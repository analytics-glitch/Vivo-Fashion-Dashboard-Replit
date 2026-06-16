import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatDate, formatKES } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LoyaltyBadge } from "@/components/LoyaltyBadge";
import { toast } from "sonner";
import { AlertOctagon, ShieldCheck, Phone, Mail, Clock, ExternalLink } from "lucide-react";

/**
 * Manager-only queue of customer right-to-be-forgotten requests submitted
 * from the mobile loyalty app. Each row resolves to the existing
 * `/api/customers/{id}/forget` endpoint which performs full anonymisation.
 */
export default function DataRequests() {
  const [data, setData] = useState({ pending: [], pending_count: 0, recent_forgotten: [] });
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState(null);
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get("/manager/data-deletion-requests");
      setData(r.data);
    } catch (e) {
      toast.error("Could not load deletion queue");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const confirmForget = async () => {
    if (!target) return;
    if (confirmText !== "FORGET") {
      toast.error("Type FORGET to confirm");
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/customers/${target.customer_id}/forget`);
      toast.success(`${target.customer_name || "Customer"} has been anonymised`);
      setTarget(null);
      setConfirmText("");
      await load();
    } catch {
      toast.error("Could not complete the deletion");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8" data-testid="data-requests-page">
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--vivo-muted)]">Data governance</div>
          <h1 className="font-display text-3xl md:text-4xl text-[var(--vivo-navy)] mt-1">Right to be forgotten</h1>
          <p className="text-sm text-[var(--vivo-muted)] mt-2 max-w-2xl">
            Requests submitted by members through the loyalty mobile app under
            the Kenya Data Protection Act. Confirming a request will anonymise the
            customer across the CRM. BI-side records in BigQuery remain — Vivo's
            data team must be notified separately for upstream deletion.
          </p>
        </div>
        <Link to="/dashboard" className="text-xs text-[var(--vivo-muted)] hover:underline">← Back to dashboard</Link>
      </div>

      <Card className="vivo-card p-0 overflow-hidden mb-8" data-testid="pending-card">
        <div className="px-5 py-3 border-b border-[var(--vivo-border)] flex items-center justify-between bg-[var(--vivo-bg-soft)]">
          <div className="flex items-center gap-2">
            <AlertOctagon className="h-4 w-4 text-amber-600"/>
            <h3 className="font-display text-lg">Pending requests</h3>
          </div>
          <span className="text-xs uppercase tracking-wider text-[var(--vivo-muted)]">{data.pending_count} in queue</span>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-[var(--vivo-muted)]">Loading…</div>
        ) : data.pending.length === 0 ? (
          <div className="vivo-empty m-8 text-center">
            <ShieldCheck className="h-7 w-7 mx-auto opacity-40"/>
            <h4>No pending requests</h4>
            <p>Members can submit a deletion request from the loyalty app Profile screen.</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--vivo-border)]">
            {data.pending.map((c) => (
              <div key={c.customer_id} className="p-5 flex items-start justify-between gap-4" data-testid={`request-row-${c.customer_id}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <Link to={`/customers/${c.customer_id}`} className="font-display text-lg text-[var(--vivo-navy)] hover:underline">
                      {c.customer_name || c.customer_id}
                    </Link>
                    {c.loyalty_tier && <LoyaltyBadge tier={c.loyalty_tier} size="sm"/>}
                    <span className="text-[11px] uppercase tracking-wider text-[var(--vivo-muted)]">{c.customer_country || "Kenya"}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-4 text-xs text-[var(--vivo-muted)]">
                    {c.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3"/>{c.phone}</span>}
                    {c.email && <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3"/>{c.email}</span>}
                    {c.preferred_store && <span>Store: {c.preferred_store}</span>}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-4 text-xs">
                    <span><span className="text-[var(--vivo-muted)]">12-mo spend:</span> <span className="font-mono-num text-[var(--vivo-navy)]">{formatKES(c.spend_12mo_kes)}</span></span>
                    <span><span className="text-[var(--vivo-muted)]">Orders:</span> <span className="font-mono-num text-[var(--vivo-navy)]">{c.total_orders || 0}</span></span>
                    <span className="inline-flex items-center gap-1 text-amber-700"><Clock className="h-3 w-3"/>Submitted {formatDate(c.data_deletion_requested_at)}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <Link to={`/customers/${c.customer_id}`} className="text-xs text-[var(--vivo-muted)] hover:underline inline-flex items-center gap-1">
                    Review profile <ExternalLink className="h-3 w-3"/>
                  </Link>
                  <Button
                    variant="destructive"
                    onClick={() => { setTarget(c); setConfirmText(""); }}
                    className="rounded-sm"
                    data-testid={`request-forget-${c.customer_id}`}
                  >
                    Confirm & Forget
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="vivo-card p-0 overflow-hidden" data-testid="forgotten-card">
        <div className="px-5 py-3 border-b border-[var(--vivo-border)] bg-[var(--vivo-bg-soft)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-700"/>
            <h3 className="font-display text-lg">Recently anonymised</h3>
          </div>
          <span className="text-xs uppercase tracking-wider text-[var(--vivo-muted)]">{data.recent_forgotten.length} on record</span>
        </div>
        {data.recent_forgotten.length === 0 ? (
          <div className="p-6 text-sm text-[var(--vivo-muted)]">No customers have been anonymised yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[var(--vivo-bg-soft)] text-[10px] uppercase tracking-[0.14em] text-[var(--vivo-muted)]">
              <tr>
                <th className="text-left px-5 py-2">Customer ID</th>
                <th className="text-left px-5 py-2">Processed by</th>
                <th className="text-right px-5 py-2">When</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_forgotten.map((r) => (
                <tr key={r.customer_id + r.at} className="border-t border-[var(--vivo-border)]">
                  <td className="px-5 py-3 font-mono text-xs">{r.customer_id}</td>
                  <td className="px-5 py-3">{r.by_name}</td>
                  <td className="px-5 py-3 text-right text-[var(--vivo-muted)]">{formatDate(r.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Dialog open={!!target} onOpenChange={(o) => { if (!o) setTarget(null); }}>
        <DialogContent className="rounded-sm">
          <DialogHeader>
            <DialogTitle>Anonymise {target?.customer_name || "customer"}?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>This permanently anonymises all CRM-side data for this customer: notes, follow-ups, messages, preferences, lookbooks, social handles, and the loyalty profile.</p>
            <p className="text-[var(--vivo-muted)] text-xs">BI-side BigQuery records are <strong>not</strong> deleted by this action — coordinate separately with Vivo's data team for upstream removal.</p>
            <div className="bg-amber-50 border-l-4 border-amber-500 p-3 rounded-sm">
              <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Confirm</div>
              <p className="text-sm mt-1">Type <strong>FORGET</strong> to proceed.</p>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="FORGET"
                className="mt-2 rounded-sm font-mono"
                data-testid="forget-confirm-input"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} className="rounded-sm">Cancel</Button>
            <Button
              variant="destructive"
              disabled={confirmText !== "FORGET" || submitting}
              onClick={confirmForget}
              className="rounded-sm"
              data-testid="forget-confirm-button"
            >
              {submitting ? "Anonymising…" : "Anonymise now"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
