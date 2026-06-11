import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { useKpis } from "@/lib/useKpis";
import { api, fmtKES, fmtKESLong, fmtNum, fmtDelta, fmtPct, buildParams, pctDelta, comparePeriod } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { InlineDelta } from "@/components/ChartHelpers";
import SortableTable from "@/components/SortableTable";
import { useTableSort, SortableTh } from "@/lib/useTableSort";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { useLocationBadges, LocationLeaderboard, useLeaderboardStreaks } from "@/components/LocationLeaderboard";
import { useOutliers } from "@/lib/useOutliers";
import { DataQualityPill, DataQualityBanner } from "@/components/DataQualityPill";
import StoreDeepDive from "@/components/StoreDeepDive";
import LocationsAttentionPanel from "@/components/LocationsAttentionPanel";
import MonthlyTargetsTracker from "@/components/MonthlyTargetsTracker";
import StockToSalesBySubcategory from "@/components/StockToSalesBySubcategory";
import { Storefront, ArrowsDownUp, ArrowUpRight, Warning, CaretDown, CaretRight, Footprints, Target, Coins, Stack, Tag } from "@phosphor-icons/react";
import { useAuth } from "@/lib/auth";

// --- Footfall & Conversion table tuning ---------------------------------
// Conversion bands (configurable). A store converting >= GREEN% is strong,
// AMBER..GREEN is a watch, below AMBER is weak. FF_LOW is the footfall floor
// below which conversion is statistical noise (deltas muted, store excluded
// from best/worst callouts).
const CONV_GREEN = 13;
const CONV_AMBER = 8;
const FF_LOW = 100;
// ABV table: a store with fewer than this many orders in EITHER the current
// or comparison period is statistically too thin to trust — its ABV/deltas
// are greyed out, badged "Low volume", and excluded from the default sort.
const ABV_LOW_ORDERS = 10;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Signed full-precision KES delta, e.g. "+KES 6,810" / "−KES 1,240".
const fmtKESDelta = (n) => {
  if (n === null || n === undefined || isNaN(Number(n))) return "—";
  const v = Math.round(Number(n));
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}KES ${Math.abs(v).toLocaleString("en-US")}`;
};

// Compact date-range label, e.g. "1–10 Jun 2026" or "1 Jun – 3 Jul 2026".
const fmtRange = (from, to) => {
  if (!from || !to) return "";
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  if (from === to) return `${d1} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 === y2) return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]} ${y1}`;
  return `${d1} ${MONTHS[m1 - 1]} ${y1} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
};

const convBand = (c, low) => {
  if (low || c == null) return "pill-neutral";
  if (c >= CONV_GREEN) return "pill-green";
  if (c >= CONV_AMBER) return "pill-amber";
  return "pill-red";
};

