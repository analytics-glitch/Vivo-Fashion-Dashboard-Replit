import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { api, fmtKES, fmtNum } from "@/lib/api";
import { usePiiReveal, piiHeaders } from "@/lib/usePiiReveal";

// ── formatting helpers ────────────────────────────────────────────────────────
const KES = (n) => fmtKES(Number(n) || 0);
const NUM = (n) => fmtNum(Number(n) || 0);

function fmtOrderDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
    }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

function fmtShortDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
    });
  } catch {
    return (iso || "").slice(0, 10);
  }
}

// ── status badge configs ───────────────────────────────────────────────────────
const PAYMENT_COLORS = {
  paid:               "bg-green-100 text-green-700 border-green-200",
  partially_refunded: "bg-orange-100 text-orange-700 border-orange-200",
  refunded:           "bg-red-100 text-red-600 border-red-200",
  voided:             "bg-stone-100 text-stone-500 border-stone-300",
  pending:            "bg-amber-100 text-amber-700 border-amber-200",
  partially_paid:     "bg-amber-100 text-amber-700 border-amber-200",
};
const PAYMENT_LABELS = {
  paid:               "Paid",
  partially_refunded: "Part. Refunded",
  refunded:           "Refunded",
  voided:             "Voided",
  pending:            "Pending",
  partially_paid:     "Part. Paid",
};

const FULFIL_COLORS = {
  fulfilled:   "bg-green-100 text-green-700 border-green-200",
  unfulfilled: "bg-stone-100 text-stone-500 border-stone-200",
  partial:     "bg-orange-100 text-orange-700 border-orange-200",
};
const FULFIL_LABELS = {
  fulfilled:   "Fulfilled",
  unfulfilled: "Unfulfilled",
  partial:     "Partial",
};

const TIER_COLORS = {
  Bronze: "bg-orange-100 text-orange-700 border-orange-200",
  Silver: "bg-stone-100 text-stone-600 border-stone-300",
  Gold:   "bg-amber-100 text-amber-700 border-amber-300",
  VIP:    "bg-purple-100 text-purple-700 border-purple-300",
};

const COUNTRY_COLORS = {
  Kenya:  "#1a5c38",
  Uganda: "#d97706",
  Rwanda: "#00c853",
  Online: "#4b7bec",
};

