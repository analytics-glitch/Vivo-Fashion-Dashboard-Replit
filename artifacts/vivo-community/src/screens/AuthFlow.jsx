import React, { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { inputCls, btnPrimary, btnSecondary, cardCls, VivoLogo, brandAsset } from "@/components/community/ui";
import HelpFaqView from "@/components/community/HelpFaqView";
import LegalPage from "@/components/community/LegalPage";
import { LEGAL_META } from "@/components/community/legalData";
import { Loader2, ArrowRight, Check, AlertCircle, X } from "lucide-react";

const COUNTRIES = [
  { code: "254", label: "KE +254" },
  { code: "250", label: "RW +250" },
  { code: "256", label: "UG +256" },
];

function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <div className="mt-4 flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded p-3">
      <AlertCircle className="shrink-0 mt-0.5" size={16} />
      <span className="leading-snug">{children}</span>
    </div>
  );
}

export default function AuthFlow() {
  const { signIn, enterGuest } = useAuth();
  // The welcome screen is a full-bleed campaign photo; the actual auth forms
  // open in a separate clean sheet ("signin" | "create" intent — both feed
  // the same phone-first flow, the server decides sign-in vs sign-up).
  const [sheet, setSheet] = useState(""); // "" | signin | create
  const [step, setStep] = useState("phone"); // phone | code | signup
  const [cc, setCc] = useState("254");
  const [local, setLocal] = useState("");
  const [code, setCode] = useState("");
  const [demo, setDemo] = useState(false);
  const [masked, setMasked] = useState("");
  const [signupToken, setSignupToken] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [dob, setDob] = useState("");
  const [consent, setConsent] = useState(false); // must start unchecked
  const [username, setUsername] = useState("");
  const [uname, setUname] = useState({ state: "idle" }); // idle|checking|ok|taken|invalid
  const unameRef = useRef("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [page, setPage] = useState(""); // "" | faq | terms | privacy | guidelines
  const codeRef = useRef(null);
  // Preserve an opaque referral code all the way through the phone-first
  // verification journey. It is validated server-side at signup.
  const referralCodeRef = useRef(new URLSearchParams(window.location.search).get("ref") || "");

  const phoneDigits = () => cc + local.replace(/\D/g, "").replace(/^0+/, "");
  const localDigits = local.replace(/\D/g, "");
  const localOk = /^\d{9,10}$/.test(localDigits.replace(/^0+/, "")) ||
    /^0\d{9}$/.test(localDigits);
  const phoneHint = localDigits && !localOk
    ? `Enter 9 digits after +${cc}, for example 712 345 678.`
    : `Enter 9 digits after +${cc}, for example 712 345 678.`;

  // Membership is 18+ (Terms §1) — cap the date picker; the server enforces it too.
  const dobMax = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 18);
    return d.toISOString().slice(0, 10);
  })();

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  useEffect(() => {
    if (step === "code" && codeRef.current) codeRef.current.focus();
  }, [step]);

  // Live username availability (debounced; guarded against stale responses)
  useEffect(() => {
    const u = username;
    if (!u) { setUname({ state: "idle" }); return; }
    if (u.length < 3) { setUname({ state: "invalid", message: "Usernames are 3–20 characters" }); return; }
    setUname({ state: "checking" });
    const t = setTimeout(() => {
      api.usernameCheck(u)
        .then((d) => {
          if (unameRef.current !== u) return;
          if (d.available) setUname({ state: "ok" });
          else setUname({ state: d.valid ? "taken" : "invalid", message: d.message, suggestions: d.suggestions || [] });
        })
        .catch(() => { if (unameRef.current === u) setUname({ state: "idle" }); });
    }, 400);
    return () => clearTimeout(t);
  }, [username]);

  const sendCode = async () => {
    setBusy(true); setError("");
    try {
      const d = await api.requestCode(phoneDigits());
      setDemo(!!d.demo);
      setMasked(d.phone_masked || "");
      setCode("");
      setStep("code");
      setResendIn(30);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const verify = async (val) => {
    const c = (val ?? code).replace(/\D/g, "");
    if (c.length !== 6 || busy) return;
    setBusy(true); setError("");
    try {
      const d = await api.verify(phoneDigits(), c);
      if (d.needs_signup) {
        setSignupToken(d.signup_token);
        setStep("signup");
      } else {
        signIn(d.token, d.member);
      }
    } catch (e) { setError(e.message); setCode(""); }
    setBusy(false);
  };

  const submitSignup = async () => {
    setBusy(true); setError("");
    try {
      const d = await api.signup({
        signup_token: signupToken,
        full_name: fullName,
        username,
        email,
        dob,
        consent,
        referral_code: referralCodeRef.current,
        // Version of the terms shown at the moment of consent — recorded
        // server-side as consent_terms_version.
        terms_version: LEGAL_META.terms.version,
      });
      // One-shot karibu moment on the very first session (TabHome shows it).
      try { sessionStorage.setItem("johari_welcome", "1"); } catch {}
      signIn(d.token, d.member);
    } catch (e) {
      if (e.detail?.code === "username_taken") {
        setUname({ state: "taken", message: e.detail.message, suggestions: e.detail.suggestions || [] });
      }
      setError(e.message);
    }
    setBusy(false);
  };

  const signupReady = fullName.trim().length >= 2 && /\S+@\S+\.\S+/.test(email) && dob && consent &&
    uname.state === "ok";

  // Help & legal pages are readable mid-signup without losing progress:
  // AuthFlow state (form fields, signup token) survives this subtree swap.
  if (page) {
    return (
      <div className="min-h-[100dvh] bg-background text-foreground">
        <div className="mx-auto max-w-3xl px-6 py-10">
          {page === "faq" ? (
            <HelpFaqView onBack={() => setPage("")} onOpenPage={setPage} />
          ) : (
            <LegalPage doc={page} onBack={() => setPage("")} onOpenPage={setPage} />
          )}
        </div>
      </div>
    );
  }

  const openSheet = (intent) => {
    setError("");
    setSheet(intent);
  };
  const closeSheet = () => setSheet("");

  return (
    <div className="min-h-[100dvh] bg-neutral-950 text-white relative overflow-hidden">
      {/* Full-bleed vertical campaign photo + a subtle dark gradient so the
          copy stays readable without hiding the image. */}
      <img
        src={brandAsset("welcome.jpg")}
        alt=""
        className="absolute inset-0 w-full h-full object-cover object-[center_22%]"
        draggable={false}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-black/20 pointer-events-none" />

      <div
        className="relative z-10 min-h-[100dvh] flex flex-col justify-between px-6"
        style={{
          paddingTop: "calc(env(safe-area-inset-top, 0px) + 2.25rem)",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 2rem)",
        }}
      >
        <div className="flex flex-col items-center animate-in fade-in duration-700">
          <VivoLogo size="md" className="shadow-lg" />
        </div>

        <div className="w-full max-w-[420px] mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700 ease-out">
          <h1 className="font-serif text-4xl sm:text-5xl leading-[1.05] text-white mb-2">Welcome to Johari</h1>
          <p className="text-[12px] uppercase tracking-[0.3em] text-white/70 mb-3">A Vivo Rewards Experience</p>
          <p data-testid="welcome-tagline" className="text-white/85 text-[15px] leading-relaxed mb-8">
            Style, community and rewards—all in one place.
          </p>

          <div className="space-y-3">
            <button
              data-testid="welcome-signin"
              onClick={() => openSheet("signin")}
              className="h-12 w-full rounded bg-primary text-primary-foreground font-medium text-[15px] flex items-center justify-center gap-2 transition-all hover:opacity-90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              Sign In
            </button>
            <button
              data-testid="welcome-create"
              onClick={() => openSheet("create")}
              className="h-12 w-full rounded border border-white/80 bg-transparent text-white font-medium text-[15px] flex items-center justify-center gap-2 transition-all hover:bg-white/10 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
            >
              Create Account
            </button>
            <div className="pt-2 text-center">
              <button
                data-testid="welcome-guest"
                onClick={enterGuest}
                className="text-[13px] text-white/80 underline underline-offset-4 decoration-white/40 hover:text-white transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 min-h-[44px] px-2"
              >
                Continue as Guest
              </button>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap justify-center gap-x-5 gap-y-2">
            <button data-testid="auth-link-faq" onClick={() => setPage("faq")} className="text-[11px] font-medium text-white/60 hover:text-white transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">Help & FAQs</button>
            <button data-testid="auth-link-terms" onClick={() => setPage("terms")} className="text-[11px] font-medium text-white/60 hover:text-white transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">Terms & Conditions</button>
            <button data-testid="auth-link-privacy" onClick={() => setPage("privacy")} className="text-[11px] font-medium text-white/60 hover:text-white transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">Privacy Policy</button>
            <button data-testid="auth-link-guidelines" onClick={() => setPage("guidelines")} className="text-[11px] font-medium text-white/60 hover:text-white transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">Community Guidelines</button>
          </div>
        </div>
      </div>

      {/* Auth sheet — a separate clean surface (bottom sheet on mobile,
          centred card on desktop). All of the original phone → code → signup
          logic lives here unchanged. */}
      {sheet && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
          <div className="absolute inset-0 bg-black/60 animate-in fade-in duration-200" onClick={closeSheet} aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={sheet === "create" ? "Create your Vivo account" : "Sign in to Vivo"}
            className="relative w-full sm:max-w-[460px] bg-background text-foreground rounded-t-2xl sm:rounded-lg shadow-2xl max-h-[92dvh] overflow-y-auto animate-in slide-in-from-bottom-8 sm:zoom-in-95 duration-300 ease-out"
          >
            <div className="sm:hidden pt-3 flex justify-center" aria-hidden="true">
              <span className="w-10 h-1 rounded-full bg-border" />
            </div>
            <div className="px-6 sm:px-8 pt-4 pb-10" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 2.5rem)" }}>
              <div className="flex items-center justify-between mb-8">
                <VivoLogo size="sm" />
                <button
                  data-testid="auth-sheet-close"
                  onClick={closeSheet}
                  aria-label="Close"
                  className="w-10 h-10 rounded-full flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <X size={18} />
                </button>
              </div>

          {step === "phone" && (
            <div className="space-y-8">
              <div>
                <h2 className="text-2xl font-serif mb-3">{sheet === "create" ? "Create your account" : "Sign in"}</h2>
                <p className="text-muted-foreground text-[15px] leading-relaxed">
                  {sheet === "create"
                    ? "Enter your phone number to get started — we'll text you a code, then set up your profile."
                    : "Sign in with your phone number for Vivo Johari — the live collection, style challenges and member rewards."}
                </p>
              </div>

              <div className="space-y-6">
                <div className="space-y-2">
                  <label htmlFor="phone-input" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Mobile Number</label>
                  <div className="flex gap-2">
                    <select
                      data-testid="select-country"
                      aria-label="Country code"
                      value={cc}
                      onChange={(e) => setCc(e.target.value)}
                      className={`${inputCls} w-28 bg-transparent shrink-0`}
                    >
                      {COUNTRIES.map((c) => (
                        <option key={c.code} value={c.code}>{c.label}</option>
                      ))}
                    </select>
                    <input
                      data-testid="input-phone"
                      id="phone-input"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel"
                      placeholder="712 345 678"
                      value={local}
                      onChange={(e) => setLocal(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && localOk && !busy && sendCode()}
                      aria-invalid={Boolean(localDigits && !localOk)}
                      aria-describedby="phone-hint"
                      className={`${inputCls} flex-1 min-w-0`}
                    />
                  </div>
                  <p
                    id="phone-hint"
                    className={`text-xs leading-relaxed ${localDigits && !localOk ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {phoneHint}
                  </p>
                </div>

                <ErrorNote>{error}</ErrorNote>

                <button
                  data-testid="btn-send-code"
                  onClick={sendCode}
                  disabled={!localOk || busy}
                  className={btnPrimary}
                >
                  {busy ? <Loader2 className="animate-spin" size={18} /> : "Continue"}
                </button>
              </div>
            </div>
          )}

          {step === "code" && (
            <div className="space-y-8">
              <div>
                <h2 className="text-2xl font-serif mb-3">Check your messages</h2>
                <p className="text-muted-foreground text-[15px] leading-relaxed">
                  We sent a 6-digit access code to <span className="text-foreground font-medium">{masked}</span>.
                </p>
              </div>

              {demo && (
                <div data-testid="demo-banner" className="bg-secondary/50 border border-border p-4 rounded text-sm text-foreground/80 leading-relaxed">
                  <div className="flex items-center gap-2 font-medium mb-1 text-foreground">
                    <AlertCircle size={16} /> Demo Environment
                  </div>
                  SMS delivery is disabled in demo mode. Please use code <span className="font-mono font-bold tracking-widest bg-background px-1.5 py-0.5 rounded">123456</span> to enter.
                </div>
              )}

              <div className="space-y-6">
                <input
                  ref={codeRef}
                  data-testid="input-otp"
                  aria-label="6-digit verification code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="••••••"
                  value={code}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                    setCode(v);
                    if (v.length === 6) verify(v);
                  }}
                  className={`${inputCls} w-full text-center text-2xl tracking-[0.5em] font-light font-serif py-6 h-auto`}
                />
                
                <ErrorNote>{error}</ErrorNote>

                <button
                  data-testid="btn-verify"
                  onClick={() => verify()}
                  disabled={code.length !== 6 || busy}
                  className={btnPrimary}
                >
                  {busy ? <Loader2 className="animate-spin" size={18} /> : "Enter Community"}
                </button>

                <div className="flex items-center justify-between text-sm pt-4 border-t border-border">
                  <button onClick={() => { setStep("phone"); setError(""); }} className="text-muted-foreground hover:text-foreground transition-colors">
                    Change number
                  </button>
                  <button
                    data-testid="btn-resend"
                    onClick={sendCode}
                    disabled={resendIn > 0 || busy}
                    className="text-primary-ink disabled:text-muted-foreground font-medium transition-colors"
                  >
                    {resendIn > 0 ? `Resend code (${resendIn}s)` : "Resend code"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "signup" && (
            <div className="space-y-8">
              <div>
                <h2 className="text-2xl font-serif mb-3">Complete Profile</h2>
                <p className="text-muted-foreground text-[15px] leading-relaxed">
                  Just a few details to finalize your Vivo Johari membership.
                </p>
              </div>

              <div className="space-y-5">
                <div className="space-y-2">
                  <label htmlFor="signup-name" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Full name</label>
                  <input data-testid="input-name" type="text" autoComplete="name" placeholder="Wanjiku Mwangi"
                    id="signup-name" value={fullName} onChange={(e) => setFullName(e.target.value)} className={`${inputCls} w-full`} />
                  <p className="text-[12px] text-muted-foreground leading-relaxed">Private — for your account and order records only.</p>
                </div>
                <div className="space-y-2">
                  <label htmlFor="signup-username" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Choose a username</label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground text-[15px]" aria-hidden="true">@</span>
                    <input data-testid="input-username" type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="wanjiku.m"
                      id="signup-username" value={username}
                      onChange={(e) => { const v = e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, "").slice(0, 20); unameRef.current = v; setUsername(v); }}
                      className={`${inputCls} w-full pl-9`} />
                  </div>
                  <p className="text-[12px] text-muted-foreground leading-relaxed">
                    This is the name other members will see on anything you share — your posts, comments, boards and challenge entries. Your real name stays private.
                  </p>
                  {uname.state === "checking" && (
                    <div data-testid="username-status" className="text-[12px] text-muted-foreground flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Checking availability…</div>
                  )}
                  {uname.state === "ok" && (
                    <div data-testid="username-status" className="text-[12px] text-primary-ink flex items-center gap-1.5"><Check size={13} /> @{username} is available</div>
                  )}
                  {(uname.state === "taken" || uname.state === "invalid") && (
                    <div data-testid="username-status" className="space-y-2">
                      <div className="text-[12px] text-destructive">{uname.message}</div>
                      {uname.suggestions?.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {uname.suggestions.map((s) => (
                            <button key={s} type="button" data-testid={`suggestion-${s}`}
                              onClick={() => { unameRef.current = s; setUsername(s); }}
                              className="text-xs font-medium border border-border rounded-full px-3 py-1.5 hover:bg-secondary transition-colors text-foreground">
                              @{s}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <label htmlFor="signup-email" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Email address</label>
                  <input data-testid="input-email" type="email" autoComplete="email" placeholder="you@example.com"
                    id="signup-email" value={email} onChange={(e) => setEmail(e.target.value)} className={`${inputCls} w-full`} />
                </div>
                <div className="space-y-2">
                  <label htmlFor="signup-dob" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">Date of birth</label>
                  <input data-testid="input-dob" type="date" max={dobMax}
                    id="signup-dob" value={dob} onChange={(e) => setDob(e.target.value)} className={`${inputCls} w-full`} />
                  <p className="text-[12px] text-muted-foreground leading-relaxed">Vivo Johari is for members 18 and over.</p>
                </div>
                
                <label className="flex items-start gap-3 cursor-pointer group mt-6">
                  <div className="relative flex items-center justify-center shrink-0 mt-1">
                    <input
                      data-testid="check-consent"
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                      className="peer appearance-none w-5 h-5 border border-border rounded bg-background checked:bg-primary checked:border-primary transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    />
                    <Check size={14} className="absolute text-primary-foreground opacity-0 peer-checked:opacity-100 pointer-events-none transition-opacity" />
                  </div>
                  <span className="text-[13px] leading-relaxed text-muted-foreground group-hover:text-foreground transition-colors">
                    I agree to the Vivo Johari{" "}
                    <button
                      type="button"
                      data-testid="link-terms-signup"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPage("terms"); }}
                      className="underline underline-offset-2 font-medium text-foreground hover:text-primary-ink transition-colors"
                    >
                      Terms & Conditions
                    </button>{" "}
                    and{" "}
                    <button
                      type="button"
                      data-testid="link-privacy-signup"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPage("privacy"); }}
                      className="underline underline-offset-2 font-medium text-foreground hover:text-primary-ink transition-colors"
                    >
                      Privacy Policy
                    </button>
                    , and to receive updates about my points, offers and activities. <span className="font-medium text-foreground">*Required</span>
                  </span>
                </label>
                <p className="text-[11px] text-muted-foreground/80 ml-8">
                  Terms v{LEGAL_META.terms.version} · Privacy v{LEGAL_META.privacy.version} · effective {LEGAL_META.terms.effective}
                </p>
              </div>

              <ErrorNote>{error}</ErrorNote>

              <button
                data-testid="btn-signup"
                onClick={submitSignup}
                disabled={!signupReady || busy}
                className={btnPrimary}
              >
                {busy ? <Loader2 className="animate-spin" size={18} /> : "Join Vivo Johari"}
              </button>
            </div>
          )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}