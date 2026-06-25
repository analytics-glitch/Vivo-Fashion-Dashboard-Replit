import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { api, fmtNum, fmtPct } from "@/lib/api";
import { exportCSV } from "@/components/SortableTable";
import { VarianceCell, varianceFlag } from "@/lib/variance";
import ProductDetailModal from "@/components/ProductDetailModal";
import {
  Plus,
  Minus,
  Download,
  CaretDown,
  MagnifyingGlass,
  X,
  Package,
} from "@phosphor-icons/react";

// Shared grid template — every header / row uses it so all columns line up
// vertically across all four drill levels.
const GRID =
  "grid grid-cols-[26px_minmax(0,2.3fr)_0.9fr_0.9fr_0.9fr_0.9fr_1fr_1.1fr] gap-2 items-center";

const useDebounced = (value, delay = 250) => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
};

// Action-item rule at product grain: the two operationally actionable extremes.
const actionReason = (units, stock) => {
  if (units > 0 && stock <= 0) return "Stockout risk";
  if (stock > 0 && units <= 0) return "Idle / overstock";
  return "";
};

// ── metric cells (Units / Inventory / %Sales / %Inventory / Variance / Risk) ──
const MetricCells = ({ m }) => (
  <>
    <span className="text-right tabular-nums">{fmtNum(m.units_sold)}</span>
    <span className="text-right tabular-nums">{fmtNum(m.current_stock)}</span>
    <span className="text-right tabular-nums text-[#6b7280]">{fmtPct(m.pct_sold, 2)}</span>
    <span className="text-right tabular-nums text-[#6b7280]">{fmtPct(m.pct_stock, 2)}</span>
    <span className="text-right">
      <VarianceCell value={m.variance} />
    </span>
    <span className="text-right text-[11px] text-muted">{varianceFlag(m.variance)}</span>
  </>
);

// ── variant (leaf) row ──
const VariantRow = ({ v, mk, onPick }) => {
  const m = mk(v.units_sold, v.current_stock);
  const label =
    [v.color, v.size].filter(Boolean).join(" · ") || v.product_name || v.style_name || v.sku;
  return (
    <button
      type="button"
      onClick={() => onPick(v.sku)}
      className={`${GRID} w-full text-left px-3 py-1.5 text-[12px] hover:bg-[#fff8ee] border-t border-[#fce6cc]`}
      data-testid={`sts-variant-${v.sku}`}
    >
      <span />
      <span className="min-w-0 truncate flex items-center gap-1.5" style={{ paddingLeft: 48 }}>
        <Package size={12} className="shrink-0 text-muted" />
        <span className="font-medium">{v.sku}</span>
        {label ? <span className="text-muted truncate"> · {label}</span> : null}
        {v.barcode ? <span className="text-muted font-mono shrink-0"> · {v.barcode}</span> : null}
      </span>
      <MetricCells m={m} />
    </button>
  );
};

// ── style row (lazy → variants) ──
const StyleRow = ({ style, drillParams, mk, onPick }) => {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const m = mk(style.units_sold, style.current_stock);

  const load = useCallback(() => {
    setLoading(true);
    setErr("");
    api
      .get("/analytics/stock-to-sales-drill", {
        params: {
          level: "variant",
          category: style.category,
          subcategory: style.subcategory,
          style: style.val,
          ...drillParams,
        },
      })
      .then(({ data }) => setKids(data?.items || []))
      .catch(() => setErr("Couldn't load SKUs"))
      .finally(() => setLoading(false));
  }, [style.category, style.subcategory, style.val, drillParams]);

  const toggle = () => {
    const n = !open;
    setOpen(n);
    if (n && kids === null && !loading) load();
  };

  return (
    <div className="border-t border-[#fce6cc]">
      <button
        type="button"
        onClick={toggle}
        className={`${GRID} w-full text-left px-3 py-1.5 text-[12px] hover:bg-[#fff8ee]`}
        data-testid={`sts-style-${(style.val || "blank").toLowerCase().replace(/\s+/g, "-")}`}
      >
        <span className="text-[#1a5c38]">
          {open ? <Minus size={12} weight="bold" /> : <Plus size={12} weight="bold" />}
        </span>
        <span className="min-w-0 truncate" style={{ paddingLeft: 32 }}>
          {style.val || <span className="italic text-muted">Unnamed style</span>}
          <span className="ml-2 text-[10px] text-[#9ca3af]">{fmtNum(style.skus)} SKU{style.skus === 1 ? "" : "s"}</span>
        </span>
        <MetricCells m={m} />
      </button>
      {open ? (
        loading ? (
          <div className="px-3 py-2 text-[12px] text-muted" style={{ paddingLeft: 60 }}>Loading SKUs…</div>
        ) : err ? (
          <div className="px-3 py-2 text-[12px] text-red-700" style={{ paddingLeft: 60 }}>
            {err} · <button className="underline" onClick={load}>retry</button>
          </div>
        ) : kids && kids.length ? (
          kids.map((v) => <VariantRow key={v.sku} v={v} mk={mk} onPick={onPick} />)
        ) : (
          <div className="px-3 py-2 text-[12px] text-muted" style={{ paddingLeft: 60 }}>No SKUs</div>
        )
      ) : null}
    </div>
  );
};

