import React, { Suspense, useEffect, useRef } from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { ClerkProvider, SignIn, SignUp } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import TopNav from "@/components/Sidebar";
import FilterBar from "@/components/FilterBar";
import { Loading } from "@/components/common";

// Code-split every authed page so the initial JS bundle is lean and
// the first paint after login is fast — critical when the upstream BI
// API is degraded and we're waiting on data anyway.
const Home = React.lazy(() => import("@/pages/Home"));
const Overview = React.lazy(() => import("@/pages/Overview"));
const Locations = React.lazy(() => import("@/pages/Locations"));
const Products = React.lazy(() => import("@/pages/Products"));
const Inventory = React.lazy(() => import("@/pages/Inventory"));
const Exports = React.lazy(() => import("@/pages/Exports"));
const Customers = React.lazy(() => import("@/pages/Customers"));
const CustomerDetails = React.lazy(() => import("@/pages/CustomerDetails"));
const Footfall = React.lazy(() => import("@/pages/Footfall"));
const TargetsTracker = React.lazy(() => import("@/pages/TargetsTracker"));
const ReOrder = React.lazy(() => import("@/pages/ReOrder"));
const IBT = React.lazy(() => import("@/pages/IBT"));
const DataQuality = React.lazy(() => import("@/pages/DataQuality"));
const Users = React.lazy(() => import("@/pages/Users"));
const ActivityLogs = React.lazy(() => import("@/pages/ActivityLogs"));
const Feedback = React.lazy(() => import("@/pages/Feedback"));
const AdminFeedback = React.lazy(() => import("@/pages/AdminFeedback"));
const Allocations = React.lazy(() => import("@/pages/Allocations"));
const Replenishments = React.lazy(() => import("@/pages/Replenishments"));
const StoreClusters = React.lazy(() => import("@/pages/StoreClusters"));
const ExecutiveSummary = React.lazy(() => import("@/pages/ExecutiveSummary"));
const Marketing = React.lazy(() => import("@/pages/Marketing"));
const CustomReport = React.lazy(() => import("@/pages/CustomReport"));
const RangeManagement = React.lazy(() => import("@/pages/RangeManagement"));
const Velocity = React.lazy(() => import("@/pages/Velocity"));
const SizeHealth = React.lazy(() => import("@/pages/SizeHealth"));
const Margin = React.lazy(() => import("@/pages/Margin"));
const RFM = React.lazy(() => import("@/pages/RFM"));

import { FiltersProvider } from "@/lib/filters";
import { AuthProvider } from "@/lib/auth";
import ProtectedRoute from "@/components/ProtectedRoute";
import ChatWidget from "@/components/ChatWidget";
import GlobalSearch from "@/components/GlobalSearch";
import { Toaster } from "@/components/ui/sonner";
import useHeartbeat from "@/lib/useHeartbeat";
import { useAuth } from "@/lib/auth";

