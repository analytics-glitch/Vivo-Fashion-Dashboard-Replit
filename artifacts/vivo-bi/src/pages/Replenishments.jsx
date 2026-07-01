import React, { useEffect, useMemo, useState, useCallback } from "react";
import { api, fmtNum } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canManageRoster } from "@/lib/roster";
import { useFilters } from "@/lib/filters";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import { useTableSort, SortableTh } from "@/lib/useTableSort";
import {
  CheckCircle, Package, ArrowCounterClockwise, MagnifyingGlass,
  Warning, Info, CaretDown, CaretRight, Clock, Lightning,
  ArrowsClockwise, X as XIcon, Prohibit, ArrowUUpLeft,
  Truck, CalendarBlank, Trash, PaperPlaneTilt,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import ReplenishmentTransferReport from "@/components/ReplenishmentTransferReport";
import ReplenishmentRosterCard from "@/components/ReplenishmentRosterCard";

/**
 * SOR-first Daily Replenishment (Phase 1).
 *
 * The pick list is driven by the canonical Sell-Out Rate engine
 * (`/analytics/replenishment-sor`): SOR = units_sold ÷ (units_sold +
 * saleable store stock), warehouse excluded. The page surfaces:
 *  • An "as-of 06:00 EAT" business-date chip + a 4 / 8 / 12-week demand
 *    lookback selector (the named SOR window) — independent of the global
 *    date bar, which is locked for this page.
 *  • A SOR KPI strip: current SOR, saleable SOR (broken-curve orphans
 *    netted out), projected SOR + uplift, deployable warehouse units,
 *    SOR-at-risk units and SOR-drag (overstock) units.
 *  • A pick list ranked DEPLOY-NOW first (a proven-demand store/Online at
 *    zero shelf stock with warehouse cover — the single highest-SOR move),
 *    then by honest projected SOR-uplift.
 *  • A Held-back panel: candidates deliberately not moved (retired /
 *    overstock / broken-curve), each merch-overridable via a Release button.
 *
 * Done-state is written through the recommendations ledger (twin sku +
 * barcode rows) which the engine reads back as `replenished`, so the
 * Completed audit + Transfer Tracking reconcile exactly.
 */

const fmtColourPrint = (r) => (r?.color_print || "").trim();

// Canonical, collision-safe row identity for selection + optimistic updates.
// Includes sku AND barcode so rows at the same POS with a blank/duplicate
// barcode can't collapse onto one key (engine read-back prefers sku).
const rowKey = (r) => `${r?.pos_location || ""}|${r?.sku || ""}|${r?.barcode || ""}`;

const LOOKBACKS = [4, 8, 12];

const CLASS_BADGE = {
  A: "bg-emerald-100 text-emerald-900 border-emerald-300",
  B: "bg-sky-100 text-sky-900 border-sky-300",
  C: "bg-slate-100 text-slate-700 border-slate-300",
};
const CLASS_LABEL = { A: "A · fast", B: "B · core", C: "C · slow" };

const HELD_REASON = {
  retired: { label: "Retired / EOL", cls: "bg-slate-100 text-slate-700 border-slate-300" },
  markdown: { label: "Markdown / clearance", cls: "bg-rose-100 text-rose-900 border-rose-300" },
  overstock: { label: "Overstock (WoC > 16)", cls: "bg-amber-100 text-amber-900 border-amber-300" },
  broken_curve: { label: "Broken-curve orphan", cls: "bg-violet-100 text-violet-900 border-violet-300" },
};

const Replenishments = () => {
  const { user } = useAuth();
  const isAdmin = canManageRoster(user);

  // Global filters drive only the country/channel-scoped support panels
  // (stockout banner, chronic). The SOR pick list owns its own demand window.
  const { applied } = useFilters();
  const filterCountry = applied.countries.length === 1 ? applied.countries[0] : undefined;
  const filterChannel = applied.channels.length ? applied.channels.join(",") : undefined;
  const filterKey = JSON.stringify([applied.countries, applied.channels, applied.dataVersion]);

  // SOR demand window (named lookback): default 4 weeks, switchable to 8/12.
  const [weeks, setWeeks] = useState(4);

  // SOR engine result.
  const [sor, setSor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [actuals, setActuals] = useState({});
  const [transferRefs, setTransferRefs] = useState({});
  const [savingKey, setSavingKey] = useState(null);
  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");

  const [selected, setSelected] = useState(() => new Set());
  const [bulkSaving, setBulkSaving] = useState(false);

  // Held-back panel.
  const [heldOpen, setHeldOpen] = useState(false);
  const [releasingKey, setReleasingKey] = useState(null);

  // Completed report.
  const [completed, setCompleted] = useState({ rows: [], total: 0 });
  const [completedLoading, setCompletedLoading] = useState(false);
  const [completedRefresh, setCompletedRefresh] = useState(0);

  // Picker accountability scorecard (Phase 2 — built on fact_pick_event facts).
  const [scorecard, setScorecard] = useState(null);

  // Post-replenishment SOR reconciliation (Phase 3 step 4 — "did SOR rise?").
  const [recon, setRecon] = useState(null);

  // Support panels.
  const [alerts, setAlerts] = useState(null);
  const [alertDismissed, setAlertDismissed] = useState(false);
  const [chronic, setChronic] = useState(null);
  const [chronicOpen, setChronicOpen] = useState(false);

  // Distribution batches (Save & distribute → frozen dated pick list).
  const [distributions, setDistributions] = useState({ batches: [], open_keys: [] });
  const [distLoading, setDistLoading] = useState(false);
  const [distSaving, setDistSaving] = useState(false);
  const [batchSavingKey, setBatchSavingKey] = useState(null);
  const [scorecardDay, setScorecardDay] = useState(
    () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10));

  const liveSort = useTableSort();
  const completedSort = useTableSort();

  const loadSor = useCallback(async (opts = {}) => {
    setLoading(true);
    setError(null);
    try {
      const { data: d } = await api.get("/analytics/replenishment-sor", {
        params: { weeks, ...(opts.forceFresh ? { nocache: 1 } : {}) },
        timeout: 240000,
        forceFresh: !!opts.forceFresh,
      });
      setSor(d || null);
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    } finally {
      setLoading(false);
    }
  }, [weeks]);

  useEffect(() => { loadSor(); }, [loadSor]);

  // Reconciliation tile (also records the rolling projection-calibration sample).
  useEffect(() => {
    let cancel = false;
    api.get("/analytics/replenishment-sor-reconciliation", { params: { weeks } })
      .then(({ data }) => { if (!cancel) setRecon(data || null); })
      .catch(() => { if (!cancel) setRecon(null); });
    return () => { cancel = true; };
  }, [weeks, completedRefresh]);

  // Completed report — admin/owner only (chain-wide audit).
  useEffect(() => {
    if (!isAdmin) return;
    let cancel = false;
    setCompletedLoading(true);
    api.get("/analytics/replenishment-completed", { params: { days: 30 }, forceFresh: completedRefresh > 0 })
      .then(({ data: c }) => { if (!cancel) setCompleted(c || { rows: [], total: 0 }); })
      .catch(() => { if (!cancel) setCompleted({ rows: [], total: 0 }); })
      .finally(() => { if (!cancel) setCompletedLoading(false); });
    api.get("/analytics/replenishment-picker-scorecard", { params: { days: 30 }, forceFresh: completedRefresh > 0 })
      .then(({ data: s }) => { if (!cancel) setScorecard(s || null); })
      .catch(() => { if (!cancel) setScorecard(null); });
    return () => { cancel = true; };
  }, [isAdmin, completedRefresh]);

  // Distribution batches (frozen pick lists with per-line Done/Outstanding).
  const loadDistributions = useCallback(async () => {
    if (!isAdmin) return;
    setDistLoading(true);
    try {
      const { data } = await api.get("/replenishment/distributions", { params: { limit: 20 }, forceFresh: true });
      setDistributions(data || { batches: [], open_keys: [] });
    } catch {
      setDistributions({ batches: [], open_keys: [] });
    } finally {
      setDistLoading(false);
    }
  }, [isAdmin]);
  useEffect(() => { loadDistributions(); }, [loadDistributions]);

  // Predictive stockout alerts (styles dropping below 2 weeks of cover).
  useEffect(() => {
    let cancel = false;
    api.get("/replenishment/stockout-alerts", { params: { country: filterCountry, channel: filterChannel } })
      .then(({ data }) => { if (!cancel) { setAlerts(data || null); setAlertDismissed(false); } })
      .catch(() => { if (!cancel) setAlerts(null); });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // Chronic stockouts (at risk 3+ consecutive snapshot weeks).
  useEffect(() => {
    let cancel = false;
    api.get("/replenishment/chronic-stockouts", { params: { min_weeks: 3 } })
      .then(({ data }) => { if (!cancel) setChronic(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancel) setChronic([]); });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied.dataVersion]);

  const rows = sor?.rows || [];
  const heldBack = sor?.held_back || [];
  const kpi = sor?.kpi || null;

  // (pos|sku) frozen into an open batch — these drop out of the live pick list
  // (they live in their batch until picked) so the list refills with new items.
  const openKeys = useMemo(
    () => new Set(distributions.open_keys || []), [distributions]);

  // Active = every open, not-yet-distributed line (ignores owner/search filters).
  // This is the exact snapshot that "Save & distribute" freezes into a batch.
  const activeRows = useMemo(
    () => rows.filter((r) => !r.replenished && !openKeys.has(`${r.pos_location}|${r.sku}`)),
    [rows, openKeys]);

  // Workload by picker, computed over the SAME activeRows that "Save & distribute"
  // freezes — so the per-picker totals (lines/units/stores) always reconcile with
  // the "(N)" on the button. (The server's sor.by_owner counts the full engine
  // list incl. rows already frozen into open batches or already picked, which
  // diverges from what's actually about to be distributed.)
  const workloadByOwner = useMemo(() => {
    const agg = {};
    for (const r of activeRows) {
      const owner = r.owner || "—";
      const o = agg[owner] || (agg[owner] = { owner, lines: 0, units: 0, stores: new Set() });
      o.lines += 1;
      o.units += Number(r.replenish || 0);
      o.stores.add(r.pos_location);
    }
    return Object.values(agg)
      .map((o) => ({ owner: o.owner, lines: o.lines, units: o.units, stores: o.stores.size }))
      .sort((a, b) => b.units - a.units);
  }, [activeRows]);

  // Distinct owners present in the open pick list, for the owner filter dropdown.
  const ownerOptions = useMemo(() => {
    const set = new Set();
    activeRows.forEach((r) => { if (r.owner) set.add(r.owner); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [activeRows]);

  // If the active owner filter is no longer present (e.g. after a redistribute),
  // clear it so the table doesn't silently show nothing.
  useEffect(() => {
    if (ownerFilter && !ownerOptions.includes(ownerFilter)) setOwnerFilter("");
  }, [ownerOptions, ownerFilter]);

  // Visible rows = drop already-completed + owner filter + free-text search. The
  // backend already ranks deploy-now first, so we preserve that order until a
  // header click overrides it.
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => !r.replenished)
      .filter((r) => !openKeys.has(`${r.pos_location}|${r.sku}`))
      .filter((r) => !ownerFilter || (r.owner || "") === ownerFilter)
      .filter((r) => {
        if (!q) return true;
        return (
          (r.pos_location || "").toLowerCase().includes(q)
          || (r.product_name || "").toLowerCase().includes(q)
          || (r.size || "").toLowerCase().includes(q)
          || (r.barcode || "").toLowerCase().includes(q)
          || (r.sku || "").toLowerCase().includes(q)
          || (r.bin || "").toLowerCase().includes(q)
          || fmtColourPrint(r).toLowerCase().includes(q)
        );
      });
  }, [rows, search, ownerFilter, openKeys]);

  const sortedVisibleRows = useMemo(() => {
    return liveSort.sortRows(visibleRows, {
      owner: (r) => r.owner || "",
      pos_location: (r) => r.pos_location || "",
      product_name: (r) => r.product_name || "",
      size: (r) => r.size || "",
      barcode: (r) => r.barcode || "",
      bin: (r) => r.bin || "",
      colour_print: (r) => fmtColourPrint(r),
      sku_class: (r) => r.sku_class || "",
      units_sold: (r) => Number(r.units_sold ?? 0),
      soh_store: (r) => Number(r.soh_store ?? 0),
      soh_wh: (r) => Number(r.soh_wh ?? 0),
      woc: (r) => Number(r.woc ?? 0),
      days_lapsed: (r) => Number(r.days_lapsed ?? 0),
      replenish: (r) => Number(r.replenish ?? 0),
      proj_uplift_units: (r) => Number(r.proj_uplift_units ?? 0),
    });
  }, [liveSort, visibleRows]);

  // Corridor grouping (spec §5): pickers dispatch one geographic corridor at a
  // time. No corridor data model exists yet (corridor cadence is Phase 3), so we
  // use country as the dispatch-corridor proxy. Corridors are ordered by total
  // projected SOR-uplift; within each corridor the active sort/uplift rank is
  // preserved (we iterate the already-sorted rows).
  const corridorGroups = useMemo(() => {
    const map = new Map();
    for (const r of sortedVisibleRows) {
      const c = r.country || "—";
      if (!map.has(c)) map.set(c, { corridor: c, rows: [], uplift: 0, units: 0 });
      const g = map.get(c);
      g.rows.push(r);
      g.uplift += Number(r.proj_uplift_units ?? 0);
      g.units += Number(r.replenish ?? 0);
    }
    return Array.from(map.values()).sort((a, b) => b.uplift - a.uplift);
  }, [sortedVisibleRows]);

  const setActual = (k, v) => setActuals((prev) => ({ ...prev, [k]: v }));

  // Persist done-state through the recommendations ledger (twin sku + barcode
  // rows) which the SOR engine reads back as `replenished`.
  const markRowsDone = useCallback(async (toMark) => {
    const actions = [];
    for (const r of toMark) {
      const k = rowKey(r);
      const raw = actuals[k];
      const actual = raw === "" || raw == null ? Number(r.replenish || 0) : Number(raw);
      const au = Number.isNaN(actual) || actual < 0 ? Number(r.replenish || 0) : actual;
      const ref = (transferRefs[k] ?? "").trim() || undefined;
      if (r.sku) actions.push({ rec_type: "replenish", rec_key: `${r.pos_location}|sku|${r.sku}`, status: "done", actual_units: au, transfer_ref: ref });
      if (r.barcode) actions.push({ rec_type: "replenish", rec_key: `${r.pos_location}|barcode|${r.barcode}`, status: "done", actual_units: au, transfer_ref: ref });
    }
    if (!actions.length) {
      toast.error("Selected lines have no SKU or barcode to action.");
      return false;
    }
    await api.post("/recommendations/bulk", { actions });
    const keys = new Set(toMark.map((r) => rowKey(r)));
    setSor((prev) => prev && ({
      ...prev,
      rows: (prev.rows || []).map((r) =>
        keys.has(rowKey(r)) ? { ...r, replenished: true } : r),
    }));
    setCompletedRefresh((t) => t + 1);
    return true;
  }, [actuals, transferRefs]);

  const markAsDone = async (row) => {
    const k = rowKey(row);
    setSavingKey(k);
    try {
      const ok = await markRowsDone([row]);
      if (ok) toast.success("Marked done.");
    } catch (e) {
      toast.error("Couldn't save — " + (e?.response?.data?.detail || e.message));
    } finally {
      setSavingKey(null);
    }
  };

  const toggleSelect = useCallback((k) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  const allVisibleSelected = sortedVisibleRows.length > 0
    && sortedVisibleRows.every((r) => selected.has(rowKey(r)));

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const keys = sortedVisibleRows.map((r) => rowKey(r));
      const everySelected = keys.length > 0 && keys.every((k) => prev.has(k));
      if (everySelected) {
        const next = new Set(prev);
        keys.forEach((k) => next.delete(k));
        return next;
      }
      return new Set([...prev, ...keys]);
    });
  }, [sortedVisibleRows]);

  const bulkApprove = useCallback(async () => {
    const toMark = sortedVisibleRows.filter((r) => selected.has(rowKey(r)));
    if (!toMark.length) return;
    setBulkSaving(true);
    try {
      const ok = await markRowsDone(toMark);
      if (ok) {
        setSelected(new Set());
        toast.success(`Approved ${toMark.length} line${toMark.length === 1 ? "" : "s"}.`);
      }
    } catch (e) {
      toast.error("Bulk approve failed — " + (e?.response?.data?.detail || e.message));
    } finally {
      setBulkSaving(false);
    }
  }, [sortedVisibleRows, selected, markRowsDone]);

  // Held-back → release back into the pick list (merch override, persists).
  const releaseHeld = useCallback(async (row) => {
    const k = `${row.pos_location}|${row.sku}`;
    setReleasingKey(k);
    try {
      await api.post("/analytics/replenishment-sor/holdback-override", {
        pos_location: row.pos_location, sku: row.sku, action: "release",
      });
      toast.success("Released — refreshing pick list…");
      await loadSor({ forceFresh: true });
    } catch (e) {
      toast.error("Release failed — " + (e?.response?.data?.detail || e.message));
    } finally {
      setReleasingKey(null);
    }
  }, [loadSor]);

  // Freeze the current open pick list into a dated distribution batch.
  const distributeNow = useCallback(async () => {
    if (!activeRows.length) { toast.error("No open lines to distribute."); return; }
    if (!window.confirm(
      `Freeze ${activeRows.length} line${activeRows.length === 1 ? "" : "s"} into a new distribution batch?\n\n`
      + `They move to "Distributed batches" below and the live list refills with new items as they arise.`)) return;
    setDistSaving(true);
    try {
      const lines = activeRows.map((r) => ({
        pos_location: r.pos_location, sku: r.sku, barcode: r.barcode,
        style_name: r.style_name, product_name: r.product_name,
        size: r.size, color_print: r.color_print, owner: r.owner,
        suggested_units: Number(r.replenish || 0),
      }));
      const { data } = await api.post("/replenishment/distribute", { lines, weeks });
      toast.success(`Distributed ${data?.line_count ?? lines.length} line${(data?.line_count ?? lines.length) === 1 ? "" : "s"}.`);
      await Promise.all([loadDistributions(), loadSor({ forceFresh: true })]);
    } catch (e) {
      toast.error("Distribute failed — " + (e?.response?.data?.detail || e.message));
    } finally {
      setDistSaving(false);
    }
  }, [activeRows, weeks, loadDistributions, loadSor]);

  // Mark a single distributed line picked (twin sku + barcode ledger rows).
  const markBatchLineDone = useCallback(async (line) => {
    const k = `${line.pos_location}|${line.sku || ""}|${line.barcode || ""}`;
    setBatchSavingKey(k);
    try {
      const au = Number(line.suggested_units || 0);
      const actions = [];
      if (line.sku) actions.push({ rec_type: "replenish", rec_key: `${line.pos_location}|sku|${line.sku}`, status: "done", actual_units: au });
      if (line.barcode) actions.push({ rec_type: "replenish", rec_key: `${line.pos_location}|barcode|${line.barcode}`, status: "done", actual_units: au });
      if (!actions.length) { toast.error("Line has no SKU or barcode."); return; }
      await api.post("/recommendations/bulk", { actions });
      toast.success("Marked done.");
      await Promise.all([loadDistributions(), loadSor({ forceFresh: true })]);
    } catch (e) {
      toast.error("Couldn't save — " + (e?.response?.data?.detail || e.message));
    } finally {
      setBatchSavingKey(null);
    }
  }, [loadDistributions, loadSor]);

  const deleteBatch = useCallback(async (id) => {
    if (!window.confirm("Remove this distribution batch? The done marks already recorded stay; only the batch record is cleared.")) return;
    try {
      await api.delete(`/replenishment/distributions/${id}`);
      toast.success("Batch removed.");
      await Promise.all([loadDistributions(), loadSor({ forceFresh: true })]);
    } catch (e) {
      toast.error("Couldn't remove — " + (e?.response?.data?.detail || e.message));
    }
  }, [loadDistributions, loadSor]);

  // Per-picker day scorecard derived from the distribution batches: Done counts
  // the selected EAT day; Outstanding is every not-yet-done line across all open
  // batches (day-independent — it's what each picker still owes).
  const dayScorecard = useMemo(() => {
    const byOwner = new Map();
    for (const b of distributions.batches || []) {
      for (const ln of b.lines || []) {
        const owner = ln.owner || "Unassigned";
        const e = byOwner.get(owner) || { owner, doneDay: 0, doneUnitsDay: 0, outstanding: 0, outstandingUnits: 0 };
        if (ln.done) {
          if (ln.done_day_eat === scorecardDay) {
            e.doneDay += 1;
            e.doneUnitsDay += Number(ln.done_units || 0);
          }
        } else {
          e.outstanding += 1;
          e.outstandingUnits += Number(ln.suggested_units || 0);
        }
        byOwner.set(owner, e);
      }
    }
    return Array.from(byOwner.values()).sort((a, b) => a.owner.localeCompare(b.owner));
  }, [distributions, scorecardDay]);

  return (
    <div className="space-y-5" data-testid="replenishments-page">
      {/* Predictive stockout banner. */}
      {alerts && !alertDismissed && (alerts.total ?? 0) > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3" role="alert" data-testid="replen-stockout-banner">
          <Warning size={18} weight="fill" className="text-rose-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0 text-[12.5px] text-rose-900">
            <b>{fmtNum(alerts.total)}</b> style{alerts.total === 1 ? "" : "s"} will stock out within 2 weeks.
            {(alerts.critical_count ?? 0) > 0 && (<> <span className="font-semibold">{fmtNum(alerts.critical_count)} critical</span>.</>)}
            {(alerts.warning_count ?? 0) > 0 && (<> {fmtNum(alerts.warning_count)} on watch.</>)}
          </div>
          <button type="button" onClick={() => setAlertDismissed(true)} className="text-rose-500 hover:text-rose-700 shrink-0" aria-label="Dismiss stockout alert" data-testid="replen-banner-dismiss">
            <XIcon size={15} weight="bold" />
          </button>
        </div>
      )}

      {/* Chronic stockouts. */}
      {chronic && chronic.length > 0 && (
        <div className="card-white p-0 overflow-hidden" data-testid="replen-chronic-panel">
          <button type="button" onClick={() => setChronicOpen((o) => !o)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-panel/40" data-testid="replen-chronic-toggle">
            <span className="inline-flex items-center gap-2 font-extrabold text-[13.5px] text-[#0f3d24]">
              <Warning size={15} weight="duotone" className="text-amber-600" />
              Chronic stockouts · {fmtNum(chronic.length)} style{chronic.length === 1 ? "" : "s"} at risk 3+ weeks
            </span>
            {chronicOpen ? <CaretDown size={15} weight="bold" /> : <CaretRight size={15} weight="bold" />}
          </button>
          {chronicOpen && (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full min-w-max text-[12px]">
                <thead className="bg-panel">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Style</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Country</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Brand</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Subcategory</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Weeks at risk</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Avg units/wk</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Avg WoC</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">First flagged</th>
                  </tr>
                </thead>
                <tbody>
                  {chronic.map((c, i) => (
                    <tr key={`${c.style_name}-${c.country}-${i}`} className={`border-t border-border/50 ${i % 2 === 0 ? "bg-white" : "bg-panel/30"}`} data-testid={`replen-chronic-row-${i}`}>
                      <td className="px-3 py-2 whitespace-nowrap font-semibold">{c.style_name || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{c.country || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{c.brand || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{c.subcategory || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className="inline-flex items-center bg-rose-100 text-rose-800 border border-rose-300 font-bold px-2 py-0.5 rounded-full">{fmtNum(c.consecutive_at_risk_weeks)}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(c.avg_weekly_units)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{c.avg_woc == null ? "—" : Number(c.avg_woc).toFixed(1)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted">{c.first_flagged_date || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div>
        <p className="text-[12.5px] text-muted mt-1 max-w-3xl">
          Ranked by <b>Sell-Out Rate</b> — units sold ÷ (units sold + saleable store
          stock), warehouse excluded. We move proven-demand SKUs from the warehouse
          to the shop floor, highest-SOR action first. Stores draw on their own
          stock; Online (Shop Zetu) is its own pool. Other online channels excluded.
        </p>
      </div>

      {/* Picker roster (admin / authorised operators) — shared with Replenish
          by Style/SKU. Saving redistributes line owners across the SOR pick list
          below by EQUAL UNITS; a reload never reshuffles a picker's lines. */}
      {isAdmin && (
        <ReplenishmentRosterCard
          isAdmin={isAdmin}
          onSaved={() => loadSor({ forceFresh: true })}
          subtitle="Who is picking the Daily Replenishments today? Saving here redistributes the SOR pick list across the roster by EQUAL UNITS — POS sorted so each person owns a contiguous block of stores. The split is then fixed: reloading won't reshuffle anyone, so a picker who finishes early can refresh without being handed new work. Shared with Replenish by Style/SKU."
        />
      )}

      {isAdmin && workloadByOwner.length > 0 && (
        <div className="card-white p-4" data-testid="replen-workload">
          <SectionTitle title="Workload by picker" subtitle="How the open pick list (what Save & distribute will freeze) splits across the roster (units · lines · stores)." />
          <div className="flex flex-wrap gap-2">
            {workloadByOwner.map((o) => (
              <span key={o.owner} className="inline-flex items-center gap-2 rounded-full border border-border bg-panel/40 px-3 py-1.5 text-[12px]" data-testid={`replen-workload-${o.owner}`}>
                <span className="font-bold text-[#0f3d24]">{o.owner}</span>
                <span className="tabular-nums">{fmtNum(o.units)} units</span>
                <span className="text-muted tabular-nums">· {fmtNum(o.lines)} lines · {fmtNum(o.stores)} stores</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* SOR pick list card. */}
      <div className="card-white p-5" data-testid="replen-live-card">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <h2 className="font-extrabold text-[14px] text-[#0f3d24] inline-flex items-center gap-2">
            <Package size={16} weight="duotone" /> SOR pick list
          </h2>
          {sor && (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand" data-testid="replen-as-of">
              <Clock size={14} weight="bold" /> As of {sor.as_of}
            </span>
          )}
          {sor && (
            <span className="text-[10.5px] font-medium text-muted">
              ruleset {sor.ruleset_version}{sor.run_id ? ` · run ${String(sor.run_id).slice(0, 8)}` : ""}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11.5px] font-semibold text-muted">Demand window</span>
            <div className="inline-flex rounded-full border border-border overflow-hidden" role="group" data-testid="replen-lookback">
              {LOOKBACKS.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setWeeks(w)}
                  className={`px-3 py-1.5 text-[12px] font-semibold ${weeks === w ? "bg-emerald-700 text-white" : "bg-white text-foreground hover:bg-panel"}`}
                  data-testid={`replen-lookback-${w}`}
                >
                  {w}w
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => loadSor({ forceFresh: true })}
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand-deep border border-border hover:bg-panel px-2.5 py-1.5 rounded-full"
              data-testid="replen-refresh"
              title="Recompute the SOR pick list"
            >
              <ArrowsClockwise size={13} weight="bold" /> Refresh
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={distributeNow}
                disabled={distSaving || activeRows.length === 0}
                className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-white bg-[#1a5c38] hover:bg-[#0f3d24] disabled:opacity-50 px-3 py-1.5 rounded-full"
                data-testid="replen-distribute"
                title="Freeze the current open pick list into a dated batch; the list then refills with new items"
              >
                <PaperPlaneTilt size={13} weight="bold" /> {distSaving ? "Distributing…" : `Save & distribute${activeRows.length ? ` (${fmtNum(activeRows.length)})` : ""}`}
              </button>
            )}
          </div>
        </div>

        {/* SOR KPI strip. */}
        {kpi && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 mb-4" data-testid="replen-kpi-strip">
            <KpiTile label="Current SOR" value={`${Number(kpi.current_sor).toFixed(1)}%`} accent />
            <KpiTile label="Saleable SOR" value={`${Number(kpi.saleable_sor).toFixed(1)}%`} hint="Broken-curve orphans netted out of the denominator — the ceiling once orphans clear." />
            <KpiTile
              label="Projected SOR"
              value={`${Number(kpi.projected_sor).toFixed(1)}%`}
              delta={kpi.projected_uplift_pts}
              hint="Conservative — bounded by what is actually pickable before the next dispatch."
            />
            <KpiTile label="Deploy now (WH units)" value={fmtNum(kpi.deployable_wh_units)} icon={<Lightning size={12} weight="fill" className="text-amber-500" />} hint="Warehouse units for proven-demand stores sitting at zero shelf stock." />
            <KpiTile label="SOR at-risk units" value={fmtNum(kpi.sor_at_risk_units)} hint="Units sold at stores now at zero shelf stock — demand we cannot currently capture." />
            <KpiTile label="SOR drag (overstock)" value={fmtNum(kpi.sor_drag_units)} hint="Slow store stock (WoC > 16) dragging the denominator down." />
          </div>
        )}

        {/* Post-replenishment reconciliation — did SOR actually rise? */}
        {recon?.available && (
          <div className="card-white p-4 mb-4" data-testid="replen-recon-tile">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <h3 className="font-bold text-[14px] tracking-tight text-foreground">
                  Did SOR rise? — last dispatched run
                </h3>
                <p className="text-[11.5px] text-muted">
                  Run of {recon.business_date} · {fmtNum(recon.store_sku_count)} store-SKUs · realised after ~{recon.dispatch_days}d
                </p>
              </div>
              <span
                className="rounded-full border border-border px-2.5 py-1 text-[11.5px] font-semibold text-foreground"
                title="Rolling-median realised/projected ratio (clamped 0.25–2.0) that scales the engine's projection. 1.0 = projections on target; <1 = over-projecting; >1 = under-projecting."
              >
                Projection calibration ×{Number(recon.calibration).toFixed(2)}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
              <KpiTile label="SOR at calc" value={`${Number(recon.sor_at_calc).toFixed(1)}%`} />
              <KpiTile label="Realised SOR now" value={`${Number(recon.realised_sor).toFixed(1)}%`} delta={recon.realised_uplift_pts} accent />
              <KpiTile label="Projected SOR" value={`${Number(recon.projected_sor).toFixed(1)}%`} delta={recon.projected_uplift_pts} hint="What the engine projected this run would reach." />
              <KpiTile label="Realised units" value={fmtNum(recon.realised_incremental_units)} hint="Incremental units sold over the scope since the suggestion was calculated." />
              <KpiTile label="Projected units" value={fmtNum(recon.projected_incremental_units)} hint="Σ min(suggested, velocity × dispatch/7) at calc time." />
            </div>
          </div>
        )}

        {/* Search + bulk bar. */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="flex items-center gap-2 input-pill" style={{ maxWidth: 360, flex: "1 1 240px" }}>
            <MagnifyingGlass size={14} className="text-muted" />
            <input
              placeholder="Search store / SKU / barcode / colour…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="replen-search"
              className="bg-transparent outline-none text-[13px] w-full"
            />
          </div>
          {ownerOptions.length > 0 && (
            <select
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              data-testid="replen-owner-filter"
              title="Show only one picker's lines"
              className="input-pill text-[13px] bg-transparent outline-none cursor-pointer"
            >
              <option value="">All owners</option>
              {ownerOptions.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
          )}
          {(sor?.deploy_now_count ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1.5 bg-amber-100 text-amber-900 border border-amber-300 text-[11.5px] font-bold px-2.5 py-1 rounded-full" data-testid="replen-deploy-now-count">
              <Lightning size={12} weight="fill" /> {fmtNum(sor.deploy_now_count)} deploy-now
            </span>
          )}
        </div>

        <p className="text-[11.5px] text-muted mb-3" data-testid="replen-allocations-note">
          This list demand-sizes only SKUs with <b>proven local sales</b> (velocity × cover, by A/B/C class). A SKU a store has <b>never sold</b> won't appear here — seed its first allocation from the <b>Allocations</b> tool, after which it earns a replenishment cadence.
        </p>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 mb-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2" data-testid="replen-bulk-bar">
            <span className="text-[12px] font-semibold text-emerald-900">{selected.size} selected</span>
            <button type="button" onClick={bulkApprove} disabled={bulkSaving} className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 px-3 py-1.5 rounded-md" data-testid="replen-bulk-approve">
              <CheckCircle size={13} weight="fill" /> {bulkSaving ? "Approving…" : "Mark selected done"}
            </button>
            <button type="button" onClick={() => setSelected(new Set())} className="text-[11.5px] font-semibold text-muted hover:text-foreground" data-testid="replen-bulk-clear">Clear</button>
          </div>
        )}

        {loading && <Loading label="Computing the SOR pick list…" />}
        {error && <ErrorBox message={error} />}

        {!loading && !error && (
          visibleRows.length === 0 ? (
            <Empty label={rows.length === 0 ? "Nothing to deploy — no proven-demand SKU has warehouse cover to move today." : "All open lines have been actioned."} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <p className="px-3 py-2 text-[11px] text-muted border-b border-border">
                Ranked by projected SOR-uplift, <b>deploy-now first</b>. Click a column header to re-sort; shift-click to add a secondary sort.
              </p>
              <table className="w-full min-w-max text-[12.5px]" data-testid="replen-table">
                <thead className="bg-panel sticky top-0 z-10">
                  <tr className="text-left">
                    <th className="px-3 py-2.5 w-9">
                      <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} aria-label="Select all lines" data-testid="replen-select-all" className="accent-emerald-700" />
                    </th>
                    <SortableTh sortKey="pos_location" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">POS Location</SortableTh>
                    <SortableTh sortKey="owner" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap" title="Picker assigned by the roster. Set the team above, then Save & redistribute.">Owner</SortableTh>
                    <SortableTh sortKey="product_name" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold sticky left-0 bg-panel z-20 min-w-[200px] max-w-[280px]">Product</SortableTh>
                    <SortableTh sortKey="colour_print" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Colour</SortableTh>
                    <SortableTh sortKey="size" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Size</SortableTh>
                    <SortableTh sortKey="barcode" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Barcode</SortableTh>
                    <SortableTh sortKey="bin" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Bin</SortableTh>
                    <SortableTh sortKey="sku_class" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap" title="Velocity class: A fast · B core · C slow">Class</SortableTh>
                    <SortableTh sortKey="units_sold" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Sold</SortableTh>
                    <SortableTh sortKey="soh_store" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">SOH Store</SortableTh>
                    <SortableTh sortKey="soh_wh" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">SOH WH</SortableTh>
                    <SortableTh sortKey="woc" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap" title="Weeks of cover at the current velocity">WoC</SortableTh>
                    <SortableTh sortKey="days_lapsed" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap" title="Days since this line last sold at this store">Days lapsed</SortableTh>
                    <SortableTh sortKey="replenish" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Suggested</SortableTh>
                    <SortableTh sortKey="proj_uplift_units" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap" title="Conservative expected incremental units sold before the next dispatch">Proj. uplift</SortableTh>
                    <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap">Actual</th>
                    <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Transfer ref</th>
                    <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {corridorGroups.map((g) => (
                  <React.Fragment key={`corridor-${g.corridor}`}>
                    <tr className="bg-[#0f3d24]/[0.06] border-t-2 border-[#0f3d24]/20" data-testid={`replen-corridor-${g.corridor}`}>
                      <td colSpan={19} className="px-3 py-2 text-[11px] font-extrabold uppercase tracking-wide text-[#0f3d24]">
                        Corridor · {g.corridor}
                        <span className="ml-2 font-semibold normal-case text-muted">
                          {g.rows.length} line{g.rows.length === 1 ? "" : "s"} · {fmtNum(g.units)} units · proj. uplift +{Number(g.uplift).toFixed(1)}
                        </span>
                      </td>
                    </tr>
                    {g.rows.map((r) => {
                    const idx = sortedVisibleRows.indexOf(r);
                    const k = rowKey(r);
                    const isSelected = selected.has(k);
                    const clsKey = r.sku_class || "C";
                    const whyText = `${r.pos_location}: ~${Number(r.velocity).toFixed(1)} units/wk over the ${weeks}w window, ${r.woc >= 999 ? "no" : `${Number(r.woc).toFixed(1)} wks`} store cover. Class ${clsKey} target ${r.target}; suggested ${r.replenish} from warehouse.`;
                    return (
                      <tr key={k} className={`border-t border-border/50 ${r.deploy_now ? "bg-amber-50/60" : idx % 2 === 0 ? "bg-white" : "bg-panel/30"} hover:bg-amber-50/40`}>
                        <td className="px-3 py-3 align-top">
                          <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(k)} aria-label={`Select ${r.product_name || "line"}`} data-testid={`replen-select-${idx}`} className="accent-emerald-700" />
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap font-semibold">
                          <div className="flex items-center gap-1.5">
                            {r.deploy_now && (
                              <span className="inline-flex items-center gap-0.5 bg-amber-200 text-amber-900 border border-amber-400 text-[9.5px] font-bold px-1.5 py-0.5 rounded-full" data-testid={`replen-deploy-now-${idx}`} title="Proven-demand store at zero shelf stock with warehouse cover — the highest-SOR move.">
                                <Lightning size={9} weight="fill" /> DEPLOY NOW
                              </span>
                            )}
                            {r.pos_location}
                          </div>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {r.owner ? <span className="inline-flex items-center bg-slate-100 text-slate-700 border border-slate-300 text-[11px] font-semibold px-2 py-0.5 rounded-full">{r.owner}</span> : <span className="text-muted text-[11px]">—</span>}
                        </td>
                        <td className="px-3 py-3 sticky left-0 bg-inherit z-[5] min-w-[200px] max-w-[280px]">
                          <div className="flex items-start gap-1.5">
                            <span className="break-words" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{r.product_name}</span>
                            <span title={whyText} className="text-muted hover:text-brand cursor-help shrink-0 mt-0.5" data-testid={`replen-why-${idx}`} aria-label="Why recommended?">
                              <Info size={13} weight="bold" />
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">{fmtColourPrint(r) || <span className="text-muted text-[11px]">—</span>}</td>
                        <td className="px-3 py-3 whitespace-nowrap">{r.size || <span className="text-muted text-[11px]">—</span>}</td>
                        <td className="px-3 py-3 whitespace-nowrap font-mono text-[11px]">{r.barcode}</td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {r.bin ? <span className="inline-flex items-center bg-amber-100 text-amber-900 text-[10.5px] font-bold px-1.5 py-0.5 rounded">{r.bin}</span> : <span className="text-muted text-[11px]">—</span>}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span className={`inline-flex items-center border text-[10px] font-bold px-1.5 py-0.5 rounded-full ${CLASS_BADGE[clsKey] || CLASS_BADGE.C}`} title={CLASS_LABEL[clsKey]}>{clsKey}</span>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{fmtNum(r.units_sold)}</td>
                        <td className={`px-3 py-3 text-right tabular-nums ${r.soh_store === 0 ? "text-rose-700 font-bold" : ""}`}>{fmtNum(r.soh_store)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{fmtNum(r.soh_wh)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{r.woc >= 999 ? <span className="text-muted">—</span> : Number(r.woc).toFixed(1)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{r.days_lapsed > 0 ? fmtNum(r.days_lapsed) : <span className="text-muted">—</span>}</td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          <div className="inline-flex flex-col items-end gap-1">
                            <span className="inline-flex items-center bg-emerald-100 text-emerald-900 font-bold px-2 py-0.5 rounded-full">{fmtNum(r.replenish)}</span>
                            {r.wh_constrained && (
                              <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-900 border border-amber-300 text-[9.5px] font-bold px-1.5 py-0.5 rounded-full" data-testid={`replen-wh-constrained-${idx}`} title={`Warehouse-limited: need ${r.need}, only ${r.replenish} available.`}>
                                WH-LIMITED
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-emerald-800 font-semibold">{r.proj_uplift_units > 0 ? `+${Number(r.proj_uplift_units).toFixed(1)}` : <span className="text-muted">—</span>}</td>
                        <td className="px-3 py-2 text-right">
                          <input type="number" min={0} inputMode="numeric" placeholder={String(r.replenish)} value={actuals[k] ?? ""} onChange={(e) => setActual(k, e.target.value)} className="w-20 h-9 px-2 text-right tabular-nums border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-brand/40" data-testid={`replen-actual-${idx}`} />
                        </td>
                        <td className="px-3 py-2">
                          <input type="text" placeholder="Transfer ref" value={transferRefs[k] ?? ""} onChange={(e) => setTransferRefs((prev) => ({ ...prev, [k]: e.target.value }))} className="w-28 h-9 px-2 border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-brand/40" title="Optional — log an IBT / transfer document reference" data-testid={`replen-transfer-ref-${idx}`} />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <button type="button" onClick={() => markAsDone(r)} disabled={savingKey === k} className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 px-3 py-2 rounded-md whitespace-nowrap" data-testid={`replen-mark-done-${idx}`} title="Log the actual units replenished and remove this row from the open list">
                            <CheckCircle size={13} weight="fill" />
                            {savingKey === k ? "Saving…" : "Mark As Done"}
                          </button>
                        </td>
                      </tr>
                    );
                    })}
                  </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* Held-back panel. */}
        {heldBack.length > 0 && (
          <div className="mt-4 rounded-lg border border-border overflow-hidden" data-testid="replen-held-panel">
            <button type="button" onClick={() => setHeldOpen((o) => !o)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left bg-panel/40 hover:bg-panel/60" data-testid="replen-held-toggle">
              <span className="inline-flex items-center gap-2 font-extrabold text-[13px] text-[#0f3d24]">
                <Prohibit size={15} weight="duotone" className="text-slate-500" />
                Held back · {fmtNum(heldBack.length)} candidate{heldBack.length === 1 ? "" : "s"} not moved
              </span>
              {heldOpen ? <CaretDown size={15} weight="bold" /> : <CaretRight size={15} weight="bold" />}
            </button>
            {heldOpen && (
              <div className="overflow-x-auto border-t border-border bg-white">
                <table className="w-full min-w-max text-[12px]" data-testid="replen-held-table">
                  <thead className="bg-panel">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-semibold whitespace-nowrap">POS Location</th>
                      <th className="px-3 py-2 font-semibold whitespace-nowrap">Product</th>
                      <th className="px-3 py-2 font-semibold whitespace-nowrap">Colour</th>
                      <th className="px-3 py-2 font-semibold whitespace-nowrap">Size</th>
                      <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Sold</th>
                      <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">SOH Store</th>
                      <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">WoC</th>
                      <th className="px-3 py-2 font-semibold whitespace-nowrap">Reason</th>
                      <th className="px-3 py-2 font-semibold whitespace-nowrap">Override</th>
                    </tr>
                  </thead>
                  <tbody>
                    {heldBack.map((r, i) => {
                      const rk = `${r.pos_location}|${r.sku}`;
                      const reason = HELD_REASON[r.held_reason] || { label: r.held_reason || "—", cls: "bg-slate-100 text-slate-700 border-slate-300" };
                      return (
                        <tr key={rk} className={`border-t border-border/50 ${i % 2 === 0 ? "bg-white" : "bg-panel/30"}`} data-testid={`replen-held-row-${i}`}>
                          <td className="px-3 py-2 whitespace-nowrap font-semibold">{r.pos_location}</td>
                          <td className="px-3 py-2 break-words max-w-[260px]" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{r.product_name}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{fmtColourPrint(r) || <span className="text-muted">—</span>}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{r.size || <span className="text-muted">—</span>}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.units_sold)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.soh_store)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.woc >= 999 ? <span className="text-muted">—</span> : Number(r.woc).toFixed(1)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={`inline-flex items-center border text-[10px] font-bold px-2 py-0.5 rounded-full ${reason.cls}`}>{reason.label}</span>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <button type="button" onClick={() => releaseHeld(r)} disabled={releasingKey === rk} className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-800 border border-emerald-300 hover:bg-emerald-50 disabled:opacity-50 px-2.5 py-1 rounded-md" data-testid={`replen-release-${i}`} title="Force this SKU back into the pick list">
                              <ArrowUUpLeft size={12} weight="bold" /> {releasingKey === rk ? "Releasing…" : "Release"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Distributed batches — frozen dated pick lists with Done/Outstanding. */}
      {isAdmin && (
        <div className="card-white p-4 sm:p-5" data-testid="replen-distributions">
          <SectionTitle
            title={<span className="inline-flex items-center gap-2 text-[14px]"><Truck size={16} weight="duotone" className="text-brand-deep" /> Distributed batches</span>}
            subtitle="Each “Save & distribute” freezes the live pick list into a dated batch handed to the pickers. Lines stay here until picked (Done vs Outstanding per line), while the live list above refills with newly-arising items."
            action={
              <button type="button" onClick={loadDistributions} className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand-deep border border-border hover:bg-panel px-2.5 py-1.5 rounded-md" data-testid="replen-distributions-refresh">
                <ArrowCounterClockwise size={12} weight="bold" /> Refresh
              </button>
            }
          />
          {distLoading && <Loading label="Loading batches…" />}
          {!distLoading && (distributions.batches || []).length === 0 && (
            <Empty label="No distribution batches yet. Use “Save & distribute” on the pick list above to create one." />
          )}
          {!distLoading && (distributions.batches || []).map((b) => (
            <BatchCard key={b.id} batch={b} onMarkDone={markBatchLineDone} onDelete={deleteBatch} savingKey={batchSavingKey} />
          ))}
        </div>
      )}

      {/* Picker scorecard by day — done (selected EAT day) vs outstanding (all open). */}
      {isAdmin && (
        <div className="card-white p-4 sm:p-5" data-testid="replen-day-scorecard">
          <SectionTitle
            title={<span className="inline-flex items-center gap-2 text-[14px]"><CalendarBlank size={16} weight="duotone" className="text-brand-deep" /> Picker scorecard by day</span>}
            subtitle="Pick a day to see how many distributed items each picker marked done that day (EAT). Outstanding is every not-yet-done line across all open batches, regardless of day — what each picker still owes."
            action={
              <input type="date" value={scorecardDay} onChange={(e) => setScorecardDay(e.target.value)} className="text-[12px] border border-border rounded-md px-2 py-1.5 bg-white" data-testid="replen-scorecard-day" />
            }
          />
          {dayScorecard.length === 0 ? (
            <Empty label="No distributed lines yet — create a batch with “Save & distribute”." />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table className="w-full min-w-max text-[12.5px]">
                <thead className="bg-panel">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Picker</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Done · {scorecardDay}</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Units done</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Outstanding (all open)</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Outstanding units</th>
                  </tr>
                </thead>
                <tbody>
                  {dayScorecard.map((o, i) => (
                    <tr key={o.owner} className={`border-t border-border/50 ${i % 2 === 0 ? "bg-white" : "bg-panel/30"}`} data-testid={`replen-day-scorecard-row-${i}`}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center bg-emerald-100 text-emerald-900 text-[11px] font-bold px-2 py-0.5 rounded-full">{o.owner}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">{fmtNum(o.doneDay)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(o.doneUnitsDay)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{o.outstanding > 0 ? <span className="text-amber-700 font-semibold">{fmtNum(o.outstanding)}</span> : fmtNum(0)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(o.outstandingUnits)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Picker accountability scorecard. */}
      {isAdmin && (
        <div className="card-white p-4 sm:p-5" data-testid="replen-scorecard">
          <SectionTitle
            title={<span className="inline-flex items-center gap-2 text-[14px]"><CheckCircle size={16} weight="duotone" className="text-emerald-700" /> Picker accountability · last 30 days</span>}
            subtitle="Built on immutable pick-event facts. Each picker is scored against the latest suggestion snapshot for the stores they actually worked: Fulfilment % is line-based (effort-normalised), Missed SOR is the weekly velocity of suggested lines they skipped, and Over-picks are units taken beyond the suggested quantity."
          />
          {!scorecard?.published ? (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900" data-testid="replen-scorecard-accruing">
              <Warning size={16} weight="fill" className="text-amber-600 mt-0.5 shrink-0" />
              <div>
                <b>Accruing data — not yet published.</b>{" "}
                {scorecard?.reason || "Picker accountability appears once suggestion snapshots and attributable pick events have built up in the window."}
              </div>
            </div>
          ) : (scorecard.pickers || []).length === 0 ? (
            <Empty label="No attributable pickers in the last 30 days." />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table className="w-full min-w-max text-[12.5px]">
                <thead className="bg-panel">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Picker</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Assigned</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Done</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Missed</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Fulfilment %</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Units picked</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Missed SOR/wk</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Over-picks</th>
                  </tr>
                </thead>
                <tbody>
                  {(scorecard.pickers || []).map((p, i) => (
                    <tr key={p.user_id} className={`border-t border-border/50 ${i % 2 === 0 ? "bg-white" : "bg-panel/30"}`} data-testid={`replen-scorecard-row-${i}`}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center bg-emerald-100 text-emerald-900 text-[11px] font-bold px-2 py-0.5 rounded-full">{p.user_name}</span>
                        <span className="ml-2 text-[11px] text-muted">{(p.stores || []).length} store{(p.stores || []).length === 1 ? "" : "s"}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(p.assigned_lines)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">{fmtNum(p.done_lines)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{p.missed_lines > 0 ? <span className="text-rose-700 font-semibold">{fmtNum(p.missed_lines)}</span> : fmtNum(0)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className={`inline-flex items-center font-bold px-2 py-0.5 rounded-full ${p.fulfilment_pct >= 80 ? "bg-emerald-100 text-emerald-900" : p.fulfilment_pct >= 50 ? "bg-amber-100 text-amber-900" : "bg-rose-100 text-rose-900"}`}>{Number(p.fulfilment_pct).toFixed(1)}%</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(p.units_picked)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{p.missed_sor_units > 0 ? <span className="text-rose-700">{Number(p.missed_sor_units).toFixed(1)}</span> : "0"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{p.over_pick_units > 0 ? <span className="text-amber-700 font-semibold">{fmtNum(p.over_pick_units)}</span> : fmtNum(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Transfer Tracking — reconcile marked-done items vs the Odoo transfer doc. */}
      <ReplenishmentTransferReport />

      {/* Completed report (admin/owner). */}
      {isAdmin && (
        <div className="card-white p-5" data-testid="replen-completed-card">
          <SectionTitle
            title={<span className="inline-flex items-center gap-2"><CheckCircle size={16} weight="duotone" className="text-emerald-700" /> Completed Replenishments · last 30 days</span>}
            subtitle="Audit trail of every line marked done — fulfilment % = actual replenished ÷ suggested. The completed history does not retain the suggested baseline, so Qty to replenish and Fulfilment % read “—”. Stock after replenishment is sampled from the live store SOH at the moment Mark As Done was clicked."
            action={
              <button type="button" onClick={() => setCompletedRefresh((t) => t + 1)} className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand-deep border border-border hover:bg-panel px-2.5 py-1.5 rounded-md" data-testid="replen-completed-refresh">
                <ArrowCounterClockwise size={12} weight="bold" /> Refresh
              </button>
            }
          />
          {completedLoading && <Loading label="Loading audit trail…" />}
          {!completedLoading && (completed.rows || []).length === 0 && (
            <Empty label="No completed replenishments in the last 30 days." />
          )}
          {!completedLoading && (completed.rows || []).length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table className="w-full min-w-max text-[12.5px]">
                <thead className="bg-panel sticky top-0">
                  <tr className="text-left">
                    <SortableTh sortKey="completed_at" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Completed at</SortableTh>
                    <SortableTh sortKey="completed_by" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">User</SortableTh>
                    <SortableTh sortKey="pos_location" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">POS Location</SortableTh>
                    <SortableTh sortKey="product_name" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold">Product</SortableTh>
                    <SortableTh sortKey="size" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Size</SortableTh>
                    <SortableTh sortKey="barcode" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Barcode</SortableTh>
                    <SortableTh sortKey="replenish" sort={completedSort.sort} onSort={completedSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Qty to replenish</SortableTh>
                    <SortableTh sortKey="actual" sort={completedSort.sort} onSort={completedSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Qty replenished</SortableTh>
                    <SortableTh sortKey="transfer_ref" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Transfer ref</SortableTh>
                    <SortableTh sortKey="fulfilment_pct" sort={completedSort.sort} onSort={completedSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Fulfilment %</SortableTh>
                    <SortableTh sortKey="soh_after" sort={completedSort.sort} onSort={completedSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Qty after replenish</SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {completedSort.sortRows(completed.rows || [], {
                    completed_at: (r) => r.completed_at || "",
                    completed_by: (r) => r.owner || r.completed_by_name || "",
                    pos_location: (r) => r.pos_location || "",
                    product_name: (r) => r.product_name || "",
                    size: (r) => r.size || "",
                    barcode: (r) => r.barcode || "",
                    replenish: (r) => Number(r.units_to_replenish ?? 0),
                    actual: (r) => Number(r.actual_units_replenished ?? 0),
                    transfer_ref: (r) => r.transfer_ref || "",
                    fulfilment_pct: (r) => {
                      const t = Number(r.units_to_replenish ?? 0);
                      const a = Number(r.actual_units_replenished ?? 0);
                      return t > 0 ? (a / t) * 100 : null;
                    },
                    soh_after: (r) => r.soh_after == null ? null : Number(r.soh_after),
                  }).map((r) => (
                    <tr key={r.key} className="border-t border-border/50 hover:bg-panel/30">
                      <td className="px-3 py-2 text-[11px] tabular-nums">{r.completed_at ? r.completed_at.replace("T", " ").slice(0, 16) : "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center bg-emerald-100 text-emerald-900 text-[11px] font-bold px-2 py-0.5 rounded-full">{r.owner || r.completed_by_name || "—"}</span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.pos_location}</td>
                      <td className="px-3 py-2 break-words" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{r.product_name}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.size || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-[11px]">{r.barcode}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.units_to_replenish == null ? <span className="text-muted">—</span> : fmtNum(r.units_to_replenish)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">{fmtNum(r.actual_units_replenished)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.transfer_ref ? <span className="inline-flex items-center bg-sky-100 text-sky-900 text-[11px] font-semibold px-2 py-0.5 rounded-full font-mono" data-testid="completed-transfer-ref">{r.transfer_ref}</span> : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {(() => {
                          const t = Number(r.units_to_replenish ?? 0);
                          const a = Number(r.actual_units_replenished ?? 0);
                          const pct = t > 0 ? (a / t) * 100 : null;
                          return pct == null ? <span className="text-muted">—</span> : (
                            <span className={`inline-flex items-center font-bold px-2 py-0.5 rounded-full ${pct >= 100 ? "bg-emerald-100 text-emerald-900" : pct >= 50 ? "bg-amber-100 text-amber-900" : "bg-rose-100 text-rose-900"}`}>{pct.toFixed(0)}%</span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.soh_after == null ? <span className="text-muted">—</span> : fmtNum(r.soh_after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// A single distribution batch: collapsible header (counts + per-owner chips)
// over a line table with Done/Outstanding status and a Mark-done action.
const BatchCard = ({ batch, onMarkDone, onDelete, savingKey }) => {
  const [open, setOpen] = useState(false);
  const when = batch.created_at ? batch.created_at.replace("T", " ").slice(0, 16) : "—";
  const pct = batch.line_count ? Math.round((batch.done_count / batch.line_count) * 100) : 0;
  return (
    <div className="mt-3 rounded-lg border border-border overflow-hidden" data-testid={`replen-batch-${batch.id}`}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 bg-panel/40">
        <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-2 font-extrabold text-[13px] text-[#0f3d24]" data-testid={`replen-batch-toggle-${batch.id}`}>
          {open ? <CaretDown size={15} weight="bold" /> : <CaretRight size={15} weight="bold" />}
          {when}
        </button>
        <span className="text-[11.5px] text-muted">{batch.created_by || "—"}{batch.weeks ? ` · ${batch.weeks}w window` : ""}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-900 text-[11px] font-bold px-2 py-0.5 rounded-full">{fmtNum(batch.done_count)} done</span>
          <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-900 text-[11px] font-bold px-2 py-0.5 rounded-full">{fmtNum(batch.outstanding_count)} outstanding</span>
          <span className="text-[11px] text-muted tabular-nums">{fmtNum(batch.line_count)} lines · {fmtNum(batch.total_units)} units · {pct}%</span>
          <button type="button" onClick={() => onDelete(batch.id)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-700 border border-rose-200 hover:bg-rose-50 px-2 py-1 rounded-md" title="Remove this batch" data-testid={`replen-batch-delete-${batch.id}`}>
            <Trash size={12} weight="bold" />
          </button>
        </div>
      </div>
      {(batch.by_owner || []).length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 py-2 border-t border-border bg-white">
          {batch.by_owner.map((o) => (
            <span key={o.owner} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px]">
              <span className="font-bold text-[#0f3d24]">{o.owner}</span>
              <span className="text-emerald-700 font-semibold">{fmtNum(o.done)} done</span>
              <span className="text-amber-700 font-semibold">{fmtNum(o.outstanding)} left</span>
            </span>
          ))}
        </div>
      )}
      {open && (
        <div className="overflow-x-auto border-t border-border bg-white">
          <table className="w-full min-w-max text-[12px]">
            <thead className="bg-panel">
              <tr className="text-left">
                <th className="px-3 py-2 font-semibold whitespace-nowrap">Status</th>
                <th className="px-3 py-2 font-semibold whitespace-nowrap">Owner</th>
                <th className="px-3 py-2 font-semibold whitespace-nowrap">POS Location</th>
                <th className="px-3 py-2 font-semibold">Product</th>
                <th className="px-3 py-2 font-semibold whitespace-nowrap">Colour</th>
                <th className="px-3 py-2 font-semibold whitespace-nowrap">Size</th>
                <th className="px-3 py-2 font-semibold whitespace-nowrap">Barcode</th>
                <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Units</th>
                <th className="px-3 py-2 font-semibold whitespace-nowrap"></th>
              </tr>
            </thead>
            <tbody>
              {(batch.lines || []).map((ln, i) => {
                const k = `${ln.pos_location}|${ln.sku || ""}|${ln.barcode || ""}`;
                return (
                  <tr key={k + i} className={`border-t border-border/50 ${i % 2 === 0 ? "bg-white" : "bg-panel/30"}`} data-testid={`replen-batch-${batch.id}-row-${i}`}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {ln.done
                        ? <span className="inline-flex items-center gap-1 bg-emerald-100 text-emerald-900 text-[10px] font-bold px-2 py-0.5 rounded-full"><CheckCircle size={11} weight="fill" /> Done</span>
                        : <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-900 text-[10px] font-bold px-2 py-0.5 rounded-full">Outstanding</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{ln.owner || <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-semibold">{ln.pos_location}</td>
                    <td className="px-3 py-2 break-words max-w-[260px]" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{ln.product_name || ln.style_name || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{(ln.color_print || "").trim() || <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{ln.size || <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-[11px]">{ln.barcode || ln.sku || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{ln.done ? `${fmtNum(ln.done_units)} / ${fmtNum(ln.suggested_units)}` : fmtNum(ln.suggested_units)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {!ln.done && (
                        <button type="button" onClick={() => onMarkDone(ln)} disabled={savingKey === k} className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 px-2.5 py-1 rounded-md" data-testid={`replen-batch-markdone-${batch.id}-${i}`}>
                          <CheckCircle size={12} weight="fill" /> {savingKey === k ? "Saving…" : "Mark done"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// Small KPI tile for the SOR strip.
const KpiTile = ({ label, value, delta, hint, accent, icon }) => (
  <div className={`rounded-lg border px-3 py-2.5 ${accent ? "border-emerald-300 bg-emerald-50" : "border-border bg-white"}`} title={hint || undefined}>
    <div className="text-[10.5px] font-semibold text-muted inline-flex items-center gap-1">
      {icon}{label}{hint && <Info size={10} weight="bold" className="text-muted/70" />}
    </div>
    <div className="mt-0.5 flex items-baseline gap-1.5">
      <span className="text-[18px] font-extrabold tabular-nums text-[#0f3d24]">{value}</span>
      {delta != null && Number(delta) !== 0 && (
        <span className={`text-[11px] font-bold tabular-nums ${Number(delta) > 0 ? "text-emerald-700" : "text-rose-700"}`}>
          {Number(delta) > 0 ? "+" : ""}{Number(delta).toFixed(2)} pts
        </span>
      )}
    </div>
  </div>
);

export default Replenishments;
