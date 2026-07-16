import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { shop, type Cart } from "./api";
import { useAuth } from "./auth";

const STORAGE_KEY = "vivo_cart_id";

interface CartState {
  cart: Cart | null;
  count: number;
  busy: boolean;
  add: (variantId: string, quantity?: number) => Promise<void>;
  update: (lineId: string, quantity: number) => Promise<void>;
  remove: (lineId: string) => Promise<void>;
  checkout: () => void;
}

const CartContext = createContext<CartState | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [cart, setCart] = useState<Cart | null>(null);
  const [busy, setBusy] = useState(false);

  const persist = (c: Cart | null) => {
    setCart(c);
    if (c?.id) localStorage.setItem(STORAGE_KEY, c.id);
    else localStorage.removeItem(STORAGE_KEY);
  };

  // Load the account's cart when signed in (so it follows the login across
  // devices). Fall back to the locally-stored cart id if the account has none.
  useEffect(() => {
    if (!user) {
      setCart(null);
      return;
    }
    shop
      .cartActive()
      .then(async (r) => {
        if (r.cart) return persist(r.cart);
        const localId = localStorage.getItem(STORAGE_KEY);
        if (localId) {
          const local = await shop.cartGet(localId).catch(() => null);
          if (local?.cart) return persist(local.cart);
        }
        persist(null);
      })
      .catch(() => {});
  }, [user?.id]);

  const add = useCallback(
    async (variantId: string, quantity = 1) => {
      setBusy(true);
      try {
        const r = await shop.cartAdd(variantId, quantity, cart?.id);
        persist(r.cart);
      } finally {
        setBusy(false);
      }
    },
    [cart?.id],
  );

  const update = useCallback(
    async (lineId: string, quantity: number) => {
      if (!cart?.id) return;
      setBusy(true);
      try {
        const r = await shop.cartUpdate(cart.id, lineId, quantity);
        persist(r.cart);
      } finally {
        setBusy(false);
      }
    },
    [cart?.id],
  );

  const remove = useCallback(
    async (lineId: string) => {
      if (!cart?.id) return;
      setBusy(true);
      try {
        const r = await shop.cartRemove(cart.id, lineId);
        persist(r.cart);
      } finally {
        setBusy(false);
      }
    },
    [cart?.id],
  );

  const checkout = useCallback(() => {
    if (cart?.checkoutUrl) window.location.href = cart.checkoutUrl;
  }, [cart?.checkoutUrl]);

  return (
    <CartContext.Provider
      value={{ cart, count: cart?.totalQuantity ?? 0, busy, add, update, remove, checkout }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}