// Resolve the publishable key from the current host so the SAME build works
// across the dev preview and any production / custom domain (falls back to the
// VITE_CLERK_PUBLISHABLE_KEY env var). The proxy URL is wired unconditionally:
// it is undefined in development (no proxy) and auto-set in production.
const PUBLISHABLE_KEY = publishableKeyFromHost(
  typeof window !== "undefined" ? window.location.hostname : "",
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const CLERK_PROXY_URL = import.meta.env.VITE_CLERK_PROXY_URL;

// The app is mounted at Vite's base path. Clerk's router callbacks hand us
// full (base-prefixed) paths; strip the base so react-router navigates
// correctly. `path`/url props passed to <SignIn>/<SignUp> keep the base.
const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const withBase = (p) => `${BASE}${p}`;
const stripBase = (to) => {
  if (typeof to !== "string") return to;
  if (BASE && to.startsWith(BASE)) return to.slice(BASE.length) || "/";
  return to;
};

const clerkAppearance = {
  theme: shadcn,
  variables: {
    colorPrimary: "#1a5c38",
    colorBackground: "#ffffff",
    colorForeground: "#1a1a1a",
    colorMutedForeground: "#6b7280",
    colorInput: "#ffffff",
    colorInputForeground: "#1a1a1a",
    colorDanger: "#dc2626",
    fontFamily:
      "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-white border border-[#fdba74] rounded-2xl shadow-xl w-[400px] max-w-full overflow-hidden",
    card: "!bg-transparent !shadow-none !border-0",
    headerTitle: "text-[#1a1a1a]",
    headerSubtitle: "text-[#6b7280]",
    socialButtonsBlockButton: "border-[#e5e7eb] hover:bg-[#f9fafb]",
    socialButtonsBlockButtonText: "text-[#1a1a1a] font-medium",
    dividerLine: "bg-[#e5e7eb]",
    dividerText: "text-[#6b7280]",
    formFieldLabel: "text-[#1a1a1a]",
    formFieldInput: "bg-white border-[#e5e7eb] text-[#1a1a1a]",
    formButtonPrimary: "bg-[#1a5c38] hover:bg-[#14492c] text-white",
    identityPreviewText: "text-[#1a1a1a]",
    formResendCodeLink: "text-[#1a5c38]",
    footer: "!bg-transparent",
    footerActionText: "text-[#6b7280]",
    footerActionLink: "text-[#1a5c38] hover:text-[#14492c] font-semibold",
    logoImage: "h-10 w-auto",
  },
  options: {
    logoPlacement: "inside",
    logoLinkUrl: BASE || "/",
    logoImageUrl: `${typeof window !== "undefined" ? window.location.origin : ""}${withBase("/logo.svg")}`,
    socialButtonsVariant: "blockButton",
  },
};

const clerkLocalization = {
  signIn: {
    start: {
      title: "Sign in to Vivo BI",
      subtitle: "Use your Vivo Fashion Group or Shop Zetu account",
    },
  },
  signUp: {
    start: {
      title: "Request access",
      subtitle: "Only @vivofashiongroup.com and @shopzetu.com accounts are permitted",
    },
  },
};

const AuthScreen = ({ children }) => (
  <div
    className="min-h-screen w-full grid place-items-center bg-[#fed7aa] px-4 py-10"
    data-testid="auth-screen"
  >
    {children}
  </div>
);

const Shell = ({ children }) => {
  const navRef = useRef(null);
  const { user } = useAuth();
  // Iter 89w-g — fire presence heartbeats while a tab is open so
  // admins can see live "who's using the system" on Activity Logs.
  useHeartbeat(Boolean(user));
  // Expose the actual rendered navbar+filter-bar height as a CSS variable so
  // sticky table headers across the app can `top: var(--app-navbar-h)`
  // and never slide under the navbar. Recalculates on resize and on
  // route-change-induced reflows.
  useEffect(() => {
    const el = navRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const h = el.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--app-navbar-h", `${Math.round(h)}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener("resize", apply);
    return () => { ro.disconnect(); window.removeEventListener("resize", apply); };
  }, []);
  return (
    <div className="min-h-screen bg-background text-foreground" data-testid="app-shell">
      <div ref={navRef} className="sticky top-0 z-40">
        <TopNav />
        <FilterBar />
      </div>
      <main className="px-3 sm:px-5 lg:px-10 pt-4 pb-6 max-w-[1600px] mx-auto w-full">
        <Suspense fallback={<div className="py-10"><Loading label="Loading…" /></div>}>
          {children}
        </Suspense>
      </main>
      <ChatWidget />
      <GlobalSearch />
    </div>
  );
};

const ProtectedShell = ({ children, adminOnly = false, pageId }) => (
  <ProtectedRoute adminOnly={adminOnly} pageId={pageId}>
    <Shell>{children}</Shell>
  </ProtectedRoute>
);

// ClerkProvider must live inside the Router so its routerPush/Replace can use
// react-router's navigate (keeps Clerk's hosted flows as SPA navigations).
const ClerkProviderWithRoutes = ({ children }) => {
  const navigate = useNavigate();
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      proxyUrl={CLERK_PROXY_URL}
      appearance={clerkAppearance}
      localization={clerkLocalization}
      signInUrl={withBase("/sign-in")}
      signUpUrl={withBase("/sign-up")}
      afterSignOutUrl={withBase("/sign-in")}
      routerPush={(to) => navigate(stripBase(to))}
      routerReplace={(to) => navigate(stripBase(to), { replace: true })}
    >
      {children}
    </ClerkProvider>
  );
};

