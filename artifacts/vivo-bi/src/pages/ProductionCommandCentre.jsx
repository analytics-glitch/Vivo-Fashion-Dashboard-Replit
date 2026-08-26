import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowsClockwise, ArrowSquareOut, ChartLineUp, ClockCounterClockwise,
  Factory, Funnel, ListMagnifyingGlass, Package, ShieldWarning,
  WarningCircle,
} from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { useFilters } from "@/lib/filters";
import { ErrorBox, Loading, SectionTitle } from "@/components/common";

const n = (value) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
const pct = (value) => value == null ? "Unavailable" : `${Number(value).toFixed(1)}%`;
const title = (value) => String(value || "—").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

function asEAT(value) {
  if (!value) return "Not recorded";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Nairobi", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(value));
  } catch { return String(value); }
}

function stateTone(state) {
  if (state === "fresh" || state === "ready" || state === "complete") return "bg-emerald-50 text-emerald-800 border-emerald-200";
  if (state === "stale" || state === "partial" || state === "incomplete" || state === "unavailable" || state === "missing" || state === "unknown") return "bg-amber-50 text-amber-800 border-amber-200";
  if (state === "error") return "bg-rose-50 text-rose-800 border-rose-200";
  return "bg-slate-50 text-slate-700 border-slate-200";
}

function MetricCard({ label, value, source, basis, unavailable, onClick, testId, nonInteractiveReason }) {
  const interactive = typeof onClick === "function";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!interactive}
      aria-disabled={!interactive}
      title={!interactive ? (nonInteractiveReason || "This metric is not interactive.") : undefined}
      data-testid={testId}
      className={`text-left rounded-xl border p-3.5 min-w-0 ${
        interactive ? "bg-white border-line hover:border-[#1a5c38]/50 hover:shadow-sm transition" : "bg-white border-line cursor-default"
      }`}
    >
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-[25px] leading-none font-extrabold tabular-nums ${unavailable ? "text-amber-700 text-[18px]" : "text-[#0f3d24]"}`}>
        {unavailable ? "Unavailable" : value}
      </div>
      <div className="mt-2 text-[10.5px] text-muted leading-snug">{unavailable || basis}</div>
      <div className="mt-1 text-[10px] font-semibold text-[#1a5c38]">{source}</div>
    </button>
  );
}

function Section({ title: sectionTitle, subtitle, state, children, testId, action }) {
  const unavailable = state?.state === "unavailable";
  const errored = state?.state === "error";
  return (
    <section className="rounded-xl border border-line bg-white overflow-hidden" data-testid={testId}>
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-line bg-panel/30">
        <div className="min-w-0">
          <h2 className="text-[14px] font-bold text-[#0f3d24]">{sectionTitle}</h2>
          {subtitle && <p className="mt-0.5 text-[11.5px] text-muted">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {state?.state && <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-bold capitalize ${stateTone(state.state)}`}>{state.state}</span>}
          {action}
        </div>
      </div>
      {errored ? (
        <div className="p-4"><ErrorBox message={state.message || "This source could not be loaded."} /></div>
      ) : unavailable ? (
        <div className="p-4 text-[12.5px] text-amber-800 bg-amber-50/50">{state.message}</div>
      ) : children}
    </section>
  );
}

function Freshness({ sources }) {
  const labels = {
    odoo_tracker: "Odoo tracker", approved_plan: "Approved plans",
    execution_capture: "Execution capture", quality_and_downtime: "Quality & downtime",
    attendance_and_sam: "Attendance & SAM",
  };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2" data-testid="command-source-health">
      {Object.entries(labels).map(([key, label]) => {
        const item = sources?.[key] || { state: "missing" };
        return (
          <div key={key} className={`rounded-lg border px-3 py-2 ${stateTone(item.state)}`}>
            <div className="flex justify-between gap-2">
              <span className="text-[11px] font-bold">{label}</span>
              <span className="text-[10px] font-bold capitalize">{item.state}</span>
            </div>
            <div className="mt-1 text-[10.5px] opacity-90">{asEAT(item.as_of)} EAT</div>
            <div className="mt-0.5 text-[10px] opacity-80">{item.detail || item.refresh_status || "No refresh status"}</div>
          </div>
        );
      })}
    </div>
  );
}