function StatusBadge({ status, map, colors, labels }) {
  const key = (status || "").toLowerCase().replace(/ /g, "_");
  const cls = colors[key] || "bg-stone-100 text-stone-500 border-stone-200";
  const label = labels[key] || status || "—";
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

function PayBadge({ status }) {
  return <StatusBadge status={status} colors={PAYMENT_COLORS} labels={PAYMENT_LABELS} />;
}
function FulfilBadge({ status }) {
  return <StatusBadge status={status} colors={FULFIL_COLORS} labels={FULFIL_LABELS} />;
}
function TierBadge({ tier }) {
  const cls = TIER_COLORS[tier] || "bg-stone-100 text-stone-500 border-stone-200";
  return (
    <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border ${cls}`}>
      {tier}
    </span>
  );
}

// ── small UI atoms ────────────────────────────────────────────────────────────
function Spinner({ size = "md" }) {
  const sz = size === "sm" ? "w-4 h-4 border-2" : "w-6 h-6 border-2";
  return (
    <div className={`${sz} border-green-700 border-t-transparent rounded-full animate-spin`} />
  );
}

function SectionLabel({ children }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">
      {children}
    </p>
  );
}

function Field({ label, value, mono }) {
  return (
    <div>
      <p className="text-[10px] text-stone-400 uppercase tracking-wider">{label}</p>
      <p className={`text-xs text-stone-800 mt-0.5 ${mono ? "font-mono" : ""}`}>
        {value || "—"}
      </p>
    </div>
  );
}

// ── Filter bar ─────────────────────────────────────────────────────────────────
const PAYMENT_OPTIONS = [
  { value: "paid",               label: "Paid" },
  { value: "pending",            label: "Pending" },
  { value: "partially_paid",     label: "Partially paid" },
  { value: "partially_refunded", label: "Partially refunded" },
  { value: "refunded",           label: "Refunded" },
  { value: "voided",             label: "Voided" },
];
const FULFIL_OPTIONS = [
  { value: "unfulfilled", label: "Unfulfilled" },
  { value: "fulfilled",   label: "Fulfilled" },
  { value: "partial",     label: "Partial" },
];

function Select({ label, options, value, onChange }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-[10px] text-stone-400 uppercase tracking-wider">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border border-stone-200 rounded-md px-2 py-1.5 text-xs text-stone-700 bg-white focus:outline-none focus:ring-1 focus:ring-green-700"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function FilterBar({ filters, onChange, onSearch, loading }) {
  const [localSearch, setLocalSearch] = useState(filters.search || "");
  const handleKey = (e) => { if (e.key === "Enter") onSearch(localSearch); };

  return (
    <div className="flex-shrink-0 bg-white border-b border-stone-200 px-4 py-3 flex flex-wrap items-end gap-3">
      {/* search */}
      <div className="flex flex-col gap-0.5 flex-1 min-w-[180px] max-w-xs">
        <label className="text-[10px] text-stone-400 uppercase tracking-wider">Search</label>
        <div className="flex gap-1">
          <input
            type="text"
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Customer name, email, order #…"
            className="flex-1 border border-stone-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-green-700"
          />
          <button
            onClick={() => onSearch(localSearch)}
            disabled={loading}
            className="px-3 py-1.5 bg-green-700 text-white text-xs rounded-md hover:bg-green-800 disabled:opacity-50 flex items-center gap-1"
          >
            {loading ? <Spinner size="sm" /> : "Search"}
          </button>
        </div>
      </div>

      {/* date range */}
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] text-stone-400 uppercase tracking-wider">From</label>
        <input
          type="date"
          value={filters.dateFrom || ""}
          onChange={(e) => onChange({ dateFrom: e.target.value })}
          className="border border-stone-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-green-700"
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] text-stone-400 uppercase tracking-wider">To</label>
        <input
          type="date"
          value={filters.dateTo || ""}
          onChange={(e) => onChange({ dateTo: e.target.value })}
          className="border border-stone-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-green-700"
        />
      </div>

      {/* status filters */}
      <Select
        label="Payment"
        options={PAYMENT_OPTIONS}
        value={filters.financialStatus || ""}
        onChange={(v) => onChange({ financialStatus: v })}
      />
      <Select
        label="Fulfillment"
        options={FULFIL_OPTIONS}
        value={filters.fulfillmentStatus || ""}
        onChange={(v) => onChange({ fulfillmentStatus: v })}
      />

      {/* reset */}
      <button
        onClick={() => {
          setLocalSearch("");
          onChange({ search: "", financialStatus: "", fulfillmentStatus: "" });
          onSearch("");
        }}
        className="text-xs text-stone-400 hover:text-stone-600 self-end pb-1.5"
      >
        Clear
      </button>
    </div>
  );
}

// ── Orders table ──────────────────────────────────────────────────────────────
function OrdersTable({ orders, selectedId, onSelect, hasMore, nextCursor, onLoadMore, loadingMore }) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="overflow-y-auto flex-1">
        {orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-stone-400">
            <p className="text-sm font-medium text-stone-500">No orders found</p>
            <p className="text-xs mt-1">Try adjusting your filters</p>
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-stone-50 border-b border-stone-200">
              <tr>
                <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone-500 whitespace-nowrap">Order</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone-500 whitespace-nowrap">Date</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone-500 whitespace-nowrap">Customer</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone-500 whitespace-nowrap">Location</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone-500 whitespace-nowrap">Payment</th>
                <th className="text-left px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone-500 whitespace-nowrap">Fulfillment</th>
                <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone-500 whitespace-nowrap">Items</th>
                <th className="text-right px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-stone-500 whitespace-nowrap">Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => {
                const selected = order.id === selectedId;
                return (
                  <tr
                    key={order.id}
                    onClick={() => onSelect(order)}
                    className={`border-b border-stone-100 cursor-pointer transition-colors ${
                      selected
                        ? "bg-green-50 border-l-2 border-l-green-700"
                        : "hover:bg-stone-50"
                    }`}
                  >
                    <td className="px-3 py-2.5">
                      <span className="font-semibold text-green-800">{order.name || order.id}</span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-stone-600">
                      {fmtShortDate(order.created_at)}
                    </td>
                    <td className="px-3 py-2.5 max-w-[160px]">
                      <p className="font-medium text-stone-800 truncate">
                        {order.customer_name || "(no name)"}
                      </p>
                      <p className="text-[10px] text-stone-400 truncate">{order.customer_email || ""}</p>
                    </td>
                    <td className="px-3 py-2.5 max-w-[130px]">
                      <span className="truncate block text-stone-600" title={order.pos_location || ""}>
                        {order.pos_location || <span className="text-stone-300">—</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <PayBadge status={order.financial_status} />
                    </td>
                    <td className="px-3 py-2.5">
                      <FulfilBadge status={order.fulfillment_status} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-stone-700 tabular-nums">
                      {order.item_count != null ? order.item_count : <span className="text-stone-300">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-stone-800 whitespace-nowrap">
                      {KES(order.total_price)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* load more */}
      {hasMore && (
        <div className="flex-shrink-0 border-t border-stone-200 px-4 py-2 bg-white">
          <button
            onClick={() => onLoadMore(nextCursor)}
            disabled={loadingMore}
            className="w-full py-1.5 text-xs text-stone-600 hover:text-green-700 border border-stone-200 rounded-md hover:border-green-300 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loadingMore ? <><Spinner size="sm" /> Loading…</> : "Load more orders"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Image lightbox (portal to body — avoids stacking context issues) ───────────
function ImageLightbox({ src, alt, onClose }) {
  useEffect(() => {
    const fn = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/85 flex items-center justify-center p-8"
      onClick={onClose}
    >
      <img
        src={src}
        alt={alt || "Product image"}
        className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center bg-white/20 hover:bg-white/40 text-white rounded-full text-xl leading-none transition-colors font-light"
      >
        ×
      </button>
    </div>,
    document.body
  );
}

// ── Product detail drawer (portal to body) ────────────────────────────────────
function ProductDetailDrawer({ sku, detail, loading, onClose, onImageExpand }) {
  useEffect(() => {
    const fn = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);

  const product  = detail?.product   || {};
  const stock    = detail?.stock     || [];
  const velocity = detail?.velocity  || {};
  const imageUrl = detail?.image_url || "";
  const sohStores = detail?.soh_stores   ?? 0;
  const sohWh     = detail?.soh_warehouse ?? 0;

  const stockRows = stock.filter((s) => Number(s.available) > 0);

  return createPortal(
    <div className="fixed inset-0 z-[9998]">
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* drawer panel */}
      <div className="absolute right-0 top-0 h-full w-[440px] max-w-full bg-white shadow-2xl flex flex-col overflow-hidden">

        {/* header: image + name + close */}
        <div className="flex-shrink-0 border-b border-stone-200 px-4 py-3 flex items-start gap-3">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={product.style_name || sku}
              className="w-16 h-16 object-cover rounded cursor-zoom-in hover:opacity-80 transition-opacity flex-shrink-0 bg-stone-100"
              onClick={() => onImageExpand(imageUrl, product.style_name || sku)}
              onError={(e) => { e.target.style.display = "none"; }}
            />
          ) : (
            <div className="w-16 h-16 rounded bg-stone-100 flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0 pt-0.5">
            <p className="font-semibold text-sm text-stone-900 leading-snug">
              {product.style_name || sku}
            </p>
            {(product.color_print || product.size) && (
              <p className="text-[10px] text-stone-500 mt-0.5">
                {[product.color_print, product.size].filter(Boolean).join(" · ")}
              </p>
            )}
            <p className="text-[10px] font-mono text-stone-400 mt-0.5 truncate">{sku}</p>
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 w-7 h-7 flex items-center justify-center text-stone-400 hover:text-stone-700 rounded hover:bg-stone-100 transition-colors text-base font-medium mt-0.5"
          >
            ×
          </button>
        </div>

        {/* body */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Spinner />
          </div>
        ) : !detail ? (
          <div className="flex-1 flex items-center justify-center text-xs text-stone-400 italic">
            Product not found
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-5">

            {/* Properties */}
            <div>
              <SectionLabel>Properties</SectionLabel>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                {product.brand        && <Field label="Brand"        value={product.brand} />}
                {product.category     && <Field label="Category"     value={product.category} />}
                {product.sub_category && <Field label="Sub-category" value={product.sub_category} />}
                {product.product_type && <Field label="Product type" value={product.product_type} />}
                {product.collection   && <Field label="Collection"   value={product.collection} />}
                {product.gender       && <Field label="Gender"       value={product.gender} />}
                {product.status       && <Field label="Status"       value={product.status} />}
                {product.tier         && <Field label="Tier"         value={product.tier} />}
                {Number(product.price) > 0 && (
                  <Field label="Price" value={KES(product.price)} />
                )}
                {product.style_launch_date && (
                  <Field label="Launch date" value={fmtShortDate(product.style_launch_date)} />
                )}
                {product.is_noos && <Field label="NOOS" value="Yes" />}
              </div>
            </div>

            {/* Stock by location */}
            <div>
              <div className="flex items-baseline justify-between mb-2">
                <SectionLabel>Stock on Hand</SectionLabel>
                <div className="flex gap-3 text-[10px] text-stone-500 -mt-0.5">
                  <span>Stores <strong className="text-stone-800 font-semibold ml-0.5">{sohStores}</strong></span>
                  <span>Warehouse <strong className="text-stone-800 font-semibold ml-0.5">{sohWh}</strong></span>
                  <span>Total <strong className="text-stone-800 font-semibold ml-0.5">{sohStores + sohWh}</strong></span>
                </div>
              </div>
              {stockRows.length === 0 ? (
                <p className="text-xs text-stone-400 italic">No stock recorded</p>
              ) : (
                <div className="rounded-lg border border-stone-200 overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-stone-50 border-b border-stone-200">
                        <th className="px-3 py-1.5 text-left font-medium text-stone-500">Location</th>
                        <th className="px-3 py-1.5 text-right font-medium text-stone-500">Units</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stockRows.map((s, i) => (
                        <tr key={i} className={`border-t border-stone-100 ${i % 2 === 1 ? "bg-stone-50/50" : ""}`}>
                          <td className="px-3 py-1.5 text-stone-700">
                            <div className="flex items-center gap-1.5">
                              <span
                                className="w-2 h-2 rounded-full flex-shrink-0 inline-block"
                                style={{ background: COUNTRY_COLORS[s.country] || "#aaa" }}
                              />
                              {s.location}
                            </div>
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono font-semibold text-stone-800">
                            {NUM(s.available)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 30-day velocity */}
            {(Number(velocity.units_30d) > 0 || Number(velocity.revenue_30d) > 0) && (
              <div>
                <SectionLabel>Last 30 Days</SectionLabel>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                  <Field label="Units sold" value={NUM(velocity.units_30d)} />
                  <Field label="Revenue" value={KES(velocity.revenue_30d)} />
                </div>
              </div>
            )}

          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ── Line item row — clickable for product drawer, image click for lightbox ─────
function LineItemRow({ item, isReturn, onImageExpand, onProductClick }) {
  const hasSku = !!item.sku;
  return (
    <div
      className={`flex items-start gap-2 rounded-lg p-2 transition-colors ${
        isReturn
          ? "bg-red-50 border border-red-100"
          : "bg-white border border-stone-100"
      } ${hasSku ? "cursor-pointer hover:border-green-200 hover:bg-stone-50/50" : ""}`}
      onClick={hasSku ? () => onProductClick && onProductClick(item) : undefined}
    >
      {/* product image — click expands to lightbox, stops row-click propagation */}
      <div
        className={`flex-shrink-0 ${item.image_url ? "cursor-zoom-in" : ""}`}
        onClick={
          item.image_url
            ? (e) => {
                e.stopPropagation();
                onImageExpand && onImageExpand(item.image_url, item.product_title);
              }
            : undefined
        }
      >
        {item.image_url ? (
          <img
            src={item.image_url}
            alt={item.product_title}
            className="w-12 h-12 object-cover rounded bg-stone-100 hover:opacity-75 transition-opacity"
            onError={(e) => { e.target.style.display = "none"; }}
          />
        ) : (
          <div className="w-12 h-12 rounded bg-stone-100 flex-shrink-0" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-stone-800 truncate">
          {item.product_title || item.sku || "—"}
        </p>
        <p className="text-[10px] text-stone-500 mt-0.5">
          {[item.colour, item.size].filter(Boolean).join(" · ") || ""}
        </p>
        {hasSku && (
          <p className="text-[10px] font-mono text-stone-400 mt-0.5 truncate">{item.sku}</p>
        )}
      </div>

      <div className="text-right flex-shrink-0">
        <p className="text-xs text-stone-700">{NUM(item.quantity)} × {KES(item.unit_price)}</p>
        {Number(item.discount) > 0 && (
          <p className="text-[10px] text-stone-400">−{KES(item.discount)} disc.</p>
        )}
        <p className={`text-xs font-semibold mt-0.5 ${isReturn ? "text-red-600" : "text-stone-900"}`}>
          {isReturn ? `− ${KES(item.line_total)}` : KES(item.line_total)}
        </p>
      </div>
    </div>
  );
}

function PriceLine({ label, value, dimmed, bold }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-xs ${dimmed ? "text-stone-400" : bold ? "font-semibold text-stone-800" : "text-stone-600"}`}>
        {label}
      </span>
      <span className={`text-xs ${dimmed ? "text-stone-400" : bold ? "font-semibold text-stone-800" : "text-stone-700"}`}>
        {value}
      </span>
    </div>
  );
}

