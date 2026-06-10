import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtNum, fmtKESLong, fmtDate } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { DownloadSimple, Table } from "@phosphor-icons/react";

// Custom Report builder. The user picks dimensions + measures from a fixed,
// server-whitelisted set; the backend (`/api/custom-report`) does a safe
// aggregation against all_sales (never raw user SQL). Date range + country /
// channel come from the global filter bar so it stays consistent with the
// rest of the dashboard.

// Fallback field lists, used until /api/custom-report/fields resolves (and if
// it ever fails). The server is the source of truth for the whitelist; we
// hydrate from it on mount so this page can't drift from the backend.
const DEFAULT_DIMENSIONS = [
  { id: "country", label: "Country", group: "Geography" },
  { id: "channel", label: "Channel", group: "Geography" },
  { id: "store", label: "Store", group: "Geography" },
  { id: "brand", label: "Brand", group: "Product" },
  { id: "category", label: "Category", group: "Product" },
  { id: "subcategory", label: "Subcategory", group: "Product" },
  { id: "month", label: "Month", group: "Time" },
];

const DEFAULT_MEASURES = [
  { id: "revenue", label: "Revenue (KES)", group: "Sales" },
  { id: "net_revenue", label: "Net Revenue (KES)", group: "Sales" },
  { id: "gross_revenue", label: "Gross Revenue (KES)", group: "Sales" },
  { id: "returns", label: "Returns (KES)", group: "Sales" },
  { id: "discounts", label: "Discounts (KES)", group: "Sales" },
  { id: "units", label: "Units Sold", group: "Sales" },
  { id: "orders", label: "Orders", group: "Sales" },
  { id: "aov", label: "Avg Order Value (KES)", group: "Sales" },
  { id: "asp", label: "Avg Selling Price (KES)", group: "Sales" },
  { id: "customers", label: "Customers", group: "Customers" },
  { id: "soh", label: "Stock on Hand", group: "Inventory" },
  { id: "sor", label: "Sell-Through %", group: "Inventory" },
];

// Measures rendered as KES money vs plain counts vs a percentage. Kept in sync
// with the server whitelist (_REPORT_MEASURES / _INVENTORY_MEASURES in api_pg.py).
const MONEY_MEASURES = new Set([
  "revenue", "net_revenue", "gross_revenue", "returns", "discounts", "aov", "asp",
]);

// Group chips under their `group` so the (now longer) field lists stay scannable.
const groupBy = (items) => {
  const out = [];
  const idx = new Map();
  for (const it of items) {
    const g = it.group || "Other";
    if (!idx.has(g)) { idx.set(g, out.length); out.push({ group: g, items: [] }); }
    out[idx.get(g)].items.push(it);
  }
  return out;
};

const Chip = ({ active, onClick, children, testId }) => (
  <button
    type="button"
    onClick={onClick}
    data-testid={testId}
    aria-pressed={active}
    className={`px-3 py-1.5 rounded-full text-[12px] font-semibold border transition-colors ${
      active
        ? "bg-brand text-white border-brand"
        : "bg-white text-foreground border-border hover:bg-panel"
    }`}
  >
    {children}
  </button>
);

const fmtMeasure = (id, val) => {
  if (val === null || val === undefined) return "—";
  if (MONEY_MEASURES.has(id)) return fmtKESLong(val);
  if (id === "sor") return `${fmtNum(val)}%`;
  return fmtNum(val);
};

