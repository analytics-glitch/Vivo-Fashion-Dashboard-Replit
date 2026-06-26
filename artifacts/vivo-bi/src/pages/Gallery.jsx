import React, { useEffect, useRef, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { Placeholder, Lightbox } from "@/components/ProductThumbnail";
import { MagnifyingGlass, X } from "@phosphor-icons/react";

const PAGE_SIZE = 48;

/**
 * Card image — a full-width responsive product photo that falls back to the
 * shared coloured-initials Placeholder (the same fallback used elsewhere in
 * the app) when there's no image or the image fails to load.
 */
const CardImage = ({ style, url }) => {
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const show = url && !failed;
  return (
    <>
      <div className="w-full aspect-square overflow-hidden rounded-md bg-panel grid place-items-center">
        {show ? (
          <img
            src={url}
            alt={style}
            loading="lazy"
            className="w-full h-full object-cover cursor-zoom-in"
            onClick={() => setOpen(true)}
            onError={() => setFailed(true)}
            data-testid="gallery-card-image"
          />
        ) : (
          <Placeholder style={style} size={160} />
        )}
      </div>
      {open && show && (
        <Lightbox url={url} caption={style} onClose={() => setOpen(false)} />
      )}
    </>
  );
};

/**
 * Gallery — an image-first product lookup. A single search box matches on
 * style name, SKU or barcode (partial, case-insensitive) and the grid of
 * product cards updates. Empty search shows a default page of products
 * (those with photos first). Results are paginated with a "Load more"
 * button so we never pull the whole catalog at once.
 */
const Gallery = () => {
  const [term, setTerm] = useState("");      // live input value
  const [query, setQuery] = useState("");    // debounced value actually sent
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);    // first/replaced page
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const reqId = useRef(0);

  // Debounce the search box so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(term.trim()), 300);
    return () => clearTimeout(t);
  }, [term]);

  const fetchPage = useCallback(async (q, off, append) => {
    const myReq = ++reqId.current;
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }
    try {
      const { data } = await api.get("/gallery/search", {
        params: { q, limit: PAGE_SIZE, offset: off },
      });
      // Ignore stale responses (a newer search superseded this one).
      if (myReq !== reqId.current) return;
      const next = Array.isArray(data?.items) ? data.items : [];
      setItems((prev) => (append ? [...prev, ...next] : next));
      setHasMore(Boolean(data?.has_more));
      setOffset(off + next.length);
    } catch (e) {
      if (myReq !== reqId.current) return;
      if (!append) setItems([]);
      setError(e?.response?.data?.detail || e.message || "Couldn't load the gallery.");
    } finally {
      if (myReq === reqId.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  // Re-fetch the first page whenever the debounced query changes.
  useEffect(() => {
    setOffset(0);
    fetchPage(query, 0, false);
  }, [query, fetchPage]);

  const loadMore = () => {
    if (loadingMore || !hasMore) return;
    fetchPage(query, offset, true);
  };

  return (
    <div className="space-y-5" data-testid="gallery-page">
      <SectionTitle
        title="Gallery"
        subtitle="Search the catalogue by style name, SKU or barcode to eyeball product photos."
        testId="gallery-header"
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
              data-testid="gallery-search"
              autoFocus
            />
            {term && (
              <button
                type="button"
                onClick={() => setTerm("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-panel text-muted"
                title="Clear"
                data-testid="gallery-search-clear"
              >
                <X size={14} />
              </button>
            )}
          </div>
        }
      />

      {loading ? (
        <Loading label="Loading products…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : items.length === 0 ? (
        <Empty
          label={
            query
              ? `No products match “${query}”.`
              : "No products to show."
          }
        />
      ) : (
        <>
          <div
            className="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
            data-testid="gallery-grid"
          >
            {items.map((p) => (
              <div
                key={`${p.style_name}|${p.sku}`}
                className="card-white p-2.5 flex flex-col gap-2"
                data-testid="gallery-card"
              >
                <CardImage style={p.style_name} url={p.image_url} />
                <div className="min-w-0">
                  <div
                    className="font-semibold text-[12.5px] leading-snug truncate"
                    title={p.style_name}
                  >
                    {p.style_name}
                  </div>
                  <div className="text-[11px] text-muted truncate" title={p.sku}>
                    {p.sku}
                  </div>
                  {p.barcode ? (
                    <div
                      className="text-[10.5px] text-muted/80 truncate font-mono"
                      title={p.barcode}
                    >
                      {p.barcode}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {hasMore && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="text-[13px] px-4 py-2 rounded-md border border-border hover:bg-panel disabled:opacity-50"
                data-testid="gallery-load-more"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default Gallery;
