import React, { createContext, useContext, useMemo } from "react";
import { useUser, useAuth as useClerkAuth, useClerk } from "@clerk/react";
import { clearApiCache } from "@/lib/api";

/**
 * Clerk auth bridge
 * -----------------
 * Access to the dashboard is restricted to company accounts. Authentication
 * is handled by Replit-managed Clerk; this provider adapts Clerk's session
 * into the legacy `useAuth` context shape the rest of the app expects
 * ({ user, loading, logout, ... }) so the 24 pages, ProtectedRoute and
 * permissions.js stay unchanged.
 *
 * `user` is non-null ONLY when the visitor is signed in AND their verified
 * email belongs to an allowed company domain. Allowed users are mapped to an
 * `admin` role/active status. Domain-blocked sign-ins keep `user === null`
 * (with `isSignedIn === true`, `domainAllowed === false`) so ProtectedRoute
 * can render the AccessRestricted screen instead of the app.
 */

export const ALLOWED_DOMAINS = ["vivofashiongroup.com", "shopzetu.com"];

export const isAllowedEmail = (email) => {
  if (!email || !email.includes("@")) return false;
  const domain = email.split("@").pop().trim().toLowerCase();
  return ALLOWED_DOMAINS.includes(domain);
};

const AuthContext = createContext(null);

// Legacy token helpers — kept as no-ops so any stray imports don't break.
// Clerk owns the session entirely (cookie-based); there is no app-managed token.
export const getStoredToken = () => null;
export const setStoredToken = () => {};

export const AuthProvider = ({ children }) => {
  const { isLoaded, isSignedIn } = useClerkAuth();
  const { user: clerkUser } = useUser();
  const clerk = useClerk();

  const value = useMemo(() => {
    const email = (clerkUser?.primaryEmailAddress?.emailAddress || "").toLowerCase();
    const domainAllowed = isAllowedEmail(email);
    const user =
      isSignedIn && domainAllowed && clerkUser
        ? {
            id: clerkUser.id,
            name:
              clerkUser.fullName ||
              clerkUser.firstName ||
              email.split("@")[0],
            email,
            role: "admin",
            status: "active",
            active: true,
            picture: clerkUser.imageUrl || null,
          }
        : null;

    const logout = async () => {
      try { clearApiCache(); } catch { /* noop */ }
      try { await clerk.signOut(); } catch { /* noop */ }
    };

    return {
      user,
      loading: !isLoaded,
      isSignedIn: !!isSignedIn,
      domainAllowed,
      email,
      logout,
      // Password / Google flows are owned by Clerk's sign-in UI now.
      loginWithPassword: async () => {
        throw new Error("Use the sign-in page.");
      },
      completeGoogleLogin: async () => {},
      checkAuth: async () => {},
    };
  }, [isLoaded, isSignedIn, clerkUser, clerk]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
