import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useFilters } from "@/lib/filters";
import {
  api, fmtKES, fmtKESLong, fmtNum, fmtDec, fmtPct, fmtDate,
} from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import SortableTable, { exportTable } from "@/components/SortableTable";
import StyleStatusToggle from "@/components/StyleStatusToggle";
import ProductImage from "@/components/ProductImage";
import { odooImageUrl } from "@/lib/useProductImages";
import MultiSelect from "@/components/MultiSelect";
import { Loading, ErrorBox, Empty } from "@/components/common";
import {
  Tag, Storefront, MagnifyingGlass, Sparkle, X as XIcon,
  Package, Cube, Percent, ChartBar, Warehouse,
} from "@phosphor-icons/react";

/**
 * Product Analysis — one canonical, interactive style-level cockpit.
 *
 * Every figure on this page is rolled from a SINGLE master dataset
 * (/analytics/product-analysis) so the summary band, the per-brand and
 * per-subcategory snapshots, and the master table always reconcile —
 * at any explosion (style, optionally split by colour / print / size) and any
 * scope (overall OR a single store, for BOTH sales and stock).
 *
 * Per style the table carries: name, style#, brand, category, sub-category,
 * units sold (period), revenue, current stock, weeks-of-cover, sell-out
 * rate, ASP, full price, current price and launch date. Expanding a row
 * drills into the style's size / colour split and where its stock is
 * sitting by location. An optional, non-blocking AI narrative summarises
 * what to act on.
 */

// Colour / Print / Size are row-explosion dimensions, driven by the column
// picker: showing one in the table groups it to one value per row (selecting
// several multiplies the rows). The backend receives these as the `dims` param.
const DIM_KEYS = ["color", "print", "size", "pos_location"];

const fmtWoc = (v) => (v === null || v === undefined ? "—" : `${fmtDec(v, 1)} wk`);
const fmtSor = (v) => (v === null || v === undefined ? "—" : `${fmtDec(v, 1)}%`);
// ASP / price columns show the full grouped shilling figure ("3,500") — no KES
// prefix and no K/M abbreviation — per the user's request.
const fmtAsp = (v) => (v === null || v === undefined || v === 0 ? "—" : fmtNum(v));
const fmtPrice = (v) => (v === null || v === undefined || v === 0 ? "—" : fmtNum(v));

// Local-time ISO date (YYYY-MM-DD) — avoids the UTC off-by-one around midnight
// in East Africa (UTC+3) when computing date presets.
const isoLocal = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// Inclusive day window ending today (matches applyPreset's 30/90/120 logic).
const presetRange = (days) => {
  const today = new Date();
  const from = new Date();
  from.setDate(today.getDate() - (days - 1));
  return { from: isoLocal(from), to: isoLocal(today) };
};

// Whole days between a YYYY-MM-DD sale date and today (local time).
const daysSinceSale = (d) => {
  if (!d) return null;
  const dt = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today.getTime() - dt.getTime()) / 86400000));
};

// Descriptive lifecycle-tier labels (shared wording with Range Management's
// Active-range cards) so the filter, table and detail popup read consistently.
const TIER_DESC = {
  "Tier 1": "NOOS / never out of stock",
  "Tier 2": "Core performers",
  "Tier 3": "Developing / watch",
  "Tier 4": "Trial / new entry",
  "Retired": "Manually retired / Zoya",
};

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

  return (
    <div className="grid grid-cols-1 gap-4" data-testid="style-drill">
      <div>
        <div className="eyebrow mb-1.5 flex items-center gap-1"><Warehouse size={12} /> Stock and Sales by location</div>
        <div className="text-[10px] text-muted mb-1.5">
          {params.store
            ? "All locations (network-wide) — for transfer planning, not limited to the selected store"
            : "All locations in the selected market(s)"}
        </div>
        {data.by_location && data.by_location.length ? (
          <SortableTable
            testId="drill-location"
            rows={data.by_location}
            initialSort={{ key: "units", dir: "desc" }}
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
              { key: "units", label: "Sales (Units)", numeric: true, render: (r) => fmtNum(r.units) },
              { key: "stock", label: "Stock (Units)", numeric: true, render: (r) => fmtNum(r.stock) },
            ]}
          />
        ) : <Empty label="No stock or sales anywhere." />}
      </div>
    </div>
  );
};

