import React from "react";
import { ArrowLeft } from "lucide-react";
import HelpSupportCard from "./HelpSupportCard";

/* Help landing (/help) — for when someone taps the HELP nav item itself.
   Links only; every destination is an existing page, nothing duplicated. */

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

      <div className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground px-1 -mb-6">Help &amp; Support</div>
      <HelpSupportCard onOpenPage={onOpenPage} />
    </div>
  );
}
