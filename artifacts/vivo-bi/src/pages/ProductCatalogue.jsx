import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { Placeholder, Lightbox } from "@/components/ProductThumbnail";
import { MagnifyingGlass, X, FunnelSimple } from "@phosphor-icons/react";

const PAGE_SIZE = 48;

const fmtKES = (v) =>
  v == null || Number.isNaN(Number(v)) ? null : "KES " + Math.round(Number(v)).toLocaleString();

const fmtDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

const fmtMonthYear = (iso) => {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
};

/** Card image — full-width product photo falling back to the shared
 *  coloured-initials Placeholder. The whole card is clickable (opens the
 *  product detail popup), so the image itself carries no handler. */
const CardImage = ({ style, url }) => {
  const [failed, setFailed] = useState(false);
  const show = url && !failed;
  return (
    <div className="w-full h-[192px] overflow-hidden rounded-md bg-[#F5F5F0] grid place-items-center">
      {show ? (
        <img
          src={url}
          alt={style}
          loading="lazy"
          className="w-full h-full object-contain"
          onError={() => setFailed(true)}
          data-testid="catalogue-card-image"
        />
      ) : (
        <Placeholder style={style} size={160} />
      )}
    </div>
  );
};

/** One catalogue card: photo, style, colour, price + launch date. */
const CatalogueCard = ({ p, onOpen }) => (
  <button
    type="button"
    onClick={() => onOpen(p)}
    className="card-white p-2.5 flex flex-col gap-2 text-left relative cursor-pointer transition-shadow hover:shadow-md hover:ring-1 hover:ring-brand/40 focus:outline-none focus:ring-2 focus:ring-brand/50"
    data-testid={`card-style-${p.sku}`}
  >
    {p.status === "Retired" && (
      <span className="absolute top-4 left-4 z-[1] text-[10px] font-semibold uppercase tracking-wide bg-black/70 text-white rounded px-1.5 py-0.5">
        Retired
      </span>
    )}
    <CardImage style={p.style_name} url={p.image_url} />
    <div className="min-w-0">
      <div className="font-semibold text-[12.5px] leading-snug truncate" title={p.style_name}>
        {p.style_name}
      </div>
      {p.color ? (
        <div className="text-[11px] text-brand truncate" title={p.color}>
          {p.color}
        </div>
      ) : null}
      <div className="flex items-baseline justify-between gap-2 mt-0.5">
        <span className="text-[11.5px] font-semibold" data-testid={`text-price-${p.sku}`}>
          {fmtKES(p.price) || "—"}
        </span>
        {p.launch_date ? (
          <span className="text-[10.5px] text-muted whitespace-nowrap" title={`Launched ${fmtDate(p.launch_date)}`}>
            {fmtMonthYear(p.launch_date)}
          </span>
        ) : null}
      </div>
      {(p.category || p.subcategory) ? (
        <div className="text-[10.5px] text-muted/80 truncate" title={[p.category, p.subcategory].filter(Boolean).join(" · ")}>
          {[p.category, p.subcategory].filter(Boolean).join(" · ")}
        </div>
      ) : null}
    </div>
  </button>
);

const Chip = ({ tone = "muted", children, testId }) => {
  const tones = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    red: "bg-rose-50 text-rose-700 border-rose-200",
    blue: "bg-sky-50 text-sky-700 border-sky-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    muted: "bg-panel text-muted border-border",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[12px] font-semibold ${tones[tone] || tones.muted}`}
      data-testid={testId}
    >
      {children}
    </span>
  );
};

/** Product detail popup — everything we know about one style+colour:
 *  photos, master-data attributes, launch, fabric block and a per-size
 *  size/SKU/barcode/stock table. Rendered via portal so no ancestor
 *  transform/sticky header can paint over it. */
