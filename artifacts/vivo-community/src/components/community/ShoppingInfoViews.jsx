import React from "react";
import { Truck, RefreshCcw, MessageCircle } from "lucide-react";
import { cardCls } from "./ui";
import { CONTACT, waLink } from "@/lib/contactInfo";

/* Delivery Information + Returns & Exchanges — the two remaining
   Help & Support pages.
   ⚠ PLACEHOLDER POLICY COPY — timelines, fees and the returns window below
   are sensible defaults for Vivo to confirm/adjust before launch. */

function InfoPage({ onBack, icon: Icon, title, intro, sections }) {
  return (
    <div className="max-w-2xl mx-auto animate-in fade-in duration-300 pb-24">
      <button onClick={onBack} className="text-[13px] text-muted-foreground hover:text-foreground mb-5 inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        ← Back
      </button>
      <div className="flex items-center gap-3 mb-2">
        <span className="w-11 h-11 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink shrink-0">
          <Icon size={18} strokeWidth={1.5} />
        </span>
        <h1 className="font-serif text-3xl text-foreground">{title}</h1>
      </div>
      <p className="text-[13px] text-muted-foreground leading-relaxed mb-8 max-w-lg">{intro}</p>
      <div className="space-y-4">
        {sections.map((s) => (
          <div key={s.h} className={`${cardCls} p-5 sm:p-6`}>
            <div className="font-semibold text-[15px] text-foreground mb-2">{s.h}</div>
            <div className="text-[13px] text-muted-foreground leading-relaxed space-y-2">
              {s.body.map((p, i) => <p key={i}>{p}</p>)}
            </div>
          </div>
        ))}
        <div className={`${cardCls} p-5 sm:p-6 flex items-start gap-4`}>
          <span className="w-11 h-11 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink shrink-0">
            <MessageCircle size={18} strokeWidth={1.5} />
          </span>
          <div>
            <div className="font-semibold text-[15px] text-foreground">Still unsure?</div>
            <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
              Our customer-care team is happy to help — {CONTACT.hours}.
            </p>
            <div className="flex gap-4 mt-2">
              <a href={waLink()} target="_blank" rel="noreferrer" className="text-[13px] font-medium text-primary-ink hover:underline underline-offset-2">WhatsApp us</a>
              <a href={CONTACT.phoneHref} className="text-[13px] font-medium text-primary-ink hover:underline underline-offset-2">{CONTACT.phoneDisplay}</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DeliveryInfoView({ onBack }) {
  return (
    <InfoPage
      onBack={onBack}
      icon={Truck}
      title="Delivery Information"
      intro="Everything you order in the app is delivered to your door — here's how it works."
      sections={[
        {
          h: "Where we deliver",
          body: [
            "We deliver across Kenya, Uganda and Rwanda. Delivery options and timelines are confirmed at checkout based on your address.",
          ],
        },
        {
          h: "How long it takes",
          body: [
            "Nairobi and other major cities are typically delivered within 1–3 working days. Upcountry and cross-border deliveries can take a little longer — your confirmation will show the expected window.",
          ],
        },
        {
          h: "Tracking your order",
          body: [
            "Once your order is on its way you'll receive updates from our delivery partner. If anything looks off, reach out to customer care with your order number and we'll chase it for you.",
          ],
        },
        {
          h: "Delivery fees",
          body: [
            "Fees depend on your location and are always shown clearly before you pay — no surprises at the door.",
          ],
        },
      ]}
    />
  );
}

export function ReturnsInfoView({ onBack }) {
  return (
    <InfoPage
      onBack={onBack}
      icon={RefreshCcw}
      title="Returns & Exchanges"
      intro="Changed your mind, or need a different size? We'll make it right."
      sections={[
        {
          h: "Our returns window",
          body: [
            "You can return or exchange unworn items with their tags attached within 14 days of delivery.",
            "Items should be in their original condition — unworn, unwashed, with all tags and packaging.",
          ],
        },
        {
          h: "How to start a return",
          body: [
            "Message customer care on WhatsApp with your order number and the item you'd like to return or exchange, and we'll guide you through the next steps.",
            "You can also take the item, with its receipt or order confirmation, to any Vivo store.",
          ],
        },
        {
          h: "Exchanges",
          body: [
            "Need a different size or colour? Exchanges are free — we'll arrange the swap as soon as the original item is back with us, subject to availability.",
          ],
        },
        {
          h: "Refunds",
          body: [
            "Refunds are issued to your original payment method once your return has been received and checked, typically within 5–7 working days.",
          ],
        },
      ]}
    />
  );
}