function ContextFilters({ data, query, onChange, onClear }) {
  const options = data?.filter_options || {};
  const select = (key, label, choices) => (
    <label className="min-w-[130px] flex-1">
      <span className="sr-only">{label}</span>
      <select value={query[key] || ""} onChange={(e) => onChange(key, e.target.value)}
        className="input-pill w-full text-[11.5px] py-1.5" aria-label={label}>
        <option value="">{label}: all</option>
        {(choices || []).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
  );
  return (
    <div className="rounded-xl border border-line bg-panel/40 p-3" data-testid="command-filters">
      <div className="flex flex-wrap items-center gap-2">
        <Funnel size={15} className="text-brand shrink-0" />
        {select("stage", "Stage", options.stages)}
        {select("factory_id", "Factory", options.factories)}
        {select("line_id", "Line", options.lines)}
        {select("shift_id", "Shift", options.shifts)}
        {data?.scope?.owner_filter_allowed && select("owner_user_id", "Owner", options.owners)}
        <label className="min-w-[130px] flex-1">
          <span className="sr-only">Plan status</span>
          <select value={query.plan_status || ""} onChange={(e) => onChange("plan_status", e.target.value)}
            className="input-pill w-full text-[11.5px] py-1.5" aria-label="Plan status">
            <option value="">Plan: approved & frozen</option><option value="approved">Approved</option><option value="frozen">Frozen</option>
          </select>
        </label>
        <label className="min-w-[130px] flex-1">
          <span className="sr-only">Delivery risk</span>
          <select value={query.delivery_risk || ""} onChange={(e) => onChange("delivery_risk", e.target.value)}
            className="input-pill w-full text-[11.5px] py-1.5" aria-label="Delivery risk">
            <option value="">Risk: all</option><option value="urgent">Urgent</option>
            <option value="watch">Watch</option><option value="planned">Planned</option>
            <option value="data_needed">Data needed</option>
          </select>
        </label>
        <div className="relative min-w-[180px] flex-[2]">
          <ListMagnifyingGlass size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query.search || ""} onChange={(e) => onChange("search", e.target.value)}
            className="input-pill w-full text-[11.5px] py-1.5 pl-7" placeholder="Search style, order, owner…" aria-label="Search production scope" />
        </div>
        <button type="button" onClick={onClear} className="text-[11.5px] font-semibold text-brand hover:underline px-1">Clear</button>
      </div>
      <div className="mt-2 text-[10.5px] text-muted">
        Live WIP is a current Odoo snapshot. Plan-versus-actual includes only full approved commitments contained in the selected period; execution uses that same period. Sales country, channel, POS, currency and comparison filters are not applicable to production data.
      </div>
    </div>
  );
}

