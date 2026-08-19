import React, { useMemo, useState } from "react";
import { ArrowLeft, Search, ChevronDown } from "lucide-react";
import { FAQ_SECTIONS } from "./legalData";
import { cardCls, inputCls, btnPrimary } from "./ui";

function FaqItem({ item, forceOpen, open, onToggle }) {
  const isOpen = forceOpen || open;
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        data-testid={`faq-item-${item.id}`}
        aria-expanded={isOpen}
        onClick={onToggle}
        className="w-full flex items-start justify-between gap-4 text-left px-5 py-4 hover:bg-secondary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      >
        <span className="text-[14px] font-medium text-foreground leading-snug">{item.q}</span>
        <ChevronDown
          size={16}
          className={`shrink-0 mt-0.5 text-muted-foreground transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>
      {isOpen && (
        <p
          data-testid={`faq-answer-${item.id}`}
          className="px-5 pb-5 -mt-1 text-[13px] text-muted-foreground leading-relaxed"
        >
          {item.a}
        </p>
      )}
    </div>
  );
}

export default function HelpFaqView({ onBack, onOpenPage }) {
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState("");
  const query = q.trim().toLowerCase();

  const sections = useMemo(() => {
    if (!query) return FAQ_SECTIONS;
    return FAQ_SECTIONS.map((s) => ({
      ...s,
      items: s.items.filter((it) => `${it.q} ${it.a}`.toLowerCase().includes(query)),
    })).filter((s) => s.items.length > 0);
  }, [query]);

  return (
    <div data-testid="faq-view" className="animate-in fade-in duration-500 max-w-2xl mx-auto">
      <button
        data-testid="faq-back"
        onClick={onBack}
        className="flex items-center gap-2 min-h-[44px] text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors mb-8 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft size={15} /> Back
      </button>

      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-3">
          We're here for you
        </div>
        <h1 className="font-serif text-3xl sm:text-4xl text-foreground mb-3">Help & FAQs</h1>
        <p className="text-[15px] text-muted-foreground leading-relaxed">
          Everything about points, tiers, sharing and shopping — in plain language. Can't find it? Ask in any Vivo store or message us.
        </p>
      </div>

      <div className="relative mb-10">
        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          data-testid="faq-search"
          type="search"
          placeholder="Search the FAQs — try 'points' or 'returns'"
          aria-label="Search the FAQs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className={`${inputCls} w-full pl-11`}
        />
      </div>

      {sections.length === 0 ? (
        <div data-testid="faq-empty" className={`${cardCls} border-dashed bg-transparent p-10 text-center`}>
          <p className="text-[14px] text-muted-foreground leading-relaxed">
            Nothing matched "{q.trim()}" — try another word, or ask us directly in any Vivo store.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {sections.map((s) => (
            <div key={s.id} data-testid={`faq-section-${s.id}`}>
              <h2 className="font-serif text-lg text-foreground mb-3">{s.title}</h2>
              <div className={`${cardCls} overflow-hidden`}>
                {s.items.map((it) => (
                  <FaqItem
                    key={it.id}
                    item={it}
                    forceOpen={!!query}
                    open={openId === it.id}
                    onToggle={() => setOpenId((cur) => (cur === it.id ? "" : it.id))}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Still stuck? Route her to a human. */}
      <div data-testid="faq-contact-cta-card" className={`${cardCls} mt-10 p-6 sm:p-7 flex flex-col sm:flex-row sm:items-center gap-4`}>
        <div className="flex-grow">
          <h2 className="font-serif text-xl text-foreground mb-1">Still need help?</h2>
          <p className="text-[13px] text-muted-foreground leading-relaxed">
            WhatsApp, message, call or visit — real people, within 1 working day.
          </p>
        </div>
        <button data-testid="faq-contact-cta" onClick={() => onOpenPage("contact")} className={`${btnPrimary} sm:w-auto shrink-0`}>
          Talk to us
        </button>
      </div>

      <div className="mt-14 pt-8 border-t border-border">
        <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-4">
          The formal bits
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          {[
            { id: "terms", label: "Terms & Conditions" },
            { id: "privacy", label: "Privacy Policy" },
            { id: "guidelines", label: "Community Guidelines" },
          ].map((l) => (
            <button
              key={l.id}
              data-testid={`faq-link-${l.id}`}
              onClick={() => onOpenPage(l.id)}
              className="text-[13px] font-medium text-foreground underline underline-offset-4 decoration-border hover:decoration-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
