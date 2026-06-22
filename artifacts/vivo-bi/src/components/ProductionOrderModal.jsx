import React, { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { X, ArrowRight, ClockCounterClockwise } from "@phosphor-icons/react";

/**
 * Per-order detail modal for the Production Tracker. Shows the order header,
 * the live per-stage balances with an inline "move" control on each stage that
 * still holds units, and the full movement history. The only writer is
 * POST /api/production/move; the terminal stage (Warehouse, no allowed_next)
 * renders a "final stage" note instead of a move control.
 */
function ageClasses(days) {
  const d = Number(days) || 0;
  if (d > 7) return "bg-rose-50 text-rose-700 border-rose-200";
  if (d >= 2) return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-emerald-50 text-emerald-700 border-emerald-200";
}

function fmtQty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtWhen(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

function StageMoveRow({ orderRef, balance, stageName, onMoved }) {
  const allowed = balance.allowed_next || [];
  const isTerminal = balance.is_terminal || allowed.length === 0;
  const [toStage, setToStage] = useState(allowed[0] || "");
  const [qty, setQty] = useState(balance.qty_here);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const move = async () => {
    setError(null);
    const q = Number(qty);
    if (!toStage) { setError("Pick a destination stage."); return; }
    if (!(q > 0)) { setError("Quantity must be greater than 0."); return; }
    if (q > Number(balance.qty_here)) {
      setError(`Only ${fmtQty(balance.qty_here)} available here.`);
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await api.post("/production/move", {
        order_ref: orderRef,
        from_stage: balance.stage,
        to_stage: toStage,
        qty: q,
      });
      onMoved?.(data);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || "Move failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-line bg-white p-3" data-testid={`prod-balance-${balance.stage}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="font-semibold text-[13px] text-[#0f3d24] truncate">{stageName}</div>
          <span className={`inline-block mt-0.5 text-[10.5px] font-semibold px-1.5 py-0.5 rounded border ${ageClasses(balance.days_in_stage)}`}>
            {fmtQty(balance.days_in_stage)}d in stage
          </span>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[18px] font-extrabold text-brand leading-none">{fmtQty(balance.qty_here)}</div>
          <div className="eyebrow">units here</div>
        </div>
      </div>

      {isTerminal ? (
        <div className="text-[11.5px] text-muted italic">Final stage — no further moves.</div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[120px]">
            <label className="eyebrow block mb-1">Move to</label>
            <select
              value={toStage}
              onChange={(e) => setToStage(e.target.value)}
              className="input-pill w-full"
              data-testid={`prod-move-to-${balance.stage}`}
            >
              {allowed.map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
              ))}
            </select>
          </div>
          <div className="w-24">
            <label className="eyebrow block mb-1">Qty</label>
            <input
              type="number"
              min={1}
              max={Number(balance.qty_here)}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="input-pill w-full"
              data-testid={`prod-move-qty-${balance.stage}`}
            />
          </div>
          <button
            type="button"
            onClick={move}
            disabled={submitting}
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-3 py-2 rounded-md disabled:opacity-50"
            data-testid={`prod-move-btn-${balance.stage}`}
          >
            {submitting ? "Moving…" : <>Move <ArrowRight size={13} weight="bold" /></>}
          </button>
        </div>
      )}
      {error && (
        <div className="mt-2 text-[11.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
          {error}
        </div>
      )}
    </div>
  );
}

export default function ProductionOrderModal({ orderRef, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get(`/production/orders/${encodeURIComponent(orderRef)}`, { forceFresh: true });
      setDetail(data);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || "Failed to load order");
    } finally {
      setLoading(false);
    }
  }, [orderRef]);

  useEffect(() => { load(); }, [load]);

  const handleMoved = (data) => {
    if (data) setDetail(data);
    onChanged?.();
  };

  const order = detail?.order;
  const balances = detail?.balances || [];
  const history = detail?.history || [];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      data-testid="prod-order-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <div className="eyebrow">Order {orderRef}</div>
            <h2 className="font-extrabold text-[16px] text-[#0f3d24] break-words">
              {order?.product_name || order?.style_number || orderRef}
            </h2>
            <p className="text-[12px] text-muted mt-0.5 break-words">
              {order?.style_number ? <>Style <span className="font-semibold">{order.style_number}</span> · </> : null}
              {order?.order_qty != null ? <>Order qty {fmtQty(order.order_qty)}</> : null}
              {order?.fabric ? <> · {order.fabric}</> : null}
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded" data-testid="prod-order-modal-close">
            <X size={16} />
          </button>
        </div>

        {loading && <div className="py-8 text-center text-muted text-sm">Loading order…</div>}
        {error && !loading && (
          <div className="text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="mb-2 eyebrow">Where the units are now</div>
            {balances.length === 0 ? (
              <div className="text-[12px] text-muted italic mb-4">No units currently in progress for this order.</div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 mb-5">
                {balances.map((b) => (
                  <StageMoveRow
                    key={b.stage}
                    orderRef={orderRef}
                    balance={b}
                    stageName={b.stage_name}
                    onMoved={handleMoved}
                  />
                ))}
              </div>
            )}

            <div className="mb-2 eyebrow flex items-center gap-1.5">
              <ClockCounterClockwise size={13} /> Movement history
            </div>
            {history.length === 0 ? (
              <div className="text-[12px] text-muted italic">No movements recorded yet.</div>
            ) : (
              <div className="border border-line rounded-lg overflow-hidden">
                <table className="w-full text-[12px]">
                  <thead className="bg-panel/60 text-muted">
                    <tr>
                      <th className="text-left font-semibold px-3 py-1.5">When</th>
                      <th className="text-left font-semibold px-3 py-1.5">From → To</th>
                      <th className="text-right font-semibold px-3 py-1.5">Qty</th>
                      <th className="text-left font-semibold px-3 py-1.5">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className="px-3 py-1.5 whitespace-nowrap text-muted">{fmtWhen(h.moved_at)}</td>
                        <td className="px-3 py-1.5">
                          <span className="text-muted">{(h.from_stage || "—").replace(/_/g, " ")}</span>
                          {" → "}
                          <span className="font-semibold text-[#0f3d24]">{(h.to_stage || "").replace(/_/g, " ")}</span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-semibold">{fmtQty(h.qty)}</td>
                        <td className="px-3 py-1.5 text-muted truncate max-w-[140px]">{h.moved_by || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
