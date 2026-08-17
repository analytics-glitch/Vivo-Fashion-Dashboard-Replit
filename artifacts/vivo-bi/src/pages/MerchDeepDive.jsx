/**
 * MerchDeepDive — Style Deep Dive tab (tab 11, ?tab=merch-deepdive)
 *
 * Reads ?style= from the URL. Fetches:
 *   • /api/merch/styles?style_number=X   → style metadata
 *   • /api/merch/style-sales-weekly?style_number=X  → 52-week weekly data
 *   • /api/merch/by-subcategory          → subcategory peer data (for ranking)
 */
import React, { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, fmtKES, fmtKESLong, fmtNum, fmtPct, fmtDate } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import ProductThumbnail from "@/components/ProductThumbnail";
import { useThumbnails } from "@/lib/useThumbnails";
import { useMerchFilters } from "./MerchandisingHub";
import MerchStyleSearch from "./MerchStyleSearch";
import {
  AreaChart, Area, BarChart, Bar, ComposedChart, Line, LineChart,
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  ReferenceLine, Legend, Cell, LabelList, PieChart, Pie,
} from "recharts";
import {
  CurrencyCircleDollar, Package, Percent, ArrowsLeftRight,
  Clock, ArrowCounterClockwise, Warning, CheckCircle, XCircle, CalendarBlank,
  Stack, Palette, Megaphone,
} from "@phosphor-icons/react";

// ── Tier colours ─────────────────────────────────────────────────────────────
const TIER_COLOR = { "Tier 1": "#1a5c38", "Tier 2": "#4b7bec", "Tier 3": "#d97706", "Tier 4": "#9ca3af" };

// Store tier (A/B/C by trailing-90d revenue) → bar colour
const STORE_TIER_COLOR = { A: "#1a5c38", B: "#4b7bec", C: "#9ca3af" };

// ── Colourway chart bands ─────────────────────────────────────────────────────
// Sell-through % bands vs the style's own average for the same period.
const ST_BAND = {
  soldout: { fill: "#0d9488", label: "Sold out (100%, no stock left)" },
  above:   { fill: "#1a5c38", label: "≥ style avg" },
  below:   { fill: "#d97706", label: "Below avg" },
  laggard: { fill: "#ef4444", label: "Laggard (<½ avg, ≥10 SOH)" },
  none:    { fill: "#e5e7eb", label: "Stock, no sales in period" },
};
// WOC bands — same thresholds as the page/backend action rules:
// <2 wks stock-out risk, >16 overstock (review), >26 severe (clearance).
const WOC_BAND = {
  low:        { fill: "#ef4444", label: "<2 wks — stock-out risk" },
  ok:         { fill: "#1a5c38", label: "2–16 wks — healthy" },
  over:       { fill: "#d97706", label: ">16 wks — overstock" },
  severe:     { fill: "#881337", label: ">26 wks — severe" },
  novelocity: { fill: "#e5e7eb", label: "No 6m velocity" },
};

// Small colour-chip legend used under the banded colourway charts.
const BandLegend = ({ bands }) => (
  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-foreground/60">
    {bands.map(({ fill, label }) => (
      <span key={label} className="inline-flex items-center gap-1">
        <span className="w-2.5 h-2.5 rounded-sm inline-block flex-shrink-0" style={{ background: fill }} />
        {label}
      </span>
    ))}
  </div>
);

// ── Store SOH distribution ────────────────────────────────────────────────────
// The existing style-stores feed powers both the selected-style drill-down and
// the all-active-styles aggregate, keeping this stock view aligned with SOR.
const StoreSohDistribution = ({ styleNumber, style, styleRows, onStyleChange }) => {
  const filters = useMerchFilters();
  const [showRetired, setShowRetired] = useState(false);
  const [allRows, setAllRows] = useState([]);
  const [loadingAll, setLoadingAll] = useState(false);
  const [errorAll, setErrorAll] = useState(null);

  useEffect(() => {
    if (styleNumber) return;
    let cancelled = false;
    setLoadingAll(true);
    setErrorAll(null);
    apiFetch("/merch/style-stores", {
      params: {
        from_date: filters.from_date,
        to_date: filters.to_date,
        country: filters.country,
        include_retired: showRetired,
      },
    })
      .then(d => { if (!cancelled) setAllRows(d.stores || []); })
      .catch(e => {
        if (!cancelled) setErrorAll(e?.response?.data?.detail || e.message);
      })
      .finally(() => { if (!cancelled) setLoadingAll(false); });
    return () => { cancelled = true; };
  }, [styleNumber, filters.from_date, filters.to_date, filters.country, filters.dataVersion, showRetired]);

  const rows = styleNumber
    ? (style?.tier === "Retired" && !showRetired ? [] : (styleRows || []))
    : allRows;

  const chart = useMemo(() => rows
    .map(r => ({
      name: r.store,
      tier: r.store_tier || "—",
      soh: Number(r.current_stock || 0),
    }))
    .sort((a, b) => (b.soh - a.soh) || a.name.localeCompare(b.name)),
  [rows]);

  const subtitle = styleNumber && style
    ? `${style.style_name} · ${style.style_number} — SOH per location`
    : "Current SOH units per location · sorted highest to lowest";
  const retiredHidden = Boolean(styleNumber && style?.tier === "Retired" && !showRetired);

  return (
    <div className="card-white p-5" data-testid="store-soh-distribution">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <SectionTitle title="Stock on Hand by Store" subtitle={subtitle} />
        <label className="inline-flex items-center gap-2 text-[11px] text-foreground/70 cursor-pointer">
          <input
            type="checkbox"
            checked={showRetired}
            onChange={e => setShowRetired(e.target.checked)}
            className="accent-brand"
          />
          Include retired stock
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted mb-1">Style filter</div>
          <MerchStyleSearch value={styleNumber} onChange={onStyleChange} />
        </div>
        {!styleNumber && (
          <span className="pb-2 text-[11px] text-muted">
            {showRetired ? "All styles aggregated" : "All active styles aggregated"}
          </span>
        )}
      </div>

      {loadingAll ? <Loading label="Loading stock by location…" /> :
       errorAll ? <ErrorBox message={errorAll} /> :
       retiredHidden ? (
         <Empty label="This style is retired. Turn on “Include retired stock” to view its locations." />
       ) :
       chart.length === 0 ? <Empty label="No location stock is available for this scope." /> : (
        <>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 8 }}
                interval={0}
                angle={-60}
                textAnchor="end"
                height={84}
              />
              <YAxis tick={{ fontSize: 9 }} tickFormatter={v => fmtNum(v)} />
              <Tooltip content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
                    <div className="font-bold mb-0.5">
                      {label}{d.tier && d.tier !== "—" ? ` · Tier ${d.tier}` : ""}
                    </div>
                    <div>Stock on hand: {fmtNum(d.soh)} units</div>
                  </div>
                );
              }} />
              <Bar dataKey="soh" name="SOH units" radius={[3, 3, 0, 0]}>
                {chart.map((d, i) => (
                  <Cell key={i} fill={STORE_TIER_COLOR[d.tier] || "#d1d5db"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-1 flex items-center flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-foreground/60">
            {Object.entries(STORE_TIER_COLOR).map(([t, c]) => (
              <span key={t} className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: c }} />
                Tier {t} store
              </span>
            ))}
            <span className="text-foreground/40">Store tier = trailing-90-day revenue rank</span>
          </div>
        </>
      )}
    </div>
  );
};

