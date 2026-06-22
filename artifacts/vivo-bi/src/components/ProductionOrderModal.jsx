import React, { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import {
  X,
  ArrowRight,
  ClockCounterClockwise,
  CaretDown,
  CaretRight,
  MapPinLine,
} from "@phosphor-icons/react";

/**
 * Per-order detail modal for the Production Tracker. It shows:
 *   1. The order header + colour x size matrix.
 *   2. The style's JOURNEY across the stages (arrival date per stage, days spent
 *      on the arrows between them, the current stage highlighted) — derived
 *      client-side from the movement history + stage reference.
 *   3. The live balances grouped by stage with a per-SKU move control so the
 *      team can advance one colour/size at a time (qty adjustable per SKU).
 *   4. The full movement history.
 * The only writer is POST /api/production/move (optionally carrying sku + size).
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

function fmtDays(n) {
  const v = Number(n) || 0;
  if (v < 1) return "<1d";
  return `${Math.round(v)}d`;
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

function fmtDay(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return String(ts);
  }
}

function stageLabel(s) {
  return String(s || "").replace(/_/g, " ");
}

/**
 * Colour x size matrix for one buying order. Rows are colours (the buying-order
 * lines), columns are the distinct sizes seen across that order's variants, and
 * each cell is the ordered qty for that (colour, size).
 */
function ColourSizeMatrix({ lines, variants }) {
  const { sizes, byColour, colTotals, grand } = React.useMemo(() => {
    const sizeOrder = [];
    const seenSize = new Set();
    const byColour = new Map();
    const colTotals = new Map();
    let grand = 0;
    for (const v of variants || []) {
      const colour = v.colour || "—";
      const size = v.size || "—";
      const qty = Number(v.qty) || 0;
      if (!seenSize.has(size)) { seenSize.add(size); sizeOrder.push(size); }
      if (!byColour.has(colour)) byColour.set(colour, { cells: new Map(), total: 0 });
      const row = byColour.get(colour);
      row.cells.set(size, (row.cells.get(size) || 0) + qty);
      row.total += qty;
      colTotals.set(size, (colTotals.get(size) || 0) + qty);
      grand += qty;
    }
    const RANK = ["XS", "XS/S", "S", "S/M", "M", "M/L", "L", "L/1X", "1X", "1X/2X", "2X", "2X/3X", "3X", "XL", "XXL"];
    sizeOrder.sort((a, b) => {
      const ia = RANK.indexOf(a), ib = RANK.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return String(a).localeCompare(String(b));
    });
    return { sizes: sizeOrder, byColour, colTotals, grand };
  }, [variants]);

  const colourRows = React.useMemo(() => {
    const fromLines = (lines || []).map((l) => l.colour || "—");
    const fromVariants = Array.from(byColour.keys());
    const ordered = [];
    const seen = new Set();
    for (const c of [...fromLines, ...fromVariants]) {
      if (!seen.has(c)) { seen.add(c); ordered.push(c); }
    }
    return ordered;
  }, [lines, byColour]);

  if (!variants || variants.length === 0) {
    if (!lines || lines.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1.5">
        {lines.map((l, i) => (
          <span key={i} className="inline-flex items-center gap-1 text-[11.5px] bg-panel/60 border border-line rounded-full px-2 py-0.5">
            <span className="font-semibold text-[#0f3d24]">{l.colour || "—"}</span>
            <span className="text-muted">{fmtQty(l.total_qty)}</span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="border border-line rounded-lg overflow-x-auto">
      <table className="w-full text-[12px] border-collapse">
        <thead className="bg-panel/60 text-muted">
          <tr>
            <th className="text-left font-semibold px-3 py-1.5 sticky left-0 bg-panel/60 z-10">Colour</th>
            {sizes.map((s) => (
              <th key={s} className="text-right font-semibold px-2.5 py-1.5 whitespace-nowrap">{s}</th>
            ))}
            <th className="text-right font-semibold px-3 py-1.5 bg-panel">Total</th>
          </tr>
        </thead>
        <tbody>
          {colourRows.map((colour) => {
            const row = byColour.get(colour) || { cells: new Map(), total: 0 };
            return (
              <tr key={colour} className="border-t border-line">
                <td className="px-3 py-1.5 font-semibold text-[#0f3d24] whitespace-nowrap sticky left-0 bg-white z-10">{colour}</td>
                {sizes.map((s) => {
                  const v = row.cells.get(s) || 0;
                  return (
                    <td key={s} className={`px-2.5 py-1.5 text-right tabular-nums ${v ? "" : "text-line"}`}>
                      {v ? fmtQty(v) : "·"}
                    </td>
                  );
                })}
                <td className="px-3 py-1.5 text-right font-bold tabular-nums bg-panel/40">{fmtQty(row.total)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line bg-panel/40">
            <td className="px-3 py-1.5 font-bold text-[#0f3d24] sticky left-0 bg-panel/40 z-10">Total</td>
            {sizes.map((s) => (
              <td key={s} className="px-2.5 py-1.5 text-right font-bold tabular-nums">{fmtQty(colTotals.get(s) || 0)}</td>
            ))}
            <td className="px-3 py-1.5 text-right font-extrabold tabular-nums text-brand">{fmtQty(grand)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * The style's journey across the stages, derived from the movement history.
 * Each visited stage shows its arrival date + units that entered; the arrow to
 * the next stage is labelled with the days the units spent in the earlier stage.
 */
function JourneyStepper({ steps }) {
  if (!steps || steps.length === 0) {
    return <div className="text-[12px] text-muted italic">No movements recorded yet — the style is still at intake.</div>;
  }
  return (
    <div className="flex items-stretch gap-0 overflow-x-auto pb-1" data-testid="prod-journey">
      {steps.map((s, i) => (
        <React.Fragment key={s.stage_key}>
          <div
            className={`shrink-0 rounded-lg border px-3 py-2 min-w-[120px] ${
              s.current
                ? "border-[#1a5c38] bg-emerald-50 ring-1 ring-[#1a5c38]"
                : "border-line bg-white"
            }`}
            data-testid={`prod-journey-${s.stage_key}`}
          >
            <div className="flex items-center gap-1 text-[11.5px] font-semibold text-[#0f3d24]">
              {s.current && <MapPinLine size={12} weight="fill" className="text-[#1a5c38]" />}
              <span className="truncate">{s.stage_name}</span>
            </div>
            <div className="text-[10.5px] text-muted mt-0.5">Arrived {fmtDay(s.arrival)}</div>
            <div className="text-[11px] font-semibold tabular-nums mt-0.5">
              {fmtQty(s.entered)} u <span className="text-muted font-normal">entered</span>
            </div>
          </div>
          {i < steps.length - 1 && (
            <div className="shrink-0 flex flex-col items-center justify-center px-1.5">
              <ArrowRight size={16} weight="bold" className="text-muted" />
              {s.daysHere != null && (
                <span className="text-[10px] text-muted whitespace-nowrap">{fmtDays(s.daysHere)}</span>
              )}
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

/** A single SKU's move control within a stage group. */
function SkuMoveRow({ orderRef, row, allowed, isTerminal, onMoved }) {
  const [toStage, setToStage] = useState(allowed[0] || "");
  const [qty, setQty] = useState(row.qty_here);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const label = row.colour
    ? `${row.colour}${row.size ? ` · ${row.size}` : ""}`
    : row.sku
    ? row.sku
    : "Whole order";

  const move = async () => {
    setError(null);
    const q = Number(qty);
    if (!toStage) { setError("Pick a destination."); return; }
    if (!(q > 0)) { setError("Qty must be > 0."); return; }
    if (q > Number(row.qty_here)) { setError(`Only ${fmtQty(row.qty_here)} here.`); return; }
    setSubmitting(true);
    try {
      const { data } = await api.post("/production/move", {
        order_ref: orderRef,
        from_stage: row.stage,
        to_stage: toStage,
        qty: q,
        sku: row.sku || undefined,
        size: row.size || undefined,
      });
      onMoved?.(data);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || "Move failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border-t border-line px-3 py-2" data-testid={`prod-sku-row-${row.sku || "whole"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold text-[#0f3d24] truncate">{label}</div>
          {row.sku && row.colour && (
            <div className="text-[10px] text-muted truncate">{row.sku}</div>
          )}
        </div>
        <div className="text-right shrink-0 w-14">
          <div className="text-[14px] font-bold text-brand leading-none tabular-nums">{fmtQty(row.qty_here)}</div>
          <div className="text-[9.5px] text-muted">here</div>
        </div>
        {isTerminal ? (
          <span className="text-[11px] text-muted italic shrink-0">Final stage</span>
        ) : (
          <div className="flex items-center gap-1.5 shrink-0">
            <select
              value={toStage}
              onChange={(e) => setToStage(e.target.value)}
              className="input-pill text-[11.5px] py-1"
              data-testid={`prod-move-to-${row.stage}-${row.sku || "whole"}`}
            >
              {allowed.map((s) => (
                <option key={s} value={s}>{stageLabel(s)}</option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              max={Number(row.qty_here)}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="input-pill text-[11.5px] py-1 w-16"
              data-testid={`prod-move-qty-${row.stage}-${row.sku || "whole"}`}
            />
            <button
              type="button"
              onClick={move}
              disabled={submitting}
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-2.5 py-1.5 rounded-md disabled:opacity-50"
              data-testid={`prod-move-btn-${row.stage}-${row.sku || "whole"}`}
            >
              {submitting ? "…" : <ArrowRight size={12} weight="bold" />}
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="mt-1.5 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
          {error}
        </div>
      )}
    </div>
  );
}

/** One stage's group of SKU rows (collapsible — long lists default collapsed). */
function StageGroup({ orderRef, group, onMoved }) {
  const rows = group.rows || [];
  const total = rows.reduce((s, r) => s + (Number(r.qty_here) || 0), 0);
  const maxDays = rows.reduce((m, r) => Math.max(m, Number(r.days_in_stage) || 0), 0);
  const allowed = group.allowed_next || [];
  const isTerminal = group.is_terminal || allowed.length === 0;
  const [open, setOpen] = useState(rows.length <= 10);

  return (
    <div className="rounded-lg border border-line bg-white overflow-hidden" data-testid={`prod-stage-group-${group.stage}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-panel/40 hover:bg-panel/60 text-left"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
          <span className="font-semibold text-[13px] text-[#0f3d24] truncate">{group.stage_name}</span>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${ageClasses(maxDays)}`}>
            {fmtDays(maxDays)} oldest
          </span>
        </div>
        <div className="text-right shrink-0">
          <span className="text-[14px] font-extrabold text-brand tabular-nums">{fmtQty(total)}</span>
          <span className="text-[10.5px] text-muted"> u · {rows.length} sku{rows.length === 1 ? "" : "s"}</span>
        </div>
      </button>
      {open && (
        <div>
          {rows.map((r) => (
            <SkuMoveRow
              key={`${r.sku || "whole"}|${r.size || ""}`}
              orderRef={orderRef}
              row={r}
              allowed={allowed}
              isTerminal={isTerminal}
              onMoved={onMoved}
            />
          ))}
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
  const skuBalances = detail?.sku_balances || [];
  const stages = detail?.stages || [];
  const history = detail?.history || [];
  const lines = detail?.lines || [];
  const variants = detail?.variants || [];
  const colourCount = React.useMemo(
    () => new Set([...lines.map((l) => l.colour || "—"), ...variants.map((v) => v.colour || "—")].filter(Boolean)).size,
    [lines, variants]
  );
  const sizeCount = React.useMemo(
    () => new Set(variants.map((v) => v.size).filter(Boolean)).size,
    [variants]
  );

  // Journey: stages this style has reached, in board order, with arrival dates
  // and the days spent before moving on.
  const journey = React.useMemo(() => {
    if (!stages.length) return [];
    const arrival = new Map();
    const entered = new Map();
    for (const h of history) {
      if (!h.to_stage) continue;
      const t = new Date(h.moved_at).getTime();
      if (!arrival.has(h.to_stage) || t < arrival.get(h.to_stage)) arrival.set(h.to_stage, t);
      entered.set(h.to_stage, (entered.get(h.to_stage) || 0) + Number(h.qty || 0));
    }
    const here = new Set(balances.filter((b) => Number(b.qty_here) > 0).map((b) => b.stage));
    const visited = stages
      .filter((s) => arrival.has(s.stage_key))
      .sort((a, b) => a.sort_order - b.sort_order);
    let current = null;
    for (const s of visited) if (here.has(s.stage_key)) current = s.stage_key;
    if (!current && visited.length) current = visited[visited.length - 1].stage_key;
    return visited.map((s, i) => {
      const next = visited[i + 1];
      let daysHere = null;
      if (next) daysHere = (arrival.get(next.stage_key) - arrival.get(s.stage_key)) / 86400000;
      else if (here.has(s.stage_key)) daysHere = (Date.now() - arrival.get(s.stage_key)) / 86400000;
      return {
        stage_key: s.stage_key,
        stage_name: s.stage_name,
        arrival: arrival.get(s.stage_key),
        entered: entered.get(s.stage_key) || 0,
        current: s.stage_key === current,
        daysHere,
      };
    });
  }, [stages, history, balances]);

  // SKU balances grouped by stage (board order).
  const skuGroups = React.useMemo(() => {
    const m = new Map();
    for (const r of skuBalances) {
      if (!m.has(r.stage)) {
        m.set(r.stage, {
          stage: r.stage,
          stage_name: r.stage_name,
          sort_order: r.sort_order,
          allowed_next: r.allowed_next,
          is_terminal: r.is_terminal,
          rows: [],
        });
      }
      m.get(r.stage).rows.push(r);
    }
    return Array.from(m.values()).sort((a, b) => a.sort_order - b.sort_order);
  }, [skuBalances]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      data-testid="prod-order-modal"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <div className="eyebrow">Order {orderRef}</div>
            <h2 className="font-extrabold text-[16px] text-[#0f3d24] break-words">
              {order?.style_name || order?.product_name || order?.style_number || orderRef}
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
            {/* Journey across the line */}
            <div className="mb-2 eyebrow flex items-center gap-1.5">
              <MapPinLine size={13} /> Journey across the line
            </div>
            <div className="mb-5">
              <JourneyStepper steps={journey} />
            </div>

            <div className="mb-2 eyebrow flex items-center gap-2 flex-wrap">
              <span>Colours &amp; sizes</span>
              <span className="text-[10.5px] font-semibold text-[#0f3d24] bg-emerald-50 border border-emerald-200 rounded-full px-1.5 py-0.5">
                {colourCount} colour{colourCount === 1 ? "" : "s"}
              </span>
              {sizeCount > 0 && (
                <span className="text-[10.5px] font-semibold text-[#0f3d24] bg-emerald-50 border border-emerald-200 rounded-full px-1.5 py-0.5">
                  {sizeCount} size{sizeCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <div className="mb-5">
              {lines.length === 0 && variants.length === 0 ? (
                <div className="text-[12px] text-muted italic">No colour / size breakdown available for this order.</div>
              ) : (
                <ColourSizeMatrix lines={lines} variants={variants} />
              )}
            </div>

            <div className="mb-2 eyebrow">Move units by SKU</div>
            {skuGroups.length === 0 ? (
              <div className="text-[12px] text-muted italic mb-5">No units currently in progress for this order.</div>
            ) : (
              <div className="space-y-2 mb-5">
                {skuGroups.map((g) => (
                  <StageGroup key={g.stage} orderRef={orderRef} group={g} onMoved={handleMoved} />
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
                      <th className="text-left font-semibold px-3 py-1.5">SKU</th>
                      <th className="text-left font-semibold px-3 py-1.5">From → To</th>
                      <th className="text-right font-semibold px-3 py-1.5">Qty</th>
                      <th className="text-left font-semibold px-3 py-1.5">By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className="px-3 py-1.5 whitespace-nowrap text-muted">{fmtWhen(h.moved_at)}</td>
                        <td className="px-3 py-1.5 text-muted truncate max-w-[120px]">
                          {h.sku ? (
                            <span title={h.sku}>{h.sku}{h.size ? ` · ${h.size}` : ""}</span>
                          ) : (
                            <span className="italic">whole order</span>
                          )}
                        </td>
                        <td className="px-3 py-1.5">
                          <span className="text-muted">{stageLabel(h.from_stage || "—")}</span>
                          {" → "}
                          <span className="font-semibold text-[#0f3d24]">{stageLabel(h.to_stage || "")}</span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-semibold">{fmtQty(h.qty)}</td>
                        <td className="px-3 py-1.5 text-muted truncate max-w-[120px]">{h.moved_by || "—"}</td>
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
