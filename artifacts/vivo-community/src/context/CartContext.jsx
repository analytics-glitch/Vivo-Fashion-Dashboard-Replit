import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { kes } from "@/components/community/ui";

// Client-side shopping bag. Checkout is not wired to payments yet, so the
// bag lives in localStorage as a per-member map: every member who signs in
// on this device keeps their own bag (one member signing in never
// overwrites another's).
const STORE_KEY = "vivo_community_cart_v1";

const CartContext = createContext(null);

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside CartProvider");
  return ctx;
}

const memberKey = (id) => String(id ?? "anon");

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (raw && typeof raw === "object") {
      if (raw.members && typeof raw.members === "object") return raw.members;
      // Migrate the original single-member shape { memberId, items } so
      // that member's bag survives the upgrade.
      if (raw.memberId != null && Array.isArray(raw.items)) {
        return { [memberKey(raw.memberId)]: raw.items };
      }
    }
  } catch { /* corrupt/absent — start clean */ }
  return {};
}

function loadCart(memberId) {
  const list = readStore()[memberKey(memberId)];
  return Array.isArray(list)
    ? list.filter((i) => i && i.key && i.qty > 0 && i.price >= 0)
    : [];
}

function persistCart(memberId, items) {
  try {
    const members = readStore();
    members[memberKey(memberId)] = items;
    localStorage.setItem(STORE_KEY, JSON.stringify({ members }));
  } catch { /* private mode */ }
}

export function CartProvider({ memberId, children }) {
  // The items in memory belong to the member the provider mounted with
  // (sign-in/out remounts the shell). If memberId ever changed without a
  // remount we refuse to persist rather than write under the wrong key.
  const ownerRef = useRef(memberKey(memberId));
  const [items, setItems] = useState(() => loadCart(memberId));
  const [peek, setPeek] = useState(null); // last-added line for the toast
  const peekTimer = useRef(null);
  const viewBagRef = useRef(null);

  useEffect(() => {
    if (ownerRef.current !== memberKey(memberId)) return;
    persistCart(memberId, items);
  }, [memberId, items]);

  useEffect(() => () => clearTimeout(peekTimer.current), []);

  const dismissPeek = useCallback(() => {
    clearTimeout(peekTimer.current);
    setPeek(null);
  }, []);

  // line: { key (size-level sku), sku, name, color, size, qty, price, image, maxStock }
  const add = useCallback((line) => {
    const cap = Math.max(1, Number(line.maxStock) || 99);
    setItems((prev) => {
      const found = prev.find((i) => i.key === line.key);
      if (found) {
        return prev.map((i) =>
          i.key === line.key ? { ...i, qty: Math.min(cap, i.qty + line.qty), maxStock: cap } : i);
      }
      return [...prev, { ...line, qty: Math.min(cap, line.qty), maxStock: cap }];
    });
    clearTimeout(peekTimer.current);
    setPeek({ ...line });
    peekTimer.current = setTimeout(() => setPeek(null), 4200);
  }, []);

  const updateQty = useCallback((key, qty) => {
    setItems((prev) => prev.map((i) =>
      i.key === key ? { ...i, qty: Math.max(1, Math.min(i.maxStock || 99, qty)) } : i));
  }, []);

  const remove = useCallback((key) => setItems((prev) => prev.filter((i) => i.key !== key)), []);
  const clear = useCallback(() => setItems([]), []);

  // The shell registers its "open the bag page" navigation here so the
  // toast's View Bag button can use it without prop cycles.
  const setViewBagHandler = useCallback((fn) => { viewBagRef.current = fn; }, []);
  const requestViewBag = useCallback(() => {
    dismissPeek();
    if (viewBagRef.current) viewBagRef.current();
  }, [dismissPeek]);

  const count = items.reduce((s, i) => s + i.qty, 0);
  const subtotal = items.reduce((s, i) => s + i.qty * (Number(i.price) || 0), 0);

  return (
    <CartContext.Provider value={{
      items, count, subtotal, add, updateQty, remove, clear,
      peek, dismissPeek, requestViewBag, setViewBagHandler,
    }}>
      {children}
      <CartPeek />
    </CartContext.Provider>
  );
}

/** Elegant slide-in confirmation after Add to Bag. Portaled to <body> so no
 *  transformed ancestor can trap the fixed positioning. */
function CartPeek() {
  const { peek, dismissPeek, requestViewBag } = useCart();
  if (!peek) return null;
  return createPortal(
    <div
      data-testid="toast-added"
      role="status"
      className="fixed z-[70] left-4 right-4 bottom-24 sm:left-auto sm:right-8 sm:bottom-8 sm:w-[380px] animate-in slide-in-from-bottom-4 fade-in duration-300"
    >
      <div className="bg-background border border-border rounded shadow-[0_12px_40px_rgba(26,22,20,0.14)] p-4 flex items-center gap-4">
        {peek.image ? (
          <img src={peek.image} alt="" className="w-12 h-16 object-contain rounded-sm bg-secondary shrink-0" />
        ) : (
          <div className="w-12 h-16 bg-secondary rounded-sm shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-wider text-primary-ink mb-0.5">Added to your bag</div>
          <div className="text-[13px] text-foreground truncate font-medium">{peek.name}</div>
          <div className="text-xs text-muted-foreground">Size {peek.size} · {kes(peek.price)}</div>
        </div>
        <button
          data-testid="toast-view-bag"
          onClick={requestViewBag}
          className="h-11 px-4 shrink-0 rounded bg-foreground text-background text-xs font-semibold hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          View Bag
        </button>
        <button
          aria-label="Dismiss"
          onClick={dismissPeek}
          className="w-11 h-11 -mr-2 shrink-0 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <X size={14} />
        </button>
      </div>
    </div>,
    document.body
  );
}
