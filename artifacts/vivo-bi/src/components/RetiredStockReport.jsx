import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtKES, fmtNum, fmtDate } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { SortableTable } from "@/components/SortableTable";
import MultiSelect from "@/components/MultiSelect";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  Legend, CartesianGrid,
} from "recharts";

/**
 * Retired Stock Report — how the Odoo-Retired range is performing and where.
 *
 * Backend: /analytics/retired-report (summary + per-style + per-store; each
 * style row embeds its store_breakdown for the row-expand drill). The report
 * follows the global filter bar: date range, country and store filters all
 * apply. Units are net of returns (sell-through lens, same as the SOR
 * Report); Net Sales is the canonical ex-VAT figure.
 */

const SorPct = ({ v }) => {
  if (v == null) return <span className="text-muted">—</span>;
  const cls = v >= 70 ? "text-emerald-600 font-bold" : v >= 50 ? "text-emerald-500" : v < 25 ? "text-rose-600" : "";
  return <span className={cls}>{v.toFixed(1)}%</span>;
};

const StatCard = ({ label, value, sub, tone }) => (
  <div className="rounded-lg border border-border bg-card p-3">
    <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
    <div className={"text-xl font-semibold mt-0.5 " + (tone === "warn" ? "text-amber-600" : tone === "bad" ? "text-rose-600" : "text-foreground")}>
      {value}
    </div>
    {sub ? <div className="text-[11px] text-muted mt-0.5">{sub}</div> : null}
  </div>
);

