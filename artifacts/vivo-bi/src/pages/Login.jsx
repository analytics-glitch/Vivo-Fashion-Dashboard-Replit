import React, { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { homePageFor } from "@/lib/permissions";
import { GoogleLogo, Envelope, Lock, SignIn, Warning, ShieldCheck, Key } from "@phosphor-icons/react";
import { api, API } from "@/lib/api";

const Login = () => {
  const { user, loginWithPassword, completeTwoFactor } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [domains, setDomains] = useState([]);
  const [twoFactor, setTwoFactor] = useState(null);
  const [enrollment, setEnrollment] = useState(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [codesSaved, setCodesSaved] = useState(false);
  const [twoFactorLoading, setTwoFactorLoading] = useState(false);
  // Iter 78 — surface a friendly explanation when the API client
  // 401-redirects us here mid-session. URL is set by the axios
  // interceptor in `lib/api.js`. Suppressed once the user clicks
  // anything (clearing the error).
  const [sessionExpired, setSessionExpired] = useState(false);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  useEffect(() => {
    api.get("/auth/allowed-domains").then((r) => setDomains(r.data.domains || [])).catch(() => {});
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("session_expired") === "1") setSessionExpired(true);
      const mode = params.get("mode");
      if (params.get("two_factor") === "1" && (mode === "enroll" || mode === "verify")) {
        setTwoFactor({ mode });
        if (mode === "enroll") startEnrollment();
      }
    } catch { /* noop */ }
  }, []);

  const startEnrollment = async () => {
    setTwoFactorLoading(true);
    setError(null);
    try {
      const r = await api.post("/auth/2fa/enroll");
      setEnrollment(r.data || null);
    } catch (err) {
      setError(err?.response?.data?.detail || "Could not start two-factor enrollment.");
    } finally {
      setTwoFactorLoading(false);
    }
  };

  if (user) return <Navigate to="/" replace />;

  const onSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // iOS Safari password-manager autofill often sets input.value WITHOUT
      // firing React's onChange, so state is stale/empty. Read the live DOM
      // value as a fallback before submitting.
      const em = (email.trim() || emailRef.current?.value?.trim() || "").trim();
      const pw = password || passwordRef.current?.value || "";
      if (!em || !pw) {
        setError("Please enter both email and password.");
        return;
      }
      const result = await loginWithPassword(em, pw);
      if (result?.two_factor_required) {
        setTwoFactor(result.two_factor || { mode: "verify" });
        if ((result.two_factor?.mode || "verify") === "enroll") await startEnrollment();
        return;
      }
      navigate(homePageFor(result?.user), { replace: true });
    } catch (err) {
      // Surface the ACTUAL failure cause so iOS Safari issues are debuggable
      // instead of a generic "Login failed". Pick the most specific source
      // available, in priority order.
      let msg;
      if (err?.name === "QuotaExceededError") {
        msg = "Your browser is blocking session storage (iOS Safari Private mode). Turn off Private Browsing and try again.";
      } else if (err?.response?.data?.detail) {
        // Backend replied with a structured error — trust it.
        msg = err.response.data.detail;
      } else if (err?.response) {
        // Backend replied but with no detail field.
        msg = `Server returned HTTP ${err.response.status}. Please try again or contact support.`;
      } else if (err?.code === "ERR_NETWORK" || err?.message?.includes("Network Error")) {
        // Most common iOS failure: browser blocked the request at the network
        // layer (CORS / certificate / ITP). Give the user something actionable.
        msg = "Cannot reach the server from this browser. On iOS: turn off Private Browsing, check your network, and reload the page. If the issue persists, please screenshot this and send to IT.";
      } else if (err?.code === "ECONNABORTED") {
        msg = "The server took too long to respond. Check your connection and try again.";
      } else {
        msg = `Login failed: ${err?.message || "unknown error"}`;
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const verifyTwoFactor = async (e) => {
    e.preventDefault();
    const code = verificationCode.trim();
    if (!code) {
      setError("Enter the 6-digit code from your authenticator app, or a backup code.");
      return;
    }
    if (twoFactor?.mode === "enroll" && (!enrollment || !codesSaved)) {
      setError("Save your backup codes before finishing enrollment.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const loggedInUser = await completeTwoFactor(code);
      navigate(homePageFor(loggedInUser), { replace: true });
    } catch (err) {
      setError(err?.response?.data?.detail || "That verification code was not accepted.");
    } finally {
      setSubmitting(false);
    }
  };

  const googleSignIn = () => {
    // Our backend starts the Google OAuth flow, then redirects back to
    // /auth/callback#token=<session> (or #error=…). API is "/api" (same
    // origin) in production, or the full backend URL in the preview env.
    window.location.href = `${API}/auth/google/login`;
  };

  return (
    <div className="min-h-screen bg-background grid place-items-center p-4" data-testid="login-page">
      <div className="w-full max-w-md card-white p-8 shadow-md">
        <div className="flex items-center gap-3 mb-6">
          <img src="/brand/vivo-logo.png" alt="Vivo Fashion Group" className="h-11 w-auto rounded-md shrink-0" />
          <div>
            <div className="font-bold tracking-tight">Vivo Fashion Group</div>
            <div className="text-[11px] text-muted uppercase tracking-wider">BI · East Africa</div>
          </div>
        </div>

        <h1 className="font-extrabold text-[22px] tracking-tight mb-1">Sign in</h1>
        <p className="text-muted text-[13px] mb-6">
          Access is restricted to {domains.map((d, i) => (
            <span key={d} className="font-semibold text-foreground">
              {i > 0 && " or "}@{d}
            </span>
          ))} email domains.
        </p>

        {twoFactor ? (
          <div className="space-y-4" data-testid="two-factor-panel">
            <div className="rounded-xl border border-brand/20 bg-brand-soft/40 p-4">
              <div className="flex items-center gap-2 font-bold text-[15px]">
                <ShieldCheck size={19} weight="bold" className="text-brand" />
                {twoFactor.mode === "enroll" ? "Set up two-step verification" : "Verify your sign-in"}
              </div>
              <p className="text-muted text-[12.5px] mt-1.5 leading-relaxed">
                {twoFactor.mode === "enroll"
                  ? "Protect your Vivo BI account with an authenticator app. This is required the first time you sign in after two-step verification is enabled."
                  : "Enter the 6-digit code from your authenticator app. You can use a backup code instead if you no longer have your app."}
              </p>
            </div>

            {twoFactor.mode === "enroll" && (
              <div className="space-y-3">
                {twoFactorLoading && <div className="text-muted text-[13px]">Preparing your secure setup…</div>}
                {enrollment && (
                  <>
                    <div className="flex flex-col sm:flex-row gap-4 items-center">
                      <div className="bg-white border border-border rounded-lg p-2 shrink-0">
                        <img
                          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(enrollment.qr_svg || "")}`}
                          alt="Authenticator setup QR code"
                          className="w-36 h-36"
                        />
                      </div>
                      <div className="text-[12px] leading-relaxed">
                        <p className="font-semibold mb-1">Scan with Google Authenticator, 1Password, or Authy.</p>
                        <p className="text-muted">If you cannot scan, enter this setup key manually:</p>
                        <div className="mt-2 flex items-center gap-1.5 rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[11px] break-all">
                          <Key size={13} className="shrink-0 text-brand" />
                          {enrollment.manual_key}
                        </div>
                         {enrollment.provisioning_uri && (
                           <a
                             href={enrollment.provisioning_uri}
                             className="sm:hidden mt-2 inline-flex items-center justify-center rounded-md bg-brand px-3 py-2 text-[12px] font-semibold text-white"
                             data-testid="totp-mobile-link"
                           >
                             Tap to add to your authenticator
                           </a>
                         )}
                      </div>
                    </div>
                    <div className="rounded-lg border border-amber-300/70 bg-amber-50 p-3">
                      <div className="font-semibold text-[12px] text-amber-950">Save these 8 backup codes</div>
                      <p className="text-[11px] text-amber-900 mt-1">Each code works once if you lose access to your authenticator. They will not be shown again.</p>
                      <div className="grid grid-cols-2 gap-1.5 mt-2 font-mono text-[12px] text-amber-950">
                        {(enrollment.backup_codes || []).map((backup) => <span key={backup}>{backup}</span>)}
                      </div>
                      <label className="flex items-start gap-2 mt-3 text-[12px] text-amber-950">
                        <input type="checkbox" checked={codesSaved} onChange={(e) => setCodesSaved(e.target.checked)} />
                        <span>I have saved my backup codes somewhere secure.</span>
                      </label>
                    </div>
                  </>
                )}
              </div>
            )}

            {twoFactor.mode === "verify" && (
              <p className="text-[12px] text-muted">
                Backup codes are accepted in the same field and are single-use.
              </p>
            )}

            {error && (
              <div className="rounded-lg border border-danger/30 bg-danger/5 text-danger px-3 py-2 text-[12.5px] flex items-start gap-2" data-testid="login-error">
                <Warning size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={verifyTwoFactor} className="space-y-3" data-testid="two-factor-form">
              <div>
                <label htmlFor="two-factor-code" className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                  Authenticator or backup code
                </label>
                <input
                  id="two-factor-code"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value)}
                  className="w-full mt-1 px-3 py-2.5 rounded-lg border border-border focus:border-brand outline-none text-[16px] font-mono tracking-widest"
                  placeholder={twoFactor.mode === "enroll" ? "123456" : "123456 or ABCD-EFGH-JKLM"}
                  inputMode="text"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
              </div>
              <button
                type="submit"
                disabled={submitting || twoFactorLoading || (twoFactor.mode === "enroll" && !enrollment)}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-brand text-white font-semibold text-[14px] hover:bg-brand-deep disabled:opacity-60"
                data-testid="two-factor-submit"
              >
                <ShieldCheck size={15} weight="bold" />
                {submitting ? "Verifying…" : twoFactor.mode === "enroll" ? "Finish setup" : "Verify and sign in"}
              </button>
            </form>
            <button
              type="button"
              onClick={() => { setTwoFactor(null); setEnrollment(null); setVerificationCode(""); setError(null); }}
              className="w-full text-[12px] text-muted hover:text-foreground"
            >
              Start over
            </button>
          </div>
        ) : (
          <>
          <button
            type="button"
            onClick={googleSignIn}
            data-testid="google-signin-btn"
            className="w-full flex items-center justify-center gap-3 py-3 rounded-xl border border-border hover:border-brand hover:bg-brand-soft transition-colors font-semibold text-[14px]"
          >
            <GoogleLogo size={18} weight="bold" />
            Sign in with Google
          </button>

          <div className="flex items-center gap-3 my-5">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[11px] text-muted uppercase tracking-wider">or email</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={onSubmit} className="space-y-3" data-testid="login-form">
          <div>
            <label htmlFor="login-email" className="text-[11px] font-semibold text-muted uppercase tracking-wider">Email</label>
            <div className="mt-1 relative">
              <Envelope size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                id="login-email"
                name="email"
                ref={emailRef}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={(e) => setEmail(e.target.value)}
                required
                placeholder="you@company.com"
                data-testid="login-email"
                // font-size 16px prevents iOS auto-zoom on focus.
                className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-border focus:border-brand outline-none text-[16px]"
                autoComplete="username email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="email"
                enterKeyHint="next"
              />
            </div>
          </div>
          <div>
            <label htmlFor="login-password" className="text-[11px] font-semibold text-muted uppercase tracking-wider">Password</label>
            <div className="mt-1 relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                id="login-password"
                name="password"
                ref={passwordRef}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={(e) => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                data-testid="login-password"
                className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-border focus:border-brand outline-none text-[16px]"
                autoComplete="current-password"
                enterKeyHint="go"
              />
            </div>
          </div>

          {sessionExpired && !error && (
            <div className="rounded-lg border border-amber-300/60 bg-amber-50 text-amber-900 px-3 py-2 text-[12.5px] flex items-start gap-2" data-testid="login-session-expired">
              <Warning size={14} className="mt-0.5 shrink-0" />
              <span>Your session has expired. Please sign in again to continue.</span>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 text-danger px-3 py-2 text-[12.5px] flex items-start gap-2" data-testid="login-error">
              <Warning size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            data-testid="login-submit"
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-brand text-white font-semibold text-[14px] hover:bg-brand-deep disabled:opacity-60"
          >
            <SignIn size={15} weight="bold" />
            {submitting ? "Signing in…" : "Sign in"}
          </button>
          </form>
          </>
        )}

        <p className="mt-5 text-[11.5px] text-muted leading-relaxed">
          Email/password accounts are created by your administrator. Contact them if you need access.
        </p>

        <div className="mt-6 pt-4 border-t border-border/60 flex items-center justify-center gap-2 text-[11px] text-muted">
          <span>Powered by</span>
          <img src="/brand/vivo-logo.png" alt="Vivo BI" className="h-4 w-auto rounded-sm" />
          <span className="font-semibold text-foreground/70">BI</span>
        </div>
      </div>
    </div>
  );
};

export default Login;
