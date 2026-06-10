import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  useEffect,
  useCallback,
} from "react";
import { useUser, useAuth as useClerkAuth, useClerk } from "@clerk/react";
import { api, clearApiCache } from "@/lib/api";

/**
 * Clerk auth bridge
 * -----------------
 * Access to the dashboard is restricted to company accounts. Authentication
 * is handled by Replit-managed Clerk; this provider adapts Clerk's session
 * into the legacy `useAuth` context shape the rest of the app expects
 * ({ user, loading, logout, checkAuth, ... }).
 *
 * Clerk only proves IDENTITY (signed-in + which email). The user's ROLE and
 * approval STATUS live in the backend (`GET /auth/me`, persisted in Postgres):
 * a brand-new company-domain account is created `pending` until an admin
 * approves it. So we fetch /auth/me once the Clerk session is ready and build
 * `user` from that — role, status and all.
 *
 * `user` is non-null whenever the visitor is signed in, on an allowed company
 * domain, AND we have their /auth/me profile (this includes pending/rejected
 * users, so ProtectedRoute can show the AwaitingApproval screen). Domain-blocked
 * sign-ins keep `user === null` (`isSignedIn === true`, `domainAllowed === false`)
 * so ProtectedRoute renders AccessRestricted instead.
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

  const email = (clerkUser?.primaryEmailAddress?.emailAddress || "").toLowerCase();
  const domainAllowed = isAllowedEmail(email);

  // Persisted profile from GET /auth/me (role + approval status). `null` until
  // the first successful fetch; `_error` distinguishes "still loading" from
  // "fetch failed" so we don't spin forever on a transient error.
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState(false);

  const fetchMe = useCallback(async () => {
    try {
      const r = await api.get("/auth/me");
      setProfile(r?.data && r.data.id ? r.data : null);
      setProfileError(false);
    } catch {
      setProfile(null);
      setProfileError(true);
    }
  }, []);

  // Fetch (and refetch on identity change) once Clerk says we're signed in on
  // an allowed domain. Clear it the moment we're signed out / off-domain.
  useEffect(() => {
    if (isLoaded && isSignedIn && domainAllowed) {
      setProfileError(false);
      fetchMe();
    } else {
      setProfile(null);
      setProfileError(false);
    }
  }, [isLoaded, isSignedIn, domainAllowed, clerkUser?.id, fetchMe]);

  const value = useMemo(() => {
    const user =
      isSignedIn && domainAllowed && profile
        ? {
            ...profile,
            id: profile.id,
            user_id: profile.user_id || profile.id,
            name:
              profile.name ||
              clerkUser?.fullName ||
              clerkUser?.firstName ||
              email.split("@")[0],
            email: profile.email || email,
            role: profile.role || "viewer",
            status: profile.status || "active",
            active: (profile.status || "active") === "active",
            picture: clerkUser?.imageUrl || null,
          }
        : null;

    const logout = async () => {
      try { clearApiCache(); } catch { /* noop */ }
      try { await clerk.signOut(); } catch { /* noop */ }
    };

    // Still resolving while Clerk is loading, or while we're signed in on an
    // allowed domain but haven't yet received /auth/me (and it hasn't errored).
    const loading =
      !isLoaded ||
      (isSignedIn && domainAllowed && profile === null && !profileError);

    return {
      user,
      loading,
      isSignedIn: !!isSignedIn,
      domainAllowed,
      email,
      logout,
      // Re-fetch the persisted profile — used by AwaitingApproval to poll for
      // approval, and anywhere a fresh role/status read is needed.
      checkAuth: fetchMe,
      // Password / Google flows are owned by Clerk's sign-in UI now.
      loginWithPassword: async () => {
        throw new Error("Use the sign-in page.");
      },
      completeGoogleLogin: async () => {},
    };
  }, [
    isLoaded,
    isSignedIn,
    domainAllowed,
    email,
    profile,
    profileError,
    clerkUser,
    clerk,
    fetchMe,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
