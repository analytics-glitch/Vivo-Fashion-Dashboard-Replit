import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtKES, fmtNum, fmtPct } from "@/lib/api";
import SORHeader from "@/components/SORHeader";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import VariantDrillDown from "@/components/VariantDrillDown";
import RecommendationActionPill from "@/components/RecommendationActionPill";
import ProductThumbnail from "@/components/ProductThumbnail";
import { useThumbnails } from "@/lib/useThumbnails";
import AgedStockReport from "@/components/AgedStockReport";
import ReplenishByColor from "@/components/ReplenishByColor";
import { useRecommendationState } from "@/lib/useRecommendationState";
import {
  Package, ShoppingCart, TrendUp, TrendDown, ArrowRight, Tag, Target,
  Warning, ChartLineUp, Eye, Stack,
} from "@phosphor-icons/react";

// Buying is planned company-wide (one national buy), so the engine is NOT
// scoped by the country/channel filter bar — the decision pools demand and
// stock across every market. We still re-fetch on dataVersion so the manual
// refresh works.
const BUY_PARAMS = { lead_weeks: 6, cover_weeks: 8, confidence_floor: 30, aged_days: 60, limit: 200 };

const confPill = (c) =>
  c === "High" ? "pill-green" : c === "Low" ? "pill-amber" : "pill-neutral";

const sorPill = (v) =>
  (v || 0) >= 70 ? "pill-green" : (v || 0) >= 50 ? "pill-neutral" : "text-muted";

const trendMeta = (t) =>
  t === "accelerating" ? { label: "Accelerating", Icon: TrendUp, cls: "text-emerald-600" } :
  t === "decelerating" ? { label: "Decelerating", Icon: TrendDown, cls: "text-rose-600" } :
  { label: "Stable", Icon: ArrowRight, cls: "text-muted" };

const BucketBadge = ({ bucket }) =>
  bucket === "newness" ? (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-100 text-indigo-700" title="Newness — launched in the last 90 days">NEW</span>
  ) : (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600" title="Core — established style with sustained demand">CORE</span>
  );

