import React, { useEffect, useMemo, useState } from "react";
import { vivoClient, apiClient, monthStartISO, todayISO, formatHHMM, rebrandHQRow, adjustedDate } from "../lib/api";
import { trainingClient } from "../lib/training";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Textarea } from "../components/ui/textarea";
import { Switch } from "../components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "../components/ui/dialog";
import { Search, UserSearch, Flag, Plus, Clock, Calendar, Trash2, GraduationCap } from "lucide-react";
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

export default function EmployeeProfile() {
  const { user } = useAuth();
  const writable = canWrite(user);
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [monthStart, setMonthStart] = useState(monthStartISO());
  const [notes, setNotes] = useState([]);
  const [trainings, setTrainings] = useState([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteFlag, setNoteFlag] = useState(false);

  const search = async () => {
    if (q.trim().length < 2) return;
    setLoading(true); setErr("");
    try {
      const { data } = await vivoClient.get("/employee-search", { params: { q: q.trim() } });
      let r = (data || []).map(rebrandHQRow);
      if (user?.role === "branch_manager" && user.branch_assignment) {
        r = r.filter((x) => x.branch_name === user.branch_assignment);
      }
      setResults(r);
    } catch (e) { setErr(e?.message || "Search failed"); }
    finally { setLoading(false); }
  };

  const open = async (emp) => {
    setSelected(emp);
    setLoading(true);
    try {
      const [det, sum, n, tr] = await Promise.all([
        vivoClient.get("/employee-detail", { params: { employee: emp.employee_name, date_from: monthStart, date_to: todayISO() } }),
        vivoClient.get("/employee-summary", { params: { date_from: monthStart, date_to: todayISO(), branch: emp._hq_source || emp.branch_name } }),
        vivoClient.get("/notes", { params: { employee_name: emp.employee_name } }).catch(() => ({ data: [] })),
        trainingClient.get("/employee-history", { params: { employee: emp.employee_name } }).catch(() => ({ data: [] })),
      ]);
      setHistory((det.data || []).map(rebrandHQRow));
      setSummary((sum.data || []).find((s) => s.employee_name === emp.employee_name) || null);
      setNotes(n.data || []);
      setTrainings(Array.isArray(tr.data) ? tr.data : []);
    } catch (e) { setErr(e?.message || "Failed to load"); }
    finally { setLoading(false); }
  };

  const reloadDetail = async () => {
    if (!selected) return;
    try {
      const { data } = await vivoClient.get("/employee-detail", { params: { employee: selected.employee_name, date_from: monthStart, date_to: todayISO() } });
      setHistory((data || []).map(rebrandHQRow));
    } catch {}
  };

  useEffect(() => { if (selected) reloadDetail(); /* eslint-disable-next-line */ }, [monthStart]);

  const cal = useMemo(() => buildCalendar(history, monthStart), [history, monthStart]);

  const stats = useMemo(() => {
    if (!history || history.length === 0) return null;
    const completed = history.filter((r) => r.is_complete);
    const checkIns = history.filter((r) => r.check_in_time).map((r) => adjustedDate(r.check_in_time)).filter(Boolean);
    const avgCheckMin = checkIns.length ? checkIns.reduce((a, d) => a + d.getHours() * 60 + d.getMinutes(), 0) / checkIns.length : null;
    const avgHours = completed.length ? completed.reduce((a, r) => a + (r.hours_worked || 0), 0) / completed.length : 0;
    // Streak: consecutive Present days ending most recent
    const sorted = [...history].sort((a, b) => b.attendance_date.localeCompare(a.attendance_date));
    let streak = 0;
    for (const r of sorted) { if (r.attendance_status === "Present") streak++; else break; }
    return {
      attendanceRate: history.length ? (history.filter((r) => r.attendance_status === "Present").length / history.length) * 100 : 0,
      avgCheckIn: avgCheckMin != null ? `${String(Math.floor(avgCheckMin / 60)).padStart(2, "0")}:${String(Math.round(avgCheckMin % 60)).padStart(2, "0")}` : "—",
      avgHours: avgHours.toFixed(1),
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

  return (
    <AppLayout>
      <PageHeader title="Employee Profile" subtitle="Search by name and view full attendance history" testId="emp-header" />

      <Card className="p-4 mb-5">
        <div className="flex gap-2">
          <Input placeholder="Search employee by name (min 2 chars)…" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} data-testid="emp-search-input" />
          <Button onClick={search} data-testid="emp-search-btn"><Search className="h-4 w-4 mr-2" />Search</Button>
        </div>
      </Card>

      {err && <ErrorState message={err} />}

      {!selected && (
        <>
          {results.length === 0 && !loading && (
            <EmptyState icon={UserSearch} title="No employee selected" description="Type at least 2 characters and search." />
          )}
          {loading && <LoadingState />}
          {results.length > 0 && (
            <Card>
              <div className="divide-y" data-testid="emp-results">
                {results.map((r) => (
                  <button key={`${r.user_id}-${r.employee_name}`} onClick={() => open(r)}
                    className="flex w-full items-center justify-between p-4 hover:bg-accent transition-colors text-left"
                    data-testid={`emp-result-${r.employee_name.replace(/\s/g, "-")}`}>
                    <div>
                      <div className="font-semibold">{r.employee_name}</div>
                      <div className="text-xs text-muted-foreground">{r.branch_name} · {COUNTRY_NAMES[r.branch_country]} · ID {r.user_id}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold">{(r.attendance_rate || 0).toFixed(1)}%</div>
                      <div className="text-[11px] text-muted-foreground">{r.days_present}/{r.total_days} days · {r.avg_hours?.toFixed?.(1) || 0}h avg</div>
                    </div>
                  </button>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {selected && (
        <div className="space-y-5">
          <Card className="p-5 bg-panel/60 border border-border rounded-2xl shadow-none">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-center gap-4">
                <div className="grid h-14 w-14 place-items-center rounded-full bg-brand text-background text-xl font-serif font-bold">
                  {selected.employee_name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                </div>
                <div>
                  <h2 className="text-xl font-bold" data-testid="emp-name">{selected.employee_name}</h2>
                  <div className="text-sm text-muted-foreground">
                    {selected.branch_name} · {COUNTRY_NAMES[selected.branch_country]} · ID {selected.user_id}
                  </div>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => { setSelected(null); setHistory([]); setNotes([]); setTrainings([]); }} data-testid="emp-back">
                ← Back to results
              </Button>
            </div>
          </Card>

          {/* Stats */}
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Card className="p-4 text-center">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Attendance score</div>
                <div className="mt-1 text-3xl font-bold text-emerald-600">{stats.attendanceRate.toFixed(1)}%</div>
              </Card>
              <Card className="p-4 text-center">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Avg check-in</div>
                <div className="mt-1 text-3xl font-bold font-mono">{stats.avgCheckIn}</div>
              </Card>
              <Card className="p-4 text-center">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Avg hours / day</div>
                <div className="mt-1 text-3xl font-bold">{stats.avgHours}h</div>
              </Card>
              <Card className="p-4 text-center">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Current streak</div>
                <div className="mt-1 text-3xl font-bold text-brand">{stats.streak}d</div>
              </Card>
            </div>
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
                    <DialogHeader><DialogTitle>Note about {selected.employee_name}</DialogTitle></DialogHeader>
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
      )}
    </AppLayout>
  );
}
