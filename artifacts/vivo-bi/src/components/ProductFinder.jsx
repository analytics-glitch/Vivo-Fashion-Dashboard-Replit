import { useState, useEffect, useRef, useMemo } from "react";
import { api, fmtNum } from "@/lib/api";
import { useThumbnails } from "@/lib/useThumbnails";
import ProductThumbnail from "@/components/ProductThumbnail";
import { MagnifyingGlass, X } from "@phosphor-icons/react";

// Small debounce so we don't fire a request on every keystroke.
const useDebounced = (value, delay = 250) => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
};

const Field = ({ label, children }) => (
  <div>
    <div className="text-[10.5px] uppercase tracking-wider text-muted">{label}</div>
    <div className="text-[13px] font-medium mt-0.5 break-words">{children ?? "—"}</div>
  </div>
);

// ─── detail popup ──────────────────────────────────────────────────────
const ProductDetailModal = ({ sku, onClose }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr("");
    api
      .get("/product-detail", { params: { sku } })
      .then(({ data }) => { if (alive) setData(data); })
      .catch((e) => { if (alive) setErr(e?.response?.data?.detail || "Couldn't load this product"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sku]);

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

// ─── search box + dropdown ─────────────────────────────────────────────
const ProductFinder = () => {
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 250);
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const boxRef = useRef(null);

  useEffect(() => {
    const term = debounced.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .get("/product-search", { params: { q: term } })
      .then(({ data }) => {
        if (alive) {
          setResults(data?.options || []);
          setOpen(true);
        }
      })
      .catch(() => { if (alive) setResults([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [debounced]);

  useEffect(() => {
    const h = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Group variant rows under their style, so the dropdown reads style > SKU/barcode.
  const groups = useMemo(() => {
    const m = new Map();
    (results || []).forEach((r) => {
      const key = r.style_name || r.product_name || "—";
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    });
    return Array.from(m.entries());
  }, [results]);

  return (
    <div className="relative mb-3" ref={boxRef} data-testid="product-finder">
      <div className="relative w-full md:w-[28rem]">
        <MagnifyingGlass
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
        />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => { if (results.length) setOpen(true); }}
          placeholder="Find a product by style, SKU or barcode…"
          className="w-full border border-border rounded-md pl-9 pr-8 py-2 text-[13px] outline-none focus:border-brand"
          data-testid="product-finder-input"
        />
        {q ? (
          <button
            type="button"
            onClick={() => { setQ(""); setResults([]); setOpen(false); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-panel text-muted"
            title="Clear"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      {open && (loading || results.length > 0 || debounced.trim().length >= 2) ? (
        <div
          className="absolute z-30 mt-1 w-full md:w-[28rem] max-h-80 overflow-auto card-white shadow-lg p-1"
          data-testid="product-finder-results"
        >
          {loading ? (
            <div className="px-3 py-2 text-muted text-[12px]">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-muted text-[12px]">No matches</div>
          ) : (
            groups.map(([style, items]) => (
              <div key={style} className="mb-1">
                <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-wider text-muted font-semibold break-words">
                  {style}
                </div>
                {items.map((it) => (
                  <button
                    key={it.sku}
                    type="button"
                    onClick={() => { setSelected(it.sku); setOpen(false); }}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-panel flex items-center justify-between gap-2"
                    data-testid={`product-finder-option-${it.sku}`}
                  >
                    <span className="text-[12.5px] min-w-0 truncate">
                      <span className="font-medium">{it.sku}</span>
                      {it.size ? <span className="text-muted"> · {it.size}</span> : null}
                      {it.color ? <span className="text-muted"> · {it.color}</span> : null}
                    </span>
                    {it.barcode ? (
                      <span className="text-[11px] text-muted shrink-0 font-mono">{it.barcode}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}

      {selected ? (
        <ProductDetailModal sku={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
};

export default ProductFinder;
