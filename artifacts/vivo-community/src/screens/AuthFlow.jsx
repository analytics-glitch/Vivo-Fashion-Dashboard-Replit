import React, { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { inputCls, btnPrimary, btnSecondary, cardCls, VivoLogo, JohariWordmark } from "@/components/community/ui";
import HelpFaqView from "@/components/community/HelpFaqView";
import LegalPage from "@/components/community/LegalPage";
import { LEGAL_META } from "@/components/community/legalData";
import { Loader2, ArrowRight, Check, AlertCircle } from "lucide-react";

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
  const { signIn } = useAuth();
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

  const phoneDigits = () => cc + local.replace(/\D/g, "").replace(/^0+/, "");
  const localOk = /^\d{9,10}$/.test(local.replace(/\D/g, "").replace(/^0+/, "")) ||
    /^0\d{9}$/.test(local.replace(/\D/g, ""));

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

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col relative overflow-hidden">
      {/* Decorative large blurry element in background */}
      <div className="absolute top-0 right-0 w-full md:w-[600px] h-[600px] bg-secondary/50 rounded-full blur-[100px] -translate-y-1/2 translate-x-1/3 pointer-events-none" />
      
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 relative z-10">
        <div className="w-full max-w-[420px] animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
          
          <div className="mb-12">
            <h1 className="mb-0"><VivoLogo size="lg" /></h1>
            <p className="mt-5 text-foreground text-[19px]"><JohariWordmark /></p>
            <p data-testid="johari-tagline" className="font-serif italic text-muted-foreground text-[14px] mt-3">We shine together</p>
          </div>

          {step === "phone" && (
            <div className="space-y-8">
              <div>
                <h2 className="text-2xl font-serif mb-3">Welcome.</h2>
                <p className="text-muted-foreground text-[15px] leading-relaxed">
                  Sign in with your phone number for Vivo Johari — the live collection, style challenges and member rewards.
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
                      className={`${inputCls} flex-1 min-w-0`}
                    />
                  </div>
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

      <div className="relative z-10 px-6 pb-10">
        <div className="mx-auto max-w-[420px] flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-6">
          <button data-testid="auth-link-faq" onClick={() => setPage("faq")} className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Help & FAQs</button>
          <button data-testid="auth-link-terms" onClick={() => setPage("terms")} className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Terms & Conditions</button>
          <button data-testid="auth-link-privacy" onClick={() => setPage("privacy")} className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Privacy Policy</button>
          <button data-testid="auth-link-guidelines" onClick={() => setPage("guidelines")} className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Community Guidelines</button>
        </div>
      </div>
    </div>
  );
}