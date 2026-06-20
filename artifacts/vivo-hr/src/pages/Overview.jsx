import React, { useEffect, useMemo, useState, useCallback } from "react";
import { vivoClient, todayISO, consolidateHQBranches, apiClient, rebrandHQRow, formatHHMM } from "../lib/api";
import { usePersistedFilter, usePersistedDateRange } from "../lib/persistedFilters";
import { yesterday } from "../lib/dates";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState, StatusDot } from "../components/UIBits";
import { KpiCard } from "../components/KpiCard";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import BranchDetailSheet from "../components/BranchDetailSheet";
import EmployeeListSheet from "../components/EmployeeListSheet";
import LocationFilter from "../components/LocationFilter";
import DateRangePicker from "../components/DateRangePicker";
import {
  CheckCircle2, XCircle, Clock, Wifi, WifiOff, AlertTriangle, MapPin, Activity,
  TimerReset, Flag, CalendarOff, Users2, ArrowRight,
} from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from "recharts";
import { useAuth } from "../lib/auth";

const COUNTRY_NAMES = { KE: "Kenya", UG: "Uganda", RW: "Rwanda" };
const COUNTRY_COLORS = { KE: "hsl(150 56% 23%)", UG: "hsl(25 95% 53%)", RW: "hsl(24 80% 35%)" };

