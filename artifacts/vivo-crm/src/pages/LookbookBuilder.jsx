import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, daysAgo, today, formatKES } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Plus, X, Check, Link2, ArrowLeft, BookImage, GripVertical } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import ProductTilePlaceholder from "@/components/ProductTilePlaceholder";

/** Stable id for an item when BI returns aggregated style-level data without a SKU. */
function itemId(s) {
  if (s?.sku) return s.sku;
  return `${s?.style_name || ""}::${s?.brand || ""}::${s?.collection || ""}::${s?.product_type || s?.subcategory || ""}`.toLowerCase().replace(/\s+/g, "-") || `item-${s?.product_title || "unknown"}`;
}

/* ------------------------------------------------------------------ *
 * Sortable row — one selected item, draggable via the grip handle.   *
 * ------------------------------------------------------------------ */
function SortableItem({ item, onRemove }) {
  const id = itemId(item);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 py-2 border-b border-[var(--vivo-border)] last:border-b-0"
      data-testid={`lookbook-selected-item-${id}`}
    >
      <button
        {...attributes}
        {...listeners}
        className="touch-none p-1 text-[var(--vivo-muted)] hover:text-[var(--vivo-navy)] cursor-grab active:cursor-grabbing"
        aria-label={`Reorder ${item.product_title}`}
        data-testid={`lookbook-grip-${id}`}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="h-14 w-14 rounded-sm overflow-hidden bg-[var(--vivo-bg)] shrink-0">
        <ProductTilePlaceholder item={item} className="h-full w-full" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{item.product_title}</div>
        <div className="text-xs text-[var(--vivo-muted)] truncate">
          {item.color || item.color_print || ""}{item.color && item.size ? " · " : ""}{item.size ? `Size ${item.size}` : ""}
        </div>
        <div className="text-xs text-[var(--vivo-muted)] mt-0.5">{formatKES(item.price)}</div>
      </div>
      <button
        onClick={() => onRemove(id)}
        className="text-[var(--vivo-muted)] hover:text-red-600 p-1"
        aria-label="Remove"
        data-testid={`lookbook-remove-${id}`}
      >
        <X className="h-4 w-4" />
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Builder page                                                       *
 * ------------------------------------------------------------------ */
export default function LookbookBuilder() {
  const [params] = useSearchParams();
  const customerId = params.get("customer_id") || "";
  const customerName = params.get("customer_name") || "";
  const navigate = useNavigate();

  const [title, setTitle] = useState(`Selected for ${customerName?.split(" ")[0] || "you"}`);
  const [note, setNote] = useState("");
  const [items, setItems] = useState([]);
  const [skus, setSkus] = useState([]);
  const [created, setCreated] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get("/bi/top-skus", { params: { date_from: daysAgo(30), date_to: today(), limit: 60 } });
        setSkus(r.data || []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const addItem = (s) => {
    const id = itemId(s);
    if (items.find((x) => itemId(x) === id)) return;
    setItems((prev) => [
      ...prev,
      {
        sku: s.sku || id,
        product_title: s.product_title || s.style_name,
        price: s.unit_price_kes || s.net_sales || s.avg_price,
        size: s.size,
        color: s.color || s.color_print,
        collection: s.collection,
        brand: s.brand,
        product_type: s.product_type || s.subcategory,
        style_name: s.style_name,
      },
    ]);
  };
  const removeItem = (id) => setItems((prev) => prev.filter((x) => itemId(x) !== id));

  const onDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const oldIndex = prev.findIndex((i) => itemId(i) === active.id);
      const newIndex = prev.findIndex((i) => itemId(i) === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const create = async () => {
    if (items.length < 3) {
      toast.error("Add at least 3 items to a lookbook");
      return;
    }
    const r = await api.post("/lookbooks", {
      customer_id: customerId,
      customer_name: customerName,
      title,
      note,
      items: items.map((it, idx) => ({ ...it, order: idx })),
    });
    setCreated(r.data);
    toast.success("Lookbook created");
  };

  const filteredSkus = useMemo(() => {
    if (!query.trim()) return skus;
    const q = query.toLowerCase();
    return skus.filter((s) =>
      (s.product_title || s.style_name || "").toLowerCase().includes(q) ||
      (s.collection || "").toLowerCase().includes(q) ||
      (s.product_type || s.subcategory || "").toLowerCase().includes(q) ||
      (s.sku || "").toLowerCase().includes(q),
    );
  }, [query, skus]);

  const shareUrl = useMemo(() => {
    if (!created) return "";
    return `${window.location.origin}/share/${created.share_token}`;
  }, [created]);

  if (created) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <Card className="vivo-card p-8 rounded-sm">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-emerald-50 flex items-center justify-center"><Check className="h-5 w-5 text-emerald-700"/></div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--vivo-muted)]">Ready to share</div>
              <h2 className="font-display text-2xl mt-0.5">Your lookbook is live</h2>
            </div>
          </div>
          <p className="text-sm text-[var(--vivo-muted)] mt-3">
            Share the link with {customerName?.split(" ")[0] || "your customer"} on WhatsApp or SMS. The page stays live for 30 days.
          </p>
          <div className="mt-4 flex items-center gap-2 bg-[var(--vivo-bg-soft)] rounded-sm p-3 border border-[var(--vivo-border)]">
            <Link2 className="h-4 w-4 text-[var(--vivo-muted)] shrink-0"/>
            <code className="text-xs flex-1 truncate" data-testid="lookbook-share-url">{shareUrl}</code>
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm"
              onClick={() => { navigator.clipboard.writeText(shareUrl); toast.success("Link copied"); }}
              data-testid="lookbook-copy-link"
            >
              Copy
            </Button>
          </div>
          <div className="flex items-center gap-2 mt-6">
            <Button variant="outline" onClick={() => navigate(-1)} className="rounded-sm">Back to customer</Button>
            <Button onClick={() => navigate("/lookbooks")} className="rounded-sm">View all lookbooks</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="text-xs text-[var(--vivo-muted)] inline-flex items-center gap-1.5 hover:underline" data-testid="lookbook-back">
          <ArrowLeft className="h-3 w-3"/> Back
        </button>
      </div>
      <div className="mt-2">
        <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--vivo-muted)]">New lookbook · for {customerName || "—"}</div>
        <h1 className="font-display text-3xl md:text-4xl text-[var(--vivo-navy)] mt-1 flex items-center gap-3">
          <BookImage className="h-6 w-6"/> Build a lookbook
        </h1>
        <p className="text-sm text-[var(--vivo-muted)] mt-2 max-w-2xl">
          Pick 3–15 pieces from this season's best-sellers. Drag the grips to reorder, then share the curated link.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
        {/* Left: meta + selected */}
        <div className="space-y-6">
          <Card className="vivo-card p-6 rounded-sm">
            <Label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">Lookbook title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 rounded-sm" data-testid="lookbook-title"/>
            <Label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)] mt-4 block">Personal note · optional</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={`Hi ${customerName?.split(" ")[0] || "there"}, picked these with you in mind…`} className="mt-1 rounded-sm h-24" data-testid="lookbook-note"/>
          </Card>

          <Card className="vivo-card p-6 rounded-sm">
            <div className="flex items-baseline justify-between">
              <h3 className="font-display text-xl">Selected ({items.length})</h3>
              <span className="text-xs text-[var(--vivo-muted)]">3–15 items</span>
            </div>
            <div className="vivo-divider my-3" />
            {items.length === 0 ? (
              <div className="vivo-empty">
                <h4>No items yet</h4>
                <p>Tap items on the right to add. Drag the grip handle to reorder.</p>
              </div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={items.map((i) => itemId(i))} strategy={verticalListSortingStrategy}>
                  <ul className="-mx-2" data-testid="lookbook-selected-list">
                    {items.map((it) => (
                      <SortableItem key={itemId(it)} item={it} onRemove={removeItem} />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            )}
            <Button
              onClick={create}
              disabled={items.length < 3}
              className="mt-6 w-full h-12 bg-[var(--vivo-navy)] hover:bg-[var(--vivo-navy-700)] text-white rounded-sm disabled:opacity-40"
              data-testid="lookbook-builder-generate-link"
            >
              Generate share link
            </Button>
          </Card>
        </div>

        {/* Right: catalogue */}
        <div className="lg:col-span-2">
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <div>
              <h3 className="font-display text-xl">Trending pieces · 30d</h3>
              <p className="text-sm text-[var(--vivo-muted)] mt-1">Tap to add. Search by name, collection, or category.</p>
            </div>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 60 pieces…"
              className="w-64 rounded-sm"
              data-testid="lookbook-catalogue-search"
            />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mt-5" data-testid="lookbook-catalogue">
            {loading && <div className="text-sm text-[var(--vivo-muted)] col-span-3">Loading catalogue…</div>}
            {!loading && filteredSkus.length === 0 && (
              <div className="vivo-empty col-span-3"><h4>No matches</h4><p>Try a different keyword.</p></div>
            )}
            {filteredSkus.map((s) => {
              const id = itemId(s);
              const isAdded = !!items.find((x) => itemId(x) === id);
              return (
                <div key={id} className="vivo-card overflow-hidden rounded-sm">
                  <div className="aspect-[3/4] bg-[var(--vivo-bg)] overflow-hidden">
                    <ProductTilePlaceholder item={s} className="h-full w-full" />
                  </div>
                  <div className="p-3">
                    <div className="text-sm font-medium truncate">{s.product_title || s.style_name}</div>
                    <div className="text-xs text-[var(--vivo-muted)] mt-1 truncate">
                      {s.color || s.color_print || ""}{(s.color || s.color_print) && s.size ? " · " : ""}{s.size ? `Size ${s.size}` : ""}
                    </div>
                    <div className="flex items-center justify-between mt-2">
                      <div className="font-mono-num text-sm">{formatKES(s.unit_price_kes || s.net_sales || s.avg_price)}</div>
                      <button
                        onClick={() => addItem(s)}
                        disabled={isAdded}
                        data-testid={`lookbook-builder-add-product-${id}`}
                        className={`h-9 px-3 rounded-sm text-xs uppercase tracking-wider transition-colors ${
                          isAdded
                            ? "bg-[var(--vivo-bg)] text-[var(--vivo-muted)]"
                            : "bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy-700)]"
                        }`}
                      >
                        {isAdded ? "Added" : <span className="inline-flex items-center"><Plus className="h-3 w-3 mr-1"/>Add</span>}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
