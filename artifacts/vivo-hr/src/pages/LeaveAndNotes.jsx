import React, { useEffect, useState, useCallback } from "react";
import { vivoClient, todayISO } from "../lib/api";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "../components/ui/dialog";
import { Plus, Flag, Calendar, Trash2, CheckCircle, ListChecks } from "lucide-react";
import { toast } from "sonner";

export default function LeaveAndNotes() {
  const [tab, setTab] = useState("leaves");
  const [leaves, setLeaves] = useState([]);
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // Leave form
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveForm, setLeaveForm] = useState({
    employee_name: "", branch_name: "", user_id: "",
    date_from: todayISO(), date_to: todayISO(), leave_type: "annual",
    reason: "", status: "approved",
  });

  // Note form
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteForm, setNoteForm] = useState({ employee_name: "", branch_name: "", note: "", flag: false });

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const [l, n] = await Promise.all([
        vivoClient.get("/leaves"),
        vivoClient.get("/notes"),
      ]);
      setLeaves(l.data || []);
      setNotes(n.data || []);
    } catch (e) { setErr(e?.message || "Failed to load"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const submitLeave = async () => {
    if (!leaveForm.employee_name || !leaveForm.date_from || !leaveForm.date_to) {
      toast.error("Employee name and dates required"); return;
    }
    try {
      await vivoClient.post("/leaves", leaveForm);
      setLeaveOpen(false);
      setLeaveForm({ employee_name: "", branch_name: "", user_id: "", date_from: todayISO(), date_to: todayISO(), leave_type: "annual", reason: "", status: "approved" });
      await load();
      toast.success("Leave recorded");
    } catch (e) { toast.error(e?.response?.data?.detail || "Failed"); }
  };

  const submitNote = async () => {
    if (!noteForm.employee_name || !noteForm.note) { toast.error("Employee and note required"); return; }
    try {
      await vivoClient.post("/notes", noteForm);
      setNoteOpen(false);
      setNoteForm({ employee_name: "", branch_name: "", note: "", flag: false });
      await load();
      toast.success("Note saved");
    } catch (e) { toast.error("Failed"); }
  };

  const updateLeaveStatus = async (id, status) => {
    try {
      await vivoClient.put(`/leaves/${id}`, { status });
      setLeaves((prev) => prev.map((l) => l.id === id ? { ...l, status } : l));
      toast.success(`Leave ${status}`);
    } catch { toast.error("Failed"); }
  };

  const deleteLeave = async (id) => {
    try { await vivoClient.delete(`/leaves/${id}`); setLeaves(leaves.filter((l) => l.id !== id)); toast.success("Deleted"); }
    catch { toast.error("Failed"); }
  };

  const deleteNote = async (id) => {
    try { await vivoClient.delete(`/notes/${id}`); setNotes(notes.filter((n) => n.id !== id)); toast.success("Deleted"); }
    catch { toast.error("Failed"); }
  };

  const toggleNoteResolved = async (n) => {
    try {
      await vivoClient.put(`/notes/${n.id}`, { resolved: !n.resolved });
      setNotes(notes.map((x) => (x.id === n.id ? { ...x, resolved: !x.resolved } : x)));
      toast.success(!n.resolved ? "Marked resolved" : "Reopened");
    } catch { toast.error("Failed"); }
  };

  const flagBadge = (n) => n.flag && <Badge variant="destructive" className="text-[10px]"><Flag className="h-2.5 w-2.5 mr-1" />Flagged</Badge>;

  // Calendar for current month: render colored bands per branch
  const monthLeaves = leaves;

  return (
    <AppLayout onRefresh={load}>
      <PageHeader title="Leave & Notes Management"
        subtitle="Approve absences as leave, track balances, manage HR notes" testId="ln-header" />

      <Tabs value={tab} onValueChange={setTab}>
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList>
            <TabsTrigger value="leaves" data-testid="tab-leaves"><Calendar className="h-4 w-4 mr-2" />Leaves ({leaves.length})</TabsTrigger>
            <TabsTrigger value="notes" data-testid="tab-notes"><ListChecks className="h-4 w-4 mr-2" />Notes ({notes.length})</TabsTrigger>
          </TabsList>
          <div className="flex gap-2">
            <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
              <DialogTrigger asChild>
                <Button size="sm" data-testid="add-leave-btn"><Plus className="h-4 w-4 mr-2" />Record leave</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Record leave / approved absence</DialogTitle></DialogHeader>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2">
                    <Label className="text-xs">Employee name</Label>
                    <Input value={leaveForm.employee_name} onChange={(e) => setLeaveForm({ ...leaveForm, employee_name: e.target.value })} data-testid="leave-employee" />
                  </div>
                  <div>
                    <Label className="text-xs">Branch (optional)</Label>
                    <Input value={leaveForm.branch_name} onChange={(e) => setLeaveForm({ ...leaveForm, branch_name: e.target.value })} data-testid="leave-branch" />
                  </div>
                  <div>
                    <Label className="text-xs">Type</Label>
                    <Select value={leaveForm.leave_type} onValueChange={(v) => setLeaveForm({ ...leaveForm, leave_type: v })}>
                      <SelectTrigger data-testid="leave-type"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="annual">Annual</SelectItem>
                        <SelectItem value="sick">Sick</SelectItem>
                        <SelectItem value="unpaid">Unpaid</SelectItem>
                        <SelectItem value="approved_absence">Approved absence</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">From</Label>
                    <Input type="date" value={leaveForm.date_from} onChange={(e) => setLeaveForm({ ...leaveForm, date_from: e.target.value })} data-testid="leave-from" />
                  </div>
                  <div>
                    <Label className="text-xs">To</Label>
                    <Input type="date" value={leaveForm.date_to} onChange={(e) => setLeaveForm({ ...leaveForm, date_to: e.target.value })} data-testid="leave-to" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-xs">Reason (optional)</Label>
                    <Textarea value={leaveForm.reason} onChange={(e) => setLeaveForm({ ...leaveForm, reason: e.target.value })} rows={3} data-testid="leave-reason" />
                  </div>
                  <div>
                    <Label className="text-xs">Status</Label>
                    <Select value={leaveForm.status} onValueChange={(v) => setLeaveForm({ ...leaveForm, status: v })}>
                      <SelectTrigger data-testid="leave-status"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="approved">Approved</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="rejected">Rejected</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setLeaveOpen(false)}>Cancel</Button>
                  <Button onClick={submitLeave} data-testid="leave-submit">Save</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" data-testid="add-note-btn"><Plus className="h-4 w-4 mr-2" />Add note</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>New HR note</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs">Employee</Label>
                    <Input value={noteForm.employee_name} onChange={(e) => setNoteForm({ ...noteForm, employee_name: e.target.value })} data-testid="note-emp" />
                  </div>
                  <div>
                    <Label className="text-xs">Branch (optional)</Label>
                    <Input value={noteForm.branch_name} onChange={(e) => setNoteForm({ ...noteForm, branch_name: e.target.value })} data-testid="note-branch" />
                  </div>
                  <div>
                    <Label className="text-xs">Note</Label>
                    <Textarea rows={4} value={noteForm.note} onChange={(e) => setNoteForm({ ...noteForm, note: e.target.value })} data-testid="note-text" />
                  </div>
                  <div className="flex items-center gap-2">
                    <input id="flagcb" type="checkbox" checked={noteForm.flag} onChange={(e) => setNoteForm({ ...noteForm, flag: e.target.checked })} data-testid="note-flag" className="h-4 w-4 accent-brand" />
                    <Label htmlFor="flagcb" className="text-sm">Flag for HR review</Label>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setNoteOpen(false)}>Cancel</Button>
                  <Button onClick={submitNote} data-testid="note-save">Save note</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {err && <ErrorState message={err} />}
        {loading ? <LoadingState /> : (
          <>
            <TabsContent value="leaves">
              {leaves.length === 0 ? <EmptyState icon={Calendar} title="No leaves recorded" description="Record approved leave or convert an absence into approved leave." /> : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3" data-testid="leaves-list">
                  {leaves.map((l) => (
                    <Card key={l.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="font-semibold">{l.employee_name}</div>
                            <Badge variant="secondary" className="text-[10px] uppercase">{l.leave_type}</Badge>
                            <Badge variant={l.status === "approved" ? "default" : l.status === "rejected" ? "destructive" : "outline"} className="text-[10px]">{l.status}</Badge>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {l.branch_name || "—"} · {l.date_from} → {l.date_to}
                          </div>
                          {l.reason && <div className="mt-2 text-sm bg-secondary/40 rounded p-2">{l.reason}</div>}
                          <div className="mt-2 text-[11px] text-muted-foreground">By {l.created_by_name} on {new Date(l.created_at).toLocaleDateString()}</div>
                        </div>
                        <div className="flex flex-col gap-1">
                          {l.status !== "approved" && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateLeaveStatus(l.id, "approved")} data-testid={`approve-${l.id}`}><CheckCircle className="h-3 w-3 mr-1" />Approve</Button>}
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => deleteLeave(l.id)} data-testid={`delete-leave-${l.id}`}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="notes">
              {notes.length === 0 ? <EmptyState icon={ListChecks} title="No notes" description="Add HR notes for employees to track follow-ups." /> : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3" data-testid="notes-list">
                  {notes.map((n) => (
                    <Card key={n.id} className={`p-4 ${n.resolved ? "opacity-60" : n.flag ? "border-rose-500/30 bg-rose-500/5" : ""}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="font-semibold">{n.employee_name}</div>
                            {flagBadge(n)}
                            {n.resolved && <Badge variant="outline" className="text-[10px]">Resolved</Badge>}
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">{n.branch_name || "—"}</div>
                          <div className="mt-2 text-sm">{n.note}</div>
                          <div className="mt-2 text-[11px] text-muted-foreground">by {n.created_by_name} · {new Date(n.created_at).toLocaleString()}</div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => toggleNoteResolved(n)} data-testid={`resolve-n-${n.id}`}>
                            {n.resolved ? "Reopen" : "Resolve"}
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => deleteNote(n.id)} data-testid={`delete-n-${n.id}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>
          </>
        )}
      </Tabs>
    </AppLayout>
  );
}
