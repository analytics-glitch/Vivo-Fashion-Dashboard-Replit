import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtKES, fmtNum, fmtPct, buildParams } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import RecommendationActionPill from "@/components/RecommendationActionPill";
import { useRecommendationState } from "@/lib/useRecommendationState";
import { useOutliers } from "@/lib/useOutliers";
import {
  ShieldCheck, Warning, MagnifyingGlass, Flag, ChartLineDown,
  CheckCircle, Database, ClockCounterClockwise, Pulse,
} from "@phosphor-icons/react";

/**
 * Data Quality — one admin console covering the whole platform's data
 * health, with four headline sections:
 *
 *   1) Overall score card — colour-coded (>90 green, 75–90 yellow, <75
 *      red) from GET /api/data-quality/report.
 *   2) One check card per quality check (score, detail, failing items).
 *   3) SKU coverage table — one row per data source from
 *      GET /api/data-quality/sku-coverage.
 *   4) Sync-health timeline (last 24h) — read from the sync_health_log
 *      surfaced by GET /api/sync-status (last check + per-store freshness).
 *
 * Below the platform health it keeps the anomaly console: every per-store
 * outlier the 2σ kernel detects, with "mark investigated" state per flag
 * reusing the recommendation_state store (item_type="dq").
 */

// Stable item_key for a DQ flag — includes metric + location so the
// same store can have multiple open anomalies on different metrics.
const dqKey = (metric, location) => `${metric}::${location}`;

const SEVERITY_PILL = {
  severe: "bg-red-100 text-red-700 border-red-300",
  warn:   "bg-amber-100 text-amber-800 border-amber-300",
};

// Score colour bands (spec): >90 green, 75–90 yellow, <75 red.
const scoreBandClass = (s) => {
  if (s === null || s === undefined || isNaN(Number(s))) return "bg-gray-100 text-gray-600 border-gray-300";
  const v = Number(s);
  if (v > 90) return "bg-green-100 text-green-700 border-green-300";
  if (v >= 75) return "bg-amber-100 text-amber-800 border-amber-300";
  return "bg-red-100 text-red-700 border-red-300";
};
const scoreAccentText = (s) => {
  if (s === null || s === undefined || isNaN(Number(s))) return "text-gray-600";
  const v = Number(s);
  if (v > 90) return "text-green-700";
  if (v >= 75) return "text-amber-700";
  return "text-red-700";
};

const humanize = (s) =>
  (s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// "X min ago" / "Xh Ym ago" from a minutes-since value.
const fmtAgo = (mins) => {
  if (mins === null || mins === undefined || isNaN(Number(mins))) return "—";
  const m = Math.max(0, Math.round(Number(mins)));
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
};

// Freshness status from minutes-since: <=6h ok, <=24h watch, else stale.
const freshnessClass = (mins) => {
  if (mins === null || mins === undefined || isNaN(Number(mins))) return "bg-gray-100 text-gray-600 border-gray-300";
  const m = Number(mins);
  if (m <= 360) return "bg-green-100 text-green-700 border-green-300";
  if (m <= 1440) return "bg-amber-100 text-amber-800 border-amber-300";
  return "bg-red-100 text-red-700 border-red-300";
};

const fmtTs = (iso) => {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      timeZone: "Africa/Nairobi",
    }).format(new Date(iso));
  } catch {
    return "—";
  }
};