const ProductDetailModal = ({ product, onClose }) => {
  const [card, setCard] = useState(null);
  const [cardErr, setCardErr] = useState(null);
  const [images, setImages] = useState(product.image_url ? [product.image_url] : []);
  const [imgIdx, setImgIdx] = useState(0);
  const [zoom, setZoom] = useState(false);
  const zoomRef = useRef(false);
  zoomRef.current = zoom;

  useEffect(() => {
    let dead = false;
    setCard(null);
    setCardErr(null);
    setImgIdx(0);
    setImages(product.image_url ? [product.image_url] : []);
    api
      .get("/gallery/style-card", { params: { sku: product.sku } })
      .then(({ data }) => { if (!dead) setCard(data); })
      .catch((e) => {
        if (!dead) setCardErr(e?.response?.data?.detail || e.message || "Couldn't load product details.");
      });
    api
      .get(`/product-images/${encodeURIComponent(product.sku)}`)
      .then(({ data }) => {
        if (dead) return;
        const urls = Array.isArray(data?.images) ? data.images.map((im) => im?.url).filter(Boolean) : [];
        if (urls.length) { setImages(urls); setImgIdx(0); }
      })
      .catch(() => {}); // keep the card thumbnail on failure
    return () => { dead = true; };
  }, [product]);

  // Esc closes the zoom lightbox first (it sits above), then the modal.
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
      ["Style #", card.style_number],
      ["Brand", card.brand],
      ["Category", card.category],
      ["Sub-category", card.subcategory],
      ["Collection", card.collection],
      ["Gender", card.gender],
      ["Season", card.season],
      ["Print / Plain", card.print_plain],
      ["Vendor", card.vendor],
    ].filter(([, v]) => (v || "").toString().trim() !== "");
  }, [card]);

  const fabric = card?.fabric && Object.keys(card.fabric).length ? card.fabric : null;
  const fabricRows = fabric
    ? [
        ["Structure", fabric.fabric_structure],
        ["Fabric category", fabric.fabric_category],
        ["Fabric sub-category", fabric.fabric_subcategory],
        ["Fibre content", fabric.fiber_content],
        ["GSM", fabric.gsm],
        ["Width", fabric.fabric_width],
        ["Source", [fabric.source_city, fabric.source_country].filter(Boolean).join(", ")],
        ["Supplier fabric code", fabric.supplier_fabric_code],
        ["NOOS fabric", fabric.noos_fabric],
      ].filter(([, v]) => (v || "").toString().trim() !== "")
    : [];

  const totals = card?.totals || null;
  const stepImg = (dir) =>
    setImgIdx((cur) => (images.length ? (cur + dir + images.length) % images.length : cur));

  return createPortal(
    <div
      className="fixed inset-0 z-[130] bg-black/40 backdrop-blur-sm p-3 sm:p-6 overflow-y-auto"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="modal-product-detail"
    >
      <div className="card-white w-full max-w-5xl mx-auto my-2 rounded-xl shadow-xl p-5 sm:p-7">
        {/* header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="font-bold text-[20px] leading-snug" data-testid="text-detail-style">
              {card?.style_name || product.style_name}
            </div>
            <div className="text-[14px] text-brand">
              {(card?.color || product.color) || ""}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-panel text-muted shrink-0"
            title="Close"
            data-testid="button-close-detail"
          >
            <X size={20} />
          </button>
        </div>

        <div className="grid gap-6 md:grid-cols-[340px,1fr]">
          {/* images */}
          <div className="space-y-2">
            <div className="w-full aspect-square overflow-hidden rounded-lg bg-[#F5F5F0] grid place-items-center">
              {images.length ? (
                <img
                  src={images[imgIdx]}
                  alt={product.style_name}
                  className="w-full h-full object-contain cursor-zoom-in"
                  onClick={() => setZoom(true)}
                  data-testid="img-detail-main"
                />
              ) : (
                <Placeholder style={product.style_name} size={280} />
              )}
            </div>
            {images.length > 1 && (
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {images.map((u, i) => (
                  <img
                    key={u}
                    src={u}
                    alt=""
                    onClick={() => setImgIdx(i)}
                    className={`h-14 w-14 rounded-md object-contain bg-[#F5F5F0] cursor-pointer border ${i === imgIdx ? "border-brand" : "border-border opacity-70 hover:opacity-100"}`}
                    data-testid={`img-detail-thumb-${i}`}
                  />
                ))}
              </div>
            )}
          </div>

          {/* attributes */}
          <div className="min-w-0">
            {cardErr ? (
              <ErrorBox message={cardErr} />
            ) : !card ? (
              <Loading label="Loading product details…" />
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {card.status === "Active" && <Chip tone="green" testId="chip-status">Active</Chip>}
                  {card.status === "Retired" && <Chip tone="red" testId="chip-status">Retired</Chip>}
                  {card.is_noos && <Chip tone="blue" testId="chip-noos">NOOS</Chip>}
                  {card.tier && <Chip tone="amber" testId="chip-tier">{card.tier}</Chip>}
                </div>

                <div className="flex items-baseline gap-3">
                  <span className="text-[24px] font-bold" data-testid="text-detail-price">
                    {fmtKES(card.price) || "No price"}
                  </span>
                  {card.launch_date ? (
                    <span className="text-[13.5px] text-muted" data-testid="text-detail-launch">
                      Launched {fmtDate(card.launch_date)}
                      {card.launch_source === "first_sale" ? " (first sale)" : ""}
                    </span>
                  ) : (
                    <span className="text-[13.5px] text-muted">Not launched yet — no sales recorded</span>
                  )}
                </div>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5" data-testid="list-detail-attrs">
                  {attrs.map(([k, v]) => (
                    <div key={k} className="min-w-0">
                      <dt className="text-[12px] uppercase tracking-wide text-muted/80">{k}</dt>
                      <dd className="text-[14.5px] font-medium truncate" title={String(v)}>{v}</dd>
                    </div>
                  ))}
                </dl>

                {fabricRows.length > 0 && (
                  <div className="rounded-lg border border-border bg-panel/50 p-3">
                    <div className="text-[12.5px] font-semibold uppercase tracking-wide text-muted mb-1.5">Fabric</div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5" data-testid="list-detail-fabric">
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

        {/* sizes & stock */}
        {card && Array.isArray(card.sizes) && card.sizes.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[12.5px] font-semibold uppercase tracking-wide text-muted">Sizes &amp; stock</div>
              {totals && (
                <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
                  <span data-testid="text-detail-soh">
                    {totals.soh_total?.toLocaleString?.() ?? totals.soh_total} on hand
                  </span>
                  {totals.soh_pipeline > 0 && (
                    <Chip tone="muted" testId="chip-pipeline">+{totals.soh_pipeline.toLocaleString()} pipeline</Chip>
                  )}
                </div>
              )}
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-[13.5px]" data-testid="table-detail-sizes">
                <thead>
                  <tr className="bg-panel/70 text-left [&>th]:p-2.5 [&>th]:font-semibold [&>th]:text-muted">
                    <th>Size</th>
                    <th>SKU</th>
                    <th>Barcode</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Stores</th>
                    <th className="text-right">Online</th>
                    <th className="text-right">Warehouse</th>
                  </tr>
                </thead>
                <tbody>
                  {card.sizes.map((z) => (
                    <tr key={z.sku} className="border-t border-border" data-testid={`row-size-${z.sku}`}>
                      <td className="p-2 font-semibold">{z.size || "—"}</td>
                      <td className="p-2 text-muted">{z.sku}</td>
                      <td className="p-2 font-mono text-[12.5px] text-muted">{z.barcode || "—"}</td>
                      <td className="p-2 text-right">{fmtKES(z.price) || "—"}</td>
                      <td className="p-2 text-right tabular-nums">{z.soh_stores}</td>
                      <td className="p-2 text-right tabular-nums">{z.soh_online ?? 0}</td>
                      <td className="p-2 text-right tabular-nums">{z.soh_warehouse}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(card.first_sale || card.last_sale) && (
              <div className="mt-2 text-[12.5px] text-muted" data-testid="text-detail-sales-meta">
                {card.first_sale ? <>First sold {fmtDate(card.first_sale)}</> : null}
                {card.first_sale && card.last_sale ? " · " : null}
                {card.last_sale ? (
                  <>
                    Last sold {fmtDate(card.last_sale)}
                    {card.days_since_last_sale != null ? ` (${card.days_since_last_sale}d ago)` : ""}
                  </>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>

      {zoom && images.length > 0 && (
        <Lightbox
          url={images[imgIdx]}
          caption={
            images.length > 1
              ? `${product.style_name} · ${imgIdx + 1} / ${images.length}`
              : product.style_name
          }
          onClose={() => setZoom(false)}
          onPrev={images.length > 1 ? () => stepImg(-1) : undefined}
          onNext={images.length > 1 ? () => stepImg(1) : undefined}
          thumbnails={images.length > 1 ? images : undefined}
          activeIndex={imgIdx}
          onSelect={(i) => setImgIdx(i)}
        />
      )}
    </div>,
    document.body,
  );
};

/**
 * Product Catalogue — the image-first browse/search surface for the whole
 * range. Search matches style name, SKU or barcode; category / sub-category
 * dropdowns narrow the grid; clicking any card opens the full product
 * detail popup (attributes, fabric, launch date, sizes + live stock).
 */
const ProductCatalogue = () => {
  const [term, setTerm] = useState("");
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("");
  const [subcat, setSubcat] = useState("");
  const [brand, setBrand] = useState("");
  const [facets, setFacets] = useState(null);      // {categories:[{name,styles,subcategories:[…]}]}
  const [facetsErr, setFacetsErr] = useState(false);
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(null);      // product for the detail popup
  const reqId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQuery(term.trim()), 300);
    return () => clearTimeout(t);
  }, [term]);

  useEffect(() => {
    let dead = false;
    api
      .get("/gallery/facets")
      .then(({ data }) => { if (!dead) setFacets(data); })
      .catch(() => { if (!dead) setFacetsErr(true); });
    return () => { dead = true; };
  }, []);

  const fetchPage = useCallback(async (q, c, sc, br, off, append) => {
    const myReq = ++reqId.current;
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }
    try {
      const { data } = await api.get("/gallery/search", {
        params: { q, category: c, subcategory: sc, brand: br, limit: PAGE_SIZE, offset: off },
      });
      if (myReq !== reqId.current) return;
      const next = Array.isArray(data?.items) ? data.items : [];
      setItems((prev) => (append ? [...prev, ...next] : next));
      setHasMore(Boolean(data?.has_more));
      setOffset(off + next.length);
    } catch (e) {
      if (myReq !== reqId.current) return;
      if (!append) setItems([]);
      setError(e?.response?.data?.detail || e.message || "Couldn't load the catalogue.");
    } finally {
      if (myReq === reqId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    setOffset(0);
    fetchPage(query, cat, subcat, brand, 0, false);
  }, [query, cat, subcat, brand, fetchPage]);

  const loadMore = () => {
    if (loadingMore || !hasMore) return;
    fetchPage(query, cat, subcat, brand, offset, true);
  };

  const activeCat = facets?.categories?.find((c) => c.name === cat) || null;
  const anyFilter = Boolean(query || cat || subcat || brand);

  return (
    <div className="space-y-4" data-testid="catalogue-page">
      <SectionTitle
        title="Product Catalogue"
        subtitle="Browse the range with photos, prices and launch dates — click any product for its full details."
        testId="catalogue-header"
        action={
          <div className="relative w-full sm:w-80">
            <MagnifyingGlass
              size={16}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            />
            <input
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search style, SKU or barcode…"
              className="w-full border border-border rounded-md pl-8 pr-8 py-2 text-[13px] outline-none focus:border-brand bg-card"
              data-testid="catalogue-search"
              autoFocus
            />
            {term && (
              <button
                type="button"
                onClick={() => setTerm("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-panel text-muted"
                title="Clear"
                data-testid="catalogue-search-clear"
              >
                <X size={14} />
              </button>
            )}
          </div>
        }
      />

      {/* brand / category / sub-category filters */}
      <div className="flex flex-wrap items-center gap-2" data-testid="catalogue-filters">
        <FunnelSimple size={15} className="text-muted" />
        {(facets?.brands || []).length > 1 && (
          <select
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="border border-border rounded-md px-2.5 py-1.5 text-[12.5px] bg-card outline-none focus:border-brand max-w-[180px]"
            data-testid="select-brand"
          >
            <option value="">All brands</option>
            {(facets.brands).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name} ({b.styles})
              </option>
            ))}
          </select>
        )}
        <select
          value={cat}
          onChange={(e) => { setCat(e.target.value); setSubcat(""); }}
          className="border border-border rounded-md px-2.5 py-1.5 text-[12.5px] bg-card outline-none focus:border-brand max-w-[220px]"
          data-testid="select-category"
        >
          <option value="">All categories</option>
          {(facets?.categories || []).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.styles})
            </option>
          ))}
        </select>
        <select
          value={subcat}
          onChange={(e) => setSubcat(e.target.value)}
          disabled={!activeCat}
          className="border border-border rounded-md px-2.5 py-1.5 text-[12.5px] bg-card outline-none focus:border-brand disabled:opacity-50 max-w-[220px]"
          data-testid="select-subcategory"
        >
          <option value="">All sub-categories</option>
          {(activeCat?.subcategories || []).map((s) => (
            <option key={s.name} value={s.name}>
              {s.name} ({s.styles})
            </option>
          ))}
        </select>
        {anyFilter && (
          <button
            type="button"
            onClick={() => { setTerm(""); setCat(""); setSubcat(""); setBrand(""); }}
            className="text-[12px] text-brand hover:underline"
            data-testid="button-clear-filters"
          >
            Clear filters
          </button>
        )}
        {facetsErr && (
          <span className="text-[11px] text-muted">Category filters unavailable right now.</span>
        )}
      </div>

      {loading ? (
        <Loading label="Loading products…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : items.length === 0 ? (
        <Empty
          label={
            anyFilter
              ? "No products match the current search / filters."
              : "No products to show."
          }
        />
      ) : (
        <>
          <div
            className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
            data-testid="catalogue-grid"
          >
            {items.map((p) => (
              <CatalogueCard key={`${p.style_name}|${p.sku}`} p={p} onOpen={setActive} />
            ))}
          </div>

          {hasMore && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="text-[13px] px-4 py-2 rounded-md border border-border hover:bg-panel disabled:opacity-50"
                data-testid="catalogue-load-more"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}

      {active && <ProductDetailModal product={active} onClose={() => setActive(null)} />}
    </div>
  );
};

export default ProductCatalogue;
