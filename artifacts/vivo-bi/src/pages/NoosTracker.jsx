import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtNum, fmtDec } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { KPICard } from "@/components/KPICard";
import { Stack, ShieldCheck, Warning, Gauge, Storefront } from "@phosphor-icons/react";

// NOOS Tracker — "Never Out Of Stock" report for the Odoo-flagged NOOS styles
// (Tier 1 in the shared lifecycle-tier model). Mission: catch a NOOS style
// BEFORE it stocks out. Weeks of cover split warehouse vs stores + a per-store
// presence matrix showing exactly which stores lack each style.
//
// As-of-today operational view: the global date & channel filters do NOT
// apply (stock is a snapshot); the country filter DOES.

const SEVERITY = { out: 0, critical: 1, low: 2, no_sales: 3, healthy: 4, not_ranged: 5 };

const STATUS_META = {
  out:        { label: "Out of stock",    cls: "bg-red-100 text-red-700" },
  critical:   { label: "Critical",        cls: "bg-red-50 text-red-600" },
  low:        { label: "Low cover",       cls: "bg-amber-50 text-amber-700" },
  no_sales:   { label: "No sales",        cls: "bg-slate-100 text-slate-500" },
  healthy:    { label: "Healthy",         cls: "bg-emerald-50 text-emerald-700" },
  // Country-filtered views only: the style isn't ranged in this market —
  // grey, not an alarm (server decides; it contributes no store gaps).
  not_ranged: { label: "Not ranged here", cls: "bg-slate-100 text-slate-400" },
};

