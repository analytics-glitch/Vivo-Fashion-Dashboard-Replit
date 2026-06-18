import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import { useTableSort, SortableTh } from "@/lib/useTableSort";
import {
  MagnifyingGlass, Package, Storefront, ArrowsClockwise,
  CaretDown, Check, X as XIcon, Warehouse,
} from "@phosphor-icons/react";

/**
 * Replenish by Style / SKU.
 *
 * Two complementary replenishment views, both warehouse-gated (only ever
 * suggests sending stock that the warehouse actually holds):
 *
 *  • By Item — pick one style (all its sizes/colours) or a single SKU, then
 *    see every retail store that is understocked (store SOH below the
 *    threshold) while the warehouse still has units. Item-centric allocation.
 *  • Store Gaps — pick a store, then see items it SOLD in the window but
 *    barely stocks now while the warehouse can refill — proven local demand
 *    the store cannot currently serve.
 */

const fmtDateInput = (d) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

// ---- Searchable item picker (debounced typeahead over /replenish-options) ----
const ItemPicker = ({ mode, value, label, onPick }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get("/analytics/replenish-options", {
          params: { mode, q },
        });
        if (alive) setOpts(data?.options || []);
      } catch {
        if (alive) setOpts([]);
      } finally {
        if (alive) setLoading(false);
      }
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q, mode, open]);

  return (
    <div className="relative" ref={ref} style={{ minWidth: 320 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-left hover:bg-muted/50"
        data-testid="button-item-picker"
      >
        <span className={value ? "text-foreground truncate" : "text-muted-foreground"}>
          {label || `Search ${mode === "sku" ? "SKU / barcode" : "style"}…`}
        </span>
        {value
          ? <XIcon size={16} className="shrink-0 text-muted-foreground" onClick={(e) => { e.stopPropagation(); onPick(null); }} />
          : <CaretDown size={16} className="shrink-0 text-muted-foreground" />}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-border bg-card shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <MagnifyingGlass size={16} className="text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={mode === "sku" ? "Type SKU, barcode or name…" : "Type a style name…"}
              className="w-full bg-transparent text-sm outline-none"
              data-testid="input-item-search"
            />
          </div>
          <div className="max-h-72 overflow-auto py-1">
            {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Searching…</div>}
            {!loading && opts.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matches.</div>
            )}
            {!loading && opts.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => { onPick(o); setOpen(false); setQ(""); }}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60"
                data-testid={`option-item-${o.value}`}
              >
                <span className="truncate">
                  {o.label}
                  {mode === "sku" && o.style_name
                    ? <span className="text-muted-foreground"> · {o.style_name}</span> : null}
                </span>
                {mode === "sku"
                  ? (o.barcode ? <span className="shrink-0 text-xs text-muted-foreground">{o.barcode}</span> : null)
                  : <span className="shrink-0 text-xs text-muted-foreground">{fmtNum(o.sku_count)} SKU</span>}
                {value === o.value && <Check size={14} className="shrink-0 text-primary" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const ReplenishByItem = () => {
  const [tab, setTab] = useState("item"); // "item" | "gaps"

  // shared date window (last 90 days)
  const today = useMemo(() => new Date(), []);
  const ninety = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d;
  }, []);
  const [dateFrom, setDateFrom] = useState(fmtDateInput(ninety));
  const [dateTo, setDateTo] = useState(fmtDateInput(today));
  const [threshold, setThreshold] = useState(2);

  // ---- By Item state ----
  const [mode, setMode] = useState("style"); // "style" | "sku"
  const [item, setItem] = useState(null); // {value,label,...}
  const [itemData, setItemData] = useState(null);
  const [itemLoading, setItemLoading] = useState(false);
  const [itemError, setItemError] = useState(null);

  useEffect(() => {
    if (!item?.value) { setItemData(null); return; }
    let alive = true;
    setItemLoading(true);
    setItemError(null);
    (async () => {
      try {
        const { data } = await api.get("/analytics/replenish-by-item", {
          params: { mode, value: item.value, date_from: dateFrom, date_to: dateTo, low_threshold: threshold },
        });
        if (alive) setItemData(data);
      } catch (e) {
        if (alive) setItemError(e?.response?.data?.detail || e.message);
      } finally {
        if (alive) setItemLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [item, mode, dateFrom, dateTo, threshold]);

  // reset picked item when toggling style/sku
  useEffect(() => { setItem(null); setItemData(null); }, [mode]);

  // ---- Store Gaps state ----
  const [stores, setStores] = useState([]);
  const [store, setStore] = useState("");
  const [gapData, setGapData] = useState(null);
  const [gapLoading, setGapLoading] = useState(false);
  const [gapError, setGapError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get("/locations");
        if (!alive) return;
        const names = (Array.isArray(data) ? data : [])
          .filter((l) => (l.store_type || "").toLowerCase() === "store")
          .map((l) => l.location_name)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
        setStores(names);
      } catch { if (alive) setStores([]); }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!store) { setGapData(null); return; }
    let alive = true;
    setGapLoading(true);
    setGapError(null);
    (async () => {
      try {
        const { data } = await api.get("/analytics/replenish-gaps", {
          params: { store, date_from: dateFrom, date_to: dateTo, low_threshold: threshold },
        });
        if (alive) setGapData(data);
      } catch (e) {
        if (alive) setGapError(e?.response?.data?.detail || e.message);
      } finally {
        if (alive) setGapLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [store, dateFrom, dateTo, threshold]);

  const itemRows = itemData?.rows || [];
  const gapRows = gapData?.rows || [];
  const { sort: itemSort, toggleSort: itemToggle, sortRows: itemSortRows } = useTableSort({ key: "units_sold", dir: "desc" });
  const { sort: gapSort, toggleSort: gapToggle, sortRows: gapSortRows } = useTableSort({ key: "units_sold", dir: "desc" });
  const itemSorted = itemSortRows(itemRows);
  const gapSorted = gapSortRows(gapRows);

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Replenish by Style / SKU"
        subtitle="Warehouse-gated replenishment — find where to send a style or SKU, or fill a single store's proven demand gaps."
      />

      {/* Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab("item")}
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${tab === "item" ? "bg-primary text-primary-foreground" : "bg-card border border-border hover:bg-muted/50"}`}
          data-testid="tab-by-item"
        >
          <Package size={16} /> By Item
        </button>
        <button
          onClick={() => setTab("gaps")}
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${tab === "gaps" ? "bg-primary text-primary-foreground" : "bg-card border border-border hover:bg-muted/50"}`}
          data-testid="tab-store-gaps"
        >
          <Storefront size={16} /> Store Gaps
        </button>
      </div>

      {/* Shared controls */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3">
        {tab === "item" && (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Mode</span>
              <div className="flex rounded-lg border border-border overflow-hidden">
                {["style", "sku"].map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`px-3 py-2 text-sm ${mode === m ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted/50"}`}
                    data-testid={`mode-${m}`}
                  >
                    {m === "style" ? "Style" : "SKU"}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{mode === "sku" ? "SKU" : "Style"}</span>
              <ItemPicker mode={mode} value={item?.value} label={item?.label} onPick={setItem} />
            </div>
          </>
        )}
        {tab === "gaps" && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Store</span>
            <select
              value={store}
              onChange={(e) => setStore(e.target.value)}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm"
              style={{ minWidth: 260 }}
              data-testid="select-store"
            >
              <option value="">Select a store…</option>
              {stores.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Sold from</span>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm" data-testid="input-date-from" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Sold to</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm" data-testid="input-date-to" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Low stock under</span>
          <input type="number" min={0} value={threshold}
            onChange={(e) => setThreshold(Math.max(0, parseInt(e.target.value || "0", 10)))}
            className="w-24 rounded-lg border border-border bg-card px-3 py-2 text-sm" data-testid="input-threshold" />
        </div>
      </div>

      {/* ---- By Item view ---- */}
      {tab === "item" && (
        <div className="rounded-lg border border-border bg-card">
          {!item && <Empty label={`Pick a ${mode === "sku" ? "SKU" : "style"} above to see understocked stores.`} />}
          {item && itemLoading && <Loading label="Finding understocked stores…" />}
          {item && itemError && <ErrorBox message={itemError} />}
          {item && !itemLoading && !itemError && itemData && (
            <>
              <div className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-3 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <Warehouse size={16} className="text-muted-foreground" />
                  Warehouse SOH: <span className="font-semibold">{fmtNum(itemData.warehouse_soh)}</span>
                </span>
                <span className="text-muted-foreground">
                  {itemRows.length} understocked store{itemRows.length === 1 ? "" : "s"}
                </span>
                {itemData.warehouse_soh === 0 && (
                  <span className="text-amber-600">No warehouse stock — nothing to send.</span>
                )}
              </div>
              {itemRows.length === 0
                ? <Empty label="No understocked stores for this item (or warehouse is empty)." />
                : (
                  <div className="overflow-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="px-3 py-2"><SortableTh sortKey="pos_location" sort={itemSort} onSort={itemToggle}>Store</SortableTh></th>
                          <th className="px-3 py-2 text-right"><SortableTh sortKey="units_sold" sort={itemSort} onSort={itemToggle} numeric>Units sold</SortableTh></th>
                          <th className="px-3 py-2 text-right"><SortableTh sortKey="soh_store" sort={itemSort} onSort={itemToggle} numeric>Store SOH</SortableTh></th>
                          <th className="px-3 py-2 text-right"><SortableTh sortKey="suggested_units" sort={itemSort} onSort={itemToggle} numeric>Suggested send</SortableTh></th>
                        </tr>
                      </thead>
                      <tbody>
                        {itemSorted.map((r) => (
                          <tr key={r.pos_location} className="border-b border-border/60 hover:bg-muted/40" data-testid={`row-item-${r.pos_location}`}>
                            <td className="px-3 py-2">{r.pos_location}</td>
                            <td className="px-3 py-2 text-right">{fmtNum(r.units_sold)}</td>
                            <td className="px-3 py-2 text-right">{fmtNum(r.soh_store)}</td>
                            <td className="px-3 py-2 text-right font-semibold">{fmtNum(r.suggested_units)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </>
          )}
        </div>
      )}

      {/* ---- Store Gaps view ---- */}
      {tab === "gaps" && (
        <div className="rounded-lg border border-border bg-card">
          {!store && <Empty label="Pick a store above to see its proven demand gaps." />}
          {store && gapLoading && <Loading label="Finding demand gaps…" />}
          {store && gapError && <ErrorBox message={gapError} />}
          {store && !gapLoading && !gapError && gapData && (
            <>
              <div className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-3 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <ArrowsClockwise size={16} className="text-muted-foreground" />
                  {gapRows.length} gap{gapRows.length === 1 ? "" : "s"} for {store}
                </span>
                <span className="text-muted-foreground">Sold in window but store SOH &lt; {threshold} and warehouse can refill.</span>
              </div>
              {gapRows.length === 0
                ? <Empty label="No demand gaps — this store stocks what it sells (or warehouse is empty)." />
                : (
                  <div className="overflow-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left text-xs text-muted-foreground">
                          <th className="px-3 py-2"><SortableTh sortKey="product_name" sort={gapSort} onSort={gapToggle}>Product</SortableTh></th>
                          <th className="px-3 py-2"><SortableTh sortKey="size" sort={gapSort} onSort={gapToggle}>Size</SortableTh></th>
                          <th className="px-3 py-2 text-right"><SortableTh sortKey="units_sold" sort={gapSort} onSort={gapToggle} numeric>Units sold</SortableTh></th>
                          <th className="px-3 py-2 text-right"><SortableTh sortKey="soh_store" sort={gapSort} onSort={gapToggle} numeric>Store SOH</SortableTh></th>
                          <th className="px-3 py-2 text-right"><SortableTh sortKey="soh_wh" sort={gapSort} onSort={gapToggle} numeric>WH SOH</SortableTh></th>
                          <th className="px-3 py-2 text-right"><SortableTh sortKey="suggested_units" sort={gapSort} onSort={gapToggle} numeric>Suggested send</SortableTh></th>
                          <th className="px-3 py-2"><SortableTh sortKey="last_sale" sort={gapSort} onSort={gapToggle}>Last sale</SortableTh></th>
                        </tr>
                      </thead>
                      <tbody>
                        {gapSorted.map((r) => (
                          <tr key={r.sku} className="border-b border-border/60 hover:bg-muted/40" data-testid={`row-gap-${r.sku}`}>
                            <td className="px-3 py-2">
                              <div className="font-medium">{r.style_name || r.product_name}</div>
                              <div className="text-xs text-muted-foreground">{r.sku}{r.barcode ? ` · ${r.barcode}` : ""}</div>
                            </td>
                            <td className="px-3 py-2">{r.size || "—"}</td>
                            <td className="px-3 py-2 text-right">{fmtNum(r.units_sold)}</td>
                            <td className="px-3 py-2 text-right">{fmtNum(r.soh_store)}</td>
                            <td className="px-3 py-2 text-right">{fmtNum(r.soh_wh)}</td>
                            <td className="px-3 py-2 text-right font-semibold">{fmtNum(r.suggested_units)}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">{r.last_sale || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ReplenishByItem;
