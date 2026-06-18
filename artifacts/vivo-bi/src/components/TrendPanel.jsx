import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine, LabelList,
} from "recharts";
import { api, fmtKES, fmtNum, fmtPct, fmtAxisKES, fmtDelta } from "@/lib/api";
import { Loading, ErrorBox } from "@/components/common";
import {
  ChartLine, ChartBar, Sparkle, DownloadSimple, Trash, Storefront, X as XIcon,
} from "@phosphor-icons/react";

/**
 * A single, self-contained KPI trend panel for the Trend Analysis page.
 *
 * Each panel independently controls:
 *   - which KPI it plots (revenue / net sales / units / orders / footfall /
 *     conversion / ABV / ASP),
 *   - its own granularity (Year / Month / Week),
 *   - its scope (Overall, or a single store).
 *
 * The series for ALL metrics comes from one /analytics/trend-series call, so
 * switching the displayed KPI is instant (no refetch); only changing the
 * bucket or store hits the wire. An on-demand "AI insight" button asks the
 * backend (/analytics/trend-ai) to describe the trend in plain English.
 */

const KPI_OPTIONS = [
  { key: "total_sales",       label: "Revenue (Total Sales)", unit: "kes",   color: "#1a5c38", axisFmt: fmtAxisKES, tipFmt: fmtKES },
  { key: "net_sales",         label: "Net Sales",             unit: "kes",   color: "#0f3d24", axisFmt: fmtAxisKES, tipFmt: fmtKES },
  { key: "units_sold",        label: "Units Sold",            unit: "count", color: "#00897b", axisFmt: fmtNum,     tipFmt: fmtNum },
  { key: "orders",            label: "Transactions (Orders)", unit: "count", color: "#0891b2", axisFmt: fmtNum,     tipFmt: fmtNum },
  { key: "footfall",          label: "Footfall",              unit: "count", color: "#6366f1", axisFmt: fmtNum,     tipFmt: fmtNum },
  { key: "conversion_rate",   label: "Conversion Rate",       unit: "pct",   color: "#9333ea", axisFmt: (v) => `${v}%`, tipFmt: (v) => fmtPct(v, 2) },
  { key: "avg_basket_size",   label: "Avg Basket Value (ABV)",unit: "kes",   color: "#d97706", axisFmt: fmtAxisKES, tipFmt: fmtKES },
  { key: "avg_selling_price", label: "Avg Selling Price (ASP)",unit: "kes",  color: "#b45309", axisFmt: fmtAxisKES, tipFmt: fmtKES },
];

const BUCKET_OPTIONS = [
  { key: "year",  label: "Yearly" },
  { key: "month", label: "Monthly" },
  { key: "week",  label: "Weekly" },
];

const kpiCfg = (key) => KPI_OPTIONS.find((o) => o.key === key) || KPI_OPTIONS[0];

// Trend the AI / summary cares about: % change first→last on the chosen KPI.
function summarize(rows, key) {
  const pts = rows.filter((r) => r[key] !== null && r[key] !== undefined);
  if (pts.length < 2) return null;
  const first = Number(pts[0][key]) || 0;
  const last = Number(pts[pts.length - 1][key]) || 0;
  const pct = first ? ((last - first) / Math.abs(first)) * 100 : null;
  let peak = pts[0], trough = pts[0];
  for (const r of pts) {
    if (Number(r[key]) > Number(peak[key])) peak = r;
    if (Number(r[key]) < Number(trough[key])) trough = r;
  }
  const avg = pts.reduce((a, r) => a + (Number(r[key]) || 0), 0) / pts.length;
  return { first, last, pct, peak, trough, avg, n: pts.length };
}

