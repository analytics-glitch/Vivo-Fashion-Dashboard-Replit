import { useState, useEffect, useRef, useCallback } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtKES, fmtNum, fmtDate } from "@/lib/api";
import { usePiiReveal, piiHeaders } from "@/lib/usePiiReveal";
import PageHeader from "@/components/layout/PageHeader";

// ── small helpers ────────────────────────────────────────────────────────────
const KES  = (n) => fmtKES(Number(n) || 0);
const NUM  = (n) => fmtNum(Number(n) || 0);

function useDebounce(value, delay) {
  const [d, setD] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setD(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return d;
}

// ── Tier badge ───────────────────────────────────────────────────────────────
const TIER_COLORS = {
  Bronze:  "bg-orange-100 text-orange-700 border-orange-200",
  Silver:  "bg-stone-100 text-stone-600 border-stone-300",
  Gold:    "bg-amber-100 text-amber-700 border-amber-300",
  VIP:     "bg-purple-100 text-purple-700 border-purple-300",
};
function TierBadge({ tier }) {
  if (!tier) return null;
  const cls = TIER_COLORS[tier] || "bg-stone-100 text-stone-600 border-stone-200";
  return (
    <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border ${cls}`}>
      {tier}
    </span>
  );
}

// ── Pill tag ─────────────────────────────────────────────────────────────────
function Pill({ children }) {
  return (
    <span className="inline-block text-xs bg-stone-100 text-stone-600 px-2 py-0.5 rounded-full border border-stone-200">
      {children}
    </span>
  );
}

// ── Section head ─────────────────────────────────────────────────────────────
function SectionHead({ children, action }) {
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-stone-50 border-b border-stone-200 flex-shrink-0">
      <span className="text-xs font-semibold text-stone-500 uppercase tracking-wider truncate">{children}</span>
      {action && <span className="flex-shrink-0 ml-2">{action}</span>}
    </div>
  );
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────
// history: [{ label }], current label shown at the end
function Breadcrumb({ history, currentLabel, onNavigate }) {
  const allCrumbs = [...history.map((h) => h.label), currentLabel].filter(Boolean);
  if (!allCrumbs.length) return null;
  return (
    <nav className="flex items-center gap-1 text-xs text-stone-500 px-4 py-2 bg-white border-b border-stone-200 flex-wrap flex-shrink-0">
      <button onClick={() => onNavigate(-1)} className="hover:text-green-700 transition-colors">
        Home
      </button>
      {allCrumbs.map((label, i) => {
        const isLast = i === allCrumbs.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
            <span className="text-stone-300">/</span>
            {isLast ? (
              <span className="font-medium text-stone-700 max-w-[180px] truncate">{label}</span>
            ) : (
              <button
                onClick={() => onNavigate(i)}
                className="hover:text-green-700 transition-colors max-w-[180px] truncate"
                title={label}
              >
                {label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────
function Empty({ icon, title, sub }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-16 gap-3 text-stone-400">
      <span className="text-4xl">{icon}</span>
      <p className="font-medium text-stone-500 text-sm">{title}</p>
      {sub && <p className="text-xs text-center max-w-xs">{sub}</p>}
    </div>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div className="flex items-center justify-center h-full py-16">
      <div className="w-6 h-6 border-2 border-green-700 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

// ── Error display ─────────────────────────────────────────────────────────────
function Err({ msg }) {
  return (
    <div className="mx-4 mt-4 p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">
      {msg}
    </div>
  );
}

// ── Image carousel ────────────────────────────────────────────────────────────
function ImageCarousel({ images, styleName }) {
  const [idx, setIdx] = useState(0);
  const valid = (images || []).filter((i) => i?.url);
  if (!valid.length) {
    return (
      <div className="w-full h-40 bg-stone-100 flex items-center justify-center flex-shrink-0">
        <span className="text-stone-400 text-xs">No image</span>
      </div>
    );
  }
  const current = valid[Math.min(idx, valid.length - 1)];
  return (
    <div className="relative flex-shrink-0">
      <img
        key={current.url}
        src={current.url}
        alt={styleName}
        className="w-full h-48 object-cover"
        onError={(e) => { e.target.style.display = "none"; }}
      />
      {valid.length > 1 && (
        <>
          <button
            onClick={() => setIdx((i) => (i - 1 + valid.length) % valid.length)}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-7 h-7 bg-black/40 text-white rounded-full text-xs flex items-center justify-center hover:bg-black/60"
          >
            ‹
          </button>
          <button
            onClick={() => setIdx((i) => (i + 1) % valid.length)}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 bg-black/40 text-white rounded-full text-xs flex items-center justify-center hover:bg-black/60"
          >
            ›
          </button>
          <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1">
            {valid.map((_, i) => (
              <button
                key={i}
                onClick={() => setIdx(i)}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${i === idx ? "bg-white" : "bg-white/50"}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function Stat({ label, value }) {
  return (
    <div className="bg-stone-50 rounded p-2">
      <p className="text-xs text-stone-500">{label}</p>
      <p className="text-sm font-semibold text-stone-800">{value}</p>
    </div>
  );
}

// ── Main view state ───────────────────────────────────────────────────────────
// A "view" snapshot has all the data needed to restore a panel state.
const BLANK_VIEW = {
  mode: "customer",
  centerSubject: null, // { type:"customer"|"product", ...data }
  centerRows: [],
  centerError: null,
  rightContent: null,  // null | { type:"product"|"customer", data }
  rightError: null,
  label: null,         // breadcrumb label for this view state
};

// ── Main page ─────────────────────────────────────────────────────────────────
export default function OrderExplorer() {
  const { applied } = useFilters();
  const { revealToken, openModal, modal } = usePiiReveal();

  const filterParams = {
    date_from: applied.dateFrom,
    date_to:   applied.dateTo,
    ...(applied.countries?.length && { country: applied.countries.join(",") }),
    ...(applied.channels?.length  && { channel:  applied.channels.join(",")  }),
  };

  // ── history stack + current view ─────────────────────────────────────────
  // history[i] = full view snapshot (the state when history[i].label was active)
  const [history, setHistory] = useState([]);   // [viewSnapshot]
  const [view, setView]       = useState(BLANK_VIEW);

  const [loadingCenter, setLoadingCenter] = useState(false);
  const [loadingRight,  setLoadingRight]  = useState(false);

  // ── search state ──────────────────────────────────────────────────────────
  const [searchQ,       setSearchQ]       = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [showDropdown,  setShowDropdown]  = useState(false);
  const searchRef = useRef(null);
  const debouncedQ = useDebounce(searchQ, 300);

  // ── navigation helpers ────────────────────────────────────────────────────
  // Navigate forward: push current view to history, set new view
  const navigateTo = useCallback((newView) => {
    setHistory((h) => [...h, view]);
    setView(newView);
  }, [view]);

  // Navigate backward: restore to history[targetIdx].
  //   targetIdx = -1 → go home (clear everything)
  //   targetIdx = i  → restore to the state that WAS showing crumb i
  const navigateBack = useCallback((targetIdx) => {
    if (targetIdx < 0) {
      // go all the way home
      setHistory([]);
      setView({ ...BLANK_VIEW, mode: view.mode });
      setSearchQ("");
      return;
    }
    // Restore the snapshot from history[targetIdx]
    const snapshot = history[targetIdx];
    if (!snapshot) return;
    setHistory((h) => h.slice(0, targetIdx));
    setView(snapshot);
    setSearchQ(snapshot.label || "");
  }, [history, view.mode]);

  // ── mode toggle ───────────────────────────────────────────────────────────
  const handleModeSwitch = (m) => {
    setHistory([]);
    setView({ ...BLANK_VIEW, mode: m });
    setSearchQ("");
    setSearchResults([]);
  };

  // ── typeahead ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!debouncedQ || debouncedQ.length < 2) {
      setSearchResults([]);
      return;
    }
    setLoadingSearch(true);
    const isCustomer = view.mode === "customer";
    const url = isCustomer ? "/api/customer-search" : "/api/product-search";
    const params = isCustomer
      ? { q: debouncedQ, date_from: filterParams.date_from, date_to: filterParams.date_to }
      : { q: debouncedQ };
    api.get(url, { params, headers: piiHeaders(revealToken) })
      .then((res) => {
        const raw = isCustomer ? (res.data || []) : (res.data?.options || []);
        // For products: de-duplicate by style_name so each style appears once
        if (!isCustomer) {
          const seen = new Set();
          const deduped = [];
          for (const r of raw) {
            const key = r.style_name || r.sku;
            if (!seen.has(key)) { seen.add(key); deduped.push(r); }
          }
          setSearchResults(deduped.slice(0, 20));
        } else {
          setSearchResults(raw.slice(0, 15));
        }
        setShowDropdown(true);
      })
      .catch(() => setSearchResults([]))
      .finally(() => setLoadingSearch(false));
  }, [debouncedQ, view.mode, filterParams.date_from, filterParams.date_to, revealToken]);

  // close dropdown on outside click
  useEffect(() => {
    const h = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) setShowDropdown(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // ── load customer orders → center ─────────────────────────────────────────
  const loadCustomerOrders = useCallback((customer) => {
    setLoadingCenter(true);
    const label = customer.customer_name || customer.customer_id;
    api.get(`/api/orders/customer/${encodeURIComponent(customer.customer_id)}`, {
      params: filterParams,
      headers: piiHeaders(revealToken),
    })
      .then((res) => {
        navigateTo({
          mode: "customer",
          centerSubject: { type: "customer", ...customer },
          centerRows: res.data || [],
          centerError: null,
          rightContent: null,
          rightError: null,
          label,
        });
        setSearchQ(label);
        setShowDropdown(false);
      })
      .catch((e) => {
        navigateTo({
          mode: "customer",
          centerSubject: { type: "customer", ...customer },
          centerRows: [],
          centerError: e?.response?.data?.detail || "Failed to load order history",
          rightContent: null,
          rightError: null,
          label,
        });
      })
      .finally(() => setLoadingCenter(false));
  }, [filterParams, revealToken, navigateTo]);

  // ── load product buyers → center ──────────────────────────────────────────
  const loadProductBuyers = useCallback((product) => {
    setLoadingCenter(true);
    const label = product.style_name || product.sku;
    api.get("/api/orders/product/buyers", {
      params: {
        style_name: product.style_name,
        sku: product.sku,
        ...filterParams,
        ...(revealToken && { reveal: true }),
      },
      headers: piiHeaders(revealToken),
    })
      .then((res) => {
        navigateTo({
          mode: "product",
          centerSubject: { type: "product", ...product },
          centerRows: res.data || [],
          centerError: null,
          rightContent: null,
          rightError: null,
          label,
        });
        setSearchQ(label);
        setShowDropdown(false);
      })
      .catch((e) => {
        navigateTo({
          mode: "product",
          centerSubject: { type: "product", ...product },
          centerRows: [],
          centerError: e?.response?.data?.detail || "Failed to load buyers",
          rightContent: null,
          rightError: null,
          label,
        });
      })
      .finally(() => setLoadingCenter(false));
  }, [filterParams, revealToken, navigateTo]);

  // ── load product detail → right ───────────────────────────────────────────
  const loadProductDetail = useCallback((styleName, sku) => {
    setLoadingRight(true);
    const label = styleName || sku;
    Promise.all([
      api.get("/api/orders/product/detail", { params: { style_name: styleName, sku } }),
      sku ? api.get(`/api/product-images/${encodeURIComponent(sku)}`) : Promise.resolve({ data: { images: [] } }),
    ])
      .then(([detailRes, imgRes]) => {
        setView((prev) => {
          // Only update right panel — don't push new history entry since this is a drill
          const newRight = {
            type: "product",
            data: { ...detailRes.data, images: imgRes.data?.images || [] },
            label,
          };
          return { ...prev, rightContent: newRight, rightError: null };
        });
        setHistory((h) => {
          // Update the last history entry to include current right if there was one before this drill
          return h;
        });
      })
      .catch((e) => {
        setView((prev) => ({
          ...prev,
          rightError: e?.response?.data?.detail || "Failed to load product detail",
          rightContent: null,
        }));
      })
      .finally(() => setLoadingRight(false));
  }, []);

  // ── load customer right panel (from product buyers) ───────────────────────
  const loadCustomerRight = useCallback((buyer) => {
    setLoadingRight(true);
    const label = buyer.customer_name || buyer.customer_id;
    api.get(`/api/orders/customer/${encodeURIComponent(buyer.customer_id)}`, {
      params: filterParams,
      headers: piiHeaders(revealToken),
    })
      .then((res) => {
        setView((prev) => ({
          ...prev,
          rightContent: { type: "customer", data: { ...buyer, orders: res.data || [] }, label },
          rightError: null,
        }));
      })
      .catch((e) => {
        setView((prev) => ({
          ...prev,
          rightError: e?.response?.data?.detail || "Failed to load customer orders",
          rightContent: null,
        }));
      })
      .finally(() => setLoadingRight(false));
  }, [filterParams, revealToken]);

  // ── "See all buyers" pivot from product right panel ───────────────────────
  const pivotToProductBuyers = useCallback((styleName, sku) => {
    handleModeSwitch("product");
    setSearchQ(styleName || sku || "");
    // Small delay to let mode state settle before navigating
    setTimeout(() => loadProductBuyers({ style_name: styleName, sku }), 0);
  }, [loadProductBuyers]);

  // ── group order rows by order_id ──────────────────────────────────────────
  const groupedOrders = (rows) => {
    const map = new Map();
    for (const r of (rows || [])) {
      if (!map.has(r.order_id)) {
        map.set(r.order_id, {
          order_id: r.order_id,
          order_name: r.order_name || r.order_id,
          sale_date: r.sale_date,
          pos_location_name: r.pos_location_name,
          country: r.country,
          items: [],
          gross_total: 0,
          net_total: 0,
        });
      }
      const g = map.get(r.order_id);
      g.items.push(r);
      g.gross_total += Number(r.gross_sales_kes) || 0;
      g.net_total   += Number(r.net_sales_kes) || 0;
    }
    return [...map.values()].sort((a, b) => b.sale_date.localeCompare(a.sale_date));
  };

  // ── derive breadcrumb labels ──────────────────────────────────────────────
  // history entries each have a .label; current view also has a label
  const crumbHistory = history.map((h) => ({ label: h.label }));
  const currentCrumbLabel = view.label;

  // ── left panel summary ────────────────────────────────────────────────────
  const centerSummary = (() => {
    if (!view.centerSubject || !view.centerRows.length) return null;
    if (view.centerSubject.type === "customer") {
      const orders = groupedOrders(view.centerRows);
      const units = view.centerRows
        .filter((r) => r.sale_kind !== "return")
        .reduce((s, r) => s + (Number(r.quantity) || 0), 0);
      const spend = view.centerRows.reduce((s, r) => s + (Number(r.net_sales_kes) || 0), 0);
      return { orders: orders.length, units, spend };
    } else {
      const spend = view.centerRows.reduce((s, r) => s + (Number(r.total_spend) || 0), 0);
      return { buyers: view.centerRows.length, spend };
    }
  })();

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {modal}
      <PageHeader
        title="Order Explorer"
        subtitle="Drill between customers and products to understand purchase behaviour"
      />
      <Breadcrumb
        history={crumbHistory}
        currentLabel={currentCrumbLabel}
        onNavigate={navigateBack}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── LEFT: mode + search ──────────────────────────────────────── */}
        <aside className="w-64 flex-shrink-0 border-r border-stone-200 flex flex-col bg-white overflow-y-auto">
          {/* mode toggle */}
          <div className="p-3 border-b border-stone-200">
            <p className="text-xs text-stone-500 mb-2 font-medium">Start from</p>
            <div className="flex rounded-lg border border-stone-200 overflow-hidden">
              {["customer", "product"].map((m) => (
                <button
                  key={m}
                  onClick={() => handleModeSwitch(m)}
                  className={`flex-1 text-xs py-2 font-medium transition-colors ${
                    view.mode === m
                      ? "bg-green-700 text-white"
                      : "bg-white text-stone-600 hover:bg-stone-50"
                  }`}
                >
                  {m === "customer" ? "Customer" : "Product"}
                </button>
              ))}
            </div>
          </div>

          {/* search */}
          <div className="p-3 relative" ref={searchRef}>
            <label className="text-xs text-stone-500 font-medium block mb-1">
              {view.mode === "customer" ? "Search customers" : "Search styles"}
            </label>
            <input
              value={searchQ}
              onChange={(e) => { setSearchQ(e.target.value); setShowDropdown(true); }}
              onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
              placeholder={view.mode === "customer" ? "Name, phone, email…" : "Style name or SKU…"}
              className="w-full border border-stone-300 rounded-md px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-green-700"
            />
            {loadingSearch && (
              <div className="absolute right-5 top-9 w-4 h-4 border-2 border-green-700 border-t-transparent rounded-full animate-spin" />
            )}
            {showDropdown && searchResults.length > 0 && (
              <div className="absolute left-3 right-3 top-[70px] z-50 bg-white border border-stone-200 rounded-md shadow-lg max-h-72 overflow-y-auto">
                {searchResults.map((item, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setShowDropdown(false);
                      if (view.mode === "customer") loadCustomerOrders(item);
                      else loadProductBuyers(item);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-stone-50 border-b border-stone-100 last:border-0"
                  >
                    {view.mode === "customer" ? (
                      <>
                        <p className="text-xs font-medium text-stone-800">
                          {item.customer_name || "(no name)"}
                        </p>
                        <p className="text-xs text-stone-500">
                          {item.phone || item.email || "—"}
                          {item.total_orders != null && <> · {NUM(item.total_orders)} orders</>}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-xs font-medium text-stone-800">{item.style_name}</p>
                        <p className="text-xs text-stone-500">{item.category || item.subcategory || "—"}</p>
                      </>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* PII reveal control */}
          <div className="px-3 pb-3">
            <button
              onClick={openModal}
              className={`w-full text-xs py-1.5 rounded border transition-colors ${
                revealToken
                  ? "bg-amber-50 border-amber-300 text-amber-700"
                  : "bg-stone-50 border-stone-200 text-stone-500 hover:border-stone-300"
              }`}
            >
              {revealToken ? "PII revealed — click to refresh" : "Reveal contact info"}
            </button>
          </div>

          {/* hint */}
          {!view.centerSubject && (
            <p className="px-3 py-2 text-xs text-stone-400 leading-relaxed">
              {view.mode === "customer"
                ? "Search for a customer to see their full order history. Click any order line to drill into the product."
                : "Search for a style to see every identified buyer. Click a buyer to see their orders."}
            </p>
          )}

          {/* summary stats */}
          {centerSummary && (
            <div className="mt-auto p-3 border-t border-stone-200 bg-stone-50">
              {view.centerSubject?.type === "customer" ? (
                <>
                  <p className="text-xs text-stone-500">
                    {centerSummary.orders} orders · {NUM(centerSummary.units)} units
                  </p>
                  <p className="text-xs font-semibold text-stone-800 mt-0.5">
                    {KES(centerSummary.spend)} net spend
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs text-stone-500">{NUM(centerSummary.buyers)} buyers</p>
                  <p className="text-xs font-semibold text-stone-800 mt-0.5">
                    {KES(centerSummary.spend)} total
                  </p>
                </>
              )}
            </div>
          )}
        </aside>

        {/* ── CENTER: results ──────────────────────────────────────────── */}
        <main className="flex-1 min-w-0 flex flex-col border-r border-stone-200 bg-white overflow-hidden">
          {loadingCenter && <Spinner />}
          {!loadingCenter && view.centerError && <Err msg={view.centerError} />}

          {!loadingCenter && !view.centerError && !view.centerSubject && (
            <Empty
              icon="🔍"
              title="Select a customer or product to begin"
              sub="Use the search panel on the left to pick your starting point"
            />
          )}

          {/* Customer → orders */}
          {!loadingCenter && !view.centerError && view.centerSubject?.type === "customer" && (() => {
            const orders = groupedOrders(view.centerRows);
            return (
              <>
                <SectionHead>
                  {view.centerSubject.customer_name || view.centerSubject.customer_id}
                </SectionHead>
                <div className="overflow-y-auto flex-1">
                  {orders.length === 0 && (
                    <Empty icon="📦" title="No orders in this window" sub="Try expanding the date range" />
                  )}
                  {orders.map((order) => (
                    <div key={order.order_id} className="border-b border-stone-100">
                      <div className="flex items-center justify-between px-4 py-2 bg-stone-50 border-b border-stone-100">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs font-medium text-stone-700">{fmtDate(order.sale_date)}</span>
                          <span className="text-xs text-stone-400 truncate">{order.pos_location_name}</span>
                          <span className="text-xs text-stone-400 uppercase">({order.country})</span>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <span className="text-xs font-semibold text-stone-800">{KES(order.net_total)}</span>
                          <span className="text-xs text-stone-400 ml-1">net</span>
                        </div>
                      </div>
                      {order.items.map((item, ii) => (
                        <button
                          key={ii}
                          onClick={() => item.sku && loadProductDetail(item.style_name, item.sku)}
                          disabled={!item.sku}
                          className={`w-full text-left flex items-center gap-3 px-4 py-2 border-b border-stone-50 last:border-0 transition-colors ${
                            item.sku ? "hover:bg-green-50 cursor-pointer" : "cursor-default"
                          } ${item.sale_kind === "return" ? "bg-red-50/40" : ""}`}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-stone-800 truncate">
                              {item.style_name || item.sku || "—"}
                            </p>
                            <p className="text-xs text-stone-500">
                              {[item.colour, item.size].filter(Boolean).join(" · ") || item.sku}
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="text-xs text-stone-700">
                              {NUM(item.quantity)} × {KES(item.unit_price_kes || 0)}
                            </p>
                            {item.sale_kind === "return" && (
                              <span className="text-xs text-red-500">return</span>
                            )}
                          </div>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            );
          })()}

          {/* Product → buyers */}
          {!loadingCenter && !view.centerError && view.centerSubject?.type === "product" && (
            <>
              <SectionHead>
                {view.centerSubject.style_name || view.centerSubject.sku}
              </SectionHead>
              <div className="overflow-y-auto flex-1">
                {view.centerRows.length === 0 && (
                  <Empty icon="👥" title="No identified buyers" sub="Try expanding the date range or reveal PII" />
                )}
                {view.centerRows.map((buyer, i) => (
                  <button
                    key={i}
                    onClick={() => loadCustomerRight(buyer)}
                    className="w-full text-left flex items-center justify-between gap-3 px-4 py-3 border-b border-stone-100 hover:bg-green-50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-medium text-stone-800 truncate">
                          {buyer.customer_name || "(no name)"}
                        </p>
                        {buyer.loyalty_tier && <TierBadge tier={buyer.loyalty_tier} />}
                      </div>
                      <p className="text-xs text-stone-500 mt-0.5">
                        {buyer.city || buyer.phone || buyer.email || buyer.customer_id}
                        {buyer.last_order_date && <> · last {fmtDate(buyer.last_order_date)}</>}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs font-semibold text-stone-800">{KES(buyer.total_spend)}</p>
                      <p className="text-xs text-stone-400">
                        {NUM(buyer.total_units)} units · {NUM(buyer.total_orders)} orders
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </main>

        {/* ── RIGHT: detail ────────────────────────────────────────────── */}
        <aside className="w-80 flex-shrink-0 flex flex-col bg-white overflow-hidden">
          {loadingRight && <Spinner />}
          {!loadingRight && view.rightError && <Err msg={view.rightError} />}

          {!loadingRight && !view.rightError && !view.rightContent && (
            <Empty
              icon="⬅"
              title="Click to drill down"
              sub={
                view.centerSubject?.type === "customer"
                  ? "Click an order line to see the product detail, stock on hand, and other buyers"
                  : view.centerSubject?.type === "product"
                  ? "Click a buyer to see their full order history"
                  : "Select an item in the centre panel first"
              }
            />
          )}

          {!loadingRight && !view.rightError && view.rightContent?.type === "product" && (
            <ProductDetailPanel
              data={view.rightContent.data}
              centerRows={view.centerSubject?.type === "product" ? view.centerRows : null}
              onSeeAllBuyers={pivotToProductBuyers}
              onOpenModal={openModal}
              revealToken={revealToken}
            />
          )}

          {!loadingRight && !view.rightError && view.rightContent?.type === "customer" && (
            <CustomerDetailPanel
              data={view.rightContent.data}
              onLoadProduct={loadProductDetail}
              onOpenModal={openModal}
              revealToken={revealToken}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// ── Product detail right panel ─────────────────────────────────────────────
function ProductDetailPanel({ data, centerRows, onSeeAllBuyers, onOpenModal, revealToken }) {
  const sohs  = Array.isArray(data.soh_by_store) ? data.soh_by_store : [];
  // If the center panel already has buyers for this style, show top 5 inline
  const topBuyers = Array.isArray(centerRows) ? centerRows.slice(0, 5) : [];

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <SectionHead
        action={
          <button
            onClick={() => onSeeAllBuyers(data.style_name, data.representative_sku)}
            className="text-xs text-green-700 hover:underline font-medium"
          >
            See all buyers
          </button>
        }
      >
        Product detail
      </SectionHead>

      <ImageCarousel images={data.images} styleName={data.style_name} />

      <div className="p-4 space-y-4">
        {/* identity */}
        <div>
          <h3 className="font-semibold text-sm text-stone-800">{data.style_name || "—"}</h3>
          <p className="text-xs text-stone-500 mt-0.5">
            {[data.brand, data.category, data.subcategory].filter(Boolean).join(" · ")}
          </p>
          {data.collection && <p className="text-xs text-stone-400 mt-0.5">{data.collection}</p>}
        </div>

        {/* stats */}
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Modal price" value={data.modal_price ? KES(data.modal_price) : "—"} />
          <Stat label="Total SOH"   value={NUM(data.total_soh || 0)} />
        </div>

        {/* colours / sizes */}
        {data.colours?.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 mb-1">Colours</p>
            <div className="flex flex-wrap gap-1">
              {data.colours.map((c) => <Pill key={c}>{c}</Pill>)}
            </div>
          </div>
        )}
        {data.sizes?.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 mb-1">Sizes</p>
            <div className="flex flex-wrap gap-1">
              {data.sizes.map((s) => <Pill key={s}>{s}</Pill>)}
            </div>
          </div>
        )}

        {/* stock by store */}
        {sohs.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 mb-2">Stock on hand by store</p>
            <div className="space-y-1">
              {sohs.slice(0, 12).map((s, i) => (
                <div key={i} className="flex items-center justify-between">
                  <span className="text-xs text-stone-700 truncate max-w-[160px]">{s.store}</span>
                  <span className="text-xs font-medium text-stone-800">{NUM(s.stock)}</span>
                </div>
              ))}
              {sohs.length > 12 && (
                <p className="text-xs text-stone-400">+{sohs.length - 12} more stores</p>
              )}
            </div>
          </div>
        )}

        {/* inline top buyers (when available from center) */}
        {topBuyers.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-stone-500">Top buyers in period</p>
              <button
                onClick={() => onSeeAllBuyers(data.style_name, data.representative_sku)}
                className="text-xs text-green-700 hover:underline"
              >
                See all
              </button>
            </div>
            <div className="space-y-1">
              {topBuyers.map((b, i) => (
                <div key={i} className="flex items-center justify-between py-1 border-b border-stone-100 last:border-0">
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="text-xs text-stone-700 truncate">
                      {b.customer_name || "(no name)"}
                    </span>
                    {b.loyalty_tier && <TierBadge tier={b.loyalty_tier} />}
                  </div>
                  <span className="text-xs text-stone-500 flex-shrink-0 ml-1">
                    {KES(b.total_spend)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Customer detail right panel ────────────────────────────────────────────
function CustomerDetailPanel({ data, onLoadProduct, onOpenModal, revealToken }) {
  const orders = data.orders || [];
  const grouped = groupOrders(orders);
  const totalSpend = orders.reduce((s, r) => s + (Number(r.net_sales_kes) || 0), 0);
  const firstDate  = orders.length ? orders.reduce((m, r) => r.sale_date < m ? r.sale_date : m, orders[0].sale_date) : null;
  const lastDate   = orders.length ? orders.reduce((m, r) => r.sale_date > m ? r.sale_date : m, orders[0].sale_date) : null;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <SectionHead>Customer detail</SectionHead>

      <div className="p-4 space-y-4">
        {/* identity */}
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-sm text-stone-800">
              {data.customer_name || "(no name)"}
            </h3>
            {data.loyalty_tier && <TierBadge tier={data.loyalty_tier} />}
          </div>
          {revealToken ? (
            <p className="text-xs text-stone-500 mt-0.5">
              {[data.phone, data.email, data.city].filter((v) => v && !v.includes("*")).join(" · ") || "—"}
            </p>
          ) : (
            <div className="flex items-center gap-2 mt-1">
              <p className="text-xs text-stone-400 italic">Contact hidden</p>
              <button
                onClick={onOpenModal}
                className="text-xs text-green-700 hover:underline"
              >
                Reveal
              </button>
            </div>
          )}
        </div>

        {/* stats */}
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Net spend (window)" value={KES(totalSpend)} />
          <Stat label="Orders (window)"    value={NUM(grouped.length)} />
        </div>
        {(firstDate || lastDate) && (
          <div className="grid grid-cols-2 gap-2">
            <Stat label="First order" value={firstDate ? fmtDate(firstDate) : "—"} />
            <Stat label="Last order"  value={lastDate  ? fmtDate(lastDate)  : "—"} />
          </div>
        )}

        {/* recent orders */}
        {grouped.length > 0 && (
          <div>
            <p className="text-xs text-stone-500 mb-2">Orders in window</p>
            <div className="space-y-2">
              {grouped.slice(0, 8).map((order) => (
                <div key={order.order_id} className="border border-stone-200 rounded">
                  <div className="flex items-center justify-between px-2 py-1.5 bg-stone-50 rounded-t border-b border-stone-200">
                    <span className="text-xs text-stone-600">{fmtDate(order.sale_date)}</span>
                    <span className="text-xs font-semibold">{KES(order.net_total)}</span>
                  </div>
                  {order.items.map((item, ii) => (
                    <button
                      key={ii}
                      onClick={() => item.sku && item.style_name && onLoadProduct(item.style_name, item.sku)}
                      disabled={!item.sku}
                      className={`w-full text-left px-2 py-1.5 flex justify-between border-b border-stone-100 last:border-0 transition-colors ${
                        item.sku ? "hover:bg-green-50 cursor-pointer" : "cursor-default"
                      }`}
                    >
                      <span className="text-xs text-stone-700 truncate max-w-[150px]">
                        {item.style_name || item.sku}
                      </span>
                      <span className="text-xs text-stone-500 flex-shrink-0">×{NUM(item.quantity)}</span>
                    </button>
                  ))}
                </div>
              ))}
              {grouped.length > 8 && (
                <p className="text-xs text-stone-400 text-center">
                  {grouped.length - 8} more orders — expand the date range to see all
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── shared order-grouping helper ───────────────────────────────────────────
function groupOrders(rows) {
  const map = new Map();
  for (const r of (rows || [])) {
    if (!map.has(r.order_id)) {
      map.set(r.order_id, { ...r, items: [], net_total: 0 });
    }
    const g = map.get(r.order_id);
    g.items.push(r);
    g.net_total += Number(r.net_sales_kes) || 0;
  }
  return [...map.values()].sort((a, b) => b.sale_date.localeCompare(a.sale_date));
}
