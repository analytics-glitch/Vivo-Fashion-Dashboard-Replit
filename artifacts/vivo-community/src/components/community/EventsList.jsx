import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Clock, Hourglass, Lock, MapPin, ArrowRight } from "lucide-react";
import { api } from "@/lib/api";
import { NewsCover } from "./NewsSection";
import { cardCls } from "./ui";
import EventSpots, { evImgUrl } from "./EventSpots";

/* =============================================================================
   EVENTS — chronological "what's on" grid for the Community tab.
   Thumbnails are browse-only, exactly like the Shop: photo, title, date,
   venue and a live "18 of 30 spots taken" indicator. Tapping opens the
   event detail page, where the full story and the RSVP live. Server events
   (api.events) carry pre-formatted EAT labels + public spot counts;
   live challenge deadlines (api.challenges) are woven in client-side as
   full-width entries so the list is one honest calendar.
   ========================================================================== */

/* Challenge deadlines ride the same calendar as lightweight entries —
   live challenges from the API, open ones only. */
function challengeEntries(items) {
  const out = [];
  for (const c of items || []) {
    if (c.closed || !c.deadline) continue;
    const d = new Date(c.deadline);
    if (Number.isNaN(d.getTime())) continue;
    out.push({
      kind: "challenge",
      id: `challenge-${c.id}`,
      challengeId: c.id,
      title: `Last day to enter ${c.title}`,
      points: c.points,
      date: d,
      date_label: d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }),
      month_key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      month_label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
    });
  }
  return out;
}

/* Compact browse-only thumbnail. All booking actions live on the detail
   page — the card only tells the member where things stand. */
