import React, { useEffect, useMemo, useState, useCallback } from "react";
import { vivoClient, monthStartISO, todayISO, formatHHMM, rebrandHQRow, adjustedDate } from "../lib/api";
import { trainingClient } from "../lib/training";
import { exportToExcel } from "../lib/exports";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Textarea } from "../components/ui/textarea";
import { Switch } from "../components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "../components/ui/dialog";
import {
  Search, UserSearch, Flag, Plus, Calendar, Trash2, GraduationCap,
  ArrowUpDown, FileDown, Users, Clock, AlarmClock, Briefcase,
} from "lucide-react";
import { useAuth, canWrite } from "../lib/auth";
import { toast } from "sonner";

const COUNTRY_NAMES = { KE: "Kenya", UG: "Uganda", RW: "Rwanda" };
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function buildCalendar(records, monthStart) {
  const start = new Date(monthStart);
  const year = start.getFullYear();
  const month = start.getMonth();
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = firstDay.getDay();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const rec = records.find((r) => r.attendance_date === dateStr);
    cells.push({ day: d, dateStr, rec });
  }
  return { cells, monthLabel: start.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
}

function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <Card className="rounded-2xl border border-border bg-card p-4 shadow-none">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className={`text-2xl font-bold font-mono tabular-nums leading-tight ${accent || ""}`}>{value}</div>
        </div>
      </div>
    </Card>
  );
}