const StatusPill = ({ s }) => {
  const m = STATUS_META[s] || { label: s || "—", cls: "bg-slate-100 text-slate-500" };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${m.cls}`}>
      {m.label}
    </span>
  );
};

// Cover cell coloured against the shared thresholds (critical = the same
// reorder bar as the Velocity tab; low = 2×).
const CoverCell = ({ v, thresholds }) => {
  if (v === null || v === undefined) return <span className="text-muted">—</span>;
  const crit = thresholds?.critical_weeks ?? 5;
  const low = thresholds?.low_weeks ?? 10;
  const cls =
    v < crit ? "text-red-600 font-semibold"
    : v < low ? "text-amber-600 font-semibold"
    : "text-emerald-700";
  return <span className={cls}>{fmtDec(v, 1)}</span>;
};

const nullsLast = (get) => (r) => {
  const v = get(r);
  return v === null || v === undefined ? Infinity : Number(v);
};

const NoosTracker = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { countries, dataVersion } = applied;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const countryKey = (countries || []).join(",");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/analytics/noos-report", {
        params: countryKey ? { country: countryKey } : {},
      })
      .then((r) => {
        if (cancelled) return;
        setData(r?.data ?? r);
        touchLastUpdated?.();
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.response?.data?.detail || e?.message || "Failed to load NOOS report");
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryKey, dataVersion]);

  const summary = data?.summary || {};
  const thresholds = data?.thresholds || {};
  const styles = data?.styles || [];
  const storesTracked = summary.stores_tracked || 0;
  const needsAction = (summary.out || 0) + (summary.critical || 0);

  const cols = useMemo(() => [
    {
      key: "style_name", label: "Style", mobilePrimary: true,
      render: (r) => (
        <div>
          <div className="font-medium">{r.style_name || "—"}</div>
          {r.style_number ? (
            <div className="text-[11px] text-muted">{r.style_number}</div>
          ) : null}
        </div>
      ),
    },
    { key: "product_type", label: "Subcategory", render: (r) => r.product_type || "—" },
    {
      key: "status", label: "Status",
      sortValue: (r) => SEVERITY[r.status] ?? 9,
      render: (r) => <StatusPill s={r.status} />,
    },
    {
      key: "weekly_rate", label: "Rate / wk", numeric: true,
      render: (r) => fmtDec(r.weekly_rate, 1),
    },
    {
      key: "woc_total", label: "Total cover (wks)", numeric: true,
      sortValue: nullsLast((r) => r.woc_total),
      render: (r) => <CoverCell v={r.woc_total} thresholds={thresholds} />,
    },
    { key: "soh_warehouse", label: "WH units", numeric: true, render: (r) => fmtNum(r.soh_warehouse) },
    {
      key: "woc_warehouse", label: "WH cover", numeric: true,
      sortValue: nullsLast((r) => r.woc_warehouse),
      render: (r) => <CoverCell v={r.woc_warehouse} thresholds={thresholds} />,
    },
    { key: "soh_stores", label: "Store units", numeric: true, render: (r) => fmtNum(r.soh_stores) },
    {
      key: "woc_stores", label: "Store cover", numeric: true,
      sortValue: nullsLast((r) => r.woc_stores),
      render: (r) => <CoverCell v={r.woc_stores} thresholds={thresholds} />,
    },
    {
      key: "soh_pipeline", label: "Incoming", numeric: true,
      render: (r) => (r.soh_pipeline ? fmtNum(r.soh_pipeline) : "—"),
    },
    {
      key: "stores_stocked", label: "Stores stocked", numeric: true,
      render: (r) => (
        <span className={r.stores_stocked < storesTracked ? "text-amber-700 font-semibold" : ""}>
          {r.stores_stocked}/{storesTracked}
        </span>
      ),
    },
    {
      key: "stores_missing", label: "Missing from",
      sortValue: (r) => (r.stores_missing || []).length,
      csv: (r) => (r.stores_missing || []).join("; "),
      render: (r) => {
        const m = r.stores_missing || [];
        if (!m.length) return <span className="text-emerald-700 text-[12px]">In all stores</span>;
        const shown = m.slice(0, 2);
        return (
          <span className="text-[12px]">
            {shown.join(", ")}
            {m.length > shown.length ? (
              <span className="text-muted"> +{m.length - shown.length} more</span>
            ) : null}
          </span>
        );
      },
    },
  ], [thresholds, storesTracked]);

  const renderExpanded = (r) => {
    const detail = r.store_detail || [];
    const missing = r.stores_missing || [];
    return (
      <div className="p-3 sm:p-4 space-y-3 bg-panel/40">
        {missing.length > 0 && (
          <div data-testid={`noos-missing-${r.style_name}`}>
            <div className="text-[11.5px] font-semibold text-muted uppercase tracking-wide mb-1">
              Not stocked in {missing.length} of {storesTracked} stores
            </div>
            <div className="flex flex-wrap gap-1.5">
              {missing.map((s) => (
                <span key={s} className="px-2 py-0.5 rounded-full bg-red-50 text-red-700 text-[11.5px] font-medium">
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}
        {detail.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-[420px] text-[12.5px]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="pr-4 pb-1 font-medium">Store</th>
                  <th className="pr-4 pb-1 font-medium text-right">Units</th>
                  <th className="pr-4 pb-1 font-medium text-right">Rate / wk</th>
                  <th className="pr-4 pb-1 font-medium text-right">Cover (wks)</th>
                  <th className="pb-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.map((d) => (
                  <tr key={d.store} className="border-t border-line/60">
                    <td className="pr-4 py-1">{d.store}</td>
                    <td className="pr-4 py-1 text-right">{fmtNum(d.units)}</td>
                    <td className="pr-4 py-1 text-right">{fmtDec(d.weekly_rate, 1)}</td>
                    <td className="pr-4 py-1 text-right"><CoverCell v={d.woc} thresholds={thresholds} /></td>
                    <td className="py-1"><StatusPill s={d.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-[12.5px] text-muted">No store stock or recent store sales for this style.</div>
        )}
        {r.soh_pipeline > 0 && (
          <div className="text-[12px] text-muted">
            Incoming / pipeline (production, transit, receiving): <span className="font-semibold text-slate-800">{fmtNum(r.soh_pipeline)}</span> units — not counted in cover.
          </div>
        )}
      </div>
    );
  };

  const critW = thresholds.critical_weeks ?? 5;
  const lowW = thresholds.low_weeks ?? 10;

  return (
    <div className="space-y-4" data-testid="noos-tracker">
      <SectionTitle
        title="NOOS — Never Out of Stock tracker"
        subtitle={`The ${summary.styles || ""} styles flagged NOOS in Odoo must never stock out. Cover uses the same weekly-velocity rule as Velocity & Cover; reorder when total cover drops under ${fmtDec(critW, 0)} weeks (${fmtDec(critW - 1, 0)}-week lead time + 1 week safety). As-of-today view — date & channel filters don't apply; country does.`}
        testId="noos-section-title"
      />

      {error ? (
        <ErrorBox message={error} />
      ) : loading && !data ? (
        <Loading label="Checking NOOS cover…" />
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <KPICard small label="NOOS styles" value={fmtNum(summary.styles || 0)}
              sub="flagged in Odoo" icon={Stack} testId="noos-kpi-styles" />
            <KPICard small label="Act now" value={fmtNum(needsAction)}
              sub={`out of stock or under ${fmtDec(critW, 0)} wks`} icon={Warning} testId="noos-kpi-act-now" />
            <KPICard small label="Low cover" value={fmtNum(summary.low || 0)}
              sub={`${fmtDec(critW, 0)}–${fmtDec(lowW, 0)} wks — plan reorder`} icon={Gauge} testId="noos-kpi-low" />
            <KPICard small label="Healthy" value={fmtNum(summary.healthy || 0)}
              sub={`${fmtDec(lowW, 0)}+ wks of cover`} icon={ShieldCheck} testId="noos-kpi-healthy" />
            <KPICard small label="Store gaps" value={fmtNum(summary.store_gaps || 0)}
              sub={`style-store slots empty · ${storesTracked} stores`} icon={Storefront} testId="noos-kpi-gaps" />
          </div>
          {((summary.no_sales || 0) > 0 || (summary.not_ranged || 0) > 0) && (
            <div className="text-[11.5px] text-muted" data-testid="noos-nosales-note">
              Act now + Low + Healthy
              {(summary.no_sales || 0) > 0 ? ` + ${summary.no_sales} “No sales” (stock, nothing sold in 8 wks)` : ""}
              {(summary.not_ranged || 0) > 0 ? ` + ${summary.not_ranged} not ranged in this country` : ""}
              {" "}= {summary.styles} tracked styles.
            </div>
          )}

          <div className="card-white p-4 sm:p-5">
            <SortableTable
              columns={cols}
              rows={styles}
              exportName="noos-tracker.csv"
              testId="noos-table"
              pageSize={40}
              mobileCards
              renderExpanded={renderExpanded}
              rowKey={(r) => r.style_name}
              emptyLabel="No NOOS styles found — flag styles as NOOS in Odoo to track them here."
            />
            <div className="mt-2 text-[11.5px] text-muted">
              Sorted most-urgent first. Expand a row for the store-by-store breakdown.
              "Missing from" counts active physical stores with zero units of the style.
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default NoosTracker;
