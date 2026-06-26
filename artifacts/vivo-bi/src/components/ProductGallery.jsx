import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { CaretLeft, CaretRight, X } from "@phosphor-icons/react";

/**
 * ProductGallery — full-screen lightbox carousel for a SKU's Shopify
 * image gallery. Prev/next buttons, keyboard arrows, a thumbnail strip,
 * and Esc / click-outside to close. Renders nothing if there are no
 * images.
 */
const ProductGallery = ({ images = [], caption, startIndex = 0, onClose }) => {
  const count = images.length;
  const [idx, setIdx] = useState(
    Math.min(Math.max(startIndex, 0), Math.max(count - 1, 0)),
  );

  const go = useCallback(
    (delta) => {
      if (count === 0) return;
      setIdx((i) => (i + delta + count) % count);
    },
    [count],
  );

  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = prev;
    };
  }, [onClose, go]);

  if (count === 0) return null;
  const current = images[idx];

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
      data-testid="product-gallery"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
        title="Close"
        data-testid="product-gallery-close"
      >
        <X size={22} />
      </button>

      <div
        className="flex flex-col items-center gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex items-center justify-center">
          {count > 1 ? (
            <button
              type="button"
              onClick={() => go(-1)}
              className="absolute left-2 sm:-left-14 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
              title="Previous"
              data-testid="product-gallery-prev"
            >
              <CaretLeft size={22} />
            </button>
          ) : null}

          <img
            src={current.url}
            alt={caption ? `${caption} (${idx + 1}/${count})` : `image ${idx + 1}`}
            className="max-w-[92vw] max-h-[72vh] object-contain rounded-lg shadow-2xl bg-white"
          />

          {count > 1 ? (
            <button
              type="button"
              onClick={() => go(1)}
              className="absolute right-2 sm:-right-14 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
              title="Next"
              data-testid="product-gallery-next"
            >
              <CaretRight size={22} />
            </button>
          ) : null}
        </div>

        {caption ? (
          <div className="text-white/90 text-sm text-center max-w-[92vw] break-words">
            {caption}
            {count > 1 ? (
              <span className="text-white/60"> · {idx + 1} of {count}</span>
            ) : null}
          </div>
        ) : null}

        {count > 1 ? (
          <div className="flex items-center gap-2 max-w-[92vw] overflow-x-auto pb-1">
            {images.map((img, i) => (
              <button
                key={img.url || i}
                type="button"
                onClick={() => setIdx(i)}
                className={`shrink-0 rounded-md overflow-hidden border-2 transition-colors ${
                  i === idx ? "border-white" : "border-transparent opacity-60 hover:opacity-100"
                }`}
                style={{ width: 56, height: 56 }}
                title={`Image ${i + 1}`}
                data-testid={`product-gallery-thumb-${i}`}
              >
                <img
                  src={img.url}
                  alt={`thumbnail ${i + 1}`}
                  className="w-full h-full object-cover bg-white"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
};

export default ProductGallery;
