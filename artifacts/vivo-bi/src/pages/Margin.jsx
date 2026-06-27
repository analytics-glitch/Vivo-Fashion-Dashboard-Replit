import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtNum, fmtKES, fmtKESLong, fmtPct, buildParams } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { KPICard } from "@/components/KPICard";
import { Coins, Percent, Tag, Receipt, ChartLineUp } from "@phosphor-icons/react";

// Markdown / Discount Impact on Margin. COGS uses all_products_clean.cost, which
// is not known for every SKU, so gross margin is computed over the COSTED subset
// only and cost coverage is shown so the figure is read honestly.

const DIMS = [
  { id: "category", label: "Category" },
  { id: "subcategory", label: "Subcategory" },
  { id: "brand", label: "Brand" },
  { id: "store", label: "Store" },
  { id: "month", label: "Month" },
];

const Chip = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`px-3 py-1.5 rounded-full text-[12px] font-semibold border transition-colors ${
      active ? "bg-brand text-white border-brand" : "bg-white text-foreground border-border hover:bg-panel"
    }`}
  >
    {children}
  </button>
);

const marginCls = (m) => {
  const v = Number(m);
  if (m === null || m === undefined || isNaN(v)) return "text-muted";
  if (v >= 50) return "text-brand font-semibold";
  if (v >= 30) return "text-amber-600 font-semibold";
  return "text-danger font-semibold";
};

const Margin = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion } = applied;
  const filters = { dateFrom, dateTo, countries, channels };

  const [dim, setDim] = useState("category");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/analytics/margin", { params: buildParams(filters, { dim }) })
      .then((r) => {
        if (cancelled) return;
        setRows(r.data || []);
        touchLastUpdated();
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [dim, dateFrom, dateTo, JSON.stringify(countries), JSON.stringify(channels), dataVersion]);

  const k = useMemo(() => {
    const gross = rows.reduce((s, r) => s + Number(r.gross || 0), 0);
    const discounts = rows.reduce((s, r) => s + Number(r.discounts || 0), 0);
    const net = rows.reduce((s, r) => s + Number(r.net_revenue || 0), 0);
    const cogs = rows.reduce((s, r) => s + Number(r.cogs || 0), 0);
    const gm = rows.reduce((s, r) => s + Number(r.gross_margin || 0), 0);
    const units = rows.reduce((s, r) => s + Number(r.units || 0), 0);
    const costedNet = gm + cogs;
    const marginPct = costedNet > 0 ? (gm * 100) / costedNet : 0;
    const discountRate = gross > 0 ? (discounts * 100) / gross : 0;
    // Coverage weighted by units (server returns per-row coverage %).
    const coveredUnits = rows.reduce((s, r) => s + Number(r.units || 0) * Number(r.cost_coverage || 0) / 100, 0);
    const coverage = units > 0 ? (coveredUnits * 100) / units : 0;
    return { gross, discounts, net, cogs, gm, marginPct, discountRate, coverage };
  }, [rows]);

  const dimLabel = DIMS.find((d) => d.id === dim)?.label || "Category";

  const columns = [
    { key: "dim", label: dimLabel, mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.dim || "—"}</span> },
    { key: "units", label: "Units", numeric: true, render: (r) => fmtNum(r.units) },
    { key: "gross", label: "Gross (KES)", numeric: true, render: (r) => fmtKESLong(r.gross) },
    { key: "discounts", label: "Discounts (KES)", numeric: true, render: (r) => fmtKESLong(r.discounts) },
    { key: "discount_rate", label: "Discount %", numeric: true, render: (r) => fmtPct(r.discount_rate) },
    { key: "net_revenue", label: "Net Revenue (KES)", numeric: true, render: (r) => fmtKESLong(r.net_revenue) },
    { key: "cogs", label: "COGS (KES)", numeric: true, render: (r) => fmtKESLong(r.cogs) },
    { key: "gross_margin", label: "Gross Margin (KES)", numeric: true, render: (r) => fmtKESLong(r.gross_margin) },
    { key: "margin_pct", label: "Margin %", numeric: true,
      render: (r) => <span className={marginCls(r.margin_pct)}>{fmtPct(r.margin_pct)}</span>,
      csv: (r) => `${Number(r.margin_pct || 0)}%` },
    { key: "cost_coverage", label: "Cost Coverage", numeric: true, mobileHidden: true,
      headerTitle: "Share of units with a known cost — margin is computed on these only. Rows under 70% are flagged: their margin reflects only a small share of units and may be unreliable.",
      render: (r) => {
        const c = Number(r.cost_coverage || 0);
        const low = c < 70;
        return (
          <span
            className={low ? "text-amber-600 font-semibold" : ""}
            title={low ? "Low cost coverage — margin for this row is based on a small share of units and may not be representative." : undefined}
          >
            {low ? "⚠ " : ""}{fmtPct(r.cost_coverage)}
          </span>
        );
      },
      csv: (r) => `${Number(r.cost_coverage || 0)}%` },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard label="Net Revenue" value={fmtKES(k.net)} valueFull={fmtKESLong(k.net)} icon={ChartLineUp} testId="kpi-mg-net" showDelta={false} formula="Item sales after discounts, minus returns — same formula as the Overview ‘Net Sales’ KPI, but this page joins to the product master to compute cost, so it covers only catalog-matched SKUs. Sales for SKUs missing from the catalog are excluded, so it reads slightly below Overview Net Sales." />
        <KPICard label="Gross Margin" value={fmtKES(k.gm)} valueFull={fmtKESLong(k.gm)} icon={Coins} testId="kpi-mg-gm" showDelta={false} suffix={`${fmtPct(k.coverage)} cost coverage`} />
        <KPICard label="Margin %" value={fmtPct(k.marginPct)} icon={Percent} testId="kpi-mg-pct" showDelta={false} formula="Gross margin ÷ costed net revenue (costed lines only)" />
        <KPICard label="Discounts" value={fmtKES(k.discounts)} valueFull={fmtKESLong(k.discounts)} icon={Receipt} testId="kpi-mg-disc" showDelta={false} />
        <KPICard label="Discount Rate" value={fmtPct(k.discountRate)} icon={Tag} testId="kpi-mg-discrate" showDelta={false} formula="Discounts ÷ gross sales" />
      </div>

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title="Markdown & Margin"
          subtitle="Gross margin uses per-unit cost; COGS, gross margin and margin % cover the subset of units with a known cost (see Cost Coverage)."
          testId="margin-section"
          action={
            <div className="flex flex-wrap gap-1.5">
              {DIMS.map((d) => (
                <Chip key={d.id} active={dim === d.id} onClick={() => setDim(d.id)}>{d.label}</Chip>
              ))}
            </div>
          }
        />
        {loading ? (
          <Loading label="Working out the margins…" />
        ) : error ? (
          <ErrorBox message={error} />
        ) : (
          <SortableTable
            columns={columns}
            rows={rows}
            initialSort={{ key: "net_revenue", dir: "desc" }}
            exportName={`margin-by-${dim}.csv`}
            testId="margin-table"
            pageSize={50}
            mobileCards
            emptyLabel="No sales for the selected filters."
          />
        )}
      </div>
    </div>
  );
};

export default Margin;
