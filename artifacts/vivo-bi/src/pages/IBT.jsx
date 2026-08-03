import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { useAuth } from "@/lib/auth";
import { api, fmtNum } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import IBTBundleTable from "@/components/IBTBundleTable";
import IBTInTransit from "@/components/IBTInTransit";
import IBTCompletedMoves from "@/components/IBTCompletedMoves";
import IBTScanOutModal from "@/components/IBTScanOutModal";
import IBTScanInModal from "@/components/IBTScanInModal";
import IBTResolveStuckModal from "@/components/IBTResolveStuckModal";
import { toast } from "sonner";
import {
  Truck, Package, MagnifyingGlass, DownloadSimple, Stack, TrendUp, Buildings, Tag,
  Clock, Lock, Warning, Timer, SealCheck,
} from "@phosphor-icons/react";

// Demand-lookback window (trailing days the engine measures sell-through over).
// A single fixed window — not user-switchable. Local to this page; it does NOT
// touch the global filter bar.
const IBT_DEMAND_DAYS = 28;

const IBT = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const canSeeCompletedMoves = isAdmin || user?.role === "leadership";
  const { countries, dataVersion } = applied;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [fromStoreFilter, setFromStoreFilter] = useState("");
  const [toStoreFilter, setToStoreFilter] = useState("");
  const [subcatFilter, setSubcatFilter] = useState("");
  const [completedKeys, setCompletedKeys] = useState(new Set());
  const [completedSkuKeys, setCompletedSkuKeys] = useState(new Set());
  const [completedRefresh, setCompletedRefresh] = useState(0);
  const [scanOutRow, setScanOutRow] = useState(null);
  const [scanInRow, setScanInRow] = useState(null);
  const [resolveStuckRow, setResolveStuckRow] = useState(null);
  const [exporting, setExporting] = useState(false);

  // Phase 3 (Flow & Proof) lifecycle state.
  const [freshness, setFreshness] = useState(null);        // {as_of_eat, sync_lag_min, stale, sla_min}
  const [reconciliation, setReconciliation] = useState(null); // realised vs projected proof strip
  const [transfers, setTransfers] = useState([]);          // all consignments (KPI aggregation)
  const [lifecycleRefresh, setLifecycleRefresh] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now()); // drives the live HH:MM:SS pill

  const stale = !!freshness?.stale;

  // Trailing demand window — a single fixed window (28d per spec), not switchable.
  const demandDays = IBT_DEMAND_DAYS;

  // B1 — cluster-aware matching (A/B/C revenue tiers). Default ON per spec.
  const [useClustering, setUseClustering] = useState(() => {
    try { return localStorage.getItem("vivo_ibt_clustering") !== "off"; }
    catch { return true; }
  });
  const setClusteringPersist = (on) => {
    setUseClustering(on);
    try { localStorage.setItem("vivo_ibt_clustering", on ? "on" : "off"); } catch { /* private */ }
  };

  const scrollToSection = (id) => {
    const el = typeof document !== "undefined" && document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Odoo draft refs keyed `${from}||${to}||${sku}` — persisted server-side so
  // draft numbers survive page reloads.
  const [odooDrafts, setOdooDrafts] = useState({});
  const [draftingKey, setDraftingKey] = useState(null); // `${from}||${to}` in flight
  useEffect(() => {
    let cancelled = false;
    api.get("/ibt/odoo-drafts")
      .then((r) => {
        if (cancelled) return;
        const map = {};
        (r.data?.rows || []).forEach((d) => {
          map[`${d.from_store}||${d.to_store}||${d.sku}`] = { id: d.picking_id, name: d.picking_name };
        });
        setOdooDrafts(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Per-corridor draft creation: one Odoo draft picking covering every visible
  // suggested line for the From→To pair.
  const handleCreateDrafts = async ({ from_store, to_store, lines }) => {
    const key = `${from_store}||${to_store}`;
    if (draftingKey) return;
    setDraftingKey(key);
    try {
      const { data } = await api.post("/ibt/odoo-draft", { from_store, to_store, lines });
      setOdooDrafts((prev) => {
        // Clear ALL old refs for this corridor first — a SKU zeroed out of the
        // recreated draft must not keep showing the (now cancelled) old ref.
        const next = {};
        const prefix = `${from_store}||${to_store}||`;
        Object.keys(prev).forEach((k) => { if (!k.startsWith(prefix)) next[k] = prev[k]; });
        lines.forEach(({ sku }) => {
          if (!(data.missing_skus || []).includes(sku)) {
            next[`${from_store}||${to_store}||${sku}`] = { id: data.picking_id, name: data.picking_name };
          }
        });
        return next;
      });
      const missing = (data.missing_skus || []).length;
      toast.success(
        `Odoo draft ${data.picking_name} created — ${data.lines_created} line(s)` +
        (missing ? `; ${missing} SKU(s) not found in Odoo` : ""),
      );
    } catch (e) {
      const d = e?.response?.data?.detail;
      toast.error(typeof d === "string" ? d : d?.message || "Could not create the Odoo draft");
    } finally {
      setDraftingKey(null);
    }
  };

  // Load already-completed keys so actioned SKUs drop out of the live list.
  useEffect(() => {
    let cancelled = false;
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
    api
      .get("/analytics/ibt-suggestions", {
        params: {
          country,
          demand_days: demandDays,
          limit: 300,
          use_clustering: useClustering,
        },
        timeout: 180000,
      })
      .then(({ data }) => {
        if (cancelled) return;
        setData(data || null);
        touchLastUpdated();
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [JSON.stringify(countries), dataVersion, demandDays, useClustering]);

  // Phase 3 — freshness, lifecycle ledger (KPI aggregation) and the realised-vs-
  // projected reconciliation proof strip. Refetched whenever a scan completes
  // (lifecycleRefresh bump) so the tiles, in-transit count and proof move at once.
  useEffect(() => {
    let cancelled = false;
    const fresh = lifecycleRefresh > 0;
    const cfg = fresh ? { forceFresh: true } : {};
    Promise.allSettled([
      api.get("/ibt/freshness", cfg),
      api.get("/ibt/transfers", { ...cfg, params: { days: 120 } }),
      api.get("/ibt/sor-reconciliation", cfg),
    ]).then(([f, t, r]) => {
      if (cancelled) return;
      if (f.status === "fulfilled") setFreshness(f.value.data || null);
      if (t.status === "fulfilled") setTransfers(t.value.data || []);
      if (r.status === "fulfilled") setReconciliation(r.value.data || null);
    });
    return () => { cancelled = true; };
  }, [lifecycleRefresh, dataVersion]);

  // Live "as of HH:MM:SS EAT" pill — re-render the freshness clock each second.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // B1 — Export to Operations: server-built multi-sheet Excel (one tab per
  // donor store). Streams a blob; bypasses the response cache.
  const handleExportOps = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const country = countries.length === 1 ? countries[0] : undefined;
      const resp = await api.get("/ibt/export/operations", {
        params: { country, demand_days: demandDays, use_clustering: useClustering },
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
      a.download = `ibt-operations-${(data?.as_of) || new Date().toISOString().slice(0, 10)}.xlsx`;
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

  const bundles = useMemo(() => data?.bundles || [], [data]);
  const markdownCandidates = useMemo(() => data?.markdown_candidates || [], [data]);
  const summary = data?.summary || {};

  // Phase 3 lifecycle KPI aggregation from the consignment ledger.
  const flowKpis = useMemo(() => {
    let inTransit = 0, inTransitUnits = 0, discrepancies = 0, overdue = 0;
    for (const t of transfers) {
      if (t.status === "in_transit") {
        inTransit += 1;
        inTransitUnits += Number(t.qty || 0);
        if (t.overdue) overdue += 1;
      }
      if (t.status === "discrepancy") discrepancies += 1;
    }
    return { inTransit, inTransitUnits, discrepancies, overdue };
  }, [transfers]);

  // Live "as of HH:MM:SS EAT" string. The freshness endpoint gives the sync's
  // as_of_eat; the seconds advance client-side off nowTick so the pill reads live.
  const eatClock = useMemo(() => {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit",
        second: "2-digit", hour12: false,
      }).format(new Date(nowTick));
    } catch { return ""; }
  }, [nowTick]);

  // Filter option lists are derived from the bundles + their embedded SKUs.
  const brands = useMemo(() => {
    const s = new Set();
    bundles.forEach((b) => (b.skus || []).forEach((k) => k.brand && s.add(k.brand)));
    return Array.from(s).sort();
  }, [bundles]);
  const subcats = useMemo(() => {
    const s = new Set();
    bundles.forEach((b) => (b.skus || []).forEach((k) => k.subcategory && s.add(k.subcategory)));
    return Array.from(s).sort();
  }, [bundles]);
  const fromStores = useMemo(
    () => Array.from(new Set(bundles.map((b) => b.from_store).filter(Boolean))).sort(),
    [bundles]
  );
  const toStores = useMemo(
    () => Array.from(new Set(bundles.map((b) => b.to_store).filter(Boolean))).sort(),
    [bundles]
  );

  // Apply the filter bar to bundles. Store filters are bundle-level; brand /
  // subcategory / search filter the embedded SKUs, and a bundle is shown only
  // if at least one SKU survives.
  const filteredBundles = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = [];
    for (const b of bundles) {
      if (fromStoreFilter && b.from_store !== fromStoreFilter) continue;
      if (toStoreFilter && b.to_store !== toStoreFilter) continue;
      const skus = (b.skus || []).filter((s) => {
        if (brandFilter && s.brand !== brandFilter) return false;
        if (subcatFilter && s.subcategory !== subcatFilter) return false;
        if (!q) return true;
        return (
          (s.style_name || "").toLowerCase().includes(q) ||
          (s.sku || "").toLowerCase().includes(q) ||
          (s.color || "").toLowerCase().includes(q) ||
          (s.barcode || "").toLowerCase().includes(q) ||
          (b.from_store || "").toLowerCase().includes(q) ||
          (b.to_store || "").toLowerCase().includes(q)
        );
      });
      if (skus.length === 0) continue;
      out.push({ ...b, skus });
    }
    return out;
  }, [bundles, search, brandFilter, fromStoreFilter, toStoreFilter, subcatFilter]);

  const hasFilters = brandFilter || fromStoreFilter || toStoreFilter || subcatFilter || search;

  return (
    <div className="space-y-6" data-testid="ibt-page">
      <div>
        <p className="text-muted text-[13px] mt-1 max-w-3xl">
          A single network solve moves each SKU from a store where it isn't
          selling to one where it is — capped by the destination's two-week
          demand and the donor's keep-one buffer, then consolidated into one
          transfer bundle per <b>from → to</b> store pair. Warehouses, Online
          and third-party brands are excluded.
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <p className="text-[12px] text-foreground/70 font-medium" data-testid="ibt-asof">
            As of {data?.as_of || "today"} · demand window: trailing {data?.demand_days || demandDays} days
          </p>
          <span
            data-testid="ibt-freshness-pill"
            title={
              freshness
                ? `Sales sync last refreshed ${freshness.sync_lag_min ?? "?"} min ago (SLA ${freshness.sla_min ?? "?"} min).` +
                  (stale ? " Sync is STALE — destructive scan actions are locked until figures refresh." : "")
                : "Loading sync freshness…"
            }
            className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full border ${
              stale
                ? "bg-rose-50 text-rose-700 border-rose-300"
                : "bg-emerald-50 text-emerald-700 border-emerald-300"
            }`}
          >
            {stale ? <Lock size={12} weight="fill" /> : <Clock size={12} weight="fill" />}
            As of {eatClock} EAT
            {freshness?.sync_lag_min != null && (
              <span className="font-semibold opacity-80">· synced {fmtNum(freshness.sync_lag_min)}m ago</span>
            )}
            {stale && <span className="uppercase tracking-wide">· stale</span>}
          </span>
        </div>
        {stale && (
          <p className="text-[11.5px] text-rose-700 mt-1.5 font-medium inline-flex items-center gap-1" data-testid="ibt-stale-warning">
            <Warning size={13} weight="fill" />
            The sales sync is behind SLA — scan-out / scan-in are locked so a transfer isn't committed against unrefreshed stock. Actions re-enable automatically once the sync catches up.
          </p>
        )}
      </div>

      {loading && <Loading label="Solving the transfer network across stores…" />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KPICard testId="ibt-kpi-bundles" accent label="Transfer bundles"
              sub={`${fmtNum(summary.units || 0)} units · ${fmtNum(summary.stores || 0)} stores`}
              value={fmtNum(summary.bundles || 0)} icon={Truck} showDelta={false} />
            <KPICard testId="ibt-kpi-value" label="Value redeployed"
              sub={`${fmtNum(summary.warehouse_covered_units || 0)} units the warehouse already covers`}
              value={`KES ${fmtNum(summary.value_kes || 0)}`} icon={Package} showDelta={false} />
            <KPICard testId="ibt-kpi-ccc" label="Inventory-days removed"
              sub={`avg ${fmtNum(summary.avg_net_ccc_days_per_unit || 0)} net days/unit`}
              value={fmtNum(summary.inventory_days_removed || 0)} icon={Buildings} showDelta={false} />
            <KPICard testId="ibt-kpi-sor" label="Est. SOR uplift"
              sub={`+${(summary.sor_uplift_pp_raw ?? summary.sor_uplift_pp ?? 0).toFixed(2)} pp raw · ×${(summary.calibration ?? 1).toFixed(2)} realisation`}
              value={`+${(summary.sor_uplift_pp ?? 0).toFixed(2)} pp`}
              icon={TrendUp} showDelta={false} />
          </div>

          {/* Phase 3 — flow & proof tiles from the consignment lifecycle ledger. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="ibt-flow-kpis">
            <KPICard testId="ibt-kpi-avg-ccc" label="Avg net-CCC / unit"
              sub={`calibrated ×${(summary.calibration ?? 1).toFixed(2)} · ${fmtNum(summary.avg_net_ccc_days_per_unit_raw ?? 0)} raw`}
              value={`${fmtNum(summary.avg_net_ccc_days_per_unit || 0)} d`}
              icon={Timer} showDelta={false} />
            <KPICard testId="ibt-kpi-in-transit" label="Units in transit"
              sub={`${fmtNum(flowKpis.inTransit)} consignments owned by the hub`}
              value={fmtNum(flowKpis.inTransitUnits)} icon={Truck} showDelta={false} />
            <KPICard testId="ibt-kpi-awaiting" label="Awaiting pick / receive"
              sub={`${fmtNum(filteredBundles.length)} bundles to pick · ${fmtNum(flowKpis.inTransit)} to receive`}
              value={fmtNum(flowKpis.inTransit)} icon={Package} showDelta={false} />
            <KPICard testId="ibt-kpi-discrepancies"
              accent={flowKpis.discrepancies > 0 || flowKpis.overdue > 0}
              label="Discrepancies / overdue"
              sub={`${fmtNum(flowKpis.overdue)} overdue in transit`}
              value={fmtNum(flowKpis.discrepancies)} icon={Warning} showDelta={false} />
          </div>

          {/* Realised-vs-projected proof strip — only shows once a run has landed. */}
          {reconciliation && reconciliation.landed_runs > 0 && (
            <div className="card-white p-4 sm:p-5" data-testid="ibt-proof-strip">
              <SectionTitle
                title={
                  <span className="inline-flex items-center gap-2">
                    <SealCheck size={16} weight="duotone" className="text-[#1a5c38]" />
                    Realisation proof · projected vs landed
                  </span>
                }
                subtitle="Each landed consignment's received units vs what was dispatched, rolled into a realisation factor that tempers the forward projection above. The canonical SOR formula and per-edge ranking are never altered — only the headline projection is scaled."
              />
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-[12.5px]">
                <div className="rounded-lg border border-border bg-panel/40 p-3">
                  <div className="text-muted text-[11px] font-semibold">Realisation</div>
                  <div className="text-[18px] font-extrabold text-brand-deep tabular-nums">
                    {fmtNum(reconciliation.realisation_pct ?? 0)}%
                  </div>
                  <div className="text-[10.5px] text-muted mt-0.5">received ÷ dispatched</div>
                </div>
                <div className="rounded-lg border border-border bg-panel/40 p-3">
                  <div className="text-muted text-[11px] font-semibold">Calibration ×</div>
                  <div className="text-[18px] font-extrabold tabular-nums">{(reconciliation.calibration ?? 1).toFixed(2)}</div>
                  <div className="text-[10.5px] text-muted mt-0.5">applied to projection</div>
                </div>
                <div className="rounded-lg border border-border bg-panel/40 p-3">
                  <div className="text-muted text-[11px] font-semibold">Landed runs</div>
                  <div className="text-[18px] font-extrabold tabular-nums">{fmtNum(reconciliation.landed_runs)}</div>
                  <div className="text-[10.5px] text-muted mt-0.5">samples in the median</div>
                </div>
                <div className="rounded-lg border border-border bg-panel/40 p-3">
                  <div className="text-muted text-[11px] font-semibold">Units dispatched → received</div>
                  <div className="text-[18px] font-extrabold tabular-nums">
                    {fmtNum(reconciliation.dispatched_units ?? 0)} → {fmtNum(reconciliation.received_units ?? 0)}
                  </div>
                  <div className="text-[10.5px] text-muted mt-0.5">across landed runs</div>
                </div>
                <div className="rounded-lg border border-border bg-panel/40 p-3">
                  <div className="text-muted text-[11px] font-semibold">CCC projected → realised</div>
                  <div className="text-[18px] font-extrabold tabular-nums">
                    {fmtNum(reconciliation.projected_ccc_days ?? 0)} → {fmtNum(reconciliation.realised_ccc_days ?? 0)} d
                  </div>
                  <div className="text-[10.5px] text-muted mt-0.5">inventory-days</div>
                </div>
              </div>
            </div>
          )}

          <div className="card-white p-3 flex flex-wrap items-center gap-2" data-testid="ibt-jump-nav">
            <span className="text-[11.5px] font-semibold text-muted">Jump to:</span>
            {[
              { id: "ibt-sec-store", label: "Transfer bundles" },
              { id: "ibt-sec-in-transit", label: "In transit" },
              ...(canSeeCompletedMoves ? [{ id: "ibt-sec-completed", label: "Received log" }] : []),
            ].map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => scrollToSection(s.id)}
                data-testid={`ibt-jump-${s.id}`}
                className="inline-flex items-center text-[11.5px] font-semibold px-2.5 py-1 rounded-lg border border-border bg-white text-foreground/70 hover:border-brand/40 hover:text-brand-deep transition-colors"
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="card-white p-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 input-pill flex-1 min-w-[200px]">
              <MagnifyingGlass size={14} className="text-muted" />
              <input
                placeholder="Search style, store, color, SKU…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="ibt-search"
                className="bg-transparent outline-none text-[13px] w-full"
              />
            </div>
            <select className="input-pill" value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} data-testid="ibt-brand-filter">
              <option value="">All brands</option>
              {brands.map((b) => <option key={b}>{b}</option>)}
            </select>
            <select className="input-pill" value={fromStoreFilter} onChange={(e) => setFromStoreFilter(e.target.value)} data-testid="ibt-from-store-filter" title="Show only bundles leaving this store">
              <option value="">All FROM stores</option>
              {fromStores.map((s) => <option key={s}>{s}</option>)}
            </select>
            <select className="input-pill" value={toStoreFilter} onChange={(e) => setToStoreFilter(e.target.value)} data-testid="ibt-to-store-filter" title="Show only bundles arriving at this store">
              <option value="">All TO stores</option>
              {toStores.map((s) => <option key={s}>{s}</option>)}
            </select>
            <select className="input-pill" value={subcatFilter} onChange={(e) => setSubcatFilter(e.target.value)} data-testid="ibt-subcat-filter" title="Show only this subcategory">
              <option value="">All subcategories</option>
              {subcats.map((s) => <option key={s}>{s}</option>)}
            </select>
            {hasFilters && (
              <button
                type="button"
                onClick={() => { setBrandFilter(""); setFromStoreFilter(""); setToStoreFilter(""); setSubcatFilter(""); setSearch(""); }}
                data-testid="ibt-clear-filters"
                className="text-[11px] text-muted underline hover:text-brand"
              >
                clear
              </button>
            )}
            <div className="flex-1" />
            <div className="inline-flex items-center gap-1.5 text-[11.5px]" data-testid="ibt-demand-control">
              <span className="font-semibold text-foreground/80">Demand window:</span>
              <span
                className="px-2.5 py-1 font-bold rounded-lg border border-border bg-panel text-foreground/70"
                title={`Sell-through is measured over the trailing ${IBT_DEMAND_DAYS} days`}
              >
                {IBT_DEMAND_DAYS}d
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={useClustering}
              onClick={() => setClusteringPersist(!useClustering)}
              data-testid="ibt-clustering-toggle"
              title="Match stores within the same or adjacent revenue tier (A/B/C). Off = chain-wide matching."
              className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${
                useClustering ? "bg-brand/10 text-brand-deep border-brand/40" : "bg-white text-muted border-border hover:border-brand/40"
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

          <div id="ibt-sec-store" className="card-white p-4 sm:p-5 scroll-mt-24" data-testid="ibt-table-card">
            <SectionTitle
              title={`Transfer suggestions · ${filteredBundles.length}${hasFilters ? ` of ${bundles.length}` : ""} bundles`}
              subtitle="One row per SKU move (From → To). Type the units actually picked, then Scan out to dispatch — the donor's live stock is re-validated at that moment (a sale wins) and the move enters the in-transit list below to be scanned in at the destination."
            />
            <IBTBundleTable
              bundles={filteredBundles}
              markdownCandidates={markdownCandidates}
              onScanOut={(payload) => setScanOutRow(payload)}
              onCreateDrafts={handleCreateDrafts}
              draftingKey={draftingKey}
              odooDrafts={odooDrafts}
              runId={data?.run_id}
              stale={stale}
              completedSkuKeys={completedSkuKeys}
              completedKeys={completedKeys}
              testId="ibt-table"
              emptyLabel="No transfer opportunities found. Try turning off cluster-aware matching, or check the country filter."
            />
          </div>

          {markdownCandidates.length > 0 && (
            <div className="card-white p-4 sm:p-5" data-testid="ibt-markdown-card">
              <SectionTitle
                title={`IBT markdown fork · ${markdownCandidates.length}`}
                subtitle="Slow stock that qualifies for a move on stock balance but does NOT pay to ship — once transit time and freight/duty are paid, the destination sells it no faster (or the value is wiped out). Clear it locally with a markdown rather than redeploying it."
              />
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-[12.5px]" data-testid="ibt-markdown-table">
                  <thead>
                    <tr className="text-left text-muted border-b border-border">
                      <th className="py-2 px-2 font-semibold">Store</th>
                      <th className="py-2 px-2 font-semibold">Style</th>
                      <th className="py-2 px-2 font-semibold">Subcategory</th>
                      <th className="py-2 px-2 font-semibold text-right">On hand</th>
                      <th className="py-2 px-2 font-semibold text-right">SKUs</th>
                      <th className="py-2 px-2 font-semibold text-right">Days to sell</th>
                      <th className="py-2 px-2 font-semibold">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {markdownCandidates.map((m, i) => (
                      <tr key={`${m.from_store}|${m.style_name}|${i}`} className="border-b border-border/60">
                        <td className="py-1.5 px-2">{m.from_store}{m.from_country ? ` · ${m.from_country}` : ""}</td>
                        <td className="py-1.5 px-2 font-medium text-foreground">{m.style_name}</td>
                        <td className="py-1.5 px-2 text-muted">{m.subcategory || "—"}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{fmtNum(m.donor_onhand || 0)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{fmtNum(m.sku_count || 0)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{fmtNum(m.src_days_to_sell || 0)}</td>
                        <td className="py-1.5 px-2">
                          <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                            m.reason === "no_value" ? "bg-rose-100 text-rose-700"
                              : m.reason === "no_demand" ? "bg-slate-100 text-slate-700"
                              : "bg-amber-100 text-amber-700"
                          }`}>
                            <Tag size={11} weight="bold" />
                            {m.reason === "no_value" ? "Freight wipes value"
                              : m.reason === "no_demand" ? "No buyer in network"
                              : "No time saved"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card-white p-4 bg-panel">
            <div className="text-[12.5px] text-muted">
              <span className="font-semibold text-foreground">How it works:</span>{" "}
              First the central warehouse is deployed against each destination gap
              (strongest demand first), so IBT only fires on the residual stores
              can't be replenished from the warehouse. The global solve then scores
              every viable SKU edge (donor selling weakly with stock → receiver
              selling strongly but low) and assigns units against a per-destination
              two-week demand budget and a per-donor keep-one ledger. Edges are
              ranked size-curve-completion first (filling an empty destination
              size), then by net cash-conversion days × value (donor days-to-sell −
              destination days-to-sell − corridor transit, valued at ASP net of
              freight and cross-border duty). A move that doesn't pay forks to the
              markdown list above. Surviving edges consolidate into one bundle per
              store pair that ships only if it clears the minimum-transfer gate
              (domestic ≥ 4 units, cross-border ≥ 24). The canonical Sell-Off-Rate
              formula is never altered.
            </div>
          </div>

          <IBTInTransit
            refreshKey={lifecycleRefresh}
            stale={stale}
            onScanIn={(row) => setScanInRow(row)}
            onResolveStuck={(row) => setResolveStuckRow(row)}
          />

          {canSeeCompletedMoves && (
            <div id="ibt-sec-completed" className="scroll-mt-24">
              <IBTCompletedMoves refreshKey={completedRefresh} />
            </div>
          )}

          {scanOutRow && (
            <IBTScanOutModal
              row={scanOutRow}
              onClose={() => setScanOutRow(null)}
              onScannedOut={() => {
                setScanOutRow(null);
                setCompletedRefresh((n) => n + 1);
                setLifecycleRefresh((n) => n + 1);
              }}
            />
          )}

          {scanInRow && (
            <IBTScanInModal
              row={scanInRow}
              onClose={() => setScanInRow(null)}
              onScannedIn={() => {
                setScanInRow(null);
                setCompletedRefresh((n) => n + 1);
                setLifecycleRefresh((n) => n + 1);
              }}
            />
          )}

          {resolveStuckRow && (
            <IBTResolveStuckModal
              row={resolveStuckRow}
              onClose={() => setResolveStuckRow(null)}
              onResolved={(data) => {
                setResolveStuckRow(null);
                toast.success(
                  data?.action === "cancel"
                    ? `Consignment ${data?.consignment_id} cancelled — ownership returned to donor.`
                    : `Consignment ${data?.consignment_id} force-received.`,
                );
                setCompletedRefresh((n) => n + 1);
                setLifecycleRefresh((n) => n + 1);
              }}
            />
          )}
        </>
      )}
    </div>
  );
};

export default IBT;
