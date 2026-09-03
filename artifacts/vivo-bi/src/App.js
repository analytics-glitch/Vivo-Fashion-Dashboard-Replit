import React, { Suspense, useEffect, useRef, Component } from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import TopNav from "@/components/Sidebar";
import FilterBar from "@/components/FilterBar";
import { Loading } from "@/components/common";

// Code-split every authed page so the initial JS bundle is lean and
// the first paint after login is fast — critical when the upstream BI
// API is degraded and we're waiting on data anyway.
const Home = React.lazy(() => import("@/pages/Home"));
const Overview = React.lazy(() => import("@/pages/Overview"));
const TrendAnalysis = React.lazy(() => import("@/pages/TrendAnalysis"));
const Retail = React.lazy(() => import("@/pages/Retail"));
const ProductAnalysis = React.lazy(() => import("@/pages/ProductAnalysis"));
const Inventory = React.lazy(() => import("@/pages/Inventory"));
const Exports = React.lazy(() => import("@/pages/Exports"));
const CustomersHub = React.lazy(() => import("@/pages/CustomersHub"));
const Footfall = React.lazy(() => import("@/pages/Footfall"));
const TargetsHub = React.lazy(() => import("@/pages/TargetsHub"));
const DataQuality = React.lazy(() => import("@/pages/DataQuality"));
const Users = React.lazy(() => import("@/pages/Users"));
const PageVisibility = React.lazy(() => import("@/pages/PageVisibility"));
const GroupAccess = React.lazy(() => import("@/pages/GroupAccess"));
const ActivityLogs = React.lazy(() => import("@/pages/ActivityLogs"));
const DataHealth = React.lazy(() => import("@/pages/DataHealth"));
const ValidationAudit = React.lazy(() => import("@/pages/ValidationAudit"));
const ThumbnailManager = React.lazy(() => import("@/pages/ThumbnailManager"));
const Feedback = React.lazy(() => import("@/pages/Feedback"));
const AdminFeedback = React.lazy(() => import("@/pages/AdminFeedback"));
const AdminStoreProfiles = React.lazy(() => import("@/pages/AdminStoreProfiles"));
const StoreClusters = React.lazy(() => import("@/pages/StoreClusters"));
const ExecutiveSummary = React.lazy(() => import("@/pages/ExecutiveSummary"));
const Marketing = React.lazy(() => import("@/pages/Marketing"));
const CustomReport = React.lazy(() => import("@/pages/CustomReport"));
const Production = React.lazy(() => import("@/pages/Production"));
const ProductionWorkspaceHub = React.lazy(() => import("@/pages/ProductionWorkspaceHub"));
// The wallboard now lives as a tab inside the Production Pipeline hub; the old
// standalone URL redirects there, carrying along any extra params (e.g. ?date=).
const WallboardRedirect = () => {
  const search = new URLSearchParams(window.location.search);
  search.set("tab", "wallboard");
  return <Navigate to={`/production?${search.toString()}`} replace />;
};
const PDFlow = React.lazy(() => import("@/pages/PDFlow"));
const Finance = React.lazy(() => import("@/pages/Finance"));
const Margin = React.lazy(() => import("@/pages/Margin"));
const Catalogue = React.lazy(() => import("@/pages/Catalogue"));
const SOPs = React.lazy(() => import("@/pages/SOPs"));
const L10 = React.lazy(() => import("@/pages/L10"));
const Rota = React.lazy(() => import("@/pages/Rota"));
const AskDashboard = React.lazy(() => import("@/pages/AskDashboard"));
const GrowthModel  = React.lazy(() => import("@/pages/GrowthModel"));
const RetailDesk      = React.lazy(() => import("@/pages/RetailDesk"));
const DayInReview     = React.lazy(() => import("@/pages/DayInReview"));
const ProductDesk      = React.lazy(() => import("@/pages/ProductDesk"));
const WorkforceDesk    = React.lazy(() => import("@/pages/WorkforceDesk"));
const CustomerDesk     = React.lazy(() => import("@/pages/CustomerDesk"));
const MarketingDesk    = React.lazy(() => import("@/pages/MarketingDesk"));
const SupplyChainDesk  = React.lazy(() => import("@/pages/SupplyChainDesk"));
const ProductionDesk   = React.lazy(() => import("@/pages/ProductionDesk"));
const TheChair         = React.lazy(() => import("@/pages/TheChair"));
const PartnerBrandsReport = React.lazy(() => import("@/pages/PartnerBrandsReport"));
const OrderExplorer = React.lazy(() => import("@/pages/OrderExplorer"));
const Quality = React.lazy(() => import("@/pages/Quality"));
const StoreFeedback = React.lazy(() => import("@/pages/StoreFeedback"));
const MerchandisingHub = React.lazy(() => import("@/pages/MerchandisingHub"));
const CentralTracker = React.lazy(() => import("@/pages/CentralTracker"));
const CommunityApp = React.lazy(() => import("@/pages/CommunityApp"));
const Atelier = React.lazy(() => import("@/pages/Atelier"));
const Login = React.lazy(() => import("@/pages/Login"));
const AuthCallback = React.lazy(() => import("@/pages/AuthCallback"));