export default function EmployeeProfile() {
  const { user } = useAuth();
  const writable = canWrite(user);

  // ---- list state ----
  const [dateFrom, setDateFrom] = useState(monthStartISO());
  const [dateTo, setDateTo] = useState(todayISO());
  const [rows, setRows] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [q, setQ] = useState("");
  const [department, setDepartment] = useState("all");
  const [country, setCountry] = useState("all");
  const [sort, setSort] = useState({ key: "employee_name", dir: "asc" });

  // ---- detail state ----
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [monthStart, setMonthStart] = useState(monthStartISO());
  const [notes, setNotes] = useState([]);
  const [trainings, setTrainings] = useState([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteFlag, setNoteFlag] = useState(false);

  const [err, setErr] = useState("");

  const loadList = useCallback(async () => {
    setListLoading(true); setErr("");
    try {
      const { data } = await vivoClient.get("/employee-summary", {
        params: { date_from: dateFrom, date_to: dateTo },
      });
      let r = (data || []).map(rebrandHQRow);
      if (user?.role === "branch_manager" && user.branch_assignment) {
        r = r.filter((x) => x.branch_name === user.branch_assignment);
      }
      setRows(r);
    } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to load employees");
    } finally {
      setListLoading(false);
    }
  }, [dateFrom, dateTo, user]);

  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [dateFrom, dateTo]);

  const departments = useMemo(
    () => Array.from(new Set(rows.map((r) => r.department).filter(Boolean))).sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    let r = rows.filter((x) => {
      if (department !== "all" && (x.department || "") !== department) return false;
      if (country !== "all" && x.branch_country !== country) return false;
      if (term) {
        const hay = `${x.employee_name} ${x.roster_name || ""} ${x.staff_no || ""} ${x.branch_name || ""}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
    const { key, dir } = sort;
    r = [...r].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
      return dir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return r;
  }, [rows, q, department, country, sort]);

  const listStats = useMemo(() => {
    if (filtered.length === 0) return null;
    const withRate = filtered.filter((r) => r.total_days > 0);
    const avgAtt = withRate.length
      ? withRate.reduce((a, r) => a + (r.attendance_rate || 0), 0) / withRate.length : 0;
    const totLate = filtered.reduce((a, r) => a + (r.late_days || 0), 0);
    const withHours = filtered.filter((r) => r.avg_hours > 0);
    const avgHours = withHours.length
      ? withHours.reduce((a, r) => a + (r.avg_hours || 0), 0) / withHours.length : 0;
    return {
      count: filtered.length,
      avgAtt: avgAtt.toFixed(1),
      totLate,
      avgHours: avgHours.toFixed(1),
    };
  }, [filtered]);

  const toggleSort = (key) => setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));

  const SortHead = ({ k, label, right = false }) => (
    <th className={`px-3 py-3 ${right ? "text-right" : "text-left"} font-semibold cursor-pointer select-none hover:text-brand-deep`}
      onClick={() => toggleSort(k)} data-testid={`emp-sort-${k}`}>
      <span className={`inline-flex items-center gap-1 ${right ? "flex-row-reverse" : ""}`}>
        {label}
        <ArrowUpDown className={`h-3 w-3 ${sort.key === k ? "text-brand" : "text-muted-foreground/50"}`} />
      </span>
    </th>
  );

  const xlsx = () => exportToExcel(
    filtered.map((r) => ({
      Name: r.employee_name, "Roster Name": r.roster_name || "", "Staff No": r.staff_no || "",
      Department: r.department || "", Team: r.team || "", "Job Title": r.job_title || "",
      Branch: r.branch_name, Country: COUNTRY_NAMES[r.branch_country] || r.branch_country,
      "Attendance %": r.attendance_rate, "Days Present": r.days_present, "Days Absent": r.days_absent,
      "Avg Hours": r.avg_hours, "Late Days": r.late_days, "Late %": r.late_rate, "Avg Check-In": r.avg_check_in || "",
    })),
    "employees-attendance.xlsx", "Employees"
  );

  const open = async (emp) => {
    setSelected(emp);
    setMonthStart(`${dateTo.slice(0, 7)}-01`);
    setDetailLoading(true); setErr("");
    try {
      const [det, n, tr] = await Promise.all([
        vivoClient.get("/employee-detail", { params: { employee: emp.employee_name, date_from: dateFrom, date_to: dateTo } }),
        vivoClient.get("/notes", { params: { employee_name: emp.employee_name } }).catch(() => ({ data: [] })),
        trainingClient.get("/employee-history", { params: { employee: emp.employee_name } }).catch(() => ({ data: [] })),
      ]);
      setHistory((det.data || []).map(rebrandHQRow));
      setNotes(n.data || []);
      setTrainings(Array.isArray(tr.data) ? tr.data : []);
    } catch (e) { setErr(e?.message || "Failed to load employee"); }
    finally { setDetailLoading(false); }
  };

  const closeDetail = () => {
    setSelected(null); setHistory([]); setNotes([]); setTrainings([]);
  };

  const cal = useMemo(() => buildCalendar(history, monthStart), [history, monthStart]);

  const stats = useMemo(() => {
    if (!history || history.length === 0) return null;
    const completed = history.filter((r) => r.is_complete);
    const checkIns = history.filter((r) => r.check_in_time).map((r) => adjustedDate(r.check_in_time)).filter(Boolean);
    const avgCheckMin = checkIns.length ? checkIns.reduce((a, d) => a + d.getHours() * 60 + d.getMinutes(), 0) / checkIns.length : null;
    const avgHours = completed.length ? completed.reduce((a, r) => a + (r.hours_worked || 0), 0) / completed.length : 0;
    const lateDays = history.filter((r) => r.is_late).length;
    const sorted = [...history].sort((a, b) => b.attendance_date.localeCompare(a.attendance_date));
    let streak = 0;
    for (const r of sorted) { if (r.attendance_status === "Present") streak++; else break; }
    return {
      avgCheckIn: avgCheckMin != null ? `${String(Math.floor(avgCheckMin / 60)).padStart(2, "0")}:${String(Math.round(avgCheckMin % 60)).padStart(2, "0")}` : "—",
      avgHours: avgHours.toFixed(1),
      lateDays,
      streak,
    };
  }, [history]);

  const submitNote = async () => {
    if (!noteText.trim()) return;
    try {
      const { data } = await vivoClient.post("/notes", {
        employee_name: selected.employee_name,
        branch_name: selected.branch_name,
        user_id: String(selected.user_id || ""),
        note: noteText, flag: noteFlag,
      });
      setNotes([data, ...notes]);
      setNoteText(""); setNoteFlag(false); setNoteOpen(false);
      toast.success("Note added");
    } catch (e) { toast.error("Failed to save note"); }
  };

  const deleteNote = async (id) => {
    try {
      await vivoClient.delete(`/notes/${id}`);
      setNotes(notes.filter((n) => n.id !== id));
      toast.success("Note deleted");
    } catch { toast.error("Failed to delete"); }
  };

  const dayClass = (cell) => {
    if (!cell?.rec) return "bg-secondary/40 text-muted-foreground";
    const s = cell.rec.attendance_status;
    if (s === "Present" && cell.rec.is_complete) return "bg-emerald-500/85 text-white";
    if (s === "Present") return "bg-emerald-500/50 text-white";
    if (s === "Missing Check-Out") return "bg-amber-500/80 text-white";
    if (s === "Absent") return "bg-rose-500/80 text-white";
    return "bg-secondary/40";
  };

  const initials = (name) => name.split(" ").map((w) => w[0]).slice(0, 2).join("");

  // ---------------------------------------------------------------- detail view
  if (selected) {
    return (
      <AppLayout onRefresh={() => open(selected)}>
        <PageHeader title="Employee Profile" subtitle="Attendance, time, lateness & department detail" testId="emp-header" />
        {err && <ErrorState message={err} />}

        <div className="space-y-5">
          <Card className="p-5 bg-panel/60 border border-border rounded-2xl shadow-none">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="grid h-14 w-14 place-items-center rounded-full bg-brand text-background text-xl font-serif font-bold">
                  {initials(selected.roster_name || selected.employee_name)}
                </div>
                <div>
                  <h2 className="text-xl font-bold" data-testid="emp-name">{selected.roster_name || selected.employee_name}</h2>
                  <div className="text-sm text-muted-foreground">
                    {selected.branch_name} · {COUNTRY_NAMES[selected.branch_country] || selected.branch_country} · ID {selected.user_id}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {selected.department && <span className="pill pill-brand">{selected.department}</span>}
                    {selected.team && <span className="pill">{selected.team}</span>}
                    {selected.job_title && <span className="pill">{selected.job_title}</span>}
                    {selected.staff_no && <span className="pill">Staff #{selected.staff_no}</span>}
                    {!selected.department && <span className="pill text-muted-foreground">No roster link</span>}
                  </div>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={closeDetail} data-testid="emp-back">
                ← Back to list
              </Button>
            </div>
          </Card>

          {detailLoading && <LoadingState />}

          {!detailLoading && stats && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <StatCard icon={Users} label="Attendance" value={`${(selected.attendance_rate ?? 0).toFixed(1)}%`} accent="text-emerald-600" />
              <StatCard icon={Clock} label="Avg check-in" value={stats.avgCheckIn} />
              <StatCard icon={Briefcase} label="Avg hours/day" value={`${stats.avgHours}h`} />
              <StatCard icon={AlarmClock} label="Late days" value={stats.lateDays} accent={stats.lateDays > 0 ? "text-amber-600" : ""} />
              <StatCard icon={Calendar} label="Present streak" value={`${stats.streak}d`} accent="text-brand" />
            </div>
          )}

          {!detailLoading && !stats && (
            <EmptyState icon={Calendar} title="No attendance in range" description="This employee has no attendance records for the selected dates." />
          )}

          {/* Calendar */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-primary" />
                <h3 className="font-semibold">{cal.monthLabel}</h3>
              </div>
              <Input type="month" value={monthStart.slice(0, 7)}
                onChange={(e) => setMonthStart(`${e.target.value}-01`)}
                className="w-[160px]" data-testid="emp-month-picker" />
            </div>
            <div className="grid grid-cols-7 gap-1.5 text-center text-[10px] text-muted-foreground mb-1.5">
              {WEEKDAYS.map((d, i) => <div key={i} className="uppercase tracking-wider">{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1.5" data-testid="emp-calendar">
              {cal.cells.map((cell, i) => (
                <div key={i} className={`aspect-square rounded-md text-xs flex flex-col items-center justify-center p-1 ${dayClass(cell)}`}
                  title={cell?.rec ? `${cell.rec.attendance_status} · ${formatHHMM(cell.rec.check_in_time)}–${formatHHMM(cell.rec.check_out_time)}` : ""}>
                  {cell && (<>
                    <div className="font-semibold">{cell.day}</div>
                    {cell.rec?.hours_worked != null && <div className="text-[9px] opacity-80">{cell.rec.hours_worked.toFixed(1)}h</div>}
                  </>)}
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded bg-emerald-500" />Present</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded bg-amber-500" />Missing checkout</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded bg-rose-500" />Absent</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded bg-secondary" />No record</span>
            </div>
          </Card>

          {/* Training history */}
          <Card className="p-5" data-testid="emp-training-card">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-semibold flex items-center gap-2"><GraduationCap className="h-4 w-4 text-brand" />Training history</h3>
                <p className="text-xs text-muted-foreground">
                  {trainings.length === 0
                    ? "No training sessions on file"
                    : `${trainings.length} session${trainings.length !== 1 ? "s" : ""} · ${trainings.reduce((a, t) => a + (Number(t.hours_actual) || 0), 0).toFixed(1)}h total`}
                </p>
              </div>
              {trainings.length > 0 && (
                <div className="flex gap-2">
                  <span className="pill pill-brand">{new Set(trainings.map((t) => t.category)).size} categories</span>
                  <span className="pill">{new Set(trainings.map((t) => t.training_name)).size} courses</span>
                </div>
              )}
            </div>
            {trainings.length === 0 ? (
              <div className="rounded-lg bg-panel/40 p-4 text-sm text-muted-foreground text-center">
                This employee has not attended any recorded training sessions yet.
              </div>
            ) : (
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full text-sm">
                  <thead className="bg-panel/40 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Date</th>
                      <th className="px-3 py-2 text-left font-semibold">Training</th>
                      <th className="px-3 py-2 text-left font-semibold">Category</th>
                      <th className="px-3 py-2 text-left font-semibold">Method</th>
                      <th className="px-3 py-2 text-right font-semibold">Hours</th>
                      <th className="px-3 py-2 text-right font-semibold">Late (h)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...trainings].sort((a, b) => (b.training_date || "").localeCompare(a.training_date || "")).slice(0, 50).map((t, i) => (
                      <tr key={i} className="border-t border-border" data-testid={`emp-training-row-${i}`}>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{t.training_date}</td>
                        <td className="px-3 py-2 font-medium">{t.training_name}</td>
                        <td className="px-3 py-2"><span className="pill">{t.category}</span></td>
                        <td className="px-3 py-2 text-muted-foreground">{t.delivery_method}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{(Number(t.hours_actual) || 0).toFixed(1)}</td>
                        <td className={`px-3 py-2 text-right font-mono tabular-nums ${Number(t.lateness_hours) > 0 ? "text-amber-600 font-semibold" : ""}`}>
                          {Number(t.lateness_hours) > 0 ? Number(t.lateness_hours).toFixed(1) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {trainings.length > 50 && (
                  <div className="text-center text-[11px] text-muted-foreground p-2">Showing 50 of {trainings.length} sessions</div>
                )}
              </div>
            )}
          </Card>

          {/* Notes */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-semibold flex items-center gap-2"><Flag className="h-4 w-4" />HR Notes & Flags</h3>
                <p className="text-xs text-muted-foreground">{notes.length} note{notes.length !== 1 ? "s" : ""}</p>
              </div>
              {writable && (
                <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" data-testid="emp-add-note-btn"><Plus className="h-4 w-4 mr-2" />Add note</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader><DialogTitle>Note about {selected.roster_name || selected.employee_name}</DialogTitle></DialogHeader>
                    <div className="space-y-3">
                      <Textarea rows={4} value={noteText} onChange={(e) => setNoteText(e.target.value)}
                        placeholder="Add a note for HR review…" data-testid="note-textarea" />
                      <div className="flex items-center justify-between rounded-lg border bg-secondary/40 p-3">
                        <div>
                          <Label htmlFor="flag-switch" className="text-sm">Flag for HR review</Label>
                          <p className="text-xs text-muted-foreground">Marks employee for follow-up</p>
                        </div>
                        <Switch id="flag-switch" checked={noteFlag} onCheckedChange={setNoteFlag} data-testid="note-flag-switch" />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setNoteOpen(false)}>Cancel</Button>
                      <Button onClick={submitNote} data-testid="note-submit">Save note</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </div>
            <div className="space-y-2" data-testid="emp-notes-list">
              {notes.length === 0 ? <div className="text-sm text-muted-foreground py-3">No notes yet</div> :
                notes.map((n) => (
                  <div key={n.id} className={`rounded-lg border p-3 ${n.flag ? "border-rose-500/30 bg-rose-500/5" : "bg-secondary/30"}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm">{n.note}</div>
                      <div className="flex items-center gap-1">
                        {n.flag && <Badge variant="destructive" className="text-[10px]"><Flag className="h-2.5 w-2.5 mr-1" />Flagged</Badge>}
                        {writable && (
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => deleteNote(n.id)} data-testid={`delete-note-${n.id}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      by {n.created_by_name} · {new Date(n.created_at).toLocaleString()}
                    </div>
                  </div>
                ))}
            </div>
          </Card>
        </div>
      </AppLayout>
    );
  }

  // ------------------------------------------------------------------ list view
  return (
    <AppLayout onRefresh={loadList}>
      <PageHeader
        title="Employees"
        subtitle="Every employee with attendance, time, lateness & department — click a row for the full profile"
        testId="emp-header"
      />

      {err && <ErrorState message={err} />}

      {listStats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
          <StatCard icon={Users} label="Employees" value={listStats.count} />
          <StatCard icon={Calendar} label="Avg attendance" value={`${listStats.avgAtt}%`} accent="text-emerald-600" />
          <StatCard icon={AlarmClock} label="Late incidents" value={listStats.totLate} accent={listStats.totLate > 0 ? "text-amber-600" : ""} />
          <StatCard icon={Briefcase} label="Avg hours/day" value={`${listStats.avgHours}h`} />
        </div>
      )}

      <Card className="rounded-2xl border border-border bg-card p-4 mb-5 shadow-none">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div className="relative lg:col-span-2">
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Search</Label>
            <Search className="absolute left-3 top-[30px] h-3.5 w-3.5 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Name, staff no or branch…" className="h-9 rounded-full border-border bg-panel/40 pl-9"
              data-testid="emp-search" />
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Department</Label>
            <Select value={department} onValueChange={setDepartment}>
              <SelectTrigger className="h-9 rounded-full border-border bg-panel/40" data-testid="emp-dept"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Country</Label>
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger className="h-9 rounded-full border-border bg-panel/40" data-testid="emp-country"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All countries</SelectItem>
                {Object.entries(COUNTRY_NAMES).map(([code, name]) => <SelectItem key={code} value={code}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">From</Label>
            <Input type="date" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)}
              className="h-9 rounded-full border-border bg-panel/40" data-testid="emp-from" />
          </div>
          <div>
            <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">To</Label>
            <Input type="date" value={dateTo} min={dateFrom} max={todayISO()} onChange={(e) => setDateTo(e.target.value)}
              className="h-9 rounded-full border-border bg-panel/40" data-testid="emp-to" />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={xlsx} className="inline-flex items-center rounded-full border border-border text-[11px] font-bold uppercase tracking-wider px-4 h-9 hover:bg-panel/40" data-testid="emp-export">
            <FileDown className="h-3.5 w-3.5 mr-1.5" />Excel
          </button>
          <span className="ml-auto text-[11px] text-muted-foreground">{filtered.length} of {rows.length} employees</span>
        </div>
      </Card>

      <Card className="overflow-hidden rounded-2xl border border-border bg-card shadow-none">
        {listLoading ? <LoadingState /> : filtered.length === 0 ? (
          <EmptyState icon={UserSearch} title="No employees found" description="Try widening the date range or clearing filters." />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm" data-testid="emp-table">
              <thead className="bg-panel/40 text-xs uppercase tracking-wider text-muted-foreground sticky top-0">
                <tr>
                  <SortHead k="employee_name" label="Employee" />
                  <SortHead k="department" label="Department" />
                  <SortHead k="branch_name" label="Branch" />
                  <SortHead k="attendance_rate" label="Attendance" right />
                  <SortHead k="days_present" label="Present" right />
                  <SortHead k="avg_hours" label="Avg hrs" right />
                  <SortHead k="late_days" label="Late" right />
                  <SortHead k="avg_check_in" label="Avg in" right />
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 600).map((r, i) => (
                  <tr key={`${r.user_id}-${r.employee_name}-${i}`}
                    onClick={() => open(r)}
                    className="border-t border-border hover:bg-panel/40 transition-colors cursor-pointer"
                    data-testid={`emp-row-${i}`}>
                    <td className="px-3 py-2.5">
                      <div className="font-semibold whitespace-nowrap">{r.roster_name || r.employee_name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {COUNTRY_NAMES[r.branch_country] || r.branch_country} · ID {r.user_id}
                        {r.job_title ? ` · ${r.job_title}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {r.department || <span className="text-muted-foreground/60">—</span>}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{r.branch_name}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      <span className={r.attendance_rate >= 90 ? "text-emerald-600 font-semibold" : r.attendance_rate < 70 ? "text-rose-600 font-semibold" : ""}>
                        {(r.attendance_rate || 0).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{r.days_present}/{r.total_days}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{(r.avg_hours || 0).toFixed(1)}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      <span className={r.late_days > 0 ? "text-amber-600 font-semibold" : "text-muted-foreground"}>{r.late_days || 0}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">{r.avg_check_in || "—"}</td>
                  </tr>
                ))}
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
