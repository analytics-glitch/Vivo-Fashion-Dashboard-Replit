import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft, ArrowRight, CalendarPlus, Check, Clock, Hourglass, Lock, MapPin, Navigation,
} from "lucide-react";
import { api } from "@/lib/api";
import { NewsCover } from "./NewsSection";
import { newsPageId } from "./newsData";
import { cardCls } from "./ui";
import EventSpots, { evImgUrl } from "./EventSpots";

/* =============================================================================
   EVENT DETAIL — the "product page" for an event, mirroring how the Shop
   works: thumbnails browse, the detail page acts. Hero image, the full
   story, when/where (EAT) with a directions link, what to expect, the host,
   live capacity — and the RSVP itself. When an event is full the RSVP
   becomes "Join the waitlist"; cancelling a confirmed spot hands it to the
   first member in the queue (the server emails them).
   ========================================================================== */

/* Client-side ICS so "Add to my calendar" works offline of any provider.
   Times convert to UTC (Z) from the event's +03:00 ISO stamps. */
function downloadIcs(ev) {
  const dt = (iso) =>
    new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const esc = (s) =>
    String(s || "")
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vivo Fashion Group//Community//EN",
    "BEGIN:VEVENT",
    `UID:vivo-community-${ev.id}@vivofashiongroup.com`,
    `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(ev.starts_at)}`,
    `DTEND:${dt(ev.ends_at)}`,
    `SUMMARY:${esc(ev.title)}`,
    `LOCATION:${esc(`${ev.venue}, ${ev.area}`)}`,
    `DESCRIPTION:${esc(ev.blurb)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `vivo-${ev.id}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const initialsOf = (name) =>
  String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || "")
    .join("") || "V";

function BackBar({ onBack }) {
  return (
    <button
      data-testid="event-detail-back"
      onClick={onBack}
      className="inline-flex items-center gap-2 text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors mb-6 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <ArrowLeft size={16} strokeWidth={1.5} /> Back to what&apos;s on
    </button>
  );
}