const CustomReport = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion } = applied;

  const [dimOptions, setDimOptions] = useState(DEFAULT_DIMENSIONS);
  const [measOptions, setMeasOptions] = useState(DEFAULT_MEASURES);

  const [dims, setDims] = useState(["country"]);
  const [meas, setMeas] = useState(["revenue", "units", "orders"]);

  // On-page date selector. Seeded from the global filter bar's applied range so
  // it stays consistent, but can be overridden here without touching the global
  // filters. Changing it re-runs the report (once the report has been run once).
  const [localFrom, setLocalFrom] = useState(dateFrom);
  const [localTo, setLocalTo] = useState(dateTo);
  useEffect(() => { setLocalFrom(dateFrom); setLocalTo(dateTo); }, [dateFrom, dateTo]);

  // Hydrate the available fields from the server whitelist so the chips can
  // never drift from the backend. Falls back silently to the defaults.
  useEffect(() => {
    let cancelled = false;
    api
      .get("/custom-report/fields")
      .then((r) => {
        if (cancelled || !r.data) return;
        if (Array.isArray(r.data.dimensions) && r.data.dimensions.length) {
          setDimOptions(r.data.dimensions);
        }
        if (Array.isArray(r.data.measures) && r.data.measures.length) {
          setMeasOptions(r.data.measures);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Bumped on every "Run report" press so the effect refetches even when the
  // dims/meas/filters are unchanged.
  const [runToken, setRunToken] = useState(0);
  // The selection that was actually used for the currently-shown report.
  const [ranWith, setRanWith] = useState(null);

  const toggle = (list, setList, id) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const validDateRange = !!localFrom && !!localTo && localFrom <= localTo;
  const canRun = dims.length > 0 && meas.length > 0 && validDateRange;

  useEffect(() => {
    if (runToken === 0) return; // don't auto-run on first mount
    if (!canRun) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const country = countries.length ? countries.join(",") : undefined;
    const channel = channels.length ? channels.join(",") : undefined;
    const usedDims = [...dims];
    const usedMeas = [...meas];
    api
      .get("/custom-report", {
        params: {
          dimensions: usedDims.join(","),
          measures: usedMeas.join(","),
          date_from: localFrom,
          date_to: localTo,
          country,
          channel,
          limit: 2000,
        },
      })
      .then((r) => {
        if (cancelled) return;
        setReport(r.data || null);
        setRanWith({ dims: usedDims, meas: usedMeas });
        touchLastUpdated();
      })
      .catch((e) => {
        if (cancelled) return;
        const detail = e?.response?.data?.detail;
        setError(typeof detail === "string" ? detail : e.message || "Request failed");
        setReport(null);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [runToken, localFrom, localTo, JSON.stringify(countries), JSON.stringify(channels), dataVersion]);

  const columns = useMemo(() => {
    if (!report || !ranWith) return [];
    const dimCols = report.dimensions.map((d) => ({
      key: d.id,
      label: d.label,
      align: "left",
      render: (row) => <span className="font-medium">{row[d.id] ?? "—"}</span>,
      csv: (row) => row[d.id],
    }));
    const measCols = report.measures.map((m) => ({
      key: m.id,
      label: m.label,
      numeric: true,
      render: (row) => (
        <span className="font-semibold tabular-nums">{fmtMeasure(m.id, row[m.id])}</span>
      ),
      csv: (row) => row[m.id],
    }));
    return [...dimCols, ...measCols];
  }, [report, ranWith]);

  const exportCsv = () => {
    if (!report?.rows?.length) return;
    const cols = [...report.dimensions, ...report.measures];
    const esc = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const metaLines = [
      `# Vivo BI · Custom Report`,
      `# Dimensions: ${report.dimensions.map((d) => d.label).join("; ")}`,
      `# Measures: ${report.measures.map((m) => m.label).join("; ")}`,
      `# Date range: ${fmtDate(localFrom)} to ${fmtDate(localTo)}`,
      `# Country: ${countries.length ? countries.join("; ") : "All"}`,
      `# Channel: ${channels.length ? channels.join("; ") : "All"}`,
      `# Rows: ${report.row_count}`,
      "",
    ];
    const lines = [...metaLines, cols.map((c) => c.label).join(",")];
    for (const r of report.rows) {
      lines.push(cols.map((c) => esc(r[c.id])).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `custom-report-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5" data-testid="custom-report-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-muted text-[13px]">
            Build your own breakdown: pick the dimensions to group by and the
            measures to total, choose a date range, then run and export to CSV.
            Country and channel come from the filter bar above.
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!report?.rows?.length}
          data-testid="custom-report-csv-btn"
          className="btn-primary flex items-center gap-1.5 disabled:opacity-50"
        >
          <DownloadSimple size={14} weight="bold" />
          Download CSV{report?.rows?.length ? ` (${fmtNum(report.rows.length)} rows)` : ""}
        </button>
      </div>

      <div className="card-white p-4 space-y-4" data-testid="custom-report-builder">
        <div>
          <div className="eyebrow mb-2">Date range</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={localFrom || ""}
              max={localTo || undefined}
              onChange={(e) => setLocalFrom(e.target.value)}
              data-testid="custom-report-date-from"
              className="rounded-lg border border-border bg-white px-3 py-1.5 text-[12.5px] font-medium text-foreground focus:border-brand focus:outline-none"
            />
            <span className="text-[12px] text-muted">to</span>
            <input
              type="date"
              value={localTo || ""}
              min={localFrom || undefined}
              onChange={(e) => setLocalTo(e.target.value)}
              data-testid="custom-report-date-to"
              className="rounded-lg border border-border bg-white px-3 py-1.5 text-[12.5px] font-medium text-foreground focus:border-brand focus:outline-none"
            />
            <span className="text-[11.5px] text-muted">
              Seeded from the filter bar — change here to override for this report.
            </span>
          </div>
        </div>
        <div>
          <div className="eyebrow mb-2">Group by (dimensions)</div>
          <div className="space-y-2">
            {groupBy(dimOptions).map((grp) => (
              <div key={grp.group} className="flex flex-wrap items-center gap-2">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted w-[68px] shrink-0">
                  {grp.group}
                </span>
                {grp.items.map((d) => (
                  <Chip
                    key={d.id}
                    active={dims.includes(d.id)}
                    onClick={() => toggle(dims, setDims, d.id)}
                    testId={`custom-report-dim-${d.id}`}
                  >
                    {d.label}
                  </Chip>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="eyebrow mb-2">Measures</div>
          <div className="space-y-2">
            {groupBy(measOptions).map((grp) => (
              <div key={grp.group} className="flex flex-wrap items-center gap-2">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted w-[68px] shrink-0">
                  {grp.group}
                </span>
                {grp.items.map((m) => (
                  <Chip
                    key={m.id}
                    active={meas.includes(m.id)}
                    onClick={() => toggle(meas, setMeas, m.id)}
                    testId={`custom-report-measure-${m.id}`}
                  >
                    {m.label}
                  </Chip>
                ))}
              </div>
            ))}
          </div>
          <p className="text-[11.5px] text-muted mt-2">
            Stock on Hand and Sell-Through % are inventory measures — they can only
            be grouped by Country, Store, Brand, Category or Subcategory (not Channel or Month).
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => setRunToken((t) => t + 1)}
            disabled={!canRun || loading}
            data-testid="custom-report-run"
            className="btn-primary flex items-center gap-1.5 disabled:opacity-50"
          >
            <Table size={14} weight="bold" />
            {loading ? "Running…" : "Run report"}
          </button>
          {!canRun && (
            <span className="text-[12px] text-muted">
              {dims.length === 0 || meas.length === 0
                ? "Pick at least one dimension and one measure."
                : "Choose a valid date range (start on or before end)."}
            </span>
          )}
        </div>
      </div>

      {loading && <Loading label="Building report…" />}
      {error && <ErrorBox message={error} />}

      {!loading && !error && report && (
        <div className="card-white p-5" data-testid="custom-report-results">
          <SectionTitle
            title={`${fmtNum(report.row_count)} rows`}
            subtitle={`Grouped by ${report.dimensions.map((d) => d.label).join(" × ")} · ${fmtDate(localFrom)} to ${fmtDate(localTo)}${report.truncated ? " · truncated to first 2,000 rows" : ""}`}
          />
          {report.rows.length === 0 ? (
            <Empty label="No data matches the current selection." />
          ) : (
            <SortableTable
              testId="custom-report-table"
              initialSort={{ key: report.measures[0]?.id, dir: "desc" }}
              columns={columns}
              rows={report.rows}
            />
          )}
        </div>
      )}

      {!loading && !error && !report && (
        <div className="card-white p-8 text-center" data-testid="custom-report-empty">
          <Table size={28} weight="duotone" className="mx-auto text-muted mb-2" />
          <div className="text-[13px] text-muted">
            Choose your dimensions and measures above, then press{" "}
            <span className="font-semibold text-foreground">Run report</span>.
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomReport;
