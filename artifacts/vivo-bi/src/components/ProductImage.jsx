import { useState, useRef, useEffect } from "react";
import { useProductImages } from "@/lib/useProductImages";
import { Placeholder, fetchAuthedBlob, isApiImageUrl } from "@/components/ProductThumbnail";
import ProductGallery from "@/components/ProductGallery";

/**
 * <ProductImage sku="V0819120BLAS" label="Linen Wrap Dress" size={40} />
 *
 * SKU-keyed product image with the full fallback chain:
 *   1. Shopify gallery primary image (GET /api/product-images/{sku})
 *   2. Odoo single image (GET /api/product-image/{sku})
 *   3. deterministic coloured placeholder
 *
 * The gallery is fetched lazily (only when the element scrolls into view)
 * and cached per-SKU for the session. When a multi-image gallery exists,
 * clicking the thumbnail opens a full carousel lightbox; a lone fallback
 * image opens a single-image view.
 *
 * When a direct <img> load of the API-served fallback fails (cookie-less
 * contexts: workspace preview iframe, Safari third-party cookie blocking),
 * it retries once through the Bearer-authed client and swaps in an object
 * URL — the shared ProductThumbnail blob cache/failure memory.
 */
const ProductImage = ({
  sku,
  label,
  size = 40,
  expandable = true,
  className = "",
}) => {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);
  // Object URL for the API fallback image when the direct load failed in a
  // cookie-blocked context and the Bearer-authed retry succeeded.
  const [blobUrl, setBlobUrl] = useState(null);
  const skuRef = useRef(sku);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Lazy: start fetching only once the thumbnail is near the viewport.
  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin: "150px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [visible]);

  // Reset failure/blob state if the SKU changes (component reuse in lists).
  useEffect(() => {
    skuRef.current = sku;
    setPrimaryFailed(false);
    setFallbackFailed(false);
    setBlobUrl(null);
  }, [sku]);

  const { images, primaryUrl, fallbackUrl, ready } = useProductImages(sku, visible);

  const caption = label || sku || "product";

  // Resolve the fallback chain to the URL actually shown.
  let shownUrl = null;
  let mode = null; // "gallery" | "single"
  if (primaryUrl && !primaryFailed) {
    shownUrl = primaryUrl;
    mode = "gallery";
  } else if ((ready && images.length === 0) || primaryFailed) {
    if (fallbackUrl && !fallbackFailed) {
      shownUrl = blobUrl || fallbackUrl;
      mode = "single";
    }
  }

  const canExpand =
    expandable && (mode === "gallery" || (mode === "single" && !!shownUrl));

  const openGallery = (e) => {
    e?.stopPropagation();
    if (canExpand) setGalleryOpen(true);
  };

  return (
    <>
      <div
        ref={ref}
        className={`relative inline-block rounded-md overflow-hidden border border-border shrink-0 align-middle ${className}`}
        style={{ width: size, height: size }}
        data-testid={`product-image-${sku || "unknown"}`}
      >
        {shownUrl ? (
          <img
            src={shownUrl}
            alt={caption}
            className={`w-full h-full object-cover ${canExpand ? "cursor-zoom-in" : ""}`}
            loading="lazy"
            onError={() => {
              if (mode === "gallery") { setPrimaryFailed(true); return; }
              // Direct load of the API fallback failed — likely a 401 from a
              // cookie-less <img> request (preview iframe / Safari). Retry
              // once through the Bearer-authed client before giving up.
              const failedFor = fallbackUrl;
              if (!blobUrl && isApiImageUrl(failedFor)) {
                fetchAuthedBlob(failedFor).then((obj) => {
                  // Stale-resolution guard: still mounted, same SKU.
                  if (!mountedRef.current || skuRef.current !== sku) return;
                  if (obj) setBlobUrl(obj);
                  else setFallbackFailed(true);
                });
              } else {
                setFallbackFailed(true);
              }
            }}
            onClick={canExpand ? openGallery : undefined}
          />
        ) : (
          <Placeholder style={caption} size={size} />
        )}
      </div>

      {galleryOpen ? (
        <ProductGallery
          images={
            mode === "gallery" && images.length
              ? images
              : shownUrl
                ? [{ url: shownUrl, position: 1, is_primary: true }]
                : []
          }
          caption={caption}
          onClose={() => setGalleryOpen(false)}
        />
      ) : null}
    </>
  );
};

export default ProductImage;
