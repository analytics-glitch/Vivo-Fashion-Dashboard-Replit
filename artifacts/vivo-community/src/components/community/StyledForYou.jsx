import React, { useEffect, useState } from "react";
import { ArrowRight, Check, RefreshCw, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";
import { cardCls, brandAsset } from "./ui";
import { ProductRail, RailCard } from "./ShopSections";
import { STYLE_PREFERENCE_VISUALS } from "./stylePreferenceVisuals";

/* "Styled for You" — opt-in weekly personalised recommendations.
   Three connected surfaces share this file:
   - StyledForYouHome    → home-page carousel (opted-in) or invitation card
   - StyledForYouShop    → the Shop tab's dedicated recommendations view
   - StylePrefsView      → the full-page Style Preferences editor (?page=styleprefs)
   Enrolment is never automatic: the server only serves picks after the
   member has explicitly switched the weekly recommendations on. */

const LATER_KEY = "vivo_sfy_later";

/* ---------------- Home surface ---------------- */

export function StyledForYouHome({ member, onViewAll, onPersonalise }) {
  const [state, setState] = useState(null); // null=loading | {opted_in, sections, week_label}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!member) return;
    let on = true;
    // meta_only: Home never downloads recommendation/product payloads —
    // the full picks fetch happens only on the Shop surface.
    api.styledForYouStatus().then((d) => { if (on) setState(d); }).catch(() => { if (on) setState({ opted_in: false, sections: [] }); });
    return () => { on = false; };
  }, [member?.id]);
  if (!member || !state) return null;

  const toggle = async () => {
    const next = !state.opted_in;
    setBusy(true);
    setError("");
    setState((current) => ({ ...current, opted_in: next }));
    try {
      const saved = await api.stylePrefsSave({ opted_in: next });
      setState((current) => ({ ...current, opted_in: !!saved?.prefs?.opted_in }));
    } catch {
      setState((current) => ({ ...current, opted_in: !next }));
      setError("We couldn't update this right now. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="sfy-home-optin" className={`${cardCls} overflow-hidden h-full flex flex-col`}>
      <div className="relative h-40 sm:h-44 bg-secondary">
        <img
          src={brandAsset("sfy-home.jpg")}
          alt=""
          loading="lazy"
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover object-top"
        />
      </div>
      <div className="p-5 sm:p-6 flex flex-col flex-1">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-2">
              <Sparkles size={12} /> New
            </div>
            <h2 className="font-serif text-xl sm:text-2xl text-foreground leading-tight">Styled for You</h2>
          </div>
          {state.opted_in && (
            <button
              type="button"
              role="switch"
              aria-checked
              aria-label="Weekly Styled for You recommendations"
              data-testid="sfy-home-toggle"
              disabled={busy}
              onClick={toggle}
              className="relative mt-1 w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary bg-primary"
            >
              <span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform translate-x-5" />
            </button>
          )}
        </div>
        <p className="text-[13px] text-muted-foreground leading-relaxed mt-3">
          {state.opted_in
            ? "Your weekly recommendations are on. New picks will appear in Shop."
            : "Get weekly outfit and product recommendations selected around your style, size and preferences."}
        </p>
        {error && <p className="text-[12px] text-destructive mt-2">{error}</p>}
        {state.opted_in && (
          <button
            data-testid="sfy-home-picks-cta"
            onClick={onViewAll}
            className="mt-auto pt-5 text-[13px] font-medium text-primary-ink hover:underline underline-offset-2 inline-flex items-center gap-1 self-start rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            See my picks in Shop <ArrowRight size={14} />
          </button>
        )}
        {!state.opted_in && (
          <button
            data-testid="sfy-home-personalise"
            onClick={onPersonalise}
            className="mt-auto pt-5 text-[13px] font-medium text-primary-ink hover:underline underline-offset-2 inline-flex items-center gap-1 self-start rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Personalise My Style <ArrowRight size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------- Shop surface ---------------- */

export function StyledForYouShop({ onOpenProduct, onEditPrefs }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let on = true;
    api.styledForYou()
      .then((d) => { if (on) setState(d); })
      .catch((e) => { if (on) setError(e.message); });
    return () => { on = false; };
  }, []);

  if (error) {
    return <div className="py-16 text-center text-muted-foreground text-sm">Couldn't load your picks right now — {error}</div>;
  }
  if (!state) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:gap-6 py-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded bg-secondary animate-pulse aspect-[3/4]" />
        ))}
      </div>
    );
  }
  if (!state.opted_in) {
    return (
      <div className={`${cardCls} p-8 sm:p-10 text-center max-w-lg mx-auto my-8`}>
        <Sparkles size={22} className="mx-auto text-primary-ink mb-3" />
        <h3 className="font-serif text-2xl text-foreground mb-2">Styled for You</h3>
        <p className="text-[13px] text-muted-foreground leading-relaxed mb-6">
          Get weekly outfit and product recommendations selected around your
          style, size and preferences. You choose to switch it on — nothing is
          automatic.
        </p>
        <button data-testid="sfy-shop-optin" onClick={onEditPrefs}
          className="px-7 bg-primary text-primary-foreground h-11 rounded font-medium text-[14px] inline-flex items-center gap-2 hover:opacity-90 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
          Personalise My Style <ArrowRight size={15} />
        </button>
      </div>
    );
  }

  const picks = (state.sections || []).find((s) => s.key === "picks");
  const rest = (state.sections || []).filter((s) => s.key !== "picks" && s.items?.length);
  return (
    <div data-testid="sfy-shop" className="animate-in fade-in duration-500">
      <div className="mb-8 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">
            <RefreshCw size={10} /> {state.week_label || "Updated weekly"}
          </div>
          <h2 className="text-3xl font-serif text-foreground">Styled for You</h2>
          <p className="text-muted-foreground text-sm mt-1">{picks?.sub || "Your picks are here."}</p>
        </div>
        <button data-testid="sfy-refresh-prefs" onClick={onEditPrefs}
          className="self-start sm:self-auto text-[13px] font-medium text-primary-ink hover:underline underline-offset-2 inline-flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          Refresh my preferences <ArrowRight size={13} />
        </button>
      </div>

      {picks?.items?.length ? (
        <div className="grid grid-cols-2 gap-4 sm:gap-6 mb-14">
          {picks.items.map((p) => (
            <RailCard key={p.sku} p={p} onOpenProduct={onOpenProduct} idPrefix="sfyg" />
          ))}
        </div>
      ) : (
        <div className="py-14 text-center text-muted-foreground text-sm mb-8">
          We're gathering pieces for you — check back shortly, or refresh your preferences.
        </div>
      )}

      {rest.map((s) => (
        <div key={s.key} className="mb-12">
          <ProductRail
            title={s.title}
            sub={s.sub}
            products={s.items}
            onOpenProduct={onOpenProduct}
            testId={`sfy-sec-${s.key}`}
            idPrefix={`sfy-${s.key}`}
          />
        </div>
      ))}
    </div>
  );
}

