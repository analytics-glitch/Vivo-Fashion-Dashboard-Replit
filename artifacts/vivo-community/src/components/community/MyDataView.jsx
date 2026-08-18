// My data — the DPA hub. One place where a member can see everything she
// has uploaded (grouped by type), delete individual items, control the
// per-item marketing consent, and ask for a copy of her data or account
// deletion. Copy is deliberately warm and plain: reassurance, not legalese.
//
// Data contract: GET /api/community/mydata → { tryon_photos, tryon_looks,
// designs, messages, style_quiz, surveys, requests }. Deletes reuse the per-type
// routes; consent goes through POST /mydata/consent (forward-only withdraw).
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft, Camera, ClipboardList, Download, Loader2, Lock, MessageSquare,
  Palette, Share2, Sparkles, Trash2, UserX,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthImage, dropAuthImage } from "./authImage";

const cardCls = "bg-card border border-border rounded";
const fmt = (d) => {
  try {
    return new Date(d).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
};

/* Small pieces ------------------------------------------------------- */

function SectionCard({ icon: Icon, title, sub, count, children, testid }) {
  return (
    <div className={`${cardCls} overflow-hidden`} data-testid={testid}>
      <div className="px-5 pt-5 pb-3 flex items-start gap-3">
        <span className="w-9 h-9 rounded bg-secondary flex items-center justify-center shrink-0 mt-0.5">
          <Icon size={16} className="text-primary-ink" />
        </span>
        <div className="flex-grow min-w-0">
          <div className="text-[14px] font-medium text-foreground">
            {title}
            {typeof count === "number" && count > 0 && (
              <span className="ml-2 text-[11px] font-semibold text-muted-foreground">{count}</span>
            )}
          </div>
          <p className="text-[12px] text-muted-foreground leading-relaxed mt-0.5">{sub}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

// Two-tap destructive button — first tap arms, second commits.
function ArmDelete({ id, armed, setArmed, busy, onDelete, label, armedLabel, testid }) {
  const isArmed = armed === id;
  return (
    <button
      type="button"
      data-testid={testid}
      disabled={busy}
      onClick={isArmed ? onDelete : () => setArmed(id)}
      className={`inline-flex items-center gap-1.5 text-[12px] font-medium rounded px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        isArmed ? "text-destructive bg-destructive/10" : "text-muted-foreground hover:text-destructive"
      }`}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
      {isArmed ? armedLabel : label}
    </button>
  );
}

// Per-item marketing consent toggle. Withdrawal is forward-only, and the
// copy says so right where the choice happens.
function ConsentToggle({ on, busy, onChange, testid }) {
  return (
    <button
      type="button"
      data-testid={testid}
      disabled={busy}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      aria-label="Allow Vivo to use this in marketing"
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
        on ? "bg-primary" : "bg-border"
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-background shadow transition-all ${
          on ? "left-[18px]" : "left-0.5"
        }`}
      />
    </button>
  );
}

function Thumb({ path, alt, className }) {
  const url = useAuthImage(path);
  if (!url) return <div className={`${className} bg-secondary animate-pulse`} />;
  return <img src={url} alt={alt} className={`${className} object-cover`} />;
}

/* Main view ----------------------------------------------------------- */

export default function MyDataView({ onBack, onOpenPage }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [armed, setArmed] = useState("");
  const [deletePanel, setDeletePanel] = useState(false);
  const [downloadNote, setDownloadNote] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setData(await api.myData());
      setErr("");
    } catch (ex) {
      setErr(ex.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Every mutation follows the same shape: run, then re-pull the truth.
  const run = async (key, fn, dropPath) => {
    setBusyKey(key);
    setErr("");
    try {
      await fn();
      if (dropPath) dropAuthImage(dropPath);
      await refresh();
    } catch (ex) {
      setErr(ex.message);
    }
    setBusyKey("");
    setArmed("");
  };

  const setConsent = (ctype, cid, ok) =>
    run(`consent-${ctype}-${cid}`, () => api.myDataConsent(ctype, cid, ok));

  const openRequest = (kind) => (data?.requests || []).find(
    (r) => r.kind === kind && (r.status === "open" || r.status === "in_progress"),
  );

  if (loading) {
    return (
      <div className="max-w-xl mx-auto py-16 flex justify-center">
        <Loader2 size={22} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const photos = data?.tryon_photos || [];
  const looks = data?.tryon_looks || [];
  const designs = data?.designs || [];
  const messages = data?.messages || [];
  const quiz = data?.style_quiz;
  const surveys = data?.surveys || [];
  const journey = data?.journey;
  const articleComments = data?.article_comments || [];
  const downloadReq = openRequest("download");
  const deleteReq = openRequest("delete_account");
  const hasAnything = photos.length || looks.length || designs.length || messages.length || quiz || surveys.length || journey || articleComments.length;

  return (
    <div className="max-w-xl mx-auto space-y-4" data-testid="mydata-view">
      <button
        type="button"
        data-testid="mydata-back"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ArrowLeft size={15} /> Back
      </button>

      <div>
        <h1 className="font-serif text-2xl text-foreground">My data</h1>
        <p className="text-[13px] text-muted-foreground leading-relaxed mt-1.5">
          Everything you&apos;ve shared with Vivo, in one place. It&apos;s all yours: delete any of it,
          ask for a copy, and decide — item by item — whether Vivo may use it in marketing.
          The full detail lives in the{" "}
          <button
            type="button"
            onClick={() => onOpenPage?.("privacy")}
            className="font-medium text-primary-ink hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Privacy Policy
          </button>.
        </p>
      </div>

      {err && (
        <p data-testid="mydata-error" className="text-[13px] text-destructive bg-destructive/10 border border-destructive/30 rounded p-3">
          {err}
        </p>
      )}

      {!hasAnything && (
        <div className={`${cardCls} p-6 text-[13px] text-muted-foreground leading-relaxed`} data-testid="mydata-empty">
          Nothing here yet — anything you upload later (try-on photos, designs, messages) will
          appear in this list, ready to manage.
        </div>
      )}

      {/* Try-on photos */}
      {photos.length > 0 && (
        <SectionCard
          icon={Camera}
          title="Try-on photos"
          count={photos.length}
          sub="Used only to create your try-ons. Private — nobody else ever sees them."
          testid="mydata-photos-card"
        >
          <div className="px-5 pb-5 grid grid-cols-4 gap-2.5">
            {photos.map((p) => (
              <div key={p.id} className="relative group" data-testid={`mydata-photo-${p.id}`}>
                <Thumb path={`/tryon/photos/${p.id}/image`} alt="Your try-on photo" className="w-full aspect-[3/4] rounded" />
                <button
                  type="button"
                  data-testid={`mydata-photo-del-${p.id}`}
                  disabled={busyKey === `photo-${p.id}`}
                  onClick={
                    armed === `photo-${p.id}`
                      ? () => run(`photo-${p.id}`, () => api.tryonDeletePhoto(p.id), `/tryon/photos/${p.id}/image`)
                      : () => setArmed(`photo-${p.id}`)
                  }
                  aria-label={armed === `photo-${p.id}` ? "Tap again to delete this photo" : "Delete this photo"}
                  className={`absolute top-1 right-1 w-7 h-7 rounded-full flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    armed === `photo-${p.id}` ? "bg-destructive text-background" : "bg-background/85 text-foreground hover:text-destructive"
                  }`}
                >
                  {busyKey === `photo-${p.id}` ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Try-on looks */}
      {looks.length > 0 && (
        <SectionCard
          icon={Sparkles}
          title="Try-on looks"
          count={looks.length}
          sub="Private by default. Deleting a shared look removes it from the community feed immediately."
          testid="mydata-looks-card"
        >
          <div className="divide-y divide-border border-t border-border">
            {looks.map((l) => (
              <div key={l.id} className="px-5 py-3.5 flex items-center gap-3.5" data-testid={`mydata-look-${l.id}`}>
                {l.status === "done" ? (
                  <Thumb path={`/tryon/looks/${l.id}/image`} alt={l.product_name} className="w-12 h-16 rounded shrink-0" />
                ) : (
                  <div className="w-12 h-16 rounded bg-secondary shrink-0" />
                )}
                <div className="flex-grow min-w-0">
                  <div className="text-[13px] font-medium text-foreground truncate">{l.product_name}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
                    {fmt(l.created_at)}
                    {l.is_shared
                      ? <span className="inline-flex items-center gap-1 text-primary-ink font-semibold"><Share2 size={10} /> In the feed</span>
                      : <span className="inline-flex items-center gap-1"><Lock size={10} /> Private</span>}
                  </div>
                  {l.status === "done" && (
                    <div className="flex items-center gap-2 mt-1.5">
                      <ConsentToggle
                        on={l.marketing_ok}
                        busy={busyKey === `consent-tryon_look-${l.id}`}
                        onChange={(ok) => setConsent("tryon_look", l.id, ok)}
                        testid={`mydata-consent-look-${l.id}`}
                      />
                      <span className="text-[11px] text-muted-foreground leading-tight">
                        {l.marketing_ok ? "Vivo may use this in marketing — switch off anytime" : "Not for marketing use"}
                      </span>
                    </div>
                  )}
                </div>
                <ArmDelete
                  id={`look-${l.id}`}
                  armed={armed}
                  setArmed={setArmed}
                  busy={busyKey === `look-${l.id}`}
                  onDelete={() => run(`look-${l.id}`, () => api.tryonDeleteLook(l.id), `/tryon/looks/${l.id}/image`)}
                  label="Delete"
                  armedLabel="Tap again"
                  testid={`mydata-look-del-${l.id}`}
                />
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Embroidery designs */}
      {designs.length > 0 && (
        <SectionCard
          icon={Palette}
          title="Embroidery designs"
          count={designs.length}
          sub="Part of your personalised orders. The order record itself is kept for the legal retention period — the artwork is yours to remove once the order is finished."
          testid="mydata-designs-card"
        >
          <div className="divide-y divide-border border-t border-border">
            {designs.map((d) => (
              <div key={d.id} className="px-5 py-3.5 flex items-center gap-3.5" data-testid={`mydata-design-${d.id}`}>
                {d.has_design ? (
                  <Thumb path={`/rewards/redemptions/${d.id}/design`} alt="Your design" className="w-12 h-12 rounded shrink-0" />
                ) : (
                  <div className="w-12 h-12 rounded bg-secondary shrink-0 flex items-center justify-center text-[10px] font-serif text-muted-foreground">
                    {d.monogram_text ? d.monogram_text.slice(0, 3) : "—"}
                  </div>
                )}
                <div className="flex-grow min-w-0">
                  <div className="text-[13px] font-medium text-foreground truncate">
                    {d.embroidery_type === "monogram" ? `Monogram “${d.monogram_text}”` : "Uploaded design"} · {d.size || d.sku}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {fmt(d.created_at)} · order {d.status.replace(/_/g, " ")}
                  </div>
                  {d.has_design && (
                    <div className="flex items-center gap-2 mt-1.5">
                      <ConsentToggle
                        on={d.marketing_ok}
                        busy={busyKey === `consent-design-${d.id}`}
                        onChange={(ok) => setConsent("design", d.id, ok)}
                        testid={`mydata-consent-design-${d.id}`}
                      />
                      <span className="text-[11px] text-muted-foreground leading-tight">
                        {d.marketing_ok ? "Vivo may use this in marketing — switch off anytime" : "Not for marketing use"}
                      </span>
                    </div>
                  )}
                </div>
                {d.has_design && (
                  d.design_deletable ? (
                    <ArmDelete
                      id={`design-${d.id}`}
                      armed={armed}
                      setArmed={setArmed}
                      busy={busyKey === `design-${d.id}`}
                      onDelete={() => run(`design-${d.id}`, () => api.deleteRedemptionDesign(d.id), `/rewards/redemptions/${d.id}/design`)}
                      label="Remove artwork"
                      armedLabel="Tap again"
                      testid={`mydata-design-del-${d.id}`}
                    />
                  ) : (
                    <span className="text-[11px] text-muted-foreground text-right leading-tight max-w-[90px]" data-testid={`mydata-design-locked-${d.id}`}>
                      In use for your order
                    </span>
                  )
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Support messages */}
      {messages.length > 0 && (
        <SectionCard
          icon={MessageSquare}
          title="Messages to us"
          count={messages.length}
          sub="Kept while we resolve your query and for up to 24 months after. You can pull back an attachment anytime — the message stays so the conversation makes sense."
          testid="mydata-messages-card"
        >
          <div className="divide-y divide-border border-t border-border">
            {messages.map((msg) => (
              <div key={msg.id} className="px-5 py-3.5 flex items-center gap-3.5" data-testid={`mydata-msg-${msg.id}`}>
                <div className="flex-grow min-w-0">
                  <div className="text-[13px] font-medium text-foreground truncate">{msg.subject || "Message"}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {fmt(msg.created_at)} · {msg.status.replace(/_/g, " ")}
                  </div>
                </div>
                {msg.has_photo && (
                  <ArmDelete
                    id={`msg-${msg.id}`}
                    armed={armed}
                    setArmed={setArmed}
                    busy={busyKey === `msg-${msg.id}`}
                    onDelete={() => run(`msg-${msg.id}`, () => api.deleteContactPhoto(msg.id))}
                    label="Remove attachment"
                    armedLabel="Tap again"
                    testid={`mydata-msg-photo-del-${msg.id}`}
                  />
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Style quiz */}
      {quiz && (
        <SectionCard
          icon={Sparkles}
          title="Style quiz"
          sub="Your answers personalise what you see. Deleting them switches personalisation off — points you earned stay yours."
          testid="mydata-quiz-card"
        >
          <div className="px-5 pb-5 flex items-center justify-between gap-4">
            <div className="text-[12px] text-muted-foreground">
              Completed {fmt(quiz.completed_at)}
              {quiz.shared_at ? " · style DNA shared" : ""}
            </div>
            <ArmDelete
              id="quiz"
              armed={armed}
              setArmed={setArmed}
              busy={busyKey === "quiz"}
              onDelete={() => run("quiz", () => api.deleteStyleQuiz())}
              label="Delete my answers"
              armedLabel="Tap again to delete"
              testid="mydata-quiz-del"
            />
          </div>
        </SectionCard>
      )}

      {/* Survey answers — legacy wave responses + the "About your Vivo
          journey" profile now collected on Style Preferences. */}
      {(surveys.length > 0 || journey) && (
        <SectionCard
          icon={ClipboardList}
          title="Survey answers"
          sub="Your answers guide what we make and stock — always reported in anonymous totals only. Deleting them removes you from those totals; points you earned stay yours."
          testid="mydata-survey-card"
        >
          <div className="px-5 pb-5 flex items-center justify-between gap-4">
            <div className="text-[12px] text-muted-foreground space-y-0.5">
              {surveys.map((s) => (
                <div key={s.wave_key}>{s.title} — completed {fmt(s.completed_at)}</div>
              ))}
              {journey && (
                <div data-testid="mydata-journey-row">
                  About your Vivo journey{journey.completed_at ? ` — completed ${fmt(journey.completed_at)}` : " — in progress"}
                </div>
              )}
            </div>
            <ArmDelete
              id="survey"
              armed={armed}
              setArmed={setArmed}
              busy={busyKey === "survey"}
              onDelete={() => run("survey", () => api.surveyDataDelete())}
              label="Delete my answers"
              armedLabel="Tap again to delete"
              testid="mydata-survey-del"
            />
          </div>
        </SectionCard>
      )}

      {/* Campaign article comments — hers only; deleting removes them from
          the article page (points already earned stay, same contract). */}
      {articleComments.length > 0 && (
        <SectionCard
          icon={ClipboardList}
          title="Article comments"
          sub="Comments you've posted on campaign stories. Deleting one removes it from the article; points you earned stay yours."
          testid="mydata-article-comments-card"
        >
          <div className="px-5 pb-5 space-y-3">
            {articleComments.map((c) => (
              <div key={c.id} data-testid={`mydata-article-comment-${c.id}`} className="flex items-center justify-between gap-4">
                <div className="text-[12px] text-muted-foreground min-w-0">
                  <span className="text-foreground">"{c.body.length > 80 ? `${c.body.slice(0, 80)}…` : c.body}"</span>
                  {" "}on {c.title} — {fmt(c.created_at)}
                </div>
                <ArmDelete
                  id={`acomment-${c.id}`}
                  armed={armed}
                  setArmed={setArmed}
                  busy={busyKey === `acomment-${c.id}`}
                  onDelete={() => run(`acomment-${c.id}`, () => api.articleDeleteComment(c.id))}
                  label="Delete"
                  armedLabel="Tap again"
                  testid={`mydata-article-comment-del-${c.id}`}
                />
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Download my data */}
      <SectionCard
        icon={Download}
        title="Download my data"
        sub="We'll gather everything we hold about you into a readable copy and send it to you — within the timelines Kenya's Data Protection Act sets."
        testid="mydata-download-card"
      >
        <div className="px-5 pb-5">
          {downloadReq ? (
            <p className="text-[12px] font-medium text-primary-ink bg-primary/10 border border-primary/20 rounded p-3" data-testid="mydata-request-chip-download">
              Requested on {fmt(downloadReq.created_at)} — our team is on it and will be in touch.
            </p>
          ) : (
            <>
              <button
                type="button"
                data-testid="mydata-download-btn"
                disabled={busyKey === "download"}
                onClick={() => run("download", async () => { await api.myDataRequest("download"); setDownloadNote(true); })}
                className="h-10 px-4 rounded bg-secondary text-[13px] font-medium text-foreground hover:bg-secondary/70 transition-colors inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {busyKey === "download" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Request a copy of my data
              </button>
              {downloadNote && <p className="text-[11px] text-muted-foreground mt-2">Request sent — you can keep using the app as normal.</p>}
            </>
          )}
        </div>
      </SectionCard>

      {/* Delete account */}
      <SectionCard
        icon={UserX}
        title="Close my account"
        sub="Your membership, your call — here's exactly what closing it means."
        testid="mydata-delete-account-card"
      >
        <div className="px-5 pb-5">
          {deleteReq ? (
            <p className="text-[12px] font-medium text-foreground bg-secondary border border-border rounded p-3" data-testid="mydata-request-chip-delete_account">
              Requested on {fmt(deleteReq.created_at)} — our team will confirm with you by SMS before anything is deleted.
              Changed your mind? Just message us.
            </p>
          ) : deletePanel ? (
            <div className="space-y-3" data-testid="mydata-delete-account-confirm">
              <div className="text-[12px] text-muted-foreground leading-relaxed space-y-2">
                <p className="text-foreground/85 font-medium">Closing your account removes:</p>
                <p>
                  Your profile, phone number and email · your try-on photos and looks · your style quiz ·
                  your points, tier and rewards · your place in the community.
                </p>
                <p className="text-foreground/85 font-medium">What the law asks us to keep:</p>
                <p>
                  Records of purchases and redemptions, for as long as tax and consumer rules require
                  (typically up to five years in Kenya). They&apos;re kept securely and no longer linked to a
                  live profile.
                </p>
                <p>We&apos;ll confirm with you by SMS before anything is deleted — nothing happens silently.</p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="mydata-delete-account-btn"
                  disabled={busyKey === "delete_account"}
                  onClick={() => run("delete_account", () => api.myDataRequest("delete_account"))}
                  className="h-10 px-4 rounded bg-destructive text-background text-[13px] font-medium hover:opacity-90 transition-opacity inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                >
                  {busyKey === "delete_account" ? <Loader2 size={14} className="animate-spin" /> : <UserX size={14} />}
                  Request account deletion
                </button>
                <button
                  type="button"
                  data-testid="mydata-delete-account-cancel"
                  onClick={() => setDeletePanel(false)}
                  className="h-10 px-4 rounded bg-secondary text-[13px] font-medium text-foreground hover:bg-secondary/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Keep my account
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-testid="mydata-delete-account-open"
              onClick={() => setDeletePanel(true)}
              className="text-[13px] font-medium text-muted-foreground hover:text-destructive transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              I&apos;d like to close my account…
            </button>
          )}
        </div>
      </SectionCard>

      <p className="text-[11px] text-muted-foreground leading-relaxed text-center pb-4">
        Questions about any of this? <button type="button" onClick={() => onOpenPage?.("contact")} className="font-medium text-primary-ink hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">Message us</button> — a real person reads every one.
      </p>
    </div>
  );
}
