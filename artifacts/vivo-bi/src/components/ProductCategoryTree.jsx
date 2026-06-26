import { useState, useEffect, useCallback } from "react";
import { api, fmtNum } from "@/lib/api";
import ProductDetailModal from "@/components/ProductDetailModal";
import ProductImage from "@/components/ProductImage";
import { CaretRight, CaretDown } from "@phosphor-icons/react";

// One lazily-expandable node. Fetches its children from /product-tree only
// the first time it is opened, then caches them. Depth drives indentation and
// which params the child query receives.
//   depth 0 = category, 1 = subcategory, 2 = style, 3 = variant (leaf)
const LEVEL_LABEL = ["category", "subcategory", "style", "variant"];

const Node = ({ depth, label, path, onPick }) => {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState(null); // null = not loaded
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const isLeafLevel = depth >= 3; // variants themselves never expand

  const load = useCallback(() => {
    setLoading(true);
    setErr("");
    api
      .get("/product-tree", {
        params: {
          category: path.category ?? "",
          subcategory: path.subcategory ?? "",
          style: path.style ?? "",
        },
      })
      .then(({ data }) => setChildren(data?.items || []))
      .catch(() => setErr("Couldn't load"))
      .finally(() => setLoading(false));
  }, [path.category, path.subcategory, path.style]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && children === null && !loading) load();
  };

  const display = label === "" ? "Uncategorised" : label;
  const pad = { paddingLeft: `${depth * 16 + 8}px` };

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        style={pad}
        className="w-full flex items-center gap-1.5 py-1.5 pr-2 text-left rounded hover:bg-panel"
        data-testid={`tree-node-${depth}`}
      >
        {open ? <CaretDown size={13} className="shrink-0 text-muted" /> : <CaretRight size={13} className="shrink-0 text-muted" />}
        <span className={depth === 0 ? "text-[13px] font-semibold" : "text-[12.5px]"}>{display}</span>
      </button>

      {open ? (
        <div>
          {loading ? (
            <div style={{ paddingLeft: `${(depth + 1) * 16 + 22}px` }} className="py-1.5 text-[12px] text-muted">Loading…</div>
          ) : err ? (
            <div style={{ paddingLeft: `${(depth + 1) * 16 + 22}px` }} className="py-1.5 text-[12px] text-red-700">
              {err} · <button type="button" className="underline" onClick={load}>retry</button>
            </div>
          ) : children && children.length === 0 ? (
            <div style={{ paddingLeft: `${(depth + 1) * 16 + 22}px` }} className="py-1.5 text-[12px] text-muted">Nothing here</div>
          ) : children ? (
            depth >= 2 ? (
              // Leaf level: variants (SKU / barcode) — click opens the popup.
              children.map((v) => (
                <button
                  key={v.sku}
                  type="button"
                  onClick={() => onPick(v.sku)}
                  style={{ paddingLeft: `${(depth + 1) * 16 + 22}px` }}
                  className="w-full flex items-center justify-between gap-2 py-1.5 pr-2 text-left rounded hover:bg-panel"
                  data-testid={`tree-variant-${v.sku}`}
                >
                  <span className="text-[12.5px] min-w-0 truncate flex items-center gap-1.5">
                    <ProductImage sku={v.sku} label={v.style_name || v.sku} size={28} expandable={false} />
                    <span className="font-medium">{v.sku}</span>
                    {v.size ? <span className="text-muted"> · {v.size}</span> : null}
                    {v.color ? <span className="text-muted"> · {v.color}</span> : null}
                  </span>
                  {v.barcode ? (
                    <span className="text-[11px] text-muted shrink-0 font-mono">{v.barcode}</span>
                  ) : null}
                </button>
              ))
            ) : (
              children.map((c) => {
                // `path` already carries this node's own level; its children
                // are one level deeper, so set the NEXT level's field.
                const childPath = { ...path };
                if (depth === 0) childPath.subcategory = c.val;
                else if (depth === 1) childPath.style = c.val;
                return (
                  <div key={`${LEVEL_LABEL[depth + 1]}:${c.val}`} className="flex items-center">
                    <div className="flex-1 min-w-0">
                      <Node depth={depth + 1} label={c.val} path={childPath} onPick={onPick} />
                    </div>
                  </div>
                );
              })
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// Top-level: fetches the category list, renders each as an expandable Node.
const ProductCategoryTree = () => {
  const [cats, setCats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr("");
    api
      .get("/product-tree")
      .then(({ data }) => setCats(data?.items || []))
      .catch(() => setErr("Couldn't load categories"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mb-4" data-testid="product-category-tree">
      <div className="text-[11px] uppercase tracking-wider text-muted font-semibold mb-1.5">
        Browse by category
      </div>
      <div className="border border-border rounded-md max-h-[26rem] overflow-auto bg-card divide-y divide-border/60">
        {loading ? (
          <div className="px-3 py-3 text-[12.5px] text-muted">Loading categories…</div>
        ) : err ? (
          <div className="px-3 py-3 text-[12.5px] text-red-700">
            {err} · <button type="button" className="underline" onClick={load}>retry</button>
          </div>
        ) : cats && cats.length ? (
          cats.map((c) => (
            <Node
              key={`category:${c.val}`}
              depth={0}
              label={c.val}
              path={{ category: c.val }}
              onPick={setPicked}
            />
          ))
        ) : (
          <div className="px-3 py-3 text-[12.5px] text-muted">No products found</div>
        )}
      </div>

      {picked ? (
        <ProductDetailModal sku={picked} onClose={() => setPicked(null)} />
      ) : null}
    </div>
  );
};

export default ProductCategoryTree;
