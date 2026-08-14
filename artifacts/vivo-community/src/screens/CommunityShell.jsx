import React, { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { CartProvider, useCart } from "@/context/CartContext";
import { WishlistProvider, useWishlist } from "@/context/WishlistContext";
import { Avatar, VivoLogo } from "@/components/community/ui";
import TabHome from "@/components/community/TabHome";
import TabCommunity from "@/components/community/TabCommunity";
import TabShop from "@/components/community/TabShop";
import TabRewards from "@/components/community/TabRewards";
import TabProfile from "@/components/community/TabProfile";
import StyleQuiz from "@/components/community/StyleQuiz";
import ProductDetail from "@/components/community/ProductDetail";
import EventDetail from "@/components/community/EventDetail";
import CartView from "@/components/community/CartView";
import WishlistView from "@/components/community/WishlistView";
import HelpFaqView from "@/components/community/HelpFaqView";
import ContactView from "@/components/community/ContactView";
import TryOnView from "@/components/community/TryOnView";
import MyDataView from "@/components/community/MyDataView";
import LegalPage from "@/components/community/LegalPage";
import NewsArticle from "@/components/community/NewsArticle";
import { isNewsPageId } from "@/components/community/newsData";
import { Home, Users, ShoppingBag, Gift, User, Heart } from "lucide-react";

const TABS = [
  { id: "home", label: "Home", icon: Home },
  { id: "community", label: "Community", icon: Users },
  { id: "shop", label: "Shop", icon: ShoppingBag },
  { id: "rewards", label: "Johari", icon: Gift },
  { id: "profile", label: "Profile", icon: User },
];

// Static help & legal pages routed via the ?page= param. News articles ride
// the same param as "news-{id}", validated against the NEWS list.
const PAGES = ["faq", "contact", "terms", "privacy", "guidelines", "tryon", "mydata"];
const isValidPage = (v) => PAGES.includes(v) || isNewsPageId(v);

const badgeCls = "absolute top-0.5 right-0 min-w-[18px] h-[18px] px-1 rounded-full bg-primary-ink text-primary-foreground text-[10px] font-bold flex items-center justify-center";
const iconBtnCls = "relative w-11 h-11 flex items-center justify-center rounded-full text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2";

function CartButton({ mobile = false }) {
  const { count, requestViewBag } = useCart();
  return (
    <button
      data-testid={mobile ? "cart-btn-mobile" : "cart-btn"}
      aria-label={`Shopping bag${count ? `, ${count} item${count > 1 ? "s" : ""}` : ""}`}
      onClick={requestViewBag}
      className={iconBtnCls}
    >
      <ShoppingBag size={20} strokeWidth={1.5} />
      {count > 0 && (
        <span data-testid={mobile ? "cart-badge-mobile" : "cart-badge"} className={badgeCls}>
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

function WishlistButton({ mobile = false }) {
  const { count, requestViewWishlist } = useWishlist();
  return (
    <button
      data-testid={mobile ? "wishlist-btn-header-mobile" : "wishlist-btn-header"}
      aria-label={`Wishlist${count ? `, ${count} piece${count > 1 ? "s" : ""}` : ""}`}
      onClick={requestViewWishlist}
      className={iconBtnCls}
    >
      <Heart size={20} strokeWidth={1.5} />
      {count > 0 && (
        <span data-testid={mobile ? "wishlist-badge-mobile" : "wishlist-badge"} className={badgeCls}>
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

function ShellInner() {
  const { member, signOut, updateMember } = useAuth();
  const { setViewBagHandler } = useCart();
  const { setViewWishlistHandler } = useWishlist();
  const params = new URLSearchParams(window.location.search);
  const initialTab = params.get("tab") || "home";
  const safeTab = TABS.some((t) => t.id === initialTab) ? initialTab : "home";
  const [tab, setTab] = useState(safeTab);
  const [productSku, setProductSku] = useState(params.get("product") || "");
  // Event detail rides ?event= exactly like ?product= — thumbnail to browse,
  // detail page to act (the Shop pattern, applied to events).
  const [eventId, setEventId] = useState(params.get("event") || "");
  const [cartOpen, setCartOpen] = useState(params.get("cart") === "1");
  const [wlOpen, setWlOpen] = useState(params.get("wishlist") === "1");
  const initialPage = isValidPage(params.get("page")) ? params.get("page") : "";
  const [page, setPage] = useState(initialPage);
  const [quizOpen, setQuizOpen] = useState(params.get("quiz") === "1");
  // Community sub-tab deep-link (?sub=events). subNav carries a nonce so a
  // repeat request lands even when TabCommunity is already mounted.
  const initialSub = params.get("sub") || "";
  const [subNav, setSubNav] = useState(() => (initialSub ? { id: initialSub, n: 1 } : null));
  const viewRef = useRef({
    tab: safeTab,
    sku: params.get("product") || "",
    ev: params.get("event") || "",
    cart: params.get("cart") === "1",
    wl: params.get("wishlist") === "1",
    page: initialPage,
    quiz: params.get("quiz") === "1",
    sub: initialSub,
  });

  // Single place view state changes. mode "push" adds a history entry (opening
  // an overlay), "replace" rewrites the current one, null = popstate restore.
  const applyView = useCallback((next, mode) => {
    viewRef.current = next;
    setTab(next.tab);
    setProductSku(next.sku);
    setEventId(next.ev || "");
    setCartOpen(next.cart);
    setWlOpen(next.wl);
    setPage(next.page);
    setQuizOpen(!!next.quiz);
    if (mode) {
      const url = new URL(window.location);
      url.searchParams.set("tab", next.tab);
      if (next.sku) url.searchParams.set("product", next.sku);
      else url.searchParams.delete("product");
      if (next.ev) url.searchParams.set("event", next.ev);
      else url.searchParams.delete("event");
      if (next.cart) url.searchParams.set("cart", "1");
      else url.searchParams.delete("cart");
      if (next.wl) url.searchParams.set("wishlist", "1");
      else url.searchParams.delete("wishlist");
      if (next.page) url.searchParams.set("page", next.page);
      else url.searchParams.delete("page");
      if (next.quiz) url.searchParams.set("quiz", "1");
      else url.searchParams.delete("quiz");
      if (next.sub) url.searchParams.set("sub", next.sub);
      else url.searchParams.delete("sub");
      if (mode === "push") window.history.pushState({}, "", url);
      else window.history.replaceState({}, "", url);
    }
    window.scrollTo({ top: 0 });
  }, []);

  const openCart = useCallback(() => {
    const cur = viewRef.current;
    if (cur.cart) return;
    applyView({ ...cur, cart: true, wl: false, page: "" }, "push");
  }, [applyView]);

  const openWishlist = useCallback(() => {
    const cur = viewRef.current;
    if (cur.wl) return;
    applyView({ ...cur, wl: true, cart: false, page: "" }, "push");
  }, [applyView]);

  useEffect(() => { setViewBagHandler(openCart); }, [setViewBagHandler, openCart]);
  useEffect(() => { setViewWishlistHandler(openWishlist); }, [setViewWishlistHandler, openWishlist]);

  const openProduct = useCallback((sku) => {
    const cur = viewRef.current;
    if (cur.sku === sku && !cur.cart && !cur.wl) return;
    applyView({ tab: cur.tab, sku, ev: "", cart: false, wl: false, page: "", sub: cur.sub || "" }, "push");
  }, [applyView]);

  const closeCart = useCallback(() => {
    applyView({ ...viewRef.current, cart: false }, "replace");
  }, [applyView]);

  const closeWishlist = useCallback(() => {
    applyView({ ...viewRef.current, wl: false }, "replace");
  }, [applyView]);

  // Style Quiz rides the same URL/history pattern as the other overlays:
  // opening pushes (?quiz=1) so Back closes it, finishing lands on Home.
  const openQuiz = useCallback(() => {
    const cur = viewRef.current;
    if (cur.quiz) return;
    applyView({ ...cur, quiz: true, cart: false, wl: false, page: "" }, "push");
  }, [applyView]);

  const closeQuiz = useCallback(() => {
    applyView({ ...viewRef.current, quiz: false }, "replace");
  }, [applyView]);

  const quizSeeFeed = useCallback(() => {
    applyView({ tab: "home", sku: "", ev: "", cart: false, wl: false, page: "", quiz: false, sub: "" }, "replace");
  }, [applyView]);

  const closeProduct = useCallback(() => {
    const cur = viewRef.current;
    applyView({ tab: cur.tab, sku: "", ev: cur.ev || "", cart: false, wl: false, page: "", sub: cur.sub || "" }, "replace");
  }, [applyView]);

  // Thumbnail → detail, the Shop pattern applied to events. Push so Back
  // returns to wherever the member tapped (events grid, home card, a news
  // article, their profile).
  const openEventDetail = useCallback((id) => {
    const cur = viewRef.current;
    if (cur.ev === id && !cur.cart && !cur.wl && !cur.page) return;
    applyView({ tab: cur.tab, sku: "", ev: id, cart: false, wl: false, page: "", sub: cur.sub || "" }, "push");
  }, [applyView]);

  // The detail page's explicit back control always lands on the Events grid
  // (its labelled destination), whatever route the member arrived by;
  // browser Back still walks the real history.
  const closeEventDetail = useCallback(() => {
    setSubNav((s) => ({ id: "events", n: (s?.n || 0) + 1 }));
    applyView({ tab: "community", sku: "", ev: "", cart: false, wl: false, page: "", sub: "events" }, "replace");
  }, [applyView]);

  const openPage = useCallback((id) => {
    const cur = viewRef.current;
    if (cur.page === id) return;
    applyView({ ...cur, page: id }, "push");
  }, [applyView]);

  const closePage = useCallback(() => {
    applyView({ ...viewRef.current, page: "" }, "replace");
  }, [applyView]);

  // Virtual Try-On entry. The PDP hands its SKU over via sessionStorage —
  // the ?page= param stays a plain id like every other page, and the SKU
  // only matters for the moment of entry (TryOnView consumes and clears it).
  const openTryOn = useCallback((sku) => {
    if (sku) {
      try { sessionStorage.setItem("vivo_tryon_sku", sku); } catch { /* private mode */ }
    }
    openPage("tryon");
  }, [openPage]);

  // Bottom-bar / top-nav navigation always returns to a plain tab.
  const goTab = useCallback((id) => {
    setSubNav(null);
    applyView({ tab: id, sku: "", ev: "", cart: false, wl: false, page: "", sub: "" }, "replace");
  }, [applyView]);

  // Deep-link into Community → Events from anywhere (home card, profile
  // mirror, news articles). Pushes history when coming from another view so
  // Back returns the member to where they tapped.
  const openEvents = useCallback(() => {
    const cur = viewRef.current;
    const alreadyPlainCommunity =
      cur.tab === "community" && !cur.sku && !cur.ev && !cur.cart && !cur.wl && !cur.page;
    setSubNav((s) => ({ id: "events", n: (s?.n || 0) + 1 }));
    applyView(
      { tab: "community", sku: "", ev: "", cart: false, wl: false, page: "", sub: "events" },
      alreadyPlainCommunity ? "replace" : "push"
    );
  }, [applyView]);

  // Keep the URL truthful when the member switches Community sub-tabs
  // themselves. Same history semantics as goTab: lateral tab moves replace
  // (never push), so refresh/share restores the sub-tab without Back having
  // to walk through every tab visited.
  const syncSub = useCallback((id) => {
    const cur = viewRef.current;
    const sub = id && id !== "feed" ? id : "";
    if ((cur.sub || "") === sub) return;
    applyView({ ...cur, sub }, "replace");
  }, [applyView]);

  // Browser Back/Forward restores whatever view the URL describes.
  useEffect(() => {
    const onPop = () => {
      const p = new URLSearchParams(window.location.search);
      const t = p.get("tab") || "home";
      const sub = p.get("sub") || "";
      applyView(
        {
          tab: TABS.some((x) => x.id === t) ? t : "home",
          sku: p.get("product") || "",
          ev: p.get("event") || "",
          cart: p.get("cart") === "1",
          wl: p.get("wishlist") === "1",
          page: isValidPage(p.get("page")) ? p.get("page") : "",
          quiz: p.get("quiz") === "1",
          sub,
        },
        null
      );
      setSubNav(sub ? (s) => ({ id: sub, n: (s?.n || 0) + 1 }) : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyView]);

  // Normalise the URL once on load so refresh/share keeps the full view state.
  useEffect(() => {
    applyView(viewRef.current, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPlainTab = !cartOpen && !wlOpen && !productSku && !eventId && !page;

  return (
    <div className="min-h-[100dvh] bg-background text-foreground font-sans pb-20 sm:pb-0">

      {/* Desktop Header + Tab Bar */}
      <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border hidden sm:block">
        <div className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
          <button onClick={() => goTab("home")} className="flex items-center gap-2.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
            <VivoLogo size="sm" />
            <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">Community</span>
          </button>

          <div className="flex items-center gap-8 h-full">
            {TABS.map((t) => (
              <button
                key={t.id}
                data-testid={`tab-${t.id}`}
                onClick={() => goTab(t.id)}
                className={`h-full flex items-center text-[13px] font-semibold uppercase tracking-wider whitespace-nowrap transition-colors relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${
                  tab === t.id && onPlainTab ? "text-primary-ink" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
                {tab === t.id && onPlainTab && (
                  <span className="absolute bottom-0 left-0 w-full h-[2px] bg-primary" />
                )}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <button
              data-testid="header-points"
              onClick={() => goTab("rewards")}
              className="px-3 py-1.5 rounded-sm bg-secondary text-foreground text-xs font-semibold flex items-center gap-1.5 hover:bg-border transition-colors border border-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              <Gift size={14} className="text-primary-ink" />
              {(member?.points ?? 0).toLocaleString()} <span className="font-normal opacity-70">pts</span>
            </button>
            <WishlistButton />
            <CartButton />
            <button data-testid="header-avatar" aria-label="Profile" onClick={() => goTab("profile")} className="p-1 -m-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
              <Avatar initials={member?.initials || "V"} tier={member?.tier} size="sm" />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Header (Brand + points + wishlist + bag) */}
      <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border sm:hidden flex items-center justify-between px-4 h-14">
        <button onClick={() => goTab("home")} className="flex items-center min-h-[44px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
          <VivoLogo size="sm" />
        </button>
        <div className="flex items-center gap-0.5">
          <button
            data-testid="header-points"
            onClick={() => goTab("rewards")}
            className="px-3 min-h-[36px] my-2 mr-1 rounded bg-secondary text-foreground text-xs font-semibold flex items-center gap-1 hover:bg-border transition-colors border border-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            {(member?.points ?? 0).toLocaleString()} <span className="font-normal opacity-70">pts</span>
          </button>
          <WishlistButton mobile />
          <CartButton mobile />
        </div>
      </header>

      {/* Main Content Area */}
      <main className="mx-auto max-w-6xl p-4 sm:p-8 animate-in fade-in duration-500">
        {page ? (
          page === "tryon" ? (
            <TryOnView onBack={closePage} member={member} />
          ) : page === "mydata" ? (
            <MyDataView onBack={closePage} onOpenPage={openPage} />
          ) : page === "contact" ? (
            <ContactView onBack={closePage} member={member} />
          ) : page === "faq" ? (
            <HelpFaqView onBack={closePage} onOpenPage={openPage} />
          ) : isNewsPageId(page) ? (
            <NewsArticle pageId={page} onBack={closePage} onOpenPage={openPage} onOpenEvents={openEvents} onOpenEvent={openEventDetail} />
          ) : (
            <LegalPage doc={page} onBack={closePage} onOpenPage={openPage} />
          )
        ) : cartOpen ? (
          <CartView onBack={closeCart} onShop={() => goTab("shop")} />
        ) : wlOpen ? (
          <WishlistView onBack={closeWishlist} onShop={() => goTab("shop")} onOpenProduct={openProduct} />
        ) : productSku ? (
          <ProductDetail sku={productSku} onBack={closeProduct} onOpenProduct={openProduct} onTryOn={openTryOn} />
        ) : eventId ? (
          <EventDetail eventId={eventId} onBack={closeEventDetail} onOpenPage={openPage} />
        ) : (
          <>
            {tab === "home" && <TabHome onNavigate={goTab} member={member} onOpenProduct={openProduct} onOpenPage={openPage} onOpenEvent={openEventDetail} />}
            {tab === "community" && <TabCommunity member={member} subNav={subNav} onSubChange={syncSub} onOpenEvent={openEventDetail} />}
            {tab === "shop" && <TabShop onOpenProduct={openProduct} onOpenTryOn={() => openTryOn("")} />}
            {tab === "rewards" && <TabRewards member={member} onMemberUpdate={updateMember} />}
            {tab === "profile" && (
              <TabProfile
                member={member}
                onSignOut={signOut}
                onMemberUpdate={updateMember}
                onOpenWishlist={openWishlist}
                onOpenPage={openPage}
                onOpenEvents={openEvents}
                onOpenEvent={openEventDetail}
                onOpenQuiz={openQuiz}
              />
            )}
          </>
        )}
        {quizOpen && member && (
          <StyleQuiz member={member} onClose={closeQuiz} onMemberUpdate={updateMember} onSeeFeed={quizSeeFeed} />
        )}
      </main>

      {/* Footer — the app-wide home for help & legal links */}
      <footer className="mt-16 border-t border-border">
        <div className="mx-auto max-w-6xl px-4 sm:px-8 py-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <button data-testid="footer-link-faq" onClick={() => openPage("faq")} className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Help & FAQs</button>
            <button data-testid="footer-link-contact" onClick={() => openPage("contact")} className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Contact Us</button>
            <button data-testid="footer-link-terms" onClick={() => openPage("terms")} className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Terms & Conditions</button>
            <button data-testid="footer-link-privacy" onClick={() => openPage("privacy")} className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Privacy Policy</button>
            <button data-testid="footer-link-guidelines" onClick={() => openPage("guidelines")} className="text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Community Guidelines</button>
          </div>
          <p className="text-[12px] text-muted-foreground">© 2026 Vivo Fashion Group · Designed in Nairobi</p>
        </div>
      </footer>

      {/* Mobile Bottom Tab Bar */}
      <div className="fixed bottom-0 left-0 w-full z-40 bg-background border-t border-border sm:hidden pb-[env(safe-area-inset-bottom)]">
        <div className="flex items-center justify-around h-16">
          {TABS.map((t) => {
            const Icon = t.icon;
            const isActive = tab === t.id && onPlainTab;
            return (
              <button
                key={t.id}
                data-testid={`tab-${t.id}-mobile`}
                onClick={() => goTab(t.id)}
                className={`flex flex-col items-center justify-center w-full h-full space-y-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${
                  isActive ? "text-primary-ink" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon size={22} strokeWidth={isActive ? 2 : 1.5} />
                <span className="text-[10px] font-medium">{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

    </div>
  );
}

export default function CommunityShell() {
  const { member } = useAuth();
  return (
    <CartProvider memberId={member?.id}>
      <WishlistProvider memberId={member?.id}>
        <ShellInner />
      </WishlistProvider>
    </CartProvider>
  );
}
