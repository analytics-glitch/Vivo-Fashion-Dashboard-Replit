import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtKES, fmtNum, fmtDate } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import MultiSelect from "@/components/MultiSelect";
import LaunchMonthFilter, { filterByLaunchMonths } from "@/components/LaunchMonthFilter";
import { DownloadSimple, MagnifyingGlass, X, Sparkle } from "@phosphor-icons/react";

/**
 * SOR New Styles Report — tracks every new style at exactly 6–7 weeks of age.
 *
 * This report refreshes daily: styles attaining 6 weeks enter, styles passing
 * 7 weeks exit. All metrics are computed over the fixed 6-week window (42 days)
 * so every style is measured on an equal footing regardless of when it
 * entered the report.
 *
 * Data source: /api/analytics/sor-all-styles with date_from = today − 42 days.
 * Client-side age filter: 6 ≤ style_age_weeks < 8.
 */

// Compute the fixed 6-week window once at module load — the component
// re-mounts if the page refreshes so this always reflects today.
const _pad = (n) => String(n).padStart(2, "0");
const _today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
};
const _sixWeeksAgo = () => {
  const d = new Date(Date.now() - 42 * 86400000);
  return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
};

const SorPct = ({ v }) => {
  if (v == null) return <span className="text-muted">—</span>;
  const cls = v >= 70 ? "text-emerald-600 font-bold" : v >= 50 ? "text-emerald-500" : v < 25 ? "text-rose-600" : "";
  return <span className={cls}>{v.toFixed(1)}%</span>;
};

// Metric columns shown in the master table, colour-expand, and size-expand.
// Only 6-week period: Units 6W (= units_sel), Revenue 6W (= sales_sel),
// SOR 6W (= sor_6w dedicated field). All lifetime / 6-month / sel-ASP
// columns are intentionally omitted per product spec.
const newStylesMetricColumns = [
  { key: "units_sel",   label: "Units 6W",   sortable: true, align: "right",
    render: (r) => fmtNum(r.units_sel) },
  { key: "sales_sel",   label: "Revenue 6W", sortable: true, align: "right",
    render: (r) => fmtKES(r.sales_sel) },
  { key: "weekly_avg",  label: "Wk Avg",     sortable: true, align: "right",
    render: (r) => (r.weekly_avg ?? 0).toFixed(1) },
  { key: "soh_total",   label: "SOH",        sortable: true, align: "right",
    headerTitle: "Total stock on hand = stores + sellable warehouse (pipeline excluded)",
    render: (r) => fmtNum(r.soh_total) },
  { key: "soh_wh",      label: "SOH W/H",    sortable: true, align: "right",
    headerTitle: "Sellable warehouse stock (excludes production pipeline)",
    render: (r) => fmtNum(r.soh_wh) },
  { key: "soh_pipeline",label: "Pipeline",   sortable: true, align: "right",
    headerTitle: "In the production pipeline — not yet sellable",
    render: (r) => (r.soh_pipeline ? fmtNum(r.soh_pipeline) : <span className="text-muted">—</span>) },
  { key: "woc", label: "WoC", sortable: true, align: "right",
    sortValue: (r) => r.woc == null ? 9999 : r.woc,
    render: (r) => {
      if (r.woc == null) return <span className="text-muted">—</span>;
      const cls = r.woc < 4 ? "text-emerald-600 font-bold" : r.woc < 12 ? "text-emerald-500" : r.woc < 26 ? "text-amber-600" : "text-rose-600";
      return <span className={cls}>{r.woc.toFixed(1)}w</span>;
    } },
  { key: "pct_in_wh", label: "% WH", sortable: true, align: "right",
    render: (r) => `${(r.pct_in_wh ?? 0).toFixed(1)}%` },
  { key: "asp_6m", label: "ASP", sortable: true, align: "right",
    render: (r) => r.asp_6m == null ? <span className="text-muted">—</span> : fmtKES(r.asp_6m) },
  { key: "original_price", label: "Full Price", sortable: true, align: "right",
    render: (r) => r.original_price == null ? <span className="text-muted">—</span> : fmtKES(r.original_price) },
  { key: "sor_6w", label: "SOR 6W", sortable: true, align: "right",
    headerTitle: "6-week sell-through: units sold in the last 42 days ÷ (units sold + SOH)",
    render: (r) => <SorPct v={r.sor_6w} /> },
];

