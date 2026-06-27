import React, { useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { X, Warning, ArrowRight, Prohibit, CheckCircle } from "@phosphor-icons/react";

/**
 * Resolve-stuck modal — force-close an in-transit consignment that was scanned
 * out but never scanned in (lost parcel, mis-scan) so it would otherwise sit
 * in_transit forever.
 *
 * Two mutually-exclusive resolutions, both requiring a reason:
 *   • cancel        — ownership returns to the donor (its SOR never moved). No
 *                     receipt is recorded.
 *   • force_receive — close it as received against the dispatched qty (or an
 *                     entered received qty); a shortfall flags a discrepancy.
 *
 * Either way the consignment leaves the in-transit worklist + KPI.
 */
export default function IBTResolveStuckModal({ row, onClose, onResolved }) {
  const dispatched = Number(row?.qty ?? 0);
  const [action, setAction] = useState("cancel");
  const [reason, setReason] = useState("");
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
    if (!reason.trim()) {
      setError("A reason is required to resolve a stuck consignment.");
      return;
    }
    if (action === "force_receive" && Number(receivedQty) < 0) {
      setError("Received quantity cannot be negative.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        consignment_id: row.consignment_id,
        action,
        reason: reason.trim(),
      };
      if (action === "force_receive") {
        payload.received_qty = Number(receivedQty);
        payload.odoo_transfer_id = odooRef.trim() || null;
      }
      const { data } = await api.post("/ibt/resolve-stuck", payload);
      onResolved?.(data);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(
        (detail && typeof detail === "object" && detail.message) ||
        (typeof detail === "string" && detail) ||
        err.message ||
        "Resolution failed — try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      data-testid="ibt-resolve-stuck-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="size-9 rounded-full bg-rose-50 text-rose-600 grid place-items-center">
            <Warning size={20} weight="fill" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-extrabold text-[15px] text-[#0f3d24]">Resolve stuck consignment</h2>
            <p className="text-[12px] text-muted mt-0.5 break-words">
              <span className="font-semibold">{row.style_name}</span> · {fromStore}{" "}
              <ArrowRight size={11} weight="bold" className="inline align-middle text-brand" />{" "}
              <span className="text-brand font-semibold">{toStore}</span>
            </p>
            {skuLine && (
              <p className="text-[11px] text-brand-deep mt-0.5 font-mono break-words">{skuLine}</p>
            )}
            <p className="text-[11px] text-muted mt-1 font-mono" data-testid="ibt-resolve-consignment">
              {row.consignment_id}
              {row.days_in_transit != null && (
                <span className="text-rose-600 font-semibold"> · {fmtNum(row.days_in_transit)}d in transit</span>
              )}
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded" data-testid="ibt-resolve-close">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="eyebrow block mb-1.5">Resolution</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAction("cancel")}
                className={`flex items-start gap-2 text-left rounded-lg border px-3 py-2.5 transition ${
                  action === "cancel"
                    ? "border-rose-400 bg-rose-50 ring-1 ring-rose-300"
                    : "border-border bg-white hover:bg-panel/40"
                }`}
                data-testid="ibt-resolve-action-cancel"
              >
                <Prohibit size={18} weight="duotone" className="text-rose-600 mt-0.5 shrink-0" />
                <span>
                  <span className="block font-bold text-[12.5px]">Cancel</span>
                  <span className="block text-[11px] text-muted mt-0.5">Return to donor — nothing was received</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setAction("force_receive")}
                className={`flex items-start gap-2 text-left rounded-lg border px-3 py-2.5 transition ${
                  action === "force_receive"
                    ? "border-emerald-400 bg-emerald-50 ring-1 ring-emerald-300"
                    : "border-border bg-white hover:bg-panel/40"
                }`}
                data-testid="ibt-resolve-action-force-receive"
              >
                <CheckCircle size={18} weight="duotone" className="text-emerald-600 mt-0.5 shrink-0" />
                <span>
                  <span className="block font-bold text-[12.5px]">Force receive</span>
                  <span className="block text-[11px] text-muted mt-0.5">Close as received at destination</span>
                </span>
              </button>
            </div>
          </div>

          {action === "force_receive" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="eyebrow block mb-1">Dispatched</label>
                  <div className="input-pill w-full bg-panel text-foreground/80 tabular-nums" data-testid="ibt-resolve-dispatched">
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
                    data-testid="ibt-resolve-received"
                  />
                </div>
              </div>
              {willDiscrepancy && (
                <div className="flex items-start gap-2.5 text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                  <Warning size={18} weight="fill" className="text-amber-500 mt-0.5 shrink-0" />
                  <div>
                    {over
                      ? `Receiving ${fmtNum(receivedQty)} against ${fmtNum(dispatched)} dispatched (overage of ${fmtNum(Number(receivedQty) - dispatched)}) — will be flagged as a discrepancy.`
                      : `Short by ${fmtNum(shortfall)} unit(s) — ${fmtNum(receivedQty)} of ${fmtNum(dispatched)} arrived; will be flagged as a discrepancy.`}
                  </div>
                </div>
              )}
              <div>
                <label className="eyebrow block mb-1">Odoo transfer ref <span className="text-muted font-normal">(optional)</span></label>
                <input
                  value={odooRef}
                  onChange={(e) => setOdooRef(e.target.value)}
                  placeholder="e.g. WH/IN/01234"
                  className="input-pill w-full"
                  data-testid="ibt-resolve-odoo"
                />
              </div>
            </>
          )}

          {action === "cancel" && (
            <div className="flex items-start gap-2.5 text-[12px] text-rose-900 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2.5">
              <Prohibit size={18} weight="fill" className="text-rose-500 mt-0.5 shrink-0" />
              <div>
                Ownership of the {fmtNum(dispatched)} unit(s) returns to{" "}
                <span className="font-semibold">{fromStore}</span>. No receipt is recorded
                and the move drops out of the in-transit list.
              </div>
            </div>
          )}

          <div>
            <label className="eyebrow block mb-1">
              Reason <span className="text-rose-600 font-normal">(required)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder={action === "cancel" ? "e.g. Parcel lost in transit, re-issuing" : "e.g. Received late, store forgot to scan"}
              className="input-pill w-full resize-none"
              data-testid="ibt-resolve-reason"
              required
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
              data-testid="ibt-resolve-cancel"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={submitting || !reason.trim()}
              className={`inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-white px-4 py-2 rounded-md disabled:opacity-50 ${
                action === "cancel" ? "bg-rose-600 hover:bg-rose-700" : "bg-emerald-600 hover:bg-emerald-700"
              }`}
              data-testid="ibt-resolve-submit"
            >
              {action === "cancel" ? <Prohibit size={14} weight="bold" /> : <CheckCircle size={14} weight="bold" />}
              {submitting
                ? "Resolving…"
                : action === "cancel" ? "Cancel consignment" : "Force receive"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
