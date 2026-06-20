import React, { useEffect, useState, useCallback, useMemo } from "react";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState } from "../components/UIBits";
import { KpiCard } from "../components/KpiCard";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
  LineChart, Line, PieChart, Pie, Legend,
} from "recharts";
import {
  GraduationCap, Users, Layers, Building, Banknote, Clock, FileDown, FileText,
  Award, Calendar, Trophy, AlertTriangle,
} from "lucide-react";
import { trainingClient } from "../lib/training";
import { exportToExcel, exportToPDF } from "../lib/exports";

const STATUS_COLORS = ["hsl(150 56% 23%)", "hsl(25 95% 53%)", "hsl(35 92% 50%)", "hsl(24 80% 35%)", "hsl(150 40% 55%)"];

const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString());
const fmtKES = (n) => (n == null ? "—" : `KES ${Number(n).toLocaleString()}`);

export default function Training() {
  const [filters, setFilters] = useState({ categories: [], training_names: [], departments: [], delivery_methods: [], locations: [], earliest_date: null, latest_date: null });

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [category, setCategory] = useState("all");
  const [trainingName, setTrainingName] = useState("all");
  const [department, setDepartment] = useState("all");
  const [deliveryMethod, setDeliveryMethod] = useState("all");

  const [overview, setOverview] = useState(null);
  const [trainingStatus, setTrainingStatus] = useState([]);
  const [byDepartment, setByDepartment] = useState([]);
  const [byDelivery, setByDelivery] = useState([]);
  const [duration, setDuration] = useState([]);
  const [budget, setBudget] = useState([]);
  const [lateness, setLateness] = useState({ by_training: [], detail: [] });
  const [topEmployees, setTopEmployees] = useState([]);
  const [monthlyTrend, setMonthlyTrend] = useState([]);
  const [facilitators, setFacilitators] = useState([]);
  const [uniqueSessionDates, setUniqueSessionDates] = useState(null);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // Load filter options once
  useEffect(() => {
    trainingClient.get("/filters").then(({ data }) => {
      setFilters(data || {});
      if (!dateFrom && data?.earliest_date) setDateFrom(data.earliest_date);
      if (!dateTo && data?.latest_date) setDateTo(data.latest_date);
    }).catch(() => {});
    // eslint-disable-next-line
  }, []);

  const params = useMemo(() => {
    const p = {};
    if (dateFrom) p.date_from = dateFrom;
    if (dateTo) p.date_to = dateTo;
    if (category !== "all") p.category = category;
    if (trainingName !== "all") p.training_name = trainingName;
    if (department !== "all") p.department = department;
    if (deliveryMethod !== "all") p.delivery_method = deliveryMethod;
    return p;
  }, [dateFrom, dateTo, category, trainingName, department, deliveryMethod]);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const [ov, ts, bd, bdm, du, bu, la, te, mt, fc] = await Promise.all([
        trainingClient.get("/overview", { params }).then((r) => r.data),
        trainingClient.get("/training-status", { params }).then((r) => r.data),
        trainingClient.get("/by-department", { params }).then((r) => r.data),
        trainingClient.get("/by-delivery-method", { params }).then((r) => r.data),
        trainingClient.get("/duration", { params }).then((r) => r.data),
        trainingClient.get("/budget", { params }).then((r) => r.data),
        trainingClient.get("/lateness", { params }).then((r) => r.data),
        trainingClient.get("/top-employees", { params }).then((r) => r.data),
        trainingClient.get("/monthly-trend", { params }).then((r) => r.data),
        trainingClient.get("/facilitators", { params }).then((r) => r.data),
      ]);
      setOverview(ov);
      setTrainingStatus(ts || []);
      setByDepartment(bd || []);
      setByDelivery(bdm || []);
      setDuration(du || []);
      setBudget(bu || []);
      setLateness(la || { by_training: [], detail: [] });
      setTopEmployees(te || []);
      setMonthlyTrend(mt || []);
      setFacilitators(fc || []);

      // Compute "unique training-session dates" by aggregating /employee-history calls
      // for the top 25 employees and deduplicating training_date values.
      // The training API has no global "list all session dates" endpoint, so we infer.
      const sample = (te || []).slice(0, 25).filter((e) => e.employee_name && e.employee_name !== "-");
      const histories = await Promise.all(
        sample.map((e) =>
          trainingClient.get("/employee-history", { params: { employee: e.employee_name } })
            .then((r) => r.data || [])
            .catch(() => [])
        )
      );
      const allDates = new Set();
      histories.forEach((rows) => rows.forEach((r) => { if (r.training_date) allDates.add(r.training_date); }));
      setUniqueSessionDates(allDates.size);
    } catch (e) { setErr(e?.message || "Failed to load training data"); }
    finally { setLoading(false); }
  }, [params]);

  useEffect(() => { if (dateFrom && dateTo) load(); /* eslint-disable-next-line */ }, [dateFrom, dateTo]);

  const top5 = topEmployees.slice(0, 5);
  const top10 = topEmployees.slice(0, 10);

  const exportXLS = () => {
    exportToExcel(
      top10.map((e) => ({
        Employee: e.employee_name, Code: e.employee_code, Department: e.department,
        Designation: e.designation, "Trainings": e.unique_trainings,
        "Sessions": e.total_sessions, "Hours Trained": e.total_hours_trained,
      })),
      `training-top10-${dateFrom}-to-${dateTo}.xlsx`, "Top Employees"
    );
  };
  const exportPDF = () => {
    exportToPDF({
      title: "Vivo Staff Training Tracking",
      subtitle: `${dateFrom} → ${dateTo}`,
      headers: ["Training", "Category", "Employees", "Sessions", "Avg Hrs Actual", "Avg Hrs Expected", "Budget"],
      rows: trainingStatus.map((t) => [
        t.training_name, t.category, t.employees_trained, t.total_sessions,
        t.avg_hours_actual?.toFixed?.(1) ?? "—", t.avg_hours_expected?.toFixed?.(1) ?? "—",
        fmtKES(t.total_budget),
      ]),
      filename: `vivo-training-${dateFrom}-to-${dateTo}.pdf`,
    });
  };

  return (
    <AppLayout onRefresh={load}>
      <PageHeader
        title="Staff Training"
        subtitle="Vivo Fashion Group · training participation, duration, budget and lateness"
        testId="training-header"
        actions={<>
          <Button variant="outline" size="sm" onClick={exportXLS} className="rounded-full text-[11px] font-bold uppercase tracking-wider"><FileDown className="h-3.5 w-3.5 mr-1.5" />Excel</Button>
          <Button variant="outline" size="sm" onClick={exportPDF} className="rounded-full text-[11px] font-bold uppercase tracking-wider"><FileText className="h-3.5 w-3.5 mr-1.5" />PDF</Button>
        </>}
      />

      {/* Filters */}
      <Card className="rounded-2xl border border-border bg-card p-4 mb-5 shadow-none">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3 items-end">
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">From</Label>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} data-testid="tr-from" className="h-9 rounded-full border-border bg-panel/40" />
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">To</Label>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} data-testid="tr-to" className="h-9 rounded-full border-border bg-panel/40" />
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger data-testid="tr-category" className="h-9 rounded-full border-border bg-panel/40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {filters.categories?.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Training</Label>
            <Select value={trainingName} onValueChange={setTrainingName}>
              <SelectTrigger data-testid="tr-name" className="h-9 rounded-full border-border bg-panel/40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All trainings</SelectItem>
                {filters.training_names?.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Department</Label>
            <Select value={department} onValueChange={setDepartment}>
              <SelectTrigger data-testid="tr-dept" className="h-9 rounded-full border-border bg-panel/40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All depts</SelectItem>
                {filters.departments?.filter((d) => d && d !== "-").map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Method</Label>
            <Select value={deliveryMethod} onValueChange={setDeliveryMethod}>
              <SelectTrigger data-testid="tr-method" className="h-9 rounded-full border-border bg-panel/40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All methods</SelectItem>
                {filters.delivery_methods?.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={load} className="rounded-full bg-brand hover:bg-brand-deep text-background text-[11px] font-bold uppercase tracking-wider" data-testid="tr-apply">Apply</Button>
        </div>
      </Card>

      {err && <ErrorState message={err} />}
      {loading ? <LoadingState label="Loading training data…" /> : (
        <>
          {/* KPI grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 animate-stagger" data-testid="tr-kpis">
            <KpiCard testId="tr-kpi-trained" title="Total trained" accent="brand" icon={GraduationCap}
              value={fmtNum(overview?.total_trained)} sub="employees attended" />
            <KpiCard testId="tr-kpi-sessions" title="Session days" icon={Calendar}
              value={uniqueSessionDates != null ? fmtNum(uniqueSessionDates) : "—"} sub="unique training dates" />
            <KpiCard testId="tr-kpi-unique" title="Unique employees" icon={Users}
              value={fmtNum(overview?.unique_employees)} sub="distinct attendees" />
            <KpiCard testId="tr-kpi-trainings" title="Trainings run" icon={Layers}
              value={fmtNum(overview?.total_trainings)} sub="distinct programs" />
            <KpiCard testId="tr-kpi-depts" title="Departments" icon={Building}
              value={fmtNum(overview?.departments_trained)} sub="reached" />
            <KpiCard testId="tr-kpi-budget" title="Actual budget" icon={Banknote}
              value={fmtKES(overview?.total_actual_budget)} sub="total cost" />
            <KpiCard testId="tr-kpi-avghours" title="Avg hours / session" icon={Clock}
              value={overview?.avg_hours_per_session ? `${overview.avg_hours_per_session.toFixed(1)}h` : "—"} sub="per attendee" />
          </div>

          {/* Row: Training status + Delivery method */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-5">
            <Card className="lg:col-span-2 rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-3">
                <div className="eyebrow">Training status</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Employees trained per program</h3>
              </div>
              <div className="h-[280px]" data-testid="tr-status-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trainingStatus} margin={{ left: 0, right: 12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                    <XAxis dataKey="training_name" tick={{ fontSize: 11, fontWeight: 600 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="employees_trained" name="Employees" radius={[8, 8, 0, 0]} fill="hsl(var(--brand))" />
                    <Bar dataKey="total_sessions" name="Sessions" radius={[8, 8, 0, 0]} fill="hsl(var(--accent-mid))" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-3">
                <div className="eyebrow">Delivery method</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">In-person · virtual · hybrid</h3>
              </div>
              <div className="h-[280px]" data-testid="tr-delivery-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={byDelivery} layout="vertical" margin={{ left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="delivery_method" tick={{ fontSize: 11, fontWeight: 600 }} width={90} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 }} />
                    <Bar dataKey="unique_employees" name="Employees" radius={[0, 8, 8, 0]} fill="hsl(var(--brand))" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-1.5">
                {byDelivery.map((d) => (
                  <div key={d.delivery_method} className="flex items-center justify-between rounded-xl border border-border bg-panel/40 p-2 text-[12px]">
                    <span className="font-semibold">{d.delivery_method}</span>
                    <span className="tabular-nums text-muted-foreground">{d.unique_employees} ppl · {d.total_sessions} sessions</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Row: By Department + Top Employees */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
            <Card className="rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-3">
                <div className="eyebrow flex items-center gap-1.5"><Trophy className="h-3 w-3" />Top departments trained</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Department reach</h3>
              </div>
              <div className="space-y-2" data-testid="tr-dept-list">
                {byDepartment.map((d, i) => {
                  const max = Math.max(...byDepartment.map((x) => x.unique_employees || 0));
                  const pct = max ? ((d.unique_employees || 0) / max) * 100 : 0;
                  return (
                    <div key={d.department} className={`rounded-2xl border p-3 ${i === 0 ? "border-brand bg-brand/[0.04]" : "border-border bg-panel/40"}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className={`grid h-7 w-7 place-items-center rounded-full text-[11px] font-bold ${i === 0 ? "bg-brand text-background" : "bg-accent-soft text-accent-deep"}`}>{i + 1}</div>
                          <div>
                            <div className="font-semibold text-[13px]">{d.department}</div>
                            <div className="text-[11px] text-muted-foreground tabular-nums">{d.trainings_attended} programs · {d.total_sessions} sessions · {(d.avg_hours || 0).toFixed(1)}h avg</div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold text-lg tabular-nums text-brand-deep">{d.unique_employees}</div>
                          <div className="eyebrow text-[9px]">employees</div>
                        </div>
                      </div>
                      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-panel">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: i === 0 ? "hsl(var(--brand))" : "hsl(var(--accent-mid))" }} />
                      </div>
                    </div>
                  );
                })}
                {byDepartment.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">No data</div>}
              </div>
            </Card>

            <Card className="rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-3">
                <div className="eyebrow flex items-center gap-1.5"><Award className="h-3 w-3" />Top employees trained</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">By sessions attended</h3>
              </div>
              <div className="space-y-1.5 max-h-[420px] overflow-y-auto scrollbar-thin" data-testid="tr-top-employees">
                {top10.map((e, i) => (
                  <div key={`${e.employee_code}-${i}`} className={`flex items-center gap-3 rounded-xl p-2.5 ${i < 5 ? "bg-brand/[0.05]" : "bg-panel/40"}`}>
                    <div className={`grid h-7 w-7 place-items-center rounded-full text-[11px] font-bold ${i < 5 ? "bg-brand text-background" : "bg-accent-soft text-accent-deep"}`}>{i + 1}</div>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-[13px] truncate">{e.employee_name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{e.designation} · {e.department}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-bold text-[13px] tabular-nums">{e.total_sessions}</div>
                      <div className="text-[10px] text-muted-foreground tabular-nums">{(e.total_hours_trained || 0).toFixed(1)}h</div>
                    </div>
                  </div>
                ))}
                {top10.length === 0 && <div className="py-6 text-center text-sm text-muted-foreground">No data</div>}
              </div>
            </Card>
          </div>

          {/* Row: Duration + Budget */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
            <Card className="rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-3">
                <div className="eyebrow">Training duration</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Actual vs expected hours</h3>
              </div>
              <div className="h-[260px]" data-testid="tr-duration-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={duration} margin={{ left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                    <XAxis dataKey="training_name" tick={{ fontSize: 11, fontWeight: 600 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="avg_expected_hours" name="Expected (avg h)" fill="hsl(var(--accent-mid))" radius={[8, 8, 0, 0]} />
                    <Bar dataKey="avg_actual_hours" name="Actual (avg h)" fill="hsl(var(--brand))" radius={[8, 8, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-3">
                <div className="eyebrow">Budget</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Cost per training program</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="tr-budget">
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={budget.filter((b) => (b.actual_cost || 0) > 0)} dataKey="actual_cost" nameKey="training_name"
                        cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2}>
                        {budget.map((_, i) => <Cell key={i} fill={STATUS_COLORS[i % STATUS_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v) => fmtKES(v)} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2">
                  {budget.map((b, i) => (
                    <div key={b.training_name} className="rounded-xl border border-border bg-panel/40 p-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full inline-block" style={{ background: STATUS_COLORS[i % STATUS_COLORS.length] }} />
                          <div className="font-semibold text-[12px]">{b.training_name}</div>
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                        {fmtKES(b.actual_cost)} · {b.employees} ppl · {fmtKES(b.avg_cost_per_person)}/ea
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          {/* Row: Lateness + Monthly trend */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
            <Card className="lg:col-span-2 rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-3">
                <div className="eyebrow flex items-center gap-1.5"><Calendar className="h-3 w-3" />Monthly trend</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Sessions & employees by month</h3>
              </div>
              <div className="h-[260px]" data-testid="tr-monthly-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={monthlyTrend} margin={{ left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fontWeight: 600 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="unique_employees" name="Unique employees" stroke="hsl(var(--brand))" strokeWidth={2.5} dot={{ r: 4 }} />
                    <Line type="monotone" dataKey="total_sessions" name="Sessions" stroke="hsl(var(--accent-mid))" strokeWidth={2.5} dot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="rounded-2xl border border-border bg-card p-5 shadow-none">
              <div className="mb-3">
                <div className="eyebrow flex items-center gap-1.5"><AlertTriangle className="h-3 w-3" />Lateness</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Avg lateness per training</h3>
              </div>
              <div className="space-y-2" data-testid="tr-lateness">
                {(lateness.by_training || []).map((l) => (
                  <div key={l.training_name} className="rounded-xl border border-border bg-panel/40 p-3">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-[13px]">{l.training_name}</div>
                      <div className="font-bold text-[13px] tabular-nums text-accent-deep">{(l.avg_lateness_hours || 0).toFixed(1)}h</div>
                    </div>
                    <div className="text-[10.5px] text-muted-foreground tabular-nums">{l.participants} participants · max {l.max_lateness_hours?.toFixed?.(1)}h</div>
                    <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-panel">
                      <div className="h-full rounded-full bg-accent-mid"
                        style={{ width: `${Math.min(100, ((l.avg_lateness_hours || 0) / Math.max(1, ...lateness.by_training.map((x) => x.max_lateness_hours || 1))) * 100)}%` }} />
                    </div>
                  </div>
                ))}
                {(lateness.by_training || []).length === 0 && <div className="py-4 text-center text-sm text-muted-foreground">No lateness data</div>}
              </div>
            </Card>
          </div>

          {/* Co-facilitators */}
          {facilitators.length > 0 && (
            <Card className="rounded-2xl border border-border bg-card p-5 mt-4 shadow-none">
              <div className="mb-3">
                <div className="eyebrow">Co-facilitators</div>
                <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Trainers behind the programs</h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5" data-testid="tr-cofacilitators">
                {facilitators.map((f) => (
                  <div key={f.facilitator} className="rounded-xl border border-border bg-panel/40 p-3">
                    <div className="font-semibold text-[13px]">{f.facilitator}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                      {f.trainings_conducted} programs · {f.employees_trained} ppl · {f.total_sessions} sessions · {fmtKES(f.total_budget)}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </AppLayout>
  );
}
