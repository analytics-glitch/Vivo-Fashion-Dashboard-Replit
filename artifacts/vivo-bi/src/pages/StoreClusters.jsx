import React, { useEffect, useMemo, useState } from "react";
import { api, fmtKES, fmtKESLong, fmtPct } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import {
  ArrowsClockwise, Stack, Calendar, CheckCircle, XCircle,
  ArrowsLeftRight, Warning,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { useTableSort, SortableTh } from "@/lib/useTableSort";
import { useFilters } from "@/lib/filters";
import SortableTable from "@/components/SortableTable";
import CountryDot from "@/components/CountryDot";

/**
 * Store Peer-Cluster inspector (Phase 1 — surface only).
 *
 * Lets admins eyeball the latest cluster run before we trust it to drive
 * IBT logic in Phase 2. Shows:
 *   • Per-cluster centroid in plain English (ASP, basket, size skew, mix)
 *   • Member stores with their feature values
 *   • A "Re-cluster now" button (uses the cached 90-day order pull, fast)
 *   • Optional "Use 12-month tier" checkbox for the slower run
 */
const StoreClusters = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reclustering, setReclustering] = useState(false);
  const [useYear, setUseYear] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Phase 5 — Store potential (vs cluster peers) from /analytics/store-potential.
  const { applied } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion } = applied;
  const [potential, setPotential] = useState(null);
  const [potLoading, setPotLoading] = useState(true);
  const [potError, setPotError] = useState(null);

  // Iter 89 — Per-store table sort state.
  const tableSort = useTableSort();

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    api.get("/admin/store-clusters", { forceFresh: refreshKey > 0 })
      .then(({ data: d }) => {
        if (cancel) return;
        setData(d);
        setError(null);
      })
      .catch((e) => !cancel && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancel && setLoading(false));
    return () => { cancel = true; };
  }, [refreshKey]);

  // /analytics/store-potential accepts a single `country` filter only (it reads
  // s.country = '<value>' — see api_pg.py). Pass it only when exactly one
  // country is selected; otherwise leave it chain-wide.
  useEffect(() => {
    let cancel = false;
    setPotLoading(true);
    const country = countries.length === 1 ? countries[0] : undefined;
    api.get("/analytics/store-potential", { params: country ? { country } : {} })
      .then(({ data: d }) => {
        if (cancel) return;
        setPotential(d);
        setPotError(null);
      })
      .catch((e) => !cancel && setPotError(e?.response?.data?.detail || e.message))
      .finally(() => !cancel && setPotLoading(false));
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, JSON.stringify(countries), JSON.stringify(channels), dataVersion]);

  const recluster = async () => {
    setReclustering(true);
    try {
      const { data: d } = await api.post(
        `/admin/store-clusters/recluster${useYear ? "?use_year=true" : ""}`,
        null,
        { timeout: 240000 }
      );
      setData(d);
      toast.success(`Re-clustered ${d.n_stores} stores using ${d.tier_window} window`);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast.error("Re-cluster failed — " + (e?.response?.data?.detail || e.message));
    } finally {
      setReclustering(false);
    }
  };

  // Cluster badge palette: A = dark green, B = amber, C = grey.
  const clusterBadge = (cl) => {
    const map = {
      A: { bg: "#0f3d24", label: "A" },
      B: { bg: "#d97706", label: "B" },
      C: { bg: "#9ca3af", label: "C" },
    };
    const m = map[cl] || { bg: "#9ca3af", label: cl || "—" };
    return (
      <span
        className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-white"
        style={{ background: m.bg }}
        title={`Cluster ${m.label}`}
      >
        {m.label}
      </span>
    );
  };

  // % of cluster potential → color band: <70 red, 70–99 amber, ≥100 green.
  const pctPill = (pct) => {
    const v = Number(pct ?? 0);
    const cls = v < 70 ? "pill-red" : v < 100 ? "pill-amber" : "pill-green";
    return <span className={cls}>{fmtPct(v)}</span>;
  };

  // Likely-cause badge mapping (no emoji — plain text pills).
  const causePill = (cause) => {
    if (!cause) return <span className="text-muted">—</span>;
    const map = {
      new_store: { cls: "pill-neutral", label: "New Store" },
      low_stock: { cls: "pill-amber", label: "Low Stock" },
      low_footfall: { cls: "pill-amber", label: "Low Footfall" },
      low_conversion: { cls: "pill-amber", label: "Low Conversion" },
    };
    const m = map[cause] || { cls: "pill-neutral", label: String(cause) };
    return <span className={m.cls}>{m.label}</span>;
  };

  const potentialCols = [
    {
      key: "store", label: "Store", mobilePrimary: true,
      render: (r) => <span className="font-semibold">{r.store}</span>,
      sortValue: (r) => r.store || "",
    },
    {
      key: "cluster", label: "Cluster", align: "center",
      render: (r) => clusterBadge(r.cluster),
      csv: (r) => r.cluster || "",
      sortValue: (r) => r.cluster || "",
    },
    {
      key: "country", label: "Country", mobileHidden: true,
      render: (r) => (r.country ? <CountryDot country={r.country} /> : "—"),
      csv: (r) => r.country || "",
      sortValue: (r) => r.country || "",
    },
    {
      key: "actual_revenue_90d", label: "Revenue (90d)", numeric: true, align: "right",
      render: (r) => <span className="tabular-nums">{fmtKES(r.actual_revenue_90d)}</span>,
      csv: (r) => fmtKESLong(r.actual_revenue_90d),
      sortValue: (r) => Number(r.actual_revenue_90d ?? 0),
    },
    {
      key: "cluster_median_revenue", label: "Cluster Median", numeric: true, align: "right",
      mobileHidden: true,
      render: (r) => <span className="tabular-nums text-muted">{fmtKES(r.cluster_median_revenue)}</span>,
      csv: (r) => fmtKESLong(r.cluster_median_revenue),
      sortValue: (r) => Number(r.cluster_median_revenue ?? 0),
    },
    {
      key: "pct_of_potential", label: "% of Potential", numeric: true, align: "right",
      render: (r) => pctPill(r.pct_of_potential),
      csv: (r) => fmtPct(r.pct_of_potential),
      sortValue: (r) => Number(r.pct_of_potential ?? 0),
    },
    {
      key: "gap_kes", label: "Gap KES", numeric: true, align: "right",
      render: (r) => (
        <span className={`tabular-nums ${Number(r.gap_kes ?? 0) > 0 ? "text-danger font-semibold" : "text-muted"}`}>
          {Number(r.gap_kes ?? 0) > 0 ? fmtKES(r.gap_kes) : "—"}
        </span>
      ),
      csv: (r) => fmtKESLong(r.gap_kes),
      sortValue: (r) => Number(r.gap_kes ?? 0),
    },
    {
      key: "likely_cause", label: "Likely Cause",
      render: (r) => causePill(r.likely_cause),
      csv: (r) => r.likely_cause || "",
      sortValue: (r) => r.likely_cause || "",
    },
  ];

  const potentialRows = potential?.stores || [];

  return (
    <div className="space-y-5" data-testid="store-clusters-page">
      <div>
        <p className="text-[12.5px] text-muted mt-1 max-w-3xl">
          Phase 1 surface — IBT recommendations now display each store's
          peer-cluster id (e.g. <b>A1</b>) but the math still uses the chain-wide
          average. Inspect the clusters below; once they look right, we'll
          flip the IBT engine to use cluster averages in Phase 2.
        </p>
      </div>

      {/* Callout — cluster assignments now feed the IBT engine. */}
      <div
        className="card-white p-4 border-l-4 border-[#1a5c38] flex items-start gap-3"
        data-testid="cluster-ibt-callout"
      >
        <CheckCircle size={18} weight="fill" className="text-[#1a5c38] mt-0.5 shrink-0" />
        <div className="text-[12.5px] text-foreground/90">
          <b className="text-brand-deep">Cluster assignments now used in IBT recommendations.</b>{" "}
          Donor→needer matching prefers peers in the same or adjacent revenue cluster.
        </div>
      </div>

      {/* Cluster IBT transfer rules diagram. */}
      <div className="card-white p-4 sm:p-5" data-testid="cluster-ibt-rules">
        <SectionTitle
          title="Cluster IBT Transfer Rules"
          subtitle="Stock moves are allowed between same-tier and adjacent clusters only — never across the A↔C extremes."
        />
        <div className="flex flex-wrap items-center gap-3">
          <RuleChip allowed from="A" to="B" />
          <RuleChip allowed from="B" to="C" />
          <RuleChip allowed={false} from="A" to="C" />
        </div>
      </div>

      {/* Store potential vs cluster peers. */}
      <div className="card-white p-4 sm:p-5" data-testid="store-potential">
        <SectionTitle
          title="Store Potential vs Cluster Peers"
          subtitle="Revenue gap against each store's cluster-median peer. Understocked stores (< 70% of potential) are flagged with a likely cause."
          action={
            potential?.understocked_count != null ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] pill-amber">
                <Warning size={13} weight="fill" />
                {potential.understocked_count} understocked
              </span>
            ) : null
          }
        />
        {potLoading && <Loading label="Loading store potential…" />}
        {!potLoading && potError && <ErrorBox message={potError} />}
        {!potLoading && !potError && potentialRows.length === 0 && (
          <Empty label="No store-potential data for the selected filters." />
        )}
        {!potLoading && !potError && potentialRows.length > 0 && (
          <SortableTable
            columns={potentialCols}
            rows={potentialRows}
            exportName="store-potential"
            testId="store-potential-table"
            mobileCards
            initialSort={{ key: "pct_of_potential", dir: "asc" }}
          />
        )}
      </div>

      <div className="card-white p-4 sm:p-5" data-testid="cluster-controls">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={recluster}
            disabled={reclustering}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-white bg-[#1a5c38] hover:bg-[#0f3d24] disabled:opacity-50 px-3 py-2 rounded-md"
            data-testid="cluster-recluster-btn"
          >
            <ArrowsClockwise size={13} weight={reclustering ? "regular" : "bold"} className={reclustering ? "animate-spin" : ""} />
            {reclustering ? "Re-clustering…" : "Re-cluster now"}
          </button>
          <label className="inline-flex items-center gap-1.5 text-[12px]">
            <input
              type="checkbox"
              checked={useYear}
              onChange={(e) => setUseYear(e.target.checked)}
              className="accent-brand"
              data-testid="cluster-use-year"
            />
            Use 12-month window for tier (slower)
          </label>
          {data?.computed_at && (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-muted ml-auto">
              <Calendar size={12} /> Last run: {new Date(data.computed_at).toLocaleString("en-KE")}
              {data.tier_window && <b className="ml-2 text-foreground">tier window: {data.tier_window}</b>}
            </span>
          )}
        </div>
      </div>

      {loading && <Loading label="Loading clusters…" />}
      {error && <ErrorBox message={error} />}
      {!loading && !error && data?.ok === false && (
        <Empty label="No cluster run yet — click 'Re-cluster now' to compute the first one." />
      )}

      {!loading && !error && data?.clusters && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="cluster-grid">
          {Object.entries(data.clusters).map(([cid, meta]) => (
            <div key={cid} className="card-white p-4 border-l-4" style={{ borderColor: tierColor(meta.tier) }}>
              <div className="flex items-baseline justify-between mb-2">
                <span className="font-extrabold text-[18px] text-foreground inline-flex items-center gap-2">
                  <Stack size={16} weight="duotone" className="text-brand-deep" /> {cid}
                </span>
                <span className="text-[11px] font-semibold text-muted">
                  Tier {meta.tier} · {meta.size} stores
                </span>
              </div>
              <div className="text-[11.5px] text-foreground/90 mb-2 leading-relaxed">
                {meta.explainer}
              </div>
              <div className="text-[11px] text-muted mb-1 font-semibold uppercase tracking-wide">Members</div>
              <ul className="space-y-0.5 text-[12px]" data-testid={`cluster-members-${cid}`}>
                {meta.members.map((s) => (
                  <li key={s} className="flex items-center gap-1.5">
                    <span className="w-1 h-1 rounded-full bg-brand inline-block"></span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && data?.by_store && (
        <div className="card-white p-4 sm:p-5" data-testid="cluster-store-table">
          <SectionTitle
            title="Per-store features"
            subtitle="The 6 normalised features feeding the within-tier k-means. Hover any feature value to compare against the cluster centroid."
          />
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-[12.5px]">
              <thead className="bg-panel">
                <tr className="text-left">
                  <SortableTh sortKey="store" sort={tableSort.sort} onSort={tableSort.toggleSort} className="px-3 py-2 font-semibold whitespace-nowrap">Store</SortableTh>
                  <SortableTh sortKey="tier" sort={tableSort.sort} onSort={tableSort.toggleSort} className="px-3 py-2 font-semibold whitespace-nowrap">Tier</SortableTh>
                  <SortableTh sortKey="cluster_id" sort={tableSort.sort} onSort={tableSort.toggleSort} className="px-3 py-2 font-semibold whitespace-nowrap">Cluster</SortableTh>
                  <SortableTh sortKey="asp" sort={tableSort.sort} onSort={tableSort.toggleSort} numeric className="px-3 py-2 font-semibold whitespace-nowrap">ASP</SortableTh>
                  <SortableTh sortKey="avg_basket_units" sort={tableSort.sort} onSort={tableSort.toggleSort} numeric className="px-3 py-2 font-semibold whitespace-nowrap">Basket</SortableTh>
                  <SortableTh sortKey="size_cog" sort={tableSort.sort} onSort={tableSort.toggleSort} numeric className="px-3 py-2 font-semibold whitespace-nowrap">Size CoG</SortableTh>
                  <SortableTh sortKey="pct_tops" sort={tableSort.sort} onSort={tableSort.toggleSort} numeric className="px-3 py-2 font-semibold whitespace-nowrap">% Tops</SortableTh>
                  <SortableTh sortKey="pct_bottoms" sort={tableSort.sort} onSort={tableSort.toggleSort} numeric className="px-3 py-2 font-semibold whitespace-nowrap">% Bottoms</SortableTh>
                  <SortableTh sortKey="pct_accessories" sort={tableSort.sort} onSort={tableSort.toggleSort} numeric className="px-3 py-2 font-semibold whitespace-nowrap">% Acc</SortableTh>
                  <SortableTh sortKey="revenue_90d" sort={tableSort.sort} onSort={tableSort.toggleSort} numeric className="px-3 py-2 font-semibold whitespace-nowrap">90d Rev</SortableTh>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const entries = Object.entries(data.by_store).map(([store, row]) => ({ store, ...row }));
                  const sorted = tableSort.sort
                    ? tableSort.sortRows(entries, {
                        store: (r) => r.store,
                        tier: (r) => r.tier || "",
                        cluster_id: (r) => r.cluster_id || "",
                        asp: (r) => Number(r.asp ?? 0),
                        avg_basket_units: (r) => Number(r.avg_basket_units ?? 0),
                        size_cog: (r) => Number(r.size_cog ?? 0),
                        pct_tops: (r) => Number(r.pct_tops ?? 0),
                        pct_bottoms: (r) => Number(r.pct_bottoms ?? 0),
                        pct_accessories: (r) => Number(r.pct_accessories ?? 0),
                        revenue_90d: (r) => Number(r.revenue_90d ?? 0),
                      })
                    : entries.sort((a, b) => (a.cluster_id || "").localeCompare(b.cluster_id || ""));
                  return sorted.map((row, i) => (
                    <tr key={row.store} className={`border-t border-border/50 ${i % 2 === 0 ? "bg-white" : "bg-panel/30"}`}>
                      <td className="px-3 py-2 font-semibold whitespace-nowrap">{row.store}</td>
                      <td className="px-3 py-2"><span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold text-white" style={{ background: tierColor(row.tier) }}>{row.tier}</span></td>
                      <td className="px-3 py-2 font-mono">{row.cluster_id || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">KES {Math.round(row.asp || 0).toLocaleString("en-KE")}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{(row.avg_basket_units || 0).toFixed(1)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{(row.size_cog || 0).toFixed(1)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Math.round((row.pct_tops || 0) * 100)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Math.round((row.pct_bottoms || 0) * 100)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Math.round((row.pct_accessories || 0) * 100)}%</td>
                      <td className="px-3 py-2 text-right tabular-nums">{Math.round((row.revenue_90d || 0) / 1000).toLocaleString("en-KE")}K</td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

const tierColor = (t) => t === "A" ? "#0f3d24" : t === "B" ? "#1a5c38" : "#9c6c2e";

/** A single cluster-pair transfer rule (allowed/blocked) for the IBT
 *  rules diagram. No emoji — uses phosphor check/cross icons + text. */
const RuleChip = ({ from, to, allowed }) => {
  const Icon = allowed ? CheckCircle : XCircle;
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] font-semibold ${
        allowed
          ? "border-[#1a5c38]/40 bg-[#1a5c38]/5 text-brand-deep"
          : "border-danger/40 bg-danger/5 text-danger"
      }`}
      data-testid={`ibt-rule-${from}-${to}`}
    >
      <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-white" style={{ background: tierColor(from) }}>{from}</span>
      <ArrowsLeftRight size={14} weight="bold" className={allowed ? "text-[#1a5c38]" : "text-danger"} />
      <span className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-white" style={{ background: tierColor(to) }}>{to}</span>
      <Icon size={15} weight="fill" className="ml-1" />
      <span>{allowed ? "Allowed" : "Not allowed"}</span>
    </div>
  );
};

export default StoreClusters;