// Display-only tidy-up for colour labels that carry style-number/size noise,
// e.g. "Mustard / 0819102 / F" → "Mustard",
//      "Hunters Green - Hunters Green / V0323019 / L" → "Hunters Green".
// The RAW colour value stays the data key on every row (byte-identical to
// the API) so tooltips and future drill-downs remain correct; this only
// affects what the axis prints. Noise is stripped from the END only, so
// genuine multi-colour names like "Navy / White" keep all their segments.
const CODE_TOKEN = /^\S*\d\S*$/;     // digit-bearing token: 0819102, V0223151, 1X…
const SIZE_TOKEN = /^[smlx]{1,4}$/i; // size token: S, M, L, Xl, XXL…
const tidyColorLabel = (raw) => {
  const s = String(raw || "").trim();
  if (!s) return "—";
  const parts = s.split("/").map(p => p.trim()).filter(Boolean);
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (CODE_TOKEN.test(last) || SIZE_TOKEN.test(last) || /^[A-Za-z]$/.test(last)) {
      parts.pop();
    } else break;
  }
  // Collapse "X - X" duplication once the trailing noise is gone.
  const out = parts.join(" / ").replace(/^(.+?) - \1$/, "$1");
  return out || s;
};

// ── Colourway recommendation rules (user spec — advisory display only) ───────
// All inputs are FIXED trailing windows from today (4/8/12-week sell-through,
// 6-month WOC) — like the section's WOC convention they never shrink with the
// hub's date filter; the country filter still applies. Precedence when a
// colourway qualifies for several groups: Restock > Marketing > Retire, so
// each colourway lands in at most one group.
const COLOR_REC = {
  // Performing very well — buy more of it.
  restock:   { minSor4: 40, maxWoc: 4, minAspPct: 90, maxLastSaleDays: 2 },
  // Recently produced but moving slowly — needs a push, not more stock.
  // Requires a recorded production order within the last ~3 months.
  marketing: { maxLastOrderDays: 91, minWoc: 8, maxSor8: 70 },
  // New styles only (Tier 4 or launched < 12 months), and only once the
  // style has been on sale ≥ 12 weeks — earlier, a 12-week SOR says nothing.
  retire:    { maxSor12: 70, newStyleMaxDays: 365, minDaysOnSale: 84 },
};

// Group chrome — green restock / amber marketing / red retire (task spec).
const REC_GROUP_STYLES = {
  restock:   { bg: "bg-emerald-50", border: "border-emerald-300", title: "text-emerald-800", tag: "bg-emerald-700", chip: "border-emerald-200" },
  marketing: { bg: "bg-amber-50",   border: "border-amber-300",   title: "text-amber-800",   tag: "bg-amber-600",   chip: "border-amber-200" },
  retire:    { bg: "bg-rose-50",    border: "border-rose-300",    title: "text-rose-700",    tag: "bg-rose-600",    chip: "border-rose-200" },
};

const fmtDaysAgo = (d) =>
  d === null || d === undefined ? "—"
    : d <= 0 ? "today"
    : d === 1 ? "1d ago"
    : `${d}d ago`;