const ReOrder = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { dataVersion } = applied;

  const [summary, setSummary] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drillStyle, setDrillStyle] = useState(null);
  const [showResolved, setShowResolved] = useState(false);
  const [showWatch, setShowWatch] = useState(false);
  const [markdownSet, setMarkdownSet] = useState(() => new Set());
  const [accuracy, setAccuracy] = useState(null);
  const { stateByKey, setState } = useRecommendationState("reorder");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/analytics/buy-candidates", { params: BUY_PARAMS })
      .then(({ data }) => {
        if (cancelled) return;
        setSummary(data?.summary || null);
        setCandidates(Array.isArray(data?.candidates) ? data.candidates : []);
        touchLastUpdated();
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [dataVersion]);

  // Markdown candidates (for the "Markdown?" flag) + replenishment forecast
  // accuracy (summary KPI). Both are non-fatal — failures leave the page
  // fully usable, just without the enrichment.
  useEffect(() => {
    let cancelled = false;
    api
      .get("/analytics/markdown-candidates")
      .then(({ data }) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : (data?.candidates || []);
        setMarkdownSet(new Set(list.map((c) => c.style_name).filter(Boolean)));
      })
      .catch(() => !cancelled && setMarkdownSet(new Set()));
    return () => { cancelled = true; };
  }, [dataVersion]);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/replenishment/forecast-accuracy")
      .then(({ data }) => {
        if (cancelled) return;
        const mape = data?.mape;
        if (mape === null || mape === undefined || isNaN(Number(mape))) {
          setAccuracy(null);
          return;
        }
        const acc = Math.max(0, Math.min(100, 100 - Number(mape)));
        setAccuracy({ pct: acc, evaluated: Number(data?.evaluated || 0) });
      })
      .catch(() => !cancelled && setAccuracy(null));
    return () => { cancelled = true; };
  }, [dataVersion]);

  const eligible = useMemo(() => candidates.filter((c) => c.eligible), [candidates]);
  const watch = useMemo(() => candidates.filter((c) => !c.eligible), [candidates]);

  // Hide rows the user has already actioned (po_raised / dismissed / done)
  // unless they flip "Show resolved" — close-the-loop UX.
  const visibleList = useMemo(() => {
    if (showResolved) return eligible;
    return eligible.filter((r) => {
      const s = stateByKey.get(r.style_name)?.status;
      return !s || s === "pending";
    });
  }, [eligible, stateByKey, showResolved]);

  const resolvedCount = useMemo(
    () => eligible.filter((r) => {
      const s = stateByKey.get(r.style_name)?.status;
      return s && s !== "pending";
    }).length,
    [eligible, stateByKey]
  );

  const { urlFor } = useThumbnails(useMemo(() => visibleList.map((r) => r.style_name), [visibleList]));

  const accTarget = 60;

  return (
    <div className="space-y-6" data-testid="reorder-page">
      <div>
        <p className="text-muted text-[13px] mt-1">
          Buy recommendations ranked by <span className="font-semibold text-foreground">opportunity value</span>{" "}
          (expected margin × demand over the cover horizon) — not by Sell-Out Rate. Each
          line nets store, warehouse and in-production units against forecast demand to
          a service-level target, so the biggest unmet money decisions surface first.
        </p>
      </div>

      {loading && <Loading />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <KPICard testId="ro-kpi-buy-value" accent label="Recommended Buy"
              value={fmtKES(summary?.recommended_buy_value_kes || 0)}
              sub={`${fmtNum(summary?.buy_units_total || 0)} units · ${fmtNum(summary?.eligible || 0)} styles`}
              icon={ShoppingCart} showDelta={false} />
            <KPICard testId="ro-kpi-at-risk" label="At-Risk Sell-Through"
              value={fmtKES(summary?.at_risk_sor_kes || 0)}
              sub="Lost over lead time if not bought"
              icon={Warning} showDelta={false} />
            <KPICard testId="ro-kpi-gmroi" label="Blended GMROI"
              value={summary?.blended_gmroi ? `${summary.blended_gmroi}×` : "—"}
              sub="Margin return on buy cost"
              icon={ChartLineUp} showDelta={false} />
            <KPICard testId="ro-kpi-candidates" label="Buy Candidates"
              value={fmtNum(summary?.eligible || 0)}
              sub={`${fmtNum(summary?.watch || 0)} on watch (building confidence)`}
              icon={Package} showDelta={false} />
            <KPICard testId="ro-kpi-accuracy" label="Forecast Accuracy"
              value={accuracy ? fmtPct(accuracy.pct) : "—"}
              sub={accuracy
                ? `Target ≥ ${accTarget}% · ${fmtNum(accuracy.evaluated)} actions scored`
                : "Awaiting completed actions to score"}
              icon={Target} showDelta={false} />
          </div>

          <div className="card-white p-5" data-testid="reorder-table-card">
            <SectionTitle
              title={`Buy list · ${visibleList.length} of ${eligible.length} styles${showResolved ? "" : " pending"}`}
              subtitle={
                <span>
                  Sorted by opportunity value — the biggest unmet-demand money first.
                  Planning horizon {fmtNum(summary?.horizon_weeks || 14)}w
                  ({fmtNum(summary?.lead_weeks || 6)}w lead + {fmtNum(summary?.cover_weeks || 8)}w cover).
                  Mark each row PO raised / dismissed so tomorrow's list only shows
                  what's still open.
                  <span className="block mt-1 text-[11.5px] text-muted/90" data-testid="reorder-drilldown-hint">
                    💡 Click any style name to see SKU-level details by color, print and size.
                  </span>
                </span>
              }
              action={
                <label className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-brand-deep cursor-pointer" data-testid="reorder-show-resolved">
                  <input
                    type="checkbox"
                    checked={showResolved}
                    onChange={(e) => setShowResolved(e.target.checked)}
                    className="accent-brand"
                  />
                  Show resolved ({resolvedCount})
                </label>
              }
            />
            {visibleList.length === 0 ? (
              <Empty label={eligible.length === 0
                ? "No styles currently meet the buy criteria (recent demand + sufficient confidence)."
                : "🎉 All buy recommendations have been actioned. Toggle 'Show resolved' to review."} />
            ) : (
              <SortableTable
                testId="reorder-table"
                exportName="buy-recommendations.csv"
                pageSize={50}
                mobileCards
                initialSort={{ key: "opportunity_value", dir: "desc" }}
                columns={[
                  { key: "rank", label: "#", numeric: true, mobileHidden: true, render: (r) => <span className="text-muted text-[11.5px]">{r.rank}</span>, csv: (r) => r.rank },
                  { key: "thumb", label: "", align: "left", sortable: false, mobileHidden: true, render: (r) => <ProductThumbnail style={r.style_name} url={urlFor(r.style_name)} size={36} />, image: (r) => urlFor(r.style_name), csv: () => "" },
                  { key: "style_name", label: "Style", align: "left", mobilePrimary: true, render: (r) => {
                    const t = trendMeta(r.trend);
                    const T = t.Icon;
                    return (
                      <span className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDrillStyle(r)}
                          className="font-medium break-words max-w-[240px] inline-block text-left text-brand underline decoration-dotted decoration-brand/40 underline-offset-[3px] hover:decoration-solid hover:decoration-brand cursor-pointer transition-colors"
                          style={{ whiteSpace: "normal", wordBreak: "break-word" }}
                          title="Click to view SKU variants (color × size × location)"
                          data-testid={`reorder-style-link-${r.style_name}`}
                        >
                          {r.style_name}
                        </button>
                        <BucketBadge bucket={r.bucket} />
                        <T size={14} weight="bold" className={t.cls} title={`Momentum: ${t.label}`} aria-label={t.label} />
                      </span>
                    );
                  } },
                  { key: "brand", label: "Brand", align: "left", mobileHidden: true, render: (r) => <span className="pill-neutral">{r.brand || "—"}</span>, csv: (r) => r.brand },
                  { key: "confidence", label: "Confidence", align: "left", mobileHidden: true, render: (r) => <span className={confPill(r.confidence)}>{r.confidence}</span>, csv: (r) => r.confidence },
                  { key: "sor_percent", label: <SORHeader />, numeric: true, mobileHidden: true, render: (r) => <span className={sorPill(r.sor_percent)}>{fmtPct(r.sor_percent)}</span>, csv: (r) => r.sor_percent?.toFixed(1) },
                  { key: "weekly_rate", label: "Demand/wk", numeric: true, mobileHidden: true, render: (r) => (
                    <span className="inline-flex items-center gap-0.5">
                      {fmtNum(Math.round(r.weekly_rate))}
                      {r.censored && <span title="Censored-demand uplift applied — recent stock-outs suppressed observed sales" className="text-amber-600 font-bold">*</span>}
                    </span>
                  ), csv: (r) => r.weekly_rate },
                  { key: "recommended_buy", label: "Recommended Buy", numeric: true, render: (r) => (
                    <span>
                      <span className="text-brand font-bold text-[15px]">{fmtNum(r.recommended_buy)}</span>
                      <span className="block text-[10.5px] text-muted">{fmtNum(r.demand_p10)}–{fmtNum(r.demand_p90)} band</span>
                    </span>
                  ), csv: (r) => r.recommended_buy },
                  { key: "net_position", label: "On-hand + WIP", numeric: true, mobileHidden: true, render: (r) => (
                    <span>
                      <span className="font-semibold">{fmtNum(r.net_position)}</span>
                      <span className="block text-[10.5px] text-muted" title="Store · Warehouse · In production (open PO)">
                        S{fmtNum(r.store_stock)}·W{fmtNum(r.warehouse_stock)}·PO{fmtNum(r.wip_units)}
                      </span>
                    </span>
                  ), csv: (r) => r.net_position },
                  { key: "opportunity_value", label: "Opportunity", numeric: true, render: (r) => <span className="font-bold">{fmtKES(r.opportunity_value)}</span>, csv: (r) => r.opportunity_value },
                  { key: "expected_margin_kes", label: "Exp. Margin", numeric: true, render: (r) => (
                    <span>
                      <span className="font-semibold">{fmtKES(r.expected_margin_kes)}</span>
                      <span className="block text-[10.5px] text-muted">GMROI {r.gmroi}×</span>
                    </span>
                  ), csv: (r) => r.expected_margin_kes },
                  { key: "payback_days", label: "Payback", numeric: true, mobileHidden: true, render: (r) => r.payback_days != null ? `${fmtNum(r.payback_days)}d` : <span className="text-muted">—</span>, csv: (r) => r.payback_days ?? "" },
                  { key: "aged_units", label: "Aged?", align: "left", mobileHidden: true, render: (r) => (
                    r.aged_block
                      ? <span className="pill-amber inline-flex items-center gap-1" title="Material aged stock held elsewhere — redistribute before re-cutting">⚠ {fmtNum(r.aged_units)}</span>
                      : (r.aged_units > 0 ? <span className="text-muted">{fmtNum(r.aged_units)}</span> : <span className="text-muted">—</span>)
                  ), csv: (r) => r.aged_block ? `aged ${r.aged_units}` : r.aged_units },
                  { key: "markdown", label: "Markdown?", align: "left", sortable: false, mobileHidden: true, render: (r) => (
                    markdownSet.has(r.style_name)
                      ? <span className="pill-amber inline-flex items-center gap-1"><Tag size={12} weight="bold" /> Markdown?</span>
                      : <span className="text-muted">—</span>
                  ), csv: (r) => markdownSet.has(r.style_name) ? "Markdown candidate" : "" },
                  { key: "__action", label: "Action", align: "left", render: (r) => (
                    <RecommendationActionPill
                      itemKey={r.style_name}
                      state={stateByKey.get(r.style_name)}
                      onChange={(status, opts) => setState(r.style_name, status, opts)}
                      label="buy"
                    />
                  ), csv: (r) => stateByKey.get(r.style_name)?.status || "pending" },
                ]}
                rows={visibleList}
              />
            )}
          </div>

          {/* Watch list — styles with real demand but below the confidence floor */}
          {watch.length > 0 && (
            <div className="card-white p-5" data-testid="reorder-watch-card">
              <SectionTitle
                title={`Watch list · ${watch.length} styles building confidence`}
                subtitle="Recent demand but not yet enough lifetime history to size a buy with confidence. They are excluded from the buy total — review manually before committing capital."
                action={
                  <button
                    type="button"
                    onClick={() => setShowWatch((v) => !v)}
                    className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-brand-deep cursor-pointer"
                    data-testid="reorder-toggle-watch"
                  >
                    <Eye size={14} weight="bold" /> {showWatch ? "Hide" : "Show"} watch list
                  </button>
                }
              />
              {showWatch && (
                <SortableTable
                  testId="reorder-watch-table"
                  exportName="buy-watch-list.csv"
                  pageSize={25}
                  mobileCards
                  initialSort={{ key: "opportunity_value", dir: "desc" }}
                  columns={[
                    { key: "style_name", label: "Style", align: "left", mobilePrimary: true, render: (r) => (
                      <button type="button" onClick={() => setDrillStyle(r)} className="font-medium text-brand underline decoration-dotted decoration-brand/40 underline-offset-[3px] hover:decoration-solid cursor-pointer">
                        {r.style_name}
                      </button>
                    ) },
                    { key: "bucket", label: "Type", align: "left", sortable: false, render: (r) => <BucketBadge bucket={r.bucket} /> },
                    { key: "lifetime_units", label: "Lifetime Units", numeric: true, render: (r) => <span className={r.lifetime_units < 30 ? "text-amber-700 font-semibold" : ""}>{fmtNum(r.lifetime_units)}</span>, csv: (r) => r.lifetime_units },
                    { key: "u28", label: "Units (28d)", numeric: true, render: (r) => fmtNum(r.u28), csv: (r) => r.u28 },
                    { key: "weekly_rate", label: "Demand/wk", numeric: true, render: (r) => fmtNum(Math.round(r.weekly_rate)), csv: (r) => r.weekly_rate },
                    { key: "opportunity_value", label: "Opportunity", numeric: true, render: (r) => <span className="font-semibold">{fmtKES(r.opportunity_value)}</span>, csv: (r) => r.opportunity_value },
                    { key: "gate", label: "Why on watch", align: "left", sortable: false, render: () => <span className="text-muted text-[11.5px]">Building confidence — needs ≥{summary?.confidence_floor || 30} lifetime units</span>, csv: (r) => r.gate },
                  ]}
                  rows={watch}
                />
              )}
            </div>
          )}

          <div className="card-white p-4 bg-panel">
            <div className="text-[12.5px] text-muted space-y-1.5">
              <div>
                <span className="font-semibold text-foreground">How the buy is sized:</span>{" "}
                demand is forecast per style (gamma-Poisson, shrunk toward the category
                rate so thin histories don't over/under-buy), taken to a service-level
                target over the {fmtNum(summary?.horizon_weeks || 14)}-week horizon, then
                netted against store + warehouse + in-production units. Ranked by
                opportunity value (margin × demand), never by Sell-Out Rate.
                Confidence: <span className="pill-green ml-1">High ≥200 units</span>{" "}
                <span className="pill-neutral ml-1">Medium</span>{" "}
                <span className="pill-amber ml-1">Low / on watch</span>.
              </div>
              {summary?.censored_note && (
                <div className="text-[11.5px]">
                  <span className="text-amber-600 font-bold">*</span> {summary.censored_note}
                </div>
              )}
              <div className="text-[11.5px] flex items-center gap-1.5">
                <Stack size={13} weight="bold" /> Buying is planned company-wide — this list is not scoped by the country / channel filter bar.
              </div>
            </div>
          </div>

          <ReplenishByColor />

          <AgedStockReport />
        </>
      )}

      {drillStyle && (
        <VariantDrillDown style={drillStyle} onClose={() => setDrillStyle(null)} />
      )}
    </div>
  );
};

export default ReOrder;
