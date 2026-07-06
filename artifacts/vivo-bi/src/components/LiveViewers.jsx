import React from "react";
import { api } from "@/lib/api";

// ── Live "who's viewing now" presence row ───────────────────────────────────
// Google-Docs-style overlapping avatar stack for the main BI cockpit top bar.
// Reuses the same server model as the fabric dashboard:
//   • POST /api/auth/heartbeat  — stamps this session as active on a surface
//   • GET  /api/auth/active-viewers?page=<surface> — reads back the viewers
// Presence is keyed on a fixed per-app surface ("vivo-bi") so the whole
// cockpit tracks its own viewers, independent of the fabric dashboard.
// Only name + role + profile photo are shown — email is never exposed.
//
// This component owns the fast heartbeat (15s, well under the 45s server
// window) and the viewer poll (8s). Both pause while the tab is hidden so an
// idle viewer drops off within the server's recency window. The photo URL is
// only ever an <img src>; on load error it falls back to an initials circle.

const SURFACE = "vivo-bi";
const PING_MS = 15000;
const POLL_MS = 8000;
const MAX_STACK = 5;

const initialsOf = (name) => {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return ((parts[0][0] || "") + (parts[parts.length - 1][0] || "")).toUpperCase();
};

const roleLabel = (r) => String(r || "").replace(/_/g, " ");

const Avatar = ({ viewer, large = false, stacked = false, style }) => {
  const [broken, setBroken] = React.useState(false);
  const name = viewer?.name || "Someone";
  const showPhoto = viewer?.picture && !broken;
  const size = large ? "w-7 h-7 text-[11px]" : "w-[22px] h-[22px] text-[9.5px]";
  const ring = viewer?.is_self
    ? "ring-2 ring-emerald-500"
    : stacked
    ? "ring-2 ring-white"
    : "";
  const margin = stacked ? "-ml-[7px] first:ml-0" : "";
  return (
    <span
      className={`relative shrink-0 inline-flex items-center justify-center rounded-full overflow-hidden font-extrabold uppercase text-white bg-slate-300 ${size} ${ring} ${margin}`}
      style={style}
      title={name + (viewer?.is_self ? " (You)" : "")}
    >
      {showPhoto ? (
        <img
          src={viewer.picture}
          alt={name}
          referrerPolicy="no-referrer"
          loading="lazy"
          className="w-full h-full object-cover block"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="bg-gradient-to-br from-brand to-brand/80 w-full h-full inline-flex items-center justify-center">
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
};

export default function LiveViewers() {
  const [viewers, setViewers] = React.useState([]);
  const [count, setCount] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);

  const poll = React.useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    api
      .get("/auth/active-viewers", { params: { page: SURFACE } })
      .then((r) => {
        const d = r.data || {};
        setViewers(Array.isArray(d.viewers) ? d.viewers : []);
        setCount(Number(d.count) || 0);
      })
      .catch(() => { /* keep last-known state on a transient failure */ });
  }, []);

  const ping = React.useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    api.post("/auth/heartbeat", { page: SURFACE }).catch(() => {});
  }, []);

  React.useEffect(() => {
    ping();
    poll();
    const pingId = setInterval(ping, PING_MS);
    const pollId = setInterval(poll, POLL_MS);
    const onVis = () => {
      if (!document.hidden) { ping(); poll(); }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(pingId);
      clearInterval(pollId);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ping, poll]);

  React.useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const n = count || viewers.length;
  if (!n) return null;

  const shown = viewers.slice(0, MAX_STACK);
  const extra = viewers.length - shown.length;

  return (
    <div className="relative" ref={ref} data-testid="live-viewers">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); if (!open) poll(); }}
        className="inline-flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full hover:bg-panel transition-colors"
        aria-expanded={open ? "true" : "false"}
        title={n === 1 ? "1 person viewing now" : `${n} people viewing now`}
        data-testid="live-viewers-btn"
      >
        <span className="inline-flex items-center">
          {shown.map((v, i) => (
            <Avatar
              key={v.user_id || i}
              viewer={v}
              stacked
              style={{ zIndex: shown.length - i }}
            />
          ))}
          {extra > 0 && (
            <span
              className="relative shrink-0 inline-flex items-center justify-center rounded-full w-[22px] h-[22px] text-[9px] font-extrabold text-white bg-slate-400 ring-2 ring-white -ml-[7px]"
              title={`${extra} more ${extra === 1 ? "person" : "people"} viewing`}
            >
              +{extra}
            </span>
          )}
        </span>
        <span className="hidden xl:inline text-[11px] font-medium text-foreground/70">
          {n === 1 ? "1 viewing" : `${n} viewing`}
        </span>
      </button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-60 rounded-xl border border-border bg-white shadow-lg py-1 z-50"
          data-testid="live-viewers-pop"
        >
          <div className="px-3 py-2 border-b border-border text-[11px] font-semibold uppercase tracking-wider text-foreground/55">
            Viewing now · {n}
          </div>
          {viewers.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-muted">
              No one else is viewing right now.
            </div>
          ) : (
            <div className="max-h-72 overflow-auto py-1">
              {viewers.map((v, i) => (
                <div
                  key={v.user_id || i}
                  className="flex items-center gap-2.5 px-3 py-1.5"
                  data-testid="live-viewer-row"
                >
                  <Avatar viewer={v} large />
                  <span className="min-w-0 leading-tight">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[12.5px] font-semibold truncate">
                        {v.name || "Someone"}
                      </span>
                      {v.is_self && (
                        <span className="text-[9.5px] font-bold uppercase tracking-wide text-emerald-600 bg-emerald-500/10 rounded px-1 py-0.5">
                          You
                        </span>
                      )}
                    </span>
                    {v.role && (
                      <span className="block text-[10.5px] text-muted capitalize">
                        {roleLabel(v.role)}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
