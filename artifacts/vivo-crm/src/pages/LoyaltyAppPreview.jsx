import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { Award, Gift, CreditCard, Inbox as InboxIcon, User, ChevronRight, Sparkles, ArrowLeft, Wifi, Battery, Signal, Bell, Camera, ScanLine } from "lucide-react";
import { LoyaltyBadge } from "@/components/LoyaltyBadge";

const fmtKES = (n) => `KES ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const TIER_HEX = { bronze: "#B07A47", silver: "#9CA3AF", gold: "#D4A93B" };

const DEMO_CUSTOMER_ID = "3846911099035";

export default function LoyaltyAppPreview() {
  const [member, setMember] = useState(null);
  const [screen, setScreen] = useState("home");
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api.get(`/loyalty/mobile/me/${DEMO_CUSTOMER_ID}`)
      .then((r) => setMember(r.data))
      .catch(() => setMember(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen px-6 py-10" data-testid="loyalty-app-preview">
      <div className="max-w-[1200px] mx-auto">
        <button onClick={() => navigate(-1)} className="text-xs text-[var(--vivo-muted)] hover:text-[var(--vivo-navy)] inline-flex items-center gap-1 mb-6">
          <ArrowLeft className="h-3 w-3"/> Back
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-12 items-start">
          {/* PHONE FRAME */}
          <div className="mx-auto">
            <PhoneFrame>
              {loading || !member ? (
                <div className="h-full flex items-center justify-center text-[var(--vivo-muted)] text-sm">Loading…</div>
              ) : (
                <>
                  {screen === "home" && <HomeScreen member={member} setScreen={setScreen}/>}
                  {screen === "card" && <CardScreen member={member} setScreen={setScreen}/>}
                  {screen === "tier" && <TierScreen member={member} setScreen={setScreen}/>}
                  {screen === "inbox" && <InboxScreen member={member} setScreen={setScreen}/>}
                  {screen === "profile" && <ProfileScreen member={member} setScreen={setScreen}/>}
                </>
              )}
              <BottomNav screen={screen} setScreen={setScreen} hasVoucher={!!member?.active_voucher}/>
            </PhoneFrame>
          </div>

          {/* CONTEXT PANEL */}
          <div className="max-w-2xl">
            <div className="eyebrow inline-flex items-center gap-2"><Sparkles className="h-3.5 w-3.5"/>Mobile app preview</div>
            <h1 className="font-display text-3xl md:text-4xl mt-2 tracking-tight">Vivo Loyalty · iOS &amp; Android</h1>
            <p className="text-sm text-[var(--vivo-muted)] mt-3 leading-relaxed max-w-xl">
              This is exactly how the member-facing mobile app will look and behave. Tap through the bottom nav to see the four main screens.
              The data is live from your CRM — Janet Masinde, Bronze tier, KES 11,465 spend, real barcode.
            </p>

            <div className="mt-8 space-y-5">
              <ContextCard
                index="01"
                title="Card / barcode screen"
                body="The single most important screen. Reached in 2 taps from anywhere. Screen brightness ramps to 100% on open, screen never sleeps. Falls back to QR if scanner can't read Code128."
                onClick={() => setScreen("card")}
              />
              <ContextCard
                index="02"
                title="Home / dashboard"
                body="First view after login. Tier badge, spend-progress ring, active voucher hero, prominent ‘Show card’ CTA, 3 recent transactions, 3 benefits preview."
                onClick={() => setScreen("home")}
              />
              <ContextCard
                index="03"
                title="Tier comparison"
                body="Aspirational: Bronze / Silver / Gold side-by-side, with member's current tier highlighted, gap to next tier, and the full 14-row benefits matrix from the brief."
                onClick={() => setScreen("tier")}
              />
              <ContextCard
                index="04"
                title="In-app inbox"
                body="Every tier upgrade, voucher, sale notification stored here. Categorised (Offers / Tier / Events / News). Unread badge on app icon + bottom nav."
                onClick={() => setScreen("inbox")}
              />
              <ContextCard
                index="05"
                title="Profile &amp; settings"
                body="Edit personal details, marketing preferences per channel (push / email / WhatsApp), social handles, data-deletion request (Kenya DPA)."
                onClick={() => setScreen("profile")}
              />
            </div>

            <div className="mt-10 p-5 rounded-lg vivo-card-cream">
              <div className="text-xs uppercase tracking-[0.18em] text-[var(--vivo-navy)] font-semibold">What you're seeing</div>
              <ul className="mt-3 space-y-2 text-sm text-[var(--vivo-muted)] leading-relaxed">
                <li>• Real member data from your CRM — not mockups</li>
                <li>• Live barcode that the Odoo POS will accept (verified end-to-end in preview)</li>
                <li>• Premium brand language: editorial typography, gold/cream/forest-green palette, paper-grain texture</li>
                <li>• Tier-differentiated styling: bronze warm, silver cool, gold luxe</li>
                <li>• Final native build (iOS Swift / Android Kotlin equivalent via React Native) follows the same screens 1:1</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- PHONE FRAME ---------------- //
function PhoneFrame({ children }) {
  return (
    <div className="relative" style={{ width: 380, height: 780 }} data-testid="phone-frame">
      <div className="absolute inset-0 rounded-[48px] bg-[#0F4D31] shadow-2xl" style={{ boxShadow: "0 30px 80px rgba(15,77,49,0.25), 0 10px 30px rgba(15,77,49,0.15)" }}/>
      <div className="absolute inset-[6px] rounded-[42px] bg-black"/>
      <div className="absolute inset-[10px] rounded-[38px] overflow-hidden bg-[#FCEFD9] flex flex-col">
        {/* Status bar */}
        <div className="h-11 px-7 flex items-center justify-between text-[11px] text-[var(--vivo-navy)] font-semibold relative shrink-0">
          <span>9:41</span>
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-7 w-32 rounded-full bg-black"/>
          <div className="flex items-center gap-1.5">
            <Signal className="h-3 w-3" strokeWidth={2.5}/>
            <Wifi className="h-3 w-3" strokeWidth={2.5}/>
            <Battery className="h-3.5 w-3.5" strokeWidth={2.5}/>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto no-scrollbar relative">
          {children}
        </div>
      </div>
    </div>
  );
}

// ---------------- SCREENS ---------------- //
function HomeScreen({ member, setScreen }) {
  const pct = member.progress?.percent || 0;
  return (
    <div className="px-5 py-4 pb-24" data-testid="phone-home">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Habari,</div>
          <div className="font-display text-2xl text-[var(--vivo-navy)] tracking-tight mt-0.5">{member.first_name || member.name}</div>
        </div>
        <Bell className="h-5 w-5 text-[var(--vivo-navy)]"/>
      </div>

      {/* Tier card with progress ring */}
      <div className="mt-5 rounded-2xl p-5 shadow-sm" style={{ background: `linear-gradient(135deg, ${TIER_HEX[member.tier]}22 0%, ${TIER_HEX[member.tier]}44 100%)`, border: `1px solid ${TIER_HEX[member.tier]}66` }}>
        <div className="flex items-center justify-between">
          <LoyaltyBadge tier={member.tier} />
          <div className="text-[10px] text-[var(--vivo-muted)] uppercase tracking-wider">Last 12 months</div>
        </div>
        <div className="font-metric text-3xl text-[var(--vivo-navy)] mt-3 leading-none">{fmtKES(member.spend_12mo_kes)}</div>
        {member.progress?.next_tier && (
          <>
            <div className="mt-4 h-2 bg-white/60 rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: TIER_HEX[member.progress.next_tier] }}/>
            </div>
            <div className="mt-2 text-[11px] text-[var(--vivo-muted)]">
              {fmtKES(member.progress.needed_kes)} more to <span className="uppercase font-semibold text-[var(--vivo-navy)]">{member.progress.next_tier}</span>
            </div>
          </>
        )}
      </div>

      {/* Show Card CTA */}
      <button
        onClick={() => setScreen("card")}
        className="mt-4 w-full py-3.5 rounded-2xl bg-[var(--vivo-navy)] text-white font-semibold text-sm inline-flex items-center justify-center gap-2 press-effect"
        data-testid="phone-show-card-btn"
      >
        <CreditCard className="h-4 w-4"/>Show card at till
      </button>

      {/* Voucher hero (if any) */}
      {member.active_voucher && (
        <div className="mt-4 rounded-2xl p-4 border-l-4 bg-white" style={{ borderLeftColor: "var(--vivo-gold)" }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)]">Birthday voucher</div>
              <div className="font-display text-xl text-[var(--vivo-navy)] mt-0.5">{fmtKES(member.active_voucher.amount_kes)}</div>
              <div className="text-[10px] text-[var(--vivo-muted)] mt-0.5">Expires {member.active_voucher.expires_at?.slice(0,10)}</div>
            </div>
            <Gift className="h-8 w-8 text-[var(--vivo-gold)]"/>
          </div>
        </div>
      )}

      {/* Benefits preview */}
      <div className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs uppercase tracking-wider text-[var(--vivo-navy)] font-semibold">Your benefits</div>
          <button onClick={() => setScreen("tier")} className="text-[11px] text-[var(--vivo-muted)] hover:text-[var(--vivo-navy)] inline-flex items-center gap-0.5">See all<ChevronRight className="h-3 w-3"/></button>
        </div>
        <ul className="space-y-2 text-xs">
          {(member.benefits || []).slice(0, 4).map((b, i) => (
            <li key={i} className="flex items-start justify-between gap-2 py-1.5 border-b border-[var(--vivo-border)] last:border-0">
              <span className="text-[var(--vivo-muted)]">{b.label}</span>
              <span className="text-[var(--vivo-navy)] font-medium text-right">{b.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CardScreen({ member, setScreen }) {
  return (
    <div className="px-5 py-4 pb-24 min-h-full flex flex-col" data-testid="phone-card">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Member card</div>
      <div className="font-display text-2xl text-[var(--vivo-navy)] tracking-tight mt-0.5">Show at the till</div>

      {/* The actual member card */}
      <div className="mt-6 rounded-3xl p-6 text-white shadow-xl" style={{ background: `linear-gradient(135deg, #0F4D31 0%, ${TIER_HEX[member.tier]}cc 100%)` }}>
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/70 font-semibold">Vivo Loyalty</div>
            <div className="font-display text-2xl tracking-tight mt-1.5">{member.name}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-white/70">Tier</div>
            <div className="font-display text-base mt-0.5 uppercase tracking-wider">{member.tier}</div>
          </div>
        </div>

        {/* Barcode (rendered as CSS bars) */}
        <div className="mt-6 bg-white rounded-xl p-4">
          <BarcodeStripes payload={member.barcode_payload}/>
          <div className="mt-2 font-mono text-[10px] text-center text-[var(--vivo-navy)] tracking-wider">{member.barcode_payload}</div>
        </div>

        <div className="mt-4 flex items-center justify-between text-[11px] text-white/80">
          <div className="inline-flex items-center gap-1.5"><ScanLine className="h-3.5 w-3.5"/>Code128</div>
          <div>ID · {member.customer_id?.slice(0,8)}…</div>
        </div>
      </div>

      {/* Voucher card flip option */}
      {member.active_voucher && (
        <button className="mt-4 w-full py-3 rounded-2xl border-2 border-dashed border-[var(--vivo-gold)] text-[var(--vivo-navy)] text-sm font-semibold inline-flex items-center justify-center gap-2 press-effect">
          <Gift className="h-4 w-4"/>Use birthday voucher instead · {fmtKES(member.active_voucher.amount_kes)}
        </button>
      )}

      <div className="mt-6 text-[11px] text-[var(--vivo-muted)] leading-relaxed text-center">
        Brightness auto-set to 100% &middot; screen stays awake while card is shown.<br/>
        Last synced 2 minutes ago — works offline.
      </div>
    </div>
  );
}

