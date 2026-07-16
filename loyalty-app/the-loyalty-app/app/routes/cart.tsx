import { Link } from "react-router";
import { useCart } from "../lib/cart";
import { formatMoney } from "../lib/format";
import { Button, EmptyState } from "../components/ui";
import { CartIcon, ChevronRight } from "../components/icons";

export function meta() {
  return [{ title: "Cart · Vivo Loyalty" }];
}

// Build a Shopify cart permalink so the app cart can be opened on the public
// storefront (variant GIDs → numeric ids: gid://…/ProductVariant/123 → 123).
// Disabled for now — kept for when web hand-off is wanted again.
// function storefrontCartUrl(lines: { variantId: string; quantity: number }[]) {
//   const parts = lines
//     .map((l) => {
//       const id = l.variantId.split("/").pop();
//       return id ? `${id}:${l.quantity}` : null;
//     })
//     .filter(Boolean);
//   return `https://www.shopzetu.com/cart/${parts.join(",")}`;
// }

export default function CartPage() {
  const { cart, busy, update, remove, checkout } = useCart();

  return (
    <div className="space-y-4">
      <div className="pt-2">
        <h1 className="text-2xl font-bold tracking-tight">Your cart</h1>
        <p className="text-sm text-muted">
          {cart?.totalQuantity ? `${cart.totalQuantity} item${cart.totalQuantity === 1 ? "" : "s"}` : "Ready when you are"}
        </p>
      </div>

      {!cart || cart.lines.length === 0 ? (
        <EmptyState
          icon={<CartIcon />}
          title="Your cart is empty"
          subtitle="Browse the shop and add your favourites."
          action={
            <Link to="/shop" className="tap rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-white">
              Start shopping
            </Link>
          }
        />
      ) : (
        <>
          <div className="space-y-3">
            {cart.lines.map((line) => (
              <div key={line.id} className="card flex gap-3 !p-3">
                <Link to={`/shop/product/${encodeURIComponent(line.handle)}`} className="shrink-0">
                  {line.image ? (
                    <img
                      src={line.image}
                      alt=""
                      className="h-28 w-16 rounded-xl object-cover object-top"
                    />
                  ) : (
                    <span className="grid h-28 w-16 place-items-center rounded-xl bg-[var(--bg)] text-xl">🛍️</span>
                  )}
                </Link>
                <div className="flex min-w-0 flex-1 flex-col">
                  <Link to={`/shop/product/${encodeURIComponent(line.handle)}`} className="line-clamp-2 text-sm font-medium">
                    {line.title}
                  </Link>
                  {line.variantTitle && <p className="text-xs text-muted">{line.variantTitle}</p>}
                  <p className="mt-0.5 text-sm font-bold text-[var(--accent)]">
                    {formatMoney(line.price, line.currency)}
                  </p>
                  <div className="mt-auto flex items-center justify-between pt-1">
                    <div className="flex items-center gap-2 rounded-lg border border-[var(--card-border)] px-1.5 py-0.5">
                      <button
                        onClick={() => update(line.id, line.quantity - 1)}
                        disabled={busy}
                        className="tap px-1.5 text-base font-bold disabled:opacity-40"
                      >
                        −
                      </button>
                      <span className="w-5 text-center text-sm font-semibold">{line.quantity}</span>
                      <button
                        onClick={() => update(line.id, line.quantity + 1)}
                        disabled={busy}
                        className="tap px-1.5 text-base font-bold disabled:opacity-40"
                      >
                        +
                      </button>
                    </div>
                    <button
                      onClick={() => remove(line.id)}
                      disabled={busy}
                      className="tap text-xs font-medium text-red-500"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Summary */}
          <div className="card !p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Subtotal</span>
              <span className="font-bold">{formatMoney(cart.subtotal, cart.currency)}</span>
            </div>
            <p className="mt-1 text-xs text-muted">Shipping &amp; taxes calculated at checkout.</p>
          </div>

          <Link
            to="/shop"
            className="tap flex items-center justify-center gap-1 text-sm font-medium text-muted"
          >
            <ChevronRight className="h-4 w-4 rotate-180" /> Continue shopping
          </Link>

          {/* Hand off the cart to the public storefront — disabled; in-app
              account persistence is enough.
          <a
            href={storefrontCartUrl(cart.lines)}
            target="_blank"
            rel="noreferrer"
            className="tap flex items-center justify-center gap-1 text-sm font-medium text-[var(--accent)]"
          >
            Open this cart on shopzetu.com →
          </a>
          */}

          {/* Sticky checkout — sits ABOVE the bottom nav */}
          <div
            className="fixed inset-x-0 z-30 mx-auto max-w-md border-t border-[var(--card-border)] bg-[var(--bg)]/95 p-3 backdrop-blur-xl"
            style={{ bottom: "calc(env(safe-area-inset-bottom) + 4.75rem)" }}
          >
            <Button full loading={busy} onClick={checkout}>
              Checkout · {formatMoney(cart.subtotal, cart.currency)}
            </Button>
            <p className="mt-1.5 text-center text-[11px] text-muted">
              Secure checkout powered by Shopify
            </p>
          </div>
          <div className="h-40" />
        </>
      )}
    </div>
  );
}
