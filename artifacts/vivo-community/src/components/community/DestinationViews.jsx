import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Copy, Mail, Users } from "lucide-react";
import { api } from "@/lib/api";
import { cardCls, btnPrimary, btnSecondary, inputCls } from "./ui";

function BackButton({ onBack }) {
  return (
    <button type="button" onClick={onBack} className="mb-8 inline-flex items-center gap-2 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors">
      <ArrowLeft size={15} /> Back
    </button>
  );
}

export function ReferAFriendView({ onBack }) {
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState("");
  const [data, setData] = useState(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.referral().then((result) => active && setData(result)).catch((err) => active && setError(err.message));
    return () => { active = false; };
  }, []);
  const link = useMemo(() => {
    if (!data?.code) return "";
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("ref", data.code);
    return url.toString();
  }, [data?.code]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("We couldn't copy the link. Select it and copy it manually.");
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!email || sending) return;
    setSending(true); setError(""); setNotice("");
    try {
      const result = await api.sendReferralInvite(email, link);
      setNotice(result.message || "Your invitation is on its way.");
      setEmail("");
    } catch (err) {
      setError(err.message || "We couldn't send that invitation. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-2 animate-in fade-in duration-500">
      <BackButton onBack={onBack} />
      <div className="text-center mb-12">
        <div className="w-14 h-14 bg-primary/10 rounded-full flex items-center justify-center text-primary-ink mx-auto mb-6">
          <Users size={24} strokeWidth={1.5} />
        </div>
        <h1 className="text-3xl font-serif text-foreground mb-4">Share the Journey</h1>
        <p className="text-[14px] text-muted-foreground leading-relaxed max-w-md mx-auto">
          Invite a friend to Vivo Johari. When they make their first purchase, you earn {data?.reward_points || 200} points as our asante.
        </p>
      </div>

      <div className="space-y-8">
        <div className={`${cardCls} p-6 sm:p-8`}>
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-4">Your Personal Link</h2>
          <div className="flex flex-col sm:flex-row gap-3">
            <input aria-label="Your referral link" readOnly value={link} placeholder="Preparing your personal link…" className={`${inputCls} flex-1 h-11 text-[13px]`} />
            <button type="button" data-testid="referral-copy-link" disabled={!link} onClick={handleCopy}
              className={`${btnPrimary} sm:w-auto px-8 shrink-0`}
            >
              {copied ? <><Check size={16} /> Copied</> : <><Copy size={16} /> Copy link</>}
            </button>
          </div>
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center" aria-hidden="true">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-background px-4 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Or send an invite</span>
          </div>
        </div>

        <div className={`${cardCls} p-6 sm:p-8`}>
          <form onSubmit={handleSend}>
            <label htmlFor="referral-email" className="block text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-4">Email Address</label>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                id="referral-email"
                type="email"
                required
                placeholder="friend@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`${inputCls} flex-1 h-11`}
              />
              <button 
                type="submit"
                disabled={sending || !email || !data}
                className={`${btnSecondary} sm:w-auto px-8 shrink-0`}
              >
                {sending ? "Sending…" : <><Mail size={16} /> Send invite</>}
              </button>
            </div>
            {notice && (
              <p className="text-[13px] text-primary-ink mt-4 text-center sm:text-left animate-in fade-in slide-in-from-bottom-1">
                {notice}
              </p>
            )}
            {error && <p role="alert" className="text-[13px] text-destructive mt-4">{error}</p>}
          </form>
        </div>
      </div>
    </div>
  );
}

export function WeeklyMissionsView({ onBack }) {
  const missions = [
    {
      id: 1,
      title: "Leave a review",
      desc: "Share your thoughts on recent purchases.",
      pts: 20,
      total: 1,
      done: 0,
    },
    {
      id: 2,
      title: "Post a look",
      desc: "Show us how you style it.",
      pts: 50,
      total: 3,
      done: 0,
    }
  ];

  return (
    <div className="max-w-3xl mx-auto py-2 animate-in fade-in duration-500">
      <BackButton onBack={onBack} />
      <div className="mb-8">
        <div className="text-[11px] font-bold uppercase tracking-widest text-primary-ink mb-2">This week</div>
        <h1 className="font-serif text-3xl text-foreground mb-3">Weekly Missions</h1>
        <p className="text-[14px] text-muted-foreground leading-relaxed max-w-xl">A focused set of ways to show up, share your point of view, and earn Johari points this week.</p>
      </div>

      <div data-testid="weekly-missions-landing" className="space-y-4">
        {missions.map(m => (
          <div key={m.id} className={`${cardCls} p-5 sm:p-6`}>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-4 mb-2">
                <h3 className="text-lg font-serif text-foreground">{m.title}</h3>
                <span className="inline-flex items-center justify-center bg-primary/10 text-primary-ink border border-primary/20 text-[10px] font-bold tracking-wider px-2 py-1 rounded-sm shrink-0">
                  {m.pts} pts
                </span>
              </div>
              <p className="text-[13px] text-muted-foreground">{m.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