export default function EventDetail({ eventId, onBack, onOpenPage }) {
  const [items, setItems] = useState(null); // null = loading
  const [loadErr, setLoadErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [actErr, setActErr] = useState("");
  const [imgFailed, setImgFailed] = useState(false);

  const load = useCallback(() => {
    setLoadErr("");
    api.events()
      .then((d) => setItems(d.items || []))
      .catch((e) => { setItems([]); setLoadErr(e.message || "This event couldn't load"); });
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setNote(""); setActErr(""); setImgFailed(false); }, [eventId]);

  const ev = (items || []).find((e) => e.id === eventId);

  const act = async (fn) => {
    setBusy(true);
    setNote("");
    setActErr("");
    try {
      const res = await fn();
      const d = await api.events(); // refresh counts + my_rsvp together
      setItems(d.items || []);
      if (res?.message) setNote(res.message);
    } catch (e) {
      setActErr(e.message || "That didn't go through — try again");
    } finally {
      setBusy(false);
    }
  };

  if (items === null) {
    return (
      <div data-testid="event-detail-loading" className="max-w-2xl mx-auto">
        <BackBar onBack={onBack} />
        <div className="aspect-[3/2] rounded bg-secondary animate-pulse mb-6" />
        <div className="h-8 w-3/4 rounded bg-secondary animate-pulse mb-4" />
        <div className="h-4 w-1/2 rounded bg-secondary animate-pulse" />
      </div>
    );
  }

  if (loadErr && !ev) {
    return (
      <div className="max-w-2xl mx-auto">
        <BackBar onBack={onBack} />
        <div data-testid="event-detail-error" className={`${cardCls} p-8 text-center`}>
          <p className="text-[14px] text-muted-foreground mb-4">{loadErr}</p>
          <button
            data-testid="event-detail-retry"
            onClick={() => { setItems(null); load(); }}
            className="bg-foreground text-background text-[13px] font-medium px-5 h-10 rounded hover:bg-foreground/90 transition-colors active:scale-[0.98]"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!ev) {
    return (
      <div className="max-w-2xl mx-auto">
        <BackBar onBack={onBack} />
        <div data-testid="event-detail-missing" className={`${cardCls} p-8 text-center text-[14px] text-muted-foreground leading-relaxed`}>
          This event isn&apos;t on the calendar any more — it may have already happened.
        </div>
      </div>
    );
  }

  const mine = ev.my_rsvp?.status || null;
  const locked = ev.gate && !ev.gate.unlocked;
  const src = evImgUrl(ev);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${ev.venue}, ${ev.area}`)}`;

  return (
    <div data-testid={`event-detail-${ev.id}`} className="max-w-2xl mx-auto">
      <BackBar onBack={onBack} />

      {/* Hero */}
      <div className="relative aspect-[3/2] rounded overflow-hidden bg-secondary mb-6">
        {src && !imgFailed ? (
          <img
            src={src}
            alt={ev.title}
            onError={() => setImgFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <NewsCover article={{ image: null, cover: ev.cover }} size="lg" className="h-full" />
        )}
        {ev.gate && (
          <span className="absolute top-4 left-4 inline-flex items-center gap-1.5 bg-foreground/85 text-background text-[10px] font-bold uppercase tracking-wider px-2.5 py-1.5 rounded">
            <Lock size={11} strokeWidth={2} /> {ev.gate.label}
          </span>
        )}
      </div>

      <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-2">{ev.kicker}</div>
      <h1 className="font-serif text-3xl sm:text-4xl leading-tight text-foreground mb-3">{ev.title}</h1>
      <p className="text-[15px] text-muted-foreground leading-relaxed mb-6">{ev.blurb}</p>

      {/* When & where */}
      <div className={`${cardCls} divide-y divide-border mb-6`}>
        <div className="p-4 sm:p-5 flex items-start gap-3">
          <Clock size={16} strokeWidth={1.5} className="text-primary-ink shrink-0 mt-0.5" />
          <div>
            <div className="text-[14px] font-medium text-foreground">{ev.date_label} · {ev.time_label}</div>
            <div className="text-[12px] text-muted-foreground mt-0.5">East Africa Time — as your phone shows it in Nairobi</div>
          </div>
        </div>
        <div className="p-4 sm:p-5 flex items-start gap-3">
          <MapPin size={16} strokeWidth={1.5} className="text-primary-ink shrink-0 mt-0.5" />
          <div className="flex-grow min-w-0">
            <div className="text-[14px] font-medium text-foreground">{ev.venue}</div>
            <div className="text-[12px] text-muted-foreground mt-0.5">{ev.area}</div>
          </div>
          <a
            data-testid="event-directions"
            href={mapsUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 inline-flex items-center gap-1.5 bg-background border border-border text-foreground hover:bg-secondary transition-colors text-[12px] font-medium px-3 h-9 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Navigation size={13} strokeWidth={1.5} /> Directions
          </a>
        </div>
        <div className="p-4 sm:p-5">
          <EventSpots ev={ev} size="lg" />
        </div>
      </div>

      {/* RSVP block — the one place booking actions live */}
      <div className={`${cardCls} p-5 sm:p-6 mb-10 space-y-3`}>
        {locked && mine !== "confirmed" && mine !== "waitlisted" ? (
          <div
            data-testid={`gate-${ev.id}`}
            className="flex items-start gap-2.5 bg-secondary border border-border rounded p-3.5 text-[13px] text-foreground/80 leading-relaxed"
          >
            <Lock size={14} strokeWidth={1.5} className="text-primary-ink shrink-0 mt-0.5" />
            <span>{ev.gate.copy}</span>
          </div>
        ) : mine === "confirmed" ? (
          <>
            <span
              data-testid={`going-${ev.id}`}
              className="inline-flex items-center gap-1.5 bg-primary/10 text-primary-ink border border-primary/20 text-[12px] font-semibold px-3 h-10 rounded"
            >
              <Check size={14} /> You&apos;re in — see you there
            </span>
            <div className="flex flex-wrap items-center gap-3">
              <button
                data-testid={`ics-${ev.id}`}
                onClick={() => downloadIcs(ev)}
                className="inline-flex items-center gap-1.5 bg-background border border-border text-foreground hover:bg-secondary transition-colors text-[13px] font-medium px-4 h-10 rounded active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <CalendarPlus size={14} strokeWidth={1.5} /> Add to my calendar
              </button>
              <button
                data-testid={`cancel-${ev.id}`}
                onClick={() => act(() => api.cancelEventRsvp(ev.id))}
                disabled={busy}
                className="text-[12px] font-medium text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {busy ? "One moment…" : "Can't make it? Free up your spot"}
              </button>
            </div>
          </>
        ) : mine === "waitlisted" ? (
          <>
            <span
              data-testid={`waitlisted-${ev.id}`}
              className="inline-flex items-center gap-1.5 bg-secondary border border-border text-foreground text-[12px] font-semibold px-3 h-10 rounded"
            >
              <Hourglass size={14} strokeWidth={1.5} /> You&apos;re #{ev.my_rsvp.position} on the waitlist
            </span>
            <p className="text-[13px] text-muted-foreground leading-relaxed">
              We&apos;ll email you the moment a spot opens — places go in the order members joined the list.
            </p>
            <button
              data-testid={`leave-waitlist-${ev.id}`}
              onClick={() => act(() => api.cancelEventRsvp(ev.id))}
              disabled={busy}
              className="text-[12px] font-medium text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {busy ? "One moment…" : "Leave the waitlist"}
            </button>
          </>
        ) : ev.full ? (
          <>
            <button
              data-testid={`waitlist-${ev.id}`}
              onClick={() => act(() => api.rsvpEvent(ev.id))}
              disabled={busy}
              className="w-full sm:w-auto bg-foreground text-background hover:bg-foreground/90 transition-colors text-[13px] font-medium px-6 h-11 rounded active:scale-[0.98] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {busy ? "One moment…" : "Join the waitlist"}
            </button>
            <p className="text-[13px] text-muted-foreground leading-relaxed">
              Fully booked — join the waitlist and we&apos;ll email you the moment a spot opens.
            </p>
          </>
        ) : (
          <>
            <button
              data-testid={`rsvp-${ev.id}`}
              onClick={() => act(() => api.rsvpEvent(ev.id))}
              disabled={busy}
              className="w-full sm:w-auto bg-foreground text-background hover:bg-foreground/90 transition-colors text-[13px] font-medium px-6 h-11 rounded active:scale-[0.98] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {busy ? "Saving your spot…" : "I'll be there"}
            </button>
            <p className="text-[13px] text-muted-foreground">
              {ev.spots_left} of {ev.capacity} spots still open — RSVP and one is yours.
            </p>
          </>
        )}

        {note && (
          <p data-testid="event-action-note" className="text-[13px] text-primary-ink font-medium leading-relaxed">{note}</p>
        )}
        {actErr && (
          <p data-testid={`event-error-${ev.id}`} className="text-[13px] text-destructive leading-relaxed">{actErr}</p>
        )}
      </div>

      {/* The full story */}
      {(ev.about || []).length > 0 && (
        <div className="space-y-4 text-[15px] leading-relaxed text-foreground/90 mb-10">
          {ev.about.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}

      {/* What to expect */}
      {(ev.expect || []).length > 0 && (
        <div className="mb-10">
          <h2 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-4">What to expect</h2>
          <ul className="space-y-2.5">
            {ev.expect.map((line, i) => (
              <li key={i} className="flex items-start gap-2.5 text-[14px] text-foreground/90 leading-relaxed">
                <Check size={15} strokeWidth={2} className="text-primary-ink shrink-0 mt-0.5" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Host */}
      {ev.host && (
        <div className={`${cardCls} p-4 sm:p-5 flex items-center gap-4 mb-10`} data-testid="event-host">
          <span className="w-12 h-12 rounded-full bg-foreground text-background flex items-center justify-center font-serif text-lg shrink-0">
            {initialsOf(ev.host.name)}
          </span>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-0.5">Your host</div>
            <div className="text-[14px] font-medium text-foreground">{ev.host.name}</div>
            <div className="text-[12px] text-muted-foreground">{ev.host.role}</div>
          </div>
        </div>
      )}

      {/* Cross-link to the news story behind the event */}
      {ev.news_id && (
        <button
          data-testid="event-news-link"
          onClick={() => onOpenPage?.(newsPageId(ev.news_id))}
          className="w-full bg-secondary border border-border rounded p-5 flex items-center justify-between gap-4 text-left hover:bg-border/40 transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-primary-ink mb-1">From Vivo News</div>
            <div className="font-serif text-[16px] text-foreground leading-snug">Read the story behind this gathering</div>
          </div>
          <ArrowRight size={16} className="text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
        </button>
      )}
    </div>
  );
}
