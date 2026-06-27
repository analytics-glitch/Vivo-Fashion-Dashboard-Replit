import React, { useMemo, useState } from "react";
import { fmtNum } from "@/lib/api";
import { Empty } from "@/components/common";
import {
  ArrowRight, CaretRight, CaretDown, MagnifyingGlass, Truck, Lock,
} from "@phosphor-icons/react";

/**
 * Bundle-first IBT table.
 *
 * Phase-1 redesign: the global solve already returns each from→to corridor as
 * ONE bundle with its embedded SKU pick list (`bundle.skus[]`). There is NO
 * per-row client fan-out to `/analytics/ibt-sku-breakdown` (the old D6 bug) —
 * every pick column (color / size / barcode / bin / on-hand both sides /
 * suggested qty) is already present, so the list renders instantly.
 *
 * Each top-level row is a from→to bundle (units, sku/style counts, score,
 * corridor badge). Expanding a bundle reveals its SKU pick list with a
 * per-SKU "actual transferred" input and a Mark-as-Done pill that opens the
 * existing modal pre-filled with that SKU's detail.
 *
 * Props:
 *   bundles          : array of bundles from /analytics/ibt-suggestions
 *   onMarkDone       : (skuPayload) => void  — opens the parent modal
 *   completedSkuKeys : Set of `${style}||${to_store}||${sku}` already actioned
 *   completedKeys    : Set of legacy `${style}||${to_store}||__all__` keys
 *   testId           : root testid (default "ibt-bundle-table")
 *   emptyLabel       : string when no bundles
 */
