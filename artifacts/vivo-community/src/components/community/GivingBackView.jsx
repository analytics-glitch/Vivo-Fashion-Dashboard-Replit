import React from "react";
import { ArrowLeft, ExternalLink, Phone, Mail, MapPin, HeartHandshake } from "lucide-react";
import { cardCls } from "./ui";

/* "Give Your Vivo a Second Life" — an information page, deliberately NOT a
   logistics service. Vivo recommends and informs; members act directly with
   Clean Start Africa. Community values, not commerce: no points anywhere on
   this page, ever — generosity isn't gamified. */

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

      {/* Editorial opening — the heart of the brand. */}
      <header className="text-center mb-10">
        <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 border border-primary/20 text-primary-ink mb-5">
          <HeartHandshake size={22} strokeWidth={1.5} />
        </span>
        <h1 className="font-serif text-3xl sm:text-4xl text-foreground leading-tight mb-4">
          Give your Vivo a second life
        </h1>
        <p className="text-[15px] text-muted-foreground leading-relaxed max-w-xl mx-auto">
          The dress that made you feel wonderful can help another woman begin again.
          When a piece has given you its best years, it still has more to give.
        </p>
      </header>

      {/* Clean Start Africa */}
      <section className={`${cardCls} p-6 sm:p-8 mb-6`}>
        <h2 className="font-serif text-xl text-foreground mb-3">Meet Clean Start Africa</h2>
        <p className="text-[14px] text-foreground/85 leading-relaxed mb-3">
          Clean Start Africa is an award-winning Kenyan social enterprise supporting women, girls
          and youth affected by the criminal justice system — restoring dignity and hope on the
          road back. Their work runs from in-prison rehabilitation and skills training to re-entry
          support after release, and they have economically empowered more than 4,000 women.
        </p>
        <p className="text-[14px] text-foreground/85 leading-relaxed mb-5">
          Gently-used clothing in good condition can be included in their dignity-pack programme —
          a welcome-back in fabric form, for women rebuilding their lives.
        </p>
        <a
          href="https://cleanstartafrica.org"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="cleanstart-link"
          className="inline-flex items-center gap-1.5 text-[14px] font-medium text-primary-ink hover:opacity-80 underline underline-offset-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          cleanstartafrica.org <ExternalLink size={13} />
        </a>
      </section>

      {/* How to help — informational only; members act directly. */}
      <section className={`${cardCls} p-6 sm:p-8 mb-6`}>
        <h2 className="font-serif text-xl text-foreground mb-4">How to help, directly</h2>
        <p className="text-[13px] text-muted-foreground leading-relaxed mb-5">
          Vivo simply connects you — donations go straight to Clean Start Africa, from your hands
          to theirs.
        </p>

        <div className="space-y-5">
          <div>
            <h3 className="text-[13px] font-semibold text-foreground mb-1.5">What to donate</h3>
            <p className="text-[14px] text-foreground/85 leading-relaxed">
              Clean, good-condition pieces — clothing you&apos;d be proud to pass on. The guiding
              question: <em className="font-serif">would you hand it to a friend?</em>
            </p>
          </div>

          <div>
            <h3 className="text-[13px] font-semibold text-foreground mb-2">Reach the team</h3>
            <ul className="space-y-2.5 text-[14px] text-foreground/85">
              <li className="flex items-center gap-3">
                <Mail size={15} className="text-primary-ink shrink-0" strokeWidth={1.5} />
                <a href="mailto:support@cleanstartafrica.org" className="hover:underline underline-offset-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">support@cleanstartafrica.org</a>
              </li>
              <li className="flex items-center gap-3">
                <Phone size={15} className="text-primary-ink shrink-0" strokeWidth={1.5} />
                <span>Nairobi <a href="tel:+254769062913" className="hover:underline underline-offset-2">0769 062 913</a> · Kisumu <a href="tel:+254769066872" className="hover:underline underline-offset-2">0769 066 872</a></span>
              </li>
              <li className="flex items-center gap-3">
                <MapPin size={15} className="text-primary-ink shrink-0" strokeWidth={1.5} />
                <span>14 Highview Lane, Ridgeways, Nairobi</span>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-[13px] font-semibold text-foreground mb-1.5">Prefer to give financially?</h3>
            <p className="text-[14px] text-foreground/85 leading-relaxed">
              You can support their work at{" "}
              <a href="https://cleanstartafrica.org/donate" target="_blank" rel="noopener noreferrer" className="text-primary-ink font-medium hover:opacity-80 underline underline-offset-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">cleanstartafrica.org/donate</a>{" "}
              or via M-Pesa Paybill <span className="font-medium text-foreground">543268</span>.
            </p>
          </div>
        </div>
      </section>

      {/* Welcome, never expected. */}
      <p className="text-[13px] text-muted-foreground leading-relaxed text-center max-w-xl mx-auto mb-8">
        If giving a piece its second life becomes a moment you&apos;d like to share, you&apos;re
        always welcome in the community — never expected.
      </p>

      <p className="text-[11px] text-muted-foreground/80 leading-relaxed text-center max-w-xl mx-auto border-t border-border pt-6 pb-4">
        Vivo shares this information to connect members with a cause we admire. Donations go
        directly to Clean Start Africa; please confirm current needs and drop-off details with the
        organisation before donating.
      </p>
    </div>
  );
}