/** Row-expand: per-store breakdown for one style (ships in the payload). */
const StyleStoresPanel = ({ styleName, rows }) => {
  if (!rows?.length) return <div className="p-3 text-sm text-muted">No store activity or stock for this style in the selected window.</div>;
  return (
    <div className="p-3 bg-muted/20">
      <div className="text-[12px] font-medium text-muted mb-1.5">Where "{styleName}" is selling & sitting</div>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-muted border-b border-border">
            <th className="py-1 pr-2 font-medium">Location</th>
            <th className="py-1 px-2 font-medium text-right">Units Sold</th>
            <th className="py-1 px-2 font-medium text-right">Net Sales</th>
            <th className="py-1 px-2 font-medium text-right">SOH</th>
            <th className="py-1 px-2 font-medium text-right">SOR %</th>
            <th className="py-1 pl-2 font-medium text-right">Last Sale</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.store} className="border-b border-border/50 last:border-0">
              <td className="py-1 pr-2">
                {r.store}
                {r.is_warehouse
                  ? <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700">WH</span>
                  : r.is_holding
                    ? <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700">HOLDING</span>
                    : null}
              </td>
              <td className="py-1 px-2 text-right">{fmtNum(r.units_sold)}</td>
              <td className="py-1 px-2 text-right">{fmtKES(r.net_sales)}</td>
              <td className="py-1 px-2 text-right">{fmtNum(r.soh)}</td>
              <td className="py-1 px-2 text-right"><SorPct v={r.sor_period} /></td>
              <td className="py-1 pl-2 text-right">{r.last_sale ? fmtDate(r.last_sale) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const RetiredStockReport = () => {
  const { applied } = useFilters();
  const { countries, channels, dateFrom, dateTo } = applied;
  const countryParam = countries?.length ? countries.map((c) => c.toLowerCase()).join(",") : undefined;
  const channelParam = channels?.length ? channels.join(",") : undefined;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [brandSel, setBrandSel] = useState([]);
  const [catSel, setCatSel] = useState([]);
  const [stockOnly, setStockOnly] = useState(false);

  const fetchParams = useMemo(() => {
    const p = {};
    if (countryParam) p.country = countryParam;
    if (channelParam) p.channel = channelParam;
    if (dateFrom) p.date_from = dateFrom;
    if (dateTo) p.date_to = dateTo;
    return p;
  }, [countryParam, channelParam, dateFrom, dateTo]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get("/analytics/retired-report", { params: fetchParams })
      .then((r) => { if (!cancelled) setData(r.data || null); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fetchParams]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 150);
    return () => clearTimeout(t);
  }, [searchInput]);

  const styles = data?.styles || [];
  const storeRows = data?.stores || [];
  const summary = data?.summary || {};
  const win = data?.window || {};

  const brands = useMemo(() => {
    const s = new Set(styles.map((r) => r.brand).filter(Boolean));
    return Array.from(s).sort().map((v) => ({ value: v, label: v }));
  }, [styles]);
  const categories = useMemo(() => {
    const s = new Set(styles.map((r) => r.category).filter(Boolean));
    return Array.from(s).sort().map((v) => ({ value: v, label: v }));
  }, [styles]);

  const filteredStyles = useMemo(() => styles.filter((r) => {
    if (brandSel.length && !brandSel.includes(r.brand)) return false;
    if (catSel.length && !catSel.includes(r.category)) return false;
    if (stockOnly && !(r.soh_total > 0)) return false;
    if (search) {
      const hay = ((r.style_name || "") + " " + (r.style_number || "")).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }), [styles, brandSel, catSel, stockOnly, search]);

  const sellingStores = useMemo(() => storeRows.filter((r) => !r.is_holding), [storeRows]);
  const holdingRows = useMemo(() => storeRows.filter((r) => r.is_holding), [storeRows]);
  const chartData = useMemo(() => (
    sellingStores.slice(0, 12).map((r) => ({
      store: r.store.replace(/^Vivo\s+/i, ""),
      "Units Sold": r.units_sold,
      "Stock on Hand": r.soh,
    }))
  ), [sellingStores]);

  const styleCols = useMemo(() => [
    { key: "style_name", label: "Style", sortable: true,
      render: (r) => (
        <div>
          <div className="font-medium">{r.style_name}</div>
          <div className="text-[10.5px] text-muted">{[r.brand, r.category].filter(Boolean).join(" · ")}</div>
        </div>
      ),
      csv: (r) => r.style_name },
    { key: "style_number", label: "Style #", sortable: true, render: (r) => r.style_number || "—" },
    { key: "subcategory", label: "Sub Category", sortable: true, render: (r) => r.subcategory || "—" },
    { key: "units_sold", label: "Units Sold", sortable: true, align: "right", render: (r) => fmtNum(r.units_sold) },
    { key: "net_sales", label: "Net Sales", sortable: true, align: "right", render: (r) => fmtKES(r.net_sales) },
    { key: "asp", label: "ASP", sortable: true, align: "right",
      render: (r) => r.asp == null ? <span className="text-muted">—</span> : fmtKES(r.asp) },
    { key: "soh_stores", label: "SOH Stores", sortable: true, align: "right", render: (r) => fmtNum(r.soh_stores) },
    { key: "soh_wh", label: "SOH WH", sortable: true, align: "right", render: (r) => fmtNum(r.soh_wh) },
    { key: "soh_total", label: "SOH", sortable: true, align: "right",
      render: (r) => <span className={r.soh_total > 0 ? "" : "text-muted"}>{fmtNum(r.soh_total)}</span> },
    { key: "soh_value_full_price", label: "SOH @ Full Price", sortable: true, align: "right",
      render: (r) => r.soh_value_full_price == null ? <span className="text-muted">—</span> : fmtKES(r.soh_value_full_price) },
    { key: "sor_period", label: "SOR Sel", sortable: true, align: "right",
      sortValue: (r) => r.sor_period == null ? -1 : r.sor_period,
      render: (r) => <SorPct v={r.sor_period} /> },
    { key: "units_life", label: "Units Life", sortable: true, align: "right", render: (r) => fmtNum(r.units_life) },
    { key: "sor_life", label: "SOR Life", sortable: true, align: "right",
      sortValue: (r) => r.sor_life == null ? -1 : r.sor_life,
      render: (r) => <SorPct v={r.sor_life} /> },
    { key: "woc", label: "WoC", sortable: true, align: "right",
      sortValue: (r) => r.woc == null ? 9999 : r.woc,
      render: (r) => {
        if (r.woc == null) return <span className="text-muted">—</span>;
        const cls = r.woc < 8 ? "text-emerald-600" : r.woc < 26 ? "text-amber-600" : "text-rose-600";
        return <span className={cls}>{r.woc.toFixed(1)}w</span>;
      } },
    { key: "stores_with_stock", label: "Stores w/ Stock", sortable: true, align: "right", render: (r) => fmtNum(r.stores_with_stock) },
    { key: "top_store", label: "Top Store", sortable: true, render: (r) => r.top_store || "—" },
    { key: "days_since_last_sale", label: "Last Sale", sortable: true, align: "right",
      sortValue: (r) => r.days_since_last_sale == null ? 99999 : r.days_since_last_sale,
      render: (r) => {
        const d = r.days_since_last_sale;
        if (d == null) return <span className="text-muted">never</span>;
        const cls = d > 90 ? "text-rose-600 font-bold" : d > 30 ? "text-amber-600" : "";
        return <span className={cls}>{d}d</span>;
      } },
    { key: "launch_date", label: "Launch", sortable: true, render: (r) => r.launch_date ? fmtDate(r.launch_date) : "—" },
  ], []);

  const storeCols = useMemo(() => [
    { key: "store", label: "Store", sortable: true,
      render: (r) => (
        <div>
          <div className="font-medium">{r.store}</div>
          <div className="text-[10.5px] text-muted">{r.country || ""}</div>
        </div>
      ),
      csv: (r) => r.store },
    { key: "units_sold", label: "Units Sold", sortable: true, align: "right", render: (r) => fmtNum(r.units_sold) },
    { key: "net_sales", label: "Net Sales", sortable: true, align: "right", render: (r) => fmtKES(r.net_sales) },
    { key: "soh", label: "SOH", sortable: true, align: "right", render: (r) => fmtNum(r.soh) },
    { key: "styles_sold", label: "Styles Sold", sortable: true, align: "right", render: (r) => fmtNum(r.styles_sold) },
    { key: "styles_with_stock", label: "Styles w/ Stock", sortable: true, align: "right", render: (r) => fmtNum(r.styles_with_stock) },
    { key: "sor_period", label: "SOR %", sortable: true, align: "right",
      sortValue: (r) => r.sor_period == null ? -1 : r.sor_period,
      render: (r) => <SorPct v={r.sor_period} /> },
  ], []);

  if (loading) return <Loading label="Building retired stock report…" />;
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Empty />;

  const windowLabel = win.date_from && win.date_to
    ? `${fmtDate(win.date_from)} → ${fmtDate(win.date_to)} (${win.days} days)`
    : "";

  return (
    <div className="space-y-5" data-testid="retired-stock-report">
      <SectionTitle
        title="Retired Stock Report"
        subtitle={`How the retired range is selling and where the remaining stock sits. Retired = marked Retired in Odoo. Sales window: ${windowLabel} — set by the date filter above. Units are net of returns; SOR = units sold ÷ (units sold + stock on hand).`}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5" data-testid="retired-kpis">
        <StatCard
          label="Retired Styles"
          value={fmtNum(summary.styles_retired_catalog)}
          sub={`${fmtNum(summary.styles_in_report)} with stock or sales in window`}
        />
        <StatCard
          label="Sold This Period"
          value={`${fmtNum(summary.styles_sold)} styles`}
          sub={`${fmtNum(summary.styles_sold_out)} fully sold out`}
        />
        <StatCard label="Units Sold" value={fmtNum(summary.units_sold)} sub="net of returns, this window" />
        <StatCard label="Net Sales" value={fmtKES(summary.net_sales)} sub="ex-VAT, returns netted" />
        <StatCard
          label="Stock on Hand"
          value={fmtNum(summary.soh_total)}
          sub={`stores ${fmtNum(summary.soh_stores)}${summary.soh_holding ? ` (incl. ${fmtNum(summary.soh_holding)} in holding)` : ""} · warehouse ${fmtNum(summary.soh_wh)}${summary.soh_pipeline ? ` · pipeline ${fmtNum(summary.soh_pipeline)}` : ""}`}
          tone={summary.soh_total > 0 ? "warn" : undefined}
        />
        <StatCard label="SOH @ Full Price" value={fmtKES(summary.soh_value_full_price)} sub="remaining stock at full ticket price" />
        <StatCard label="Sell-Through (Window)" value={summary.sor_period == null ? "—" : `${summary.sor_period.toFixed(1)}%`} sub="units sold vs sold + remaining" />
        <StatCard label="Sell-Through (Life)" value={summary.sor_life == null ? "—" : `${summary.sor_life.toFixed(1)}%`} sub="lifetime units vs remaining stock" />
      </div>

      {chartData.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-[13px] font-medium mb-2">Top stores — retired units sold vs stock still sitting</div>
          <div style={{ width: "100%", height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="store" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={52} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <RTooltip formatter={(v) => fmtNum(v)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Units Sold" fill="#1a5c38" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Stock on Hand" fill="#d97706" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div>
        <SectionTitle
          title="By Store"
          subtitle="Which stores are moving retired stock — and which are sitting on it."
        />
        <SortableTable
          columns={storeCols}
          rows={sellingStores}
          initialSort={{ key: "units_sold", dir: "desc" }}
          exportName="retired-stock-by-store"
          testId="retired-stores-table"
          maxHeight="48vh"
        />
        {holdingRows.length > 0 && (
          <div className="mt-2 text-[12px] text-muted" data-testid="retired-wh-strip">
            <span className="mr-2 font-medium">Not on a shop floor:</span>
            {holdingRows.map((r) => (
              <span key={r.store} className="inline-block mr-4">
                <span className="font-medium text-foreground">{r.store}:</span>{" "}
                {fmtNum(r.soh)} units across {fmtNum(r.styles_with_stock)} styles
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionTitle
          title="By Style"
          subtitle="Every retired style with stock or sales in the window. Click a row for its store-by-store breakdown."
        />
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <div className="relative">
            <MagnifyingGlass size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search style / style #…"
              className="pl-7 pr-7 py-1.5 text-[13px] rounded-md border border-border bg-card w-56"
              data-testid="retired-search"
            />
            {searchInput && (
              <button type="button" onClick={() => setSearchInput("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted">
                <X size={13} />
              </button>
            )}
          </div>
          <div className="w-44"><MultiSelect options={brands} value={brandSel} onChange={setBrandSel} placeholder="All Brands" testId="retired-brand-filter" /></div>
          <div className="w-48"><MultiSelect options={categories} value={catSel} onChange={setCatSel} placeholder="All Categories" testId="retired-cat-filter" /></div>
          <label className="flex items-center gap-1.5 text-[12.5px] text-muted cursor-pointer select-none">
            <input type="checkbox" checked={stockOnly} onChange={(e) => setStockOnly(e.target.checked)} />
            Only styles with stock
          </label>
          <div className="text-[12px] text-muted ml-auto">
            {fmtNum(filteredStyles.length)} of {fmtNum(styles.length)} styles
          </div>
        </div>
        <SortableTable
          columns={styleCols}
          rows={filteredStyles}
          initialSort={{ key: "net_sales", dir: "desc" }}
          exportName="retired-stock-by-style"
          testId="retired-styles-table"
          pageSize={100}
          resizable
          renderExpanded={(r) => <StyleStoresPanel styleName={r.style_name} rows={r.store_breakdown} />}
          rowKey={(r) => r.style_name}
        />
      </div>
    </div>
  );
};

export default RetiredStockReport;
