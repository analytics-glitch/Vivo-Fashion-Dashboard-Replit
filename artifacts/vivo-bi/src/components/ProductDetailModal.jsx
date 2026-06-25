import { useState, useEffect } from "react";
import { api, fmtNum } from "@/lib/api";
import { useThumbnails } from "@/lib/useThumbnails";
import ProductThumbnail from "@/components/ProductThumbnail";
import { X } from "@phosphor-icons/react";

const Field = ({ label, children }) => (
  <div>
    <div className="text-[10.5px] uppercase tracking-wider text-muted">{label}</div>
    <div className="text-[13px] font-medium mt-0.5 break-words">{children ?? "—"}</div>
  </div>
);

// Shared product-detail popup used by the finder search box and the
// category drill-down tree. Resolves the variant via /product-detail.
const ProductDetailModal = ({ sku, barcode, onClose }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr("");
    const params = sku ? { sku } : { barcode };
    api
      .get("/product-detail", { params })
      .then(({ data }) => { if (alive) setData(data); })
      .catch((e) => { if (alive) setErr(e?.response?.data?.detail || "Couldn't load this product"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sku, barcode]);

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const { urlFor } = useThumbnails(data?.style_name ? [data.style_name] : []);
  const photoUrl = data?.style_name ? urlFor(data.style_name) : null;

  const lastSale = (() => {
    if (!data) return null;
    if (data.days_since_last_sale == null) return "Never sold";
    const d = data.days_since_last_sale;
    const when = data.last_sale ? ` (${data.last_sale})` : "";
    return `${fmtNum(d)} day${d === 1 ? "" : "s"} ago${when}`;
  })();

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/45 backdrop-blur-sm p-4"
      onClick={onClose}
      data-testid="product-detail-backdrop"
    >
      <div
        className="card-white p-5 w-full max-w-lg space-y-4"
        onClick={(e) => e.stopPropagation()}
        data-testid="product-detail-modal"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10.5px] uppercase tracking-wider text-muted">Product detail</div>
            <div className="font-semibold text-[16px] mt-0.5 break-words">
              {loading ? "Loading…" : (data?.product_name || data?.style_name || "—")}
            </div>
            {data?.barcode ? (
              <div className="text-[11px] text-muted mt-0.5">Barcode {data.barcode}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-panel shrink-0"
            data-testid="product-detail-close"
          >
            <X size={18} />
          </button>
        </div>

        {err ? (
          <div className="text-[13px] text-red-700 py-6 text-center">{err}</div>
        ) : loading ? (
          <div className="text-[13px] text-muted py-10 text-center">Loading product…</div>
        ) : data ? (
          <div className="flex gap-4">
            <ProductThumbnail style={data.style_name || data.product_name || "?"} url={photoUrl} size={120} />
            <div className="flex-1 grid grid-cols-2 gap-x-4 gap-y-3">
              <Field label="Style">{data.style_name || "—"}</Field>
              <Field label="Colour">{data.color || "—"}</Field>
              <Field label="Size">{data.size || "—"}</Field>
              <Field label="Subcategory">{data.subcategory || "—"}</Field>
              <Field label="Brand">{data.brand || "—"}</Field>
              <Field label="SKU">{data.sku || "—"}</Field>
              <Field label="Stock on hand">
                {fmtNum(data.soh_total || 0)}
                <span className="text-[11px] text-muted font-normal">
                  {" "}({fmtNum(data.soh_stores || 0)} stores · {fmtNum(data.soh_warehouse || 0)} wh)
                </span>
              </Field>
              <Field label="Days since last sale">{lastSale}</Field>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ProductDetailModal;
