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
import { yesterday } from "../lib/dates";
import { usePersistedDateRange, usePersistedFilter } from "../lib/persistedFilters";
import DateRangePicker from "../components/DateRangePicker";
import { exportToExcel, exportToPDF } from "../lib/exports";
import { FileDown, FileText, Search, ArrowUpDown } from "lucide-react";
import { useAuth } from "../lib/auth";

const COUNTRY_NAMES = { KE: "Kenya", UG: "Uganda", RW: "Rwanda" };

export default function DaysWorked() {
  const { user } = useAuth();
  const [dateFrom, dateTo, setDateFrom, setDateTo] = usePersistedDateRange(yesterday(), yesterday());
  const [country, setCountry] = usePersistedFilter("country", "all");
  const [location, setLocation] = usePersistedFilter("location", "all");
  const [branch, setBranch] = useState(user?.branch_assignment || "all");
  const [empQuery, setEmpQuery] = useState("");
  const [branches, setBranches] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [sort, setSort] = useState({ key: "days_present", dir: "desc" });

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
      if (empQuery.trim()) params.employee = empQuery.trim();
      const { data } = await vivoClient.get("/days-worked", { params });
      let merged = (data || []).map((r) => {
        if (isHQSource(r.branch_name)) return { ...r, branch_name: HQ_LABEL, _hq_source: r.branch_name };
        return r;
      });
      // Aggregate duplicate HQ rows (an employee with rows from multiple HQ devices)
      if (branch === HQ_LABEL || location === "HQ" || location === "all") {
        const map = new Map();
        for (const r of merged) {
          const k = r.branch_name === HQ_LABEL ? `HQ::${r.employee_name}` : `${r.branch_name}::${r.employee_name}`;
          const cur = map.get(k);
          if (!cur) { map.set(k, { ...r }); continue; }
          // sum numerics
          ["total_days_recorded","days_present","days_missing_checkout","days_absent","total_hours_worked","days_late","days_overtime","days_undertime"].forEach((f) => { cur[f] = (Number(cur[f])||0) + (Number(r[f])||0); });
          cur.avg_hours_per_day = cur.total_hours_worked && cur.days_present ? cur.total_hours_worked / cur.days_present : null;
        }
        merged = Array.from(map.values());
      }
      if (user?.role === "branch_manager" && user.branch_assignment) {
        merged = merged.filter((r) => r.branch_name === user.branch_assignment);
      }
      setRows(merged);
    } catch (e) { setErr(e?.message || "Failed to load"); }
    finally { setLoading(false); }
  }, [dateFrom, dateTo, country, location, branch, empQuery, user]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const filtered = useMemo(() => {
    const q = empQuery.trim().toLowerCase();
    let list = rows;
    if (q) list = list.filter((r) => (r.employee_name || "").toLowerCase().includes(q));
    const { key, dir } = sort;
    const sorted = [...list].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
      return dir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
    return sorted;
  }, [rows, empQuery, sort]);

  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }));

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
      Employee: r.employee_name, Branch: r.branch_name, Location: r.location,
      Country: COUNTRY_NAMES[r.branch_country] || r.branch_country,
      "Days Recorded": r.total_days_recorded, "Days Present": r.days_present,
      "Missing Checkout": r.days_missing_checkout, "Days Absent": r.days_absent,
      "Total Hours": r.total_hours_worked, "Avg Hrs/Day": r.avg_hours_per_day,
      "Avg Check-in": r.avg_check_in_time, "Avg Check-out": r.avg_check_out_time,
      "Days Late": r.days_late, "Days OT": r.days_overtime, "Days UT": r.days_undertime,
    })),
    `days-worked-${dateFrom}-to-${dateTo}.xlsx`, "Days Worked"
  );
  const pdf = () => exportToPDF({
    title: "Days Worked",
    subtitle: `${dateFrom} → ${dateTo} · ${branch === "all" ? "All branches" : branch}`,
    headers: ["Employee", "Branch", "Loc", "Days", "Present", "Missing", "Hrs", "Late", "OT"],
    rows: filtered.map((r) => [r.employee_name, r.branch_name, r.location, r.total_days_recorded, r.days_present, r.days_missing_checkout, (r.total_hours_worked||0).toFixed(1), r.days_late, r.days_overtime]),
    filename: `days-worked-${dateFrom}-to-${dateTo}.pdf`,
  });

  return (
    <AppLayout onRefresh={load}>
      <PageHeader
        title="Days Worked"
        subtitle="Per-employee days present, missing checkout, hours, late/overtime — searchable"
        testId="dw-header"
        actions={<>
          <Button variant="outline" size="sm" onClick={xlsx} className="rounded-full text-[11px] font-bold uppercase tracking-wider"><FileDown className="h-3.5 w-3.5 mr-1.5" />Excel</Button>
          <Button variant="outline" size="sm" onClick={pdf} className="rounded-full text-[11px] font-bold uppercase tracking-wider"><FileText className="h-3.5 w-3.5 mr-1.5" />PDF</Button>
        </>}
      />

      <Card className="rounded-2xl border border-border bg-card p-4 mb-5 shadow-none">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3 items-end">
          <div className="lg:col-span-2">
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Date range</Label>
            <DateRangePicker
              value={{ from: dateFrom, to: dateTo }}
              onChange={({ from, to }) => { setDateFrom(from); setDateTo(to); }}
              testId="dw-daterange"
              className="w-full"
            />
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Country</Label>
            <Select value={country} onValueChange={setCountry} disabled={user?.role === "branch_manager"}>
              <SelectTrigger className="h-9 rounded-full border-border bg-panel/40" data-testid="dw-country"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All countries</SelectItem>
                <SelectItem value="KE">Kenya</SelectItem>
                <SelectItem value="UG">Uganda</SelectItem>
                <SelectItem value="RW">Rwanda</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <LocationFilter value={location} onChange={setLocation} testId="dw-location" />
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Branch</Label>
            <Select value={branch} onValueChange={setBranch} disabled={user?.role === "branch_manager"}>
              <SelectTrigger className="h-9 rounded-full border-border bg-panel/40" data-testid="dw-branch"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {branches.map((b) => <SelectItem key={b.branch_name} value={b.branch_name}>{b.branch_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Employee</Label>
            <Search className="absolute left-3 top-[30px] h-3.5 w-3.5 text-muted-foreground" />
            <Input value={empQuery} onChange={(e) => setEmpQuery(e.target.value)} placeholder="Search name…" className="h-9 rounded-full border-border bg-panel/40 pl-9" data-testid="dw-emp" />
          </div>
          <Button onClick={load} className="rounded-full bg-brand hover:bg-brand-deep text-background text-[11px] font-bold uppercase tracking-wider" data-testid="dw-apply">Apply</Button>
        </div>
      </Card>

      {err && <ErrorState message={err} />}
      <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-none">
        {loading ? <LoadingState /> : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm" data-testid="dw-table">
              <thead className="bg-panel/40 text-xs uppercase tracking-wider text-muted-foreground sticky top-0">
                <tr>
                  <SortHead k="employee_name" label="Employee" />
                  <SortHead k="branch_name" label="Branch" />
                  <SortHead k="location" label="Loc" />
                  <SortHead k="total_days_recorded" label="Days" right />
                  <SortHead k="days_present" label="Present" right />
                  <SortHead k="days_missing_checkout" label="Missing" right />
                  <SortHead k="total_hours_worked" label="Total Hrs" right />
                  <SortHead k="avg_hours_per_day" label="Avg/Day" right />
                  <th className="px-3 py-3 text-left font-semibold">Avg in/out</th>
                  <SortHead k="days_late" label="Late" right />
                  <SortHead k="days_overtime" label="OT" right />
                  <SortHead k="days_undertime" label="UT" right />
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map((r, i) => (
                  <tr key={i} className="border-t border-border hover:bg-panel/40 transition-colors" data-testid={`dw-row-${i}`}>
                    <td className="px-3 py-2.5 font-semibold whitespace-nowrap">{r.employee_name}</td>
                    <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{r.branch_name}</td>
                    <td className="px-3 py-2.5"><span className="pill">{r.location}</span></td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{r.total_days_recorded}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-success">{r.days_present}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-warning">{r.days_missing_checkout}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{(r.total_hours_worked || 0).toFixed(1)}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{r.avg_hours_per_day != null ? r.avg_hours_per_day.toFixed(1) : "—"}</td>
                    <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap text-muted-foreground">{r.avg_check_in_time || "—"} / {r.avg_check_out_time || "—"}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-accent-deep">{r.days_late}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{r.days_overtime}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{r.days_undertime}</td>
                  </tr>
                ))}
                {filtered.length === 0 && !loading && (
                  <tr><td colSpan={12} className="px-4 py-16 text-center text-muted-foreground">No employees found</td></tr>
                )}
              </tbody>
            </table>
            {filtered.length > 500 && (
              <div className="border-t border-border bg-panel/30 p-3 text-center text-xs text-muted-foreground">
                Showing first 500 of {filtered.length}. Narrow filters to see more.
              </div>
            )}
          </div>
        )}
      </Card>
    </AppLayout>
  );
}
