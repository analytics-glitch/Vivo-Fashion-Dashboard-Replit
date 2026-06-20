import React, { useEffect, useMemo, useState, useCallback } from "react";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import LocationFilter from "../components/LocationFilter";
import { vivoClient, monthStartISO, todayISO, consolidateHQBranches, rebrandHQRow, isHQSource, HQ_LABEL } from "../lib/api";
import { fetchAllBranches } from "../lib/branches";
import { yesterday, previousPeriod } from "../lib/dates";
import { usePersistedDateRange, usePersistedFilter } from "../lib/persistedFilters";
import DateRangePicker from "../components/DateRangePicker";
import { useSort } from "../lib/useSort";
import DeltaChip from "../components/DeltaChip";
import { Switch } from "../components/ui/switch";
import { exportToExcel, exportToPDF } from "../lib/exports";
import { FileDown, FileText, AlertTriangle } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from "recharts";
import { useAuth } from "../lib/auth";

const COUNTRY_NAMES = { KE: "Kenya", UG: "Uganda", RW: "Rwanda" };

const CATEGORY = {
  "High Loss":     { dot: "bg-danger",         text: "text-danger",      bg: "bg-danger/10",  border: "border-danger/30",  fill: "hsl(var(--danger))"  },
  "Moderate Loss": { dot: "bg-accent-mid",     text: "text-accent-deep", bg: "bg-accent-mid/10", border: "border-accent-mid/30", fill: "hsl(var(--accent-mid))" },
  "Minor Loss":    { dot: "bg-warning",        text: "text-accent-deep", bg: "bg-warning/10", border: "border-warning/30", fill: "hsl(var(--warning))" },
  "On Track":      { dot: "bg-success",        text: "text-success",     bg: "bg-success/10", border: "border-success/30", fill: "hsl(var(--success))" },
};
const catCls = (c) => CATEGORY[c] || CATEGORY["On Track"];

