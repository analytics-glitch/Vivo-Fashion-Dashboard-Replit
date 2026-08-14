// "Help us dress you better" — the wave-based customer survey.
// One question per screen, tappable everything (typing optional), warm voice,
// under 3 minutes. The question schema comes from the server wave row, so a
// future wave can change content with no rebuild. +30 points on completion,
// once per wave (server-enforced; the animation only plays when awarded).
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Heart, Loader2, Lock, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { PointsAction, btnPrimary, btnSecondary, cardCls } from "./ui";

// Build the runtime step list: the store follow-up slides in right after the
// channel question once an answer triggers it.
function buildSteps(questions, answers) {
  const steps = [];
  for (const q of questions || []) {
    steps.push(q);
    const f = q.followup;
    if (f && (f.when || []).includes(answers[q.id])) {
      steps.push({ ...f, kind: "single", isFollowup: true });
    }
  }
  return steps;
}

function OptionRow({ label, selected, disabled, onTap, testid }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onTap}
      disabled={disabled}
      aria-pressed={selected}
      className={`w-full flex items-center justify-between gap-3 rounded border p-4 text-left text-[15px] transition-all active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        selected
          ? "border-primary bg-primary/5 text-foreground"
          : "border-border bg-background text-foreground hover:border-primary/40 hover:bg-secondary/40"
      } ${disabled ? "opacity-40 pointer-events-none" : ""}`}
    >
      <span className="leading-snug">{label}</span>
      <span
        className={`shrink-0 w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${
          selected ? "border-primary bg-primary text-primary-foreground" : "border-border"
        }`}
      >
        {selected && <Check size={12} strokeWidth={3} />}
      </span>
    </button>
  );
}

