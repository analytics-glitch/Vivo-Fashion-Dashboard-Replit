import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { auth, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/toast";
import { Button, Spinner } from "../components/ui";
import { GoogleIcon, MailIcon } from "../components/icons";

export function meta() {
  return [{ title: "Sign in · Vivo Loyalty" }];
}

type Step = "email" | "code";

export default function Login() {
  const { user, loading, refresh, setUser } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const referralCode = params.get("ref") ?? undefined;

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [autoSigningIn, setAutoSigningIn] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const autoTried = useRef(false);

  // Redirect if already signed in (e.g. returned from Google OAuth).
  useEffect(() => {
    if (!loading && user) navigate("/dashboard", { replace: true });
  }, [user, loading, navigate]);

  useEffect(() => {
    auth.status().then((s) => setGoogleEnabled(s.google)).catch(() => {});
  }, []);

  useEffect(() => {
    if (params.get("error") === "google") toast("Google sign-in failed. Try again.", "error");
  }, [params, toast]);

  const requestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    try {
      const { ttlMinutes } = await auth.requestOtp(email, referralCode);
      setStep("code");
      toast(`We sent a code to ${email}. Expires in ${ttlMinutes}m.`, "success");
      setTimeout(() => codeRef.current?.focus(), 100);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't send the code.", "error");
    } finally {
      setBusy(false);
    }
  };

  const doVerify = async (emailVal: string, codeVal: string) => {
    setBusy(true);
    try {
      const { user } = await auth.verifyOtp(emailVal, codeVal, referralCode);
      setUser(user);
      toast("Welcome! 🎉", "success");
      navigate("/dashboard", { replace: true });
      return true;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Invalid code.", "error");
      setCode("");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length < 4) return;
    await doVerify(email, code);
  };

  // Magic link from the OTP email: /login?email=…&code=… → auto sign-in.
  // (Verification is a client POST, so email link-scanners can't consume the code.)
  useEffect(() => {
    if (autoTried.current) return;
    const em = params.get("email");
    const cd = params.get("code");
    if (em && cd) {
      autoTried.current = true;
      setEmail(em);
      setCode(cd);
      setStep("code");
      setAutoSigningIn(true);
      doVerify(em, cd).finally(() => setAutoSigningIn(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  if (autoSigningIn) {
    return (
      <div className="grid min-h-[100dvh] place-items-center px-6 text-center">
        <div className="flex flex-col items-center gap-4">
          <img src="/loyalty-app/icons/vivo-mark.png" alt="Vivo Loyalty" className="h-16 w-16 rounded-2xl object-cover" />
          <Spinner className="h-6 w-6 text-[var(--accent)]" />
          <p className="text-sm text-muted">Signing you in…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-hidden">
      {/* Ambient brand background */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-brand-500/30 blur-3xl" />
        <div className="absolute -right-20 top-40 h-72 w-72 rounded-full bg-fuchsia-500/20 blur-3xl" />
      </div>

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-10">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center text-center rise">
          <img
            src="/loyalty-app/icons/vivo-mark.png"
            alt="Vivo Loyalty"
            className="h-16 w-16 rounded-2xl object-cover shadow-[var(--shadow-accent)]"
          />
          <h1 className="mt-4 text-2xl font-bold tracking-tight">Vivo Loyalty</h1>
          <p className="mt-1 text-sm text-muted">
            {step === "email"
              ? "Sign in to earn points & unlock rewards."
              : `Enter the 6-digit code we sent to ${email}.`}
          </p>
        </div>

        <div className="card p-6 rise">
          {step === "email" ? (
            <>
              {googleEnabled && (
                <>
                  <a href={auth.googleRedirectUrl(referralCode)} className="block">
                    <Button variant="secondary" full type="button" className="!py-3.5">
                      <GoogleIcon />
                      Continue with Google
                    </Button>
                  </a>
                  <div className="my-5 flex items-center gap-3 text-xs text-muted">
                    <span className="h-px flex-1 bg-[var(--card-border)]" />
                    or use email
                    <span className="h-px flex-1 bg-[var(--card-border)]" />
                  </div>
                </>
              )}

              <form onSubmit={requestCode} className="space-y-3">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">Email address</span>
                  <div className="flex items-center gap-2 rounded-2xl border border-[var(--card-border)] bg-[var(--bg)] px-3.5 focus-within:border-brand-400">
                    <MailIcon className="h-5 w-5 text-muted" />
                    <input
                      type="email"
                      required
                      autoFocus
                      value={email}
                      onChange={(e) => setEmail(e.target.value.trim())}
                      placeholder="you@example.com"
                      className="w-full bg-transparent py-3.5 text-sm outline-none"
                    />
                  </div>
                </label>
                <Button full type="submit" loading={busy}>
                  Send me a code
                </Button>
              </form>
              <p className="mt-4 text-center text-xs text-muted">
                We'll email you a one-time code. No password needed.
              </p>
            </>
          ) : (
            <form onSubmit={verifyCode} className="space-y-4">
              <input
                ref={codeRef}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="••••••"
                className="mx-auto block w-full max-w-[220px] rounded-2xl border border-[var(--card-border)] bg-[var(--bg)] py-3.5 pl-[0.2em] text-center text-xl font-semibold tracking-[0.2em] outline-none focus:border-brand-400"
              />
              <Button full type="submit" loading={busy} disabled={code.length < 4}>
                Verify & continue
              </Button>
              <div className="flex items-center justify-between text-xs">
                <button type="button" onClick={() => setStep("email")} className="text-muted hover:text-[var(--text)]">
                  ← Change email
                </button>
                <button
                  type="button"
                  onClick={() => requestCode(new Event("submit") as unknown as React.FormEvent)}
                  className="font-semibold text-brand-600"
                >
                  Resend code
                </button>
              </div>
            </form>
          )}
        </div>

        {referralCode && (
          <p className="mt-5 text-center text-sm text-muted rise">
            🎁 You were invited — you'll get bonus points when you join!
          </p>
        )}

        {loading && (
          <div className="mt-6 flex justify-center">
            <Spinner className="h-5 w-5 text-brand-500" />
          </div>
        )}
      </div>
    </div>
  );
}
