import { NavLink, useLocation } from "react-router";
import { useEffect, type ReactNode } from "react";
import { auth } from "../lib/api";
import { HomeIcon, GiftIcon, BagIcon, ShopIcon, UserIcon, SparkIcon, CartIcon, HeartIcon } from "./icons";
import { formatPoints } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useCart } from "../lib/cart";
import { useWishlist } from "../lib/wishlist";
import { InstallPrompt } from "./install-prompt";
import { UpdatePrompt } from "./update-prompt";

const nav = [
  { to: "/dashboard", label: "Home", Icon: HomeIcon },
  { to: "/rewards", label: "Rewards", Icon: GiftIcon },
  { to: "/shop", label: "Shop", Icon: ShopIcon },
  { to: "/orders", label: "Orders", Icon: BagIcon },
  { to: "/profile", label: "Profile", Icon: UserIcon },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { count } = useCart();
  const { count: wishCount } = useWishlist();
  const location = useLocation();

  // Telemetry heartbeat: report activity, install status, and app version.
  useEffect(() => {
    const installed =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    const version =
      (document.querySelector('script[src*="/assets/manifest-"]') as HTMLScriptElement | null)
        ?.src.match(/manifest-([^.]+)\.js/)?.[1] ?? null;
    const beat = () => {
      if (document.visibilityState === "visible") auth.heartbeat(installed, version).catch(() => {});
    };
    beat();
    document.addEventListener("visibilitychange", beat);
    const id = window.setInterval(beat, 120_000);
    return () => {
      document.removeEventListener("visibilitychange", beat);
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col">
      {/* Top bar */}
      <header
        className="sticky top-0 z-30 flex items-center justify-between px-5 pb-3 backdrop-blur-xl"
        style={{
          background: "color-mix(in srgb, var(--bg) 80%, transparent)",
          paddingTop: "calc(env(safe-area-inset-top) + 1.25rem)",
        }}
      >
        <NavLink to="/dashboard" className="tap flex items-center gap-2">
          <img
            src="/loyalty-app/icons/vivo-mark.png"
            alt="Vivo Loyalty"
            className="h-8 w-8 rounded-lg object-cover"
          />
          <span className="text-[15px] font-bold tracking-tight">Vivo Loyalty</span>
        </NavLink>
        <div className="flex items-center gap-2">
          {user && (
            <NavLink
              to="/rewards"
              className="tap flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 py-1.5 text-sm font-bold text-white shadow-[var(--shadow-accent)]"
            >
              <SparkIcon className="h-4 w-4" />
              {formatPoints(user.pointsBalance)}
            </NavLink>
          )}
          <NavLink
            to="/wishlist"
            aria-label="Wishlist"
            className="tap relative grid h-9 w-9 place-items-center rounded-full border border-[var(--card-border)] bg-[var(--card)]"
          >
            <HeartIcon className="h-5 w-5" />
            {wishCount > 0 && (
              <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-bold text-white">
                {wishCount}
              </span>
            )}
          </NavLink>
          <NavLink
            to="/cart"
            aria-label="Cart"
            className="tap relative grid h-9 w-9 place-items-center rounded-full border border-[var(--card-border)] bg-[var(--card)]"
          >
            <CartIcon className="h-5 w-5" />
            {count > 0 && (
              <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-bold text-white">
                {count}
              </span>
            )}
          </NavLink>
        </div>
      </header>

      {/* Content */}
      <main key={location.pathname} className="fade-in flex-1 px-4 pb-28 pt-1">{children}</main>

      <InstallPrompt />
      <UpdatePrompt />

      {/* Bottom nav */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md">
        <div
          className="mx-3 mb-2 flex items-center justify-around rounded-3xl border border-white/10 bg-[#14141c]/95 px-2 py-1.5 backdrop-blur-xl"
          style={{
            boxShadow:
              "0 -7px 26px -6px rgba(254,106,2,0.55), 0 -2px 0 0 rgba(254,106,2,0.85), 0 6px 22px rgba(0,0,0,0.35)",
          }}
        >
          {nav.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className="tap group flex flex-1 flex-col items-center gap-0.5 rounded-2xl py-1.5"
            >
              {({ isActive }) => (
                <>
                  <span
                    className={`grid place-items-center rounded-xl px-3 py-1 transition-colors ${
                      isActive ? "bg-[var(--accent)] text-white" : "text-white/55"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <span
                    className={`text-[10px] font-medium ${
                      isActive ? "text-white" : "text-white/55"
                    }`}
                  >
                    {label}
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
