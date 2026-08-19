import React from "react";
import { ArrowLeft } from "lucide-react";
import {
  LEGAL_META,
  TERMS_SECTIONS,
  PRIVACY_SECTIONS,
  GUIDELINES_SECTIONS,
} from "./legalData";

const DOCS = {
  terms: {
    title: "Terms & Conditions",
    eyebrow: "Membership",
    meta: LEGAL_META.terms,
    sections: TERMS_SECTIONS,
    intro: "The friendly agreement behind your membership — what points are, whose content is whose, and how we look after the programme.",
  },
  privacy: {
    title: "Privacy Policy",
    eyebrow: "Your data",
    meta: LEGAL_META.privacy,
    sections: PRIVACY_SECTIONS,
    intro: "What we collect, why we collect it, and the rights Kenya's Data Protection Act gives you over all of it.",
  },
  guidelines: {
    title: "Community Guidelines",
    eyebrow: "Our space",
    meta: null,
    sections: GUIDELINES_SECTIONS,
    intro: null,
  },
};

const CROSS_LINKS = [
  { id: "faq", label: "Help & FAQs" },
  { id: "terms", label: "Terms & Conditions" },
  { id: "privacy", label: "Privacy Policy" },
  { id: "guidelines", label: "Community Guidelines" },
];

function Block({ block }) {
  if (block.t === "ul") {
    return (
      <ul className="list-disc pl-5 space-y-2.5 text-[14px] text-muted-foreground leading-relaxed marker:text-primary-ink">
        {block.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    );
  }
  return <p className="text-[14px] text-muted-foreground leading-relaxed">{block.text}</p>;
}

export default function LegalPage({ doc, onBack, onOpenPage }) {
  const d = DOCS[doc] || DOCS.terms;
  return (
    <div
      data-testid={`legal-${doc}`}
      // Admin-visible draft marker (inspect element) — members never see a
      // "draft" banner, but the document status ships with the DOM.
      data-legal-status={d.meta?.status || "published"}
      data-legal-version={d.meta?.version || ""}
      className="animate-in fade-in duration-500 max-w-2xl mx-auto"
    >
      <button
        data-testid="legal-back"
        onClick={onBack}
        className="flex items-center gap-2 min-h-[44px] text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors mb-8 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft size={15} /> Back
      </button>

      <div className="mb-10">
        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-3">
          {d.eyebrow}
        </div>
        <h1 className="font-serif text-3xl sm:text-4xl text-foreground mb-3">{d.title}</h1>
        {d.meta && (
          <p data-testid="legal-version" className="text-[12px] text-muted-foreground">
            Version {d.meta.version} · Effective {d.meta.effective}
          </p>
        )}
        {d.intro && (
          <p className="text-[15px] text-muted-foreground leading-relaxed mt-4">{d.intro}</p>
        )}
      </div>

      <div className="space-y-10">
        {d.sections.map((s) => (
          <section key={s.id} data-testid={`legal-section-${s.id}`}>
            {s.heading && (
              <h2 className="font-serif text-xl text-foreground mb-3">{s.heading}</h2>
            )}
            <div className="space-y-3">
              {s.blocks.map((b, i) => (
                <Block key={i} block={b} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-14 pt-8 border-t border-border">
        <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-4">
          See also
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-3">
          {CROSS_LINKS.filter((l) => l.id !== doc).map((l) => (
            <button
              key={l.id}
              data-testid={`legal-crosslink-${l.id}`}
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
