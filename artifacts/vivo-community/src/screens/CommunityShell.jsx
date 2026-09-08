import React, { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { CartProvider, useCart } from "@/context/CartContext";
import { WishlistProvider, useWishlist } from "@/context/WishlistContext";
import { Avatar, VivoLogo, JohariWordmark } from "@/components/community/ui";
import TabHome from "@/components/community/TabHome";
import TabCommunity from "@/components/community/TabCommunity";
import StyleBoardsLanding from "@/components/community/StyleBoardsLanding";
import TabShop from "@/components/community/TabShop";
import TabRewards from "@/components/community/TabRewards";
import TabProfile from "@/components/community/TabProfile";
import StyleQuiz from "@/components/community/StyleQuiz";
import ProductDetail from "@/components/community/ProductDetail";
import EventDetail from "@/components/community/EventDetail";
import CartView from "@/components/community/CartView";
import WishlistView from "@/components/community/WishlistView";
import HelpFaqView from "@/components/community/HelpFaqView";
import HelpLandingView from "@/components/community/HelpLandingView";
import GivingBackView from "@/components/community/GivingBackView";
import { FabulasStoryView } from "@/components/community/FabulasStory";
import ContactView from "@/components/community/ContactView";
import TryOnView from "@/components/community/TryOnView";
import MyDataView from "@/components/community/MyDataView";
import { StylePrefsView } from "@/components/community/StyledForYou";
import { VivoEditsAllView, VivoEditDetail, VivoEditsHome } from "@/components/community/VivoEdits";
import StoreLocatorView from "@/components/community/StoreLocatorView";
import { DeliveryInfoView, ReturnsInfoView } from "@/components/community/ShoppingInfoViews";
import LegalPage from "@/components/community/LegalPage";
import NewsArticle from "@/components/community/NewsArticle";
import CampaignArticle from "@/components/community/CampaignArticle";
import { ReferAFriendView, WeeklyMissionsView } from "@/components/community/DestinationViews";
import { isNewsPageId } from "@/components/community/newsData";
import MobileMenu from "@/components/community/MobileMenu";
import { Home, Users, ShoppingBag, Gift, User, Heart, HelpCircle, Search, Menu } from "lucide-react";

const TABS = [
  { id: "home", label: "Home", icon: Home },
  { id: "shop", label: "Shop", icon: ShoppingBag },
  { id: "community", label: "Community", icon: Users },
  { id: "rewards", label: "Rewards", icon: Gift },
  { id: "profile", label: "Account", icon: User },
];

/**
 * How many tabs the mobile nav row shows before the hamburger.
 *
 * Four is what fits a 360px screen without the row scrolling. It used to hold
 * all five by overflowing horizontally, which put "Account" off the edge of
 * the smallest phones with nothing to say it was there.
 */
const MOBILE_TAB_COUNT = 4;
const MOBILE_TABS = TABS.slice(0, MOBILE_TAB_COUNT);
const MENU_TABS = TABS.slice(MOBILE_TAB_COUNT);

// Static help & legal pages routed via the ?page= param. News articles ride
// the same param as "news-{id}", validated against the NEWS list.
const PAGES = ["faq", "contact", "terms", "privacy", "guidelines", "tryon", "mydata", "help", "givingback", "styleprefs", "stores", "delivery", "returns", "edits", "refer", "missions"];
// Campaign articles ride ?page=article-{slug} — server-validated (404 UI on
// unknown slugs), guest-readable like news pages (composer is member-gated).
const isArticlePageId = (v) => /^article-[a-z0-9-]+$/.test(v || "");
const isValidPage = (v) => PAGES.includes(v) || isNewsPageId(v) || isArticlePageId(v);

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

/* Guest fence for member-only tabs — browsing stays open, membership
   surfaces invite her in. exitGuest returns to the welcome screen. */
function GuestGate({ title, body, onJoin }) {
  return (
    <div className="max-w-md mx-auto text-center py-16">
      <div className="flex justify-center mb-6"><VivoLogo size="md" /></div>
      <h2 className="font-serif text-2xl text-foreground mb-2">{title}</h2>
      <p className="text-[14px] text-muted-foreground leading-relaxed mb-8">{body}</p>
      <button
        data-testid="guest-join-cta"
        onClick={onJoin}
        className="h-12 px-8 rounded bg-primary text-primary-foreground font-medium text-[15px] hover:opacity-90 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        Sign in or create account
      </button>
    </div>
  );
}

function ShellInner() {
  const { member, signOut, updateMember, exitGuest } = useAuth();
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
  // Vivo Edit detail rides ?edit= exactly like ?event= — card to browse,
  // detail page to explore and shop.
  const [editId, setEditId] = useState(params.get("edit") || "");
  // Deliberately NOT in the URL. The other overlays are deep-linkable because
  // they are destinations; this is a way of getting to one, and a back button
  // that only closes a menu is a back button that does nothing.
  const [menuOpen, setMenuOpen] = useState(false);
  const [cartOpen, setCartOpen] = useState(params.get("cart") === "1");
  const [wlOpen, setWlOpen] = useState(params.get("wishlist") === "1");
  const initialPage = isValidPage(params.get("page")) ? params.get("page") : "";
  const [page, setPage] = useState(initialPage);
  const [quizOpen, setQuizOpen] = useState(params.get("quiz") === "1");
  // Community sub-tab deep-link (?sub=events). subNav carries a nonce so a
  // repeat request lands even when TabCommunity is already mounted.
  const initialSub = params.get("sub") || "";
  const [subNav, setSubNav] = useState(() => (initialSub ? { id: initialSub, n: 1 } : null));
  const [communityComposeAction, setCommunityComposeAction] = useState(null);
  // #FabulasAtAnyAge story overlay — plain shell state (an overlay, not a
  // route): Escape/close never disturbs the URL underneath.
  const [fabulasId, setFabulasId] = useState("");
  const viewRef = useRef({
    tab: safeTab,
    sku: params.get("product") || "",
    ev: params.get("event") || "",
    edit: params.get("edit") || "",
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
    setEditId(next.edit || "");
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
      if (next.edit) url.searchParams.set("edit", next.edit);
      else url.searchParams.delete("edit");
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

  const quizSeeShop = useCallback(() => {
    // This tap is the one-shot bridge from quiz completion to Shop. TabShop
    // also defaults completed members to curated, but preserving the intent
    // avoids a brief uncurated render while member state refreshes.
    try { sessionStorage.setItem("vivo_shop_style_dna_handoff", "1"); } catch { /* private mode */ }
    applyView({ tab: "shop", sku: "", ev: "", cart: false, wl: false, page: "", quiz: false, sub: "" }, "replace");
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

  // Vivo Edit detail — card → detail, the Shop pattern. Push so Back returns
  // to wherever she tapped (home section or the all-edits grid).
  const openEdit = useCallback((id) => {
    const cur = viewRef.current;
    if (cur.edit === id && !cur.cart && !cur.wl && !cur.page) return;
    applyView({ tab: cur.tab, sku: "", ev: "", edit: id, cart: false, wl: false, page: "", sub: cur.sub || "" }, "push");
  }, [applyView]);

  const closeEdit = useCallback(() => {
    applyView({ ...viewRef.current, edit: "" }, "replace");
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

  const openCommunityComposer = useCallback((type) => {
    setCommunityComposeAction({ type, nonce: Date.now() });
    goTab("community");
  }, [goTab]);

  const clearCommunityComposeAction = useCallback(() => {
    setCommunityComposeAction(null);
  }, []);

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

  const openStyleBoards = useCallback(() => {
    const cur = viewRef.current;
    const alreadyPlainCommunity =
      cur.tab === "community" && !cur.sku && !cur.ev && !cur.cart && !cur.wl && !cur.page;
    setSubNav((s) => ({ id: "style_boards", n: (s?.n || 0) + 1 }));
    applyView(
      { tab: "community", sku: "", ev: "", cart: false, wl: false, page: "", sub: "style_boards" },
      alreadyPlainCommunity ? "replace" : "push"
    );
  }, [applyView]);

  // A Fabulas story's "share yours" hand-off — land on Community →
  // Challenges where the #FabulasAtAnyAge flagship lives (push: Back
  // returns to wherever she was reading).
  const openChallengesFromFabulas = useCallback(() => {
    setFabulasId("");
    setSubNav((sn) => ({ id: "challenges", n: (sn?.n || 0) + 1 }));
    applyView({ tab: "community", sku: "", ev: "", cart: false, wl: false, page: "", sub: "challenges" }, "push");
  }, [applyView]);

  const openChallenges = useCallback(() => {
    const cur = viewRef.current;
    const alreadyPlainCommunity =
      cur.tab === "community" && !cur.sku && !cur.ev && !cur.cart && !cur.wl && !cur.page;
    setSubNav((sn) => ({ id: "challenges", n: (sn?.n || 0) + 1 }));
    applyView(
      { tab: "community", sku: "", ev: "", cart: false, wl: false, page: "", sub: "challenges" },
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
          edit: p.get("edit") || "",
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

  const onPlainTab = !cartOpen && !wlOpen && !productSku && !eventId && !editId && !page;

  return (
    <div className="min-h-[100dvh] bg-background text-foreground font-sans">

      {/* Desktop Header + Tab Bar */}
      <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border hidden sm:block">
        <div className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
          <button onClick={() => goTab("home")} className="flex shrink-0 items-center gap-2.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
            <VivoLogo size="sm" className="shrink-0" />
            {/* JOHARI joins the lockup only when the header has room —
                squeezed widths were painting it over the HOME tab. */}
            <JohariWordmark className="hidden lg:inline text-[13px] text-foreground/85 pt-0.5" />
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
            <button
              data-testid="nav-help"
              onClick={() => openPage("help")}
              className={`h-full flex items-center text-[13px] font-semibold uppercase tracking-wider whitespace-nowrap transition-colors relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${
                page === "help" ? "text-primary-ink" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Help
              {page === "help" && <span className="absolute bottom-0 left-0 w-full h-[2px] bg-primary" />}
            </button>
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

      {/* Mobile Header — sticky white bar: search left, logo centred, bag
          (with badge) right. Help + wishlist keep their places beside them. */}
      <header className="sticky top-0 z-40 bg-background/95 backdrop-blur-md border-b border-border sm:hidden">
        <div className="relative flex items-center justify-between px-2 h-14">
          <div className="flex items-center">
            <button
              data-testid="header-search"
              aria-label="Search the collection"
              onClick={() => goTab("shop")}
              className={iconBtnCls}
            >
              <Search size={20} strokeWidth={1.5} />
            </button>
            <button
              data-testid="nav-help-mobile"
              aria-label="Help"
              onClick={() => openPage("help")}
              className={iconBtnCls}
            >
              <HelpCircle size={19} strokeWidth={1.5} />
            </button>
          </div>
          <button
            aria-label="Vivo home"
            onClick={() => goTab("home")}
            className="absolute left-1/2 -translate-x-1/2 flex items-center min-h-[44px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            <VivoLogo size="sm" />
          </button>
          <div className="flex items-center">
            <WishlistButton mobile />
            <CartButton mobile />
          </div>
        </div>
        {/* Mobile top nav row — replaces the old bottom tab bar (rewire spec
            §"mobile nav"). Four tabs fit; the rest live behind the hamburger,
            which is pinned right and does not scroll away. Same testids. */}
        <nav aria-label="Primary" className="flex items-stretch border-t border-border/60">
          <div className="flex gap-6 px-4 flex-1 min-w-0 overflow-x-auto hide-scrollbar">
            {MOBILE_TABS.map((t) => {
              const isActive = tab === t.id && onPlainTab;
              return (
                <button
                  key={t.id}
                  data-testid={`tab-${t.id}-mobile`}
                  onClick={() => goTab(t.id)}
                  className={`relative py-2.5 text-[12px] font-semibold uppercase tracking-wider whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${
                    isActive ? "text-primary-ink" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.label}
                  {isActive && <span className="absolute bottom-0 left-0 w-full h-[2px] bg-primary" />}
                </button>
              );
            })}
          </div>
          <button
            data-testid="mobile-menu-open"
            aria-label="More"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
            className={`relative shrink-0 px-4 flex items-center border-l border-border/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${
              // A tab that now lives in the drawer still has to look selected,
              // or the member loses their place the moment they open Account.
              MENU_TABS.some((t) => t.id === tab) && onPlainTab
                ? "text-primary-ink"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Menu size={18} strokeWidth={1.75} />
            {MENU_TABS.some((t) => t.id === tab) && onPlainTab && (
              <span className="absolute bottom-0 left-0 w-full h-[2px] bg-primary" />
            )}
          </button>
        </nav>
      </header>

      <MobileMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        tabs={MENU_TABS}
        activeTab={onPlainTab ? tab : ""}
        activePage={page}
        onTab={goTab}
        onPage={openPage}
      />

      {/* Main Content Area */}
      <main className="mx-auto max-w-6xl p-4 sm:p-8 animate-in fade-in duration-500">
        {/* Guest fence for deep-linkable member surfaces — overlays reachable
            via URL state (?page= / ?event=) that carry member-authenticated
            writes: try-on, survey, my-data, contact and event RSVP. Browsing
            surfaces (products, cart, wishlist, news, legal, help) stay open. */}
        {!member && (quizOpen || eventId || ["tryon", "mydata", "contact", "styleprefs", "refer", "missions"].includes(page)) ? (
          <GuestGate
            title={quizOpen ? "Your Style Quiz is for members" : eventId ? "Events are for members" : "This is a member space"}
            body={quizOpen
              ? "Create a free Vivo Johari account to save your Style DNA and receive a collection made for you."
              : "Sign in or create a free account to RSVP to events, use member tools and get in touch — it only takes a minute."}
            onJoin={exitGuest}
          />
        ) : page ? (
          page === "refer" ? (
            <ReferAFriendView onBack={closePage} />
          ) : page === "missions" ? (
            <WeeklyMissionsView onBack={closePage} />
          ) : page === "tryon" ? (
            <TryOnView onBack={closePage} member={member} />
          ) : page === "styleprefs" ? (
            <StylePrefsView onBack={closePage} />
          ) : page === "stores" ? (
            <StoreLocatorView onBack={closePage} />
          ) : page === "delivery" ? (
            <DeliveryInfoView onBack={closePage} />
          ) : page === "returns" ? (
            <ReturnsInfoView onBack={closePage} />
          ) : page === "mydata" ? (
            <MyDataView onBack={closePage} onOpenPage={openPage} />
          ) : page === "contact" ? (
            <ContactView onBack={closePage} member={member} />
          ) : page === "help" ? (
            <HelpLandingView onBack={closePage} onOpenPage={openPage} />
          ) : page === "givingback" ? (
            <GivingBackView onBack={closePage} />
          ) : page === "edits" ? (
            <VivoEditsAllView onBack={closePage} onOpenEdit={openEdit} />
          ) : page === "faq" ? (
            <HelpFaqView onBack={closePage} onOpenPage={openPage} />
          ) : isArticlePageId(page) ? (
            <CampaignArticle slug={page.slice("article-".length)} member={member} onBack={closePage} onJoin={exitGuest} />
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
          <ProductDetail sku={productSku} onBack={closeProduct} onOpenProduct={openProduct} onTryOn={openTryOn} onOpenPage={openPage} />
        ) : eventId ? (
          <EventDetail eventId={eventId} onBack={closeEventDetail} onOpenPage={openPage} />
        ) : editId ? (
          <VivoEditDetail editId={editId} onBack={closeEdit} onOpenProduct={openProduct} member={member} onGuest={exitGuest} />
        ) : (
          <>
            {tab === "home" && <TabHome onNavigate={goTab} member={member} onOpenProduct={openProduct} onOpenPage={openPage} onOpenEvents={openEvents} onOpenEvent={openEventDetail} onOpenStyleBoards={openStyleBoards} onOpenChallenges={openChallenges} onOpenFabulas={setFabulasId} onOpenCommunityComposer={openCommunityComposer} />}
            {tab === "community" && !member && subNav?.id === "style_boards" && (
              <StyleBoardsLanding onGuest={exitGuest} />
            )}
            {tab === "community" && !member && subNav?.id !== "style_boards" && (
              <>
                <GuestGate
                  title="Join the conversation"
                  body="Posting, style challenges, likes and comments are for members — sign in or create a free account to take part."
                  onJoin={exitGuest}
                />
                {/* Editorial reads stay guest-open: Vivo Edits browsing was
                    guest-visible on Home pre-rewire and keeps that access here. */}
                <div className="mt-10">
                  <VivoEditsHome onOpenEdit={openEdit} onViewAll={() => openPage("edits")} />
                </div>
              </>
            )}
            {tab === "community" && member && <TabCommunity member={member} subNav={subNav} composeAction={communityComposeAction} onComposeActionConsumed={clearCommunityComposeAction} onSubChange={syncSub} onOpenEvent={openEventDetail} onOpenProduct={openProduct} onOpenPage={openPage} onOpenFabulas={setFabulasId} onOpenEdit={openEdit} onOpenEdits={() => openPage("edits")} />}
            {tab === "shop" && <TabShop member={member} onOpenProduct={openProduct} onOpenTryOn={() => openTryOn("")} onOpenPage={openPage} onOpenQuiz={openQuiz} onOpenEdit={openEdit} onOpenEdits={() => openPage("edits")} />}
            {tab === "rewards" && (member ? (
              <TabRewards
                member={member}
                onMemberUpdate={updateMember}
                onOpenPage={openPage}
                onOpenShop={() => goTab("shop")}
                onOpenCommunity={() => goTab("community")}
                onOpenChallenges={openChallenges}
              />
            ) : (
              <GuestGate
                title="Rewards are for members"
                body="Join Vivo Johari to earn points on everything you share and shop — and unlock member-only rewards."
                onJoin={exitGuest}
              />
            ))}
            {tab === "profile" && !member && (
              <GuestGate
                title="You're browsing as a guest"
                body="Sign in or create a free account to build your profile, save your style and join the community."
                onJoin={exitGuest}
              />
            )}
            {tab === "profile" && member && (
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
          <StyleQuiz member={member} onClose={closeQuiz} onMemberUpdate={updateMember} onSeeShop={quizSeeShop} />
        )}
        {fabulasId && (
          <FabulasStoryView
            storyId={fabulasId}
            onClose={() => setFabulasId("")}
            onShareStory={openChallengesFromFabulas}
          />
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
