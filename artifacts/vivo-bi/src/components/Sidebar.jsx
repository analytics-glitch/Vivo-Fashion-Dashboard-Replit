import React from "react";
import { NavLink, Link, useNavigate } from "react-router-dom";
import {
  ChartPieSlice,
  MapPin,
  Package,
  Tag,
  Users,
  FileText,
  Footprints,
  ArrowClockwise,
  SignOut,
  CaretDown,
  ShieldCheck,
  ClockClockwise,
  ArrowsClockwise,
  Truck,
  Warning,
  DownloadSimple,
  Target,
  Stack,
  ChatCircleDots,
  Briefcase,
  Megaphone,
  Star,
  List as MenuIcon,
  X as CloseIcon,
} from "@phosphor-icons/react";
import { usePinnedPages } from "@/lib/pinnedPages";
import { useFilters } from "@/lib/filters";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { canAccessPage } from "@/lib/permissions";
import NotificationBell from "@/components/NotificationBell";
import RedisStatusPill from "@/components/RedisStatusPill";
import ReconciliationStatusPill from "@/components/ReconciliationStatusPill";
import SyncStatusPill from "@/components/SyncStatusPill";
import UpstreamHealthPill from "@/components/UpstreamHealthPill";
import BackendUrlWarningPill from "@/components/BackendUrlWarningPill";
import CacheStatsPill from "@/components/CacheStatsPill";
import DataQualityStatusPill from "@/components/DataQualityStatusPill";
// Top-nav tabs come from the shared nav definition (lib/navItems.jsx), the same
// source the Home landing page uses, so the two never drift apart.
import { PRIMARY_NAV as tabs } from "@/lib/navItems";

