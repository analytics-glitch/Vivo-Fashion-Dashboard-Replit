import React, { useCallback, useEffect, useState } from "react";
import { api, fmtKESLong } from "@/lib/api";
import { SectionTitle, Loading, ErrorBox, Empty } from "@/components/common";
import { ArrowClockwise, ShieldWarning, CaretDown, CaretRight } from "@phosphor-icons/react";
import SortableTable from "@/components/SortableTable";

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

const SummaryCard = ({ label, value, tone }) => (
  <div className="card-white p-4 flex flex-col gap-1" data-testid={`summary-${label}`}>
    <div className="eyebrow text-[10.5px]">{label}</div>
    <div className={`font-extrabold text-[22px] leading-none ${tone || ""}`}>{value}</div>
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
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.get("/admin/validation-exceptions", {
      params: { status, severity, limit: 1000 },
      forceFresh: true,
    })
      .then((r) => setData(r.data || null))
      .catch((e) => setError(e?.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
  }, [status, severity]);

  useEffect(() => { load(); }, [load]);

  const summary = data?.summary || {};
  const rows = data?.rows || [];
  const available = data?.available !== false;

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
        <div className="flex-1" />
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

      {!loading && !error && available && (
        <div className="card-white p-5" data-testid="validation-table-wrap">
          <SectionTitle
            title={`${rows.length.toLocaleString()} finding${rows.length === 1 ? "" : "s"} shown`}
            subtitle="Click a row to see the diagnosis and any proposed fix"
          />
          {rows.length === 0
            ? <Empty label="No findings match the current filters." />
            : (
              <SortableTable
                testId="validation-table"
                exportName="validation-findings.csv"
                initialSort={{ key: "last_seen_at", dir: "desc" }}
                onRowClick={(r) => setExpanded(expanded === r.id ? null : r.id)}
                columns={[
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
                ]}
                rows={rows}
                renderExpanded={(r) => expanded === r.id ? (
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
                      <span>{r.auto_fixable ? "Auto-fixable" : "Manual review"}</span>
                      {r.dry_run && <span>dry-run</span>}
                    </div>
                    {r.proposed_fix_sql && (
                      <div>
                        <div className="font-semibold mb-1">Proposed fix (SQL)</div>
                        <pre className="bg-slate-900 text-slate-100 rounded-lg p-3 text-[11px] overflow-x-auto whitespace-pre-wrap">{r.proposed_fix_sql}</pre>
                      </div>
                    )}
                  </div>
                ) : null}
              />
            )}
        </div>
      )}

      <AgentActivitySection />
    </div>
  );
};

export default ValidationAudit;