// One recommendation group card: header + rule line + colourway chips carrying
// the supporting figures, or a compact "none" state (a group never disappears).
const RecGroup = ({ variant, icon: Icon, title, rule, items, emptyLabel, renderFigures }) => {
  const st = REC_GROUP_STYLES[variant];
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${st.bg} ${st.border}`}>
      <div className={`flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wide ${st.title}`}>
        <Icon size={13} weight="bold" className="flex-shrink-0" />
        <span className="truncate">{title}</span>
        <span className={`ml-auto flex-shrink-0 min-w-[18px] text-center text-[10px] px-1.5 py-0.5 rounded-full text-white ${st.tag}`}>
          {items.length}
        </span>
      </div>
      <div className="mt-0.5 text-[9.5px] leading-snug text-foreground/50">{rule}</div>
      {items.length === 0 ? (
        <div className="mt-2 text-[10.5px] italic text-foreground/50">{emptyLabel}</div>
      ) : (
        <div className="mt-2 space-y-1.5">
          {items.map((c) => (
            <div key={c.color} className={`bg-white/80 rounded-md border px-2 py-1.5 ${st.chip}`}>
              <div className="text-[11px] font-bold text-foreground truncate" title={c.color}>
                {c.name}
              </div>
              <div className="mt-0.5 text-[10px] text-foreground/70 flex flex-wrap gap-x-2 gap-y-0.5 tabular-nums">
                {renderFigures(c)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

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

// ── Rank bar chart (rank 1 = best → full bar, worst rank → near-empty) ───────
const rankFillPct = (rank, total) => {
  const n = Math.max(1, total || 1);
  const r = Math.min(Math.max(1, rank || n), n);
  return ((n - r + 1) / n) * 100; // rank 1 → 100%, rank n → 1/n of the bar
};
const rankColor = (rank, total) => {
  const pct = rankFillPct(rank, total);
  return pct >= 66 ? "#1a5c38" : pct >= 33 ? "#d97706" : "#ef4444";
};
const RankBar = ({ rank, total }) => (
  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
    <div
      className="h-full rounded-full transition-all"
      style={{ width: rankFillPct(rank, total) + "%", background: rankColor(rank, total) }}
    />
  </div>
);

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
  // Backend emits Postgres IYYY-IW ("2026-32", no "W"); tolerate "2026-W32"
  // too. The old split("-W") parse yielded NaN for the real format, and the
  // resulting Invalid Date is TRUTHY — it slipped past `!d` guards and
  // collapsed every week into one "NaN-NaN" month bucket downstream.
  const m = String(isoWeek).match(/^(\d{4})-W?(\d{1,2})$/);
  if (!m) return null;
  const yr = +m[1], wk = +m[2];
  const jan4 = new Date(yr, 0, 4);
  const day = jan4.getDay() || 7;
  const d = new Date(jan4);
  d.setDate(jan4.getDate() - (day - 1) + (wk - 1) * 7);
  return Number.isFinite(d.getTime()) ? d : null;
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
  const [styles,  setStyles]  = useState([]);  // same-subcategory styles for ranking
  const [storePerf, setStorePerf] = useState([]);           // per-store rows for this style
  const [colorPerf, setColorPerf] = useState([]);           // per-colourway rows for this style
  const [storeMetric, setStoreMetric] = useState("revenue"); // store chart: "revenue" | "units"
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
      // Deliberately NO from_date/to_date here: the weekly feed backs the
      // fixed trailing-window charts ("Trailing 52 Weeks", "Monthly Revenue —
      // Last 12 Months"), which must not shrink with the hub's date filter
      // (a 1-day/1-month filter left them a single lump). Country still
      // applies; the endpoint defaults to the trailing 364 days.
      apiFetch("/merch/style-sales-weekly", { params: {
        style_number: styleNumber,
        country:   filters.country,
      } }),
      apiFetch("/merch/by-subcategory", { params: filters }),
      apiFetch("/merch/style-stores", { params: {
        style_number: styleNumber,
        from_date: filters.from_date,
        to_date:   filters.to_date,
        country:   filters.country,
      } }),
      apiFetch("/merch/style-colors", { params: {
        style_number: styleNumber,
        from_date: filters.from_date,
        to_date:   filters.to_date,
        country:   filters.country,
      } }),
    ])
      .then(([allStylesList, wk, sc, sp, cp]) => {
        if (cancelled) return;
        const found = allStylesList.find(s => s.style_number === styleNumber) || null;
        setStyle(found);
        setWeeks(wk.weeks || []);
        setSubcat(sc.rows || []);
        setStyles(allStylesList);
        setStorePerf(sp.stores || []);
        setColorPerf(cp.colors || []);
      })
      .catch(e => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleNumber, filters.from_date, filters.to_date, filters.country, filters.dataVersion]);

  const handleStyleChange = (num) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (num) next.set("style", num);
      else next.delete("style");
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

  const handleViewInventory = () => {
    if (!styleNumber) return;
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set("tab", "merch-inventory");
      next.set("style", styleNumber);
      next.set("expanded", "true");
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

  // Rank vs ACTIVE styles (tier ≠ "Retired") in the same subcategory — rank 1 =
  // best (highest value). The viewed style is always part of the comparison set
  // and the denominator, even when it is itself Retired. Ties share a rank
  // (1 + count of strictly-higher peers) and null metrics count as 0.
  const ranking = useMemo(() => {
    if (!style || !styles.length) return { n: 0, ranks: {} };
    const peers = styles.filter(s =>
      s.subcategory === style.subcategory &&
      (s.tier !== "Retired" || s.style_number === style.style_number)
    );
    if (!peers.some(s => s.style_number === style.style_number)) peers.push(style);
    const rank = (key) => {
      const myVal = style[key] || 0;
      return 1 + peers.filter(s => (s[key] || 0) > myVal).length;
    };
    return {
      n: peers.length,
      ranks: {
        revenue:      rank("revenue_6m"),
        units:        rank("units_6m"),
        sor:          rank("sor_6m"),
        velocity:     rank("weekly_avg"),
        fullPricePct: rank("full_price_pct"),
      },
    };
  }, [style, styles]);

  // Monthly revenue (last 12m from weekly data)
  // Compact label for the currently selected filter period, e.g. "30d" / "3m".
  // Falls back to "6m" when no dates are set (matches the backend default).
  const periodLabel = useMemo(() => {
    if (!filters.from_date || !filters.to_date) return "6m";
    const from = new Date(filters.from_date);
    const to   = new Date(filters.to_date);
    const days = Math.round((to - from) / 86400000) + 1;
    if (!Number.isFinite(days) || days <= 0) return "6m";
    if (days <= 62) return `${days}d`;
    return `${Math.round(days / 30.44)}m`;
  }, [filters.from_date, filters.to_date]);

  // Per-store bars, sorted best→worst on the selected metric. The API field
  // names are units_6m/revenue_6m for legacy reasons, but the values are
  // scoped to the from_date→to_date window passed to /merch/style-stores.
  const storeChart = useMemo(() => {
    const key = storeMetric === "units" ? "units_6m" : "revenue_6m";
    return [...storePerf]
      .sort((a, b) => (b[key] || 0) - (a[key] || 0))
      .map(r => ({
        name:     r.store,
        tier:     r.store_tier || "—",
        value:    storeMetric === "units"
          ? (r.units_6m || 0)
          : Math.round((r.revenue_6m || 0) / 1000),
        units:    r.units_6m || 0,
        revenueK: Math.round((r.revenue_6m || 0) / 1000),
        stock:    r.current_stock || 0,
      }));
  }, [storePerf, storeMetric]);

  // Per-store SOR for the selected period — same rows as the Store Performance
  // chart. SOR = units ÷ (units + stock on hand), the codebase's sell-through
  // canon; a store with zero units AND zero stock has no signal and is
  // excluded (mirrors sor_period's None convention on the backend).
  const storeSorChart = useMemo(() => {
    return storePerf
      .map(r => {
        const units = r.units_6m || 0;
        const stock = r.current_stock || 0;
        const denom = units + stock;
        if (denom <= 0) return null;
        return {
          name:     r.store,
          tier:     r.store_tier || "—",
          value:    +(units * 100 / denom).toFixed(1),
          units,
          stock,
          revenueK: Math.round((r.revenue_6m || 0) / 1000),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.value - a.value);
  }, [storePerf]);

  // Per-colourway bars — one consistent ordering (revenue desc, from backend)
  // shared by all FOUR charts so bars line up across Revenue / SOH /
  // Sell-through / WOC. `color` keeps the raw API value; `name` is the
  // tidied display label (falls back to raw if two rows tidy to the same
  // label, so the axis/tooltip never becomes ambiguous).
  const colorChart = useMemo(() => {
    const tidy = colorPerf.map(r => tidyColorLabel(r.color));
    const seen = {};
    for (const t of tidy) seen[t] = (seen[t] || 0) + 1;

    // Style-average sell-through for the same period, computed from the same
    // rows the bars use (Σ units ÷ (Σ units + Σ SOH)) so the reference line
    // reconciles with the chart exactly.
    const totUnits = colorPerf.reduce((a, r) => a + (r.units_sold || 0), 0);
    const totSoh   = colorPerf.reduce((a, r) => a + (r.soh || 0), 0);
    const avg = (totUnits + totSoh) > 0
      ? +(totUnits * 100 / (totUnits + totSoh)).toFixed(1)
      : null;

    const rows = colorPerf.map((r, i) => {
      const units = r.units_sold || 0;
      const soh   = r.soh || 0;
      const denom = units + soh;
      // Same sell-through formula as the backend's sor_period canon.
      const sellThrough = denom > 0 ? +(units * 100 / denom).toFixed(1) : null;
      const soldOut = units > 0 && soh === 0;   // 100% — possible missed sales
      const noSales = units === 0;

      let band;
      if (sellThrough === null || noSales)                          band = "none";
      else if (soldOut)                                             band = "soldout";
      else if (avg !== null && sellThrough >= avg)                  band = "above";
      else if (avg !== null && sellThrough < avg / 2 && soh >= 10)  band = "laggard";
      else                                                          band = "below";

      // WOC — fixed 6m velocity from the backend (null ⇒ no velocity).
      const woc = (r.woc === null || r.woc === undefined) ? null : r.woc;
      const noVelocity = woc === null;
      const wocCapped  = !noVelocity && woc > 52;   // extreme — cap at 52+
      let wocValue, wocBand;
      if (noVelocity) {
        // Stock with zero 6m sales = indefinite cover: grey bar at the cap
        // (never a broken/infinite bar). No stock AND no velocity ⇒ 0.
        wocValue = soh > 0 ? 52 : 0;
        wocBand  = "novelocity";
      } else {
        wocValue = Math.min(woc, 52);
        wocBand  = woc < 2 ? "low" : woc > 26 ? "severe" : woc > 16 ? "over" : "ok";
      }

      return {
        color:    r.color || "—",                 // raw API key (byte-identical)
        name:     seen[tidy[i]] > 1 ? (r.color || "—") : tidy[i],
        revenueK: Math.round((r.revenue || 0) / 1000),
        soh,
        units,
        // null ratio = stock but no period sales; kept for the tooltip.
        ratio:    r.stock_to_sales,
        noSales,
        soldOut,
        sellThrough,
        band,
        units6m:   r.units_6m || 0,
        weeklyAvg: r.weekly_avg || 0,
        woc,
        wocValue,
        wocBand,
        wocCapped,
        noVelocity,
        wocTopLabel: (wocCapped || (noVelocity && soh > 0)) ? "52+" : "",
        // Recommendation rule inputs (fixed trailing windows, backend-derived)
        sor4:         r.sor_4wk ?? null,
        sor8:         r.sor_8wk ?? null,
        sor12:        r.sor_12wk ?? null,
        aspPctFull:   r.asp_pct_full ?? null,
        fullPrice:    r.full_price ?? null,
        lastSaleDays: r.last_sale_days ?? null,
      };
    });
    return { rows, avg };
  }, [colorPerf]);

  // ── Colourway recommendations — rule-based buckets (COLOR_REC) ─────────────
  // Combines the per-colour fixed-window inputs with style-level facts the
  // page already loads (lifecycle tier, launch date incl. first-sale fallback,
  // last production order). Precedence Restock > Marketing > Retire: the
  // `continue`s guarantee each colourway lands in at most one group.
  const colorRecs = useMemo(() => {
    const out = {
      restock: [], marketing: [], retire: [],
      marketingEligible: false, retireEligible: false,
      isNewStyle: false, lastOrderDays: null, launchDays: null,
    };
    if (!style) return out;
    const dayDiff = (iso) => {
      const d = new Date(String(iso).slice(0, 10));
      return Number.isFinite(d.getTime())
        ? Math.floor((Date.now() - d.getTime()) / 86400000)
        : null;
    };
    out.lastOrderDays = style.last_order_date ? dayDiff(style.last_order_date) : null;
    // Marketing needs a recorded production order in the last ~3 months —
    // styles with no order history never qualify.
    out.marketingEligible =
      out.lastOrderDays !== null && out.lastOrderDays <= COLOR_REC.marketing.maxLastOrderDays;
    out.launchDays = style.launch_date ? dayDiff(style.launch_date) : null;
    // "New" style: lifecycle tier New (Tier 4) or launched < 12 months ago.
    out.isNewStyle =
      style.tier === "Tier 4" ||
      (out.launchDays !== null && out.launchDays <= COLOR_REC.retire.newStyleMaxDays);
    // Retire additionally needs ≥ 12 weeks on sale (launch_date falls back to
    // the first-ever sale upstream); unknown launch fails closed — too early.
    const onSale12wk =
      out.launchDays !== null && out.launchDays >= COLOR_REC.retire.minDaysOnSale;
    out.retireEligible = out.isNewStyle && onSale12wk;

    for (const c of colorChart.rows) {
      const R = COLOR_REC.restock;
      if (c.sor4 != null && c.sor4 > R.minSor4 &&
          c.woc != null && c.woc < R.maxWoc &&
          c.aspPctFull != null && c.aspPctFull > R.minAspPct &&
          c.lastSaleDays != null && c.lastSaleDays < R.maxLastSaleDays) {
        out.restock.push(c);
        continue;                        // precedence: restock wins
      }
      const M = COLOR_REC.marketing;
      if (out.marketingEligible &&
          c.woc != null && c.woc > M.minWoc &&
          c.sor8 != null && c.sor8 < M.maxSor8) {
        out.marketing.push(c);
        continue;                        // precedence: marketing beats retire
      }
      if (out.retireEligible && c.sor12 != null && c.sor12 < COLOR_REC.retire.maxSor12) {
        out.retire.push(c);
      }
    }
    return out;
  }, [colorChart, style]);

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

  const aiCards = useMemo(() => {
    const avg = weeks.length ? weeks.reduce((a, w) => a + w.units, 0) / weeks.length : 0;
    return buildRecommendationCards(style, avg);
  }, [style, weeks]);

  // Product image for the header (custom thumbnail → Odoo image → placeholder)
  const { urlFor } = useThumbnails(style?.style_name ? [style.style_name] : []);

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
          <p className="text-[13px] text-foreground font-medium">Search for a style to get started</p>
          <MerchStyleSearch value={styleNumber} onChange={handleStyleChange} />
        </div>
        <StoreSohDistribution
          styleNumber={styleNumber}
          style={style}
          styleRows={storePerf}
          onStyleChange={handleStyleChange}
        />
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

  // ── Total SOH split ────────────────────────────────────────────────────────
  // soh_online is a SUBSET of soh_stores (the online channel is scoped as a
  // store location upstream), so the split shows PHYSICAL stores =
  // stores − online; the three rows then sum to the bold total
  // (stores + sellable warehouse — pipeline stock already excluded upstream).
  // Mirrors the CSV export's Warehouse/Stores/Online SOH columns.
  const sohTotal = style.current_stock || 0;
  const sohWh    = style.soh_warehouse || 0;
  const sohOnl   = style.soh_online || 0;
  const sohSto   = Math.max((style.soh_stores || 0) - sohOnl, 0);
  // Percentages print to exactly 100.0%: round Warehouse & Online, Stores
  // takes the balance (absorbs the rounding remainder). All "—" at zero stock.
  let sohWhPct = null, sohStoPct = null, sohOnlPct = null;
  if (sohTotal > 0) {
    sohWhPct  = Math.round((sohWh  * 1000) / sohTotal) / 10;
    sohOnlPct = Math.round((sohOnl * 1000) / sohTotal) / 10;
    sohStoPct = Math.max(Math.round((100 - sohWhPct - sohOnlPct) * 10) / 10, 0);
  }
  const sohSplitRows = [
    ["Warehouse", sohWh,  sohWhPct],
    ["Stores",    sohSto, sohStoPct],
    ["Online",    sohOnl, sohOnlPct],
  ];
  // Active Colour Ways — DERIVED status (there is no stored colour-level
  // status): a colourway is active iff the parent style is an Active tier AND
  // that colour has stock now, so Retired-tier styles always read 0
  // (style-level retirement cascades to every colourway).
  const activeColours = style.tier === "Retired" ? 0 : (style.colours_in_stock || 0);

  // Gross Margin Waterfall — the API resolves cost across buying orders,
  // product master, and completed manufacturing/DPS costing in that order.
  // Keep the warning only for a genuinely missing/non-zero cost.
  const avgSellingPrice = Number(style.avg_selling_price);
  const standardCost = Number(style.standard_cost_kes);
  const hasCost = Number.isFinite(standardCost) && standardCost > 0;
  const hasSellingPrice = Number.isFinite(avgSellingPrice) && avgSellingPrice > 0;
  const costSource = style.cost_source || null;
  const costDate = style.cost_date ? fmtDate(style.cost_date) : null;
  const costSourceNote = hasCost
    ? `Cost: ${fmtKES(standardCost)} · from ${costSource || "available costing data"}${costDate ? ` (${costDate})` : ""}`
    : null;
  const grossMarginKes = hasCost && hasSellingPrice
    ? avgSellingPrice - standardCost
    : null;
  const grossMarginPct = grossMarginKes !== null
    ? (grossMarginKes / avgSellingPrice) * 100
    : null;

  return (
    <div className="space-y-5 pb-8">
      {/* ── Style header row ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <ProductThumbnail
            style={style.style_name}
            url={urlFor(style.style_name)}
            size={88}
            className="rounded-lg shrink-0"
          />
          <div className="min-w-0 flex-1">
            <h2
              className="text-[22px] font-bold text-foreground leading-tight truncate whitespace-nowrap"
              title={style.style_name}
            >
              {style.style_name}
            </h2>
            <p className="text-[12px] text-muted mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 leading-tight">
              <span className="font-mono whitespace-nowrap">{style.style_number}</span>
              <span className="opacity-40" aria-hidden="true">·</span>
              <span className="whitespace-nowrap">{style.brand}</span>
              <span className="opacity-40" aria-hidden="true">·</span>
              <span className="whitespace-nowrap">{style.subcategory}</span>
              <span className="opacity-40" aria-hidden="true">·</span>
              <span className="whitespace-nowrap">{style.tier}</span>
              {style.launch_date && <>
                <span className="opacity-40" aria-hidden="true">·</span>
                <span className="whitespace-nowrap">Launched {fmtDate(style.launch_date)}</span>
              </>}
              <span className="opacity-40" aria-hidden="true">·</span>
              <span className="whitespace-nowrap">As at {fmtDate(new Date().toISOString().slice(0, 10))}</span>
            </p>
            <div className="mt-1.5 max-w-sm">
              <MerchStyleSearch value={styleNumber} onChange={handleStyleChange} />
            </div>
          </div>
        </div>
        <div className="flex flex-row sm:flex-col items-start sm:items-end gap-1.5 shrink-0">
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

      {/* ── AI Recommendations ────────────────────────────────────────────
          Rendered first (directly under the style header) so recommendations
          are visible without scrolling past the charts.
          (Style Lifecycle Timeline chart removed: it accumulated only the
          trailing-52-week window, so it never showed true lifetime volume.
          Replaced by the Units Sold (Lifetime) KPI card below.) */}
      <div className="card-white p-5">
        <SectionTitle title="AI Recommendation Engine" />
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
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

      {/* ── KPI cards ───────────────────────────────────────────────────── */}
      {/* `small` — deep-dive cards run 6-across, so the default md:28px bold
          value overflows/oversizes; use the shared small size variant (16/20px).
          Scoped to this page only — other pages' KPI cards are unchanged. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Card order is canonical (period trio → lifetime trio → margin →
            stock → colourways, then the trailing ops cards):
            Revenue (period) → Units (period) → SOR (period) →
            Revenue (Lifetime) → Units (Lifetime) → SOR (Lifetime) →
            Gross Margin → Total SOH → Active Colour Ways →
            Weeks of Cover → Reorder Count → Last Ordered. */}
        <KPICard
          small
          label={`Revenue (${periodLabel})`}
          value={fmtKES(style.revenue_period)}
          valueFull={fmtKESLong(style.revenue_period)}
          sub={`vs subcat avg ${fmtKES(
            (subcat.find(s => s.subcategory === style.subcategory)?.revenue_period || 0) /
            Math.max(1, subcat.find(s => s.subcategory === style.subcategory)?.style_count || 1)
          )}`}
          icon={CurrencyCircleDollar}
          showDelta={false}
          testId="dd-rev-6m"
        />
        <KPICard
          small
          label={`Units Sold (${periodLabel})`}
          value={fmtNum(style.units_period)}
          sub={`vs subcat avg ${fmtNum(
            (subcat.find(s => s.subcategory === style.subcategory)?.units_period || 0) /
            Math.max(1, subcat.find(s => s.subcategory === style.subcategory)?.style_count || 1)
          )}`}
          icon={Package}
          showDelta={false}
          testId="dd-units-6m"
        />
        <KPICard
          small
          label={`SOR (${periodLabel})`}
          value={fmtPct(style.sor_period)}
          sub={`vs subcat avg ${fmtPct(subcat.find(s => s.subcategory === style.subcategory)?.avg_sor_period || 0)}`}
          icon={Percent}
          showDelta={false}
          testId="dd-sor"
        />
        {/* Ported from Sales & Pricing (card removed there) — lifetime only
            makes sense at style level. revenue_life comes from the style row's
            unbounded lifetime CTE, so it ignores the hub date filter. */}
        <KPICard
          small
          label="Revenue (Lifetime)"
          value={fmtKES(style.revenue_life)}
          valueFull={fmtKESLong(style.revenue_life)}
          sub="Since first launch"
          icon={CurrencyCircleDollar}
          showDelta={false}
          testId="dd-rev-life"
        />
        {/* Lifetime Units — replaces the Style Lifecycle Timeline chart, which
            accumulated only the trailing-52-week window and so never showed a
            true lifetime figure. units_life = unbounded gross units from the
            style row's lifetime CTE (same family as revenue_life); ignores the
            hub date filter. */}
        <KPICard
          small
          label="Units Sold (Lifetime)"
          value={fmtNum(style.units_life)}
          sub="Since first launch"
          icon={Package}
          showDelta={false}
          testId="dd-units-life"
        />
        {/* SOR (Lifetime) — since-launch sell-through from the style payload:
            lifetime units ÷ (lifetime units + current stock), the same formula
            the hub's CSV export uses for "SOR Since Launch %". Lifetime basis
            ⇒ ignores the hub date filter (like the other Lifetime cards). */}
        <KPICard
          small
          label="SOR (Lifetime)"
          value={fmtPct(style.sor_life)}
          sub="Since first launch"
          icon={Percent}
          showDelta={false}
          testId="dd-sor-life"
        />
        <KPICard
          small
          label="Gross Margin"
          value="—"
          sub="Cost N/A · GM not available"
          showDelta={false}
          testId="dd-gm"
        />
        {/* Total SOH — stores + sellable warehouse (bold), split by location
            in the footer. Split rows sum to the bold total and percentages to
            100% (see the sohSplitRows derivation above the return). */}
        <KPICard
          small
          label="Total SOH"
          value={fmtNum(sohTotal)}
          sub="Stores + sellable warehouse"
          icon={Stack}
          showDelta={false}
          footer={
            <div className="space-y-0.5 font-normal">
              {sohSplitRows.map(([loc, units, pct]) => (
                <div
                  key={loc}
                  className="flex items-center justify-between gap-2 text-[10.5px]"
                  data-testid={`dd-soh-${loc.toLowerCase()}`}
                >
                  <span className="text-muted">{loc}</span>
                  <span className="font-semibold tabular-nums">
                    {fmtNum(units)} · {pct === null ? "—" : `${pct.toFixed(1)}%`}
                  </span>
                </div>
              ))}
            </div>
          }
          testId="dd-soh"
        />
        {/* Active Colour Ways — colourways with stock now (derived; Retired
            styles read 0), with the style's total colourways as context. */}
        <KPICard
          small
          label="Active Colour Ways"
          value={fmtNum(activeColours)}
          sub={`of ${fmtNum(style.colour_count)} total colour ways`}
          icon={Palette}
          showDelta={false}
          testId="dd-colourways"
        />
        <KPICard
          small
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
          small
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
            small
            label="Last Ordered"
            value={fmtDate(style.last_order_date)}
            sub=""
            icon={CalendarBlank}
            showDelta={false}
            testId="dd-last-order"
          />
        )}
      </div>

      {/* ── Row 1: Weekly trend (own full-width row) ────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* 52-week weekly sales trend — 12 */}
        <div className="lg:col-span-12 card-white p-5">
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

      </div>

      {/* ── Row 1a: Store Performance — Revenue/Units (full width) ──────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-12 card-white p-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <SectionTitle
              title={`Store Performance — ${storeMetric === "units" ? "Units Sold" : "Revenue"} (${periodLabel})`}
              subtitle={storeMetric === "units"
                ? "Units per store · sorted best to worst"
                : "KES Thousands per store · sorted best to worst"}
            />
            <div className="flex gap-1">
              {[["revenue", "Revenue"], ["units", "Units"]].map(([m, lbl]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setStoreMetric(m)}
                  className={`px-3 py-1 text-[11px] font-semibold rounded-full border transition-all ${
                    storeMetric === m
                      ? "bg-brand/10 text-brand-deep border-brand/30"
                      : "text-foreground/50 border-transparent hover:bg-muted"
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
          {storeChart.length === 0
            ? <Empty />
            : (
              <>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={storeChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 10 }}
                      interval={0}
                      angle={-45}
                      textAnchor="end"
                      height={90}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      tickFormatter={v => (storeMetric === "units" ? v : v + "K")}
                    />
                    <Tooltip content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
                          <div className="font-bold mb-0.5">
                            {label}{d.tier && d.tier !== "—" ? ` · Tier ${d.tier}` : ""}
                          </div>
                          <div>Revenue: KES {fmtNum(d.revenueK)}K</div>
                          <div>Units sold: {fmtNum(d.units)}</div>
                          <div>Stock on hand: {fmtNum(d.stock)}</div>
                        </div>
                      );
                    }} />
                    <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                      {storeChart.map((d, i) => (
                        <Cell key={i} fill={STORE_TIER_COLOR[d.tier] || "#d1d5db"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className="mt-1 flex items-center flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-foreground/60">
                  {Object.entries(STORE_TIER_COLOR).map(([t, c]) => (
                    <span key={t} className="inline-flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: c }} />
                      Tier {t} store
                    </span>
                  ))}
                  <span className="text-foreground/40">Store tier = trailing-90-day revenue rank</span>
                </div>
              </>
            )}
        </div>
      </div>

      {/* ── Row 1b: Store Performance — SOR (selected period) ───────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-12 card-white p-5">
          <SectionTitle
            title={`Store Performance — SOR (${periodLabel})`}
            subtitle="Sell-through % per store · units ÷ (units + stock on hand) · sorted best to worst"
          />
          {storeSorChart.length === 0
            ? <Empty />
            : (
              <>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={storeSorChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 8 }}
                      interval={0}
                      angle={-60}
                      textAnchor="end"
                      height={84}
                    />
                    <YAxis
                      tick={{ fontSize: 9 }}
                      domain={[0, 100]}
                      tickFormatter={v => v + "%"}
                    />
                    <Tooltip content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
                          <div className="font-bold mb-0.5">
                            {label}{d.tier && d.tier !== "—" ? ` · Tier ${d.tier}` : ""}
                          </div>
                          <div>SOR: {d.value}%</div>
                          <div>Units sold: {fmtNum(d.units)}</div>
                          <div>Stock on hand: {fmtNum(d.stock)}</div>
                          <div>Revenue: KES {fmtNum(d.revenueK)}K</div>
                        </div>
                      );
                    }} />
                    <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                      {storeSorChart.map((d, i) => (
                        <Cell key={i} fill={STORE_TIER_COLOR[d.tier] || "#d1d5db"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className="mt-1 flex items-center flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-foreground/60">
                  {Object.entries(STORE_TIER_COLOR).map(([t, c]) => (
                    <span key={t} className="inline-flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: c }} />
                      Tier {t} store
                    </span>
                  ))}
                  <span className="text-foreground/40">Store tier = trailing-90-day revenue rank</span>
                </div>
              </>
            )}
        </div>
      </div>

      {/* ── Row 1c: Store SOH distribution ───────────────────────────────── */}
      <StoreSohDistribution
        styleNumber={styleNumber}
        style={style}
        styleRows={storePerf}
        onStyleChange={handleStyleChange}
      />

      {/* ── Row 1d: Colourway Performance (Active styles only) ──────────── */}
      {style.tier !== "Retired" && (
        <div className="card-white p-5">
          <SectionTitle
            title={`Colourway Performance (${periodLabel})`}
            subtitle="Revenue, stock on hand, sell-through and weeks of cover by colourway · colourways with no stock and no period sales are hidden"
            action={styleNumber ? (
              <button
                type="button"
                onClick={handleViewInventory}
                className="shrink-0 text-[11px] font-semibold text-[#1a5c38] hover:text-[#124229] hover:underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-[#1a5c38]/25 rounded px-1 py-0.5"
                data-testid="colourway-view-inventory"
              >
                View stock breakdown <span aria-hidden="true">→</span>
              </button>
            ) : null}
          />
          {/* ── Colourway Recommendations — rule-based, above the chart grid ── */}
          {colorChart.rows.length > 0 && (
            <>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
                <RecGroup
                  variant="restock"
                  icon={ArrowCounterClockwise}
                  title="Restock"
                  rule="4-wk sell-through > 40% · WOC < 4 · ASP > 90% of full price · sold in last 2 days"
                  items={colorRecs.restock}
                  emptyLabel="None qualify."
                  renderFigures={(c) => (<>
                    <span>ST 4wk <b>{c.sor4 == null ? "—" : c.sor4 + "%"}</b></span>
                    <span>WOC <b>{c.woc == null ? "—" : c.woc.toFixed(1)}</b></span>
                    <span>ASP <b>{c.aspPctFull == null ? "—" : c.aspPctFull + "%"}</b> of full</span>
                    <span>sold <b>{fmtDaysAgo(c.lastSaleDays)}</b></span>
                  </>)}
                />
                <RecGroup
                  variant="marketing"
                  icon={Megaphone}
                  title="Marketing push"
                  rule="Production order < 3 months ago · WOC > 8 · 8-wk sell-through < 70%"
                  items={colorRecs.marketing}
                  emptyLabel={
                    colorRecs.marketingEligible
                      ? "None qualify."
                      : colorRecs.lastOrderDays === null
                        ? "n/a — no production order on record."
                        : `n/a — last order ${fmtDaysAgo(colorRecs.lastOrderDays)} (> 3 months).`
                  }
                  renderFigures={(c) => (<>
                    <span>ST 8wk <b>{c.sor8 == null ? "—" : c.sor8 + "%"}</b></span>
                    <span>WOC <b>{c.woc == null ? "—" : c.woc.toFixed(1)}</b></span>
                    <span>SOH <b>{fmtNum(c.soh)}</b></span>
                    <span>ordered <b>{fmtDaysAgo(colorRecs.lastOrderDays)}</b></span>
                  </>)}
                />
                <RecGroup
                  variant="retire"
                  icon={XCircle}
                  title="Retire candidates"
                  rule="New styles only (Tier 4 / launched < 12 mo, on sale ≥ 12 wks) · 12-wk sell-through < 70%"
                  items={colorRecs.retire}
                  emptyLabel={
                    colorRecs.retireEligible
                      ? "None qualify."
                      : !colorRecs.isNewStyle
                        ? "n/a — established style (rule applies to new styles)."
                        : colorRecs.launchDays === null
                          ? "n/a — launch date unknown."
                          : "Too early — on sale under 12 weeks."
                  }
                  renderFigures={(c) => (<>
                    <span>ST 12wk <b>{c.sor12 == null ? "—" : c.sor12 + "%"}</b></span>
                    <span>WOC <b>{c.woc == null ? "—" : c.woc.toFixed(1)}</b></span>
                    <span>SOH <b>{fmtNum(c.soh)}</b></span>
                    <span>last sale <b>{c.lastSaleDays == null ? "none in 12 wks" : fmtDaysAgo(c.lastSaleDays)}</b></span>
                  </>)}
                />
              </div>
              <div className="mt-1.5 text-[9.5px] text-foreground/45">
                Advisory only · fixed trailing windows (4/8/12-wk sell-through, 6-mo WOC) — independent of the
                date filter, country filter applies · each colourway appears in at most one group (Restock › Marketing › Retire)
              </div>
            </>
          )}
          {colorChart.rows.length === 0
            ? <Empty label="No colourways with stock or sales in the selected period." />
            : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-4 gap-y-5 mt-2">
                {/* Revenue */}
                <div>
                  <div className="text-[11.5px] font-semibold text-foreground/70 mb-1">
                    Revenue (KES Thousands)
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={colorChart.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="name" tick={{ fontSize: 8 }} interval={0}
                        angle={-45} textAnchor="end" height={64} />
                      <YAxis tick={{ fontSize: 9 }} tickFormatter={v => v + "K"} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload;
                        return (
                          <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
                            <div className="font-bold mb-0.5">{d.name}</div>
                            <div>Revenue: KES {fmtNum(d.revenueK)}K</div>
                            <div>Units sold: {fmtNum(d.units)}</div>
                            <div>Stock on hand: {fmtNum(d.soh)}</div>
                          </div>
                        );
                      }} />
                      <Bar dataKey="revenueK" fill="#1a5c38" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {/* SOH */}
                <div>
                  <div className="text-[11.5px] font-semibold text-foreground/70 mb-1">
                    Stock on Hand (units)
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={colorChart.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="name" tick={{ fontSize: 8 }} interval={0}
                        angle={-45} textAnchor="end" height={64} />
                      <YAxis tick={{ fontSize: 9 }} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload;
                        return (
                          <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
                            <div className="font-bold mb-0.5">{d.name}</div>
                            <div>Stock on hand: {fmtNum(d.soh)}</div>
                            <div>Units sold: {fmtNum(d.units)}</div>
                            <div>Revenue: KES {fmtNum(d.revenueK)}K</div>
                          </div>
                        );
                      }} />
                      <Bar dataKey="soh" fill="#4b7bec" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {/* Sell-through % — banded vs the style's own period average */}
                <div>
                  <div className="text-[11.5px] font-semibold text-foreground/70 mb-1">
                    Sell-through % (units sold ÷ (units sold + SOH)) — higher is better
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={colorChart.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="name" tick={{ fontSize: 8 }} interval={0}
                        angle={-45} textAnchor="end" height={64} />
                      <YAxis tick={{ fontSize: 9 }} domain={[0, 100]}
                        ticks={[0, 25, 50, 75, 100]} tickFormatter={v => v + "%"} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload;
                        return (
                          <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
                            <div className="font-bold mb-0.5">{d.name}</div>
                            <div>
                              Sell-through:{" "}
                              <span className="font-semibold">
                                {d.sellThrough === null ? "—" : d.sellThrough + "%"}
                              </span>
                              {colorChart.avg !== null && (
                                <span className="text-foreground/50"> · style avg {colorChart.avg}%</span>
                              )}
                            </div>
                            {d.soldOut && (
                              <div className="text-teal-700 font-semibold">
                                Sold out — top performer, possible missed sales
                              </div>
                            )}
                            {d.noSales && (
                              <div className="text-rose-600 font-semibold">No sales in period</div>
                            )}
                            <div>Units sold: {fmtNum(d.units)}</div>
                            <div>Stock on hand: {fmtNum(d.soh)}</div>
                            <div>Revenue: KES {fmtNum(d.revenueK)}K</div>
                            <div className="text-foreground/60">
                              Stock-to-sales: {d.ratio === null || d.ratio === undefined ? "—" : d.ratio}
                            </div>
                          </div>
                        );
                      }} />
                      {colorChart.avg !== null && (
                        <ReferenceLine y={colorChart.avg} stroke="#334155" strokeDasharray="4 4"
                          label={{ value: `Style avg ${colorChart.avg}%`, position: "insideTopRight",
                                   fontSize: 9, fill: "#334155" }} />
                      )}
                      <Bar dataKey="sellThrough" radius={[3, 3, 0, 0]} minPointSize={2}>
                        {colorChart.rows.map((d, i) => (
                          <Cell key={i} fill={ST_BAND[d.band].fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <BandLegend bands={["soldout", "above", "below", "laggard", "none"]
                    .map(k => ST_BAND[k])} />
                </div>
                {/* WOC per colourway — fixed 6m velocity, same formula as header WOC */}
                <div>
                  <div className="text-[11.5px] font-semibold text-foreground/70 mb-1">
                    Weeks of Cover (SOH ÷ weekly velocity, fixed 6-month window)
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={colorChart.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                      <XAxis dataKey="name" tick={{ fontSize: 8 }} interval={0}
                        angle={-45} textAnchor="end" height={64} />
                      <YAxis tick={{ fontSize: 9 }}
                        domain={[0, dataMax => (dataMax >= 52 ? 56 : Math.max(8, Math.ceil(dataMax * 1.15)))]} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload;
                        return (
                          <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
                            <div className="font-bold mb-0.5">{d.name}</div>
                            <div>
                              Weeks of cover:{" "}
                              <span className="font-semibold">
                                {d.noVelocity
                                  ? "—"
                                  : d.wocCapped
                                    ? `52+ wks (actual ≈ ${fmtNum(Math.round(d.woc))})`
                                    : d.woc.toFixed(1) + " wks"}
                              </span>
                            </div>
                            {d.noVelocity && (
                              <div className="text-foreground/60 font-semibold">
                                No sales in last 6 months — no velocity
                              </div>
                            )}
                            <div>Weekly velocity: {d.weeklyAvg ? d.weeklyAvg.toFixed(2) + " u/wk" : "0 u/wk"}</div>
                            <div>Units (6m): {fmtNum(d.units6m)}</div>
                            <div>Stock on hand: {fmtNum(d.soh)}</div>
                          </div>
                        );
                      }} />
                      <Bar dataKey="wocValue" radius={[3, 3, 0, 0]} minPointSize={2}>
                        {colorChart.rows.map((d, i) => (
                          <Cell key={i} fill={WOC_BAND[d.wocBand].fill} />
                        ))}
                        <LabelList dataKey="wocTopLabel" position="top"
                          style={{ fontSize: 8, fill: "#64748b", fontWeight: 700 }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <BandLegend bands={["low", "ok", "over", "severe", "novelocity"]
                    .map(k => WOC_BAND[k])} />
                </div>
              </div>
            )}
        </div>
      )}

      {/* ── Row 2: Subcategory rank + Gross Margin waterfall + Monthly Revenue ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Subcategory rank vs active peers — 5 */}
        <div className="lg:col-span-5 card-white p-5">
          <SectionTitle
            title={`Subcategory Ranking (${style.subcategory || "—"}, n=${ranking.n})`}
            subtitle="Rank vs active peers (1 = best)"
          />
          <div className="mt-4 space-y-3">
            {[
              { label: "Revenue (6m)",     rank: ranking.ranks.revenue },
              { label: "Units (6m)",       rank: ranking.ranks.units },
              { label: "SOR (6m%)",        rank: ranking.ranks.sor },
              { label: "Weekly Velocity",  rank: ranking.ranks.velocity },
              { label: "Full Price %",     rank: ranking.ranks.fullPricePct },
            ].map(({ label, rank }) => {
              const r = rank ?? ranking.n;
              return (
                <div key={label}>
                  <div className="flex justify-between text-[11px] text-muted mb-1">
                    <span>{label}</span>
                    <span className="font-bold tabular-nums" style={{ color: rankColor(r, ranking.n) }}>
                      {r}/{ranking.n}
                    </span>
                  </div>
                  <RankBar rank={r} total={ranking.n} />
                </div>
              );
            })}
          </div>
          <div className="mt-3 border-t border-line pt-2 text-[10.5px] text-muted">
            — Rank 1 = best of {ranking.n} active styles
            {style.tier === "Retired" ? " (incl. this Retired style)" : ""} · ties share a rank
          </div>
        </div>

        {/* Gross Margin Waterfall — 3 */}
        <div className="lg:col-span-3 card-white p-5">
          <SectionTitle
            title="Gross Margin Waterfall"
            subtitle={hasCost ? "Indicative" : "Indicative — Cost N/A"}
          />
          <div className="mt-4 space-y-2">
            {[
              { label: "Full Price", value: style.full_price || 0, color: "#1a5c38" },
              { label: "Avg Selling", value: style.avg_selling_price || 0, color: "#4b7bec" },
              { label: "Discount", value: -(style.full_price - style.avg_selling_price || 0), color: "#ef4444" },
              { label: "Cost", value: hasCost ? standardCost : null, color: "#334155" },
              {
                label: "Gross Margin",
                value: grossMarginKes,
                pct: grossMarginPct,
                color: grossMarginKes === null ? "#9ca3af" : grossMarginKes >= 0 ? "#1a5c38" : "#ef4444",
              },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: color }} />
                <span className="text-[11.5px] text-foreground flex-1">{label}</span>
                {label === "Gross Margin" && value !== null ? (
                  <span className="text-right leading-tight" style={{ color }}>
                    <span className="block text-[14px] font-extrabold tabular-nums">
                      {fmtPct(pct)}
                    </span>
                    <span className="block text-[10px] font-semibold tabular-nums">
                      {fmtKES(value)}
                    </span>
                  </span>
                ) : (
                  <span className="text-[12px] font-bold tabular-nums" style={{ color }}>
                    {value === null ? "N/A" : fmtKES(Math.abs(value))}
                  </span>
                )}
              </div>
            ))}
          </div>
          {hasCost ? (
            <div className="mt-3 text-[10.5px] text-muted">
              {costSourceNote}
            </div>
          ) : (
            <div className="mt-3 text-[10.5px] text-muted">
              Checked last reorder/buying-order cost, product-master cost, and production/DPS costing records.
            </div>
          )}
          {!hasCost && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[10.5px] text-amber-700">
              No non-zero cost was found in the checked sources — Gross Margin cannot be calculated.
            </div>
          )}
        </div>
        {/* Monthly Revenue — 4 */}
        <div className="lg:col-span-4 card-white p-5">
          <SectionTitle title="Monthly Revenue — Last 12 Months" subtitle="KES Thousands" />
          {monthlyRevChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={monthlyRevChart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 8.5 }}
                    interval={0}
                    angle={-45}
                    textAnchor="end"
                    height={36}
                  />
                  <YAxis tick={{ fontSize: 9 }} tickFormatter={v => v + "K"} />
                  <Tooltip formatter={(v) => [v + "K", "Revenue"]} />
                  <Bar dataKey="revenue" name="Revenue" fill="#1a5c38" radius={[3, 3, 0, 0]} />
                  <Line type="monotone" dataKey="revenue" stroke="#d97706" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
        </div>

      </div>
    </div>
  );
};

export default MerchDeepDive;
