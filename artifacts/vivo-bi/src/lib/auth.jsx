import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { api, clearApiCache } from "@/lib/api";

/**
 * Auth bridge — self-hosted Postgres sessions.
 * ----------------------------------------------
 * Authentication is handled entirely by our own FastAPI backend (`api_pg.py`):
 * email/password accounts (PBKDF2) and real Google OAuth. The backend issues an
 * opaque session token, returned on login and set as an httpOnly cookie. We also
 * keep the token in localStorage so it can be sent as a `Bearer` header (the
 * api.js request interceptor attaches it). No Clerk, no Mongo, no third-party
 * identity service.
 */

export const ALLOWED_DOMAINS = ["vivofashiongroup.com", "shopzetu.com"];
export const isAllowedEmail = (email) => {
  if (!email || !email.includes("@")) return false;
  return ALLOWED_DOMAINS.includes(email.split("@").pop().trim().toLowerCase());
};

const TOKEN_KEY = "vivo_token";
export const getStoredToken = () => {
  try {
    return typeof window !== "undefined"
      ? window.localStorage.getItem(TOKEN_KEY)
      : null;
  } catch {
    return null;
  }
};
export const setStoredToken = (t) => {
  try {
    if (typeof window === "undefined") return;
    if (t) window.localStorage.setItem(TOKEN_KEY, t);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked (iOS private mode) — Bearer falls back to the cookie */
  }
};

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Resolve the current session to a user via /auth/me. Returns the user (or
  // null). /auth/me is a self-path: a pending/rejected/disabled user still gets
  // a 200 with their record, so the route guard can route them correctly.
  const checkAuth = useCallback(async () => {
    const token = getStoredToken();
    if (!token) {
      setUser(null);
      setLoading(false);
      return null;
    }
    try {
      const r = await api.get("/auth/me");
      const u = r?.data && r.data.user_id ? r.data : null;
      setUser(u);
      return u;
    } catch {
      // 401 / network — treat as signed out.
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const loginWithPassword = useCallback(async (email, password) => {
    const r = await api.post("/auth/login", { email, password });
    const token = r?.data?.token;
    if (token) setStoredToken(token);
    clearApiCache();
    const u = r?.data?.user || null;
    setUser(u);
    setLoading(false);
    return u;
  }, []);

  // Complete the Google OAuth flow: the backend callback redirects to
  // /auth/callback#token=<session>, the callback page hands us that token.
  const completeGoogleLogin = useCallback(
    async (token) => {
      if (token) setStoredToken(token);
      clearApiCache();
      return checkAuth();
    },
    [checkAuth],
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* best-effort server-side destroy */
    }
    setStoredToken(null);
    clearApiCache();
    setUser(null);
    if (typeof window !== "undefined") window.location.assign("/login");
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const value = useMemo(
    () => ({
      user,
      loading,
      isSignedIn: !!user,
      domainAllowed: user ? isAllowedEmail(user.email) : true,
      email: user?.email || null,
      logout,
      checkAuth,
      loginWithPassword,
      completeGoogleLogin,
    }),
    [user, loading, logout, checkAuth, loginWithPassword, completeGoogleLogin],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
