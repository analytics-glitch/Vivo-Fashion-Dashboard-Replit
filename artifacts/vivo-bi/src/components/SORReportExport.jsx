import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtKES, fmtNum, fmtDate } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import MultiSelect from "@/components/MultiSelect";
import LaunchMonthFilter, { filterByLaunchMonths } from "@/components/LaunchMonthFilter";
import { DownloadSimple, MagnifyingGlass, X } from "@phosphor-icons/react";

/**
 * SOR Report — catalog-wide style sell-through report.
 *
 * Master table: one row per style, compact density (sor-compact CSS).
 * Column order: Style Name, Style # first; Category / Sub Category LAST.
 * A custom date range drives the "Selected Period" columns (SOR Sel,
 * ASP Sel, % of Full Price) — defaults to the trailing 180 days.
 *
 * Each row expands to a PER-COLOUR table with the exact same column set
 * as the master row (backend /analytics/sor-style-colors). Clicking a
 * colour row filters the per-location pane on the right.
 */

// Shared metric column definitions used by BOTH the master style table and
// the expanded per-colour table so the two always show identical columns.
// Actual length in days of the selected period (inclusive). Falls back to
// the backend default of 180 days when no custom range is set.
const selPeriodDays = (dateFrom, dateTo) => {
  const from = dateFrom ? new Date(dateFrom + "T00:00:00") : null;
  const to = dateTo ? new Date(dateTo + "T00:00:00") : new Date();
  if (!from || isNaN(from) || isNaN(to)) return 180;
  const days = Math.round((to - from) / 86400000) + 1;
  return days > 0 ? days : 180;
};

const metricColumns = (selDays = 180) => [
  { key: "sales_sel", label: `Sales Sel (${selDays}d)`, sortable: true, align: "right",
    render: (r) => fmtKES(r.sales_sel) },
  { key: "units_sel", label: `Units Sel (${selDays}d)`, sortable: true, align: "right",
    render: (r) => fmtNum(r.units_sel) },
  { key: "weekly_avg", label: "Wk Avg", sortable: true, align: "right",
    render: (r) => (r.weekly_avg ?? 0).toFixed(1) },
  { key: "units_since_launch", label: "Units Life", sortable: true, align: "right",
    render: (r) => fmtNum(r.units_since_launch) },
  { key: "soh_total", label: "SOH", sortable: true, align: "right",
    render: (r) => fmtNum(r.soh_total) },
  { key: "soh_wh", label: "SOH WH", sortable: true, align: "right",
    render: (r) => fmtNum(r.soh_wh) },
  { key: "soh_pipeline", label: "SOH Pipeline", sortable: true, align: "right",
    render: (r) => (r.soh_pipeline ? fmtNum(r.soh_pipeline) : "—") },
  { key: "woc", label: "WoC", sortable: true, align: "right",
    sortValue: (r) => r.woc == null ? 9999 : r.woc,
    render: (r) => {
      if (r.woc == null) return <span className="text-muted">—</span>;
      const cls = r.woc < 4 ? "text-emerald-600 font-bold" : r.woc < 12 ? "text-emerald-500" : r.woc < 26 ? "text-amber-600" : "text-rose-600";
      return <span className={cls}>{r.woc.toFixed(1)}w</span>;
    } },
  { key: "pct_in_wh", label: "% WH", sortable: true, align: "right",
    render: (r) => `${(r.pct_in_wh ?? 0).toFixed(1)}%` },
  { key: "asp_6m", label: "ASP 6M", sortable: true, align: "right",
    render: (r) => r.asp_6m == null ? <span className="text-muted">—</span> : fmtKES(r.asp_6m) },
  { key: "original_price", label: "Full Price", sortable: true, align: "right",
    render: (r) => r.original_price == null ? <span className="text-muted">—</span> : fmtKES(r.original_price) },
  { key: "days_since_last_sale", label: "Last Sale", sortable: true, align: "right",
    render: (r) => {
      const d = r.days_since_last_sale;
      if (d == null) return <span className="text-muted">—</span>;
      const cls = d > 60 ? "text-rose-600 font-bold" : d > 30 ? "text-amber-600" : "";
      return <span className={cls}>{d}d</span>;
    } },
  { key: "sor_6w", label: "SOR 6W", sortable: true, align: "right",
    render: (r) => <SorPct v={r.sor_6w} /> },
  { key: "sor_6m", label: "SOR 6M", sortable: true, align: "right",
    render: (r) => <SorPct v={r.sor_6m} /> },
  { key: "sor_since_launch", label: "SOR Life", sortable: true, align: "right",
    render: (r) => <SorPct v={r.sor_since_launch} /> },
  { key: "sor_sel", label: `SOR Sel (${selDays}d)`, sortable: true, align: "right",
    render: (r) => <SorPct v={r.sor_sel} /> },
  { key: "asp_sel", label: `ASP Sel (${selDays}d)`, sortable: true, align: "right",
    render: (r) => r.asp_sel == null ? <span className="text-muted">—</span> : fmtKES(r.asp_sel) },
  { key: "pct_of_full", label: "% Full Price", sortable: true, align: "right",
    render: (r) => {
      if (r.pct_of_full == null) return <span className="text-muted">—</span>;
      const cls = r.pct_of_full >= 95 ? "text-emerald-600" : r.pct_of_full < 70 ? "text-rose-600" : "text-amber-600";
      return <span className={cls}>{r.pct_of_full.toFixed(1)}%</span>;
    } },
  { key: "launch_date", label: "Launch", sortable: true,
    render: (r) => r.launch_date ? fmtDate(r.launch_date) : "—" },
  { key: "style_age_weeks", label: "Age", sortable: true, align: "right",
    render: (r) => `${(r.style_age_weeks ?? 0).toFixed(0)}w` },
];

