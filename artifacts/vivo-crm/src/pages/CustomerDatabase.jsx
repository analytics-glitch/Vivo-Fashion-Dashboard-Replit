import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatDate, formatKES } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoyaltyBadge } from "@/components/LoyaltyBadge";
import { RfmBadge } from "@/components/RfmBadge";
import { toast } from "sonner";
import { Search, ChevronUp, ChevronDown, Download, RotateCcw, Filter as FilterIcon, ArrowRight, RefreshCw } from "lucide-react";

const COLS = [
  { key: "customer_name", label: "Customer", sortable: true, align: "left", w: 220 },
  { key: "loyalty_tier", label: "Loyalty", sortable: true, align: "left", w: 90 },
  { key: "rfm_tier", label: "RFM", sortable: true, align: "left", w: 90 },
  { key: "spend_12mo_kes", label: "12-mo spend", sortable: true, align: "right", w: 130 },
  { key: "total_sales", label: "Lifetime", sortable: true, align: "right", w: 130 },
  { key: "total_orders", label: "Orders", sortable: true, align: "right", w: 80 },
  { key: "avg_order_value", label: "AOV", sortable: false, align: "right", w: 100 },
  { key: "last_purchase_date", label: "Last seen", sortable: true, align: "left", w: 140 },
  { key: "days_since_last_purchase", label: "Days ago", sortable: false, align: "right", w: 90 },
  { key: "city", label: "City", sortable: true, align: "left", w: 130 },
  { key: "assignee_name", label: "Assigned", sortable: false, align: "left", w: 120 },
  { key: "contact", label: "Contact", sortable: false, align: "left", w: 110 },
];

const LOYALTY_TIERS = ["bronze", "silver", "gold"];
const RFM_TIERS = ["vip", "loyal", "promising", "new", "at_risk", "churned"];
const ASSIGNMENT_OPTS = [
  { value: "any", label: "Anyone" },
  { value: "mine", label: "Mine" },
  { value: "assigned", label: "Any assigned" },
  { value: "unassigned", label: "Unassigned" },
];
const PAGE_SIZE = 25;

