import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { homePageFor } from "@/lib/permissions";

const AuthCallback = () => {
  const { completeGoogleLogin } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    const run = async () => {
      const hash = (window.location.hash || "").replace(/^#/, "");
      const params = new URLSearchParams(hash);
      const errParam = params.get("error");
      if (errParam) {
        // WS9 T901 — map backend error codes to friendly copy (a raw code like
        // "provisioning" means nothing to a store manager).
        const code = decodeURIComponent(errParam);
        const friendly = {
          not_configured: "Google sign-in isn't configured yet. Use email & password, or contact an admin.",
          invalid_state: "The sign-in link expired or was reused. Please try signing in again.",
          token_exchange: "Google didn't complete the sign-in. Please try again.",
          profile: "We couldn't read your Google profile. Please try again.",
          domain_not_allowed: "This Google account isn't on an allowed company domain.",
          provisioning: "Sign-in succeeded but we couldn't set up your account just now. Please try again in a minute.",
        }[code];
        setError(friendly || code);
        return;
      }
      const token = params.get("token");
      if (!token) {
        setError("Missing token from redirect");
        return;
      }
      try {
        const u = await completeGoogleLogin(token);
        // Clear the hash so a reload doesn't re-process the token.
        window.history.replaceState(null, "", "/");
        // Pending/rejected users still land in the app — ProtectedRoute
        // routes them to the awaiting-approval screen. Store managers go
        // directly to Overview; everyone else lands on the Home tile grid.
        navigate(homePageFor(u), { replace: true });
        if (!u) setError("Could not verify your account. Please try again.");
      } catch (err) {
        setError(err?.response?.data?.detail || "Google sign-in failed");
      }
    };
    run();
    // eslint-disable-next-line
  }, []);

  return (
    <div className="min-h-screen grid place-items-center bg-background p-6" data-testid="auth-callback">
      <div className="card-white p-6 max-w-md w-full text-center">
        {error ? (
          <>
            <div className="font-bold text-danger text-[16px] mb-2">Sign-in failed</div>
            <p className="text-muted text-[13px] mb-4">{error}</p>
            <button
              className="px-3 py-1.5 rounded-lg bg-brand text-white text-[13px] font-semibold"
              onClick={() => navigate("/login", { replace: true })}
              data-testid="auth-callback-back"
            >
              Back to sign-in
            </button>
          </>
        ) : (
          <>
            <div className="animate-pulse font-semibold">Signing you in…</div>
            <p className="text-muted text-[12px] mt-1">Verifying your Google account</p>
          </>
        )}
      </div>
    </div>
  );
};

export default AuthCallback;