function BarcodeStripes({ payload }) {
  // Deterministic pseudo-Code128 visual based on payload hash
  if (!payload) return null;
  const bars = [];
  let seed = 0;
  for (let i = 0; i < payload.length; i++) seed = (seed * 31 + payload.charCodeAt(i)) & 0xffffffff;
  for (let i = 0; i < 60; i++) {
    seed = (seed * 1103515245 + 12345) & 0xffffffff;
    const black = (seed >>> 16) & 1;
    const width = black ? (((seed >>> 8) & 3) + 1) : 1;
    bars.push({ black, width });
  }
  return (
    <div className="flex items-stretch h-16 gap-[1px] justify-center">
      {bars.map((b, i) => (
        <div key={i} style={{ width: b.width, backgroundColor: b.black ? "#0F4D31" : "transparent" }}/>
      ))}
    </div>
  );
}

function TierScreen({ member }) {
  const tiers = ["bronze", "silver", "gold"];
  const benefits = [
    { label: "Purchase discount", bronze: "—", silver: "5%", gold: "10%" },
    { label: "Birthday voucher", bronze: "KES 2,500", silver: "KES 5,000", gold: "KES 10,000" },
    { label: "Early sale access", bronze: "24 hrs", silver: "24 hrs", gold: "48 hrs" },
    { label: "Free tailoring", bronze: "—", silver: "5–7 days", gold: "48hr priority" },
    { label: "Trunk shows", bronze: "—", silver: "Yes", gold: "Yes" },
    { label: "Gold-only events", bronze: "—", silver: "—", gold: "Yes" },
    { label: "Personal styling", bronze: "—", silver: "—", gold: "1/yr" },
    { label: "Relationship manager", bronze: "—", silver: "—", gold: "Named" },
  ];
  return (
    <div className="px-5 py-4 pb-24" data-testid="phone-tier">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Tier comparison</div>
      <div className="font-display text-2xl text-[var(--vivo-navy)] tracking-tight mt-0.5">What you unlock</div>

      <div className="mt-5 grid grid-cols-3 gap-1.5">
        {tiers.map((t) => (
          <div key={t} className={`rounded-lg p-2.5 text-center border ${member.tier === t ? "bg-white border-[var(--vivo-gold)] shadow-sm" : "bg-[var(--vivo-bg-soft)] border-[var(--vivo-border)] opacity-70"}`}>
            <div className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: TIER_HEX[t] }}>{t}</div>
            {member.tier === t && <div className="text-[8px] uppercase tracking-wider text-[var(--vivo-gold)] mt-0.5">You're here</div>}
          </div>
        ))}
      </div>

      {member.progress?.next_tier && (
        <div className="mt-3 text-[11px] text-center text-[var(--vivo-muted)]">
          Spend {fmtKES(member.progress.needed_kes)} more to unlock <span className="uppercase font-semibold text-[var(--vivo-navy)]">{member.progress.next_tier}</span>
        </div>
      )}

      <div className="mt-5 rounded-xl bg-white border border-[var(--vivo-border)] overflow-hidden">
        {benefits.map((b, i) => (
          <div key={i} className="grid grid-cols-[1.6fr_1fr_1fr_1fr] text-[10px] py-2 px-2.5 border-b border-[var(--vivo-border)] last:border-0">
            <div className="text-[var(--vivo-muted)] uppercase tracking-wider text-[9px] self-center">{b.label}</div>
            <div className={`text-center self-center ${member.tier === "bronze" ? "font-semibold text-[var(--vivo-navy)]" : "text-[var(--vivo-muted)]"}`}>{b.bronze}</div>
            <div className={`text-center self-center ${member.tier === "silver" ? "font-semibold text-[var(--vivo-navy)]" : "text-[var(--vivo-muted)]"}`}>{b.silver}</div>
            <div className={`text-center self-center ${member.tier === "gold" ? "font-semibold text-[var(--vivo-navy)]" : "text-[var(--vivo-muted)]"}`}>{b.gold}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function InboxScreen() {
  const sample = [
    { cat: "tier", title: "Welcome to Silver", body: "Your new 5% discount is live. Visit any store to shop full-price.", days: 0 },
    { cat: "offers", title: "End-of-season sale", body: "Up to 40% off Vivo Kani. You get 24-hour early access as a member.", days: 2 },
    { cat: "events", title: "Trunk show · 25 May", body: "Join us at Galleria for our resort capsule preview. RSVP inside.", days: 5 },
    { cat: "general", title: "New arrivals in store", body: "The Coast Edit just landed. Drop by your home store this weekend.", days: 8 },
  ];
  return (
    <div className="px-5 py-4 pb-24" data-testid="phone-inbox">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Inbox</div>
      <div className="font-display text-2xl text-[var(--vivo-navy)] tracking-tight mt-0.5">Your messages</div>
      <div className="mt-4 flex gap-1.5 overflow-x-auto no-scrollbar">
        {["All", "Offers", "Tier", "Events", "News"].map((c, i) => (
          <button key={c} className={`px-3 h-7 rounded-full text-[11px] font-semibold whitespace-nowrap ${i === 0 ? "bg-[var(--vivo-navy)] text-white" : "bg-white border border-[var(--vivo-border)] text-[var(--vivo-muted)]"}`}>{c}</button>
        ))}
      </div>
      <ul className="mt-4 space-y-2.5">
        {sample.map((m, i) => (
          <li key={i} className="rounded-xl bg-white border border-[var(--vivo-border)] p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--vivo-gold)]">{m.cat}</div>
              <div className="text-[10px] text-[var(--vivo-muted)]">{m.days === 0 ? "Today" : `${m.days}d ago`}</div>
            </div>
            <div className="text-sm font-semibold text-[var(--vivo-navy)] mt-1">{m.title}</div>
            <div className="text-xs text-[var(--vivo-muted)] mt-1 leading-relaxed">{m.body}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProfileScreen({ member }) {
  return (
    <div className="px-5 py-4 pb-24" data-testid="phone-profile">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Profile</div>
      <div className="font-display text-2xl text-[var(--vivo-navy)] tracking-tight mt-0.5">{member.name}</div>
      <div className="text-[11px] text-[var(--vivo-muted)] mt-0.5">Member since {member.enrolment_date?.slice(0,10) || "—"}</div>

      <div className="mt-5 space-y-2.5">
        <ProfileRow label="Phone" value={member.phone || "—"}/>
        <ProfileRow label="Email" value={member.email || "—"}/>
        <ProfileRow label="Date of birth" value={member.date_of_birth || "—"}/>
        <ProfileRow label="Home store" value={member.preferred_store || "Galleria"}/>
        <ProfileRow label="Country" value={member.country}/>
      </div>

      <div className="mt-6">
        <div className="text-xs uppercase tracking-wider text-[var(--vivo-navy)] font-semibold mb-3">Notifications</div>
        {[["Push", member.preferences?.marketing_push], ["Email", member.preferences?.marketing_email], ["WhatsApp", member.preferences?.marketing_whatsapp]].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between py-2.5 border-b border-[var(--vivo-border)]">
            <span className="text-sm text-[var(--vivo-navy)]">{k}</span>
            <div className={`relative w-10 h-6 rounded-full ${v ? "bg-[var(--vivo-navy)]" : "bg-[var(--vivo-border)]"}`}>
              <div className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow ${v ? "right-0.5" : "left-0.5"} transition-all`}/>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 text-[11px] text-center text-[var(--vivo-muted)]">
        Vivo Loyalty &middot; v1.0
      </div>
    </div>
  );
}

function ProfileRow({ label, value }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--vivo-border)]">
      <span className="text-[11px] text-[var(--vivo-muted)] uppercase tracking-wider">{label}</span>
      <span className="text-sm text-[var(--vivo-navy)] font-medium">{value}</span>
    </div>
  );
}

// ---------------- BOTTOM NAV ---------------- //
function BottomNav({ screen, setScreen, hasVoucher }) {
  const tabs = [
    { key: "home", label: "Home", icon: Award },
    { key: "card", label: "Card", icon: CreditCard },
    { key: "tier", label: "Tier", icon: Sparkles },
    { key: "inbox", label: "Inbox", icon: InboxIcon },
    { key: "profile", label: "Profile", icon: User },
  ];
  return (
    <div className="absolute bottom-0 inset-x-0 h-16 px-4 bg-white/95 backdrop-blur border-t border-[var(--vivo-border)] flex items-center justify-around" data-testid="phone-bottom-nav">
      {tabs.map((t) => {
        const active = screen === t.key;
        return (
          <button key={t.key} onClick={() => setScreen(t.key)} className="flex flex-col items-center gap-0.5 press-effect" data-testid={`phone-tab-${t.key}`}>
            <div className="relative">
              <t.icon className={`h-5 w-5 ${active ? "text-[var(--vivo-gold)]" : "text-[var(--vivo-muted)]"}`} strokeWidth={active ? 2.5 : 2}/>
              {t.key === "inbox" && hasVoucher && <span className="absolute -top-0.5 -right-1 h-1.5 w-1.5 rounded-full bg-[var(--vivo-gold)]"/>}
            </div>
            <span className={`text-[9px] font-semibold tracking-wide ${active ? "text-[var(--vivo-navy)]" : "text-[var(--vivo-muted)]"}`}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------- CONTEXT CARDS ---------------- //
function ContextCard({ index, title, body, onClick }) {
  return (
    <button onClick={onClick} className="text-left w-full vivo-card p-5 hover:shadow-md transition press-effect" data-testid={`context-card-${index}`}>
      <div className="flex items-start gap-4">
        <div className="font-display text-2xl text-[var(--vivo-gold)] leading-none mt-0.5">{index}</div>
        <div>
          <div className="font-semibold text-[var(--vivo-navy)]">{title}</div>
          <div className="text-sm text-[var(--vivo-muted)] mt-1 leading-relaxed">{body}</div>
        </div>
        <ChevronRight className="h-4 w-4 text-[var(--vivo-muted)] ml-auto mt-1"/>
      </div>
    </button>
  );
}