export default function CustomerDatabase() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState("spend_12mo_kes");
  const [order, setOrder] = useState("desc");
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const [filters, setFilters] = useState({
    loyalty_tiers: [],
    rfm_tiers: [],
    cities: [],
    has_phone: null,
    has_email: null,
    min_spend_12mo: "",
    min_orders: "",
    last_purchase_within_days: "",
    last_purchase_beyond_days: "",
    assignment: "any",
    q: "",
  });
  const [facets, setFacets] = useState({ countries: [], cities: [], total_in_cache: 0 });
  const [showFilters, setShowFilters] = useState(false);
  const [freshness, setFreshness] = useState({ last_synced_at: null, last_sync_kind: null, running: false });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { api.get("/customers/grid/facets").then((r) => setFacets(r.data)).catch(() => {}); }, []);

  // Freshness badge: query once on mount, then poll every 15s while a sync is running
  useEffect(() => {
    let timer;
    const fetchFreshness = async () => {
      try {
        const r = await api.get("/customers/freshness");
        setFreshness(r.data || {});
        // Refresh grid + facets when a running sync completes
        if (!r.data?.running && refreshing) {
          setRefreshing(false);
          load();
          api.get("/customers/grid/facets").then((rr) => setFacets(rr.data)).catch(() => {});
        }
      } catch {/* silent */}
    };
    fetchFreshness();
    timer = setInterval(fetchFreshness, freshness.running || refreshing ? 5000 : 30000);
    return () => clearInterval(timer);
    // eslint-disable-next-line
  }, [freshness.running, refreshing]);

  const triggerRefresh = async () => {
    setRefreshing(true);
    try {
      await api.post("/customers/refresh");
      toast.success("Refreshing customer data from BI…");
    } catch {
      setRefreshing(false);
      toast.error("Refresh could not start");
    }
  };

  const cleanFilters = useMemo(() => {
    const o = {};
    Object.entries(filters).forEach(([k, v]) => {
      if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) return;
      if (k === "assignment" && v === "any") return;
      if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) o[k] = Number(v);
      else o[k] = v;
    });
    return o;
  }, [filters]);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.post("/customers/grid", {
        limit: PAGE_SIZE, offset, sort, order, filters: cleanFilters,
      });
      setRows(r.data.rows || []);
      setTotal(r.data.total || 0);
    } catch {
      toast.error("Could not load customer database");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [offset, sort, order, cleanFilters]);

  const toggleSort = (key) => {
    if (sort === key) setOrder(order === "desc" ? "asc" : "desc");
    else { setSort(key); setOrder("desc"); }
    setOffset(0);
  };
  const resetFilters = () => {
    setFilters({ loyalty_tiers: [], rfm_tiers: [], cities: [], has_phone: null, has_email: null, min_spend_12mo: "", min_orders: "", last_purchase_within_days: "", last_purchase_beyond_days: "", q: "" });
    setOffset(0);
  };
  const toggleArray = (key, val) => {
    setFilters((f) => ({ ...f, [key]: f[key].includes(val) ? f[key].filter((x) => x !== val) : [...f[key], val] }));
    setOffset(0);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await api.post("/customers/grid/export", { limit: 10000, filters: cleanFilters }, { responseType: "blob" });
      const url = URL.createObjectURL(new Blob([r.data], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url; a.download = `vivo-customers-${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast.success("CSV downloaded");
    } catch { toast.error("Export failed"); }
    setExporting(false);
  };

  const activeFilterCount = Object.values(cleanFilters).filter(v => v !== null && v !== "" && (!Array.isArray(v) || v.length > 0)).length;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-8" data-testid="customer-database-page">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <div>
          <div className="eyebrow">Customer database</div>
          <h1 className="font-display text-3xl md:text-4xl mt-1 tracking-tight">All customers</h1>
          <div className="text-sm text-[var(--vivo-muted)] mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {total.toLocaleString()} {total === 1 ? "match" : "matches"} of {facets.total_in_cache?.toLocaleString() || "—"} cached customers
            </span>
            <span className="text-[var(--vivo-muted)]">·</span>
            <FreshnessBadge freshness={freshness} refreshing={refreshing} onRefresh={triggerRefresh} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setShowFilters((v) => !v)} className="border-[var(--vivo-border)] press-effect" data-testid="grid-toggle-filters">
            <FilterIcon className="h-4 w-4 mr-2"/>Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ""}
          </Button>
          <Button variant="outline" onClick={resetFilters} className="border-[var(--vivo-border)] press-effect" disabled={activeFilterCount === 0} data-testid="grid-reset">
            <RotateCcw className="h-4 w-4 mr-2"/>Reset
          </Button>
          <Button onClick={exportCsv} disabled={exporting} className="bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy-700)] press-effect" data-testid="grid-export">
            <Download className={`h-4 w-4 mr-2 ${exporting ? "animate-pulse" : ""}`}/>
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>

      {/* Quick search row — always visible */}
      <div className="vivo-card p-3 mb-3 flex items-center gap-3">
        <Search className="h-4 w-4 text-[var(--vivo-muted)] ml-1"/>
        <Input
          placeholder="Search name, email, phone, canonical person ID, or source alias"
          value={filters.q}
          onChange={(e) => { setFilters({ ...filters, q: e.target.value }); setOffset(0); }}
          className="h-9 rounded-sm border-0 focus-visible:ring-0 bg-transparent flex-1"
          data-testid="grid-search"
        />
      </div>

      {/* Filter panel — collapsible */}
      {showFilters && (
        <Card className="vivo-card-cream p-5 mb-4" data-testid="grid-filter-panel">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            <FilterGroup label="Loyalty tier">
              {LOYALTY_TIERS.map((t) => (
                <Pill key={t} active={filters.loyalty_tiers.includes(t)} onClick={() => toggleArray("loyalty_tiers", t)} testid={`f-loyalty-${t}`}>
                  <LoyaltyBadge tier={t} size="sm"/>
                </Pill>
              ))}
            </FilterGroup>
            <FilterGroup label="RFM tier">
              {RFM_TIERS.map((t) => (
                <Pill key={t} active={filters.rfm_tiers.includes(t)} onClick={() => toggleArray("rfm_tiers", t)} testid={`f-rfm-${t}`}>
                  <span className="text-[11px] capitalize">{t.replace("_", " ")}</span>
                </Pill>
              ))}
            </FilterGroup>
            <FilterGroup label="Contactability">
              <Pill active={filters.has_phone === true} onClick={() => setFilters({ ...filters, has_phone: filters.has_phone === true ? null : true })} testid="f-has-phone">Has phone</Pill>
              <Pill active={filters.has_email === true} onClick={() => setFilters({ ...filters, has_email: filters.has_email === true ? null : true })} testid="f-has-email">Has email</Pill>
            </FilterGroup>
            <FilterGroup label="Assignment">
              {ASSIGNMENT_OPTS.map((opt) => (
                <Pill key={opt.value} active={filters.assignment === opt.value} onClick={() => { setFilters({ ...filters, assignment: opt.value }); setOffset(0); }} testid={`f-assignment-${opt.value}`}>
                  {opt.label}
                </Pill>
              ))}
            </FilterGroup>
            <FilterGroup label="Minimum 12-mo spend (KES)">
              <Input type="number" value={filters.min_spend_12mo} onChange={(e) => { setFilters({ ...filters, min_spend_12mo: e.target.value }); setOffset(0); }} placeholder="e.g. 50000" className="h-9 rounded-sm" data-testid="f-min-spend"/>
            </FilterGroup>
            <FilterGroup label="Minimum lifetime orders">
              <Input type="number" value={filters.min_orders} onChange={(e) => { setFilters({ ...filters, min_orders: e.target.value }); setOffset(0); }} placeholder="e.g. 5" className="h-9 rounded-sm" data-testid="f-min-orders"/>
            </FilterGroup>
            <FilterGroup label="Last seen (days)">
              <div className="flex items-center gap-2">
                <Input type="number" value={filters.last_purchase_within_days} onChange={(e) => { setFilters({ ...filters, last_purchase_within_days: e.target.value }); setOffset(0); }} placeholder="≤" className="h-9 rounded-sm w-24" data-testid="f-seen-within"/>
                <span className="text-xs text-[var(--vivo-muted)]">or beyond</span>
                <Input type="number" value={filters.last_purchase_beyond_days} onChange={(e) => { setFilters({ ...filters, last_purchase_beyond_days: e.target.value }); setOffset(0); }} placeholder="≥" className="h-9 rounded-sm w-24" data-testid="f-seen-beyond"/>
              </div>
            </FilterGroup>
            <FilterGroup label="City">
              <select value="" onChange={(e) => e.target.value && toggleArray("cities", e.target.value)} className="h-9 rounded-sm border border-[var(--vivo-border)] bg-white text-sm w-full px-2" data-testid="f-city-select">
                <option value="">Add city…</option>
                {facets.cities.filter((c) => !filters.cities.includes(c)).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <div className="flex flex-wrap gap-1 mt-2">
                {filters.cities.map((c) => (
                  <button key={c} onClick={() => toggleArray("cities", c)} className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy-700)]" data-testid={`f-city-chip-${c}`}>
                    {c} ×
                  </button>
                ))}
              </div>
            </FilterGroup>
          </div>
        </Card>
      )}

      {/* Table */}
      <Card className="vivo-card overflow-hidden" data-testid="grid-table-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="grid-table">
            <thead className="bg-[var(--vivo-bg-soft)] border-b border-[var(--vivo-border)] sticky top-0 z-10">
              <tr>
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    onClick={() => c.sortable && toggleSort(c.key)}
                    className={`px-4 py-3 text-[10px] uppercase tracking-[0.14em] font-semibold text-[var(--vivo-muted)] ${c.align === "right" ? "text-right" : "text-left"} ${c.sortable ? "cursor-pointer select-none hover:text-[var(--vivo-navy)]" : ""}`}
                    style={{ minWidth: c.w }}
                    data-testid={`grid-col-${c.key}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      {c.sortable && sort === c.key && (order === "desc" ? <ChevronDown className="h-3 w-3"/> : <ChevronUp className="h-3 w-3"/>)}
                    </span>
                  </th>
                ))}
                <th className="w-10"/>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-[var(--vivo-border)]">
                    {COLS.map((c) => <td key={c.key} className="px-4 py-3"><div className="h-3 bg-[var(--vivo-bg-soft)] rounded-sm"/></td>)}
                    <td/>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={COLS.length + 1}>
                  <div className="vivo-empty m-4">
                    <Search className="h-6 w-6 mx-auto opacity-40"/>
                    <h4>No customers match these filters</h4>
                    <p>Try removing a filter or widening the spend / date range.</p>
                  </div>
                </td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.customer_id} className="border-b border-[var(--vivo-border)] hover:bg-[var(--vivo-bg-soft)] press-effect" data-testid={`grid-row-${r.customer_id}`}>
                    <td className="px-4 py-3">
                      <Link to={`/customers/${r.customer_id}`} className="font-medium text-[var(--vivo-navy)] hover:underline">{r.customer_name || r.customer_id}</Link>
                      <div className="text-[11px] text-[var(--vivo-muted)] mt-0.5 font-mono-num">person:{r.person_id || r.customer_id}</div>
                      {r.provenance && <div className="text-[10px] text-[var(--vivo-muted)] truncate max-w-[250px]" title={r.provenance}>{r.provenance}</div>}
                    </td>
                    <td className="px-4 py-3">{r.loyalty_tier ? <LoyaltyBadge tier={r.loyalty_tier} size="sm"/> : <span className="text-[var(--vivo-muted)] text-xs">—</span>}</td>
                    <td className="px-4 py-3">{r.rfm_tier ? <RfmBadge tier={r.rfm_tier}/> : <span className="text-[var(--vivo-muted)] text-xs">—</span>}</td>
                    <td className="px-4 py-3 text-right font-mono-num">{formatKES(r.spend_12mo_kes)}</td>
                    <td className="px-4 py-3 text-right font-mono-num text-[var(--vivo-muted)]">{formatKES(r.total_sales)}</td>
                    <td className="px-4 py-3 text-right font-mono-num">{r.total_orders || 0}</td>
                    <td className="px-4 py-3 text-right font-mono-num">{formatKES(r.avg_order_value)}</td>
                    <td className="px-4 py-3">{formatDate(r.last_purchase_date)}</td>
                    <td className="px-4 py-3 text-right font-mono-num text-[var(--vivo-muted)]">{r.days_since_last_purchase ?? "—"}</td>
                    <td className="px-4 py-3 text-[var(--vivo-muted)]">{r.city || "—"}</td>
                    <td className="px-4 py-3">
                      {r.assignee_name ? (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-[var(--vivo-bg)] border border-[var(--vivo-border)] text-[11px] text-[var(--vivo-navy)]" data-testid={`grid-assignee-${r.customer_id}`}>
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--vivo-orange,#ED7C2A)]"/>
                          {r.assignee_name}
                        </span>
                      ) : (
                        <span className="text-[11px] text-[var(--vivo-muted)] italic">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span title="Phone" className={`h-1.5 w-1.5 rounded-full ${r.has_phone ? "bg-[var(--vivo-navy)]" : "bg-[var(--vivo-border)]"}`}/>
                        <span className="text-[11px] text-[var(--vivo-muted)]">{r.has_phone ? "Phone" : "—"}</span>
                        <span title="Email" className={`ml-2 h-1.5 w-1.5 rounded-full ${r.has_email ? "bg-[var(--vivo-gold)]" : "bg-[var(--vivo-border)]"}`}/>
                        <span className="text-[11px] text-[var(--vivo-muted)]">{r.has_email ? "Email" : "—"}</span>
                      </div>
                    </td>
                    <td className="px-2"><Link to={`/customers/${r.customer_id}`} className="text-[var(--vivo-muted)] hover:text-[var(--vivo-navy)]" aria-label="Open"><ArrowRight className="h-4 w-4"/></Link></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--vivo-border)] bg-[var(--vivo-bg-soft)]">
          <span className="text-xs text-[var(--vivo-muted)]" data-testid="grid-pager-summary">
            {start}–{end} of {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} className="h-8 px-3 rounded-sm border border-[var(--vivo-border)] text-xs disabled:opacity-40 press-effect" data-testid="grid-pager-prev">← Prev</button>
            <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={end >= total} className="h-8 px-3 rounded-sm border border-[var(--vivo-border)] text-xs disabled:opacity-40 press-effect" data-testid="grid-pager-next">Next →</button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function FilterGroup({ label, children }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-navy)] font-semibold mb-2">{label}</div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function Pill({ active, onClick, children, testid }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`px-2.5 py-1 rounded-full border text-xs press-effect ${
        active
          ? "bg-[var(--vivo-navy)] text-white border-[var(--vivo-navy)]"
          : "bg-white border-[var(--vivo-border)] text-[var(--vivo-muted)] hover:text-[var(--vivo-navy)]"
      }`}
    >
      {children}
    </button>
  );
}

function FreshnessBadge({ freshness, refreshing, onRefresh }) {
  const { last_synced_at, last_sync_kind, running } = freshness || {};
  const busy = running || refreshing;
  const label = busy
    ? "Syncing customer data…"
    : last_synced_at
      ? `Last synced ${relTime(last_synced_at)}${last_sync_kind === "full" ? " (full)" : ""}`
      : "Cache not synced yet";
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="customer-freshness-badge">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${busy ? "bg-amber-500 animate-pulse" : last_synced_at ? "bg-emerald-600" : "bg-[var(--vivo-muted)]"}`}/>
      <span>{label}</span>
      <button
        onClick={onRefresh}
        disabled={busy}
        title="Pull the latest two quarters from BI now (~45s)"
        className={`inline-flex items-center gap-1 text-[var(--vivo-navy)] hover:underline disabled:opacity-50 disabled:no-underline`}
        data-testid="customer-freshness-refresh"
      >
        <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`}/>
        {busy ? "" : "Refresh now"}
      </button>
    </span>
  );
}

function relTime(iso) {
  try {
    const t = new Date(iso).getTime();
    const diff = Math.max(0, Date.now() - t);
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  } catch { return iso; }
}

