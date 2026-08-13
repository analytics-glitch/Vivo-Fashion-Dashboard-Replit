/**
 * MerchColourDetail — product info popup for a Stock Mix colour row
 * (Inventory & Stock Health tab).
 *
 * Opens from a right-click on a colour row or a click/tap on its thumbnail.
 * Shows the Product Catalogue-style card for the row's representative SKU —
 * a SINGLE product photo (first Shopify gallery image → Odoo single image
 * with the Bearer-blob fallback → placeholder; click still zooms), a row of
 * three KPI cards (Tier · Average Selling Price with its %-of-full-price
 * note · Days since last sale — ASP is fetched under the tracker period this
 * popup received), master-data attributes, fabric block and per-size stock
 * table (live, ALL locations, Stores | Online | Warehouse) — plus a "This
 * view" strip with the tracker row's period numbers (SOH, stock value, units
 * sold, revenue, SOR, WOC, last ordered) under the tracker's current filters.
 *
 * Rendered via createPortal(document.body) so the tracker's sticky table
 * header can't paint over it (house overlay rule); closes on Esc or a
 * backdrop mousedown. Rows without a representative SKU (no product-master
 * match) still open — the card section explains why it's unavailable.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { Loading, ErrorBox } from "@/components/common";
import { Placeholder, Lightbox } from "@/components/ProductThumbnail";
import ProductImage from "@/components/ProductImage";
import { fmtNum, fmtKESM, fmtSor, sorColor, wocColor } from "./MerchHelpers";

const fmtKES = (v) =>
  v == null || Number.isNaN(Number(v)) ? null : "KES " + Math.round(Number(v)).toLocaleString();

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

const Chip = ({ tone = "muted", children }) => {
  const tones = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    red: "bg-rose-50 text-rose-700 border-rose-200",
    blue: "bg-sky-50 text-sky-700 border-sky-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    muted: "bg-panel text-muted border-border",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tones[tone] || tones.muted}`}>
      {children}
    </span>
  );
};

const Stat = ({ label, title, children }) => (
  <div className="min-w-0" title={title}>
    <div className="text-[10px] uppercase tracking-wide text-muted/80">{label}</div>
    <div className="text-[14px] font-semibold tabular-nums truncate">{children}</div>
  </div>
);

const KpiCard = ({ label, note, title, testId, children }) => (
  <div
    className="rounded-lg border border-border bg-panel/50 px-3 py-2.5 min-w-0"
    title={title}
    data-testid={testId}
  >
    <div className="text-[10px] uppercase tracking-wide text-muted/80">{label}</div>
    <div className="text-[17px] font-bold tabular-nums truncate mt-0.5">{children}</div>
    {note ? <div className="text-[11px] text-muted mt-0.5 truncate">{note}</div> : null}
  </div>
);

export default function MerchColourDetail({ item, period, onClose }) {
  const { sku, styleName, styleNumber, colour, metrics } = item;
  const [card, setCard] = useState(null);
  const [cardErr, setCardErr] = useState(null);
  const [imageUrl, setImageUrl] = useState(null); // single photo — first gallery image only
  const [zoom, setZoom] = useState(false);
  const zoomRef = useRef(false);
  zoomRef.current = zoom;

  useEffect(() => {
    let dead = false;
    setCard(null);
    setCardErr(null);
    setImageUrl(null);
    if (!sku) return undefined;
    const params = { sku };
    // Pass the tracker window through so the ASP KPI matches the viewed
    // period (the backend defaults to trailing 12 months without it).
    if (period?.from && period?.to) {
      params.date_from = period.from;
      params.date_to = period.to;
    }
    api
      .get("/gallery/style-card", { params })
      .then(({ data }) => { if (!dead) setCard(data); })
      .catch((e) => {
        if (!dead) setCardErr(e?.response?.data?.detail || e.message || "Couldn't load product details.");
      });
    api
      .get(`/product-images/${encodeURIComponent(sku)}`)
      .then(({ data }) => {
        if (dead) return;
        const urls = Array.isArray(data?.images) ? data.images.map((im) => im?.url).filter(Boolean) : [];
        if (urls.length) setImageUrl(urls[0]); // first image only — no thumbnail strip
      })
      .catch(() => {}); // fall through to the single-image / placeholder chain
    return () => { dead = true; };
  }, [sku, period?.from, period?.to]);

  // Esc closes the zoom lightbox first (it sits above), then the popup.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (zoomRef.current) return; // Lightbox handles its own Esc
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const attrs = useMemo(() => {
    if (!card) return [];
    return [
      ["Style #", card.style_number || styleNumber],
      ["Brand", card.brand],
      ["Category", card.category],
      ["Sub-category", card.subcategory],
      ["Collection", card.collection],
      ["Gender", card.gender],
      ["Season", card.season],
      ["Print / Plain", card.print_plain],
      ["Vendor", card.vendor],
    ].filter(([, v]) => (v || "").toString().trim() !== "");
  }, [card, styleNumber]);

  const fabric = card?.fabric && Object.keys(card.fabric).length ? card.fabric : null;
  const fabricRows = fabric
    ? [
        ["Structure", fabric.fabric_structure],
        ["Fabric category", fabric.fabric_category],
        ["Fibre content", fabric.fiber_content],
        ["GSM", fabric.gsm],
        ["Source", [fabric.source_city, fabric.source_country].filter(Boolean).join(", ")],
        ["NOOS fabric", fabric.noos_fabric],
      ].filter(([, v]) => (v || "").toString().trim() !== "")
    : [];

  const m = metrics || {};
  const caption = [styleName, colour].filter(Boolean).join(" · ") || sku || "Product";

  // KPI card values degrade to "—" when data is missing (no rep SKU, load
  // error, no sales / no tier). While the card is loading show a quiet
  // ellipsis instead of a false "—". 0 is a real value (sold today).
  const loadingCard = Boolean(sku) && !card && !cardErr;
  const kpiVal = (v) => (loadingCard ? "…" : v == null || v === "" ? "—" : v);
  const aspNote = !card
    ? null
    : card.asp_pct_of_full != null
      ? `${Math.round(card.asp_pct_of_full)}% of full price`
      : card.asp != null
        ? "No full price on file"
        : "No sales in this window";

  return createPortal(
    <div
      className="fixed inset-0 z-[130] bg-black/40 backdrop-blur-sm p-3 sm:p-6 overflow-y-auto"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="mix-colour-detail"
    >
      <div className="card-white w-full max-w-4xl mx-auto my-2 rounded-xl shadow-xl p-5 sm:p-6">
        {/* header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="font-bold text-[19px] leading-snug break-words" data-testid="mix-detail-style">
              {styleName || card?.style_name || "—"}
            </div>
            <div className="text-[13.5px] text-brand">
              {colour}
              {styleNumber ? <span className="text-muted"> · {styleNumber}</span> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-panel text-muted shrink-0"
            title="Close"
            data-testid="mix-detail-close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* KPI cards — lifecycle tier, achieved price vs ticket, recency */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-4" data-testid="mix-detail-kpis">
          <KpiCard
            label="Tier"
            testId="mix-kpi-tier"
            title="Lifecycle tier from the range model (sheet overrides applied)."
          >
            {kpiVal(card?.tier)}
          </KpiCard>
          <KpiCard
            label="Average Selling Price"
            testId="mix-kpi-asp"
            title={
              card
                ? `Achieved price incl. VAT — (sales − discounts) ÷ gross units, all locations, ${card.asp_from} → ${card.asp_to}.`
                : undefined
            }
            note={aspNote}
          >
            {kpiVal(card?.asp != null ? fmtKES(card.asp) : null)}
          </KpiCard>
          <KpiCard
            label="Days since last sale"
            testId="mix-kpi-recency"
            title="Across all locations — not scoped by the tracker's filters."
            note={card?.last_sale ? `Last sold ${fmtDate(card.last_sale)}` : null}
          >
            {kpiVal(card?.days_since_last_sale)}
          </KpiCard>
        </div>

        {/* This-view period metrics — the tracker row the popup was opened from */}
        <div className="rounded-lg border border-border bg-panel/50 p-3 mb-4" data-testid="mix-detail-metrics">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted mb-2">
            This view{period ? ` · ${period.from} → ${period.to}` : ""}
            <span className="ml-1 normal-case font-normal text-muted/80">
              — this colourway's tracker row under the current filters
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2.5">
            <Stat label="Stock on hand" title="Stores + sellable warehouse; pipeline excluded.">
              {fmtNum(m.stock_units)} u
            </Stat>
            <Stat label="Stock value">{fmtKESM(m.stock_value)}</Stat>
            <Stat label="Units sold">{fmtNum(m.units_period)}</Stat>
            <Stat label="Revenue">{fmtKESM(m.revenue_period)}</Stat>
            <Stat label="Sell-through (SOR)" title="Units sold ÷ (units sold + current SOH) — the SOR report's formula.">
              {m.sor == null ? "—" : (
                <span style={{ color: sorColor(m.sor) }}>{fmtSor(m.sor)}</span>
              )}
            </Stat>
            <Stat label="Weeks of cover" title="Stock ÷ trailing-6-month weekly run-rate (÷ 26).">
              {m.woc == null ? "—" : (
                <span style={{ color: wocColor(m.woc) }}>{Number(m.woc).toFixed(1)}w</span>
              )}
            </Stat>
            <Stat label="Last ordered" title="Most recent production/buying order for this exact colourway.">
              {m.last_order_date ? fmtDate(m.last_order_date) : "—"}
            </Stat>
            <Stat label="SKUs stock / sold" title="Distinct SKUs (sizes) with stock on hand / sold in the period.">
              {fmtNum(m.skus_in_stock)} / {fmtNum(m.skus_sold)}
            </Stat>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-[300px,1fr]">
          {/* image — single photo only (first gallery image), click to zoom */}
          <div className="space-y-2">
            <div className="w-full aspect-square overflow-hidden rounded-lg bg-panel grid place-items-center">
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt={caption}
                  className="w-full h-full object-cover cursor-zoom-in"
                  onClick={() => setZoom(true)}
                  data-testid="mix-detail-img"
                />
              ) : sku ? (
                // No Shopify gallery — ProductImage runs the single-image
                // (Odoo) fallback with the Bearer-blob retry, then the
                // placeholder, so preview iframes still show a photo.
                <ProductImage sku={sku} label={caption} size={280} />
              ) : (
                <Placeholder style={caption} size={280} />
              )}
            </div>
          </div>

          {/* master data */}
          <div className="min-w-0">
            {!sku ? (
              <div className="text-[13px] text-muted py-4">
                This colour row has no product-master SKU, so the catalogue
                card (photos, attributes, sizes) isn't available for it.
              </div>
            ) : cardErr ? (
              <ErrorBox message={cardErr} />
            ) : !card ? (
              <Loading label="Loading product details…" />
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {card.status === "Active" && <Chip tone="green">Active</Chip>}
                  {card.status === "Retired" && <Chip tone="red">Retired</Chip>}
                  {card.is_noos && <Chip tone="blue">NOOS</Chip>}
                  {card.tier && <Chip tone="amber">{card.tier}</Chip>}
                </div>

                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="text-[22px] font-bold" data-testid="mix-detail-price">
                    {fmtKES(card.price) || "No price"}
                  </span>
                  {card.launch_date ? (
                    <span className="text-[13px] text-muted">
                      Launched {fmtDate(card.launch_date)}
                      {card.launch_source === "first_sale" ? " (first sale)" : ""}
                    </span>
                  ) : (
                    <span className="text-[13px] text-muted">Not launched yet — no sales recorded</span>
                  )}
                </div>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5" data-testid="mix-detail-attrs">
                  {attrs.map(([k, v]) => (
                    <div key={k} className="min-w-0">
                      <dt className="text-[11px] uppercase tracking-wide text-muted/80">{k}</dt>
                      <dd className="text-[13.5px] font-medium truncate" title={String(v)}>{v}</dd>
                    </div>
                  ))}
                </dl>

                {fabricRows.length > 0 && (
                  <div className="rounded-lg border border-border bg-panel/50 p-3">
                    <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted mb-1.5">Fabric</div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                      {fabricRows.map(([k, v]) => (
                        <div key={k} className="min-w-0">
                          <dt className="text-[10.5px] uppercase tracking-wide text-muted/80">{k}</dt>
                          <dd className="text-[12.5px] font-medium truncate" title={String(v)}>{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* sizes & stock — live, ALL locations (unlike the scoped strip above) */}
        {card && Array.isArray(card.sizes) && card.sizes.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
              <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted">Sizes &amp; stock</div>
              <div className="flex items-center gap-1.5 text-[12px] text-muted">
                {card.totals ? (
                  <span data-testid="mix-detail-soh">
                    {fmtNum(card.totals.soh_total)} on hand
                  </span>
                ) : null}
                {card.totals?.soh_pipeline > 0 && (
                  <Chip tone="muted">+{fmtNum(card.totals.soh_pipeline)} pipeline</Chip>
                )}
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-[12.5px]" data-testid="mix-detail-sizes">
                <thead>
                  <tr className="bg-panel/70 text-left [&>th]:p-2 [&>th]:font-semibold [&>th]:text-muted">
                    <th>Size</th>
                    <th>SKU</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Stores</th>
                    <th className="text-right">Online</th>
                    <th className="text-right">Warehouse</th>
                  </tr>
                </thead>
                <tbody>
                  {card.sizes.map((z) => (
                    <tr key={z.sku} className="border-t border-border">
                      <td className="p-2 font-semibold">{z.size || "—"}</td>
                      <td className="p-2 text-muted">{z.sku}</td>
                      <td className="p-2 text-right">{fmtKES(z.price) || "—"}</td>
                      <td className="p-2 text-right tabular-nums">{z.soh_stores}</td>
                      <td className="p-2 text-right tabular-nums">{z.soh_online ?? 0}</td>
                      <td className="p-2 text-right tabular-nums">{z.soh_warehouse}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-1.5 text-[11px] text-muted/80">
              Live stock across all countries &amp; locations — not scoped by the tracker's filters.
              {card.last_sale ? <> · Last sold {fmtDate(card.last_sale)}</> : null}
            </div>
          </div>
        )}
      </div>

      {zoom && imageUrl && (
        <Lightbox url={imageUrl} caption={caption} onClose={() => setZoom(false)} />
      )}
    </div>,
    document.body,
  );
}