const relativeTime = (d) => {
  if (!d) return "—";
  const diff = Math.floor((new Date() - d) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
};

// Per-route prefetch map — when the user HOVERS a nav item, we fire the
// page's main API call ahead of time. By the time they actually click,
// the response is already in the 5-min response cache so the page
// renders instantly. Bandwidth-cheap (most calls share the same
// `_FETCH_CACHE` upstream) and silently ignored if the user moves on.
// `_already` guard prevents hammering the cache when a user hovers
// repeatedly over the same item.
const _alreadyPrefetched = new Set();
const _resetPrefetchTokens = () => _alreadyPrefetched.clear();
const prefetchForRoute = (routeId, filters) => {
  const token = `${routeId}|${filters?.dateFrom}|${filters?.dateTo}|${(filters?.countries || []).join(",")}|${(filters?.channels || []).join(",")}`;
  if (_alreadyPrefetched.has(token)) return;
  _alreadyPrefetched.add(token);
  // Reset after 60 s so users hovering an hour later still trigger a
  // refresh (the response cache itself TTLs at 5 min, but the in-process
  // hint should not be sticky for longer than that).
  setTimeout(() => _alreadyPrefetched.delete(token), 60_000);
  const df = filters?.dateFrom;
  const dt = filters?.dateTo;
  const ctry = (filters?.countries || []).join(",");
  const channel = (filters?.channels || []).join(",");
  const p = { date_from: df, date_to: dt, ...(ctry ? { country: ctry } : {}), ...(channel ? { channel } : {}) };
  try {
    if (routeId === "overview") {
      api.get("/bootstrap/overview", { params: p }).catch(() => {});
    } else if (routeId === "customers") {
      api.get("/customers", { params: p }).catch(() => {});
    } else if (routeId === "products") {
      api.get("/analytics/sor-all-styles", { params: { country: ctry || undefined } }).catch(() => {});
    } else if (routeId === "inventory") {
      api.get("/inventory", { params: { country: ctry || undefined } }).catch(() => {});
    } else if (routeId === "locations") {
      api.get("/locations").catch(() => {});
      api.get("/sales-summary", { params: p }).catch(() => {});
    } else if (routeId === "footfall") {
      api.get("/footfall", { params: p }).catch(() => {});
    } else if (routeId === "ibt") {
      api.get("/analytics/ibt-suggestions", { params: p }).catch(() => {});
    } else if (routeId === "replenishments") {
      api.get("/analytics/replenishment-report", { params: { country: ctry || undefined } }).catch(() => {});
    } else if (routeId === "re-order") {
      api.get("/analytics/re-order-list", { params: { country: ctry || undefined } }).catch(() => {});
    } else if (routeId === "allocations") {
      api.get("/analytics/allocations", { params: { country: ctry || undefined } }).catch(() => {});
    } else if (routeId === "targets") {
      api.get("/analytics/annual-targets").catch(() => {});
    }
  } catch { /* prefetch is best-effort */ }
};

const UserMenu = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    const onClick = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);
  if (!user) return null;
  const initials = (user.name || user.email).slice(0, 2).toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-lg hover:bg-panel"
        data-testid="user-menu-btn"
      >
        {user.picture ? (
          <img src={user.picture} alt="" className="w-7 h-7 rounded-full border border-border" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-brand text-white grid place-items-center font-bold text-[11px]">
            {initials}
          </div>
        )}
        <div className="hidden md:block text-left leading-tight">
          <div className="text-[12px] font-semibold">{user.name || user.email.split("@")[0]}</div>
          <div className="text-[10px] text-muted">{user.role}</div>
        </div>
        <CaretDown size={11} className="text-muted" />
      </button>
      {open && (
        <div
          className="absolute right-0 mt-2 w-56 rounded-xl border border-border bg-white shadow-lg py-1 z-50"
          data-testid="user-menu"
        >
          <div className="px-3 py-2 border-b border-border">
            <div className="text-[12px] font-semibold truncate">{user.name || "—"}</div>
            <div className="text-[11px] text-muted truncate">{user.email}</div>
          </div>
          {user.role === "admin" && (
            <>
              <button
                className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-panel flex items-center gap-2"
                onClick={() => { setOpen(false); navigate("/admin/users"); }}
                data-testid="menu-users"
              >
                <ShieldCheck size={13} /> Users
              </button>
              <button
                className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-panel flex items-center gap-2"
                onClick={() => { setOpen(false); navigate("/admin/activity-logs"); }}
                data-testid="menu-logs"
              >
                <ClockClockwise size={13} /> Activity Logs
              </button>
              <button
                className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-panel flex items-center gap-2"
                onClick={() => { setOpen(false); navigate("/admin/feedback"); }}
                data-testid="menu-feedback-inbox"
              >
                <ChatCircleDots size={13} /> Feedback Inbox
              </button>
              <button
                className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-panel flex items-center gap-2"
                onClick={() => { setOpen(false); navigate("/admin/store-clusters"); }}
                data-testid="menu-store-clusters"
              >
                <Stack size={13} /> Store Clusters
              </button>
              <div className="h-px bg-border my-1" />
            </>
          )}
          <button
            className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-panel flex items-center gap-2 text-danger"
            onClick={async () => { setOpen(false); await logout(); navigate("/login", { replace: true }); }}
            data-testid="menu-logout"
          >
            <SignOut size={13} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
};

const TopNav = () => {
  const { lastUpdated, refresh, dateFrom, dateTo, countries, channels } = useFilters();
  const prefetchFilters = React.useMemo(
    () => ({ dateFrom, dateTo, countries, channels }),
    [dateFrom, dateTo, JSON.stringify(countries), JSON.stringify(channels)],
  );
  const { user } = useAuth();
  const visibleTabs = React.useMemo(() => {
    const role = (user?.role || "").toLowerCase();
    // store_manager + warehouse roles can only see the Inventory tab on
    // Exports, so the side-nav label is shortened to match what they'll
    // actually find on the page.
    const inventoryOnly = role === "store_manager" || role === "warehouse";
    return tabs
      .filter((t) => canAccessPage(user, t.id))
      .map((t) =>
        t.id === "exports" && inventoryOnly
          ? { ...t, label: "Exports (Inventory)" }
          : t,
      );
  }, [user]);
  // Per-user pinned pages ("Favorites") — quick one-click access to the handful
  // of pages a user uses most. Order follows the order they were pinned.
  const { pinned, toggle: togglePin, isPinned } = usePinnedPages(user?.user_id);
  const pinnedTabs = React.useMemo(() => {
    const byId = new Map(visibleTabs.map((t) => [t.id, t]));
    // Map pinned ids → currently-visible tabs (drops pages the user can no
    // longer access without mutating their saved pins).
    return pinned.map((id) => byId.get(id)).filter(Boolean);
  }, [pinned, visibleTabs]);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  // Force the relative-time label to re-render every 30s.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  // "Late transfers" badge — count of IBT suggestions first surfaced
  // >5 days ago that nobody has marked done yet. Polled every 5 min so
  // the number stays fresh without spamming the backend.
  const [lateCount, setLateCount] = React.useState(0);
  React.useEffect(() => {
    if (!user || !canAccessPage(user, "ibt")) return;
    let cancelled = false;
    const fetch = () => {
      api.get("/ibt/late-count")
        .then((r) => { if (!cancelled) setLateCount(r.data?.count || 0); })
        .catch(() => { /* non-critical */ });
    };
    fetch();
    const id = setInterval(fetch, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user]);

  // "Pending replenishment recommendations" badge — count of replenishment
  // recommendation actions still awaiting a decision. Polled every 5 min.
  const [replenPending, setReplenPending] = React.useState(0);
  React.useEffect(() => {
    if (!user || !canAccessPage(user, "replenishments")) return;
    let cancelled = false;
    const fetch = () => {
      api.get("/recommendations/summary")
        .then((r) => {
          if (cancelled) return;
          const d = r.data || {};
          let n = 0;
          for (const [recType, byStatus] of Object.entries(d)) {
            // Backend tags replenishment recommendation actions rec_type="replenish".
            if (String(recType).toLowerCase() === "replenish") {
              n += Number(byStatus?.pending || 0);
            }
          }
          setReplenPending(n);
        })
        .catch(() => { /* non-critical */ });
    };
    fetch();
    const id = setInterval(fetch, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user]);
  return (
    <nav
      className="relative px-3 sm:px-5 lg:px-10 pt-2.5 pb-1.5 no-print bg-[#fed7aa] border-b border-border"
      data-testid="top-nav"
    >
      {/* Row 1: brand · utility pills (full width) */}
      <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 sm:gap-3 shrink-0 min-w-0">
        <button
          type="button"
          className="lg:hidden p-1.5 -ml-1 rounded-lg hover:bg-panel"
          onClick={() => setMobileOpen((v) => !v)}
          data-testid="mobile-menu-btn"
          aria-label="Toggle navigation"
        >
          {mobileOpen ? <CloseIcon size={20} /> : <MenuIcon size={20} />}
        </button>
        <Link
          to="/"
          className="flex items-center gap-2 sm:gap-3 min-w-0 hover:opacity-90 transition-opacity"
          data-testid="brand-logo"
          aria-label="Vivo Fashion Group — home"
        >
          <img
            src="/brand/vivo-logo.png"
            alt="Vivo"
            className="h-8 sm:h-9 w-auto rounded-md shrink-0"
          />
          <span className="leading-tight min-w-0">
            <span className="block text-[13px] sm:text-[14px] font-bold tracking-tight text-foreground truncate">
              Vivo Fashion Group
            </span>
            <span className="hidden sm:block text-[10.5px] text-muted uppercase tracking-wider">
              BI · East Africa
            </span>
          </span>
        </Link>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2 text-[11.5px] text-muted">
        <span className="hidden xl:inline" data-testid="last-updated">
          Updated {relativeTime(lastUpdated)}
        </span>
        <button
          type="button"
          onClick={() => {
            // Dispatch the same keyboard shortcut the palette listens for.
            const evt = new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true });
            window.dispatchEvent(evt);
          }}
          className="hidden md:inline-flex items-center gap-1.5 text-[11px] text-muted hover:text-brand px-2 py-1 rounded-md border border-border hover:border-brand transition-colors"
          data-testid="open-global-search"
          title="Open global search (⌘K)"
        >
          <span className="hidden lg:inline">Search</span>
          <kbd className="bg-panel px-1 py-0.5 rounded text-[10px] border border-border">⌘K</kbd>
        </button>
        <button
          type="button"
          onClick={refresh}
          data-testid="refresh-data-btn"
          className="p-1.5 rounded-lg hover:bg-panel text-foreground/70 hover:text-brand transition-colors"
          title="Refresh data from API"
        >
          <ArrowClockwise size={15} weight="bold" />
        </button>
        <NotificationBell />
        <BackendUrlWarningPill />
        <UpstreamHealthPill />
        <SyncStatusPill />
        <ReconciliationStatusPill />
        <DataQualityStatusPill />
        <CacheStatsPill />
        <RedisStatusPill />
        <UserMenu />
      </div>
      </div>

      {/* Favorites — per-user pinned pages for one-click access. Desktop only;
          shown when the user has pinned at least one page. */}
      {pinnedTabs.length > 0 && (
        <div
          className="hidden lg:flex items-center gap-x-1 gap-y-1 justify-start flex-wrap mt-2 -mx-1 px-1"
          data-testid="top-nav-favorites"
        >
          <span className="inline-flex items-center gap-1 pl-1 pr-1 text-[10.5px] font-semibold uppercase tracking-wider text-foreground/55 select-none">
            <Star size={12} weight="fill" className="text-amber-500" />
            Favorites
          </span>
          {pinnedTabs.map((t) => (
            <NavLink
              key={`fav-${t.id}`}
              to={t.to}
              end={t.to === "/"}
              reloadDocument={t.external}
              data-testid={`fav-${t.id}`}
              onMouseEnter={() => prefetchForRoute(t.id, prefetchFilters)}
              onFocus={() => prefetchForRoute(t.id, prefetchFilters)}
              className={({ isActive }) =>
                `flex items-center gap-1 px-1.5 xl:px-2 py-1 rounded-md text-[11px] xl:text-[12px] font-medium transition-colors whitespace-nowrap border ${
                  isActive
                    ? "bg-brand text-white border-brand shadow-sm"
                    : "bg-white/60 text-foreground/75 border-border hover:bg-panel hover:text-foreground"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <t.icon size={13} weight={isActive ? "fill" : "regular"} />
                  <span>{t.label}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`Unpin ${t.label} from Favorites`}
                    title="Unpin from Favorites"
                    data-testid={`unpin-${t.id}`}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePin(t.id); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePin(t.id); } }}
                    className={`ml-0.5 -mr-0.5 p-0.5 rounded ${isActive ? "text-amber-200 hover:text-white" : "text-amber-500 hover:text-amber-600"}`}
                  >
                    <Star size={12} weight="fill" />
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      )}

      {/* Row 2: page-name tabs (full viewport width, max 2 rows) */}
      <div
        className="hidden lg:flex items-center gap-x-1 gap-y-1 justify-start flex-wrap mt-2 -mx-1 px-1"
        data-testid="top-nav-tabs"
      >
        {visibleTabs.map((t) => (
          <NavLink
            key={t.id}
            to={t.to}
            end={t.to === "/"}
            reloadDocument={t.external}
            data-testid={`nav-${t.id}`}
            onMouseEnter={() => prefetchForRoute(t.id, prefetchFilters)}
            onFocus={() => prefetchForRoute(t.id, prefetchFilters)}
            className={({ isActive }) =>
              `group flex items-center gap-1 px-1.5 xl:px-2 py-1 rounded-md text-[11px] xl:text-[12px] font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? "bg-brand text-white shadow-sm"
                  : "text-foreground/70 hover:bg-panel hover:text-foreground"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <t.icon size={13} weight={isActive ? "fill" : "regular"} />
                <span>{t.label}</span>
                {t.id === "ibt" && lateCount > 0 && (
                  <span
                    className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-bold leading-none animate-pulse"
                    title={`${lateCount} transfer${lateCount === 1 ? "" : "s"} suggested >5 days ago and not yet marked done`}
                    data-testid="ibt-late-badge"
                  >
                    {lateCount > 99 ? "99+" : lateCount}
                  </span>
                )}
                {t.id === "replenishments" && replenPending > 0 && (
                  <span
                    className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-brand text-white text-[10px] font-bold leading-none"
                    title={`${replenPending} replenishment recommendation${replenPending === 1 ? "" : "s"} pending review`}
                    data-testid="replen-pending-badge"
                  >
                    {replenPending > 99 ? "99+" : replenPending}
                  </span>
                )}
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={isPinned(t.id) ? `Unpin ${t.label} from Favorites` : `Pin ${t.label} to Favorites`}
                  title={isPinned(t.id) ? "Unpin from Favorites" : "Pin to Favorites"}
                  data-testid={`pin-${t.id}`}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePin(t.id); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePin(t.id); } }}
                  className={`ml-0.5 -mr-0.5 p-0.5 rounded transition-opacity ${
                    isPinned(t.id) ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                  } ${isActive ? "text-amber-200 hover:text-white" : "text-amber-500 hover:text-amber-600"}`}
                >
                  <Star size={12} weight={isPinned(t.id) ? "fill" : "regular"} />
                </span>
              </>
            )}
          </NavLink>
        ))}
      </div>

      {mobileOpen && (
        <div
          className="lg:hidden absolute left-0 right-0 top-full bg-white border-b border-border shadow-md z-40 px-3 py-2 flex flex-col gap-1"
          data-testid="mobile-menu"
        >
          {pinnedTabs.length > 0 && (
            <>
              <div className="px-3 pt-1 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-foreground/55 flex items-center gap-1 select-none">
                <Star size={12} weight="fill" className="text-amber-500" /> Favorites
              </div>
              {pinnedTabs.map((t) => (
                <NavLink
                  key={`fav-m-${t.id}`}
                  to={t.to}
                  end={t.to === "/"}
                  reloadDocument={t.external}
                  onClick={() => setMobileOpen(false)}
                  data-testid={`nav-mobile-fav-${t.id}`}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[14px] font-medium ${
                      isActive ? "bg-brand text-white" : "text-foreground/80 hover:bg-panel"
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <t.icon size={17} weight={isActive ? "fill" : "regular"} />
                      <span>{t.label}</span>
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={`Unpin ${t.label} from Favorites`}
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePin(t.id); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePin(t.id); } }}
                        className={`ml-auto p-1 ${isActive ? "text-amber-200" : "text-amber-500"}`}
                      >
                        <Star size={16} weight="fill" />
                      </span>
                    </>
                  )}
                </NavLink>
              ))}
              <div className="h-px bg-border my-1 mx-3" />
            </>
          )}
          {visibleTabs.map((t) => (
            <NavLink
              key={t.id}
              to={t.to}
              end={t.to === "/"}
              reloadDocument={t.external}
              onClick={() => setMobileOpen(false)}
              data-testid={`nav-mobile-${t.id}`}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[14px] font-medium ${
                  isActive
                    ? "bg-brand text-white"
                    : "text-foreground/80 hover:bg-panel"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <t.icon size={17} weight={isActive ? "fill" : "regular"} />
                  <span>{t.label}</span>
                  {t.id === "ibt" && lateCount > 0 && (
                    <span
                      className="ml-auto inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-rose-600 text-white text-[11px] font-bold leading-none"
                      data-testid="ibt-late-badge-mobile"
                    >
                      {lateCount > 99 ? "99+" : lateCount}
                    </span>
                  )}
                  {t.id === "replenishments" && replenPending > 0 && (
                    <span
                      className="ml-auto inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-brand text-white text-[11px] font-bold leading-none"
                      data-testid="replen-pending-badge-mobile"
                    >
                      {replenPending > 99 ? "99+" : replenPending}
                    </span>
                  )}
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={isPinned(t.id) ? `Unpin ${t.label} from Favorites` : `Pin ${t.label} to Favorites`}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePin(t.id); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); togglePin(t.id); } }}
                    className={`${t.id === "ibt" || t.id === "replenishments" ? "ml-1" : "ml-auto"} p-1 ${isPinned(t.id) ? "text-amber-500" : "text-foreground/30"}`}
                  >
                    <Star size={16} weight={isPinned(t.id) ? "fill" : "regular"} />
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      )}
    </nav>
  );
};

export default TopNav;