function TimelineStep({ label, time, done, pending }) {
  return (
    <div className="flex items-start gap-2">
      <div className={`mt-0.5 w-3 h-3 rounded-full border-2 flex-shrink-0 ${done ? "bg-green-700 border-green-700" : "bg-white border-stone-300"}`} />
      <div>
        <p className={`text-xs font-medium ${done ? "text-stone-800" : "text-stone-400"}`}>{label}</p>
        {time && <p className="text-[10px] text-stone-400 mt-0.5">{time}</p>}
      </div>
    </div>
  );
}

// ── debounce hook ─────────────────────────────────────────────────────────────
function useDebounce(value, delay) {
  const [d, setD] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setD(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return d;
}

// ── Order detail panel ────────────────────────────────────────────────────────
function OrderDetail({ detail, loadingDetail, onClose, revealToken, openModal, onProductClick, onImageExpand }) {
  if (loadingDetail) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-stone-400 gap-2 px-6 text-center">
        <p className="text-sm font-medium text-stone-500">Select an order</p>
        <p className="text-xs">Click any row in the list to see the full order details</p>
      </div>
    );
  }

  const { header, lines, customer, pricing } = detail;
  const saleLine = (lines || []).filter((l) => l.sale_kind !== "return");
  const retLines = (lines || []).filter((l) => l.sale_kind === "return");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* sticky header */}
      <div className="flex-shrink-0 bg-white border-b border-stone-200 px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-base text-stone-900">{header.name || header.id}</span>
            <PayBadge status={header.financial_status} />
            <FulfilBadge status={header.fulfillment_status} />
          </div>
          <p className="text-xs text-stone-400 mt-0.5">{fmtOrderDate(header.created_at)}</p>
        </div>
        <button
          onClick={onClose}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center text-stone-400 hover:text-stone-700 rounded hover:bg-stone-100 transition-colors text-sm font-medium"
        >
          ×
        </button>
      </div>

      {/* scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">

        {/* ── Customer ─────────────────────────────────────────── */}
        <div className="bg-stone-50 rounded-lg p-3">
          <SectionLabel>Customer</SectionLabel>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-sm text-stone-800">
                  {customer.first_name || customer.last_name
                    ? `${customer.first_name || ""} ${customer.last_name || ""}`.trim()
                    : header.customer_name || "(no name)"}
                </p>
                {customer.loyalty_tier && <TierBadge tier={customer.loyalty_tier} />}
              </div>
              {revealToken ? (
                <div className="mt-1 space-y-0.5">
                  {header.customer_email && (
                    <p className="text-xs text-stone-600">{header.customer_email}</p>
                  )}
                  {customer.phone && (
                    <p className="text-xs text-stone-600">{customer.phone}</p>
                  )}
                  {customer.city && (
                    <p className="text-xs text-stone-500">{customer.city}</p>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-1">
                  <p className="text-xs text-stone-400 italic">Contact hidden</p>
                  <button onClick={openModal} className="text-xs text-green-700 hover:underline">
                    Reveal
                  </button>
                </div>
              )}
            </div>
            {(customer.total_orders != null || customer.lifetime_value != null) && (
              <div className="flex-shrink-0 text-right">
                {customer.total_orders != null && (
                  <p className="text-xs text-stone-500">{NUM(customer.total_orders)} orders</p>
                )}
                {customer.lifetime_value != null && (
                  <p className="text-xs font-semibold text-stone-800">{KES(customer.lifetime_value)} LTV</p>
                )}
              </div>
            )}
          </div>
          {(customer.first_order_date || customer.last_order_date) && (
            <div className="grid grid-cols-2 gap-2 mt-3">
              {customer.first_order_date && (
                <Field label="First order" value={fmtShortDate(customer.first_order_date)} />
              )}
              {customer.last_order_date && (
                <Field label="Last order" value={fmtShortDate(customer.last_order_date)} />
              )}
            </div>
          )}
        </div>

        {/* ── Line items ───────────────────────────────────────── */}
        <div>
          <SectionLabel>Line Items</SectionLabel>
          {saleLine.length === 0 ? (
            <p className="text-xs text-stone-400 italic">No sale lines found in internal records</p>
          ) : (
            <div className="space-y-2">
              {saleLine.map((item, i) => (
                <LineItemRow
                  key={i}
                  item={item}
                  onImageExpand={onImageExpand}
                  onProductClick={onProductClick}
                />
              ))}
            </div>
          )}

          {retLines.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-red-400 mb-2">Returns</p>
              <div className="space-y-2">
                {retLines.map((item, i) => (
                  <LineItemRow
                    key={i}
                    item={item}
                    isReturn
                    onImageExpand={onImageExpand}
                    onProductClick={onProductClick}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Pricing breakdown ────────────────────────────────── */}
        <div className="bg-stone-50 rounded-lg p-3">
          <SectionLabel>Pricing</SectionLabel>
          <div className="space-y-1.5">
            <PriceLine label="Subtotal (incl. VAT)" value={KES(pricing.subtotal || header.total_price)} />
            {Number(pricing.discounts) > 0 && (
              <PriceLine label="Discounts" value={`− ${KES(pricing.discounts)}`} dimmed />
            )}
            {Number(pricing.returns) > 0 && (
              <PriceLine label="Returns" value={`− ${KES(pricing.returns)}`} dimmed />
            )}
            <div className="border-t border-stone-200 pt-1.5 mt-1">
              <PriceLine label="Order Total" value={KES(header.total_price)} bold />
            </div>
          </div>
        </div>

        {/* ── Fulfillment timeline ─────────────────────────────── */}
        <div>
          <SectionLabel>Fulfillment Timeline</SectionLabel>
          <div className="space-y-2">
            <TimelineStep
              label="Order placed"
              time={fmtOrderDate(header.created_at)}
              done
            />
            <TimelineStep
              label={header.fulfillment_status === "fulfilled" ? "Fulfilled" : "Fulfillment pending"}
              time={
                header.fulfillment_status === "fulfilled" && header.updated_at
                  ? fmtOrderDate(header.updated_at)
                  : null
              }
              done={header.fulfillment_status === "fulfilled"}
              pending={header.fulfillment_status !== "fulfilled"}
            />
          </div>
        </div>

        {/* ── Shipping ─────────────────────────────────────────── */}
        {(header.shipping_city || header.shipping_country) && (
          <div>
            <SectionLabel>Shipping Address</SectionLabel>
            <p className="text-xs text-stone-700">
              {[header.shipping_city, header.shipping_country].filter(Boolean).join(", ")}
            </p>
          </div>
        )}

        {/* ── Payment info ─────────────────────────────────────── */}
        <div>
          <SectionLabel>Payment</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status" value={PAYMENT_LABELS[(header.financial_status || "").toLowerCase()] || header.financial_status} />
            <Field label="Channel" value={header.source_name || "Online"} />
            <Field label="Order ID" value={header.id} mono />
          </div>
        </div>

      </div>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────
export default function OrderExplorer() {
  const { revealToken, openModal, modal } = usePiiReveal();

  // filter state
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const [filters, setFilters] = useState({
    search: "",
    dateFrom: thirtyDaysAgo,
    dateTo: today,
    financialStatus: "",
    fulfillmentStatus: "",
  });
  const [committedSearch, setCommittedSearch] = useState("");

  // orders list state
  const [orders, setOrders] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // order detail state
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [orderDetail, setOrderDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // image lightbox state
  const [lightbox, setLightbox] = useState(null); // { src, alt }

  // product detail drawer state
  const [prodDrawerItem, setProdDrawerItem] = useState(null); // line item object
  const [prodDetail, setProdDetail] = useState(null);
  const [loadingProd, setLoadingProd] = useState(false);

  // build API params from filters
  const buildParams = useCallback((search) => {
    const p = {};
    if (filters.dateFrom)         p.date_from = filters.dateFrom;
    if (filters.dateTo)           p.date_to = filters.dateTo;
    if (filters.financialStatus)  p.financial_status = filters.financialStatus;
    if (filters.fulfillmentStatus) p.fulfillment_status = filters.fulfillmentStatus;
    const q = (search ?? committedSearch).trim();
    if (q)                        p.search = q;
    return p;
  }, [filters, committedSearch]);

  // load first page
  const loadOrders = useCallback((searchOverride) => {
    setLoading(true);
    setSelectedOrder(null);
    setOrderDetail(null);
    const params = buildParams(searchOverride);
    api.get("/orders/list", { params })
      .then((res) => {
        setOrders(res.data?.orders || []);
        setHasMore(res.data?.has_more || false);
        setNextCursor(res.data?.next_cursor || null);
      })
      .catch(() => {
        setOrders([]);
        setHasMore(false);
        setNextCursor(null);
      })
      .finally(() => setLoading(false));
  }, [buildParams]);

  // load more (append next page)
  const loadMore = useCallback((cursor) => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const params = { ...buildParams(), after_id: cursor };
    api.get("/orders/list", { params })
      .then((res) => {
        setOrders((prev) => [...prev, ...(res.data?.orders || [])]);
        setHasMore(res.data?.has_more || false);
        setNextCursor(res.data?.next_cursor || null);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [buildParams, loadingMore]);

  // initial load
  useEffect(() => {
    loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // auto-reload when date/status filters change (not search — that's commit-on-enter)
  const prevFilterRef = useRef(null);
  useEffect(() => {
    const sig = `${filters.dateFrom}|${filters.dateTo}|${filters.financialStatus}|${filters.fulfillmentStatus}`;
    if (prevFilterRef.current === null) { prevFilterRef.current = sig; return; }
    if (prevFilterRef.current === sig) return;
    prevFilterRef.current = sig;
    loadOrders();
  }, [filters.dateFrom, filters.dateTo, filters.financialStatus, filters.fulfillmentStatus, loadOrders]);

  // load order detail
  const selectOrder = useCallback((order) => {
    setSelectedOrder(order);
    setLoadingDetail(true);
    setOrderDetail(null);
    api.get(`/orders/detail/${encodeURIComponent(order.id)}`, {
      headers: piiHeaders(revealToken),
    })
      .then((res) => setOrderDetail(res.data))
      .catch(() => setOrderDetail(null))
      .finally(() => setLoadingDetail(false));
  }, [revealToken]);

  // open product drawer
  const openProductDrawer = useCallback((item) => {
    if (!item.sku) return;
    setProdDrawerItem(item);
    setProdDetail(null);
    setLoadingProd(true);
    api.get(`/orders/product-detail/${encodeURIComponent(item.sku)}`)
      .then((res) => setProdDetail(res.data))
      .catch(() => setProdDetail(null))
      .finally(() => setLoadingProd(false));
  }, []);

  const closeProdDrawer = useCallback(() => {
    setProdDrawerItem(null);
    setProdDetail(null);
  }, []);

  const handleFilterChange = (patch) => setFilters((f) => ({ ...f, ...patch }));

  const handleSearch = (q) => {
    setCommittedSearch(q);
    loadOrders(q);
  };

  const detailOpen = !!selectedOrder;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {modal}

      {/* image lightbox portal */}
      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}

      {/* product detail drawer portal */}
      {prodDrawerItem && (
        <ProductDetailDrawer
          sku={prodDrawerItem.sku}
          detail={prodDetail}
          loading={loadingProd}
          onClose={closeProdDrawer}
          onImageExpand={(src, alt) => setLightbox({ src, alt })}
        />
      )}

      {/* page title */}
      <div className="flex-shrink-0 px-4 pt-3 pb-0">
        <h1 className="text-xl font-bold text-stone-800">Order Explorer</h1>
        <p className="text-xs text-stone-400 mt-0.5">Browse, filter, and inspect Shopify orders</p>
      </div>

      {/* filter bar */}
      <FilterBar
        filters={filters}
        onChange={handleFilterChange}
        onSearch={handleSearch}
        loading={loading}
      />

      {/* main content: list + optional detail */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── order list ─────────────────────────────────────── */}
        <div className={`flex flex-col min-h-0 overflow-hidden transition-all duration-200 ${detailOpen ? "w-1/2 border-r border-stone-200" : "flex-1"}`}>
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <OrdersTable
              orders={orders}
              selectedId={selectedOrder?.id}
              onSelect={selectOrder}
              hasMore={hasMore}
              nextCursor={nextCursor}
              onLoadMore={loadMore}
              loadingMore={loadingMore}
            />
          )}
        </div>

        {/* ── order detail ───────────────────────────────────── */}
        {detailOpen && (
          <div className="w-1/2 flex flex-col min-h-0 overflow-hidden bg-white">
            <OrderDetail
              detail={orderDetail}
              loadingDetail={loadingDetail}
              onClose={() => { setSelectedOrder(null); setOrderDetail(null); }}
              revealToken={revealToken}
              openModal={openModal}
              onProductClick={openProductDrawer}
              onImageExpand={(src, alt) => setLightbox({ src, alt })}
            />
          </div>
        )}

        {/* empty right hint when nothing selected */}
        {!detailOpen && orders.length > 0 && !loading && (
          <div className="hidden" />
        )}
      </div>
    </div>
  );
}