import { FiltersProvider } from "@/lib/filters";
import { AuthProvider } from "@/lib/auth";
import ProtectedRoute from "@/components/ProtectedRoute";
import ChatWidget from "@/components/ChatWidget";
import DevPreviewBanner from "@/components/DevPreviewBanner";
import GlobalSearch from "@/components/GlobalSearch";
import { Toaster } from "@/components/ui/sonner";
import useHeartbeat from "@/lib/useHeartbeat";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { canAccessPage } from "@/lib/permissions";

// ── Error boundary — catches uncaught React render errors and shows a friendly
// recovery card instead of a blank white screen or a Vite crash overlay.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error("App ErrorBoundary caught:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen grid place-items-center bg-background text-foreground">
          <div className="max-w-md w-full mx-4 rounded-xl border border-border bg-card p-8 text-center shadow-md">
            <div className="text-4xl mb-4">⚠️</div>
            <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
            <p className="text-muted-foreground mb-6 text-sm">
              An unexpected error occurred. Refreshing the page usually fixes it.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Refresh page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

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
  const location = useLocation();
  const isFocusedRecord = /^\/atelier\/jobs\/[^/]+\/?$/.test(location.pathname);
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
        <TopNav quietMode={isFocusedRecord} />
        {!isFocusedRecord && <FilterBar />}
      </div>
      <main className="px-3 sm:px-5 lg:px-10 pt-4 pb-6 max-w-[1600px] mx-auto w-full">
        <Suspense fallback={<div className="py-10"><Loading label="Loading…" /></div>}>
          {children}
        </Suspense>
      </main>
      <ChatWidget />
      {!isFocusedRecord && <GlobalSearch />}
    </div>
  );
};

const ProtectedShell = ({ children, adminOnly = false, pageId, anyOfPageIds }) => (
  <ProtectedRoute adminOnly={adminOnly} pageId={pageId} anyOfPageIds={anyOfPageIds}>
    <Shell>{children}</Shell>
  </ProtectedRoute>
);

// Production Workspace is intentionally a dedicated operating environment.
// It keeps the same route-level protection as the BI app, but does not inherit
// the sales-oriented global nav and filters inside its factory shell.
const ProtectedProductionWorkspace = ({ children }) => (
  <ProtectedRoute pageId="production-workspace">
    <Suspense fallback={<div className="min-h-screen grid place-items-center"><Loading label="Loading Production Workspace…" /></div>}>
      {children}
    </Suspense>
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

// Fire-and-forget page-visit ping on every route change while signed in.
// Feeds the admin-only page-usage analytics (page_visits table / assistant
// get_page_usage tool). Best-effort: errors are swallowed, never blocks UI.
const PageVisitTracker = () => {
  const location = useLocation();
  const { user } = useAuth();
  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return;
    const segs = (location.pathname || "/").split("/").filter(Boolean);
    // Canonical page id = path segments joined with "-", matching the backend
    // page-id catalog exactly (e.g. /admin/users -> admin-users). Root renders
    // Overview or Home depending on access (mirror RootLanding's logic).
    let page;
    if (segs.length === 0) {
      page = canAccessPage(user, "overview") ? "overview" : "home";
    } else {
      const first = segs[0].toLowerCase();
      if (["login", "auth", "sign-in", "sign-up"].includes(first)) return;
      page = segs.join("-").toLowerCase();
    }
    api.post("/auth/page-visit", { page }).catch(() => {});
  }, [location.pathname, signedIn, user]);
  return null;
};