export default function SurveyView({ onBack, member, onMemberUpdate }) {
  const [state, setState] = useState(null); // /survey/state payload
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState("intro"); // intro | steps | done | already
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [awarded, setAwarded] = useState(false);
  const startedAt = useRef(null);
  const advanceTimer = useRef(null);

  useEffect(() => {
    let alive = true;
    api.surveyState()
      .then((s) => {
        if (!alive) return;
        setState(s);
        if (s.completed) setPhase("already");
        setReady(true);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(e.message);
        setReady(true);
      });
    return () => {
      alive = false;
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    };
  }, []);

  const wave = state?.wave || null;
  const pts = state?.points ?? 30;
  const steps = useMemo(() => buildSteps(wave?.questions, answers), [wave, answers]);
  const q = phase === "steps" ? steps[idx] : null;
  const isLast = phase === "steps" && idx === steps.length - 1;
  const progress = phase === "steps" ? Math.round(((idx + 1) / steps.length) * 100) : 0;

  const start = () => {
    startedAt.current = Date.now();
    setErr("");
    setIdx(0);
    setPhase("steps");
  };

  const maybeLater = async () => {
    try { if (wave) await api.surveyDismiss(wave.id); } catch { /* best-effort */ }
    onBack?.();
  };

  const goBack = () => {
    setErr("");
    if (phase !== "steps" || idx === 0) { setPhase("intro"); return; }
    setIdx((i) => i - 1);
  };

  const submit = async (finalAnswers) => {
    setBusy(true);
    setErr("");
    try {
      const resp = await api.surveyComplete({
        wave_id: wave.id,
        answers: finalAnswers,
        duration_secs: startedAt.current ? Math.round((Date.now() - startedAt.current) / 1000) : undefined,
      });
      if (resp.member && onMemberUpdate) onMemberUpdate(resp.member);
      setAwarded(!!resp.awarded);
      setPhase("done");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const advance = (nextAnswers) => {
    const ns = buildSteps(wave?.questions, nextAnswers);
    if (idx >= ns.length - 1) { submit(nextAnswers); return; }
    setIdx((i) => i + 1);
  };

  // Single-select (and NPS): one tap answers AND advances — a brief beat so
  // the selection is seen before the next screen slides in.
  const pickSingle = (question, value) => {
    if (busy) return;
    const next = { ...answers, [question.id]: value };
    if (question.followup && !(question.followup.when || []).includes(value)) {
      delete next[question.followup.id];
    }
    setAnswers(next);
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    advanceTimer.current = setTimeout(() => advance(next), 280);
  };

  const toggleMulti = (question, value) => {
    const cur = Array.isArray(answers[question.id]) ? answers[question.id] : [];
    let next;
    if (cur.includes(value)) next = cur.filter((x) => x !== value);
    else if (question.max && cur.length >= question.max) return;
    else next = [...cur, value];
    setAnswers((a) => ({ ...a, [question.id]: next }));
  };

  const multiPicks = q && q.kind === "multi" ? (Array.isArray(answers[q.id]) ? answers[q.id] : []) : [];
  const canContinue =
    q && (q.kind === "multi"
      ? multiPicks.length > 0
      : q.kind === "text"
        ? true
        : answers[q.id] !== undefined);

  return (
    <div data-testid="survey-view" className="max-w-xl mx-auto">
      {/* Header: back + progress */}
      <div className="flex items-center gap-3 mb-6">
        <button
          type="button"
          data-testid="survey-back"
          onClick={phase === "steps" ? goBack : onBack}
          aria-label="Back"
          className="w-10 h-10 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {phase === "steps" ? <ChevronLeft size={18} /> : <ArrowLeft size={18} />}
        </button>
        {phase === "steps" ? (
          <div className="flex-grow" aria-label={`Question ${idx + 1} of ${steps.length}`}>
            <div data-testid="survey-progress" className="h-1 bg-border rounded-full overflow-hidden">
              <div className="h-full bg-primary transition-all duration-500" style={{ width: `${progress}%` }} />
            </div>
            <div className="text-[11px] text-muted-foreground mt-1.5 uppercase tracking-wider">
              {idx + 1} of {steps.length}
            </div>
          </div>
        ) : (
          <div className="font-serif text-lg text-foreground">{wave?.title || "Help us dress you better"}</div>
        )}
      </div>

      {!ready && (
        <div className="space-y-3">
          <div className="h-24 bg-secondary rounded animate-pulse" />
          <div className="h-40 bg-secondary rounded animate-pulse" />
        </div>
      )}

      {ready && !wave && phase !== "already" && (
        <div className={`${cardCls} p-8 text-center`}>
          <p className="text-[14px] text-muted-foreground">
            There's no survey running right now — asante for wanting to help!
          </p>
          <button type="button" onClick={onBack} className={`${btnSecondary} mt-5`}>Back</button>
        </div>
      )}

      {/* ---------- intro ---------- */}
      {ready && wave && phase === "intro" && (
        <div className={`${cardCls} p-6 sm:p-8 animate-in fade-in duration-300`}>
          <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-primary-ink text-primary-foreground text-[10px] font-bold uppercase tracking-wider rounded-sm mb-4">
            <Sparkles size={11} /> +{pts} points
          </div>
          <h2 className="font-serif text-3xl text-foreground leading-tight mb-3">{wave.title}</h2>
          <p className="text-[14px] text-muted-foreground leading-relaxed mb-2">
            Ten quick taps — under three minutes. Your answers shape what we
            make, what we stock and how we serve you.
          </p>
          <p className="text-[12px] text-muted-foreground flex items-start gap-1.5 leading-relaxed mb-6">
            <Lock size={12} className="shrink-0 mt-0.5" />
            Private to Vivo: your answers are only ever used in aggregate to improve Vivo — never shared, never shown with your name.
          </p>
          <button type="button" data-testid="survey-start" onClick={start} className={btnPrimary}>
            Let's begin <ChevronRight size={15} />
          </button>
          <button type="button" data-testid="survey-later" onClick={maybeLater} className="w-full mt-3 h-10 text-[13px] text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
            Maybe later
          </button>
        </div>
      )}

      {/* ---------- one question per screen ---------- */}
      {ready && wave && phase === "steps" && q && (
        <div key={`${q.id}-${idx}`} data-testid={`survey-q-${q.id}`} className={`${cardCls} p-6 sm:p-8 animate-in fade-in slide-in-from-right-4 duration-300`}>
          <h2 className="font-serif text-2xl text-foreground leading-snug mb-1.5">{q.title}</h2>
          {q.hint && (
            <p className="text-[13px] text-muted-foreground mb-4">
              {q.hint}
              {q.max ? ` (${multiPicks.length}/${q.max})` : ""}
            </p>
          )}
          {!q.hint && <div className="mb-4" />}

          {(q.kind === "single") && (
            <div className="space-y-2.5">
              {(q.options || []).map((o, i) => (
                <OptionRow
                  key={o}
                  label={o}
                  testid={`survey-opt-${i}`}
                  selected={answers[q.id] === o}
                  onTap={() => pickSingle(q, o)}
                />
              ))}
            </div>
          )}

          {q.kind === "multi" && (
            <div className="space-y-2.5">
              {(q.options || []).map((o, i) => (
                <OptionRow
                  key={o}
                  label={o}
                  testid={`survey-opt-${i}`}
                  selected={multiPicks.includes(o)}
                  disabled={!multiPicks.includes(o) && !!q.max && multiPicks.length >= q.max}
                  onTap={() => toggleMulti(q, o)}
                />
              ))}
            </div>
          )}

          {q.kind === "nps" && (
            <div>
              <div className="grid grid-cols-6 gap-2">
                {Array.from({ length: 11 }).map((_, n) => (
                  <button
                    key={n}
                    type="button"
                    data-testid={`survey-nps-${n}`}
                    onClick={() => pickSingle(q, n)}
                    aria-pressed={answers[q.id] === n}
                    className={`h-12 rounded border text-[15px] font-medium transition-all active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                      answers[q.id] === n
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-foreground hover:border-primary/40"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="flex justify-between mt-2.5 text-[11px] text-muted-foreground">
                <span>0 · {q.low || "Not at all likely"}</span>
                <span>10 · {q.high || "Extremely likely"}</span>
              </div>
            </div>
          )}

          {q.kind === "text" && (
            <textarea
              data-testid="survey-text"
              value={answers[q.id] || ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              rows={6}
              maxLength={2000}
              placeholder={q.placeholder || "In your own words…"}
              className="w-full rounded bg-background border border-border p-4 text-[15px] text-foreground placeholder-muted-foreground leading-relaxed outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary resize-none"
            />
          )}

          {err && <p className="text-[13px] text-destructive mt-4" data-testid="survey-error">{err}</p>}

          {/* Multi + text advance with a button; singles/NPS auto-advance. */}
          {(q.kind === "multi" || q.kind === "text") && (
            <div className="mt-6">
              {isLast ? (
                <PointsAction points={pts} className="w-full">
                  <button
                    type="button"
                    data-testid="survey-finish"
                    onClick={() => advance(answers)}
                    disabled={busy || !canContinue}
                    className={btnPrimary}
                  >
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <Heart size={15} />}
                    {busy ? "Saving…" : "Finish"}
                  </button>
                </PointsAction>
              ) : (
                <button
                  type="button"
                  data-testid="survey-continue"
                  onClick={() => advance(answers)}
                  disabled={busy || !canContinue}
                  className={btnPrimary}
                >
                  Continue <ChevronRight size={15} />
                </button>
              )}
              {q.kind === "text" && q.optional && !String(answers[q.id] || "").trim() && (
                <button
                  type="button"
                  data-testid="survey-skip"
                  onClick={() => advance(answers)}
                  disabled={busy}
                  className="w-full mt-3 h-10 text-[13px] text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
                >
                  Skip this one
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ---------- thank you ---------- */}
      {phase === "done" && (
        <div data-testid="survey-done" className={`${cardCls} p-8 sm:p-10 text-center animate-in fade-in zoom-in-95 duration-500`}>
          <div className="w-14 h-14 rounded-full bg-primary/10 text-primary-ink flex items-center justify-center mx-auto mb-5">
            <Heart size={22} strokeWidth={1.5} />
          </div>
          <h2 className="font-serif text-3xl text-foreground mb-2">Asante!</h2>
          {awarded ? (
            <div data-testid="survey-awarded" className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary/10 text-primary-ink text-[14px] font-semibold animate-in slide-in-from-bottom-3 fade-in duration-500 delay-150 mb-4">
              <Sparkles size={14} /> +{pts} points, with love.
            </div>
          ) : (
            <p className="text-[14px] text-muted-foreground mb-4">
              You'd already completed this round — asante again for the first time!
            </p>
          )}
          <p className="text-[13px] text-muted-foreground leading-relaxed max-w-sm mx-auto mb-7">
            Your answers stay private, and they'll shape what we make next.
          </p>
          <button type="button" data-testid="survey-done-btn" onClick={onBack} className={btnPrimary}>
            Done
          </button>
        </div>
      )}

      {/* ---------- already completed this wave ---------- */}
      {ready && phase === "already" && (
        <div data-testid="survey-already" className={`${cardCls} p-8 sm:p-10 text-center`}>
          <div className="w-14 h-14 rounded-full bg-primary/10 text-primary-ink flex items-center justify-center mx-auto mb-5">
            <Check size={22} strokeWidth={1.5} />
          </div>
          <h2 className="font-serif text-2xl text-foreground mb-2">You've already helped this round</h2>
          <p className="text-[13px] text-muted-foreground leading-relaxed max-w-sm mx-auto mb-7">
            Asante sana — your {pts} points are in your balance. We'll let you
            know when the next survey opens.
          </p>
          <button type="button" onClick={onBack} className={btnSecondary}>Back</button>
        </div>
      )}
    </div>
  );
}
