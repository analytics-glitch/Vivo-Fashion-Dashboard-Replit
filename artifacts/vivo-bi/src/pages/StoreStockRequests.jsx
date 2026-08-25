import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { api, fmtNum } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import { useTableSort, SortableTh } from "@/lib/useTableSort";
import {
  MagnifyingGlass, Storefront, X as XIcon, Clock,
  ListDashes, Plus, WarningCircle, FileText, DownloadSimple
} from "@phosphor-icons/react";

const fmtDateInput = (d) => {
  if (!d) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const DATE_RANGES = [
  { label: "Last 7 Days", days: 7 },
  { label: "Last 14 Days", days: 14 },
  { label: "Last 30 Days", days: 30 },
  { label: "Last 90 Days", days: 90 },
];

const requestErrorMessage = (error, fallback) => {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (detail?.message) return detail.message;
  return error?.message || fallback;
};

export default function StoreStockRequests() {
  const { user } = useAuth();
  const role = String(user?.role || "").toLowerCase();
  const canCreateForRole = ["store_manager", "warehouse", "admin"].includes(role);
  const canViewFulfilmentReport = [
    "store_manager", "warehouse", "admin", "retail", "leadership", "smt"
  ].includes(role);
  const [tab, setTab] = useState(() => canCreateForRole ? "catalog" : "queue");
  const appliedRoleDefault = useRef(false);

  useEffect(() => {
    if (!role || appliedRoleDefault.current) return;
    setTab(canCreateForRole ? "catalog" : "queue");
    appliedRoleDefault.current = true;
  }, [role, canCreateForRole]);

  return (
    <div className="space-y-4 md:space-y-5">
      <SectionTitle
        title="Store Stock Requests"
        subtitle="Request stock from the warehouse based on store sales and available inventory."
      />
      
      {/* Tabs */}
      <div className="flex gap-2 border-b border-border overflow-x-auto whitespace-nowrap hide-scrollbar">
        {canCreateForRole && (
          <button
            onClick={() => setTab("catalog")}
            className={`flex items-center gap-2 px-3 md:px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === "catalog" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            data-testid="tab-catalog"
          >
            <Plus size={16} /> New Request
          </button>
        )}
        <button
          onClick={() => setTab("queue")}
          className={`flex items-center gap-2 px-3 md:px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === "queue" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          data-testid="tab-queue"
        >
          <ListDashes size={16} /> Request Queue
        </button>
        {canViewFulfilmentReport && (
          <button
            onClick={() => setTab("report")}
            className={`flex items-center gap-2 px-3 md:px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === "report" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            data-testid="tab-fulfilment-report"
          >
            <FileText size={16} /> Fulfilment Report
          </button>
        )}
      </div>

      {tab === "catalog" && <CatalogView />}
      {tab === "queue" && <QueueView />}
      {tab === "report" && canViewFulfilmentReport && <FulfilmentReportView />}
    </div>
  );
}

function CatalogView() {
  const [dateRange, setDateRange] = useState(DATE_RANGES[1]);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [store, setStore] = useState("");

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stores, setStores] = useState([]);

  const [draftLines, setDraftLines] = useState({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let alive = true;
    api.get("/locations").then(res => {
      if (!alive) return;
      const names = (Array.isArray(res.data) ? res.data : [])
        .filter(l => (l.store_type || "").toLowerCase() === "store")
        .map(l => l.location_name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      setStores(names);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const effectiveFrom = useMemo(() => {
    if (dateRange) {
      const d = new Date();
      d.setDate(d.getDate() - dateRange.days);
      return fmtDateInput(d);
    }
    return customFrom;
  }, [dateRange, customFrom]);

  const effectiveTo = useMemo(() => {
    if (dateRange) return fmtDateInput(new Date());
    return customTo;
  }, [dateRange, customTo]);

  const fetchCatalog = useCallback(async () => {
    if (!effectiveFrom || !effectiveTo) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get("/store-stock-requests/catalog", {
        params: {
          date_from: effectiveFrom,
          date_to: effectiveTo,
          q: debouncedQ || undefined,
          store: store || undefined
        }
      });
      setData(res.data);
      // Auto-select store for restricted users if provided in response
      if (!store && res.data.store && !res.data.can_manage) {
        setStore(res.data.store);
      }
    } catch (e) {
      setError(requestErrorMessage(e, "Could not load the request catalog."));
    } finally {
      setLoading(false);
    }
  }, [effectiveFrom, effectiveTo, debouncedQ, store]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  const { sort, sorts, toggleSort, sortRows } = useTableSort({ key: "units_sold", dir: "desc" });
  const sortedRows = sortRows(data?.rows || []);

  const totalDraftItems = Object.values(draftLines).reduce((a, b) => a + (Number(b) || 0), 0);
  const totalDraftSkus = Object.keys(draftLines).filter(k => draftLines[k] > 0).length;

  const handleSubmit = async () => {
    const lines = Object.entries(draftLines)
      .filter(([_, qty]) => Number(qty) > 0)
      .map(([sku, qty]) => ({ sku, quantity: Number(qty) }));
    
    if (!lines.length) return toast.error("No items requested");
    if (!data?.store) return toast.error("No store selected");

    setSubmitting(true);
    try {
      await api.post("/store-stock-requests/requests", {
        store: data.store,
        date_from: effectiveFrom,
        date_to: effectiveTo,
        lines,
        idempotency_key: crypto.randomUUID()
      });
      toast.success("Request submitted successfully");
      setDraftLines({});
      fetchCatalog();
    } catch (e) {
      if (e?.response?.status === 409) {
        toast.error("Stock changed: " + requestErrorMessage(e, "Please refresh and try again."));
        fetchCatalog();
      } else {
        toast.error("Failed to submit: " + requestErrorMessage(e, "Please try again."));
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!data && loading) return <div className="py-10"><Loading label="Loading catalog..." /></div>;
  if (error) return (
    <div className="space-y-3">
      <ErrorBox message={error} />
      <button onClick={fetchCatalog} className="btn-primary">Retry</button>
    </div>
  );

  const missingHomeStore = data && !data.can_manage && !data.store && !store;
  if (missingHomeStore) {
    return (
      <div className="card p-8 text-center max-w-md mx-auto mt-10">
        <WarningCircle size={48} className="mx-auto text-amber-500 mb-4" />
        <h3 className="text-lg font-bold mb-2">No Home Store Assigned</h3>
        <p className="text-muted-foreground text-sm">
          You must have a home store assigned to your profile to request stock. Please contact an administrator.
        </p>
      </div>
    );
  }

  const availableStores = data?.stores?.length ? data.stores : stores;
  const showStoreDropdown = data?.can_manage || (data?.can_request && availableStores.length > 1);

  return (
    <div className="space-y-4 pb-24">
      {/* Controls */}
      <div className="card p-3 flex flex-col md:flex-row md:flex-wrap gap-3">
        {showStoreDropdown && (
          <div className="flex flex-col gap-1.5 w-full md:w-48 shrink-0">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Store</label>
            <select 
              value={store} 
              onChange={e => setStore(e.target.value)}
              className="input-pill w-full h-9"
              data-testid="filter-catalog-store"
            >
              <option value="">{data?.can_manage ? "Select a store..." : "My Store"}</option>
              {availableStores.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Search</label>
          <div className="relative">
            <MagnifyingGlass size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input 
              type="text"
              placeholder="Search style, product, barcode, SKU..."
              value={q}
              onChange={e => setQ(e.target.value)}
              className="input-pill w-full h-9 pl-8"
              data-testid="input-catalog-search"
            />
            {q && <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2"><XIcon size={14} className="text-muted-foreground hover:text-foreground" /></button>}
          </div>
        </div>

        <div className="flex flex-col gap-1.5 w-full md:w-auto">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Sales Period</label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={dateRange?.days || "custom"}
              onChange={(e) => {
                if (e.target.value === "custom") {
                  setDateRange(null);
                  setCustomFrom(effectiveFrom);
                  setCustomTo(effectiveTo);
                } else {
                  setDateRange(DATE_RANGES.find(r => r.days === Number(e.target.value)));
                }
              }}
              className="input-pill h-9 w-full sm:w-auto"
              data-testid="filter-date-preset"
            >
              {DATE_RANGES.map(r => <option key={r.days} value={r.days}>{r.label}</option>)}
              <option value="custom">Custom Range</option>
            </select>
            
            {!dateRange && (
              <div className="flex items-center gap-1 w-full sm:w-auto">
                <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="input-pill h-9 flex-1" data-testid="input-date-from" />
                <span className="text-muted-foreground px-1 text-sm">to</span>
                <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="input-pill h-9 flex-1" data-testid="input-date-to" />
              </div>
            )}
          </div>
        </div>
      </div>

      {data?.can_manage && !data?.store && !loading && (
        <div className="card p-6 flex flex-col items-center justify-center text-center text-muted-foreground">
          <Storefront size={32} className="mb-2 opacity-50" />
          <p>Please select a store to view its request catalog and inventory gaps.</p>
        </div>
      )}

      {/* Desktop Table */}
      {data?.store && (
        <div className="card overflow-hidden hidden md:block">
          <div className="overflow-x-auto">
            <table className="data w-full text-sm">
              <thead>
                <tr>
                  <SortableTh sortKey="product_name" sort={sort} sorts={sorts} onSort={toggleSort}>Product</SortableTh>
                  <SortableTh sortKey="barcode" sort={sort} sorts={sorts} onSort={toggleSort}>Barcode</SortableTh>
                  <SortableTh sortKey="units_sold" sort={sort} sorts={sorts} onSort={toggleSort} className="text-right">Sold</SortableTh>
                  <SortableTh sortKey="soh_store" sort={sort} sorts={sorts} onSort={toggleSort} className="text-right">SOH Store</SortableTh>
                  <SortableTh sortKey="soh_warehouse" sort={sort} sorts={sorts} onSort={toggleSort} className="text-right">SOH WH</SortableTh>
                  <SortableTh sortKey="reserved_store_requests" sort={sort} sorts={sorts} onSort={toggleSort} className="text-right">Rsvd (Store)</SortableTh>
                  <SortableTh sortKey="reserved_ibt" sort={sort} sorts={sorts} onSort={toggleSort} className="text-right">Rsvd (IBT)</SortableTh>
                  <SortableTh sortKey="available_to_request" sort={sort} sorts={sorts} onSort={toggleSort} className="text-right">Available</SortableTh>
                  <th className="text-right min-w-[140px]">Request Qty</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center py-8 text-muted-foreground">No matching products found.</td>
                  </tr>
                ) : sortedRows.map(r => (
                  <tr key={r.sku} className={r.soh_store === 0 ? "bg-rose-50/30" : ""} data-testid={`catalog-row-${r.sku}`}>
                    <td className="max-w-[200px] truncate" title={r.product_name}>
                      <div className="font-medium">{r.style_name || r.product_name}</div>
                      <div className="text-xs text-muted-foreground">{r.category} · {r.size} {r.color_print ? `· ${r.color_print.trim()}` : ""}</div>
                    </td>
                    <td className="font-mono text-xs text-muted-foreground">{r.barcode}</td>
                    <td className="text-right font-medium">{fmtNum(r.units_sold)}</td>
                    <td className={`text-right ${r.soh_store === 0 ? "text-danger font-bold" : ""}`}>{fmtNum(r.soh_store)}</td>
                    <td className="text-right">{fmtNum(r.soh_warehouse)}</td>
                    <td className="text-right text-muted-foreground" data-testid={`reserved-store-${r.sku}`}>{fmtNum(r.reserved_store_requests)}</td>
                    <td className="text-right text-muted-foreground" data-testid={`reserved-ibt-${r.sku}`}>{fmtNum(r.reserved_ibt)}</td>
                    <td className="text-right" data-testid={`available-${r.sku}`}>
                      <span className="inline-flex items-center bg-emerald-100 text-emerald-900 font-bold px-2 py-0.5 rounded-full text-xs">
                        {fmtNum(r.available_to_request)}
                      </span>
                    </td>
                    <td className="text-right">
                      <div className="flex flex-col items-end gap-1">
                        <input
                          type="number"
                          min={0}
                          max={r.available_to_request}
                          value={draftLines[r.sku] || ""}
                          onChange={e => {
                            const v = parseInt(e.target.value, 10);
                            if (isNaN(v) || v <= 0) {
                              const newDraft = { ...draftLines };
                              delete newDraft[r.sku];
                              setDraftLines(newDraft);
                            } else if (v <= r.available_to_request) {
                              setDraftLines({ ...draftLines, [r.sku]: v });
                            } else {
                              toast.error(`Cannot request more than available (${r.available_to_request})`);
                              setDraftLines({ ...draftLines, [r.sku]: r.available_to_request });
                            }
                          }}
                          className="w-20 h-8 px-2 text-right tabular-nums border border-border rounded bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                          disabled={!data?.can_request || r.available_to_request === 0}
                          data-testid={`input-qty-${r.sku}`}
                          placeholder="0"
                        />
                        {r.existing_open_qty > 0 && (
                          <span className="text-[10px] text-amber-600 font-medium">
                            +{r.existing_open_qty} existing hold
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Mobile Cards */}
      {data?.store && (
        <div className="md:hidden flex flex-col gap-3">
          {sortedRows.length === 0 ? (
            <div className="card p-6 text-center text-muted-foreground text-sm">No matching products found.</div>
          ) : sortedRows.map(r => (
            <div key={r.sku} className={`card p-3 flex flex-col gap-2 ${r.soh_store === 0 ? 'bg-rose-50/50' : ''}`} data-testid={`catalog-card-${r.sku}`}>
              <div className="flex justify-between items-start gap-2">
                <div>
                  <div className="font-semibold text-sm leading-tight">{r.style_name || r.product_name}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{r.category} · {r.size} {r.color_print ? `· ${r.color_print.trim()}` : ""}</div>
                  <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{r.barcode}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sold</div>
                  <div className="font-bold">{fmtNum(r.units_sold)}</div>
                </div>
              </div>
              
              <div className="grid grid-cols-4 gap-2 text-center text-xs py-2 border-y border-border/50 bg-background/50 rounded">
                <div>
                  <div className="text-muted-foreground mb-0.5">SOH Store</div>
                  <div className={`font-semibold ${r.soh_store === 0 ? "text-danger" : ""}`}>{fmtNum(r.soh_store)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-0.5">SOH WH</div>
                  <div className="font-semibold">{fmtNum(r.soh_warehouse)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-0.5">Rsvd</div>
                  <div className="font-semibold text-muted-foreground" data-testid={`card-reserved-${r.sku}`}>
                    {fmtNum((r.reserved_store_requests || 0) + (r.reserved_ibt || 0))}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-0.5">Available</div>
                  <div className="font-bold text-emerald-700" data-testid={`card-available-${r.sku}`}>{fmtNum(r.available_to_request)}</div>
                </div>
              </div>

              <div className="flex justify-between items-center mt-1">
                <div className="text-xs text-amber-600 font-medium w-1/2">
                  {r.existing_open_qty > 0 && `+${r.existing_open_qty} existing hold`}
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-muted-foreground">Req:</label>
                  <input
                    type="number"
                    min={0}
                    max={r.available_to_request}
                    value={draftLines[r.sku] || ""}
                    onChange={e => {
                      const v = parseInt(e.target.value, 10);
                      if (isNaN(v) || v <= 0) {
                        const newDraft = { ...draftLines };
                        delete newDraft[r.sku];
                        setDraftLines(newDraft);
                      } else if (v <= r.available_to_request) {
                        setDraftLines({ ...draftLines, [r.sku]: v });
                      } else {
                        toast.error(`Max available: ${r.available_to_request}`);
                        setDraftLines({ ...draftLines, [r.sku]: r.available_to_request });
                      }
                    }}
                    className="w-16 h-8 px-2 text-right tabular-nums border border-border rounded bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50 text-sm"
                    disabled={!data?.can_request || r.available_to_request === 0}
                    data-testid={`card-input-qty-${r.sku}`}
                    placeholder="0"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Summary Footer */}
      {totalDraftSkus > 0 && (
        <div className="fixed bottom-4 md:bottom-6 left-1/2 -translate-x-1/2 w-[calc(100%-1rem)] md:w-[90%] max-w-2xl bg-card border border-border shadow-[0_-4px_24px_-8px_rgba(0,0,0,0.15)] rounded-xl md:rounded-2xl p-3 md:p-4 flex flex-col sm:flex-row items-center justify-between gap-3 z-50 animate-in slide-in-from-bottom-10 fade-in">
          <div className="text-center sm:text-left w-full sm:w-auto">
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Draft Request</div>
            <div className="font-medium text-sm md:text-base whitespace-nowrap">
              <span className="text-primary font-bold">{totalDraftItems}</span> units across <span className="text-primary font-bold">{totalDraftSkus}</span> styles
            </div>
          </div>
          <div className="flex gap-2 w-full sm:w-auto">
            <button 
              onClick={() => setDraftLines({})} 
              className="btn-ghost flex-1 sm:flex-none text-sm h-10"
            >
              Clear
            </button>
            <button 
              onClick={handleSubmit} 
              disabled={submitting || !data?.can_request}
              className="btn-primary flex-1 sm:flex-none flex items-center justify-center gap-2 text-sm h-10"
              data-testid="button-submit-request"
            >
              {submitting ? "Submitting..." : "Submit"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function QueueView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  const [storeFilter, setStoreFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("open");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const fetchQueue = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    setError(null);
    try {
      const res = await api.get("/store-stock-requests/requests", {
        params: {
          store: storeFilter || undefined,
          status: statusFilter === "all" ? undefined : statusFilter,
          q: debouncedQ || undefined
        }
      });
      setData(res.data);
      if (!storeFilter && res.data.scoped_store) {
        setStoreFilter(res.data.scoped_store);
      }
    } catch (e) {
      if (!isSilent) setError(requestErrorMessage(e, "Could not load the request queue."));
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, [storeFilter, statusFilter, debouncedQ]);

  useEffect(() => {
    fetchQueue(false);
    const id = setInterval(() => fetchQueue(true), 30000);
    return () => clearInterval(id);
  }, [fetchQueue]);

  const handleLineAction = async (lineId, action, params = {}) => {
    try {
      const res = await api.patch(`/store-stock-requests/lines/${lineId}`, {
        action,
        ...params
      });
      const result = res.data || {};
      const nextStatus = String(result.status || "").toLowerCase();
      const actionLabel = action === "picking"
        ? "Moved to Picking"
        : action === "fulfill"
          ? "Fulfilled"
          : "Cancelled";

      // Patch first so the person who performed the action sees the changed
      // line immediately. The follow-up read keeps other browser sessions and
      // mixed request headers in sync with the server.
      setData(current => {
        if (!current || !nextStatus) return current;
        return {
          ...current,
          requests: (current.requests || []).map(request => ({
            ...request,
            status: request.lines?.some(line => line.id === lineId)
              ? (result.request_status || request.status)
              : request.status,
            lines: (request.lines || []).map(line => line.id === lineId
              ? {
                  ...line,
                  status: nextStatus,
                  line_status: nextStatus,
                  actual_units: result.actual_units ?? line.actual_units,
                  transfer_ref: result.transfer_ref ?? line.transfer_ref,
                  fulfilled_at: nextStatus === "fulfilled"
                    ? (result.updated_at || line.fulfilled_at)
                    : line.fulfilled_at
                }
              : line)
          }))
        };
      });
      toast.success(actionLabel);

      // An OPEN filter should not make a successful "Start Picking" look like
      // a disappearing/no-op action. Move to the new lifecycle view, then
      // refetch it; leave All Statuses in place when it is already selected.
      if (nextStatus && statusFilter !== "all" && statusFilter !== nextStatus) {
        setStatusFilter(nextStatus);
      } else {
        fetchQueue(true);
      }
    } catch (e) {
      toast.error(`Failed to apply action: ` + requestErrorMessage(e, "Please refresh and try again."));
    }
  };

  if (!data && loading) return <div className="py-10"><Loading label="Loading queue..." /></div>;
  if (error) return (
    <div className="space-y-3">
      <ErrorBox message={error} />
      <button onClick={() => fetchQueue()} className="btn-primary">Retry</button>
    </div>
  );

  const requests = data?.requests || [];

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="card p-3 flex flex-col md:flex-row md:flex-wrap gap-3">
        {data?.can_manage && (
          <div className="flex flex-col gap-1.5 w-full md:w-48 shrink-0">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Store</label>
            <select 
              value={storeFilter} 
              onChange={e => setStoreFilter(e.target.value)}
              className="input-pill w-full h-9"
              data-testid="filter-queue-store"
            >
              <option value="">All Stores</option>
              {data?.stores?.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Search</label>
          <div className="relative">
            <MagnifyingGlass size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input 
              type="text"
              placeholder="Search ref, product..."
              value={q}
              onChange={e => setQ(e.target.value)}
              className="input-pill w-full h-9 pl-8"
              data-testid="input-queue-search"
            />
            {q && <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2"><XIcon size={14} className="text-muted-foreground hover:text-foreground" /></button>}
          </div>
        </div>

        <div className="flex flex-col gap-1.5 w-full md:w-48">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Status</label>
          <select 
            value={statusFilter} 
            onChange={e => setStatusFilter(e.target.value)}
            className="input-pill w-full h-9"
            data-testid="filter-queue-status"
          >
            <option value="open">Open (To Pick)</option>
            <option value="picking">Picking in Progress</option>
            <option value="fulfilled">Fulfilled</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired</option>
            <option value="all">All Statuses</option>
          </select>
        </div>
      </div>

      {requests.length === 0 ? (
        <Empty label="No requests found" />
      ) : (
        <div className="space-y-6">
          {requests.map(req => (
            <RequestCard 
              key={req.id} 
              request={req} 
              canManage={data?.can_manage} 
              canRequest={data?.can_request}
              filteredStatus={statusFilter}
              onLineAction={handleLineAction} 
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FulfilmentReportView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [storeFilter, setStoreFilter] = useState("");
  const [dateRange, setDateRange] = useState(DATE_RANGES[2]);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const effectiveFrom = useMemo(() => {
    if (!dateRange) return customFrom;
    const d = new Date();
    d.setDate(d.getDate() - dateRange.days);
    return fmtDateInput(d);
  }, [dateRange, customFrom]);

  const effectiveTo = useMemo(() => dateRange ? fmtDateInput(new Date()) : customTo,
    [dateRange, customTo]);

  const fetchReport = useCallback(async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    setError(null);
    try {
      const res = await api.get("/store-stock-requests/fulfilment-report", {
        params: {
          store: storeFilter || undefined,
          date_from: effectiveFrom || undefined,
          date_to: effectiveTo || undefined,
          q: debouncedQ || undefined
        }
      });
      setData(res.data);
      if (!storeFilter && res.data.scoped_store) setStoreFilter(res.data.scoped_store);
    } catch (e) {
      if (!isSilent) setError(requestErrorMessage(e, "Could not load the fulfilment report."));
    } finally {
      if (!isSilent) setLoading(false);
    }
  }, [storeFilter, effectiveFrom, effectiveTo, debouncedQ]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const rows = data?.rows || [];
  const totalUnits = rows.reduce((sum, row) => sum + (Number(row.actual_units) || 0), 0);
  const storeCount = new Set(rows.map(row => row.store).filter(Boolean)).size;

  const exportCsv = () => {
    const headers = [
      "Fulfilled At", "Request #", "Store", "Requested By", "SKU", "Barcode",
      "Product", "Requested Qty", "Actual Qty", "Transfer Reference"
    ];
    const csvCell = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const values = rows.map(row => [
      row.fulfilled_at ? new Date(row.fulfilled_at).toISOString() : "",
      row.request_id,
      row.store,
      row.requested_by_name,
      row.sku,
      row.barcode,
      row.style_name || row.product_name,
      row.requested_qty,
      row.actual_units,
      row.transfer_ref
    ]);
    const blob = new Blob([
      [headers, ...values].map(line => line.map(csvCell).join(",")).join("\n")
    ], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `store-stock-fulfilments-${effectiveFrom || "all"}-to-${effectiveTo || "all"}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (!data && loading) return <div className="py-10"><Loading label="Loading fulfilment report..." /></div>;
  if (error) return (
    <div className="space-y-3">
      <ErrorBox message={error} />
      <button onClick={() => fetchReport()} className="btn-primary">Retry</button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="card p-3 flex flex-col md:flex-row md:flex-wrap gap-3">
        {data?.can_manage && (
          <div className="flex flex-col gap-1.5 w-full md:w-48 shrink-0">
            <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Store</label>
            <select
              value={storeFilter}
              onChange={e => setStoreFilter(e.target.value)}
              className="input-pill w-full h-9"
              data-testid="filter-report-store"
            >
              <option value="">All Stores</option>
              {(data?.stores || []).map(store => <option key={store} value={store}>{store}</option>)}
            </select>
          </div>
        )}

        <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Search</label>
          <div className="relative">
            <MagnifyingGlass size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search store, requester, product, barcode..."
              value={q}
              onChange={e => setQ(e.target.value)}
              className="input-pill w-full h-9 pl-8"
              data-testid="input-report-search"
            />
            {q && <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2"><XIcon size={14} className="text-muted-foreground hover:text-foreground" /></button>}
          </div>
        </div>

        <div className="flex flex-col gap-1.5 w-full md:w-auto">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Fulfilled Period</label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={dateRange?.days || "custom"}
              onChange={e => {
                if (e.target.value === "custom") {
                  setDateRange(null);
                  setCustomFrom(effectiveFrom);
                  setCustomTo(effectiveTo);
                } else {
                  setDateRange(DATE_RANGES.find(range => range.days === Number(e.target.value)));
                }
              }}
              className="input-pill h-9 w-full sm:w-auto"
              data-testid="filter-report-date-preset"
            >
              {DATE_RANGES.map(range => <option key={range.days} value={range.days}>{range.label}</option>)}
              <option value="custom">Custom Range</option>
            </select>
            {!dateRange && (
              <div className="flex items-center gap-1 w-full sm:w-auto">
                <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="input-pill h-9 flex-1" data-testid="input-report-date-from" />
                <span className="text-muted-foreground px-1 text-sm">to</span>
                <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="input-pill h-9 flex-1" data-testid="input-report-date-to" />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-end">
          <button
            onClick={exportCsv}
            disabled={!rows.length}
            className="btn-ghost h-9 w-full md:w-auto flex items-center justify-center gap-2 disabled:opacity-50"
            data-testid="button-export-fulfilment-report"
          >
            <DownloadSimple size={16} /> Export CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card p-3"><div className="text-xs text-muted-foreground">Fulfilled lines</div><div className="text-xl font-bold">{fmtNum(rows.length)}</div></div>
        <div className="card p-3"><div className="text-xs text-muted-foreground">Actual units transferred</div><div className="text-xl font-bold">{fmtNum(totalUnits)}</div></div>
        <div className="card p-3"><div className="text-xs text-muted-foreground">Stores fulfilled</div><div className="text-xl font-bold">{fmtNum(storeCount)}</div></div>
      </div>

      {rows.length === 0 ? (
        <Empty label="No fulfilled request lines found for these filters" />
      ) : (
        <>
          <div className="card overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="data w-full text-sm">
                <thead>
                  <tr>
                    <th>Fulfilled</th><th>Request</th><th>Store</th><th>Requested By</th>
                    <th>Product</th><th>Barcode</th><th className="text-right">Requested</th>
                    <th className="text-right">Actual</th><th>Transfer Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.line_id} data-testid={`fulfilment-report-row-${row.line_id}`}>
                      <td className="whitespace-nowrap text-xs">{row.fulfilled_at ? new Date(row.fulfilled_at).toLocaleString() : "—"}</td>
                      <td className="font-medium">#{row.request_id}</td>
                      <td>{row.store}</td><td>{row.requested_by_name || "—"}</td>
                      <td className="max-w-[220px] truncate" title={row.product_name}>{row.style_name || row.product_name || row.sku}</td>
                      <td className="font-mono text-[11px] text-muted-foreground">{row.barcode || row.sku}</td>
                      <td className="text-right">{fmtNum(row.requested_qty)}</td>
                      <td className="text-right font-bold">{fmtNum(row.actual_units)}</td>
                      <td className="text-xs text-muted-foreground">{row.transfer_ref || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="md:hidden flex flex-col gap-3">
            {rows.map(row => (
              <div key={row.line_id} className="card p-3" data-testid={`fulfilment-report-card-${row.line_id}`}>
                <div className="flex justify-between gap-3">
                  <div>
                    <div className="font-semibold">{row.style_name || row.product_name || row.sku}</div>
                    <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{row.barcode || row.sku}</div>
                  </div>
                  <div className="text-right"><div className="text-[10px] text-muted-foreground uppercase">Actual</div><div className="font-bold text-emerald-700">{fmtNum(row.actual_units)}</div></div>
                </div>
                <div className="mt-3 pt-2 border-t border-border grid grid-cols-2 gap-2 text-xs">
                  <div><span className="text-muted-foreground">Store</span><div className="font-medium">{row.store}</div></div>
                  <div><span className="text-muted-foreground">Request</span><div className="font-medium">#{row.request_id} · {fmtNum(row.requested_qty)} req</div></div>
                  <div><span className="text-muted-foreground">Fulfilled</span><div>{row.fulfilled_at ? new Date(row.fulfilled_at).toLocaleString() : "—"}</div></div>
                  <div><span className="text-muted-foreground">Transfer ref</span><div>{row.transfer_ref || "—"}</div></div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RequestCard({ request, canManage, canRequest, filteredStatus, onLineAction }) {
  const requestStatus = String(request.status || "").toLowerCase();
  const isExpired = request.expires_at ? new Date(request.expires_at) < new Date() : false;
  
  return (
    <div className="card overflow-hidden" data-testid={`request-${request.id}`}>
      <div className="bg-muted/10 border-b border-border px-3 md:px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="font-bold text-base md:text-lg">#{request.id}</span>
          <span className="font-medium">{request.store}</span>
          <span className="text-[11px] text-muted-foreground px-2 py-0.5 rounded-full border border-border bg-card">
            By {request.requested_by_name}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {new Date(request.created_at).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <StatusPill status={requestStatus} />
          {filteredStatus !== "all" && requestStatus !== filteredStatus && (
            <span className="text-muted-foreground">Showing {filteredStatus} line{request.lines.length === 1 ? "" : "s"}</span>
          )}
          {requestStatus === 'open' && request.expires_at && (
            <span className="flex items-center gap-1 text-amber-600 bg-amber-50 px-2 py-1 rounded">
              <Clock size={12} />
              {isExpired ? 'Expired' : `Expires: ${new Date(request.expires_at).toLocaleString()}`}
            </span>
          )}
        </div>
      </div>
      
      {/* Desktop Table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="data w-full text-sm">
          <thead>
            <tr>
              <th>Status</th>
              <th>Product</th>
              <th>Category</th>
              <th>Size</th>
              <th>Colour</th>
              <th>Barcode</th>
              <th className="text-right">Req Qty</th>
              <th className="text-right">Actual Qty</th>
              <th>Transfer Ref</th>
              {(canManage || canRequest) && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {request.lines.map(line => (
              <RequestLineRow 
                key={line.id} 
                line={line} 
                canManage={canManage}
                canRequest={canRequest}
                onAction={(action, params) => onLineAction(line.id, action, params)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile Lines */}
      <div className="md:hidden flex flex-col divide-y divide-border">
        {request.lines.map(line => (
          <RequestLineMobile
            key={line.id}
            line={line}
            canManage={canManage}
            canRequest={canRequest}
            onAction={(action, params) => onLineAction(line.id, action, params)}
          />
        ))}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const normalized = String(status || "").toLowerCase();
  switch (normalized) {
    case 'open': return <span className="pill-amber text-[10px]">Open</span>;
    case 'picking': return <span className="pill-neutral text-[10px] bg-blue-100 text-blue-800">Picking</span>;
    case 'fulfilled': return <span className="pill-green text-[10px]">Fulfilled</span>;
    case 'cancelled': return <span className="pill-red text-[10px]">Cancelled</span>;
    case 'expired': return <span className="pill-red text-[10px]">Expired</span>;
    case 'mixed': return <span className="pill-neutral text-[10px] bg-violet-100 text-violet-800">Mixed</span>;
    default: return <span className="text-muted-foreground text-[10px] uppercase">{normalized || "unknown"}</span>;
  }
}

function RequestLineRow({ line, canManage, canRequest, onAction }) {
  const [actualQty, setActualQty] = useState(line.requested_qty);
  const [transferRef, setTransferRef] = useState(line.transfer_ref || "");
  const [isFulfilling, setIsFulfilling] = useState(false);

  const status = String(line.status || "").toLowerCase();
  const canCancel = (canManage && (status === 'open' || status === 'picking')) || (canRequest && status === 'open');
  const canPick = canManage && status === 'open';
  const canFulfill = canManage && status === 'picking';

  const startFulfill = () => {
    setActualQty(line.requested_qty);
    setTransferRef(line.transfer_ref || "");
    setIsFulfilling(true);
  };

  const handleFulfillSubmit = () => {
    const qty = parseInt(actualQty, 10);
    if (isNaN(qty) || qty < 0 || qty > line.requested_qty) {
      return toast.error(`Valid actual quantity must be between 0 and ${line.requested_qty}`);
    }
    onAction('fulfill', { actual_units: qty, transfer_ref: transferRef });
    setIsFulfilling(false);
  };

  return (
    <tr data-testid={`line-${line.id}`}>
      <td><StatusPill status={status} /></td>
      <td className="max-w-[180px] truncate" title={line.product_name}>
        {line.style_name || line.product_name || "—"}
      </td>
      <td>{line.category || "—"}</td>
      <td>{line.size || "—"}</td>
      <td>{line.color_print?.trim() || "—"}</td>
      <td className="font-mono text-[11px] text-muted-foreground">{line.barcode || line.sku}</td>
      <td className="text-right font-medium">{line.requested_qty}</td>
      
      <td className="text-right">
        {status === 'fulfilled' ? (
          <span className="font-bold">{line.actual_units}</span>
        ) : isFulfilling ? (
          <input
            type="number"
            min={0}
            max={line.requested_qty}
            value={actualQty}
            onChange={e => setActualQty(e.target.value)}
            className="w-16 h-8 px-2 text-right tabular-nums border border-border rounded bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 text-xs"
            data-testid={`input-actual-${line.id}`}
          />
        ) : (
          "—"
        )}
      </td>
      
      <td>
        {status === 'fulfilled' ? (
          <span className="text-muted-foreground text-xs">{line.transfer_ref || "—"}</span>
        ) : isFulfilling ? (
          <input
            type="text"
            placeholder="Ref #"
            value={transferRef}
            onChange={e => setTransferRef(e.target.value)}
            className="w-24 h-8 px-2 border border-border rounded bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 text-xs"
            data-testid={`input-ref-${line.id}`}
          />
        ) : (
          "—"
        )}
      </td>

      {(canManage || canRequest) && (
        <td>
          <div className="flex items-center gap-2 flex-wrap">
            {canPick && (
              <button 
                onClick={() => onAction('picking')} 
                className="btn-ghost py-1 px-2 text-[11px]"
                data-testid={`btn-pick-${line.id}`}
              >
                Start Picking
              </button>
            )}
            
            {canFulfill && !isFulfilling && (
              <button 
                onClick={startFulfill} 
                className="btn-primary py-1 px-2 text-[11px]"
                data-testid={`btn-fulfill-init-${line.id}`}
              >
                Fulfill
              </button>
            )}

            {isFulfilling && (
              <>
                <button 
                  onClick={handleFulfillSubmit} 
                  className="bg-emerald-600 hover:bg-emerald-700 text-white rounded px-2 py-1 text-[11px] font-semibold transition-colors"
                  data-testid={`btn-fulfill-submit-${line.id}`}
                >
                  Confirm
                </button>
                <button 
                  onClick={() => setIsFulfilling(false)} 
                  className="text-muted-foreground hover:text-foreground text-[11px] font-medium px-1"
                >
                  Cancel
                </button>
              </>
            )}

            {canCancel && !isFulfilling && (
              <button 
                onClick={() => onAction('cancel')} 
                className="text-danger hover:text-danger/80 text-[11px] font-medium px-2"
                data-testid={`btn-cancel-${line.id}`}
              >
                Cancel
              </button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}

function RequestLineMobile({ line, canManage, canRequest, onAction }) {
  const [actualQty, setActualQty] = useState(line.requested_qty);
  const [transferRef, setTransferRef] = useState(line.transfer_ref || "");
  const [isFulfilling, setIsFulfilling] = useState(false);

  const status = String(line.status || "").toLowerCase();
  const canCancel = (canManage && (status === 'open' || status === 'picking')) || (canRequest && status === 'open');
  const canPick = canManage && status === 'open';
  const canFulfill = canManage && status === 'picking';

  const startFulfill = () => {
    setActualQty(line.requested_qty);
    setTransferRef(line.transfer_ref || "");
    setIsFulfilling(true);
  };

  const handleFulfillSubmit = () => {
    const qty = parseInt(actualQty, 10);
    if (isNaN(qty) || qty < 0 || qty > line.requested_qty) {
      return toast.error(`Valid actual quantity must be between 0 and ${line.requested_qty}`);
    }
    onAction('fulfill', { actual_units: qty, transfer_ref: transferRef });
    setIsFulfilling(false);
  };

  return (
    <div className="p-3 flex flex-col gap-2" data-testid={`mobile-line-${line.id}`}>
      <div className="flex justify-between items-start gap-2">
        <div>
          <div className="font-semibold text-sm leading-tight">{line.style_name || line.product_name || "—"}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{line.category || "—"} · {line.size || "—"} {line.color_print ? `· ${line.color_print.trim()}` : ""}</div>
          <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{line.barcode || line.sku}</div>
        </div>
        <div className="text-right shrink-0 flex flex-col items-end gap-1">
          <StatusPill status={status} />
          <div className="mt-1 text-xs">
            <span className="text-muted-foreground mr-1">Req:</span>
            <span className="font-bold">{line.requested_qty}</span>
          </div>
          {status === 'fulfilled' && (
            <div className="text-xs text-emerald-700">
              <span className="text-muted-foreground mr-1">Act:</span>
              <span className="font-bold">{line.actual_units}</span>
            </div>
          )}
        </div>
      </div>

      {status === 'fulfilled' && line.transfer_ref && (
        <div className="text-[11px] text-muted-foreground bg-muted/20 px-2 py-1 rounded inline-block w-max">
          Ref: {line.transfer_ref}
        </div>
      )}

      {isFulfilling && (
        <div className="bg-background border border-border rounded-lg p-2 flex flex-wrap gap-2 items-end mt-1">
          <div className="flex flex-col gap-1 w-20">
            <label className="text-[10px] font-medium text-muted-foreground uppercase">Actual</label>
            <input
              type="number"
              min={0}
              max={line.requested_qty}
              value={actualQty}
              onChange={e => setActualQty(e.target.value)}
              className="w-full h-8 px-2 text-right tabular-nums border border-border rounded bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 text-xs"
              data-testid={`mobile-input-actual-${line.id}`}
            />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-[100px]">
            <label className="text-[10px] font-medium text-muted-foreground uppercase">Transfer Ref</label>
            <input
              type="text"
              placeholder="Optional"
              value={transferRef}
              onChange={e => setTransferRef(e.target.value)}
              className="w-full h-8 px-2 border border-border rounded bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 text-xs"
              data-testid={`mobile-input-ref-${line.id}`}
            />
          </div>
          <div className="flex gap-1 w-full mt-1">
            <button 
              onClick={handleFulfillSubmit} 
              className="btn-primary flex-1 py-1 px-2 text-[11px] h-8"
              data-testid={`mobile-btn-fulfill-submit-${line.id}`}
            >
              Confirm
            </button>
            <button 
              onClick={() => setIsFulfilling(false)} 
              className="btn-ghost flex-1 py-1 px-2 text-[11px] h-8"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {(canManage || canRequest) && !isFulfilling && (
        <div className="flex flex-wrap items-center gap-2 mt-1">
          {canPick && (
            <button 
              onClick={() => onAction('picking')} 
              className="btn-ghost py-1 px-3 text-[11px] flex-1 max-w-[120px]"
              data-testid={`mobile-btn-pick-${line.id}`}
            >
              Start Picking
            </button>
          )}
          
          {canFulfill && (
            <button 
              onClick={startFulfill} 
              className="btn-primary py-1 px-3 text-[11px] flex-1 max-w-[120px]"
              data-testid={`mobile-btn-fulfill-init-${line.id}`}
            >
              Fulfill
            </button>
          )}

          {canCancel && (
            <button 
              onClick={() => onAction('cancel')} 
              className="text-danger hover:text-danger/80 border border-danger/20 rounded py-1 px-3 text-[11px] font-medium"
              data-testid={`mobile-btn-cancel-${line.id}`}
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}
