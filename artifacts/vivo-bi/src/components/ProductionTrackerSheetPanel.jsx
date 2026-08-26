import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowClockwise, ArrowSquareOut, CheckCircle, ClockCounterClockwise,
  Plug, WarningCircle,
} from "@phosphor-icons/react";
import { api } from "@/lib/api";

/**
 * Setup & Settings panel for the Production Tracker 2026 Google Sheets
 * feed. Read-only status/history/warnings for everyone with access to the
 * production workspace; configuration and "Sync now" are restricted to
 * SHEET_SOURCE_WRITE_ROLES (admin, production) on the backend — this panel
 * only reflects that gate via `status.can_edit`, it never enforces it.
 */

// Backend run status values (production_tracker_sheet_sync.py / production_workspace.py
// _tracker_sheet_get's connection_state) are 'ok', 'connection_pending', 'failed', 'running',
// or absent (-> 'never_synced'). 'succeeded'/'promoted' are kept as aliases in case an older
// run row or a future status rename uses them, but 'ok' is the canonical success value.
const SUCCESS_STATES = ["ok", "succeeded", "promoted"];
const STATE_LABEL = {
  never_synced: "Never synced",
  connection_pending: "Connection pending — sheet not shared with the connector",
  failed: "Last sync failed",
  running: "Sync in progress",
  ok: "Synced",
  succeeded: "Synced",
  promoted: "Synced",
};
const STATE_TONE = (state) => {
  if (SUCCESS_STATES.includes(state)) return "ok";
  if (state === "connection_pending") return "pending";
  if (state === "failed") return "danger";
  return "pending";
};
const fmtDate = (value) => {
  if (!value) return "Not recorded";
  try { return new Date(value).toLocaleString("en-GB", { timeZone: "Africa/Nairobi" }) + " EAT"; } catch { return String(value); }
};

