import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * Sync-pipeline health pill.
 *
 * Polls `/api/sync-status` every 60 s. Color reflects whether the sync LOOP is
 * alive (its heartbeat), so a quiet sales period never turns the pill red:
 *   • Green  (OK)       — sync ran within 10 min
 *   • Amber  (WARNING)  — sync last ran 10-30 min ago
 *   • Red    (CRITICAL) — sync last ran > 30 min ago, or the endpoint is down
 * The tooltip also reports data freshness (when sales data last loaded).
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

  const health = error ? "CRITICAL" : data?.health || "loading";

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
  const label = error
    ? "Sync offline"
    : health === "loading"
      ? "Sync —"
      : `Sync · ${ago}`;

  const dataAgo = fmtAgo(data?.data_freshness?.minutes_since);
  const title = error
    ? "Sync status endpoint unreachable"
    : `Sync pipeline: ${health}`
      + (data?.last_sync_at ? ` — last ran ${ago}` : "")
      + (data?.data_freshness?.last_loaded_at ? `; data loaded ${dataAgo}` : "");

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
