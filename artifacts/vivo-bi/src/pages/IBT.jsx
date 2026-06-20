import React, { useEffect, useMemo, useRef, useState } from "react";
import { useFilters } from "@/lib/filters";
import { useAuth } from "@/lib/auth";
import { api, fmtKES, fmtNum } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import IBTFlatTable from "@/components/IBTFlatTable";
import IBTSuggestionsTable from "@/components/IBTSuggestionsTable";
import IBTOutcomes from "@/components/IBTOutcomes";
import WarehouseToStoreIBT from "@/components/WarehouseToStoreIBT";
import IBTCompletedMoves from "@/components/IBTCompletedMoves";
import IBTMarkAsDoneModal from "@/components/IBTMarkAsDoneModal";
import { useRecommendationState } from "@/lib/useRecommendationState";
import { toast } from "sonner";
import {
  Truck, Coins, Package, MagnifyingGlass, DownloadSimple,
  ListChecks, ChartLineUp, Stack,
} from "@phosphor-icons/react";

const ibtKey = (r) => `${r.style_name}||${r.from_store}||${r.to_store}`;

const IBT = () => {
  const { applied, touchLastUpdated, setPreset } = useFilters();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // Senior Leadership also need access to the Completed Moves report so
  // they can audit IBT picker activity without admin-only navigation.
  const canSeeCompletedMoves = isAdmin || user?.role === "leadership";
  const { dateFrom, dateTo, countries, dataVersion } = applied;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [fromStoreFilter, setFromStoreFilter] = useState("");
  const [toStoreFilter, setToStoreFilter] = useState("");
  const [subcatFilter, setSubcatFilter] = useState("");
  const [showResolved, setShowResolved] = useState(false); // eslint-disable-line no-unused-vars
  const [completedKeys, setCompletedKeys] = useState(new Set());
  const [completedSkuKeys, setCompletedSkuKeys] = useState(new Set());
  const [completedRefresh, setCompletedRefresh] = useState(0);
  const [doneModalRow, setDoneModalRow] = useState(null);
  // B1 — top-level view tabs: live suggestions vs. realised outcomes.
  const [tab, setTab] = useState("suggestions");
  // B1 — cluster-aware matching (A/B/C revenue tiers). Default ON per spec;
  // persisted so a buyer's preference survives reloads.
  const [useClustering, setUseClustering] = useState(() => {
    try { return localStorage.getItem("vivo_ibt_clustering") !== "off"; }
    catch { return true; }
  });
  const setClusteringPersist = (on) => {
    setUseClustering(on);
    try { localStorage.setItem("vivo_ibt_clustering", on ? "on" : "off"); } catch { /* private browsing */ }
  };
  const [exporting, setExporting] = useState(false);
  // Sensitivity preset for the FROM/TO velocity bands. Persists across
  // sessions so a buyer who likes the looser view doesn't have to
  // re-pick it every visit. Default = strict (matches pre-iter-64).
  const [sensitivity, setSensitivity] = useState(() => {
    try { return localStorage.getItem("vivo_ibt_sensitivity") || "strict"; }
    catch { return "strict"; }
  });
  // (low_pct, high_pct) for each preset.
  const SENSITIVITY = {
    strict:   { low: 20, high: 150, label: "Strict",   help: "≤20% / ≥150% of group avg — fewer rows, strongest signals" },
    balanced: { low: 30, high: 130, label: "Balanced", help: "≤30% / ≥130% — surfaces ~3× more stores" },
    wide:     { low: 40, high: 120, label: "Wide",     help: "≤40% / ≥120% — most stores visible, weakest signal" },
  };
  const setSensitivityPersist = (key) => {
    setSensitivity(key);
    try { localStorage.setItem("vivo_ibt_sensitivity", key); } catch { /* private browsing */ }
  };
  // Recommendation pill state retained at module level only because
  // useRecommendationState writes to MongoDB; we no longer surface the
  // pill UI per leadership request — Mark As Done is the single
  // workflow.
  // B1 — full hook: read state + refresh after bulk actions in the
  // priority suggestions accordion.
  const ibtRecState = useRecommendationState("ibt");

  // ALWAYS force "Last 30 days" on this page — leadership directive so
  // store managers don't see stale narrow date windows. Runs once on
  // mount, then subsequent filter-bar changes are respected.
  const forcedRangeRef = useRef(false);
  useEffect(() => {
    if (forcedRangeRef.current) return;
    forcedRangeRef.current = true;
    setPreset("last_30d");
  }, [setPreset]);

  // Load the keys of already-completed suggestions
  // so we can hide them from the live table.
  useEffect(() => {
    let cancelled = false;
    // Iter 89 — when this effect re-runs *because* of a Mark-As-Done
    // (completedRefresh > 0), we MUST bypass the client response cache
    // — otherwise the freshly-completed row keeps showing up in the
    // live list for up to 5 minutes (the api.js default RESP_TTL_MS).
    // Initial mount can use the cache normally.
    const config = completedRefresh > 0 ? { forceFresh: true } : {};
    api.get("/ibt/completed/keys", config)
      .then((r) => {
        if (cancelled) return;
        setCompletedKeys(new Set(r.data?.keys || []));
        setCompletedSkuKeys(new Set(r.data?.sku_keys || []));
      })
      .catch(() => {
        if (cancelled) return;
        setCompletedKeys(new Set());
        setCompletedSkuKeys(new Set());
      });
    return () => { cancelled = true; };
  }, [completedRefresh]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const country = countries.length === 1 ? countries[0] : undefined;
    const { low, high } = SENSITIVITY[sensitivity] || SENSITIVITY.strict;
    api
      .get("/analytics/ibt-suggestions", {
        params: {
          date_from: dateFrom, date_to: dateTo, country,
          limit: 300,
          low_pct: low, high_pct: high,
          use_clustering: useClustering,
        },
        timeout: 180000,
      })
      .then(({ data }) => {
        if (cancelled) return;
        setRows(data || []);
        touchLastUpdated();
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [dateFrom, dateTo, JSON.stringify(countries), dataVersion, sensitivity, useClustering]);

  // B1 — Export to Operations: server-built multi-sheet Excel (one tab per
  // donor store) for the picking team. Streams a blob; bypasses the response
  // cache so each click reflects the latest filters/clustering choice.
  const handleExportOps = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const country = countries.length === 1 ? countries[0] : undefined;
      const resp = await api.get("/ibt/export/operations", {
        params: { date_from: dateFrom, date_to: dateTo, country, use_clustering: useClustering },
        responseType: "blob",
        forceFresh: true,
        timeout: 180000,
      });
      const blob = new Blob([resp.data], {
        type: resp.headers?.["content-type"] ||
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ibt-operations-${dateTo}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Operations workbook downloaded");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Export failed — try again");
    } finally {
      setExporting(false);
    }
  };

  const brands = useMemo(
    () => Array.from(new Set(rows.map((r) => r.brand).filter(Boolean))).sort(),
    [rows]
  );
  const fromStores = useMemo(
    () => Array.from(new Set(rows.map((r) => r.from_store).filter(Boolean))).sort(),
    [rows]
  );
  const toStores = useMemo(
    () => Array.from(new Set(rows.map((r) => r.to_store).filter(Boolean))).sort(),
    [rows]
  );
  const subcats = useMemo(
    () => Array.from(new Set(rows.map((r) => r.subcategory).filter(Boolean))).sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      // Hide entire (style,to) only when a LEGACY (no-SKU) completion
      // exists for it — the new SKU-level keys are used per-row by
      // IBTFlatTable.
      if (completedKeys.has(`${r.style_name}||${r.to_store}||__all__`)) return false;
      if (brandFilter && r.brand !== brandFilter) return false;
      if (fromStoreFilter && r.from_store !== fromStoreFilter) return false;
      if (toStoreFilter && r.to_store !== toStoreFilter) return false;
      if (subcatFilter && r.subcategory !== subcatFilter) return false;
      if (!q) return true;
      return (
        (r.style_name || "").toLowerCase().includes(q) ||
        (r.from_store || "").toLowerCase().includes(q) ||
        (r.to_store || "").toLowerCase().includes(q)
      );
    });
  }, [rows, search, brandFilter, fromStoreFilter, toStoreFilter, subcatFilter, completedKeys]);

  // RecommendationActionPill removed per leadership; we just show the
  // pending list. Mark-as-Done filters via `completedKeys` further up.
  const visible = filtered;

  const kpis = useMemo(() => {
    const totalUplift = filtered.reduce((s, r) => s + (r.estimated_uplift || 0), 0);
    const totalUnits = filtered.reduce((s, r) => s + (r.units_to_move || 0), 0);
    const storesInvolved = new Set();
    filtered.forEach((r) => { storesInvolved.add(r.from_store); storesInvolved.add(r.to_store); });
    return {
      moves: filtered.length,
      totalUnits,
      totalUplift,
      storesInvolved: storesInvolved.size,
    };
  }, [filtered]);

  return (
    <div className="space-y-6" data-testid="ibt-page">
      <div>
        <p className="text-muted text-[13px] mt-1 max-w-3xl">
          Moves a SKU from a store where it isn't selling to one where it is.
          Rule: the <b>from</b>-store sells at ≤ 20% of the group average for
          that style while having available stock; the <b>to</b>-store sells
          at ≥ 150% of average while running low. Warehouses are excluded —
          only store-to-store moves.
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-border" role="tablist" data-testid="ibt-tabs">
        {[
          { id: "suggestions", label: "Suggestions", icon: ListChecks },
          { id: "outcomes", label: "Outcomes", icon: ChartLineUp },
        ].map((t) => {
          const TabIcon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              data-testid={`ibt-tab-${t.id}`}
              className={`inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold border-b-2 -mb-px transition-colors ${
                active
                  ? "border-brand text-brand-deep"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              <TabIcon size={15} weight={active ? "fill" : "regular"} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === "outcomes" && <IBTOutcomes dataVersion={dataVersion} />}

      {tab === "suggestions" && loading && <Loading label="Analyzing sell-through across stores…" />}
      {tab === "suggestions" && error && <ErrorBox message={error} />}

      {tab === "suggestions" && !loading && !error && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KPICard testId="ibt-kpi-moves" accent label="Open moves"
              sub="All pending review"
              value={fmtNum(kpis.moves)} icon={Truck} showDelta={false} />
            <KPICard testId="ibt-kpi-units" label="Units To Move" value={fmtNum(kpis.totalUnits)} icon={Package} showDelta={false} />
            <KPICard testId="ibt-kpi-uplift" label="Est. Revenue Uplift" value={fmtKES(kpis.totalUplift)} icon={Coins} showDelta={false} />
            <KPICard testId="ibt-kpi-stores" label="Stores Involved" value={fmtNum(kpis.storesInvolved)} showDelta={false} />
          </div>

          <div className="card-white p-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 input-pill flex-1 min-w-[200px]">
              <MagnifyingGlass size={14} className="text-muted" />
              <input
                placeholder="Search style or store…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="ibt-search"
                className="bg-transparent outline-none text-[13px] w-full"
              />
            </div>
            <select
              className="input-pill"
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              data-testid="ibt-brand-filter"
            >
              <option value="">All brands</option>
              {brands.map((b) => <option key={b}>{b}</option>)}
            </select>
            <select
              className="input-pill"
              value={fromStoreFilter}
              onChange={(e) => setFromStoreFilter(e.target.value)}
              data-testid="ibt-from-store-filter"
              title="Show only moves leaving this store"
            >
              <option value="">All FROM stores</option>
              {fromStores.map((s) => <option key={s}>{s}</option>)}
            </select>
            <select
              className="input-pill"
              value={toStoreFilter}
              onChange={(e) => setToStoreFilter(e.target.value)}
              data-testid="ibt-to-store-filter"
              title="Show only moves arriving at this store"
            >
              <option value="">All TO stores</option>
              {toStores.map((s) => <option key={s}>{s}</option>)}
            </select>
            <select
              className="input-pill"
              value={subcatFilter}
              onChange={(e) => setSubcatFilter(e.target.value)}
              data-testid="ibt-subcat-filter"
              title="Show only moves for this subcategory"
            >
              <option value="">All subcategories</option>
              {subcats.map((s) => <option key={s}>{s}</option>)}
            </select>
            {(brandFilter || fromStoreFilter || toStoreFilter || subcatFilter || search) && (
              <button
                type="button"
                onClick={() => {
                  setBrandFilter("");
                  setFromStoreFilter("");
                  setToStoreFilter("");
                  setSubcatFilter("");
                  setSearch("");
                }}
                data-testid="ibt-clear-filters"
                className="text-[11px] text-muted underline hover:text-brand"
              >
                clear
              </button>
            )}
            <div className="flex-1" />
            <button
              type="button"
              role="switch"
              aria-checked={useClustering}
              onClick={() => setClusteringPersist(!useClustering)}
              data-testid="ibt-clustering-toggle"
              title="Match stores within the same or adjacent revenue tier (A/B/C). Off = chain-wide matching."
              className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${
                useClustering
                  ? "bg-brand/10 text-brand-deep border-brand/40"
                  : "bg-white text-muted border-border hover:border-brand/40"
              }`}
            >
              <Stack size={13} weight="bold" />
              Cluster-aware {useClustering ? "on" : "off"}
            </button>
            <button
              type="button"
              onClick={handleExportOps}
              disabled={exporting}
              data-testid="ibt-export-operations"
              title="Download a multi-sheet Excel workbook (one tab per donor store) for the picking team"
              className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-white bg-brand hover:bg-brand-deep disabled:opacity-50 px-3 py-1.5 rounded-lg"
            >
              <DownloadSimple size={13} weight="bold" />
              {exporting ? "Exporting…" : "Export to Operations"}
            </button>
          </div>

          <div className="card-white p-4 sm:p-5" data-testid="ibt-priority-card">
            <SectionTitle
              title="Priority transfers"
              subtitle="Grouped by style and ranked by transfer score (donor surplus + destination demand). Expand a style to see every donor → needer pair, store revenue-cluster (A/B/C), the projected weeks-of-cover left at source, and the SKU-level size run. Select rows for bulk Mark Done / Dismiss / Export."
            />
            <IBTSuggestionsTable
              suggestions={visible}
              recState={ibtRecState}
              onMarkDone={(payload) => setDoneModalRow(payload)}
              emptyLabel={
                filtered.length === 0
                  ? "No transfer opportunities found for the current window. Try widening the date range or turning off cluster-aware matching."
                  : "All transfer moves have been actioned."
              }
            />
          </div>

          <div className="card-white p-4 sm:p-5" data-testid="ibt-table-card">
            <SectionTitle
              title={`Store → Store transfer list · ${visible.length} suggestions`}
              subtitle="Each row is one SKU (color × size). Type the units you actually transferred, then tap Mark As Done to log the PO and remove it from this list. Tablet-friendly — scroll horizontally to see all columns."
              action={
                <div className="inline-flex items-center gap-2 text-[11.5px]" data-testid="ibt-sensitivity">
                  <span className="font-semibold text-foreground/80">Sensitivity:</span>
                  <div className="inline-flex border border-border rounded-lg overflow-hidden">
                    {Object.entries(SENSITIVITY).map(([key, cfg]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSensitivityPersist(key)}
                        title={cfg.help}
                        data-testid={`ibt-sensitivity-${key}`}
                        className={`px-2.5 py-1 font-bold transition-colors ${
                          sensitivity === key
                            ? "bg-brand text-white"
                            : "bg-white text-foreground/70 hover:bg-panel"
                        }`}
                      >
                        {cfg.label}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10.5px] text-muted">
                    ≤{SENSITIVITY[sensitivity].low}% / ≥{SENSITIVITY[sensitivity].high}%
                  </span>
                </div>
              }
            />
            <IBTFlatTable
              suggestions={visible}
              flow="store_to_store"
              onMarkDone={(payload) => setDoneModalRow(payload)}
              completedSkuKeys={completedSkuKeys}
              testId="ibt-table"
              emptyLabel={
                filtered.length === 0
                  ? "No transfer opportunities found for the current window. Try widening the date range."
                  : "All transfer moves have been actioned."
              }
            />
          </div>

          <div className="card-white p-4 bg-panel">
            <div className="text-[12.5px] text-muted">
              <span className="font-semibold text-foreground">How it works:</span>{" "}
              For each style that lives in at least two stores, the algorithm
              compares per-store sell-through to the group average. A move is
              suggested when a store with inventory isn't selling and another
              store is selling strongly but running low. Qty is bounded by the
              smaller of: <i>from-store buffer (2 units)</i> and
              <i> to-store 2-week cover target</i>. Warehouses are always
              excluded. Tap <b className="text-emerald-700">Mark As Done</b> on
              any row to log it to the Completed Moves table below and hide
              it from the live list.
            </div>
          </div>

          <WarehouseToStoreIBT
            dateFrom={dateFrom}
            dateTo={dateTo}
            countries={countries}
            onMarkDone={async (r) => {
              // Iter 88t — One-click "Done" for warehouse→store IBT.
              // Skips the modal entirely; the backend fills in PO#,
              // completed-by name, and transfer date with sensible
              // defaults. The store→store flow still uses the modal
              // (it surfaces the audit fields the picker fills in by
              // hand).
              try {
                await api.post("/ibt/complete", {
                  style_name: r.style_name,
                  brand: r.brand || null,
                  subcategory: r.subcategory || null,
                  from_store: r.from_store,
                  to_store: r.to_store,
                  units_to_move: Number(r.units_to_move || r.suggested_units || 1),
                  actual_units_moved: Number(r.units_to_move || r.suggested_units || 1),
                  flow: "warehouse_to_store",
                  sku: r.sku || null,
                  color: r.color || null,
                  size: r.size || null,
                  barcode: r.barcode || null,
                });
                // Trigger the completed-moves list + parent SKU-keys
                // refresh so the row vanishes from the live table.
                setCompletedRefresh((k) => k + 1);
              } catch (e) {
                // Surface failure inline so the row isn't silently lost.
                // eslint-disable-next-line no-console
                console.error("[IBT warehouse→store] one-click done failed:", e);
                alert(e?.response?.data?.detail || e?.message || "Failed to mark as done");
              }
            }}
            completedSkuKeys={completedSkuKeys}
          />

          {canSeeCompletedMoves && (
            <IBTCompletedMoves refreshKey={completedRefresh} />
          )}

          {doneModalRow && (
            <IBTMarkAsDoneModal
              row={doneModalRow}
              onClose={() => setDoneModalRow(null)}
              onSubmitted={() => {
                setDoneModalRow(null);
                setCompletedRefresh((n) => n + 1);
              }}
            />
          )}
        </>
      )}
    </div>
  );
};

export default IBT;
