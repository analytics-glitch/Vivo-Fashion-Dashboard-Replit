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
  { id: "country", label: "Country" },
  { id: "channel", label: "Channel" },
  { id: "brand", label: "Brand" },
  { id: "category", label: "Category" },
  { id: "subcategory", label: "Subcategory" },
  { id: "store", label: "Store" },
  { id: "month", label: "Month" },
];

const DEFAULT_MEASURES = [
  { id: "revenue", label: "Revenue (KES)" },
  { id: "units", label: "Units" },
  { id: "orders", label: "Orders" },
  { id: "customers", label: "Customers" },
];

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

const fmtMeasure = (id, val) =>
  id === "revenue" ? fmtKESLong(val) : fmtNum(val);

const CustomReport = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion } = applied;

  const [dimOptions, setDimOptions] = useState(DEFAULT_DIMENSIONS);
  const [measOptions, setMeasOptions] = useState(DEFAULT_MEASURES);

  const [dims, setDims] = useState(["country"]);
  const [meas, setMeas] = useState(["revenue", "units", "orders"]);

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

  const canRun = dims.length > 0 && meas.length > 0;

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
          date_from: dateFrom,
          date_to: dateTo,
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
  }, [runToken, dateFrom, dateTo, JSON.stringify(countries), JSON.stringify(channels), dataVersion]);

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
      `# Date range: ${fmtDate(dateFrom)} to ${fmtDate(dateTo)}`,
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
          <h2 className="font-extrabold text-[18px] sm:text-[20px] tracking-tight">
            Custom Report
          </h2>
          <p className="text-muted text-[13px] mt-0.5">
            Build your own breakdown: pick the dimensions to group by and the
            measures to total, then run and export to CSV. Date range, country
            and channel come from the filter bar above.
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
          <div className="eyebrow mb-2">Group by (dimensions)</div>
          <div className="flex flex-wrap gap-2">
            {dimOptions.map((d) => (
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
        </div>
        <div>
          <div className="eyebrow mb-2">Measures</div>
          <div className="flex flex-wrap gap-2">
            {measOptions.map((m) => (
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
              Pick at least one dimension and one measure.
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
            subtitle={`Grouped by ${report.dimensions.map((d) => d.label).join(" × ")} · ${fmtDate(dateFrom)} to ${fmtDate(dateTo)}${report.truncated ? " · truncated to first 2,000 rows" : ""}`}
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
