import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useFilters } from "@/lib/filters";
import {
  api, fmtKES, fmtKESLong, fmtNum, fmtDec, fmtPct, fmtDate,
} from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import SortableTable, { exportCSV } from "@/components/SortableTable";
import StyleStatusToggle from "@/components/StyleStatusToggle";
import MultiSelect from "@/components/MultiSelect";
import CountryDot from "@/components/CountryDot";
import { Loading, ErrorBox, Empty } from "@/components/common";
import {
  Tag, Storefront, MagnifyingGlass, Sparkle, X as XIcon,
  Package, Cube, Stack, Percent, ChartBar, Warehouse,
} from "@phosphor-icons/react";

/**
 * Product Analysis — one canonical, interactive style-level cockpit.
 *
 * Every figure on this page is rolled from a SINGLE master dataset
 * (/analytics/product-analysis) so the summary band, the per-brand and
 * per-subcategory snapshots, and the master table always reconcile —
 * at any grain (style / colour / size) and any scope (overall OR a
 * single store, for BOTH sales and stock).
 *
 * Per style the table carries: name, style#, brand, category, sub-category,
 * units sold (period), revenue, current stock, weeks-of-cover, sell-out
 * rate, ASP, full price, current price and launch date. Expanding a row
 * drills into the style's size / colour split and where its stock is
 * sitting by location. An optional, non-blocking AI narrative summarises
 * what to act on.
 */

const GRAINS = [
  { key: "style", label: "Style", icon: Tag },
  { key: "color", label: "Colour", icon: Cube },
  { key: "size", label: "Size", icon: Stack },
];

const fmtWoc = (v) => (v === null || v === undefined ? "—" : `${fmtDec(v, 1)} wk`);
const fmtSor = (v) => (v === null || v === undefined ? "—" : `${fmtDec(v, 1)}%`);
const fmtAsp = (v) => (v === null || v === undefined || v === 0 ? "—" : fmtKES(v));
const fmtPrice = (v) => (v === null || v === undefined || v === 0 ? "—" : fmtKES(v));

// Colour the weeks-of-cover so overstock jumps out.
const wocCls = (v) => {
  if (v === null || v === undefined) return "text-muted";
  if (v >= 26) return "text-[#dc2626] font-semibold";
  if (v >= 13) return "text-[#d97706] font-semibold";
  return "text-foreground";
};

// ---------------------------------------------------------------------------
// Per-style drill — size / colour split + where the stock is sitting.
// Lazily fetched the first time a row is expanded.
// ---------------------------------------------------------------------------
const StyleDrill = ({ styleName, params }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/analytics/product-analysis/style", {
        params: { style: styleName, ...params },
      })
      .then((r) => { if (!cancelled) setData(r.data || null); })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.detail || e?.message || "Failed to load style detail");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleName, params.date_from, params.date_to, params.country, params.store]);

  if (loading) return <Loading label="Loading style detail…" />;
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Empty label="No detail for this style." />;

  const SizeColTable = ({ rows, dimKey, dimLabel }) => {
    if (!rows || !rows.length) return <Empty label={`No ${dimLabel.toLowerCase()} data.`} />;
    return (
      <SortableTable
        testId={`drill-${dimKey}`}
        rows={rows}
        initialSort={{ key: "units", dir: "desc" }}
        exportName={`${styleName}_by_${dimKey}.csv`.replace(/\s+/g, "-")}
        maxHeight={260}
        columns={[
          { key: dimKey, label: dimLabel, render: (r) => r[dimKey] || "(none)" },
          { key: "units", label: "Units", numeric: true, render: (r) => fmtNum(r.units) },
          { key: "revenue", label: "Revenue", numeric: true, render: (r) => fmtKES(r.revenue) },
          { key: "stock", label: "Stock", numeric: true, render: (r) => fmtNum(r.stock) },
        ]}
      />
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4" data-testid="style-drill">
      <div>
        <div className="eyebrow mb-1.5 flex items-center gap-1"><Stack size={12} /> By size</div>
        <SizeColTable rows={data.by_size} dimKey="size" dimLabel="Size" />
      </div>
      <div>
        <div className="eyebrow mb-1.5 flex items-center gap-1"><Cube size={12} /> By colour</div>
        <SizeColTable rows={data.by_color} dimKey="color" dimLabel="Colour" />
      </div>
      <div>
        <div className="eyebrow mb-1.5 flex items-center gap-1"><Warehouse size={12} /> Stock by location</div>
        <div className="text-[10px] text-muted mb-1.5">
          {params.store
            ? "All locations (network-wide) — for transfer planning, not limited to the selected store"
            : "All locations in the selected market(s)"}
        </div>
        {data.by_location && data.by_location.length ? (
          <SortableTable
            testId="drill-location"
            rows={data.by_location}
            initialSort={{ key: "stock", dir: "desc" }}
            exportName={`${styleName}_by_location.csv`.replace(/\s+/g, "-")}
            maxHeight={260}
            columns={[
              {
                key: "location", label: "Location",
                render: (r) => (
                  <span className="inline-flex items-center gap-1.5">
                    {r.location}
                    {r.is_warehouse && (
                      <span className="text-[9.5px] uppercase tracking-wide text-muted border border-border rounded px-1">WH</span>
                    )}
                  </span>
                ),
              },
              { key: "country", label: "Market", render: (r) => (r.country ? <CountryDot country={r.country} /> : "—") },
              { key: "stock", label: "Stock", numeric: true, render: (r) => fmtNum(r.stock) },
            ]}
          />
        ) : <Empty label="No stock on hand anywhere." />}
      </div>
    </div>
  );
};

