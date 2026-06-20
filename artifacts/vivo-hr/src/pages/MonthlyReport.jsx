import React, { useEffect, useState, useMemo, useCallback } from "react";
import { vivoClient, monthStartISO, todayISO, consolidateHQBranches, expandBranchName, rebrandHQRow } from "../lib/api";
import { fetchAllBranches } from "../lib/branches";
import { yesterday, previousPeriod } from "../lib/dates";
import { usePersistedDateRange, usePersistedFilter } from "../lib/persistedFilters";
import DateRangePicker from "../components/DateRangePicker";
import { useSort } from "../lib/useSort";
import DeltaChip from "../components/DeltaChip";
import { Switch } from "../components/ui/switch";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import LocationFilter from "../components/LocationFilter";
import { exportToExcel, exportToPDF } from "../lib/exports";
import { FileDown, FileText } from "lucide-react";
import { useAuth } from "../lib/auth";

const COUNTRY_NAMES = { KE: "Kenya", UG: "Uganda", RW: "Rwanda" };

export default function MonthlyReport() {
  const { user } = useAuth();
  const [country, setCountry] = usePersistedFilter("country", "all");
  const [location, setLocation] = usePersistedFilter("location", "all");
  const [branch, setBranch] = useState(user?.branch_assignment || "all");
  const [branches, setBranches] = useState([]);
  const [dateFrom, dateTo, setDateFrom, setDateTo] = usePersistedDateRange(yesterday(), yesterday());
  const [rows, setRows] = useState([]);
  const [prevRows, setPrevRows] = useState([]);
  const [compare, setCompare] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");

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
      const { data: rawBranches } = await vivoClient.get("/branches");
      const params = { date_from: dateFrom, date_to: dateTo };
      if (country !== "all") params.country = country;
      if (location !== "all") params.location = location;
      const fetchSet = async (p) => {
        if (branch === "all" || !branch) {
          const { data } = await vivoClient.get("/employee-summary", { params: p });
          return (data || []).map(rebrandHQRow);
        }
        const sources = expandBranchName(branch, rawBranches);
        const batches = await Promise.all(
          sources.map((s) =>
            vivoClient.get("/employee-summary", { params: { ...p, branch: s } })
              .then((r) => r.data || []).catch(() => [])
          )
        );
        return batches.flat().map(rebrandHQRow);
      };
      let merged = await fetchSet(params);
      if (user?.role === "branch_manager" && user.branch_assignment) {
        merged = merged.filter((r) => r.branch_name === user.branch_assignment);
      }
      setRows(merged);
      if (compare) {
        const pp = previousPeriod(dateFrom, dateTo);
        let prev = await fetchSet({ ...params, date_from: pp.from, date_to: pp.to });
        if (user?.role === "branch_manager" && user.branch_assignment) {
          prev = prev.filter((r) => r.branch_name === user.branch_assignment);
        }
        setPrevRows(prev);
      } else {
        setPrevRows([]);
      }
    } catch (e) { setErr(e?.message || "Failed to load report"); }
    finally { setLoading(false); }
  }, [country, location, branch, dateFrom, dateTo, compare, user]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const filtered = rows.filter((r) => !search || r.employee_name?.toLowerCase().includes(search.toLowerCase()));
  const { sorted: sortedFiltered, SortHead } = useSort(filtered, { key: "attendance_rate", dir: "desc" });

  const aggregate = (list) => {
    const acc = { employees: list.length, present: 0, absent: 0, late: 0, totalHours: 0, sumRate: 0, n: 0 };
    list.forEach((r) => {
      acc.present += r.days_present || 0;
      acc.absent += r.days_absent || 0;
      acc.late += r.days_late || 0;
      acc.totalHours += r.total_hours_worked || 0;
      if (r.attendance_rate != null) { acc.sumRate += r.attendance_rate; acc.n += 1; }
    });
    acc.avgRate = acc.n ? acc.sumRate / acc.n : 0;
    return acc;
  };
  const curr = useMemo(() => aggregate(rows), [rows]);
  const prev = useMemo(() => aggregate(prevRows), [prevRows]);

  const xlsx = () => {
    exportToExcel(
      filtered.map((r) => ({
        Employee: r.employee_name, Branch: r.branch_name, Country: COUNTRY_NAMES[r.branch_country] || r.branch_country,
        "Days Total": r.total_days, "Days Present": r.days_present, "Missing Checkout": r.days_missing_checkout,
        "Days Absent": r.days_absent, "Days Late": r.days_late, "Early Departures": r.days_early_departure,
        Overtime: r.days_overtime, Undertime: r.days_undertime,
        "Avg Hours": r.avg_hours_worked?.toFixed?.(2), "Total Hours": r.total_hours_worked?.toFixed?.(2),
        "Attendance Rate %": r.attendance_rate?.toFixed?.(1),
      })),
      `monthly-report-${dateFrom}-to-${dateTo}.xlsx`, "Monthly Report"
    );
  };

  const pdf = () => {
    exportToPDF({
      title: "Monthly HR Report",
      subtitle: `${branch === "all" ? "All branches" : branch} · ${dateFrom} → ${dateTo}`,
      headers: ["Employee", "Branch", "Days", "Present", "Absent", "Late", "OT", "UT", "Avg Hrs", "Rate %"],
      rows: filtered.map((r) => [
        r.employee_name, r.branch_name, r.total_days, r.days_present, r.days_absent,
        r.days_late, r.days_overtime, r.days_undertime,
        r.avg_hours_worked?.toFixed?.(1) || "—",
        (r.attendance_rate || 0).toFixed(1) + "%",
      ]),
      filename: `monthly-report-${dateFrom}-to-${dateTo}.pdf`,
    });
  };

  const cellTone = (val, type) => {
    if (type === "rate") {
      if (val >= 90) return "text-emerald-600 font-semibold";
      if (val >= 75) return "text-amber-600 font-semibold";
      return "text-rose-600 font-semibold";
    }
    return "";
  };

  return (
    <AppLayout onRefresh={load}>
      <PageHeader title="Monthly HR Report" subtitle="Auto-generated per-employee summary with full export" testId="report-header"
        actions={<>
          <Button variant="outline" size="sm" onClick={xlsx} data-testid="report-excel"><FileDown className="h-4 w-4 mr-2" />Excel</Button>
          <Button variant="outline" size="sm" onClick={pdf} data-testid="report-pdf"><FileText className="h-4 w-4 mr-2" />PDF</Button>
        </>} />

      <Card className="p-4 mb-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3 items-end">
          <div>
            <Label className="text-xs">Country</Label>
            <Select value={country} onValueChange={setCountry} disabled={user?.role === "branch_manager"}>
              <SelectTrigger data-testid="report-country"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="KE">Kenya</SelectItem>
                <SelectItem value="UG">Uganda</SelectItem>
                <SelectItem value="RW">Rwanda</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <LocationFilter value={location} onChange={setLocation} testId="report-location" />
          <div>
            <Label className="text-xs">Branch</Label>
            <Select value={branch} onValueChange={setBranch} disabled={user?.role === "branch_manager"}>
              <SelectTrigger data-testid="report-branch"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {branches.map((b) => <SelectItem key={b.branch_name} value={b.branch_name}>{b.branch_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="lg:col-span-2">
            <Label className="text-xs">Date range</Label>
            <DateRangePicker
              value={{ from: dateFrom, to: dateTo }}
              onChange={({ from, to }) => { setDateFrom(from); setDateTo(to); }}
              testId="report-daterange"
              className="w-full"
            />
          </div>
          <div className="lg:col-span-1">
            <Label className="text-xs">Search</Label>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name…" data-testid="report-search" />
          </div>
          <Button onClick={load} data-testid="report-apply">Apply</Button>
        </div>
        <div className="mt-3 flex items-center gap-2 border-t pt-3">
          <Switch id="rep-compare" checked={compare} onCheckedChange={setCompare} data-testid="report-compare-toggle" />
          <label htmlFor="rep-compare" className="text-[12px] font-semibold cursor-pointer">Compare to previous period</label>
          {compare && (() => { const p = previousPeriod(dateFrom, dateTo); return (
            <span className="text-[11px] text-muted-foreground">({p.from} → {p.to})</span>
          ); })()}
        </div>
      </Card>

      {compare && (
        <Card className="rounded-2xl border border-border bg-card p-4 mb-5 shadow-none">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3" data-testid="report-delta-strip">
            <div>
              <div className="eyebrow">Employees</div>
              <div className="mt-1 flex items-center gap-2">
                <div className="font-extrabold text-2xl tabular-nums text-brand-deep">{curr.employees}</div>
                <DeltaChip current={curr.employees} previous={prev.employees} />
              </div>
            </div>
            <div>
              <div className="eyebrow">Avg attendance rate</div>
              <div className="mt-1 flex items-center gap-2">
                <div className="font-extrabold text-2xl tabular-nums">{curr.avgRate.toFixed(1)}%</div>
                <DeltaChip current={curr.avgRate} previous={prev.avgRate} />
              </div>
            </div>
            <div>
              <div className="eyebrow">Total present</div>
              <div className="mt-1 flex items-center gap-2">
                <div className="font-extrabold text-2xl tabular-nums">{curr.present.toLocaleString()}</div>
                <DeltaChip current={curr.present} previous={prev.present} />
              </div>
            </div>
            <div>
              <div className="eyebrow">Total absent</div>
              <div className="mt-1 flex items-center gap-2">
                <div className="font-extrabold text-2xl tabular-nums">{curr.absent.toLocaleString()}</div>
                <DeltaChip current={curr.absent} previous={prev.absent} invert />
              </div>
            </div>
            <div>
              <div className="eyebrow">Total late</div>
              <div className="mt-1 flex items-center gap-2">
                <div className="font-extrabold text-2xl tabular-nums">{curr.late.toLocaleString()}</div>
                <DeltaChip current={curr.late} previous={prev.late} invert />
              </div>
            </div>
          </div>
        </Card>
      )}

      {err && <ErrorState message={err} />}

      <Card className="overflow-hidden">
        {loading ? <LoadingState /> : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm" data-testid="report-table">
              <thead className="bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground sticky top-0">
                <tr>
                  <SortHead k="employee_name" label="Employee" />
                  <SortHead k="branch_name" label="Branch" />
                  <SortHead k="total_days" label="Days" right />
                  <SortHead k="days_present" label="Present" right />
                  <SortHead k="days_absent" label="Absent" right />
                  <SortHead k="days_late" label="Late" right />
                  <SortHead k="days_early_departure" label="Early" right />
                  <SortHead k="days_overtime" label="OT" right />
                  <SortHead k="days_undertime" label="UT" right />
                  <SortHead k="avg_hours_worked" label="Avg h" right />
                  <SortHead k="total_hours_worked" label="Total h" right />
                  <SortHead k="attendance_rate" label="Rate" right />
                </tr>
              </thead>
              <tbody>
                {sortedFiltered.slice(0, 500).map((r, i) => (
                  <tr key={i} className="border-t hover:bg-accent/40 transition-colors" data-testid={`report-row-${i}`}>
                    <td className="px-4 py-2.5 font-medium whitespace-nowrap">{r.employee_name}</td>
                    <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{r.branch_name}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{r.total_days}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-emerald-600">{r.days_present}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-rose-600">{r.days_absent}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-amber-600">{r.days_late}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{r.days_early_departure}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-sky-600">{r.days_overtime}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-yellow-600">{r.days_undertime}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{r.avg_hours_worked?.toFixed?.(1) || "—"}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{r.total_hours_worked?.toFixed?.(1) || "—"}</td>
                    <td className={`px-3 py-2.5 text-right font-mono ${cellTone(r.attendance_rate, "rate")}`}>{(r.attendance_rate || 0).toFixed(1)}%</td>
                  </tr>
                ))}
                {filtered.length === 0 && !loading && (
                  <tr><td colSpan={12} className="px-4 py-16 text-center text-muted-foreground">No employees found</td></tr>
                )}
              </tbody>
            </table>
            {filtered.length > 500 && (
              <div className="border-t bg-secondary/30 p-3 text-center text-xs text-muted-foreground">
                Showing first 500 of {filtered.length}. Use filters to narrow.
              </div>
            )}
          </div>
        )}
      </Card>
    </AppLayout>
  );
}