export default function OverviewPage() {
  const { user } = useAuth();
  const [location, setLocation] = usePersistedFilter("location", "all");
  const [dateFrom, dateTo, setDateFrom, setDateTo] = usePersistedDateRange(yesterday(), yesterday());
  const [overview, setOverview] = useState(null);
  const [activeRegisteredSet, setActiveRegisteredSet] = useState(null); // Set<string> | null
  const [activeRegisteredRows, setActiveRegisteredRows] = useState([]);
  const [branches, setBranches] = useState([]);
  const [todayRows, setTodayRows] = useState([]); // /branch-detail filtered to today
  const [flaggedNotes, setFlaggedNotes] = useState([]);
  const [leavesToday, setLeavesToday] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");
  const [selectedBranch, setSelectedBranch] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [listSheet, setListSheet] = useState({ open: false, title: "", subtitle: "", rows: [], sortMode: "time-asc", eyebrow: "Drill-down", filename: "vivo-list.xlsx" });

  const load = useCallback(async () => {
    setErr("");
    const today = todayISO();
    const isToday = dateFrom === today && dateTo === today;
    try {
      const locParams = location !== "all" ? { location } : {};
      // /overview and /branches accept a single `date` param — use date_to as the snapshot day.
      const snapshotParams = { ...locParams, ...(dateTo ? { date: dateTo } : {}) };
      const [ov, br, td, fn, lv] = await Promise.all([
        vivoClient.get("/overview", { params: snapshotParams }).catch(() => vivoClient.get("/overview")),
        vivoClient.get("/branches", { params: snapshotParams }),
        vivoClient.get("/branch-detail", { params: { date_from: dateFrom, date_to: dateTo, ...locParams } }).catch(() => ({ data: [] })),
        vivoClient.get("/notes", { params: { flagged_only: true } }).catch(() => ({ data: [] })),
        vivoClient.get("/leaves").catch(() => ({ data: [] })),
      ]);
      setOverview(ov.data);
      let blist = consolidateHQBranches(br.data || []);
      if (user?.role === "branch_manager" && user.branch_assignment) {
        blist = blist.filter((b) => b.branch_name === user.branch_assignment);
      }
      setBranches(blist);

      let trows = (td.data || []).map(rebrandHQRow);
      if (user?.role === "branch_manager" && user.branch_assignment) {
        trows = trows.filter((r) => r.branch_name === user.branch_assignment);
      }
      setTodayRows(trows);
      setFlaggedNotes(fn.data || []);
      // filter leaves overlapping the chosen date range; for "today" snapshot, this matches today's leaves.
      const refDate = isToday ? today : dateTo;
      const ld = (lv.data || []).filter((l) => l.date_from <= refDate && l.date_to >= refDate && l.status !== "rejected");
      setLeavesToday(ld);
    } catch (e) {
      setErr(e?.message || "Failed to load overview");
    } finally {
      setLoading(false);
    }
  }, [user, location, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  // Load "active registered" — unique employees who have any attendance record in the past 6 months.
  // Cached for the session via state; only refetched when user or location filter changes.
  useEffect(() => {
    const today = new Date();
    const dateTo6 = today.toISOString().slice(0, 10);
    const sixMo = new Date(today);
    sixMo.setMonth(sixMo.getMonth() - 6);
    const dateFrom6 = sixMo.toISOString().slice(0, 10);
    const params = { date_from: dateFrom6, date_to: dateTo6, ...(location !== "all" ? { location } : {}) };
    vivoClient.get("/employee-summary", { params })
      .then((res) => {
        const rows = res.data || [];
        let filtered = rows;
        if (user?.role === "branch_manager" && user.branch_assignment) {
          filtered = rows.filter((r) => r.branch_name === user.branch_assignment);
        }
        const set = new Set(filtered.map((r) => (r.user_id || r.employee_name || "").toString().toLowerCase()).filter(Boolean));
        setActiveRegisteredSet(set);
        setActiveRegisteredRows(filtered);
      })
      .catch(() => { setActiveRegisteredSet(new Set()); setActiveRegisteredRows([]); });
  }, [user, location]);

  const totals = overview?.totals || {};
  const countries = overview?.by_country || [];

  // Recompute "Checked in today" from per-employee records (not just completed shifts).
  // The /overview API's `present` only counts completed shifts → misleading mid-day.
  const todayKPIs = useMemo(() => {
    if (todayRows.length === 0) {
      // fallback to API totals
      const checkedIn = (totals.present ?? 0) + (totals.missing_checkout ?? 0);
      return {
        checkedIn,
        present: totals.present ?? 0,
        onShift: totals.missing_checkout ?? 0,
        absent: totals.absent ?? 0,
        late: totals.late_arrivals ?? 0,
        earlyDeparture: 0,
        rateByCheckin: totals.total_employees ? (checkedIn / totals.total_employees) * 100 : 0,
        avgHours: totals.avg_hours_worked || null,
        totalEmployees: totals.total_employees ?? 0,
        lateRows: [],
        missingCheckoutRows: [],
        absentRowsFromApi: [],
        absentList: [],
        presentRows: [],
        earlyRows: [],
      };
    }
    const withCheckin = todayRows.filter((r) => !!r.check_in_time);
    const presentRows = todayRows.filter((r) => r.attendance_status === "Present");
    const missingCheckoutRows = todayRows.filter((r) => r.attendance_status === "Missing Check-Out");
    const absentRowsFromApi = todayRows.filter((r) => r.attendance_status === "Absent");
    const lateRows = todayRows.filter((r) => r.is_late);
    const earlyRows = todayRows.filter((r) => r.is_early_departure);
    const completed = todayRows.filter((r) => r.is_complete && r.hours_worked != null);
    const avgHours = completed.length ? completed.reduce((a, r) => a + (r.hours_worked || 0), 0) / completed.length : null;

    // Distinct employees who checked in at least once in the selected range.
    const checkedInSet = new Set(
      withCheckin.map((r) => (r.user_id || r.employee_name || "").toString().toLowerCase()).filter(Boolean)
    );
    const uniqueCheckedIn = checkedInSet.size;

    // Active registered = unique employees who appeared in attendance over the past 6 months,
    // unioned with anyone who checked in during the selected window (so new joiners are counted).
    let registeredSet;
    if (activeRegisteredSet && activeRegisteredSet.size) {
      registeredSet = new Set(activeRegisteredSet);
      checkedInSet.forEach((id) => registeredSet.add(id));
    } else {
      // Fallback while 6-mo summary is loading or empty — derive from today's roster.
      registeredSet = new Set(
        todayRows.map((r) => (r.user_id || r.employee_name || "").toString().toLowerCase()).filter(Boolean)
      );
    }
    const totalEmployees = registeredSet.size || (totals.total_employees ?? todayRows.length);

    // Absent = active-registered who didn't appear in checkedIn set during the selected window.
    const absentIds = new Set([...registeredSet].filter((id) => !checkedInSet.has(id)));
    const absentCount = absentIds.size;
    // Build absent rows for the drill-down sheet: prefer rows from the 6-month roster,
    // fall back to any matching rows in today's data (covers new joiners).
    const seen = new Set();
    const absentList = [];
    activeRegisteredRows.forEach((r) => {
      const id = (r.user_id || r.employee_name || "").toString().toLowerCase();
      if (!id || !absentIds.has(id) || seen.has(id)) return;
      seen.add(id);
      absentList.push({
        employee_name: r.employee_name,
        branch_name: r.branch_name,
        branch_country: r.branch_country,
        attendance_status: "Absent",
        check_in_time: null,
        check_out_time: null,
        hours_worked: null,
        attendance_rate: r.attendance_rate,
        days_absent: r.days_absent,
        total_days: r.total_days,
      });
    });


    const rateByCheckin = totalEmployees ? (uniqueCheckedIn / totalEmployees) * 100 : 0;
    const dayCount = (() => {
      if (!dateFrom || !dateTo) return 1;
      const f = new Date(dateFrom), t = new Date(dateTo);
      const ms = t.getTime() - f.getTime();
      return Math.max(1, Math.round(ms / 86400000) + 1);
    })();
    return {
      checkedIn: withCheckin.length,
      uniqueCheckedIn,
      present: presentRows.length,
      onShift: missingCheckoutRows.length,
      absent: absentCount,
      late: lateRows.length,
      earlyDeparture: earlyRows.length,
      rateByCheckin,
      avgHours,
      totalEmployees,
      dayCount,
      lateRows, missingCheckoutRows, absentRowsFromApi, presentRows, earlyRows,
      absentList,
    };
  }, [todayRows, totals, dateFrom, dateTo, activeRegisteredSet, activeRegisteredRows]);

  const recentCheckins = useMemo(() => {
    const list = todayRows.filter((r) => !!r.check_in_time);
    list.sort((a, b) => new Date(b.check_in_time).getTime() - new Date(a.check_in_time).getTime());
    return list.slice(0, 10);
  }, [todayRows]);

  const topLateOffenders = useMemo(() => {
    // Sorted by latest check-in time (most-late first)
    return [...todayKPIs.lateRows].sort((a, b) => {
      const av = a.check_in_time ? new Date(a.check_in_time).getTime() : 0;
      const bv = b.check_in_time ? new Date(b.check_in_time).getTime() : 0;
      return bv - av;
    }).slice(0, 8);
  }, [todayKPIs]);

  const openListSheet = (cfg) => setListSheet({ open: true, ...cfg });

  const filteredBranches = useMemo(() => {
    const q = search.toLowerCase();
    return branches.filter((b) => !q || b.branch_name?.toLowerCase().includes(q) || b.branch_country?.toLowerCase().includes(q));
  }, [branches, search]);

  const offlineCount = branches.filter((b) => b.device_status?.toLowerCase() === "offline").length;
  const onlineCount = branches.length - offlineCount;

  return (
    <AppLayout onRefresh={load}>
      <PageHeader
        title="Live Overview"
        subtitle={`Attendance across ${branches.length || 29} branches in Kenya, Uganda & Rwanda · ${dateFrom === dateTo ? dateFrom : `${dateFrom} → ${dateTo}`}`}
        testId="overview-header"
        actions={
          <DateRangePicker
            value={{ from: dateFrom, to: dateTo }}
            onChange={({ from, to }) => { setDateFrom(from); setDateTo(to); }}
            testId="overview-daterange"
            className="min-w-[240px]"
          />
        }
      />

      {/* Quick location toggle */}
      <div className="mb-5 flex items-center gap-2" data-testid="overview-location-toggle">
        <span className="eyebrow">View</span>
        {[
          { v: "all", l: "All" },
          { v: "HQ", l: "HQ" },
          { v: "Shopzetu", l: "Shopzetu" },
          { v: "Stores", l: "Stores" },
        ].map((o) => (
          <button
            key={o.v}
            type="button"
            onClick={() => setLocation(o.v)}
            data-testid={`overview-loc-${o.v}`}
            className={`rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition-colors ${
              location === o.v
                ? "bg-brand text-background"
                : "bg-panel/60 text-muted-foreground hover:bg-panel"
            }`}
          >
            {o.l}
          </button>
        ))}
      </div>

      {err && <ErrorState message={err} />}
      {loading ? <LoadingState label="Fetching live data…" /> : (
        <>
          {/* KPI grid — top row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-stagger" data-testid="kpi-grid">
            <KpiCard
              testId="kpi-attendance-rate"
              title="Check-in rate" accent="brand" icon={Activity}
              value={`${todayKPIs.rateByCheckin.toFixed(1)}%`}
              sub={`${todayKPIs.uniqueCheckedIn ?? todayKPIs.checkedIn} of ${todayKPIs.totalEmployees} registered`}
              progress={todayKPIs.rateByCheckin}
            />
            <KpiCard
              testId="kpi-checked-in"
              title={todayKPIs.dayCount > 1 ? "Check-ins (period)" : "Checked in today"} icon={CheckCircle2}
              value={todayKPIs.checkedIn}
              sub={todayKPIs.dayCount > 1 ? `${todayKPIs.dayCount} days · check-in events` : "employees with a check-in"}
              onClick={() => openListSheet({
                title: "Checked in today",
                subtitle: `${todayKPIs.checkedIn} employees · earliest first`,
                eyebrow: "Today · check-ins",
                rows: todayRows.filter((r) => !!r.check_in_time),
                sortMode: "time-asc",
                filename: `vivo-checkedin-${todayISO()}.xlsx`,
              })}
            />
            <KpiCard
              testId="kpi-missing-checkout"
              title="Still on shift" icon={TimerReset}
              value={todayKPIs.onShift} sub="checked in, not yet out"
              onClick={() => openListSheet({
                title: "Still on shift",
                subtitle: `${todayKPIs.onShift} employees · check-out missing`,
                eyebrow: "Open shifts",
                rows: todayKPIs.missingCheckoutRows,
                sortMode: "time-asc",
                filename: `vivo-onshift-${todayISO()}.xlsx`,
              })}
            />
            <KpiCard
              testId="kpi-absent"
              title="Absent" icon={XCircle}
              value={todayKPIs.absent} sub="active staff with no check-in"
              onClick={() => openListSheet({
                title: "Absent",
                subtitle: `${todayKPIs.absent} active employees with no check-in for the selected period`,
                eyebrow: "Absentees",
                rows: todayKPIs.absentList,
                sortMode: "time-asc",
                filename: `vivo-absent-${todayISO()}.xlsx`,
              })}
            />
          </div>

          {/* KPI grid — second row */}
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-stagger">
            <KpiCard
              testId="kpi-late"
              title="Late arrivals" icon={AlertTriangle}
              value={todayKPIs.late} sub="check-in after 08:00 — tap to see who"
              onClick={() => openListSheet({
                title: "Late arrivals today",
                subtitle: `${todayKPIs.late} employees checked in after 08:00`,
                eyebrow: "Late",
                rows: todayKPIs.lateRows,
                sortMode: "lateness-desc",
                filename: `vivo-late-${todayISO()}.xlsx`,
              })}
            />
            <KpiCard
              testId="kpi-completed"
              title="Completed shifts" icon={CheckCircle2}
              value={todayKPIs.present} sub="checked in and out"
              onClick={() => openListSheet({
                title: "Completed shifts today",
                subtitle: `${todayKPIs.present} employees finished their day`,
                eyebrow: "Completed",
                rows: todayKPIs.presentRows,
                sortMode: "time-asc",
                filename: `vivo-completed-${todayISO()}.xlsx`,
              })}
            />
            <KpiCard testId="kpi-avg-hours" title="Avg hours worked" icon={Clock}
              value={todayKPIs.avgHours != null ? `${todayKPIs.avgHours.toFixed(1)}h` : "—"}
              sub="across completed shifts today" />
            <KpiCard testId="kpi-devices-online" title="Devices online" icon={Wifi}
              value={onlineCount} sub={`of ${branches.length} branches`} />
          </div>

          {/* HR-focused widgets */}
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Recently checked in */}
            <Card className="rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="eyebrow flex items-center gap-1.5"><Clock className="h-3 w-3" />Last 10 check-ins</div>
                  <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Recently arrived</h3>
                </div>
                <button
                  type="button"
                  onClick={() => openListSheet({
                    title: "Today's check-in timeline",
                    subtitle: "Latest first",
                    eyebrow: "Today",
                    rows: todayRows.filter((r) => !!r.check_in_time),
                    sortMode: "time-desc",
                    filename: `vivo-checkins-timeline-${todayISO()}.xlsx`,
                  })}
                  className="text-[10.5px] font-bold uppercase tracking-wider text-brand hover:text-brand-deep inline-flex items-center gap-1"
                  data-testid="see-all-checkins"
                >
                  See all <ArrowRight className="h-3 w-3" />
                </button>
              </div>
              <div className="space-y-1 max-h-[360px] overflow-y-auto scrollbar-thin" data-testid="recent-checkins">
                {recentCheckins.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">No check-ins recorded today.</div>
                ) : recentCheckins.map((r, i) => (
                  <div key={i} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-panel/60">
                    <div className="w-[44px] shrink-0 text-right">
                      <div className="font-mono font-bold text-[12px] tabular-nums text-brand-deep">{formatHHMM(r.check_in_time)}</div>
                    </div>
                    <div className="grid h-6 w-6 place-items-center rounded-full bg-panel text-[9px] font-bold text-brand-deep shrink-0">
                      {(r.employee_name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("")}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-semibold truncate">{r.employee_name}</div>
                      <div className="text-[10.5px] text-muted-foreground truncate">{r.branch_name}</div>
                    </div>
                    {r.is_late && <span className="pill pill-warning">Late</span>}
                  </div>
                ))}
              </div>
            </Card>

            {/* Top late offenders */}
            <Card className="rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <div className="eyebrow flex items-center gap-1.5"><AlertTriangle className="h-3 w-3" />Latest arrivals</div>
                  <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Today's top late</h3>
                </div>
                {todayKPIs.lateRows.length > 0 && (
                  <button
                    type="button"
                    onClick={() => openListSheet({
                      title: "Late arrivals today",
                      subtitle: `${todayKPIs.late} employees · most-late first`,
                      eyebrow: "Late",
                      rows: todayKPIs.lateRows,
                      sortMode: "lateness-desc",
                      filename: `vivo-late-${todayISO()}.xlsx`,
                    })}
                    className="text-[10.5px] font-bold uppercase tracking-wider text-brand hover:text-brand-deep inline-flex items-center gap-1"
                    data-testid="see-all-late"
                  >
                    See all <ArrowRight className="h-3 w-3" />
                  </button>
                )}
              </div>
              <div className="space-y-1 max-h-[360px] overflow-y-auto scrollbar-thin" data-testid="top-late">
                {topLateOffenders.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">No late arrivals today.</div>
                ) : topLateOffenders.map((r, i) => (
                  <div key={i} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-panel/60">
                    <div className="w-[44px] shrink-0 text-right">
                      <div className="font-mono font-bold text-[12px] tabular-nums text-accent-deep">{formatHHMM(r.check_in_time)}</div>
                    </div>
                    <div className="grid h-6 w-6 place-items-center rounded-full bg-accent-soft text-[9px] font-bold text-accent-deep shrink-0">
                      {(r.employee_name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("")}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-semibold truncate">{r.employee_name}</div>
                      <div className="text-[10.5px] text-muted-foreground truncate">{r.branch_name}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* On leave today + Flagged */}
            <div className="grid grid-rows-2 gap-4">
              <Card className="rounded-2xl border border-border bg-card p-5 shadow-none">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <div className="eyebrow flex items-center gap-1.5"><CalendarOff className="h-3 w-3" />Approved leave</div>
                    <h3 className="font-serif text-lg font-bold text-brand-deep mt-0.5">On leave today</h3>
                  </div>
                  <span className="pill pill-brand">{leavesToday.length}</span>
                </div>
                <div className="space-y-1 max-h-[140px] overflow-y-auto scrollbar-thin" data-testid="leaves-today">
                  {leavesToday.length === 0 ? (
                    <div className="py-2 text-[12px] text-muted-foreground">No employees on leave today.</div>
                  ) : leavesToday.slice(0, 6).map((l) => (
                    <div key={l.id} className="rounded-lg bg-panel/40 p-2 text-[12px]">
                      <div className="flex items-center justify-between">
                        <div className="font-semibold truncate">{l.employee_name}</div>
                        <span className="pill" style={{ background: "hsl(var(--brand) / 0.12)", color: "hsl(var(--brand-deep))" }}>{l.leave_type}</span>
                      </div>
                      <div className="text-[10.5px] text-muted-foreground truncate">{l.branch_name || "—"} · until {l.date_to}</div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="rounded-2xl border border-border bg-card p-5 shadow-none">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <div className="eyebrow flex items-center gap-1.5"><Flag className="h-3 w-3" />HR review</div>
                    <h3 className="font-serif text-lg font-bold text-brand-deep mt-0.5">Flagged employees</h3>
                  </div>
                  <span className="pill pill-danger">{flaggedNotes.length}</span>
                </div>
                <div className="space-y-1 max-h-[140px] overflow-y-auto scrollbar-thin" data-testid="flagged-list">
                  {flaggedNotes.length === 0 ? (
                    <div className="py-2 text-[12px] text-muted-foreground">No employees currently flagged.</div>
                  ) : flaggedNotes.slice(0, 6).map((n) => (
                    <div key={n.id} className="rounded-lg bg-danger/5 border border-danger/15 p-2 text-[12px]">
                      <div className="font-semibold truncate">{n.employee_name}</div>
                      <div className="text-[10.5px] text-muted-foreground truncate">{n.note}</div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>

          {/* Headcount summary */}
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-4 gap-4">
            <Card className="rounded-2xl border border-border bg-card p-5 shadow-none lg:col-span-1">
              <div className="eyebrow flex items-center gap-1.5"><Users2 className="h-3 w-3" />Roster</div>
              <h3 className="font-serif text-lg font-bold text-brand-deep mt-0.5">Headcount</h3>
              <div className="mt-3 space-y-2">
                <div className="rounded-lg bg-brand/[0.06] border border-brand/20 p-3">
                  <div className="font-extrabold text-3xl tabular-nums text-brand-deep">{todayKPIs.totalEmployees}</div>
                  <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground mt-0.5">Total on roster</div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-panel/40 p-2">
                    <div className="font-bold text-xl tabular-nums">{todayKPIs.checkedIn}</div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Checked in</div>
                  </div>
                  <div className="rounded-lg bg-panel/40 p-2">
                    <div className="font-bold text-xl tabular-nums">{todayKPIs.totalEmployees - todayKPIs.checkedIn - leavesToday.length}</div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Unaccounted</div>
                  </div>
                </div>
              </div>
            </Card>
            <Card className="rounded-2xl border border-border bg-card p-5 shadow-none lg:col-span-3">
              <div className="mb-3">
                <div className="eyebrow flex items-center gap-1.5"><WifiOff className="h-3 w-3" />Device health</div>
                <h3 className="font-serif text-lg font-bold text-brand-deep mt-0.5">Branches with offline devices</h3>
              </div>
              {branches.filter((b) => b.device_status?.toLowerCase() === "offline").length === 0 ? (
                <div className="py-4 text-[13px] text-muted-foreground">All branches online — devices reporting normally.</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" data-testid="offline-list">
                  {branches.filter((b) => b.device_status?.toLowerCase() === "offline").map((b) => (
                    <button key={b.branch_name} type="button"
                      onClick={() => { setSelectedBranch(b); setSheetOpen(true); }}
                      className="rounded-xl border border-danger/30 bg-danger/5 p-2.5 text-left hover:border-danger/60 transition-colors">
                      <div className="flex items-center gap-2">
                        <WifiOff className="h-3.5 w-3.5 text-danger" />
                        <div className="font-semibold text-[13px] truncate">{b.branch_name}</div>
                      </div>
                      <div className="text-[10.5px] text-muted-foreground mt-0.5">{COUNTRY_NAMES[b.branch_country] || b.branch_country}</div>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          </div>


          {/* Country breakdown + chart */}
          <div className="mt-8 grid grid-cols-1 lg:grid-cols-5 gap-4">
            <Card className="lg:col-span-3 rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-4">
                <div className="eyebrow">Country breakdown</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Present vs absent today</h3>
              </div>
              <div className="h-[280px]" data-testid="country-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={countries.map((c) => ({ ...c, country_name: COUNTRY_NAMES[c.country] || c.country }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                    <XAxis dataKey="country_name" tick={{ fontSize: 12, fontWeight: 600 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 }} />
                    <Bar dataKey="present" name="Present" radius={[8, 8, 0, 0]}>
                      {countries.map((c) => <Cell key={c.country} fill={COUNTRY_COLORS[c.country] || "hsl(var(--brand))"} />)}
                    </Bar>
                    <Bar dataKey="absent" name="Absent" fill="hsl(var(--accent-soft))" radius={[8, 8, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="lg:col-span-2 rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-3">
                <div className="eyebrow">By country</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Ranking</h3>
              </div>
              <div className="space-y-2.5" data-testid="country-list">
                {countries.map((c, idx) => (
                  <div key={c.country} className={`flex items-center justify-between rounded-2xl border p-3 ${idx === 0 ? "border-brand bg-brand/[0.04]" : "border-border bg-panel/40"}`}
                    data-testid={`country-row-${c.country}`}>
                    <div className="flex items-center gap-3">
                      <div className="grid h-9 w-9 place-items-center rounded-full text-[11px] font-bold text-white"
                        style={{ background: COUNTRY_COLORS[c.country] }}>
                        {c.country}
                      </div>
                      <div>
                        <div className="font-semibold text-[13px]">{COUNTRY_NAMES[c.country] || c.country}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {c.present}/{c.total_employees} present · {c.late_arrivals || 0} late
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-serif font-bold text-2xl tabular-nums text-brand-deep">{(c.attendance_rate || 0).toFixed(1)}%</div>
                      <div className="eyebrow text-[9.5px]">attendance</div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Branch list */}
          <Card className="mt-6 rounded-2xl border border-border bg-card p-5 shadow-none">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="eyebrow">Live status</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5 flex items-center gap-2"><MapPin className="h-4 w-4" />Branches</h3>
                <p className="text-[11px] text-muted-foreground mt-1">Green ≥80% · orange 50–79% · red &lt;50% · gray offline</p>
              </div>
              <Input className="sm:max-w-[260px] h-10 rounded-full border-border bg-panel/60" placeholder="Search branch…"
                value={search} onChange={(e) => setSearch(e.target.value)} data-testid="branch-search-input" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="branch-grid">
              {filteredBranches.map((b) => {
                const isTop = (b.attendance_rate ?? 0) >= 80 && b.device_status?.toLowerCase() === "online";
                return (
                  <button
                    key={b.branch_name}
                    type="button"
                    onClick={() => { setSelectedBranch(b); setSheetOpen(true); }}
                    className={`group relative rounded-2xl border bg-card p-4 text-left transition-colors w-full ${isTop ? "border-brand" : "border-border hover:border-accent-mid/40"}`}
                    data-testid={`branch-card-${b.branch_name.replace(/\s/g, "-")}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <StatusDot color={b.status_color} />
                          <div className="truncate font-semibold text-[13px]">{b.branch_name}</div>
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {COUNTRY_NAMES[b.branch_country] || b.branch_country}
                          {b._hq_sources && <> · {b._hq_sources.length} devices</>}
                        </div>
                      </div>
                      <span className={b.device_status?.toLowerCase() === "online" ? "pill pill-success" : "pill pill-danger"}>
                        {b.device_status?.toLowerCase() === "online" ? "Online" : "Offline"}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <div>
                        <div className="font-bold text-lg tabular-nums">{b.present ?? 0}</div>
                        <div className="eyebrow text-[9px]">present</div>
                      </div>
                      <div>
                        <div className="font-bold text-lg tabular-nums">{b.absent ?? 0}</div>
                        <div className="eyebrow text-[9px]">absent</div>
                      </div>
                      <div>
                        <div className="font-bold text-lg tabular-nums">{(b.attendance_rate ?? 0).toFixed(0)}%</div>
                        <div className="eyebrow text-[9px]">rate</div>
                      </div>
                    </div>
                    {/* progress bar */}
                    <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-panel">
                      <div className="h-full rounded-full"
                        style={{
                          width: `${Math.max(0, Math.min(100, b.attendance_rate ?? 0))}%`,
                          background: isTop ? "hsl(var(--brand))" : "hsl(var(--accent-mid))",
                        }} />
                    </div>
                    <div className="mt-2 text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                      Click for deep dive →
                    </div>
                  </button>
                );
              })}
            </div>
            {filteredBranches.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">No branches match your search</div>
            )}
          </Card>
        </>
      )}

      <BranchDetailSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        branch={selectedBranch}
        allBranches={branches}
      />

      <EmployeeListSheet
        open={listSheet.open}
        onOpenChange={(o) => setListSheet({ ...listSheet, open: o })}
        title={listSheet.title}
        subtitle={listSheet.subtitle}
        eyebrow={listSheet.eyebrow}
        rows={listSheet.rows}
        sortMode={listSheet.sortMode}
        filename={listSheet.filename}
      />
    </AppLayout>
  );
}
