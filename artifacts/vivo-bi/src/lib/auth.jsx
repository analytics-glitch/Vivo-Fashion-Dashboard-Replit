import React, { createContext, useContext, useMemo } from "react";

/**
 * Auth bridge — LOGIN DISABLED
 * ----------------------------
 * The login + access-control layer has been removed for now. This provider no
 * longer talks to Clerk or the backend `/auth/me` endpoint; it simply hands the
 * whole app a built-in admin user so every page and action is available without
 * signing in. The exported shape (`{ user, loading, logout, ... }`) is kept
 * identical to before so existing `useAuth()` consumers keep working, and so the
 * login/security layer can be restored later by reverting this file.
 */

export const ALLOWED_DOMAINS = ["vivofashiongroup.com", "shopzetu.com"];
export const isAllowedEmail = () => true;

// Legacy token helpers — kept as no-ops so any stray imports don't break.
export const getStoredToken = () => null;
export const setStoredToken = () => {};

const STATIC_USER = {
  id: "local",
  user_id: "local",
  name: "User",
  email: "user@local",
  role: "admin",
  status: "active",
  active: true,
  picture: null,
};

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const value = useMemo(
    () => ({
      user: STATIC_USER,
      loading: false,
      isSignedIn: true,
      domainAllowed: true,
      email: STATIC_USER.email,
      logout: async () => {},
      checkAuth: async () => {},
      loginWithPassword: async () => {},
      completeGoogleLogin: async () => {},
    }),
    [],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
