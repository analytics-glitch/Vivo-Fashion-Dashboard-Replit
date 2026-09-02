/**
 * Stock Mix drill-down — Inventory & Stock Health tab (Merchandising Hub).
 *
 * Brings the fabric Stock Mix pattern to finished goods: one expandable table
 * Category → Sub Category → Style → Colour, showing how stock is distributed
 * vs how sales are distributed, so colour-level replenish/retire calls can be
 * made in one place:
 *   • Every hierarchy level (and the pinned Total row) uses share-of-total
 *     semantics for % of SOH and % of Units Sold. Gap (pp) = % of SOH −
 *     % of Units Sold — positive = overstocked (house convention shared with
 *     the fabric page).
 *   • Every level also shows a dedicated selected-period SOR column:
 *     units sold ÷ (units sold + current SOH). Because each node carries
 *     aggregated units and SOH, this is calculated from summed numerator and
 *     denominator rather than averaging child percentages.
 *   • Style / Colour rows carry a "Last Ordered" date (most recent
 *     production/buying order); colour rows a lazy product thumbnail.
 *     Right-clicking a colour row — or clicking/tapping its thumbnail —
 *     opens the MerchColourDetail popup (photos, master data, per-size
 *     stock, this row's period numbers).
 *   • "Download CSV" exports the ENTIRE tree (every row at every level,
 *     independent of search/expansion) with hierarchy columns + all metrics.
 *
 * API contract (/api/merch/stock-mix):
 *   { categories: [{ name, stock_units, stock_value, units_period,
 *       revenue_period, woc,
 *       subcategories: [{ ..., styles: [{ ..., style_number, last_order_date,
 *         status,
 *         colours: [{ ..., status, skus_in_stock, skus_sold, last_order_date,
 *           rep_sku }] }] }] }],
 *     totals: { stock_units, stock_value, units_period, revenue_period },
 *     period: { from, to } }
 *
 * `last_order_date` / `rep_sku` are nullable AND may be missing entirely from
 * a briefly-cached old-shape payload — every consumer here null-guards them
 * (missing → dash / no thumbnail); the table itself never depends on them.
 *
 * % of SOH / % of Units Sold / Gap are derived here from `totals` (same as
 * the fabric page derives shares client-side), so rows and totals always
 * agree. The TOTAL row is pinned in the sticky thead so it stays visible
 * while drilling and scrolling.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, ChevronRight, Download, Info, Search, X } from "lucide-react";
import { ErrorBox } from "@/components/common";
import { fmtNum, fmtKESM, wocColor } from "./MerchHelpers";
import ProductImage from "@/components/ProductImage";
import MerchColourDetail from "./MerchColourDetail";

const SEP = "\u0001";
const CHILD_KEYS = ["subcategories", "styles", "colours", null];
const LEVEL_LABEL = ["Category", "Sub Category", "Style", "Colour"];
const MAX_ROWS = 600;

const FX = {
  stock:    "Sellable SOH = stock available to sell now in Vivo, Zoya, Safari and Oasis retail stores, Online - Shop Zetu, plus Warehouse Finished Goods. Finished Goods Production, WIP, receiving, transit, raw materials, samples, QC/defects, holding/retired and unknown locations are excluded.",
  pipeline: "Pipeline = committed units on open Odoo Buying Orders that have not yet become sellable finished goods. Broken down by Draft, BOM Pending, Ready, Partially Planned and Fully Planned. Pipeline is never added to SOH, WOC or SOR.",
  value:    "Stock Value = stock units × unit cost (KES, at cost).",
  sold:     "Units Sold = gross units sold in the selected period (returns not netted).",
  revenue:  "Total Revenue = net sales in the selected period (after discounts & returns, ex-VAT) — same basis as the hub's revenue figures.",
  pctStock: "% of SOH = this row's SOH ÷ TOTAL SOH across all categories. Every level is measured against the grand total.",
  pctSales: "% of Units Sold = this row's period units ÷ TOTAL period units. Every level is measured against the grand total.",
  sor:      "Sell-through rate for selected period · Units Sold ÷ (Units Sold + Stock on Hand)",
  gap:      "Gap (pp) = % of SOH − % of Units Sold (percentage points), both as shares of the grand total at EVERY level (unchanged by the SOR display on style/colour rows). Positive = overstocked (holds a larger share of stock than of sales); negative = under-stocked vs demand.",
  woc:      "Weeks of Cover = stock ÷ weekly run-rate (trailing 6 months ÷ 26) — independent of the selected period, matching the tab's WOC.",
  lastOrd:  "Last Ordered = date of the most recent production/buying order for this style (style rows) or this exact colourway (colour rows). Dash = no order on record; category rows don't aggregate order dates.",
  skus:     "SKUs (stock / sold) = distinct SKUs (sizes) of this colour with stock on hand / sold in the period.",
};

const PIPELINE_STATES = [
  ["draft", "Draft"],
  ["bom_pending", "BOM Pending"],
  ["ready", "Ready"],
  ["partially_planned", "Partially Planned"],
  ["fully_planned", "Fully Planned"],
];

const PipelineCell = ({ node, className = "" }) => {
  const states = node?.pipeline_by_state || {};
  const nonZero = PIPELINE_STATES.filter(([key]) => Number(states[key]) !== 0);
  return (
    <td className={`text-right px-2 py-1.5 tabular-nums ${className}`} title={FX.pipeline}>
      <div className="font-medium text-slate-700">{fmtNum(node?.pipeline_units)}</div>
      {nonZero.length > 0 ? (
        <div className="mt-0.5 whitespace-nowrap text-[8.5px] font-normal leading-tight text-slate-400">
          {nonZero.map(([key, label]) => `${label} ${fmtNum(states[key])}`).join(" · ")}
        </div>
      ) : null}
    </td>
  );
};

// Selected-period sell-through at every hierarchy level: units sold in the
// period ÷ (units sold + current SOH). Null when either input is missing or
// the denominator is not meaningful; clamped to 0–100 for safe display.
const sorOf = (node) => {
  if (
    node?.units_period === null || node?.units_period === undefined ||
    node?.stock_units === null || node?.stock_units === undefined ||
    node?.units_period === "" || node?.stock_units === ""
  ) return null;
  const u = Number(node.units_period);
  const s = Number(node.stock_units);
  if (!Number.isFinite(u) || !Number.isFinite(s)) return null;
  const d = u + s;
  if (d <= 0) return null;
  return Math.max(0, Math.min(100, (u / d) * 100));
};

const sorTextClass = (sor, node) => {
  if (sor == null) return "text-slate-300";
  const soh = Number(node?.stock_units);
  if (sor === 0 && Number.isFinite(soh) && soh > 0) return "text-rose-600";
  if (sor >= 80) return "text-emerald-700";
  if (sor < 50) return "text-amber-700";
  return "text-slate-700";
};

const SorCell = ({ node, className = "" }) => {
  const sor = sorOf(node);
  return (
    <td className={`text-right px-2 py-1.5 tabular-nums ${className}`}>
      {sor == null ? (
        <span className="text-slate-300">—</span>
      ) : (
        <span className={`font-medium ${sorTextClass(sor, node)}`}>
          {sor.toFixed(1)}%
        </span>
      )}
    </td>
  );
};

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
};

// Gap chip — same sign convention + thresholds as the fabric Stock Mix page.
const GapPill = ({ v }) => {
  const n = Number(v) || 0;
  const a = Math.abs(n).toFixed(1);
  if (n >= 3) return (
    <span className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700"
          title="Holds a larger share of stock than of sales (overstocked).">+{a}pp</span>
  );
  if (n <= -3) return (
    <span className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-600"
          title="Sells a larger share than it holds (under-stocked vs demand).">−{a}pp</span>
  );
  return (
    <span className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700"
          title="Stock share and sales share are in balance.">±{a}pp</span>
  );
};

const lifecycleStatus = (value) => {
  const normalized = String(value || "Active").trim().toLowerCase();
  if (normalized === "retired") return "Retired";
  if (normalized === "archived") return "Archived";
  return "Active";
};

const LifecycleBadge = ({ status, inconsistent = false }) => {
  const label = lifecycleStatus(status);
  const classes = {
    Active: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
    Retired: "bg-amber-50 text-amber-700 ring-amber-600/20",
    Archived: "bg-slate-100 text-slate-500 ring-slate-500/20",
  };
  const title = inconsistent
    ? "Style is retired but this colourway shows as active — check Odoo"
    : `${label} lifecycle status`;
  return (
    <span
      className={`inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[9px] font-semibold leading-none ring-1 ring-inset ${classes[label]}`}
      title={title}
      aria-label={title}
      data-testid={`lifecycle-badge-${label.toLowerCase()}`}
    >
      {label}
      {inconsistent ? <AlertTriangle className="h-3 w-3 text-amber-600" aria-hidden="true" /> : null}
    </span>
  );
};

const LEVEL_ROW_CLS = [
  "bg-slate-50/80 font-semibold text-slate-800",
  "font-medium text-slate-700",
  "text-slate-600",
  "text-slate-500",
];

const CSV_HEADERS = [
  "Level", "Category", "Sub Category", "Style", "Style Number", "Colour",
  "Sellable SOH Units", "Pipeline Units", "Pipeline Draft", "Pipeline BOM Pending",
  "Pipeline Ready", "Pipeline Partially Planned", "Pipeline Fully Planned",
  "Stock Value KES", "Units Sold", "Revenue KES",
  "% of SOH", "% of Units Sold / SOR", "Gap pp", "WOC", "Last Ordered",
  "SKUs in Stock", "SKUs Sold",
];

// Find the exact style-code path in the loaded hierarchy. The returned paths
// match the keys used by the existing expansion state, so deep links can open
// every ancestor without changing the tree's identity or ordering.
const findStyleTarget = (categories, styleNumber) => {
  if (!styleNumber) return null;
  let found = null;

  const walk = (nodes, level, parentPath, openPaths) => {
    for (const node of nodes || []) {
      const path = parentPath ? `${parentPath}${SEP}${node.name}` : String(node.name || "");
      const nextOpenPaths = [...openPaths, path];
      if (
        level === 2 &&
        String(node.style_number || "").trim() === String(styleNumber).trim()
      ) {
        found = { path, openPaths: nextOpenPaths };
        return true;
      }
      const childKey = CHILD_KEYS[level];
      if (childKey && walk(node[childKey] || [], level + 1, path, nextOpenPaths)) {
        return true;
      }
    }
    return false;
  };

  walk(categories, 0, "", []);
  return found;
};

export default function MerchStockMix({
  data,
  loading,
  error,
  showRetired = false,
  onShowRetiredChange,
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState({});
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState(null);
  const [highlightedStyle, setHighlightedStyle] = useState("");
  const rowRefs = useRef(new Map());
  const requestedStyle = searchParams.get("style") || "";
  const shouldFocusStyle = Boolean(
    requestedStyle && searchParams.get("expanded") === "true"
  );
  const q = query.trim().toLowerCase();

  const cats   = data?.categories || [];
  const totals = data?.totals || {};
  const totSu  = Number(totals.stock_units) || 0;
  const totUp  = Number(totals.units_period) || 0;
  const styleTarget = useMemo(
    () => findStyleTarget(cats, requestedStyle),
    [cats, requestedStyle]
  );

  // Flatten the tree into visible rows. In search mode a node is visible when
  // its own name matches, an ancestor matches, or a descendant matches — and
  // the ancestry of every match auto-expands (fabric-page behaviour). Each
  // row carries its parent style context so colour rows can open the popup
  // with the full style + colour identity.
  const rows = useMemo(() => {
    const out = [];
    const walk = (node, level, path, ancestorMatch, styleCtx) => {
      const ck = CHILD_KEYS[level];
      const kids = ck ? node[ck] || [] : [];
      const visibleKids = kids;
      const nextCtx = level === 2
        ? { name: node.name, number: node.style_number, status: lifecycleStatus(node.status) }
        : styleCtx;
        const searchable = [
          node.name,
          level === 2 ? node.style_number : "",
        ].filter(Boolean).join(" ");
        const selfMatch = q !== "" && searchable.toLowerCase().includes(q);
      const childRows = [];
      let descMatch = false;
      for (const k of visibleKids) {
        const r = walk(k, level + 1, path + SEP + k.name, ancestorMatch || selfMatch, nextCtx);
        if (r.rowList.length) childRows.push(...r.rowList);
        descMatch = descMatch || r.branchMatch;
      }
      const visible = !q || selfMatch || ancestorMatch || descMatch;
      const expanded = q
        ? (descMatch || (!!open[path] && (selfMatch || ancestorMatch)))
        : !!open[path];
      const rowList = [];
      if (visible) {
        rowList.push({ node, level, path, expandable: visibleKids.length > 0, expanded, hit: selfMatch, styleCtx: nextCtx });
        if (expanded) rowList.push(...childRows);
      }
      return { rowList, branchMatch: selfMatch || descMatch };
    };
    for (const c of cats) out.push(...walk(c, 0, c.name, false, null).rowList);
    return out;
  }, [cats, q, open]);

  // A deep link is also a real table filter: this keeps the selected style
  // visible even when it would otherwise fall below the 600-row safety cap.
  // Expansion remains explicit so the URL contract is useful independently of
  // the search implementation.
  useEffect(() => {
    if (!shouldFocusStyle || !styleTarget) return;
    setQuery((current) => current === requestedStyle ? current : requestedStyle);
    setOpen((current) => {
      const next = { ...current };
      let changed = false;
      for (const path of styleTarget.openPaths) {
        if (!next[path]) {
          next[path] = true;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [shouldFocusStyle, requestedStyle, styleTarget]);

  const truncated = rows.length > MAX_ROWS;
  const shown = truncated ? rows.slice(0, MAX_ROWS) : rows;
  // Colour-only column stays hidden until colour rows are actually on screen
  // (a style drilled open, or a search surfacing colours) — fabric behaviour.
  const showSkus = shown.some((r) => r.level === 3);
  const nCols = 12 + (showSkus ? 1 : 0);

  const toggle = (path) => setOpen((o) => ({ ...o, [path]: !o[path] }));

  // Scroll after the expanded/search-filtered row has actually been rendered.
  // The short delay lets the browser commit the new table layout first.
  useEffect(() => {
    if (!shouldFocusStyle || !styleTarget) return undefined;
    const timer = window.setTimeout(() => {
      const row = rowRefs.current.get(String(requestedStyle));
      if (!row) return;
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedStyle(String(requestedStyle));
    }, 60);
    const clearHighlight = window.setTimeout(() => {
      setHighlightedStyle((current) =>
        current === String(requestedStyle) ? "" : current
      );
    }, 2400);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clearHighlight);
    };
  }, [shouldFocusStyle, requestedStyle, styleTarget, rows]);

  const viewDeepDive = (styleNumber) => {
    if (!styleNumber) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", "merch-deepdive");
      next.set("style", String(styleNumber));
      next.delete("expanded");
      return next;
    });
  };

  const pctOf = (v, tot) => (tot > 0 ? (Number(v) / tot) * 100 : 0);

  // ── Full-tree CSV export ──────────────────────────────────────────────────
  // Flattens the ENTIRE loaded tree — every node at every level, regardless
  // of the current search or expansion state. Shares/SOR/gap mirror exactly
  // what the table shows at each level.
  const csvRows = useMemo(() => {
    const out = [];
    const walk = (node, level, ctx) => {
      const pctS = pctOf(node.stock_units, totSu);
      const pctU = pctOf(node.units_period, totUp);
      const sor = level >= 2 ? sorOf(node) : null;
      out.push([
        LEVEL_LABEL[level],
        level === 0 ? node.name : ctx.category,
        level === 1 ? node.name : level > 1 ? ctx.sub : "",
        level === 2 ? node.name : level > 2 ? ctx.style : "",
        level === 2 ? node.style_number || "" : level > 2 ? ctx.styleNumber : "",
        level === 3 ? node.name : "",
        Math.round(Number(node.stock_units) || 0),
        Math.round(Number(node.pipeline_units) || 0),
        ...PIPELINE_STATES.map(([key]) =>
          Math.round(Number(node.pipeline_by_state?.[key]) || 0)
        ),
        Math.round(Number(node.stock_value) || 0),
        Math.round(Number(node.units_period) || 0),
        Math.round(Number(node.revenue_period) || 0),
        pctS.toFixed(1),
        level >= 2 ? (sor == null ? "" : sor.toFixed(1)) : pctU.toFixed(1),
        (pctS - pctU).toFixed(1),
        node.woc == null ? "" : node.woc,
        level >= 2 ? node.last_order_date || "" : "",
        level === 3 ? (node.skus_in_stock ?? "") : "",
        level === 3 ? (node.skus_sold ?? "") : "",
      ]);
      const ck = CHILD_KEYS[level];
      for (const k of (ck && node[ck]) || []) {
        walk(k, level + 1, {
          category: level === 0 ? node.name : ctx.category,
          sub: level === 1 ? node.name : ctx.sub,
          style: level === 2 ? node.name : ctx.style,
          styleNumber: level === 2 ? node.style_number || "" : ctx.styleNumber,
        });
      }
    };
    for (const c of cats) walk(c, 0, { category: "", sub: "", style: "", styleNumber: "" });
    return out;
  }, [cats, totSu, totUp]);

  const downloadCsv = () => {
    if (!csvRows.length) return;
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [CSV_HEADERS.join(","), ...csvRows.map((r) => r.map(esc).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = data?.period
      ? `Stock_Mix_${data.period.from}_to_${data.period.to}.csv`
      : `Stock_Mix_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Open the product-detail popup for a colour row (right-click or thumbnail
  // click). Works even without a rep_sku — the popup then shows the row's
  // period numbers and explains that no product-master SKU matched.
  const openDetail = (r) => {
    const n = r.node;
    setDetail({
      sku: n.rep_sku || null,
      colour: n.name,
      styleName: r.styleCtx?.name || "",
      styleNumber: r.styleCtx?.number || "",
      metrics: {
        stock_units: n.stock_units,
        stock_value: n.stock_value,
        units_period: n.units_period,
        revenue_period: n.revenue_period,
        sor: sorOf(n),
        woc: n.woc,
        last_order_date: n.last_order_date || null,
        skus_in_stock: n.skus_in_stock,
        skus_sold: n.skus_sold,
      },
    });
  };

  return (
    <div className="bg-white rounded-xl shadow-sm p-4 sm:p-5" data-testid="merch-stock-mix">
      <div className="flex items-start justify-between flex-wrap gap-2 mb-3">
        <div>
          <div className="text-[12px] font-semibold text-slate-500">
            Stock Mix — where stock sits vs where sales happen
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">
            Shares vs grand total on category rows · SOR on style & colour rows · click to drill
            Category → Sub Category → Style → Colour · right-click a colour (or tap its photo) for the product card
            {data?.period ? ` · units sold ${data.period.from} → ${data.period.to}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={downloadCsv}
            disabled={!csvRows.length}
            data-testid="mix-csv-btn"
            title="Export the full tree — every category, sub-category, style and colour row (not just the expanded ones) with all metrics."
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            Download CSV{csvRows.length ? ` · ${fmtNum(csvRows.length)} rows` : ""}
          </button>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search category, style or colour…"
              data-testid="mix-search-input"
              className="text-[12px] border border-slate-200 rounded-lg pl-8 pr-7 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-brand w-[240px] max-w-full"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <label
            className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 whitespace-nowrap cursor-pointer select-none"
            title="Include colourways whose product-master lifecycle status is Retired or Archived."
          >
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => onShowRetiredChange?.(e.target.checked)}
              data-testid="mix-show-retired-colourways"
              className="h-3.5 w-3.5 rounded border-slate-300 text-[#1a5c38] focus:ring-[#1a5c38]/30"
            />
            Show retired styles & colourways
          </label>
        </div>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-2 py-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-8 bg-slate-100 rounded" />
          ))}
        </div>
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <div className="overflow-auto max-h-[600px] rounded-lg border border-slate-100">
          <table className="w-full min-w-[1080px] text-[11.5px] border-collapse">
            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_#e2e8f0]">
              <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                <th className="text-left font-semibold px-2 py-2">
                  Category / Sub / Style / Colour
                </th>
                <th className="text-right font-semibold px-2 py-2" title={FX.stock}>Sellable SOH</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.pipeline}>Pipeline</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.value}>Stock Value</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.sold}>Units Sold</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.revenue}>Total Revenue</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.pctStock}>% of SOH</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.pctSales}>% of Units Sold</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.sor}>
                  <span className="inline-flex items-center justify-end gap-1">
                    SOR
                    <Info
                      className="h-3 w-3 text-slate-400"
                      aria-label={FX.sor}
                      title={FX.sor}
                    />
                  </span>
                </th>
                <th className="text-right font-semibold px-2 py-2" title={FX.gap}>Gap (pp)</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.woc}>WOC</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.lastOrd}>Last Ordered</th>
                {showSkus && (
                  <th className="text-right font-semibold px-2 py-2" title={FX.skus}>SKUs</th>
                )}
              </tr>
              {shown.length > 0 && (
                <tr
                  className="bg-slate-50 font-bold text-slate-800 shadow-[0_1px_0_#cbd5e1]"
                  data-testid="mix-total-row"
                >
                  <td className="px-2 py-2">Total</td>
                  <td className="text-right px-2 py-2 tabular-nums" data-testid="mix-total-stock">
                    {fmtNum(totals.stock_units)}
                  </td>
                  <PipelineCell node={totals} className="py-2" />
                  <td className="text-right px-2 py-2 tabular-nums">{fmtKESM(totals.stock_value)}</td>
                  <td className="text-right px-2 py-2 tabular-nums">{fmtNum(totals.units_period)}</td>
                  <td className="text-right px-2 py-2 tabular-nums">{fmtKESM(totals.revenue_period)}</td>
                  <td className="text-right px-2 py-2 tabular-nums">100.0%</td>
                  <td className="text-right px-2 py-2 tabular-nums">100.0%</td>
                  <SorCell node={totals} className="py-2" />
                  <td className="text-right px-2 py-2 text-slate-300 font-normal" title="Gap nets to 0 across all categories.">—</td>
                  <td className="text-right px-2 py-2 text-slate-300 font-normal" title="Cover is a ratio — no meaningful grand total.">—</td>
                  <td className="text-right px-2 py-2 text-slate-300 font-normal" title="Order dates don't aggregate.">—</td>
                  {showSkus && <td className="px-2 py-2" />}
                </tr>
              )}
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={nCols} className="text-center text-slate-400 py-8">
                    {q ? <>No match for “{query.trim()}”.</> : "No stock or sales in this view."}
                  </td>
                </tr>
              )}
              {shown.map((r) => {
                const n = r.node;
                const rowStatus = lifecycleStatus(n.status);
                const colourInconsistency = r.level === 3
                  && r.styleCtx?.status === "Retired"
                  && rowStatus === "Active";
                const pctS = pctOf(n.stock_units, totSu);
                const pctU = pctOf(n.units_period, totUp);
                const gap = pctS - pctU;
                return (
                  <tr
                    key={r.path}
                    data-testid={`mix-row-l${r.level}`}
                    data-style-number={r.level === 2 ? n.style_number || undefined : undefined}
                    ref={(el) => {
                      if (r.level !== 2 || !n.style_number) return;
                      const key = String(n.style_number);
                      if (el) rowRefs.current.set(key, el);
                      else rowRefs.current.delete(key);
                    }}
                    onClick={r.expandable ? () => toggle(r.path) : undefined}
                    onContextMenu={r.level === 3 ? (e) => { e.preventDefault(); openDetail(r); } : undefined}
                    className={`border-t border-slate-100 ${LEVEL_ROW_CLS[r.level]} ${
                      r.expandable ? "cursor-pointer hover:bg-slate-50" : ""
                     } ${highlightedStyle === String(n.style_number || "") ? "mix-style-highlight" : ""}`}
                  >
                    <td className="px-2 py-1.5">
                      <div
                        className="flex items-center gap-1"
                        style={{ paddingLeft: r.level * 18 }}
                      >
                        {r.expandable ? (
                          <ChevronRight
                            className={`w-3.5 h-3.5 shrink-0 text-slate-400 transition-transform ${
                              r.expanded ? "rotate-90" : ""
                            }`}
                          />
                        ) : (
                          <span className="w-3.5 shrink-0 text-center text-slate-300">·</span>
                        )}
                        {r.level === 3 && n.rep_sku ? (
                          <span
                            className="shrink-0 cursor-pointer"
                            onClick={(e) => { e.stopPropagation(); openDetail(r); }}
                            title="View product card"
                            data-testid={`mix-thumb-${n.rep_sku}`}
                          >
                            <ProductImage
                              sku={n.rep_sku}
                              label={`${r.styleCtx?.name || ""} ${n.name}`.trim()}
                              size={26}
                              expandable={false}
                            />
                          </span>
                        ) : null}
                        <span className={`break-words ${r.hit ? "bg-yellow-100 rounded px-0.5" : ""}`}>
                          {n.name}
                        </span>
                        {r.level === 2 ? (
                           <>
                             {n.style_number ? (
                               <span className="text-[9.5px] text-slate-400 shrink-0">{n.style_number}</span>
                             ) : null}
                             <LifecycleBadge status={rowStatus} />
                             {n.style_number ? (
                               <button
                                 type="button"
                                 onClick={(e) => {
                                   e.stopPropagation();
                                   viewDeepDive(n.style_number);
                                 }}
                                 className="ml-1.5 shrink-0 text-[9.5px] font-semibold text-[#1a5c38] hover:underline underline-offset-2 focus:outline-none focus:ring-1 focus:ring-[#1a5c38]/30 rounded"
                                 aria-label={`View ${n.name} in Style Deep Dive`}
                                 data-testid={`mix-view-deep-dive-${n.style_number}`}
                               >
                                 View Style Deep Dive →
                               </button>
                             ) : null}
                           </>
                        ) : null}
                         {r.level === 3 ? (
                           <LifecycleBadge status={rowStatus} inconsistent={colourInconsistency} />
                         ) : null}
                        {r.level === 0 ? (
                          <span className="text-[9.5px] text-slate-400 font-normal shrink-0">
                            · {LEVEL_LABEL[0]}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="text-right px-2 py-1.5 tabular-nums">{fmtNum(n.stock_units)}</td>
                    <PipelineCell node={n} />
                    <td className="text-right px-2 py-1.5 tabular-nums">{fmtKESM(n.stock_value)}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums">{fmtNum(n.units_period)}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums">{fmtKESM(n.revenue_period)}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums">{pctS.toFixed(1)}%</td>
                    <td className="text-right px-2 py-1.5 tabular-nums">
                      {`${pctU.toFixed(1)}%`}
                    </td>
                    <SorCell node={n} />
                    <td className="text-right px-2 py-1.5"><GapPill v={gap} /></td>
                    <td className="text-right px-2 py-1.5 tabular-nums">
                      {n.woc == null ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <span className="font-medium" style={{ color: wocColor(n.woc) }}>
                          {Number(n.woc).toFixed(1)}w
                        </span>
                      )}
                    </td>
                    <td className="text-right px-2 py-1.5 tabular-nums whitespace-nowrap">
                      {r.level >= 2 && n.last_order_date ? (
                        <span className="text-slate-500">{fmtDate(n.last_order_date)}</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    {showSkus && (
                      <td className="text-right px-2 py-1.5 tabular-nums text-slate-400">
                        {r.level === 3 ? `${fmtNum(n.skus_in_stock)} / ${fmtNum(n.skus_sold)}` : ""}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {truncated && (
        <div className="text-[10px] text-slate-400 mt-2">
          Showing the first {MAX_ROWS} rows — refine the search to narrow the tree.
        </div>
      )}

      {detail ? (
        <MerchColourDetail item={detail} period={data?.period} onClose={() => setDetail(null)} />
      ) : null}
    </div>
  );
}