const ProductAnalysis = () => {
  const { applied } = useFilters();
  const { countries, dataVersion } = applied;

  // Layered scope (on top of the global date + country filter bar).
  const [stores, setStores] = useState([]);         // [] = all stores (multi)
  const [tiers, setTiers] = useState([]);           // [] = all range tiers
  const [revPct, setRevPct] = useState("");         // "" = off; Pareto top-revenue % cutoff
  const [status, setStatus] = useState("active");   // active | retired | all
  const [brands, setBrands] = useState([]);         // [] = all
  const [cats, setCats] = useState([]);             // [] = all (category)
  const [subcats, setSubcats] = useState([]);       // [] = all
  const [velDays, setVelDays] = useState(30);       // velocity window (days)
  // Whether warehouse / holding-location stock is counted in the figures.
  // false (default) = retail stores only; true = stores + warehouse.
  const [includeWarehouse, setIncludeWarehouse] = useState(false);
  const [search, setSearch] = useState("");
  // Embed product photos in the export (slow .xlsx). Unchecked = fast plain CSV.
  const [includePhotos, setIncludePhotos] = useState(true);
  const [drillStyle, setDrillStyle] = useState(null); // style_name shown in the location popup
  // Master column show/hide. The newly-added analytical columns start hidden so
  // the default table stays readable; the picker (above the table) reveals them.
  const [hiddenCols, setHiddenCols] = useState(
    () => new Set([
      "color", "primary_color", "print", "size", "pos_location", "tier", "units_life", "sor_since_launch", "launch_date",
      "days_since_last_sale", "soh_stores", "soh_warehouse",
    ])
  );

  // Explosion dimensions = the colour / print / size columns currently shown.
  // Showing a dimension explodes the table to one value per row for it; the
  // backend groups by every selected dim (combinations multiply).
  const dims = useMemo(() => DIM_KEYS.filter((k) => !hiddenCols.has(k)), [hiddenCols]);
  const dimsParam = useMemo(() => dims.join(","), [dims]);

  // Local date scope — defaults to the last 30 days for this page, with quick
  // presets (30/90/120 days) + a custom range that re-scope ONLY this page.
  // A later change to the global filter bar still re-seeds it (see effect below).
  const [localFrom, setLocalFrom] = useState(() => presetRange(30).from);
  const [localTo, setLocalTo] = useState(() => presetRange(30).to);
  const [datePreset, setDatePreset] = useState(30); // 30 | 90 | 120 | "custom" | null

  const [posOptions, setPosOptions] = useState([]);  // [{value,label,group:country}]
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

  // Master store list (active POS) for the scope select — grouped by country.
  useEffect(() => {
    let cancelled = false;
    api
      .get("/analytics/active-pos", { params: { n_days: 365 } })
      .then((r) => {
        if (cancelled) return;
        const seen = new Map(); // channel -> country
        for (const s of (r.data || [])) {
          if (s.channel && !seen.has(s.channel)) seen.set(s.channel, s.country || "Other");
        }
        const opts = Array.from(seen.entries())
          .map(([channel, country]) => ({ value: channel, label: channel, group: country }))
          .sort((a, b) => a.group.localeCompare(b.group) || a.value.localeCompare(b.value));
        setPosOptions(opts);
      })
      .catch(() => { if (!cancelled) setPosOptions([]); });
    return () => { cancelled = true; };
  }, []);

  const countryParam = useMemo(
    () => (countries && countries.length ? countries.join(",") : undefined),
    [countries]
  );
  const storeParam = useMemo(
    () => (stores.length ? stores.join(",") : undefined),
    [stores]
  );
  const tierParam = useMemo(
    () => (tiers.length ? tiers.join(",") : undefined),
    [tiers]
  );

  const revPctParam = useMemo(() => {
    const n = Number(revPct);
    return Number.isFinite(n) && n > 0 ? Math.min(100, n) : undefined;
  }, [revPct]);

  // The Sales Period is fully independent of the global filter bar and always
  // opens on its 30-day default (the global date no longer re-seeds it).

  const applyPreset = useCallback((days) => {
    const today = new Date();
    const from = new Date();
    from.setDate(today.getDate() - (days - 1));
    setLocalFrom(isoLocal(from));
    setLocalTo(isoLocal(today));
    setDatePreset(days);
  }, []);

  // Reset the AI narrative whenever the scope changes — it described the
  // previous range.
  useEffect(() => { setAi(null); setAiError(null); }, [
    localFrom, localTo, countryParam, storeParam, status, dimsParam, velDays,
    brands.join(","), cats.join(","), subcats.join(","), tierParam, revPctParam,
  ]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/analytics/product-analysis", {
        params: {
          date_from: localFrom,
          date_to: localTo,
          country: countryParam,
          store: storeParam,
          style_status: status,
          dims: dimsParam || undefined,
          velocity_days: velDays,
          include_warehouse: includeWarehouse || undefined,
          brand: brands.length ? brands.join(",") : undefined,
          category: cats.length ? cats.join(",") : undefined,
          subcategory: subcats.length ? subcats.join(",") : undefined,
          tier: tierParam,
          rev_pct: revPctParam,
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
  }, [localFrom, localTo, countryParam, storeParam, status, dimsParam, velDays, includeWarehouse, brands, cats, subcats, tierParam, revPctParam, dataVersion]);

  const rows = data?.rows || [];
  const summary = data?.summary || null;
  const byBrand = data?.by_brand || [];
  const bySubcat = data?.by_subcategory || [];

  const drillParams = useMemo(
    () => ({
      date_from: localFrom,
      date_to: localTo,
      country: countryParam,
      store: storeParam,
    }),
    [localFrom, localTo, countryParam, storeParam]
  );

  // Close the per-style location popup on Escape.
  useEffect(() => {
    if (!drillStyle) return;
    const h = (e) => { if (e.key === "Escape") setDrillStyle(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [drillStyle]);

  // Client-side search filter over the master rows.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      (r.style_name || "").toLowerCase().includes(q) ||
      (r.style_number || "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  const rangeLabel = localFrom && localTo ? `${fmtDate(localFrom)} – ${fmtDate(localTo)}` : "";
  const scopeLabel = stores.length
    ? (stores.length === 1 ? stores[0] : `${stores.length} stores`)
    : (countries && countries.length ? countries.join(", ") : "All markets");

  // Master table columns. Style # shows by default immediately after the Style
  // name. Colour / Print / Size are explosion dimensions: showing one groups the
  // table to one value per row for it.
  const columns = useMemo(() => {
    const cols = [
      {
        key: "image", label: "", sortable: false,
        headerTitle: "Product photo of the style",
        render: (r) => (
          <ProductImage sku={r.sku} label={r.style_name} size={40} />
        ),
        csv: () => "",
      },
      {
        key: "style_name", label: "Style", mobilePrimary: true,
        render: (r) => (
          <div className="min-w-[180px]">
            {dims.length === 0 ? (
              <button
                type="button"
                onClick={() => setDrillStyle(r)}
                className="font-medium text-foreground break-words text-left hover:text-brand hover:underline underline-offset-2"
                title="View stock & sales by location"
                data-testid={`pa-style-open-${r.style_name}`}
              >
                {r.style_name}
              </button>
            ) : (
              <div className="font-medium text-foreground break-words">{r.style_name}</div>
            )}
            {r.launch_date ? (
              <div className="text-[10.5px] text-muted">launched {fmtDate(r.launch_date)}</div>
            ) : null}
          </div>
        ),
        csv: (r) => r.style_name,
      },
      { key: "style_number", label: "Style #", render: (r) => r.style_number || "—", csv: (r) => r.style_number || "" },
    ];
    cols.push(
      { key: "brand", label: "Brand", render: (r) => r.brand || "—" },
      { key: "category", label: "Category", render: (r) => r.category || "—" },
      { key: "subcategory", label: "Sub-category", render: (r) => r.subcategory || "—", csvLabel: "Sub-category" },
      { key: "color", label: "Colour", render: (r) => r.color || "—", csv: (r) => r.color || "" },
      {
        key: "primary_color", label: "Primary Color",
        headerTitle: "Base colour family each style's colour maps onto (AI-assisted)",
        render: (r) => r.primary_color || "—", csv: (r) => r.primary_color || "",
      },
      { key: "print", label: "Print", render: (r) => r.print || "—", csv: (r) => r.print || "" },
      { key: "size", label: "Size", render: (r) => r.size || "—", csv: (r) => r.size || "" },
      {
        key: "tier", label: "Tier",
        headerTitle: "Lifecycle tier (shared with Range Management) — Tier 1 NOOS / never out of stock, Tier 2 Core performers, Tier 3 Developing / watch, Tier 4 Trial / new entry, Retired",
        render: (r) => r.tier || "—",
      },
      { key: "units_sold", label: "Units Sold", numeric: true, headerTitle: "NET units (returns subtracted) over this page's selected period (30-day default, independent of the global filter). Overview/Products/Velocity show GROSS units over their own windows, so the same style reads differently there.", render: (r) => fmtNum(r.units_sold) },
      { key: "revenue", label: "Revenue", numeric: true, render: (r) => fmtKES(r.revenue), csv: (r) => r.revenue },
      { key: "current_stock", label: "Stock", numeric: true, render: (r) => fmtNum(r.current_stock) },
      {
        key: "soh_stores", label: "SOH in Stores", numeric: true,
        headerTitle: "Stock on hand held across retail stores",
        render: (r) => fmtNum(r.store_stock), csv: (r) => r.store_stock ?? "",
      },
      {
        key: "soh_warehouse", label: "SOH in Warehouse", numeric: true,
        headerTitle: "Stock on hand held in the warehouse",
        render: (r) => fmtNum(r.warehouse_stock), csv: (r) => r.warehouse_stock ?? "",
      },
      {
        key: "pos_location", label: "POS Location",
        headerTitle: "Retail stores currently holding stock of this style",
        render: (r) => (
          <span className="block max-w-[260px] break-words">{r.pos_location || "—"}</span>
        ),
        csv: (r) => r.pos_location || "",
      },
      {
        key: "style_status", label: "Style Status",
        headerTitle: "Lifecycle status: Retired = manually retired or Zoya brand; Active = any Tier 1..4 style (independent of window sales)",
        render: (r) => {
          const s = r.style_status || "—";
          if (s === "—") return "—";
          const active = s === "Active";
          return (
            <span
              className={
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium " +
                (active
                  ? "bg-emerald-500/15 text-emerald-600"
                  : "bg-muted text-muted-foreground")
              }
            >
              {s}
            </span>
          );
        },
        csv: (r) => r.style_status || "",
      },
      {
        key: "days_since_last_sale", label: "Days Since Last Sale", numeric: true,
        headerTitle: "Whole days since this style last sold a unit",
        render: (r) => { const d = daysSinceSale(r.last_sale); return d == null ? "—" : fmtNum(d); },
        sortValue: (r) => { const d = daysSinceSale(r.last_sale); return d == null ? -1 : d; },
        csv: (r) => { const d = daysSinceSale(r.last_sale); return d == null ? "" : d; },
      },
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
      {
        key: "units_life", label: "Units Sold Since Launch", numeric: true,
        headerTitle: "Net units sold over the style's entire life (ignores the date range)",
        render: (r) => fmtNum(r.units_life), csv: (r) => r.units_life ?? "",
      },
      {
        key: "sor_since_launch", label: "SOR Since Launch", numeric: true,
        headerTitle: "Lifetime sell-out = lifetime units ÷ (lifetime units + current stock)",
        render: (r) => fmtSor(r.sor_since_launch), pct: true,
        sortValue: (r) => (r.sor_since_launch === null || r.sor_since_launch === undefined ? -1 : r.sor_since_launch),
      },
      { key: "asp", label: "ASP", numeric: true, headerTitle: "Average selling price", render: (r) => fmtAsp(r.asp), csv: (r) => r.asp ?? "" },
      { key: "full_price", label: "Full Price", numeric: true, render: (r) => fmtPrice(r.full_price), csv: (r) => r.full_price ?? "" },
      { key: "current_price", label: "Current Price", numeric: true, render: (r) => fmtPrice(r.current_price), csv: (r) => r.current_price ?? "" },
      { key: "launch_date", label: "Launch Date", render: (r) => (r.launch_date ? fmtDate(r.launch_date) : "—"), csv: (r) => r.launch_date || "" },
      {
        key: "life_cycle", label: "Life Cycle",
        headerTitle: "Gated lifecycle stage (2026 Range Strategy): New/Test → Recent Performer (passed the Week-8 read) → Core Performer (9–24mo, 3+ reorders) → Core (24mo+, 5+ reorders). Styles that fail their SOR / full-price / reorder gate show Retire.",
        render: (r) => r.life_cycle || "—", csv: (r) => r.life_cycle || "",
      },
      {
        key: "reorder_count", label: "No. of Reorders", numeric: true,
        headerTitle: "Estimated reorder cycles — one per ~12 weeks of style age",
        render: (r) => fmtNum(r.reorder_count), csv: (r) => r.reorder_count ?? "",
      },
      {
        key: "age_years", label: "Age (Years)", numeric: true,
        headerTitle: "Style age in years since launch",
        render: (r) => (r.age_years == null ? "—" : r.age_years),
        sortValue: (r) => (r.age_years == null ? -1 : r.age_years),
        csv: (r) => r.age_years ?? "",
      },
      {
        key: "age_weeks", label: "Age (Weeks)", numeric: true,
        headerTitle: "Style age in weeks since launch",
        render: (r) => (r.age_weeks == null ? "—" : fmtNum(r.age_weeks)),
        sortValue: (r) => (r.age_weeks == null ? -1 : r.age_weeks),
        csv: (r) => r.age_weeks ?? "",
      },
      {
        key: "days_since_launch", label: "Days Since Launch", numeric: true,
        headerTitle: "Whole days since the style launched",
        render: (r) => (r.days_since_launch == null ? "—" : fmtNum(r.days_since_launch)),
        sortValue: (r) => (r.days_since_launch == null ? -1 : r.days_since_launch),
        csv: (r) => r.days_since_launch ?? "",
      },
      {
        key: "weeks_since_launch", label: "Weeks Since Launch", numeric: true,
        headerTitle: "Whole weeks since the style launched",
        render: (r) => (r.weeks_since_launch == null ? "—" : fmtNum(r.weeks_since_launch)),
        sortValue: (r) => (r.weeks_since_launch == null ? -1 : r.weeks_since_launch),
        csv: (r) => r.weeks_since_launch ?? "",
      },
      {
        key: "units_per_week", label: "Units / Week", numeric: true,
        headerTitle: "Average units sold per week over the velocity window",
        render: (r) => (r.units_per_week == null ? "—" : r.units_per_week),
        sortValue: (r) => (r.units_per_week == null ? -1 : r.units_per_week),
        csv: (r) => r.units_per_week ?? "",
      },
      {
        key: "full_price_pct", label: "Full Price %", numeric: true,
        headerTitle: "Lifetime avg selling price ÷ full ticket price (capped at 100%)",
        render: (r) => fmtSor(r.full_price_pct), pct: true,
        sortValue: (r) => (r.full_price_pct == null ? -1 : r.full_price_pct),
        csv: (r) => (r.full_price_pct == null ? "" : r.full_price_pct),
      },
      {
        key: "price_range", label: "Price Range", numeric: true,
        headerTitle: "Min–max full ticket price across the style's variants",
        render: (r) => {
          if (r.price_min == null && r.price_max == null) return "—";
          if (r.price_min === r.price_max) return fmtPrice(r.price_min);
          return `${fmtPrice(r.price_min)} – ${fmtPrice(r.price_max)}`;
        },
        sortValue: (r) => (r.price_max == null ? -1 : r.price_max),
        csv: (r) => {
          if (r.price_min == null && r.price_max == null) return "";
          if (r.price_min === r.price_max) return r.price_min;
          return `${r.price_min} - ${r.price_max}`;
        },
      },
      {
        key: "units_6m", label: "6M Units Sold", numeric: true,
        headerTitle: "Net units sold in the last 180 days (rolling — ignores the date range)",
        render: (r) => fmtNum(r.units_6m), csv: (r) => r.units_6m ?? "",
      },
      {
        key: "revenue_6m", label: "6M Revenue", numeric: true,
        headerTitle: "Revenue in the last 180 days (rolling — ignores the date range)",
        render: (r) => fmtKES(r.revenue_6m), csv: (r) => r.revenue_6m ?? "",
      },
      {
        key: "asp_6m", label: "6M Avg Price", numeric: true,
        headerTitle: "Average selling price over the last 180 days",
        render: (r) => fmtAsp(r.asp_6m), csv: (r) => r.asp_6m ?? "",
      },
      {
        key: "sor_6m", label: "SOR (6m)", numeric: true,
        headerTitle: "Sell-out rate over the last 180 days = 6m units ÷ (6m units + current stock)",
        render: (r) => fmtSor(r.sor_6m), pct: true,
        sortValue: (r) => (r.sor_6m == null ? -1 : r.sor_6m),
      },
      {
        key: "revenue_24m", label: "24M Revenue", numeric: true,
        headerTitle: "Revenue in the last 730 days (rolling — ignores the date range)",
        render: (r) => fmtKES(r.revenue_24m), csv: (r) => r.revenue_24m ?? "",
      },
      {
        key: "asp_24m", label: "24M Avg Price", numeric: true,
        headerTitle: "Average selling price over the last 730 days",
        render: (r) => fmtAsp(r.asp_24m), csv: (r) => r.asp_24m ?? "",
      },
    );
    return cols;
  }, []);

  // Column show/hide for the master table. The Style identity column is always
  // shown; the colour / print / size dimension columns drive row explosion.
  const lockedCols = useMemo(() => new Set(["image", "style_name"]), []);
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
      { key: "image", label: "Photo", image: (r) => odooImageUrl(r.sku), csv: () => "" },
      { key: "style_name", label: "Style", csv: (r) => r.style_name },
      { key: "style_number", label: "Style Number", csv: (r) => r.style_number || "" },
      { key: "brand", label: "Brand", csv: (r) => r.brand || "" },
      { key: "category", label: "Category", csv: (r) => r.category || "" },
      { key: "subcategory", label: "Sub-category", csv: (r) => r.subcategory || "" },
      { key: "color", label: "Colour", csv: (r) => r.color || "" },
      { key: "print", label: "Print", csv: (r) => r.print || "" },
      { key: "size", label: "Size", csv: (r) => r.size || "" },
      { key: "tier", label: "Tier", csv: (r) => r.tier || "" },
      { key: "units_sold", label: "Units Sold", csv: (r) => r.units_sold },
      { key: "soh_stores", label: "SOH in Stores", csv: (r) => r.store_stock ?? "" },
      { key: "soh_warehouse", label: "SOH in Warehouse", csv: (r) => r.warehouse_stock ?? "" },
      { key: "pos_location", label: "POS Location", csv: (r) => r.pos_location || "" },
      { key: "style_status", label: "Style Status", csv: (r) => r.style_status || "" },
      { key: "days_since_last_sale", label: "Days Since Last Sale", csv: (r) => { const d = daysSinceSale(r.last_sale); return d == null ? "" : d; } },
      { key: "revenue", label: "Revenue (KES)", csv: (r) => r.revenue },
      { key: "net_revenue", label: "Net Revenue (KES)", csv: (r) => r.net_revenue },
      { key: "current_stock", label: "Current Stock", csv: (r) => r.current_stock },
      { key: "woc", label: "Weeks of Cover", csv: (r) => (r.woc == null ? "" : r.woc) },
      { key: "sor", label: "Sell-Out Rate %", csv: (r) => (r.sor == null ? "" : r.sor), pct: true },
      { key: "units_life", label: "Units Sold Since Launch", csv: (r) => r.units_life ?? "" },
      { key: "sor_since_launch", label: "SOR Since Launch %", csv: (r) => (r.sor_since_launch == null ? "" : r.sor_since_launch), pct: true },
      { key: "asp", label: "ASP (KES)", csv: (r) => r.asp ?? "" },
      { key: "full_price", label: "Full Price (KES)", csv: (r) => r.full_price ?? "" },
      { key: "current_price", label: "Current Price (KES)", csv: (r) => r.current_price ?? "" },
      { key: "launch_date", label: "Launch Date", csv: (r) => r.launch_date || "" },
      { key: "life_cycle", label: "Life Cycle", csv: (r) => r.life_cycle || "" },
      { key: "reorder_count", label: "No. of Reorders", csv: (r) => r.reorder_count ?? "" },
      { key: "age_years", label: "Age (Years)", csv: (r) => r.age_years ?? "" },
      { key: "age_weeks", label: "Age (Weeks)", csv: (r) => r.age_weeks ?? "" },
      { key: "days_since_launch", label: "Days Since Launch", csv: (r) => r.days_since_launch ?? "" },
      { key: "weeks_since_launch", label: "Weeks Since Launch", csv: (r) => r.weeks_since_launch ?? "" },
      { key: "units_per_week", label: "Units Sold per Week", csv: (r) => r.units_per_week ?? "" },
      { key: "full_price_pct", label: "Full Price %", csv: (r) => (r.full_price_pct == null ? "" : r.full_price_pct), pct: true },
      { key: "price_range", label: "Price Range", csv: (r) => { if (r.price_min == null && r.price_max == null) return ""; if (r.price_min === r.price_max) return r.price_min; return `${r.price_min} - ${r.price_max}`; } },
      { key: "units_6m", label: "6 Months Units Sold", csv: (r) => r.units_6m ?? "" },
      { key: "revenue_6m", label: "6 Months Revenue (KES)", csv: (r) => r.revenue_6m ?? "" },
      { key: "asp_6m", label: "6 Month Avg Price (KES)", csv: (r) => r.asp_6m ?? "" },
      { key: "sor_6m", label: "SOR (6m) %", csv: (r) => (r.sor_6m == null ? "" : r.sor_6m), pct: true },
      { key: "revenue_24m", label: "24 Month Revenue (KES)", csv: (r) => r.revenue_24m ?? "" },
      { key: "asp_24m", label: "24 Month Avg Price (KES)", csv: (r) => r.asp_24m ?? "" },
    ];
    const scopeSlug = stores.length
      ? (stores.length === 1 ? stores[0] : `${stores.length}-stores`)
      : "overall";
    const dimSlug = dims.length ? dims.join("-") : "style";
    exportTable(filteredRows, exportCols, `product_analysis_${dimSlug}_${scopeSlug.replace(/\s+/g, "-")}.csv`, includePhotos);
  }, [filteredRows, dims, stores, includePhotos]);

  const generateAi = useCallback(() => {
    if (!summary) return;
    setAiLoading(true);
    setAiError(null);
    // Build the grounded fact lists from the same rows (style grain). When the
    // master is exploded by colour/print/size, roll the dim rows up to STYLE
    // grain and RECOMPUTE woc/sor from the aggregated totals (carrying a single
    // dim row's woc/sor would mis-rank overstock / slow-movers).
    let styleRows;
    if (dims.length === 0) {
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
  }, [summary, rows, dims, velDays, scopeLabel, rangeLabel]);

  return (
    <div
      className="space-y-5 relative left-1/2 -translate-x-1/2 w-screen px-3 sm:px-5 lg:px-10"
      data-testid="product-analysis-page"
    >
      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2 text-[18px] font-bold text-foreground">
          <Tag size={20} weight="duotone" className="text-[#1a5c38]" />
          Product Analysis
        </h1>
        <p className="text-[12.5px] text-muted mt-1 max-w-3xl">
          One canonical style-level view of sales and stock that reconciles end to end.
          Scope it to all markets or a single store (sales and stock move together),
          explode it to one row per colour, print, size or POS location from the column picker, and
          drill any style into its size / colour split and where its stock is sitting.
          Narrow the date range with
          the presets (or a custom range), scope to one or more stores, and filter by
          range tier — all independent of the global filter bar.
        </p>
        <div className="text-[11.5px] text-muted mt-1">
          {rangeLabel ? <span className="num">{rangeLabel}</span> : null}
          {rangeLabel ? <span className="mx-1.5">·</span> : null}
          <span>{scopeLabel}</span>
        </div>
      </div>

      {/* Scope controls */}
      <div className="card-white p-3.5 flex flex-wrap items-center gap-2.5">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] font-semibold text-muted uppercase tracking-wide">Sales Period</span>
            <div className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5" data-testid="pa-date">
              {[30, 90, 120].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => applyPreset(d)}
                  data-testid={`pa-date-${d}`}
                  className={`px-2 py-0.5 text-[11.5px] font-semibold rounded-full transition-colors ${
                    datePreset === d ? "bg-[#1a5c38] text-white" : "text-[#374151] hover:bg-[#f3f4f6]"
                  }`}
                  title={`Last ${d} days`}
                >
                  {d}D
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] font-semibold text-muted uppercase tracking-wide">Custom</span>
            <div
              className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 ${
                datePreset === "custom" ? "border-[#1a5c38]" : "border-border"
              }`}
              data-testid="pa-date-custom"
            >
              <input
                type="date"
                value={localFrom || ""}
                max={localTo || undefined}
                onChange={(e) => { setLocalFrom(e.target.value); setDatePreset("custom"); }}
                className="bg-transparent text-[11.5px] text-foreground outline-none"
                data-testid="pa-date-from"
                aria-label="From date"
              />
              <span className="text-muted text-[11px]">–</span>
              <input
                type="date"
                value={localTo || ""}
                min={localFrom || undefined}
                onChange={(e) => { setLocalTo(e.target.value); setDatePreset("custom"); }}
                className="bg-transparent text-[11.5px] text-foreground outline-none"
                data-testid="pa-date-to"
                aria-label="To date"
              />
            </div>
          </div>
        </div>

        <MultiSelect
          label="Store"
          icon={Storefront}
          options={posOptions}
          value={stores}
          onChange={setStores}
          placeholder="All stores"
          width={210}
          testId="pa-store"
        />

        <div
          className="inline-flex items-center rounded-full border border-border p-0.5 text-[11.5px]"
          data-testid="pa-warehouse-toggle"
          title="Include or exclude warehouse / holding-location stock in the figures"
        >
          <button
            type="button"
            onClick={() => setIncludeWarehouse(false)}
            className={`px-2.5 py-1 rounded-full transition-colors ${!includeWarehouse ? "bg-brand text-white" : "text-muted hover:text-foreground"}`}
            data-testid="pa-warehouse-exclude"
          >
            Stores only
          </button>
          <button
            type="button"
            onClick={() => setIncludeWarehouse(true)}
            className={`px-2.5 py-1 rounded-full transition-colors ${includeWarehouse ? "bg-brand text-white" : "text-muted hover:text-foreground"}`}
            data-testid="pa-warehouse-include"
          >
            Incl. warehouse
          </button>
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

        <MultiSelect
          label="Tier"
          icon={ChartBar}
          options={[
            { value: "Tier 1", label: "Tier 1 · NOOS / never out of stock" },
            { value: "Tier 2", label: "Tier 2 · Core performers" },
            { value: "Tier 3", label: "Tier 3 · Developing / watch" },
            { value: "Tier 4", label: "Tier 4 · Trial / new entry" },
            { value: "Retired", label: "Retired" },
          ]}
          value={tiers}
          onChange={setTiers}
          placeholder="All tiers"
          width={200}
          testId="pa-tier"
        />

        <label
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px] text-muted"
          title="Top revenue contributors (Pareto): keep the fewest highest-revenue styles whose cumulative revenue reaches this % of the current selection. Blank = off."
        >
          Top rev %
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={revPct}
            onChange={(e) => setRevPct(e.target.value)}
            placeholder="off"
            className="w-[52px] bg-transparent text-[12px] text-foreground outline-none"
            data-testid="pa-rev-pct"
          />
        </label>

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
                label={status === "active" ? "Active Styles" : status === "retired" ? "Retired Styles" : "Styles"}
                value={fmtNum(summary.styles)} icon={Tag}
                sub={`${fmtNum(summary.actively_selling)} actively selling`}
                formula="Styles counts only Vivo Fashion Group styles that currently hold stock (third-party consignment and zero-stock styles are excluded). Active vs Retired is a lifecycle status: a style is Retired when it is manually retired or gated to the underperforming/aged 'Retire' tier, and Active otherwise — independent of window sales. 'Actively selling' means the style sold at least one unit within the selected velocity window (an overlay across both Active and Retired)."
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
                {dims.length ? ` · by ${dims.map((d) => (d === "color" ? "colour" : d === "pos_location" ? "POS" : d)).join(" × ")}` : ""}
              </div>
              <div className="flex items-center gap-2">
                <details className="relative" data-testid="pa-columns">
                  <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-brand px-2 py-1 rounded border border-border hover:border-brand select-none">
                    Columns{hiddenCols.size ? ` (${columns.length - hiddenCols.size}/${columns.length})` : ""}
                  </summary>
                  <div className="absolute right-0 z-50 mt-1 w-56 max-h-72 overflow-auto rounded-md border border-border bg-white shadow-lg p-1.5">
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
                <label
                  className="inline-flex items-center gap-1.5 text-[11.5px] text-muted cursor-pointer select-none px-1"
                  title="Include product photos in the export (slower). Uncheck for a fast CSV without images."
                  data-testid="pa-master-include-photos"
                >
                  <input
                    type="checkbox"
                    checked={includePhotos}
                    onChange={(e) => setIncludePhotos(e.target.checked)}
                    className="accent-[var(--brand,#1a5c38)] cursor-pointer"
                  />
                  Photos
                </label>
                <button
                  type="button"
                  onClick={exportMaster}
                  disabled={!filteredRows.length}
                  className="inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-brand px-2 py-1 rounded border border-border hover:border-brand disabled:opacity-40"
                  data-testid="pa-master-export"
                >
                  {includePhotos ? "Export Excel" : "Export CSV"}
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
                rowKey={(r) => (dims.length ? `${r.style_name}|${dims.map((d) => r[d] ?? "").join("|")}` : r.style_name)}
                emptyLabel="No styles match the filters."
              />
            ) : (
              <Empty label="No styles match the filters." />
            )}
          </div>
        </>
      )}

      {drillStyle ? (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center bg-black/45 backdrop-blur-sm p-4"
          onClick={() => setDrillStyle(null)}
          data-testid="pa-style-drill-backdrop"
        >
          <div
            className="card-white p-5 w-full max-w-2xl space-y-4 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            data-testid="pa-style-drill-modal"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10.5px] uppercase tracking-wider text-muted">Style detail</div>
                <div className="text-[15px] font-semibold break-words">{drillStyle.style_name}</div>
              </div>
              <button
                type="button"
                onClick={() => setDrillStyle(null)}
                className="text-muted hover:text-foreground shrink-0"
                aria-label="Close"
                data-testid="pa-style-drill-close"
              >
                <XIcon size={18} />
              </button>
            </div>

            {/* Photo + identity + lifecycle badges */}
            <div className="flex gap-4">
              <div className="shrink-0">
                <ProductImage sku={drillStyle.sku} label={drillStyle.style_name} size={112} />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {drillStyle.tier ? (
                    <span
                      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-brand/10 text-brand"
                      title={TIER_DESC[drillStyle.tier] || ""}
                    >
                      {drillStyle.tier}
                      {TIER_DESC[drillStyle.tier] ? ` · ${TIER_DESC[drillStyle.tier]}` : ""}
                    </span>
                  ) : null}
                  {drillStyle.style_status ? (
                    <span
                      className={
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium " +
                        (drillStyle.style_status === "Active"
                          ? "bg-emerald-500/15 text-emerald-600"
                          : "bg-muted text-muted-foreground")
                      }
                    >
                      {drillStyle.style_status}
                    </span>
                  ) : null}
                  {drillStyle.life_cycle ? (
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium border border-border text-muted">
                      {drillStyle.life_cycle}
                    </span>
                  ) : null}
                </div>
                <div className="text-[11.5px] text-muted space-y-0.5">
                  <div>
                    {[drillStyle.brand, drillStyle.category, drillStyle.subcategory]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {drillStyle.style_number ? <span>Style&nbsp;#{drillStyle.style_number}</span> : null}
                    {drillStyle.color ? <span>{drillStyle.color}</span> : null}
                    {drillStyle.launch_date ? <span>Launched {fmtDate(drillStyle.launch_date)}</span> : null}
                    {(() => {
                      const d = daysSinceSale(drillStyle.last_sale);
                      return d == null ? null : <span>Last sold {fmtNum(d)}d ago</span>;
                    })()}
                  </div>
                </div>
              </div>
            </div>

            {/* Key metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="pa-style-drill-stats">
              {[
                { label: "SOR (period)", value: fmtSor(drillStyle.sor) },
                { label: "SOR since launch", value: fmtSor(drillStyle.sor_since_launch) },
                { label: "Units sold (period)", value: fmtNum(drillStyle.units_sold) },
                { label: "Units since launch", value: fmtNum(drillStyle.units_life) },
                { label: "Revenue (period)", value: fmtKES(drillStyle.revenue) },
                { label: "Current stock", value: fmtNum(drillStyle.current_stock) },
                { label: "SOH stores", value: fmtNum(drillStyle.store_stock) },
                { label: "SOH warehouse", value: fmtNum(drillStyle.warehouse_stock) },
                { label: "Weeks of cover", value: fmtWoc(drillStyle.woc) },
                { label: "Reorders", value: fmtNum(drillStyle.reorder_count) },
                { label: "ASP", value: fmtAsp(drillStyle.asp) },
                { label: "Full price", value: fmtPrice(drillStyle.full_price) },
                { label: "Current price", value: fmtPrice(drillStyle.current_price) },
              ].map((s) => (
                <div key={s.label} className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5">
                  <div className="text-[9.5px] uppercase tracking-wider text-muted leading-tight">{s.label}</div>
                  <div className="text-[13px] font-semibold tabular-nums">{s.value ?? "—"}</div>
                </div>
              ))}
            </div>

            <StyleDrill styleName={drillStyle.style_name} params={drillParams} />
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default ProductAnalysis;
