import React, { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ErrorBox, Loading } from "@/components/common";
import {
  ChartCard,
  C,
  fmtKESM,
  fmtNum,
  fmtPct1,
  fmtWoc,
  useMerchData,
} from "./MerchHelpers";

const PRIMARY_DIMENSIONS = [
  { value: "fabric_category", label: "Fabric category" },
  { value: "fabric_subcategory", label: "Fabric subcategory" },
  { value: "colour", label: "Colour" },
  { value: "silhouette", label: "Silhouette" },
];

const SECONDARY_DIMENSIONS = [
  { value: "category", label: "Product category" },
  { value: "subcategory", label: "Product subcategory" },
  { value: "tier", label: "Tier" },
];

const METRICS = [
  { value: "sor", label: "SOR", shortLabel: "SOR", direction: "high" },
  { value: "woc", label: "WOC", shortLabel: "WOC", direction: "low" },
  { value: "revenue", label: "Revenue", shortLabel: "Revenue", direction: "high" },
  { value: "full_price", label: "Full-price %", shortLabel: "Full-price %", direction: "high" },
  { value: "units", label: "Units sold", shortLabel: "Units sold", direction: "high" },
];

const tidy = (value) => (typeof value === "string" ? value.trim() : "");
const isActiveStyle = (row) => String(row.odoo_status || row.status || "").toLowerCase() === "active";

const selectedPeriodUnits = (row) => Number(row.units_period ?? row.units_6m ?? 0) || 0;
const selectedPeriodRevenue = (row) => Number(row.revenue_period ?? row.revenue_6m ?? 0) || 0;
const metricDefinition = (value) => METRICS.find((metric) => metric.value === value) || METRICS[0];

const metricValue = (row, metric) => {
  if (metric === "sor") return row.sor_period ?? row.sor_6m;
  if (metric === "woc") return row.woc;
  if (metric === "revenue") return selectedPeriodRevenue(row);
  if (metric === "full_price") return row.full_price_pct;
  return selectedPeriodUnits(row);
};

const formatMetric = (value, metric) => {
  if (value == null || Number.isNaN(Number(value))) return "—";
  if (metric === "sor" || metric === "full_price") return fmtPct1(value);
  if (metric === "woc") return fmtWoc(value);
  if (metric === "revenue") return fmtKESM(value);
  return fmtNum(value);
};

const aggregateRows = (rows, primaryKey, secondaryKey, metric) => {
  const groups = new Map();

  for (const row of rows) {
    const primary = tidy(row[primaryKey]);
    const secondary = secondaryKey ? tidy(row[secondaryKey]) : "";
    if (!primary || (secondaryKey && !secondary)) continue;

    const key = secondaryKey ? `${primary}|||${secondary}` : primary;
    const units = selectedPeriodUnits(row);
    const stock = Number(row.current_stock || 0) || 0;
    const revenue = selectedPeriodRevenue(row);
    const fpPct = Number(row.full_price_pct);
    const group = groups.get(key) || {
      key,
      primary,
      secondary,
      styles: 0,
      units: 0,
      revenue: 0,
      stock: 0,
      sorDenom: 0,
      fullPriceUnits: 0,
      wocUnits: 0,
    };

    group.styles += 1;
    group.units += units;
    group.revenue += revenue;
    group.stock += stock;
    group.sorDenom += units + stock;
    group.fullPriceUnits += Number.isFinite(fpPct) ? (units * fpPct) / 100 : 0;
    group.wocUnits += Number(row.units_6m || 0) || 0;
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      value: metric === "sor"
        ? (group.sorDenom > 0 ? (group.units * 100) / group.sorDenom : null)
        : metric === "woc"
          ? (group.wocUnits > 0 ? group.stock / (group.wocUnits / 26) : null)
          : metric === "full_price"
            ? (group.units > 0 ? (group.fullPriceUnits * 100) / group.units : null)
            : metric === "revenue" ? group.revenue : group.units,
    }))
    .filter((group) => group.value != null && Number.isFinite(Number(group.value)));
};

const sortGroups = (groups, metric) => {
  const direction = metricDefinition(metric).direction === "low" ? 1 : -1;
  return [...groups].sort((a, b) => (Number(a.value) - Number(b.value)) * direction);
};

