import React, { useRef, useState } from "react";
import {
  ArrowLeft, MessageCircle, Phone, Mail, MapPin, Camera, X,
  CheckCircle2, ExternalLink, UserRound, Send,
} from "lucide-react";
import { api } from "@/lib/api";
import { CONTACT, STORES, waLink } from "@/lib/contactInfo";
import { cardCls, inputCls, btnPrimary, btnSecondary } from "./ui";

// Subject ids are the API contract; labels are what she sees.
const SUBJECTS = [
  ["order", "My order"],
  ["sizing", "Sizing & fit help"],
  ["points", "My points or tier"],
  ["account", "My account"],
  ["events", "Events"],
  ["other", "Something else"],
];

const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

function IconCircle({ children, className = "" }) {
  return (
    <span className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${className}`}>
      {children}
    </span>
  );
}

export default function ContactView({ onBack, member }) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [photo, setPhoto] = useState(null); // { file, preview }
  const [photoErr, setPhotoErr] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  const canSend = subject && message.trim().length >= 5 && !sending;

  const pickPhoto = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setPhotoErr("");
    if (!["image/jpeg", "image/png"].includes(f.type)) {
      setPhotoErr("JPG or PNG photos only.");
      return;
    }
    if (f.size > MAX_PHOTO_BYTES) {
      setPhotoErr("That photo is over 3MB — a smaller one works best.");
      return;
    }
    setPhoto({ file: f, preview: URL.createObjectURL(f) });
  };

  const clearPhoto = () => {
    if (photo?.preview) URL.revokeObjectURL(photo.preview);
    setPhoto(null);
    setPhotoErr("");
  };

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    setError("");
    try {
      let photo_b64;
      if (photo?.file) {
        photo_b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] || "");
          r.onerror = () => reject(new Error("That photo didn't read cleanly — please try again"));
          r.readAsDataURL(photo.file);
        });
      }
      await api.contactSubmit({ subject, message: message.trim(), ...(photo_b64 ? { photo_b64 } : {}) });
      setSent(true);
    } catch (e) {
      setError(e.message || "Something went wrong — please try again");
    } finally {
      setSending(false);
    }
  };

  const resetForm = () => {
    setSent(false);
    setSubject("");
    setMessage("");
    clearPhoto();
    setError("");
  };

  return (
    <div data-testid="contact-view" className="animate-in fade-in duration-500 max-w-2xl mx-auto">
      <button
        data-testid="contact-back"
        onClick={onBack}
        className="flex items-center gap-2 min-h-[44px] text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors mb-8 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft size={15} /> Back
      </button>

      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground mb-3">
          We're here for you
        </div>
        <h1 className="font-serif text-3xl sm:text-4xl text-foreground mb-3">We'd love to hear from you.</h1>
        <p className="text-[15px] text-muted-foreground leading-relaxed">
          A question about an order, your points, sizing — or just a hello. Real people answer, {CONTACT.hours.toLowerCase()}.
        </p>
      </div>

      <div className="space-y-5">
        {/* WhatsApp — the way most of our members already talk to us */}
        <div className={`${cardCls} p-6 sm:p-7`} data-testid="contact-whatsapp-card">
          <div className="flex items-center gap-4 mb-4">
            {/* WhatsApp green lives on the icon only — everything else stays on-brand */}
            <IconCircle className="bg-[#25D366]/10 border border-[#25D366]/25 text-[#25D366]">
              <MessageCircle size={19} strokeWidth={1.8} />
            </IconCircle>
            <div className="min-w-0">
              <h2 className="font-serif text-xl text-foreground leading-snug">Chat with us on WhatsApp</h2>
              <p className="text-[13px] text-muted-foreground mt-0.5">The fastest way to reach us · {CONTACT.hours}</p>
            </div>
          </div>
          <a
            data-testid="contact-whatsapp"
            href={waLink()}
            target="_blank"
            rel="noopener noreferrer"
            className={btnPrimary}
          >
            <MessageCircle size={17} strokeWidth={2} /> Chat with us on WhatsApp
          </a>
        </div>

        {/* In-app message form */}
        <div className={`${cardCls} p-6 sm:p-7`} data-testid="contact-form-card">
          {sent ? (
            <div data-testid="contact-success" className="text-center py-6">
              <span className="w-14 h-14 rounded-full bg-secondary border border-border flex items-center justify-center text-primary-ink mx-auto mb-5">
                <CheckCircle2 size={26} strokeWidth={1.5} />
              </span>
              <h2 className="font-serif text-2xl text-foreground mb-2">Thank you — we've got it.</h2>
              <p className="text-[14px] text-muted-foreground leading-relaxed max-w-sm mx-auto mb-6">
                Our team will get back to you within 1 working day. For anything urgent, WhatsApp is quickest.
              </p>
              <button data-testid="contact-send-another" onClick={resetForm} className={`${btnSecondary} sm:w-auto sm:mx-auto`}>
                Send another message
              </button>
            </div>
          ) : (
            <>
              <h2 className="font-serif text-xl text-foreground mb-1">Send us a message</h2>
              <p className="text-[13px] text-muted-foreground leading-relaxed mb-5">
                We reply within 1 working day.
              </p>

              {member && (
                <div
                  data-testid="contact-identity"
                  className="flex items-center gap-3 rounded bg-secondary/60 border border-border px-4 py-3 mb-5"
                >
                  <UserRound size={16} strokeWidth={1.8} className="text-primary-ink shrink-0" />
                  <p className="text-[12px] text-muted-foreground leading-relaxed">
                    Sending as <span className="font-semibold text-foreground">@{member.username}</span> — your
                    account details travel with your message, so we can help you faster.
                  </p>
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label htmlFor="contact-subject" className="block text-[12px] font-semibold text-foreground mb-1.5">
                    What's it about?
                  </label>
                  <select
                    id="contact-subject"
                    data-testid="contact-subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className={`${inputCls} w-full appearance-none ${subject ? "" : "text-muted-foreground"}`}
                  >
                    <option value="" disabled>Choose a subject…</option>
                    {SUBJECTS.map(([id, label]) => (
                      <option key={id} value={id}>{label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="contact-message" className="block text-[12px] font-semibold text-foreground mb-1.5">
                    Your message
                  </label>
                  <textarea
                    id="contact-message"
                    data-testid="contact-message"
                    rows={5}
                    maxLength={4000}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Tell us what's going on — the more detail, the faster we can help."
                    className="w-full rounded bg-background border border-border px-4 py-3 text-[15px] text-foreground placeholder-muted-foreground outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary leading-relaxed resize-y min-h-[120px]"
                  />
                </div>

                <div>
                  <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={pickPhoto} />
                  {photo ? (
                    <div data-testid="contact-photo-preview" className="flex items-center gap-3 rounded border border-border bg-secondary/40 p-3">
                      <img src={photo.preview} alt="Attached" className="w-14 h-14 rounded object-cover border border-border" />
                      <div className="flex-grow min-w-0">
                        <p className="text-[13px] font-medium text-foreground truncate">{photo.file.name}</p>
                        <p className="text-[11px] text-muted-foreground">Attached — great for sizing or order issues.</p>
                      </div>
                      <button
                        data-testid="contact-photo-remove"
                        onClick={clearPhoto}
                        aria-label="Remove photo"
                        className="w-9 h-9 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ) : (
                    <button
                      data-testid="contact-photo-add"
                      onClick={() => fileRef.current?.click()}
                      className="flex items-center gap-2 text-[13px] font-medium text-primary-ink hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <Camera size={15} strokeWidth={1.8} /> Add a photo <span className="font-normal text-muted-foreground">(optional · JPG or PNG, up to 3MB)</span>
                    </button>
                  )}
                  {photoErr && <p data-testid="contact-photo-error" className="text-[12px] text-destructive mt-2">{photoErr}</p>}
                </div>

                {error && (
                  <p data-testid="contact-error" className="text-[13px] text-destructive" role="alert">{error}</p>
                )}

                <button data-testid="contact-submit" onClick={submit} disabled={!canSend} className={btnPrimary}>
                  <Send size={16} strokeWidth={2} /> {sending ? "Sending…" : "Send message"}
                </button>
              </div>
            </>
          )}
        </div>

        {/* Call + Email */}
        <div className="grid sm:grid-cols-2 gap-5">
          <div className={`${cardCls} p-6`} data-testid="contact-call-card">
            <div className="flex items-center gap-4">
              <IconCircle className="bg-secondary border border-border text-primary-ink">
                <Phone size={18} strokeWidth={1.5} />
              </IconCircle>
              <div className="min-w-0">
                <h3 className="text-[15px] font-medium text-foreground">Call us</h3>
                <a
                  data-testid="contact-call"
                  href={CONTACT.phoneHref}
                  className="block text-[14px] font-semibold text-primary-ink hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {CONTACT.phoneDisplay}
                </a>
                <p className="text-[12px] text-muted-foreground mt-0.5">{CONTACT.hours}</p>
              </div>
            </div>
          </div>

          <div className={`${cardCls} p-6`} data-testid="contact-email-card">
            <div className="flex items-center gap-4">
              <IconCircle className="bg-secondary border border-border text-primary-ink">
                <Mail size={18} strokeWidth={1.5} />
              </IconCircle>
              <div className="min-w-0">
                <h3 className="text-[15px] font-medium text-foreground">Email us</h3>
                <a
                  data-testid="contact-email"
                  href={`mailto:${CONTACT.email}`}
                  className="block text-[14px] font-semibold text-primary-ink hover:underline break-all rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {CONTACT.email}
                </a>
                <p className="text-[12px] text-muted-foreground mt-0.5">We reply within 1 working day.</p>
              </div>
            </div>
          </div>
        </div>

        {/* Visit us */}
        <div className={`${cardCls} overflow-hidden`} data-testid="contact-stores-card">
          <div className="p-6 pb-4 flex items-center gap-4">
            <IconCircle className="bg-secondary border border-border text-primary-ink">
              <MapPin size={18} strokeWidth={1.5} />
            </IconCircle>
            <div>
              <h3 className="text-[15px] font-medium text-foreground">Visit us</h3>
              <p className="text-[12px] text-muted-foreground mt-0.5">Come say hello — the team loves a fitting-room chat.</p>
            </div>
          </div>
          <div>
            {STORES.map((s, i) => (
              <div
                key={`${s.country}-${s.name}`}
                data-testid={`contact-store-${i}`}
                className="px-6 py-4 border-t border-border flex items-center gap-4"
              >
                <div className="flex-grow min-w-0">
                  <p className="text-[14px] font-medium text-foreground truncate">{s.name}</p>
                  <p className="text-[12px] text-muted-foreground mt-0.5">{s.area} · {s.country}</p>
                </div>
                <a
                  data-testid={`contact-store-map-${i}`}
                  href={s.maps}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-[13px] font-medium text-primary-ink hover:underline shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Map <ExternalLink size={13} strokeWidth={2} />
                </a>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
