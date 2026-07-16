import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { shop, type StorefrontProduct } from "../lib/api";
import { formatMoney } from "../lib/format";
import { useCart } from "../lib/cart";
import { useWishlist } from "../lib/wishlist";
import { useToast } from "../components/toast";
import { Button, Skeleton, EmptyState } from "../components/ui";
import { ShopIcon, ChevronRight, HeartIcon, HeartFilledIcon } from "../components/icons";

export function meta() {
  return [{ title: "Product · Vivo Loyalty" }];
}

export default function ProductPage() {
  const { handle } = useParams();
  const { add } = useCart();
  const { has, toggle } = useWishlist();
  const toast = useToast();
  const [product, setProduct] = useState<StorefrontProduct | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [qty, setQty] = useState(1);
  const [activeImg, setActiveImg] = useState(0);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!handle) return;
    shop
      .product(handle)
      .then((r) => {
        setProduct(r.product);
        // Default selection to the first available variant.
        const v = r.product.variants.find((x) => x.available) ?? r.product.variants[0];
        if (v) setSelected(Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value])));
      })
      .catch((e) => setError(e?.message ?? "Couldn't load product."));
  }, [handle]);

  // Resolve the variant that matches the currently-selected options.
  const currentVariant = useMemo(() => {
    if (!product) return null;
    return (
      product.variants.find((v) =>
        v.selectedOptions.every((o) => selected[o.name] === o.value),
      ) ?? null
    );
  }, [product, selected]);

  const addToCart = async () => {
    if (!currentVariant) return;
    setAdding(true);
    try {
      await add(currentVariant.id, qty);
      toast("Added to cart 🛍️", "success");
    } catch {
      toast("Couldn't add to cart.", "error");
    } finally {
      setAdding(false);
    }
  };

  if (error) {
    return (
      <div className="pt-2">
        <BackLink />
        <EmptyState icon={<ShopIcon />} title="Product unavailable" subtitle={error} />
      </div>
    );
  }

  if (!product) {
    return (
      <div className="space-y-3 pt-2">
        <BackLink />
        <Skeleton className="aspect-[9/12] w-full !rounded-2xl" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const price = currentVariant?.price ?? product.price;
  const currency = currentVariant?.currency ?? product.currency;
  const soldOut = currentVariant ? !currentVariant.available : false;

  return (
    <div className="space-y-4 pb-4">
      <div className="pt-2">
        <BackLink />
      </div>

      {/* Gallery — swipable carousel with heart overlay */}
      <div className="relative overflow-hidden rounded-[1.5rem] bg-[var(--bg)]">
        <div
          onScroll={(e) => {
            const el = e.currentTarget;
            const idx = Math.round(el.scrollLeft / el.clientWidth);
            if (idx !== activeImg) setActiveImg(idx);
          }}
          className="flex snap-x snap-mandatory overflow-x-auto no-scrollbar"
        >
          {(product.images.length ? product.images : [null]).map((src, i) => (
            <div key={i} className="aspect-[4/5] w-full shrink-0 snap-center">
              {src ? (
                <img src={src} alt={product.title} className="h-full w-full object-cover object-top" />
              ) : (
                <div className="grid h-full place-items-center text-5xl">🛍️</div>
              )}
            </div>
          ))}
        </div>

        {/* Wishlist heart */}
        <button
          onClick={async () => {
            const now = await toggle({ handle: product.handle, title: product.title, image: product.images[0] ?? null, price, currency });
            toast(now ? "Saved to wishlist ♥" : "Removed from wishlist", "success");
          }}
          aria-label="Toggle wishlist"
          className="tap absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full bg-black/35 backdrop-blur"
        >
          {has(product.handle) ? (
            <HeartFilledIcon className="h-5 w-5 text-[var(--accent)]" />
          ) : (
            <HeartIcon className="h-5 w-5 text-white" />
          )}
        </button>

        {/* Dots */}
        {product.images.length > 1 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
            {product.images.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full bg-white transition-all ${
                  i === activeImg ? "w-4" : "w-1.5 opacity-50"
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Title + price */}
      <div>
        <h1 className="text-xl font-bold leading-tight">{product.title}</h1>
        <p className="mt-1 text-lg font-black text-[var(--accent)]">{formatMoney(price, currency)}</p>
      </div>

      {/* Variant options */}
      {product.options
        .filter((o) => o.values.length > 1 || o.name.toLowerCase() !== "title")
        .map((opt) => (
          <div key={opt.name}>
            <p className="mb-1.5 text-sm font-semibold">{opt.name}</p>
            <div className="flex flex-wrap gap-2">
              {opt.values.map((val) => {
                const active = selected[opt.name] === val;
                return (
                  <button
                    key={val}
                    onClick={() => setSelected((s) => ({ ...s, [opt.name]: val }))}
                    className={`tap rounded-xl border px-3 py-2 text-sm font-medium transition-colors ${
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-700)] dark:text-[var(--accent)]"
                        : "border-[var(--card-border)]"
                    }`}
                  >
                    {val}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

      {/* Quantity */}
      <div className="flex items-center gap-4">
        <p className="text-sm font-semibold">Quantity</p>
        <div className="flex items-center gap-3 rounded-xl border border-[var(--card-border)] px-2 py-1">
          <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="tap px-2 text-lg font-bold">
            −
          </button>
          <span className="w-6 text-center font-semibold">{qty}</span>
          <button onClick={() => setQty((q) => q + 1)} className="tap px-2 text-lg font-bold">
            +
          </button>
        </div>
      </div>

      {/* Description */}
      {product.descriptionHtml && (
        <div
          className="prose-sm text-sm leading-relaxed text-muted [&_a]:text-[var(--accent)] [&_li]:ml-4 [&_li]:list-disc"
          dangerouslySetInnerHTML={{ __html: product.descriptionHtml }}
        />
      )}

      {/* Sticky add-to-cart — sits ABOVE the bottom nav */}
      <div
        className="fixed inset-x-0 z-30 mx-auto max-w-md border-t border-[var(--card-border)] bg-[var(--bg)]/95 p-3 backdrop-blur-xl"
        style={{ bottom: "calc(env(safe-area-inset-bottom) + 4.75rem)" }}
      >
        <Button full loading={adding} disabled={soldOut || !currentVariant} onClick={addToCart}>
          {soldOut ? "Sold out" : `Add to cart · ${formatMoney(price * qty, currency)}`}
        </Button>
      </div>
      <div className="h-36" />
    </div>
  );
}

function BackLink() {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(-1)}
      className="tap inline-flex items-center gap-1 text-sm font-medium text-muted"
    >
      <ChevronRight className="h-4 w-4 rotate-180" /> Back
    </button>
  );
}
