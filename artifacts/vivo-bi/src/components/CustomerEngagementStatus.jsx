import React, { useEffect, useMemo, useState } from "react";
import { CaretDown, CaretRight, Download, UsersThree } from "@phosphor-icons/react";
import { api, buildParams, comparePeriod, fmtKES, fmtNum, fmtPct, pctDelta } from "@/lib/api";
import { exportCSV } from "@/components/SortableTable";
import { useFilters } from "@/lib/filters";
import { ErrorBox, Loading, SectionTitle } from "@/components/common";

const scopeSlug = (scope) => {
  const parts = [scope?.country, scope?.channel]
    .filter(Boolean)
    .join("_")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "");
  return parts || "all-locations";
};

const compareLabel = (mode) => ({
  yesterday: "vs Yesterday",
  last_month: "vs Last Month",
  last_year: "vs Last Year",
  last_year_dow: "vs Last Year",
  custom: "vs Comparison",
}[mode] || null);

export const useRetailCustomerHealth = () => {
  const { applied, touchLastUpdated } = useFilters();
  const [health, setHealth] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const filters = {
      dateFrom: applied.dateFrom,
      dateTo: applied.dateTo,
      countries: applied.countries,
      channels: applied.channels,
    };
    const currentParams = buildParams(filters, { _v: applied.dataVersion });
    const previous = comparePeriod(
      applied.dateFrom,
      applied.dateTo,
      applied.compareMode,
      { date_from: applied.compareDateFrom, date_to: applied.compareDateTo },
    );
    const comparisonParams = previous
      ? buildParams(
          { ...filters, dateFrom: previous.date_from, dateTo: previous.date_to },
          { _v: applied.dataVersion },
        )
      : null;

    Promise.all([
      api.get("/retail/customer-health", { params: currentParams }),
      comparisonParams
        ? api.get("/retail/customer-health", { params: comparisonParams })
        : Promise.resolve(null),
    ])
      .then(([current, prior]) => {
        if (cancelled) return;
        setHealth(current.data || null);
        setComparison(prior?.data || null);
        touchLastUpdated();
      })
      .catch((err) => {
        if (!cancelled) setError(err?.response?.data?.detail || err?.message || "Could not load customer engagement.");
      })
      .finally(() => !cancelled && setLoading(false));

    return () => { cancelled = true; };
  }, [
    applied.dateFrom,
    applied.dateTo,
    JSON.stringify(applied.countries),
    JSON.stringify(applied.channels),
    applied.compareMode,
    applied.compareDateFrom,
    applied.compareDateTo,
    applied.dataVersion,
    touchLastUpdated,
  ]);

  return { health, comparison, loading, error, comparisonLabel: compareLabel(applied.compareMode) };
};

const statusTone = (key) => ({
  active: "border-emerald-200 bg-emerald-50/50 text-emerald-800",
  cooling: "border-sky-200 bg-sky-50/50 text-sky-800",
  at_risk: "border-amber-200 bg-amber-50/60 text-amber-900",
  high_risk: "border-orange-200 bg-orange-50/70 text-orange-900",
  lapsed: "border-red-200 bg-red-50/60 text-red-900",
}[key] || "border-border bg-white text-foreground");

const statusRange = (cohort) =>
  cohort.max_days == null ? `${cohort.min_days}+ days` : `${cohort.min_days}–${cohort.max_days} days`;

const engagementColumns = [
  { key: "date_from", csvLabel: "Date From" },
  { key: "date_to", csvLabel: "Date To" },
  { key: "country", csvLabel: "Country Scope" },
  { key: "pos", csvLabel: "POS Scope" },
  { key: "status", csvLabel: "Engagement Status" },
  { key: "store", csvLabel: "Store" },
  { key: "customers", csvLabel: "Customers" },
  { key: "customer_base_share_pct", csvLabel: "Customer Base Share %" },
  { key: "revenue_at_risk_kes", csvLabel: "Historical Revenue at Risk (KES)" },
];

const exportRows = (health, cohorts) => cohorts.flatMap((cohort) =>
  (cohort.stores || []).map((store) => ({
    date_from: health.scope.date_from,
    date_to: health.scope.date_to,
    country: health.scope.country || "All",
    pos: health.scope.channel || "All",
    status: cohort.label,
    store: store.store,
    customers: store.count,
    customer_base_share_pct: health.customer_base
      ? Number((store.count * 100 / health.customer_base).toFixed(2))
      : 0,
    revenue_at_risk_kes: store.revenue_at_risk,
  })));

