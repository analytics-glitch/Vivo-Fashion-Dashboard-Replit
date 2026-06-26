import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { api, fmtNum, fmtPct } from "@/lib/api";
import { exportCSV } from "@/components/SortableTable";
import { VarianceCell, varianceFlag } from "@/lib/variance";
import {
  Plus,
  Minus,
  Download,
  CaretDown,
} from "@phosphor-icons/react";

// Shared grid template — header and every row use it so all columns line up
// vertically across both drill levels (Category, Subcategory).
const GRID =
  "grid grid-cols-[26px_minmax(0,2.3fr)_0.9fr_0.9fr_0.9fr_0.9fr_1fr_1.1fr] gap-2 items-center";

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

// ── subcategory row (leaf — no further drill) ──
const SubcatRow = ({ sub }) => {
  const m = {
    units_sold: sub.units_sold || 0,
    current_stock: sub.current_stock || 0,
    pct_sold: sub.pct_of_total_sold || 0,
    pct_stock: sub.pct_of_total_stock || 0,
    variance: sub.variance || 0,
  };

  return (
    <div
      className={`${GRID} px-3 py-2 text-[12.5px] bg-white border-t border-[#fce6cc]`}
      data-testid={`sts-subcat-${(sub.subcategory || "blank").toLowerCase().replace(/\s+/g, "-")}`}
    >
      <span />
      <span className="min-w-0 truncate text-[#0f3d24] font-medium" style={{ paddingLeft: 16 }}>
        {sub.subcategory || <span className="italic text-muted">Uncategorised</span>}
      </span>
      <MetricCells m={m} />
    </div>
  );
};

// ── category row (subcategories are client-side leaves) ──
const CategoryRow = ({ cat, subs, open, onToggle }) => {
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
              <SubcatRow key={s.subcategory || "__blank__"} sub={s} />
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
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState("");
  const exportRef = useRef(null);

  // Grand totals (denominator for the product-grain % shares used in exports).
  // The server's
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

  return (
    <div data-testid={testId}>
      {/* toolbar: expand/collapse + export dropdown */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
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
        <span className="text-left">Category › Subcategory</span>
        <span className="text-right">Units Sold</span>
        <span className="text-right">Inventory</span>
        <span className="text-right">% of Total Sales</span>
        <span className="text-right">% of Total Inventory</span>
        <span className="text-right">Variance %</span>
        <span className="text-right">Risk Flag</span>
      </div>

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
            />
          ))
        )}
      </div>
    </div>
  );
};

export default StockToSalesDrillTable;
