import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft, ArrowRight, Check, Lock, Sparkles, Briefcase, ShoppingBag,
  PartyPopper, Sun, Moon, Plane, Share2,
} from "lucide-react";
import { api } from "@/lib/api";
import { cardCls, btnPrimary, btnSecondary, TierBadge, PointsAction, JohariWordmark } from "@/components/community/ui";

/* Style Quiz — a two-minute, one-question-per-screen conversation that turns
   into the member's Style DNA. Warm stylist voice, big tappable cards, always
   skippable, revisitable from Profile. Answers save server-side and gently
   re-order the Shop and the "Picked for you" rail at Home. */

const STYLES = [
  { id: "bold_colourful", label: "Bold & Colourful", note: "Colour is the outfit", art: { background: "linear-gradient(135deg,#FE5000 0%,#d94f8e 55%,#7a3ff2 100%)" } },
  { id: "classic_polished", label: "Classic & Polished", note: "Clean lines, quiet power", art: { background: "repeating-linear-gradient(115deg,#2b2724 0 14px,#37322d 14px 16px)" } },
  { id: "relaxed_easy", label: "Relaxed & Easy", note: "Soft, breathable, no fuss", art: { background: "linear-gradient(160deg,#f6efe4 0%,#e9ddcc 60%,#dccbb2 100%)" } },
  { id: "statement_glam", label: "Statement & Glamorous", note: "Made to be noticed", art: { background: "linear-gradient(150deg,#3b0f2a 0%,#6d1136 70%,#8a1a3f 100%)", boxShadow: "inset 0 -26px 40px -28px #e7b86b" } },
  { id: "modern_minimal", label: "Modern Minimal", note: "Less, but better", art: { background: "linear-gradient(105deg,#efedea 0 62%,#2b2724 62% 63%,#efedea 63% 100%)" } },
  { id: "print_loving", label: "Print-Loving", note: "Patterns tell the story", art: { background: "radial-gradient(circle at 6px 6px,#b3552e 2.5px,transparent 3px), radial-gradient(circle at 22px 20px,#2b2724 2px,transparent 2.5px), #f1e6d6", backgroundSize: "32px 28px, 32px 28px, auto" } },
];

const OCCASIONS = [
  { id: "work", label: "Work", icon: Briefcase },
  { id: "everyday", label: "Everyday errands", icon: ShoppingBag },
  { id: "events", label: "Events & celebrations", icon: PartyPopper },
  { id: "sunday_best", label: "Sunday best", icon: Sun },
  { id: "evenings_out", label: "Evenings out", icon: Moon },
  { id: "travel", label: "Travel", icon: Plane },
];

const REACH = [
  { id: "dresses", label: "Dresses", note: "One piece, done" },
  { id: "separates", label: "Separates", note: "Mix, match, repeat" },
  { id: "both", label: "A bit of both", note: "Depends on the day" },
];

const FITS = [
  { id: "comfort", label: "Comfort all day", note: "If it pinches, it stays home" },
  { id: "shaping", label: "Shaping & support", note: "Structure where it counts" },
  { id: "curves", label: "Celebrating my curves", note: "Cut to show, not hide" },
  { id: "coverage", label: "Coverage where I want it", note: "My rules, my hemlines" },
  { id: "fuss_free", label: "Fuss-free fabrics", note: "Wash, wear, walk out" },
];

const COLOURS = [
  { id: "warm_earth", label: "Warm earth tones", swatches: ["#a0522d", "#c67b43", "#8a6f3c", "#d8b98a"] },
  { id: "jewel", label: "Jewel tones", swatches: ["#0f6b4f", "#123a7c", "#7a1533", "#4b1e7a"] },
  { id: "brights", label: "Brights", swatches: ["#FE5000", "#e5399b", "#ffd400", "#0aa5ff"] },
  { id: "soft_neutrals", label: "Soft neutrals", swatches: ["#f4efe8", "#d9cfc2", "#8f887f", "#2b2724"] },
  { id: "prints", label: "Prints & patterns", swatches: null },
];