const TrendPanel = ({
  dateFrom, dateTo, countries, dataVersion, stores = [],
  onRemove, removable = true,
  initialKpi = "total_sales", initialBucket = "month",
}) => {
  const [kpi, setKpi] = useState(initialKpi);
  const [bucket, setBucket] = useState(initialBucket);
  const [store, setStore] = useState(""); // "" = Overall
  const [chartType, setChartType] = useState("line"); // line | bar

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [ai, setAi] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);

  const countryParam = useMemo(
    () => (countries && countries.length ? countries.join(",") : undefined),
    [countries]
  );

  // Footfall / conversion are not country-attributable in the sensor feed, so
  // a country filter cannot scope them — flag that to the user.
  const ffMetric = kpi === "footfall" || kpi === "conversion_rate";
  const countryCaveat = ffMetric && !store && countryParam;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAi(null);
    setAiError(null);
    api
      .get("/analytics/trend-series", {
        params: {
          date_from: dateFrom, date_to: dateTo,
          country: store ? undefined : countryParam,
          store: store || undefined,
          bucket,
        },
      })
      .then((r) => { if (!cancelled) setRows(Array.isArray(r.data) ? r.data : []); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || e?.message || "Failed to load trend"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dateFrom, dateTo, countryParam, store, bucket, dataVersion]);

  // Clear any AI narrative when the displayed metric changes — it described
  // the previous KPI.
  useEffect(() => { setAi(null); setAiError(null); }, [kpi]);

  const cfg = kpiCfg(kpi);
  const chartData = useMemo(
    () => rows.map((r) => ({ label: r.label, date: r.date, value: r[kpi] ?? null })),
    [rows, kpi]
  );
  const stats = useMemo(() => summarize(rows, kpi), [rows, kpi]);

  const scopeLabel = store
    ? store
    : (countries && countries.length ? countries.join(", ") : "All markets");

  const generateAi = useCallback(() => {
    if (!chartData.length) return;
    setAiLoading(true);
    setAiError(null);
    api
      .post("/analytics/trend-ai", {
        metric_label: cfg.label,
        unit: cfg.unit,
        bucket,
        scope_label: scopeLabel,
        points: chartData
          .filter((p) => p.value !== null && p.value !== undefined)
          .map((p) => ({ label: p.label, value: p.value })),
      })
      .then((r) => {
        const d = r.data || {};
        if (d.available && d.narrative) setAi(d);
        else setAiError(
          d.reason === "ai_not_configured"
            ? "AI insights are not configured on the server."
            : d.reason === "not_enough_points"
              ? "Need at least two points to summarize."
              : "Couldn't generate an insight right now."
        );
      })
      .catch((e) => setAiError(e?.response?.data?.detail || e?.message || "AI request failed"))
      .finally(() => setAiLoading(false));
  }, [chartData, cfg.label, cfg.unit, bucket, scopeLabel]);

  const exportCsv = useCallback(() => {
    if (!chartData.length) return;
    const head = ["period", "date", cfg.label];
    const lines = [head.join(",")];
    for (const r of chartData) {
      lines.push([`"${r.label}"`, r.date, r.value ?? ""].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trend_${kpi}_${bucket}_${(store || "overall").replace(/\s+/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [chartData, cfg.label, kpi, bucket, store]);

  const deltaCls = stats && stats.pct != null
    ? (stats.pct > 0.05 ? "text-[#059669]" : stats.pct < -0.05 ? "text-[#dc2626]" : "text-muted")
    : "text-muted";
  const arrow = stats && stats.pct != null
    ? (stats.pct > 0.05 ? "▲" : stats.pct < -0.05 ? "▼" : "—")
    : "";

  return (
    <div className="card-white p-5 flex flex-col" data-testid="trend-panel">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          className="input-pill text-[12px] font-semibold"
          value={kpi}
          onChange={(e) => setKpi(e.target.value)}
          data-testid="trend-kpi-select"
          aria-label="KPI"
        >
          {KPI_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>

        <div className="inline-flex rounded-full border border-border overflow-hidden" data-testid="trend-bucket">
          {BUCKET_OPTIONS.map((b) => {
            const active = bucket === b.key;
            return (
              <button
                key={b.key}
                type="button"
                onClick={() => setBucket(b.key)}
                data-testid={`trend-bucket-${b.key}`}
                className={`px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                  active ? "bg-[#1a5c38] text-white" : "bg-white text-[#374151] hover:bg-[#f3f4f6]"
                }`}
                title={`Group by ${b.label.toLowerCase()}`}
              >
                {b.label}
              </button>
            );
          })}
        </div>

        <div className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5">
          <Storefront size={13} className="text-muted shrink-0" />
          <select
            className="bg-transparent text-[11.5px] font-medium outline-none max-w-[150px]"
            value={store}
            onChange={(e) => setStore(e.target.value)}
            data-testid="trend-store-select"
            aria-label="Store scope"
          >
            <option value="">Overall</option>
            {stores.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="inline-flex rounded-full border border-border overflow-hidden ml-auto" data-testid="trend-charttype">
          <button
            type="button"
            onClick={() => setChartType("line")}
            className={`px-2 py-1 transition-colors ${chartType === "line" ? "bg-[#1a5c38] text-white" : "bg-white text-[#374151] hover:bg-[#f3f4f6]"}`}
            title="Line chart"
            aria-label="Line chart"
          >
            <ChartLine size={14} />
          </button>
          <button
            type="button"
            onClick={() => setChartType("bar")}
            className={`px-2 py-1 transition-colors ${chartType === "bar" ? "bg-[#1a5c38] text-white" : "bg-white text-[#374151] hover:bg-[#f3f4f6]"}`}
            title="Bar chart"
            aria-label="Bar chart"
          >
            <ChartBar size={14} />
          </button>
        </div>

        <button
          type="button"
          onClick={exportCsv}
          disabled={!chartData.length}
          className="p-1.5 rounded-full border border-border text-muted hover:text-[#1a5c38] disabled:opacity-40"
          title="Export CSV"
          aria-label="Export CSV"
          data-testid="trend-export"
        >
          <DownloadSimple size={14} />
        </button>

        {removable && (
          <button
            type="button"
            onClick={onRemove}
            className="p-1.5 rounded-full border border-border text-muted hover:text-[#dc2626]"
            title="Remove panel"
            aria-label="Remove panel"
            data-testid="trend-remove"
          >
            <Trash size={14} />
          </button>
        )}
      </div>

      {/* Headline + delta */}
      <div className="flex items-end justify-between gap-3 mb-2">
        <div>
          <div className="eyebrow">{cfg.label} · {scopeLabel}</div>
          {stats && (
            <div className="flex items-baseline gap-2">
              <span className="text-[20px] font-bold num text-foreground">{cfg.tipFmt(stats.last)}</span>
              {stats.pct != null && (
                <span className={`text-[12.5px] font-semibold num ${deltaCls}`}>
                  {arrow} {fmtDelta(stats.pct)}
                  <span className="text-muted font-normal"> over period</span>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="text-[11px] text-muted text-right">
          {stats ? `${stats.n} ${bucket === "day" ? "days" : bucket + "s"}` : ""}
          {stats && (
            <div>avg {cfg.tipFmt(stats.avg)}</div>
          )}
        </div>
      </div>

      {countryCaveat && (
        <div className="text-[10.5px] text-[#b45309] bg-[#fffbeb] border border-[#fcd34d]/50 rounded-md px-2 py-1 mb-2">
          Footfall sensors aren't tagged by country — this {cfg.label.toLowerCase()} reflects all stores. Pick a single store to scope it precisely.
        </div>
      )}

      {/* Chart */}
      <div className="flex-1">
        {loading && <Loading label="Loading trend…" />}
        {error && <ErrorBox message={error} />}
        {!loading && !error && chartData.length === 0 && (
          <div className="py-12 text-center text-[12px] text-muted">No data for this window.</div>
        )}
        {!loading && !error && chartData.length > 0 && (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 14, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f0" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10 }}
                stroke="#9ca3af"
                interval="preserveStartEnd"
                minTickGap={18}
              />
              <YAxis tick={{ fontSize: 10 }} stroke="#9ca3af" tickFormatter={cfg.axisFmt} width={48} />
              {stats && (
                <ReferenceLine y={stats.avg} stroke="#cbd5e1" strokeDasharray="4 4" />
              )}
              <Tooltip
                formatter={(v) => [v == null ? "—" : cfg.tipFmt(v), cfg.label]}
                labelFormatter={(_, payload) => {
                  const p = payload && payload[0] && payload[0].payload;
                  if (!p) return "";
                  return p.date ? `${p.label} · ${p.date}` : p.label;
                }}
                contentStyle={{ borderRadius: 8, fontSize: 12, border: "1px solid #d1d5db" }}
              />
              {chartType === "line" ? (
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={cfg.color}
                  strokeWidth={2.5}
                  dot={chartData.length <= 40 ? { r: 3, fill: cfg.color } : false}
                  activeDot={{ r: 5 }}
                  isAnimationActive={false}
                  connectNulls
                  name={cfg.label}
                >
                  {chartData.length <= 16 && (
                    <LabelList
                      dataKey="value"
                      position="top"
                      formatter={(v) => (v == null ? "" : cfg.axisFmt(v))}
                      style={{ fontSize: 9, fill: "#6b7280" }}
                    />
                  )}
                </Line>
              ) : (
                <Bar dataKey="value" fill={cfg.color} radius={[3, 3, 0, 0]} isAnimationActive={false} name={cfg.label}>
                  {chartData.length <= 16 && (
                    <LabelList
                      dataKey="value"
                      position="top"
                      formatter={(v) => (v == null ? "" : cfg.axisFmt(v))}
                      style={{ fontSize: 9, fill: "#6b7280" }}
                    />
                  )}
                </Bar>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* AI narrative */}
      <div className="mt-3 pt-3 border-t border-border">
        {!ai && (
          <button
            type="button"
            onClick={generateAi}
            disabled={aiLoading || chartData.length < 2}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#1a5c38] hover:underline disabled:opacity-40 disabled:no-underline"
            data-testid="trend-ai-btn"
          >
            <Sparkle size={14} weight="fill" />
            {aiLoading ? "Analyzing trend…" : "Generate AI insight"}
          </button>
        )}
        {aiError && (
          <div className="text-[11.5px] text-muted mt-1">{aiError}</div>
        )}
        {ai && (
          <div className="relative" data-testid="trend-ai-text">
            <div className="flex items-center gap-1.5 mb-1">
              <Sparkle size={13} weight="fill" className="text-[#1a5c38]" />
              <span className="eyebrow">AI insight</span>
              <button
                type="button"
                onClick={() => setAi(null)}
                className="ml-auto text-muted hover:text-foreground"
                title="Dismiss"
                aria-label="Dismiss insight"
              >
                <XIcon size={13} />
              </button>
            </div>
            <p className="text-[12.5px] leading-relaxed text-foreground/90">{ai.narrative}</p>
            <button
              type="button"
              onClick={generateAi}
              disabled={aiLoading}
              className="mt-1.5 text-[11px] text-muted underline hover:text-[#1a5c38] disabled:opacity-40"
            >
              {aiLoading ? "Regenerating…" : "Regenerate"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default TrendPanel;
