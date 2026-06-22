import React, { useEffect, useState, useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import { SectionTitle, Loading, ErrorBox, Empty } from "@/components/common";
import ProductionOrderModal from "@/components/ProductionOrderModal";
import {
  ArrowsClockwise,
  Factory,
  MagnifyingGlass,
  X,
  DownloadSimple,
} from "@phosphor-icons/react";

/**
 * Production Report — a detailed, structured read of every buying order in the
 * Production Tracker. It answers three questions for the buying team:
 *   1. Per order: how many colours, what sizes, and "what is where" (the unit
 *      split across manufacturing stages). Click a row to open the full
 *      colour x size matrix + stage balances modal.
 *   2. Across orders: roll-ups by lifecycle (New / Replenishment / Re-order),
 *      production type, buying-order state, current WIP stage and buyer.
 *   3. The whole order table exports to CSV.
 *
 * Reads GET /api/production/summary (one round-trip: totals + breakdowns + a
 * flat row per order with colour/size/variant counts and per-stage units).
 */
function fmtQty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v)
    ? v.toLocaleString()
    : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(d);
  }
}

function titleize(s) {
  if (!s) return "—";
  return String(s)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const LIFECYCLE_STYLE = {
  New: "bg-emerald-50 text-emerald-700 border-emerald-200",
  Replenishment: "bg-sky-50 text-sky-700 border-sky-200",
  "Re-order": "bg-violet-50 text-violet-700 border-violet-200",
};

function lifecycleBadge(label) {
  return LIFECYCLE_STYLE[label] || "bg-gray-50 text-gray-600 border-gray-200";
}

/** A labelled roll-up card: a small table of {label, orders, units}. */
function BreakdownCard({ title, rows, accent }) {
  const total = useMemo(
    () => (rows || []).reduce((s, r) => s + (Number(r.units) || 0), 0),
    [rows]
  );
  return (
    <div className="card-white p-4" data-testid={`breakdown-${title}`}>
      <div className="eyebrow mb-2">{title}</div>
      {(!rows || rows.length === 0) ? (
        <div className="text-[12px] text-muted italic">No data.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const pct = total > 0 ? (Number(r.units) / total) * 100 : 0;
            return (
              <div key={r.label || r.stage_key}>
                <div className="flex items-center justify-between gap-2 text-[12.5px]">
                  <span className="font-semibold text-[#0f3d24] truncate">
                    {r.stage_name || titleize(r.label)}
                  </span>
                  <span className="text-muted whitespace-nowrap tabular-nums">
                    {fmtQty(r.units)} u · {fmtQty(r.orders)} ord
                  </span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-panel/70 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${accent || "bg-brand"}`}
                    style={{ width: `${Math.max(pct, pct > 0 ? 3 : 0)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub }) {
  return (
    <div className="card-white p-4">
      <div className="eyebrow">{label}</div>
      <div className="text-[24px] font-extrabold text-brand leading-tight mt-0.5">
        {value}
      </div>
      {sub && <div className="text-[11.5px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

export default function ProductionReport() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [lifecycleFilter, setLifecycleFilter] = useState("");
  const [openOrder, setOpenOrder] = useState(null);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const { data } = await api.get(
        "/production/summary",
        force ? { forceFresh: true } : {}
      );
      setData(data);
    } catch (err) {
      setError(
        err?.response?.data?.detail ||
          err.message ||
          "Failed to load the production report"
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const totals = data?.totals || { orders: 0, units: 0, styles: 0 };
  const byStage = data?.by_stage || [];
  const orders = data?.orders || [];

  // Stage columns in board order, for the per-order "what is where" mini-split.
  const stageCols = useMemo(
    () => byStage.map((s) => ({ key: s.stage_key, name: s.stage_name })),
    [byStage]
  );

  const inProgressUnits = useMemo(
    () => byStage.reduce((s, r) => s + (Number(r.units) || 0), 0),
    [byStage]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      if (lifecycleFilter && (o.lifecycle_type || "") !== lifecycleFilter)
        return false;
      if (!q) return true;
      return [o.order_ref, o.style_number, o.style_name, o.product_name, o.buyer]
        .some((v) => String(v || "").toLowerCase().includes(q));
    });
  }, [orders, query, lifecycleFilter]);

  const lifecycleOptions = useMemo(
    () =>
      (data?.by_lifecycle || [])
        .map((r) => r.label)
        .filter((l) => l && l !== "Unspecified"),
    [data]
  );

  const exportCsv = useCallback(() => {
    const cols = [
      "Order",
      "Style number",
      "Style name",
      "Buyer",
      "Lifecycle",
      "Production type",
      "BO state",
      "Colours",
      "Sizes",
      "Variants",
      "Order qty",
      "In progress",
      "Date ordered",
      "Expected delivery",
      ...stageCols.map((s) => s.name),
    ];
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const o of filtered) {
      const sq = o.stage_qty || {};
      const row = [
        o.order_ref,
        o.style_number,
        o.style_name,
        o.buyer,
        o.lifecycle_type,
        o.production_type,
        titleize(o.bo_state),
        o.colours,
        o.sizes,
        o.variants,
        o.order_qty,
        o.units_in_progress,
        o.date_ordered ? String(o.date_ordered).slice(0, 10) : "",
        o.expected_delivery_date ? String(o.expected_delivery_date).slice(0, 10) : "",
        ...stageCols.map((s) => sq[s.key] || 0),
      ];
      lines.push(row.map(esc).join(","));
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `production-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, stageCols]);

  if (loading) return <Loading label="Loading the production report…" />;
  if (error) return <ErrorBox message={error} />;

  return (
    <div className="space-y-5" data-testid="production-report">
      <SectionTitle
        title="Production Report"
        subtitle="Every buying order — colours, sizes and where the units sit across the line, with cross-order roll-ups by order type, production type and stage."
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportCsv}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#0f3d24] bg-white border border-line hover:bg-panel/60 px-3 py-2 rounded-md"
              data-testid="production-report-csv"
            >
              <DownloadSimple size={14} weight="bold" /> CSV
            </button>
            <button
              type="button"
              onClick={() => load(true)}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-white bg-[#1a5c38] hover:bg-[#0f3d24] px-3 py-2 rounded-md disabled:opacity-50"
              data-testid="production-report-refresh"
            >
              <ArrowsClockwise
                size={14}
                weight="bold"
                className={refreshing ? "animate-spin" : ""}
              />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        }
      />

      {/* KPI row */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Kpi label="Buying orders" value={fmtQty(totals.orders)} />
        <Kpi label="Ordered units" value={fmtQty(totals.units)} />
        <Kpi label="Distinct styles" value={fmtQty(totals.styles)} />
        <Kpi
          label="Units in progress"
          value={fmtQty(inProgressUnits)}
          sub="Across all active stages"
        />
      </div>

      {/* Breakdowns */}
      <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        <BreakdownCard
          title="By order type"
          rows={data?.by_lifecycle}
          accent="bg-emerald-500"
        />
        <BreakdownCard
          title="By production type"
          rows={data?.by_production_type}
          accent="bg-sky-500"
        />
        <BreakdownCard
          title="By buying-order state"
          rows={data?.by_state}
          accent="bg-amber-500"
        />
        <BreakdownCard
          title="What is where (current stage)"
          rows={(byStage || []).filter((s) => Number(s.units) > 0)}
          accent="bg-violet-500"
        />
        <BreakdownCard
          title="By buyer"
          rows={(data?.by_buyer || []).slice(0, 8)}
          accent="bg-rose-500"
        />
      </div>

      {/* Per-order table */}
      <div className="card-white p-4">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="eyebrow">
            Orders ({fmtQty(filtered.length)}
            {filtered.length !== orders.length ? ` of ${fmtQty(orders.length)}` : ""})
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={lifecycleFilter}
              onChange={(e) => setLifecycleFilter(e.target.value)}
              className="input-pill text-[12px]"
              data-testid="production-report-lifecycle"
            >
              <option value="">All order types</option>
              {lifecycleOptions.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <div className="relative">
              <MagnifyingGlass
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search order, style, buyer…"
                className="input-pill text-[12px] pl-8 pr-7 w-56"
                data-testid="production-report-search"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        </div>

        {filtered.length === 0 ? (
          <Empty label="No orders match the current search / filter." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] border-collapse">
              <thead className="bg-panel/60 text-muted">
                <tr>
                  <th className="text-left font-semibold px-3 py-2">Order</th>
                  <th className="text-left font-semibold px-3 py-2">Style</th>
                  <th className="text-left font-semibold px-3 py-2">Buyer</th>
                  <th className="text-left font-semibold px-3 py-2">Type</th>
                  <th className="text-right font-semibold px-2.5 py-2">Colours</th>
                  <th className="text-right font-semibold px-2.5 py-2">Sizes</th>
                  <th className="text-right font-semibold px-2.5 py-2">Order qty</th>
                  <th className="text-left font-semibold px-3 py-2">What is where</th>
                  <th className="text-left font-semibold px-3 py-2">Expected</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => {
                  const sq = o.stage_qty || {};
                  const active = stageCols.filter((s) => Number(sq[s.key]) > 0);
                  return (
                    <tr
                      key={o.order_ref}
                      className="border-t border-line hover:bg-panel/40 cursor-pointer"
                      onClick={() => setOpenOrder(o.order_ref)}
                      data-testid={`production-report-row-${o.order_ref}`}
                    >
                      <td className="px-3 py-2 font-semibold text-brand whitespace-nowrap">
                        {o.order_ref}
                      </td>
                      <td className="px-3 py-2 max-w-[200px]">
                        <div className="font-semibold text-[#0f3d24] truncate">
                          {o.style_name || o.product_name || o.style_number || "—"}
                        </div>
                        {o.style_number && (
                          <div className="text-[10.5px] text-muted truncate">
                            {o.style_number}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted whitespace-nowrap max-w-[120px] truncate">
                        {o.buyer || "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {o.lifecycle_type ? (
                          <span
                            className={`inline-block text-[10.5px] font-semibold px-1.5 py-0.5 rounded border ${lifecycleBadge(
                              o.lifecycle_type
                            )}`}
                          >
                            {o.lifecycle_type}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-2.5 py-2 text-right tabular-nums">
                        {fmtQty(o.colours)}
                      </td>
                      <td className="px-2.5 py-2 text-right tabular-nums">
                        {fmtQty(o.sizes)}
                      </td>
                      <td className="px-2.5 py-2 text-right font-semibold tabular-nums">
                        {fmtQty(o.order_qty)}
                      </td>
                      <td className="px-3 py-2">
                        {active.length === 0 ? (
                          <span className="text-muted italic text-[11px]">
                            Not started / done
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {active.map((s) => (
                              <span
                                key={s.key}
                                className="inline-flex items-center gap-1 text-[10.5px] bg-panel/70 border border-line rounded-full px-1.5 py-0.5 whitespace-nowrap"
                                title={s.name}
                              >
                                <span className="text-[#0f3d24]">{s.name}</span>
                                <span className="font-semibold tabular-nums">
                                  {fmtQty(sq[s.key])}
                                </span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted whitespace-nowrap">
                        {fmtDate(o.expected_delivery_date)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openOrder && (
        <ProductionOrderModal
          orderRef={openOrder}
          onClose={() => setOpenOrder(null)}
          onChanged={() => load(true)}
        />
      )}
    </div>
  );
}