const SIZES = [
  { id: "xs_s", label: "XS – S" },
  { id: "m_l", label: "M – L" },
  { id: "xl_2x", label: "XL – 2X" },
  { id: "3x_up", label: "3X +" },
  { id: "varies", label: "It varies" },
];

const LEANS = [
  { id: "true_to_size", label: "True to size" },
  { id: "size_up", label: "I size up" },
  { id: "size_down", label: "I size down" },
];

const GEM_ACCENT = { Tsavorite: "#9fd8b4", Ruby: "#d98a97", Tanzanite: "#a9b3e8" };

const EMPTY = { styles: [], occasions: [], reach_for: "", fit_priorities: [], colours: [], size_range: "", fit_lean: "" };

function toggleIn(list, id, max) {
  if (list.includes(id)) return list.filter((x) => x !== id);
  if (max && list.length >= max) return list;
  return [...list, id];
}

function CheckChip() {
  return (
    <span className="absolute top-2.5 right-2.5 w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center shadow-sm">
      <Check size={14} strokeWidth={3} />
    </span>
  );
}

function StepHeading({ kicker, title, sub }) {
  return (
    <div className="mb-7">
      {kicker && <div className="text-[11px] font-semibold uppercase tracking-widest text-primary-ink mb-3 flex items-center gap-1.5"><Sparkles size={13} /> {kicker}</div>}
      <h2 className="font-serif text-[26px] sm:text-3xl text-foreground leading-snug">{title}</h2>
      {sub && <p className="text-sm text-muted-foreground mt-2">{sub}</p>}
    </div>
  );
}

