import React, { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { SectionTitle, Loading, ErrorBox } from "@/components/common";
import ProductionOrderModal from "@/components/ProductionOrderModal";
import { ArrowsClockwise, Factory, MagnifyingGlass, X } from "@phosphor-icons/react";

/**
 * Production Tracker — a kanban board of every buying order's work-in-progress
 * across the manufacturing stages (Buying Order → Cutting → … → Warehouse).
 * Each column is a stage; each card is the slice of one order's units sitting
 * in that stage. Clicking a card opens the order modal to move quantities on.
 * Reads GET /api/production/stages + /board; writes via the modal's
 * POST /api/production/move. Card age colours: green <2d, amber 2–7d, red >7d.
 */
function ageClasses(days) {
  const d = Number(days) || 0;
  if (d > 7) return "border-l-rose-400 bg-rose-50/40";
  if (d >= 2) return "border-l-amber-400 bg-amber-50/40";
  return "border-l-emerald-400 bg-emerald-50/40";
}

function ageBadge(days) {
  const d = Number(days) || 0;
  if (d > 7) return "bg-rose-100 text-rose-700";
  if (d >= 2) return "bg-amber-100 text-amber-700";
  return "bg-emerald-100 text-emerald-700";
}

function fmtQty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtDays(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export default function Production() {
  const [stages, setStages] = useState([]);
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openOrder, setOpenOrder] = useState(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const [stagesRes, boardRes] = await Promise.all([
        api.get("/production/stages", force ? { forceFresh: true } : {}),
        api.get("/production/board", force ? { forceFresh: true } : {}),
      ]);
      setStages(stagesRes.data?.stages || []);
      setCards(boardRes.data?.cards || []);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || "Failed to load the production board");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const filteredCards = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((c) =>
      [c.style_number, c.product_name, c.order_ref]
        .some((v) => String(v || "").toLowerCase().includes(q))
    );
  }, [cards, query]);

  const cardsByStage = React.useMemo(() => {
    const map = {};
    for (const c of filteredCards) {
      (map[c.stage] ||= []).push(c);
    }
    return map;
  }, [filteredCards]);

  const totalUnits = React.useMemo(
    () => filteredCards.reduce((s, c) => s + (Number(c.qty_here) || 0), 0),
    [filteredCards]
  );
  const totalOrders = React.useMemo(
    () => new Set(filteredCards.map((c) => c.order_ref)).size,
    [filteredCards]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <SectionTitle
          title="Production Tracker"
          subtitle="Work-in-progress across the manufacturing stages — move quantities forward as orders progress."
          testId="production-title"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search style name or number…"
              className="w-60 text-[12.5px] border border-line rounded-md pl-8 pr-7 py-2 focus:outline-none focus:ring-2 focus:ring-brand/30"
              data-testid="production-search"
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-[#0f3d24]"
                aria-label="Clear search"
                data-testid="production-search-clear"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <button
            onClick={() => load(true)}
            disabled={refreshing || loading}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-brand border border-brand/30 hover:bg-brand/5 px-3 py-2 rounded-md disabled:opacity-50"
            data-testid="production-refresh"
          >
            <ArrowsClockwise size={14} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {loading ? (
        <Loading label="Loading the production board…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <>
          <div className="flex flex-wrap gap-4 text-[12px] text-muted">
            <span><span className="font-extrabold text-[#0f3d24] text-[15px]">{fmtQty(totalUnits)}</span> units in progress</span>
            <span><span className="font-extrabold text-[#0f3d24] text-[15px]">{fmtQty(totalOrders)}</span> active orders</span>
            <span><span className="font-extrabold text-[#0f3d24] text-[15px]">{stages.length}</span> stages</span>
          </div>

          <div className="overflow-x-auto pb-2">
            <div className="flex gap-3 min-w-max">
              {stages.map((st) => {
                const colCards = cardsByStage[st.stage_key] || [];
                return (
                  <div
                    key={st.stage_key}
                    className="w-[248px] shrink-0 rounded-xl bg-panel/50 border border-line flex flex-col"
                    data-testid={`production-col-${st.stage_key}`}
                  >
                    <div className="px-3 py-2.5 border-b border-line">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-bold text-[13px] text-[#0f3d24] truncate">{st.stage_name}</div>
                        <span className="text-[11px] font-semibold text-muted bg-white border border-line rounded-full px-1.5 py-0.5">
                          {colCards.length}
                        </span>
                      </div>
                      <div className="text-[11px] text-muted mt-0.5">
                        {fmtQty(st.units_here)} units
                        {Number(st.oldest_days_in_stage) > 0 && (
                          <> · oldest {fmtDays(st.oldest_days_in_stage)}d</>
                        )}
                      </div>
                    </div>

                    <div className="p-2 space-y-2 flex-1 min-h-[60px]">
                      {colCards.length === 0 ? (
                        <div className="text-[11px] text-muted/70 italic text-center py-4">Empty</div>
                      ) : (
                        colCards.map((c) => (
                          <button
                            key={`${c.order_ref}-${c.stage}`}
                            onClick={() => setOpenOrder(c.order_ref)}
                            className={`w-full text-left rounded-lg border border-line border-l-4 bg-white hover:shadow-sm transition p-2.5 ${ageClasses(c.days_in_stage)}`}
                            data-testid={`production-card-${c.order_ref}-${c.stage}`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="font-semibold text-[12.5px] text-[#0f3d24] truncate">
                                  {c.style_number || c.order_ref}
                                </div>
                                {c.product_name && (
                                  <div className="text-[11px] text-muted truncate">{c.product_name}</div>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <div className="text-[15px] font-extrabold text-brand leading-none">{fmtQty(c.qty_here)}</div>
                                <div className="eyebrow">units</div>
                              </div>
                            </div>
                            <div className="flex items-center justify-between gap-2 mt-1.5">
                              <span className="text-[10.5px] text-muted font-mono truncate">{c.order_ref}</span>
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${ageBadge(c.days_in_stage)}`}>
                                {fmtDays(c.days_in_stage)}d
                              </span>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {cards.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 text-muted py-10">
              <Factory size={32} className="opacity-40" />
              <div className="text-sm">No work-in-progress orders on the board yet.</div>
            </div>
          )}
        </>
      )}

      {openOrder && (
        <ProductionOrderModal
          orderRef={openOrder}
          onClose={() => setOpenOrder(null)}
          onChanged={() => load(true)}
        />
      )}
    </div>
  );
}
