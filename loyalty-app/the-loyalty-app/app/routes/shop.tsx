import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { shop, type Collection, type ShopProduct } from "../lib/api";
import { formatMoney } from "../lib/format";
import { useCart } from "../lib/cart";
import { useWishlist } from "../lib/wishlist";
import { useToast } from "../components/toast";
import { Card, Skeleton, EmptyState, Spinner } from "../components/ui";
import { ShopIcon, MenuIcon, CloseIcon, ChevronRight, HeartIcon, HeartFilledIcon } from "../components/icons";

export function meta() {
  return [{ title: "Shop · Vivo Loyalty" }];
}

type Tab = "featured" | "new" | "about";

// Module-level caches so returning to Shop (e.g. after viewing a product)
// renders instantly at the same view — which is what lets the browser restore
// the scroll position instead of jumping to the top.
let collectionsCache: Collection[] | null = null;
const productsCache: Record<string, ShopProduct[]> = {};
let uiState: { tab: Tab; selected: { handle: string; title: string } | null } = {
  tab: "featured",
  selected: null,
};

export default function Shop() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[] | null>(collectionsCache);
  const [linked, setLinked] = useState(true);
  const [tab, setTab] = useState<Tab>(uiState.tab);
  const [selected, setSelected] = useState(uiState.selected);

  // Featured/New tabs follow the curated collection order (1st and 2nd).
  const featuredHandle = collections?.[0]?.handle ?? null;
  const newHandle = collections?.[1]?.handle ?? collections?.[0]?.handle ?? null;

  // Which collection's products to show right now.
  const handle = selected
    ? selected.handle
    : tab === "featured"
      ? featuredHandle
      : tab === "new"
        ? newHandle
        : null;

  // Seed products from cache so the grid renders at full height immediately.
  const [products, setProducts] = useState<ShopProduct[] | null>(
    handle ? (productsCache[handle] ?? null) : null,
  );

  // Persist view state for the next time this page mounts.
  useEffect(() => {
    uiState = { tab, selected };
  }, [tab, selected]);

  // Collections power the drawer menu (fetch once; reuse cache on remount).
  useEffect(() => {
    if (collectionsCache) return;
    shop
      .collections()
      .then((r) => {
        collectionsCache = r.collections;
        setCollections(r.collections);
        setLinked(r.linked);
      })
      .catch(() => setCollections([]));
  }, []);

  useEffect(() => {
    if (!handle) return;
    if (productsCache[handle]) {
      setProducts(productsCache[handle]);
      return;
    }
    setProducts(null);
    shop
      .products(handle)
      .then((r) => {
        productsCache[handle] = r.products;
        setProducts(r.products);
      })
      .catch(() => setProducts([]));
  }, [handle]);

  // Collections with images first (curated), then the rest.
  const sortedCollections = useMemo(() => {
    if (!collections) return [];
    return [...collections].sort((a, b) => (b.image ? 1 : 0) - (a.image ? 1 : 0));
  }, [collections]);

  const pickCollection = (c: Collection) => {
    setSelected({ handle: c.handle, title: c.title });
    setDrawerOpen(false);
  };

  return (
    <div className="space-y-4">
      {/* Header with hamburger */}
      <div className="flex items-center justify-between pt-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {selected ? selected.title : "Shop"}
          </h1>
          <p className="text-sm text-muted">
            {selected ? "Collection" : "Discover the Vivo edit"}
          </p>
        </div>
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Browse collections"
          className="tap grid h-11 w-11 place-items-center rounded-2xl border border-[var(--card-border)] bg-[var(--card)]"
        >
          <MenuIcon className="h-6 w-6" />
        </button>
      </div>

      {selected ? (
        <>
          <button
            onClick={() => setSelected(null)}
            className="tap inline-flex items-center gap-1 text-sm font-medium text-[var(--accent)]"
          >
            <ChevronRight className="h-4 w-4 rotate-180" /> Back to shop
          </button>
          <ProductGrid products={products} />
        </>
      ) : (
        <>
          {/* Marketing hero */}
          <div
            className="relative overflow-hidden rounded-[1.75rem] p-6 text-white"
            style={{ background: "linear-gradient(135deg,#fe6a02,#ff8f3c 45%,#e0431f)" }}
          >
            <div className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rounded-full bg-white/20 blur-2xl" />
            <p className="text-xs font-semibold uppercase tracking-wider opacity-90">New season</p>
            <h2 className="mt-1 max-w-[15rem] text-2xl font-black leading-tight">
              Shop the Vivo collection
            </h2>
            <p className="mt-1 text-sm text-white/85">Earn points on every purchase.</p>
            <button
              onClick={() => setDrawerOpen(true)}
              className="tap mt-4 inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-bold text-[#e0431f]"
            >
              Browse collections <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Marketing / info tabs */}
          <div className="flex gap-1 rounded-2xl bg-[var(--card-border)]/50 p-1">
            {(
              [
                ["featured", "Featured"],
                ["new", "New in"],
                ["about", "About"],
              ] as [Tab, string][]
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`tap flex-1 rounded-xl py-2 text-sm font-semibold transition-all ${
                  tab === t ? "bg-[var(--accent)] text-white shadow-sm" : "text-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {!linked ? (
            <EmptyState
              icon={<ShopIcon />}
              title="Shop unavailable"
              subtitle="The store isn't connected yet. Please check back soon."
            />
          ) : tab === "about" ? (
            <AboutVivo />
          ) : (
            <ProductGrid products={products} />
          )}
        </>
      )}

      {/* Collections drawer */}
      <CollectionsDrawer
        open={drawerOpen}
        collections={sortedCollections}
        loading={collections === null}
        onClose={() => setDrawerOpen(false)}
        onPick={pickCollection}
      />
    </div>
  );
}

function ProductGrid({ products }: { products: ShopProduct[] | null }) {
  if (products === null) {
    return (
      <div className="grid grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-56 w-full" />
        ))}
      </div>
    );
  }
  if (products.length === 0) {
    return <EmptyState icon={<ShopIcon />} title="No products" subtitle="Nothing here yet." />;
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      {products.map((p) => (
        <ProductCard key={p.id} product={p} />
      ))}
    </div>
  );
}

function ProductCard({ product: p }: { product: ShopProduct }) {
  const { add } = useCart();
  const { has, toggle } = useWishlist();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const saved = has(p.handle);

  const toggleWish = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const now = await toggle({
      handle: p.handle,
      title: p.title,
      image: p.image,
      price: p.price,
      currency: p.currency,
    });
    toast(now ? "Saved to wishlist ♥" : "Removed from wishlist", "success");
  };

  // Quick-add fetches the product's first available variant, then adds it.
  const quickAdd = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAdding(true);
    try {
      const { product } = await shop.product(p.handle);
      const variant = product.variants.find((v) => v.available) ?? product.variants[0];
      if (!variant) throw new Error("Out of stock");
      await add(variant.id, 1);
      toast("Added to cart 🛍️", "success");
    } catch {
      toast("Couldn't add to cart.", "error");
    } finally {
      setAdding(false);
    }
  };

  return (
    <Link
      to={`/shop/product/${encodeURIComponent(p.handle)}`}
      className="tap card group flex flex-col overflow-hidden !rounded-2xl !p-0"
    >
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-[var(--bg)]">
        {p.image ? (
          <img
            src={p.image}
            alt={p.title}
            loading="lazy"
            className="h-full w-full object-cover object-top transition-transform group-active:scale-95"
          />
        ) : (
          <div className="grid h-full place-items-center text-3xl">🛍️</div>
        )}
        <button
          onClick={toggleWish}
          aria-label={saved ? "Remove from wishlist" : "Save to wishlist"}
          className="tap absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/35 backdrop-blur"
        >
          {saved ? (
            <HeartFilledIcon className="h-[18px] w-[18px] text-[var(--accent)]" />
          ) : (
            <HeartIcon className="h-[18px] w-[18px] text-white" />
          )}
        </button>
      </div>
      <div className="flex flex-1 flex-col p-3">
        <p className="line-clamp-2 text-xs font-medium leading-snug">{p.title}</p>
        <span className="mt-1 text-sm font-bold text-[var(--accent)]">
          {formatMoney(p.price, p.currency)}
        </span>
        <button
          onClick={quickAdd}
          disabled={adding}
          className="tap mt-2 flex items-center justify-center gap-1 rounded-xl bg-[var(--accent)] py-2 text-xs font-bold text-white disabled:opacity-60"
        >
          {adding ? <Spinner className="h-4 w-4" /> : "Add to cart"}
        </button>
      </div>
    </Link>
  );
}

function CollectionsDrawer({
  open,
  collections,
  loading,
  onClose,
  onPick,
}: {
  open: boolean;
  collections: Collection[];
  loading: boolean;
  onClose: () => void;
  onPick: (c: Collection) => void;
}) {
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/40 transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      {/* Panel */}
      <aside
        className={`fixed right-0 top-0 z-50 flex h-[100dvh] w-[82%] max-w-sm flex-col bg-[var(--card)] shadow-2xl transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="safe-top flex items-center justify-between border-b border-[var(--card-border)] px-5 pb-3 pt-4">
          <div>
            <p className="text-lg font-bold">Collections</p>
            <p className="text-xs text-muted">Pick a collection to shop</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="tap grid h-10 w-10 place-items-center rounded-xl bg-[var(--bg)]"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {collections.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => onPick(c)}
                    className="tap flex w-full items-center gap-3 rounded-2xl p-2 text-left hover:bg-[var(--bg)]"
                  >
                    {c.image ? (
                      <img src={c.image} alt="" className="h-12 w-12 rounded-xl object-cover" />
                    ) : (
                      <span className="grid h-12 w-12 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                        <ShopIcon className="h-5 w-5" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{c.title}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

function AboutVivo() {
  const points = [
    ["✨", "Premium quality", "Thoughtfully designed pieces made to last."],
    ["🚚", "Fast delivery", "Countrywide shipping, tracked to your door."],
    ["⭐", "Earn as you shop", "Every order earns loyalty points toward rewards."],
    ["↩️", "Easy returns", "Not quite right? Returns are simple and quick."],
  ];
  return (
    <Card>
      <h2 className="mb-1 text-lg font-bold">Why shop with Vivo</h2>
      <p className="mb-4 text-sm text-muted">
        Vivo brings you curated fashion with a rewarding twist — shop your favourites and watch
        your points grow.
      </p>
      <ul className="space-y-3">
        {points.map(([icon, title, sub]) => (
          <li key={title} className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--accent-soft)] text-lg">
              {icon}
            </span>
            <div>
              <p className="text-sm font-semibold">{title}</p>
              <p className="text-xs text-muted">{sub}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
