import React, { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

// The backend Google OAuth callback redirects to <base>/auth/callback#token=<session>.
// We read that token, complete the session, then route into the app.
export default function AuthCallback() {
  const navigate = useNavigate();
  const { completeGoogleLogin } = useAuth();
  const processed = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const hash = window.location.hash || "";
    const errMatch = hash.match(/error=([^&]+)/);
    if (errMatch) {
      navigate(`/login?error=${errMatch[1]}`, { replace: true });
      return;
    }
    // Web flow: the backend already set the httpOnly session cookie on its
    // redirect and no longer puts the token in the URL. Any legacy #token=
    // fragment is ignored — the cookie is the sole credential.
    (async () => {
      const u = await completeGoogleLogin();
      // Clear the hash so it isn't re-processed.
      window.history.replaceState(null, "", window.location.pathname);
      navigate(u ? "/dashboard" : "/login", { replace: true });
    })();
  }, [navigate, completeGoogleLogin]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--vivo-bg)]">
      <div className="text-center">
        <div className="eyebrow mb-3">VIVO · CLIENTELING</div>
        <p className="text-[var(--vivo-muted)]">Signing you in…</p>
      </div>
    </div>
  );
}
