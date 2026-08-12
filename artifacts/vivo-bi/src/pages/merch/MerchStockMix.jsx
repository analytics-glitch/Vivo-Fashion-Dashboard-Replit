/**
 * Stock Mix drill-down — Inventory & Stock Health tab (Merchandising Hub).
 *
 * Brings the fabric Stock Mix pattern to finished goods: one expandable table
 * Category → Sub Category → Style → Colour, showing how stock is distributed
 * vs how sales are distributed. Shares are measured against the GRAND total
 * at every level (a sub-category's % is its share of ALL stock), and
 * Gap (pp) = % of Stock − % of Sales — positive = overstocked (house
 * convention shared with the fabric page).
 *
 * API contract (/api/merch/stock-mix):
 *   { categories: [{ name, stock_units, stock_value, units_period, woc,
 *       subcategories: [{ ..., styles: [{ ..., style_number,
 *         colours: [{ ..., skus_in_stock, skus_sold }] }] }] }],
 *     totals: { stock_units, stock_value, units_period },
 *     period: { from, to } }
 *
 * % of Stock / % of Sales / Gap are derived here from `totals` (same as the
 * fabric page derives shares client-side), so rows and totals always agree.
 */
import React, { useMemo, useState } from "react";
import { ChevronRight, Search, X } from "lucide-react";
import { ErrorBox } from "@/components/common";
import { C, fmtNum, fmtKESM, wocColor } from "./MerchHelpers";

const SEP = "\u0001";
const CHILD_KEYS = ["subcategories", "styles", "colours", null];
const LEVEL_LABEL = ["Category", "Sub Category", "Style", "Colour"];
const MAX_ROWS = 600;

