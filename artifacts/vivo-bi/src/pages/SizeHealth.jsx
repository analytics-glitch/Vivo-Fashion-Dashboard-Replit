import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFilters } from "@/lib/filters";
import { api, fmtNum, fmtPct, fmtKES, buildParams } from "@/lib/api";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { KPICard } from "@/components/KPICard";
import { Ruler, Warning, CheckCircle, Stack, ArrowsLeftRight } from "@phosphor-icons/react";

// Size & Color Curve Health — flags styles whose catalogued sizes are out of
// stock across selling locations (warehouses excluded). Best-sellers with
// broken curves surface first so the lost-sales risk is actionable.

const healthTag = (h) => {
  const v = Number(h);
  if (h === null || h === undefined || isNaN(v)) return { label: "—", cls: "text-muted" };
  if (v >= 80) return { label: `${v}%`, cls: "text-brand font-semibold" };
  if (v >= 50) return { label: `${v}%`, cls: "text-amber-600 font-semibold" };
  return { label: `${v}%`, cls: "text-danger font-semibold" };
};

// Color for the progress bar fill, mirroring the health thresholds.
const healthBarColor = (v) => {
  const n = Number(v);
  if (isNaN(n)) return "#9ca3af";
  if (n >= 80) return "#1a5c38"; // brand green
  if (n >= 50) return "#d97706"; // amber
  return "#dc2626"; // danger red
};

// Horizontal progress bar used by the store size-run health table.
const HealthBar = ({ value }) => {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="flex items-center gap-2 min-w-[140px]">
      <div className="flex-1 h-2 rounded-full bg-panel overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${n}%`, backgroundColor: healthBarColor(n) }}
        />
      </div>
      <span className="text-[12px] font-semibold tabular-nums" style={{ color: healthBarColor(n) }}>
        {fmtPct(n)}
      </span>
    </div>
  );
};

