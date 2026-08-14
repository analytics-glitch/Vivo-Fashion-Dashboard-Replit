import React from "react";

/* =============================================================================
   EVENT CAPACITY INDICATOR — shared by the events grid, the event detail
   page and the profile mirror. Spot counts are public by product decision
   ("18 of 30 spots taken"); the server folds its demo-layer baseline into
   `taken`, so the client only ever renders the numbers it is given.
   ========================================================================== */

/** Event images ship inside the SPA bundle at public/events/<file>. */
export const evImgUrl = (ev) =>
  ev?.image ? `${import.meta.env.BASE_URL}events/${ev.image}` : null;

/** One-line capacity summary, with urgency as an event fills. */
export function spotsLine(ev) {
  const left = ev.spots_left ?? 0;
  if (ev.full) return "Fully booked";
  if (left <= 6) return `Only ${left} spot${left === 1 ? "" : "s"} left`;
  return `${ev.taken} of ${ev.capacity} spots taken`;
}

export default function EventSpots({ ev, size = "sm" }) {
  const pct = ev.capacity
    ? Math.min(100, Math.round(((ev.taken ?? 0) / ev.capacity) * 100))
    : 0;
  const urgent = !ev.full && (ev.spots_left ?? 0) <= 6;
  return (
    <div data-testid={`spots-${ev.id}`} className="w-full">
      <div className={`flex items-center justify-between gap-3 ${size === "lg" ? "mb-1.5" : "mb-1"}`}>
        <span
          className={`${size === "lg" ? "text-[13px]" : "text-[11px]"} font-semibold ${
            urgent ? "text-primary-ink" : "text-muted-foreground"
          }`}
        >
          {spotsLine(ev)}
        </span>
        {size === "lg" && !ev.full && (
          <span className="text-[12px] text-muted-foreground">{ev.capacity} seats total</span>
        )}
      </div>
      <div
        className={`w-full rounded-full bg-secondary overflow-hidden ${size === "lg" ? "h-1.5" : "h-1"}`}
        aria-hidden="true"
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ${ev.full ? "bg-foreground/25" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
