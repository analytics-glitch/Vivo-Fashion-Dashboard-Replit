import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { useEffect } from "react";

import type { Route } from "./+types/root";
import "./app.css";
import { AuthProvider } from "./lib/auth";
import { CartProvider } from "./lib/cart";
import { WishlistProvider } from "./lib/wishlist";
import { ToastProvider } from "./components/toast";

// After a deploy, a still-open tab may reference an old JS chunk that no longer
// exists → its dynamic import fails. Vite fires `vite:preloadError`; reload once
// (fresh index → fresh chunks) instead of hanging on the splash.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", () => {
    if (!sessionStorage.getItem("vivo_chunk_reload")) {
      sessionStorage.setItem("vivo_chunk_reload", "1");
      window.location.reload();
    }
  });
}

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
  { rel: "manifest", href: "/loyalty-app/manifest.webmanifest" },
  { rel: "icon", href: "/loyalty-app/icons/icon-192.png", type: "image/png" },
  { rel: "apple-touch-icon", href: "/loyalty-app/icons/icon-180.png" },
];

export const meta: Route.MetaFunction = () => [
  { title: "Vivo Loyalty" },
  { name: "description", content: "Earn points, climb tiers, and unlock exclusive rewards." },
  { name: "theme-color", content: "#0a0a0f" },
  { name: "apple-mobile-web-app-capable", content: "yes" },
  { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
  { name: "apple-mobile-web-app-title", content: "Vivo Loyalty" },
  { name: "mobile-web-app-capable", content: "yes" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  // Register the service worker (offline shell + installability). The SW no
  // longer caches assets, so there's no stale-content reload dance needed.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/loyalty-app/sw.js", { scope: "/loyalty-app/" })
      .then((reg) => reg.update())
      .catch(() => {});
  }, []);

  return (
    <ToastProvider>
      <AuthProvider>
        <CartProvider>
          <WishlistProvider>
            <Outlet />
          </WishlistProvider>
        </CartProvider>
      </AuthProvider>
    </ToastProvider>
  );
}

export function HydrateFallback() {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-[var(--bg)] px-8">
      <img
        src="/loyalty-app/icons/vivo-icon.png"
        alt="Vivo Loyalty"
        className="w-40 max-w-[55%] animate-pulse rounded-3xl"
      />
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Something went wrong";
  let details = "An unexpected error occurred.";

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "Page not found" : "Error";
    details = error.status === 404 ? "We couldn't find that page." : error.statusText || details;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center p-6 text-center">
      <div>
        <h1 className="text-2xl font-bold">{message}</h1>
        <p className="mt-2 text-muted">{details}</p>
        <a
          href="/loyalty-app/dashboard"
          className="mt-6 inline-block rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white"
        >
          Back to home
        </a>
      </div>
    </main>
  );
}
