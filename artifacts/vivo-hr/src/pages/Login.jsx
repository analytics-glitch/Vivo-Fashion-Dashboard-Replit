import React, { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card } from "../components/ui/card";
import { VivoLogo } from "../components/AppLayout";
import { Eye, EyeOff, Loader2, LogIn } from "lucide-react";
import { toast } from "sonner";

const DEMO = [
  { role: "Executive", email: "exec@vivofashion.com", password: "Executive@2026" },
  { role: "HR Manager", email: "hr@vivofashion.com", password: "HRManager@2026" },
  { role: "Branch Manager", email: "branch@vivofashion.com", password: "Branch@2026" },
];

export default function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  React.useEffect(() => {
    if (user) navigate(location.state?.from?.pathname || "/", { replace: true });
  }, [user, navigate, location]);

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setLoading(true);
    try {
      await login(email, password);
      toast.success("Welcome back");
      navigate(location.state?.from?.pathname || "/", { replace: true });
    } catch (e) {
      const d = e?.response?.data?.detail;
      const msg = typeof d === "string" ? d : "Invalid email or password";
      setErr(msg);
      toast.error(msg);
    } finally { setLoading(false); }
  };

  const fillDemo = (d) => { setEmail(d.email); setPassword(d.password); };

  const handleGoogleLogin = () => {
    // Backend builds the OAuth flow and redirects back to <base>/auth/callback.
    // Pass an absolute return path (BASE_URL already ends with "/hr/") so the
    // callback lands on THIS app's /hr/auth/callback rather than the root SPA.
    const ret = import.meta.env.BASE_URL + "auth/callback";
    window.location.href = "/api/auth/google/login?return=" + encodeURIComponent(ret);
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="grid min-h-screen lg:grid-cols-2">
        {/* Left forest panel */}
        <div className="hidden lg:flex flex-col justify-between p-12 text-white relative overflow-hidden" style={{ background: "hsl(var(--brand-deep))" }}>
          <div className="absolute inset-0 opacity-[0.06]" style={{
            backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.4) 1px, transparent 0)",
            backgroundSize: "24px 24px",
          }} />
          <div className="relative">
            <VivoLogo light />
            <div className="mt-3 inline-flex pill-brand" style={{ background: "rgba(255,255,255,0.15)", color: "#fff" }}>
              HR Attendance · East Africa
            </div>
          </div>
          <div className="relative">
            <div className="font-serif text-5xl xl:text-6xl font-bold leading-[1.05] tracking-tight">
              Attendance,<br />
              <span style={{ color: "hsl(var(--accent-soft))" }}>decoded.</span>
            </div>
            <p className="mt-6 max-w-md text-[15px] text-white/80 leading-relaxed">
              Live attendance, branch performance, and people insights across 29 stores in Kenya, Uganda and Rwanda.
            </p>
            <div className="mt-10 flex items-center gap-10 text-sm">
              <div>
                <div className="font-serif font-bold text-white text-4xl tabular-nums">29</div>
                <div className="eyebrow mt-1" style={{ color: "rgba(255,255,255,0.6)" }}>branches</div>
              </div>
              <div>
                <div className="font-serif font-bold text-white text-4xl tabular-nums">3</div>
                <div className="eyebrow mt-1" style={{ color: "rgba(255,255,255,0.6)" }}>countries</div>
              </div>
              <div>
                <div className="font-serif font-bold text-white text-4xl tabular-nums">30m</div>
                <div className="eyebrow mt-1" style={{ color: "rgba(255,255,255,0.6)" }}>refresh</div>
              </div>
            </div>
          </div>
          <div className="relative text-[11px] uppercase tracking-wider text-white/50">© {new Date().getFullYear()} Vivo Fashion Group</div>
        </div>

        {/* Right form */}
        <div className="flex items-center justify-center p-6 sm:p-10 bg-background">
          <div className="w-full max-w-md">
            <div className="lg:hidden mb-8"><VivoLogo size={32} /></div>
            <div className="eyebrow">Welcome back</div>
            <h1 className="font-serif font-bold tracking-tight text-4xl text-brand-deep mt-1">Sign in</h1>
            <p className="mt-1.5 text-[13px] text-muted-foreground">Access your HR attendance dashboard</p>

            <form onSubmit={submit} className="mt-7 space-y-4" data-testid="login-form">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-[11px] font-bold uppercase tracking-wider text-brand-deep">Email</Label>
                <Input id="email" data-testid="login-email" type="email" autoComplete="email" required
                  className="h-11 rounded-xl border-border bg-white"
                  value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@vivofashion.com" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-[11px] font-bold uppercase tracking-wider text-brand-deep">Password</Label>
                <div className="relative">
                  <Input id="password" data-testid="login-password" type={showPwd ? "text" : "password"} autoComplete="current-password" required
                    className="h-11 rounded-xl border-border bg-white pr-10"
                    value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
                  <button type="button" onClick={() => setShowPwd(!showPwd)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    data-testid="toggle-password-visibility" aria-label="Toggle password visibility">
                    {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              {err && <div className="text-sm text-danger" data-testid="login-error">{err}</div>}
              <Button type="submit" disabled={loading} data-testid="login-submit"
                className="w-full h-11 rounded-full bg-brand hover:bg-brand-deep text-background text-[12px] font-bold uppercase tracking-wider">
                {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Signing in…</> : <><LogIn className="mr-2 h-4 w-4" />Sign in</>}
              </Button>
            </form>

            <div className="mt-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <Button type="button" onClick={handleGoogleLogin} variant="outline" data-testid="login-google-button"
              className="mt-5 w-full h-11 rounded-full border-border bg-white text-[12px] font-bold uppercase tracking-wider text-brand-deep hover:bg-panel">
              <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
              </svg>
              Continue with Google
            </Button>

            <Card className="mt-7 rounded-2xl border-border bg-panel/60 p-4 shadow-none">
              <div className="eyebrow mb-2">Demo accounts · click to fill</div>
              <div className="space-y-1">
                {DEMO.map((d) => (
                  <button key={d.role} type="button" onClick={() => fillDemo(d)}
                    data-testid={`demo-${d.role.toLowerCase().replace(/\s/g, "-")}`}
                    className="w-full rounded-full border border-transparent px-3 py-2 text-left text-[12px] hover:border-brand/30 hover:bg-white transition-colors">
                    <span className="font-bold text-brand-deep">{d.role}</span>
                    <span className="text-muted-foreground"> · {d.email}</span>
                  </button>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
