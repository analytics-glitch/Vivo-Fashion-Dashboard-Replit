import React, { useEffect, useMemo, useState } from "react";
import { api, fmtNum, fmtPct } from "@/lib/api";
import { useFilters } from "@/lib/filters";
import { varianceStyle } from "@/lib/variance";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import DateWindowSelector from "@/components/DateWindowSelector";

/**
 * Stock-to-Sales · by Color and · by Size.
 *
 * Two stacked variance tables matching the column shape of
 * `Stock-to-Sales · by Subcategory` (Inventory page) so users can switch
 * between attribute lenses without re-learning the layout. Both tables share
 * a single `/analytics/stock-to-sales-by-attribute` fetch (returns
 * `{by_color, by_size}`) so we don't pay the /orders fan-out twice.
 *
 * Iter 91q — Own date-window selector (default 30 days) per leadership
 * pref Jun 2026 so the color/size lens can be analysed against a
 * different period than the subcategory view above.
 */

const VarianceCellPts = ({ value }) => {
  const { cls, icon, tip, flag } = varianceStyle(value);
  return (
    <span className={`${cls} inline-flex items-center gap-1`} title={tip} data-variance-flag={flag}>
      <span aria-hidden="true">{icon}</span>
      {value >= 0 ? "+" : ""}
      {(value || 0).toFixed(2)} pp
    </span>
  );
};

const buildColumns = (keyLabel, keyField) => [
  {
    key: keyField, label: keyLabel, align: "left",
    render: (r) => <span className="font-medium">{r[keyField] || "—"}</span>,
  },
  { key: "units_sold",         label: "Units Sold",          numeric: true, render: (r) => fmtNum(r.units_sold) },
  { key: "current_stock",      label: "Inventory",           numeric: true, render: (r) => fmtNum(Math.round(r.current_stock || 0)), csv: (r) => Math.round(r.current_stock || 0) },
  { key: "pct_of_total_sold",  label: "% of Total Sales",    numeric: true, render: (r) => fmtPct(r.pct_of_total_sold, 2) },
  { key: "pct_of_total_stock", label: "% of Total Inventory",numeric: true, render: (r) => fmtPct(r.pct_of_total_stock, 2) },
  {
    key: "variance", label: "Variance", numeric: true,
    sortValue: (r) => Math.abs(r.variance || 0),
    render: (r) => <VarianceCellPts value={r.variance} />,
    csv: (r) => r.variance?.toFixed(2),
  },
  {
    key: "risk_flag", label: "Risk Flag", align: "left",
    render: (r) => <span className="text-[11px] text-muted">{varianceStyle(r.variance).flag}</span>,
    csv: (r) => varianceStyle(r.variance).flag,
  },
];

