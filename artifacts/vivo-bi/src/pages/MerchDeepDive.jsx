/**
 * MerchDeepDive — Style Deep Dive tab (tab 11, ?tab=merch-deepdive)
 *
 * Reads ?style= from the URL. Fetches:
 *   • /api/merch/styles?style_number=X   → style metadata
 *   • /api/merch/style-sales-weekly?style_number=X  → 52-week weekly data
 *   • /api/merch/by-subcategory          → subcategory peer data (for percentile)
 */
import React, { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, fmtKES, fmtKESLong, fmtNum, fmtPct, fmtDate } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { useMerchFilters } from "./MerchandisingHub";
import MerchStyleSearch, { loadStyles } from "./MerchStyleSearch";
import {
  AreaChart, Area, BarChart, Bar, ComposedChart, Line, LineChart,
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  ReferenceLine, Legend, Cell, LabelList, PieChart, Pie,
} from "recharts";
import {
  CurrencyCircleDollar, Package, Percent, ArrowsLeftRight,
  Clock, ArrowCounterClockwise, Warning, CheckCircle, XCircle, CalendarBlank,
} from "@phosphor-icons/react";

// ── Tier colours ─────────────────────────────────────────────────────────────
const TIER_COLOR = { "Tier 1": "#1a5c38", "Tier 2": "#4b7bec", "Tier 3": "#d97706", "Tier 4": "#9ca3af" };

// ── Status badge ──────────────────────────────────────────────────────────────
const StatusBadge = ({ status }) => {
  const s = String(status || "").toLowerCase();
  const [cls, label] =
    s.includes("on_track") || s.includes("healthy")
      ? ["bg-emerald-100 text-emerald-800 border-emerald-300", "On Track"]
    : s.includes("at_risk") || s.includes("monitor")
      ? ["bg-amber-100 text-amber-800 border-amber-300",   "At Risk"]
    : s.includes("overdue") || s.includes("restock")
      ? ["bg-rose-100 text-rose-800 border-rose-300",      "Overdue"]
      : ["bg-slate-100 text-slate-600 border-slate-300",   "—"];
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border text-[11.5px] font-bold ${cls}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
};

// ── Percentile bar chart ──────────────────────────────────────────────────────
const PercentileBar = ({ value }) => {
  const pct = Math.max(0, Math.min(100, value || 0));
  const color = pct >= 66 ? "#1a5c38" : pct >= 33 ? "#d97706" : "#ef4444";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: pct + "%", background: color }} />
      </div>
      <span className="text-[11px] font-bold tabular-nums w-10 text-right" style={{ color }}>
        {Math.round(pct)}th
      </span>
    </div>
  );
};

// ── AI Recommendation Engine cards ────────────────────────────────────────────
const AI_CARD_STYLES = {
  restock:   { bg: "bg-rose-50",   border: "border-rose-300",   title: "text-rose-700",   tag: "bg-rose-600"   },
  retire:    { bg: "bg-emerald-50",border: "border-emerald-300",title: "text-emerald-800",tag: "bg-emerald-700" },
  transfer:  { bg: "bg-teal-50",   border: "border-teal-300",   title: "text-teal-800",   tag: "bg-teal-700"   },
  margin:    { bg: "bg-amber-50",  border: "border-amber-300",  title: "text-amber-800",  tag: "bg-amber-600"  },
};