/* ---------------- Preferences editor (full page + Profile toggle) ---------------- */

const FALLBACK_OPTIONS = {
  sizes: ["XS", "S", "M", "L", "XL", "XXL", "1X", "2X", "3X", "4X"],
  fits: ["Fitted", "True to size", "Relaxed", "Flowy"],
  colours: [],
  print_preferences: ["Plain", "Prints"],
  colour_shades: ["Olive", "Sage", "Emerald", "Cobalt", "Navy", "Burgundy", "Blush", "Terracotta", "Cocoa", "Ivory", "Charcoal", "Black"],
  fabrics: ["Cotton", "Silk", "Chiffon", "Denim", "Knit", "Linen"],
  interests: ["Workwear", "Casual", "Occasionwear", "Activewear"],
  frequencies: ["weekly", "fortnightly", "monthly"],
};
const FREQ_LABEL = { weekly: "Weekly", fortnightly: "Every two weeks", monthly: "Monthly" };

function Chip({ on, children, onClick, testId }) {
  return (
    <button type="button" data-testid={testId} onClick={onClick} aria-pressed={on}
      className={`px-3 h-9 rounded border text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        on ? "bg-foreground text-background border-foreground" : "bg-background text-foreground border-border hover:bg-secondary"}`}>
      {on && <Check size={12} className="inline mr-1 -mt-0.5" />}{children}
    </button>
  );
}

