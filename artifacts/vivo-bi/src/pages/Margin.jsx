import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartLine, Info } from "@phosphor-icons/react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { api, fmtKES, fmtKESLong } from "@/lib/api";
import { useFilters } from "@/lib/filters";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import { exportCSV } from "@/components/SortableTable";

const DIMS = [
  { key: "category", label: "Category" },
  { key: "subcategory", label: "Subcategory" },
  { key: "brand", label: "Brand" },
  { key: "store", label: "Store" },
  { key: "month", label: "Month" },
];

const BRAND_GREEN = "#1a5c38";
const CHART_COLORS = [
  "#1a5c38", "#2e7d4f", "#3d9966", "#d97706", "#b45309",
  "#7c3aed", "#4b7bec", "#00c853", "#e53e3e", "#718096",
  "#9f7aea", "#ed8936", "#38a169", "#e53e3e", "#667eea",
];

const pct = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);
const num = (v) => (v == null ? 0 : Number(v));
const fmtUnits = (v) => (v == null ? "—" : Number(v).toLocaleString());

const SORT_COLS = [
  { key: "dim",           label: "Dimension",     align: "left"  },
  { key: "units",         label: "Units",          align: "right" },
  { key: "gross",         label: "Gross Sales",    align: "right", kes: true },
  { key: "discounts",     label: "Discounts",      align: "right", kes: true },
  { key: "discount_rate", label: "Disc. Rate %",   align: "right" },
  { key: "net_revenue",   label: "Net Revenue",    align: "right", kes: true },
  { key: "cogs",          label: "COGS",           align: "right", kes: true },
  { key: "gross_margin",  label: "Gross Margin",   align: "right", kes: true },
  { key: "margin_pct",    label: "Margin %",       align: "right" },
  { key: "cost_coverage", label: "Cost Coverage %", align: "right" },
];

function SortHeader({ col, sortKey, sortAsc, onSort }) {
  const active = sortKey === col.key;
  return (
    <th
      className={`whitespace-nowrap cursor-pointer select-none px-2 py-2.5 text-[11.5px] font-semibold ${
        col.align === "right" ? "text-right" : "text-left"
      } hover:text-brand transition-colors`}
      onClick={() => onSort(col.key)}
    >
      {col.label}
      {active && (
        <span className="ml-0.5 text-brand">{sortAsc ? " ▲" : " ▼"}</span>
      )}
    </th>
  );
}

const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-white border border-border rounded-lg shadow-lg px-3 py-2 text-[12px]">
      <div className="font-semibold mb-1">{d.dim}</div>
      <div className="text-muted">Gross Margin: <span className="text-foreground font-medium">{fmtKESLong(d.gross_margin)}</span></div>
      <div className="text-muted">Margin %: <span className="text-foreground font-medium">{pct(d.margin_pct)}</span></div>
    </div>
  );
};