const DataQuality = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion } = applied;

  // ── Platform data-quality report + SKU coverage + sync timeline ──
  const [report, setReport] = useState(null);
  const [coverage, setCoverage] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState(null);

  useEffect(() => {
    let cancel = false;
    setHealthLoading(true);
    setHealthError(null);
    Promise.allSettled([
      api.get("/data-quality/report"),
      api.get("/data-quality/sku-coverage"),
      api.get("/sync-status"),
    ])
      .then(([repRes, covRes, syncRes]) => {
        if (cancel) return;
        if (repRes.status === "fulfilled") setReport(repRes.value.data || null);
        else setReport(null);
        if (covRes.status === "fulfilled") {
          const d = covRes.value.data;
          setCoverage(Array.isArray(d?.sources) ? d.sources : Array.isArray(d) ? d : []);
        } else setCoverage([]);
        if (syncRes.status === "fulfilled") setSyncStatus(syncRes.value.data || null);
        else setSyncStatus(null);
        // Only hard-error if every section failed.
        if (
          repRes.status === "rejected" &&
          covRes.status === "rejected" &&
          syncRes.status === "rejected"
        ) {
          setHealthError(repRes.reason?.message || "Failed to load data-quality report");
        }
        touchLastUpdated();
      })
      .finally(() => { if (!cancel) setHealthLoading(false); });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion]);

  const overall = report?.overall_score;
  const checks = useMemo(
    () => (Array.isArray(report?.checks) ? report.checks : []),
    [report],
  );

  // Sync timeline rows — per-store freshness within the last 24h plus the
  // most recent sync_health_log check exposed by /api/sync-status.
  const syncStores = useMemo(() => {
    const rows = Array.isArray(syncStatus?.stores) ? syncStatus.stores : [];
    return [...rows].sort((a, b) => (a.minutes_since ?? 1e9) - (b.minutes_since ?? 1e9));
  }, [syncStatus]);

  const stores24h = useMemo(
    () => syncStores.filter((s) => s.minutes_since != null && s.minutes_since <= 1440),
    [syncStores],
  );

  // ── Anomaly console (existing 2σ outlier detection) ──
  const [footfall, setFootfall] = useState([]);
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showResolved, setShowResolved] = useState(false);

  const { stateByKey, setState } = useRecommendationState("dq");

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    const params = buildParams({ dateFrom, dateTo, countries, channels });
    Promise.all([
      api.get("/footfall", { params }),
      api.get("/sales-summary", { params }),
    ])
      .then(([ffRes, sRes]) => {
        if (cancel) return;
        setFootfall(Array.isArray(ffRes.data) ? ffRes.data : []);
        setSales(Array.isArray(sRes.data) ? sRes.data : []);
        touchLastUpdated();
      })
      .catch((e) => { if (!cancel) setError(e?.message || "Failed to load anomalies"); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [dateFrom, dateTo, countries, channels, dataVersion, touchLastUpdated]);

  // --- Anomaly family 1: Footfall CR outliers ---
  const footfallEnriched = useMemo(() => {
    return (footfall || []).map((r) => ({
      ...r,
      physical: !/online/i.test(r.location || ""),
    }));
  }, [footfall]);

  const { enriched: ffFlags, stats: ffStats } = useOutliers(footfallEnriched, {
    valueKey: "conversion_rate",
    filter: (r) => r.physical && (r.total_footfall || 0) >= 200,
    hardHi: { at: 50, reason: "Unusually high CR (>=50%) — likely counter miscalibration" },
    hardLo: { at: 1, reason: "Unusually low CR (<1%) — counter may be over-counting traffic" },
    label: "CR",
    valueFmt: (v) => `${v.toFixed(1)}%`,
  });

  // --- Anomaly family 2: Return-rate outliers (from sales-summary) ---
  const salesEnriched = useMemo(() => {
    return (sales || []).map((r) => {
      const ts = r.total_sales || 0;
      const ret = r.returns || 0;
      return {
        ...r,
        return_rate: ts > 0 ? (ret / ts) * 100 : 0,
      };
    });
  }, [sales]);

  const { enriched: salesFlags, stats: rrStats } = useOutliers(salesEnriched, {
    valueKey: "return_rate",
    filter: (r) => (r.total_sales || 0) >= 100000,
    hardHi: { at: 30, reason: "Return rate >= 30% — investigate before using this store's numbers." },
    label: "return rate",
    valueFmt: (v) => `${v.toFixed(1)}%`,
  });

  const allFlags = useMemo(() => {
    const out = [];
    ffFlags.forEach((r) => {
      if (!r.outlier) return;
      out.push({
        metric: "conversion_rate",
        metric_label: "Conversion",
        location: r.location,
        value: r.conversion_rate || 0,
        value_fmt: fmtPct(r.conversion_rate || 0, 2),
        group_avg: ffStats.mean,
        severity: r.outlier.severity,
        kind: r.outlier.kind,
        reason: r.outlier.reason,
        supporting: `${fmtNum(r.total_footfall)} visitors sampled`,
        distance: ffStats.sd > 0 ? Math.abs((r.conversion_rate - ffStats.mean) / ffStats.sd) : 0,
      });
    });
    salesFlags.forEach((r) => {
      if (!r.outlier) return;
      out.push({
        metric: "return_rate",
        metric_label: "Return rate",
        location: r.channel,
        value: r.return_rate || 0,
        value_fmt: fmtPct(r.return_rate || 0, 2),
        group_avg: rrStats.mean,
        severity: r.outlier.severity,
        kind: r.outlier.kind,
        reason: r.outlier.reason,
        supporting: `${fmtKES(r.total_sales)} sales · ${fmtKES(r.returns || 0)} returns`,
        distance: rrStats.sd > 0 ? Math.abs((r.return_rate - rrStats.mean) / rrStats.sd) : 0,
      });
    });
    const sevWeight = { severe: 2, warn: 1 };
    out.sort((a, b) => (sevWeight[b.severity] || 0) - (sevWeight[a.severity] || 0) || (b.distance - a.distance));
    return out;
  }, [ffFlags, salesFlags, ffStats, rrStats]);

  const visibleFlags = useMemo(() => {
    if (showResolved) return allFlags;
    return allFlags.filter((f) => {
      const s = stateByKey.get(dqKey(f.metric, f.location))?.status;
      return !s || s === "pending";
    });
  }, [allFlags, stateByKey, showResolved]);

  const resolvedCount = useMemo(
    () => allFlags.filter((f) => {
      const s = stateByKey.get(dqKey(f.metric, f.location))?.status;
      return s && s !== "pending";
    }).length,
    [allFlags, stateByKey],
  );

  const severeCount = useMemo(() => allFlags.filter((f) => f.severity === "severe").length, [allFlags]);
  const warnCount = useMemo(() => allFlags.filter((f) => f.severity === "warn").length, [allFlags]);

  return (
    <div className="space-y-4" data-testid="data-quality-page">
      <div>
        <div className="mt-0.5 text-[13.5px] text-muted max-w-2xl">
          Platform data-health at a glance — overall quality score, per-check
          diagnostics, SKU coverage by source, and the sync timeline — followed
          by the per-store anomaly console.
        </div>
      </div>

      {/* ── Section 1+2: Overall score + per-check cards ── */}
      <div className="card-white p-5" data-testid="dq-report-card">
        <SectionTitle
          title="Data Quality Report"
          subtitle="Each check scores 0–100. Overall is the mean across all checks. These measure data-pipeline completeness & freshness (ingest coverage, SKU mapping, sync recency) — not the business correctness of the reported figures."
        />
        {healthLoading ? (
          <Loading label="Scoring data quality…" />
        ) : !report ? (
          <Empty label="Data quality report unavailable right now." />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
            {/* Overall score — colour-coded headline */}
            <div
              className={`rounded-xl border p-4 flex flex-col justify-between ${scoreBandClass(overall)}`}
              data-testid="dq-overall-score"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">Overall Score</span>
                <ShieldCheck size={16} weight="duotone" />
              </div>
              <div className="mt-3 num text-[34px] font-bold leading-none" data-testid="dq-overall-value">
                {overall != null ? fmtPct(overall, 1) : "—"}
              </div>
              <div className="mt-2 text-[11.5px] font-medium">
                {overall == null
                  ? "No score"
                  : overall > 90
                  ? "Healthy — pipeline checks passing"
                  : overall >= 75
                  ? "Watch — some checks degraded"
                  : "At risk — review failing checks"}
              </div>
              {report.checked_at && (
                <div className="mt-1 text-[10.5px] opacity-80">
                  Checked {fmtTs(report.checked_at)}
                </div>
              )}
            </div>

            {/* Per-check cards */}
            {checks.length === 0 ? (
              <div className="lg:col-span-3">
                <Empty label="No individual checks returned." />
              </div>
            ) : (
              checks.map((c) => {
                const failing = Array.isArray(c.failing_locations) ? c.failing_locations : [];
                const ok = (c.status ? c.status === "ok" : Number(c.score) >= 80);
                return (
                  <div
                    key={c.check}
                    className="rounded-xl border border-gray-200 bg-panel/40 p-4"
                    data-testid={`dq-check-${c.check}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-bold text-brand-deep">
                        {humanize(c.check)}
                      </span>
                      {ok ? (
                        <CheckCircle size={16} weight="fill" className="text-green-600" />
                      ) : (
                        <Warning size={16} weight="fill" className="text-red-600" />
                      )}
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className={`num text-[24px] font-bold ${scoreAccentText(c.score)}`}>
                        {c.score != null ? fmtPct(c.score, 1) : "—"}
                      </span>
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9.5px] font-bold border ${scoreBandClass(c.score)}`}
                      >
                        {ok ? "OK" : "Alert"}
                      </span>
                    </div>
                    {c.detail && (
                      <div className="mt-1.5 text-[11.5px] text-foreground/80 leading-snug">
                        {c.detail}
                      </div>
                    )}
                    {failing.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[10.5px] font-semibold text-muted mb-1">
                          Failing items ({failing.length})
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {failing.slice(0, 8).map((f, i) => (
                            <span
                              key={`${c.check}-fail-${i}`}
                              className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[9.5px] font-medium bg-red-50 text-red-700 border border-red-200"
                              title={String(f)}
                            >
                              {String(f)}
                            </span>
                          ))}
                          {failing.length > 8 && (
                            <span className="text-[10px] text-muted">+{failing.length - 8} more</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* ── Section 3: SKU coverage by source ── */}
      <div className="card-white p-5" data-testid="dq-coverage-card">
        <SectionTitle
          title="SKU Coverage by Source"
          subtitle="Share of recent sale lines (90d) that match a product and carry cost, subcategory, and size."
          action={
            <span className="inline-flex items-center gap-1 text-[11.5px] text-muted">
              <Database size={14} weight="duotone" />
              {coverage.length} {coverage.length === 1 ? "source" : "sources"}
            </span>
          }
        />
        {healthLoading ? (
          <Loading label="Measuring coverage…" />
        ) : coverage.length === 0 ? (
          <Empty label="SKU coverage data unavailable." />
        ) : (
          <SortableTable
            testId="dq-coverage-table"
            exportName="sku-coverage.csv"
            mobileCards
            initialSort={{ key: "total_sku_lines", dir: "desc" }}
            columns={[
              {
                key: "source", label: "Source", align: "left", mobilePrimary: true,
                render: (r) => <span className="font-medium">{r.source}</span>,
                csv: (r) => r.source,
              },
              {
                key: "total_sku_lines", label: "SKU Lines", numeric: true,
                render: (r) => <span className="num">{fmtNum(r.total_sku_lines)}</span>,
                csv: (r) => r.total_sku_lines,
                sortValue: (r) => r.total_sku_lines || 0,
              },
              {
                key: "pct_matched", label: "% Matched", numeric: true,
                render: (r) => (
                  <span className={`num font-semibold ${scoreAccentText(r.pct_matched)}`}>
                    {fmtPct(r.pct_matched, 1)}
                  </span>
                ),
                csv: (r) => r.pct_matched,
                sortValue: (r) => r.pct_matched || 0,
              },
              {
                key: "pct_with_cost", label: "% With Cost", numeric: true,
                render: (r) => (
                  <span className={`num ${scoreAccentText(r.pct_with_cost)}`}>
                    {fmtPct(r.pct_with_cost, 1)}
                  </span>
                ),
                csv: (r) => r.pct_with_cost,
                sortValue: (r) => r.pct_with_cost || 0,
                mobileHidden: true,
              },
              {
                key: "pct_with_subcategory", label: "% Subcategory", numeric: true,
                render: (r) => (
                  <span className={`num ${scoreAccentText(r.pct_with_subcategory)}`}>
                    {fmtPct(r.pct_with_subcategory, 1)}
                  </span>
                ),
                csv: (r) => r.pct_with_subcategory,
                sortValue: (r) => r.pct_with_subcategory || 0,
                mobileHidden: true,
              },
              {
                key: "pct_with_size", label: "% Size", numeric: true,
                render: (r) => (
                  <span className={`num ${scoreAccentText(r.pct_with_size)}`}>
                    {fmtPct(r.pct_with_size, 1)}
                  </span>
                ),
                csv: (r) => r.pct_with_size,
                sortValue: (r) => r.pct_with_size || 0,
                mobileHidden: true,
              },
            ]}
            rows={coverage}
          />
        )}
      </div>

      {/* ── Section 4: Sync-health timeline (last 24h) ── */}
      <div className="card-white p-5" data-testid="dq-sync-card">
        <SectionTitle
          title="Sync Health — Last 24 Hours"
          subtitle="Pipeline heartbeat, last recorded health check, and per-store data freshness."
          action={
            syncStatus?.health ? (
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-bold border ${
                  syncStatus.health === "OK"
                    ? "bg-green-100 text-green-700 border-green-300"
                    : syncStatus.health === "WARNING"
                    ? "bg-amber-100 text-amber-800 border-amber-300"
                    : "bg-red-100 text-red-700 border-red-300"
                }`}
              >
                <Pulse size={12} weight="bold" />
                {syncStatus.health}
              </span>
            ) : null
          }
        />
        {healthLoading ? (
          <Loading label="Reading the sync log…" />
        ) : !syncStatus ? (
          <Empty label="Sync status unavailable." />
        ) : (
          <div className="space-y-4">
            {/* Heartbeat + last-check summary timeline */}
            <div className="space-y-2.5">
              <div className="flex items-start gap-2.5" data-testid="dq-sync-heartbeat">
                <ClockCounterClockwise size={16} weight="duotone" className="text-brand mt-0.5" />
                <div className="text-[12px]">
                  <span className="font-semibold text-brand-deep">Last sync cycle</span>{" "}
                  <span className="text-foreground/80">
                    {fmtTs(syncStatus.last_sync_at)} · {fmtAgo(syncStatus.minutes_since)}
                  </span>
                  {syncStatus.last_status && (
                    <span className="text-muted"> · status {syncStatus.last_status}</span>
                  )}
                </div>
              </div>
              {syncStatus.data_freshness && (
                <div className="flex items-start gap-2.5" data-testid="dq-sync-freshness">
                  <Database size={16} weight="duotone" className="text-brand mt-0.5" />
                  <div className="text-[12px]">
                    <span className="font-semibold text-brand-deep">Latest data load</span>{" "}
                    <span className="text-foreground/80">
                      {fmtTs(syncStatus.data_freshness.last_loaded_at)} ·{" "}
                      {fmtAgo(syncStatus.data_freshness.minutes_since)}
                    </span>
                  </div>
                </div>
              )}
              {syncStatus.last_check && (
                <div className="flex items-start gap-2.5" data-testid="dq-sync-lastcheck">
                  {syncStatus.last_check.api_healthy && syncStatus.last_check.sync_healthy ? (
                    <CheckCircle size={16} weight="fill" className="text-green-600 mt-0.5" />
                  ) : (
                    <Warning size={16} weight="fill" className="text-red-600 mt-0.5" />
                  )}
                  <div className="text-[12px]">
                    <span className="font-semibold text-brand-deep">Last health check</span>{" "}
                    <span className="text-foreground/80">{fmtTs(syncStatus.last_check.checked_at)}</span>
                    <span className="text-muted">
                      {" "}· API {syncStatus.last_check.api_healthy ? "healthy" : "down"} · Sync{" "}
                      {syncStatus.last_check.sync_healthy ? "healthy" : "down"}
                    </span>
                    {syncStatus.last_check.action_taken && (
                      <span className="text-muted"> · {syncStatus.last_check.action_taken}</span>
                    )}
                    {syncStatus.last_check.notes && (
                      <div className="text-[11px] text-muted mt-0.5">{syncStatus.last_check.notes}</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Per-store freshness within the last 24h */}
            {stores24h.length === 0 ? (
              <Empty label="No store sync activity recorded in the last 24 hours." />
            ) : (
              <SortableTable
                testId="dq-sync-stores-table"
                exportName="sync-store-freshness.csv"
                mobileCards
                pageSize={25}
                initialSort={{ key: "minutes_since", dir: "asc" }}
                columns={[
                  {
                    key: "store_id", label: "Store", align: "left", mobilePrimary: true,
                    render: (r) => <span className="font-medium">{r.store_id || "Unknown"}</span>,
                    csv: (r) => r.store_id,
                  },
                  {
                    key: "last_sync_at", label: "Last Sync", align: "left",
                    render: (r) => <span className="text-foreground/80">{fmtTs(r.last_sync_at)}</span>,
                    csv: (r) => r.last_sync_at,
                    sortable: false,
                  },
                  {
                    key: "minutes_since", label: "Freshness", numeric: true,
                    render: (r) => (
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9.5px] font-bold border ${freshnessClass(r.minutes_since)}`}
                      >
                        {fmtAgo(r.minutes_since)}
                      </span>
                    ),
                    csv: (r) => Math.round(r.minutes_since || 0),
                    sortValue: (r) => r.minutes_since ?? 1e9,
                  },
                ]}
                rows={stores24h}
              />
            )}
          </div>
        )}
      </div>

      {/* ── Anomaly console (per-store 2σ outliers) ── */}
      {loading ? (
        <Loading label="Scanning for anomalies…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KPICard accent testId="dq-kpi-total" label="Active flags" value={fmtNum(allFlags.length - resolvedCount)} icon={Warning} showDelta={false}
              sub={resolvedCount > 0 ? `${resolvedCount} already investigated` : "all pending"}
            />
            <KPICard testId="dq-kpi-severe" label="Severe"
              sub="Hard-cap triggered (>=50% CR or >=30% returns)"
              value={fmtNum(severeCount)} icon={Flag} showDelta={false} higherIsBetter={false}
            />
            <KPICard testId="dq-kpi-warn" label="Warn"
              sub="Outside 2σ of group mean"
              value={fmtNum(warnCount)} icon={ChartLineDown} showDelta={false} higherIsBetter={false}
            />
            <KPICard testId="dq-kpi-metrics" label="Metrics monitored"
              sub="Conversion · Return rate"
              value="2" showDelta={false}
              action={{ label: "Learn how it works", onClick: () => document.querySelector('[data-testid="dq-how"]')?.scrollIntoView({ behavior: "smooth" }) }}
            />
          </div>

          <div className="card-white p-5" data-testid="dq-table-card">
            <SectionTitle
              title={`Flags · ${visibleFlags.length} of ${allFlags.length}${showResolved ? "" : " open"}`}
              subtitle={
                allFlags.length === 0
                  ? "No anomalies in the current window — data looks clean."
                  : "Each row is a single metric + location flagged by the 2σ kernel. Mark as investigated (PO raised), resolved (Done), or dismissed to silence it for next session."
              }
              action={
                <label className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-brand-deep cursor-pointer" data-testid="dq-show-resolved">
                  <input
                    type="checkbox"
                    checked={showResolved}
                    onChange={(e) => setShowResolved(e.target.checked)}
                    className="accent-brand"
                  />
                  Show resolved ({resolvedCount})
                </label>
              }
            />
            {visibleFlags.length === 0 ? (
              <Empty label={
                allFlags.length === 0
                  ? "No anomalies detected by the pipeline checks right now."
                  : "Every open flag has been investigated. Toggle 'Show resolved' to review."
              } />
            ) : (
              <SortableTable
                testId="dq-flags-table"
                exportName="data-quality-flags.csv"
                pageSize={50}
                initialSort={{ key: "distance", dir: "desc" }}
                columns={[
                  {
                    key: "severity", label: "Severity", align: "left",
                    render: (r) => (
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9.5px] font-bold border ${SEVERITY_PILL[r.severity]}`}>
                        <Warning size={10} weight="fill" />
                        {r.severity === "severe" ? "Severe" : "Warn"}
                      </span>
                    ),
                    csv: (r) => r.severity,
                  },
                  {
                    key: "location", label: "Store / Scope", align: "left",
                    render: (r) => <span className="font-medium">{r.location}</span>,
                  },
                  {
                    key: "metric_label", label: "Metric", align: "left",
                    render: (r) => <span className="pill-neutral">{r.metric_label}</span>,
                  },
                  {
                    key: "value", label: "Value", numeric: true,
                    render: (r) => (
                      <span className="font-bold text-brand-deep num">{r.value_fmt}</span>
                    ),
                    csv: (r) => r.value?.toFixed(2),
                  },
                  {
                    key: "group_avg", label: "Group Avg", numeric: true,
                    render: (r) => <span className="text-muted num">{fmtPct(r.group_avg, 2)}</span>,
                    csv: (r) => r.group_avg?.toFixed(2),
                  },
                  {
                    key: "distance", label: "σ", numeric: true,
                    render: (r) => <span className="pill-neutral">{r.distance.toFixed(1)}σ</span>,
                    csv: (r) => r.distance.toFixed(2),
                  },
                  {
                    key: "reason", label: "Reason", align: "left",
                    sortable: false,
                    render: (r) => <span className="text-[11.5px] text-foreground/80">{r.reason}</span>,
                    csv: (r) => r.reason,
                  },
                  {
                    key: "supporting", label: "Supporting", align: "left", sortable: false,
                    render: (r) => <span className="text-[11px] text-muted">{r.supporting}</span>,
                    csv: (r) => r.supporting,
                  },
                  {
                    key: "__action", label: "Action", align: "left", sortable: false,
                    render: (r) => {
                      const k = dqKey(r.metric, r.location);
                      return (
                        <RecommendationActionPill
                          itemKey={k}
                          state={stateByKey.get(k)}
                          onChange={(status, opts) => setState(k, status, opts)}
                          label="data-quality flag"
                        />
                      );
                    },
                    csv: (r) => stateByKey.get(dqKey(r.metric, r.location))?.status || "pending",
                  },
                ]}
                rows={visibleFlags}
              />
            )}
          </div>

          <div className="card-white p-5" data-testid="dq-how">
            <div className="flex items-center gap-2 mb-2 text-brand-deep">
              <MagnifyingGlass size={14} weight="fill" />
              <div className="text-[13px] font-bold">How this works</div>
            </div>
            <ul className="text-[12.5px] text-foreground/85 space-y-1.5 leading-snug">
              <li>
                <span className="font-bold text-brand-deep">Conversion outliers.</span>{" "}
                Over physical stores with &gt;= 200 visitors, we compute the group mean ({fmtPct(ffStats.mean, 2)})
                and standard deviation ({fmtPct(ffStats.sd, 2)}pp). Any store outside ±2σ is flagged.
                Hard caps: &gt;= 50% or &lt; 1% always severe.
              </li>
              <li>
                <span className="font-bold text-brand-deep">Return-rate outliers.</span>{" "}
                Over stores with &gt;= KES 100k sales, same 2σ math. Group mean {fmtPct(rrStats.mean, 2)} ± {fmtPct(rrStats.sd, 2)}pp.
                Hard cap: &gt;= 30% return rate is always severe.
              </li>
              <li>
                <span className="font-bold text-brand-deep">State is yours.</span>{" "}
                Flags you mark as investigated / dismissed / done only affect your session — your
                colleagues see the full list. Reset a decision anytime via the action menu.
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
};

export default DataQuality;