export default function HoursLost() {
  const { user } = useAuth();
  const [dateFrom, dateTo, setDateFrom, setDateTo] = usePersistedDateRange(yesterday(), yesterday());
  const [country, setCountry] = usePersistedFilter("country", "all");
  const [location, setLocation] = usePersistedFilter("location", "all");
  const [branch, setBranch] = useState(user?.branch_assignment || "all");
  const [branches, setBranches] = useState([]);
  const [rows, setRows] = useState([]);
  const [prevRows, setPrevRows] = useState([]);
  const [compare, setCompare] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetchAllBranches().then((list) => {
      let l = list;
      if (user?.role === "branch_manager" && user.branch_assignment) l = l.filter((b) => b.branch_name === user.branch_assignment);
      setBranches(l);
    }).catch(() => {});
  }, [user]);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const params = { date_from: dateFrom, date_to: dateTo };
      if (country !== "all") params.country = country;
      if (location !== "all") params.location = location;
      if (branch !== "all" && branch !== HQ_LABEL) params.branch = branch;
      const reqs = [vivoClient.get("/hours-lost", { params })];
      if (compare) {
        const prev = previousPeriod(dateFrom, dateTo);
        const pp = { ...params, date_from: prev.from, date_to: prev.to };
        reqs.push(vivoClient.get("/hours-lost", { params: pp }));
      }
      const responses = await Promise.all(reqs);
      // Normalize: clamp hours-lost so that rows where actual ≥ expected show 0 lost hours.
      // Re-derive loss_category from the clamped value so the table never paradoxically
      // shows "High Loss · 8.9h" while efficiency is >100%.
      const categorize = (lost, expected) => {
        if (!expected || lost <= 0) return "On Track";
        const pct = (lost / expected) * 100;
        if (pct >= 10) return "High Loss";
        if (pct >= 5)  return "Moderate Loss";
        if (pct > 0)   return "Minor Loss";
        return "On Track";
      };
      const normalize = (r) => {
        const expected = Number(r.total_expected_hours) || 0;
        const actual = Number(r.total_actual_hours) || 0;
        const lost = Math.max(0, expected - actual);
        const eff = expected ? (actual / expected) * 100 : 0;
        return {
          ...r,
          total_hours_lost: lost,
          efficiency_pct: eff,
          loss_category: categorize(lost, expected),
        };
      };
      const remap = (data) => (data || [])
        .map((r) => isHQSource(r.branch_name) ? { ...r, branch_name: HQ_LABEL, _hq_source: r.branch_name } : r)
        .map(normalize);
      let merged = remap(responses[0].data);
      if (user?.role === "branch_manager" && user.branch_assignment) {
        merged = merged.filter((r) => r.branch_name === user.branch_assignment);
      }
      merged.sort((a, b) => (b.total_hours_lost || 0) - (a.total_hours_lost || 0));
      setRows(merged);
      if (compare && responses[1]) {
        let prev = remap(responses[1].data);
        if (user?.role === "branch_manager" && user.branch_assignment) {
          prev = prev.filter((r) => r.branch_name === user.branch_assignment);
        }
        setPrevRows(prev);
      } else {
        setPrevRows([]);
      }
    } catch (e) { setErr(e?.message || "Failed to load"); }
    finally { setLoading(false); }
  }, [dateFrom, dateTo, country, location, branch, compare, user]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const stats = useMemo(() => {
    const counts = { "High Loss": 0, "Moderate Loss": 0, "Minor Loss": 0, "On Track": 0 };
    let totalLost = 0, totalExpected = 0, totalActual = 0;
    rows.forEach((r) => {
      counts[r.loss_category] = (counts[r.loss_category] || 0) + 1;
      totalLost += r.total_hours_lost || 0;
      totalExpected += r.total_expected_hours || 0;
      totalActual += r.total_actual_hours || 0;
    });
    const efficiency = totalExpected ? (totalActual / totalExpected) * 100 : 0;
    return { counts, totalLost, totalExpected, totalActual, efficiency };
  }, [rows]);

  const prevStats = useMemo(() => {
    const counts = { "High Loss": 0, "Moderate Loss": 0, "Minor Loss": 0, "On Track": 0 };
    let totalLost = 0;
    prevRows.forEach((r) => {
      counts[r.loss_category] = (counts[r.loss_category] || 0) + 1;
      totalLost += r.total_hours_lost || 0;
    });
    return { counts, totalLost };
  }, [prevRows]);

  const top20 = rows.slice(0, 20);
  const filteredByCategory = useMemo(
    () => (categoryFilter ? rows.filter((r) => r.loss_category === categoryFilter) : rows),
    [rows, categoryFilter]
  );
  const { sorted: sortedRows, SortHead } = useSort(filteredByCategory, { key: "total_hours_lost", dir: "desc" });

  const xlsx = () => exportToExcel(
    rows.map((r) => ({
      Employee: r.employee_name, Branch: r.branch_name, Location: r.location,
      Country: COUNTRY_NAMES[r.branch_country] || r.branch_country,
      "Days Present": r.total_days_present, "Expected Hrs": r.total_expected_hours,
      "Actual Hrs": r.total_actual_hours, "Allowable Hrs": r.total_allowable_hours,
      "Hours Lost": r.total_hours_lost, "Efficiency %": r.efficiency_pct,
      Category: r.loss_category,
    })),
    `hours-lost-${dateFrom}-to-${dateTo}.xlsx`, "Hours Lost"
  );
  const pdf = () => exportToPDF({
    title: "Hours Lost — worst to best",
    subtitle: `${dateFrom} → ${dateTo}`,
    headers: ["Employee", "Branch", "Loc", "Expected", "Actual", "Lost", "Eff %", "Category"],
    rows: rows.map((r) => [r.employee_name, r.branch_name, r.location, (r.total_expected_hours||0).toFixed(1), (r.total_actual_hours||0).toFixed(1), (r.total_hours_lost||0).toFixed(1), (r.efficiency_pct||0).toFixed(1), r.loss_category]),
    filename: `hours-lost-${dateFrom}-to-${dateTo}.pdf`,
  });

  return (
    <AppLayout onRefresh={load}>
      <PageHeader
        title="Hours Lost"
        subtitle="Productivity efficiency — expected vs actual hours, ranked worst to best"
        testId="hl-header"
        actions={<>
          <Button variant="outline" size="sm" onClick={xlsx} className="rounded-full text-[11px] font-bold uppercase tracking-wider"><FileDown className="h-3.5 w-3.5 mr-1.5" />Excel</Button>
          <Button variant="outline" size="sm" onClick={pdf} className="rounded-full text-[11px] font-bold uppercase tracking-wider"><FileText className="h-3.5 w-3.5 mr-1.5" />PDF</Button>
        </>}
      />

      <Card className="rounded-2xl border border-border bg-card p-4 mb-5 shadow-none">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
          <div className="lg:col-span-2"><Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Date range</Label>
            <DateRangePicker
              value={{ from: dateFrom, to: dateTo }}
              onChange={({ from, to }) => { setDateFrom(from); setDateTo(to); }}
              testId="hl-daterange"
              className="w-full"
            /></div>
          <div><Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Country</Label>
            <Select value={country} onValueChange={setCountry} disabled={user?.role === "branch_manager"}>
              <SelectTrigger className="h-9 rounded-full border-border bg-panel/40" data-testid="hl-country"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="KE">Kenya</SelectItem><SelectItem value="UG">Uganda</SelectItem><SelectItem value="RW">Rwanda</SelectItem></SelectContent>
            </Select></div>
          <LocationFilter value={location} onChange={setLocation} testId="hl-location" />
          <div><Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Branch</Label>
            <Select value={branch} onValueChange={setBranch} disabled={user?.role === "branch_manager"}>
              <SelectTrigger className="h-9 rounded-full border-border bg-panel/40" data-testid="hl-branch"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem>{branches.map((b) => <SelectItem key={b.branch_name} value={b.branch_name}>{b.branch_name}</SelectItem>)}</SelectContent>
            </Select></div>
          <Button onClick={load} className="rounded-full bg-brand hover:bg-brand-deep text-background text-[11px] font-bold uppercase tracking-wider" data-testid="hl-apply">Apply</Button>
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
          <Switch id="hl-compare" checked={compare} onCheckedChange={setCompare} data-testid="hl-compare-toggle" />
          <label htmlFor="hl-compare" className="text-[12px] font-semibold text-foreground cursor-pointer">
            Compare to previous period
          </label>
          {compare && (() => { const p = previousPeriod(dateFrom, dateTo); return (
            <span className="text-[11px] text-muted-foreground">({p.from} → {p.to})</span>
          ); })()}
        </div>
      </Card>

      {err && <ErrorState message={err} />}
      {loading ? <LoadingState /> : (
        <>
          {/* Category KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5" data-testid="hl-kpis">
            {Object.entries(CATEGORY).map(([cat, st]) => {
              const active = categoryFilter === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter((curr) => (curr === cat ? null : cat))}
                  data-testid={`hl-kpi-${cat.replace(/\s/g, "-")}`}
                  className={`text-left rounded-2xl border p-4 shadow-none transition-all ${st.border} ${st.bg} hover:-translate-y-0.5 ${active ? "ring-2 ring-brand/60 shadow-md" : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="eyebrow flex items-center gap-1.5">
                        {cat}
                        {active && <span className="pill pill-brand text-[8px]">FILTERED</span>}
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <div className={`font-extrabold text-3xl tabular-nums ${st.text}`}>{stats.counts[cat] || 0}</div>
                        {compare && <DeltaChip current={stats.counts[cat] || 0} previous={prevStats.counts[cat] || 0} invert={cat !== "On Track"} format="pct" />}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1">
                        employees {active ? "— click to clear" : "— click to filter"}
                      </div>
                    </div>
                    <span className={`h-3 w-3 rounded-full ${st.dot}`} />
                  </div>
                </button>
              );
            })}
          </div>

          {/* Top 20 worst chart */}
          <Card className="rounded-2xl border border-border bg-card p-5 shadow-none mb-5">
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-danger" />
              <div>
                <div className="eyebrow">Top 20 worst performers</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Hours lost — biggest leakage</h3>
              </div>
            </div>
            <div className="h-[380px]" data-testid="hl-chart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={top20} layout="vertical" margin={{ left: 0, right: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="employee_name" tick={{ fontSize: 10 }} width={140} tickLine={false} axisLine={false} />
                  <Tooltip
                    formatter={(v) => [`${Number(v).toFixed(1)}h`, "Hours lost"]}
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 }}
                  />
                  <Bar dataKey="total_hours_lost" radius={[0, 6, 6, 0]}>
                    {top20.map((r, i) => <Cell key={i} fill={catCls(r.loss_category).fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* Table */}
          <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-none">
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-sm" data-testid="hl-table">
                <thead className="bg-panel/40 text-xs uppercase tracking-wider text-muted-foreground sticky top-0">
                  <tr>
                    <th className="px-3 py-3 text-left font-semibold">#</th>
                    <SortHead k="employee_name" label="Employee" />
                    <SortHead k="branch_name" label="Branch" />
                    <SortHead k="location" label="Loc" />
                    <SortHead k="total_expected_hours" label="Expected" right />
                    <SortHead k="total_actual_hours" label="Actual" right />
                    <SortHead k="total_hours_lost" label="Lost" right />
                    <SortHead k="efficiency_pct" label="Efficiency" right />
                    <SortHead k="loss_category" label="Category" />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.slice(0, 500).map((r, i) => {
                    const st = catCls(r.loss_category);
                    return (
                      <tr key={i} className={`border-t border-border ${st.bg}`} data-testid={`hl-row-${i}`}>
                        <td className="px-3 py-2.5 text-muted-foreground font-mono tabular-nums">{i + 1}</td>
                        <td className="px-3 py-2.5 font-semibold whitespace-nowrap">{r.employee_name}</td>
                        <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{r.branch_name}</td>
                        <td className="px-3 py-2.5"><span className="pill">{r.location}</span></td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums">{(r.total_expected_hours || 0).toFixed(1)}h</td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums">{(r.total_actual_hours || 0).toFixed(1)}h</td>
                        <td className={`px-3 py-2.5 text-right font-mono tabular-nums font-bold ${st.text}`}>{(r.total_hours_lost || 0).toFixed(1)}h</td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums">{(r.efficiency_pct || 0).toFixed(1)}%</td>
                        <td className="px-3 py-2.5">
                          <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                            style={{ background: `${st.fill}22`, color: st.fill }}>
                            <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                            {r.loss_category}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && !loading && (
                    <tr><td colSpan={9} className="px-4 py-16 text-center text-muted-foreground">No data — adjust filters</td></tr>
                  )}
                  {rows.length > 0 && sortedRows.length === 0 && (
                    <tr><td colSpan={9} className="px-4 py-16 text-center text-muted-foreground">
                      No employees in <strong>{categoryFilter}</strong> — <button type="button" className="text-brand font-semibold underline" onClick={() => setCategoryFilter(null)}>clear filter</button>
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </AppLayout>
  );
}
