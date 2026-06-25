import { useState, useEffect, useRef, useMemo } from "react";
import { api } from "@/lib/api";
import ProductDetailModal from "@/components/ProductDetailModal";
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
