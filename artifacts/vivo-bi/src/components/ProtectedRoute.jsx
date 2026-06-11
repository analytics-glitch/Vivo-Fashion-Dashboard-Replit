import React from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { canAccessPage } from "@/lib/permissions";
import { Loading } from "@/components/common";
import AwaitingApproval from "@/pages/AwaitingApproval";

/**
 * Route guard.
 *
 * - While the session is resolving -> full-screen spinner.
 * - No session -> redirect to /login.
 * - status !== "active" (pending / rejected / disabled) -> AwaitingApproval
 *   (which renders the rejected variant when appropriate).
 * - `adminOnly` route but non-admin -> bounce home.
 * - `pageId` not in the user's allowed pages -> bounce home.
 */
export const ProtectedRoute = ({ children, adminOnly = false, pageId }) => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-background">
        <Loading label="Loading…" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  if (user.status && user.status !== "active") {
    return <AwaitingApproval />;
  }

  const role = (user.role || "").toLowerCase();
  if (adminOnly && role !== "admin") {
    return <Navigate to="/" replace />;
  }

  if (pageId && !canAccessPage(user, pageId)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
