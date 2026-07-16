import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { shop, type WishlistItem } from "./api";
import { useAuth } from "./auth";

interface WishlistState {
  items: WishlistItem[];
  count: number;
  has: (handle: string) => boolean;
  toggle: (item: WishlistItem) => Promise<boolean>; // returns new saved state
  remove: (handle: string) => Promise<void>;
}

const WishlistContext = createContext<WishlistState | null>(null);

export function WishlistProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [items, setItems] = useState<WishlistItem[]>([]);

  // Load the account's wishlist once we know who's signed in, and re-load when
  // the account changes (e.g. logging in on a new browser/device). Clear on
  // logout. This is what makes the wishlist follow the account everywhere.
  useEffect(() => {
    if (!user) {
      setItems([]);
      return;
    }
    shop
      .wishlist()
      .then((r) => setItems(r.items))
      .catch(() => {});
  }, [user?.id]);

  const has = useCallback((handle: string) => items.some((i) => i.handle === handle), [items]);

  const toggle = useCallback(
    async (item: WishlistItem) => {
      const saved = items.some((i) => i.handle === item.handle);
      // Optimistic update.
      setItems((prev) =>
        saved ? prev.filter((i) => i.handle !== item.handle) : [item, ...prev],
      );
      try {
        const r = saved
          ? await shop.wishlistRemove(item.handle)
          : await shop.wishlistAdd({
              handle: item.handle,
              title: item.title,
              image: item.image,
              price: item.price,
              currency: item.currency,
            });
        setItems(r.items);
      } catch {
        // Revert on failure.
        setItems((prev) =>
          saved ? [item, ...prev] : prev.filter((i) => i.handle !== item.handle),
        );
      }
      return !saved;
    },
    [items],
  );

  const remove = useCallback(async (handle: string) => {
    setItems((prev) => prev.filter((i) => i.handle !== handle));
    try {
      const r = await shop.wishlistRemove(handle);
      setItems(r.items);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <WishlistContext.Provider value={{ items, count: items.length, has, toggle, remove }}>
      {children}
    </WishlistContext.Provider>
  );
}

export function useWishlist() {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error("useWishlist must be used within WishlistProvider");
  return ctx;
}
