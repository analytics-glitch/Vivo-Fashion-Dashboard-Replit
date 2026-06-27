import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { useAuth } from "@/lib/auth";
import { api, fmtNum } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import IBTBundleTable from "@/components/IBTBundleTable";
import IBTCompletedMoves from "@/components/IBTCompletedMoves";
import IBTMarkAsDoneModal from "@/components/IBTMarkAsDoneModal";
import { toast } from "sonner";
import {
  Truck, Package, MagnifyingGlass, DownloadSimple, Stack, TrendUp, Buildings,
} from "@phosphor-icons/react";

// Demand-lookback presets (trailing window the engine measures sell-through
// over). Local to this page — it does NOT touch the global filter bar.
const DEMAND_OPTIONS = [
  { days: 14, label: "14d" },
  { days: 28, label: "28d" },
  { days: 56, label: "56d" },
];

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
  const [doneModalRow, setDoneModalRow] = useState(null);
  const [exporting, setExporting] = useState(false);

  // Trailing demand window (default 28d per spec). Persisted; local-only.
  const [demandDays, setDemandDays] = useState(() => {
    try { return Number(localStorage.getItem("vivo_ibt_demand_days")) || 28; }
    catch { return 28; }
  });
  const setDemandDaysPersist = (d) => {
    setDemandDays(d);
    try { localStorage.setItem("vivo_ibt_demand_days", String(d)); } catch { /* private */ }
  };

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
  const summary = data?.summary || {};

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
        <p className="text-[12px] text-foreground/70 mt-2 font-medium" data-testid="ibt-asof">
          As of {data?.as_of || "today"} · demand window: trailing {data?.demand_days || demandDays} days
        </p>
      </div>

      {loading && <Loading label="Solving the transfer network across stores…" />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KPICard testId="ibt-kpi-bundles" accent label="Transfer bundles"
              sub="One per from → to pair"
              value={fmtNum(summary.bundles || 0)} icon={Truck} showDelta={false} />
            <KPICard testId="ibt-kpi-units" label="Units to move"
              value={fmtNum(summary.units || 0)} icon={Package} showDelta={false} />
            <KPICard testId="ibt-kpi-stores" label="Stores involved"
              value={fmtNum(summary.stores || 0)} icon={Buildings} showDelta={false} />
            <KPICard testId="ibt-kpi-sor" label="Est. SOR uplift"
              sub={`${fmtNum(summary.cross_border_bundles || 0)} cross-border`}
              value={`+${(summary.sor_uplift_pp ?? 0).toFixed(2)} pp`}
              icon={TrendUp} showDelta={false} />
          </div>

          <div className="card-white p-3 flex flex-wrap items-center gap-2" data-testid="ibt-jump-nav">
            <span className="text-[11.5px] font-semibold text-muted">Jump to:</span>
            {[
              { id: "ibt-sec-store", label: "Transfer bundles" },
              ...(canSeeCompletedMoves ? [{ id: "ibt-sec-completed", label: "Completed moves" }] : []),
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
              <span className="font-semibold text-foreground/80">Demand:</span>
              <div className="inline-flex border border-border rounded-lg overflow-hidden">
                {DEMAND_OPTIONS.map((o) => (
                  <button
                    key={o.days}
                    type="button"
                    onClick={() => setDemandDaysPersist(o.days)}
                    title={`Measure sell-through over the trailing ${o.days} days`}
                    data-testid={`ibt-demand-${o.days}`}
                    className={`px-2.5 py-1 font-bold transition-colors ${
                      demandDays === o.days ? "bg-brand text-white" : "bg-white text-foreground/70 hover:bg-panel"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
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
              title={`Transfer bundles · ${filteredBundles.length}${hasFilters ? ` of ${bundles.length}` : ""}`}
              subtitle="Each row is one store → store transfer. Expand it to see the SKU pick list, type the units you actually moved, then Mark As Done to log the PO and clear it."
            />
            <IBTBundleTable
              bundles={filteredBundles}
              onMarkDone={(payload) => setDoneModalRow(payload)}
              completedSkuKeys={completedSkuKeys}
              completedKeys={completedKeys}
              testId="ibt-table"
              emptyLabel="No transfer opportunities found for the current window. Try a longer demand window or turn off cluster-aware matching."
            />
          </div>

          <div className="card-white p-4 bg-panel">
            <div className="text-[12.5px] text-muted">
              <span className="font-semibold text-foreground">How it works:</span>{" "}
              One global solve scores every viable SKU edge (donor selling weakly
              with stock → receiver selling strongly but low), then greedily
              assigns units against a per-destination two-week demand budget and a
              per-donor keep-one ledger so no store is over-drained or
              over-filled. Surviving edges are consolidated into one bundle per
              store pair; a bundle ships only if it clears the minimum-transfer
              gate (domestic ≥ 4 units, cross-border ≥ 24). The canonical
              Sell-Off-Rate formula is never altered.
            </div>
          </div>

          {canSeeCompletedMoves && (
            <div id="ibt-sec-completed" className="scroll-mt-24">
              <IBTCompletedMoves refreshKey={completedRefresh} />
            </div>
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
