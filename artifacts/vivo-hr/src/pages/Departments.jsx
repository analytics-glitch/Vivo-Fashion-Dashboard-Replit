import React, { useEffect, useMemo, useState, useCallback } from "react";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { vivoClient, monthStartISO, todayISO } from "../lib/api";
import { exportToExcel } from "../lib/exports";
import {
  ArrowUpDown, FileDown, Building2, AlarmClock, Clock, Briefcase,
  ChevronDown, ChevronRight, TrendingDown, TrendingUp,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";

const BAR_COLORS = [
  "hsl(var(--brand))", "hsl(var(--accent))", "#7c3aed", "#0ea5e9",
  "#f59e0b", "#ef4444", "#10b981", "#6366f1", "#ec4899", "#14b8a6",
];

function StatCard({ icon: Icon, label, value, hint }) {
  return (
    <Card className="rounded-2xl border border-border bg-card p-4 shadow-none">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="text-2xl font-bold font-mono tabular-nums leading-tight">{value}</div>
          {hint && <div className="text-[11px] text-muted-foreground truncate">{hint}</div>}
        </div>
      </div>
    </Card>
  );
}

function ChartCard({ title, data, dataKey, fmt }) {
  if (!data.length) return null;
  return (
    <Card className="rounded-2xl border border-border bg-card p-4 shadow-none">
      <div className="text-[11px] font-bold uppercase tracking-wider text-brand-deep mb-3">{title}</div>
      <div style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 60 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} height={70}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
            <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
            <Tooltip
              cursor={{ fill: "hsl(var(--muted) / 0.3)" }}
              contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 }}
              formatter={(v) => [fmt ? fmt(v) : v, title]}
            />
            <Bar dataKey={dataKey} radius={[6, 6, 0, 0]}>
              {data.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function minToClock(min) {
  if (min == null) return "—";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function PerfList({ title, icon: Icon, tone, people }) {
  const bad = tone === "bad";
  const accent = bad ? "text-rose-600" : "text-emerald-600";
  const dot = bad ? "bg-rose-500" : "bg-emerald-500";
  const list = Array.isArray(people) ? people : [];
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className={`flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider mb-2 ${accent}`}>
        <Icon className="h-3.5 w-3.5" />{title}
      </div>
      {list.length === 0 ? (
        <div className="text-[12px] text-muted-foreground py-2">Not enough tracked days to rank.</div>
      ) : (
        <div className="space-y-1.5">
          {list.map((p, i) => (
            <div key={i} className="flex items-center gap-2 text-[12px]">
              <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dot}`} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate">{p.employee_name}</div>
                {p.designation ? <div className="text-[10px] text-muted-foreground truncate">{p.designation}</div> : null}
              </div>
              <div className="flex items-center gap-3 font-mono tabular-nums text-right shrink-0">
                <span className={p.attendance_rate >= 90 ? "text-emerald-600" : p.attendance_rate < 70 ? "text-rose-600" : ""} title="Attendance rate">
                  {p.attendance_rate}%
                </span>
                <span className="text-muted-foreground" title="Late days">{p.late_days}L</span>
                <span className="text-muted-foreground" title="Absent days">{p.absent_days}A</span>
                <span className="text-muted-foreground hidden sm:inline" title="Avg check-in">{p.avg_check_in || "—"}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Departments() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [dateFrom, setDateFrom] = useState(monthStartISO());
  const [dateTo, setDateTo] = useState(todayISO());
  const [entity, setEntity] = useState("all");
  const [entities, setEntities] = useState([]);
  const [sort, setSort] = useState({ key: "employees", dir: "desc" });
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const params = { date_from: dateFrom, date_to: dateTo };
      if (entity !== "all") params.entity = entity;
      const { data } = await vivoClient.get("/department-performance", { params });
      setRows(data || []);
    } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to load department performance");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, entity]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dateFrom, dateTo, entity]);

  useEffect(() => {
    vivoClient.get("/employees/summary")
      .then(({ data }) => setEntities((data?.by_entity || []).map((e) => e.entity).filter(Boolean)))
      .catch(() => {});
  }, []);

  const enriched = useMemo(
    () => rows.map((r) => {
      let checkinMin = null;
      if (r.avg_check_in) {
        const [h, m] = r.avg_check_in.split(":").map(Number);
        checkinMin = h * 60 + m;
      }
      return { ...r, checkin_min: checkinMin };
    }),
    [rows]
  );

  const sorted = useMemo(() => {
    const { key, dir } = sort;
    return [...enriched].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
      return dir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
  }, [enriched, sort]);

  const summary = useMemo(() => {
    if (enriched.length === 0) return null;
    const totEmp = enriched.reduce((a, r) => a + (r.employees || 0), 0);
    const withHours = enriched.filter((r) => r.avg_hours > 0);
    const avgHours = withHours.length ? withHours.reduce((a, r) => a + r.avg_hours, 0) / withHours.length : 0;
    const mostLate = [...enriched].sort((a, b) => (b.late_rate || 0) - (a.late_rate || 0))[0];
    const bestAtt = [...enriched].sort((a, b) => (b.attendance_rate || 0) - (a.attendance_rate || 0))[0];
    return { depts: enriched.length, totEmp, avgHours: avgHours.toFixed(1), mostLate, bestAtt };
  }, [enriched]);

  const hoursChart = useMemo(
    () => [...enriched].filter((r) => r.avg_hours > 0).sort((a, b) => b.avg_hours - a.avg_hours).slice(0, 12)
      .map((r) => ({ name: r.department, value: r.avg_hours })),
    [enriched]
  );
  const lateChart = useMemo(
    () => [...enriched].sort((a, b) => (b.late_rate || 0) - (a.late_rate || 0)).slice(0, 12)
      .map((r) => ({ name: r.department, value: r.late_rate })),
    [enriched]
  );
  const checkinChart = useMemo(
    () => [...enriched].filter((r) => r.checkin_min != null).sort((a, b) => b.checkin_min - a.checkin_min).slice(0, 12)
      .map((r) => ({ name: r.department, value: r.checkin_min })),
    [enriched]
  );

  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }));

  const SortHead = ({ k, label, right = false }) => (
    <th className={`px-3 py-3 ${right ? "text-right" : "text-left"} font-semibold cursor-pointer select-none hover:text-brand-deep`}
      onClick={() => toggleSort(k)} data-testid={`dept-sort-${k}`}>
      <span className={`inline-flex items-center gap-1 ${right ? "flex-row-reverse" : ""}`}>
        {label}
        <ArrowUpDown className={`h-3 w-3 ${sort.key === k ? "text-brand" : "text-muted-foreground/50"}`} />
      </span>
    </th>
  );

  const xlsx = () => exportToExcel(
    sorted.map((r) => ({
      Department: r.department, Employees: r.employees, "Attendance %": r.attendance_rate,
      "Late %": r.late_rate, "Late Days": r.late_days, "Avg Hours": r.avg_hours,
      "Avg Check-In": r.avg_check_in || "", "Undertime Days": r.undertime_days,
    })),
    "department-performance.xlsx", "Departments"
  );

  return (
    <AppLayout onRefresh={load}>
      <PageHeader
        title="Department Performance"
        subtitle="Lateness, average hours and check-in time by department — see which departments are performing how"
        testId="dept-header"
      />

      {err && <ErrorState message={err} />}

      <Card className="rounded-2xl border border-border bg-card p-4 mb-5 shadow-none">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Entity</Label>
            <Select value={entity} onValueChange={setEntity}>
              <SelectTrigger className="h-9 rounded-full border-border bg-panel/40" data-testid="dept-entity"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All entities</SelectItem>
                {entities.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">From</Label>
            <Input type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)}
              className="h-9 rounded-full border-border bg-panel/40" data-testid="dept-from" />
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">To</Label>
            <Input type="date" value={dateTo} min={dateFrom} max={todayISO()} onChange={(e) => setDateTo(e.target.value)}
              className="h-9 rounded-full border-border bg-panel/40" data-testid="dept-to" />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={xlsx} className="inline-flex items-center rounded-full border border-border text-[11px] font-bold uppercase tracking-wider px-4 h-9 hover:bg-panel/40" data-testid="dept-export">
            <FileDown className="h-3.5 w-3.5 mr-1.5" />Excel
          </button>
          <span className="ml-auto text-[11px] text-muted-foreground">{sorted.length} departments</span>
        </div>
      </Card>

      {loading ? <LoadingState /> : enriched.length === 0 ? (
        <EmptyState icon={Building2} title="No department data"
          description="No roster-linked attendance in this range. Link employees in the Directory, or widen the dates." />
      ) : (
        <>
          {summary && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
              <StatCard icon={Building2} label="Departments" value={summary.depts} hint={`${summary.totEmp} employees tracked`} />
              <StatCard icon={Briefcase} label="Avg hours/day" value={`${summary.avgHours}h`} hint="across departments" />
              <StatCard icon={AlarmClock} label="Most lateness" value={`${summary.mostLate?.late_rate ?? 0}%`} hint={summary.mostLate?.department} />
              <StatCard icon={Clock} label="Best attendance" value={`${summary.bestAtt?.attendance_rate ?? 0}%`} hint={summary.bestAtt?.department} />
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
            <ChartCard title="Lateness rate by department (%)" data={lateChart} dataKey="value" fmt={(v) => `${v}%`} />
            <ChartCard title="Average hours per day by department" data={hoursChart} dataKey="value" fmt={(v) => `${v}h`} />
            <ChartCard title="Average check-in time by department" data={checkinChart} dataKey="value" fmt={(v) => minToClock(v)} />
          </div>

          <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-none">
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-sm" data-testid="dept-table">
                <thead className="bg-panel/40 text-xs uppercase tracking-wider text-muted-foreground sticky top-0">
                  <tr>
                    <SortHead k="department" label="Department" />
                    <SortHead k="employees" label="Employees" right />
                    <SortHead k="attendance_rate" label="Attendance" right />
                    <SortHead k="late_rate" label="Late %" right />
                    <SortHead k="late_days" label="Late days" right />
                    <SortHead k="avg_hours" label="Avg hrs" right />
                    <SortHead k="checkin_min" label="Avg check-in" right />
                    <SortHead k="undertime_days" label="Undertime" right />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => {
                    const isOpen = expanded === r.department;
                    const hasPerf = (r.worst_performers?.length || 0) > 0 || (r.best_performers?.length || 0) > 0;
                    return (
                    <React.Fragment key={r.department}>
                    <tr
                      className={`border-t border-border transition-colors ${hasPerf ? "cursor-pointer hover:bg-panel/40" : ""} ${isOpen ? "bg-panel/40" : ""}`}
                      data-testid={`dept-row-${i}`}
                      onClick={() => hasPerf && setExpanded(isOpen ? null : r.department)}
                    >
                      <td className="px-3 py-2.5 font-semibold whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          {hasPerf ? (isOpen ? <ChevronDown className="h-3.5 w-3.5 text-brand" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />) : <span className="w-3.5" />}
                          {r.department}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{r.employees}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                        <span className={r.attendance_rate >= 90 ? "text-emerald-600 font-semibold" : r.attendance_rate < 70 ? "text-rose-600 font-semibold" : ""}>
                          {r.attendance_rate}%
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                        <span className={r.late_rate >= 30 ? "text-rose-600 font-semibold" : r.late_rate >= 15 ? "text-amber-600 font-semibold" : "text-muted-foreground"}>
                          {r.late_rate}%
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{r.late_days}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{(r.avg_hours || 0).toFixed(1)}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">{r.avg_check_in || "—"}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{r.undertime_days}</td>
                    </tr>
                    {isOpen && hasPerf && (
                      <tr className="border-t border-border bg-panel/20" data-testid={`dept-perf-${i}`}>
                        <td colSpan={8} className="px-3 py-4">
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <PerfList
                              title="Needs attention"
                              icon={TrendingDown}
                              tone="bad"
                              people={r.worst_performers}
                            />
                            <PerfList
                              title="Top performers"
                              icon={TrendingUp}
                              tone="good"
                              people={r.best_performers}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </AppLayout>
  );
}
