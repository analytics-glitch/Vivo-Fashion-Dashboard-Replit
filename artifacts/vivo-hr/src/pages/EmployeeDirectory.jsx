import React, { useEffect, useMemo, useState, useCallback } from "react";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { vivoClient } from "../lib/api";
import { exportToExcel } from "../lib/exports";
import { Search, ArrowUpDown, FileDown, Users, Building2, Layers, Link2 } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";

const BAR_COLORS = [
  "hsl(var(--brand))", "hsl(var(--accent))", "#7c3aed", "#0ea5e9",
  "#f59e0b", "#ef4444", "#10b981", "#6366f1", "#ec4899", "#14b8a6",
];

function StatCard({ icon: Icon, label, value, hint, testId }) {
  return (
    <Card className="rounded-2xl border border-border bg-card p-4 shadow-none" data-testid={testId}>
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

export default function EmployeeDirectory() {
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [entity, setEntity] = useState("all");
  const [department, setDepartment] = useState("all");
  const [matched, setMatched] = useState("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "name", dir: "asc" });

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const params = {};
      if (entity !== "all") params.entity = entity;
      if (department !== "all") params.department = department;
      if (matched !== "all") params.matched = matched;
      if (q.trim()) params.q = q.trim();
      const [empRes, sumRes] = await Promise.all([
        vivoClient.get("/employees", { params }),
        vivoClient.get("/employees/summary"),
      ]);
      setRows(empRes.data || []);
      setSummary(sumRes.data || null);
    } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [entity, department, matched, q]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const entities = useMemo(
    () => (summary?.by_entity || []).map((e) => e.entity).filter(Boolean),
    [summary]
  );
  const departments = useMemo(
    () => (summary?.by_department || []).map((d) => d.department).filter(Boolean),
    [summary]
  );

  const deptChart = useMemo(
    () => (summary?.by_department || []).slice(0, 10).map((d) => ({ name: d.department, count: d.count })),
    [summary]
  );

  const filtered = useMemo(() => {
    const { key, dir } = sort;
    return [...rows].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
      return dir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
  }, [rows, sort]);

  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));

  const SortHead = ({ k, label, right = false }) => (
    <th className={`px-3 py-3 ${right ? "text-right" : "text-left"} font-semibold cursor-pointer select-none hover:text-brand-deep`}
      onClick={() => toggleSort(k)} data-testid={`sort-${k}`}>
      <span className={`inline-flex items-center gap-1 ${right ? "flex-row-reverse" : ""}`}>
        {label}
        <ArrowUpDown className={`h-3 w-3 ${sort.key === k ? "text-brand" : "text-muted-foreground/50"}`} />
      </span>
    </th>
  );

  const xlsx = () => exportToExcel(
    filtered.map((r) => ({
      Name: r.name, "Staff No": r.employee_id, Entity: r.entity, Country: r.country,
      Department: r.department || "", Team: r.team || "", "Job Title": r.job_title || "",
      "Attendance Linked": r.linked ? "Yes" : "No", "Attendance Aliases": r.attendance_aliases,
    })),
    "employee-directory.xlsx", "Employees"
  );

  const coverage = summary && summary.total_employees
    ? Math.round((summary.linked_employees / summary.total_employees) * 100)
    : 0;

  return (
    <AppLayout onRefresh={load}>
      <PageHeader
        title="Employee Directory"
        subtitle="Official roster from the company sheet, linked to biometric attendance by name"
        testId="dir-header"
      />

      {err && <ErrorState message={err} />}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard icon={Users} label="Employees" value={summary?.total_employees ?? "—"}
          hint={`${entities.length} entities`} testId="stat-total" />
        <StatCard icon={Building2} label="Departments" value={departments.length || "—"}
          hint="across all entities" testId="stat-depts" />
        <StatCard icon={Link2} label="Linked to attendance" value={summary?.linked_employees ?? "—"}
          hint={`${coverage}% of roster`} testId="stat-linked" />
        <StatCard icon={Layers} label="Unmatched names" value={summary?.unmatched_aliases ?? "—"}
          hint="attendance names w/o roster" testId="stat-unmatched" />
      </div>

      {deptChart.length > 0 && (
        <Card className="rounded-2xl border border-border bg-card p-4 mb-5 shadow-none" data-testid="dept-chart-card">
          <div className="text-[11px] font-bold uppercase tracking-wider text-brand-deep mb-3">
            Headcount by department (top 10)
          </div>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={deptChart} margin={{ top: 4, right: 12, left: 0, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="name" angle={-35} textAnchor="end" interval={0} height={70}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                <Tooltip
                  cursor={{ fill: "hsl(var(--muted) / 0.3)" }}
                  contentStyle={{
                    background: "hsl(var(--card))", border: "1px solid hsl(var(--border))",
                    borderRadius: 12, fontSize: 12,
                  }}
                />
                <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                  {deptChart.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card className="rounded-2xl border border-border bg-card p-4 mb-5 shadow-none">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div className="relative lg:col-span-2">
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Search</Label>
            <Search className="absolute left-3 top-[30px] h-3.5 w-3.5 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              placeholder="Name or staff no…" className="h-9 rounded-full border-border bg-panel/40 pl-9"
              data-testid="dir-search" />
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Entity</Label>
            <Select value={entity} onValueChange={setEntity}>
              <SelectTrigger className="h-9 rounded-full border-border bg-panel/40" data-testid="dir-entity"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All entities</SelectItem>
                {entities.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Department</Label>
            <Select value={department} onValueChange={setDepartment}>
              <SelectTrigger className="h-9 rounded-full border-border bg-panel/40" data-testid="dir-dept"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Attendance link</Label>
            <Select value={matched} onValueChange={setMatched}>
              <SelectTrigger className="h-9 rounded-full border-border bg-panel/40" data-testid="dir-matched"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="yes">Linked only</SelectItem>
                <SelectItem value="no">Unlinked only</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={load} className="rounded-full bg-brand hover:bg-brand-deep text-background text-[11px] font-bold uppercase tracking-wider px-4 h-9" data-testid="dir-apply">Apply</button>
          <button onClick={xlsx} className="inline-flex items-center rounded-full border border-border text-[11px] font-bold uppercase tracking-wider px-4 h-9 hover:bg-panel/40" data-testid="dir-export">
            <FileDown className="h-3.5 w-3.5 mr-1.5" />Excel
          </button>
          <span className="ml-auto text-[11px] text-muted-foreground">{filtered.length} employees</span>
        </div>
      </Card>

      <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-none">
        {loading ? <LoadingState /> : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm" data-testid="dir-table">
              <thead className="bg-panel/40 text-xs uppercase tracking-wider text-muted-foreground sticky top-0">
                <tr>
                  <SortHead k="name" label="Name" />
                  <SortHead k="employee_id" label="Staff No" />
                  <SortHead k="entity" label="Entity" />
                  <SortHead k="department" label="Department" />
                  <SortHead k="team" label="Team" />
                  <SortHead k="job_title" label="Job Title" />
                  <th className="px-3 py-3 text-center font-semibold">Attendance</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 600).map((r, i) => (
                  <tr key={r.id ?? i} className="border-t border-border hover:bg-panel/40 transition-colors" data-testid={`dir-row-${i}`}>
                    <td className="px-3 py-2.5 font-semibold whitespace-nowrap">{r.name}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{r.employee_id || "—"}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{r.entity}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{r.department || <span className="text-muted-foreground/60">—</span>}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{r.team || "—"}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{r.job_title || "—"}</td>
                    <td className="px-3 py-2.5 text-center">
                      {r.linked ? (
                        <span className="pill bg-success/10 text-success">Linked</span>
                      ) : (
                        <span className="pill text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && !loading && (
                  <tr><td colSpan={7} className="px-4 py-16 text-center text-muted-foreground">No employees found</td></tr>
                )}
              </tbody>
            </table>
            {filtered.length > 600 && (
              <div className="border-t border-border bg-panel/30 p-3 text-center text-xs text-muted-foreground">
                Showing first 600 of {filtered.length}. Narrow filters to see more.
              </div>
            )}
          </div>
        )}
      </Card>
    </AppLayout>
  );
}
