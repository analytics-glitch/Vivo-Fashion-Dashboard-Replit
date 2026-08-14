import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { apiClient, clearLegacyToken } from "./api";

const AuthCtx = createContext(null);

// This project's backend uses richer roles (admin / exec / analyst /
// store_manager / manager …). The reference HR app only knows three roles:
// executive, hr_manager, branch_manager. Map the backend role onto the
// reference role so ProtectedRoute and the role-gated nav keep working. The
// original backend role is preserved as `backend_role`.
const EXEC_ROLES = new Set(["admin", "exec", "executive"]);
const HR_ROLES = new Set(["analyst", "hr_manager", "manager", "hr"]);

export const mapRole = (raw) => {
  const r = String(raw || "").toLowerCase();
  if (EXEC_ROLES.has(r)) return "executive";
  if (HR_ROLES.has(r)) return "hr_manager";
  // Auto-approved self-service accounts: Salary Advance only (server-enforced
  // by the employee API fence — this mapping just drives nav/route gating).
  if (r === "employee") return "employee";
  return "branch_manager";
};

const normalizeUser = (u) => {
  if (!u || !(u.user_id || u.id)) return null;
  // Only fully-active accounts are treated as signed in.
  if (u.status && u.status !== "active") return null;
  return {
    ...u,
    backend_role: u.role,
    role: mapRole(u.role),
    name: u.name || u.email,
  };
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchMe = useCallback(async () => {
    // Cookie-only session: /auth/me resolves the httpOnly cookie (401 = signed out).
    clearLegacyToken();
    try {
      const { data } = await apiClient.get("/auth/me");
      const u = normalizeUser(data);
      setUser(u);
      return u;
    } catch (e) {
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
    fetchMe();
  }, [fetchMe]);

  const login = async (email, password) => {
    // The backend sets the httpOnly session cookie on this response; the token
    // in the JSON body is intentionally ignored (mobile-only path).
    const { data } = await apiClient.post("/auth/login", { email, password });
    const u = normalizeUser(data.user);
    setUser(u);
    setLoading(false);
    return u;
  };

  // Complete Google OAuth: the backend callback already set the httpOnly
  // session cookie on its redirect (no token in the URL); just resolve it.
  const completeGoogleLogin = async () => fetchMe();

  const logout = async () => {
    try { await apiClient.post("/auth/logout"); } catch {}
    clearLegacyToken();
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ user, loading, login, logout, completeGoogleLogin, refresh: fetchMe }}>
      {children}
    </AuthCtx.Provider>
  );
};

export const useAuth = () => useContext(AuthCtx);

export const ROLES = {
  EXEC: "executive",
  HR: "hr_manager",
  BRANCH: "branch_manager",
};

export const roleLabel = (r) =>
  ({ executive: "Executive", hr_manager: "HR Manager", branch_manager: "Branch Manager", employee: "Employee" }[r] || r);

export const canWrite = (user) => user && (user.role === "executive" || user.role === "hr_manager");