function App() {
  return (
    <div className="App">
      <DevPreviewBanner />
      <BrowserRouter>
          <AuthProvider>
            <PageVisitTracker />
            <FiltersProvider>
              <ErrorBoundary>
              <Routes>
                {/* Public auth routes — rendered without the app Shell. */}
                <Route path="/login" element={<Suspense fallback={<div className="min-h-screen grid place-items-center"><Loading label="Loading…" /></div>}><Login /></Suspense>} />
                <Route path="/auth/callback" element={<Suspense fallback={<div className="min-h-screen grid place-items-center"><Loading label="Loading…" /></div>}><AuthCallback /></Suspense>} />
                <Route path="/sign-in/*" element={<Navigate to="/login" replace />} />
                <Route path="/sign-up/*" element={<Navigate to="/login" replace />} />
                <Route path="/" element={<ProtectedShell><RootLanding /></ProtectedShell>} />
                <Route path="/home" element={<ProtectedShell><Home /></ProtectedShell>} />
                <Route path="/catalogue" element={<ProtectedShell pageId="catalogue"><Catalogue /></ProtectedShell>} />
                <Route path="/sops" element={<ProtectedShell pageId="sops"><SOPs /></ProtectedShell>} />
                <Route path="/l10" element={<ProtectedShell pageId="l10"><L10 /></ProtectedShell>} />
                <Route path="/rota" element={<ProtectedShell pageId="rota"><Rota /></ProtectedShell>} />
                <Route path="/store-feedback" element={<ProtectedShell pageId="store-feedback"><StoreFeedback /></ProtectedShell>} />
                <Route path="/ask" element={<ProtectedShell pageId="ask"><AskDashboard /></ProtectedShell>} />
                <Route path="/growth" element={<ProtectedShell pageId="growth"><GrowthModel /></ProtectedShell>} />
                <Route path="/store-profiling" element={<Navigate to="/retail?tab=store-scorecard" replace />} />
                <Route path="/retail-desk" element={<ProtectedShell pageId="retail-desk"><RetailDesk /></ProtectedShell>} />
                <Route path="/day-review" element={<ProtectedShell pageId="day-review"><DayInReview /></ProtectedShell>} />
                <Route path="/product-desk" element={<ProtectedShell pageId="product-desk"><ProductDesk /></ProtectedShell>} />
                <Route path="/workforce-desk" element={<ProtectedShell pageId="workforce-desk"><WorkforceDesk /></ProtectedShell>} />
                <Route path="/customer-desk" element={<ProtectedShell pageId="customer-desk"><CustomerDesk /></ProtectedShell>} />
                <Route path="/marketing-desk" element={<ProtectedShell pageId="marketing-desk"><MarketingDesk /></ProtectedShell>} />
                <Route path="/supply-chain-desk" element={<ProtectedShell pageId="supply-chain-desk"><SupplyChainDesk /></ProtectedShell>} />
                <Route path="/production-desk" element={<ProtectedShell pageId="production-desk"><ProductionDesk /></ProtectedShell>} />
                <Route path="/the-chair" element={<ProtectedShell pageId="the-chair"><TheChair /></ProtectedShell>} />
                <Route path="/partner-brands" element={<ProtectedShell pageId="partner-brands"><PartnerBrandsReport /></ProtectedShell>} />
                {/* "production" grants entry for the embedded Buying Order Status tab
                    (?tab=pd-buying-orders) so everyone who can see that tab can open its
                    deep link — mirrors /product-analysis, whose allowlist also ORs the
                    page id of its embedded Buying Order "Overview" tab. */}
                <Route path="/merchandising" element={<ProtectedShell anyOfPageIds={["merch-overview", "merch-sales", "merch-inventory", "merch-lifecycle", "merch-deepdive", "merch-store", "merch-online", "production"]}><MerchandisingHub /></ProtectedShell>} />
                <Route path="/gallery" element={<Navigate to="/product-analysis?tab=gallery" replace />} />
                <Route path="/exec-summary" element={<ProtectedShell pageId="exec-summary"><ExecutiveSummary /></ProtectedShell>} />
                <Route path="/overview" element={<ProtectedShell pageId="overview"><Overview /></ProtectedShell>} />
                <Route path="/retail" element={<ProtectedShell anyOfPageIds={["locations", "store-profiling", "warehouse-returns", "excess-inventory", "ibt", "rebalancing", "store-flow"]}><Retail /></ProtectedShell>} />
                <Route path="/locations" element={<Navigate to="/retail?tab=locations" replace />} />
                {/* Legacy pages merged into tabs — keep old URLs working */}
                <Route path="/products" element={<Navigate to="/product-analysis" replace />} />
                <Route path="/inventory" element={<ProtectedShell anyOfPageIds={["inventory", "replenishments", "replenish-by-item", "size-health", "store-stock-requests"]}><Inventory /></ProtectedShell>} />
                <Route path="/velocity" element={<Navigate to="/inventory" replace />} />
                <Route path="/size-health" element={<Navigate to="/inventory?tab=size-health" replace />} />
                <Route path="/finance" element={<ProtectedShell pageId="finance"><Finance /></ProtectedShell>} />
                <Route path="/margin" element={<ProtectedShell pageId="margin"><Margin /></ProtectedShell>} />
                <Route path="/crm" element={<ExternalRedirect to="/crm/" />} />
                <Route path="/social" element={<ExternalRedirect to="/crm/inbox" />} />
                <Route path="/atelier/*" element={<ProtectedShell pageId="atelier"><Atelier /></ProtectedShell>} />
                <Route path="/exports" element={<ProtectedShell pageId="exports"><Exports /></ProtectedShell>} />
                <Route path="/order-explorer" element={<ProtectedShell pageId="order-explorer"><OrderExplorer /></ProtectedShell>} />
                <Route path="/customers" element={<ProtectedShell anyOfPageIds={["customers", "customer-details", "crm", "atelier"]}><CustomersHub /></ProtectedShell>} />
                <Route path="/customer-details" element={<Navigate to="/customers?tab=details" replace />} />
                <Route path="/marketing" element={<ProtectedShell pageId="marketing"><Marketing /></ProtectedShell>} />
                {/* Legacy BI route retained as a protected redirect to the live member-facing app. */}
                <Route path="/community-app" element={<ProtectedShell pageId="community-app"><CommunityApp /></ProtectedShell>} />
                <Route path="/custom-report" element={<ProtectedShell pageId="custom-report"><CustomReport /></ProtectedShell>} />
                <Route path="/range-mgmt" element={<Navigate to="/product-analysis?tab=range" replace />} />
                <Route path="/footfall" element={<ProtectedShell pageId="footfall"><Footfall /></ProtectedShell>} />
                <Route path="/trend-analysis" element={<ProtectedShell pageId="trend-analysis"><TrendAnalysis /></ProtectedShell>} />
                <Route path="/product-analysis" element={<ProtectedShell anyOfPageIds={["product-analysis", "production", "range-mgmt", "allocations", "re-order", "style-tracker", "gallery", "style-library", "exports", "pd-flow"]}><ProductAnalysis /></ProtectedShell>} />
                <Route path="/targets" element={<ProtectedShell anyOfPageIds={["targets", "quarter-scorecard"]}><TargetsHub /></ProtectedShell>} />
                <Route path="/quarter-scorecard" element={<Navigate to="/targets?tab=quarter" replace />} />
                <Route path="/re-order" element={<Navigate to="/product-analysis?tab=reorder" replace />} />
                <Route path="/warehouse-returns" element={<Navigate to="/retail?tab=warehouse-returns" replace />} />
                <Route path="/excess-inventory" element={<Navigate to="/retail?tab=excess-inventory" replace />} />
                <Route path="/store-flow" element={<Navigate to="/retail?tab=stock-movement" replace />} />
                <Route path="/ibt" element={<Navigate to="/retail?tab=ibt" replace />} />
                <Route path="/production" element={<ProtectedShell anyOfPageIds={["production", "production-workspace", "production-report", "style-tracker"]}><Production /></ProtectedShell>} />
                <Route path="/production-workspace/*" element={<ProtectedProductionWorkspace><ProductionWorkspaceHub /></ProtectedProductionWorkspace>} />
                <Route path="/production-wallboard" element={<WallboardRedirect />} />
                <Route path="/production-report" element={<Navigate to="/production?tab=report" replace />} />
                <Route path="/quality" element={<ProtectedShell pageId="quality"><Quality /></ProtectedShell>} />
                <Route path="/central-tracker" element={<ProtectedShell pageId="central-tracker"><CentralTracker /></ProtectedShell>} />
                <Route path="/pd-flow" element={<Navigate to="/product-analysis?tab=pd-flow" replace />} />
                <Route path="/style-tracker" element={<Navigate to="/product-analysis?tab=tracker" replace />} />
                <Route path="/data-quality" element={<ProtectedShell pageId="data-quality"><DataQuality /></ProtectedShell>} />
                <Route path="/feedback" element={<ProtectedShell pageId="feedback"><Feedback /></ProtectedShell>} />
                <Route path="/allocations" element={<Navigate to="/product-analysis?tab=allocations" replace />} />
                <Route path="/replenishments" element={<Navigate to="/inventory?tab=replenishments" replace />} />
                <Route path="/replenish-by-item" element={<Navigate to="/inventory?tab=replenish-by-sku" replace />} />
                <Route path="/admin/users" element={<ProtectedShell adminOnly pageId="admin-users"><Users /></ProtectedShell>} />
                <Route path="/admin/activity-logs" element={<ProtectedShell adminOnly pageId="admin-activity-logs"><ActivityLogs /></ProtectedShell>} />
                <Route path="/admin/feedback" element={<ProtectedShell adminOnly pageId="admin-feedback"><AdminFeedback /></ProtectedShell>} />
                <Route path="/admin/store-clusters" element={<ProtectedShell adminOnly pageId="admin-store-clusters"><StoreClusters /></ProtectedShell>} />
                <Route path="/admin/page-visibility" element={<ProtectedShell adminOnly pageId="admin-page-visibility"><PageVisibility /></ProtectedShell>} />
                <Route path="/admin/group-access" element={<ProtectedShell adminOnly pageId="admin-group-access"><GroupAccess /></ProtectedShell>} />
                <Route path="/admin/data-health" element={<ProtectedShell adminOnly pageId="admin-data-health"><DataHealth /></ProtectedShell>} />
                <Route path="/admin/validation-audit" element={<ProtectedShell adminOnly pageId="admin-validation-audit"><ValidationAudit /></ProtectedShell>} />
                <Route path="/admin/thumbnails" element={<ProtectedShell adminOnly pageId="admin-thumbnails"><ThumbnailManager /></ProtectedShell>} />
                <Route path="/admin/store-profiles" element={<ProtectedShell adminOnly pageId="admin-store-profiles"><AdminStoreProfiles /></ProtectedShell>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              </ErrorBoundary>
            </FiltersProvider>
          </AuthProvider>
      </BrowserRouter>
      <Toaster position="top-right" richColors />
    </div>
  );
}

export default App;
