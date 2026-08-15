import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  AuthUser,
  fetchMe,
  verifyTwoFactorRequest,
  loginRequest,
  logoutRequest,
  setAuthToken,
  setUnauthorizedHandler,
} from "@/lib/api";

const TOKEN_KEY = "vivo_token";

type Status = "loading" | "authenticated" | "unauthenticated";

interface AuthValue {
  status: Status;
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<{ twoFactorRequired?: boolean; mode?: string; challengeToken?: string }>;
  completeTwoFactor: (code: string, challengeToken: string) => Promise<void>;
  completeGoogleLogin: (token: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Friendly messages for non-active accounts that still authenticate. */
function statusMessage(status?: string | null): string {
  switch (status) {
    case "pending":
      return "Your account is awaiting approval from an administrator.";
    case "rejected":
      return "Your access request was rejected.";
    case "disabled":
      return "Your account has been disabled.";
    default:
      return "Your account is not active.";
  }
}

/** Translate backend login error details into user-facing messages. */
function loginErrorMessage(detail: string): string {
  switch (detail) {
    case "account_rejected":
      return statusMessage("rejected");
    case "account_disabled":
      return statusMessage("disabled");
    case "account_pending_approval":
      return statusMessage("pending");
    case "Invalid email or password":
      return "Invalid email or password.";
    default:
      return detail || "Sign in failed. Please try again.";
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);

  const clear = useCallback(async () => {
    setAuthToken(null);
    setUser(null);
    setStatus("unauthenticated");
    // Drop any cached BI data so a different user on this device never sees the
    // previous session's figures.
    queryClient.clear();
    try {
      await AsyncStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore storage errors; in-memory state is already cleared
    }
  }, [queryClient]);

  // A 401 from any request (e.g. expired session) bounces back to login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      void clear();
    });
    return () => setUnauthorizedHandler(null);
  }, [clear]);

  // Restore a persisted session on launch.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const token = await AsyncStorage.getItem(TOKEN_KEY);
        if (!token) {
          if (active) setStatus("unauthenticated");
          return;
        }
        setAuthToken(token);
        const me = await fetchMe();
        if (!active) return;
        if (me && me.user_id && me.status === "active") {
          setUser(me);
          setStatus("authenticated");
        } else {
          await clear();
        }
      } catch {
        if (active) await clear();
      }
    })();
    return () => {
      active = false;
    };
  }, [clear]);

  const login = useCallback(
    async (email: string, password: string) => {
      let token: string;
      let u: AuthUser;
      try {
        const res = await loginRequest(email, password);
        if (res.two_factor_required) {
          return {
            twoFactorRequired: true,
            mode: res.two_factor?.mode,
            challengeToken: res.challenge_token,
          };
        }
        if (!res.token) throw new Error("Sign in requires two-step verification.");
        token = res.token;
        u = res.user;
      } catch (e) {
        const detail = e instanceof Error ? e.message : "";
        throw new Error(loginErrorMessage(detail));
      }
      if (u.status && u.status !== "active") {
        // Login succeeds for pending accounts but the API gates their data.
        await clear();
        throw new Error(statusMessage(u.status));
      }
      // Start this session with a clean cache (no prior user's figures).
      queryClient.clear();
      setAuthToken(token);
      try {
        await AsyncStorage.setItem(TOKEN_KEY, token);
      } catch {
        // ignore storage errors; session still works for this launch
      }
      setUser(u);
      setStatus("authenticated");
      return {};
    },
    [clear, queryClient],
  );

  const completeTwoFactor = useCallback(
    async (code: string, challengeToken: string) => {
      const res = await verifyTwoFactorRequest(code, challengeToken);
      if (!res.token || !res.user) throw new Error("Two-step verification failed.");
      queryClient.clear();
      setAuthToken(res.token);
      try {
        await AsyncStorage.setItem(TOKEN_KEY, res.token);
      } catch {
        // ignore storage errors; session still works for this launch
      }
      setUser(res.user);
      setStatus("authenticated");
    },
    [queryClient],
  );

  const completeGoogleLogin = useCallback(
    async (token: string) => {
      if (!token) throw new Error("Sign in failed. Please try again.");
      setAuthToken(token);
      let me: AuthUser;
      try {
        me = await fetchMe();
      } catch {
        await clear();
        throw new Error("Sign in failed. Please try again.");
      }
      if (!me || !me.user_id) {
        await clear();
        throw new Error("Sign in failed. Please try again.");
      }
      if (me.status && me.status !== "active") {
        await clear();
        throw new Error(statusMessage(me.status));
      }
      queryClient.clear();
      setAuthToken(token);
      try {
        await AsyncStorage.setItem(TOKEN_KEY, token);
      } catch {
        // ignore storage errors; session still works for this launch
      }
      setUser(me);
      setStatus("authenticated");
    },
    [clear, queryClient],
  );

  const logout = useCallback(async () => {
    await logoutRequest();
    await clear();
  }, [clear]);

  const value = useMemo<AuthValue>(
    () => ({ status, user, login, completeTwoFactor, completeGoogleLogin, logout }),
    [status, user, login, completeTwoFactor, completeGoogleLogin, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
