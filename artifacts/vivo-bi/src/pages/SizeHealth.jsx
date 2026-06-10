import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtNum, fmtPct, buildParams } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { KPICard } from "@/components/KPICard";
import { Ruler, Warning, CheckCircle, Stack } from "@phosphor-icons/react";

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

const SizeHealth = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion } = applied;
  const filters = { dateFrom, dateTo, countries, channels };

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [brokenOnly, setBrokenOnly] = useState(false);

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
    </div>
  );
};

export default SizeHealth;
