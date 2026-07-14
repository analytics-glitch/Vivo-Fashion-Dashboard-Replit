import React, { useEffect, useMemo, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { ArrowsClockwise, DownloadSimple, Storefront, Package, Warning, CheckCircle } from "@phosphor-icons/react";

const FLAGS = ["", "Return", "Keep"];

/**
 * Excess Inventory — flags store stock that exceeds the per-brand, per-size
 * allowance table (max units a store should hold of any single SKU):
 *
 *   VIVO           S 2 · M 3 · L 3 · 1X 2 · 2X 1 · F 4 · XS/S 2 · M/L 2 · 1X/2X 1 · S/M 2 · L/1X 1
 *   SAFARI X VIVO  S 2 · M 3 · L 2 · 1X 1 · 2X 1 · F 4 · XS/S 2 · M/L 2 · 1X/2X 1
 *   STUDIO         XS 1 · S 2 · M 3 · L 2 · 1X 1 · F 4 · XS/S 2 · M/L 2 · 1X/2X 1
 *
 * Rows above allowance are flagged "Return" (excess = inventory − allowance);
 * everything else (including sizes/brands with no rule) is "Keep". The summary
 * shows per-store total inventory and total excess.
 */
const ExcessInventory = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pos, setPos] = useState("");
  const [flag, setFlag] = useState("");
  const [search, setSearch] = useState("");
  // Local overrides for the fillable fields, keyed "pos|sku" — lets typing feel
  // instant while saves happen on blur. savedKeys flashes a subtle confirm.
  const [edits, setEdits] = useState({});
  const [saveErr, setSaveErr] = useState(null);

  const load = (forceFresh = false) => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = {};
    if (pos) params.pos = pos;
    if (flag) params.flag = flag;
    api
      .get("/analytics/excess-inventory", { params, timeout: 240000, forceFresh })
      .then(({ data }) => { if (!cancelled) setData(data); })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.detail || e.message || "Failed to load excess inventory");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  };

  useEffect(() => {
    const cancel = load();
    return cancel;
    // eslint-disable-next-line
  }, [pos, flag]);

  const rows = data?.rows || [];
  const summary = data?.summary || [];
  const totals = data?.totals || {};
  const posOptions = data?.pos_locations || [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay = `${r.product_name || ""} ${r.sku || ""} ${r.barcode || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search]);

  const rowKey = (r) => `${r.pos_location}|${r.sku}`;
  const fieldVal = (r, field) => {
    const e = edits[rowKey(r)];
    if (e && field in e) return e[field];
    const v = r[field];
    return v == null ? "" : String(v);
  };
  const setField = (r, field, value) => {
    setEdits((prev) => ({ ...prev, [rowKey(r)]: { ...prev[rowKey(r)], [field]: value } }));
  };
  const saveRow = (r) => {
    const qty = fieldVal(r, "qty_returned").trim();
    const ref = fieldVal(r, "transfer_ref").trim();
    const origQty = r.qty_returned == null ? "" : String(r.qty_returned);
    const origRef = r.transfer_ref == null ? "" : String(r.transfer_ref);
    if (qty === origQty.trim() && ref === origRef.trim()) return;
    setSaveErr(null);
    api
      .post("/analytics/excess-inventory/action", {
        pos_location: r.pos_location, sku: r.sku,
        qty_returned: qty, transfer_ref: ref,
      })
      .then(({ data: saved }) => {
        // Fold the confirmed values back into the loaded rows so a later blur
        // compares against what the server actually holds.
        setData((prev) => prev ? {
          ...prev,
          rows: prev.rows.map((row) =>
            row.pos_location === r.pos_location && row.sku === r.sku
              ? { ...row, qty_returned: saved.qty_returned, transfer_ref: saved.transfer_ref }
              : row),
        } : prev);
      })
      .catch((e) => {
        setSaveErr(e?.response?.data?.detail || e.message || "Failed to save");
      });
  };

  const toggleDone = (r) => {
    const next = !r.done;
    setSaveErr(null);
    // Optimistic: flip the row + adjust the per-POS summary counts instantly.
    const adjust = (prev) => prev ? {
      ...prev,
      rows: prev.rows.map((row) =>
        row.pos_location === r.pos_location && row.sku === r.sku
          ? { ...row, done: next } : row),
      summary: (prev.summary || []).map((s) =>
        s.pos_location === r.pos_location && r.excess > 0
          ? { ...s,
              done_units: (s.done_units || 0) + (next ? r.excess : -r.excess),
              done_skus: (s.done_skus || 0) + (next ? 1 : -1) }
          : s),
      totals: prev.totals && r.excess > 0 ? {
        ...prev.totals,
        done_units: (prev.totals.done_units || 0) + (next ? r.excess : -r.excess),
        done_skus: (prev.totals.done_skus || 0) + (next ? 1 : -1),
      } : prev.totals,
    } : prev;
    setData(adjust);
    api
      .post("/analytics/excess-inventory/done", {
        pos_location: r.pos_location, sku: r.sku, done: next,
      })
      .catch((e) => {
        // Roll back by reloading the authoritative server state.
        load();
        setSaveErr(e?.response?.data?.detail || e.message || "Failed to update done mark");
      });
  };

  const exportCsv = () => {
    const header = ["Store", "Product Title", "SKU", "Barcode", "Size", "Brand Group", "Inventory", "Allowed", "Excess", "Flag", "Quantity Returned", "Transfer Number", "Done"];
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(",")];
    for (const r of filtered) {
      lines.push([
        r.pos_location, r.product_name, r.sku, r.barcode, r.size,
        r.brand_group, r.inventory, r.allowed ?? "", r.excess, r.flag,
        fieldVal(r, "qty_returned"), fieldVal(r, "transfer_ref"),
        r.done ? "Yes" : "",
      ].map(esc).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `excess-inventory-${pos || "all"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5" data-testid="excess-inventory">
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <SectionTitle
          title="Excess Inventory"
          subtitle="Store stock above the per-brand size allowance — flagged Return; everything else Keep"
        />
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => load(true)}
            data-testid="button-refresh"
          >
            <ArrowsClockwise size={15} /> Refresh
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={exportCsv}
            disabled={!filtered.length}
            data-testid="button-export-csv"
          >
            <DownloadSimple size={15} /> Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card-white p-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-600">
          POS Location{" "}
          <select
            className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={pos}
            onChange={(e) => setPos(e.target.value)}
            data-testid="select-pos"
          >
            <option value="">All stores</option>
            {posOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="text-sm text-slate-600">
          Flag{" "}
          <select
            className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={flag}
            onChange={(e) => setFlag(e.target.value)}
            data-testid="select-flag"
          >
            {FLAGS.map((f) => (
              <option key={f || "all"} value={f}>{f || "All flags"}</option>
            ))}
          </select>
        </label>
        <input
          className="flex-1 min-w-[200px] rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          placeholder="Search product, SKU or barcode…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="input-search"
        />
      </div>

      {saveErr && <ErrorBox message={`Save failed: ${saveErr}`} />}

      {loading ? (
        <Loading label="Computing excess inventory…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide"><Storefront size={14} /> POS Locations</div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-pos-count">{fmtNum(summary.length)}</div>
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide"><Package size={14} /> Total Inventory</div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-total-inventory">{fmtNum(totals.total_inventory || 0)}</div>
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide"><Warning size={14} /> Excess Inventory</div>
              <div className="mt-1 text-2xl font-semibold text-amber-600" data-testid="text-excess-inventory">{fmtNum(totals.excess_inventory || 0)}</div>
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide"><Warning size={14} /> SKUs to Return</div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-return-skus">{fmtNum(totals.return_skus || 0)}</div>
            </div>
          </div>

          {/* Per-POS summary (only useful when viewing all stores) */}
          {!pos && summary.length > 1 && (
            <div className="card-white p-5">
              <SectionTitle title="Summary by POS" subtitle="Total vs excess inventory per store (excess = sum of every SKU's units above allowance)" />
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                      <th className="py-2 pr-4">POS Location</th>
                      <th className="py-2 pr-4 text-right">SKUs</th>
                      <th className="py-2 pr-4 text-right">Total Inventory</th>
                      <th className="py-2 pr-4 text-right">Excess Inventory</th>
                      <th className="py-2 pr-4 text-right">SKUs to Return</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map((s) => (
                      <tr key={s.pos_location} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setPos(s.pos_location)} data-testid={`row-summary-${s.pos_location}`}>
                        <td className="py-1.5 pr-4 font-medium text-slate-700">{s.pos_location}</td>
                        <td className="py-1.5 pr-4 text-right">{fmtNum(s.skus)}</td>
                        <td className="py-1.5 pr-4 text-right">{fmtNum(s.total_inventory)}</td>
                        <td className={"py-1.5 pr-4 text-right font-semibold " + (s.excess_inventory > 0 ? "text-amber-600" : "text-slate-500")}>{fmtNum(s.excess_inventory)}</td>
                        <td className="py-1.5 pr-4 text-right">{fmtNum(s.return_skus)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Detail rows */}
          <div className="card-white p-5">
            <SectionTitle
              title={pos ? `Items — ${pos}` : "Items"}
              subtitle={`${fmtNum(filtered.length)} rows${data?.truncated ? ` (showing first ${fmtNum(rows.length)} of ${fmtNum(data.row_count)} — narrow with the filters)` : ""}`}
            />
            {!filtered.length ? (
              <Empty label="No items match the selected filters." />
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                      <th className="py-2 pr-4">Store</th>
                      <th className="py-2 pr-4">Product Title</th>
                      <th className="py-2 pr-4">SKU</th>
                      <th className="py-2 pr-4">Barcode</th>
                      <th className="py-2 pr-4">Size</th>
                      <th className="py-2 pr-4">Brand</th>
                      <th className="py-2 pr-4 text-right">Inventory</th>
                      <th className="py-2 pr-4 text-right">Allowed</th>
                      <th className="py-2 pr-4 text-right">Excess</th>
                      <th className="py-2 pr-4">Flag</th>
                      <th className="py-2 pr-4">Qty Returned</th>
                      <th className="py-2 pr-4">Transfer No.</th>
                      <th className="py-2 pr-4">Done</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={`${r.pos_location}|${r.sku}`} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`row-item-${r.pos_location}-${r.sku}`}>
                        <td className="py-1.5 pr-4 whitespace-nowrap text-slate-600">{r.pos_location}</td>
                        <td className="py-1.5 pr-4 font-medium text-slate-700">{r.product_name || "—"}</td>
                        <td className="py-1.5 pr-4 whitespace-nowrap">{r.sku}</td>
                        <td className="py-1.5 pr-4 whitespace-nowrap text-slate-500">{r.barcode || "—"}</td>
                        <td className="py-1.5 pr-4">{r.size || "—"}</td>
                        <td className="py-1.5 pr-4 whitespace-nowrap text-slate-500">{r.brand_group}</td>
                        <td className="py-1.5 pr-4 text-right">{fmtNum(r.inventory)}</td>
                        <td className="py-1.5 pr-4 text-right text-slate-500">{r.allowed ?? "—"}</td>
                        <td className={"py-1.5 pr-4 text-right font-semibold " + (r.excess > 0 ? "text-amber-600" : "text-slate-400")}>{r.excess > 0 ? fmtNum(r.excess) : "0"}</td>
                        <td className="py-1.5 pr-4">
                          <span className={
                            "inline-flex rounded-full px-2 py-0.5 text-xs font-semibold " +
                            (r.flag === "Return" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700")
                          }>
                            {r.flag}
                          </span>
                        </td>
                        <td className="py-1.5 pr-4">
                          <input
                            type="number"
                            min="0"
                            className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm text-right"
                            placeholder="—"
                            value={fieldVal(r, "qty_returned")}
                            onChange={(e) => setField(r, "qty_returned", e.target.value)}
                            onBlur={() => saveRow(r)}
                            data-testid={`input-qty-returned-${r.pos_location}-${r.sku}`}
                          />
                        </td>
                        <td className="py-1.5 pr-4">
                          <input
                            type="text"
                            className="w-32 rounded-md border border-slate-300 px-2 py-1 text-sm"
                            placeholder="To be filled"
                            value={fieldVal(r, "transfer_ref")}
                            onChange={(e) => setField(r, "transfer_ref", e.target.value)}
                            onBlur={() => saveRow(r)}
                            data-testid={`input-transfer-ref-${r.pos_location}-${r.sku}`}
                          />
                        </td>
                        <td className="py-1.5 pr-4">
                          <button
                            className={
                              "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold " +
                              (r.done
                                ? "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50")
                            }
                            onClick={() => toggleDone(r)}
                            title={r.done ? "Marked done — click to undo" : "Mark this row as done"}
                            data-testid={`button-done-${r.pos_location}-${r.sku}`}
                          >
                            <CheckCircle size={13} weight={r.done ? "fill" : "regular"} />
                            {r.done ? "Done" : "Mark done"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Returns progress per POS (below the list, per business request):
              Expected returns = excess units flagged Return; Done = excess
              units on rows marked Done. */}
          {summary.length > 0 && (
            <div className="card-white p-5">
              <SectionTitle
                title="Returns Progress by POS"
                subtitle="Expected returns (excess units) vs units on rows marked Done"
              />
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                      <th className="py-2 pr-4">POS Location</th>
                      <th className="py-2 pr-4 text-right">Expected Returns</th>
                      <th className="py-2 pr-4 text-right">Done</th>
                      <th className="py-2 pr-4 text-right">Remaining</th>
                      <th className="py-2 pr-4 text-right">SKUs Done</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map((s) => (
                      <tr key={s.pos_location} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`row-progress-${s.pos_location}`}>
                        <td className="py-1.5 pr-4 font-medium text-slate-700">{s.pos_location}</td>
                        <td className={"py-1.5 pr-4 text-right font-semibold " + (s.excess_inventory > 0 ? "text-amber-600" : "text-slate-400")}>{fmtNum(s.excess_inventory)}</td>
                        <td className={"py-1.5 pr-4 text-right font-semibold " + ((s.done_units || 0) > 0 ? "text-emerald-600" : "text-slate-400")}>{fmtNum(s.done_units || 0)}</td>
                        <td className="py-1.5 pr-4 text-right">{fmtNum(Math.max(0, s.excess_inventory - (s.done_units || 0)))}</td>
                        <td className="py-1.5 pr-4 text-right text-slate-500">{fmtNum(s.done_skus || 0)} / {fmtNum(s.return_skus || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-300 font-semibold text-slate-800">
                      <td className="py-2 pr-4">Total</td>
                      <td className="py-2 pr-4 text-right">{fmtNum(totals.excess_inventory || 0)}</td>
                      <td className="py-2 pr-4 text-right">{fmtNum(totals.done_units || 0)}</td>
                      <td className="py-2 pr-4 text-right">{fmtNum(Math.max(0, (totals.excess_inventory || 0) - (totals.done_units || 0)))}</td>
                      <td className="py-2 pr-4 text-right">{fmtNum(totals.done_skus || 0)} / {fmtNum(totals.return_skus || 0)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ExcessInventory;
