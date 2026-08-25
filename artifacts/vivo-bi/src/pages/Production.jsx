import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { SectionTitle, Loading, ErrorBox } from "@/components/common";
import ProductionOrderModal from "@/components/ProductionOrderModal";
import { ArrowsClockwise, Factory, MagnifyingGlass, X, CloudCheck, Warning } from "@phosphor-icons/react";
import { useAuth } from "@/lib/auth";
import { canAccessPage } from "@/lib/permissions";

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

function fmtNairobi(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString("en-GB", {
      timeZone: "Africa/Nairobi",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return null;
  }
}

/** Per-column bulk-advance bar shown when ≥1 card in this stage is selected.
 * Cutting is a special case: its only action is "Clear" — hand the bundles to
 * the sewing floor; from there the board tracks them live from Odoo stock. */
function ColumnBulkBar({ stageKey, allowed, count, busy, onMove, onClear }) {
  const clearOnly = stageKey === "cutting";
  const [toStage, setToStage] = useState(allowed[0] || "");
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null);

  useEffect(() => {
    if (!allowed.includes(toStage)) setToStage(allowed[0] || "");
  }, [allowed, toStage]);

  const stageLabel = (k) => String(k || "").replace(/_/g, " ");

  const submit = () => {
    setErr(null);
    const dest = clearOnly ? "waiting_sewing" : toStage;
    if (!dest) { setErr("Pick a destination."); return; }
    setConfirm({ toStage: dest });
  };

  if (confirm) {
    return (
      <div className="px-2 py-2 border-t border-line bg-brand/5" data-testid={`production-bulkbar-${stageKey}`}>
        <div className="text-[11px] font-bold text-[#0f3d24] mb-1">{clearOnly ? "Confirm clear" : "Confirm move"}</div>
        <div className="text-[10.5px] text-[#0f3d24] mb-2" data-testid={`production-bulk-confirm-summary-${stageKey}`}>
          {clearOnly ? (
            <>Clear <span className="font-bold">{count}</span> order{count === 1 ? "" : "s"} out of Cutting to the sewing floor? From here on the board tracks the pieces live from Odoo stock.</>
          ) : (
            <>Move <span className="font-bold">{count}</span> order{count === 1 ? "" : "s"} from{" "}
            <span className="font-semibold capitalize">{stageLabel(stageKey)}</span> to{" "}
            <span className="font-semibold capitalize">{stageLabel(confirm.toStage)}</span>?</>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => { const c = confirm; setConfirm(null); onMove(c); }}
            disabled={busy}
            className="text-[11px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-2.5 py-1.5 rounded-md disabled:opacity-50"
            data-testid={`production-bulk-confirm-${stageKey}`}
          >
            {busy ? "…" : "Confirm"}
          </button>
          <button
            type="button"
            onClick={() => setConfirm(null)}
            disabled={busy}
            className="text-[11px] font-semibold text-[#0f3d24] border border-line hover:bg-white px-2.5 py-1.5 rounded-md disabled:opacity-50"
            data-testid={`production-bulk-cancel-${stageKey}`}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-2 py-2 border-t border-line bg-brand/5" data-testid={`production-bulkbar-${stageKey}`}>
      <div className="flex items-center justify-between gap-1 mb-1.5">
        <span className="text-[11px] font-bold text-[#0f3d24]">{count} selected</span>
        <button
          type="button"
          onClick={onClear}
          className="text-[10.5px] text-muted hover:text-[#0f3d24] underline"
          data-testid={`production-bulk-clear-${stageKey}`}
        >
          Clear
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {!clearOnly && (
          <select
            value={toStage}
            onChange={(e) => setToStage(e.target.value)}
            className="input-pill text-[11px] py-1 flex-1 min-w-0"
            data-testid={`production-bulk-to-${stageKey}`}
          >
            {allowed.map((s) => (
              <option key={s} value={s}>{String(s).replace(/_/g, " ")}</option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className={`text-[11px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-2.5 py-1.5 rounded-md disabled:opacity-50 ${clearOnly ? "flex-1" : ""}`}
          data-testid={`production-bulk-move-${stageKey}`}
        >
          {busy ? "…" : clearOnly ? "Clear to sewing floor" : "Advance"}
        </button>
      </div>
      {clearOnly && (
        <div className="mt-1 text-[10px] text-muted italic">hands the cut bundles over — tracked live from Odoo stock after this</div>
      )}
      {err && <div className="mt-1 text-[10.5px] text-rose-700">{err}</div>}
    </div>
  );
}

function Production() {
  const [stages, setStages] = useState([]);
  const [cards, setCards] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openOrder, setOpenOrder] = useState(null);
  const [query, setQuery] = useState("");
  // Multi-BO selection is scoped to a single stage column (from_stage must be
  // uniform for a bulk advance). Selecting a card in another stage resets it.
  const [selStage, setSelStage] = useState(null);
  const [selRefs, setSelRefs] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState(null);

  const clearSelection = useCallback(() => {
    setSelStage(null);
    setSelRefs(new Set());
    setBulkMsg(null);
  }, []);

  const toggleSelect = useCallback((stage, ref) => {
    setBulkMsg(null);
    setSelStage((prevStage) => {
      if (prevStage !== stage) {
        setSelRefs(new Set([ref]));
        return stage;
      }
      setSelRefs((prev) => {
        const next = new Set(prev);
        if (next.has(ref)) next.delete(ref); else next.add(ref);
        if (next.size === 0) setSelStage(null);
        return next;
      });
      return prevStage;
    });
  }, []);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const [stagesRes, boardRes, syncRes] = await Promise.all([
        api.get("/production/stages", force ? { forceFresh: true } : {}),
        api.get("/production/board", force ? { forceFresh: true } : {}),
        api.get("/production/sync-status", { forceFresh: true }),
      ]);
      setStages(stagesRes.data?.stages || []);
      setCards(boardRes.data?.cards || []);
      setSyncStatus(syncRes.data || null);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || "Failed to load the production board");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const bulkAdvance = useCallback(async ({ fromStage, toStage, sewingLine, refs }) => {
    setBulkBusy(true);
    setBulkMsg(null);
    try {
      const { data } = await api.post("/production/bulk-move", {
        order_refs: refs,
        from_stage: fromStage,
        to_stage: toStage,
        sewing_line: sewingLine || undefined,
      });
      const results = data?.results || [];
      const moved = data?.moved_count || 0;
      const failed = data?.failed_count || 0;
      const movedRefs = results.filter((r) => r.ok !== false).map((r) => r.order_ref).filter(Boolean);
      const failedRows = results.filter((r) => r.ok === false);
      if (failed > 0) {
        setBulkMsg({
          kind: "warn",
          text: `Moved ${moved} order${moved === 1 ? "" : "s"}, ${failed} failed`,
          moved: movedRefs,
          failed: failedRows.map((r) => ({ ref: r.order_ref, error: r.error })),
        });
        // Keep only the still-failing orders selected so the operator can retry.
        setSelRefs(new Set(failedRows.map((r) => r.order_ref)));
      } else {
        setBulkMsg({ kind: "ok", text: `Moved ${moved} order${moved === 1 ? "" : "s"}`, moved: movedRefs, failed: [] });
        setSelStage(null);
        setSelRefs(new Set());
      }
      await load(true);
    } catch (err) {
      setBulkMsg({ kind: "warn", text: err?.response?.data?.detail || err.message || "Bulk move failed" });
    } finally {
      setBulkBusy(false);
    }
  }, [load]);

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
        <div className="min-w-0">
          <SectionTitle
            title="Production Tracker"
            subtitle="Work-in-progress across the manufacturing stages — move quantities forward as orders progress."
            testId="production-title"
          />
          {syncStatus && (
            syncStatus.last_run_at ? (
              <div
                className={`mt-1 inline-flex items-center gap-1.5 text-[11.5px] font-medium ${
                  syncStatus.stale ? "text-amber-700" : "text-muted"
                }`}
                data-testid="production-sync-status"
                title={syncStatus.stale ? "The last Odoo sync is unusually old — it may have failed." : undefined}
              >
                {syncStatus.stale ? (
                  <Warning size={13} weight="fill" className="text-amber-500" />
                ) : (
                  <CloudCheck size={13} className="text-emerald-500" />
                )}
                <span>Last updated from Odoo: {fmtNairobi(syncStatus.last_run_at)} EAT</span>
                {syncStatus.stale && <span className="font-semibold">· may be out of date</span>}
              </div>
            ) : (
              <div className="mt-1 text-[11.5px] text-muted" data-testid="production-sync-status">
                Not yet synced from Odoo
              </div>
            )
          )}
        </div>
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
            <span title="Distinct buying orders with units on the board now. An order spanning stages is counted once here but appears in each stage column, so the per-stage badges can total higher."><span className="font-extrabold text-[#0f3d24] text-[15px]">{fmtQty(totalOrders)}</span> active orders</span>
            <span><span className="font-extrabold text-[#0f3d24] text-[15px]">{stages.length}</span> stages</span>
          </div>

          {bulkMsg && (
            <div
              className={`rounded-lg border px-3 py-2 text-[12px] ${
                bulkMsg.kind === "ok"
                  ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                  : "bg-amber-50 border-amber-200 text-amber-800"
              }`}
              data-testid="production-bulk-result"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{bulkMsg.text}</span>
                <button
                  type="button"
                  onClick={() => setBulkMsg(null)}
                  className="text-[11px] underline opacity-80 hover:opacity-100"
                  data-testid="production-bulk-result-dismiss"
                >
                  Dismiss
                </button>
              </div>
              {bulkMsg.failed && bulkMsg.failed.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {bulkMsg.failed.map((f) => (
                    <li key={f.ref} className="text-[11.5px]">
                      <span className="font-mono font-semibold">{f.ref}</span>
                      {f.error ? <span className="text-amber-700"> — {f.error}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
              {bulkMsg.moved && bulkMsg.moved.length > 0 && (
                <div className="mt-1 text-[11px] opacity-80">
                  Moved: <span className="font-mono">{bulkMsg.moved.join(", ")}</span>
                </div>
              )}
            </div>
          )}

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
                        <div className="flex items-center gap-1.5 min-w-0">
                          <div className="font-bold text-[13px] text-[#0f3d24] truncate">{st.stage_name}</div>
                          {st.live && (
                            <span className="text-[9px] font-bold uppercase tracking-wide text-sky-700 bg-sky-100 border border-sky-200 rounded-full px-1.5 py-0.5 shrink-0" title="Derived live from Odoo stock locations — advances automatically as stock moves in Odoo.">
                              Live
                            </span>
                          )}
                        </div>
                        <span
                          title="Orders with units in this stage. An order spanning stages appears in each column, so these per-stage counts can total more than the distinct active-orders figure above."
                          className="text-[11px] font-semibold text-muted bg-white border border-line rounded-full px-1.5 py-0.5"
                        >
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
                        colCards.map((c) => {
                          const selectable = (st.allowed_next || []).length > 0;
                          const selected = selStage === st.stage_key && selRefs.has(c.order_ref);
                          return (
                            <div
                              key={`${c.order_ref}-${c.stage}`}
                              className={`rounded-lg border border-line border-l-4 bg-white hover:shadow-sm transition p-2.5 ${c.live ? "border-l-sky-400 bg-sky-50/30" : ageClasses(c.days_in_stage)} ${selected ? "ring-2 ring-brand/50" : ""}`}
                              data-testid={`production-card-${c.order_ref}-${c.stage}`}
                            >
                              <div className="flex items-start gap-2">
                                {selectable && (
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    onChange={() => toggleSelect(st.stage_key, c.order_ref)}
                                    className="mt-0.5 shrink-0 accent-[#1a5c38] cursor-pointer"
                                    aria-label={`Select order ${c.order_ref}`}
                                    data-testid={`production-card-select-${c.order_ref}-${c.stage}`}
                                  />
                                )}
                                <button
                                  type="button"
                                  onClick={() => setOpenOrder(c.order_ref)}
                                  className="flex-1 min-w-0 text-left"
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
                                    {c.live ? (
                                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">
                                        live
                                      </span>
                                    ) : (
                                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${ageBadge(c.days_in_stage)}`}>
                                        {fmtDays(c.days_in_stage)}d
                                      </span>
                                    )}
                                  </div>
                                  {c.live && c.sewing_lines && c.sewing_lines.length > 0 && (
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {c.sewing_lines.map((l) => (
                                        <span key={l} className="text-[9.5px] font-semibold text-[#0f3d24] bg-white border border-line rounded px-1 py-0.5">
                                          Line {l}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                    {selStage === st.stage_key && selRefs.size > 0 && (st.allowed_next || []).length > 0 && (
                      <ColumnBulkBar
                        stageKey={st.stage_key}
                        allowed={st.allowed_next || []}
                        count={selRefs.size}
                        busy={bulkBusy}
                        onClear={clearSelection}
                        onMove={({ toStage, sewingLine }) =>
                          bulkAdvance({
                            fromStage: st.stage_key,
                            toStage,
                            sewingLine,
                            refs: Array.from(selRefs),
                          })
                        }
                      />
                    )}
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

// ── Page wrapper: Production Pipeline hub ────────────────────────────────────
// Merges the former standalone Production Tracker and Production Report pages
// as tabs (same pattern as the Product Development hub). Each tab keeps its
// ORIGINAL page id for permissions; the /production route admits a user who
// can access ANY tab, and /production-report redirects here with ?tab=report.
const ProductionReportTab = React.lazy(() => import("./ProductionReport"));
const ProductionOverviewTab = React.lazy(() => import("./ProductionOverview"));
const ProductionCommandCentreTab = React.lazy(() => import("./ProductionCommandCentre"));
const StyleTrackerTab = React.lazy(() => import("./StyleTracker"));
const ProductionWallboardTab = React.lazy(() => import("./ProductionWallboard"));
const ProductionWorkspaceTab = React.lazy(() => import("./ProductionWorkspace"));
const ProductionExecutionTab = React.lazy(() => import("./ProductionExecution"));
const ProductionInsightsTab = React.lazy(() => import("./ProductionInsights"));

const PROD_TABS = [
  { id: "dashboard", label: "Command Centre", pageId: "production-workspace", el: ProductionCommandCentreTab },
  { id: "overview", label: "Overview", pageId: "production", el: ProductionOverviewTab },
  { id: "tracker", label: "Production Tracker", pageId: "production", el: null },
  { id: "workspace", label: "Planning Workspace", pageId: "production-workspace", el: ProductionWorkspaceTab },
  { id: "capture", label: "Execution Capture", pageId: "production-workspace", el: ProductionExecutionTab },
  { id: "insights", label: "Productivity & Recovery", pageId: "production-workspace", el: ProductionInsightsTab },
  { id: "wallboard", label: "Wallboard", pageId: "production", el: ProductionWallboardTab },
  { id: "report", label: "Production Report", pageId: "production-report", el: ProductionReportTab },
  { id: "style-tracker", label: "Style Launch Planner", pageId: "style-tracker", el: StyleTrackerTab },
];

const ProductionPipelinePage = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const visibleTabs = PROD_TABS.filter((t) => canAccessPage(user, t.pageId));
  const initialTab = (() => {
    const wanted = new URLSearchParams(window.location.search).get("tab");
    return visibleTabs.some((t) => t.id === wanted) ? wanted : (visibleTabs[0]?.id || "tracker");
  })();
  const [tab, setTab] = useState(initialTab);
  useEffect(() => {
    const syncTab = () => {
      const wanted = new URLSearchParams(window.location.search).get("tab");
      if (visibleTabs.some((item) => item.id === wanted)) setTab(wanted);
    };
    window.addEventListener("popstate", syncTab);
    return () => window.removeEventListener("popstate", syncTab);
  }, [visibleTabs]);
  const active = visibleTabs.find((t) => t.id === tab) || visibleTabs[0];
  const ActiveEl = active?.el;
  const selectTab = useCallback((nextTab, extra = {}) => {
    const search = new URLSearchParams(window.location.search);
    search.set("tab", nextTab);
    Object.entries(extra).forEach(([key, value]) => {
      if (value != null && value !== "") search.set(`prod_${key}`, String(value));
    });
    navigate({ pathname: window.location.pathname, search: `?${search.toString()}` });
    setTab(nextTab);
  }, [navigate]);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 border-b border-border overflow-x-auto" data-testid="prod-tabs">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => selectTab(t.id)}
            data-testid={`prod-tab-${t.id}`}
            className={
              "px-3.5 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors whitespace-nowrap " +
              (t.id === active?.id
                ? "border-[#1a5c38] text-[#1a5c38]"
                : "border-transparent text-muted hover:text-foreground")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {active?.id === "tracker" ? (
        <Production />
      ) : ActiveEl ? (
        <React.Suspense fallback={<Loading label="Loading…" />}>
          <ActiveEl
            onOpenReport={
              visibleTabs.some((t) => t.id === "report")
                ? () => selectTab("report")
                : null
            }
            onOpenWorkspace={
              visibleTabs.some((t) => t.id === "workspace")
                ? (plan) => selectTab("workspace", {
                  factory_id: plan?.factory_id,
                  line_id: plan?.line_id,
                  shift_id: plan?.shift_id,
                  plan: plan?.plan_version_id,
                })
                : null
            }
          />
        </React.Suspense>
      ) : null}
    </div>
  );
};

export default ProductionPipelinePage;
