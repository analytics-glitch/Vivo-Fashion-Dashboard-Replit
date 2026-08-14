import React from "react";
import { ArrowLeft, ChevronRight, HelpCircle, MessageCircle, FileText, ShieldCheck, HeartHandshake } from "lucide-react";
import { cardCls } from "./ui";

/* Help landing (/help) — for when someone taps the HELP nav item itself.
   Links only; every destination is an existing page, nothing duplicated. */

const LINKS = [
  {
    id: "faq",
    title: "FAQs",
    desc: "How points, tiers, challenges and sharing work.",
    icon: HelpCircle,
  },
  {
    id: "contact",
    title: "Contact Us",
    desc: "WhatsApp, call, email or message us — we answer quickly.",
    icon: MessageCircle,
  },
  {
    id: "terms",
    title: "Terms & Conditions",
    desc: "The membership agreement, in plain language.",
    icon: FileText,
  },
  {
    id: "privacy",
    title: "Privacy Policy",
    desc: "What we hold, what others see, and your rights.",
    icon: ShieldCheck,
  },
  {
    id: "guidelines",
    title: "Community Guidelines",
    desc: "How we keep this space warm, genuine and kind.",
    icon: HeartHandshake,
  },
];

export default function HelpLandingView({ onBack, onOpenPage }) {
  return (
    <div className="animate-in fade-in duration-300 max-w-2xl mx-auto" data-testid="help-landing">
      <button
        type="button"
        onClick={onBack}
        data-testid="help-back"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors mb-6 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft size={15} /> Back
      </button>

      <header className="mb-8">
        <h1 className="font-serif text-3xl text-foreground mb-2">Need a hand? We&apos;re here.</h1>
        <p className="text-[14px] text-muted-foreground leading-relaxed">
          Everything about your membership, answered — and real people one tap away when it isn&apos;t.
        </p>
      </header>

      <div className={`${cardCls} overflow-hidden`}>
        {LINKS.map((l, i) => {
          const Icon = l.icon;
          return (
            <button
              key={l.id}
              type="button"
              data-testid={`help-link-${l.id}`}
              onClick={() => onOpenPage(l.id)}
              className={`w-full p-5 flex items-center gap-4 text-left hover:bg-secondary/50 transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${i > 0 ? "border-t border-border" : ""}`}
            >
              <span className="w-11 h-11 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink shrink-0">
                <Icon size={18} strokeWidth={1.5} />
              </span>
              <span className="flex-grow min-w-0">
                <span className="block font-medium text-foreground text-[15px]">{l.title}</span>
                <span className="block text-[13px] text-muted-foreground mt-0.5">{l.desc}</span>
              </span>
              <ChevronRight size={16} className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
