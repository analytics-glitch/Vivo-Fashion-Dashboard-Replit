import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, getToken, setToken, setUnauthorizedHandler } from "@/lib/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [member, setMember] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => setMember(null));
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api.me()
      .then((d) => setMember(d.member))
      .catch(() => setMember(null))
      .finally(() => setLoading(false));
  }, []);

  // Guest browsing — a client-side flag only. Reads on the public API work
  // signed out, member-only actions simply prompt for sign-in. Session-scoped
  // so a fresh visit always lands on the welcome screen.
  const [guest, setGuest] = useState(() => {
    try { return sessionStorage.getItem("vivo_guest") === "1"; } catch { return false; }
  });
  const enterGuest = useCallback(() => {
    try { sessionStorage.setItem("vivo_guest", "1"); } catch { /* private mode */ }
    setGuest(true);
  }, []);
  const exitGuest = useCallback(() => {
    try { sessionStorage.removeItem("vivo_guest"); } catch { /* private mode */ }
    setGuest(false);
  }, []);

  const signIn = useCallback((token, m) => {
    setToken(token);
    setMember(m);
    exitGuest();
  }, [exitGuest]);

  const signOut = useCallback(() => {
    api.logout().catch(() => {});
    setToken("");
    setMember(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const d = await api.me();
      setMember(d.member);
    } catch { /* handled by unauthorized handler */ }
  }, []);

  const updateMember = useCallback((m) => setMember(m), []);

  return (
    <AuthContext.Provider value={{ member, loading, guest, enterGuest, exitGuest, signIn, signOut, refresh, updateMember }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