const ProductAnalysis = () => {
  const { applied } = useFilters();
  const { dateFrom, dateTo, countries, dataVersion } = applied;

  // Layered scope (on top of the global date + country filter bar).
  const [store, setStore] = useState("");           // "" = Overall
  const [status, setStatus] = useState("active");   // active | retired | all
  const [grain, setGrain] = useState("style");      // style | color | size
  const [brands, setBrands] = useState([]);         // [] = all
  const [cats, setCats] = useState([]);             // [] = all (category)
  const [subcats, setSubcats] = useState([]);       // [] = all
  const [velDays, setVelDays] = useState(30);       // velocity window (days)
  const [search, setSearch] = useState("");
  const [hiddenCols, setHiddenCols] = useState(() => new Set()); // master col show/hide

  const [stores, setStores] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Accumulate brand / subcategory options across loads so narrowing the
  // filter never hides an option that exists in the catalog.
  const brandOptsRef = useRef(new Set());
  const catOptsRef = useRef(new Set());
  const subcatOptsRef = useRef(new Set());
  const [brandOpts, setBrandOpts] = useState([]);
  const [catOpts, setCatOpts] = useState([]);
  const [subcatOpts, setSubcatOpts] = useState([]);

  const [ai, setAi] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState(null);

  // Master store list (active POS) for the scope select.
  useEffect(() => {
    let cancelled = false;
    api
      .get("/analytics/active-pos", { params: { n_days: 365 } })
      .then((r) => {
        if (cancelled) return;
        const names = Array.from(
          new Set((r.data || []).map((s) => s.channel).filter(Boolean))
        ).sort((a, b) => a.localeCompare(b));
        setStores(names);
      })
      .catch(() => { if (!cancelled) setStores([]); });
    return () => { cancelled = true; };
  }, []);

  const countryParam = useMemo(
    () => (countries && countries.length ? countries.join(",") : undefined),
    [countries]
  );

  // Reset the AI narrative whenever the scope changes — it described the
  // previous range.
  useEffect(() => { setAi(null); setAiError(null); }, [
    dateFrom, dateTo, countryParam, store, status, grain, velDays,
    brands.join(","), cats.join(","), subcats.join(","),
  ]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/analytics/product-analysis", {
        params: {
          date_from: dateFrom,
          date_to: dateTo,
          country: countryParam,
          store: store || undefined,
          style_status: status,
          grain,
          velocity_days: velDays,
          brand: brands.length ? brands.join(",") : undefined,
          category: cats.length ? cats.join(",") : undefined,
          subcategory: subcats.length ? subcats.join(",") : undefined,
        },
      })
      .then((r) => {
        if (cancelled) return;
        const d = r.data || {};
        setData(d);
        // Grow the option sets from the per-brand / per-subcategory rollups.
        let bChanged = false;
        for (const b of (d.by_brand || [])) {
          if (b.brand && !brandOptsRef.current.has(b.brand)) { brandOptsRef.current.add(b.brand); bChanged = true; }
        }
        if (bChanged) setBrandOpts(Array.from(brandOptsRef.current).sort((a, b) => a.localeCompare(b)));
        let sChanged = false;
        for (const s of (d.by_subcategory || [])) {
          if (s.subcategory && !subcatOptsRef.current.has(s.subcategory)) { subcatOptsRef.current.add(s.subcategory); sChanged = true; }
        }
        if (sChanged) setSubcatOpts(Array.from(subcatOptsRef.current).sort((a, b) => a.localeCompare(b)));
        let cChanged = false;
        for (const row of (d.rows || [])) {
          if (row.category && !catOptsRef.current.has(row.category)) { catOptsRef.current.add(row.category); cChanged = true; }
        }
        if (cChanged) setCatOpts(Array.from(catOptsRef.current).sort((a, b) => a.localeCompare(b)));
      })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.detail || e?.message || "Failed to load product analysis");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [dateFrom, dateTo, countryParam, store, status, grain, velDays, brands, cats, subcats, dataVersion]);

  const rows = data?.rows || [];
  const summary = data?.summary || null;
  const byBrand = data?.by_brand || [];
  const bySubcat = data?.by_subcategory || [];

  const showDim = grain !== "style";
  const drillParams = useMemo(
    () => ({
      date_from: dateFrom,
      date_to: dateTo,
      country: countryParam,
      store: store || undefined,
    }),
    [dateFrom, dateTo, countryParam, store]
  );

  // Client-side search filter over the master rows.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      (r.style_name || "").toLowerCase().includes(q) ||
      (r.style_number || "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  const rangeLabel = dateFrom && dateTo ? `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}` : "";
  const scopeLabel = store
    ? store
    : (countries && countries.length ? countries.join(", ") : "All markets");

  // Master table columns. The leading dimension column only appears when the
  // grain is colour / size.
  const columns = useMemo(() => {
    const cols = [
      {
        key: "style_name", label: "Style", mobilePrimary: true,
        render: (r) => (
          <div className="min-w-[180px]">
            <div className="font-medium text-foreground break-words">{r.style_name}</div>
            <div className="text-[10.5px] text-muted">
              {r.style_number || "—"}
              {r.launch_date ? <span className="ml-1.5">· launched {fmtDate(r.launch_date)}</span> : null}
            </div>
          </div>
        ),
        csv: (r) => r.style_name,
      },
    ];
    if (showDim) {
      cols.push({
        key: "dim", label: grain === "color" ? "Colour" : "Size",
        render: (r) => r.dim || "(none)",
      });
    }
    cols.push(
      { key: "brand", label: "Brand", render: (r) => r.brand || "—" },
      { key: "category", label: "Category", render: (r) => r.category || "—" },
      { key: "subcategory", label: "Sub-category", render: (r) => r.subcategory || "—", csvLabel: "Sub-category" },
      { key: "units_sold", label: "Units Sold", numeric: true, render: (r) => fmtNum(r.units_sold) },
      { key: "revenue", label: "Revenue", numeric: true, render: (r) => fmtKES(r.revenue), csv: (r) => r.revenue },
      { key: "current_stock", label: "Stock", numeric: true, render: (r) => fmtNum(r.current_stock) },
      {
        key: "woc", label: "WOC", numeric: true,
        headerTitle: "Weeks of cover = current stock ÷ weekly velocity",
        render: (r) => <span className={wocCls(r.woc)}>{fmtWoc(r.woc)}</span>,
        sortValue: (r) => (r.woc === null || r.woc === undefined ? -1 : r.woc),
        csv: (r) => (r.woc == null ? "" : r.woc),
      },
      {
        key: "sor", label: "SOR", numeric: true,
        headerTitle: "Sell-out rate = units sold ÷ (units sold + current stock)",
        render: (r) => fmtSor(r.sor), pct: true,
        sortValue: (r) => (r.sor === null || r.sor === undefined ? -1 : r.sor),
      },
      { key: "asp", label: "ASP", numeric: true, headerTitle: "Average selling price", render: (r) => fmtAsp(r.asp), csv: (r) => r.asp ?? "" },
      { key: "full_price", label: "Full Price", numeric: true, render: (r) => fmtPrice(r.full_price), csv: (r) => r.full_price ?? "" },
      { key: "current_price", label: "Current Price", numeric: true, render: (r) => fmtPrice(r.current_price), csv: (r) => r.current_price ?? "" },
    );
    return cols;
  }, [showDim, grain]);

  // Column show/hide for the master table. The first two identity columns
  // (Style, and the colour/size dim when not at style grain) are always shown.
  const lockedCols = useMemo(
    () => new Set(["style_name", ...(showDim ? ["dim"] : [])]),
    [showDim]
  );
  const visibleColumns = useMemo(
    () => columns.filter((c) => lockedCols.has(c.key) || !hiddenCols.has(c.key)),
    [columns, hiddenCols, lockedCols]
  );
  const toggleCol = useCallback((key) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // Master CSV export — uses the full filtered set + the full-precision KES.
  const exportMaster = useCallback(() => {
    const exportCols = [
      { key: "style_name", label: "Style", csv: (r) => r.style_name },
      ...(showDim ? [{ key: "dim", label: grain === "color" ? "Colour" : "Size", csv: (r) => r.dim || "" }] : []),
      { key: "style_number", label: "Style Number", csv: (r) => r.style_number || "" },
      { key: "brand", label: "Brand", csv: (r) => r.brand || "" },
      { key: "category", label: "Category", csv: (r) => r.category || "" },
      { key: "subcategory", label: "Sub-category", csv: (r) => r.subcategory || "" },
      { key: "units_sold", label: "Units Sold", csv: (r) => r.units_sold },
      { key: "revenue", label: "Revenue (KES)", csv: (r) => r.revenue },
      { key: "net_revenue", label: "Net Revenue (KES)", csv: (r) => r.net_revenue },
      { key: "current_stock", label: "Current Stock", csv: (r) => r.current_stock },
      { key: "woc", label: "Weeks of Cover", csv: (r) => (r.woc == null ? "" : r.woc) },
      { key: "sor", label: "Sell-Out Rate %", csv: (r) => (r.sor == null ? "" : r.sor), pct: true },
      { key: "asp", label: "ASP (KES)", csv: (r) => r.asp ?? "" },
      { key: "full_price", label: "Full Price (KES)", csv: (r) => r.full_price ?? "" },
      { key: "current_price", label: "Current Price (KES)", csv: (r) => r.current_price ?? "" },
      { key: "launch_date", label: "Launch Date", csv: (r) => r.launch_date || "" },
    ];
    exportCSV(filteredRows, exportCols, `product_analysis_${grain}_${(store || "overall").replace(/\s+/g, "-")}.csv`);
  }, [filteredRows, showDim, grain, store]);

  const generateAi = useCallback(() => {
    if (!summary) return;
    setAiLoading(true);
    setAiError(null);
    // Build the grounded fact lists from the same rows (style grain). When the
    // master is at colour/size grain, roll dim rows up to STYLE grain and
    // RECOMPUTE woc/sor from the aggregated totals (carrying a single dim
    // row's woc/sor would mis-rank overstock / slow-movers).
    let styleRows;
    if (grain === "style") {
      styleRows = rows;
    } else {
      const agg = rows.reduce((acc, r) => {
        const k = r.style_name;
        const g = acc[k] || (acc[k] = {
          style_name: r.style_name, units_sold: 0, revenue: 0,
          current_stock: 0, units_vel: 0,
        });
        g.units_sold += r.units_sold || 0;
        g.revenue += r.revenue || 0;
        g.current_stock += r.current_stock || 0;
        g.units_vel += r.units_vel || 0;
        return acc;
      }, {});
      // WOC mirrors the server: weekly velocity = units_vel / (velDays/7),
      // then WOC = current_stock / weekly_velocity. Using raw units_vel here
      // would distort the overstock ranking fed to the AI.
      const wk = velDays / 7;
      styleRows = Object.values(agg).map((g) => {
        const weekly = wk > 0 ? g.units_vel / wk : 0;
        return {
          ...g,
          woc: weekly > 0 ? g.current_stock / weekly : null,
          sor: (g.units_sold + g.current_stock) > 0
            ? (g.units_sold * 100.0) / (g.units_sold + g.current_stock)
            : null,
        };
      });
    }
    const overstock = [...styleRows]
      .filter((r) => r.woc != null && r.current_stock > 0)
      .sort((a, b) => b.woc - a.woc).slice(0, 8)
      .map((r) => ({ style_name: r.style_name, woc: r.woc, current_stock: r.current_stock }));
    const topSellers = [...styleRows]
      .sort((a, b) => b.revenue - a.revenue).slice(0, 8)
      .map((r) => ({ style_name: r.style_name, units_sold: r.units_sold, revenue: r.revenue }));
    const slow = [...styleRows]
      .filter((r) => r.sor != null && r.current_stock > 0)
      .sort((a, b) => a.sor - b.sor).slice(0, 8)
      .map((r) => ({ style_name: r.style_name, sor: r.sor, current_stock: r.current_stock }));
    api
      .post("/analytics/product-analysis/ai", {
        scope_label: scopeLabel,
        date_label: rangeLabel,
        summary,
        overstock,
        top_sellers: topSellers,
        slow_movers: slow,
      })
      .then((r) => {
        const d = r.data || {};
        if (d.available && d.narrative) setAi(d);
        else setAiError(
          d.reason === "ai_not_configured"
            ? "AI insights are not configured on the server."
            : "Couldn't generate an insight right now."
        );
      })
      .catch((e) => setAiError(e?.response?.data?.detail || e?.message || "AI request failed"))
      .finally(() => setAiLoading(false));
  }, [summary, rows, grain, scopeLabel, rangeLabel]);

  return (
    <div className="space-y-5" data-testid="product-analysis-page">
      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2 text-[18px] font-bold text-foreground">
          <Tag size={20} weight="duotone" className="text-[#1a5c38]" />
          Product Analysis
        </h1>
        <p className="text-[12.5px] text-muted mt-1 max-w-3xl">
          One canonical style-level view of sales and stock that reconciles end to end.
          Scope it to all markets or a single store (sales and stock move together),
          switch the grain between style, colour and size, and drill any style into its
          size / colour split and where its stock is sitting. Date range and market come
          from the filter bar above.
        </p>
        <div className="text-[11.5px] text-muted mt-1">
          {rangeLabel ? <span className="num">{rangeLabel}</span> : null}
          {rangeLabel ? <span className="mx-1.5">·</span> : null}
          <span>{scopeLabel}</span>
        </div>
      </div>

      {/* Scope controls */}
      <div className="card-white p-3.5 flex flex-wrap items-center gap-2.5">
        <div className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5">
          <Storefront size={13} className="text-muted shrink-0" />
          <select
            className="bg-transparent text-[12px] font-medium outline-none max-w-[180px]"
            value={store}
            onChange={(e) => setStore(e.target.value)}
            data-testid="pa-store-select"
            aria-label="Store scope"
          >
            <option value="">Overall (all stores)</option>
            {stores.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="inline-flex rounded-full border border-border overflow-hidden" data-testid="pa-grain">
          {GRAINS.map((g) => {
            const active = grain === g.key;
            const Icon = g.icon;
            return (
              <button
                key={g.key}
                type="button"
                onClick={() => setGrain(g.key)}
                data-testid={`pa-grain-${g.key}`}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                  active ? "bg-[#1a5c38] text-white" : "bg-white text-[#374151] hover:bg-[#f3f4f6]"
                }`}
                title={`Group rows by ${g.label.toLowerCase()}`}
              >
                <Icon size={12} /> {g.label}
              </button>
            );
          })}
        </div>

        <StyleStatusToggle value={status} onChange={setStatus} testIdPrefix="pa-status" />

        <MultiSelect
          label="Brand"
          icon={Tag}
          options={brandOpts.map((b) => ({ value: b, label: b }))}
          value={brands}
          onChange={setBrands}
          placeholder="All brands"
          width={190}
          testId="pa-brand"
        />

        <MultiSelect
          label="Category"
          icon={Package}
          options={catOpts.map((c) => ({ value: c, label: c }))}
          value={cats}
          onChange={setCats}
          placeholder="All categories"
          width={190}
          testId="pa-category"
        />

        <MultiSelect
          label="Sub-cat"
          icon={Package}
          options={subcatOpts.map((s) => ({ value: s, label: s }))}
          value={subcats}
          onChange={setSubcats}
          placeholder="All sub-categories"
          width={210}
          testId="pa-subcat"
        />

        <label className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px] text-muted">
          Velocity
          <select
            value={velDays}
            onChange={(e) => setVelDays(Number(e.target.value))}
            className="bg-transparent text-[12px] text-foreground outline-none"
            data-testid="pa-velocity"
            title="Velocity window used for weeks-of-cover"
          >
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
          </select>
        </label>

        <div className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 ml-auto">
          <MagnifyingGlass size={13} className="text-muted shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search style or style #"
            className="bg-transparent text-[12px] outline-none w-[170px]"
            data-testid="pa-search"
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} className="text-muted hover:text-foreground" aria-label="Clear search">
              <XIcon size={12} />
            </button>
          )}
        </div>
      </div>

      {loading && <Loading label="Building the product range…" />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && data && (
        <>
          {/* Summary band */}
          {summary && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <KPICard
                small showDelta={false} testId="pa-kpi-styles"
                label="Styles" value={fmtNum(summary.styles)} icon={Tag}
                sub={`${fmtNum(summary.active_styles)} actively selling`}
              />
              <KPICard
                small showDelta={false} accent testId="pa-kpi-revenue"
                label="Revenue" value={fmtKES(summary.revenue)} valueFull={fmtKESLong(summary.revenue)} icon={ChartBar}
                sub={`Net ${fmtKES(summary.net_revenue)}`}
              />
              <KPICard
                small showDelta={false} testId="pa-kpi-units"
                label="Units Sold" value={fmtNum(summary.units)} icon={Cube}
              />
              <KPICard
                small showDelta={false} testId="pa-kpi-stock"
                label="Current Stock" value={fmtNum(summary.stock_units)} icon={Package}
                sub="units on hand (scope)"
              />
              <KPICard
                small showDelta={false} testId="pa-kpi-sor"
                label="Avg Sell-Out" value={fmtSor(summary.avg_sor)} icon={Percent}
                formula="Sell-out rate = units sold ÷ (units sold + current stock)"
              />
              <KPICard
                small showDelta={false} testId="pa-kpi-woc"
                label="Avg Weeks Cover" value={fmtWoc(summary.avg_woc)} icon={ChartBar}
                formula="Weeks of cover = current stock ÷ weekly velocity"
              />
            </div>
          )}

          {/* By-brand + by-subcategory snapshots */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card-white p-4">
              <div className="eyebrow mb-2">By brand</div>
              {byBrand.length ? (
                <SortableTable
                  testId="pa-by-brand"
                  rows={byBrand}
                  initialSort={{ key: "revenue", dir: "desc" }}
                  exportName="product_analysis_by_brand.csv"
                  maxHeight={300}
                  columns={[
                    { key: "brand", label: "Brand", render: (r) => r.brand },
                    { key: "styles", label: "Styles", numeric: true, render: (r) => fmtNum(r.styles) },
                    { key: "units", label: "Units", numeric: true, render: (r) => fmtNum(r.units) },
                    { key: "revenue", label: "Revenue", numeric: true, render: (r) => fmtKES(r.revenue) },
                    { key: "stock", label: "Stock", numeric: true, render: (r) => fmtNum(r.stock) },
                    { key: "sor", label: "SOR", numeric: true, render: (r) => fmtSor(r.sor), pct: true },
                    { key: "woc", label: "WOC", numeric: true, render: (r) => <span className={wocCls(r.woc)}>{fmtWoc(r.woc)}</span>, sortValue: (r) => (r.woc ?? -1) },
                  ]}
                />
              ) : <Empty />}
            </div>
            <div className="card-white p-4">
              <div className="eyebrow mb-2">By sub-category</div>
              {bySubcat.length ? (
                <SortableTable
                  testId="pa-by-subcat"
                  rows={bySubcat}
                  initialSort={{ key: "revenue", dir: "desc" }}
                  exportName="product_analysis_by_subcategory.csv"
                  maxHeight={300}
                  columns={[
                    { key: "subcategory", label: "Sub-category", render: (r) => r.subcategory, csvLabel: "Sub-category" },
                    { key: "styles", label: "Styles", numeric: true, render: (r) => fmtNum(r.styles) },
                    { key: "pct_range", label: "% Range", numeric: true, render: (r) => fmtPct(r.pct_range), pct: true },
                    { key: "stock", label: "Stock", numeric: true, render: (r) => fmtNum(r.stock) },
                    { key: "pct_stock", label: "% Stock", numeric: true, render: (r) => fmtPct(r.pct_stock), pct: true },
                    { key: "units", label: "Units", numeric: true, render: (r) => fmtNum(r.units) },
                    { key: "pct_units", label: "% Units", numeric: true, render: (r) => fmtPct(r.pct_units), pct: true },
                    { key: "revenue", label: "Revenue", numeric: true, render: (r) => fmtKES(r.revenue) },
                    { key: "pct_revenue", label: "% Rev", numeric: true, render: (r) => fmtPct(r.pct_revenue), pct: true },
                    { key: "woc", label: "WOC", numeric: true, render: (r) => <span className={wocCls(r.woc)}>{fmtWoc(r.woc)}</span>, sortValue: (r) => (r.woc ?? -1) },
                  ]}
                />
              ) : <Empty />}
            </div>
          </div>

          {/* AI narrative (non-blocking) */}
          <div className="card-white p-4">
            {!ai && (
              <button
                type="button"
                onClick={generateAi}
                disabled={aiLoading || !summary}
                className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[#1a5c38] hover:underline disabled:opacity-40 disabled:no-underline"
                data-testid="pa-ai-btn"
              >
                <Sparkle size={15} weight="fill" />
                {aiLoading ? "Analysing the range…" : "Generate AI: what to act on"}
              </button>
            )}
            {aiError && <div className="text-[11.5px] text-muted mt-1">{aiError}</div>}
            {ai && (
              <div data-testid="pa-ai-text">
                <div className="flex items-center gap-1.5 mb-1">
                  <Sparkle size={14} weight="fill" className="text-[#1a5c38]" />
                  <span className="eyebrow">AI insight</span>
                  <button
                    type="button"
                    onClick={() => setAi(null)}
                    className="ml-auto text-muted hover:text-foreground"
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

          {/* Master table */}
          <div className="card-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <div className="eyebrow">
                Styles ({fmtNum(filteredRows.length)}{filteredRows.length !== rows.length ? ` of ${fmtNum(rows.length)}` : ""})
                {showDim ? ` · by ${grain === "color" ? "colour" : "size"}` : ""}
              </div>
              <div className="flex items-center gap-2">
                <details className="relative" data-testid="pa-columns">
                  <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-brand px-2 py-1 rounded border border-border hover:border-brand select-none">
                    Columns{hiddenCols.size ? ` (${columns.length - hiddenCols.size}/${columns.length})` : ""}
                  </summary>
                  <div className="absolute right-0 z-20 mt-1 w-56 max-h-72 overflow-auto rounded-md border border-border bg-white shadow-lg p-1.5">
                    {columns.map((c) => {
                      const locked = lockedCols.has(c.key);
                      const shown = locked || !hiddenCols.has(c.key);
                      const label = typeof c.label === "string" ? c.label : c.key;
                      return (
                        <label
                          key={c.key}
                          className={`flex items-center gap-2 px-2 py-1 text-[12px] rounded ${locked ? "opacity-50" : "hover:bg-muted/10 cursor-pointer"}`}
                        >
                          <input
                            type="checkbox"
                            checked={shown}
                            disabled={locked}
                            onChange={() => toggleCol(c.key)}
                            data-testid={`pa-col-${c.key}`}
                          />
                          {label}
                        </label>
                      );
                    })}
                  </div>
                </details>
                <button
                  type="button"
                  onClick={exportMaster}
                  disabled={!filteredRows.length}
                  className="inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-brand px-2 py-1 rounded border border-border hover:border-brand disabled:opacity-40"
                  data-testid="pa-master-export"
                >
                  Export CSV
                </button>
              </div>
            </div>
            {filteredRows.length ? (
              <SortableTable
                testId="pa-master"
                rows={filteredRows}
                columns={visibleColumns}
                initialSort={{ key: "revenue", dir: "desc" }}
                pageSize={100}
                mobileCards
                rowKey={(r) => (showDim ? `${r.style_name}|${r.dim}` : r.style_name)}
                renderExpanded={grain === "style" ? (r) => <StyleDrill styleName={r.style_name} params={drillParams} /> : null}
                emptyLabel="No styles match the filters."
              />
            ) : (
              <Empty label="No styles match the filters." />
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default ProductAnalysis;
