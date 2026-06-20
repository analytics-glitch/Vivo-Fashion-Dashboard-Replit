import React, { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { LoadingState } from "../components/UIBits";

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
    const m = hash.match(/token=([^&]+)/);
    if (!m) {
      navigate("/login", { replace: true });
      return;
    }
    const token = decodeURIComponent(m[1]);

    (async () => {
      const u = await completeGoogleLogin(token);
      // Clear the hash so it isn't re-processed.
      window.history.replaceState(null, "", window.location.pathname);
      navigate(u ? "/" : "/login", { replace: true });
    })();
  }, [navigate, completeGoogleLogin]);

  return (
    <div className="min-h-screen grid place-items-center bg-background">
      <LoadingState />
    </div>
  );
}
