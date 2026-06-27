import React, { useCallback, useEffect, useState } from "react";
import { api, fmtKESLong } from "@/lib/api";
import { SectionTitle, Loading, ErrorBox, Empty } from "@/components/common";
import { ArrowClockwise, ShieldWarning, CaretDown, CaretRight, Check, X, Copy, Lightning, Wrench } from "@phosphor-icons/react";
import SortableTable from "@/components/SortableTable";
import { toast } from "sonner";

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "all", label: "All statuses" },
  { value: "auto_fixed", label: "Auto-fixed" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

const SEVERITY_OPTIONS = [
  { value: "", label: "All severities" },
  { value: "red", label: "Red only" },
  { value: "amber", label: "Amber only" },
];

const fmtTs = (ts) => {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
      timeZone: "Africa/Nairobi",
    });
  } catch { return ts; }
};

const sevPill = (s) =>
  s === "red" ? "pill-red" : s === "amber" ? "pill-amber" : "pill-neutral";

const statusPill = (s) =>
  s === "approved" || s === "auto_fixed" ? "pill-green"
    : s === "rejected" ? "pill-neutral"
      : "pill-amber";

const fmtNumOrDash = (n) =>
  n === null || n === undefined || isNaN(Number(n))
    ? "—"
    : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

const SummaryCard = ({ label, value, tone, hint }) => (
  <div className="card-white p-4 flex flex-col gap-1" data-testid={`summary-${label}`}>
    <div className="eyebrow text-[10.5px]">{label}</div>
    <div className={`font-extrabold text-[22px] leading-none ${tone || ""}`}>{value}</div>
    {hint ? <div className="text-[10.5px] text-muted leading-tight">{hint}</div> : null}
  </div>
);

// Recent run/event trail from validation_audit, collapsed by default.
const AgentActivitySection = () => {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [lastRun, setLastRun] = useState(null);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.get("/admin/validation-audit", { params: { limit: 200 }, forceFresh: true })
      .then((r) => {
        setRows(r.data?.rows || []);
        setLastRun(r.data?.last_run || null);
        setAvailable(r.data?.available !== false);
        setLoadedOnce(true);
      })
      .catch((e) => setError(e?.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (open && !loadedOnce) load();
  }, [open, loadedOnce, load]);

  return (
    <div className="card-white p-5" data-testid="agent-activity-section">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 text-left"
        data-testid="agent-activity-toggle"
      >
        <div className="flex items-center gap-2">
          {open ? <CaretDown size={14} weight="bold" /> : <CaretRight size={14} weight="bold" />}
          <div>
            <h3 className="font-extrabold text-[15px] leading-tight">Agent activity log</h3>
            <p className="text-muted text-[12px] mt-0.5">
              Recent runs and events from the validation agent (newest first).
            </p>
          </div>
        </div>
        {lastRun && (
          <span className="text-[11px] text-muted whitespace-nowrap">Last run {fmtTs(lastRun)}</span>
        )}
      </button>

      {open && (
        <div className="mt-4">
          {loading && <Loading />}
          {error && <ErrorBox message={error} />}
          {!loading && !error && !available && (
            <Empty label="The validation agent has not written any activity to this database yet." />
          )}
          {!loading && !error && available && (
            rows.length === 0
              ? <Empty label="No agent activity recorded yet." />
              : (
                <SortableTable
                  testId="agent-activity-table"
                  exportName="validation-agent-activity.csv"
                  initialSort={{ key: "ts", dir: "desc" }}
                  columns={[
                    { key: "ts", label: "When", align: "left", render: (r) => fmtTs(r.ts) },
                    { key: "phase", label: "Phase", align: "left", render: (r) => (
                      <span className="font-mono text-[11px]">{r.phase}</span>
                    ) },
                    { key: "event", label: "Event", align: "left", render: (r) => (
                      <span className="font-mono text-[11px]">{r.event}</span>
                    ) },
                    { key: "entity", label: "Entity", align: "left", render: (r) => (
                      r.entity ? <span>{r.entity_type ? `${r.entity_type}:` : ""}{r.entity}</span> : <span className="text-muted">—</span>
                    ) },
                    { key: "metric", label: "Metric", align: "left", render: (r) => r.metric || "—" },
                    { key: "check_code", label: "Check", align: "left", render: (r) => (
                      <span className="font-mono text-[11px]">{r.check_code || "—"}</span>
                    ) },
                    { key: "dry_run", label: "Mode", align: "left", render: (r) => (
                      <span className={`pill-${r.dry_run ? "neutral" : "green"} text-[10.5px]`}>{r.dry_run ? "dry-run" : "live"}</span>
                    ) },
                  ]}
                  rows={rows}
                />
              )
          )}
        </div>
      )}
    </div>
  );
};