const SorPct = ({ v }) => {
  if (v == null) return <span className="text-muted">—</span>;
  const cls = v >= 70 ? "text-emerald-600 font-bold" : v >= 50 ? "text-emerald-500" : v < 25 ? "text-rose-600" : "";
  return <span className={cls}>{v.toFixed(1)}%</span>;
};
const SORReport = () => {
  const { applied } = useFilters();
  const { countries, channels } = applied;
  const countryParam = countries?.length ? countries.map((c) => c.toLowerCase()).join(",") : undefined;
  const channelParam = channels?.length ? channels.join(",") : undefined;

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [catSel, setCatSel] = useState([]);
  const [subcatSel, setSubcatSel] = useState([]);
  const [brandSel, setBrandSel] = useState([]);
  const [launchMonthSel, setLaunchMonthSel] = useState([]);
  const [selectedStyle, setSelectedStyle] = useState(null);
  const [selectedColor, setSelectedColor] = useState(null);
  const [selectedSize, setSelectedSize] = useState(null);

  // Custom "Selected Period" date range — drives SOR Sel / ASP Sel /
  // % Full Price. Empty = backend default (trailing 180 days).
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const selDays = selPeriodDays(dateFrom, dateTo);

  // Per-style COLOUR breakdown cache (for row expand). Keyed by style_name.
  const [colorCache, setColorCache] = useState({});
  const [colorLoading, setColorLoading] = useState({});

  // Per-(style+colour) SIZE breakdown cache (for colour-row expand).
  // Keyed by `style|color`.
  const [sizeCache, setSizeCache] = useState({});
  const [sizeLoading, setSizeLoading] = useState({});

  // Per-style location breakdown cache. Keyed by `style|color|size`
  // (color/size = "" for the all-rollup view) so the same style can
  // show all-colours, per-colour, AND per-(colour+size) drills without
  // re-fetching when toggling between them.
  const [locCache, setLocCache] = useState({});
  const [locLoading, setLocLoading] = useState(false);
  const [locError, setLocError] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = {};
    if (countryParam) params.country = countryParam;
    if (channelParam) params.channel = channelParam;
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    api.get("/analytics/sor-all-styles", { params })
      .then((r) => { if (!cancelled) setRows(Array.isArray(r.data) ? r.data : []); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [countryParam, channelParam, dateFrom, dateTo]);

  // Drop the per-style caches when the country/channel/date filters change
  // so we don't show a Kenya-scoped breakdown for an Online-scoped table.
  useEffect(() => {
    setColorCache({});
    setSizeCache({});
    setLocCache({});
    setSelectedStyle(null);
  }, [countryParam, channelParam, dateFrom, dateTo]);

  const categories = useMemo(() => {
    const s = new Set(rows.map((r) => r.category).filter(Boolean));
    return Array.from(s).sort().map((v) => ({ value: v, label: v }));
  }, [rows]);
  const subcategories = useMemo(() => {
    const s = new Set(rows.map((r) => r.subcategory).filter(Boolean));
    return Array.from(s).sort().map((v) => ({ value: v, label: v }));
  }, [rows]);
  const brands = useMemo(() => {
    const s = new Set(rows.map((r) => r.brand).filter(Boolean));
    return Array.from(s).sort().map((v) => ({ value: v, label: v }));
  }, [rows]);

  const filtered = useMemo(() => {
    const byLaunch = filterByLaunchMonths(rows, launchMonthSel);
    return byLaunch.filter((r) => {
      if (catSel.length && !catSel.includes(r.category)) return false;
      if (subcatSel.length && !subcatSel.includes(r.subcategory)) return false;
      if (brandSel.length && !brandSel.includes(r.brand)) return false;
      if (search) {
        const hay = (
          (r.style_name || "") + " " + (r.style_number || "") + " " + (r.collection || "")
        ).toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }, [rows, search, catSel, subcatSel, brandSel, launchMonthSel]);

  const stats = useMemo(() => {
    const totalSales = filtered.reduce((s, r) => s + (r.sales_sel || 0), 0);
    const totalUnits = filtered.reduce((s, r) => s + (r.units_sel || 0), 0);
    const totalSOH = filtered.reduce((s, r) => s + (r.soh_total || 0), 0);
    const denom = filtered.reduce((s, r) => s + ((r.units_sel || 0) + (r.soh_total || 0)), 0);
    const wSor = denom > 0 ? totalUnits / denom * 100 : 0;
    // Iter 89d — Catalog-wide Weeks-of-Cover.
    //   weekly_burn = Σ(weekly_avg) — already 3-month based (Iter 89c).
    //   wOC = totalSOH ÷ weekly_burn. "—" when the filtered catalog
    //   has 0 recent burn (would be ∞).
    const totalWeeklyBurn = filtered.reduce((s, r) => s + (r.weekly_avg || 0), 0);
    const aggregateWoc = totalWeeklyBurn > 0 ? totalSOH / totalWeeklyBurn : null;
    const overstocked = filtered.filter((r) => r.woc != null && r.woc > 26).length;
    return { totalSales, totalUnits, totalSOH, wSor, n: filtered.length, aggregateWoc, overstocked };
  }, [filtered]);

  // Lazy-load the per-colour breakdown when a row expands. Returns the
  // same full column set as the master row (one row per colour).
  const loadColors = (style) => {
    if (!style || colorCache[style] || colorLoading[style]) return;
    setColorLoading((s) => ({ ...s, [style]: true }));
    api.get("/analytics/sor-style-colors", {
      params: {
        style_name: style,
        country: countryParam,
        channel: channelParam,
        ...(dateFrom ? { date_from: dateFrom } : {}),
        ...(dateTo ? { date_to: dateTo } : {}),
      },
    })
      .then((r) => {
        setColorCache((c) => ({ ...c, [style]: Array.isArray(r.data) ? r.data : [] }));
      })
      .catch(() => {
        setColorCache((c) => ({ ...c, [style]: [] }));
      })
      .finally(() => setColorLoading((s) => ({ ...s, [style]: false })));
  };

  // Lazy-load the per-size breakdown when a colour row expands. Same full
  // column set as the master/colour rows (backend /analytics/sor-style-sizes).
  const loadSizes = (style, color) => {
    if (!style || color == null) return;
    const key = `${style}|${color}`;
    if (sizeCache[key] || sizeLoading[key]) return;
    setSizeLoading((s) => ({ ...s, [key]: true }));
    api.get("/analytics/sor-style-sizes", {
      params: {
        style_name: style,
        color,
        country: countryParam,
        channel: channelParam,
        ...(dateFrom ? { date_from: dateFrom } : {}),
        ...(dateTo ? { date_to: dateTo } : {}),
      },
    })
      .then((r) => {
        setSizeCache((c) => ({ ...c, [key]: Array.isArray(r.data) ? r.data : [] }));
      })
      .catch(() => {
        setSizeCache((c) => ({ ...c, [key]: [] }));
      })
      .finally(() => setSizeLoading((s) => ({ ...s, [key]: false })));
  };

  // Lazy-load location breakdown when a style (and optionally color +
  // size) is selected. Same 202 poll pattern as SKU breakdown — both
  // endpoints share the same /orders scan on the backend so once one
  // finishes the other warms instantly. Cache key is `style|color|size`
  // so toggling between any of the three drill levels doesn't refetch.
  const loadLocations = (style, color, size) => {
    if (!style) return;
    const key = `${style}|${color || ""}|${size || ""}`;
    if (locCache[key]) return;
    setLocLoading(true);
    setLocError(null);
    const tick = (attempt = 0) => {
      api.get("/analytics/style-location-breakdown", {
        params: {
          style_name: style,
          country: countryParam,
          channel: channelParam,
          ...(color ? { color } : {}),
          ...(size ? { size } : {}),
        },
      })
        .then((r) => {
          if (r.data?.computing && attempt < 8) {
            setLocError(`Computing… (${attempt * 15}s elapsed; rare styles can take ~2 min)`);
            setTimeout(() => tick(attempt + 1), (r.data.retry_after || 15) * 1000);
          } else if (r.data?.computing) {
            setLocError("Still computing — try again in a minute. The result will be cached and instant once ready.");
            setLocLoading(false);
          } else {
            setLocCache((c) => ({ ...c, [key]: r.data?.locations || [] }));
            setLocError(null);
            setLocLoading(false);
          }
        })
        .catch((e) => {
          setLocError(e?.response?.data?.detail || e.message || "Could not load location breakdown");
          setLocLoading(false);
        });
    };
    tick();
  };

  // Note: auto-select on first render was removed — the cold /orders
  // fan-out for a randomly-picked first-row style is too slow and made
  // the SOR Report tab feel sluggish on open. Users now explicitly
  // click a row to populate the side pane.

  useEffect(() => {
    if (selectedStyle) loadLocations(selectedStyle, selectedColor, selectedSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStyle, selectedColor, selectedSize]);

  const exportCsv = () => {
    const header = [
      "Style Name", "Style Number",
      `Sales (Selected Period ${selDays}d)`, `Units (Selected Period ${selDays}d)`,
      "Weekly Average", "Units Since Launch", "SOH", "SOH Warehouse",
      "SOH Pipeline",
      "Weeks of Cover", "% In WH", "ASP 6 Months", "Full Price",
      "Days Since Last Sale", "6 Weeks SOR", "6 Months SOR", "SOR Since Launch",
      "SOR (Selected Period)", "ASP (Selected Period)", "Price % of Full Price",
      "Style Launch Date", "Style Age (Weeks)",
      "Category", "Sub Category",
    ];
    const lines = [header];
    for (const r of filtered) {
      lines.push([
        r.style_name || "", r.style_number || "",
        r.sales_sel ?? "", r.units_sel ?? "",
        r.weekly_avg ?? "", r.units_since_launch ?? "", r.soh_total ?? "", r.soh_wh ?? "",
        r.soh_pipeline ?? 0,
        r.woc ?? "", r.pct_in_wh ?? "", r.asp_6m ?? "", r.original_price ?? "",
        r.days_since_last_sale ?? "", r.sor_6w ?? "", r.sor_6m ?? "", r.sor_since_launch ?? "",
        r.sor_sel ?? "", r.asp_sel ?? "", r.pct_of_full ?? "",
        r.launch_date || "", r.style_age_weeks ?? "",
        r.category || "", r.subcategory || "",
      ]);
    }
    const csv = lines
      .map((row) => row.map((v) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sor-report_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4" data-testid="sor-report-tab">
      <div className="card-white p-4 sm:p-5">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <div>
            <SectionTitle>SOR Report — Catalog-wide</SectionTitle>
            <div className="text-[12px] text-muted mt-0.5">
              Every style with sales in the last 6 months. {stats.n.toLocaleString()} of {rows.length.toLocaleString()} styles after filters.
              Click any row to expand its Color × Size SKU breakdown, or select a style to see its per-location sales & stock on the right.
            </div>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!filtered.length}
            className="btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
            data-testid="sor-report-export-btn"
          >
            <DownloadSimple size={14} weight="bold" /> Export CSV
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
          <Tile label="Styles" value={fmtNum(stats.n)} />
          <Tile label="Total Sales" value={fmtKES(stats.totalSales)} />
          <Tile label="Units Sold" value={fmtNum(stats.totalUnits)} />
          <Tile label="SOH" value={fmtNum(stats.totalSOH)} />
          <Tile
            label="Weeks of Cover"
            value={stats.aggregateWoc == null ? "—" : `${stats.aggregateWoc.toFixed(1)}w`}
            sub={stats.aggregateWoc == null ? "no recent burn" : `${fmtNum(stats.overstocked)} styles > 26w`}
            tone={
              stats.aggregateWoc == null
                ? undefined
                : stats.aggregateWoc < 12
                ? "good"
                : stats.aggregateWoc > 26
                ? "warn"
                : undefined
            }
          />
          <Tile label="Weighted SOR" value={`${stats.wSor.toFixed(1)}%`} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-2 mb-3">
          <div className="md:col-span-3 relative">
            <MagnifyingGlass size={14} className="absolute left-2.5 top-2.5 text-muted" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search style name, style number, collection…"
              className="w-full pl-8 pr-2 py-1.5 rounded-lg border border-border bg-white text-[13px]"
              data-testid="sor-report-search"
            />
          </div>
          <div className="md:col-span-2">
            <MultiSelect options={categories} value={catSel} onChange={setCatSel} placeholder="All Categories" testId="sor-cat-filter" />
          </div>
          <div className="md:col-span-2">
            <MultiSelect options={subcategories} value={subcatSel} onChange={setSubcatSel} placeholder="All Subcategories" testId="sor-subcat-filter" />
          </div>
          <div className="md:col-span-2">
            <MultiSelect options={brands} value={brandSel} onChange={setBrandSel} placeholder="All Brands" testId="sor-brand-filter" />
          </div>
          <div className="md:col-span-3">
            <LaunchMonthFilter
              rows={rows}
              value={launchMonthSel}
              onChange={setLaunchMonthSel}
              testId="sor-launch-month-filter"
            />
          </div>
        </div>

        {/* Custom "Selected Period" date range — drives the SOR Sel / ASP Sel
            / % Full Price columns. Defaults to the trailing 180 days. */}
        <div className="flex items-center flex-wrap gap-2 mb-3" data-testid="sor-date-filter">
          <span className="text-[11px] font-bold uppercase text-muted">Select Sales Period</span>
          {[30, 90, 120].map((d) => {
            const from = new Date(Date.now() - d * 86400000);
            const pad = (n) => String(n).padStart(2, "0");
            const iso = `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())}`;
            const now = new Date();
            const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
            const active = dateFrom === iso && (dateTo === today || dateTo === "");
            return (
              <button
                key={d}
                type="button"
                onClick={() => { setDateFrom(iso); setDateTo(today); }}
                className={`px-2 py-1 rounded-lg border text-[11.5px] font-semibold ${active ? "border-amber-500 bg-amber-50 text-amber-700" : "border-border bg-white text-muted hover:text-fg"}`}
                data-testid={`sor-preset-${d}d`}
              >
                {d}D
              </button>
            );
          })}
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="px-2 py-1 rounded-lg border border-border bg-white text-[12px]"
            data-testid="sor-date-from"
          />
          <span className="text-muted text-[12px]">to</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="px-2 py-1 rounded-lg border border-border bg-white text-[12px]"
            data-testid="sor-date-to"
          />
          {(dateFrom || dateTo) ? (
            <button
              type="button"
              onClick={() => { setDateFrom(""); setDateTo(""); }}
              className="text-[11.5px] text-muted hover:text-rose-600 underline"
              data-testid="sor-date-clear"
            >
              Clear
            </button>
          ) : (
            <span className="text-[11px] text-muted">Default: last 180 days</span>
          )}
        </div>

        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorBox message={error} />
        ) : !filtered.length ? (
          <Empty>No styles match the current filters.</Empty>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            {/* Master table — 2 columns wide on xl */}
            <div className="xl:col-span-2 min-w-0 sor-compact">
              <SortableTable
                testId="sor-report-table"
                onRowClick={(row) => {
                  // Load the per-colour breakdown for the expanded panel.
                  loadColors(row.style_name);
                  // Reset the per-color and per-size drills whenever
                  // the user picks a different style — colours/sizes
                  // from the previous style would no longer match.
                  if (row.style_name !== selectedStyle) {
                    setSelectedColor(null);
                    setSelectedSize(null);
                  }
                  setSelectedStyle(row.style_name);
                }}
                rowClassName={(row) => row.style_name === selectedStyle ? "bg-amber-50/60" : ""}
                columns={[
                  // Column order per user spec: Style Name + Style Number
                  // FIRST, all measures, then Category / Sub Category LAST.
                  { key: "style_name", label: "Style Name", sortable: true,
                    render: (r) => <span className="font-semibold block max-w-[200px]" style={{ whiteSpace: "normal", wordBreak: "break-word", overflowWrap: "anywhere" }} title={r.style_name}>{r.style_name}</span> },
                  { key: "style_number", label: "Style #", sortable: true,
                    render: (r) => <span className="font-mono text-[10.5px]">{r.style_number || "—"}</span> },
                  ...metricColumns(selDays),
                  { key: "category", label: "Category", sortable: true,
                    render: (r) => r.category || "—" },
                  { key: "subcategory", label: "Sub Cat", sortable: true,
                    render: (r) => r.subcategory || "—" },
                ]}
                rows={filtered}
                initialSort={{ key: "sales_sel", dir: "desc" }}
                pageSize={50}
                stickyFirstCol
                renderExpanded={(row) => (
                  <ColorBreakdown
                    rows={colorCache[row.style_name]}
                    loading={colorLoading[row.style_name]}
                    selDays={selDays}
                    selectedColor={row.style_name === selectedStyle ? selectedColor : null}
                    selectedSize={row.style_name === selectedStyle ? selectedSize : null}
                    sizeCache={sizeCache}
                    sizeLoading={sizeLoading}
                    styleName={row.style_name}
                    onColorClick={(color) => {
                      // Anchor the location pane to this style first so
                      // useEffect re-fires the loader. Toggling: same
                      // colour clicked again clears both filters.
                      setSelectedStyle(row.style_name);
                      setSelectedSize(null);
                      setSelectedColor((prev) => (prev === color ? null : color));
                      // Warm the per-size drill for this colour so the
                      // expanded size table shows up immediately.
                      loadSizes(row.style_name, color);
                    }}
                    onSizeClick={(color, size) => {
                      // Clicking a size row scopes the location pane to
                      // style + colour + size. Toggling: same size again
                      // clears the size filter (colour stays).
                      setSelectedStyle(row.style_name);
                      setSelectedColor(color);
                      setSelectedSize((prev) => (prev === size ? null : size));
                    }}
                  />
                )}
              />
            </div>

            {/* Location detail pane */}
            <div className="xl:col-span-1 min-w-0">
              <LocationPane
                style={selectedStyle}
                color={selectedColor}
                size={selectedSize}
                rows={locCache[`${selectedStyle}|${selectedColor || ""}|${selectedSize || ""}`]}
                loading={locLoading}
                error={locError}
                onClear={() => { setSelectedStyle(null); setSelectedColor(null); setSelectedSize(null); }}
                onClearColor={() => { setSelectedColor(null); setSelectedSize(null); }}
                onClearSize={() => setSelectedSize(null)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const Tile = ({ label, value, sub, tone }) => {
  // Iter 89d — `tone` paints WoC tile in green when catalog is lean
  // (< 12w) or amber when overstocked (> 26w). `sub` adds context line
  // such as "X styles > 26w" so the tile reads at a glance.
  const cls =
    tone === "warn"
      ? "border-amber-300 bg-amber-50 text-amber-900"
      : tone === "good"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
      : "border-border";
  return (
    <div className={`rounded-xl border p-3 ${cls}`}>
      <div className="eyebrow">{label}</div>
      <div className="font-extrabold text-[16px] num mt-0.5">{value}</div>
      {sub && <div className="text-[10.5px] opacity-80 mt-0.5">{sub}</div>}
    </div>
  );
};

// ---- Colour breakdown (row expand) ----
//
// One row per colour, with EXACTLY the same column set as the master
// style table (shared `metricColumns()` definitions). Clicking a colour
// row filters the per-location pane on the right AND expands a nested
// per-SIZE table (same columns again) for that colour.
const ColorBreakdown = ({
  rows, loading, selectedColor, onColorClick, selDays = 180,
  styleName, sizeCache = {}, sizeLoading = {}, selectedSize, onSizeClick,
}) => {
  if (loading && (!rows || rows.length === 0)) {
    return <div className="text-[12px] text-muted py-2 px-2">Loading colour breakdown…</div>;
  }
  if (!rows || !rows.length) {
    return <div className="text-[12px] text-muted py-2 px-2">No colour detail available for this style.</div>;
  }
  return (
    <div className="px-2 py-1 sor-compact" data-testid="sor-color-breakdown">
      <div className="text-[11px] font-bold uppercase text-muted mb-2">
        By Colour — {rows.length} colour{rows.length === 1 ? "" : "s"} · click a row to filter locations & see sizes
      </div>
      <SortableTable
        testId="sor-color-table"
        columns={[
          { key: "color", label: "Colour", sortable: true,
            render: (r) => <span className="font-semibold">{r.color || "—"}</span> },
          ...metricColumns(selDays),
        ]}
        rows={rows}
        rowKey={(r) => r.color}
        initialSort={{ key: "sales_sel", dir: "desc" }}
        stickyFirstCol
        maxHeight={null}
        onRowClick={(r) => { if (onColorClick) onColorClick(r.color); }}
        rowClassName={(r) => (r.color === selectedColor ? "bg-amber-100/70" : "")}
        renderExpanded={(r) => (
          <SizeBreakdown
            rows={sizeCache[`${styleName}|${r.color}`]}
            loading={sizeLoading[`${styleName}|${r.color}`]}
            selDays={selDays}
            color={r.color}
            selectedSize={r.color === selectedColor ? selectedSize : null}
            onSizeClick={(size) => { if (onSizeClick) onSizeClick(r.color, size); }}
          />
        )}
      />
    </div>
  );
};

// ---- Size breakdown (colour-row expand) ----
//
// One row per size for a single style + colour — again the SAME column
// set as the style/colour rows. Clicking a size row scopes the location
// pane to style + colour + size.
const SizeBreakdown = ({ rows, loading, color, selectedSize, onSizeClick, selDays = 180 }) => {
  if (loading && (!rows || rows.length === 0)) {
    return <div className="text-[12px] text-muted py-2 px-2">Loading size breakdown…</div>;
  }
  if (!rows || !rows.length) {
    return <div className="text-[12px] text-muted py-2 px-2">No size detail available for this colour.</div>;
  }
  return (
    <div className="px-2 py-1 sor-compact" data-testid="sor-size-breakdown">
      <div className="text-[11px] font-bold uppercase text-muted mb-2">
        By Size — {color || "—"} · {rows.length} size{rows.length === 1 ? "" : "s"} · click a row to filter locations
      </div>
      <SortableTable
        testId="sor-size-table"
        columns={[
          { key: "size", label: "Size", sortable: true,
            render: (r) => <span className="font-semibold">{r.size || "—"}</span> },
          ...metricColumns(selDays),
        ]}
        rows={rows}
        initialSort={{ key: "sales_sel", dir: "desc" }}
        stickyFirstCol
        maxHeight={null}
        onRowClick={(r) => { if (onSizeClick) onSizeClick(r.size); }}
        rowClassName={(r) => (r.size === selectedSize ? "bg-sky-100/70" : "")}
      />
    </div>
  );
};

// ---- Location pane (right side) — sortable by clicking headers ----
const LocationPane = ({ style, color, size, rows, loading, error, onClear, onClearColor, onClearSize }) => {
  const [sortKey, setSortKey] = useState("units_6m");
  const [sortDir, setSortDir] = useState("desc");

  const sorted = useMemo(() => {
    if (!rows || !rows.length) return rows || [];
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      // String compare for `location`, numeric otherwise
      if (sortKey === "location") {
        const r = String(av || "").localeCompare(String(bv || ""));
        return sortDir === "asc" ? r : -r;
      }
      const an = Number(av) || 0;
      const bn = Number(bv) || 0;
      return sortDir === "asc" ? an - bn : bn - an;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "location" ? "asc" : "desc");
    }
  };

  const SortHeader = ({ keyName, label, align = "left" }) => {
    const active = sortKey === keyName;
    const arrow = active ? (sortDir === "asc" ? "▲" : "▼") : "";
    return (
      <th
        onClick={() => toggleSort(keyName)}
        className={`py-1 pr-2 cursor-pointer hover:text-foreground select-none ${align === "right" ? "text-right" : "text-left"}`}
        data-testid={`sor-loc-th-${keyName}`}
      >
        {label} <span className="text-[9px]">{arrow}</span>
      </th>
    );
  };

  if (!style) {
    return (
      <div className="rounded-xl border border-border p-4 text-[12px] text-muted text-center" data-testid="sor-location-pane-empty">
        Click any style on the left to see where it sold and where it's stocked.
      </div>
    );
  }
  const totals = (rows || []).reduce(
    (a, r) => ({
      units_6m: a.units_6m + (r.units_6m || 0),
      sales_6m: a.sales_6m + (r.sales_6m || 0),
      soh_total: a.soh_total + (r.soh_total || 0),
    }),
    { units_6m: 0, sales_6m: 0, soh_total: 0 },
  );
  return (
    <div className="rounded-xl border border-border bg-white" data-testid="sor-location-pane">
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <div className="eyebrow">Where did it sell?</div>
          <div className="font-bold text-[14px]" style={{ whiteSpace: "normal", wordBreak: "break-word", overflowWrap: "anywhere" }} title={style}>{style}</div>
          {(color || size) && (
            <div className="mt-1 flex flex-wrap gap-1.5" data-testid="sor-loc-filter-pills">
              {color && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-300 text-amber-900 text-[10.5px] font-bold" data-testid="sor-loc-color-pill">
                  <span>Color: {color}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); if (onClearColor) onClearColor(); }}
                    className="hover:text-rose-700"
                    aria-label="Clear color filter"
                    data-testid="sor-loc-clear-color-btn"
                  >×</button>
                </span>
              )}
              {size && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-sky-50 border border-sky-300 text-sky-900 text-[10.5px] font-bold" data-testid="sor-loc-size-pill">
                  <span>Size: {size}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); if (onClearSize) onClearSize(); }}
                    className="hover:text-rose-700"
                    aria-label="Clear size filter"
                    data-testid="sor-loc-clear-size-btn"
                  >×</button>
                </span>
              )}
            </div>
          )}
          {(rows && rows.length > 0) && (
            <div className="text-[11px] text-muted mt-1">
              {rows.length} location{rows.length === 1 ? "" : "s"} ·{" "}
              {fmtNum(totals.units_6m)} units · {fmtKES(totals.sales_6m)} · {fmtNum(totals.soh_total)} SOH
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="text-muted hover:text-foreground p-1"
          aria-label="Clear selection"
          data-testid="sor-location-pane-clear"
        >
          <X size={14} weight="bold" />
        </button>
      </div>
      <div className="px-2 py-2 max-h-[640px] overflow-y-auto">
        {loading ? (
          <div className="text-[12px] text-muted px-2 py-3">Loading… (~30s on cold cache)</div>
        ) : error ? (
          <div className="text-[12px] text-rose-600 px-2 py-3">{error}</div>
        ) : (!rows || rows.length === 0) ? (
          <div className="text-[12px] text-muted px-2 py-3">No location data for this style.</div>
        ) : (
          <table className="w-full text-[12px]" data-testid="sor-location-table">
            <thead>
              <tr className="text-muted border-b border-border">
                <SortHeader keyName="location" label="Location" />
                <SortHeader keyName="units_6m" label="Units 6M" align="right" />
                <SortHeader keyName="soh_total" label="SOH" align="right" />
                <SortHeader keyName="sor_6m" label="SOR" align="right" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const sor = r.sor_6m || 0;
                const sorCls = sor >= 70 ? "text-emerald-600 font-bold"
                  : sor >= 50 ? "text-emerald-500"
                  : sor < 25 ? "text-rose-600"
                  : "";
                return (
                  <tr key={r.location} className="border-b border-border/40 last:border-0">
                    <td className="py-1.5 pr-2 max-w-[180px]" style={{ whiteSpace: "normal", wordBreak: "break-word" }} title={r.location}>{r.location}</td>
                    <td className="py-1.5 pr-2 text-right num">{fmtNum(r.units_6m)}</td>
                    <td className="py-1.5 pr-2 text-right num">{fmtNum(r.soh_total)}</td>
                    <td className={`py-1.5 pr-0 text-right num ${sorCls}`}>{sor.toFixed(1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default SORReport;
