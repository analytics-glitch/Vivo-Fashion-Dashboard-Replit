import React, { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, fmtKES, fmtKESLong, fmtNum, fmtPct, fmtAxisKES } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { useMerchFilters } from "./MerchandisingHub";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  ComposedChart, Line, Cell, PieChart, Pie, Legend, LabelList,
  ReferenceLine,
} from "recharts";
import {
  CurrencyCircleDollar, ChartBar, Percent, Tag, TrendUp,
} from "@phosphor-icons/react";

// ── colour palette ───────────────────────────────────────────────────────────
const BRAND_COLORS = ["#1a5c38", "#00c853", "#4b7bec", "#d97706", "#7c3aed"];
const TIER_COLORS  = { "Tier 1": "#1a5c38", "Tier 2": "#00c853", "Tier 3": "#4b7bec", "Tier 4": "#d97706" };
const DONUT_COLORS = ["#1a5c38", "#00c853", "#4b7bec", "#d97706", "#ef4444"];
const PRICE_BUCKETS = ["<KES 2K", "2K–4K", "4K–6K", "6K–8K", ">8K"];

// ── custom tooltip ───────────────────────────────────────────────────────────
const ChartTip = ({ active, payload, label, isKES, isPct }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-border rounded-lg shadow-lg p-2.5 text-[11.5px] max-w-[220px]">
      <div className="font-semibold text-foreground mb-1 truncate">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color || p.fill }} />
          <span className="text-muted">{p.name}:</span>
          <span className="font-semibold tabular-nums">
            {isPct ? fmtPct(p.value) : isKES ? fmtAxisKES(p.value) : fmtNum(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

// ── price bucket helper ───────────────────────────────────────────────────────
function priceBuckets(styles) {
  const buckets = [0, 0, 0, 0, 0];
  for (const s of styles) {
    const p = s.full_price || 0;
    if (p < 2000)       buckets[0]++;
    else if (p < 4000)  buckets[1]++;
    else if (p < 6000)  buckets[2]++;
    else if (p < 8000)  buckets[3]++;
    else                buckets[4]++;
  }
  return PRICE_BUCKETS.map((name, i) => ({ name, value: buckets[i] })).filter(d => d.value > 0);
}

// ── main component ────────────────────────────────────────────────────────────
const MerchFinancial = () => {
  const filters = useMerchFilters();
  const params = { ...filters };

  const [summary, setSummary]   = useState(null);
  const [subcat, setSubcat]     = useState([]);
  const [brands, setBrands]     = useState([]);
  const [tiers, setTiers]       = useState([]);
  const [styles, setStyles]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch("/merch/summary",       { params }),
      apiFetch("/merch/by-subcategory",{ params }),
      apiFetch("/merch/by-brand",      { params }),
      apiFetch("/merch/by-tier",       { params }),
      apiFetch("/merch/styles",        { params }),
    ])
      .then(([sum, sub, br, ti, st]) => {
        if (cancelled) return;
        setSummary(sum);
        setSubcat((sub.rows || []).sort((a, b) => b.revenue_6m - a.revenue_6m));
        setBrands(br.rows || []);
        setTiers(ti.rows || []);
        setStyles(st.styles || []);
      })
      .catch(e => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.from_date, filters.to_date, filters.country, filters.dataVersion]);

  // ── derived KPIs ─────────────────────────────────────────────────────────
  const lifetimeRev = useMemo(() =>
    styles.reduce((s, r) => s + (r.revenue_life || 0), 0), [styles]);

  const avgFullPrice = useMemo(() => {
    const valid = styles.filter(s => s.full_price > 0);
    if (!valid.length) return 0;
    return valid.reduce((a, b) => a + b.full_price, 0) / valid.length;
  }, [styles]);

  const avgSellPrice = useMemo(() => {
    const valid = styles.filter(s => s.avg_selling_price > 0);
    if (!valid.length) return 0;
    return valid.reduce((a, b) => a + b.avg_selling_price, 0) / valid.length;
  }, [styles]);

  const priceReal = avgFullPrice > 0 ? (avgSellPrice / avgFullPrice) * 100 : 0;

  // ── chart data ─────────────────────────────────────────────────────────────
  const subcatChart = subcat.slice(0, 9).map(r => ({
    name: r.subcategory || "—",
    revenue: +(r.revenue_6m / 1e6).toFixed(1),
  }));

  // Pre-group styles by brand once for brand chart calculations
  const stylesByBrand = useMemo(() => {
    const map = {};
    styles.forEach(s => {
      if (!s.brand) return;
      if (!map[s.brand]) map[s.brand] = [];
      map[s.brand].push(s);
    });
    return map;
  }, [styles]);

  const brandRealChart = brands.slice(0, 5).map(r => {
    const brandStyles = stylesByBrand[r.brand] || [];
    const validFP    = brandStyles.filter(s => s.full_price > 0);
    const validSell  = brandStyles.filter(s => s.avg_selling_price > 0);
    return {
      name: r.brand || "—",
      fullPrice:   +(validFP.length   ? validFP.reduce((a, b) => a + b.full_price, 0) / validFP.length / 1000 : 0).toFixed(2),
      avgSelling:  +(validSell.length ? validSell.reduce((a, b) => a + b.avg_selling_price, 0) / validSell.length / 1000 : 0).toFixed(2),
      realisation: +(r.avg_full_price_pct || 0),
      // Gross margin % is only available for styles where cost data exists;
      // null means no cost data for this brand.
      grossMargin: r.avg_gross_margin_pct != null ? +r.avg_gross_margin_pct.toFixed(1) : null,
    };
  });

  const tierAvgRevChart = tiers.map(r => ({
    name: r.tier,
    avgRev: r.style_count > 0 ? +((r.revenue_6m / r.style_count) / 1e6).toFixed(3) : 0,
    label: r.style_count > 0 ? fmtKES(r.revenue_6m / r.style_count) : "—",
  }));

  // Aggregate lifetime revenue per brand from the per-style records (which do
  // carry revenue_life). The /merch/by-brand endpoint does not return a
  // brand-level lifetime aggregate, so we roll it up client-side.
  const brandLifetimeMap = useMemo(() => {
    const map = {};
    styles.forEach(s => {
      if (!s.brand) return;
      map[s.brand] = (map[s.brand] || 0) + (s.revenue_life || 0);
    });
    return map;
  }, [styles]);

  const lifetimeVs6mChart = brands.slice(0, 5).map(r => ({
    name: r.brand || "—",
    lifetime: +((brandLifetimeMap[r.brand] || 0) / 1e6).toFixed(1),
    sixm: +(r.revenue_6m / 1e6).toFixed(1),
  }));

  const donutData = useMemo(() => priceBuckets(styles), [styles]);

  if (loading) return <Loading label="Loading Financial Performance…" />;
  if (error)   return <ErrorBox message={error} />;

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div>
        <h2 className="text-[22px] font-bold text-foreground">Financial Performance</h2>
        <p className="text-[12px] text-muted mt-0.5">
          Revenue, Pricing &amp; Margin Performance · All Brands · As at {new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
          {summary?.avg_gross_margin_pct != null && (
            <span className="ml-2 text-emerald-700 font-medium">· Portfolio GM {fmtPct(summary.avg_gross_margin_pct)}</span>
          )}
        </p>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KPICard
          label="Total Revenue (6m)"
          value={fmtKES(summary?.revenue_6m)}
          valueFull={fmtKESLong(summary?.revenue_6m)}
          sub={`Across ${fmtNum(summary?.total_styles)} styles`}
          icon={CurrencyCircleDollar}
          accent
          showDelta={false}
          testId="fin-rev-6m"
        />
        <KPICard
          label="Revenue (Lifetime)"
          value={fmtKES(lifetimeRev) + "+"}
          valueFull={fmtKESLong(lifetimeRev)}
          sub="Since first launch"
          icon={TrendUp}
          accent
          showDelta={false}
          testId="fin-rev-life"
        />
        <KPICard
          label="Avg Full Price"
          value={fmtKES(avgFullPrice)}
          sub="Portfolio average"
          icon={Tag}
          accent
          showDelta={false}
          testId="fin-avg-full"
        />
        <KPICard
          label="Avg Selling Price"
          value={fmtKES(avgSellPrice)}
          sub="Incl. discounts"
          icon={ChartBar}
          accent
          showDelta={false}
          testId="fin-avg-sell"
        />
        <KPICard
          label="Price Realisation"
          value={fmtPct(priceReal)}
          sub="Avg/Full price ratio"
          icon={Percent}
          accent
          showDelta={false}
          testId="fin-price-real"
        />
      </div>

      {/* Row 1: Revenue by Subcategory + Price Realisation by Brand */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Revenue by Subcategory — takes 3/5 */}
        <div className="lg:col-span-3 card-white p-5">
          <SectionTitle title="Revenue by Subcategory (6m)" subtitle="KES Millions" />
          {subcatChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={subcatChart} margin={{ top: 16, right: 8, left: 0, bottom: 60 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" interval={0} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v + "M"} />
                  <Tooltip content={<ChartTip isKES={false} />}
                    formatter={(v) => [v + "M", "Revenue"]} />
                  <Bar dataKey="revenue" name="Revenue (KES M)" fill="#1a5c38" radius={[3, 3, 0, 0]}>
                    <LabelList dataKey="revenue" position="top" style={{ fontSize: 9, fill: "#555" }}
                      formatter={v => v + "M"} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* Price Realisation by Brand — takes 2/5 */}
        <div className="lg:col-span-2 card-white p-5">
          <SectionTitle title="Price Realisation by Brand" />
          {brandRealChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={brandRealChart} margin={{ top: 16, right: 40, left: 0, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 10 }} tickFormatter={v => v + "K"}
                    label={{ value: "Price KES (000s)", angle: -90, position: "insideLeft", style: { fontSize: 9 } }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }}
                    tickFormatter={v => v + "%"}
                    label={{ value: "Realisation %", angle: 90, position: "insideRight", style: { fontSize: 9 } }} />
                  <Tooltip
                    formatter={(v, name) => {
                      if (v == null) return ["—", name];
                      if (name === "Realisation %" || name === "Gross Margin %") return [fmtPct(v), name];
                      return ["KES " + (v * 1000).toLocaleString(), name];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
                  <Bar yAxisId="left" dataKey="fullPrice" name="Full Price (KES 000s)" fill="#1a5c38" radius={[3, 3, 0, 0]} />
                  <Bar yAxisId="left" dataKey="avgSelling" name="Avg Selling Price" fill="#4b7bec" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="realisation" name="Realisation %"
                    stroke="#d97706" strokeWidth={2} strokeDasharray="6 3" dot={{ r: 4 }} />
                  {/* Gross margin line — only rendered where cost data is available (null = no cost) */}
                  <Line yAxisId="right" type="monotone" dataKey="grossMargin" name="Gross Margin %"
                    stroke="#00b894" strokeWidth={2} strokeDasharray="3 3" dot={{ r: 3 }}
                    connectNulls={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
        </div>
      </div>

      {/* Row 2: Avg Revenue per Style by Tier + Lifetime vs 6m by Brand + Full Price Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Avg Revenue per Style by Tier — 4/12 */}
        <div className="lg:col-span-3 card-white p-5">
          <SectionTitle title="Avg Revenue per Style by Tier (6m)" subtitle="KES M per style" />
          {tierAvgRevChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={tierAvgRevChart} margin={{ top: 28, right: 8, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v + "M"}
                    label={{ value: "KES M per Style", angle: -90, position: "insideLeft", style: { fontSize: 9 } }} />
                  <Tooltip formatter={(v) => [fmtKES(v * 1e6), "Avg Revenue"]} />
                  <Bar dataKey="avgRev" name="Avg Revenue" radius={[3, 3, 0, 0]}>
                    {tierAvgRevChart.map((entry, i) => (
                      <Cell key={i} fill={TIER_COLORS[entry.name] || "#4b7bec"} />
                    ))}
                    <LabelList dataKey="label" position="top" style={{ fontSize: 9, fill: "#555" }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* Lifetime vs 6m Revenue by Brand — 6/12 */}
        <div className="lg:col-span-6 card-white p-5">
          <SectionTitle title="Lifetime vs 6m Revenue by Brand" subtitle="KES Millions" />
          {lifetimeVs6mChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={lifetimeVs6mChart} margin={{ top: 16, right: 8, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v + "M"} />
                  <Tooltip formatter={(v, name) => [v + "M", name]} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="lifetime" name="Lifetime Revenue (KES M)" fill="#1a5c38" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="sixm" name="6m Revenue (KES M)" fill="#00c853" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* Full Price Distribution Donut — 3/12 */}
        <div className="lg:col-span-3 card-white p-5">
          <SectionTitle title="Full Price Distribution" />
          {donutData.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={donutData}
                    cx="50%"
                    cy="45%"
                    innerRadius={55}
                    outerRadius={85}
                    dataKey="value"
                    nameKey="name"
                    label={({ name, percent }) => `${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                  >
                    {donutData.map((_, i) => (
                      <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, name) => [v + " styles", name]} />
                  <Legend
                    layout="vertical"
                    align="right"
                    verticalAlign="middle"
                    wrapperStyle={{ fontSize: 10 }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
        </div>
      </div>
    </div>
  );
};

export default MerchFinancial;
