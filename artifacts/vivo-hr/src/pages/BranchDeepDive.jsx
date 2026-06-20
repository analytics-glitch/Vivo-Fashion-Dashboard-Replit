import React, { useEffect, useMemo, useState, useCallback } from "react";
import { vivoClient, monthStartISO, todayISO, formatHHMM, consolidateHQBranches, expandBranchName, rebrandHQRow } from "../lib/api";
import { apiClient } from "../lib/api";
import { fetchAllBranches } from "../lib/branches";
import { yesterday } from "../lib/dates";
import { usePersistedDateRange, usePersistedFilter } from "../lib/persistedFilters";
import DateRangePicker from "../components/DateRangePicker";
import { useSort } from "../lib/useSort";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import LocationFilter from "../components/LocationFilter";
import { exportToExcel, exportToPDF } from "../lib/exports";
import { FileDown, FileText, Filter } from "lucide-react";
import { useAuth } from "../lib/auth";

const COUNTRY_NAMES = { KE: "Kenya", UG: "Uganda", RW: "Rwanda" };

export default function BranchDeepDive() {
  const { user } = useAuth();
  const [branches, setBranches] = useState([]);
  const [branch, setBranch] = useState(user?.branch_assignment || "all");
  const [country, setCountry] = usePersistedFilter("country", "all");
  const [location, setLocation] = usePersistedFilter("location", "all");
  const [dateFrom, dateTo, setDateFrom, setDateTo] = usePersistedDateRange(yesterday(), yesterday());
  const [rows, setRows] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [empQuery, setEmpQuery] = useState("");

  useEffect(() => {
    fetchAllBranches().then((list) => {
      let l = list;
      if (user?.role === "branch_manager" && user.branch_assignment) l = l.filter((b) => b.branch_name === user.branch_assignment);
      setBranches(l);
    }).catch(() => {});
  }, [user]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const { data: rawBranches } = await vivoClient.get("/branches");
      const params = { date_from: dateFrom, date_to: dateTo };
      if (country !== "all") params.country = country;
      if (location !== "all") params.location = location;
      let merged = [];
      if (branch === "all" || !branch) {
        const { data } = await vivoClient.get("/branch-detail", { params });
        merged = (data || []).map(rebrandHQRow);
      } else {
        const sources = expandBranchName(branch, rawBranches);
        const batches = await Promise.all(
          sources.map((s) =>
            vivoClient.get("/branch-detail", { params: { ...params, branch: s } })
              .then((r) => r.data || []).catch(() => [])
          )
        );
        merged = batches.flat().map(rebrandHQRow);
      }
      if (user?.role === "branch_manager" && user.branch_assignment) {
        merged = merged.filter((r) => r.branch_name === user.branch_assignment);
      }
      setRows(merged);
      // Pull leaves overlapping the date range to suppress false "Absent"
      try {
        const { data: lv } = await vivoClient.get("/leaves");
        const overlapping = (lv || []).filter((l) =>
          l.status !== "rejected" && l.date_to >= dateFrom && l.date_from <= dateTo
        );
        setLeaves(overlapping);
      } catch { setLeaves([]); }
    } catch (e) {
      setErr(e?.message || "Failed to load");
    } finally { setLoading(false); }
  }, [branch, country, location, dateFrom, dateTo, user]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const rowClass = (r) => {
    if (r.is_early_departure) return "bg-rose-500/5 dark:bg-rose-500/10";
    if (r.is_late) return "bg-amber-500/5 dark:bg-amber-500/10";
    if (r.is_overtime) return "bg-sky-500/5 dark:bg-sky-500/10";
    if (r.is_undertime) return "bg-yellow-500/5 dark:bg-yellow-500/10";
    return "";
  };

  const filteredRows = useMemo(() => {
    const q = empQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => (r.employee_name || "").toLowerCase().includes(q));
  }, [rows, empQuery]);

  const { sorted: sortedRows, SortHead } = useSort(filteredRows, { key: "attendance_date", dir: "desc" });

  // Build a set of (employee_name|date) tuples that are covered by approved/pending leave.
  const leaveSet = useMemo(() => {
    const s = new Set();
    leaves.forEach((l) => {
      const start = new Date(l.date_from);
      const end = new Date(l.date_to);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const iso = d.toISOString().slice(0, 10);
        s.add(`${(l.employee_name || "").toLowerCase()}|${iso}`);
      }
    });
    return s;
  }, [leaves]);

  const leaveLabel = (r) => {
    const key = `${(r.employee_name || "").toLowerCase()}|${r.attendance_date}`;
    if (leaveSet.has(key)) {
      const l = leaves.find((x) => (x.employee_name || "").toLowerCase() === (r.employee_name || "").toLowerCase() && x.date_from <= r.attendance_date && x.date_to >= r.attendance_date);
      return l ? (l.leave_type || "On leave") : "On leave";
    }
    return null;
  };

  const stats = useMemo(() => {
    const total = filteredRows.length;
    const present = filteredRows.filter((r) => r.attendance_status === "Present").length;
    const late = filteredRows.filter((r) => r.is_late).length;
    const early = filteredRows.filter((r) => r.is_early_departure).length;
    const ot = filteredRows.filter((r) => r.is_overtime).length;
    const ut = filteredRows.filter((r) => r.is_undertime).length;
    const onLeave = filteredRows.filter((r) => r.attendance_status === "Absent" && leaveSet.has(`${(r.employee_name || "").toLowerCase()}|${r.attendance_date}`)).length;
    return { total, present, late, early, ot, ut, onLeave };
  }, [filteredRows, leaveSet]);

  const excelExport = () => {
    const data = filteredRows.map((r) => ({
      Date: r.attendance_date,
      Employee: r.employee_name,
      Branch: r.branch_name,
      Country: COUNTRY_NAMES[r.branch_country] || r.branch_country,
      "Check In": formatHHMM(r.check_in_time),
      "Check Out": formatHHMM(r.check_out_time),
      "Hours Worked": r.hours_worked ?? "",
      Status: r.attendance_status,
      Late: r.is_late ? "Yes" : "",
      "Early Departure": r.is_early_departure ? "Yes" : "",
      Overtime: r.is_overtime ? "Yes" : "",
      Undertime: r.is_undertime ? "Yes" : "",
    }));
    exportToExcel(data, `branch-deep-dive-${dateFrom}-to-${dateTo}.xlsx`, "Branch Detail");
  };

  const pdfExport = () => {
    exportToPDF({
      title: "Branch Deep Dive",
      subtitle: `${branch === "all" ? "All branches" : branch} · ${dateFrom} → ${dateTo}`,
      headers: ["Date", "Employee", "Branch", "Check In", "Check Out", "Hrs", "Status", "Flags"],
      rows: filteredRows.map((r) => [
        r.attendance_date, r.employee_name, r.branch_name,
        formatHHMM(r.check_in_time), formatHHMM(r.check_out_time),
        r.hours_worked != null ? r.hours_worked.toFixed(1) : "—",
        r.attendance_status,
        [r.is_late && "Late", r.is_early_departure && "Early", r.is_overtime && "OT", r.is_undertime && "UT"].filter(Boolean).join(", "),
      ]),
      filename: `branch-deep-dive-${dateFrom}-to-${dateTo}.pdf`,
    });
  };

  return (
    <AppLayout onRefresh={load}>
      <PageHeader
        title="Branch Deep Dive"
        subtitle="Per-employee attendance with late, overtime, and early departure flags"
        testId="branch-deep-dive-header"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={excelExport} data-testid="export-excel-btn">
              <FileDown className="h-4 w-4 mr-2" />Excel
            </Button>
            <Button variant="outline" size="sm" onClick={pdfExport} data-testid="export-pdf-btn">
              <FileText className="h-4 w-4 mr-2" />PDF
            </Button>
          </>
        }
      />

      <Card className="p-4 mb-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3 items-end">
          <div>
            <Label className="text-xs">Country</Label>
            <Select value={country} onValueChange={setCountry} disabled={user?.role === "branch_manager"}>
              <SelectTrigger data-testid="filter-country"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All countries</SelectItem>
                <SelectItem value="KE">Kenya</SelectItem>
                <SelectItem value="UG">Uganda</SelectItem>
                <SelectItem value="RW">Rwanda</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <LocationFilter value={location} onChange={setLocation} testId="filter-location" />
          <div>
            <Label className="text-xs">Branch</Label>
            <Select value={branch} onValueChange={setBranch} disabled={user?.role === "branch_manager"}>
              <SelectTrigger data-testid="filter-branch"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {branches.map((b) => <SelectItem key={b.branch_name} value={b.branch_name}>{b.branch_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="lg:col-span-2">
            <Label className="text-xs">Date range</Label>
            <DateRangePicker
              value={{ from: dateFrom, to: dateTo }}
              onChange={({ from, to }) => { setDateFrom(from); setDateTo(to); }}
              testId="filter-daterange"
              className="w-full"
            />
          </div>
          <div>
            <Label className="text-xs">Employee</Label>
            <Input type="text" value={empQuery} onChange={(e) => setEmpQuery(e.target.value)} placeholder="Search name…" data-testid="filter-employee" />
          </div>
          <Button onClick={load} data-testid="apply-filters-btn"><Filter className="h-4 w-4 mr-2" />Apply</Button>
        </div>
      </Card>

      {/* Legend */}
      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 border-amber-500/30">Late (after 08:00)</Badge>
        <Badge className="bg-rose-500/15 text-rose-700 dark:text-rose-300 hover:bg-rose-500/20 border-rose-500/30">Early departure (before 17:00)</Badge>
        <Badge className="bg-sky-500/15 text-sky-700 dark:text-sky-300 hover:bg-sky-500/20 border-sky-500/30">Overtime (&gt;9h)</Badge>
        <Badge className="bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-500/20 border-yellow-500/30">Undertime (&lt;6h)</Badge>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-7 gap-2 mb-5 text-center text-sm" data-testid="dd-stats">
        <Card className="p-3"><div className="text-xs text-muted-foreground">Records</div><div className="font-bold text-xl">{stats.total}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Present</div><div className="font-bold text-xl text-emerald-600">{stats.present}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">On leave</div><div className="font-bold text-xl text-brand-deep">{stats.onLeave}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Late</div><div className="font-bold text-xl text-amber-600">{stats.late}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Early left</div><div className="font-bold text-xl text-rose-600">{stats.early}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Overtime</div><div className="font-bold text-xl text-sky-600">{stats.ot}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Undertime</div><div className="font-bold text-xl text-yellow-600">{stats.ut}</div></Card>
      </div>

      <Card className="overflow-hidden">
        {err && <div className="p-4"><ErrorState message={err} /></div>}
        {loading ? <LoadingState /> : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm" data-testid="dd-table">
              <thead className="bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <SortHead k="attendance_date" label="Date" />
                  <SortHead k="employee_name" label="Employee" />
                  <SortHead k="branch_name" label="Branch" />
                  <SortHead k="check_in_time" label="Check-in" />
                  <SortHead k="check_out_time" label="Check-out" />
                  <SortHead k="hours_worked" label="Hrs" right />
                  <SortHead k="attendance_status" label="Status" />
                  <th className="px-4 py-3 text-left font-semibold">Flags</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.slice(0, 500).map((r, i) => {
                  const onLeave = r.attendance_status === "Absent" ? leaveLabel(r) : null;
                  return (
                  <tr key={i} className={`border-t ${onLeave ? "bg-brand/[0.04]" : rowClass(r)}`} data-testid={`dd-row-${i}`}>
                    <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">{r.attendance_date}</td>
                    <td className="px-4 py-2.5 font-medium">{r.employee_name}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.branch_name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{formatHHMM(r.check_in_time)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{formatHHMM(r.check_out_time)}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{r.hours_worked != null ? r.hours_worked.toFixed(1) : "—"}</td>
                    <td className="px-4 py-2.5">
                      {onLeave ? (
                        <Badge className="bg-brand/15 text-brand-deep border-brand/30 hover:bg-brand/20" data-testid={`dd-leave-${i}`}>
                          On leave · {onLeave}
                        </Badge>
                      ) : (
                        <Badge variant={r.attendance_status === "Present" ? "secondary" : r.attendance_status === "Absent" ? "destructive" : "outline"}>
                          {r.attendance_status}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {r.is_late && <Badge className="bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20">Late</Badge>}
                        {r.is_early_departure && <Badge className="bg-rose-500/15 border-rose-500/30 text-rose-700 dark:text-rose-300 hover:bg-rose-500/20">Early</Badge>}
                        {r.is_overtime && <Badge className="bg-sky-500/15 border-sky-500/30 text-sky-700 dark:text-sky-300 hover:bg-sky-500/20">OT</Badge>}
                        {r.is_undertime && <Badge className="bg-yellow-500/15 border-yellow-500/30 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-500/20">UT</Badge>}
                      </div>
                    </td>
                  </tr>
                  );
                })}
                {rows.length === 0 && !loading && (
                  <tr><td colSpan={8} className="px-4 py-16 text-center text-muted-foreground">No records found for selected filters</td></tr>
                )}
              </tbody>
            </table>
            {rows.length > 500 && (
              <div className="border-t bg-secondary/30 p-3 text-center text-xs text-muted-foreground">
                Showing first 500 of {rows.length} records. Narrow your filters to see more.
              </div>
            )}
          </div>
        )}
      </Card>
    </AppLayout>
  );
}