function buildRecommendationCards(style, weeklyAvg) {
  if (!style) return [];
  const woc  = style.woc  || 0;
  const sor  = style.sor_6m || 0;
  const ros  = weeklyAvg || style.weekly_avg || 0;
  const tier = style.tier || "Tier 4";
  const gm   = style.gross_margin_pct || 0;

  const restockUrgent = woc < 1;
  const restockSoon   = woc >= 1 && woc < 2;
  const cards = [];

  // 1. Restock
  if (restockUrgent || restockSoon) {
    cards.push({
      key: "restock",
      label: restockUrgent ? "1] RESTOCK URGENTLY" : "1] RESTOCK SOON",
      style: AI_CARD_STYLES.restock,
      lines: [
        `WOC = ${woc.toFixed(1)} weeks. At current velocity (${ros.toFixed(1)} units/wk),`,
        restockUrgent
          ? `stock will be exhausted in ${woc > 0 ? Math.round(woc * 7) : "<7"} days. Raise PO immediately.`
          : `stock will run low in ~${Math.round(woc * 7)} days. Place reorder soon.`,
      ],
    });
  }

  // 2. Do Not Retire
  if (sor >= 80 || tier === "Tier 1" || tier === "Tier 2") {
    cards.push({
      key: "retire",
      label: "[OK] DO NOT RETIRE",
      style: AI_CARD_STYLES.retire,
      lines: [
        `${fmtPct(sor)} SOR (${fmtPct(sor)} lifetime). ${style.reorder_count || 0} reorders.`,
        `This is a proven ${tier} core style — maintain indefinitely.`,
      ],
    });
  }

  // 3. Inter-store transfers
  if (woc > 0) {
    cards.push({
      key: "transfer",
      label: "[↕] INTER-STORE TRANSFERS",
      style: AI_CARD_STYLES.transfer,
      lines: [
        `${woc < 2 ? "Critical" : "Some"} units can be redistributed from low-velocity stores.`,
        `Review store detail for donor/recipient store recommendations.`,
      ],
    });
  }

  // 4. Margin
  cards.push({
    key: "margin",
    label: "[%] MARGIN OPPORTUNITY",
    style: AI_CARD_STYLES.margin,
    lines: [
      `Full price realisation: ${fmtPct(style.full_price_pct || 0)} vs subcat avg ~85%. Review discount`,
      `frequency — ${gm >= 50 ? "GM is strong; protect it." : "GM is below target; review markdown policy."}`,
    ],
  });

  return cards;
}

// ── Month label from ISO week ─────────────────────────────────────────────────
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const isoWeekToDate = (isoWeek) => {
  if (!isoWeek) return null;
  const [yr, wk] = isoWeek.split("-W").map(Number);
  const jan4 = new Date(yr, 0, 4);
  const day = jan4.getDay() || 7;
  const d = new Date(jan4);
  d.setDate(jan4.getDate() - (day - 1) + (wk - 1) * 7);
  return d;
};
const weekLabel = (isoWeek, i) => {
  if (i % 4 !== 0) return "";
  const d = isoWeekToDate(isoWeek);
  return d ? `${MON[d.getMonth()]} '${String(d.getFullYear()).slice(2)}` : isoWeek;
};

