import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { canAccessPage, homePageFor } from "@/lib/permissions";
import AccessRestricted from "@/pages/AccessRestricted";
import AwaitingApproval from "@/pages/AwaitingApproval";

/**
 * Gate that wraps every authenticated route:
 *   1. Still loading Clerk — show a lightweight checking state.
 *   2. Signed out — redirect to the branded /sign-in page.
 *   3. Signed in but email is NOT on the company-domain allowlist —
 *      render the AccessRestricted screen (with a sign-out action).
 *   4. `adminOnly` / `pageId` — role-based gates via lib/permissions.js.
 */
export const ProtectedRoute = ({ children, adminOnly = false, pageId }) => {
  const { user, loading, isSignedIn, domainAllowed } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-background">
        <div className="text-muted text-[13px] animate-pulse" data-testid="auth-checking">
          Checking session…
        </div>
      </div>
    );
  }
  if (!isSignedIn) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }
  if (!domainAllowed) {
    return <AccessRestricted />;
  }
  if (!user) {
    return (
      <div className="min-h-screen grid place-items-center bg-background">
        <div className="text-muted text-[13px] animate-pulse" data-testid="auth-checking">
          Checking session…
        </div>
      </div>
    );
  }
  // Signed in + on an allowed domain, but the account isn't approved yet
  // (pending / rejected / disabled). Hold them on the awaiting-approval screen
  // regardless of which route they hit until an admin activates them.
  if (user.status && user.status !== "active") {
    return <AwaitingApproval />;
  }
  if (adminOnly && user.role !== "admin") {
    return <Navigate to={homePageFor(user)} replace />;
  }
  if (pageId && !canAccessPage(user, pageId)) {
    return <Navigate to={homePageFor(user)} replace />;
  }
  return children;
};

export default ProtectedRoute;