// ── subcategory row (lazy → styles) ──
const SubcatRow = ({ sub, category, drillParams, mk, onPick }) => {
  const [open, setOpen] = useState(false);
  const [kids, setKids] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const m = {
    units_sold: sub.units_sold || 0,
    current_stock: sub.current_stock || 0,
    pct_sold: sub.pct_of_total_sold || 0,
    pct_stock: sub.pct_of_total_stock || 0,
    variance: sub.variance || 0,
  };

  const load = useCallback(() => {
    setLoading(true);
    setErr("");
    api
      .get("/analytics/stock-to-sales-drill", {
        params: {
          level: "style",
          category,
          subcategory: sub.subcategory,
          ...drillParams,
        },
      })
      .then(({ data }) =>
        setKids((data?.items || []).map((s) => ({ ...s, category, subcategory: sub.subcategory })))
      )
      .catch(() => setErr("Couldn't load styles"))
      .finally(() => setLoading(false));
  }, [category, sub.subcategory, drillParams]);

  const toggle = () => {
    const n = !open;
    setOpen(n);
    if (n && kids === null && !loading) load();
  };

  return (
    <div className="border-t border-[#fce6cc]">
      <button
        type="button"
        onClick={toggle}
        className={`${GRID} w-full text-left px-3 py-2 text-[12.5px] bg-white hover:bg-[#fff8ee]`}
        data-testid={`sts-subcat-${(sub.subcategory || "blank").toLowerCase().replace(/\s+/g, "-")}`}
      >
        <span className="text-[#1a5c38]">
          {open ? <Minus size={13} weight="bold" /> : <Plus size={13} weight="bold" />}
        </span>
        <span className="min-w-0 truncate text-[#0f3d24] font-medium" style={{ paddingLeft: 16 }}>
          {sub.subcategory || <span className="italic text-muted">Uncategorised</span>}
        </span>
        <MetricCells m={m} />
      </button>
      {open ? (
        loading ? (
          <div className="px-3 py-2 text-[12px] text-muted" style={{ paddingLeft: 44 }}>Loading styles…</div>
        ) : err ? (
          <div className="px-3 py-2 text-[12px] text-red-700" style={{ paddingLeft: 44 }}>
            {err} · <button className="underline" onClick={load}>retry</button>
          </div>
        ) : kids && kids.length ? (
          kids.map((s) => (
            <StyleRow key={s.val || "__blank__"} style={s} drillParams={drillParams} mk={mk} onPick={onPick} />
          ))
        ) : (
          <div className="px-3 py-2 text-[12px] text-muted" style={{ paddingLeft: 44 }}>No styles</div>
        )
      ) : null}
    </div>
  );
};

