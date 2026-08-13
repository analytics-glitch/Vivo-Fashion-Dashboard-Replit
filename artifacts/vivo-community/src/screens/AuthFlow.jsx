import React, { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

const COUNTRIES = [
  { code: "254", label: "🇰🇪 +254" },
  { code: "250", label: "🇷🇼 +250" },
  { code: "256", label: "🇺🇬 +256" },
];

function Spinner() {
  return (
    <span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin align-middle" />
  );
}

function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <div className="mt-3 text-sm font-medium text-[#b3261e] bg-[#fdecea] border border-[#f5c6c0] rounded-xl px-4 py-2.5">
      {children}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const codeRef = useRef(null);

  const phoneDigits = () => cc + local.replace(/\D/g, "").replace(/^0+/, "");
  const localOk = /^\d{9,10}$/.test(local.replace(/\D/g, "").replace(/^0+/, "")) ||
    /^0\d{9}$/.test(local.replace(/\D/g, ""));

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  useEffect(() => {
    if (step === "code" && codeRef.current) codeRef.current.focus();
  }, [step]);

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
        email,
        dob,
        consent,
      });
      signIn(d.token, d.member);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const signupReady = fullName.trim().length >= 2 && /\S+@\S+\.\S+/.test(email) && dob && consent;
  const inputCls = "w-full rounded-xl border border-[#e8dfd5] bg-white px-4 py-3 text-[15px] text-[#2c2a29] placeholder-[#b5aca2] outline-none focus:border-[#c25e30] focus:ring-2 focus:ring-[#c25e30]/20 transition";
  const ctaCls = "w-full py-3.5 rounded-xl font-bold text-[15px] flex items-center justify-center gap-2 transition-all bg-[#c25e30] text-white hover:bg-[#a84f26] disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_6px_18px_rgba(194,94,48,0.35)]";

  return (
    <div className="min-h-[100dvh] bg-[#fbf9f6] text-[#2c2a29] font-sans flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-5 py-10">
        <div className="w-full max-w-md animate-in fade-in duration-500">

          {/* Brand */}
          <div className="text-center mb-8">
            <div className="text-4xl font-black tracking-[0.35em] text-[#2c2a29]">VIVO</div>
            <div className="mt-2 inline-block px-3 py-1 rounded-full bg-[#f5ece4] text-[#c25e30] text-[11px] font-bold uppercase tracking-[0.25em]">
              Community
            </div>
          </div>

          {step === "phone" && (
            <div>
              {/* Welcome hero */}
              <div className="rounded-3xl bg-gradient-to-br from-[#c25e30] to-[#8a3818] text-white p-6 sm:p-7 mb-6 shadow-[0_12px_30px_rgba(138,56,24,0.25)]">
                <h1 className="text-2xl font-extrabold leading-snug mb-2">Karibu to the Vivo family ✨</h1>
                <p className="text-white/85 text-sm leading-relaxed mb-4">
                  Fashion that fits your life — and rewards it.
                </p>
                <div className="space-y-2 text-sm font-medium">
                  <div className="flex items-center gap-2.5"><span>⭐</span> Earn points on every purchase</div>
                  <div className="flex items-center gap-2.5"><span>👗</span> Style challenges &amp; community boards</div>
                  <div className="flex items-center gap-2.5"><span>🎁</span> Member-only rewards &amp; perks</div>
                </div>
              </div>

              <div className="bg-white rounded-2xl p-5 sm:p-6 shadow-[0_2px_10px_rgba(44,42,41,0.05)] border border-[#f0e9e1]">
                <label className="block text-sm font-bold mb-2">Sign in with your phone number</label>
                <div className="flex gap-2">
                  <select
                    data-testid="select-country"
                    value={cc}
                    onChange={(e) => setCc(e.target.value)}
                    className="rounded-xl border border-[#e8dfd5] bg-white px-2.5 py-3 text-[15px] font-semibold outline-none focus:border-[#c25e30]"
                  >
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>{c.label}</option>
                    ))}
                  </select>
                  <input
                    data-testid="input-phone"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel"
                    placeholder="712 345 678"
                    value={local}
                    onChange={(e) => setLocal(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && localOk && !busy && sendCode()}
                    className={inputCls + " flex-1"}
                  />
                </div>
                <p className="mt-2 text-xs text-[#7a746e]">We'll text you a one-time code — no passwords.</p>
                <ErrorNote>{error}</ErrorNote>
                <button
                  data-testid="btn-send-code"
                  onClick={sendCode}
                  disabled={!localOk || busy}
                  className={ctaCls + " mt-4"}
                >
                  {busy ? <Spinner /> : "Send my code"}
                </button>
              </div>
            </div>
          )}

          {step === "code" && (
            <div className="bg-white rounded-2xl p-5 sm:p-6 shadow-[0_2px_10px_rgba(44,42,41,0.05)] border border-[#f0e9e1]">
              <h2 className="text-xl font-extrabold mb-1">Enter your code</h2>
              <p className="text-sm text-[#7a746e] mb-4">
                We sent a 6-digit code to <span className="font-bold text-[#2c2a29]">{masked}</span>
              </p>
              {demo && (
                <div data-testid="demo-banner" className="mb-4 rounded-xl bg-[#fdf3e0] border border-[#eabf74] px-4 py-3 text-[13px] text-[#8a5a13] font-medium leading-relaxed">
                  <span className="font-bold">Demo mode</span> — SMS isn't connected yet, so no text was sent.
                  Use code <span className="font-black tracking-widest">123456</span> to continue.
                </div>
              )}
              <input
                ref={codeRef}
                data-testid="input-otp"
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
                className="w-full rounded-xl border border-[#e8dfd5] bg-white px-4 py-3.5 text-2xl font-black tracking-[0.6em] text-center text-[#2c2a29] outline-none focus:border-[#c25e30] focus:ring-2 focus:ring-[#c25e30]/20"
              />
              <ErrorNote>{error}</ErrorNote>
              <button
                data-testid="btn-verify"
                onClick={() => verify()}
                disabled={code.length !== 6 || busy}
                className={ctaCls + " mt-4"}
              >
                {busy ? <Spinner /> : "Verify"}
              </button>
              <div className="flex items-center justify-between mt-4 text-sm">
                <button onClick={() => { setStep("phone"); setError(""); }} className="font-semibold text-[#7a746e] hover:text-[#2c2a29]">
                  ← Change number
                </button>
                <button
                  data-testid="btn-resend"
                  onClick={sendCode}
                  disabled={resendIn > 0 || busy}
                  className="font-semibold text-[#c25e30] disabled:text-[#b5aca2]"
                >
                  {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
                </button>
              </div>
            </div>
          )}

          {step === "signup" && (
            <div className="bg-white rounded-2xl p-5 sm:p-6 shadow-[0_2px_10px_rgba(44,42,41,0.05)] border border-[#f0e9e1]">
              <h2 className="text-xl font-extrabold mb-1">Create your Vivo profile</h2>
              <p className="text-sm text-[#7a746e] mb-5">
                You're almost in — tell us a little about you.
              </p>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-bold mb-1.5">Full name</label>
                  <input data-testid="input-name" type="text" autoComplete="name" placeholder="e.g. Wanjiku Mwangi"
                    value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-bold mb-1.5">Email</label>
                  <input data-testid="input-email" type="email" autoComplete="email" placeholder="you@example.com"
                    value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-bold mb-1.5">Date of birth</label>
                  <input data-testid="input-dob" type="date" max={new Date().toISOString().slice(0, 10)}
                    value={dob} onChange={(e) => setDob(e.target.value)} className={inputCls} />
                  <p className="mt-1 text-xs text-[#7a746e]">So we can spoil you on your birthday 🎂</p>
                </div>
                <label className="flex items-start gap-3 cursor-pointer select-none rounded-xl border border-[#e8dfd5] bg-[#fbf9f6] p-3.5">
                  <input
                    data-testid="check-consent"
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    className="mt-0.5 w-5 h-5 accent-[#c25e30]"
                  />
                  <span className="text-[13px] leading-relaxed text-[#4a4643]">
                    I agree to Vivo's membership terms and to receive updates about my points,
                    offers and community activity. <span className="font-bold">Required.</span>
                  </span>
                </label>
              </div>
              <ErrorNote>{error}</ErrorNote>
              <button
                data-testid="btn-signup"
                onClick={submitSignup}
                disabled={!signupReady || busy}
                className={ctaCls + " mt-5"}
              >
                {busy ? <Spinner /> : "Join Vivo Community"}
              </button>
            </div>
          )}

          <p className="text-center text-xs text-[#b5aca2] mt-8">
            Vivo Fashion Group · Kenya · Rwanda · Uganda
          </p>
        </div>
      </div>
    </div>
  );
}
