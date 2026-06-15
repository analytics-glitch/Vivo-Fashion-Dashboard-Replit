import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtDate } from "@/lib/api";
import TrendPanel from "@/components/TrendPanel";
import { TrendUp, Plus } from "@phosphor-icons/react";

/**
 * Trend Analysis — a self-serve cockpit for watching any KPI's shape over time.
 *
 * Each "panel" is an independent mini-dashboard: pick the KPI, the granularity
 * (Year / Month / Week) and the scope (Overall or one store) WITHOUT affecting
 * the other panels, and ask the AI to describe what the trend shows. The page
 * inherits the date range + country from the global filter bar; each panel
 * layers its own store scope on top. Add or remove panels to compare KPIs
 * side by side (e.g. Revenue monthly vs Conversion weekly vs Footfall yearly).
 */

let _seq = 0;
const newPanel = (kpi, bucket) => ({ id: ++_seq, kpi, bucket });

const DEFAULT_PANELS = [
  newPanel("total_sales", "month"),
  newPanel("conversion_rate", "month"),
  newPanel("units_sold", "month"),
  newPanel("avg_basket_size", "month"),
];

const TrendAnalysis = () => {
  const { applied } = useFilters();
  const { dateFrom, dateTo, countries, dataVersion } = applied;

  const [panels, setPanels] = useState(DEFAULT_PANELS);
  const [stores, setStores] = useState([]);

  // Master store list (active POS) so each panel can scope to a single store.
  useEffect(() => {
    let cancelled = false;
    api
      .get("/analytics/active-pos", { params: { n_days: 365 } })
      .then((r) => {
        if (cancelled) return;
        const names = Array.from(
          new Set((r.data || []).map((s) => s.channel).filter(Boolean))
        ).sort((a, b) => a.localeCompare(b));
        setStores(names);
      })
      .catch(() => { if (!cancelled) setStores([]); });
    return () => { cancelled = true; };
  }, []);

  const addPanel = useCallback(() => {
    setPanels((p) => [...p, newPanel("total_sales", "month")]);
  }, []);

  const removePanel = useCallback((id) => {
    setPanels((p) => p.filter((x) => x.id !== id));
  }, []);

  const rangeLabel = useMemo(() => {
    if (!dateFrom || !dateTo) return "";
    return `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`;
  }, [dateFrom, dateTo]);
  const countryLabel = countries && countries.length ? countries.join(", ") : "All markets";

  return (
    <div className="space-y-6" data-testid="trend-analysis-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[18px] font-bold text-foreground">
            <TrendUp size={20} weight="duotone" className="text-[#1a5c38]" />
            Trend Analysis
          </h1>
          <p className="text-[12.5px] text-muted mt-1 max-w-2xl">
            Track any KPI over time — revenue, net sales, units, transactions, footfall,
            conversion, basket value or selling price. Each panel sets its own granularity
            and store scope independently, so you can compare different KPIs side by side.
            Use the filter bar above for the date range and market.
          </p>
          <div className="text-[11.5px] text-muted mt-1">
            {rangeLabel ? <span className="num">{rangeLabel}</span> : null}
            {rangeLabel ? <span className="mx-1.5">·</span> : null}
            <span>{countryLabel}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={addPanel}
          className="inline-flex items-center gap-1.5 rounded-full bg-[#1a5c38] text-white text-[12.5px] font-semibold px-3.5 py-2 hover:bg-[#0f3d24] transition-colors"
          data-testid="trend-add-panel"
        >
          <Plus size={14} weight="bold" /> Add KPI panel
        </button>
      </div>

      {panels.length === 0 ? (
        <div className="card-white p-12 text-center text-[13px] text-muted">
          No panels. Click <span className="font-semibold text-foreground">Add KPI panel</span> to start a trend.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {panels.map((p) => (
            <TrendPanel
              key={p.id}
              dateFrom={dateFrom}
              dateTo={dateTo}
              countries={countries}
              dataVersion={dataVersion}
              stores={stores}
              initialKpi={p.kpi}
              initialBucket={p.bucket}
              removable={panels.length > 1}
              onRemove={() => removePanel(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default TrendAnalysis;