const SizeHealth = () => {
  const navigate = useNavigate();
  const { applied, touchLastUpdated } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion } = applied;
  const filters = { dateFrom, dateTo, countries, channels };

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [brokenOnly, setBrokenOnly] = useState(false);

  // Size gaps + store size-run health are filtered by country only (the
  // endpoints accept a single `country` query param). Pass it only when the
  // user has narrowed to exactly one country, mirroring shared conventions.
  const country = countries.length === 1 ? countries[0] : undefined;

  const [gaps, setGaps] = useState([]);
  const [gapsLoading, setGapsLoading] = useState(true);
  const [gapsError, setGapsError] = useState(null);

  const [storeHealth, setStoreHealth] = useState([]);
  const [shLoading, setShLoading] = useState(true);
  const [shError, setShError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/analytics/size-curve", { params: buildParams(filters) })
      .then((r) => {
        if (cancelled) return;
        setRows(r.data || []);
        touchLastUpdated();
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [dateFrom, dateTo, JSON.stringify(countries), JSON.stringify(channels), dataVersion]);

  useEffect(() => {
    let cancelled = false;
    setGapsLoading(true);
    setGapsError(null);
    api
      .get("/analytics/size-gaps", { params: country ? { country } : {} })
      .then((r) => {
        if (cancelled) return;
        setGaps(r.data?.gaps || []);
      })
      .catch((e) => !cancelled && setGapsError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setGapsLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [JSON.stringify(countries), dataVersion]);

  useEffect(() => {
    let cancelled = false;
    setShLoading(true);
    setShError(null);
    api
      .get("/analytics/size-run-health", { params: country ? { country } : {} })
      .then((r) => {
        if (cancelled) return;
        setStoreHealth(r.data?.stores || []);
      })
      .catch((e) => !cancelled && setShError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setShLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [JSON.stringify(countries), dataVersion]);

  const view = useMemo(
    () => (brokenOnly ? rows.filter((r) => Number(r.broken_sizes || 0) > 0) : rows),
    [rows, brokenOnly]
  );

  const k = useMemo(() => {
    const broken = rows.filter((r) => Number(r.broken_sizes || 0) > 0);
    const whole = rows.length - broken.length;
    const avgHealth = rows.length
      ? rows.reduce((s, r) => s + Number(r.health_pct || 0), 0) / rows.length
      : 0;
    const missingUnits = broken.reduce((s, r) => s + Number(r.units_sold || 0), 0);
    return { styles: rows.length, broken: broken.length, whole, avgHealth, missingUnits };
  }, [rows]);

  const columns = [
    { key: "style_name", label: "Style", mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.style_name || "—"}</span> },
    { key: "brand", label: "Brand", render: (r) => r.brand || "—" },
    { key: "category", label: "Category", render: (r) => r.category || "—" },
    { key: "units_sold", label: "Units Sold", numeric: true, render: (r) => fmtNum(r.units_sold) },
    { key: "total_sizes", label: "Sizes", numeric: true, render: (r) => fmtNum(r.total_sizes) },
    { key: "sizes_in_stock", label: "In Stock", numeric: true, render: (r) => fmtNum(r.sizes_in_stock) },
    { key: "broken_sizes", label: "Broken", numeric: true,
      render: (r) => { const b = Number(r.broken_sizes || 0); return <span className={b > 0 ? "text-danger font-semibold" : "text-muted"}>{fmtNum(b)}</span>; } },
    { key: "health_pct", label: "Curve Health", numeric: true,
      render: (r) => { const t = healthTag(r.health_pct); return <span className={t.cls}>{t.label}</span>; },
      csv: (r) => `${Number(r.health_pct || 0)}%` },
    { key: "missing_sizes", label: "Missing Sizes", sortable: false, mobileHidden: true,
      render: (r) => <span className="text-[12px] text-muted">{r.missing_sizes || "—"}</span> },
  ];

  // Size gaps: per-store broken-curve opportunities with cross-store source
  // stock. An "IBT Available" badge surfaces where another store can supply
  // the missing sizes (ibt_opportunity: there is at least one source store).
  const gapColumns = [
    { key: "store", label: "Store", mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.store || "—"}</span> },
    { key: "style_name", label: "Style",
      render: (r) => {
        const ibtAvailable = (r.source_stores_with_stock || []).length > 0;
        return (
          <div className="flex items-center gap-2 flex-wrap">
            <span>{r.style_name || "—"}</span>
            {ibtAvailable && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"
                data-testid="ibt-available-badge"
              >
                IBT Available
              </span>
            )}
          </div>
        );
      },
      csv: (r) => r.style_name || "" },
    { key: "missing_sizes", label: "Missing Sizes", sortable: false,
      render: (r) => (
        <div className="flex flex-wrap gap-1">
          {(r.missing_sizes || []).length
            ? (r.missing_sizes || []).map((s, i) => (
                <span key={i} className="pill-amber text-[11px] px-1.5 py-0.5">{s}</span>
              ))
            : <span className="text-muted">—</span>}
        </div>
      ),
      csv: (r) => (r.missing_sizes || []).join(" | ") },
    { key: "chain_demand_for_missing", label: "Chain Demand", numeric: true,
      render: (r) => fmtNum(r.chain_demand_for_missing),
      sortValue: (r) => Number(r.chain_demand_for_missing || 0) },
    { key: "estimated_lost_sales_kes", label: "Est. Lost Sales", numeric: true,
      render: (r) => <span className="text-danger font-semibold">{fmtKES(r.estimated_lost_sales_kes)}</span>,
      csv: (r) => Number(r.estimated_lost_sales_kes || 0),
      sortValue: (r) => Number(r.estimated_lost_sales_kes || 0) },
    { key: "source_stores_with_stock", label: "Source Stores Available", sortable: false, mobileHidden: true,
      render: (r) => {
        const src = r.source_stores_with_stock || [];
        if (!src.length) return <span className="text-muted">None</span>;
        return <span className="text-[12px]">{src.join(", ")}</span>;
      },
      csv: (r) => (r.source_stores_with_stock || []).join(" | ") },
    { key: "_action", label: "", sortable: false, exportInclude: false,
      render: (r) => {
        const ibtAvailable = (r.source_stores_with_stock || []).length > 0;
        return (
          <button
            type="button"
            onClick={() => navigate("/ibt")}
            disabled={!ibtAvailable}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] font-medium border transition ${
              ibtAvailable
                ? "bg-brand text-white border-brand hover:opacity-90"
                : "bg-panel text-muted border-transparent cursor-not-allowed"
            }`}
            data-testid="create-ibt-btn"
            title={ibtAvailable ? "Create an inter-branch transfer" : "No source store with stock"}
          >
            <ArrowsLeftRight size={13} />
            Create IBT
          </button>
        );
      } },
  ];

  const shColumns = [
    { key: "store", label: "Store", mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.store || "—"}</span> },
    { key: "avg_size_run_health_pct", label: "Size-Run Health", numeric: true,
      render: (r) => <HealthBar value={r.avg_size_run_health_pct} />,
      csv: (r) => `${Number(r.avg_size_run_health_pct || 0)}%`,
      sortValue: (r) => Number(r.avg_size_run_health_pct || 0) },
    { key: "styles_evaluated", label: "Styles Evaluated", numeric: true,
      render: (r) => fmtNum(r.styles_evaluated) },
    { key: "styles_with_broken_runs", label: "Broken Runs", numeric: true,
      render: (r) => { const b = Number(r.styles_with_broken_runs || 0); return <span className={b > 0 ? "text-danger font-semibold" : "text-muted"}>{fmtNum(b)}</span>; } },
    { key: "styles_fully_stocked", label: "Fully Stocked", numeric: true,
      render: (r) => fmtNum(r.styles_fully_stocked) },
  ];

  if (loading) return <Loading label="Checking size curves…" />;
  if (error) return <ErrorBox message={error} />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard label="Styles Tracked" value={fmtNum(k.styles)} icon={Stack} testId="kpi-sh-styles" showDelta={false} />
        <KPICard label="Broken Curves" value={fmtNum(k.broken)} icon={Warning} testId="kpi-sh-broken" showDelta={false} sub="One or more sizes out of stock" />
        <KPICard label="Fully Stocked" value={fmtNum(k.whole)} icon={CheckCircle} testId="kpi-sh-whole" showDelta={false} />
        <KPICard label="Avg Curve Health" value={fmtPct(k.avgHealth)} icon={Ruler} testId="kpi-sh-health" showDelta={false} formula="Average of (sizes in stock ÷ catalogued sizes) across styles" />
      </div>

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title="Size Curve Health by Style"
          subtitle="A broken curve means catalogued sizes are out of stock in selling locations. Styles with ≥ 2 sizes; warehouses excluded."
          testId="size-health-section"
          action={
            <label className="inline-flex items-center gap-2 text-[12px] text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={brokenOnly}
                onChange={(e) => setBrokenOnly(e.target.checked)}
                data-testid="size-health-broken-only"
              />
              Broken curves only
            </label>
          }
        />
        <SortableTable
          columns={columns}
          rows={view}
          initialSort={{ key: "units_sold", dir: "desc" }}
          secondarySort={{ key: "broken_sizes", dir: "desc" }}
          exportName="size-curve-health.csv"
          testId="size-health-table"
          pageSize={50}
          mobileCards
          emptyLabel="No styles for the selected filters."
        />
      </div>

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title="Size Gaps & IBT Opportunities"
          subtitle="Stores missing in-demand sizes (last 30 days, selling locations only). Where another store holds stock, raise an inter-branch transfer."
          testId="size-gaps-section"
        />
        {gapsLoading ? (
          <Loading label="Finding size gaps…" />
        ) : gapsError ? (
          <ErrorBox message={gapsError} />
        ) : gaps.length === 0 ? (
          <Empty label="No size gaps for the selected filters." />
        ) : (
          <SortableTable
            columns={gapColumns}
            rows={gaps}
            initialSort={{ key: "estimated_lost_sales_kes", dir: "desc" }}
            exportName="size-gaps.csv"
            testId="size-gaps-table"
            pageSize={50}
            mobileCards
            emptyLabel="No size gaps for the selected filters."
          />
        )}
      </div>

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title="Store Size-Run Health Scores"
          subtitle="Average size-run completeness per store (last 90 days). Lower scores carry more broken curves and lost-sales risk."
          testId="size-run-health-section"
        />
        {shLoading ? (
          <Loading label="Scoring stores…" />
        ) : shError ? (
          <ErrorBox message={shError} />
        ) : storeHealth.length === 0 ? (
          <Empty label="No store size-run data for the selected filters." />
        ) : (
          <SortableTable
            columns={shColumns}
            rows={storeHealth}
            initialSort={{ key: "avg_size_run_health_pct", dir: "asc" }}
            exportName="store-size-run-health.csv"
            testId="size-run-health-table"
            pageSize={50}
            mobileCards
            emptyLabel="No store size-run data for the selected filters."
          />
        )}
      </div>
    </div>
  );
};

export default SizeHealth;
