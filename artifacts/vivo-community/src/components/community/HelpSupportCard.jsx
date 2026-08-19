import React from "react";
import { ChevronRight, ClipboardList, HelpCircle, MapPin, MessageCircle, RefreshCcw, Sparkles, Truck } from "lucide-react";
import { cardCls } from "./ui";

const SUPPORT_LINKS = [
  {
    id: "stores",
    title: "Find a Store",
    desc: "Every Vivo store in Kenya, Uganda & Rwanda.",
    icon: MapPin,
  },
  {
    id: "delivery",
    title: "Delivery Information",
    desc: "Where we deliver, timelines and fees.",
    icon: Truck,
  },
  {
    id: "returns",
    title: "Returns & Exchanges",
    desc: "Changed your mind? Here's how it works.",
    icon: RefreshCcw,
  },
  {
    id: "faq",
    title: "FAQs",
    desc: "Points, tiers, sharing, shopping — answered.",
    icon: HelpCircle,
  },
  {
    id: "tryon",
    title: "Virtual Try-On",
    desc: "Your photos and looks — private by default.",
    icon: Sparkles,
  },
  {
    id: "styleprefs",
    title: "About your Vivo journey",
    desc: "Four quick questions on Style Preferences — 30 points.",
    icon: ClipboardList,
  },
  {
    id: "contact",
    title: "Contact Us",
    desc: "WhatsApp, message, call or visit — we're here.",
    icon: MessageCircle,
  },
];

export default function HelpSupportCard({ onOpenPage }) {
  return (
    <div className={`${cardCls} overflow-hidden`} data-testid="help-legal-card">
      {SUPPORT_LINKS.map(({ id, title, desc, icon: Icon }, index) => (
        <button
          key={id}
          type="button"
          data-testid={`help-link-${id}`}
          onClick={() => onOpenPage?.(id)}
          className={`w-full p-5 flex items-center gap-4 text-left hover:bg-secondary/50 transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${index > 0 ? "border-t border-border" : ""}`}
        >
          <span className="w-11 h-11 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink shrink-0">
            <Icon size={18} strokeWidth={1.5} />
          </span>
          <span className="flex-grow min-w-0">
            <span className="block font-medium text-foreground text-[15px]">{title}</span>
            <span className="block text-[13px] text-muted-foreground mt-0.5">{desc}</span>
          </span>
          <ChevronRight size={16} className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
        </button>
      ))}
      <div className="px-5 py-4 border-t border-border flex flex-wrap gap-x-5 gap-y-2">
        <button type="button" data-testid="help-link-terms" onClick={() => onOpenPage?.("terms")} className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Terms &amp; Conditions</button>
        <button type="button" data-testid="help-link-privacy" onClick={() => onOpenPage?.("privacy")} className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Privacy Policy</button>
        <button type="button" data-testid="help-link-guidelines" onClick={() => onOpenPage?.("guidelines")} className="text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Community Guidelines</button>
      </div>
    </div>
  );
}