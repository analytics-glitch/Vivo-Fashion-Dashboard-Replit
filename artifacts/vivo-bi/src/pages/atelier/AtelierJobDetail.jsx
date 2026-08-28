import React, { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api, fmtDate, API } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { ArrowLeft, Scissors, Printer, Clock, ChevronRight, AlertCircle } from "lucide-react";

const STATUS_TRANSITIONS = {
  intake: ["fitting", "in_progress", "cancelled"],
  fitting: ["in_progress", "cancelled"],
  in_progress: ["fitting", "quality_check", "cancelled"],
  quality_check: ["in_progress", "ready", "cancelled"],
  ready: ["collected", "in_progress", "cancelled"],
  collected: [],
  cancelled: [],
};

export default function AtelierJobDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  
  const [job, setJob] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [measurements, setMeasurements] = useState([]);
  const [history, setHistory] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tailors, setTailors] = useState([]);
  const [error, setError] = useState(null);
  
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateAssignee, setUpdateAssignee] = useState("");
  const [updateNote, setUpdateNote] = useState("");
  const [updating, setUpdating] = useState(false);

  const [measurementOpen, setMeasurementOpen] = useState(false);
  const [measurementForm, setMeasurementForm] = useState({ name: "", value: "", unit: "cm", note: "" });
  const [measurementSaving, setMeasurementSaving] = useState(false);

  useEffect(() => {
    loadJob();
    loadTailors();
  }, [id]);

  const loadJob = async (forceFresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/atelier/jobs/${id}`, { forceFresh });
      setJob(r.data.job);
      setCustomer(r.data.customer);
      setMeasurements(r.data.measurements || []);
      setHistory(r.data.status_history || []);
      setPhotos(r.data.photos || []);
      setUpdateStatus(r.data.job.status);
      setUpdateAssignee(r.data.job.assigned_to ? String(r.data.job.assigned_to) : "unassigned");
    } catch (e) {
      setError({
        message: e?.response?.data?.detail || e?.message || "Failed to load job details",
        status: e?.response?.status
      });
    } finally {
      setLoading(false);
    }
  };

  const loadTailors = async () => {
    try {
      const r = await api.get('/atelier/config');
      setTailors(r.data.staff || []);
    } catch {
      // ignore
    }
  };

  const handleUpdate = async () => {
    if (updateNote && updateStatus === job.status) {
      return toast.error("A status note requires moving the job to a different status.");
    }
    setUpdating(true);
    try {
      const payload = {};
      if (updateAssignee !== (job.assigned_to ? String(job.assigned_to) : "unassigned")) {
        payload.assigned_to = updateAssignee === "unassigned" ? null : updateAssignee;
      }
      if (updateStatus !== job.status) {
        payload.status = updateStatus;
        payload.status_note = updateNote || null;
      }
      if (Object.keys(payload).length === 0) {
        return toast.info("No changes to save.");
      }
      await api.patch(`/atelier/jobs/${id}`, payload);
      toast.success("Job updated");
      setUpdateNote("");
      await loadJob(true);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Update failed");
    } finally {
      setUpdating(false);
    }
  };

  const handleSaveMeasurement = async () => {
    if (!measurementForm.name || !measurementForm.value) return toast.error("Name and value are required");
    setMeasurementSaving(true);
    try {
      await api.post(`/atelier/jobs/${id}/measurements`, measurementForm);
      toast.success("Measurement saved");
      setMeasurementOpen(false);
      setMeasurementForm({ name: "", value: "", unit: "cm", note: "" });
      loadJob(true);
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to save measurement");
    } finally {
      setMeasurementSaving(false);
    }
  };

  if (loading) return <div className="p-10 text-center text-[var(--muted)]">Loading job details...</div>;
  
  if (error) {
    return (
      <div className="fade-in max-w-lg mx-auto mt-10">
        <Button variant="ghost" onClick={() => navigate('/atelier')} className="mb-4 -ml-3 text-[var(--muted)] no-print btn-ghost border-transparent hover:bg-transparent">
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to Board
        </Button>
        <Card className="card p-6 flex flex-col items-center justify-center text-center" data-testid="error-job-load">
          <AlertCircle className="h-10 w-10 text-[var(--danger)] mb-4" />
          <p className="text-[var(--text)] font-semibold mb-2">
            {error.status === 404 ? "Job not found" : "Error loading job"}
          </p>
          <p className="text-[var(--muted)] text-sm mb-6">{error.message}</p>
          {error.status !== 404 && (
            <Button onClick={() => { loadJob(); loadTailors(); }} className="btn-primary" data-testid="button-retry-job">
              Retry
            </Button>
          )}
        </Card>
      </div>
    );
  }

  if (!job) return null;

  const isAdmin = user?.role === "admin";

  return (
    <div className="relative pb-20 fade-in">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .print-area, .print-area * { visibility: visible; }
          .print-area { position: absolute; left: 0; top: 0; width: 100%; border: none !important; box-shadow: none !important; }
          .no-print { display: none !important; }
        }
      `}</style>

      <Button variant="ghost" onClick={() => navigate('/atelier')} className="mb-4 -ml-3 text-[var(--muted)] no-print btn-ghost border-transparent hover:bg-transparent">
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to Board
      </Button>

      <div className="flex items-start justify-between mb-6 no-print flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold tracking-tight text-[var(--text)]">
              Claim #{job.claim_number}
            </h1>
              <Badge variant="outline" className={`rounded-sm text-xs font-bold uppercase tracking-wide
              ${job.status === 'intake' ? 'border-[var(--amber)] text-[var(--amber)] bg-[#fef3c7]' : ''}
              ${job.status === 'ready' ? 'border-[var(--accent-strong)] text-[var(--accent-strong)] bg-[#dcfce7]' : ''}
              ${job.status === 'in_progress' ? 'border-blue-500 text-blue-700 bg-blue-50' : ''}
            `}>
              {job.status.replace("_", " ")}
            </Badge>
          </div>
          <p className="text-sm text-[var(--muted)]">
            Created {fmtDate(job.created_at)}
          </p>
        </div>
        <Button onClick={() => window.open(`${API}/atelier/jobs/${id}/ticket`, '_blank')} variant="outline" className="btn-ghost h-10 border-[var(--accent)] text-[var(--accent)]" data-testid="button-print-ticket">
          <Printer className="mr-2 h-4 w-4" /> Print Ticket
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Details */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="card p-6 rounded-xl print-area shadow-sm relative overflow-hidden border-t-[var(--accent)] border-t-4">
            <div className="hidden print:block text-center mb-6 border-b border-dashed border-gray-300 pb-6">
              <h2 className="text-2xl tracking-tight font-bold">VIVO ATELIER</h2>
              <div className="text-sm mt-1">Junction Mall</div>
              <div className="text-4xl tabular-nums font-bold mt-4 tracking-tighter">
                #{job.claim_number}
              </div>
              <div className="text-xs uppercase mt-2 font-bold tracking-wider">{job.status}</div>
            </div>

            <h3 className="text-lg font-bold mb-4 text-[var(--text)] flex items-center gap-2">
              <Scissors className="h-5 w-5 text-[var(--accent)]" /> Job Details
            </h3>
            
            <div className="grid grid-cols-2 gap-y-6 gap-x-4">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">Customer</div>
                <div className="font-medium text-sm text-[var(--text)]">{customer?.first_name || 'Walk-in'} {customer?.last_name || ''}</div>
                <div className="text-xs text-[var(--muted)] mt-0.5">{customer?.phone}</div>
                {job.customer_id && (
                  <Link to={`/customers?tab=details&id=${job.customer_id}`} className="text-[11px] text-[var(--accent)] hover:underline mt-1 inline-block no-print font-medium">
                    View Profile &rarr;
                  </Link>
                )}
              </div>
              
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">Garment</div>
                <div className="font-medium text-sm text-[var(--text)]">{job.sku || job.product_name || job.garment_type || '—'}</div>
                {job.condition_notes && <div className="text-xs text-[var(--muted)] mt-0.5">Condition: {job.condition_notes}</div>}
              </div>

              <div className="col-span-2 bg-[var(--panel)] p-4 rounded-xl border border-[var(--border)]">
                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-2">Alteration Instructions</div>
                <div className="text-sm whitespace-pre-wrap leading-relaxed text-[var(--text)]">{job.alteration_notes || "—"}</div>
              </div>

              {photos.length > 0 && (
                <div className="col-span-2">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-2">Condition / Photos</div>
                  <div className="flex gap-4 overflow-x-auto pb-2">
                    {photos.map(p => (
                      <div key={p.id} className="relative shrink-0 w-32">
                        <img src={`${API}/atelier/photos/${p.id}`} alt={p.caption || "Garment condition"} className="w-32 h-32 object-cover rounded-xl border border-[var(--border)]" />
                        {p.caption && <div className="text-[10px] mt-1 text-[var(--muted)] truncate">{p.caption}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">Promise Date</div>
                <div className="font-medium text-sm text-[var(--text)]">{job.promised_at ? fmtDate(job.promised_at) : '—'}</div>
              </div>

              {isAdmin && (
                <div className="no-print">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">Cost</div>
                  <div className="text-xs text-[var(--muted)] bg-[var(--panel)] inline-block px-2 py-1 rounded-md border border-[var(--border)]">
                    Pricing inactive / KES 0
                  </div>
                </div>
              )}
            </div>

            <div className="hidden print:block mt-12 pt-6 border-t border-dashed border-gray-300 text-center text-xs text-gray-500">
              <p>Please present this ticket when collecting your garment.</p>
              <p className="mt-1">Date: {new Date().toLocaleDateString()}</p>
            </div>
          </Card>

          {/* Measurements */}
          <Card className="card p-6 rounded-xl no-print">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[var(--text)]">Measurements</h3>
              <Button onClick={() => setMeasurementOpen(true)} size="sm" variant="outline" className="btn-ghost h-8 text-xs">
                Add
              </Button>
            </div>
            
            {(measurements || []).length === 0 ? (
              <div className="text-sm text-[var(--muted)]">No measurements recorded.</div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {measurements.map(m => (
                  <div key={m.id} className="bg-[var(--panel)] border border-[var(--border)] p-3 rounded-xl">
                    <div className="text-[10px] uppercase text-[var(--muted)]">{m.name}</div>
                    <div className="tabular-nums text-lg font-bold text-[var(--text)]">{m.value} <span className="text-xs font-normal text-[var(--muted)]">{m.unit}</span></div>
                    {m.note && <div className="text-[10px] text-[var(--muted)] mt-1">{m.note}</div>}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Timeline */}
          <Card className="card p-6 rounded-xl no-print">
            <h3 className="text-lg font-bold mb-4 text-[var(--text)] flex items-center gap-2">
              <Clock className="h-5 w-5 text-[var(--accent)]" /> Job Timeline
            </h3>
            
            <div className="space-y-4">
              {(history || []).length === 0 ? (
                <div className="text-sm text-[var(--muted)]">No timeline events recorded.</div>
              ) : (
                <div className="relative border-l border-[var(--border)] ml-3 pl-6 space-y-6">
                  {history.map((event, i) => (
                    <div key={i} className="relative">
                      <div className="absolute -left-[30px] bg-[var(--bg)] border-2 border-[var(--accent)] h-3 w-3 rounded-full top-1"></div>
                      <div className="text-sm font-medium text-[var(--text)]">Status changed to {event.to_status.replace("_", " ")}</div>
                      {event.note && (
                        <div className="text-sm mt-1 text-[var(--muted)] whitespace-pre-wrap bg-[var(--panel)] p-3 rounded-xl border border-[var(--border)] italic">
                          "{event.note}"
                        </div>
                      )}
                      <div className="text-[11px] text-[var(--muted)] mt-1 uppercase tracking-wider font-semibold">
                        {fmtDate(event.changed_at)} &middot; {event.changed_by_name || 'System'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Action Sidebar */}
        <div className="space-y-6 no-print">
          <Card className="card p-5 rounded-xl bg-[var(--panel)] border-t-[var(--amber)] border-t-4">
            <h3 className="text-lg font-bold mb-4 text-[var(--text)]">Update Status</h3>
            <div className="space-y-4">
              <div>
                <Label className="text-xs mb-1 block">Status</Label>
                <Select value={updateStatus} onValueChange={setUpdateStatus}>
                  <SelectTrigger className="input-pill bg-white h-10" data-testid="select-update-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={job.status}>{job.status.replace("_", " ")} (Current)</SelectItem>
                    {STATUS_TRANSITIONS[job.status]?.map(status => (
                      <SelectItem key={status} value={status}>{status.replace("_", " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div>
                <Label className="text-xs mb-1 block">Assignee</Label>
                <Select value={updateAssignee} onValueChange={setUpdateAssignee}>
                  <SelectTrigger className="input-pill bg-white h-10" data-testid="select-update-assignee">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {tailors.map(t => (
                      <SelectItem key={String(t.id)} value={String(t.user_id || t.id)}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-xs mb-1 block">Internal Note (optional)</Label>
                <Textarea 
                  value={updateNote} 
                  onChange={e => setUpdateNote(e.target.value)} 
                  placeholder="Fabric ordered, waiting for customer..."
                  className="input-pill bg-white text-sm resize-none" data-testid="input-update-note"
                  rows={3}
                />
              </div>

              <Button disabled={updating} onClick={handleUpdate} className="btn-primary w-full h-10 font-semibold" data-testid="button-update-job">
                {updating ? "Saving..." : "Update Job"}
              </Button>
            </div>
          </Card>
        </div>
      </div>

      <Dialog open={measurementOpen} onOpenChange={setMeasurementOpen}>
        <DialogContent className="card-white rounded-xl w-[95vw] max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Measurement</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Name (e.g. Bust, Waist, Inseam)</Label>
              <Input value={measurementForm.name} onChange={e => setMeasurementForm(f => ({ ...f, name: e.target.value }))} className="mt-1 input-pill" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Value</Label>
                <Input type="number" value={measurementForm.value} onChange={e => setMeasurementForm(f => ({ ...f, value: e.target.value }))} className="mt-1 input-pill" />
              </div>
              <div>
                <Label>Unit</Label>
                <Select value={measurementForm.unit} onValueChange={v => setMeasurementForm(f => ({ ...f, unit: v }))}>
                  <SelectTrigger className="mt-1 input-pill"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cm">cm</SelectItem>
                    <SelectItem value="in">inches</SelectItem>
                    <SelectItem value="mm">mm</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Note (Optional)</Label>
              <Input value={measurementForm.note} onChange={e => setMeasurementForm(f => ({ ...f, note: e.target.value }))} className="mt-1 input-pill" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" className="btn-ghost" onClick={() => setMeasurementOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveMeasurement} disabled={measurementSaving} className="btn-primary">
              {measurementSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}