function Toggle({ on, onChange, testId, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} data-testid={testId}
      onClick={() => onChange(!on)}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${on ? "bg-primary" : "bg-border"}`}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : ""}`} />
    </button>
  );
}

function VisualChoiceGrid({ field, allowed, values, onToggle, columns }) {
  const options = (STYLE_PREFERENCE_VISUALS[field] || [])
    .filter((option) => !allowed?.length || allowed.includes(option.value));
  return (
    <div className={`grid gap-3 ${columns}`}>
      {options.map((option) => {
        const selected = (values || []).includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            aria-label={option.label}
            data-testid={`sfy-${field.replace(/_/g, "-")}-${option.value.toLowerCase().replace(/\s+/g, "-")}`}
            onClick={() => onToggle(option.value)}
            className={`group relative overflow-hidden rounded border text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
              selected
                ? "border-primary ring-2 ring-primary/30 bg-primary/5"
                : "border-border bg-card hover:-translate-y-0.5 hover:border-foreground/30"
            }`}
          >
            <span className="relative block aspect-[3/2] overflow-hidden bg-secondary">
              <img
                src={option.image}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]"
              />
              {selected && (
                <span className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
                  <Check size={14} strokeWidth={2.5} />
                </span>
              )}
            </span>
            <span className="block px-3 py-2.5 text-[12px] font-semibold text-foreground">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function PrefsSection({ title, hint, children }) {
  return (
    <div className={`${cardCls} p-5 sm:p-6`}>
      <div className="mb-3">
        <div className="font-semibold text-[15px] text-foreground">{title}</div>
        {hint && <div className="text-[12px] text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function useStylePrefs() {
  const [prefs, setPrefs] = useState(null);
  const [journey, setJourney] = useState(null);
  const [options, setOptions] = useState(FALLBACK_OPTIONS);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let on = true;
    api.stylePrefs()
      .then((d) => { if (on) { setPrefs(d.prefs); setJourney(d.journey || null); setOptions({ ...FALLBACK_OPTIONS, ...(d.options || {}) }); } })
      .catch(() => {})
      .finally(() => on && setLoading(false));
    return () => { on = false; };
  }, []);
  const save = async (patch) => {
    const d = await api.stylePrefsSave(patch);
    setPrefs(d.prefs);
    if (d.journey) setJourney(d.journey);
    return d;
  };
  return { prefs, journey, options, loading, save, setPrefs };
}

export function StylePrefsView({ onBack }) {
  const { prefs, journey, options, loading, save } = useStylePrefs();
  const [draft, setDraft] = useState(null);
  const [jDraft, setJDraft] = useState(null);
  const [jCompleted, setJCompleted] = useState(false);
  const [jAwarded, setJAwarded] = useState(false);
  const [cats, setCats] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (prefs && !draft) setDraft(prefs); }, [prefs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (journey && !jDraft) {
      setJDraft({ tenure: journey.tenure || "", discovery: journey.discovery || "",
                  shop_frequency: journey.shop_frequency || "", feedback: journey.feedback || "" });
      setJCompleted(!!journey.completed);
    }
  }, [journey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api.products({ limit: 1 }).then((d) => setCats((d.categories || []).map((c) => c.name))).catch(() => {});
  }, []);

  const flip = (key, v) => setDraft((d) => {
    const list = d[key] || [];
    return { ...d, [key]: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] };
  });
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const submit = async () => {
    setSaving(true); setError(""); setSaved(false);
    try {
      // Journey section is optional: it rides along with the same save, but
      // the style fields above save fine even if it's untouched.
      const d = await save(jDraft ? { ...draft, journey: jDraft } : draft);
      if (d?.journey) setJCompleted(!!d.journey.completed);
      if (d?.journey_awarded) setJAwarded(true);
      setSaved(true);
      try { sessionStorage.removeItem(LATER_KEY); } catch { /* private mode */ }
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  if (loading || !draft) {
    return (
      <div className="max-w-2xl mx-auto py-10">
        <div className="h-8 w-56 bg-secondary rounded animate-pulse mb-6" />
        <div className="space-y-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 bg-secondary rounded animate-pulse" />)}</div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto animate-in fade-in duration-300 pb-24">
      <button onClick={onBack} className="text-[13px] text-muted-foreground hover:text-foreground mb-5 inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        ← Back
      </button>
      <h1 className="font-serif text-3xl text-foreground mb-2">Style Preferences</h1>
      <p className="text-[13px] text-muted-foreground leading-relaxed mb-8 max-w-lg">
        Tell us how you like to dress and we'll style your weekly picks around
        it. You can change any of this — or opt out — at any time.
      </p>

      <div className="space-y-4">
        <div className={`${cardCls} p-5 sm:p-6 border-l-2 border-l-primary`}>
          <div>
            <div className="font-semibold text-[15px] text-foreground">Weekly picks are managed in the Style Quiz</div>
            <div className="text-[12px] text-muted-foreground mt-0.5">Finish the quiz and choose “Also send me weekly picks based on this” to turn them on. You can switch them off from Profile.</div>
          </div>
        </div>

        <PrefsSection title="Clothing size" hint="Used for 'Recommended in Your Size' — private to you.">
          <div className="flex flex-wrap gap-2">
            {options.sizes.map((s) => (
              <Chip key={s} on={draft.size === s} onClick={() => set({ size: draft.size === s ? "" : s })} testId={`sfy-size-${s}`}>{s}</Chip>
            ))}
          </div>
        </PrefsSection>

        <PrefsSection title="Preferred fit">
          <div className="flex flex-wrap gap-2">
            {options.fits.map((f) => (
              <Chip key={f} on={draft.fit === f} onClick={() => set({ fit: draft.fit === f ? "" : f })} testId={`sfy-fit-${f.replace(/\s+/g, "-")}`}>{f}</Chip>
            ))}
          </div>
        </PrefsSection>

        {options.colours.length > 0 && (
          <PrefsSection title="Favourite colours" hint="Pick as many as you like.">
            <div className="flex flex-wrap gap-2">
              {options.colours.map((c) => (
                <Chip key={c} on={(draft.colours || []).includes(c)} onClick={() => flip("colours", c)} testId={`sfy-colour-${c.replace(/\s+/g, "-")}`}>{c}</Chip>
              ))}
            </div>
          </PrefsSection>
        )}

        <PrefsSection title="Plain or Prints" hint="Choose one or both — whichever feels most like you.">
          <VisualChoiceGrid
            field="print_preferences"
            allowed={options.print_preferences}
            values={draft.print_preferences}
            onToggle={(value) => flip("print_preferences", value)}
            columns="grid-cols-2"
          />
        </PrefsSection>

        <PrefsSection title="Color Shades" hint="Choose the specific shades you reach for most.">
          <VisualChoiceGrid
            field="colour_shades"
            allowed={options.colour_shades}
            values={draft.colour_shades}
            onToggle={(value) => flip("colour_shades", value)}
            columns="grid-cols-3 sm:grid-cols-4"
          />
        </PrefsSection>

        <PrefsSection title="Fabrics" hint="Select every texture and material you enjoy wearing.">
          <VisualChoiceGrid
            field="fabrics"
            allowed={options.fabrics}
            values={draft.fabrics}
            onToggle={(value) => flip("fabrics", value)}
            columns="grid-cols-2 sm:grid-cols-3"
          />
        </PrefsSection>

        {cats.length > 0 && (
          <PrefsSection title="Preferred categories" hint="We'll lean your picks toward these.">
            <div className="flex flex-wrap gap-2">
              {cats.map((c) => (
                <Chip key={c} on={(draft.categories || []).includes(c)} onClick={() => flip("categories", c)} testId={`sfy-cat-${c.replace(/\s+/g, "-")}`}>{c}</Chip>
              ))}
            </div>
          </PrefsSection>
        )}

        <PrefsSection title="What do you dress for?" hint="Workwear, casual, occasionwear or activewear — choose all that apply.">
          <div className="flex flex-wrap gap-2">
            {options.interests.map((i) => (
              <Chip key={i} on={(draft.interests || []).includes(i)} onClick={() => flip("interests", i)} testId={`sfy-int-${i}`}>{i}</Chip>
            ))}
          </div>
        </PrefsSection>

        {cats.length > 0 && (
          <PrefsSection title="Rather not see" hint="Styles we should leave out of your picks.">
            <div className="flex flex-wrap gap-2">
              {cats.map((c) => (
                <Chip key={c} on={(draft.avoid || []).includes(c)} onClick={() => flip("avoid", c)} testId={`sfy-avoid-${c.replace(/\s+/g, "-")}`}>{c}</Chip>
              ))}
            </div>
          </PrefsSection>
        )}

        <PrefsSection title="How often?">
          <div className="flex flex-wrap gap-2">
            {options.frequencies.map((f) => (
              <Chip key={f} on={draft.frequency === f} onClick={() => set({ frequency: f })} testId={`sfy-freq-${f}`}>{FREQ_LABEL[f] || f}</Chip>
            ))}
          </div>
        </PrefsSection>

        <PrefsSection title="Notifications & data">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="text-[13px] text-foreground">Push notification when new picks land</div>
              <Toggle on={!!draft.notify_push} onChange={(v) => set({ notify_push: v })} testId="sfy-notify-push" label="Push notifications" />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="text-[13px] text-foreground">Email me my weekly picks</div>
              <Toggle on={!!draft.notify_email} onChange={(v) => set({ notify_email: v })} testId="sfy-notify-email" label="Email notifications" />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[13px] text-foreground">Use my shopping activity</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">Let your wishlist and purchases shape the picks. Switch off any time — your picks then use only what you've told us here.</div>
              </div>
              <Toggle on={!!draft.use_activity} onChange={(v) => set({ use_activity: v })} testId="sfy-use-activity" label="Use my shopping activity" />
            </div>
          </div>
        </PrefsSection>

        {/* ---- About your Vivo journey (merged from the old "Help us dress
             you better" survey). Optional & skippable independently of the
             style fields above; +30 pts once all three selects are answered. */}
        {jDraft && (
          <div data-testid="sfy-journey" className="pt-6 mt-2 border-t border-border">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <div className="font-serif text-xl text-foreground">About your Vivo journey</div>
                <div className="text-[12px] text-muted-foreground mt-1 max-w-md">
                  Four quick questions about you and Vivo — totally optional, and
                  separate from your style preferences above.
                </div>
              </div>
              {jCompleted ? (
                <span data-testid="sfy-journey-done" className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-primary-ink shrink-0 mt-1">
                  <Check size={12} /> Completed
                </span>
              ) : (
                <span data-testid="sfy-journey-pts" className="inline-flex items-center px-2 py-1 bg-primary-ink text-primary-foreground text-[10px] font-bold uppercase tracking-wider rounded-sm shrink-0">
                  +30 points
                </span>
              )}
            </div>
            <div className="space-y-4">
              <PrefsSection title="How long have you been shopping with Vivo?">
                <div className="flex flex-wrap gap-2">
                  {(options.journey?.tenures || []).map((t) => (
                    <Chip key={t} on={jDraft.tenure === t}
                      onClick={() => setJDraft((j) => ({ ...j, tenure: j.tenure === t ? "" : t }))}
                      testId={`sfy-journey-tenure-${t.replace(/[^a-zA-Z0-9]+/g, "-")}`}>{t}</Chip>
                  ))}
                </div>
              </PrefsSection>
              <PrefsSection title="How did you discover Vivo?">
                <div className="flex flex-wrap gap-2">
                  {(options.journey?.discoveries || []).map((t) => (
                    <Chip key={t} on={jDraft.discovery === t}
                      onClick={() => setJDraft((j) => ({ ...j, discovery: j.discovery === t ? "" : t }))}
                      testId={`sfy-journey-disc-${t.replace(/[^a-zA-Z0-9]+/g, "-")}`}>{t}</Chip>
                  ))}
                </div>
              </PrefsSection>
              <PrefsSection title="Roughly how often do you shop for clothing?" hint="Anywhere — not just Vivo.">
                <div className="flex flex-wrap gap-2">
                  {(options.journey?.shop_frequencies || []).map((t) => (
                    <Chip key={t} on={jDraft.shop_frequency === t}
                      onClick={() => setJDraft((j) => ({ ...j, shop_frequency: j.shop_frequency === t ? "" : t }))}
                      testId={`sfy-journey-shopfreq-${t.replace(/[^a-zA-Z0-9]+/g, "-")}`}>{t}</Chip>
                  ))}
                </div>
              </PrefsSection>
              <PrefsSection title="Anything you wish Vivo did differently?" hint="Optional — skip it if nothing comes to mind.">
                <textarea data-testid="sfy-journey-feedback" value={jDraft.feedback} maxLength={1000}
                  onChange={(e) => setJDraft((j) => ({ ...j, feedback: e.target.value }))}
                  rows={3} placeholder="Tell us anything…"
                  className="w-full rounded border border-border bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary resize-none" />
              </PrefsSection>
            </div>
          </div>
        )}
      </div>

      {jAwarded && (
        <div data-testid="sfy-journey-awarded" className="mt-4 text-[13px] text-primary-ink inline-flex items-center gap-1.5">
          <Sparkles size={14} /> +30 points added — thanks for telling us about your Vivo journey.
        </div>
      )}
      {error && <div className="mt-4 text-[13px] text-destructive">{error}</div>}
      <div className="mt-6 flex items-center gap-3">
        <button data-testid="sfy-save" onClick={submit} disabled={saving}
          className="px-8 bg-primary text-primary-foreground h-11 rounded font-medium text-[14px] inline-flex items-center gap-2 hover:opacity-90 transition-all active:scale-[0.98] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2">
          {saving ? "Saving…" : "Save preferences"}
        </button>
        {saved && <span data-testid="sfy-saved" className="text-[13px] text-primary-ink inline-flex items-center gap-1"><Check size={14} /> Saved</span>}
      </div>
    </div>
  );
}

/* ---------------- Profile section ---------------- */

export function StylePrefsProfileCard({ onOpenPrefs }) {
  const { prefs, loading, save } = useStylePrefs();
  const [busy, setBusy] = useState(false);
  if (loading || !prefs) return null;
  const toggle = async (v) => {
    setBusy(true);
    try { await save({ opted_in: v }); } catch { /* keep old state */ }
    setBusy(false);
  };
  const bits = [
    prefs.size && `Size ${prefs.size}`,
    prefs.fit,
    (prefs.colours || []).slice(0, 3).join(", "),
    (prefs.print_preferences || []).join(" & "),
    (prefs.fabrics || []).slice(0, 2).join(", "),
    (prefs.interests || []).slice(0, 2).join(" · "),
  ].filter(Boolean);
  return (
    <div data-testid="profile-style-prefs" className={`${cardCls} p-5 sm:p-6`}>
      <div className="flex items-start justify-between gap-4 mb-1">
        <div>
          <div className="font-semibold text-[15px] text-foreground">Style Preferences</div>
          <div className="text-[12px] text-muted-foreground mt-0.5">Weekly Styled for You recommendations</div>
        </div>
        <Toggle on={!!prefs.opted_in} onChange={toggle} testId="profile-sfy-toggle" label="Weekly Styled for You recommendations" />
      </div>
      {bits.length > 0 && (
        <div className="text-[12px] text-muted-foreground mt-2 truncate">{bits.join(" · ")}</div>
      )}
      <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
        You can change your preferences or opt out at any time.
      </p>
      <button data-testid="profile-sfy-edit" onClick={onOpenPrefs} disabled={busy}
        className="mt-3 text-[13px] font-medium text-primary-ink hover:underline underline-offset-2 inline-flex items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        Edit style preferences <ArrowRight size={13} />
      </button>
    </div>
  );
}