export default function ProductionCommandCentre({
  onOpenWorkspace, onOpenReport, onOpenCapture, onOpenTracker, onOpenInsights,
}) {
  const { applied } = useFilters();
  const location = useLocation();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const query = useMemo(() => {
    const search = new URLSearchParams(location.search);
    return Object.fromEntries(["stage", "factory_id", "line_id", "shift_id", "owner_user_id", "plan_status", "delivery_risk", "search"]
      .map((key) => [key, search.get(`prod_${key}`) || ""]));
  }, [location.search]);

  const load = useCallback(async (force = false) => {
    force ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const params = { date_from: applied.dateFrom, date_to: applied.dateTo, ...query };
      const response = await api.get("/production-workspace/command-centre", { params, forceFresh: force });
      setData(response.data);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || "Could not load the Production Command Centre.");
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [applied.dateFrom, applied.dateTo, query]);

  useEffect(() => { load(false); }, [load]);
  const changeQuery = (key, value) => {
    const search = new URLSearchParams(location.search);
    const name = `prod_${key}`;
    if (value) search.set(name, value); else search.delete(name);
    navigate({ pathname: location.pathname, search: search.toString() ? `?${search}` : "" }, { replace: true });
  };
  const clearQuery = () => {
    const search = new URLSearchParams(location.search);
    Object.keys(query).forEach((key) => search.delete(`prod_${key}`));
    navigate({ pathname: location.pathname, search: search.toString() ? `?${search}` : "" }, { replace: true });
  };
  const openWorkspace = (plan) => onOpenWorkspace?.(plan, {
    ...query,
    date_from: applied.dateFrom,
    date_to: applied.dateTo,
  });
  const openTab = (callback, extra = {}) => callback?.({
    ...query,
    ...extra,
    date_from: applied.dateFrom,
    date_to: applied.dateTo,
  });
  const tabAction = (callback, extra = {}) => (
    callback ? () => openTab(callback, extra) : null
  );
  const drillLink = (pathname, extra = {}) => {
    const search = new URLSearchParams(location.search);
    search.set("date_from", applied.dateFrom);
    search.set("date_to", applied.dateTo);
    Object.entries(extra).forEach(([key, value]) => {
      const name = key.startsWith("prod_") ? key : `prod_${key}`;
      if (value != null && value !== "") search.set(name, String(value));
    });
    return `${pathname}?${search.toString()}`;
  };
  const metrics = data?.metrics || {};
  const planState = data?.sections?.plan_actual;
  const deliveryState = data?.sections?.delivery;
  const wipState = data?.sections?.wip;
  const productivityState = data?.sections?.productivity;

  return (
    <div className="space-y-4" data-testid="production-command-centre">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <SectionTitle title="Production Command Centre"
            subtitle="An honest East Africa stand-up view — verified tracker WIP, approved plans and validated execution evidence."
            testId="command-centre-title" />
          <div className="mt-1 text-[11px] text-muted">
            As of {asEAT(data?.as_of)} EAT · {data?.scope?.snapshot_semantics || "Loading operational scope…"}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold">
            <Link to={drillLink("/quality")} className="text-brand hover:underline">Quality</Link>
            <span className="text-line">·</span>
            <button type="button" onClick={tabAction(onOpenCapture)} disabled={!onOpenCapture} title={!onOpenCapture ? "Execution Capture is not available for your role." : undefined} className="text-brand hover:underline disabled:opacity-50">Capture</button>
            <span className="text-line">·</span>
            <button type="button" onClick={tabAction(onOpenTracker)} disabled={!onOpenTracker} title={!onOpenTracker ? "Production Tracker is not available for your role." : undefined} className="text-brand hover:underline disabled:opacity-50">Tracker</button>
            <span className="text-line">·</span>
            <button type="button" onClick={tabAction(onOpenReport)} disabled={!onOpenReport} title={!onOpenReport ? "Production Report is not available for your role." : undefined} className="text-brand hover:underline disabled:opacity-50">Report</button>
            <span className="text-line">·</span>
            <Link to={drillLink("/central-tracker")} className="text-brand hover:underline">Order Tracker</Link>
            <span className="text-line">·</span>
            <button type="button" onClick={onOpenWorkspace ? () => openWorkspace(null) : null} disabled={!onOpenWorkspace} title={!onOpenWorkspace ? "Planning is not available for your role." : undefined} className="text-brand hover:underline disabled:opacity-50">Planning</button>
            <span className="text-line">·</span>
            <button type="button" onClick={tabAction(onOpenInsights)} disabled={!onOpenInsights} title={!onOpenInsights ? "Recovery history is not available for your role." : undefined} className="text-brand hover:underline disabled:opacity-50">Recovery history</button>
          </div>
        </div>
        <button type="button" onClick={() => load(true)} disabled={loading || refreshing}
          className="btn-ghost inline-flex items-center gap-1.5 !px-3 !py-2 text-[12px] disabled:opacity-50" data-testid="command-refresh">
          <ArrowsClockwise size={14} className={refreshing ? "animate-spin" : ""} />{refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {loading && !data ? <Loading label="Loading production command centre…" /> : error ? <ErrorBox message={error} /> : (
        <>
          <Freshness sources={data?.source_freshness} />
          {data?.completeness?.state !== "complete" && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-900" data-testid="command-completeness-warning">
              <div className="font-bold flex items-center gap-1.5"><ShieldWarning size={15} />Decision data is incomplete</div>
              <div className="mt-0.5">{data.completeness.message}</div>
              {(data.completeness.issues || []).length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {data.completeness.issues.map((issue) => <li key={`${issue.key}-${issue.state}`}>{title(issue.key)}: {issue.message}</li>)}
                </ul>
              )}
            </div>
          )}
          <ContextFilters data={data} query={query} onChange={changeQuery} onClear={clearQuery} />

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <MetricCard label="Current WIP" value={n(metrics.wip_units)} source="Verified Odoo tracker" basis="Live stage balances; not mapped to Workspace factory/line scope."
              unavailable={metrics.wip_units == null ? wipState?.message || "Tracker WIP unavailable" : null}
              onClick={wipState?.state === "ready" ? tabAction(onOpenTracker) : null}
              nonInteractiveReason={wipState?.message} />
            <MetricCard label="Plan vs actual" value={metrics.actual_qty == null ? "—" : `${n(metrics.actual_qty)} / ${n(metrics.plan_qty)}`} source="Approved plans + validated execution"
              basis="Only full approved commitments contained in the selected period; actual = good + reject + rework." unavailable={metrics.actual_qty == null ? "Validated execution is incomplete" : null}
              onClick={tabAction(onOpenReport)} nonInteractiveReason="Production Report is not available for your role." />
            <MetricCard label="Capacity load" value={pct(metrics.load_pct)} source="Approved capacity inputs" basis={metrics.load_pct == null ? "Requires saved required and available minutes." : `${n(metrics.required_minutes)} required of ${n(metrics.available_minutes)} available minutes`}
              unavailable={metrics.load_pct == null ? "Capacity denominator incomplete" : null}
              onClick={onOpenWorkspace ? () => openWorkspace(null) : null} nonInteractiveReason="Planning is not available for your role." />
            <MetricCard label="Delivery risk" value={n(metrics.delivery_risk_count)} source="Approved commitments + recovery rules" basis="Explainable risk queue; click rows for evidence."
              onClick={() => document.getElementById("command-delivery")?.scrollIntoView({ behavior: "smooth", block: "start" })} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <Section title="Where work sits" subtitle="Live current Odoo tracker units by stage." state={wipState} testId="command-stage-wip">
              <div className="p-4 space-y-2.5">
                {(data?.stage_wip || []).length === 0 ? <div className="text-[12px] text-muted italic">No current tracker WIP in this scope.</div> :
                  data.stage_wip.map((row) => {
                    const total = metrics.wip_units || 1;
                    const width = Math.max(2, Math.min(100, Number(row.units || 0) / total * 100));
                    return <button key={row.stage_key} type="button"
                      onClick={tabAction(onOpenTracker, { stage: row.stage_key })}
                      disabled={!onOpenTracker}
                      className="block w-full text-left rounded-md px-1 py-0.5 hover:bg-panel/70 transition"
                      title={`Open ${row.stage_name} in Production Tracker`}>
                      <div className="flex items-center justify-between gap-2 text-[12px]"><span className="font-semibold text-[#0f3d24]">{row.stage_name}</span><span className="tabular-nums text-muted">{n(row.units)} u · {n(row.orders)} orders</span></div>
                      <div className="mt-1 h-2 bg-panel rounded-full overflow-hidden"><div className="h-full bg-[#1a5c38] rounded-full" style={{ width: `${width}%` }} /></div>
                    </button>;
                  })}
              </div>
            </Section>
            <Section title="Quality, rework & productivity" subtitle="Only shown when approved denominators and validated capture are present." state={productivityState} testId="command-quality">
              <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                <MetricCard label="Good" value={n(metrics.good_qty)} source="Execution capture" basis="Accepted output" unavailable={metrics.good_qty == null ? "Execution incomplete" : null} onClick={tabAction(onOpenCapture)} nonInteractiveReason="Execution Capture is not available for your role." />
                <MetricCard label="Reject" value={n(metrics.reject_qty)} source="Execution capture" basis="Rejected output" unavailable={metrics.reject_qty == null ? "Execution incomplete" : null} onClick={tabAction(onOpenCapture)} nonInteractiveReason="Execution Capture is not available for your role." />
                <MetricCard label="Rework" value={n(metrics.rework_qty)} source="Execution + QC" basis="Rework capture" unavailable={metrics.rework_qty == null ? "Execution incomplete" : null} onClick={() => navigate(drillLink("/quality"))} />
                <MetricCard label="Efficiency" value={pct(metrics.efficiency_pct)} source="Approved SAM + attendance" basis="Earned minutes ÷ complete attendance" unavailable={metrics.efficiency_pct == null ? "SAM, attendance or output incomplete" : null} onClick={tabAction(onOpenInsights)} nonInteractiveReason="Recovery history is not available for your role." />
              </div>
            </Section>
          </div>

          <Section title="Factory / line load" subtitle="Approved plan, capacity and execution rows. A blank is a source gap, not a zero." state={planState} testId="command-lines">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-[12px]">
                <thead className="text-left text-[10.5px] uppercase tracking-wide text-muted bg-panel/30"><tr>
                  <th className="px-4 py-2">Factory / line</th><th className="px-3 py-2 text-right">Plan</th><th className="px-3 py-2 text-right">Actual</th><th className="px-3 py-2 text-right">Load</th><th className="px-3 py-2 text-right">Quality</th><th className="px-3 py-2 text-right">Efficiency</th>
                </tr></thead>
                <tbody>{(data?.line_performance || []).map((row) => <tr key={`${row.factory_id}-${row.line_id}-${row.shift_id}`} className={onOpenWorkspace ? "border-t border-line hover:bg-panel/20 cursor-pointer" : "border-t border-line"} onClick={onOpenWorkspace ? () => openWorkspace(row) : undefined} title={!onOpenWorkspace ? "Planning is not available for your role." : "Open this line in Planning"}>
                  <td className="px-4 py-2.5"><div className="font-semibold text-[#0f3d24]">{row.factory_name}</div><div className="text-muted">{row.line_name} · {row.shift_name} · {row.owner_count} owner{row.owner_count === 1 ? "" : "s"}</div></td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.target_qty == null ? "Unavailable" : n(row.target_qty)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.actual_qty == null ? "Incomplete" : n(row.actual_qty)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{pct(row.load_pct)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{row.quality_total == null ? "Incomplete" : n(row.quality_total)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{pct(row.efficiency_pct)}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </Section>

          <div id="command-delivery">
            <Section title="Delivery-risk commitments" subtitle="Evidence-backed recovery queue; priority is not a worker score." state={deliveryState} testId="command-delivery">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] text-[12px]">
                  <thead className="text-left text-[10.5px] uppercase tracking-wide text-muted bg-panel/30"><tr>
                    <th className="px-4 py-2">Commitment & owner</th><th className="px-3 py-2">Due / stage</th><th className="px-3 py-2 text-right">Remaining</th><th className="px-3 py-2 text-right">Load</th><th className="px-3 py-2">Evidence</th><th className="px-4 py-2 text-right">Open</th>
                  </tr></thead>
                  <tbody>{(data?.delivery_risk || []).map((row) => <tr key={row.plan_version_id} className="border-t border-line hover:bg-panel/20">
                    <td className="px-4 py-2.5"><div className="font-semibold text-[#0f3d24]">{row.style_number || row.external_ref || row.production_order_ref || "Plan"}</div><div className="text-muted">{row.factory_name} · {row.line_name || "Unassigned line"}{row.owner_user_id ? ` · owner ${row.owner_user_id}` : ""}</div></td>
                    <td className="px-3 py-2.5"><div className={`inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${stateTone(row.priority_band === "urgent" ? "error" : row.priority_band === "watch" ? "partial" : "ready")}`}>{title(row.priority_band)}</div><div className="mt-1 text-muted">{row.planned_end} · {row.current_stage ? title(row.current_stage) : "Stage unavailable"}</div></td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{row.remaining_qty == null ? "Needs capture" : n(row.remaining_qty)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{pct(row.load_pct)}</td>
                    <td className="px-3 py-2.5 max-w-[350px] text-muted">{(row.reasons || []).slice(0, 2).join(" ")}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {row.production_order_ref && <button type="button" onClick={tabAction(onOpenTracker, { search: row.production_order_ref })} disabled={!onOpenTracker} title={!onOpenTracker ? "Production Tracker is not available for your role." : undefined} className="text-brand font-semibold hover:underline mr-3 disabled:opacity-50">Order</button>}
                      <button type="button" onClick={onOpenWorkspace ? () => openWorkspace(row) : null} disabled={!onOpenWorkspace} title={!onOpenWorkspace ? "Planning is not available for your role." : undefined} className="inline-flex items-center gap-1 text-brand font-semibold hover:underline disabled:opacity-50">Plan <ArrowSquareOut size={12} /></button>
                    </td>
                  </tr>)}</tbody>
                </table>
                {(data?.delivery_risk || []).length === 0 && <div className="p-4 text-[12px] text-muted italic">No delivery-risk commitments match this scope.</div>}
              </div>
            </Section>
          </div>

          <Section title="Data gaps & calculation bases" subtitle="Use this disclosure before treating a blank as an operational result." testId="command-definitions">
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-[11.5px]">
              {Object.entries(data?.definitions || {}).map(([key, value]) => <div key={key} className="rounded-lg border border-line bg-panel/20 p-3"><div className="font-bold text-[#0f3d24] capitalize">{key.replace(/_/g, " ")}</div><div className="mt-1 text-muted leading-relaxed">{value}</div></div>)}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}