const aggregateFabricBuyingSummary = (rows, fabricKey) => {
  const groups = new Map();

  for (const row of rows) {
    const name = tidy(row[fabricKey]);
    if (!name) continue;

    const units = selectedPeriodUnits(row);
    const stock = Number(row.current_stock || 0) || 0;
    const fullPricePct = Number(row.full_price_pct);
    const group = groups.get(name) || {
      name,
      styles: 0,
      stock: 0,
      wocTotal: 0,
      wocCount: 0,
      units: 0,
      revenue: 0,
      sorDenom: 0,
      fullPriceUnits: 0,
    };

    group.styles += 1;
    group.stock += stock;
    group.units += units;
    group.revenue += selectedPeriodRevenue(row);
    group.sorDenom += units + stock;
    if (Number.isFinite(Number(row.woc))) {
      group.wocTotal += Number(row.woc);
      group.wocCount += 1;
    }
    if (Number.isFinite(fullPricePct)) {
      group.fullPriceUnits += (units * fullPricePct) / 100;
    }
    groups.set(name, group);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    woc: group.wocCount > 0 ? group.wocTotal / group.wocCount : null,
    sor: group.sorDenom > 0 ? (group.units * 100) / group.sorDenom : null,
    full_price: group.units > 0 ? (group.fullPriceUnits * 100) / group.units : null,
  }));
};

const FABRIC_SUMMARY_COLUMNS = [
  { key: "name", label: "Fabric name", numeric: false },
  { key: "styles", label: "Active styles", numeric: true },
  { key: "stock", label: "Current stock units (SOH)", numeric: true },
  { key: "woc", label: "WOC", numeric: true },
  { key: "sor", label: "Period SOR", numeric: true },
  { key: "full_price", label: "Full-price %", numeric: true },
  { key: "revenue", label: "Period revenue", numeric: true },
  { key: "units", label: "Period units sold", numeric: true },
];

const sortFabricSummary = (rows, sort) => {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === "name") return a.name.localeCompare(b.name) * direction;
    const aValue = Number(a[sort.key]);
    const bValue = Number(b[sort.key]);
    if (!Number.isFinite(aValue) && !Number.isFinite(bValue)) return 0;
    if (!Number.isFinite(aValue)) return 1;
    if (!Number.isFinite(bValue)) return -1;
    return (aValue - bValue) * direction;
  });
};

const wocAlertClass = (woc) => {
  if (!Number.isFinite(Number(woc))) return "text-slate-400";
  if (Number(woc) < 4) return "bg-red-50 font-bold text-red-700";
  if (Number(woc) < 8) return "bg-amber-50 font-semibold text-amber-700";
  return "text-slate-700";
};

const AttributeTooltip = ({ active, payload, metric }) => {
  if (!active || !payload?.length) return null;
  const group = payload[0]?.payload;
  if (!group) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] shadow-lg">
      <div className="mb-1 max-w-[220px] truncate font-semibold text-slate-700">
        {group.primary}{group.secondary ? ` · ${group.secondary}` : ""}
      </div>
      <div className="text-slate-500">
        {metricDefinition(metric).label}: <span className="font-semibold text-slate-800">{formatMetric(group.value, metric)}</span>
      </div>
      <div className="text-slate-500">
        Styles: <span className="font-semibold text-slate-800">{fmtNum(group.styles)}</span>
      </div>
    </div>
  );
};

const AxisTick = ({ x, y, payload }) => {
  const group = payload?.payload;
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={-8} y={-2} textAnchor="end" fill="#475569" fontSize={11}>
        {payload?.value}
      </text>
      {group?.styles != null && (
        <text x={-8} y={11} textAnchor="end" fill="#94a3b8" fontSize={9}>
          {group.styles} styles
        </text>
      )}
    </g>
  );
};

const heatColor = (value, values, metric) => {
  if (value == null) return "#f8fafc";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min;
  const raw = spread === 0 ? 0.72 : (Number(value) - min) / spread;
  const strength = metric === "woc" ? 1 - raw : raw;
  return `rgba(26, 92, 56, ${0.12 + Math.max(0, Math.min(1, strength)) * 0.7})`;
};

