import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtNum, fmtKES, fmtKESLong, fmtPct, fmtDec, buildParams } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { KPICard } from "@/components/KPICard";
import { Gauge, Lightning, Package, ChartLineUp, Stack } from "@phosphor-icons/react";

// Sell-Through Velocity — rate of sale (units/week) and weeks of cover by style,
// driven by the global filter bar. Sell-through thresholds mirror the Products
// page (>60 fast, 30–60 steady, <30 slow) so the two pages read consistently.

const velocityTag = (st) => {
  const v = Number(st);
  if (st === null || st === undefined || isNaN(v)) return { label: "—", cls: "text-muted" };
  if (v >= 60) return { label: "Fast", cls: "text-brand font-semibold" };
  if (v >= 30) return { label: "Steady", cls: "text-amber-600 font-semibold" };
  return { label: "Slow", cls: "text-danger font-semibold" };
};

const Velocity = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion } = applied;
  const filters = { dateFrom, dateTo, countries, channels };

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Canonical Units Sold for the same window/scope (the Overview headline) so
  // the styles-scope sum below can be reconciled with a quantified caption.
  const [canonicalUnits, setCanonicalUnits] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/analytics/velocity", { params: buildParams(filters) })
      .then((r) => {
        if (cancelled) return;
        setRows(r.data || []);
        touchLastUpdated();
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    setCanonicalUnits(null);
    api
      .get("/analytics/canonical-units-sold", { params: buildParams(filters) })
      .then((r) => { if (!cancelled) setCanonicalUnits(r.data?.units_sold ?? null); })
      .catch(() => { if (!cancelled) setCanonicalUnits(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [dateFrom, dateTo, JSON.stringify(countries), JSON.stringify(channels), dataVersion]);

  const k = useMemo(() => {
    const units = rows.reduce((s, r) => s + Number(r.units_sold || 0), 0);
    const stock = rows.reduce((s, r) => s + Number(r.current_stock || 0), 0);
    const weeklyRate = rows.reduce((s, r) => s + Number(r.rate_of_sale || 0), 0);
    const sellThrough = units + stock > 0 ? (units * 100) / (units + stock) : 0;
    const fast = rows.filter((r) => Number(r.sell_through || 0) >= 60).length;
    const slow = rows.filter((r) => Number(r.sell_through || 0) < 30).length;
    return { styles: rows.length, units, stock, weeklyRate, sellThrough, fast, slow };
  }, [rows]);

  const columns = [
    { key: "style_name", label: "Style", mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.style_name || "—"}</span> },
    { key: "brand", label: "Brand", render: (r) => r.brand || "—" },
    { key: "product_type", label: "Subcategory", render: (r) => r.product_type || "—" },
    { key: "units_sold", label: "Units Sold", numeric: true, render: (r) => fmtNum(r.units_sold) },
    { key: "rate_of_sale", label: "Rate / wk", numeric: true,
      headerTitle: "Units sold per week over the selected period",
      render: (r) => fmtDec(r.rate_of_sale, 1) },
    { key: "current_stock", label: "Current Stock", numeric: true, render: (r) => fmtNum(r.current_stock) },
    { key: "weeks_of_cover", label: "Weeks Cover", numeric: true,
      headerTitle: "Current stock ÷ rate of sale",
      sortValue: (r) => (r.weeks_of_cover == null ? Infinity : Number(r.weeks_of_cover)),
      render: (r) => (r.weeks_of_cover == null ? "—" : fmtDec(r.weeks_of_cover, 1)) },
    { key: "sell_through", label: "Sell-Through", numeric: true,
      render: (r) => fmtPct(r.sell_through) },
    { key: "velocity", label: "Velocity", sortable: false,
      render: (r) => { const t = velocityTag(r.sell_through); return <span className={t.cls}>{t.label}</span>; },
      csv: (r) => velocityTag(r.sell_through).label },
  ];

  if (loading) return <Loading label="Crunching velocity…" />;
  if (error) return <ErrorBox message={error} />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard label="Styles" value={fmtNum(k.styles)} icon={Stack} testId="kpi-vel-styles" showDelta={false} />
        <KPICard label="Units Sold" value={fmtNum(k.units)} icon={ChartLineUp} testId="kpi-vel-units" showDelta={false}
          sub={canonicalUnits != null && canonicalUnits !== k.units
            ? `vs ${fmtNum(canonicalUnits)} company-wide (${fmtNum(canonicalUnits - k.units)} on lines without a resolved style)`
            : undefined}
          formula={`Same gross units measure as Overview, over the selected period, but summed only across styles in the velocity universe (lines without a resolved style are excluded).${canonicalUnits != null ? ` Company-wide Units Sold for this window is ${fmtNum(canonicalUnits)}; the difference of ${fmtNum(canonicalUnits - k.units)} units sits on sale lines whose SKU is not in the product catalog.` : ""}`} />
        <KPICard label="Weekly Rate" value={`${fmtDec(k.weeklyRate, 0)} / wk`} icon={Lightning} testId="kpi-vel-rate" showDelta={false} sub={`${k.fast} fast · ${k.slow} slow`} />
        <KPICard label="Current Stock" value={fmtNum(k.stock)} icon={Package} testId="kpi-vel-stock" showDelta={false} />
        <KPICard label="Sell-Through" value={fmtPct(k.sellThrough)} icon={Gauge} testId="kpi-vel-sor" showDelta={false} formula="Units sold ÷ (units sold + current stock)" />
      </div>

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title="Sell-Through Velocity by Style"
          subtitle="Rate of sale and weeks of cover over the selected period. Current stock excludes warehouses."
          testId="velocity-section"
        />
        <SortableTable
          columns={columns}
          rows={rows}
          initialSort={{ key: "rate_of_sale", dir: "desc" }}
          exportName="sell-through-velocity.csv"
          testId="velocity-table"
          pageSize={50}
          mobileCards
          emptyLabel="No sales for the selected filters."
        />
      </div>
    </div>
  );
};

export default Velocity;