export default function ProductionTrackerSheetPanel({ user }) {
  const [status, setStatus] = useState(null);
  const [runs, setRuns] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState(null);
  const [tabMapDraft, setTabMapDraft] = useState({ summary: "", monthly: "", process: "" });
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [statusRes, runsRes, warningsRes] = await Promise.all([
        api.get("/production-workspace/tracker-sheet", { forceFresh: true }),
        api.get("/production-workspace/tracker-sheet/runs", { params: { limit: 10 }, forceFresh: true }),
        api.get("/production-workspace/tracker-sheet/warnings", { params: { resolved: false, limit: 20 }, forceFresh: true }),
      ]);
      setStatus(statusRes.data);
      setRuns(runsRes.data?.runs || []);
      setWarnings(warningsRes.data?.warnings || []);
      if (statusRes.data?.tab_map) setTabMapDraft({ ...tabMapDraft, ...statusRes.data.tab_map });
    } catch (err) {
      setError(err?.response?.data?.detail || "The tracker sheet feed status could not be loaded.");
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(); }, [load]);

  const syncNow = async () => {
    const syncReason = window.prompt("Audit reason for triggering this sync now");
    if (!syncReason || !syncReason.trim()) return;
    setSyncing(true); setNotice(null);
    try {
      await api.post("/production-workspace/tracker-sheet/sync-now", { reason: syncReason.trim() });
      setNotice({ tone: "ok", text: "Sync started in the background. Refresh in a moment to see the result." });
      setTimeout(load, 4000);
    } catch (err) {
      setNotice({ tone: "danger", text: err?.response?.data?.detail || "Could not start the sync." });
    } finally { setSyncing(false); }
  };

  const saveConfig = async (event) => {
    event.preventDefault();
    if (!reason.trim()) { setNotice({ tone: "danger", text: "Add a reason before saving configuration changes." }); return; }
    setSaving(true); setNotice(null);
    try {
      await api.put("/production-workspace/tracker-sheet", { tab_map: tabMapDraft, reason });
      setReason("");
      setNotice({ tone: "ok", text: "Tab configuration saved." });
      await load();
    } catch (err) {
      setNotice({ tone: "danger", text: err?.response?.data?.detail || "Could not save the tab configuration." });
    } finally { setSaving(false); }
  };

  const toggleEnabled = async () => {
    const nextReason = window.prompt(`Audit reason to ${status?.enabled ? "pause" : "resume"} the scheduled sync`);
    if (!nextReason) return;
    try {
      await api.put("/production-workspace/tracker-sheet", { enabled: !status?.enabled, reason: nextReason });
      await load();
    } catch (err) {
      setNotice({ tone: "danger", text: err?.response?.data?.detail || "Could not change the schedule." });
    }
  };

  if (loading) return <section className="pw-panel p-8 text-center text-sm" style={{ color: "var(--pw-text-muted)" }} data-testid="pw-tracker-sheet-panel">Loading Production Tracker sheet feed status…</section>;
  if (error) return <section className="pw-panel p-4 text-sm text-rose-800" data-testid="pw-tracker-sheet-panel"><WarningCircle className="inline mr-2" />{error}<button className="ml-3 font-bold underline" onClick={load}>Retry</button></section>;
  if (!status?.configured) return <section className="pw-panel p-5" data-testid="pw-tracker-sheet-panel"><div className="font-bold" style={{ color: "var(--pw-navy)" }}>Production Tracker 2026 sheet feed</div><div className="mt-2 text-sm" style={{ color: "var(--pw-text-muted)" }}>The governed source record has not been created yet. It is created automatically on the next API restart — refresh this page in a moment.</div></section>;

  const state = status.connection_state;
  const tone = STATE_TONE(state);
  const canEdit = Boolean(status.can_edit);
  const latestRun = status.latest_run;

  return <section className="pw-panel p-5 space-y-5" data-testid="pw-tracker-sheet-panel">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="font-bold" style={{ color: "var(--pw-navy)" }}>Production Tracker 2026 sheet feed</div>
        <div className="mt-1 text-sm" style={{ color: "var(--pw-text-muted)" }}>Governed, read-only ingestion of the "Production Tracker 2026" Google Sheet. Every read is a GET — nothing is ever written back to the sheet.</div>
      </div>
      <div className="flex items-center gap-2">
        {canEdit && <button type="button" className="pw-action pw-action--quiet" data-testid="pw-tracker-sheet-sync-now" onClick={syncNow} disabled={syncing || !status.enabled}><ArrowClockwise size={15} className={syncing ? "animate-spin" : ""} />{syncing ? "Starting…" : "Sync now"}</button>}
        <a className="pw-action pw-action--quiet" href={status.spreadsheet_url} target="_blank" rel="noreferrer"><ArrowSquareOut size={15} />Open sheet</a>
      </div>
    </div>

    {state === "connection_pending" && <div className="pw-banner pw-banner--pending" data-testid="pw-tracker-sheet-connection-pending"><Plug size={20} /><div><strong>Connection pending</strong>This sheet has not been shared with the connector's Google account yet, so no live row has been read. Share "Production Tracker 2026" with the connector, then use Sync now. Nothing has been written to the sheet, and no data here has been guessed.</div></div>}
    {state === "failed" && <div className="pw-banner pw-banner--danger" data-testid="pw-tracker-sheet-failed"><WarningCircle size={20} /><div><strong>Last sync failed</strong>{latestRun?.error_message || "The sync could not complete."} The previously published metrics are unchanged (last-known-good) — nothing shown elsewhere in the workspace was rolled back or blanked because of this failure.</div></div>}
    {SUCCESS_STATES.includes(state) && <div className="pw-banner pw-banner--ok" data-testid="pw-tracker-sheet-ok"><CheckCircle size={20} /><div><strong>Synced</strong>Source updated label: {latestRun?.source_updated_label || "not recorded"}. {latestRun?.row_count ?? 0} rows promoted, {latestRun?.warning_count ?? 0} open warning{(latestRun?.warning_count ?? 0) === 1 ? "" : "s"}.</div></div>}
    {state === "never_synced" && <div className="pw-banner pw-banner--pending"><ClockCounterClockwise size={20} /><div><strong>Never synced</strong>No sync has run yet for this source.</div></div>}

    <div className="grid gap-3 sm:grid-cols-4">
      <div><div className="pw-metric-label">Connection state</div><span className={`pw-chip pw-chip--${tone === "ok" ? "ok" : tone === "danger" ? "danger" : "warning"} mt-1`}>{STATE_LABEL[state] || state}</span></div>
      <div><div className="pw-metric-label">Schedule</div><div className="mt-1 text-sm">{status.enabled ? "Every 24 hours + manual" : "Paused"} {canEdit && <button type="button" className="ml-2 text-xs font-bold underline" style={{ color: "var(--pw-navy)" }} onClick={toggleEnabled}>{status.enabled ? "Pause" : "Resume"}</button>}</div></div>
      <div><div className="pw-metric-label">Last run</div><div className="mt-1 text-sm">{fmtDate(latestRun?.finished_at || latestRun?.started_at)}</div></div>
      <div><div className="pw-metric-label">Rows promoted</div><div className="mt-1 text-sm">{latestRun?.row_count ?? "Unavailable"}</div></div>
    </div>

    {notice && <div className={`pw-banner pw-banner--${notice.tone}`}>{notice.text}</div>}

    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <div className="font-bold text-sm" style={{ color: "var(--pw-navy)" }}>Open data-quality warnings</div>
        <div className="mt-1 text-xs" style={{ color: "var(--pw-text-muted)" }}>Every sync surfaces known issues rather than silently working around them — including the conflicting annual totals and the sheet's broken "Average Output per Person" formula.</div>
        {!warnings.length ? <div className="mt-3 text-xs" style={{ color: "var(--pw-text-muted)" }}>No open warning.</div> : <ul className="mt-3 space-y-2">{warnings.map((item) => <li key={item.id} className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: "var(--pw-border)" }}><span className={`pw-chip ${item.severity === "warning" ? "pw-chip--warning" : "pw-chip--muted"}`}>{item.code}</span><div className="mt-1">{item.message}</div></li>)}</ul>}
      </div>
      <div>
        <div className="font-bold text-sm" style={{ color: "var(--pw-navy)" }}>Sync history</div>
        <div className="mt-1 text-xs" style={{ color: "var(--pw-text-muted)" }}>Every manual and scheduled attempt, whether or not it promoted data.</div>
        {!runs.length ? <div className="mt-3 text-xs" style={{ color: "var(--pw-text-muted)" }}>No run recorded yet.</div> : <div className="pw-table-wrap mt-3"><table className="pw-table"><thead><tr><th>Started</th><th>Trigger</th><th>Status</th><th>Rows</th></tr></thead><tbody>{runs.map((run) => <tr key={run.id}><td>{fmtDate(run.started_at)}</td><td>{run.trigger_kind}{run.triggered_by ? ` · ${run.triggered_by}` : ""}</td><td><span className={`pw-chip pw-chip--${SUCCESS_STATES.includes(run.status) ? "ok" : run.status === "failed" ? "danger" : "warning"}`}>{STATE_LABEL[run.status] || run.status}</span></td><td>{run.row_count ?? "—"}</td></tr>)}</tbody></table></div>}
      </div>
    </div>

    {canEdit && <form onSubmit={saveConfig} className="rounded-lg border p-4" style={{ borderColor: "var(--pw-border)" }} data-testid="pw-tracker-sheet-config-form">
      <div className="font-bold text-sm" style={{ color: "var(--pw-navy)" }}>Tab mapping</div>
      <div className="mt-1 text-xs" style={{ color: "var(--pw-text-muted)" }}>The live parser reads tabs by these names and matches rows by label, not fixed cell coordinates — recalibrate here if the sheet's layout changes, without a code change.</div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {["summary", "monthly", "process"].map((key) => <label key={key} className="text-xs font-medium" style={{ color: "var(--pw-text-muted)" }}>{key.charAt(0).toUpperCase() + key.slice(1)} tab name
          <input className="mt-1 block w-full rounded-md border px-2 py-1.5 text-sm" style={{ borderColor: "var(--pw-border)" }} value={tabMapDraft[key] || ""} onChange={(event) => setTabMapDraft({ ...tabMapDraft, [key]: event.target.value })} />
        </label>)}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input required placeholder="Audit reason" className="min-w-[220px] flex-1 rounded-md border px-2 py-1.5 text-xs" style={{ borderColor: "var(--pw-border)" }} value={reason} onChange={(event) => setReason(event.target.value)} />
        <button className="pw-action pw-action--quiet" type="submit" disabled={saving}>{saving ? "Saving…" : "Save tab mapping"}</button>
      </div>
    </form>}
  </section>;
}