function App() {
  return (
    <div className="App">
      <BrowserRouter>
        <ClerkProviderWithRoutes>
          <AuthProvider>
            <FiltersProvider>
              <Routes>
                <Route
                  path="/sign-in/*"
                  element={
                    <AuthScreen>
                      <SignIn
                        routing="path"
                        path={withBase("/sign-in")}
                        signUpUrl={withBase("/sign-up")}
                        forceRedirectUrl={withBase("/")}
                        appearance={clerkAppearance}
                      />
                    </AuthScreen>
                  }
                />
                <Route
                  path="/sign-up/*"
                  element={
                    <AuthScreen>
                      <SignUp
                        routing="path"
                        path={withBase("/sign-up")}
                        signInUrl={withBase("/sign-in")}
                        forceRedirectUrl={withBase("/")}
                        appearance={clerkAppearance}
                      />
                    </AuthScreen>
                  }
                />
                {/* Legacy auth routes now defer to the Clerk sign-in page. */}
                <Route path="/login" element={<Navigate to="/sign-in" replace />} />
                <Route path="/auth/callback" element={<Navigate to="/sign-in" replace />} />
                <Route path="/" element={<ProtectedShell><Home /></ProtectedShell>} />
                <Route path="/exec-summary" element={<ProtectedShell pageId="exec-summary"><ExecutiveSummary /></ProtectedShell>} />
                <Route path="/overview" element={<ProtectedShell pageId="overview"><Overview /></ProtectedShell>} />
                <Route path="/locations" element={<ProtectedShell pageId="locations"><Locations /></ProtectedShell>} />
                <Route path="/products" element={<ProtectedShell pageId="products"><Products /></ProtectedShell>} />
                <Route path="/inventory" element={<ProtectedShell pageId="inventory"><Inventory /></ProtectedShell>} />
                <Route path="/velocity" element={<ProtectedShell pageId="velocity"><Velocity /></ProtectedShell>} />
                <Route path="/size-health" element={<ProtectedShell pageId="size-health"><SizeHealth /></ProtectedShell>} />
                <Route path="/margin" element={<ProtectedShell pageId="margin"><Margin /></ProtectedShell>} />
                <Route path="/rfm" element={<ProtectedShell pageId="rfm"><RFM /></ProtectedShell>} />
                <Route path="/exports" element={<ProtectedShell pageId="exports"><Exports /></ProtectedShell>} />
                <Route path="/customers" element={<ProtectedShell pageId="customers"><Customers /></ProtectedShell>} />
                <Route path="/customer-details" element={<ProtectedShell pageId="customer-details"><CustomerDetails /></ProtectedShell>} />
                <Route path="/marketing" element={<ProtectedShell pageId="marketing"><Marketing /></ProtectedShell>} />
                <Route path="/custom-report" element={<ProtectedShell pageId="custom-report"><CustomReport /></ProtectedShell>} />
                <Route path="/range-mgmt" element={<ProtectedShell pageId="range-mgmt"><RangeManagement /></ProtectedShell>} />
                <Route path="/footfall" element={<ProtectedShell pageId="footfall"><Footfall /></ProtectedShell>} />
                <Route path="/targets" element={<ProtectedShell pageId="targets"><TargetsTracker /></ProtectedShell>} />
                <Route path="/re-order" element={<ProtectedShell pageId="re-order"><ReOrder /></ProtectedShell>} />
                <Route path="/ibt" element={<ProtectedShell pageId="ibt"><IBT /></ProtectedShell>} />
                <Route path="/data-quality" element={<ProtectedShell pageId="data-quality"><DataQuality /></ProtectedShell>} />
                <Route path="/feedback" element={<ProtectedShell pageId="feedback"><Feedback /></ProtectedShell>} />
                <Route path="/allocations" element={<ProtectedShell pageId="allocations"><Allocations /></ProtectedShell>} />
                <Route path="/replenishments" element={<ProtectedShell pageId="replenishments"><Replenishments /></ProtectedShell>} />
                <Route path="/admin/users" element={<ProtectedShell adminOnly pageId="admin-users"><Users /></ProtectedShell>} />
                <Route path="/admin/activity-logs" element={<ProtectedShell adminOnly pageId="admin-activity-logs"><ActivityLogs /></ProtectedShell>} />
                <Route path="/admin/feedback" element={<ProtectedShell adminOnly pageId="admin-feedback"><AdminFeedback /></ProtectedShell>} />
                <Route path="/admin/store-clusters" element={<ProtectedShell adminOnly pageId="admin-store-clusters"><StoreClusters /></ProtectedShell>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </FiltersProvider>
          </AuthProvider>
        </ClerkProviderWithRoutes>
      </BrowserRouter>
      <Toaster position="top-right" richColors />
    </div>
  );
}

export default App;
