import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, Heart } from "lucide-react";

// Client-side wishlist, mirroring the bag: it lives in localStorage as a
// per-member map, so every member who signs in on this device keeps their
// own saves (one member signing in never overwrites another's list).
const STORE_KEY = "vivo_community_wishlist_v1";
// Safety valve so wishlist hydration can never breach the public PDP
// throttle: an absurdly long list drops its oldest saves.
const MAX_ITEMS = 100;

const WishlistContext = createContext(null);

export function useWishlist() {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error("useWishlist must be used inside WishlistProvider");
  return ctx;
}

const memberKey = (id) => String(id ?? "anon");

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (raw && typeof raw === "object") {
      if (raw.members && typeof raw.members === "object") return raw.members;
      // Migrate the original single-member shape { memberId, items } so
      // that member's saves survive the upgrade.
      if (raw.memberId != null && Array.isArray(raw.items)) {
        return { [memberKey(raw.memberId)]: raw.items };
      }
    }
  } catch { /* corrupt/absent — start clean */ }
  return {};
}

function loadItems(memberId) {
  const list = readStore()[memberKey(memberId)];
  return Array.isArray(list) ? list.filter((i) => i && i.sku) : [];
}

function persistItems(memberId, list) {
  try {
    const members = readStore();
    members[memberKey(memberId)] = list;
    localStorage.setItem(STORE_KEY, JSON.stringify({ members }));
  } catch { /* private mode */ }
}

export function WishlistProvider({ memberId, children }) {
  // list is tagged with the member it belongs to, so a member switch can
  // never persist one member's list under another member's key.
  const [state, setState] = useState(() => ({ member: memberKey(memberId), list: loadItems(memberId) }));
  const listRef = useRef(state.list); // synchronous mirror — makes toggle atomic
  const [peek, setPeek] = useState(null); // last-saved item for the toast
  const peekTimer = useRef(null);
  const viewRef = useRef(null);

  // Member switch: swap in that member's own list.
  useEffect(() => {
    if (state.member !== memberKey(memberId)) {
      const list = loadItems(memberId);
      listRef.current = list;
      setState({ member: memberKey(memberId), list });
    }
  }, [memberId, state.member]);

  // Persist only when the in-memory list actually belongs to this member.
  useEffect(() => {
    if (state.member === memberKey(memberId)) persistItems(memberId, state.list);
  }, [memberId, state.member, state.list]);

  useEffect(() => () => clearTimeout(peekTimer.current), []);

  const dismissPeek = useCallback(() => {
    clearTimeout(peekTimer.current);
    setPeek(null);
  }, []);

  const commit = useCallback((nextList) => {
    listRef.current = nextList;
    setState((s) => ({ ...s, list: nextList }));
  }, []);

  const has = useCallback((sku) => state.list.some((i) => i.sku === sku), [state.list]);

  // item: { sku, name, price, image, color, category }
  // Returns true when the toggle ADDED the item, false when it removed it.
  // Decisions run against the synchronous listRef so two rapid taps behave
  // as a true toggle (add, then remove) instead of both taking the add path.
  const toggle = useCallback((item) => {
    if (!item?.sku) return false;
    const cur = listRef.current;
    const exists = cur.some((i) => i.sku === item.sku);
    if (exists) {
      commit(cur.filter((i) => i.sku !== item.sku));
      // Un-hearting the piece the toast is showing dismisses the toast.
      setPeek((p) => (p && p.sku === item.sku ? null : p));
      return false;
    }
    commit([{ ...item, addedAt: Date.now() }, ...cur].slice(0, MAX_ITEMS));
    clearTimeout(peekTimer.current);
    setPeek({ ...item });
    peekTimer.current = setTimeout(() => setPeek(null), 3600);
    return true;
  }, [commit]);

  const remove = useCallback((sku) => {
    commit(listRef.current.filter((i) => i.sku !== sku));
  }, [commit]);

  // The shell registers its "open the wishlist page" navigation here so the
  // toast's View button can use it without prop cycles.
  const setViewWishlistHandler = useCallback((fn) => { viewRef.current = fn; }, []);
  const requestViewWishlist = useCallback(() => {
    dismissPeek();
    if (viewRef.current) viewRef.current();
  }, [dismissPeek]);

  return (
    <WishlistContext.Provider value={{
      items: state.list, count: state.list.length, has, toggle, remove,
      peek, dismissPeek, requestViewWishlist, setViewWishlistHandler,
    }}>
      {children}
      <WishPeek />
    </WishlistContext.Provider>
  );
}

/** Slide-in confirmation after saving a piece. Portaled to <body> so no
 *  transformed ancestor can trap the fixed positioning. */
function WishPeek() {
  const { peek, dismissPeek, requestViewWishlist } = useWishlist();
  if (!peek) return null;
  return createPortal(
    <div
      data-testid="toast-wishlisted"
      role="status"
      className="fixed z-[70] left-4 right-4 bottom-24 sm:left-auto sm:right-8 sm:bottom-8 sm:w-[380px] animate-in slide-in-from-bottom-4 fade-in duration-300"
    >
      <div className="bg-background border border-border rounded shadow-[0_12px_40px_rgba(26,22,20,0.14)] p-4 flex items-center gap-4">
        {peek.image ? (
          <img src={peek.image} alt="" className="w-12 h-16 object-contain rounded-sm bg-secondary shrink-0" />
        ) : (
          <div className="w-12 h-16 bg-secondary rounded-sm shrink-0 flex items-center justify-center text-primary-ink">
            <Heart size={16} className="fill-primary text-primary-ink" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-wider text-primary-ink mb-0.5">Saved to your wishlist</div>
          <div className="text-[13px] text-foreground truncate font-medium">{peek.name}</div>
          {peek.price > 0 && <div className="text-xs text-muted-foreground">KES {Math.round(Number(peek.price)).toLocaleString("en-KE")}</div>}
        </div>
        <button
          data-testid="toast-view-wishlist"
          onClick={requestViewWishlist}
          className="h-11 px-4 shrink-0 rounded bg-foreground text-background text-xs font-semibold hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          View
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
