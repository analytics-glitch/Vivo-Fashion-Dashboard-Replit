import React, { useMemo, useState } from "react";
import { fmtNum } from "@/lib/api";
import { Empty } from "@/components/common";
import { ArrowRight, Truck, Lock, Package } from "@phosphor-icons/react";

/**
 * Flat IBT transfer table (one row per SKU move).
 *
 * Redesign (Aug 2026): the old bundle-first layout (expandable from→to rows
 * with a nested SKU pick list) is replaced by a single flat table — every
 * suggested SKU move is one row with From / To / Style / Color / Size / SKU /
 * Barcode / sold + inventory context / Suggested qty (highlighted).
 * Removed columns per ops request: Bin, Net days, Curve, Value (KES), Score.
 * A "Quantity to receive (total)" chip above the table sums the visible
 * suggested units.
 *
 * Props:
 *   bundles          : array of bundles from /analytics/ibt-suggestions
 *   markdownCandidates : donor styles partially forked to the markdown list
 *   onScanOut        : (skuPayload) => void  — opens the scan-out modal
 *   runId            : engine run id (echoed into the scan-out payload)
 *   stale            : sync-behind-SLA lock (disables dispatch)
 *   odooDrafts       : { "from||to||sku": {name, id, state} } — Odoo draft refs
 *   completedSkuKeys : Set of `${style}||${to_store}||${sku}` already actioned
 *   completedKeys    : Set of legacy `${style}||${to_store}||__all__` keys
 */
