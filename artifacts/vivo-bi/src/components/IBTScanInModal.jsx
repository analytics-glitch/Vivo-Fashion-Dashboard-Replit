import React, { useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { X, Package, CheckCircle, Warning, ArrowRight } from "@phosphor-icons/react";

/**
 * Scan-IN modal — Phase 3 (Flow & Proof). The hard receiving gate.
 *
 * Scans a consignment in at the destination: records the realised received_qty
 * against the dispatched qty. If they match the move is `received`; any shortfall
 * branches to `discrepancy` (still closed, but flagged for follow-up + excluded
 * from the realisation that calibrates the forward projection). A live preview
 * shows the operator the discrepancy before they commit. Scan-in also mirrors
 * into ibt_completions so late-count / outcomes / roi keep working unchanged.
 */
export default function IBTScanInModal({ row, onClose, onScannedIn }) {
  const dispatched = Number(row?.qty ?? 0);
  const [receivedQty, setReceivedQty] = useState(dispatched);
  const [odooRef, setOdooRef] = useState(row?.odoo_transfer_id || "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  if (!row) return null;

  const fromStore = row.from_store;
  const toStore = row.to_store;
  const skuLine = [row.color, row.size, row.sku, row.barcode].filter(Boolean).join(" · ");
  const shortfall = Math.max(dispatched - Number(receivedQty || 0), 0);
  const over = Number(receivedQty || 0) > dispatched;
  const willDiscrepancy = Number(receivedQty || 0) !== dispatched;

  const submit = async (e) => {
    e.preventDefault();
    if (Number(receivedQty) < 0) {
      setError("Received quantity cannot be negative.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await api.post("/ibt/scan-in", {
        consignment_id: row.consignment_id,
        received_qty: Number(receivedQty),
        odoo_transfer_id: odooRef.trim() || null,
      });
      onScannedIn?.(data);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(
        (detail && typeof detail === "object" && detail.message) ||
        (typeof detail === "string" && detail) ||
        err.message ||
        "Scan-in failed — try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      data-testid="ibt-scan-in-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="size-9 rounded-full bg-emerald-50 text-emerald-600 grid place-items-center">
            <Package size={20} weight="fill" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-extrabold text-[15px] text-[#0f3d24]">Scan in — receive transfer</h2>
            <p className="text-[12px] text-muted mt-0.5 break-words">
              <span className="font-semibold">{row.style_name}</span> · {fromStore}{" "}
              <ArrowRight size={11} weight="bold" className="inline align-middle text-brand" />{" "}
              <span className="text-brand font-semibold">{toStore}</span>
            </p>
            {skuLine && (
              <p className="text-[11px] text-brand-deep mt-0.5 font-mono break-words">{skuLine}</p>
            )}
            <p className="text-[11px] text-muted mt-1 font-mono" data-testid="ibt-scan-in-consignment">
              {row.consignment_id}
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded" data-testid="ibt-scan-in-close">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="eyebrow block mb-1">Dispatched</label>
              <div className="input-pill w-full bg-panel text-foreground/80 tabular-nums" data-testid="ibt-scan-in-dispatched">
                {fmtNum(dispatched)} units
              </div>
            </div>
            <div>
              <label className="eyebrow block mb-1">Received</label>
              <input
                type="number"
                min={0}
                value={receivedQty}
                onChange={(e) => setReceivedQty(Number(e.target.value) || 0)}
                className="input-pill w-full"
                data-testid="ibt-scan-in-received"
                required
              />
            </div>
          </div>

          {willDiscrepancy ? (
            <div className="flex items-start gap-2.5 text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5" data-testid="ibt-scan-in-discrepancy-preview">
              <Warning size={18} weight="fill" className="text-amber-500 mt-0.5 shrink-0" />
              <div>
                <div className="font-bold">Discrepancy — will be flagged</div>
                <div className="mt-0.5">
                  {over
                    ? `Receiving ${fmtNum(receivedQty)} against ${fmtNum(dispatched)} dispatched (overage of ${fmtNum(Number(receivedQty) - dispatched)}).`
                    : `Short by ${fmtNum(shortfall)} unit(s) — ${fmtNum(receivedQty)} of ${fmtNum(dispatched)} arrived.`}
                </div>
                <div className="mt-1 text-[11px] text-amber-700">
                  The move still closes, but only the received units count toward
                  realised SOR/CCC.
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[12px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              <CheckCircle size={16} weight="fill" className="text-emerald-600" />
              Full receipt — all {fmtNum(dispatched)} units accounted for.
            </div>
          )}

          <div>
            <label className="eyebrow block mb-1">Odoo transfer ref <span className="text-muted font-normal">(optional)</span></label>
            <input
              value={odooRef}
              onChange={(e) => setOdooRef(e.target.value)}
              placeholder="e.g. WH/IN/01234"
              className="input-pill w-full"
              data-testid="ibt-scan-in-odoo"
            />
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
              data-testid="ibt-scan-in-cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 px-4 py-2 rounded-md disabled:opacity-50"
              data-testid="ibt-scan-in-submit"
            >
              <Package size={14} weight="bold" />
              {submitting ? "Receiving…" : "Scan in"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
