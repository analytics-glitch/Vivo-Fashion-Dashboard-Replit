import React, { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Database, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";

/**
 * Customer cache sync card. Shows live progress of the BI-wide full-sync
 * (quarterly pagination → all ~163k customers) so a non-technical manager
 * can kick it off and watch it complete.
 */
export default function CustomerSyncCard() {
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);

  const fetchStatus = async () => {
    try {
      const r = await api.get("/admin/customer-cache/full-sync/status");
      setJob(r.data || null);
      return r.data;
    } catch (e) {
      return null;
    }
  };

  useEffect(() => {
    fetchStatus();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Auto-poll while a sync is running
  useEffect(() => {
    if (job?.status === "running") {
      if (!pollRef.current) {
        pollRef.current = setInterval(fetchStatus, 4000);
      }
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [job?.status]);

  const start = async () => {
    setBusy(true);
    try {
      await api.post("/admin/customer-cache/full-sync");
      await fetchStatus();
    } finally {
      setBusy(false);
    }
  };

  const status = job?.status || "idle";
  const completedQ = job?.completed_quarters ?? 0;
  const totalQ = job?.total_quarters ?? 0;
  const pct = totalQ ? Math.round((completedQ / totalQ) * 100) : 0;
  const cached = job?.customers_in_cache ?? 0;
  const unique = job?.unique_customers_synced ?? 0;
  const errors = job?.errors || [];
  const isRunning = status === "running";
  const isDone = status === "completed" || status === "completed_with_errors";

  return (
    <Card className="vivo-card p-6 mt-6 rounded-sm" data-testid="settings-customer-sync-card">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="flex items-start gap-4 max-w-xl">
          <div className="h-10 w-10 rounded-sm bg-[var(--vivo-bg-soft)] flex items-center justify-center">
            <Database className="h-5 w-5 text-[var(--vivo-navy)]"/>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">Customer database</div>
            <h2 className="font-display text-2xl mt-1">Sync all customers from BI</h2>
            <p className="text-sm text-[var(--vivo-muted)] mt-2">
              Pulls every customer in the Vivo BI warehouse (~163k records) into the CRM, paginated quarter by quarter. Takes about 5 minutes the first time; subsequent runs only refresh changes. Recompute of loyalty tiers runs automatically afterwards.
            </p>
          </div>
        </div>
        <Button
          onClick={start}
          disabled={busy || isRunning}
          className="rounded-sm bg-[var(--vivo-navy)] text-white"
          data-testid="settings-sync-customers-btn"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isRunning ? "animate-spin" : ""}`}/>
          {isRunning ? "Syncing…" : isDone ? "Re-run full sync" : "Run full sync"}
        </Button>
      </div>

      <div className="vivo-divider my-5"/>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="sync-stats">
        <Stat label="Cached customers" value={cached.toLocaleString()} highlight />
        <Stat label="Unique synced (this run)" value={unique.toLocaleString()} />
        <Stat label="Quarters processed" value={totalQ ? `${completedQ} / ${totalQ}` : "—"} />
        <Stat label="Status" value={prettyStatus(status)} />
      </div>

      {(isRunning || isDone) && (
        <div className="mt-5">
          <div className="h-2 rounded-sm bg-[var(--vivo-bg)] overflow-hidden">
            <div
              className="h-full bg-[var(--vivo-navy)] transition-all duration-500"
              style={{ width: `${pct}%` }}
              data-testid="sync-progress-bar"
            />
          </div>
          <div className="text-xs text-[var(--vivo-muted)] mt-2 flex items-center gap-2">
            {isRunning && job?.current_range && (
              <>
                <RefreshCw className="h-3 w-3 animate-spin"/>
                Processing <code className="bg-[var(--vivo-bg)] px-1 rounded-sm">{job.current_range}</code> · {pct}% complete
              </>
            )}
            {isDone && errors.length === 0 && (
              <>
                <CheckCircle2 className="h-3 w-3 text-emerald-600"/>
                Completed at {fmtTime(job?.finished_at)} · loyalty tiers recomputed.
              </>
            )}
            {isDone && errors.length > 0 && (
              <>
                <AlertTriangle className="h-3 w-3 text-amber-600"/>
                Completed with {errors.length} error{errors.length === 1 ? "" : "s"} (most likely transient BI 503s) — re-run to retry.
              </>
            )}
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <details className="mt-3 text-xs text-[var(--vivo-muted)]" data-testid="sync-errors">
          <summary className="cursor-pointer">{errors.length} error log entries</summary>
          <ul className="mt-2 space-y-1 list-disc pl-5">
            {errors.slice(0, 10).map((e, i) => <li key={i} className="font-mono">{e}</li>)}
            {errors.length > 10 && <li>…+{errors.length - 10} more</li>}
          </ul>
        </details>
      )}
    </Card>
  );
}

function Stat({ label, value, highlight }) {
  return (
    <div className={`px-4 py-3 rounded-sm ${highlight ? "bg-[var(--vivo-bg-soft)]" : "border border-[var(--vivo-border)]"}`}>
      <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">{label}</div>
      <div className={`font-display text-xl mt-1 ${highlight ? "text-[var(--vivo-navy)]" : ""}`}>{value}</div>
    </div>
  );
}

function prettyStatus(s) {
  if (s === "running") return "Running";
  if (s === "completed") return "Completed";
  if (s === "completed_with_errors") return "Completed (w/ errors)";
  if (s === "idle") return "Not started";
  return s || "—";
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch { return iso; }
}
