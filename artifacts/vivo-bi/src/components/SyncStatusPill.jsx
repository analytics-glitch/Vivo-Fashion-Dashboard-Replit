import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * Sync-pipeline health pill.
 *
 * Polls `/api/sync-status` every 60 s and reflects the WORSE of two separate
 * signals:
 *   1. Loop liveness (heartbeat) — is the sync loop itself running?
 *      • Green (OK) ran <10 min ago · Amber 10-30 min · Red >30 min/endpoint down
 *   2. Per-source data staleness (`sources_health`) — is every ACTIVE sales
 *      source (Kenya Odoo, Uganda, Rwanda, Shop Zetu) still landing rows
 *      during its trading hours? A healthy pull rewrites its anchor window
 *      with fresh loaded_at stamps, so a frozen source means dead pulls (the
 *      13-Aug-2026 Odoo permission loss froze Kenya ~19 h while the loop
 *      heartbeat stayed green — this is the signal that catches that).
 *
 * When a source is stale the label names the worst offender and its data age
 * (e.g. "Kenya feed 17h stale"); when the LOOP is the problem the label keeps
 * the heartbeat age (stale sources are then just a consequence). A quiet
 * overnight/pre-open period accrues no staleness server-side, so the pill
 * stays green for merely-closed stores.
 *
 * Visible to every signed-in user (sync health is operational, not sensitive).
 * No emojis — a colored status dot per project conventions.
 */
const fmtAgo = (m) => {
  if (m == null) return "—";
  if (m < 1) return "<1m ago";
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return r ? `${h}h ${r}m ago` : `${h}h ago`;
};

const RANK = { loading: 0, OK: 0, WARNING: 1, CRITICAL: 2 };

const SyncStatusPill = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const { data: d } = await api.get("/sync-status");
        if (!cancelled) {
          setData(d);
          setError(false);
        }
      } catch (e) {
        if (!cancelled) setError(true);
      }
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const loopHealth = error ? "CRITICAL" : data?.health || "loading";
  const sourcesHealth = data?.sources_health || "OK";
  const health =
    loopHealth === "loading"
      ? "loading"
      : (RANK[sourcesHealth] || 0) > (RANK[loopHealth] || 0)
        ? sourcesHealth
        : loopHealth;

  const cls = {
    loading: "bg-panel text-muted border-border",
    OK: "bg-emerald-50 text-emerald-700 border-emerald-200",
    WARNING: "bg-amber-50 text-amber-800 border-amber-200",
    CRITICAL: "bg-rose-50 text-rose-700 border-rose-200",
  }[health];

  const dot = {
    loading: "bg-slate-300",
    OK: "bg-emerald-500",
    WARNING: "bg-amber-500",
    CRITICAL: "bg-rose-500",
  }[health];

  const ago = fmtAgo(data?.minutes_since);
  const staleOnly = loopHealth === "OK" && data?.sources_stale && data?.stale_summary;
  const label = error
    ? "Sync offline"
    : health === "loading"
      ? "Sync —"
      : staleOnly
        ? data.stale_summary
        : `Sync · ${ago}`;

  const dataAgo = fmtAgo(data?.data_freshness?.minutes_since);
  const staleDetail = (data?.sources || [])
    .filter((s) => s.status === "stale")
    .map((s) => `${s.short_label}: no new rows since ${s.last_loaded_eat} EAT (${s.age_label})`)
    .join("; ");
  const title = error
    ? "Sync status endpoint unreachable"
    : `Sync pipeline: ${health}`
      + (data?.last_sync_at ? ` — loop ran ${ago}` : "")
      + (data?.data_freshness?.last_loaded_at ? `; data loaded ${dataAgo}` : "")
      + (staleDetail ? `. STALE — ${staleDetail}` : "");

  return (
    <div className="relative inline-block" title={title}>
      <span
        data-testid="sync-status-pill"
        className={`hidden lg:inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10.5px] font-semibold ${cls}`}
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
        <span>{label}</span>
      </span>
    </div>
  );
};

export default SyncStatusPill;
