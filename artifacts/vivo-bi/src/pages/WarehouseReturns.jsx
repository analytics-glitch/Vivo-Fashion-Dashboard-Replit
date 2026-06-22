import React, { useEffect, useMemo, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { toast } from "sonner";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import ReplenishmentTransferReport from "@/components/ReplenishmentTransferReport";
import { ArrowsClockwise, Warehouse, Tag, Hourglass } from "@phosphor-icons/react";

const DAY_PRESETS = [30, 60, 90, 180];
const rowKey = (r) => `${r.pos_location}|${r.sku}`;

/**
 * Warehouse Returns — surfaces store stock that should go back to the warehouse,
 * in one of two mutually-exclusive modes:
 *
 *   • Aged    — SKUs that have not sold AT THEIR STORE in >= N days.
 *   • Retired — stock of retired styles (no company-wide sales in 182 days, or
 *               on the manual-retirement list).
 *
 * The operator selects items, sets the units to pull back (defaults to store
 * SOH), and marks them for transfer to the warehouse. Those marks are written as
 * `warehouse_return` recommendation actions and roll up into the embedded
 * Transfer Tracking report so the single Odoo transfer document number that
 * physically moved each store's items can be reconciled — exactly like the
 * replenishment flow, but in the store → warehouse direction.
 */
const WarehouseReturns = () => {
  const [mode, setMode] = useState("aged");
  const [minDays, setMinDays] = useState(30);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [posFilter, setPosFilter] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [qty, setQty] = useState({});
  const [saving, setSaving] = useState(false);
  const [reportKey, setReportKey] = useState(0);

  const load = (forceFresh = false) => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = mode === "aged" ? { mode, min_days: minDays } : { mode };
    api
      .get("/analytics/warehouse-return-candidates", { params, timeout: 240000, forceFresh })
      .then(({ data }) => {
        if (cancelled) return;
        const rs = data?.rows || [];
        setRows(rs);
        // Seed each row's return qty from its store SOH.
        setQty((prev) => {
          const next = { ...prev };
          for (const r of rs) {
            const k = rowKey(r);
            if (next[k] == null) next[k] = String(r.soh ?? 0);
          }
          return next;
        });
        setSelected(new Set());
      })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.detail || e.message || "Failed to load candidates");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  };

  useEffect(() => {
    const cancel = load();
    return cancel;
    // eslint-disable-next-line
  }, [mode, minDays]);

  const allPos = useMemo(() => {
    const set = new Set();
    for (const r of rows) if (r.pos_location) set.add(r.pos_location);
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (posFilter && r.pos_location !== posFilter) return false;
      if (!q) return true;
      const hay = `${r.product_name || ""} ${r.sku || ""} ${r.barcode || ""} ${r.color || ""} ${r.style_name || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search, posFilter]);

  const totals = useMemo(() => ({
    count: filtered.length,
    soh: filtered.reduce((s, r) => s + (r.soh || 0), 0),
    wh: filtered.reduce((s, r) => s + (r.soh_warehouse || 0), 0),
    marked: filtered.filter((r) => r.already_marked).length,
  }), [filtered]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selected.has(rowKey(r)));

  const toggleAll = () => {
    setSelected((prev) => {
      if (allVisibleSelected) return new Set();
      const next = new Set(prev);
      for (const r of filtered) next.add(rowKey(r));
      return next;
    });
  };

  const toggleRow = (r) => {
    const k = rowKey(r);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const markSelected = async () => {
    const picked = filtered.filter((r) => selected.has(rowKey(r)));
    if (!picked.length) {
      toast.error("Select at least one item to return.");
      return;
    }
    const actions = picked.map((r) => {
      const k = rowKey(r);
      const raw = qty[k];
      const n = raw === "" || raw == null ? Number(r.soh || 0) : Number(raw);
      const units = Number.isNaN(n) || n < 0 ? Number(r.soh || 0) : Math.round(n);
      return {
        rec_type: "warehouse_return",
        rec_key: `${r.pos_location}|sku|${r.sku}`,
        status: "done",
        actual_units: units,
      };
    });
    setSaving(true);
    try {
      await api.post("/recommendations/bulk", { actions });
      const keys = new Set(picked.map(rowKey));
      setRows((prev) => prev.map((r) => (keys.has(rowKey(r)) ? { ...r, already_marked: true } : r)));
      setSelected(new Set());
      setReportKey((t) => t + 1);
      toast.success(`Marked ${picked.length} item${picked.length === 1 ? "" : "s"} for transfer to warehouse.`);
    } catch (e) {
      toast.error("Couldn't mark — " + (e?.response?.data?.detail || e.message));
    } finally {
      setSaving(false);
    }
  };

  const unmarkRow = async (r) => {
    try {
      await api.post("/recommendations/bulk", {
        actions: [{ rec_type: "warehouse_return", rec_key: `${r.pos_location}|sku|${r.sku}`, status: "pending" }],
      });
      const k = rowKey(r);
      setRows((prev) => prev.map((x) => (rowKey(x) === k ? { ...x, already_marked: false } : x)));
      setReportKey((t) => t + 1);
      toast.success("Removed from the warehouse-return list.");
    } catch (e) {
      toast.error("Couldn't unmark — " + (e?.response?.data?.detail || e.message));
    }
  };

  return (
    <div className="space-y-6">
      <div className="card-white p-5" data-testid="warehouse-returns">
        <SectionTitle
          title={
            <span className="inline-flex items-center gap-2">
              <Warehouse size={18} weight="duotone" className="text-[#1a5c38]" />
              Warehouse Returns
            </span>
          }
          subtitle="Pull store stock back to the warehouse. Pick a mode, select the items, set the units to return (defaults to store SOH), and mark them for transfer — then reconcile against the Odoo transfer document in the tracking report below."
        />

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="inline-flex rounded-md overflow-hidden border border-border" data-testid="warehouse-mode-toggle">
            <button
              onClick={() => setMode("aged")}
              data-testid="warehouse-mode-aged"
              className={`inline-flex items-center gap-1 text-[11px] font-bold px-3 py-1.5 transition-colors ${mode === "aged" ? "bg-[#1a5c38] text-white" : "bg-white text-[#1a5c38] hover:bg-[#fef3e0]"}`}
            >
              <Hourglass size={13} weight="duotone" /> Aged in store
            </button>
            <button
              onClick={() => setMode("retired")}
              data-testid="warehouse-mode-retired"
              className={`inline-flex items-center gap-1 text-[11px] font-bold px-3 py-1.5 border-l border-border transition-colors ${mode === "retired" ? "bg-[#1a5c38] text-white" : "bg-white text-[#1a5c38] hover:bg-[#fef3e0]"}`}
            >
              <Tag size={13} weight="duotone" /> Retired styles
            </button>
          </div>

          {mode === "aged" && (
            <div className="inline-flex items-center gap-2">
              <span className="eyebrow">Not sold in store for</span>
              <div className="inline-flex rounded-md overflow-hidden border border-border" data-testid="warehouse-days-toggle">
                {DAY_PRESETS.map((d) => (
                  <button
                    key={d}
                    onClick={() => setMinDays(d)}
                    data-testid={`warehouse-days-${d}`}
                    className={`text-[11px] font-bold px-3 py-1.5 transition-colors ${minDays === d ? "bg-[#1a5c38] text-white" : "bg-white text-[#1a5c38] hover:bg-[#fef3e0]"}`}
                  >
                    {d}d+
                  </button>
                ))}
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={minDays}
                  onChange={(e) => setMinDays(Math.max(0, Math.min(365, parseInt(e.target.value || "0", 10))))}
                  className="text-[11px] font-bold px-2 py-1.5 w-16 outline-none border-l border-border"
                  data-testid="warehouse-days-custom"
                  aria-label="Custom days threshold"
                />
              </div>
            </div>
          )}

          <select
            value={posFilter}
            onChange={(e) => setPosFilter(e.target.value)}
            className="input-pill text-[12px]"
            data-testid="warehouse-pos-filter"
          >
            <option value="">All POS ({allPos.length})</option>
            {allPos.map((p) => <option key={p}>{p}</option>)}
          </select>

          <input
            type="text"
            placeholder="Search product / SKU / barcode / colour / style"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-pill text-[12px] flex-1 min-w-[220px]"
            data-testid="warehouse-search"
          />

          <button
            type="button"
            onClick={() => load(true)}
            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm hover:bg-accent"
            data-testid="button-refresh-warehouse"
          >
            <ArrowsClockwise size={15} /> Refresh
          </button>
        </div>

        {loading ? (
          <Loading label="Finding warehouse-return candidates — first run can take ~60s." />
        ) : error ? (
          <ErrorBox message={error} />
        ) : filtered.length === 0 ? (
          <Empty label={mode === "aged" ? `No stock has been sitting unsold in store for ${minDays}+ days.` : "No retired-style stock is sitting in stores."} />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
              <div className="text-[12px] text-muted" data-testid="warehouse-totals">
                <strong>{fmtNum(totals.count)}</strong> SKU-store rows ·
                <strong> {fmtNum(totals.soh)}</strong> units in store ·
                <strong> {fmtNum(totals.wh)}</strong> in warehouse ·
                <strong> {fmtNum(totals.marked)}</strong> already marked
              </div>
              <button
                type="button"
                onClick={markSelected}
                disabled={saving || selected.size === 0}
                className="inline-flex items-center gap-1 rounded-md bg-[#1a5c38] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                data-testid="button-mark-warehouse-return"
              >
                <Warehouse size={15} weight="duotone" />
                {saving ? "Marking…" : `Mark ${selected.size || ""} for transfer to warehouse`}
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-sm" data-testid="warehouse-candidates-table">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase text-muted">
                    <th className="py-2 pr-2">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleAll}
                        aria-label="Select all"
                        data-testid="warehouse-select-all"
                      />
                    </th>
                    <th className="py-2 pr-3">POS</th>
                    <th className="py-2 pr-3">Product</th>
                    <th className="py-2 pr-3">Size</th>
                    <th className="py-2 pr-3">SKU</th>
                    <th className="py-2 pr-3">Barcode</th>
                    <th className="py-2 pr-3 text-right">Sold 180d</th>
                    <th className="py-2 pr-3 text-right">Store SOH</th>
                    <th className="py-2 pr-3 text-right">Wh SOH</th>
                    <th className="py-2 pr-3 text-right">Days idle</th>
                    <th className="py-2 pr-3 text-right">Return qty</th>
                    <th className="py-2 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const k = rowKey(r);
                    const checked = selected.has(k);
                    const d = r.days_since_last_sale;
                    const dCls = d >= 180 ? "pill-red" : d >= 90 ? "pill-amber" : "pill-neutral";
                    const dLabel = d >= 999 ? "Never" : `${d}d`;
                    return (
                      <tr key={k} className="border-b border-border/50" data-testid={`warehouse-row-${k}`}>
                        <td className="py-2 pr-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleRow(r)}
                            aria-label={`Select ${r.sku}`}
                            data-testid={`warehouse-select-${k}`}
                          />
                        </td>
                        <td className="py-2 pr-3"><span className="pill-neutral text-[10.5px]">{r.pos_location}</span></td>
                        <td className="py-2 pr-3">
                          <div className="max-w-[240px]">
                            <div className="font-medium text-[12px] leading-snug truncate" title={r.product_name}>
                              {r.product_name || "—"}
                            </div>
                            {r.color && <div className="text-[10px] text-muted truncate">{r.color}</div>}
                          </div>
                        </td>
                        <td className="py-2 pr-3 font-mono text-[11px]">{r.size || "—"}</td>
                        <td className="py-2 pr-3 font-mono text-[11px]">{r.sku || "—"}</td>
                        <td className="py-2 pr-3 font-mono text-[10.5px] text-muted">{r.barcode || "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(r.units_sold_180d)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums font-bold">{fmtNum(r.soh)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-muted">{fmtNum(r.soh_warehouse)}</td>
                        <td className="py-2 pr-3 text-right"><span className={dCls}>{dLabel}</span></td>
                        <td className="py-2 pr-3 text-right">
                          <input
                            type="number"
                            min={0}
                            value={qty[k] ?? ""}
                            onChange={(e) => setQty((p) => ({ ...p, [k]: e.target.value }))}
                            className="w-16 rounded-md border border-input bg-background px-2 py-1 text-right text-sm"
                            data-testid={`warehouse-qty-${k}`}
                            aria-label="Units to return"
                          />
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {r.already_marked ? (
                            <span className="inline-flex items-center gap-2">
                              <span className="pill-amber text-[10.5px]">Marked</span>
                              <button
                                type="button"
                                onClick={() => unmarkRow(r)}
                                className="text-[11px] text-muted underline hover:text-foreground"
                                data-testid={`warehouse-unmark-${k}`}
                              >
                                Unmark
                              </button>
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <ReplenishmentTransferReport
        key={reportKey}
        recType="warehouse_return"
        title="Transfer Tracking — Warehouse Returns Marked Done → Odoo"
        description="Items you mark for transfer to the warehouse land here, grouped by store and day. Enter the one Odoo transfer number that physically moved that store's returns that day — it applies to every item in the group so you can reconcile the marked items against the actual transfer document."
        noun="warehouse returns"
        exportPrefix="warehouse-returns-transfers"
      />
    </div>
  );
};

export default WarehouseReturns;
