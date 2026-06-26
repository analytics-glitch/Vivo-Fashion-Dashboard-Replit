import { useEffect, useState } from "react";
import { api } from "@/lib/api";

// ─── session cache for SKU image galleries ────────────────────────────
// Map<sku, Array<{url, position, is_primary}>>  — [] means "confirmed none".
// Module-level so the same SKU never re-fetches across tables / popups.
const CACHE = new Map();
const IN_FLIGHT = new Map(); // Map<sku, Promise>

// Every mounted hook subscribes; a resolved fetch notifies all of them so
// instances that mounted a SKU *while it was already in flight* (and thus
// didn't start the request) still re-render when the cache fills.
const LISTENERS = new Set();
const notify = () => { LISTENERS.forEach((fn) => fn()); };

// The Odoo single-image endpoint serves raw JPEG bytes behind the global
// auth middleware. Used directly as an <img src> (browser sends the
// session cookie), so it must carry the leading /api prefix.
export const odooImageUrl = (sku) =>
  sku ? `/api/product-image/${encodeURIComponent(sku)}` : null;

const fetchGallery = (sku) => {
  if (CACHE.has(sku) || IN_FLIGHT.has(sku)) return;
  const p = api
    .get(`/product-images/${encodeURIComponent(sku)}`)
    .then(({ data }) => {
      const imgs = Array.isArray(data?.images) ? data.images : [];
      CACHE.set(sku, imgs);
    })
    .catch(() => {
      // Treat any failure as "no gallery" so we fall through to the
      // single-image fallback and stop retrying this session.
      CACHE.set(sku, []);
    })
    .finally(() => {
      IN_FLIGHT.delete(sku);
      notify();
    });
  IN_FLIGHT.set(sku, p);
};

/**
 * useProductImages — lazily fetch a SKU's Shopify image gallery from
 * `GET /api/product-images/{sku}`. Pass `enabled=false` until the row /
 * card is actually visible so we don't fan out thousands of requests.
 *
 * Results are memoised in a module-level cache for the session. The
 * endpoint already resolves the leading-V SKU mismatch in both
 * directions, so pass the SKU exactly as it appears in the data.
 *
 * Returns the ordered gallery plus the Odoo single-image fallback URL.
 * The fallback is only meaningful once the gallery is confirmed empty;
 * the consuming component owns the gallery → single → placeholder chain.
 */
export const useProductImages = (sku, enabled = true) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    LISTENERS.add(fn);
    return () => { LISTENERS.delete(fn); };
  }, []);

  useEffect(() => {
    if (!enabled || !sku) return;
    fetchGallery(sku);
  }, [sku, enabled]);

  const ready = !!(enabled && sku && CACHE.has(sku));
  const images = ready ? CACHE.get(sku) : [];
  const primaryUrl = images.length ? images[0].url : null;

  return {
    images,
    primaryUrl,
    fallbackUrl: odooImageUrl(sku),
    ready,
  };
};