export default function Margin() {
  const { applied } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion } = applied;
  const [dim, setDim] = useState("category");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState("net_revenue");
  const [sortAsc, setSortAsc] = useState(false);

  const fetchRef = useRef(0);

  const load = useCallback(() => {
    const id = ++fetchRef.current;
    setLoading(true);
    setError(null);
    const params = {
      dim,
      date_from: dateFrom,
      date_to: dateTo,
      ...(countries.length ? { country: countries.join(",") } : {}),
      ...(channels.length ? { channel: channels.join(",") } : {}),
    };
    api
      .get("/analytics/margin", { params })
      .then((r) => {
        if (fetchRef.current !== id) return;
        setRows(r.data?.rows || r.data || []);
        setLoading(false);
      })
      .catch((e) => {
        if (fetchRef.current !== id) return;
        setError(e?.response?.data?.detail || e?.message || "Failed to load margin data");
        setLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dim, dateFrom, dateTo, JSON.stringify(countries), JSON.stringify(channels), dataVersion]);

  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() => {
    const d = [...rows];
    d.sort((a, b) => {
      const av = a[sortKey] ?? (sortKey === "dim" ? "" : -Infinity);
      const bv = b[sortKey] ?? (sortKey === "dim" ? "" : -Infinity);
      if (typeof av === "string") return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortAsc ? av - bv : bv - av;
    });
    return d;
  }, [rows, sortKey, sortAsc]);

  const onSort = (key) => {
    if (sortKey === key) setSortAsc((a) => !a);
    else { setSortKey(key); setSortAsc(false); }
  };

  const summary = useMemo(() => {
    if (!rows.length) return null;
    const totalNet = rows.reduce((s, r) => s + num(r.net_revenue), 0);
    const totalMargin = rows.reduce((s, r) => s + num(r.gross_margin), 0);
    const totalCosted = rows.reduce((s, r) => s + num(r.cogs) + num(r.gross_margin), 0);
    const weightedMarginPct = totalCosted > 0 ? (totalMargin / totalCosted) * 100 : null;
    const avgCoverage = rows.length > 0
      ? rows.reduce((s, r) => s + num(r.cost_coverage), 0) / rows.length
      : null;
    return { totalNet, totalMargin, weightedMarginPct, avgCoverage };
  }, [rows]);

  const chartRows = useMemo(
    () => sorted.slice(0, 15).filter((r) => num(r.gross_margin) !== 0),
    [sorted]
  );

  const doExport = () => {
    const cols = SORT_COLS.map((c) => ({
      key: c.key,
      label: c.label,
      csv: c.kes ? (r) => String(num(r[c.key])) : undefined,
    }));
    exportCSV(sorted, cols, `margin-analysis-${dim}.csv`);
  };

  const dimLabel = DIMS.find((d) => d.key === dim)?.label || dim;

  return (
    <div className="space-y-5" data-testid="margin-page">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight flex items-center gap-2">
            <ChartLine size={22} weight="duotone" className="text-brand" />
            Margin Analysis
          </h1>
          <p className="text-[13px] text-muted mt-1">
            Gross margin, discount rate and cost coverage by {dimLabel.toLowerCase()} — KES
          </p>
        </div>
      </div>

      {/* Dimension selector */}
      <div className="flex flex-wrap items-center gap-1.5">
        {DIMS.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => setDim(d.key)}
            data-testid={`margin-dim-${d.key}`}
            className={`text-[12.5px] font-semibold px-3 py-1.5 rounded-full border transition-colors ${
              dim === d.key
                ? "bg-brand text-white border-brand"
                : "border-border text-muted hover:text-brand hover:border-brand bg-white"
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      {/* KPI strip */}
      {summary && !loading && !error && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Net Revenue", value: fmtKESLong(summary.totalNet), sub: fmtKES(summary.totalNet) },
            { label: "Gross Margin", value: fmtKESLong(summary.totalMargin), sub: fmtKES(summary.totalMargin) },
            { label: "Weighted Margin %", value: summary.weightedMarginPct != null ? `${summary.weightedMarginPct.toFixed(1)}%` : "—", sub: "over costed units" },
            { label: "Avg Cost Coverage", value: summary.avgCoverage != null ? `${summary.avgCoverage.toFixed(0)}%` : "—", sub: "of units with known cost" },
          ].map((k) => (
            <div key={k.label} className="card-white p-3.5">
              <div className="text-[11px] text-muted uppercase tracking-wide mb-1">{k.label}</div>
              <div className="text-[18px] font-bold tabular-nums tracking-tight">{k.value}</div>
              <div className="text-[11px] text-muted mt-0.5">{k.sub}</div>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <Loading label="Loading margin data…" />
      ) : error ? (
        <ErrorBox message={error} retry={load} />
      ) : rows.length === 0 ? (
        <div className="card-white p-10 text-center">
          <p className="text-[14px] text-muted">No margin data for the selected filters.</p>
          <p className="text-[12px] text-muted mt-1">
            Margin analysis requires product master cost data. Try a broader date range or remove country/channel filters.
          </p>
        </div>
      ) : (
        <>
          {/* Bar chart — top 15 by current sort */}
          {chartRows.length > 0 && (
            <div className="card-white p-4">
              <SectionTitle
                title={`Gross Margin by ${dimLabel} (top ${chartRows.length})`}
                subtitle="KES — sorted by current table order"
              />
              <div style={{ height: Math.max(220, chartRows.length * 28) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartRows}
                    layout="vertical"
                    margin={{ top: 4, right: 24, bottom: 4, left: 8 }}
                  >
                    <XAxis
                      type="number"
                      tickFormatter={(v) => fmtKES(v)}
                      tick={{ fontSize: 10 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="dim"
                      width={110}
                      tick={{ fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v) => (String(v).length > 14 ? `${String(v).slice(0, 14)}…` : v)}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="gross_margin" radius={[0, 3, 3, 0]}>
                      {chartRows.map((_, i) => (
                        <Cell
                          key={i}
                          fill={num(chartRows[i]?.gross_margin) >= 0 ? CHART_COLORS[i % CHART_COLORS.length] : "#e53e3e"}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Data table */}
          <div className="card-white p-4">
            <SectionTitle
              title={`Breakdown by ${dimLabel}`}
              subtitle={`${sorted.length} ${dimLabel.toLowerCase()}${sorted.length !== 1 ? "s" : ""} · KES · click a column header to sort`}
              action={
                <button
                  type="button"
                  onClick={doExport}
                  className="inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-brand px-2 py-1 rounded border border-border hover:border-brand"
                  data-testid="margin-export"
                >
                  Export CSV
                </button>
              }
            />
            <div className="overflow-auto" style={{ maxHeight: "70vh" }}>
              <table className="w-full data" data-testid="margin-table">
                <thead>
                  <tr>
                    {SORT_COLS.map((col) => (
                      <SortHeader
                        key={col.key}
                        col={col}
                        sortKey={sortKey}
                        sortAsc={sortAsc}
                        onSort={onSort}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr key={`${r.dim}-${i}`} className="hover:bg-panel/30 transition-colors">
                      <td className="px-2 py-2 text-[12.5px] font-medium max-w-[160px] truncate" title={r.dim}>
                        {r.dim || "—"}
                      </td>
                      <td className="px-2 py-2 text-right text-[12.5px] tabular-nums">{fmtUnits(r.units)}</td>
                      <td className="px-2 py-2 text-right text-[12.5px] tabular-nums">{fmtKES(r.gross)}</td>
                      <td className="px-2 py-2 text-right text-[12.5px] tabular-nums">{fmtKES(r.discounts)}</td>
                      <td className="px-2 py-2 text-right text-[12.5px] tabular-nums">{pct(r.discount_rate)}</td>
                      <td className="px-2 py-2 text-right text-[12.5px] tabular-nums font-medium">{fmtKES(r.net_revenue)}</td>
                      <td className="px-2 py-2 text-right text-[12.5px] tabular-nums">{fmtKES(r.cogs)}</td>
                      <td className={`px-2 py-2 text-right text-[12.5px] tabular-nums font-semibold ${
                        num(r.gross_margin) < 0 ? "text-red-600" : "text-brand"
                      }`}>
                        {fmtKES(r.gross_margin)}
                      </td>
                      <td className={`px-2 py-2 text-right text-[12.5px] tabular-nums font-semibold ${
                        num(r.margin_pct) < 0 ? "text-red-600" : ""
                      }`}>
                        {pct(r.margin_pct)}
                      </td>
                      <td className="px-2 py-2 text-right text-[12.5px] tabular-nums text-muted">
                        {r.cost_coverage != null ? `${num(r.cost_coverage)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Cost coverage footnote */}
            <div className="flex items-start gap-1.5 mt-3 text-[11.5px] text-muted border-t border-border pt-3">
              <Info size={13} className="mt-0.5 shrink-0 text-amber-600" />
              <span>
                <strong className="text-foreground">Cost coverage note:</strong> Gross Margin and Margin % are calculated
                over the costed subset of units (those with a known landed cost in the product master). The{" "}
                <em>Cost Coverage %</em> column shows the fraction of units in each {dimLabel.toLowerCase()} that have a
                known cost — rows with low coverage should be interpreted with care.
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
