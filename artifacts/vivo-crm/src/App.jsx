import React from "react";
import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { DateRangeProvider } from "@/contexts/DateRangeContext";
import AuthCallback from "@/pages/AuthCallback";
import Login from "@/pages/Login";
import AppShell from "@/components/AppShell";
import DevPreviewBanner from "@/components/DevPreviewBanner";
import Dashboard from "@/pages/Dashboard";
import CustomerSearch from "@/pages/CustomerSearch";
import CustomerDatabase from "@/pages/CustomerDatabase";
import CustomerProfile from "@/pages/CustomerProfile";
import LookbookBuilder from "@/pages/LookbookBuilder";
import PublicLookbook from "@/pages/PublicLookbook";
import ManagerDashboard from "@/pages/ManagerDashboard";
import Templates from "@/pages/Templates";
import AuditLog from "@/pages/AuditLog";
import Lookbooks from "@/pages/Lookbooks";
import Inbox from "@/pages/Inbox";
import CommunityInbox from "@/pages/CommunityInbox";
import VivoEdits from "@/pages/VivoEdits";
import ShopCards from "@/pages/ShopCards";
import Service from "@/pages/Service";
import TeamQueue from "@/pages/TeamQueue";
import Reports from "@/pages/Reports";
import CSAT from "@/pages/CSAT";
import SurveyResults from "@/pages/SurveyResults";
import Overview from "@/pages/Overview";
import FollowUps from "@/pages/FollowUps";
import DataQuality from "@/pages/DataQuality";
import Training from "@/pages/Training";
import Loyalty from "@/pages/Loyalty";
import LoyaltyAppPreview from "@/pages/LoyaltyAppPreview";
import DataRequests from "@/pages/DataRequests";
import Settings from "@/pages/Settings";
import { CohortsPage, OperationsPage } from "@/pages/InsightsPages";
import AtelierDashboard from "@/pages/AtelierDashboard";
import AtelierJobDetail from "@/pages/AtelierJobDetail";
import AtelierReports from "@/pages/AtelierReports";
import AtelierSettings from "@/pages/AtelierSettings";

function ProtectedRoutes() {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center text-[var(--vivo-muted)]">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/customers" element={<CustomerSearch />} />
        <Route path="/customers/database" element={<CustomerDatabase />} />
        <Route path="/customers/:id" element={<CustomerProfile />} />
        <Route path="/lookbooks" element={<Lookbooks />} />
        <Route path="/lookbooks/new" element={<LookbookBuilder />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/community-inbox" element={<CommunityInbox />} />
        <Route path="/vivo-edits" element={<VivoEdits />} />
        <Route path="/shop-cards" element={<ShopCards />} />
        <Route path="/service" element={<Service />} />
        <Route path="/team-queue" element={user.role === "manager" ? <TeamQueue /> : <Navigate to="/dashboard" replace />} />
        <Route path="/reports" element={user.role === "manager" ? <Reports /> : <Navigate to="/dashboard" replace />} />
        <Route path="/follow-ups" element={<FollowUps />} />
        <Route path="/overview" element={user.role === "manager" ? <Overview /> : <Navigate to="/dashboard" replace />} />
        <Route path="/cohorts" element={user.role === "manager" ? <CohortsPage /> : <Navigate to="/dashboard" replace />} />
        <Route path="/operations" element={user.role === "manager" ? <OperationsPage /> : <Navigate to="/dashboard" replace />} />
        <Route path="/data-quality" element={user.role === "manager" ? <DataQuality /> : <Navigate to="/dashboard" replace />} />
        <Route path="/training" element={user.role === "manager" ? <Training /> : <Navigate to="/dashboard" replace />} />
        <Route path="/csat" element={user.role === "manager" ? <CSAT /> : <Navigate to="/dashboard" replace />} />
        <Route path="/survey-results" element={user.role === "manager" ? <SurveyResults /> : <Navigate to="/dashboard" replace />} />
        <Route path="/loyalty" element={user.role === "manager" ? <Loyalty /> : <Navigate to="/dashboard" replace />} />
        <Route path="/loyalty/app-preview" element={user.role === "manager" ? <LoyaltyAppPreview /> : <Navigate to="/dashboard" replace />} />
        <Route path="/data-requests" element={user.role === "manager" ? <DataRequests /> : <Navigate to="/dashboard" replace />} />
        <Route path="/settings" element={user.role === "manager" ? <Settings /> : <Navigate to="/dashboard" replace />} />
        <Route path="/manager" element={user.role === "manager" ? <ManagerDashboard /> : <Navigate to="/dashboard" replace />} />
        <Route path="/templates" element={user.role === "manager" ? <Templates /> : <Navigate to="/dashboard" replace />} />
        <Route path="/audit" element={user.role === "manager" ? <AuditLog /> : <Navigate to="/dashboard" replace />} />
        <Route path="/atelier" element={user.atelier_enabled || user.atelier_admin ? <AtelierDashboard /> : <Navigate to="/dashboard" replace />} />
        <Route path="/atelier/jobs/:id" element={user.atelier_enabled || user.atelier_admin ? <AtelierJobDetail /> : <Navigate to="/dashboard" replace />} />
        <Route path="/atelier/reports" element={user.atelier_enabled || user.atelier_admin ? <AtelierReports /> : <Navigate to="/dashboard" replace />} />
        <Route path="/atelier/settings" element={user.atelier_admin ? <AtelierSettings /> : <Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}

function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/share/:token" element={<PublicLookbook />} />
      <Route path="/*" element={<ProtectedRoutes />} />
    </Routes>
  );
}

const basename = import.meta.env.BASE_URL.replace(/\/$/, "");

function App() {
  return (
    <div className="App">
      <DevPreviewBanner />
      <BrowserRouter basename={basename}>
        <AuthProvider>
          <DateRangeProvider>
            <Toaster position="top-right" richColors />
            <AppRouter />
          </DateRangeProvider>
        </AuthProvider>
      </BrowserRouter>
    </div>
  );
}

export default App;
