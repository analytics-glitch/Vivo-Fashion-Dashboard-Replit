import React from "react";
import { ArrowLeft, Clock3, HeartHandshake, Mail, MapPin, Phone } from "lucide-react";
import { cardCls } from "./ui";

// [X Home] is a placeholder — replace with confirmed charity partner name once legal has signed off.
const STEPS = [
  "Pack up the Vivo pieces you've outgrown.",
  "Drop them off at any Vivo store, or directly at [X Home] — address and hours below.",
  "Your pre-loved pieces help another woman feel confident as she takes her next step.",
];

const PARTNER_DETAILS = [
  { key: "address", label: "Address", Icon: MapPin },
  { key: "hours", label: "Drop-off hours", Icon: Clock3 },
  { key: "contact", label: "Contact info", Icon: Phone },
];

export default function GivingBackView({ onBack }) {
  return (
    <div className="animate-in fade-in duration-300 max-w-3xl mx-auto" data-testid="givingback-page">
      <button
        type="button"
        onClick={onBack}
        data-testid="givingback-back"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors mb-6 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft size={15} /> Back
      </button>

      <header className="text-center mb-8 sm:mb-10">
        <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 border border-primary/20 text-primary-ink mb-5">
          <HeartHandshake size={22} strokeWidth={1.5} />
        </span>
        <h1 className="font-serif text-3xl sm:text-4xl text-foreground leading-tight">
          How it works
        </h1>
      </header>

      <section className={`${cardCls} p-6 sm:p-8 mb-6`} aria-labelledby="givingback-steps-title">
        <h2 id="givingback-steps-title" className="font-serif text-xl text-foreground mb-6">
          Give your Vivo a second life
        </h2>
        <ol className="space-y-5">
          {STEPS.map((step, index) => (
            <li key={step} className="flex items-start gap-4" data-testid={`givingback-step-${index + 1}`}>
              <span className="flex items-center justify-center shrink-0 w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
                {index + 1}
              </span>
              <p className="text-[14px] text-foreground/85 leading-relaxed pt-1">
                {step}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section className={`${cardCls} p-6 sm:p-8 mb-8`} aria-labelledby="xhome-details-title">
        <h2 id="xhome-details-title" className="font-serif text-xl text-foreground mb-5">
          [X Home]
        </h2>
        <dl className="divide-y divide-border">
          {PARTNER_DETAILS.map(({ key, label, Icon }) => (
            <div key={key} className="flex items-start gap-3 py-4 first:pt-0 last:pb-0" data-testid={`xhome-${key}`}>
              <Icon size={17} className="text-primary-ink shrink-0 mt-0.5" strokeWidth={1.5} aria-hidden="true" />
              <div className="flex-1">
                <dt className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
                <dd className="min-h-6 mt-1" />
              </div>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}