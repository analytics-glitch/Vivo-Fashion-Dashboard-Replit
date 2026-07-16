import { useState } from "react";
import { Link } from "react-router";
import { useWishlist } from "../lib/wishlist";
import { useCart } from "../lib/cart";
import { shop } from "../lib/api";
import { formatMoney } from "../lib/format";
import { useToast } from "../components/toast";
import { EmptyState, Spinner } from "../components/ui";
import { HeartIcon, HeartFilledIcon } from "../components/icons";

export function meta() {
  return [{ title: "Wishlist · Vivo Loyalty" }];
}

export default function WishlistPage() {
  const { items, remove } = useWishlist();

  return (
    <div className="space-y-4">
      <div className="pt-2">
        <h1 className="text-2xl font-bold tracking-tight">Wishlist</h1>
        <p className="text-sm text-muted">
          {items.length ? `${items.length} saved item${items.length === 1 ? "" : "s"}` : "Save your favourites"}
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<HeartIcon />}
          title="No saved items yet"
          subtitle="Tap the heart on any product to save it here."
          action={
            <Link to="/shop" className="tap rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white">
              Browse shop
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {items.map((it) => (
            <WishlistCard key={it.handle} item={it} onRemove={() => remove(it.handle)} />
          ))}
        </div>
      )}
    </div>
  );
}

function WishlistCard({
  item,
  onRemove,
}: {
  item: { handle: string; title: string; image: string | null; price: number; currency: string };
  onRemove: () => void;
}) {
  const { add } = useCart();
  const toast = useToast();
  const [adding, setAdding] = useState(false);

  const quickAdd = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setAdding(true);
    try {
      const { product } = await shop.product(item.handle);
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
      to={`/shop/product/${encodeURIComponent(item.handle)}`}
      className="tap card group flex flex-col overflow-hidden !rounded-2xl !p-0"
    >
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-[var(--bg)]">
        {item.image ? (
          <img src={item.image} alt={item.title} loading="lazy" className="h-full w-full object-cover object-top" />
        ) : (
          <div className="grid h-full place-items-center text-3xl">🛍️</div>
        )}
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove from wishlist"
          className="tap absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/35 backdrop-blur"
        >
          <HeartFilledIcon className="h-[18px] w-[18px] text-[var(--accent)]" />
        </button>
      </div>
      <div className="flex flex-1 flex-col p-3">
        <p className="line-clamp-2 text-xs font-medium leading-snug">{item.title}</p>
        <span className="mt-1 text-sm font-bold text-[var(--accent)]">
          {formatMoney(item.price, item.currency)}
        </span>
        <button
          onClick={quickAdd}
          disabled={adding}
          className="tap mt-2 flex items-center justify-center gap-1 rounded-xl bg-[var(--accent)] py-2 text-xs font-bold text-white disabled:opacity-60"
        >
          {adding ? <Spinner className="h-4 w-4" /> : "Add to cart"}
        </button>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className="tap mt-1.5 flex items-center justify-center gap-1 py-1 text-xs font-medium text-red-500"
        >
          Remove
        </button>
      </div>
    </Link>
  );
}
