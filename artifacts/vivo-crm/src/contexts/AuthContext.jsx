import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, clearLegacyToken } from "@/lib/api";

const AuthContext = createContext({
  user: null,
  loading: true,
  logout: () => {},
  refresh: () => {},
});

// The reference app gates manager-only pages on `user.role === "manager"`.
// This project's backend uses richer roles (admin/exec/analyst/store_manager…).
// Map the elevated backend roles onto the reference's "manager" role and the
// rest onto "associate" so the ported pages keep working unchanged. The
// original backend role is preserved as `backend_role`.
const MANAGER_ROLES = new Set(["admin", "exec", "manager", "customer_service"]);
function normalizeUser(u) {
  if (!u || !u.user_id) return null;
  // Only fully-active accounts are treated as signed in.
  if (u.status && u.status !== "active") return null;
  const raw = String(u.role || "").toLowerCase();
  return {
    ...u,
    backend_role: u.role,
    role: MANAGER_ROLES.has(raw) || u.crm_admin ? "manager" : "associate",
    name: u.name || u.email,
  };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    // Cookie-only session: /auth/me resolves the httpOnly cookie (401 = signed out).
    clearLegacyToken();
    try {
      const r = await api.get("/auth/me");
      const u = normalizeUser(r.data);
      setUser(u);
      return u;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The OAuth callback route handles the token exchange itself; skip /me there.
    if (window.location.pathname.endsWith("/auth/callback")) {
      setLoading(false);
      return;
    }
    refresh();
  }, [refresh]);

  const loginWithPassword = useCallback(async (email, password) => {
    // The backend sets the httpOnly session cookie on this response; the token
    // in the JSON body is intentionally ignored (mobile-only path).
    const r = await api.post("/auth/login", { email, password });
    const u = normalizeUser(r?.data?.user);
    setUser(u);
    setLoading(false);
    return u;
  }, []);

  // Complete Google OAuth: the backend callback already set the httpOnly
  // session cookie on its redirect (no token in the URL); just resolve it.
  const completeGoogleLogin = useCallback(
    async () => refresh(),
    [refresh],
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* best-effort server-side destroy */
    }
    clearLegacyToken();
    setUser(null);
    window.location.href = import.meta.env.BASE_URL + "login";
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, loading, logout, refresh, setUser, loginWithPassword, completeGoogleLogin }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