const FX = {
  stock:    "Stock Units = current stock on hand (stores + sellable warehouse; pipeline excluded) — same basis as the Total Stock Units KPI.",
  value:    "Stock Value = stock units × unit cost (KES, at cost).",
  sold:     "Units Sold = gross units sold in the selected period (returns not netted).",
  pctStock: "% of Stock = this row's stock ÷ TOTAL stock across all categories. Every level is measured against the grand total.",
  pctSales: "% of Sales = this row's period units ÷ TOTAL period units across all categories.",
  gap:      "Gap (pp) = % of Stock − % of Sales (percentage points). Positive = overstocked (holds a larger share of stock than of sales); negative = under-stocked vs demand.",
  woc:      "Weeks of Cover = stock ÷ weekly run-rate (trailing 6 months ÷ 26) — independent of the selected period, matching the tab's WOC.",
  skus:     "SKUs (stock / sold) = distinct SKUs (sizes) of this colour with stock on hand / sold in the period.",
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

const LEVEL_ROW_CLS = [
  "bg-slate-50/80 font-semibold text-slate-800",
  "font-medium text-slate-700",
  "text-slate-600",
  "text-slate-500",
];

export default function MerchStockMix({ data, loading, error }) {
  const [open, setOpen] = useState({});
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const cats   = data?.categories || [];
  const totals = data?.totals || {};
  const totSu  = Number(totals.stock_units) || 0;
  const totUp  = Number(totals.units_period) || 0;

  // Flatten the tree into visible rows. In search mode a node is visible when
  // its own name matches, an ancestor matches, or a descendant matches — and
  // the ancestry of every match auto-expands (fabric-page behaviour).
  const rows = useMemo(() => {
    const out = [];
    const walk = (node, level, path, ancestorMatch) => {
      const ck = CHILD_KEYS[level];
      const kids = ck ? node[ck] || [] : [];
      const selfMatch = q !== "" && String(node.name).toLowerCase().includes(q);
      const childRows = [];
      let descMatch = false;
      for (const k of kids) {
        const r = walk(k, level + 1, path + SEP + k.name, ancestorMatch || selfMatch);
        if (r.rowList.length) childRows.push(...r.rowList);
        descMatch = descMatch || r.branchMatch;
      }
      const visible = !q || selfMatch || ancestorMatch || descMatch;
      const expanded = q
        ? (descMatch || (!!open[path] && (selfMatch || ancestorMatch)))
        : !!open[path];
      const rowList = [];
      if (visible) {
        rowList.push({ node, level, path, expandable: kids.length > 0, expanded, hit: selfMatch });
        if (expanded) rowList.push(...childRows);
      }
      return { rowList, branchMatch: selfMatch || descMatch };
    };
    for (const c of cats) out.push(...walk(c, 0, c.name, false).rowList);
    return out;
  }, [cats, q, open]);

  const truncated = rows.length > MAX_ROWS;
  const shown = truncated ? rows.slice(0, MAX_ROWS) : rows;
  // Colour-only column stays hidden until colour rows are actually on screen
  // (a style drilled open, or a search surfacing colours) — fabric behaviour.
  const showSkus = shown.some((r) => r.level === 3);
  const nCols = 8 + (showSkus ? 1 : 0);

  const toggle = (path) => setOpen((o) => ({ ...o, [path]: !o[path] }));

  const pctOf = (v, tot) => (tot > 0 ? (Number(v) / tot) * 100 : 0);

  return (
    <div className="bg-white rounded-xl shadow-sm p-4 sm:p-5" data-testid="merch-stock-mix">
      <div className="flex items-start justify-between flex-wrap gap-2 mb-3">
        <div>
          <div className="text-[12px] font-semibold text-slate-500">
            Stock Mix — where stock sits vs where sales happen
          </div>
          <div className="text-[10px] text-slate-400 mt-0.5">
            Shares vs grand total at every level · click a row to drill Category → Sub Category → Style → Colour
            {data?.period ? ` · units sold ${data.period.from} → ${data.period.to}` : ""}
          </div>
        </div>
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
          <table className="w-full min-w-[860px] text-[11.5px] border-collapse">
            <thead className="sticky top-0 z-10 bg-white shadow-[0_1px_0_#e2e8f0]">
              <tr className="text-[10px] uppercase tracking-wide text-slate-400">
                <th className="text-left font-semibold px-2 py-2">
                  Category / Sub / Style / Colour
                </th>
                <th className="text-right font-semibold px-2 py-2" title={FX.stock}>Stock Units</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.value}>Stock Value</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.sold}>Units Sold</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.pctStock}>% of Stock</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.pctSales}>% of Sales</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.gap}>Gap (pp)</th>
                <th className="text-right font-semibold px-2 py-2" title={FX.woc}>WOC</th>
                {showSkus && (
                  <th className="text-right font-semibold px-2 py-2" title={FX.skus}>SKUs</th>
                )}
              </tr>
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
                const pctS = pctOf(n.stock_units, totSu);
                const pctU = pctOf(n.units_period, totUp);
                const gap = pctS - pctU;
                return (
                  <tr
                    key={r.path}
                    data-testid={`mix-row-l${r.level}`}
                    onClick={r.expandable ? () => toggle(r.path) : undefined}
                    className={`border-t border-slate-100 ${LEVEL_ROW_CLS[r.level]} ${
                      r.expandable ? "cursor-pointer hover:bg-slate-50" : ""
                    }`}
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
                        <span className={`break-words ${r.hit ? "bg-yellow-100 rounded px-0.5" : ""}`}>
                          {n.name}
                        </span>
                        {r.level === 2 && n.style_number ? (
                          <span className="text-[9.5px] text-slate-400 shrink-0">{n.style_number}</span>
                        ) : null}
                        {r.level === 0 ? (
                          <span className="text-[9.5px] text-slate-400 font-normal shrink-0">
                            · {LEVEL_LABEL[0]}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="text-right px-2 py-1.5 tabular-nums">{fmtNum(n.stock_units)}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums">{fmtKESM(n.stock_value)}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums">{fmtNum(n.units_period)}</td>
                    <td className="text-right px-2 py-1.5 tabular-nums">{pctS.toFixed(1)}%</td>
                    <td className="text-right px-2 py-1.5 tabular-nums">{pctU.toFixed(1)}%</td>
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
                    {showSkus && (
                      <td className="text-right px-2 py-1.5 tabular-nums text-slate-400">
                        {r.level === 3 ? `${fmtNum(n.skus_in_stock)} / ${fmtNum(n.skus_sold)}` : ""}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            {shown.length > 0 && (
              <tfoot className="sticky bottom-0 z-10">
                <tr
                  className="bg-slate-50 font-bold text-slate-800 border-t-2 border-slate-200 shadow-[0_-1px_0_#e2e8f0]"
                  data-testid="mix-total-row"
                >
                  <td className="px-2 py-2">Total</td>
                  <td className="text-right px-2 py-2 tabular-nums" data-testid="mix-total-stock">
                    {fmtNum(totals.stock_units)}
                  </td>
                  <td className="text-right px-2 py-2 tabular-nums">{fmtKESM(totals.stock_value)}</td>
                  <td className="text-right px-2 py-2 tabular-nums">{fmtNum(totals.units_period)}</td>
                  <td className="text-right px-2 py-2 tabular-nums">100.0%</td>
                  <td className="text-right px-2 py-2 tabular-nums">100.0%</td>
                  <td className="text-right px-2 py-2 text-slate-300 font-normal" title="Gap nets to 0 across all categories.">—</td>
                  <td className="text-right px-2 py-2 text-slate-300 font-normal" title="Cover is a ratio — no meaningful grand total.">—</td>
                  {showSkus && <td className="px-2 py-2" />}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {truncated && (
        <div className="text-[10px] text-slate-400 mt-2">
          Showing the first {MAX_ROWS} rows — refine the search to narrow the tree.
        </div>
      )}
    </div>
  );
}
