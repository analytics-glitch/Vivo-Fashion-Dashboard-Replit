import React, { useEffect, useState } from 'react';
import { TierBadge, cardCls, btnPrimary, JohariWordmark } from "./ui";
import { api } from "@/lib/api";
import TankRedeemFlow, { DesignThumb } from "./TankRedeemFlow";
import { Star, Gift, ShoppingBag, Receipt, Ticket, Sparkles, Wand2, Video, Ruler, Users, CalendarCheck, Scissors, Truck, Shirt, ClipboardList, Check, Camera } from "lucide-react";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(String(iso).includes("T") ? iso : iso + "T00:00:00").toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch {
    return iso;
  }
}

export default function TabRewards({ member, onMemberUpdate, onOpenPage }) {
  const m = member || {};
  const points = m.points ?? 0;
  // Tier progress runs on lifetime earn — redeeming a reward never walks
  // the bar (or the tier) backwards. `points` is the spendable balance.
  const lifetimePoints = m.lifetime_points ?? points;
  const maxTierPoints = 1000;
  const progressPercent = Math.min((lifetimePoints / maxTierPoints) * 100, 100);
  const firstName = String(m.full_name || m.name || "").trim().split(/\s+/)[0] || "";
  // Display-only framing: the KES 500-per-300-pts voucher already on the
  // redemption ladder, expressed as what her balance could reach today.
  const voucherValue = Math.floor(points / 300) * 500;

  const [tank, setTank] = useState(null);
  const [redemptions, setRedemptions] = useState([]);
  const [flow, setFlow] = useState(null); // null | {mode:'new'} | {mode:'adjust', redemption}
  // Try-on perk ladder — read live from the server (TRYON_WEEK_LIMITS) so
  // the business can change the split without an app rebuild.
  const [tryonPerk, setTryonPerk] = useState(null);
  // Survey wave state — drives the "Complete our survey" mission card
  // (server decides the wave, the points and whether it's already done).
  const [survey, setSurvey] = useState(null);
  // Live journal of shared content — pending rows show their would-be points.
  const [myEntries, setMyEntries] = useState([]);
  // Zetu Studios photoshoot — one-tap redemption with its own confirm sheet.
  const [zetuOpen, setZetuOpen] = useState(false);
  const [zetuBusy, setZetuBusy] = useState(false);
  const [zetuErr, setZetuErr] = useState("");
  const [zetuDone, setZetuDone] = useState(null);

  const loadRedemptions = () =>
    api.myRedemptions().then((r) => setRedemptions(r.redemptions || [])).catch(() => {});

  useEffect(() => {
    api.rewardsTank().then(setTank).catch(() => {});
    api.tryonAllowance().then(setTryonPerk).catch(() => {});
    api.surveyState().then(setSurvey).catch(() => {});
    api.myEntries().then((d) => setMyEntries(d.items || [])).catch(() => {});
    loadRedemptions();
  }, []);

  const closeZetu = () => { setZetuOpen(false); setZetuErr(""); setZetuDone(null); };
  const bookZetu = () => {
    setZetuBusy(true); setZetuErr("");
    api.zetuRedeem()
      .then((r) => { setZetuDone(r); handleRedeemed(); })
      .catch((e) => setZetuErr(e.message || "Something went wrong — please try again."))
      .finally(() => setZetuBusy(false));
  };

  const handleRedeemed = () => {
    loadRedemptions();
    if (onMemberUpdate) api.me().then(onMemberUpdate).catch(() => {});
  };

  // Shared content earns its points on publication, never on submission —
  // pending rows read as warm, clearly-pending lines; published rows post.
  // Questions never carry points, so they never enter the points ledger.
  const entryRows = [];
  for (const e of myEntries) {
    if ((e.winner_position || 0) >= 1 && e.challenge_title) {
      entryRows.push({
        id: `win-${e.post_id}`,
        action: `Challenge winner — ${e.challenge_title}`,
        date: fmtDate(e.published_at || e.created_at),
        pts: "+200",
        status: "Posted",
      });
    }
    if (!e.points) continue;
    const action = e.challenge_title
      ? `Entered ${e.challenge_title}`
      : e.media_kind === "video" ? "Shared a video look" : "Shared a look";
    if (e.entry_status === "pending") {
      entryRows.push({ id: `entry-${e.post_id}`, action, date: fmtDate(e.created_at), pts: `+${e.points}`, status: "Pending" });
    } else if (e.entry_status === "published") {
      entryRows.push({ id: `entry-${e.post_id}`, action, date: fmtDate(e.published_at || e.created_at), pts: `+${e.points}`, status: "Posted" });
    }
  }

  const STATUS_LABELS = {
    in_review: "In review",
    needs_changes: "Needs a tweak",
    stitching: "Being stitched",
    ready: "Ready",
    collected: "Collected",
    cancelled: "Cancelled",
    booking: "Booking in progress",
    scheduled: "Scheduled",
    done: "Done",
  };

  const transactions = [
    ...redemptions.map((r) => ({
      id: `rdm-${r.id}`,
      action: r.reward_key === "zetu_shoot"
        ? "Booked Zetu Studios Photoshoot"
        : "Redeemed Personalised Embroidered Tank",
      date: fmtDate(r.created),
      pts: `-${(r.points_cost || 0).toLocaleString()}`,
      status: STATUS_LABELS[r.status] || "In review",
    })),
    ...entryRows,
    ...(m.recent_orders || []).map((o, i) => ({
      id: `order-${i}`,
      action: `Purchase ${o.order}`,
      date: fmtDate(o.date),
      pts: `+${o.pts}`,
      status: "Posted",
    })),
    {
      id: "welcome",
      action: "Joined Vivo Johari",
      date: m.joined || "",
      pts: "+200",
      status: "Posted",
    },
  ];

  const earnWays = [
    { title: "Purchases", pts: "1 pt per 100 KES", icon: <ShoppingBag size={20} strokeWidth={1.5} /> },
    { title: "Text Review", pts: "10 pts when published", icon: <Receipt size={20} strokeWidth={1.5} /> },
    { title: "Photo Review", pts: "25 pts when published", icon: <Star size={20} strokeWidth={1.5} /> },
    { title: "Video Review", pts: "40 pts when published", icon: <Video size={20} strokeWidth={1.5} /> },
    { title: "Community Look — Photo", pts: "50 pts when published", icon: <Camera size={20} strokeWidth={1.5} /> },
    { title: "Community Look — Video", pts: "100 pts when published", icon: <Gift size={20} strokeWidth={1.5} /> },
    { title: "Fit Notes", pts: "15 pts when published", icon: <Ruler size={20} strokeWidth={1.5} /> },
    { title: "Join Challenge", pts: "Up to 150 pts when published", icon: <Ticket size={20} strokeWidth={1.5} /> },
    { title: "Refer a Friend", pts: "200 pts", icon: <Users size={20} strokeWidth={1.5} /> },
    { title: "Weekly Missions", pts: "Up to 100 pts", icon: <CalendarCheck size={20} strokeWidth={1.5} /> },
  ];

  return (
    <div className="animate-in fade-in duration-500 max-w-4xl mx-auto space-y-12">

      {/* Aspirational hero — her name, her tier, her points and what they
          reach. Charcoal editorial band, never a banking dashboard. The
          "redeemable value" line reads off the same ladder shown below
          (KES 500 voucher per 300 pts) — display only, no mechanics change. */}
      <div data-testid="rewards-balance-card" className="relative overflow-hidden rounded bg-foreground text-background p-6 sm:p-9 -mx-4 sm:mx-0">
        <div className="absolute top-0 right-0 w-52 h-52 bg-white/5 rounded-full blur-3xl pointer-events-none" aria-hidden="true" />
        <div className="flex items-center justify-between gap-4 mb-5">
          <div data-testid="johari-wordmark" className="text-[12px] text-background/70"><JohariWordmark withVivo /></div>
          <TierBadge tier={m.tier} />
        </div>
        <h2 className="font-serif text-2xl sm:text-3xl leading-tight mb-1 text-background">
          {firstName ? `You shine, ${firstName}.` : "You shine."}
        </h2>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mt-4">
          <div data-testid="rewards-points" className="font-serif font-light text-4xl sm:text-5xl tracking-tight">
            {points.toLocaleString()} <span className="text-xl italic opacity-60">pts</span>
          </div>
          <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-background/60">Available Balance</span>
        </div>
        <p data-testid="rewards-value" className="text-[13px] text-background/75 mt-2">
          {voucherValue > 0
            ? <>Worth up to <span className="font-medium text-background">KES {voucherValue.toLocaleString()}</span> in vouchers — or keep climbing the ladder below.</>
            : <>{(300 - points).toLocaleString()} pts to your first KES 500 voucher.</>}
        </p>
        <div className="mt-6">
          <div className="flex justify-between text-[10px] font-semibold uppercase tracking-wider text-background/60 mb-2">
            <span>Tier Progress</span>
            <span className="text-background/90">{lifetimePoints >= maxTierPoints ? 'Max Tier Reached' : `${(maxTierPoints - lifetimePoints).toLocaleString()} pts to next tier`}</span>
          </div>
          <div className="h-1 bg-white/15 rounded-full overflow-hidden relative">
            <div className="absolute top-0 left-0 h-full bg-primary rounded-full transition-all duration-1000 ease-out" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="flex justify-between mt-2 text-[10px] uppercase font-bold tracking-wider text-background/50">
            <span>Tsavorite</span>
            <span className={lifetimePoints >= 500 ? 'text-background/90' : ''}>Ruby (500+)</span>
            <span className={lifetimePoints >= 1000 ? 'text-background/90' : ''}>Tanzanite (1,000+)</span>
          </div>
        </div>
      </div>

      {/* How it works — three quiet steps */}
      <div data-testid="rewards-how-it-works" className="grid grid-cols-3 gap-3 sm:gap-4">
        {[
          { icon: <ShoppingBag size={18} strokeWidth={1.5} />, title: "Shop & share", sub: "1 pt per 100 KES, more when you post" },
          { icon: <Star size={18} strokeWidth={1.5} />, title: "Earn points", sub: "Points land when purchases post & entries publish" },
          { icon: <Gift size={18} strokeWidth={1.5} />, title: "Redeem", sub: "Vouchers to studio shoots — your pick" },
        ].map((s) => (
          <div key={s.title} className="text-center px-1 sm:px-3 py-4 border-t border-border">
            <div className="flex justify-center text-primary-ink mb-2">{s.icon}</div>
            <div className="font-serif text-[14px] sm:text-[15px] text-foreground mb-1">{s.title}</div>
            <div className="text-[11px] text-muted-foreground leading-snug">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Johari perk — Virtual Try-On. The ladder renders from the server
          config, so a business change to the split shows up here live. */}
      {tryonPerk?.ladder && (
        <div data-testid="rewards-tryon-perk" className={`${cardCls} p-6 sm:p-8`}>
          <div className="flex items-center justify-between gap-3 mb-2">
            <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Johari Perk — Virtual Try-On</h3>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary-ink text-primary-foreground text-[9px] font-bold uppercase tracking-widest rounded-sm shrink-0">
              <Sparkles size={10} /> New
            </span>
          </div>
          <p className="text-[13px] text-muted-foreground leading-relaxed mb-5">
            See Vivo pieces on you, virtually — your weekly try-ons grow with your tier.
          </p>
          <div className="space-y-3">
            {tryonPerk.ladder.map((l) => {
              const top = l.limit == null;
              const mine = tryonPerk.tier === l.tier;
              return (
                <div
                  key={l.tier}
                  data-testid={`rewards-tryon-tier-${l.tier}`}
                  className={`flex items-center justify-between gap-4 rounded border px-4 py-3 ${top ? "border-primary/50 bg-primary/5" : "border-border"} ${mine ? "ring-1 ring-primary/40" : ""}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <TierBadge tier={l.tier} className="shrink-0" />
                    {mine && <span className="text-[9px] font-bold uppercase tracking-widest text-primary-ink whitespace-nowrap">Your tier</span>}
                  </div>
                  <div className={top ? "font-serif italic text-lg text-primary-ink whitespace-nowrap" : "text-[13px] font-medium text-foreground whitespace-nowrap"}>
                    {l.limit == null ? "Unlimited try-ons" : l.limit === 0 ? "Not included" : `${l.limit} a week`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Survey mission — wave-scoped, points land instantly (the server
          enforces once-per-wave; the card flips to its done state after). */}
      {survey?.wave && (
        <div data-testid="rewards-survey-card" className={`${cardCls} p-6 border-l-2 border-l-primary`}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <span className="w-11 h-11 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary-ink shrink-0">
              <ClipboardList size={18} strokeWidth={1.5} />
            </span>
            <div className="flex-grow min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-foreground text-[15px]">Complete our survey — {survey.points ?? 30} pts</h3>
                {survey.completed && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary-ink bg-primary/10 border border-primary/20 px-2 py-0.5 rounded-sm">
                    <Check size={11} strokeWidth={3} /> Done this round
                  </span>
                )}
              </div>
              <p className="text-[13px] text-muted-foreground mt-1">
                {survey.completed
                  ? "Asante — your answers are already shaping what we make next."
                  : `${survey.wave.title}: ten taps, under three minutes, points land instantly.`}
              </p>
            </div>
            {!survey.completed && (
              <button
                type="button"
                data-testid="rewards-survey-cta"
                onClick={() => onOpenPage?.("survey")}
                className={`${btnPrimary} sm:w-auto sm:px-8 shrink-0`}
              >
                Start
              </button>
            )}
          </div>
        </div>
      )}

      {/* Active Missions */}
      <div>
        <h2 className="text-xl font-serif text-foreground mb-6">Active Weekly Missions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={`${cardCls} p-6 border-border`}>
            <div className="flex justify-between items-start mb-5">
              <div>
                <h3 className="font-semibold text-foreground text-[15px]">Leave a review</h3>
                <p className="text-[13px] text-muted-foreground mt-1">Share your thoughts on recent purchases.</p>
              </div>
              <span className="bg-primary/10 text-primary-ink border border-primary/20 text-[10px] font-semibold leading-snug px-2.5 py-1.5 rounded-sm shrink-0 max-w-[110px] text-center">20 pts when published</span>
            </div>
            <div className="flex justify-between text-[11px] font-bold uppercase tracking-wider mb-2 text-muted-foreground">
              <span>Progress</span>
              <span>0/1 done</span>
            </div>
            <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-primary w-0" />
            </div>
          </div>

          <div className={`${cardCls} p-6 border-border`}>
            <div className="flex justify-between items-start mb-5">
              <div>
                <h3 className="font-semibold text-foreground text-[15px]">Post a look</h3>
                <p className="text-[13px] text-muted-foreground mt-1">Show us how you style it.</p>
              </div>
              <span className="bg-primary/10 text-primary-ink border border-primary/20 text-[10px] font-semibold leading-snug px-2.5 py-1.5 rounded-sm shrink-0 max-w-[110px] text-center">50 pts when published</span>
            </div>
            <div className="flex justify-between text-[11px] font-bold uppercase tracking-wider mb-2 text-muted-foreground">
              <span>Progress</span>
              <span>0/3 done</span>
            </div>
            <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
              <div className="h-full bg-primary w-0" />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
        {/* History */}
        <div>
          <h2 className="text-xl font-serif text-foreground mb-6">Points History</h2>
          <div className={`${cardCls} overflow-hidden divide-y divide-border`}>
            {transactions.map((t, i) => (
              <div key={t.id} className="p-4 flex items-center justify-between hover:bg-secondary/30 transition-colors">
                <div>
                  <div className="font-medium text-foreground text-[14px]">{t.action}</div>
                  <div className="text-[12px] text-muted-foreground mt-1">{t.date}</div>
                </div>
                <div className="text-right">
                  <div className={`font-medium ${t.pts.startsWith('+') ? 'text-primary-ink' : 'text-destructive'}`}>{t.pts}</div>
                  <div className={`text-[10px] uppercase font-bold tracking-widest mt-1 max-w-[150px] ml-auto ${t.status.includes('Pending') ? 'text-muted-foreground' : 'text-primary-ink'}`}>
                    {t.status === "Pending" ? "Pending — awarded when published" : t.status}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p data-testid="pending-note" className="text-[12px] text-muted-foreground leading-relaxed mt-3">
            Pending points land the moment your entry is published. If one doesn't go live, we'll let you know — you can tweak and reshare anytime.
          </p>
        </div>

        {/* How to Earn */}
        <div>
          <h2 className="text-xl font-serif text-foreground mb-6">How to Earn</h2>
          <div className="grid grid-cols-2 gap-3">
            {earnWays.map(w => (
              <div key={w.title} className="bg-secondary/50 rounded p-4 border border-border text-center flex flex-col items-center justify-center group hover:bg-secondary transition-colors">
                <div className="text-muted-foreground group-hover:text-primary-ink transition-colors mb-3">{w.icon}</div>
                <div className="font-medium text-foreground text-[13px] mb-1">{w.title}</div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{w.pts}</div>
              </div>
            ))}
          </div>
          <p className="text-[12px] text-muted-foreground leading-relaxed mt-4">
            Reviews, photos, videos, fit notes, style posts and challenge entries are reviewed with love before they go live — each earns its points when it's published.
          </p>
        </div>
      </div>

      {/* Our gems — the story behind the tier names */}
      <div data-testid="our-gems" className={`${cardCls} p-6 sm:p-8`}>
        <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">Our Gems</h3>
        <p className="text-[13px] text-muted-foreground leading-relaxed mb-6">
          Every tier is a gemstone from East African soil — your journey moves through the treasures of our own region.
        </p>
        <div className="space-y-5">
          <div className="flex items-start gap-4">
            <TierBadge tier="Tsavorite" className="mt-0.5 shrink-0" />
            <p className="text-[13px] text-foreground/80 leading-relaxed">The vivid green garnet discovered in Kenya's Tsavo — where everyone begins.</p>
          </div>
          <div className="flex items-start gap-4">
            <TierBadge tier="Ruby" className="mt-0.5 shrink-0" />
            <p className="text-[13px] text-foreground/80 leading-relaxed">Warm, deep red from East Africa's ruby heartlands.</p>
          </div>
          <div className="flex items-start gap-4">
            <TierBadge tier="Tanzanite" className="mt-0.5 shrink-0" />
            <p className="text-[13px] text-foreground/80 leading-relaxed">Found only at the foot of Kilimanjaro — rarer than diamond.</p>
          </div>
        </div>
      </div>

      {/* Personalised-tank redemptions — live status from the studio */}
      {redemptions.length > 0 && (
        <div className="pt-4">
          <h2 className="text-xl font-serif text-foreground mb-6">Your Redemptions</h2>
          <div className="space-y-4">
            {redemptions.map((r) => (
              <div key={r.id} data-testid={`redemption-${r.id}`} className={`${cardCls} p-5 flex flex-col sm:flex-row sm:items-center gap-4`}>
                {r.reward_key === "zetu_shoot" ? (
                  <div className="w-16 h-16 rounded-sm border border-border bg-secondary flex items-center justify-center shrink-0 text-primary-ink">
                    <Camera size={22} strokeWidth={1.5} />
                  </div>
                ) : r.embroidery_type === "upload" && r.has_design ? (
                  <DesignThumb id={r.id} className="w-16 h-16 rounded-sm border border-border bg-secondary object-contain shrink-0" />
                ) : (
                  <div className="w-16 h-16 rounded-sm border border-border bg-secondary flex items-center justify-center shrink-0">
                    <span className={`text-foreground/80 text-[12px] text-center leading-tight px-1 break-words ${
                      r.monogram_style === "block" ? "font-sans font-bold uppercase tracking-widest" :
                      r.monogram_style === "script" ? "italic" : "font-serif italic"
                    }`}>{r.monogram_text || "—"}</span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium text-foreground text-[14px]">{r.reward_key === "zetu_shoot" ? "Zetu Studios Photoshoot" : "Personalised Embroidered Tank"}</h3>
                    <span data-testid={`redemption-status-${r.id}`} className={`px-2 py-0.5 rounded-sm text-[10px] font-semibold uppercase tracking-wider border ${
                      r.status === "needs_changes" ? "border-primary/40 text-primary-ink bg-primary/5" :
                      r.status === "ready" ? "border-foreground text-background bg-foreground" :
                      "border-border text-muted-foreground bg-secondary"
                    }`}>{STATUS_LABELS[r.status] || r.status}</span>
                  </div>
                  <p className="text-[12px] text-muted-foreground mt-1">
                    {r.reward_key === "zetu_shoot"
                      ? fmtDate(r.created)
                      : <>{r.colour} · Size {r.size} · {r.collection_method === "pickup" ? `Pick up at ${r.pickup_store}` : "Delivery"} · {fmtDate(r.created)}</>}
                  </p>
                  {r.reward_key === "zetu_shoot" && r.status === "booking" && (
                    <p className="text-[12px] text-muted-foreground mt-2">We'll be in touch within 2 working days to arrange your session at Zetu Studios.</p>
                  )}
                  {r.reward_key === "zetu_shoot" && r.status_note && (
                    <p data-testid={`redemption-note-${r.id}`} className="text-[12px] text-foreground mt-2 leading-relaxed">{r.status_note}</p>
                  )}
                  {r.status === "needs_changes" && (
                    <p className="text-[12px] text-foreground mt-2 leading-relaxed">
                      {r.status_note || "This design is tricky to stitch as-is."}{" "}
                      <span className="text-muted-foreground">Tweak it and resend — your points are safe.</span>
                    </p>
                  )}
                  {r.status === "in_review" && (
                    <p className="text-[12px] text-muted-foreground mt-2">We'll review your design and get stitching — we'll let you know when your tank is ready.</p>
                  )}
                </div>
                {r.status === "needs_changes" && (
                  <button
                    data-testid={`redemption-adjust-${r.id}`}
                    onClick={() => setFlow({ mode: "adjust", redemption: r })}
                    className="shrink-0 px-4 py-2 bg-primary text-primary-foreground text-[13px] font-medium rounded hover:opacity-90 transition-opacity"
                  >
                    Adjust design
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Redemption Options */}
      <div className="pt-4">
        <h2 className="text-xl font-serif text-foreground mb-1">Redeem Rewards</h2>
        <p className="text-[13px] text-muted-foreground mb-6">From everyday value to insider access — the ladder climbs as you earn.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {[
            { title: "KES 500 off voucher", pts: 300, icon: <Ticket size={24} strokeWidth={1.5} />, note: "A fixed KES 500 off your next order." },
            { title: "Free delivery on your next order", pts: 500, icon: <Truck size={24} strokeWidth={1.5} /> },
            { title: "Alteration on one style", pts: 800, icon: <Scissors size={24} strokeWidth={1.5} />, note: "Basic alterations only — hems, waists and simple adjustments. At participating stores. T&Cs apply." },
            { title: "Personal styling session", pts: 1200, icon: <Wand2 size={24} strokeWidth={1.5} /> },
            { title: "Personalised Embroidered Tank", pts: 1600, img: tank?.colourways?.[0]?.image, icon: <Shirt size={24} strokeWidth={1.5} />, note: "Vivo's ribbed tank finished with your own embroidered design, stitched in-house.", redeem: () => setFlow({ mode: "new" }) },
            { title: "Members' event invitation", pts: 2000, icon: <Sparkles size={24} strokeWidth={1.5} />, note: "Styling evenings and first looks at new collections, in store." },
            { title: "Zetu Studios Photoshoot", pts: 3000, icon: <Camera size={24} strokeWidth={1.5} />, note: "The top of the Johari ladder — a professional solo shoot at Zetu Studios, styled in Vivo, your favourite images yours to keep.", redeem: () => setZetuOpen(true), testId: "redeem-zetu" }
          ].map(r => (
            <div key={r.title} className={`${cardCls} overflow-hidden flex flex-col items-center text-center group hover:border-primary/50 transition-colors ${r.redeem ? "" : "cursor-pointer"}`}>
              {r.img && (
                <img src={r.img} alt={r.title} className="w-full h-44 object-cover object-top" />
              )}
              <div className="p-6 flex flex-col items-center flex-1 w-full">
                {!r.img && (
                  <div className="mb-4 text-muted-foreground group-hover:text-primary-ink transition-colors">{r.icon}</div>
                )}
                <h3 className="font-medium text-foreground text-[14px] mb-2">{r.title}</h3>
                <div className="text-primary-ink font-serif italic text-lg mb-6">{r.pts.toLocaleString()} pts</div>
                {r.note && (
                  <p className="text-[11px] text-muted-foreground leading-relaxed -mt-4 mb-6">{r.note}</p>
                )}
                <button
                  data-testid={r.testId || (r.redeem ? "redeem-tank" : undefined)}
                  onClick={r.redeem}
                  className="mt-auto w-full py-2 bg-secondary text-foreground font-medium rounded text-[13px] group-hover:bg-primary group-hover:text-primary-foreground transition-colors border border-border group-hover:border-primary"
                >
                  Redeem
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {zetuOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label="Book Zetu Studios photoshoot" data-testid="zetu-modal">
          <div className="absolute inset-0 bg-black/50" onClick={() => !zetuBusy && closeZetu()} aria-hidden="true" />
          <div className="relative w-full sm:max-w-md bg-background rounded-t-lg sm:rounded-lg border border-border p-6 sm:p-7 animate-in slide-in-from-bottom-4 sm:zoom-in-95 duration-200">
            {zetuDone ? (
              <>
                <span className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 text-primary-ink flex items-center justify-center mb-4">
                  <Check size={22} strokeWidth={2.5} />
                </span>
                <h3 className="font-serif text-xl text-foreground mb-2">Booking in progress</h3>
                <p data-testid="zetu-success" className="text-sm text-muted-foreground leading-relaxed mb-6">{zetuDone.message}</p>
                <button data-testid="zetu-done" onClick={closeZetu} className={btnPrimary}>Asante</button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-3">
                  <span className="w-11 h-11 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink shrink-0">
                    <Camera size={18} strokeWidth={1.5} />
                  </span>
                  <h3 className="font-serif text-xl text-foreground">Zetu Studios Photoshoot</h3>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed mb-2">
                  A professional solo session at Zetu Studios — styled in Vivo, shot by the pros, your favourite images yours to keep.
                </p>
                <p className="text-sm text-foreground font-medium mb-5">3,000 points · we'll call within 2 working days to schedule your session.</p>
                {zetuErr && <p data-testid="zetu-error" className="text-sm text-destructive mb-4">{zetuErr}</p>}
                <div className="flex gap-3">
                  <button data-testid="zetu-cancel" onClick={closeZetu} disabled={zetuBusy}
                          className="flex-1 h-11 rounded border border-border bg-background text-foreground text-[14px] font-medium hover:bg-secondary transition-colors disabled:opacity-40">
                    Not yet
                  </button>
                  <button data-testid="zetu-confirm" onClick={bookZetu} disabled={zetuBusy}
                          className="flex-1 h-11 rounded bg-primary text-primary-foreground text-[14px] font-medium hover:opacity-90 transition-all disabled:opacity-40">
                    {zetuBusy ? "Booking…" : "Book my shoot"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {flow && (
        <TankRedeemFlow
          member={m}
          tank={tank}
          mode={flow.mode}
          redemption={flow.redemption}
          onClose={() => setFlow(null)}
          onRedeemed={handleRedeemed}
        />
      )}

    </div>
  );
}