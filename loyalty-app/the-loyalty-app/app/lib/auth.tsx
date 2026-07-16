import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { auth, type User } from "./api";

interface AuthState {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<User | null>;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const controller = new AbortController();
    // Guard against a hung fetch leaving the app on the splash screen forever.
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const { user } = await auth.me(controller.signal);
      setUser(user);
      return user;
    } catch (e) {
      if (e instanceof Error && e.name !== "AbortError") {
        console.error("[auth] refresh failed:", e.message);
      }
      setUser(null);
      return null;
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await auth.logout();
    } finally {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