function EventThumb({ ev, onOpen }) {
  const [imgFailed, setImgFailed] = useState(false);
  const src = evImgUrl(ev);
  const mine = ev.my_rsvp?.status;

  return (
    <button
      data-testid={`event-card-${ev.id}`}
      onClick={() => onOpen?.(ev.id)}
      className={`${cardCls} overflow-hidden text-left w-full flex flex-col group transition-transform hover:-translate-y-0.5 duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
    >
      <div className="relative aspect-[3/2] overflow-hidden bg-secondary w-full">
        {src && !imgFailed ? (
          <img
            src={src}
            alt={ev.title}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <NewsCover article={{ image: null, cover: ev.cover }} size="md" className="h-full" />
        )}
        {ev.gate && (
          <span className="absolute top-3 left-3 inline-flex items-center gap-1 bg-foreground/85 text-background text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded">
            <Lock size={10} strokeWidth={2} /> {ev.gate.label}
          </span>
        )}
        {mine === "confirmed" && (
          <span
            data-testid={`going-${ev.id}`}
            className="absolute top-3 right-3 inline-flex items-center gap-1 bg-primary text-primary-foreground text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded"
          >
            <Check size={10} strokeWidth={2.5} /> You&apos;re in
          </span>
        )}
        {mine === "waitlisted" && (
          <span
            data-testid={`waitlisted-${ev.id}`}
            className="absolute top-3 right-3 inline-flex items-center gap-1 bg-background/90 text-foreground border border-border text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded"
          >
            <Hourglass size={10} strokeWidth={2} /> #{ev.my_rsvp.position} on waitlist
          </span>
        )}
      </div>

      <div className="p-4 sm:p-5 flex flex-col gap-1.5 flex-grow w-full">
        <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink">{ev.kicker}</div>
        <h3 className="font-serif text-[17px] leading-snug text-foreground">{ev.title}</h3>
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Clock size={12} strokeWidth={1.5} className="shrink-0" />
          <span className="truncate">{ev.date_label} · {ev.time_label}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground mb-1.5">
          <MapPin size={12} strokeWidth={1.5} className="shrink-0" />
          <span className="truncate">{ev.venue}</span>
        </div>
        <div className="mt-auto pt-1.5">
          <EventSpots ev={ev} />
        </div>
      </div>
    </button>
  );
}

/* Slim full-width row for a challenge deadline — same calendar, lighter weight. */
function ChallengeDeadlineCard({ entry, onEnterChallenge }) {
  return (
    <div data-testid={`event-card-${entry.id}`} className={`${cardCls} p-4 sm:p-5 flex items-center gap-4 sm:col-span-2`}>
      <div className="w-1 self-stretch rounded-full bg-primary shrink-0" aria-hidden="true" />
      <div className="flex-grow min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1">Challenge deadline</div>
        <div className="font-serif text-[16px] leading-snug text-foreground">{entry.title}</div>
        <div className="text-[12px] text-muted-foreground mt-1">
          {entry.date_label} · Earn {entry.points} pts when published
        </div>
      </div>
      <button
        data-testid={`enter-${entry.id}`}
        onClick={() => onEnterChallenge?.(entry.challengeId)}
        className="shrink-0 inline-flex items-center gap-1.5 bg-background border border-border text-foreground hover:bg-secondary transition-colors text-[13px] font-medium px-4 h-10 rounded active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        Enter now <ArrowRight size={14} />
      </button>
    </div>
  );
}

export default function EventsList({ onEnterChallenge, onOpenEvent }) {
  const [items, setItems] = useState(null);   // null = loading
  const [chal, setChal] = useState([]);
  const [loadErr, setLoadErr] = useState("");

  const load = useCallback(() => {
    setLoadErr("");
    api.events()
      .then((d) => setItems(d.items || []))
      .catch((e) => { setItems([]); setLoadErr(e.message || "Events couldn't load"); });
    api.challenges()
      .then((d) => setChal(d.items || []))
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const months = useMemo(() => {
    if (!items) return [];
    const all = [
      ...items.map((ev) => ({ kind: "event", sort: ev.starts_at, ev })),
      ...challengeEntries(chal).map((c) => ({ kind: "challenge", sort: c.date.toISOString(), c })),
    ].sort((a, b) => (a.sort < b.sort ? -1 : 1));
    const out = [];
    for (const row of all) {
      const key = row.kind === "event" ? row.ev.month_key : row.c.month_key;
      const label = row.kind === "event" ? row.ev.month_label : row.c.month_label;
      let bucket = out[out.length - 1];
      if (!bucket || bucket.key !== key) {
        bucket = { key, label, rows: [] };
        out.push(bucket);
      }
      bucket.rows.push(row);
    }
    return out;
  }, [items, chal]);

  if (items === null) {
    return (
      <div data-testid="events-loading" className="max-w-3xl grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-72 rounded bg-secondary animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div data-testid="events-list" className="max-w-3xl space-y-10">
      <p className="text-muted-foreground text-sm leading-relaxed max-w-2xl">
        Styling evenings, workshops and celebrations — in our stores, for our members.
        Every event has a fixed number of spots; tap one for the full story and to save yours.
      </p>

      {loadErr && (
        <div className={`${cardCls} p-6 text-center`}>
          <p className="text-[14px] text-muted-foreground mb-4">{loadErr}</p>
          <button
            data-testid="events-retry"
            onClick={() => { setItems(null); load(); }}
            className="bg-foreground text-background text-[13px] font-medium px-5 h-10 rounded hover:bg-foreground/90 transition-colors active:scale-[0.98]"
          >
            Try again
          </button>
        </div>
      )}

      {!loadErr && months.length === 0 && (
        <div className={`${cardCls} p-8 text-center text-[14px] text-muted-foreground leading-relaxed`}>
          Nothing on the calendar right now — new gatherings land here first, so check back soon.
        </div>
      )}

      {months.map((mo) => (
        <section key={mo.key} className="relative">
          <h3
            data-testid={`month-${mo.key}`}
            className="block text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-4 pt-1 bg-background"
          >
            {mo.label}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
            {mo.rows.map((row) =>
              row.kind === "event" ? (
                <EventThumb key={row.ev.id} ev={row.ev} onOpen={onOpenEvent} />
              ) : (
                <ChallengeDeadlineCard key={row.c.id} entry={row.c} onEnterChallenge={onEnterChallenge} />
              )
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
