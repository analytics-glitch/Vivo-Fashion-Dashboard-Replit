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

  const signIn = useCallback((token, m) => {
    setToken(token);
    setMember(m);
  }, []);

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
    <AuthContext.Provider value={{ member, loading, signIn, signOut, refresh, updateMember }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