const ValidationAudit = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState("open");
  const [severity, setSeverity] = useState("");
  const [pickedFrom, setPickedFrom] = useState("");
  const [pickedTo, setPickedTo] = useState("");
  const [acting, setActing] = useState(null);
  const [showAllBriefs, setShowAllBriefs] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.get("/admin/validation-exceptions", {
      params: {
        status, severity, limit: 1000,
        ...(pickedFrom ? { picked_from: pickedFrom } : {}),
        ...(pickedTo ? { picked_to: pickedTo } : {}),
      },
      forceFresh: true,
    })
      .then((r) => setData(r.data || null))
      .catch((e) => setError(e?.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
  }, [status, severity, pickedFrom, pickedTo]);

  const applyFix = useCallback((r) => {
    if (!window.confirm(
      "Apply this fix? It runs a single reversible UPDATE on the live database. " +
      "The change is captured by the database checkpoint if it needs to be rolled back."
    )) return;
    setActing(r.id);
    api.post(`/admin/validation-exceptions/${r.id}/apply-fix`)
      .then((res) => {
        toast.success(`Fix applied — ${res.data?.rows ?? 0} row(s) updated`);
        load();
      })
      .catch((e) => toast.error(e?.response?.data?.detail || e.message))
      .finally(() => setActing(null));
  }, [load]);

  const dismissFinding = useCallback((r) => {
    setActing(r.id);
    api.post(`/admin/validation-exceptions/${r.id}/dismiss`)
      .then(() => { toast.success("Finding dismissed"); load(); })
      .catch((e) => toast.error(e?.response?.data?.detail || e.message))
      .finally(() => setActing(null));
  }, [load]);

  const markDone = useCallback((r) => {
    setActing(r.id);
    api.post(`/admin/validation-exceptions/${r.id}/done`)
      .then(() => { toast.success("Marked as done"); load(); })
      .catch((e) => toast.error(e?.response?.data?.detail || e.message))
      .finally(() => setActing(null));
  }, [load]);

  const markAllDone = useCallback((openCount, sev) => {
    const scope = sev === "red" ? "red" : sev === "amber" ? "amber" : "";
    const label = scope ? `${scope} ` : "";
    if (!window.confirm(
      `Mark all ${openCount} open ${label}finding${openCount === 1 ? "" : "s"} as done? ` +
      "Use this once the underlying fixes have shipped. They move out of the open " +
      "queue as resolved (this does not run any SQL)."
    )) return;
    setActing("all");
    api.post("/admin/validation-exceptions/done-all", null, { params: scope ? { severity: scope } : {} })
      .then((res) => { toast.success(`Marked ${res.data?.count ?? 0} finding(s) as done`); load(); })
      .catch((e) => toast.error(e?.response?.data?.detail || e.message))
      .finally(() => setActing(null));
  }, [load]);

  useEffect(() => { load(); }, [load]);

  const summary = data?.summary || {};
  const rows = data?.rows || [];
  const available = data?.available !== false;

  // Split into the two batches the operator asked for: ones the button can
  // safely apply (auto_applicable, computed by the backend safety fence) vs the
  // ones that need a developer to change code.
  const autoRows = rows.filter((r) => r.auto_applicable);
  const devRows = rows.filter((r) => !r.auto_applicable);

  // Open findings within the CURRENT filter scope — drives the "Mark all as
  // done" button's visibility/label so it never promises more than is shown.
  const openCount = rows.filter((r) => (r.status || "open") === "open").length;

  // Build a copy-paste brief describing the desired outcome for a dev finding.
  const briefFor = (r) => {
    const ent = `${r.entity_type ? r.entity_type + ":" : ""}${r.entity || "—"}` +
      (r.subcategory && r.subcategory !== "__ALL__" ? ` · ${r.subcategory}` : "");
    const exp = (r.expected_low === null || r.expected_low === undefined) &&
      (r.expected_high === null || r.expected_high === undefined)
      ? "—"
      : `${fmtNumOrDash(r.expected_low)}–${fmtNumOrDash(r.expected_high)}`;
    const lines = [
      "Fix this Vivo BI data-validation finding so the check passes:",
      "",
      `• Check: ${r.check_code || "—"}`,
      `• Entity: ${ent}`,
    ];
    if (r.metric) lines.push(`• Metric: ${r.metric}`);
    if (r.period_date) lines.push(`• Period: ${r.period_date}`);
    lines.push(`• Observed: ${fmtNumOrDash(r.observed)}   Expected: ${exp}`);
    if (r.diagnosis_cause) lines.push(`• Diagnosis: ${r.diagnosis_cause}`);
    if (r.broken_identity) lines.push(`• Broken identity: ${r.broken_identity}`);
    lines.push("");
    lines.push(
      `Desired outcome: "${r.metric || "the metric"}" for ${ent} should fall ` +
      "within the expected range under identical filters and reconcile across " +
      "every page that reports it. Please align the underlying calculation/" +
      "definition in code (do not just patch the data) so this check no longer " +
      "fires, then confirm the figures match.");
    return lines.join("\n");
  };

  const fallbackCopy = (text, done) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done && done();
    } catch {
      toast.error("Could not copy — select the text manually.");
    }
  };

  const copyText = (text, label) => {
    const done = () => toast.success(label || "Copied to clipboard");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  };

  // One consolidated text block with every developer brief, in table order, so
  // the operator can copy them all at once (or select the text on-page) and
  // paste the whole batch back for me to queue and action in sequence.
  const allDevBriefText = () => {
    const all = devRows
      .map((r, i) => `--- Finding ${i + 1} of ${devRows.length} ---\n${briefFor(r)}`)
      .join("\n\n");
    return `${devRows.length} Vivo BI findings that need a developer fix ` +
      `(please action them in order, one issue at a time):\n\n${all}`;
  };

  const copyAllDev = () => {
    if (!devRows.length) return;
    copyText(
      allDevBriefText(),
      `Copied ${devRows.length} finding${devRows.length === 1 ? "" : "s"} to clipboard`);
  };

  const columns = [
    { key: "severity", label: "Severity", align: "left", render: (r) => (
      <span className={`${sevPill(r.severity)} text-[10.5px] uppercase`}>{r.severity || "—"}</span>
    ) },
    { key: "status", label: "Status", align: "left", render: (r) => (
      <span className={`${statusPill(r.status)} text-[10.5px]`}>{r.status || "open"}</span>
    ) },
    { key: "entity", label: "Entity", align: "left", render: (r) => (
      <span className="text-[12px]">
        <span className="text-muted">{r.entity_type ? `${r.entity_type}:` : ""}</span>
        {r.entity || "—"}
        {r.subcategory && r.subcategory !== "__ALL__" && (
          <span className="text-muted"> · {r.subcategory}</span>
        )}
      </span>
    ) },
    { key: "metric", label: "Metric", align: "left", render: (r) => r.metric || "—" },
    { key: "check_code", label: "Check", align: "left", render: (r) => (
      <span className="font-mono text-[11px]">{r.check_code || "—"}</span>
    ) },
    { key: "period_date", label: "Period", align: "left", render: (r) => r.period_date || "—" },
    { key: "observed", label: "Observed", numeric: true, render: (r) => fmtNumOrDash(r.observed) },
    { key: "expected", label: "Expected", align: "left", render: (r) => (
      r.expected_low === null && r.expected_high === null
        ? <span className="text-muted">—</span>
        : <span className="text-[12px]">{fmtNumOrDash(r.expected_low)} – {fmtNumOrDash(r.expected_high)}</span>
    ) },
    { key: "materiality_kes", label: "Impact (KES)", numeric: true, render: (r) => (
      r.materiality_kes ? fmtKESLong(r.materiality_kes) : "—"
    ) },
    { key: "last_seen_at", label: "Last seen", align: "left", render: (r) => fmtTs(r.last_seen_at) },
  ];

  const renderExpanded = (r) => (
    <div className="bg-panel/60 p-4 text-[12.5px] space-y-2" data-testid={`finding-detail-${r.id}`}>
      <div>
        <span className="font-semibold">Diagnosis: </span>
        {r.diagnosis_cause || <span className="text-muted italic">No automated diagnosis recorded.</span>}
      </div>
      {r.broken_identity && (
        <div><span className="font-semibold">Broken identity: </span><span className="font-mono">{r.broken_identity}</span></div>
      )}
      <div className="flex flex-wrap gap-4 text-[11.5px] text-muted">
        <span>First seen {fmtTs(r.created_at)}</span>
        {r.resolved_at && <span>Resolved {fmtTs(r.resolved_at)}</span>}
        <span>Tier {r.tier ?? "—"}</span>
        <span>{r.auto_applicable ? "One-click fixable" : "Needs a developer"}</span>
        {r.dry_run && <span>dry-run</span>}
      </div>
      {r.proposed_fix_sql && (
        <div>
          <div className="font-semibold mb-1">Proposed fix (SQL)</div>
          <pre className="bg-slate-900 text-slate-100 rounded-lg p-3 text-[11px] overflow-x-auto whitespace-pre-wrap">{r.proposed_fix_sql}</pre>
        </div>
      )}
      {!r.auto_applicable && (
        <div>
          <div className="font-semibold mb-1">Brief for the developer</div>
          <pre className="bg-panel border border-border rounded-lg p-3 text-[11px] overflow-x-auto whitespace-pre-wrap">{briefFor(r)}</pre>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1.5">
        {r.auto_applicable && r.status === "open" && (
          <button
            type="button"
            onClick={() => applyFix(r)}
            disabled={acting === r.id}
            data-testid={`apply-fix-${r.id}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand text-white text-[11.5px] font-semibold hover:opacity-90 disabled:opacity-50"
          >
            <Check size={14} weight="bold" />
            {acting === r.id ? "Applying…" : "Approve & apply fix"}
          </button>
        )}
        {!r.auto_applicable && (
          <button
            type="button"
            onClick={() => copyText(briefFor(r), "Copied — paste it here to action")}
            data-testid={`copy-brief-${r.id}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand text-white text-[11.5px] font-semibold hover:opacity-90"
          >
            <Copy size={14} weight="bold" />
            Copy brief for developer
          </button>
        )}
        {r.status === "open" && (
          <button
            type="button"
            onClick={() => markDone(r)}
            disabled={acting === r.id}
            data-testid={`done-${r.id}`}
            title="Mark this finding as resolved once the fix has been actioned"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-600 text-emerald-700 text-[11.5px] font-semibold hover:bg-emerald-50 disabled:opacity-50"
          >
            <Check size={14} weight="bold" />
            {acting === r.id ? "Saving…" : "Done"}
          </button>
        )}
        {r.status === "open" && (
          <button
            type="button"
            onClick={() => dismissFinding(r)}
            disabled={acting === r.id}
            data-testid={`dismiss-${r.id}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-[11.5px] font-semibold hover:bg-panel disabled:opacity-50"
          >
            <X size={14} weight="bold" />
            Dismiss
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6" data-testid="validation-audit-page">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-brand"><ShieldWarning size={22} weight="duotone" /></div>
        <div>
          <p className="text-muted text-[13px] mt-0.5 max-w-3xl">
            Findings raised by the background data-validation agent — every metric
            inconsistency, baseline anomaly and cross-page mismatch it has caught,
            with a proposed diagnosis. Worst findings (reds, highest KES impact)
            are listed first.
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="validation-summary">
        <SummaryCard label="Total findings" value={(summary.total ?? 0).toLocaleString()} />
        <SummaryCard label="Open" value={(summary.open ?? 0).toLocaleString()} tone={summary.open ? "text-amber-700" : ""} />
        <SummaryCard label="Red (critical)" value={(summary.red ?? 0).toLocaleString()} tone={summary.red ? "text-red-600" : ""} />
        <SummaryCard label="Amber (watch)" value={(summary.amber ?? 0).toLocaleString()} tone={summary.amber ? "text-amber-600" : ""} />
      </div>

      {/* Issues picked (by detection date, Africa/Nairobi) */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3" data-testid="validation-picked">
        <SummaryCard label="Picked today" value={(summary.picked_today ?? 0).toLocaleString()} hint="New findings first detected today" />
        <SummaryCard label="Picked month-to-date" value={(summary.picked_mtd ?? 0).toLocaleString()} hint="Cumulative findings first detected since the 1st" />
        <SummaryCard
          label={pickedFrom || pickedTo ? "Picked in selected range" : "Picked in range"}
          value={summary.picked_range != null ? Number(summary.picked_range).toLocaleString() : "—"}
          hint={pickedFrom || pickedTo ? `${pickedFrom || "…"} → ${pickedTo || "…"}` : "Set a date range below"}
        />
      </div>

      {/* Filters */}
      <div className="card-white p-3 flex flex-wrap items-center gap-3" data-testid="validation-filter">
        <label className="text-[12px] font-semibold text-muted">Status</label>
        <select
          className="px-3 py-2 rounded-lg border border-border text-[13px]"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          data-testid="filter-status"
        >
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label className="text-[12px] font-semibold text-muted ml-2">Severity</label>
        <select
          className="px-3 py-2 rounded-lg border border-border text-[13px]"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          data-testid="filter-severity"
        >
          {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label className="text-[12px] font-semibold text-muted ml-2">Picked between</label>
        <input
          type="date"
          className="px-3 py-2 rounded-lg border border-border text-[13px]"
          value={pickedFrom}
          max={pickedTo || undefined}
          onChange={(e) => setPickedFrom(e.target.value)}
          data-testid="filter-picked-from"
          aria-label="Picked from date"
        />
        <span className="text-[12px] text-muted">to</span>
        <input
          type="date"
          className="px-3 py-2 rounded-lg border border-border text-[13px]"
          value={pickedTo}
          min={pickedFrom || undefined}
          onChange={(e) => setPickedTo(e.target.value)}
          data-testid="filter-picked-to"
          aria-label="Picked to date"
        />
        {(pickedFrom || pickedTo) && (
          <button
            type="button"
            onClick={() => { setPickedFrom(""); setPickedTo(""); }}
            className="px-2.5 py-1.5 rounded-lg border border-border text-[11.5px] font-semibold hover:bg-panel text-muted"
            data-testid="filter-picked-clear"
            title="Clear the date range"
          >
            Clear
          </button>
        )}
        <div className="flex-1" />
        {available && openCount > 0 && (
          <button
            type="button"
            onClick={() => markAllDone(openCount, severity)}
            disabled={loading || acting === "all"}
            data-testid="mark-all-done"
            title="Mark every open finding as resolved once the fixes have shipped"
            className="px-3 py-1.5 rounded-lg border border-emerald-600 text-emerald-700 text-[11.5px] font-semibold hover:bg-emerald-50 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Check size={13} weight="bold" />
            {acting === "all"
              ? "Marking…"
              : `Mark all ${openCount.toLocaleString()}${severity ? ` ${severity}` : ""} as done`}
          </button>
        )}
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg border border-border text-[11.5px] font-semibold hover:bg-panel disabled:opacity-50 inline-flex items-center gap-1.5"
          data-testid="validation-refresh"
        >
          <ArrowClockwise size={12} weight="bold" />
          Refresh
        </button>
      </div>

      {loading && <Loading />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && !available && (
        <div className="card-white p-5" data-testid="validation-unavailable">
          <Empty label="The validation agent has not run on this database yet — there are no audit findings to show. Findings appear here automatically once the agent runs (it runs inside the production sync loop)." />
        </div>
      )}

      {!loading && !error && available && rows.length === 0 && (
        <div className="card-white p-5" data-testid="validation-empty">
          <Empty label="No findings match the current filters." />
        </div>
      )}

      {/* Batch 1 — one-click auto-fixes */}
      {!loading && !error && available && rows.length > 0 && (
        <div className="card-white p-5" data-testid="auto-batch">
          <div className="flex items-center gap-2 mb-1">
            <Lightning size={18} weight="duotone" className="text-brand" />
            <SectionTitle
              title={`${autoRows.length.toLocaleString()} one-click fix${autoRows.length === 1 ? "" : "es"}`}
              subtitle="Each has a safe, reversible fix. Open a row and click Approve & apply — no developer or publish needed."
            />
          </div>
          {autoRows.length === 0
            ? <Empty label="No findings can be auto-fixed right now." />
            : (
              <SortableTable
                testId="auto-batch-table"
                exportName="validation-auto-fixable.csv"
                initialSort={{ key: "last_seen_at", dir: "desc" }}
                rowKey={(r) => r.id}
                columns={columns}
                rows={autoRows}
                renderExpanded={renderExpanded}
              />
            )}
        </div>
      )}

      {/* Batch 2 — needs a developer */}
      {!loading && !error && available && rows.length > 0 && (
        <div className="card-white p-5" data-testid="dev-batch">
          <div className="flex items-start justify-between gap-3 mb-1">
            <div className="flex items-center gap-2">
              <Wrench size={18} weight="duotone" className="text-amber-600" />
              <SectionTitle
                title={`${devRows.length.toLocaleString()} finding${devRows.length === 1 ? "" : "s"} that need a developer`}
                subtitle="No safe automated fix — these need a code change. Open a row to copy a ready-made brief, or copy them all and paste here for me to action."
              />
            </div>
            {devRows.length > 0 && (
              <div className="flex items-center gap-2 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => setShowAllBriefs((v) => !v)}
                  data-testid="toggle-all-briefs"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-[11.5px] font-semibold hover:bg-panel"
                >
                  {showAllBriefs ? <CaretDown size={13} weight="bold" /> : <CaretRight size={13} weight="bold" />}
                  View all briefs
                </button>
                <button
                  type="button"
                  onClick={copyAllDev}
                  data-testid="copy-all-dev"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand text-white text-[11.5px] font-semibold hover:opacity-90"
                >
                  <Copy size={14} weight="bold" />
                  Copy all {devRows.length} briefs
                </button>
              </div>
            )}
          </div>

          {/* Consolidated, on-page view of every brief — copy the whole batch at
              once (button above) or select the text here, then paste it back. */}
          {devRows.length > 0 && showAllBriefs && (
            <div className="mt-3 mb-1" data-testid="all-briefs-panel">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <p className="text-[11.5px] text-muted">
                  All {devRows.length} developer brief{devRows.length === 1 ? "" : "s"} on one page — copy the
                  whole batch and paste it back, and I'll queue and action them one issue at a time.
                </p>
                <button
                  type="button"
                  onClick={copyAllDev}
                  data-testid="copy-all-dev-panel"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border text-[11px] font-semibold hover:bg-panel whitespace-nowrap"
                >
                  <Copy size={13} weight="bold" />
                  Copy
                </button>
              </div>
              <textarea
                readOnly
                value={allDevBriefText()}
                onFocus={(e) => e.target.select()}
                rows={14}
                data-testid="all-briefs-textarea"
                className="w-full font-mono text-[11px] leading-relaxed bg-panel border border-border rounded-lg p-3 resize-y"
              />
            </div>
          )}
          {devRows.length === 0
            ? <Empty label="Nothing here needs a developer — every finding can be auto-fixed." />
            : (
              <SortableTable
                testId="dev-batch-table"
                exportName="validation-needs-developer.csv"
                initialSort={{ key: "last_seen_at", dir: "desc" }}
                rowKey={(r) => r.id}
                columns={columns}
                rows={devRows}
                renderExpanded={renderExpanded}
              />
            )}
        </div>
      )}

      <AgentActivitySection />
    </div>
  );
};

export default ValidationAudit;