// ── Main component ────────────────────────────────────────────────────────────
const MerchDeepDive = () => {
  const filters = useMerchFilters();
  const [searchParams, setSearchParams] = useSearchParams();

  const styleNumber = searchParams.get("style") || "";

  const [style,   setStyle]   = useState(null);
  const [weeks,   setWeeks]   = useState([]);
  const [subcat,  setSubcat]  = useState([]);
  const [styles,  setStyles]  = useState([]);  // same-subcategory styles for percentile
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  // Load style data when styleNumber changes
  useEffect(() => {
    if (!styleNumber) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      // Fetch filtered styles so metrics (revenue, sor, etc.) respect the active filters.
      apiFetch("/merch/styles", { params: {
        from_date: filters.from_date,
        to_date:   filters.to_date,
        country:   filters.country,
      } }).then(d => d.styles || []),
      apiFetch("/merch/style-sales-weekly", { params: {
        style_number: styleNumber,
        from_date: filters.from_date,
        to_date:   filters.to_date,
        country:   filters.country,
      } }),
      apiFetch("/merch/by-subcategory", { params: filters }),
    ])
      .then(([allStylesList, wk, sc]) => {
        if (cancelled) return;
        const found = allStylesList.find(s => s.style_number === styleNumber) || null;
        setStyle(found);
        setWeeks(wk.weeks || []);
        setSubcat(sc.rows || []);
        setStyles(allStylesList);
      })
      .catch(e => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleNumber, filters.from_date, filters.to_date, filters.country, filters.dataVersion]);

  // Auto-select first style if none chosen
  useEffect(() => {
    if (!styleNumber) {
      loadStyles()
        .then(list => {
          const first = list[0];
          if (first?.style_number) {
            setSearchParams(prev => {
              const next = new URLSearchParams(prev);
              next.set("style", first.style_number);
              return next;
            }, { replace: true });
          }
        }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStyleChange = (num) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set("style", num);
      return next;
    }, { replace: true });
  };

  const handleViewStore = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set("tab", "merch-store");
      if (styleNumber) next.set("style", styleNumber);
      return next;
    });
  };

  // ── Derived chart data ───────────────────────────────────────────────────
  const weeklyChart = useMemo(() => {
    if (!weeks.length) return [];
    const avgUnits = weeks.reduce((a, w) => a + w.units, 0) / weeks.length;
    return weeks.map((w, i) => ({
      week: w.iso_week,
      weekNum: i,
      units: w.units,
      subcatAvg: w.subcat_avg || 0,
      currentAvg: +avgUnits.toFixed(1),
      reorder: w.reorder ? w.units : undefined,
      orderRef: w.order_refs || "",
    }));
  }, [weeks]);

  const reorderLines = useMemo(() => {
    const lines = [];
    let ro = 1;
    for (let i = 0; i < weeklyChart.length; i++) {
      if (weeklyChart[i].reorder !== undefined) {
        lines.push({ weekNum: i, label: `RO${ro++}` });
      }
    }
    return lines;
  }, [weeklyChart]);

  // Percentile rankings vs same subcategory
  const percentiles = useMemo(() => {
    if (!style || !styles.length) return {};
    const peers = styles.filter(s => s.subcategory === style.subcategory);
    const rank = (key) => {
      if (!peers.length) return 50;
      const vals = peers.map(s => s[key] || 0).sort((a, b) => a - b);
      const myVal = style[key] || 0;
      const below = vals.filter(v => v < myVal).length;
      return Math.round((below / vals.length) * 100);
    };
    return {
      revenue:    rank("revenue_6m"),
      units:      rank("units_6m"),
      sor:        rank("sor_6m"),
      velocity:   rank("weekly_avg"),
      fullPricePct: rank("full_price_pct"),
    };
  }, [style, styles]);

  const subcatPeerCount = useMemo(
    () => styles.filter(s => s.subcategory === style?.subcategory).length,
    [style, styles]
  );

  // Monthly revenue (last 12m from weekly data)
  const monthlyRevChart = useMemo(() => {
    const map = {};
    for (const w of weeks) {
      const d = isoWeekToDate(w.iso_week);
      if (!d) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      map[key] = (map[key] || 0) + (w.units * (style?.avg_selling_price || 0));
    }
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([k, v]) => ({
        name: `${MON[parseInt(k.split("-")[1], 10) - 1]} '${k.slice(2, 4)}`,
        revenue: +((v) / 1000).toFixed(1),
      }));
  }, [weeks, style]);

  // Lifecycle timeline data
  const lifecycleData = useMemo(() => {
    if (!style?.launch_date || !weeks.length) return [];
    const launchMs = new Date(style.launch_date).getTime();
    let cumUnits = 0;
    return weeks.map((w) => {
      const d = isoWeekToDate(w.iso_week);
      const weeksSince = d ? Math.round((d.getTime() - launchMs) / (7 * 24 * 3600 * 1000)) : 0;
      cumUnits += w.units;
      return { week: weeksSince, cumUnits, reorder: w.reorder ? cumUnits : undefined };
    }).filter(d => d.week >= 0);
  }, [weeks, style]);

  const aiCards = useMemo(() => {
    const avg = weeks.length ? weeks.reduce((a, w) => a + w.units, 0) / weeks.length : 0;
    return buildRecommendationCards(style, avg);
  }, [style, weeks]);

  // WOC colour
  const wocColor = !style ? "" :
    style.woc < 1 ? "text-rose-600" :
    style.woc < 2 ? "text-amber-600" : "text-foreground";

  if (!styleNumber) {
    return (
      <div className="space-y-4 pb-8">
        <div>
          <h2 className="text-[22px] font-bold text-foreground">Style Deep Dive</h2>
          <p className="text-[12px] text-muted mt-0.5">Select a style to analyse</p>
        </div>
        <div className="card-white p-6 flex flex-col gap-3 items-start">
          <p className="text-[13px] text-foreground font-medium">Choose a style to begin:</p>
          <MerchStyleSearch value={styleNumber} onChange={handleStyleChange} />
        </div>
      </div>
    );
  }

  if (loading) return <Loading label="Loading Style Deep Dive…" />;
  if (error)   return <ErrorBox message={error} />;
  if (!style)  return (
    <div className="space-y-4 pb-8">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <MerchStyleSearch value={styleNumber} onChange={handleStyleChange} />
      </div>
      <Empty label="Style not found — try a different style number." />
    </div>
  );

  const avgUnits = weeks.length ? (weeks.reduce((a, w) => a + w.units, 0) / weeks.length).toFixed(1) : "—";

  return (
    <div className="space-y-5 pb-8">
      {/* ── Style header row ─────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <h2 className="text-[22px] font-bold text-foreground leading-tight truncate">
            {style.style_name}
          </h2>
          <p className="text-[12px] text-muted mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5">
            <span className="font-mono">{style.style_number}</span>
            <span className="opacity-40">·</span>
            <span>{style.brand}</span>
            <span className="opacity-40">·</span>
            <span>{style.subcategory}</span>
            <span className="opacity-40">·</span>
            <span>{style.tier}</span>
            {style.launch_date && <>
              <span className="opacity-40">·</span>
              <span>Launched {fmtDate(style.launch_date)}</span>
            </>}
            <span className="opacity-40">·</span>
            <span>As at {fmtDate(new Date().toISOString().slice(0, 10))}</span>
          </p>
          <div className="mt-1.5">
            <MerchStyleSearch value={styleNumber} onChange={handleStyleChange} />
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <StatusBadge status={style.action_status} />
          {style.recommended_action && (
            <span className="text-[12px] font-extrabold text-rose-600 uppercase tracking-wide">
              Recommendation: {style.recommended_action}
            </span>
          )}
          <button
            type="button"
            onClick={handleViewStore}
            className="mt-1 px-3 py-1.5 text-[11.5px] font-semibold rounded-full bg-brand/10 hover:bg-brand/20 text-brand-deep border border-brand/30 transition-all"
          >
            View Store Detail →
          </button>
        </div>
      </div>

      {/* ── 6 KPI cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KPICard
          label="Revenue (6m)"
          value={fmtKES(style.revenue_6m)}
          valueFull={fmtKESLong(style.revenue_6m)}
          sub={`vs subcat avg ${fmtKES(
            (subcat.find(s => s.subcategory === style.subcategory)?.revenue_6m || 0) /
            Math.max(1, subcat.find(s => s.subcategory === style.subcategory)?.style_count || 1)
          )}`}
          icon={CurrencyCircleDollar}
          showDelta={false}
          testId="dd-rev-6m"
        />
        <KPICard
          label="Units Sold (6m)"
          value={fmtNum(style.units_6m)}
          sub={`vs subcat avg ${fmtNum(
            (subcat.find(s => s.subcategory === style.subcategory)?.units_6m || 0) /
            Math.max(1, subcat.find(s => s.subcategory === style.subcategory)?.style_count || 1)
          )}`}
          icon={Package}
          showDelta={false}
          testId="dd-units-6m"
        />
        <KPICard
          label="SOR (6m)"
          value={fmtPct(style.sor_6m)}
          sub={`vs subcat avg ${fmtPct(subcat.find(s => s.subcategory === style.subcategory)?.avg_sor_6m || 0)}`}
          icon={Percent}
          showDelta={false}
          testId="dd-sor"
        />
        <KPICard
          label="Gross Margin"
          value="—"
          sub="Cost N/A · GM not available"
          showDelta={false}
          testId="dd-gm"
        />
        <KPICard
          label="Weeks of Cover"
          value={<span className={wocColor}>{style.woc ? style.woc.toFixed(1) + " wks" : "—"}</span>}
          sub={
            style.woc < 1 ? "🔴 CRITICAL — reorder now" :
            style.woc < 2 ? "⚠️ Urgent — reorder soon" : "In stock"
          }
          icon={Clock}
          showDelta={false}
          testId="dd-woc"
        />
        <KPICard
          label="Reorder Count"
          value={(style.reorder_count || 0) + "×"}
          sub={style.launch_date
            ? `Since ${new Date(style.launch_date).getFullYear()}`
            : ""}
          icon={ArrowCounterClockwise}
          showDelta={false}
          testId="dd-reorder"
        />
        {style.last_order_date && (
          <KPICard
            label="Last Ordered"
            value={fmtDate(style.last_order_date)}
            sub=""
            icon={CalendarBlank}
            showDelta={false}
            testId="dd-last-order"
          />
        )}
      </div>

      {/* ── Row 1: Weekly trend + Subcategory percentile + Gross Margin waterfall ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* 52-week weekly sales trend — 5 */}
        <div className="lg:col-span-5 card-white p-5">
          <SectionTitle
            title="Weekly Sales Trend — Trailing 52 Weeks"
            subtitle={`Current avg ${avgUnits}/wk`}
          />
          {weeklyChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={weeklyChart} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                  <defs>
                    <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#1a5c38" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#1a5c38" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="weekNum"
                    tick={{ fontSize: 9 }}
                    tickFormatter={(v) => weekLabel(weeklyChart[v]?.week, v)}
                    interval={3}
                  />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const row = weeklyChart[label] || {};
                      return (
                        <div className="bg-white border border-border rounded-lg shadow-lg p-2 text-[11px]">
                          <div className="font-semibold">{row.week}</div>
                          <div>Units: <b>{payload[0]?.value}</b></div>
                          <div className="text-muted">Subcat avg: {row.subcatAvg?.toFixed(1)}</div>
                          {row.orderRef && <div className="text-brand text-[10px]">{row.orderRef}</div>}
                        </div>
                      );
                    }}
                  />
                  {/* Reorder reference lines */}
                  {reorderLines.map(r => (
                    <ReferenceLine
                      key={r.weekNum}
                      x={r.weekNum}
                      stroke="#d97706"
                      strokeDasharray="4 2"
                      label={{ value: r.label, position: "top", style: { fontSize: 9, fill: "#d97706" } }}
                    />
                  ))}
                  {/* Dashed current avg */}
                  <ReferenceLine
                    y={weeklyChart[0]?.currentAvg}
                    stroke="#1a5c38"
                    strokeDasharray="6 3"
                    label={{ value: `Avg ${avgUnits}/wk`, position: "right", style: { fontSize: 9, fill: "#1a5c38" } }}
                  />
                  {/* Dotted subcat avg */}
                  {weeklyChart[0]?.subcatAvg > 0 && (
                    <ReferenceLine
                      y={weeklyChart[0].subcatAvg}
                      stroke="#4b7bec"
                      strokeDasharray="3 3"
                      label={{ value: `Subcat avg ${weeklyChart[0].subcatAvg?.toFixed(1)}`, position: "right", style: { fontSize: 9, fill: "#4b7bec" } }}
                    />
                  )}
                  <Area
                    type="monotone"
                    dataKey="units"
                    stroke="#1a5c38"
                    strokeWidth={1.5}
                    fill="url(#ddGrad)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* Subcategory percentile ranking — 4 */}
        <div className="lg:col-span-4 card-white p-5">
          <SectionTitle
            title={`Subcategory Ranking (${style.subcategory || "—"}, n=${subcatPeerCount})`}
            subtitle="Percentile vs peers (higher = better)"
          />
          <div className="mt-4 space-y-3">
            {[
              { label: "Revenue (6m)",     value: percentiles.revenue },
              { label: "Units (6m)",       value: percentiles.units },
              { label: "SOR (6m%)",        value: percentiles.sor },
              { label: "Weekly Velocity",  value: percentiles.velocity },
              { label: "Full Price %",     value: percentiles.fullPricePct },
            ].map(({ label, value }) => (
              <div key={label}>
                <div className="flex justify-between text-[11px] text-muted mb-1">
                  <span>{label}</span>
                  <span className="font-semibold tabular-nums">{Math.round(value ?? 50)}th percentile</span>
                </div>
                <PercentileBar value={value ?? 50} />
              </div>
            ))}
          </div>
          <div className="mt-3 border-t border-line pt-2 text-[10.5px] text-muted">
            — Subcat median (50th)
          </div>
        </div>

        {/* Gross Margin Waterfall placeholder — 3 */}
        <div className="lg:col-span-3 card-white p-5">
          <SectionTitle title="Gross Margin Waterfall" subtitle="Indicative — Cost N/A" />
          <div className="mt-4 space-y-2">
            {[
              { label: "Full Price", value: style.full_price || 0, color: "#1a5c38" },
              { label: "Avg Selling", value: style.avg_selling_price || 0, color: "#4b7bec" },
              { label: "Discount", value: -(style.full_price - style.avg_selling_price || 0), color: "#ef4444" },
              { label: "Cost", value: null, color: "#9ca3af" },
              { label: "Gross Margin", value: null, color: "#9ca3af" },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: color }} />
                <span className="text-[11.5px] text-foreground flex-1">{label}</span>
                <span className="text-[12px] font-bold tabular-nums" style={{ color }}>
                  {value === null ? "N/A" : fmtKES(Math.abs(value))}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[10.5px] text-amber-700">
            Cost price not available in current data — Gross Margin cannot be calculated.
          </div>
        </div>
      </div>

      {/* ── Row 2: Monthly Revenue + Lifecycle Timeline + Transfer table + AI Recs ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Monthly Revenue — 4 */}
        <div className="lg:col-span-4 card-white p-5">
          <SectionTitle title="Monthly Revenue — Last 12 Months" subtitle="KES Thousands" />
          {monthlyRevChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={monthlyRevChart} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={v => v + "K"} />
                  <Tooltip formatter={(v) => [v + "K", "Revenue"]} />
                  <Bar dataKey="revenue" name="Revenue" fill="#1a5c38" radius={[3, 3, 0, 0]} />
                  <Line type="monotone" dataKey="revenue" stroke="#d97706" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* Style Lifecycle Timeline — 5 */}
        <div className="lg:col-span-5 card-white p-5">
          <SectionTitle title="Style Lifecycle Timeline" subtitle="Weeks since launch / Cumulative units" />
          {lifecycleData.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={lifecycleData} margin={{ top: 8, right: 8, left: 0, bottom: 24 }}>
                  <defs>
                    <linearGradient id="lcGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#4b7bec" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#4b7bec" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="week"
                    tick={{ fontSize: 9 }}
                    label={{ value: "Weeks Since Launch", position: "insideBottom", offset: -12, style: { fontSize: 9 } }}
                  />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip formatter={(v, n) => [fmtNum(v), n]} />
                  {/* Reorder event markers */}
                  {lifecycleData.filter(d => d.reorder !== undefined).map((d, i) => (
                    <ReferenceLine
                      key={i}
                      x={d.week}
                      stroke="#d97706"
                      strokeDasharray="4 2"
                      label={{ value: `RO${i + 1}`, position: "top", style: { fontSize: 9, fill: "#d97706" } }}
                    />
                  ))}
                  <Area
                    type="monotone"
                    dataKey="cumUnits"
                    name="Cumulative Units"
                    stroke="#4b7bec"
                    strokeWidth={2}
                    fill="url(#lcGrad)"
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* AI Recommendation Engine — 3 */}
        <div className="lg:col-span-3 card-white p-5">
          <SectionTitle title="AI Recommendation Engine" />
          <div className="mt-3 space-y-2">
            {aiCards.map(card => (
              <div
                key={card.key}
                className={`rounded-lg border px-3 py-2 ${card.style.bg} ${card.style.border}`}
              >
                <div className={`text-[11px] font-extrabold uppercase tracking-wide mb-0.5 ${card.style.title}`}>
                  {card.label}
                </div>
                {card.lines.map((l, i) => (
                  <div key={i} className="text-[10.5px] text-foreground/80 leading-snug">{l}</div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MerchDeepDive;
