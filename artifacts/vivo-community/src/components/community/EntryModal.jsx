import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { btnPrimary, btnSecondary } from "./ui";

// ---------------------------------------------------------------------------
// Demo entry store (community layer is a demo — points are display-only).
// Entries live in localStorage so a member's pending submissions survive tab
// switches and reloads. Every entry starts life "in_review": points are only
// earned once an entry is reviewed and published — never on submission.
// ---------------------------------------------------------------------------
const STORE_KEY = "vivo_demo_entries";

export function getEntries() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveEntries(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* demo store — best effort */
  }
}

export function addEntry(entry) {
  const list = [
    { id: Date.now(), status: "in_review", date: new Date().toISOString().slice(0, 10), ...entry },
    ...getEntries(),
  ];
  saveEntries(list);
  return list;
}

// Warm, non-punitive status labels for a member's own entries.
export const ENTRY_STATUS_COPY = {
  in_review: "In review",
  not_published: "Not published this time",
};

export default function EntryModal({ challenge, onClose, onSubmitted }) {
  const [step, setStep] = useState("form");
  const [caption, setCaption] = useState("");
  // Marketing-reuse consent is OPT-IN and separate from membership terms:
  // it must never be pre-checked, and sharing works identically without it.
  const [marketingOk, setMarketingOk] = useState(false);
  const dialogRef = useRef(null);
  const prevFocusRef = useRef(null);

  const isLook = challenge?.kind === "look";
  const open = !!challenge;

  useEffect(() => {
    if (challenge) {
      setStep("form");
      setCaption("");
      setMarketingOk(false);
    }
  }, [challenge?.id]);

  // Remember the invoker and hand focus back when the dialog closes.
  useEffect(() => {
    if (!open) return;
    prevFocusRef.current = document.activeElement;
    return () => {
      if (prevFocusRef.current && typeof prevFocusRef.current.focus === "function") {
        prevFocusRef.current.focus();
      }
      prevFocusRef.current = null;
    };
  }, [open]);

  // Move focus into the dialog on open and when the step changes.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const target = dialogRef.current?.querySelector(
        step === "form" ? "#entry-caption" : '[data-testid="btn-entry-done"]'
      );
      target?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!challenge) return null;

  // Keep Tab cycling inside the dialog while it is open.
  const trapTab = (e) => {
    if (e.key !== "Tab") return;
    const nodes = dialogRef.current?.querySelectorAll(
      'button, textarea, input, select, a[href], [tabindex]:not([tabindex="-1"])'
    );
    if (!nodes || nodes.length === 0) return;
    const list = Array.from(nodes).filter((n) => !n.disabled);
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const submit = () => {
    addEntry({
      challengeId: challenge.id,
      title: isLook ? "A look from my journal" : challenge.title,
      label: isLook ? "Shared a look" : `Entered ${challenge.title}`,
      points: challenge.points,
      caption: caption.trim(),
      // Stored per entry, separate from the membership-terms consent given
      // at sign-up. Only governs reuse OUTSIDE the app.
      marketing_ok: marketingOk,
    });
    setStep("done");
    if (onSubmitted) onSubmitted();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
      data-testid="entry-modal"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="entry-modal-title"
        className="bg-background rounded border border-border shadow-xl w-full max-w-md p-6 sm:p-8 relative animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <button aria-label="Close" onClick={onClose} className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors">
          <X size={18} strokeWidth={1.5} />
        </button>

        {step === "form" ? (
          <>
            <h3 id="entry-modal-title" className="text-xl font-serif text-foreground mb-1.5 pr-8">
              {isLook ? "Share your look" : `Enter ${challenge.title}`}
            </h3>
            <p className="text-[13px] text-primary-ink font-medium mb-5">
              Earn {challenge.points} pts when {isLook ? "your look" : "your entry"} is published
            </p>

            <label htmlFor="entry-caption" className="block text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
              Your story
            </label>
            <textarea
              id="entry-caption"
              data-testid="input-entry-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={3}
              placeholder="Tell us the story behind your look…"
              className="w-full rounded border border-border bg-secondary/30 p-3 text-[14px] text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary resize-none mb-4"
            />

            <label className="flex items-start gap-3 cursor-pointer group mb-4">
              <div className="relative flex items-center justify-center shrink-0 mt-0.5">
                <input
                  data-testid="check-marketing-consent"
                  type="checkbox"
                  checked={marketingOk}
                  onChange={(e) => setMarketingOk(e.target.checked)}
                  className="peer appearance-none w-5 h-5 border border-border rounded bg-background checked:bg-primary checked:border-primary transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                />
                <Check size={14} className="absolute text-primary-foreground opacity-0 peer-checked:opacity-100 pointer-events-none transition-opacity" />
              </div>
              <span className="text-[13px] leading-relaxed text-muted-foreground group-hover:text-foreground transition-colors">
                Vivo may feature my post in Vivo's marketing (social media, website).
                <span className="block text-[11px] mt-1 opacity-80">Optional — sharing works the same either way. This only covers use outside the app.</span>
              </span>
            </label>

            <p className="text-[12px] text-muted-foreground leading-relaxed bg-secondary/50 border border-border rounded p-3.5 mb-6">
              Our team reviews every {isLook ? "share" : "entry"} before it goes live in the community — it's how we keep this space lovely. Your {challenge.points} points are added as soon as {isLook ? "your look" : "your entry"} is published.
            </p>

            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <button onClick={onClose} className={btnSecondary}>Not now</button>
              <button data-testid="btn-entry-submit" onClick={submit} className={btnPrimary}>
                {isLook ? "Share my look" : "Share my entry"}
              </button>
            </div>
          </>
        ) : (
          <div className="text-center pt-2" data-testid="entry-confirmation">
            <div className="w-14 h-14 mx-auto rounded-full bg-primary/10 border border-primary/20 text-primary-ink flex items-center justify-center mb-5">
              <Check size={26} strokeWidth={2} />
            </div>
            <h3 className="text-xl font-serif text-foreground mb-3">Thanks for sharing!</h3>
            <p className="text-[14px] text-muted-foreground leading-relaxed mb-2">
              {isLook ? "Your look" : "Your entry"} is under review — you'll earn your {challenge.points} points the moment it's published.
            </p>
            <p className="text-[12px] text-muted-foreground leading-relaxed mb-7">
              You can follow it in your Style Journal — it's only visible to you until it goes live.
            </p>
            <button data-testid="btn-entry-done" onClick={onClose} className={btnPrimary}>Done</button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}