import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { LoadingState } from "./UIBits";

export default function ProtectedRoute({ children, roles }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="min-h-screen grid place-items-center"><LoadingState /></div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  // Self-service "employee" accounts may only use the Salary Advance page —
  // every other route bounces them there (the API also refuses everything
  // else server-side; this just keeps the UX clean).
  if (user.role === "employee" && location.pathname !== "/salary-advance")
    return <Navigate to="/salary-advance" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}
