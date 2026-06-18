import React, { Suspense, useEffect, useRef } from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import TopNav from "@/components/Sidebar";
import FilterBar from "@/components/FilterBar";
import { Loading } from "@/components/common";

// Code-split every authed page so the initial JS bundle is lean and
// the first paint after login is fast — critical when the upstream BI
// API is degraded and we're waiting on data anyway.
const Home = React.lazy(() => import("@/pages/Home"));
const Overview = React.lazy(() => import("@/pages/Overview"));
const TrendAnalysis = React.lazy(() => import("@/pages/TrendAnalysis"));
const Locations = React.lazy(() => import("@/pages/Locations"));
const Products = React.lazy(() => import("@/pages/Products"));
const ProductAnalysis = React.lazy(() => import("@/pages/ProductAnalysis"));
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
const PageVisibility = React.lazy(() => import("@/pages/PageVisibility"));
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
const MarkdownClearance = React.lazy(() => import("@/pages/MarkdownClearance"));
const Margin = React.lazy(() => import("@/pages/Margin"));
const RFM = React.lazy(() => import("@/pages/RFM"));
const Catalogue = React.lazy(() => import("@/pages/Catalogue"));
const Login = React.lazy(() => import("@/pages/Login"));
const AuthCallback = React.lazy(() => import("@/pages/AuthCallback"));

import { FiltersProvider } from "@/lib/filters";
import { AuthProvider } from "@/lib/auth";
import ProtectedRoute from "@/components/ProtectedRoute";
import ChatWidget from "@/components/ChatWidget";
import GlobalSearch from "@/components/GlobalSearch";
import { Toaster } from "@/components/ui/sonner";
import useHeartbeat from "@/lib/useHeartbeat";
import { useAuth } from "@/lib/auth";
import { canAccessPage } from "@/lib/permissions";

// Landing for "/". Renders the Overview cockpit for users who can access it
// (exec / analyst / viewer), and falls back to the Home tile launcher for
// roles without overview access (store_manager / warehouse) so they never hit
// a redirect dead-end (ProtectedRoute bounces forbidden pages to "/").
const RootLanding = () => {
  const { user } = useAuth();
  return canAccessPage(user, "overview") ? <Overview /> : <Home />;
};

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

// The CRM is a SEPARATE app served by the proxy at /crm/ (not an in-SPA route).
// Clicking the "CRM" nav item routes here, which does a real browser navigation
// into that standalone app rather than rendering the old in-app CRM page.
const ExternalRedirect = ({ to }) => {
  React.useEffect(() => { window.location.replace(to); }, [to]);
  return (
    <div className="min-h-screen grid place-items-center">
      <Loading label="Opening CRM…" />
    </div>
  );
};

function App() {
  return (
    <div className="App">
      <BrowserRouter>
          <AuthProvider>
            <FiltersProvider>
              <Routes>
                {/* Public auth routes — rendered without the app Shell. */}
                <Route path="/login" element={<Suspense fallback={<div className="min-h-screen grid place-items-center"><Loading label="Loading…" /></div>}><Login /></Suspense>} />
                <Route path="/auth/callback" element={<Suspense fallback={<div className="min-h-screen grid place-items-center"><Loading label="Loading…" /></div>}><AuthCallback /></Suspense>} />
                <Route path="/sign-in/*" element={<Navigate to="/login" replace />} />
                <Route path="/sign-up/*" element={<Navigate to="/login" replace />} />
                <Route path="/" element={<ProtectedShell><RootLanding /></ProtectedShell>} />
                <Route path="/home" element={<ProtectedShell><Home /></ProtectedShell>} />
                <Route path="/catalogue" element={<ProtectedShell pageId="catalogue"><Catalogue /></ProtectedShell>} />
                <Route path="/exec-summary" element={<ProtectedShell pageId="exec-summary"><ExecutiveSummary /></ProtectedShell>} />
                <Route path="/overview" element={<ProtectedShell pageId="overview"><Overview /></ProtectedShell>} />
                <Route path="/locations" element={<ProtectedShell pageId="locations"><Locations /></ProtectedShell>} />
                <Route path="/products" element={<ProtectedShell pageId="products"><Products /></ProtectedShell>} />
                <Route path="/inventory" element={<ProtectedShell pageId="inventory"><Inventory /></ProtectedShell>} />
                <Route path="/velocity" element={<ProtectedShell pageId="velocity"><Velocity /></ProtectedShell>} />
                <Route path="/size-health" element={<ProtectedShell pageId="size-health"><SizeHealth /></ProtectedShell>} />
                <Route path="/margin" element={<ProtectedShell pageId="margin"><Margin /></ProtectedShell>} />
                <Route path="/rfm" element={<ProtectedShell pageId="rfm"><RFM /></ProtectedShell>} />
                <Route path="/crm" element={<ExternalRedirect to="/crm/" />} />
                <Route path="/social" element={<ExternalRedirect to="/crm/inbox" />} />
                <Route path="/exports" element={<ProtectedShell pageId="exports"><Exports /></ProtectedShell>} />
                <Route path="/customers" element={<ProtectedShell pageId="customers"><Customers /></ProtectedShell>} />
                <Route path="/customer-details" element={<ProtectedShell pageId="customer-details"><CustomerDetails /></ProtectedShell>} />
                <Route path="/marketing" element={<ProtectedShell pageId="marketing"><Marketing /></ProtectedShell>} />
                <Route path="/custom-report" element={<ProtectedShell pageId="custom-report"><CustomReport /></ProtectedShell>} />
                <Route path="/range-mgmt" element={<ProtectedShell pageId="range-mgmt"><RangeManagement /></ProtectedShell>} />
                <Route path="/markdown-clearance" element={<ProtectedShell pageId="markdown-clearance"><MarkdownClearance /></ProtectedShell>} />
                <Route path="/footfall" element={<ProtectedShell pageId="footfall"><Footfall /></ProtectedShell>} />
                <Route path="/trend-analysis" element={<ProtectedShell pageId="trend-analysis"><TrendAnalysis /></ProtectedShell>} />
                <Route path="/product-analysis" element={<ProtectedShell pageId="product-analysis"><ProductAnalysis /></ProtectedShell>} />
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
                <Route path="/admin/page-visibility" element={<ProtectedShell adminOnly pageId="admin-page-visibility"><PageVisibility /></ProtectedShell>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </FiltersProvider>
          </AuthProvider>
      </BrowserRouter>
      <Toaster position="top-right" richColors />
    </div>
  );
}

export default App;
