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
 * opaque session token set as an httpOnly `session_token` cookie. The web app
 * relies solely on that cookie — the token is deliberately NOT persisted in
 * localStorage (a stored copy would be readable by any injected script,
 * defeating the httpOnly protection). No Clerk, no Mongo, no third-party
 * identity service.
 */

export const ALLOWED_DOMAINS = ["vivofashiongroup.com", "shopzetu.com"];
export const isAllowedEmail = (email) => {
  if (!email || !email.includes("@")) return false;
  return ALLOWED_DOMAINS.includes(email.split("@").pop().trim().toLowerCase());
};

// Legacy cleanup: earlier builds persisted the session token in localStorage.
// Remove any stale copy so it can't be exfiltrated by injected script.
const LEGACY_TOKEN_KEY = "vivo_token";
const clearLegacyToken = () => {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* storage blocked — nothing to clear */
  }
};

const AuthContext = createContext(null);
// The route guard depends on this request. A busy BI worker must not leave the
// entire application on a blank loading screen for Axios's general 120-second
// API timeout; a short failure safely falls through to the sign-in screen.
const SESSION_CHECK_TIMEOUT_MS = 12_000;

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Resolve the current session to a user via /auth/me. Returns the user (or
  // null). /auth/me is a self-path: a pending/rejected/disabled user still gets
  // a 200 with their record, so the route guard can route them correctly.
  const checkAuth = useCallback(async () => {
    clearLegacyToken();
    try {
      const r = await api.get("/auth/me", { timeout: SESSION_CHECK_TIMEOUT_MS });
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
    // Password verification now ends in a short-lived, httpOnly 2FA challenge.
    // The normal session cookie is only set after completeTwoFactor succeeds.
    const r = await api.post("/auth/login", { email, password });
    clearApiCache();
    const data = r?.data || {};
    if (!data.two_factor_required) {
      setUser(data.user || null);
    }
    setLoading(false);
    return data;
  }, []);

  const completeTwoFactor = useCallback(async (code) => {
    const r = await api.post("/auth/2fa/verify", { code });
    clearApiCache();
    const u = r?.data?.user || null;
    setUser(u);
    setLoading(false);
    return u;
  }, []);

  // Complete the Google OAuth flow: the backend callback already set the
  // httpOnly session cookie on its redirect response, so we only need to
  // resolve the session to a user. The `#token=` fragment (kept for the
  // mobile deep-link flow) is ignored and never persisted.
  const completeGoogleLogin = useCallback(
    async () => {
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
    clearLegacyToken();
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
      completeTwoFactor,
      completeGoogleLogin,
    }),
    [user, loading, logout, checkAuth, loginWithPassword, completeTwoFactor, completeGoogleLogin],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
