import React, { useEffect, useMemo, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { DownloadSimple } from "@phosphor-icons/react";

const REASON_STYLES = {
  Retired:     { bg: "bg-rose-100",   text: "text-rose-800",   border: "border-rose-300",   label: "Retired" },
  Excess:      { bg: "bg-amber-100",  text: "text-amber-800",  border: "border-amber-300",  label: "Excess" },
  "Slow Mover":{ bg: "bg-orange-100", text: "text-orange-800", border: "border-orange-300", label: "Slow Mover" },
};

const ReasonBadge = ({ reason }) => {
  const s = REASON_STYLES[reason] || { bg: "bg-panel", text: "text-muted", border: "border-border", label: reason };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10.5px] font-semibold border ${s.bg} ${s.text} ${s.border}`}>
      {s.label}
    </span>
  );
};

const Rebalancing = () => {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [storeFilter, setStoreFilter] = useState("");
  const [reasonFilter, setReasonFilter] = useState("");

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.get("/analytics/rebalancing", { timeout: 300000 })
      .then((r) => setData(r.data))
      .catch((e) => setError(e?.response?.data?.detail || e.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const rows = data?.rows || [];

  const stores = useMemo(() => {
    const s = [...new Set(rows.map((r) => r.store).filter(Boolean))].sort();
    return s;
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (storeFilter && r.store !== storeFilter) return false;
      if (reasonFilter && r.reason !== reasonFilter) return false;
      return true;
    });
  }, [rows, storeFilter, reasonFilter]);

  const summary = useMemo(() => {
    const totals = { total: filtered.length, proposed: 0, inventory: 0, Retired: 0, Excess: 0, "Slow Mover": 0 };
    for (const r of filtered) {
      totals.proposed  += r.proposed_return || 0;
      totals.inventory += r.inventory || 0;
      totals[r.reason] = (totals[r.reason] || 0) + 1;
    }
    return totals;
  }, [filtered]);

  const downloadCSV = () => {
    const cols = ["store","product_title","sku","barcode","size","brand","inventory","proposed_return","reason","days_since_last_sale"];
    const header = ["Store","Product Title","SKU","Barcode","Size","Brand","Inventory","Proposed Return","Reason","Days Since Last Sale"];
    const csvRows = [header, ...filtered.map((r) => cols.map((c) => {
      const v = r[c] ?? "";
      return typeof v === "string" && v.includes(",") ? `"${v}"` : v;
    }))];
    const blob = new Blob([csvRows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `rebalancing-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  if (loading) return <Loading label="Loading rebalancing data…" />;
  if (error)   return <ErrorBox message={error} />;

  return (
    <div className="space-y-5" data-testid="rebalancing-page">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="card-white p-3.5">
          <div className="eyebrow text-[10px] mb-0.5">Total SKU lines</div>
          <div className="font-extrabold text-[24px] num leading-none">{fmtNum(summary.total)}</div>
          <div className="text-muted text-[11px] mt-0.5">across all stores</div>
        </div>
        <div className="card-white p-3.5">
          <div className="eyebrow text-[10px] mb-0.5">Units to return</div>
          <div className="font-extrabold text-[24px] num leading-none text-brand">{fmtNum(summary.proposed)}</div>
          <div className="text-muted text-[11px] mt-0.5">proposed to warehouse</div>
        </div>
        <div className="card-white p-3.5 border-l-2 border-rose-400">
          <div className="eyebrow text-[10px] mb-0.5">Retired</div>
          <div className="font-extrabold text-[24px] num leading-none text-rose-700">{fmtNum(summary.Retired || 0)}</div>
          <div className="text-muted text-[11px] mt-0.5">lines — return all units</div>
        </div>
        <div className="card-white p-3.5 border-l-2 border-amber-400">
          <div className="eyebrow text-[10px] mb-0.5">Excess</div>
          <div className="font-extrabold text-[24px] num leading-none text-amber-700">{fmtNum(summary.Excess || 0)}</div>
          <div className="text-muted text-[11px] mt-0.5">lines — return excess only</div>
        </div>
        <div className="card-white p-3.5 border-l-2 border-orange-400">
          <div className="eyebrow text-[10px] mb-0.5">Slow Movers</div>
          <div className="font-extrabold text-[24px] num leading-none text-orange-700">{fmtNum(summary["Slow Mover"] || 0)}</div>
          <div className="text-muted text-[11px] mt-0.5">lines — not sold in 45+ days</div>
        </div>
      </div>

      {/* Filters + export */}
      <div className="card-white p-3 flex flex-wrap items-end gap-2" data-testid="rebalancing-filters">
        <div className="flex flex-col gap-1 min-w-[180px]">
          <label className="text-[10.5px] text-muted font-medium">Store</label>
          <select
            className="text-[12px] border border-border rounded px-2 py-1.5 bg-white"
            value={storeFilter}
            onChange={(e) => setStoreFilter(e.target.value)}
            data-testid="rebalancing-store-filter"
          >
            <option value="">All stores</option>
            {stores.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1 min-w-[150px]">
          <label className="text-[10.5px] text-muted font-medium">Reason</label>
          <select
            className="text-[12px] border border-border rounded px-2 py-1.5 bg-white"
            value={reasonFilter}
            onChange={(e) => setReasonFilter(e.target.value)}
            data-testid="rebalancing-reason-filter"
          >
            <option value="">All reasons</option>
            <option value="Retired">Retired</option>
            <option value="Excess">Excess</option>
            <option value="Slow Mover">Slow Mover</option>
          </select>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={downloadCSV}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-[12px] font-medium hover:bg-panel transition-colors"
          data-testid="rebalancing-csv-btn"
        >
          <DownloadSimple size={14} />
          Export CSV
        </button>
      </div>

      {/* Table */}
      <div className="card-white p-5" data-testid="rebalancing-table-card">
        <SectionTitle
          title={`Rebalancing · ${fmtNum(filtered.length)} lines`}
          subtitle="Stock to return from stores to the warehouse. Retired = full store stock back; Excess = units above the size allowance; Slow Mover = not sold at this store in 45+ days."
        />
        {filtered.length === 0 ? (
          <Empty label="No lines match the current filters." />
        ) : (
          <SortableTable
            testId="rebalancing-table"
            initialSort={{ key: "proposed_return", dir: "desc" }}
            pageSize={100}
            columns={[
              {
                key: "store", label: "Store", align: "left",
                render: (r) => <span className="font-medium text-[12px]">{r.store}</span>,
              },
              {
                key: "product_title", label: "Product Title", align: "left",
                render: (r) => (
                  <div className="max-w-[220px]">
                    <div className="font-medium truncate text-[12px]" title={r.product_title}>{r.product_title || "—"}</div>
                  </div>
                ),
              },
              {
                key: "sku", label: "SKU", align: "left",
                render: (r) => <span className="text-muted text-[11.5px] font-mono">{r.sku || "—"}</span>,
              },
              {
                key: "barcode", label: "Barcode", align: "left",
                render: (r) => <span className="text-muted text-[11.5px] font-mono">{r.barcode || "—"}</span>,
              },
              {
                key: "size", label: "Size",
                render: (r) => <span className="text-[12px]">{r.size || "—"}</span>,
              },
              {
                key: "brand", label: "Brand", align: "left",
                render: (r) => <span className="text-[12px]">{r.brand || "—"}</span>,
              },
              {
                key: "inventory", label: "Inventory", numeric: true,
                render: (r) => <span className="num">{fmtNum(r.inventory)}</span>,
              },
              {
                key: "proposed_return", label: "Proposed Return", numeric: true,
                render: (r) => (
                  <span className="num font-semibold text-brand">{fmtNum(r.proposed_return)}</span>
                ),
              },
              {
                key: "reason", label: "Reason",
                render: (r) => <ReasonBadge reason={r.reason} />,
              },
              {
                key: "days_since_last_sale", label: "Last Sale", numeric: true,
                render: (r) => {
                  if (r.days_since_last_sale == null) return <span className="text-muted">—</span>;
                  const d = r.days_since_last_sale;
                  const cls = d >= 999 ? "text-rose-700 font-semibold" : d >= 45 ? "text-amber-700" : "";
                  return <span className={`num ${cls}`}>{d >= 999 ? "Never" : `${d}d`}</span>;
                },
              },
            ]}
            rows={filtered}
          />
        )}
      </div>
    </div>
  );
};

export default Rebalancing;
