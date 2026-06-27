import React, { useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { X, Truck, CheckCircle, Warning, ArrowRight } from "@phosphor-icons/react";

/**
 * Scan-OUT modal — Phase 3 (Flow & Proof). Replaces the blind Mark-As-Done.
 *
 * Dispatches a SKU off the donor store: re-validates live donor on-hand minus
 * active reservations server-side, and if a POS sale (or another transfer) took
 * the unit the backend returns 409 `donor_stock_unavailable` — surfaced here as
 * a distinct block (NOT a generic error) so the operator re-runs the suggestions.
 *
 * On success the move enters `in_transit` (owned by the hub — neither store's
 * SOR moves) and a manifest / consignment id is returned + shown so the picker
 * can label the carton. The at-calc snapshot (net-CCC, value, gaps) is captured
 * at THIS commit, not on every cached GET solve.
 */
export default function IBTScanOutModal({ row, onClose, onScannedOut }) {
  const suggested = row?.suggested_qty ?? row?.units_to_move ?? 0;
  const donorAvail = row?.from_available;
  const [qty, setQty] = useState(
    row?.actual_units_moved != null ? Number(row.actual_units_moved) : Number(suggested) || 0,
  );
  const [odooRef, setOdooRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [block, setBlock] = useState(null); // 409 donor_stock_unavailable detail
  const [done, setDone] = useState(null);    // { consignment_id, status }

  if (!row) return null;

  const fromStore = row.from_store;
  const toStore = row.to_store;
  const skuLine = [row.color, row.size, row.sku, row.barcode].filter(Boolean).join(" · ");
  const viaHub = row.via_hub !== false; // default true (hub routing) unless same-mall

  const submit = async (e) => {
    e.preventDefault();
    if (Number(qty) < 1) {
      setError("Dispatch quantity must be at least 1.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setBlock(null);
    try {
      const { data } = await api.post("/ibt/scan-out", {
        from_store: fromStore,
        from_country: row.from_country || null,
        to_store: toStore,
        to_country: row.to_country || null,
        style_name: row.style_name,
        brand: row.brand || null,
        subcategory: row.subcategory || null,
        sku: row.sku,
        color: row.color || null,
        size: row.size || null,
        barcode: row.barcode || null,
        qty: Number(qty),
        via_hub: viaHub,
        route: row.route || null,
        run_id: row.run_id || null,
        source_onhand_at_calc: row.from_available ?? null,
        dest_gap_at_calc: row.dest_gap_at_calc ?? null,
        net_ccc_days: row.net_ccc_days ?? null,
        value_kes: row.value_kes ?? null,
        curve_complete: !!row.curve_complete,
        odoo_transfer_id: odooRef.trim() || null,
      });
      setDone({ consignment_id: data?.consignment_id, status: data?.status || "in_transit" });
    } catch (err) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail;
      if (status === 409 && detail && typeof detail === "object") {
        setBlock(detail);
      } else {
        setError(
          (typeof detail === "string" && detail) ||
          err.message ||
          "Scan-out failed — try again.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      data-testid="ibt-scan-out-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="size-9 rounded-full bg-brand/10 text-brand grid place-items-center">
            <Truck size={20} weight="fill" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-extrabold text-[15px] text-[#0f3d24]">Scan out — dispatch transfer</h2>
            <p className="text-[12px] text-muted mt-0.5 break-words">
              <span className="font-semibold">{row.style_name}</span> · {fromStore}{" "}
              <ArrowRight size={11} weight="bold" className="inline align-middle text-brand" />{" "}
              <span className="text-brand font-semibold">{toStore}</span>
            </p>
            {skuLine && (
              <p className="text-[11px] text-brand-deep mt-0.5 font-mono break-words" data-testid="ibt-scan-out-sku-line">
                {skuLine}
              </p>
            )}
            <p className="text-[10.5px] text-muted mt-1">
              {viaHub ? (
                <span title={row.route || "Routed donor → hub warehouse → destination"}>
                  Routes via hub{row.route ? ` · ${row.route}` : ""}
                </span>
              ) : (
                <span title={row.route || "Direct same-mall transfer"}>
                  Same-mall direct{row.route ? ` · ${row.route}` : ""}
                </span>
              )}
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded" data-testid="ibt-scan-out-close">
            <X size={16} />
          </button>
        </div>

        {done ? (
          <div className="space-y-4" data-testid="ibt-scan-out-success">
            <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3">
              <CheckCircle size={22} weight="fill" className="text-emerald-600 mt-0.5" />
              <div className="min-w-0">
                <div className="font-bold text-[13px] text-emerald-900">In transit</div>
                <div className="text-[12px] text-emerald-800 mt-0.5">
                  Manifest / consignment id — label the carton with this so the
                  destination can scan it in.
                </div>
                <div className="mt-2 inline-flex items-center font-mono text-[14px] font-bold bg-white border border-emerald-300 text-emerald-900 px-3 py-1.5 rounded-md" data-testid="ibt-scan-out-consignment">
                  {done.consignment_id}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => onScannedOut?.(done)}
                className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-4 py-2 rounded-md"
                data-testid="ibt-scan-out-done"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {block && (
              <div className="flex items-start gap-2.5 text-[12px] text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2.5" data-testid="ibt-scan-out-block">
                <Warning size={18} weight="fill" className="text-rose-500 mt-0.5 shrink-0" />
                <div>
                  <div className="font-bold">Stock no longer available</div>
                  <div className="mt-0.5">{block.message}</div>
                  <div className="mt-1 text-[11px] text-rose-700">
                    Live available: <b>{fmtNum(block.available ?? 0)}</b>
                    {block.reserved ? <> · reserved: <b>{fmtNum(block.reserved)}</b></> : null}
                    {" "}· requested: <b>{fmtNum(block.requested ?? qty)}</b>
                  </div>
                </div>
              </div>
            )}

            <div>
              <label className="eyebrow block mb-1">Units to dispatch</label>
              <input
                type="number"
                min={1}
                max={donorAvail != null ? donorAvail : 9999}
                value={qty}
                onChange={(e) => setQty(Number(e.target.value) || 0)}
                className="input-pill w-full"
                data-testid="ibt-scan-out-qty"
                required
              />
              <div className="text-[10.5px] text-muted mt-0.5">
                Suggested: {fmtNum(suggested)}
                {donorAvail != null ? <> · donor on-hand: {fmtNum(donorAvail)}</> : null}
              </div>
            </div>

            <div>
              <label className="eyebrow block mb-1">Odoo transfer ref <span className="text-muted font-normal">(optional)</span></label>
              <input
                value={odooRef}
                onChange={(e) => setOdooRef(e.target.value)}
                placeholder="e.g. WH/OUT/01234 — can be added at scan-in"
                className="input-pill w-full"
                data-testid="ibt-scan-out-odoo"
              />
              <div className="text-[10.5px] text-muted mt-0.5">
                The internal transfer document this picks against. Reconciled
                nightly against Odoo.
              </div>
            </div>

            {error && (
              <div className="text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="text-[12px] font-semibold text-muted hover:text-foreground px-3 py-2"
                data-testid="ibt-scan-out-cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-4 py-2 rounded-md disabled:opacity-50"
                data-testid="ibt-scan-out-submit"
              >
                <Truck size={14} weight="bold" />
                {submitting ? "Dispatching…" : "Scan out"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
