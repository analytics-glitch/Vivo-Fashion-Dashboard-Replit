import React, { useEffect, useMemo, useState, useCallback } from "react";
import { vivoClient } from "../lib/api";
import { useAuth } from "../lib/auth";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Textarea } from "../components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "../components/ui/command";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "../components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import {
  HandCoins, ChevronsUpDown, Check, CheckCircle, XCircle, Clock, BadgeCheck, Link2,
} from "lucide-react";
import { toast } from "sonner";

const fmtKES = (n) =>
  `KES ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const StatusBadge = ({ status }) => {
  if (status === "approved")
    return <Badge className="text-[10px] bg-success/15 text-success border-success/30" variant="outline"><CheckCircle className="h-2.5 w-2.5 mr-1" />Approved</Badge>;
  if (status === "rejected")
    return <Badge variant="destructive" className="text-[10px]"><XCircle className="h-2.5 w-2.5 mr-1" />Rejected</Badge>;
  return <Badge variant="outline" className="text-[10px]"><Clock className="h-2.5 w-2.5 mr-1" />Pending</Badge>;
};

export default function SalaryAdvance() {
  const { user } = useAuth();

  const [employees, setEmployees] = useState([]);
  const [data, setData] = useState({ applications: [], pending_count: 0, can_review: false });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // Application form
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [amount, setAmount] = useState("");
  const [mpesa, setMpesa] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(null); // last submitted application

  // Review
  const [statusFilter, setStatusFilter] = useState("pending");
  const [rejecting, setRejecting] = useState(null); // application being rejected
  const [rejectReason, setRejectReason] = useState("");
  const [deciding, setDeciding] = useState(false);

  const selected = useMemo(
    () => employees.find((e) => e.id === selectedId) || null,
    [employees, selectedId]
  );

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const [emps, apps] = await Promise.all([
        vivoClient.get("/salary-advances/employees"),
        vivoClient.get("/salary-advances"),
      ]);
      setEmployees(emps.data || []);
      setData(apps.data || { applications: [], pending_count: 0, can_review: false });
    } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to load");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refreshApps = useCallback(async () => {
    try {
      const { data: d } = await vivoClient.get("/salary-advances");
      setData(d || { applications: [], pending_count: 0, can_review: false });
    } catch {}
  }, []);

  const validMpesa = (v) =>
    /^(?:\+?254|0)(?:7|1)\d{8}$/.test(String(v || "").replace(/[\s\-()]/g, ""));

  const submit = async () => {
    if (!selected) { toast.error("Select your staff code first"); return; }
    const amt = Number(amount);
    if (!amount || isNaN(amt) || amt <= 0) { toast.error("Enter a positive advance amount"); return; }
    if (!validMpesa(mpesa)) { toast.error("Enter a valid Kenyan M-Pesa number (07XX/01XX or +2547XX/+2541XX)"); return; }
    setSubmitting(true);
    try {
      const { data: r } = await vivoClient.post("/salary-advances", {
        employee_id: selected.id, amount: amt, mpesa_number: mpesa,
      });
      setSubmitted({ name: selected.name, amount: amt, mpesa: r.mpesa_number });
      setSelectedId(null); setAmount(""); setMpesa("");
      toast.success("Application submitted — pending HR review");
      await refreshApps();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to submit application");
      if (e?.response?.status === 409) await refreshApps();
    } finally { setSubmitting(false); }
  };

  const decide = async (app, action, reason) => {
    setDeciding(true);
    try {
      await vivoClient.post(`/salary-advances/${app.id}/decision`, { action, reason });
      toast.success(action === "approve" ? "Advance approved" : "Advance rejected");
      setRejecting(null); setRejectReason("");
      await refreshApps();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to record decision");
      await refreshApps();
    } finally { setDeciding(false); }
  };

  const apps = data.applications || [];
  // Trust the SERVER's can_review flag (it knows the real backend role) rather
  // than the client-side role mapping — the mapped role hides leadership/SMT
  // reviewers the server actually allows.
  const canReview = !!data.can_review;
  const shown = statusFilter === "all" ? apps : apps.filter((a) => a.status === statusFilter);
  const myApps = canReview
    ? apps.filter((a) => String(a.applied_by) === String(user?.user_id || user?.id))
    : apps;

  const employeeLink = `${window.location.origin}${import.meta.env.BASE_URL}salary-advance`;
  const copyEmployeeLink = async () => {
    try {
      await navigator.clipboard.writeText(employeeLink);
      toast.success("Employee link copied — share it with staff. They sign in with their company Google account.");
    } catch {
      toast.error("Could not copy — the link is " + employeeLink);
    }
  };

  const detailRow = (label, value) => (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm font-medium truncate">{value || "—"}</div>
    </div>
  );

  return (
    <AppLayout onRefresh={load}>
      <PageHeader
        title="Salary Advance"
        subtitle="Apply for a salary advance against your staff code. HR reviews and approves or rejects each request."
        testId="sa-header"
      />

      {err && <ErrorState message={err} />}
      {loading ? <LoadingState /> : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* ------------------------- Apply form ------------------------- */}
            <Card className="p-5" data-testid="sa-apply-card">
              <div className="flex items-center gap-2 mb-4">
                <HandCoins className="h-4 w-4 text-brand" />
                <div className="font-semibold">New application</div>
              </div>

              <div className="space-y-3">
                <div>
                  <Label className="text-xs">Staff code</Label>
                  <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline" role="combobox" aria-expanded={pickerOpen}
                        className="w-full justify-between font-normal"
                        data-testid="sa-emp-picker"
                      >
                        {selected
                          ? `${selected.employee_id} — ${selected.name}`
                          : "Search your staff code…"}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Type a staff code or name…" data-testid="sa-emp-search" />
                        <CommandList>
                          <CommandEmpty>No employee found.</CommandEmpty>
                          <CommandGroup>
                            {employees.map((e) => (
                              <CommandItem
                                key={e.id}
                                value={`${e.employee_id} ${e.name}`}
                                onSelect={() => { setSelectedId(e.id); setPickerOpen(false); setSubmitted(null); }}
                                data-testid={`sa-emp-${e.id}`}
                              >
                                <Check className={`mr-2 h-4 w-4 ${selectedId === e.id ? "opacity-100" : "opacity-0"}`} />
                                <span className="font-mono text-xs mr-2">{e.employee_id}</span>
                                <span className="truncate">{e.name}</span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>

                {selected && (
                  <div className="rounded-xl border border-border bg-secondary/30 p-3 grid grid-cols-2 sm:grid-cols-3 gap-3" data-testid="sa-emp-details">
                    {detailRow("Name", selected.name)}
                    {detailRow("Entity", selected.entity)}
                    {detailRow("Department", selected.department)}
                    {detailRow("Team", selected.team)}
                    {detailRow("Job title", selected.job_title)}
                    {detailRow("Country", selected.country)}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Advance amount (KES)</Label>
                    <Input
                      type="number" min="1" step="1" inputMode="numeric"
                      placeholder="e.g. 5000"
                      value={amount} onChange={(e) => setAmount(e.target.value)}
                      data-testid="sa-amount"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">M-Pesa phone number</Label>
                    <Input
                      type="tel" placeholder="07XX XXX XXX"
                      value={mpesa} onChange={(e) => setMpesa(e.target.value)}
                      data-testid="sa-mpesa"
                    />
                    {mpesa && !validMpesa(mpesa) && (
                      <div className="mt-1 text-[11px] text-danger">
                        Use 07XX/01XX or +2547XX/+2541XX format
                      </div>
                    )}
                  </div>
                </div>

                <Button
                  onClick={submit} disabled={submitting}
                  className="w-full sm:w-auto" data-testid="sa-submit"
                >
                  {submitting ? "Submitting…" : "Submit application"}
                </Button>

                {submitted && (
                  <div className="rounded-xl border border-success/30 bg-success/5 p-3 text-sm flex items-start gap-2" data-testid="sa-confirmation">
                    <BadgeCheck className="h-4 w-4 text-success mt-0.5 shrink-0" />
                    <div>
                      Application for <span className="font-semibold">{submitted.name}</span> —{" "}
                      <span className="font-semibold">{fmtKES(submitted.amount)}</span> to{" "}
                      <span className="font-mono">{submitted.mpesa}</span> submitted. Status: <span className="font-semibold">Pending</span> HR review.
                    </div>
                  </div>
                )}
              </div>
            </Card>

            {/* --------------------- My applications ----------------------- */}
            <Card className="p-5" data-testid="sa-my-card">
              <div className="font-semibold mb-4">My applications</div>
              {myApps.length === 0 ? (
                <EmptyState icon={HandCoins} title="No applications yet"
                  description="Submit a salary-advance application and its status will show here." />
              ) : (
                <div className="space-y-2">
                  {myApps.slice(0, 8).map((a) => (
                    <div key={a.id} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3" data-testid={`sa-my-${a.id}`}>
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {a.employee_name} · {fmtKES(a.amount)}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {a.mpesa_number} · {new Date(a.created_at).toLocaleDateString()}
                          {a.status === "rejected" && a.rejection_reason && (
                            <span> · Reason: {a.rejection_reason}</span>
                          )}
                        </div>
                      </div>
                      <StatusBadge status={a.status} />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* ------------------------ HR review ---------------------------- */}
          {canReview && (
            <Card className="p-5" data-testid="sa-review-card">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <div className="font-semibold">HR review</div>
                  {data.pending_count > 0 && (
                    <Badge className="text-[10px]" data-testid="sa-pending-count">
                      {data.pending_count} pending
                    </Badge>
                  )}
                  <Button
                    size="sm" variant="outline" className="h-7 px-2.5 text-[11px]"
                    onClick={copyEmployeeLink} data-testid="sa-copy-link"
                  >
                    <Link2 className="h-3 w-3 mr-1" />Copy employee link
                  </Button>
                </div>
                <div className="flex gap-1.5">
                  {["pending", "approved", "rejected", "all"].map((s) => (
                    <Button
                      key={s} size="sm"
                      variant={statusFilter === s ? "default" : "outline"}
                      className="h-7 px-3 text-[11px] capitalize"
                      onClick={() => setStatusFilter(s)}
                      data-testid={`sa-filter-${s}`}
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              </div>

              {shown.length === 0 ? (
                <EmptyState icon={Clock} title={`No ${statusFilter === "all" ? "" : statusFilter + " "}applications`} />
              ) : (
                <div className="overflow-x-auto">
                  <Table data-testid="sa-review-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Employee</TableHead>
                        <TableHead className="hidden md:table-cell">Entity / Dept</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>M-Pesa</TableHead>
                        <TableHead className="hidden sm:table-cell">Applied</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shown.map((a) => (
                        <TableRow key={a.id} data-testid={`sa-row-${a.id}`}>
                          <TableCell>
                            <div className="font-medium">{a.employee_name}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {a.employee_code}{a.job_title ? ` · ${a.job_title}` : ""}
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                            {a.entity || "—"}{a.department ? ` · ${a.department}` : ""}
                          </TableCell>
                          <TableCell className="text-right font-semibold whitespace-nowrap">{fmtKES(a.amount)}</TableCell>
                          <TableCell className="font-mono text-xs whitespace-nowrap">{a.mpesa_number}</TableCell>
                          <TableCell className="hidden sm:table-cell text-xs whitespace-nowrap">
                            {new Date(a.created_at).toLocaleDateString()}
                            <div className="text-[10px] text-muted-foreground">by {a.applied_by_name}</div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={a.status} />
                            {a.status !== "pending" && a.decided_by_name && (
                              <div className="text-[10px] text-muted-foreground mt-0.5">
                                by {a.decided_by_name}{a.decided_at ? ` · ${new Date(a.decided_at).toLocaleDateString()}` : ""}
                              </div>
                            )}
                            {a.status === "rejected" && a.rejection_reason && (
                              <div className="text-[10px] text-muted-foreground mt-0.5 max-w-[180px] truncate" title={a.rejection_reason}>
                                {a.rejection_reason}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {a.status === "pending" ? (
                              <div className="flex justify-end gap-1.5">
                                <Button
                                  size="sm" className="h-7 px-2.5 text-[11px]"
                                  disabled={deciding}
                                  onClick={() => decide(a, "approve")}
                                  data-testid={`sa-approve-${a.id}`}
                                >
                                  <CheckCircle className="h-3 w-3 mr-1" />Approve
                                </Button>
                                <Button
                                  size="sm" variant="destructive" className="h-7 px-2.5 text-[11px]"
                                  disabled={deciding}
                                  onClick={() => { setRejecting(a); setRejectReason(""); }}
                                  data-testid={`sa-reject-${a.id}`}
                                >
                                  <XCircle className="h-3 w-3 mr-1" />Reject
                                </Button>
                              </div>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>
          )}
        </div>
      )}

      {/* Reject dialog */}
      <Dialog open={!!rejecting} onOpenChange={(o) => { if (!o) { setRejecting(null); setRejectReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject salary advance</DialogTitle>
          </DialogHeader>
          {rejecting && (
            <div className="space-y-3">
              <div className="text-sm">
                Reject <span className="font-semibold">{rejecting.employee_name}</span>'s request for{" "}
                <span className="font-semibold">{fmtKES(rejecting.amount)}</span>?
              </div>
              <div>
                <Label className="text-xs">Reason (optional)</Label>
                <Textarea
                  rows={3} value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="e.g. exceeds the monthly advance limit"
                  data-testid="sa-reject-reason"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejecting(null); setRejectReason(""); }}>Cancel</Button>
            <Button
              variant="destructive" disabled={deciding}
              onClick={() => decide(rejecting, "reject", rejectReason.trim() || undefined)}
              data-testid="sa-reject-confirm"
            >
              {deciding ? "Rejecting…" : "Reject application"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