const StockToSalesByVariant = ({ exportSlug, search = "", brand = "", productType = "" }) => {
  const { applied } = useFilters();
  const { countries, channels, dataVersion } = applied;

  // Iter 91q — Own date window (default 30 days). Independent of the
  // subcategory table's window so leadership can compare a 30-day color
  // mix against a 90-day subcategory view in the same session.
  // Now also supports a Custom From/To range (windowDays === "custom").
  const [windowDays, setWindowDays] = useState(30);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  // Effective range: preset N-days ending today, or the custom From/To.
  // Returns null when the custom range is incomplete/invalid (From > To)
  // so we can skip the fetch and keep the last good data.
  const range = useMemo(() => {
    if (windowDays === "custom") {
      if (customFrom && customTo && customFrom <= customTo) {
        return { dateFrom: customFrom, dateTo: customTo };
      }
      return null;
    }
    const today = new Date();
    const to = today.toISOString().slice(0, 10);
    const fromDate = new Date(today);
    fromDate.setUTCDate(fromDate.getUTCDate() - windowDays + 1);
    return { dateFrom: fromDate.toISOString().slice(0, 10), dateTo: to };
  }, [windowDays, customFrom, customTo]);
  const dateFrom = range?.dateFrom || "";
  const dateTo = range?.dateTo || "";

  // Switching to "Custom" seeds the empty pickers from the current numeric
  // window so the user starts from a sensible range.
  const handleWindowChange = (v) => {
    if (v === "custom") {
      if (!customFrom || !customTo) {
        const days = typeof windowDays === "number" ? windowDays : 30;
        const today = new Date();
        const to = today.toISOString().slice(0, 10);
        const fromDate = new Date(today);
        fromDate.setUTCDate(fromDate.getUTCDate() - days + 1);
        setCustomFrom(fromDate.toISOString().slice(0, 10));
        setCustomTo(to);
      }
      setWindowDays("custom");
    } else {
      setWindowDays(v);
    }
  };

  const [data, setData] = useState({ by_color: [], by_size: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The range the currently-held `data` was fetched with — so a CSV export
  // during an incomplete custom edit still names the file after the data on
  // screen, not the empty in-progress range.
  const [loadedSlug, setLoadedSlug] = useState("");

  useEffect(() => {
    // Incomplete/invalid custom range → skip the fetch, keep last good data.
    // Clear any stale fetch error so the user isn't shown an old error while
    // still editing the custom From/To dates.
    if (!dateFrom || !dateTo) { setError(null); setLoading(false); return; }
    let cancel = false;
    setLoading(true);
    setError(null);
    const params = { date_from: dateFrom, date_to: dateTo };
    if (countries && countries.length) params.country = countries.map((c) => c.toLowerCase()).join(",");
    if (channels && channels.length) params.locations = channels.join(",");
    // Inventory-page local product filters — the server scopes both the
    // sales and stock sides so these attribute aggregates reflect only the
    // searched/filtered products (impossible to filter client-side: rows
    // are color/size aggregates, not style-level).
    if (search) params.search = search;
    if (brand) params.brand = brand;
    if (productType) params.product_type = productType;
    api
      .get("/analytics/stock-to-sales-by-attribute", { params, timeout: 240000 })
      .then(({ data: d }) => {
        if (cancel) return;
        setData(d || { by_color: [], by_size: [] });
        setLoadedSlug(`${dateFrom}_${dateTo}`);
      })
      .catch((e) => !cancel && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancel && setLoading(false));
    return () => { cancel = true; };
    // eslint-disable-next-line
  }, [dateFrom, dateTo, JSON.stringify(countries), JSON.stringify(channels), dataVersion, search, brand, productType]);

  const byColor = data.by_color || [];
  const bySize = data.by_size || [];

  const colorColumns = useMemo(() => buildColumns("Color/Print", "color"), []);
  const sizeColumns = useMemo(() => buildColumns("Size", "size"), []);

  const slug = exportSlug || (dateFrom && dateTo ? `${dateFrom}_${dateTo}` : loadedSlug || "range");

  // Iter 91q — Shared date window header so both tables move together.
  // Now includes a Custom From/To range option alongside the presets.
  const headerWindow = (
    <div className="flex items-center justify-end mb-2 gap-2 flex-wrap">
      <DateWindowSelector
        value={windowDays}
        onChange={handleWindowChange}
        testId="inv-sts-variant-window"
        allowCustom
        customFrom={customFrom}
        customTo={customTo}
        onCustomChange={(f, t) => { setCustomFrom(f); setCustomTo(t); }}
      />
      {dateFrom && dateTo ? (
        <span className="text-[10.5px] text-muted tabular-nums">
          {dateFrom} → {dateTo}
        </span>
      ) : (
        <span className="text-[10.5px] text-red-500 tabular-nums">
          Pick a valid From → To range
        </span>
      )}
    </div>
  );

  return (
    <>
      <div className="card-white p-5" data-testid="sts-by-color-table">
        <SectionTitle
          title="Stock-to-Sales · by Color"
          subtitle="One row per color/print across all merchandise. Variance = sales share − stock share. Red = action needed (stockout or overstock risk). Green = healthy balance."
        />
        {headerWindow}
        {loading && <Loading />}
        {error && <ErrorBox message={error} />}
        {!loading && !error && (
          byColor.length === 0 ? (
            <Empty label="No color data in the selected window." />
          ) : (
            <SortableTable
              testId="inv-sts-color"
              exportName={`inventory-sts-by-color_${slug}.csv`}
              pageSize={15}
              initialSort={{ key: "variance", dir: "desc" }}
              columns={colorColumns}
              rows={byColor}
            />
          )
        )}
      </div>

      <div className="card-white p-5" data-testid="sts-by-size-table">
        <SectionTitle
          title="Stock-to-Sales · by Size"
          subtitle="One row per size across all merchandise. Spot sizes that consistently outsell their stock share (re-order) and sizes that are over-stocked (markdown / IBT)."
        />
        {headerWindow}
        {loading && <Loading />}
        {error && <ErrorBox message={error} />}
        {!loading && !error && (
          bySize.length === 0 ? (
            <Empty label="No size data in the selected window." />
          ) : (
            <SortableTable
              testId="inv-sts-size"
              exportName={`inventory-sts-by-size_${slug}.csv`}
              pageSize={15}
              initialSort={{ key: "variance", dir: "desc" }}
              columns={sizeColumns}
              rows={bySize}
            />
          )
        )}
      </div>
    </>
  );
};

export default StockToSalesByVariant;