export default function StyleQuiz({ member, onClose, onMemberUpdate, onSeeFeed }) {
  const completedBefore = !!member?.quiz_completed;
  const [step, setStep] = useState(completedBefore ? 1 : 0); // 0 welcome · 1–6 questions · "result"
  const [answers, setAnswers] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // {dna, points_awarded, shared}
  const [shareState, setShareState] = useState("idle"); // idle | busy | done
  const [weeklyPicks, setWeeklyPicks] = useState(false);
  const touch = useRef(null);

  // Prefill saved answers so editing feels like a conversation resumed.
  useEffect(() => {
    let on = true;
    api.styleQuiz()
      .then((d) => {
        if (on && typeof d.weekly_picks_opted_in === "boolean") {
          setWeeklyPicks(d.weekly_picks_opted_in);
        }
        if (on && d.answers && Object.keys(d.answers).length) {
          setAnswers({ ...EMPTY, ...d.answers });
          if (d.shared) setShareState("done");
        }
      })
      .catch(() => {}); // fresh quiz is fine offline
    return () => { on = false; };
  }, []);

  // Full-screen overlay: lock the page behind it.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const set = (patch) => setAnswers((a) => ({ ...a, ...patch }));

  const stepValid =
    step === 1 ? answers.styles.length > 0
    : step === 2 ? answers.occasions.length > 0
    : step === 3 ? !!answers.reach_for
    : step === 4 ? answers.fit_priorities.length > 0
    : step === 5 ? answers.colours.length > 0
    : true;

  const next = useCallback(() => {
    if (step === 0) { setStep(1); return; }
    if (step >= 1 && step <= 5 && stepValid) setStep(step + 1);
  }, [step, stepValid]);

  const back = useCallback(() => {
    if (step === "result") return;
    if (step > 0) setStep(step - 1);
  }, [step]);

  const submit = async (includePrivate) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const payload = includePrivate ? answers : { ...answers, size_range: "", fit_lean: "" };
    try {
      const d = await api.styleQuizSave(payload, weeklyPicks);
      if (d.member && onMemberUpdate) onMemberUpdate(d.member);
      setResult({ dna: d.dna || [], points_awarded: !!d.points_awarded });
      if (d.shared) setShareState("done");
      setStep("result");
    } catch (e) {
      setError(e.message || "Couldn't save your answers — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (shareState !== "idle") return;
    setShareState("busy");
    try {
      await api.styleQuizShare();
      setShareState("done");
    } catch {
      setShareState("idle");
    }
  };

  // Light swipe navigation between question screens.
  const onTouchStart = (e) => { touch.current = e.touches?.[0]?.clientX ?? null; };
  const onTouchEnd = (e) => {
    if (touch.current == null || typeof step !== "number") return;
    const dx = (e.changedTouches?.[0]?.clientX ?? touch.current) - touch.current;
    touch.current = null;
    if (dx > 60 && step > 0) back();
    else if (dx < -60 && step >= 1 && step <= 5 && stepValid) next();
  };

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const gem = GEM_ACCENT[member?.tier] || "#d9cfc2";

  const body = (
    <div data-testid="quiz-root" className="fixed inset-0 z-[70] bg-background overflow-y-auto" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {/* Header: back · progress dots · skip */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border/60">
        <div className="max-w-2xl mx-auto px-5 h-14 flex items-center justify-between gap-3">
          <button
            data-testid="quiz-back"
            onClick={step === 0 || step === "result" ? onClose : back}
            aria-label="Back"
            className="w-10 h-10 -ml-2 rounded-full flex items-center justify-center text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ArrowLeft size={18} />
          </button>
          {typeof step === "number" ? (
            <div data-testid="quiz-dots" className="flex items-center gap-1.5" aria-label={`Step ${step + 1} of 7`}>
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <span key={i} className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? "w-6 bg-primary" : i < step ? "w-1.5 bg-foreground/70" : "w-1.5 bg-border"}`} />
              ))}
            </div>
          ) : <JohariWordmark className="h-4 opacity-80" />}
          {step !== "result" ? (
            <button data-testid="quiz-skip" onClick={onClose} className="text-[13px] text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap">
              Skip for now
            </button>
          ) : <span className="w-10" />}
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-5 py-8 sm:py-12 pb-28">
        {/* ── Welcome ── */}
        {step === 0 && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-500 text-center pt-6 sm:pt-14">
            <JohariWordmark className="h-5 mx-auto mb-8 opacity-90" />
            <h1 className="font-serif text-4xl sm:text-5xl text-foreground leading-tight mb-5">Let's find your<br />Style DNA</h1>
            <p className="text-[15px] text-muted-foreground leading-relaxed max-w-md mx-auto mb-3">
              Two minutes, a handful of easy questions — no wrong answers. Your feed starts dressing you properly.
            </p>
            {!completedBefore && (
              <p className="text-[14px] text-primary-ink font-medium mb-10">Finish and 50 points land on your card.</p>
            )}
            {completedBefore && (
              <p className="text-[14px] text-muted-foreground mb-10">Your answers are saved — refresh them any time and your feed follows your lead.</p>
            )}
            <button data-testid="quiz-start" onClick={next} className={`${btnPrimary} px-10 h-12 text-[15px]`}>
              Let's begin <ArrowRight size={16} className="ml-2 inline" />
            </button>
          </div>
        )}

        {/* ── 1 · Style archetypes ── */}
        {step === 1 && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-400">
            <StepHeading kicker="Your style" title="Which of these feels most like you?" sub="Pick up to three — whatever catches your eye." />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {STYLES.map((s) => {
                const on = answers.styles.includes(s.id);
                return (
                  <button
                    key={s.id}
                    data-testid={`quiz-style-${s.id}`}
                    onClick={() => set({ styles: toggleIn(answers.styles, s.id, 3) })}
                    aria-pressed={on}
                    className={`relative rounded overflow-hidden border text-left transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${on ? "border-primary ring-2 ring-primary shadow-md" : "border-border hover:border-foreground/30"}`}
                  >
                    <div className="aspect-[4/3]" style={s.art} />
                    {on && <CheckChip />}
                    <div className="p-3 bg-card">
                      <div className="font-serif text-[15px] text-foreground leading-tight">{s.label}</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">{s.note}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 2 · Occasions ── */}
        {step === 2 && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-400">
            <StepHeading kicker="Your week" title="Where do your clothes need to take you?" sub="Choose all that apply." />
            <div className="grid grid-cols-2 gap-3">
              {OCCASIONS.map((o) => {
                const on = answers.occasions.includes(o.id);
                const Icon = o.icon;
                return (
                  <button
                    key={o.id}
                    data-testid={`quiz-occasion-${o.id}`}
                    onClick={() => set({ occasions: toggleIn(answers.occasions, o.id) })}
                    aria-pressed={on}
                    className={`relative h-24 rounded border p-4 text-left flex flex-col justify-between transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${on ? "border-primary ring-2 ring-primary bg-primary/5" : `${cardCls} hover:border-foreground/30`}`}
                  >
                    <Icon size={20} strokeWidth={1.5} className={on ? "text-primary-ink" : "text-muted-foreground"} />
                    {on && <CheckChip />}
                    <span className="text-[14px] font-medium text-foreground leading-tight">{o.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 3 · Reach for first ── */}
        {step === 3 && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-400">
            <StepHeading kicker="Your instinct" title="What do you reach for first?" sub="On a good morning, what wins?" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {REACH.map((r) => {
                const on = answers.reach_for === r.id;
                return (
                  <button
                    key={r.id}
                    data-testid={`quiz-reach-${r.id}`}
                    onClick={() => set({ reach_for: r.id })}
                    aria-pressed={on}
                    className={`relative rounded border p-6 sm:py-10 flex sm:flex-col items-center gap-4 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${on ? "border-primary ring-2 ring-primary bg-primary/5" : `${cardCls} hover:border-foreground/30`}`}
                  >
                    {on && <CheckChip />}
                    <svg width="44" height="56" viewBox="0 0 44 56" fill="none" className="shrink-0 text-foreground">
                      {r.id !== "separates" && (
                        <path d="M17 4l5 5 5-5 3 7-4 6c7 10 6 22 6 22H12s-1-12 6-22l-4-6 3-7z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" opacity={r.id === "both" ? 0.45 : 1} />
                      )}
                      {r.id !== "dresses" && (
                        <>
                          <path d="M13 8h18l2 12H11L13 8z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                          <path d="M14 26h16l3 22H11l3-22z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                        </>
                      )}
                    </svg>
                    <span className="text-left sm:text-center">
                      <span className="block font-serif text-[17px] text-foreground">{r.label}</span>
                      <span className="block text-[12px] text-muted-foreground mt-1">{r.note}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 4 · Fit priorities ── */}
        {step === 4 && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-400">
            <StepHeading
              kicker="Real curves, really considered"
              title="When something fits just right, what does that mean for you?"
              sub="Vivo is designed for real curves — pick up to two."
            />
            <div className="space-y-3">
              {FITS.map((f) => {
                const on = answers.fit_priorities.includes(f.id);
                const full = !on && answers.fit_priorities.length >= 2;
                return (
                  <button
                    key={f.id}
                    data-testid={`quiz-fit-${f.id}`}
                    onClick={() => set({ fit_priorities: toggleIn(answers.fit_priorities, f.id, 2) })}
                    aria-pressed={on}
                    disabled={full}
                    className={`relative w-full rounded border px-5 py-4 text-left flex items-center justify-between gap-4 transition-all active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${on ? "border-primary ring-2 ring-primary bg-primary/5" : `${cardCls} hover:border-foreground/30`} ${full ? "opacity-40" : ""}`}
                  >
                    <span>
                      <span className="block text-[15px] font-medium text-foreground">{f.label}</span>
                      <span className="block text-[12px] text-muted-foreground mt-0.5">{f.note}</span>
                    </span>
                    <span className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 ${on ? "bg-primary border-primary text-white" : "border-border"}`}>
                      {on && <Check size={14} strokeWidth={3} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 5 · Colours ── */}
        {step === 5 && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-400">
            <StepHeading kicker="Your palette" title="Which colours make you feel amazing?" sub="Choose every family you love." />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {COLOURS.map((c) => {
                const on = answers.colours.includes(c.id);
                return (
                  <button
                    key={c.id}
                    data-testid={`quiz-colour-${c.id}`}
                    onClick={() => set({ colours: toggleIn(answers.colours, c.id) })}
                    aria-pressed={on}
                    className={`relative rounded border px-5 py-4 flex items-center justify-between gap-4 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${on ? "border-primary ring-2 ring-primary bg-primary/5" : `${cardCls} hover:border-foreground/30`}`}
                  >
                    <span className="text-[15px] font-medium text-foreground">{c.label}</span>
                    {c.swatches ? (
                      <span className="flex -space-x-1.5 shrink-0">
                        {c.swatches.map((hex) => (
                          <span key={hex} className="w-7 h-7 rounded-full border-2 border-card shadow-sm" style={{ background: hex }} />
                        ))}
                      </span>
                    ) : (
                      <span className="w-14 h-7 rounded-full border-2 border-card shadow-sm shrink-0" style={{ background: "radial-gradient(circle at 5px 5px,#b3552e 2px,transparent 2.5px), radial-gradient(circle at 14px 12px,#2b2724 1.8px,transparent 2.3px), #f1e6d6", backgroundSize: "20px 16px, 20px 16px, auto" }} />
                    )}
                    {on && <CheckChip />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── 6 · Private fit details ── */}
        {step === 6 && (
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-400">
            <div className="flex items-center gap-2 text-muted-foreground mb-3">
              <Lock size={14} />
              <span className="text-[11px] font-semibold uppercase tracking-widest">Private · optional</span>
            </div>
            <h2 className="font-serif text-[26px] sm:text-3xl text-foreground leading-snug mb-2">Just between us</h2>
            <p className="text-sm text-muted-foreground mb-8">This helps us recommend pieces that fit beautifully. It never shows on your profile or to other members.</p>

            <div className="mb-8">
              <div className="text-[13px] font-medium text-foreground mb-3">Your usual size range</div>
              <div className="flex flex-wrap gap-2">
                {SIZES.map((s) => {
                  const on = answers.size_range === s.id;
                  return (
                    <button
                      key={s.id}
                      data-testid={`quiz-size-${s.id}`}
                      onClick={() => set({ size_range: on ? "" : s.id })}
                      aria-pressed={on}
                      className={`h-11 px-5 rounded border text-[14px] transition-all active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${on ? "border-primary bg-primary/10 text-foreground font-medium ring-1 ring-primary" : "border-border bg-card text-muted-foreground hover:border-foreground/30"}`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mb-10">
              <div className="text-[13px] font-medium text-foreground mb-3">How do you usually size?</div>
              <div className="flex flex-wrap gap-2">
                {LEANS.map((l) => {
                  const on = answers.fit_lean === l.id;
                  return (
                    <button
                      key={l.id}
                      data-testid={`quiz-lean-${l.id}`}
                      onClick={() => set({ fit_lean: on ? "" : l.id })}
                      aria-pressed={on}
                      className={`h-11 px-5 rounded border text-[14px] transition-all active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${on ? "border-primary bg-primary/10 text-foreground font-medium ring-1 ring-primary" : "border-border bg-card text-muted-foreground hover:border-foreground/30"}`}
                    >
                      {l.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex items-start gap-3 rounded border border-primary/25 bg-primary/5 p-4 cursor-pointer">
              <input
                type="checkbox"
                data-testid="quiz-weekly-picks"
                checked={weeklyPicks}
                onChange={(e) => setWeeklyPicks(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span>
                <span className="block text-[14px] font-medium text-foreground">Also send me weekly picks based on this</span>
                <span className="block text-[12px] text-muted-foreground mt-1 leading-relaxed">Fresh suggestions selected from your Style DNA. You can turn this off any time.</span>
              </span>
            </label>

            {error && <div className="text-[13px] text-destructive mb-4">{error}</div>}

            <div className="flex flex-col sm:flex-row gap-3">
              {completedBefore ? (
                <button data-testid="quiz-finish" onClick={() => submit(true)} disabled={busy} className={`${btnPrimary} h-12 px-8 flex-1 sm:flex-none disabled:opacity-60`}>
                  {busy ? "Saving…" : "Reveal my Style DNA"}
                </button>
              ) : (
                <PointsAction points={50}>
                  <button data-testid="quiz-finish" onClick={() => submit(true)} disabled={busy} className={`${btnPrimary} h-12 px-8 w-full sm:w-auto disabled:opacity-60`}>
                    {busy ? "Saving…" : "Reveal my Style DNA"}
                  </button>
                </PointsAction>
              )}
              <button data-testid="quiz-finish-skip" onClick={() => submit(false)} disabled={busy} className="h-12 px-6 text-[13px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-60">
                Skip this step
              </button>
            </div>
          </div>
        )}

        {/* ── Result ── */}
        {step === "result" && result && (
          <div data-testid="quiz-result" className="animate-in fade-in slide-in-from-bottom-3 duration-500 pt-4 sm:pt-10">
            <div className={`${cardCls} relative overflow-hidden p-8 sm:p-12 text-center`}>
              <div className="absolute top-0 left-0 right-0 h-1" style={{ background: `linear-gradient(90deg, transparent, ${gem}, transparent)` }} />
              <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full blur-[70px] pointer-events-none" style={{ background: `${gem}33` }} />

              <JohariWordmark className="h-4 mx-auto mb-6 opacity-80" />
              <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-4">Your Style DNA</div>
              <div data-testid="quiz-dna-text" className="font-serif text-[26px] sm:text-4xl text-foreground leading-snug mb-6">
                {(result.dna || []).join(" · ")}
              </div>
              <div className="flex flex-wrap justify-center gap-2 mb-6">
                {(result.dna || []).map((d) => (
                  <span key={d} className="bg-secondary border border-border text-foreground text-xs font-medium px-3 py-1.5 rounded">{d}</span>
                ))}
              </div>
              <div className="flex justify-center mb-2"><TierBadge tier={member?.tier} /></div>

              {result.points_awarded && (
                <div data-testid="quiz-points-pill" className="inline-flex items-center gap-1.5 bg-primary/10 text-primary-ink text-[13px] font-semibold px-4 py-2 rounded-full mt-4">
                  <Sparkles size={14} /> +50 points · added to your card
                </div>
              )}

              <div className="flex flex-col sm:flex-row justify-center gap-3 mt-8">
                <button data-testid="quiz-see-feed" onClick={onSeeFeed} className={`${btnPrimary} h-12 px-8`}>
                  See my personalized feed
                </button>
                <button
                  data-testid="quiz-share"
                  onClick={share}
                  disabled={shareState !== "idle"}
                  className={`${btnSecondary} h-12 px-6 disabled:opacity-70`}
                >
                  {shareState === "done" ? (<span className="flex items-center gap-2"><Check size={15} /> Shared with the community</span>)
                    : shareState === "busy" ? "Sharing…"
                    : (<span className="flex items-center gap-2"><Share2 size={15} /> Share to community</span>)}
                </button>
              </div>
              <p className="text-[12px] text-muted-foreground mt-6">Sharing is always your call — and you can retake this any time from your Profile.</p>
            </div>
          </div>
        )}
      </div>

      {/* Sticky continue bar on question screens 1–5 */}
      {typeof step === "number" && step >= 1 && step <= 5 && (
        <div className="fixed bottom-0 left-0 right-0 z-10 bg-background/95 backdrop-blur border-t border-border/60">
          <div className="max-w-2xl mx-auto px-5 py-3.5 flex items-center justify-between gap-4">
            <span className="text-[12px] text-muted-foreground">
              {step === 1 && `${answers.styles.length}/3 picked`}
              {step === 2 && (answers.occasions.length ? `${answers.occasions.length} picked` : "")}
              {step === 4 && `${answers.fit_priorities.length}/2 picked`}
              {step === 5 && (answers.colours.length ? `${answers.colours.length} picked` : "")}
            </span>
            <button data-testid="quiz-next" onClick={next} disabled={!stepValid} className={`${btnPrimary} h-12 px-8 disabled:opacity-40 disabled:pointer-events-none`}>
              Continue <ArrowRight size={15} className="ml-1.5 inline" />
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(body, document.body);
}