export const CustomerEngagementStatus = ({ health, loading, error }) => {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set());
  const rowsByCohort = useMemo(
    () => Object.fromEntries((health?.cohorts || []).map((cohort) => [cohort.key, exportRows(health, [cohort])])),
    [health],
  );

  if (loading) {
    return (
      <section className="card-white p-4" data-testid="customer-engagement-loading">
        <Loading label="Loading customer engagement…" />
      </section>
    );
  }
  if (error) return <ErrorBox message={error} />;
  if (!health) return null;

  const allRows = exportRows(health, health.cohorts || []);
  const filenameBase = `retail-customer-engagement_${health.scope.date_to}_${scopeSlug(health.scope)}`;

  return (
    <section className="card-white p-4 sm:p-5" data-testid="customer-engagement-status">
      <SectionTitle
        title="Customer Engagement Status"
        subtitle={`Recency as of ${health.scope.date_to}. Each identified customer is assigned to the most recent in-scope purchase store.`}
        action={
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => exportCSV(allRows, engagementColumns, `${filenameBase}_all-statuses.csv`)}
              className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-[11.5px] font-semibold text-muted hover:border-brand hover:text-brand"
              data-testid="customer-engagement-export-all"
            >
              <Download size={13} weight="bold" /> Export all CSV
            </button>
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-[11.5px] font-semibold text-foreground hover:border-brand"
              aria-expanded={open}
              data-testid="customer-engagement-toggle"
            >
              {open ? <CaretDown size={13} weight="bold" /> : <CaretRight size={13} weight="bold" />}
              {open ? "Collapse" : "Expand"}
            </button>
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-panel/60 px-3 py-2 text-[11.5px] text-muted">
        <span><b className="text-foreground">{fmtNum(health.customer_base)}</b> identified customers in the recency base</span>
        <span>Historical revenue at risk is net historical in-scope revenue through the selected end date.</span>
      </div>

      {open && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          {(health.cohorts || []).map((cohort) => {
            const isExpanded = expanded.has(cohort.key);
            const deltaText = cohort.change_pct == null
              ? "No prior-year base"
              : `${cohort.change_pct >= 0 ? "+" : ""}${cohort.change_pct.toFixed(1)}% vs LY`;
            return (
              <article
                key={cohort.key}
                className={`min-w-0 rounded-xl border p-3 ${statusTone(cohort.key)}`}
                data-testid={`customer-engagement-${cohort.key}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-bold text-[13.5px]">{cohort.label}</h3>
                    <p className="text-[10.5px] opacity-75">{statusRange(cohort)} since last purchase</p>
                  </div>
                  <UsersThree size={16} weight="duotone" className="shrink-0 opacity-75" />
                </div>
                <div className="mt-3 text-[22px] leading-none font-bold num">{fmtNum(cohort.count)}</div>
                <div className="mt-1 text-[11.5px] opacity-80">{fmtPct(cohort.share)} of customer base</div>
                <div className="mt-2 border-t border-current/15 pt-2 text-[11.5px]">
                  <div className="font-semibold">{deltaText}</div>
                  <div className="mt-1 opacity-80">Historical revenue at risk</div>
                  <div className="font-bold num">{fmtKES(cohort.revenue_at_risk)}</div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(cohort.key)) next.delete(cohort.key);
                      else next.add(cohort.key);
                      return next;
                    })}
                    className="inline-flex items-center gap-1 rounded border border-current/25 bg-white/50 px-2 py-1 text-[10.5px] font-semibold hover:bg-white/80"
                    aria-expanded={isExpanded}
                    data-testid={`customer-engagement-${cohort.key}-toggle`}
                  >
                    {isExpanded ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
                    {isExpanded ? "Hide stores" : `Stores (${cohort.stores.length})`}
                  </button>
                  <button
                    type="button"
                    onClick={() => exportCSV(
                      rowsByCohort[cohort.key] || [],
                      engagementColumns,
                      `${filenameBase}_${cohort.key}.csv`,
                    )}
                    className="inline-flex items-center gap-1 rounded border border-current/25 bg-white/50 px-2 py-1 text-[10.5px] font-semibold hover:bg-white/80"
                    data-testid={`customer-engagement-${cohort.key}-export`}
                  >
                    <Download size={11} weight="bold" /> CSV
                  </button>
                </div>
                {isExpanded && (
                  <div className="mt-3 space-y-1.5 border-t border-current/15 pt-2" data-testid={`customer-engagement-${cohort.key}-stores`}>
                    {(cohort.stores || []).length === 0 ? (
                      <p className="text-[11px] opacity-75">No stores in this filtered status.</p>
                    ) : cohort.stores.map((store) => (
                      <div key={store.store} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="min-w-0 truncate font-medium" title={store.store}>{store.store}</span>
                        <span className="shrink-0 text-right num">{fmtNum(store.count)} · {fmtKES(store.revenue_at_risk)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};

export const retailEngagementKpis = (health, comparison) => {
  if (!health) return null;
  const current = health.metrics || {};
  const prior = comparison?.metrics || null;
  return {
    footfall: current.footfall,
    previousFootfall: prior?.footfall ?? null,
    footfallDelta: current.footfall != null && prior?.footfall != null
      ? pctDelta(current.footfall, prior.footfall) : null,
    conversion: current.conversion_rate,
    previousConversion: prior?.conversion_rate ?? null,
    conversionDeltaPp: current.conversion_rate != null && prior?.conversion_rate != null
      ? current.conversion_rate - prior.conversion_rate : null,
    uniqueCustomers: current.unique_customers,
    previousUniqueCustomers: prior?.unique_customers ?? null,
    uniqueCustomersDelta: prior
      ? pctDelta(current.unique_customers, prior.unique_customers) : null,
  };
};

export default CustomerEngagementStatus;