// ── category row (subcategories are client-side; styles/variants lazy) ──
const CategoryRow = ({ cat, subs, open, onToggle, drillParams, mk, onPick }) => {
  const m = {
    units_sold: cat.units_sold || 0,
    current_stock: cat.current_stock || 0,
    pct_sold: cat.pct_of_total_sold || 0,
    pct_stock: cat.pct_of_total_stock || 0,
    variance: cat.variance || 0,
  };
  const slug = (cat.category || "blank").toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="rounded-lg border border-[#fcd9b6] overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className={`${GRID} w-full text-left px-3 py-2.5 ${open ? "bg-[#fef3e0]" : "bg-[#fff8ee] hover:bg-[#fef3e0]"}`}
        data-testid={`sts-cat-${slug}`}
      >
        <span className="text-[#1a5c38]">
          {open ? <Minus size={14} weight="bold" /> : <Plus size={14} weight="bold" />}
        </span>
        <span className="min-w-0 truncate font-extrabold text-[13px] text-[#0f3d24]">
          {cat.category || <span className="italic text-muted">Uncategorised</span>}
          <span className="ml-2 text-[10px] font-semibold text-[#6b7280] uppercase tracking-wide">
            {subs.length} subcat{subs.length === 1 ? "" : "s"}
          </span>
        </span>
        <MetricCells m={m} />
      </button>
      {open ? (
        subs.length ? (
          <div className="bg-white">
            {subs.map((s) => (
              <SubcatRow
                key={s.subcategory || "__blank__"}
                sub={s}
                category={cat.category}
                drillParams={drillParams}
                mk={mk}
                onPick={onPick}
              />
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 text-[12px] text-muted bg-white" style={{ paddingLeft: 44 }}>
            No subcategories
          </div>
        )
      ) : null}
    </div>
  );
};

// ── top component ──
const StockToSalesDrillTable = ({
  catRows = [],
  subRows = [],
  categoryFor,
  drillParams,
  testId = "sts-drill",
}) => {
  const [openCats, setOpenCats] = useState(() => new Set());
  const [picked, setPicked] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState("");
  const exportRef = useRef(null);

  // search
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 250);
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // Grand totals (denominator for the style/variant % shares). The server's
  // category rows carry pct_i = units_i / GRAND * 100, so summing both sides
  // gives GRAND = Σunits / Σpct * 100 — a sum-ratio that cancels the per-row
  // 2dp rounding error far better than back-solving from a single row, and is
  // subset-invariant so the merch-filtered catRows still recover the true
  // all-category denominator the server used. Falls back to a plain sum if no
  // % shares are present.
  const { grandUnits, grandStock } = useMemo(() => {
    let sumU = 0, sumPu = 0, sumS = 0, sumPs = 0;
    for (const r of catRows) {
      if (r.pct_of_total_sold > 0 && r.units_sold > 0) {
        sumU += r.units_sold;
        sumPu += r.pct_of_total_sold;
      }
      if (r.pct_of_total_stock > 0 && r.current_stock > 0) {
        sumS += r.current_stock;
        sumPs += r.pct_of_total_stock;
      }
    }
    const gu = sumPu > 0 ? (sumU * 100) / sumPu : catRows.reduce((s, r) => s + (r.units_sold || 0), 0);
    const gs = sumPs > 0 ? (sumS * 100) / sumPs : catRows.reduce((s, r) => s + (r.current_stock || 0), 0);
    return { grandUnits: gu, grandStock: gs };
  }, [catRows]);

  // Build STS metric object for style/variant rows from raw units + stock.
  const mk = useCallback(
    (units, stock) => {
      const u = units || 0;
      const st = stock || 0;
      const ps = grandUnits > 0 ? (u * 100) / grandUnits : 0;
      const pst = grandStock > 0 ? (st * 100) / grandStock : 0;
      return { units_sold: u, current_stock: st, pct_sold: ps, pct_stock: pst, variance: ps - pst };
    },
    [grandUnits, grandStock]
  );

  // Subcategories grouped under their resolved category.
  const subsByCat = useMemo(() => {
    const m = new Map();
    for (const r of subRows) {
      const c = categoryFor(r.subcategory) || "";
      if (!m.has(c)) m.set(c, []);
      m.get(c).push(r);
    }
    for (const arr of m.values()) arr.sort((a, b) => (b.units_sold || 0) - (a.units_sold || 0));
    return m;
  }, [subRows, categoryFor]);

  const cats = useMemo(
    () => [...catRows].sort((a, b) => (b.units_sold || 0) - (a.units_sold || 0)),
    [catRows]
  );

  const toggleCat = (c) =>
    setOpenCats((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  const expandAll = () => setOpenCats(new Set(cats.map((c) => c.category)));
  const collapseAll = () => setOpenCats(new Set());

  // search effect — uses the same date window so figures reconcile.
  useEffect(() => {
    const term = debounced.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    setSearching(true);
    api
      .get("/product-search", { params: { q: term, ...drillParams } })
      .then(({ data }) => alive && setResults(data?.options || []))
      .catch(() => alive && setResults([]))
      .finally(() => alive && setSearching(false));
    return () => {
      alive = false;
    };
  }, [debounced, drillParams]);

  useEffect(() => {
    const h = (e) => {
      if (exportRef.current && !exportRef.current.contains(e.target)) setExportOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // ── CSV exports ──
  const doExportCategory = () => {
    const cols = [
      { key: "category", label: "Category" },
      { key: "units_sold", label: "Units Sold" },
      { key: "current_stock", label: "Inventory" },
      { key: "pct_sales", label: "% of Total Sales" },
      { key: "pct_inv", label: "% of Total Inventory" },
      { key: "variance", label: "Variance %" },
      { key: "risk_flag", label: "Risk Flag" },
    ];
    const rows = cats.map((r) => ({
      category: r.category,
      units_sold: r.units_sold,
      current_stock: r.current_stock,
      pct_sales: r.pct_of_total_sold?.toFixed?.(2) ?? r.pct_of_total_sold,
      pct_inv: r.pct_of_total_stock?.toFixed?.(2) ?? r.pct_of_total_stock,
      variance: r.variance?.toFixed?.(2) ?? r.variance,
      risk_flag: varianceFlag(r.variance),
    }));
    exportCSV(rows, cols, "stock-to-sales-category-summary.csv");
  };

  const doExportSubcat = () => {
    const cols = [
      { key: "category", label: "Category" },
      { key: "subcategory", label: "Subcategory" },
      { key: "units_sold", label: "Units Sold" },
      { key: "current_stock", label: "Inventory" },
      { key: "pct_sales", label: "% of Total Sales" },
      { key: "pct_inv", label: "% of Total Inventory" },
      { key: "variance", label: "Variance %" },
      { key: "risk_flag", label: "Risk Flag" },
    ];
    const rows = subRows.map((r) => ({
      category: categoryFor(r.subcategory) || "",
      subcategory: r.subcategory,
      units_sold: r.units_sold,
      current_stock: r.current_stock,
      pct_sales: r.pct_of_total_sold?.toFixed?.(2) ?? r.pct_of_total_sold,
      pct_inv: r.pct_of_total_stock?.toFixed?.(2) ?? r.pct_of_total_stock,
      variance: r.variance?.toFixed?.(2) ?? r.variance,
      risk_flag: varianceFlag(r.variance),
    }));
    exportCSV(rows, cols, "stock-to-sales-subcategory-summary.csv");
  };

  const doExportProducts = async (actionOnly) => {
    setExporting(actionOnly ? "action" : "products");
    try {
      const { data } = await api.get("/analytics/stock-to-sales-export", {
        params: { grain: "product", ...drillParams },
      });
      let items = data?.items || [];
      const enriched = items.map((r) => {
        const m = mk(r.units_sold, r.current_stock);
        return {
          category: r.category,
          subcategory: r.subcategory,
          style_name: r.style_name,
          sku: r.sku,
          barcode: r.barcode,
          color: r.color,
          size: r.size,
          units_sold: r.units_sold,
          current_stock: r.current_stock,
          pct_sales: m.pct_sold.toFixed(3),
          pct_inv: m.pct_stock.toFixed(3),
          variance: m.variance.toFixed(3),
          action: actionReason(r.units_sold, r.current_stock),
        };
      });
      const rows = actionOnly ? enriched.filter((r) => r.action) : enriched;
      const cols = [
        { key: "category", label: "Category" },
        { key: "subcategory", label: "Subcategory" },
        { key: "style_name", label: "Style" },
        { key: "sku", label: "SKU" },
        { key: "barcode", label: "Barcode" },
        { key: "color", label: "Colour" },
        { key: "size", label: "Size" },
        { key: "units_sold", label: "Units Sold" },
        { key: "current_stock", label: "Inventory" },
        { key: "pct_sales", label: "% of Total Sales" },
        { key: "pct_inv", label: "% of Total Inventory" },
        { key: "variance", label: "Variance %" },
        { key: "action", label: "Action" },
      ];
      exportCSV(
        rows,
        cols,
        actionOnly ? "stock-to-sales-action-items.csv" : "stock-to-sales-all-products.csv"
      );
    } catch {
      // swallow — the button just re-enables
    } finally {
      setExporting("");
      setExportOpen(false);
    }
  };

  const EXPORTS = [
    { label: "Category summary", run: () => { doExportCategory(); setExportOpen(false); } },
    { label: "Sub-category summary", run: () => { doExportSubcat(); setExportOpen(false); } },
    { label: "All products — full stock mix", run: () => doExportProducts(false) },
    { label: "Action items only", run: () => doExportProducts(true) },
  ];

  const searchActive = debounced.trim().length >= 2;

  return (
    <div data-testid={testId}>
      {/* toolbar: search + expand/collapse + export dropdown */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[14rem] max-w-[28rem]">
          <MagnifyingGlass
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
          />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a product by style, SKU or barcode…"
            className="w-full border border-border rounded-md pl-9 pr-8 py-1.5 text-[12.5px] outline-none focus:border-brand"
            data-testid="sts-drill-search"
          />
          {q ? (
            <button
              type="button"
              onClick={() => { setQ(""); setResults([]); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-panel text-muted"
              title="Clear"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-[11px] ml-auto">
          <button onClick={expandAll} className="text-[#1a5c38] font-bold hover:underline" data-testid="sts-drill-expand-all">
            Expand all
          </button>
          <span className="text-[#d6c5a8]">·</span>
          <button onClick={collapseAll} className="text-[#1a5c38] font-bold hover:underline" data-testid="sts-drill-collapse-all">
            Collapse all
          </button>
          <div className="relative" ref={exportRef}>
            <button
              type="button"
              onClick={() => setExportOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 bg-[#fff8ee] border border-[#fcd9b6] rounded-md px-2.5 py-1 text-[#1a5c38] font-bold hover:bg-[#fef3e0]"
              data-testid="sts-drill-export-btn"
            >
              <Download size={12} weight="bold" />
              {exporting ? "Exporting…" : "Export CSV"}
              <CaretDown size={11} weight="bold" />
            </button>
            {exportOpen ? (
              <div
                className="absolute right-0 mt-1 w-56 z-30 card-white shadow-lg p-1"
                data-testid="sts-drill-export-menu"
              >
                {EXPORTS.map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={opt.run}
                    disabled={!!exporting}
                    className="w-full text-left px-3 py-2 rounded text-[12.5px] hover:bg-panel disabled:opacity-50"
                    data-testid={`sts-drill-export-${opt.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* header strip */}
      <div
        className={`${GRID} px-3 py-2 bg-[#fed7aa] text-[10.5px] uppercase tracking-wide text-[#6b7280] font-semibold rounded-md`}
        data-testid="sts-drill-header"
      >
        <span />
        <span className="text-left">Category › Subcategory › Style › SKU</span>
        <span className="text-right">Units Sold</span>
        <span className="text-right">Inventory</span>
        <span className="text-right">% of Total Sales</span>
        <span className="text-right">% of Total Inventory</span>
        <span className="text-right">Variance %</span>
        <span className="text-right">Risk Flag</span>
      </div>

      {/* search results pinned in-table */}
      {searchActive ? (
        <div className="mt-2 rounded-lg border border-[#1a5c38]/30 overflow-hidden" data-testid="sts-drill-search-results">
          <div className="px-3 py-2 bg-[#eaf3ee] text-[11px] font-semibold text-[#1a5c38] flex items-center justify-between">
            <span>Search results for “{debounced.trim()}”</span>
            <span className="text-[#6b7280] font-normal">
              {searching ? "Searching…" : `${results.length} match${results.length === 1 ? "" : "es"}`}
            </span>
          </div>
          {!searching && results.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-muted bg-white">No matching products</div>
          ) : (
            <div className="bg-white">
              {results.map((v) => (
                <VariantRow key={`s-${v.sku}`} v={v} mk={mk} onPick={setPicked} />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* drill rows */}
      <div className="space-y-2 mt-2">
        {cats.length === 0 ? (
          <div className="text-sm text-muted py-6 text-center">No data</div>
        ) : (
          cats.map((c) => (
            <CategoryRow
              key={c.category || "__blank__"}
              cat={c}
              subs={subsByCat.get(c.category) || []}
              open={openCats.has(c.category)}
              onToggle={() => toggleCat(c.category)}
              drillParams={drillParams}
              mk={mk}
              onPick={setPicked}
            />
          ))
        )}
      </div>

      {picked ? <ProductDetailModal sku={picked} onClose={() => setPicked(null)} /> : null}
    </div>
  );
};

export default StockToSalesDrillTable;