const SORNewStylesReport = () => {
  const { applied } = useFilters();
  const { countries, channels } = applied;
  const countryParam = countries?.length ? countries.map((c) => c.toLowerCase()).join(",") : undefined;
  const channelParam = channels?.length ? channels.join(",") : undefined;

  // Fixed 6-week window — re-computed each mount so the date is always fresh.
  const [dateFrom]   = useState(_sixWeeksAgo);
  const [dateTo]     = useState(_today);

  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const [search, setSearch]           = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [catSel, setCatSel]           = useState([]);
  const [subcatSel, setSubcatSel]     = useState([]);
  const [brandSel, setBrandSel]       = useState([]);
  const [launchMonthSel, setLaunchMonthSel] = useState([]);
  const [selectedStyle, setSelectedStyle]   = useState(null);
  const [selectedColor, setSelectedColor]   = useState(null);
  const [selectedSize, setSelectedSize]     = useState(null);

  // Per-style drill-down caches (same pattern as SORReport).
  const [colorCache, setColorCache]       = useState({});
  const [colorLoading, setColorLoading]   = useState({});
  const [sizeCache, setSizeCache]         = useState({});
  const [sizeLoading, setSizeLoading]     = useState({});
  const [locCache, setLocCache]           = useState({});
  const [locLoading, setLocLoading]       = useState(false);
  const [locError, setLocError]           = useState(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Fetch all styles from the sor-all-styles endpoint with the 6W window.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = { date_from: dateFrom, date_to: dateTo };
    if (countryParam) params.country = countryParam;
    if (channelParam) params.channel = channelParam;
    api.get("/analytics/sor-all-styles", { params })
      .then((r) => { if (!cancelled) setRows(Array.isArray(r.data) ? r.data : []); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [countryParam, channelParam, dateFrom, dateTo]);

  // Clear drill-down caches on filter change.
  useEffect(() => {
    setColorCache({});
    setSizeCache({});
    setLocCache({});
    setSelectedStyle(null);
  }, [countryParam, channelParam]);

  // ── Age gate: only styles aged 6 or 7 complete weeks ────────────────────
  // style_age_weeks ∈ [6, 8) means exactly week 6 or week 7.
  const ageGated = useMemo(
    () => rows.filter((r) => {
      const w = r.style_age_weeks ?? 0;
      return w >= 6 && w < 8;
    }),
    [rows],
  );

  const categories = useMemo(() => {
    const s = new Set(ageGated.map((r) => r.category).filter(Boolean));
    return Array.from(s).sort().map((v) => ({ value: v, label: v }));
  }, [ageGated]);
  const subcategories = useMemo(() => {
    const s = new Set(ageGated.map((r) => r.subcategory).filter(Boolean));
    return Array.from(s).sort().map((v) => ({ value: v, label: v }));
  }, [ageGated]);
  const brands = useMemo(() => {
    const s = new Set(ageGated.map((r) => r.brand).filter(Boolean));
    return Array.from(s).sort().map((v) => ({ value: v, label: v }));
  }, [ageGated]);

  const filtered = useMemo(() => {
    const byLaunch = filterByLaunchMonths(ageGated, launchMonthSel);
    return byLaunch.filter((r) => {
      if (catSel.length    && !catSel.includes(r.category))      return false;
      if (subcatSel.length && !subcatSel.includes(r.subcategory)) return false;
      if (brandSel.length  && !brandSel.includes(r.brand))        return false;
      if (search) {
        const hay = ((r.style_name || "") + " " + (r.style_number || "") + " " + (r.collection || "")).toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }, [ageGated, search, catSel, subcatSel, brandSel, launchMonthSel]);

  const stats = useMemo(() => {
    const totalSales  = filtered.reduce((s, r) => s + (r.sales_sel  || 0), 0);
    const totalUnits  = filtered.reduce((s, r) => s + (r.units_sel  || 0), 0);
    const totalSOH    = filtered.reduce((s, r) => s + (r.soh_total  || 0), 0);
    const totalSOHWH  = filtered.reduce((s, r) => s + (r.soh_wh     || 0), 0);
    const totalPipeline = filtered.reduce((s, r) => s + (r.soh_pipeline || 0), 0);
    const totalWeeklyBurn = filtered.reduce((s, r) => s + (r.weekly_avg || 0), 0);
    const aggregateWoc    = totalWeeklyBurn > 0 ? totalSOH / totalWeeklyBurn : null;
    // Weighted SOR: units / (units + stock) across all styles in window.
    const denom = filtered.reduce((s, r) => s + ((r.units_sel || 0) + (r.soh_total || 0)), 0);
    const wSor  = denom > 0 ? (totalUnits / denom) * 100 : 0;
    const slowBurners = filtered.filter((r) => (r.sor_6w ?? 0) < 25).length;
    const pctInWH = totalSOH > 0 ? (totalSOHWH / totalSOH) * 100 : 0;
    return {
      totalSales, totalUnits, totalSOH, totalSOHWH, totalPipeline,
      totalWeeklyBurn, aggregateWoc, wSor, slowBurners, pctInWH,
      n: filtered.length,
    };
  }, [filtered]);

  // ── Drill-down loaders (same pattern as SORReport) ───────────────────────
  const loadColors = (style) => {
    if (!style || colorCache[style] || colorLoading[style]) return;
    setColorLoading((s) => ({ ...s, [style]: true }));
    api.get("/analytics/sor-style-colors", {
      params: { style_name: style, country: countryParam, channel: channelParam, date_from: dateFrom, date_to: dateTo },
    })
      .then((r) => setColorCache((c) => ({ ...c, [style]: Array.isArray(r.data) ? r.data : [] })))
      .catch(() => setColorCache((c) => ({ ...c, [style]: [] })))
      .finally(() => setColorLoading((s) => ({ ...s, [style]: false })));
  };

  const loadSizes = (style, color) => {
    if (!style || color == null) return;
    const key = `${style}|${color}`;
    if (sizeCache[key] || sizeLoading[key]) return;
    setSizeLoading((s) => ({ ...s, [key]: true }));
    api.get("/analytics/sor-style-sizes", {
      params: { style_name: style, color, country: countryParam, channel: channelParam, date_from: dateFrom, date_to: dateTo },
    })
      .then((r) => setSizeCache((c) => ({ ...c, [key]: Array.isArray(r.data) ? r.data : [] })))
      .catch(() => setSizeCache((c) => ({ ...c, [key]: [] })))
      .finally(() => setSizeLoading((s) => ({ ...s, [key]: false })));
  };

  const loadLocations = (style, color, size) => {
    if (!style) return;
    const key = `${style}|${color || ""}|${size || ""}`;
    if (locCache[key]) return;
    setLocLoading(true);
    setLocError(null);
    const tick = (attempt = 0) => {
      api.get("/analytics/style-location-breakdown", {
        params: {
          style_name: style, country: countryParam, channel: channelParam,
          ...(color ? { color } : {}),
          ...(size  ? { size  } : {}),
        },
      })
        .then((r) => {
          if (r.data?.computing && attempt < 8) {
            setLocError(`Computing… (${attempt * 15}s elapsed)`);
            setTimeout(() => tick(attempt + 1), (r.data.retry_after || 15) * 1000);
          } else if (r.data?.computing) {
            setLocError("Still computing — try again in a minute.");
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

  useEffect(() => {
    if (selectedStyle) loadLocations(selectedStyle, selectedColor, selectedSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStyle, selectedColor, selectedSize]);

  // ── CSV export ───────────────────────────────────────────────────────────
  const exportCsv = () => {
    const header = [
      "Style Name", "Style Number",
      "Units 6W", "Revenue 6W (KES)",
      "Weekly Average", "SOH", "SOH Warehouse", "SOH Pipeline",
      "Weeks of Cover", "% In WH", "ASP", "Full Price",
      "SOR 6W %",
      "Launch Date", "Style Age (Weeks)",
      "Category", "Sub Category",
    ];
    const lines = [header];
    for (const r of filtered) {
      lines.push([
        r.style_name || "", r.style_number || "",
        r.units_sel ?? "", r.sales_sel ?? "",
        r.weekly_avg ?? "", r.soh_total ?? "", r.soh_wh ?? "", r.soh_pipeline ?? 0,
        r.woc ?? "", r.pct_in_wh ?? "", r.asp_6m ?? "", r.original_price ?? "",
        r.sor_6w ?? "",
        r.launch_date || "", r.style_age_weeks ?? "",
        r.category || "", r.subcategory || "",
      ]);
    }
    const csv = lines.map((row) => row.map((v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = `sor-new-styles_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4" data-testid="sor-new-styles-report-tab">
      <div className="card-white p-4 sm:p-5">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <div>
            <SectionTitle>SOR New Styles · Week 6–7 Tracker</SectionTitle>
            <div className="text-[12px] text-muted mt-0.5">
              <Sparkle size={12} weight="fill" className="inline -mt-0.5 mr-1 text-brand" />
              Styles aged exactly <strong>6 or 7 weeks</strong> — measured over a fixed 6-week window (42 days).
              {" "}This list refreshes daily as styles age in and out.
              {" "}{stats.n.toLocaleString()} of {ageGated.length.toLocaleString()} styles after filters.
              {" "}Click any row to see its colour breakdown and per-location stock.
            </div>
          </div>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!filtered.length}
            className="btn-primary inline-flex items-center gap-1.5 disabled:opacity-50"
            data-testid="sor-new-styles-export-btn"
          >
            <DownloadSimple size={14} weight="bold" /> Export CSV
          </button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
          <Tile label="Styles in Window" value={fmtNum(stats.n)} sub="Age 6–7 weeks" />
          <Tile label="Revenue 6W" value={fmtKES(stats.totalSales)} />
          <Tile label="Units 6W" value={fmtNum(stats.totalUnits)} />
          <Tile label="Stock on Hand" value={fmtNum(stats.totalSOH)} />
          <Tile
            label="Weeks of Cover"
            value={stats.aggregateWoc == null ? "—" : `${stats.aggregateWoc.toFixed(1)}w`}
            tone={
              stats.aggregateWoc == null ? undefined
              : stats.aggregateWoc < 12 ? "good"
              : stats.aggregateWoc > 26 ? "warn"
              : undefined
            }
          />
          <Tile
            label="Weighted SOR 6W"
            value={`${stats.wSor.toFixed(1)}%`}
            sub={`${fmtNum(stats.slowBurners)} slow burners (< 25%)`}
            tone={stats.wSor >= 50 ? "good" : stats.wSor < 25 ? "warn" : undefined}
          />
        </div>

        {/* Search + filters */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2 mb-3">
          <div className="md:col-span-3 relative">
            <MagnifyingGlass size={14} className="absolute left-2.5 top-2.5 text-muted" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search style name, style #, collection…"
              className="w-full pl-8 pr-2 py-1.5 rounded-lg border border-border bg-white text-[13px]"
              data-testid="sor-new-styles-search"
            />
          </div>
          <div className="md:col-span-2">
            <MultiSelect options={categories} value={catSel} onChange={setCatSel} placeholder="All Categories" testId="sor-ns-cat-filter" />
          </div>
          <div className="md:col-span-2">
            <MultiSelect options={subcategories} value={subcatSel} onChange={setSubcatSel} placeholder="All Subcategories" testId="sor-ns-subcat-filter" />
          </div>
          <div className="md:col-span-2">
            <MultiSelect options={brands} value={brandSel} onChange={setBrandSel} placeholder="All Brands" testId="sor-ns-brand-filter" />
          </div>
          <div className="md:col-span-3">
            <LaunchMonthFilter
              rows={ageGated}
              value={launchMonthSel}
              onChange={setLaunchMonthSel}
              testId="sor-ns-launch-month-filter"
            />
          </div>
        </div>

        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorBox message={error} />
        ) : ageGated.length === 0 ? (
          <Empty>
            No styles are currently in the 6–7 week window. This list refreshes daily.
          </Empty>
        ) : !filtered.length ? (
          <Empty>No styles match the current filters.</Empty>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            {/* Master table */}
            <div className="xl:col-span-2 min-w-0 sor-compact">
              <SortableTable
                testId="sor-new-styles-table"
                onRowClick={(row) => {
                  loadColors(row.style_name);
                  if (row.style_name !== selectedStyle) {
                    setSelectedColor(null);
                    setSelectedSize(null);
                  }
                  setSelectedStyle(row.style_name);
                }}
                rowClassName={(row) => row.style_name === selectedStyle ? "bg-amber-50/60" : ""}
                columns={[
                  { key: "style_name", label: "Style Name", sortable: true,
                    render: (r) => (
                      <span
                        className="font-semibold block max-w-[200px]"
                        style={{ whiteSpace: "normal", wordBreak: "break-word", overflowWrap: "anywhere" }}
                        title={r.style_name}
                      >
                        {r.style_name}
                      </span>
                    ) },
                  { key: "style_number", label: "Style #", sortable: true,
                    render: (r) => <span className="font-mono text-[10.5px]">{r.style_number || "—"}</span> },
                  ...newStylesMetricColumns,
                  { key: "launch_date", label: "Launch", sortable: true,
                    render: (r) => r.launch_date ? fmtDate(r.launch_date) : "—" },
                  { key: "style_age_weeks", label: "Age", sortable: true, align: "right",
                    render: (r) => {
                      const w = r.style_age_weeks ?? 0;
                      return (
                        <span className="inline-block px-1.5 py-0.5 rounded text-[10.5px] font-bold bg-indigo-100 text-indigo-700">
                          {w.toFixed(0)}w
                        </span>
                      );
                    } },
                  { key: "category",    label: "Category",  sortable: true, render: (r) => r.category    || "—" },
                  { key: "subcategory", label: "Sub Cat",   sortable: true, render: (r) => r.subcategory  || "—" },
                ]}
                rows={filtered}
                initialSort={{ key: "units_sel", dir: "desc" }}
                pageSize={50}
                stickyFirstCol
                resizable
                footerRow={filtered.length > 0 ? [
                  // expand-chevron column (renderExpanded adds this as first col)
                  <td key="fchev" />,
                  // style_name — sticky to match body stickyFirstCol
                  <td key="fn" className="font-bold text-foreground sticky left-0 bg-panel z-10 whitespace-nowrap">
                    Total · {fmtNum(stats.n)} styles
                  </td>,
                  // style_number
                  <td key="fsn" />,
                  // units_sel
                  <td key="fu" className="text-right num font-bold">{fmtNum(stats.totalUnits)}</td>,
                  // sales_sel
                  <td key="fs" className="text-right num font-bold">{fmtKES(stats.totalSales)}</td>,
                  // weekly_avg
                  <td key="fwa" className="text-right num font-bold">{stats.totalWeeklyBurn.toFixed(1)}</td>,
                  // soh_total
                  <td key="fsoh" className="text-right num font-bold">{fmtNum(Math.round(stats.totalSOH))}</td>,
                  // soh_wh
                  <td key="fwh" className="text-right num font-bold">{fmtNum(Math.round(stats.totalSOHWH))}</td>,
                  // soh_pipeline
                  <td key="fpipe" className="text-right num font-bold">{stats.totalPipeline ? fmtNum(Math.round(stats.totalPipeline)) : "—"}</td>,
                  // woc
                  <td key="fwoc" className="text-right num font-bold">
                    {stats.aggregateWoc == null ? "—" : `${stats.aggregateWoc.toFixed(1)}w`}
                  </td>,
                  // pct_in_wh
                  <td key="fpwh" className="text-right num font-bold">{stats.pctInWH.toFixed(1)}%</td>,
                  // asp_6m — weighted avg (sales ÷ units)
                  <td key="fasp" className="text-right num font-bold">
                    {stats.totalUnits > 0 ? fmtKES(stats.totalSales / stats.totalUnits) : "—"}
                  </td>,
                  // original_price — no meaningful aggregate
                  <td key="ffp" />,
                  // sor_6w — weighted SOR
                  <td key="fsor" className="text-right num font-bold">
                    <SorPct v={stats.wSor} />
                  </td>,
                  // launch_date
                  <td key="fld" />,
                  // style_age_weeks
                  <td key="fage" />,
                  // category
                  <td key="fcat" />,
                  // subcategory
                  <td key="fsub" />,
                ] : null}
                renderExpanded={(row) => (
                  <NSColorBreakdown
                    rows={colorCache[row.style_name]}
                    loading={colorLoading[row.style_name]}
                    selectedColor={row.style_name === selectedStyle ? selectedColor : null}
                    selectedSize={row.style_name === selectedStyle ? selectedSize : null}
                    sizeCache={sizeCache}
                    sizeLoading={sizeLoading}
                    styleName={row.style_name}
                    onColorClick={(color) => {
                      setSelectedStyle(row.style_name);
                      setSelectedSize(null);
                      setSelectedColor((prev) => (prev === color ? null : color));
                      loadSizes(row.style_name, color);
                    }}
                    onSizeClick={(color, size) => {
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
              <NSLocationPane
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

        <p className="text-[11px] text-muted italic mt-3">
          <Sparkle size={11} weight="fill" className="inline -mt-0.5 mr-1 text-brand" />
          All measures use a fixed 6-week window (last 42 days).
          SOR 6W = units sold in 42 days ÷ (units sold + current SOH).
          Styles exit this report once they pass 8 weeks of age.
        </p>
      </div>
    </div>
  );
};

// ── Tile ──────────────────────────────────────────────────────────────────────
const Tile = ({ label, value, sub, tone }) => {
  const cls = tone === "warn" ? "border-amber-300 bg-amber-50 text-amber-900"
    : tone === "good"         ? "border-emerald-300 bg-emerald-50 text-emerald-900"
    : "border-border";
  return (
    <div className={`rounded-xl border p-3 ${cls}`}>
      <div className="eyebrow">{label}</div>
      <div className="font-extrabold text-[16px] num mt-0.5">{value}</div>
      {sub && <div className="text-[10.5px] opacity-80 mt-0.5">{sub}</div>}
    </div>
  );
};

// ── Colour breakdown (row expand) ─────────────────────────────────────────────
const NSColorBreakdown = ({
  rows, loading, selectedColor, onColorClick,
  styleName, sizeCache = {}, sizeLoading = {}, selectedSize, onSizeClick,
}) => {
  if (loading && (!rows || rows.length === 0))
    return <div className="text-[12px] text-muted py-2 px-2">Loading colour breakdown…</div>;
  if (!rows || !rows.length)
    return <div className="text-[12px] text-muted py-2 px-2">No colour detail available for this style.</div>;
  return (
    <div className="px-2 py-1 sor-compact" data-testid="sor-ns-color-breakdown">
      <div className="text-[11px] font-bold uppercase text-muted mb-2">
        By Colour — {rows.length} colour{rows.length === 1 ? "" : "s"} · click a row to filter locations & see sizes
      </div>
      <SortableTable
        testId="sor-ns-color-table"
        columns={[
          { key: "color", label: "Colour", sortable: true, render: (r) => <span className="font-semibold">{r.color || "—"}</span> },
          ...newStylesMetricColumns,
        ]}
        rows={rows}
        rowKey={(r) => r.color}
        initialSort={{ key: "units_sel", dir: "desc" }}
        stickyFirstCol
        maxHeight={null}
        onRowClick={(r) => { if (onColorClick) onColorClick(r.color); }}
        rowClassName={(r) => (r.color === selectedColor ? "bg-amber-100/70" : "")}
        renderExpanded={(r) => (
          <NSSizeBreakdown
            rows={sizeCache[`${styleName}|${r.color}`]}
            loading={sizeLoading[`${styleName}|${r.color}`]}
            color={r.color}
            selectedSize={r.color === selectedColor ? selectedSize : null}
            onSizeClick={(size) => { if (onSizeClick) onSizeClick(r.color, size); }}
          />
        )}
      />
    </div>
  );
};

// ── Size breakdown (colour-row expand) ───────────────────────────────────────
const NSSizeBreakdown = ({ rows, loading, color, selectedSize, onSizeClick }) => {
  if (loading && (!rows || rows.length === 0))
    return <div className="text-[12px] text-muted py-2 px-2">Loading size breakdown…</div>;
  if (!rows || !rows.length)
    return <div className="text-[12px] text-muted py-2 px-2">No size detail for this colour.</div>;
  return (
    <div className="px-2 py-1 sor-compact" data-testid="sor-ns-size-breakdown">
      <div className="text-[11px] font-bold uppercase text-muted mb-2">
        By Size — {color || "—"} · {rows.length} size{rows.length === 1 ? "" : "s"} · click a row to filter locations
      </div>
      <SortableTable
        testId="sor-ns-size-table"
        columns={[
          { key: "size", label: "Size", sortable: true, render: (r) => <span className="font-semibold">{r.size || "—"}</span> },
          ...newStylesMetricColumns,
        ]}
        rows={rows}
        initialSort={{ key: "units_sel", dir: "desc" }}
        stickyFirstCol
        maxHeight={null}
        onRowClick={(r) => { if (onSizeClick) onSizeClick(r.size); }}
        rowClassName={(r) => (r.size === selectedSize ? "bg-sky-100/70" : "")}
      />
    </div>
  );
};

// ── Location pane (right side) ───────────────────────────────────────────────
const NSLocationPane = ({ style, color, size, rows, loading, error, onClear, onClearColor, onClearSize }) => {
  const [sortKey, setSortKey] = useState("units_6m");
  const [sortDir, setSortDir] = useState("desc");

  const sorted = useMemo(() => {
    if (!rows || !rows.length) return rows || [];
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (sortKey === "location") {
        const r = String(av || "").localeCompare(String(bv || ""));
        return sortDir === "asc" ? r : -r;
      }
      return sortDir === "asc" ? (Number(av) || 0) - (Number(bv) || 0) : (Number(bv) || 0) - (Number(av) || 0);
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "location" ? "asc" : "desc"); }
  };

  const SortHeader = ({ keyName, label, align = "left" }) => {
    const active = sortKey === keyName;
    return (
      <th
        onClick={() => toggleSort(keyName)}
        className={`py-1 pr-2 cursor-pointer hover:text-foreground select-none ${align === "right" ? "text-right" : "text-left"}`}
        data-testid={`sor-ns-loc-th-${keyName}`}
      >
        {label} <span className="text-[9px]">{active ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>
      </th>
    );
  };

  if (!style) {
    return (
      <div className="rounded-xl border border-border p-4 text-[12px] text-muted text-center" data-testid="sor-ns-location-pane-empty">
        Click any style to see where it sold and where it's stocked.
      </div>
    );
  }

  const totals = (rows || []).reduce(
    (a, r) => ({ units_6m: a.units_6m + (r.units_6m || 0), sales_6m: a.sales_6m + (r.sales_6m || 0), soh_total: a.soh_total + (r.soh_total || 0) }),
    { units_6m: 0, sales_6m: 0, soh_total: 0 },
  );

  return (
    <div className="rounded-xl border border-border bg-white" data-testid="sor-ns-location-pane">
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <div className="eyebrow">Where did it sell?</div>
          <div
            className="font-bold text-[14px]"
            style={{ whiteSpace: "normal", wordBreak: "break-word", overflowWrap: "anywhere" }}
            title={style}
          >{style}</div>
          {(color || size) && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {color && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-300 text-amber-900 text-[10.5px] font-bold">
                  Color: {color}
                  <button type="button" onClick={(e) => { e.stopPropagation(); onClearColor?.(); }} className="hover:text-rose-700" aria-label="Clear colour filter">×</button>
                </span>
              )}
              {size && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-sky-50 border border-sky-300 text-sky-900 text-[10.5px] font-bold">
                  Size: {size}
                  <button type="button" onClick={(e) => { e.stopPropagation(); onClearSize?.(); }} className="hover:text-rose-700" aria-label="Clear size filter">×</button>
                </span>
              )}
            </div>
          )}
          {rows?.length > 0 && (
            <div className="text-[11px] text-muted mt-1">
              {rows.length} location{rows.length === 1 ? "" : "s"} · {fmtNum(totals.units_6m)} units · {fmtKES(totals.sales_6m)} · {fmtNum(totals.soh_total)} SOH
            </div>
          )}
        </div>
        <button type="button" onClick={onClear} className="text-muted hover:text-foreground p-1" aria-label="Clear selection">
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
          <table className="w-full text-[12px]" data-testid="sor-ns-location-table">
            <thead>
              <tr className="text-muted border-b border-border">
                <SortHeader keyName="location" label="Location" />
                <SortHeader keyName="units_6m"  label="Units 6M"  align="right" />
                <SortHeader keyName="soh_total" label="SOH"       align="right" />
                <SortHeader keyName="sor_6m"    label="SOR"       align="right" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const sor = r.sor_6m || 0;
                const sorCls = sor >= 70 ? "text-emerald-600 font-bold" : sor >= 50 ? "text-emerald-500" : sor < 25 ? "text-rose-600" : "";
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

export default SORNewStylesReport;