// One "lever" of the diagnose-the-gap mini panel: current vs last-month,
// rendered as two proportional bars plus the delta. Higher-is-better drives
// the delta colour.
const LeverTile = ({ icon: Icon, label, cur, prev, fmt, delta, deltaSuffix = "%", higherBetter = true, note }) => {
  const max = Math.max(cur || 0, prev || 0) || 1;
  const good = delta == null ? null : (higherBetter ? delta >= 0 : delta <= 0);
  const deltaCls = good == null ? "text-muted" : good ? "text-emerald-700" : "text-red-600";
  const Bar = ({ v, tone }) => (
    <div className="h-1.5 rounded-full bg-stone-200/70 overflow-hidden">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, ((v || 0) / max) * 100)}%` }} />
    </div>
  );
  return (
    <div className="flex-1 min-w-[150px] rounded-lg border border-stone-200 bg-white p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted uppercase tracking-wide">
        {Icon && <Icon size={13} weight="bold" />}{label}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="text-base font-bold text-[#1a1a1a]">{fmt(cur)}</span>
        {delta != null && (
          <span className={`text-[11px] font-semibold ${deltaCls}`}>
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}{deltaSuffix}
          </span>
        )}
      </div>
      <div className="mt-1.5 space-y-1">
        <Bar v={cur} tone="bg-brand" />
        <Bar v={prev} tone="bg-stone-300" />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>Now</span><span>LM {prev == null ? "n/a" : fmt(prev)}</span>
      </div>
      {note && <div className="mt-1.5 text-[10px] text-muted leading-snug">{note}</div>}
    </div>
  );
};

const Locations = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { dateFrom, dateTo, countries, channels, compareMode, compareDateFrom, compareDateTo, dataVersion } = applied;
  const filters = { dateFrom, dateTo, countries, channels };

  // Shared KPI state — guarantees Total Sales/Orders/Units match Overview & CEO Report.
  const { kpis: rawKpis, prevKpis: rawKpisPrev, loading: kpisLoading, error: kpisError } = useKpis({ compare: true });

  const [rows, setRows] = useState([]);
  const [prevRows, setPrevRows] = useState([]);
  const [footfall, setFootfall] = useState([]);
  const [prevFootfall, setPrevFootfall] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortKey, setSortKey] = useState("total_sales");
  const [selected, setSelected] = useState(null);
  const [weekdayData, setWeekdayData] = useState(null);
  // Footfall & Conversion table — default sort by Sales/Visitor desc (the
  // primary efficiency metric). Row click expands a diagnose-the-gap panel.
  const ffSort = useTableSort({ key: "spv", dir: "desc" });
  const [expandedFf, setExpandedFf] = useState(null);

  // ABV-by-location table — manual sort (null until the user clicks a header,
  // so the default low-volume-aware ordering applies), plus row expansion for
  // the basket-decomposition drill-down.
  const abvSort = useTableSort();
  const [expandedAbv, setExpandedAbv] = useState(null);
  const { user } = useAuth();

  // Weekday pattern feeds the store deep-dive's mini-heatmap.
  // Safe to share across all store drills since the endpoint is 1h-cached.
  useEffect(() => {
    let cancel = false;
    api.get("/footfall/weekday-pattern")
      .then((r) => { if (!cancel) setWeekdayData(r.data || null); })
      .catch(() => { /* optional — deep-dive still renders without it */ });
    return () => { cancel = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const p = buildParams(filters);
    const prev = comparePeriod(dateFrom, dateTo, compareMode, { date_from: compareDateFrom, date_to: compareDateTo });
    const prevP = prev
      ? buildParams({ ...filters, dateFrom: prev.date_from, dateTo: prev.date_to })
      : null;

    Promise.all([
      api.get("/sales-summary", { params: p }),
      prevP
        ? api.get("/sales-summary", { params: prevP })
        : Promise.resolve({ data: [] }),
      api.get("/footfall", { params: { date_from: dateFrom, date_to: dateTo } }),
      prev
        ? api.get("/footfall", { params: { date_from: prev.date_from, date_to: prev.date_to } }).catch(() => ({ data: [] }))
        : Promise.resolve({ data: [] }),
    ])
      .then(([s, ps, ff, pff]) => {
        if (cancelled) return;
        setRows(s.data || []);
        setPrevRows(ps.data || []);
        setFootfall(ff.data || []);
        setPrevFootfall(pff.data || []);
        touchLastUpdated();
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line
  }, [dateFrom, dateTo, JSON.stringify(countries), JSON.stringify(channels), compareMode, compareDateFrom, compareDateTo, dataVersion]);

  const prevMap = useMemo(() => {
    const m = new Map();
    for (const r of prevRows) m.set(r.channel, r);
    return m;
  }, [prevRows]);

  // Footfall lookup keyed by location name. The /footfall response uses
  // `location` (the store name displayed at POS), which equals our row's
  // `channel` field for store-level POS. Online channels won't match —
  // they get total_footfall=0 (correct, no walk-in concept).
  const footfallMap = useMemo(() => {
    const m = new Map();
    for (const r of footfall) {
      m.set(r.location, r);
    }
    return m;
  }, [footfall]);

  const prevFootfallMap = useMemo(() => {
    const m = new Map();
    for (const r of prevFootfall) m.set(r.location, r);
    return m;
  }, [prevFootfall]);

  const kpis = rawKpis;

  const enriched = useMemo(() => {
    return rows.map((r) => {
      const prev = prevMap.get(r.channel);
      const ff = footfallMap.get(r.channel);
      const sales = r.total_sales || 0;
      const orders = r.orders || r.total_orders || 0;
      const units = r.units_sold || r.total_units_sold || 0;
      const returns = r.returns || 0;
      const basket = orders ? sales / orders : (r.avg_basket_size || 0);
      const asp = units ? sales / units : 0;
      const msi = orders ? units / orders : 0;

      const ffCount = ff ? (ff.total_footfall || 0) : 0;
      const conv = ffCount ? (orders / ffCount) * 100 : null;
      // Previous conversion = prev orders ÷ prev footfall when both exist.
      // Pull prev footfall from the dedicated /footfall fetch on the prev
      // window (the upstream /footfall endpoint doesn't return previous-
      // period totals inline, so we have to fan out a second call).
      const pFf = prevFootfallMap.get(r.channel);
      const pFfCount = pFf ? (pFf.total_footfall || 0) : 0;
      const pPrevOrders = prev ? (prev.orders || prev.total_orders || 0) : 0;
      const pConv = pFfCount ? (pPrevOrders / pFfCount) * 100 : null;
      const conv_delta_pp = (conv != null && pConv != null) ? +(conv - pConv).toFixed(2) : null;

      // Previous-period numbers
      const pSales = prev ? (prev.total_sales || 0) : null;
      const pOrders = prev ? (prev.orders || prev.total_orders || 0) : null;
      const pUnits = prev ? (prev.units_sold || prev.total_units_sold || 0) : null;
      const pReturns = prev ? (prev.returns || 0) : null;
      const pAbv = pOrders ? pSales / pOrders : null;
      const pAsp = pUnits ? pSales / pUnits : null;
      const pMsi = pOrders ? pUnits / pOrders : null;

      return {
        ...r,
        total_sales: sales,
        orders,
        units_sold: units,
        returns,
        avg_basket: basket,
        abv: basket,
        asp,
        msi,
        // Return rate = returns ÷ total_sales (fraction of sales flipped
        // back). Exposed here so the Data-Quality layer can flag stores
        // whose return behaviour sits outside the group norm.
        return_rate: sales > 0 ? (returns / sales) * 100 : 0,
        // Legacy headline delta (kept for SortableTable row)
        delta: prev ? pctDelta(sales, pSales) : null,
        // Per-metric deltas (null when no prev data / prev is 0)
        d_sales: prev ? pctDelta(sales, pSales) : null,
        d_orders: prev ? pctDelta(orders, pOrders) : null,
        d_units: prev ? pctDelta(units, pUnits) : null,
        d_returns: prev ? pctDelta(returns, pReturns) : null,
        d_abv: prev ? pctDelta(basket, pAbv) : null,
        d_asp: prev ? pctDelta(asp, pAsp) : null,
        d_msi: prev ? pctDelta(msi, pMsi) : null,
        // Raw previous-period values (exposed for table display / CSV export)
        prev_abv: pAbv,
        prev_orders: pOrders,
        prev_sales: pSales,
        prev_msi: pMsi,
        prev_asp: pAsp,
        // Footfall + conversion (joined from /footfall response)
        total_footfall: ffCount,
        conversion_rate: conv,
        conv_delta_pp,
      };
    });
  }, [rows, prevMap, footfallMap, prevFootfallMap]);

  // --- Footfall & Conversion table model ---------------------------------
  // One decorated row per footfall location. Sales/Orders come from the
  // authoritative store grid (sales-summary); conversion is recomputed from
  // CLEAN orders (sensor-gap days excluded server-side). prev-period values
  // come from the second /footfall + /sales-summary fan-out.
  const ffRows = useMemo(() => {
    return footfall.map((r) => {
      const loc = r.location;
      const store = enriched.find((l) => l.channel === loc);
      const sales = store ? (store.total_sales || 0) : (r.total_sales || 0);
      const orders = store ? (store.orders || store.total_orders || 0) : (r.orders || 0);
      const footfallCount = r.total_footfall || 0;
      const sensorGapDays = r.sensor_gap_days || 0;
      // clean_orders excludes orders booked on days the sensor reported 0.
      const cleanOrders = r.clean_orders != null ? r.clean_orders : orders;
      const conv = footfallCount ? (cleanOrders / footfallCount) * 100 : null;

      const pFf = prevFootfallMap.get(loc);
      const prevFootfallCount = pFf ? (pFf.total_footfall || 0) : 0;
      const prevStore = prevMap.get(loc);
      const prevOrders = prevStore ? (prevStore.orders || prevStore.total_orders || 0) : 0;
      const prevSales = prevStore ? (prevStore.total_sales || 0) : 0;
      // Previous conversion must use the SAME sensor-clean methodology as the
      // current period — prior clean orders over prior footfall, not raw
      // sales-summary orders — or Δpp is comparing two different bases.
      const prevCleanOrders = pFf ? (pFf.clean_orders != null ? pFf.clean_orders : (pFf.orders || 0)) : 0;
      const prevConv = prevFootfallCount ? (prevCleanOrders / prevFootfallCount) * 100 : null;
      const convDeltaPp = (conv != null && prevConv != null) ? +(conv - prevConv).toFixed(2) : null;

      const footfallDeltaPct = prevFootfallCount > 0 ? pctDelta(footfallCount, prevFootfallCount) : null;
      const spv = footfallCount ? sales / footfallCount : null;
      const prevSpv = prevFootfallCount ? prevSales / prevFootfallCount : null;
      const spvDeltaPct = (spv != null && prevSpv != null && prevSpv > 0) ? pctDelta(spv, prevSpv) : null;

      // Low-traffic when either period is below the noise floor.
      const lowTraffic = footfallCount < FF_LOW || (prevFootfallCount > 0 && prevFootfallCount < FF_LOW);
      // Estimated orders gained/lost from the conversion move: Δpp × footfall.
      const estOrdersDelta = convDeltaPp != null ? Math.round((convDeltaPp / 100) * footfallCount) : null;

      const abv = store ? (store.abv || 0) : 0;
      const prevAbv = store ? store.prev_abv : null;
      const abvDeltaPct = store ? store.d_abv : null;

      return {
        loc, sales, orders, cleanOrders, footfallCount, prevFootfallCount,
        conv, prevConv, convDeltaPp, footfallDeltaPct, spv, prevSpv, spvDeltaPct,
        lowTraffic, estOrdersDelta, sensorGapDays, abv, prevAbv, abvDeltaPct,
        prevOrders, prevSales, prevCleanOrders,
      };
    });
  }, [footfall, enriched, prevFootfallMap, prevMap]);

  // Pinned network total (blended, not averaged). Conversion blends CLEAN
  // orders over total footfall; sales/visitor blends total sales over footfall.
  const ffNetwork = useMemo(() => {
    if (!ffRows.length) return null;
    const sum = (k) => ffRows.reduce((a, r) => a + (r[k] || 0), 0);
    const footfall = sum("footfallCount");
    const prevFootfall = sum("prevFootfallCount");
    const cleanOrders = sum("cleanOrders");
    const orders = sum("orders");
    const sales = sum("sales");
    const prevCleanOrders = sum("prevCleanOrders");
    const prevSales = sum("prevSales");
    const conv = footfall ? (cleanOrders / footfall) * 100 : null;
    const prevConv = prevFootfall ? (prevCleanOrders / prevFootfall) * 100 : null;
    const convDeltaPp = (conv != null && prevConv != null) ? +(conv - prevConv).toFixed(2) : null;
    const spv = footfall ? sales / footfall : null;
    const prevSpv = prevFootfall ? prevSales / prevFootfall : null;
    return {
      footfall, orders, sales, conv, prevConv, convDeltaPp, spv,
      footfallDeltaPct: prevFootfall > 0 ? pctDelta(footfall, prevFootfall) : null,
      spvDeltaPct: (spv != null && prevSpv != null && prevSpv > 0) ? pctDelta(spv, prevSpv) : null,
    };
  }, [ffRows]);

  // Best/worst conversion callout — excludes low-traffic stores (noise).
  const ffCallouts = useMemo(() => {
    const eligible = ffRows.filter((r) => !r.lowTraffic && r.conv != null && r.footfallCount > 0);
    if (eligible.length < 2) return null;
    const best = eligible.reduce((a, b) => (b.conv > a.conv ? b : a));
    const worst = eligible.reduce((a, b) => (b.conv < a.conv ? b : a));
    return { best, worst };
  }, [ffRows]);

  // "1–10 Jun vs 1–10 May 2026"-style period label for the subtitle.
  const ffPeriodLabel = useMemo(() => {
    const cur = fmtRange(dateFrom, dateTo);
    if (compareMode === "none") return cur;
    const p = comparePeriod(dateFrom, dateTo, compareMode, { date_from: compareDateFrom, date_to: compareDateTo });
    return p ? `${cur} vs ${fmtRange(p.date_from, p.date_to)}` : cur;
  }, [dateFrom, dateTo, compareMode, compareDateFrom, compareDateTo]);

  const avg = useMemo(() => {
    if (!enriched.length) return 0;
    return (
      enriched.reduce((s, r) => s + (r.total_sales || 0), 0) / enriched.length
    );
  }, [enriched]);

  const groupTotals = useMemo(() => {
    // Use authoritative API KPIs — never sum per-location rows locally.
    const sales = kpis?.total_sales || 0;
    const orders = kpis?.total_orders || 0;
    const units = kpis?.total_units || 0;
    return {
      abv: orders ? sales / orders : (kpis?.avg_basket_size || 0),
      asp: units ? sales / units : (kpis?.avg_selling_price || 0),
      msi: orders ? units / orders : 0,
    };
  }, [kpis]);

  // Group-level previous-period totals (for KPI delta + prevValue).
  const prevGroupTotals = useMemo(() => {
    if (!rawKpisPrev) return null;
    const sales = rawKpisPrev.total_sales || 0;
    const orders = rawKpisPrev.total_orders || 0;
    const units = rawKpisPrev.total_units || 0;
    return {
      total_sales: sales,
      total_orders: orders,
      total_units: units,
      abv: orders ? sales / orders : (rawKpisPrev.avg_basket_size || 0),
      asp: units ? sales / units : (rawKpisPrev.avg_selling_price || 0),
      msi: orders ? units / orders : 0,
    };
  }, [rawKpisPrev]);

  const compareLbl = compareMode === "yesterday" ? "vs Yesterday" : compareMode === "last_month" ? "vs Last Month" : compareMode === "last_year" ? "vs Last Year" : null;
  const d = (cur, prev) => (cur != null && prev != null) ? pctDelta(cur, prev) : null;

  // Data-quality outlier flagging on return-rate. Physical + online stores
  // whose return rate falls ≥ 2σ above the group mean OR ≥ 30% (structural
  // cap) get a "⚠ verify" chip on their card. Catches the
  // "Vivo Sarit RETURNS ▲ +135.6%" class of anomaly the audit flagged.
  const { enriched: enrichedWithDq, stats: returnStats, count: returnOutlierCount } = useOutliers(
    enriched,
    {
      valueKey: "return_rate",
      filter: (r) => (r.total_sales || 0) >= 100000,  // min 100k KES sample
      hardHi: { at: 30, reason: "Return rate ≥ 30% — suspicious, investigate before using." },
      label: "return rate",
      valueFmt: (v) => `${v.toFixed(1)}%`,
      sigmas: 2,
      outputKey: "return_outlier",
    }
  );

  const sorted = useMemo(() => {
    return [...enrichedWithDq].sort((a, b) => {
      if (sortKey === "avg_basket" || sortKey === "abv") return (b.abv || 0) - (a.abv || 0);
      if (sortKey === "asp") return (b.asp || 0) - (a.asp || 0);
      if (sortKey === "msi") return (b.msi || 0) - (a.msi || 0);
      return (b[sortKey] || 0) - (a[sortKey] || 0);
    });
  }, [enrichedWithDq, sortKey]);

  // --- Average Basket Value table model ----------------------------------
  // One decorated row per location. ABV = Total Sales ÷ Orders, decomposed
  // into Items/Order (msi) × Avg Item Price (asp). A store too thin to trust
  // in EITHER period is flagged low-volume (deltas suppressed, sorted last by
  // default, badged). prev_* come from the sales-summary compare fan-out.
  const abvRows = useMemo(() => {
    return enrichedWithDq.map((r) => {
      const orders = r.orders || 0;
      const prevOrders = r.prev_orders;
      const lowVolume =
        orders < ABV_LOW_ORDERS ||
        (prevOrders != null && prevOrders < ABV_LOW_ORDERS);
      const abvDeltaKes =
        r.abv != null && r.prev_abv != null ? r.abv - r.prev_abv : null;
      return {
        loc: r.channel,
        orders,
        prevOrders,
        sales: r.total_sales || 0,
        abv: r.abv,
        prevAbv: r.prev_abv,
        abvDeltaKes,
        abvDeltaPct: r.d_abv,
        msi: r.msi,
        prevMsi: r.prev_msi,
        asp: r.asp,
        prevAsp: r.prev_asp,
        lowVolume,
      };
    });
  }, [enrichedWithDq]);

  // Pinned "Network Average" benchmark — Total Sales ÷ Total Orders across all
  // locations (sourced from authoritative KPIs so it matches Overview/CEO).
  const abvNetwork = useMemo(() => {
    if (!abvRows.length) return null;
    const orders = kpis?.total_orders || 0;
    const sales = kpis?.total_sales || 0;
    const abv = groupTotals.abv;
    const prevAbv = prevGroupTotals?.abv ?? null;
    const abvDeltaKes = abv != null && prevAbv != null ? abv - prevAbv : null;
    const abvDeltaPct = prevAbv != null ? pctDelta(abv, prevAbv) : null;
    return { orders, sales, abv, prevAbv, abvDeltaKes, abvDeltaPct };
  }, [abvRows, kpis, groupTotals, prevGroupTotals]);

  // Personalisation: store staff (role store_manager) get their own store row
  // auto-highlighted + a one-line summary. There is NO store↔user mapping in
  // app_users, so we match the user's display name to a location name (exact,
  // case-insensitive). Fails safe: no match → no highlight, no false claim.
  const myStoreLoc = useMemo(() => {
    if (!user || (user.role || "").toLowerCase() !== "store_manager") return null;
    const name = (user.name || "").trim().toLowerCase();
    if (!name) return null;
    const hit = abvRows.find((r) => (r.loc || "").trim().toLowerCase() === name);
    return hit ? hit.loc : null;
  }, [user, abvRows]);

  // Sum of sales across all in-scope locations — used to surface a "% of
  // total" chip on each location card AND to power the bottom-of-page
  // "Locations needing attention" insight panel.
  const totalSalesAll = useMemo(
    () => enrichedWithDq.reduce((s, r) => s + (r.total_sales || 0), 0),
    [enrichedWithDq]
  );

  // Shared leaderboard badges (also used on Overview). Extracted into
  // `/app/frontend/src/components/LocationLeaderboard.jsx` so both pages
  // compute identical winners for the same filters. `enriched` already
  // carries `prev_sales` inline — re-shape into the array the hook wants.
  const prevRowsForBadges = useMemo(
    () => enriched.map((r) => ({ channel: r.channel, total_sales: r.prev_sales || 0 })),
    [enriched]
  );
  const leaderBadges = useLocationBadges({
    sales: enriched, prevSales: prevRowsForBadges, footfall,
    compareMode, compareLbl,
  });
  const leaderStreaks = useLeaderboardStreaks();

  return (
    <div className="space-y-6" data-testid="locations-page">
      {(loading || kpisLoading) && <Loading />}
      {(error || kpisError) && <ErrorBox message={error || kpisError} />}

      {!loading && !kpisLoading && !error && kpis && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KPICard
              testId="loc-kpi-sales"
              accent
              label="Total Sales"
              value={fmtKES(kpis.total_sales)}
              delta={d(kpis.total_sales, prevGroupTotals?.total_sales)}
              deltaLabel={compareLbl}
              prevValue={prevGroupTotals && compareMode !== "none" ? fmtKES(prevGroupTotals.total_sales) : null}
              showDelta={compareMode !== "none"}
              action={{ label: "Sales breakdown", to: "/overview" }}
            />
            <KPICard
              testId="loc-kpi-orders"
              label="Transactions"
              value={fmtNum(kpis.total_orders)}
              delta={d(kpis.total_orders, prevGroupTotals?.total_orders)}
              deltaLabel={compareLbl}
              prevValue={prevGroupTotals && compareMode !== "none" ? fmtNum(prevGroupTotals.total_orders) : null}
              showDelta={compareMode !== "none"}
              action={{ label: "Order export", to: "/exports" }}
            />
            <KPICard
              testId="loc-kpi-units"
              label="Total Units"
              value={fmtNum(kpis.total_units)}
              delta={d(kpis.total_units, prevGroupTotals?.total_units)}
              deltaLabel={compareLbl}
              prevValue={prevGroupTotals && compareMode !== "none" ? fmtNum(prevGroupTotals.total_units) : null}
              showDelta={compareMode !== "none"}
              action={{ label: "Top styles", to: "/products" }}
            />
            <KPICard small testId="loc-kpi-abv" label="ABV" sub="Sales ÷ Orders" value={fmtKES(groupTotals.abv)}
              delta={d(groupTotals.abv, prevGroupTotals?.abv)}
              deltaLabel={compareLbl}
              prevValue={prevGroupTotals && compareMode !== "none" ? fmtKES(prevGroupTotals.abv) : null}
              showDelta={compareMode !== "none"}
              action={{ label: "Sort by ABV", onClick: () => { setSortKey && setSortKey("abv"); document.querySelector('[data-testid="locations-grid"]')?.scrollIntoView({ behavior: "smooth" }); } }}
            />
            <KPICard small testId="loc-kpi-asp" label="ASP" sub="Sales ÷ Units" value={fmtKES(groupTotals.asp)}
              delta={d(groupTotals.asp, prevGroupTotals?.asp)}
              deltaLabel={compareLbl}
              prevValue={prevGroupTotals && compareMode !== "none" ? fmtKES(prevGroupTotals.asp) : null}
              showDelta={compareMode !== "none"}
              action={{ label: "Sort by ASP", onClick: () => { setSortKey && setSortKey("asp"); document.querySelector('[data-testid="locations-grid"]')?.scrollIntoView({ behavior: "smooth" }); } }}
            />
            <KPICard small testId="loc-kpi-msi" label="MSI" sub="Units ÷ Orders" value={groupTotals.msi.toFixed(2)}
              delta={d(groupTotals.msi, prevGroupTotals?.msi)}
              deltaLabel={compareLbl}
              prevValue={prevGroupTotals && compareMode !== "none" ? prevGroupTotals.msi.toFixed(2) : null}
              showDelta={compareMode !== "none"}
              action={{ label: "Sort by MSI", onClick: () => { setSortKey && setSortKey("msi"); document.querySelector('[data-testid="locations-grid"]')?.scrollIntoView({ behavior: "smooth" }); } }}
            />
          </div>

          {/* Sort + leaderboard + grid — kept visible behind the deep-dive
              slide-over so users can jump between stores without losing
              context (the drill pattern the audit asked for). */}
          <>
              <div className="card-white p-3 flex items-center gap-2 flex-wrap">
                <ArrowsDownUp size={14} className="text-muted ml-1" />
                <span className="text-[12px] text-muted">Sort by:</span>
                {[
                  ["total_sales", "Total Sales"],
                  ["total_orders", "Orders"],
                  ["units_sold", "Units"],
                  ["total_footfall", "Footfall"],
                  ["abv", "ABV"],
                  ["asp", "ASP"],
                  ["msi", "MSI"],
                ].map(([k, lbl]) => (
                  <button
                    key={k}
                    data-testid={`loc-sort-${k}`}
                    className={`px-2.5 py-1 rounded-lg text-[12px] font-medium ${
                      sortKey === k
                        ? "bg-brand text-white"
                        : "hover:bg-panel text-foreground/70"
                    }`}
                    onClick={() => setSortKey(k)}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              {/* "Click any card to drill in" hint + legend — communicates
                  the deep-dive interaction AND tells users how to read the
                  blue % chip on each card. */}
              <div
                className="rounded-lg bg-brand-soft/50 border border-brand/20 px-3 py-2 text-[12.5px] text-foreground/75 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5"
                data-testid="locations-deep-dive-hint"
              >
                <span className="inline-flex items-center gap-2">
                  <span aria-hidden="true">👆</span>
                  <span>
                    <b className="text-brand-deep">Click any card</b> to open the
                    store deep-dive — full KPI history, daily trend, top SKUs and
                    return-rate context.
                  </span>
                </span>
                <span
                  className="inline-flex items-center gap-1.5 text-[11.5px] shrink-0"
                  data-testid="pct-share-legend"
                >
                  <span className="font-bold text-[#1e6ad6]">12.3%</span>
                  <span className="text-muted">= share of total sales across in-scope locations</span>
                </span>
              </div>

              {/* Return-rate data-quality banner — reuses the platform-wide
                  outlier kernel to flag stores whose returns sit outside the
                  group norm (catches the "RETURNS ▲ +135%" anomaly class). */}
              <DataQualityBanner
                count={returnOutlierCount}
                noun="stores"
                statsLine={`return rate outside ±2σ (group avg ${returnStats.mean.toFixed(1)}% ± ${returnStats.sd.toFixed(1)}pp)`}
                action="verify the refund data before trusting the delta."
                testId="returns-dq-banner"
              />

              <div
                className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3"
                data-testid="locations-grid"
              >
                {sorted.length === 0 && <Empty />}
                {sorted.map((l, i) => {
                  const above = (l.total_sales || 0) >= avg;
                  const borderCls = above ? "border-brand/40" : "border-red-300";
                  // % share of group total — surfaced inline in the card
                  // header so users see "this store ≈ X% of all sales".
                  const pctShare =
                    totalSalesAll && l.total_sales != null
                      ? (l.total_sales / totalSalesAll) * 100
                      : null;
                  return (
                    <button
                      key={`${l.channel}-${i}`}
                      className={`card-white p-4 hover-lift text-left border-l-4 ${borderCls} relative`}
                      data-testid={`location-card-${l.channel}`}
                      onClick={() => setSelected(l.channel)}
                      onMouseEnter={() => {
                        // Iter 78 — prefetch the StoreDeepDive payload
                        // so the slide-over opens instantly when the
                        // card is actually clicked. Fire-and-forget;
                        // idempotent via lib/api's response cache.
                        const pf = { date_from: dateFrom, date_to: dateTo, channel: l.channel, limit: 10 };
                        api.get("/top-skus", { params: pf }).catch(() => {});
                        api.get("/top-customers", { params: pf }).catch(() => {});
                      }}
                    >
                      {/* Deep-dive affordance — a subtle ArrowUpRight pinned
                          to the top-right corner of every card so the user
                          knows the card is interactive even before reading
                          the banner above. Lights up on hover. */}
                      <div
                        className="absolute top-2.5 right-2.5 w-6 h-6 rounded-full grid place-items-center text-muted/70 hover:text-brand-deep hover:bg-brand-soft/60 transition-colors"
                        aria-hidden="true"
                        data-testid="card-deep-dive-icon"
                      >
                        <ArrowUpRight size={13} weight="bold" />
                      </div>
                      <div className="flex items-start gap-2.5 min-w-0">
                        <div className="w-9 h-9 rounded-lg bg-brand-soft text-brand grid place-items-center shrink-0">
                          <Storefront size={18} weight="duotone" />
                        </div>
                        <div className="min-w-0 flex-1">
                          {/* Name + sales sit on a SINGLE LINE so the card
                              header reads as one phrase. The full sales
                              value is the dominant element; the % share
                              chip and country line follow on subsequent
                              rows. The location name truncates rather
                              than wrapping, with a title attribute for
                              the full string. */}
                          <div className="flex items-baseline flex-wrap gap-x-2 gap-y-0.5 leading-tight">
                            <div className="font-bold text-[14px] truncate min-w-0" title={l.channel}>
                              {l.channel}
                            </div>
                            <div className="font-extrabold text-[15px] text-brand-deep num shrink-0">
                              {fmtKES(l.total_sales)}
                            </div>
                            {pctShare != null && (
                              <span
                                className="text-[10.5px] font-semibold text-[#1e6ad6] shrink-0"
                                data-testid={`loc-${l.channel}-pct-share`}
                                title="Share of total sales across all locations in scope"
                              >
                                {pctShare.toFixed(1)}%
                              </span>
                            )}
                          </div>
                          {/* Country line removed per spec — sales delta now
                              sits on its own row directly under the value/share
                              for a cleaner card. */}
                          {compareMode !== "none" && (
                            <div className="text-[11.5px] text-muted mt-1 flex items-center">
                              <InlineDelta delta={l.d_sales} testId={`loc-${l.channel}-d-sales`} compact />
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-2 mt-3">
                        <div>
                          <div className="eyebrow">Orders</div>
                          <div className="font-semibold text-[13px] num mt-0.5">
                            {fmtNum(l.orders)}
                          </div>
                          {compareMode !== "none" && (
                            <InlineDelta delta={l.d_orders} testId={`loc-${l.channel}-d-orders`} compact />
                          )}
                        </div>
                        <div>
                          <div className="eyebrow">Units</div>
                          <div className="font-semibold text-[13px] num mt-0.5">
                            {fmtNum(l.units_sold)}
                          </div>
                          {compareMode !== "none" && (
                            <InlineDelta delta={l.d_units} testId={`loc-${l.channel}-d-units`} compact />
                          )}
                        </div>
                        <div>
                          <div className="eyebrow">Returns</div>
                          <div
                            className={`font-semibold text-[13px] num mt-0.5 ${
                              (l.returns || 0) > 0 ? "text-danger" : ""
                            }`}
                          >
                            {fmtKES(l.returns || 0)}
                          </div>
                          {compareMode !== "none" && (
                            // Returns: rising is BAD → higherIsBetter=false
                            <InlineDelta delta={l.d_returns} higherIsBetter={false} testId={`loc-${l.channel}-d-returns`} compact />
                          )}
                        </div>
                        <div>
                          <div className="eyebrow">ABV</div>
                          <div className="font-semibold text-[13px] num mt-0.5">
                            {fmtKES(l.abv)}
                          </div>
                          {compareMode !== "none" && (
                            <InlineDelta delta={l.d_abv} testId={`loc-${l.channel}-d-abv`} compact />
                          )}
                        </div>
                        <div>
                          <div className="eyebrow">ASP</div>
                          <div className="font-semibold text-[13px] num mt-0.5">
                            {fmtKES(l.asp)}
                          </div>
                          {compareMode !== "none" && (
                            <InlineDelta delta={l.d_asp} testId={`loc-${l.channel}-d-asp`} compact />
                          )}
                        </div>
                        <div>
                          <div className="eyebrow">MSI</div>
                          <div className="font-semibold text-[13px] num mt-0.5">
                            {(l.msi || 0).toFixed(2)}
                          </div>
                          {compareMode !== "none" && (
                            <InlineDelta delta={l.d_msi} testId={`loc-${l.channel}-d-msi`} compact />
                          )}
                        </div>
                      </div>
                      {/* Bottom-of-card deep-dive prompt — restated per
                          card so users mid-grid see the cue without
                          scrolling back to the banner above. Picks up the
                          card's hover via the parent .hover-lift. */}
                      <div className="mt-4 pt-3 border-t border-border/60 flex items-center justify-between text-[11.5px]">
                        <span className="text-muted inline-flex items-center gap-1">
                          <span aria-hidden="true">👆</span>
                          <span>Click for deep dive</span>
                        </span>
                        <span className="font-semibold text-brand-deep inline-flex items-center gap-0.5">
                          <span>More info</span>
                          <ArrowUpRight size={11} weight="bold" />
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Stock-to-Sales · by Subcategory — moved from the bottom
                  of the page (iter 88b) so location-focused users see the
                  merchandise-mix imbalance immediately below the store
                  cards. This card runs its OWN date filter (independent of
                  the page-wide one at the top) and defaults to the last
                  30 days. */}
              <StockToSalesBySubcategory
                testIdPrefix="locations-sts-subcat"
                exportNameFlat="locations-stock-to-sales-by-subcategory.csv"
                exportNameGrouped="locations-stock-to-sales-by-subcategory-grouped.csv"
                useOwnDates
                defaultLookbackDays={30}
              />

              {(() => {
                const compare = compareMode !== "none";
                const lmTag = compareMode === "yesterday" ? "Yd" : compareMode === "last_month" ? "LM" : "LY";
                // Explicit comparison periods for the subtitle, e.g.
                // "1–10 Jun 2026 vs 1–10 May 2026 (MTD comparison)".
                const curRange = fmtRange(dateFrom, dateTo);
                const prevP = compare
                  ? comparePeriod(dateFrom, dateTo, compareMode, { date_from: compareDateFrom, date_to: compareDateTo })
                  : null;
                const cmpNote = compareMode === "yesterday" ? "prior-day comparison" : compareMode === "last_month" ? "MTD comparison" : "YoY comparison";
                const subtitle = compare && prevP
                  ? `Total Sales ÷ Orders — the value of each customer transaction. ${curRange} vs ${fmtRange(prevP.date_from, prevP.date_to)} (${cmpNote}) · KES. Click a row to decompose the basket.`
                  : `Total Sales ÷ Orders — the value of each customer transaction. ${curRange} · KES. Click a row to decompose the basket.`;

                const accessors = {
                  location: (r) => r.loc,
                  orders: (r) => r.orders,
                  total_sales: (r) => r.sales,
                  abv: (r) => r.abv,
                  prev_abv: (r) => r.prevAbv,
                  d_abv_kes: (r) => r.abvDeltaKes,
                  d_abv_pct: (r) => r.abvDeltaPct,
                };
                const sortLabels = {
                  location: "Location", orders: "Orders", total_sales: "Total Sales",
                  abv: "ABV", prev_abv: `ABV (${lmTag})`, d_abv_kes: "Δ ABV (KES)", d_abv_pct: "Δ ABV (%)",
                };
                // Default (no manual sort): trustworthy rows by ABV desc, then
                // low-volume rows pushed to the bottom. Manual sort applies to
                // every row uniformly.
                const sortedAbv = abvSort.sort
                  ? abvSort.sortRows(abvRows, accessors)
                  : [...abvRows].sort((a, b) => {
                      if (a.lowVolume !== b.lowVolume) return a.lowVolume ? 1 : -1;
                      return (b.abv || 0) - (a.abv || 0);
                    });
                const activeSort = abvSort.sort;
                const nCols = compare ? 8 : 5;

                const myRow = myStoreLoc ? abvRows.find((r) => r.loc === myStoreLoc) : null;

                return (
                  <div className="card-white p-5" data-testid="abv-by-location">
                    <SectionTitle
                      title="Average Basket Value by Location"
                      subtitle={
                        activeSort
                          ? `${subtitle.replace(/Click a row.*$/, "")}Sorted by ${sortLabels[activeSort.key] || "ABV"} ${activeSort.dir === "asc" ? "↑" : "↓"}. Click a row to decompose the basket.`
                          : subtitle
                      }
                    />

                    {/* Store-staff personalisation: one-line summary above the
                        table when the signed-in manager's store is in scope. */}
                    {myRow && (
                      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[#1a5c38]/25 bg-[#1a5c38]/[0.06] px-3 py-2 text-[12px]" data-testid="abv-mystore-summary">
                        <Storefront size={14} weight="bold" className="text-[#1a5c38]" />
                        <span className="text-[#1a1a1a]">
                          Your store <span className="font-semibold text-[#0f3d24]">{myRow.loc}</span>{" "}
                          {myRow.lowVolume
                            ? "has too few orders this period to read a reliable basket value."
                            : <>has an average basket of <span className="font-semibold">{fmtKESLong(myRow.abv)}</span>{abvNetwork && abvNetwork.abv != null && (
                                <> — {myRow.abv >= abvNetwork.abv ? "above" : "below"} the network average of <span className="font-semibold">{fmtKESLong(abvNetwork.abv)}</span></>
                              )}{compare && myRow.abvDeltaKes != null && (
                                <> ({fmtKESDelta(myRow.abvDeltaKes)} vs {lmTag})</>
                              )}.</>}
                        </span>
                      </div>
                    )}

                    <div className="overflow-x-auto max-h-[640px] overflow-y-auto">
                      <table className="w-full data abv-compact" data-testid="abv-table">
                        <thead className="sticky top-0 z-10 bg-white">
                          <tr>
                            <th className="w-10">#</th>
                            <SortableTh sortKey="location" sort={abvSort.sort} onSort={abvSort.toggleSort}>Location</SortableTh>
                            <SortableTh sortKey="orders" sort={abvSort.sort} onSort={abvSort.toggleSort} numeric>Orders</SortableTh>
                            <SortableTh sortKey="total_sales" sort={abvSort.sort} onSort={abvSort.toggleSort} numeric>Total Sales</SortableTh>
                            <SortableTh sortKey="abv" sort={abvSort.sort} onSort={abvSort.toggleSort} numeric title="Total Sales ÷ Orders">ABV</SortableTh>
                            {compare && <SortableTh sortKey="prev_abv" sort={abvSort.sort} onSort={abvSort.toggleSort} numeric title={`ABV last ${lmTag === "Yd" ? "day" : lmTag === "LM" ? "month" : "year"}`}>ABV ({lmTag})</SortableTh>}
                            {compare && <SortableTh sortKey="d_abv_kes" sort={abvSort.sort} onSort={abvSort.toggleSort} numeric>Δ ABV (KES)</SortableTh>}
                            {compare && <SortableTh sortKey="d_abv_pct" sort={abvSort.sort} onSort={abvSort.toggleSort} numeric>Δ ABV (%)</SortableTh>}
                          </tr>
                        </thead>
                        <tbody>
                          {abvRows.length === 0 && (
                            <tr><td colSpan={nCols + 1}><Empty label="No sales data in this period." /></td></tr>
                          )}

                          {/* Pinned network-average benchmark */}
                          {abvNetwork && abvRows.length > 0 && (
                            <tr className="bg-[#f6efe6] font-semibold border-b-2 border-stone-300" data-testid="abv-network-row">
                              <td className="text-muted text-center">—</td>
                              <td className="text-[#0f3d24]">Network Average</td>
                              <td className="text-right num">{fmtNum(abvNetwork.orders)}</td>
                              <td className="text-right num font-normal">{fmtKESLong(abvNetwork.sales)}</td>
                              <td className="text-right num text-[#0f3d24] font-bold">{abvNetwork.abv == null ? "—" : fmtKESLong(abvNetwork.abv)}</td>
                              {compare && <td className="text-right num text-muted">{abvNetwork.prevAbv == null ? "—" : fmtKESLong(abvNetwork.prevAbv)}</td>}
                              {compare && (
                                <td className={`text-right num ${abvNetwork.abvDeltaKes == null ? "text-muted" : abvNetwork.abvDeltaKes > 0 ? "text-emerald-700" : abvNetwork.abvDeltaKes < 0 ? "text-red-700" : "text-muted"}`}>
                                  {abvNetwork.abvDeltaKes == null ? "—" : fmtKESDelta(abvNetwork.abvDeltaKes)}
                                </td>
                              )}
                              {compare && (
                                <td className="text-right num">{abvNetwork.abvDeltaPct == null ? <span className="text-muted">—</span> : <InlineDelta delta={abvNetwork.abvDeltaPct} compact />}</td>
                              )}
                            </tr>
                          )}

                          {sortedAbv.map((r, i) => {
                            const open = expandedAbv === r.loc;
                            const mine = myStoreLoc && r.loc === myStoreLoc;
                            const muted = r.lowVolume ? "text-muted" : "";
                            return (
                              <React.Fragment key={r.loc + i}>
                                <tr
                                  className={`cursor-pointer hover:bg-stone-50/70 ${mine ? "bg-[#1a5c38]/[0.06]" : ""}`}
                                  onClick={() => setExpandedAbv(open ? null : r.loc)}
                                  data-testid={`abv-row-${r.loc}`}
                                >
                                  <td className="text-muted">
                                    <span className="inline-flex items-center gap-1 num">
                                      {open ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
                                      {i + 1}
                                    </span>
                                  </td>
                                  <td className="font-medium">
                                    <span className="inline-flex items-center gap-1.5">
                                      <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); setSelected(r.loc); }}
                                        className="text-left hover:text-brand hover:underline decoration-dotted underline-offset-[3px]"
                                        data-testid={`abv-row-link-${r.loc}`}
                                      >
                                        {r.loc}
                                      </button>
                                      {mine && (
                                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide bg-[#1a5c38] text-white">Your store</span>
                                      )}
                                      {r.lowVolume && (
                                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide bg-stone-100 text-muted border border-stone-200" title={`Fewer than ${ABV_LOW_ORDERS} orders in this period or the comparison period — basket value is statistically unreliable.`}>Low volume</span>
                                      )}
                                    </span>
                                  </td>
                                  <td className="text-right num">{fmtNum(r.orders)}</td>
                                  <td className="text-right num font-normal">{fmtKESLong(r.sales)}</td>
                                  <td className={`text-right num font-bold ${r.lowVolume ? "text-muted" : "text-[#0f3d24]"}`}>
                                    {r.abv == null ? "—" : fmtKESLong(r.abv)}
                                  </td>
                                  {compare && (
                                    <td className={`text-right num ${r.lowVolume ? "text-muted/70" : "text-muted"}`}>
                                      {r.lowVolume || r.prevAbv == null ? "—" : fmtKESLong(r.prevAbv)}
                                    </td>
                                  )}
                                  {compare && (
                                    <td className={`text-right num ${r.lowVolume ? "text-muted" : r.abvDeltaKes == null ? "text-muted" : r.abvDeltaKes > 0 ? "text-emerald-700 font-semibold" : r.abvDeltaKes < 0 ? "text-red-700 font-semibold" : "text-muted"}`}>
                                      {r.lowVolume || r.abvDeltaKes == null ? "—" : fmtKESDelta(r.abvDeltaKes)}
                                    </td>
                                  )}
                                  {compare && (
                                    <td className="text-right num">
                                      {r.lowVolume || r.abvDeltaPct == null ? <span className="text-muted">—</span> : <span className="text-[11px]"><InlineDelta delta={r.abvDeltaPct} compact /></span>}
                                    </td>
                                  )}
                                </tr>
                                {open && (
                                  <tr className="bg-[#faf6ef]" data-testid={`abv-expand-${r.loc}`}>
                                    <td colSpan={nCols + 1} className="p-3">
                                      <div className="text-[11px] text-muted mb-2">
                                        Basket decomposition for <span className="font-semibold text-[#0f3d24]">{r.loc}</span> — ABV = Items per Order × Average Item Price.
                                      </div>
                                      <div className="flex flex-wrap gap-3">
                                        <LeverTile
                                          icon={Coins}
                                          label="Avg basket (ABV)"
                                          cur={r.abv}
                                          prev={r.prevAbv}
                                          fmt={(v) => (v == null ? "n/a" : fmtKESLong(v))}
                                          delta={r.abvDeltaPct}
                                          note="Total Sales ÷ Orders."
                                        />
                                        <LeverTile
                                          icon={Stack}
                                          label="Items per order"
                                          cur={r.msi}
                                          prev={r.prevMsi}
                                          fmt={(v) => (v == null ? "n/a" : v.toFixed(2))}
                                          delta={r.prevMsi ? pctDelta(r.msi, r.prevMsi) : null}
                                          note="Units ÷ Orders (basket size)."
                                        />
                                        <LeverTile
                                          icon={Tag}
                                          label="Avg item price"
                                          cur={r.asp}
                                          prev={r.prevAsp}
                                          fmt={(v) => (v == null ? "n/a" : fmtKESLong(v))}
                                          delta={r.prevAsp ? pctDelta(r.asp, r.prevAsp) : null}
                                          note="Sales ÷ Units (price point)."
                                        />
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {(() => {
                const compare = compareMode !== "none";
                const activeSort = ffSort.sort || { key: "spv", dir: "desc" };
                const sortLabels = {
                  location: "Location", footfall: "Footfall", ff_delta: "Δ Footfall",
                  orders: "Orders", conversion: "Conversion", prev_conv: "Conversion (LM)",
                  spv: "Sales/Visitor", total_sales: "Total Sales",
                };
                const accessors = {
                  location: (r) => r.loc,
                  footfall: (r) => r.footfallCount,
                  ff_delta: (r) => r.footfallDeltaPct,
                  orders: (r) => r.orders,
                  conversion: (r) => r.conv,
                  prev_conv: (r) => r.prevConv,
                  spv: (r) => r.spv,
                  total_sales: (r) => r.sales,
                };
                const sortedFf = ffSort.sort
                  ? ffSort.sortRows(ffRows, accessors)
                  : [...ffRows].sort((a, b) => (b.spv || 0) - (a.spv || 0));
                const nColumns = compare ? 8 : 6;
                const lmTag = compareMode === "yesterday" ? "Yd" : compareMode === "last_month" ? "LM" : "LY";

                return (
                  <div className="card-white p-5" data-testid="footfall-section">
                    <SectionTitle
                      title="Footfall & Conversion"
                      subtitle={`Sales/Visitor (Total Sales ÷ Footfall) is the headline efficiency metric. Sorted by ${sortLabels[activeSort.key] || "Sales/Visitor"} ${activeSort.dir === "asc" ? "↑" : "↓"} · ${ffPeriodLabel} · KES. Conversion uses sensor-clean days; click a store to diagnose the gap.`}
                    />

                    {/* Conversion legend + best/worst callout */}
                    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 mb-3 text-[11px]">
                      <div className="flex items-center gap-3 text-muted">
                        <span className="font-semibold uppercase tracking-wide">Conversion</span>
                        <span className="inline-flex items-center gap-1"><i className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500" />≥{CONV_GREEN}% strong</span>
                        <span className="inline-flex items-center gap-1"><i className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500" />{CONV_AMBER}–{CONV_GREEN}% watch</span>
                        <span className="inline-flex items-center gap-1"><i className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" />&lt;{CONV_AMBER}% weak</span>
                        <span className="inline-flex items-center gap-1"><Warning size={12} weight="bold" className="text-amber-600" />sensor gap</span>
                        <span className="opacity-70">Low traffic (&lt;{FF_LOW}) muted</span>
                      </div>
                      {ffCallouts && (
                        <div className="flex items-center gap-4">
                          <span className="text-muted">Best <span className="font-semibold text-emerald-700">{ffCallouts.best.loc} {fmtPct(ffCallouts.best.conv)}</span></span>
                          <span className="text-muted">Watch <span className="font-semibold text-red-700">{ffCallouts.worst.loc} {fmtPct(ffCallouts.worst.conv)}</span></span>
                        </div>
                      )}
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full data" data-testid="footfall-table">
                        <thead>
                          <tr>
                            <th className="w-5" />
                            <SortableTh sortKey="location" sort={ffSort.sort} onSort={ffSort.toggleSort}>Location</SortableTh>
                            <SortableTh sortKey="footfall" sort={ffSort.sort} onSort={ffSort.toggleSort} numeric>Footfall</SortableTh>
                            {compare && <SortableTh sortKey="ff_delta" sort={ffSort.sort} onSort={ffSort.toggleSort} numeric>Δ Footfall</SortableTh>}
                            <SortableTh sortKey="orders" sort={ffSort.sort} onSort={ffSort.toggleSort} numeric>Orders</SortableTh>
                            <SortableTh sortKey="conversion" sort={ffSort.sort} onSort={ffSort.toggleSort} numeric>Conversion</SortableTh>
                            {compare && <SortableTh sortKey="prev_conv" sort={ffSort.sort} onSort={ffSort.toggleSort} numeric title={`Conversion last ${lmTag === "Yd" ? "day" : lmTag === "LM" ? "month" : "year"}`}>Conv ({lmTag})</SortableTh>}
                            <SortableTh sortKey="spv" sort={ffSort.sort} onSort={ffSort.toggleSort} numeric title="Total Sales ÷ Footfall">Sales/Visitor</SortableTh>
                            <SortableTh sortKey="total_sales" sort={ffSort.sort} onSort={ffSort.toggleSort} numeric>Total Sales</SortableTh>
                          </tr>
                        </thead>
                        <tbody>
                          {ffRows.length === 0 && (
                            <tr><td colSpan={nColumns + 1}><Empty label="No footfall data in this period." /></td></tr>
                          )}

                          {/* Pinned network total */}
                          {ffNetwork && ffRows.length > 0 && (
                            <tr className="bg-[#f6efe6] font-semibold border-b-2 border-stone-300" data-testid="ff-network-row">
                              <td />
                              <td className="text-[#0f3d24]">Network total</td>
                              <td className="text-right num">{fmtNum(ffNetwork.footfall)}</td>
                              {compare && (
                                <td className="text-right num">{ffNetwork.footfallDeltaPct == null ? "—" : <InlineDelta delta={ffNetwork.footfallDeltaPct} compact />}</td>
                              )}
                              <td className="text-right num">{fmtNum(ffNetwork.orders)}</td>
                              <td className="text-right">
                                <span className={convBand(ffNetwork.conv, false)}>{fmtPct(ffNetwork.conv)}</span>
                                {compare && ffNetwork.convDeltaPp != null && (
                                  <div className={`text-[10px] mt-0.5 font-semibold ${ffNetwork.convDeltaPp > 0 ? "text-emerald-700" : ffNetwork.convDeltaPp < 0 ? "text-red-700" : "text-muted"}`}>
                                    {ffNetwork.convDeltaPp > 0 ? "▲" : ffNetwork.convDeltaPp < 0 ? "▼" : ""} {Math.abs(ffNetwork.convDeltaPp).toFixed(1)}pp
                                  </div>
                                )}
                              </td>
                              {compare && <td className="text-right num text-muted">{ffNetwork.prevConv == null ? "—" : fmtPct(ffNetwork.prevConv)}</td>}
                              <td className="text-right num text-[#0f3d24] font-bold">
                                {ffNetwork.spv == null ? "—" : fmtKESLong(ffNetwork.spv)}
                                {compare && ffNetwork.spvDeltaPct != null && (
                                  <div className="text-[10px] font-normal"><InlineDelta delta={ffNetwork.spvDeltaPct} compact /></div>
                                )}
                              </td>
                              <td className="text-right num">{fmtKES(ffNetwork.sales)}</td>
                            </tr>
                          )}

                          {sortedFf.map((r, i) => {
                            const open = expandedFf === r.loc;
                            return (
                              <React.Fragment key={r.loc + i}>
                                <tr
                                  className="cursor-pointer hover:bg-stone-50/70"
                                  onClick={() => setExpandedFf(open ? null : r.loc)}
                                  data-testid={`ff-row-${r.loc}`}
                                >
                                  <td className="text-muted pl-1">
                                    {open ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
                                  </td>
                                  <td className="font-medium">
                                    <span className="inline-flex items-center gap-1.5">
                                      {r.loc}
                                      {r.sensorGapDays > 0 && (
                                        <Warning
                                          size={13}
                                          weight="fill"
                                          className="text-amber-600"
                                          title={`Sensor gap: ${r.sensorGapDays} day(s) had sales but zero footfall — excluded from the conversion calc.`}
                                        />
                                      )}
                                      {r.lowTraffic && (
                                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide bg-stone-100 text-muted border border-stone-200">Low traffic</span>
                                      )}
                                    </span>
                                  </td>
                                  <td className="text-right num">{fmtNum(r.footfallCount)}</td>
                                  {compare && (
                                    <td className="text-right num">
                                      {r.footfallDeltaPct == null ? <span className="text-muted text-[11px]">—</span> : <InlineDelta delta={r.footfallDeltaPct} compact />}
                                    </td>
                                  )}
                                  <td className="text-right num">{fmtNum(r.orders)}</td>
                                  <td className="text-right">
                                    <span className={convBand(r.conv, r.lowTraffic)}>{r.conv == null ? "—" : fmtPct(r.conv)}</span>
                                    {compare && (
                                      r.lowTraffic ? (
                                        <div className="text-[10px] mt-0.5 text-muted">Δ muted</div>
                                      ) : r.convDeltaPp != null ? (
                                        <div
                                          className={`text-[10px] mt-0.5 font-semibold ${r.convDeltaPp > 0 ? "text-emerald-700" : r.convDeltaPp < 0 ? "text-red-700" : "text-muted"}`}
                                          title={`${r.estOrdersDelta >= 0 ? "≈ +" : "≈ "}${r.estOrdersDelta} orders vs ${lmTag} (Δpp × footfall)`}
                                        >
                                          {r.convDeltaPp > 0 ? "▲" : r.convDeltaPp < 0 ? "▼" : ""} {Math.abs(r.convDeltaPp).toFixed(1)}pp
                                        </div>
                                      ) : null
                                    )}
                                  </td>
                                  {compare && (
                                    <td className="text-right num text-muted">{r.prevConv == null ? "—" : fmtPct(r.prevConv)}</td>
                                  )}
                                  <td className="text-right num text-[#0f3d24] font-bold">
                                    {r.spv == null ? "—" : fmtKESLong(r.spv)}
                                    {compare && r.spvDeltaPct != null && (
                                      <div className="text-[10px] font-normal"><InlineDelta delta={r.spvDeltaPct} compact /></div>
                                    )}
                                  </td>
                                  <td className="text-right num font-semibold">{fmtKES(r.sales)}</td>
                                </tr>
                                {open && (
                                  <tr className="bg-[#faf6ef]" data-testid={`ff-expand-${r.loc}`}>
                                    <td colSpan={nColumns + 1} className="p-3">
                                      <div className="text-[11px] text-muted mb-2">
                                        Diagnose the gap for <span className="font-semibold text-[#0f3d24]">{r.loc}</span> — is the move traffic, conversion, or basket?
                                        {r.sensorGapDays > 0 && (
                                          <span className="ml-2 inline-flex items-center gap-1 text-amber-700"><Warning size={12} weight="fill" />{r.sensorGapDays} sensor-gap day(s) excluded from conversion</span>
                                        )}
                                      </div>
                                      <div className="flex flex-wrap gap-3">
                                        <LeverTile
                                          icon={Footprints}
                                          label="Footfall"
                                          cur={r.footfallCount}
                                          prev={r.prevFootfallCount || null}
                                          fmt={(v) => fmtNum(v)}
                                          delta={r.footfallDeltaPct}
                                          note="Visitors through the door."
                                        />
                                        <LeverTile
                                          icon={Target}
                                          label="Conversion"
                                          cur={r.conv}
                                          prev={r.prevConv}
                                          fmt={(v) => (v == null ? "n/a" : fmtPct(v))}
                                          delta={r.convDeltaPp}
                                          deltaSuffix="pp"
                                          note={r.estOrdersDelta != null ? `${r.estOrdersDelta >= 0 ? "≈ +" : "≈ "}${r.estOrdersDelta} orders from the conversion move.` : "Orders ÷ footfall (clean days)."}
                                        />
                                        <LeverTile
                                          icon={Coins}
                                          label="Avg basket (ABV)"
                                          cur={r.abv}
                                          prev={r.prevAbv}
                                          fmt={(v) => (v == null ? "n/a" : fmtKESLong(v))}
                                          delta={r.abvDeltaPct}
                                          note="Spend per order."
                                        />
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {/* "Locations needing attention" — surfaces stores that look
                  off on at least one of: sales drop, conversion drop,
                  return-rate spike, or weak share + below-avg sales. */}
              <LocationsAttentionPanel
                rows={enrichedWithDq}
                avgSales={avg}
                totalSalesAll={totalSalesAll}
                returnStats={returnStats}
                compareMode={compareMode}
              />

              {/* Monthly Sales Target Tracker — duplicate of the
                  Targets-page block so store managers and exec users
                  can see daily progress without leaving the locations
                  view. The tracker is self-fetching off /analytics/
                  monthly-targets so the date range is the current month. */}
              <MonthlyTargetsTracker month={`${new Date(dateTo).toISOString().slice(0, 7)}-01`} />
            </>

          {/* Store deep-dive slide-over — the audit's "single biggest missed
              opportunity". Renders ONLY when `selected` is set. */}
          <StoreDeepDive
            open={!!selected}
            onClose={() => setSelected(null)}
            row={selected ? sorted.find((l) => l.channel === selected) || null : null}
            compareLbl={compareLbl}
            weekdayData={weekdayData}
          />
        </>
      )}
    </div>
  );
};

export default Locations;
