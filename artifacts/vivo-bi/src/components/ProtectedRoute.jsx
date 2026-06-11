import React from "react";

/**
 * Route guard — DISABLED.
 *
 * Login + role/approval gating has been removed for now, so this component is a
 * pass-through: it renders its children regardless of `adminOnly` / `pageId`.
 * The props are still accepted so callers (App.js routes) don't need to change,
 * which keeps the security layer easy to restore later.
 */
export const ProtectedRoute = ({ children }) => <>{children}</>;

export default ProtectedRoute;
