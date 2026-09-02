import React, { useEffect, useMemo, useState } from "react";
import { Download } from "@phosphor-icons/react";
import { api, fmtNum, fmtPct } from "@/lib/api";
import { useFilters } from "@/lib/filters";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { exportCSV } from "@/components/SortableTable";
import DateWindowSelector from "@/components/DateWindowSelector";

const fullKES = (value) =>
  `KES ${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(Number(value) || 0)}`;

const yesterdayRange = (days) => {
  const to = new Date();
  to.setUTCDate(to.getUTCDate() - 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days + 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
};

const ProductsPlan = () => {
  const { applied } = useFilters();
  const { countries = [], channels = [] } = applied || {};
  const [windowDays, setWindowDays] = useState(30);
  const initialRange = useMemo(() => yesterdayRange(30), []);
  const [customFrom, setCustomFrom] = useState(initialRange.from);
  const [customTo, setCustomTo] = useState(initialRange.to);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const dateRange = useMemo(() => {
    if (windowDays === "custom") {
      return customFrom && customTo && customFrom <= customTo
        ? { from: customFrom, to: customTo }
        : null;
    }
    return yesterdayRange(windowDays);
  }, [windowDays, customFrom, customTo]);

  const changeWindow = (value) => {
    if (value === "custom" && windowDays !== "custom") {
      const current = yesterdayRange(typeof windowDays === "number" ? windowDays : 30);
      setCustomFrom(current.from);
      setCustomTo(current.to);
    }
    setWindowDays(value);
  };

  useEffect(() => {
    if (!dateRange) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/analytics/products-plan", {
        params: {
          date_from: dateRange.from,
          date_to: dateRange.to,
          country: countries.length ? countries.join(",") : undefined,
          channel: channels.length ? channels.join(",") : undefined,
        },
        timeout: 180000,
      })
      .then(({ data }) => { if (!cancelled) setRows(data || []); })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [dateRange, JSON.stringify(countries), JSON.stringify(channels)]);

  const totals = useMemo(() => {
    const sums = rows.reduce(
      (acc, r) => ({
        total_sales: acc.total_sales + (r.total_sales || 0),
        qty_sold: acc.qty_sold + (r.qty_sold || 0),
        total_soh: acc.total_soh + (r.total_soh || 0),
        stores_soh: acc.stores_soh + (r.stores_soh || 0),
        wh_soh: acc.wh_soh + (r.wh_soh || 0),
        pipeline_soh: acc.pipeline_soh + (r.pipeline_soh || 0),
      }),
      { total_sales: 0, qty_sold: 0, total_soh: 0, stores_soh: 0, wh_soh: 0, pipeline_soh: 0 }
    );
    const sor = sums.qty_sold + sums.total_soh > 0
      ? (sums.qty_sold / (sums.qty_sold + sums.total_soh)) * 100
      : 0;
    const openingWoc = sums.qty_sold > 0
      ? sums.total_soh / (sums.qty_sold / 4.28)
      : null;
    return { ...sums, sor, opening_woc: openingWoc };
  }, [rows]);

  const exportRows = useMemo(() => [
    ...rows,
    {
      category: "TOTAL",
      subcategory: "",
      ...totals,
      pct_qty: rows.length ? 100 : 0,
      pct_total_soh: rows.length ? 100 : 0,
      pct_stores_soh: rows.length ? 100 : 0,
      pct_wh_soh: rows.length ? 100 : 0,
      stock_to_sales_ratio: 0,
    },
  ], [rows, totals]);

  const exportColumns = [
    { key: "category", label: "Category" },
    { key: "subcategory", label: "Subcategory" },
    { key: "total_sales", label: "Total Sales" },
    { key: "sor", label: "SOR", pct: true },
    { key: "qty_sold", label: "Units Sold" },
    { key: "pct_qty", label: "% Units Sold", pct: true },
    { key: "total_soh", label: "Total Opening Stock" },
    { key: "opening_woc", label: "Opening WOC", csv: (r) => r.opening_woc == null ? "" : Number(r.opening_woc).toFixed(1) },
    { key: "pct_total_soh", label: "% Total SOH", pct: true },
    { key: "stores_soh", label: "Stores SOH" },
    { key: "pct_stores_soh", label: "% Stores SOH", pct: true },
    { key: "wh_soh", label: "Warehouse Finished Goods SOH" },
    { key: "pct_wh_soh", label: "% Warehouse SOH", pct: true },
    { key: "stock_to_sales_ratio", label: "Total Stock to Sales Ratio", pct: true },
  ];

  const pct = (value) => fmtPct(Number(value) || 0, 1);
  const woc = (value) => value == null ? "—" : Number(value).toFixed(1);

  return (
    <div className="space-y-4" data-testid="products-plan">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Stock to Sales — Products Plan</h1>
          <p className="text-[12.5px] text-muted mt-1">
            Product mix by category and subcategory, using current sellable stock.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <div className="eyebrow mb-1">Report window</div>
            <DateWindowSelector
              value={windowDays}
              onChange={changeWindow}
              testId="products-plan-window"
              label=""
              allowCustom
              customFrom={customFrom}
              customTo={customTo}
              onCustomChange={(from, to) => { setCustomFrom(from); setCustomTo(to); }}
            />
          </div>
          <button
            type="button"
            onClick={() => exportCSV(exportRows, exportColumns, "stock-to-sales-products-plan.csv")}
            disabled={!rows.length}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-2 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
            data-testid="products-plan-export"
          >
            <Download size={14} weight="bold" />
            Export CSV
          </button>
        </div>
      </div>
      <div className="card-white p-5">
      <SectionTitle
        subtitle={
          <>
            Opening WOC = Total Opening Stock ÷ (Units Sold ÷ 4.28). Total
            Opening Stock includes Stores and Warehouse Finished Goods only.
            Total Stock to Sales Ratio = % Total SOH − % Units Sold.
          </>
        }
      />
      {loading && <Loading label="Aggregating plan…" />}
      {error && <ErrorBox message={error} />}
      {!loading && !error && (
        rows.length === 0 ? (
          <Empty label="No product-plan data for the selected window." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1450px] text-[12px]" data-testid="products-plan-table">
              <thead>
                <tr className="border-b border-border bg-[#fff8ee] text-[10.5px] uppercase tracking-wide text-muted">
                  <th className="p-2 text-left">Category</th>
                  <th className="p-2 text-left">Subcategory</th>
                  <th className="p-2 text-right">Total Sales</th>
                  <th className="p-2 text-right">SOR</th>
                  <th className="p-2 text-right">Units Sold</th>
                  <th className="p-2 text-right">% Units Sold</th>
                  <th className="p-2 text-right">Total Opening Stock</th>
                  <th className="p-2 text-right">Opening WOC</th>
                  <th className="p-2 text-right">% Total SOH</th>
                  <th className="p-2 text-right">Stores SOH</th>
                  <th className="p-2 text-right">% Stores SOH</th>
                  <th className="p-2 text-right">WH Finished Goods</th>
                  <th className="p-2 text-right">% WH SOH</th>
                  <th className="p-2 text-right">Stock to Sales Ratio</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.category}:${r.subcategory}`} className="border-b border-border/70 hover:bg-panel/40">
                    <td className="p-2 font-semibold text-brand-deep">{r.category}</td>
                    <td className="p-2">{r.subcategory}</td>
                    <td className="p-2 text-right tabular-nums">{fullKES(r.total_sales)}</td>
                    <td className="p-2 text-right tabular-nums">{pct(r.sor)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtNum(r.qty_sold)}</td>
                    <td className="p-2 text-right tabular-nums">{pct(r.pct_qty)}</td>
                    <td className="p-2 text-right tabular-nums font-semibold">{fmtNum(r.total_soh)}</td>
                    <td className="p-2 text-right tabular-nums">{woc(r.opening_woc)}</td>
                    <td className="p-2 text-right tabular-nums">{pct(r.pct_total_soh)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtNum(r.stores_soh)}</td>
                    <td className="p-2 text-right tabular-nums">{pct(r.pct_stores_soh)}</td>
                    <td className="p-2 text-right tabular-nums">{fmtNum(r.wh_soh)}</td>
                    <td className="p-2 text-right tabular-nums">{pct(r.pct_wh_soh)}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${r.stock_to_sales_ratio > 0 ? "text-danger" : r.stock_to_sales_ratio < 0 ? "text-brand" : ""}`}>
                      {pct(r.stock_to_sales_ratio)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-brand bg-[#fef3e0] font-bold" data-testid="products-plan-totals">
                  <td className="p-2">TOTAL</td>
                  <td className="p-2" />
                  <td className="p-2 text-right tabular-nums">{fullKES(totals.total_sales)}</td>
                  <td className="p-2 text-right tabular-nums">{pct(totals.sor)}</td>
                  <td className="p-2 text-right tabular-nums">{fmtNum(totals.qty_sold)}</td>
                  <td className="p-2 text-right tabular-nums">100.0%</td>
                  <td className="p-2 text-right tabular-nums">{fmtNum(totals.total_soh)}</td>
                  <td className="p-2 text-right tabular-nums">{woc(totals.opening_woc)}</td>
                  <td className="p-2 text-right tabular-nums">100.0%</td>
                  <td className="p-2 text-right tabular-nums">{fmtNum(totals.stores_soh)}</td>
                  <td className="p-2 text-right tabular-nums">100.0%</td>
                  <td className="p-2 text-right tabular-nums">{fmtNum(totals.wh_soh)}</td>
                  <td className="p-2 text-right tabular-nums">100.0%</td>
                  <td className="p-2 text-right tabular-nums">0.0%</td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      )}
      </div>
    </div>
  );
};

export default ProductsPlan;