export default function IBTBundleTable({
  bundles = [],
  markdownCandidates = [],
  onScanOut,
  runId,
  stale = false,
  completedSkuKeys = new Set(),
  completedKeys = new Set(),
  testId = "ibt-bundle-table",
  emptyLabel = "No transfer opportunities for the current window.",
}) {
  // Donor (store, style) pairs whose slow sizes were forked to the markdown list
  // (some sizes of the same style at the same store don't pay to ship). Used to
  // flag those bundle rows inline so the operator sees "also markdown" stock.
  const markdownDonors = useMemo(() => {
    const s = new Set();
    (markdownCandidates || []).forEach((m) =>
      m.from_store && m.style_name && s.add(`${m.from_store}||${m.style_name}`));
    return s;
  }, [markdownCandidates]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [actuals, setActuals] = useState({}); // skuRowKey → number string
  const setActual = (k, v) => setActuals((prev) => ({ ...prev, [k]: v }));

  const toggle = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Drop already-actioned SKUs; hide a bundle once every SKU is done.
  const liveBundles = useMemo(() => {
    const out = [];
    for (const b of bundles) {
      const skus = (b.skus || []).filter((s) => {
        if (completedSkuKeys.has(`${s.style_name}||${b.to_store}||${s.sku}`)) return false;
        if (completedKeys.has(`${s.style_name}||${b.to_store}||__all__`)) return false;
        return true;
      });
      if (skus.length === 0) continue;
      const units = skus.reduce((n, s) => n + (s.suggested_qty || 0), 0);
      out.push({
        ...b,
        skus,
        units,
        sku_count: skus.length,
        style_count: new Set(skus.map((s) => s.style_name)).size,
      });
    }
    return out;
  }, [bundles, completedSkuKeys, completedKeys]);

  const handleScanOut = (b, s) => {
    const rowKey = `${b.from_store}||${b.to_store}||${s.sku}`;
    const actual = actuals[rowKey];
    onScanOut?.({
      from_store: b.from_store,
      from_country: b.from_country,
      to_store: b.to_store,
      to_country: b.to_country,
      style_name: s.style_name,
      brand: s.brand,
      subcategory: s.subcategory,
      suggested_qty: s.suggested_qty,
      units_to_move: s.suggested_qty,
      actual_units_moved:
        actual !== undefined && actual !== "" ? Number(actual) : s.suggested_qty,
      sku: s.sku,
      color: s.color,
      size: s.size,
      barcode: s.barcode,
      from_available: s.from_available,
      // Phase-3 at-calc snapshot + hub routing — captured into the lifecycle
      // ledger at scan-out (commit), not on every cached GET solve.
      via_hub: b.via_hub,
      route: b.route,
      run_id: runId,
      net_ccc_days: s.net_ccc_days,
      value_kes: s.value_kes,
      curve_complete: s.curve_complete,
      source_onhand_at_calc: s.source_onhand_at_calc,
      dest_gap_at_calc: s.dest_gap_at_calc,
      flow: "store_to_store",
    });
  };

  const exportCSV = () => {
    const header = [
      "From Store", "To Store", "Corridor", "Style", "Brand", "Subcategory",
      "Color", "Size", "SKU", "Barcode", "Bin",
      "From: Qty Sold (28d)", "To: Qty Sold (28d)",
      "Inv. Qty FROM", "Inv. Qty TO", "Suggested Qty",
      "Net CCC Days", "Value (KES)", "Curve Complete",
    ];
    const out = [header];
    for (const b of liveBundles) {
      for (const s of b.skus) {
        out.push([
          b.from_store, b.to_store, b.corridor,
          s.style_name, s.brand || "", s.subcategory || "",
          s.color || "", s.size || "", s.sku || "", s.barcode || "", s.bin || "",
          s.from_qty_sold_28d ?? "", s.to_qty_sold_28d ?? "",
          s.from_available ?? "", s.to_available ?? "", s.suggested_qty ?? "",
          s.net_ccc_days ?? "", s.value_kes ?? "", s.curve_complete ? "Y" : "",
        ]);
      }
    }
    const csv = out
      .map((row) =>
        row
          .map((cell) => {
            const v = cell == null ? "" : String(cell);
            return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
          })
          .join(","),
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ibt-bundles-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  };

  if (!bundles.length) return <Empty label={emptyLabel} />;
  if (!liveBundles.length) {
    return <Empty label="All transfer moves have been actioned." />;
  }

  const StorePill = ({ name, cluster }) => (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-semibold">{name}</span>
      {cluster && (
        <span
          className="text-[9.5px] font-bold tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-300"
          title={`Revenue cluster ${cluster}`}
        >
          {cluster}
        </span>
      )}
    </span>
  );

  return (
    <div data-testid={testId} className="space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={exportCSV}
          className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-white bg-brand hover:bg-brand-deep px-3 py-2 rounded-md"
          data-testid={`${testId}-export`}
        >
          Export CSV
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-white" data-testid={`${testId}-scroll`}>
        <table className="w-full min-w-max text-[12.5px]">
          <thead className="bg-panel">
            <tr className="text-left">
              <th className="px-3 py-2.5 font-semibold w-8"></th>
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">From</th>
              <th className="px-2 py-2.5"></th>
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">To</th>
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Corridor</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap">Units</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap">SKUs</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap">Styles</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap" title="Net inventory-days removed: donor days-to-sell − destination days-to-sell − corridor transit, summed over the moved units">Net days</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap" title="Value redeployed: units × ASP, net of freight and (cross-border) duty">Value (KES)</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap" title="SKUs that fill an empty destination size (size-curve completion)">Curve</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap">Score</th>
            </tr>
          </thead>
          <tbody>
            {liveBundles.map((b, idx) => {
              const id = `${b.from_store}__${b.to_store}`;
              const open = expanded.has(id);
              return (
                <React.Fragment key={id}>
                  <tr
                    className={`border-t border-border/50 cursor-pointer ${open ? "bg-amber-50/50" : idx % 2 === 0 ? "bg-white" : "bg-panel/30"} hover:bg-amber-50/40`}
                    onClick={() => toggle(id)}
                    data-testid={`${testId}-row-${idx}`}
                  >
                    <td className="px-3 py-3 text-muted">
                      {open ? <CaretDown size={14} weight="bold" /> : <CaretRight size={14} weight="bold" />}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <StorePill name={b.from_store} cluster={b.from_cluster} />
                    </td>
                    <td className="px-2 py-3 text-brand"><ArrowRight size={14} weight="bold" /></td>
                    <td className="px-3 py-3 whitespace-nowrap text-brand">
                      <StorePill name={b.to_store} cluster={b.to_cluster} />
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            b.cross_border
                              ? "bg-amber-100 text-amber-900 border border-amber-300"
                              : "bg-emerald-50 text-emerald-800 border border-emerald-200"
                          }`}
                        >
                          {b.cross_border ? "Cross-border" : "Domestic"}
                        </span>
                        <span
                          className={`text-[9.5px] font-bold px-1.5 py-0.5 rounded-full ${
                            b.via_hub !== false
                              ? "bg-sky-50 text-sky-800 border border-sky-200"
                              : "bg-slate-100 text-slate-700 border border-slate-300"
                          }`}
                          title={b.route || (b.via_hub !== false ? "Routed donor → hub warehouse → destination (raises net-CCC honestly)" : "Same-mall direct transfer")}
                        >
                          {b.via_hub !== false ? "via hub" : "same-mall"}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-semibold">{fmtNum(b.units)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{fmtNum(b.sku_count)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{fmtNum(b.style_count)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{fmtNum(b.net_ccc_days ?? 0)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{fmtNum(b.value_kes ?? 0)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {b.curve_completions ? (
                        <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-100 text-violet-700" title="Size-curve completions in this bundle">
                          {fmtNum(b.curve_completions)}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{fmtNum(b.score)}</td>
                  </tr>

                  {open && (
                    <tr className="bg-white">
                      <td colSpan={12} className="px-0 py-0">
                        <div className="overflow-x-auto border-t border-border/40">
                          <table className="w-full min-w-max text-[12px]">
                            <thead className="bg-panel/60">
                              <tr className="text-left">
                                <th className="px-3 py-2 font-semibold whitespace-nowrap">Style</th>
                                <th className="px-3 py-2 font-semibold whitespace-nowrap">Color</th>
                                <th className="px-3 py-2 font-semibold whitespace-nowrap">Size</th>
                                <th className="px-3 py-2 font-semibold whitespace-nowrap">SKU</th>
                                <th className="px-3 py-2 font-semibold whitespace-nowrap">Barcode</th>
                                <th className="px-3 py-2 font-semibold whitespace-nowrap">Bin</th>
                                <th className="px-3 py-2 font-semibold text-right whitespace-nowrap" title="Units sold at the FROM store in the last 28 days">From sold 28d</th>
                                <th className="px-3 py-2 font-semibold text-right whitespace-nowrap" title="Units sold at the TO store in the last 28 days">To sold 28d</th>
                                <th className="px-3 py-2 font-semibold text-right whitespace-nowrap" title="Shop-floor inventory at the FROM store">Inv FROM</th>
                                <th className="px-3 py-2 font-semibold text-right whitespace-nowrap" title="Shop-floor inventory at the TO store">Inv TO</th>
                                <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Suggested</th>
                                <th className="px-3 py-2 font-semibold text-right whitespace-nowrap" title="Net inventory-days removed for this SKU">Net days</th>
                                <th className="px-3 py-2 font-semibold text-right whitespace-nowrap" title="Value redeployed (units × ASP, net of freight/duty)">Value (KES)</th>
                                <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Actual transferred</th>
                                <th className="px-3 py-2 font-semibold whitespace-nowrap">Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {b.skus.map((s) => {
                                const rowKey = `${b.from_store}||${b.to_store}||${s.sku}`;
                                return (
                                  <tr key={rowKey} className="border-t border-border/40 hover:bg-amber-50/30" data-testid={`${testId}-sku-${s.sku}`}>
                                    <td className="px-3 py-2.5 whitespace-nowrap">
                                      <div className="font-semibold inline-flex items-center gap-1.5">
                                        {s.style_name}
                                        {s.curve_complete && (
                                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700" title="Fills an empty destination size (size-curve completion)">
                                            curve
                                          </span>
                                        )}
                                        {markdownDonors.has(`${b.from_store}||${s.style_name}`) && (
                                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700" title="Other sizes of this style at this store don't pay to ship — see the Markdown instead list">
                                            also markdown
                                          </span>
                                        )}
                                      </div>
                                      <div className="text-[10px] text-muted">{s.brand} · {s.subcategory}</div>
                                    </td>
                                    <td className="px-3 py-2.5 whitespace-nowrap">{s.color || "—"}</td>
                                    <td className="px-3 py-2.5 whitespace-nowrap">{s.size || "—"}</td>
                                    <td className="px-3 py-2.5 whitespace-nowrap font-mono text-[11px]">{s.sku || "—"}</td>
                                    <td className="px-3 py-2.5 whitespace-nowrap font-mono text-[11px]">{s.barcode || "—"}</td>
                                    <td className="px-3 py-2.5 whitespace-nowrap">{s.bin || "—"}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums">{s.from_qty_sold_28d == null ? "—" : fmtNum(s.from_qty_sold_28d)}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-[#0f3d24]">{s.to_qty_sold_28d == null ? "—" : fmtNum(s.to_qty_sold_28d)}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(s.from_available ?? 0)}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(s.to_available ?? 0)}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{fmtNum(s.suggested_qty ?? 0)}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(s.net_ccc_days ?? 0)}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(s.value_kes ?? 0)}</td>
                                    <td className="px-3 py-2.5 text-right">
                                      <input
                                        type="number"
                                        min={0}
                                        max={s.from_available ?? 9999}
                                        value={actuals[rowKey] ?? ""}
                                        placeholder={String(s.suggested_qty ?? 0)}
                                        onChange={(e) => setActual(rowKey, e.target.value)}
                                        onClick={(e) => e.stopPropagation()}
                                        className="input-pill w-20 text-right"
                                        data-testid={`${testId}-actual-${s.sku}`}
                                      />
                                    </td>
                                    <td className="px-3 py-2.5 whitespace-nowrap">
                                      <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); if (!stale) handleScanOut(b, s); }}
                                        disabled={stale}
                                        title={stale ? "Sales sync is stale — dispatch is locked until figures refresh" : "Scan this SKU out of the donor store"}
                                        className={`inline-flex items-center gap-1 text-[11.5px] font-semibold px-2.5 py-1.5 rounded-md ${
                                          stale
                                            ? "bg-gray-100 text-muted cursor-not-allowed"
                                            : "text-white bg-[#1a5c38] hover:bg-[#0f3d24]"
                                        }`}
                                        data-testid={`${testId}-scan-out-${s.sku}`}
                                      >
                                        {stale ? <Lock size={13} weight="bold" /> : <Truck size={13} weight="bold" />}
                                        Scan out
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
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
}