function DimensionSelect({ label, value, options, onChange, optional = false }) {
  return (
    <label className="flex min-w-[180px] flex-1 flex-col gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-[#1a5c38]/20"
        data-testid={`attribute-${label.toLowerCase().replaceAll(" ", "-")}-select`}
      >
        {optional && <option value="">None — primary dimension only</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export default function AttributePerformance() {
  const [primaryKey, setPrimaryKey] = useState("fabric_category");
  const [secondaryKey, setSecondaryKey] = useState("");
  const [metric, setMetric] = useState("sor");
  const [includeRetired, setIncludeRetired] = useState(false);
  const [summarySort, setSummarySort] = useState({ key: "sor", direction: "desc" });
  const { styles, loading, error } = useMerchData(["styles"]);
  const styleRows = styles?.styles || [];

  const primary = PRIMARY_DIMENSIONS.find((dimension) => dimension.value === primaryKey) || PRIMARY_DIMENSIONS[0];
  const secondary = SECONDARY_DIMENSIONS.find((dimension) => dimension.value === secondaryKey);
  const fabricSummaryKey = primaryKey === "fabric_subcategory" ? "fabric_subcategory" : "fabric_category";
  const fabricSummaryLabel = fabricSummaryKey === "fabric_subcategory" ? "Fabric subcategory" : "Fabric category";

  useEffect(() => {
    if (primaryKey !== "fabric_category" || !styleRows.length) return;
    const activeRows = styleRows.filter(isActiveStyle);
    const categoryCount = activeRows.filter((row) => tidy(row.fabric_category)).length;
    const subcategoryCount = activeRows.filter((row) => tidy(row.fabric_subcategory)).length;
    if (categoryCount === 0 && subcategoryCount > 0) setPrimaryKey("fabric_subcategory");
  }, [primaryKey, styleRows]);

  // Cross-tab comparisons are most useful for buying decisions when they land
  // on sell-through. Users can still choose another metric after the default.
  useEffect(() => {
    if (secondaryKey) setMetric("sor");
  }, [secondaryKey]);

  const analysis = useMemo(() => {
    const baseRows = includeRetired ? styleRows : styleRows.filter(isActiveStyle);
    const validRows = baseRows.filter((row) => {
      if (!tidy(row[primaryKey])) return false;
      return !secondaryKey || Boolean(tidy(row[secondaryKey]));
    });
    const excluded = baseRows.length - validRows.length;
    const groups = sortGroups(aggregateRows(validRows, primaryKey, secondaryKey, metric), metric);
    return { baseRows, validRows, excluded, groups };
  }, [includeRetired, metric, primaryKey, secondaryKey, styleRows]);

  const activeStyleRows = useMemo(() => styleRows.filter(isActiveStyle), [styleRows]);
  const fabricSummary = useMemo(() => {
    const rows = aggregateFabricBuyingSummary(activeStyleRows, fabricSummaryKey);
    return sortFabricSummary(rows, summarySort);
  }, [activeStyleRows, fabricSummaryKey, summarySort]);

  const heatmap = useMemo(() => {
    if (!secondaryKey) return null;
    const primaryNames = [...new Set(analysis.groups.map((group) => group.primary))];
    const secondaryNames = [...new Set(analysis.groups.map((group) => group.secondary))];
    const lookup = new Map(analysis.groups.map((group) => [`${group.primary}|||${group.secondary}`, group]));
    const values = analysis.groups.map((group) => Number(group.value));
    return { primaryNames, secondaryNames, lookup, values };
  }, [analysis.groups, secondaryKey]);

  if (loading) return <Loading label="Loading attribute performance…" />;
  if (error) return <ErrorBox error={error} />;

  const metricInfo = metricDefinition(metric);
  const includedLabel = includeRetired ? "catalogue styles" : "active styles";
  const missingLabel = secondary
    ? `${primary.label} or ${secondary.label} not populated`
    : `${primary.label} not populated`;
  const setSummarySortKey = (key) => {
    setSummarySort((current) => (
      current.key === key
        ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
        : { key, direction: key === "name" ? "asc" : "desc" }
    ));
  };

  return (
    <div className="space-y-5" data-testid="attribute-performance-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#1a5c38]">Merchandising analysis</div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">Attribute Performance</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted">
            Compare sell-through, stock cover, sales and pricing across the attributes that are actually populated in the product master.
          </p>
        </div>
        <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-600 shadow-sm">
          <input
            type="checkbox"
            checked={includeRetired}
            onChange={(event) => setIncludeRetired(event.target.checked)}
            className="accent-[#1a5c38]"
            data-testid="attribute-include-retired"
          />
          Include retired / archived
        </label>
      </div>

      <ChartCard title="Fabric Buying Summary" className="overflow-hidden" >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[11px] text-slate-500">
              Active styles only · {fabricSummaryLabel.toLowerCase()} is populated before aggregation
            </p>
            <p className="mt-1 text-[11px] font-semibold text-[#1a5c38]" data-testid="fabric-summary-coverage">
              {fmtNum(fabricSummary.reduce((count, row) => count + row.styles, 0))} of {fmtNum(activeStyleRows.length)} active styles have fabric data
            </p>
          </div>
          <div className="text-right text-[10px] text-slate-400">
            <div>Default sort: Period SOR descending</div>
            <div>High SOR + low WOC = buy more · low SOR + high WOC = hold off</div>
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200" data-testid="fabric-buying-summary">
          <table className="min-w-[920px] w-full border-collapse text-left">
            <thead className="bg-slate-50">
              <tr>
                {FABRIC_SUMMARY_COLUMNS.map((column) => {
                  const isSorted = summarySort.key === column.key;
                  return (
                    <th key={column.key} className={`border-b border-slate-200 px-3 py-2 ${column.numeric ? "text-right" : ""}`}>
                      <button
                        type="button"
                        onClick={() => setSummarySortKey(column.key)}
                        className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider ${isSorted ? "text-[#1a5c38]" : "text-slate-400"} hover:text-[#1a5c38]`}
                        data-testid={`fabric-summary-sort-${column.key}`}
                      >
                        {column.label}
                        <span aria-hidden="true">{isSorted ? (summarySort.direction === "desc" ? "↓" : "↑") : "↕"}</span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {fabricSummary.length > 0 ? fabricSummary.map((row) => (
                <tr key={row.name} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/70">
                  <td className="px-3 py-2.5 text-[12px] font-semibold text-slate-700">{row.name}</td>
                  <td className="px-3 py-2.5 text-right text-[12px] text-slate-600">{fmtNum(row.styles)}</td>
                  <td className="px-3 py-2.5 text-right text-[12px] text-slate-600">{fmtNum(row.stock)}</td>
                  <td className={`px-3 py-2.5 text-right text-[12px] ${wocAlertClass(row.woc)}`}>
                    <span className="inline-flex items-center gap-1.5">
                      {Number(row.woc) < 4 && <span aria-label="Critically low WOC" className="h-2 w-2 rounded-full bg-red-500" />}
                      {Number(row.woc) >= 4 && Number(row.woc) < 8 && <span aria-label="Low WOC" className="h-2 w-2 rounded-full bg-amber-500" />}
                      {fmtWoc(row.woc)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-[12px] font-semibold text-[#1a5c38]">{fmtPct1(row.sor)}</td>
                  <td className="px-3 py-2.5 text-right text-[12px] text-slate-600">{fmtPct1(row.full_price)}</td>
                  <td className="px-3 py-2.5 text-right text-[12px] text-slate-600">{fmtKESM(row.revenue)}</td>
                  <td className="px-3 py-2.5 text-right text-[12px] text-slate-600">{fmtNum(row.units)}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={FABRIC_SUMMARY_COLUMNS.length} className="px-4 py-8 text-center text-[12px] text-slate-400">
                    No active styles have populated {fabricSummaryLabel.toLowerCase()} data.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 shadow-sm" data-testid="attribute-controls">
        <div className="flex flex-wrap gap-3">
          <DimensionSelect label="Rows / groups" value={primaryKey} options={PRIMARY_DIMENSIONS} onChange={setPrimaryKey} />
          <DimensionSelect label="Cross-tab / filter" value={secondaryKey} options={SECONDARY_DIMENSIONS} onChange={setSecondaryKey} optional />
          <label className="flex min-w-[180px] flex-1 flex-col gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Metric</span>
            <select
              value={metric}
              onChange={(event) => setMetric(event.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-[#1a5c38]/20"
              data-testid="attribute-metric-select"
            >
              {METRICS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-[#cfe3d5] bg-[#f0f8f1] px-3 py-2 text-[11px] leading-4 text-[#3e6d4f]" data-testid="attribute-population-notice">
          <span aria-hidden="true" className="mt-0.5 text-[13px]">●</span>
          <span>
            Analysing <strong>{fmtNum(analysis.validRows.length)}</strong> of <strong>{fmtNum(analysis.baseRows.length)}</strong> {includedLabel}
            {analysis.excluded > 0
              ? <> — <strong>{fmtNum(analysis.excluded)} excluded</strong>: {missingLabel}</>
              : <> — all selected attribute fields are populated</>}
          </span>
        </div>
      </div>

      {analysis.groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-16 text-center shadow-sm">
          <div className="text-sm font-semibold text-slate-700">No populated attribute combinations found</div>
          <p className="mx-auto mt-1 max-w-md text-[12px] leading-5 text-muted">
            Change the selected dimensions or populate {primary.label.toLowerCase()} in the product master. Blank values are intentionally excluded.
          </p>
        </div>
      ) : secondaryKey ? (
        <ChartCard
          title={`${metricInfo.label} by ${primary.label} × ${secondary.label}`}
          className="overflow-hidden"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-slate-400">SOR is the default cross-tab metric. Darker green indicates stronger performance.</p>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{analysis.groups.length} populated combinations</span>
          </div>
          <div className="overflow-auto rounded-lg border border-slate-200" data-testid="attribute-heatmap">
            <div
              className="grid min-w-[720px]"
              style={{ gridTemplateColumns: `minmax(150px, 1.2fr) repeat(${heatmap.secondaryNames.length}, minmax(92px, 1fr))` }}
            >
              <div className="sticky left-0 z-10 border-b border-r border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {primary.label}
              </div>
              {heatmap.secondaryNames.map((name) => (
                <div key={name} className="border-b border-slate-200 bg-slate-50 px-2 py-2 text-center text-[10px] font-semibold text-slate-500">
                  {name}
                </div>
              ))}
              {heatmap.primaryNames.map((primaryName) => (
                <React.Fragment key={primaryName}>
                  <div className="sticky left-0 z-10 border-b border-r border-slate-200 bg-white px-3 py-3 text-[11px] font-semibold text-slate-700">
                    {primaryName}
                  </div>
                  {heatmap.secondaryNames.map((secondaryName) => {
                    const group = heatmap.lookup.get(`${primaryName}|||${secondaryName}`);
                    return (
                      <div
                        key={`${primaryName}-${secondaryName}`}
                        className="min-h-[54px] border-b border-slate-200 px-2 py-2 text-center"
                        style={{ background: heatColor(group?.value, heatmap.values, metric) }}
                        title={group ? `${formatMetric(group.value, metric)} · ${group.styles} styles` : "No populated styles"}
                      >
                        {group ? (
                          <>
                            <div className="text-[12px] font-bold text-slate-800">{formatMetric(group.value, metric)}</div>
                            <div className="mt-0.5 text-[9px] text-slate-600">{group.styles} styles</div>
                          </>
                        ) : <span className="text-[12px] text-slate-300">—</span>}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
        </ChartCard>
      ) : (
        <ChartCard title={`${metricInfo.label} by ${primary.label}`} className="overflow-hidden">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-slate-400">Ranked best to worst · each bar represents only styles with a populated {primary.label.toLowerCase()}.</p>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{analysis.groups.length} populated groups</span>
          </div>
          <div className="h-[min(68vh,560px)] min-h-[320px]" data-testid="attribute-ranked-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analysis.groups} layout="vertical" margin={{ top: 4, right: 72, left: 136, bottom: 4 }}>
                <CartesianGrid horizontal={false} stroke="#e2e8f0" />
                <XAxis
                  type="number"
                  tick={{ fill: "#94a3b8", fontSize: 10 }}
                  tickFormatter={(value) => formatMetric(value, metric)}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="primary"
                  width={132}
                  tick={<AxisTick />}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip cursor={{ fill: "rgba(26,92,56,.05)" }} content={<AttributeTooltip metric={metric} />} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={22} fill={C.green}>
                  {analysis.groups.map((group) => <Cell key={group.key} fill={metric === "woc" ? "#4e8c67" : C.green} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      )}
    </div>
  );
}