export default function IBTBundleTable({
  bundles = [],
  markdownCandidates = [],
  onScanOut,
  onCreateDrafts,
  draftingKey = null,
  runId,
  stale = false,
  odooDrafts = {},
  completedSkuKeys = new Set(),
  completedKeys = new Set(),
  testId = "ibt-bundle-table",
  emptyLabel = "No transfer opportunities for the current window.",
}) {
  // Donor (store, style) pairs whose slow sizes were forked to the markdown list.
  const markdownDonors = useMemo(() => {
    const s = new Set();
    (markdownCandidates || []).forEach((m) =>
      m.from_store && m.style_name && s.add(`${m.from_store}||${m.style_name}`));
    return s;
  }, [markdownCandidates]);
  const [actuals, setActuals] = useState({}); // skuRowKey → number string
  const setActual = (k, v) => setActuals((prev) => ({ ...prev, [k]: v }));

  // Flatten bundles → one row per SKU; drop already-actioned SKUs.
  const rows = useMemo(() => {
    const out = [];
    for (const b of bundles) {
      for (const s of b.skus || []) {
        if (completedSkuKeys.has(`${s.style_name}||${b.to_store}||${s.sku}`)) continue;
        if (completedKeys.has(`${s.style_name}||${b.to_store}||__all__`)) continue;
        out.push({ b, s });
      }
    }
    return out;
  }, [bundles, completedSkuKeys, completedKeys]);

  const totalToReceive = useMemo(
    () => rows.reduce((n, { s }) => n + (s.suggested_qty || 0), 0),
    [rows],
  );

  // All visible lines for a From→To corridor → ONE Odoo draft. Uses the typed
  // "Actual transferred" override when present (partial transfers), else the
  // suggested qty.
  const corridorLines = (b) =>
    rows
      .filter(({ b: rb }) => rb.from_store === b.from_store && rb.to_store === b.to_store)
      .map(({ b: rb, s: rs }) => {
        const a = actuals[`${rb.from_store}||${rb.to_store}||${rs.sku}`];
        let qty;
        if (a === undefined || a === "") qty = rs.suggested_qty || 0;
        else {
          const n = parseInt(a, 10);
          qty = Number.isFinite(n) && n > 0 ? n : 0; // invalid/negative → excluded
        }
        return { sku: rs.sku, qty };
      })
      .filter((l) => l.qty > 0);

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
      odoo_transfer_id: odooDrafts[rowKey]?.name || undefined,
      odoo_picking_id: odooDrafts[rowKey]?.id || undefined,
      flow: "store_to_store",
    });
  };

  const exportCSV = () => {
    const header = [
      "From Store", "To Store", "Style", "Brand", "Subcategory",
      "Color", "Size", "SKU", "Barcode",
      "From: Qty Sold (28d)", "To: Qty Sold (28d)",
      "Inv. Qty FROM", "Inv. Qty TO", "Suggested Qty", "Odoo Draft",
    ];
    const out = [header];
    for (const { b, s } of rows) {
      const rowKey = `${b.from_store}||${b.to_store}||${s.sku}`;
      out.push([
        b.from_store, b.to_store,
        s.style_name, s.brand || "", s.subcategory || "",
        s.color || "", s.size || "", s.sku || "", s.barcode || "",
        s.from_qty_sold_28d ?? "", s.to_qty_sold_28d ?? "",
        s.from_available ?? "", s.to_available ?? "", s.suggested_qty ?? "",
        odooDrafts[rowKey]?.name || "",
      ]);
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
    link.download = `ibt-transfers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  };

  if (!bundles.length) return <Empty label={emptyLabel} />;
  if (!rows.length) {
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className="inline-flex items-center gap-2 text-[13px] font-bold px-3 py-2 rounded-md bg-emerald-50 text-emerald-900 border border-emerald-200"
          data-testid={`${testId}-total-to-receive`}
        >
          <Package size={16} weight="bold" />
          Quantity to receive (total): {fmtNum(totalToReceive)} units · {fmtNum(rows.length)} SKU moves
        </span>
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
        <table className="w-full min-w-max text-[12px]">
          <thead className="bg-panel">
            <tr className="text-left">
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">From</th>
              <th className="px-2 py-2.5"></th>
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">To</th>
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Style</th>
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Color</th>
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Size</th>
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">SKU</th>
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Barcode</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap" title="Units sold at the FROM store in the last 28 days">From sold 28d</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap" title="Units sold at the TO store in the last 28 days">To sold 28d</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap" title="Shop-floor inventory at the FROM store">Inv FROM</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap" title="Shop-floor inventory at the TO store">Inv TO</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap">Suggested</th>
              <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap">Actual transferred</th>
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap" title="Odoo internal-transfer draft reference">Odoo draft</th>
              <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ b, s }, idx) => {
              const rowKey = `${b.from_store}||${b.to_store}||${s.sku}`;
              const draft = odooDrafts[rowKey];
              return (
                <tr
                  key={rowKey}
                  className={`border-t border-border/40 hover:bg-amber-50/30 ${idx % 2 === 0 ? "bg-white" : "bg-panel/30"}`}
                  data-testid={`${testId}-sku-${s.sku}`}
                >
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <StorePill name={b.from_store} cluster={b.from_cluster} />
                  </td>
                  <td className="px-2 py-2.5 text-brand"><ArrowRight size={13} weight="bold" /></td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-brand">
                    <StorePill name={b.to_store} cluster={b.to_cluster} />
                  </td>
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
                  <td className="px-3 py-2.5 text-right tabular-nums">{s.from_qty_sold_28d == null ? "—" : fmtNum(s.from_qty_sold_28d)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-[#0f3d24]">{s.to_qty_sold_28d == null ? "—" : fmtNum(s.to_qty_sold_28d)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(s.from_available ?? 0)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(s.to_available ?? 0)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <span
                      className="inline-flex items-center justify-center min-w-[2rem] px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-900 border border-emerald-300 font-bold tabular-nums"
                      data-testid={`${testId}-suggested-${s.sku}`}
                    >
                      {fmtNum(s.suggested_qty ?? 0)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <input
                      type="number"
                      min={0}
                      max={s.from_available ?? 9999}
                      value={actuals[rowKey] ?? ""}
                      placeholder={String(s.suggested_qty ?? 0)}
                      onChange={(e) => setActual(rowKey, e.target.value)}
                      className="input-pill w-20 text-right"
                      data-testid={`${testId}-actual-${s.sku}`}
                    />
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-[11px]" data-testid={`${testId}-draft-${s.sku}`}>
                    {draft?.name ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-mono font-semibold text-[#1a5c38]">{draft.name}</span>
                        <button
                          type="button"
                          disabled={!!draftingKey || corridorLines(b).length === 0}
                          onClick={() => {
                            const lines = corridorLines(b);
                            if (lines.length) onCreateDrafts?.({ from_store: b.from_store, to_store: b.to_store, lines });
                          }}
                          title="Recreate this store-to-store draft in Odoo with the current quantities (Actual if typed, else Suggested). The old draft is cancelled if still in draft."
                          className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-border text-muted hover:text-brand hover:border-brand/40 disabled:opacity-50"
                          data-testid={`${testId}-redo-draft-${s.sku}`}
                        >
                          ↻
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={!!draftingKey || corridorLines(b).length === 0}
                        onClick={() => {
                          const lines = corridorLines(b);
                          if (lines.length) onCreateDrafts?.({ from_store: b.from_store, to_store: b.to_store, lines });
                        }}
                        title={corridorLines(b).length === 0
                          ? "All quantities for this corridor are 0 — type a quantity to include in the draft"
                          : `Creates ONE draft internal transfer in Odoo covering all ${b.from_store} → ${b.to_store} lines. Type a lower number in "Actual transferred" first to send fewer than suggested.`}
                        className="text-[11px] font-semibold px-2 py-1 rounded-md border border-brand/40 text-brand hover:bg-brand/5 disabled:opacity-50"
                        data-testid={`${testId}-create-draft-${s.sku}`}
                      >
                        {draftingKey === `${b.from_store}||${b.to_store}`
                          ? "Creating…"
                          : `Create 1 draft (${corridorLines(b).length} lines)`}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => { if (!stale) handleScanOut(b, s); }}
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
    </div>
  );
}
