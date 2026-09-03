import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

// Factory-floor wallboard: as big and glanceable as possible. One board per
// sewing line — hourly Target vs Achieved cells, pace, and the projected
// end-of-day landing. Data: the hourly-updated Production Tracker sheet,
// re-polled every 30s so an edit lands on screen within ~1 minute.

const REFRESH_MS = 30000;

const STATUS = {
  "On track": { bg: "#0f7a3d", label: "ON TRACK" },
  "Slightly behind": { bg: "#c98a00", label: "SLIGHTLY BEHIND" },
  Behind: { bg: "#c0392b", label: "BEHIND" },
  "Not started": { bg: "#4a5568", label: "NOT STARTED" },
};

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());

function slotShort(s) {
  const a = s.start_hour > 12 ? s.start_hour - 12 : s.start_hour;
  const b = s.end_hour > 12 ? s.end_hour - 12 : s.end_hour;
  return `${a}–${b}`;
}

function Metric({ label, value, sub, bg }) {
  return (
    <div style={{ background: bg || "#0a1a12", borderRadius: 14, padding: "12px 10px", textAlign: "center", minWidth: 0 }}>
      <div style={{ fontSize: "clamp(12px, 1.1vw, 18px)", opacity: 0.8, fontWeight: 700, letterSpacing: 1.5 }}>{label}</div>
      <div style={{ fontSize: "clamp(34px, 3.4vw, 62px)", fontWeight: 800, lineHeight: 1.02 }}>{value}</div>
      <div style={{ fontSize: "clamp(12px, 1vw, 17px)", opacity: 0.75 }}>{sub}</div>
    </div>
  );
}

function LineBoard({ d }) {
  const sc = STATUS[d.status] || STATUS["Not started"];
  const pct = d.pct_achieved ?? 0;
  const marker = d.daily_target > 0 ? Math.min(100, (100 * d.expected_by_now) / d.daily_target) : 0;
  return (
    <div style={{ background: "#12261c", borderRadius: 18, padding: "18px 20px", color: "#eafaf1", boxShadow: "0 4px 24px rgba(0,0,0,.35)", display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: "clamp(34px, 3vw, 56px)", fontWeight: 800, letterSpacing: 1 }}>
          LINE {d.sewing_line}
        </span>
        <span style={{ background: sc.bg, fontWeight: 800, fontSize: "clamp(16px, 1.5vw, 26px)", padding: "6px 20px", borderRadius: 999, whiteSpace: "nowrap" }}>
          {d.targets_set ? sc.label : "TARGETS NOT SET"}
        </span>
      </div>

       <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
        <Metric label="MADE" value={fmt(d.made_so_far)} sub={`of ${fmt(d.daily_target)}`} />
        <Metric label="% OF TARGET" value={`${pct}%`} sub={`should be ${fmt(d.expected_by_now)}`} />
        <Metric label="PACE / HR" value={d.pace_per_hour == null ? "—" : fmt(Math.round(d.pace_per_hour))} sub={`${d.hours_filled ?? 0}/${d.productive_hours} hrs filled`} />
        <Metric label="PROJECTED" value={fmt(d.projected_landing)} sub={`${d.projected_pct}% of target`} bg={sc.bg} />
         <Metric label="MANPOWER" value={fmt(d.manpower)} sub={d.manpower == null ? "not entered" : "operators"} />
      </div>

      <div style={{ position: "relative", height: 26, background: "#0a1a12", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: sc.bg, transition: "width .6s ease" }} />
        {d.daily_target > 0 && (
          <div title="Where you should be now" style={{ position: "absolute", top: 0, bottom: 0, left: `${marker}%`, width: 3, background: "#fff", opacity: 0.9 }} />
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${d.slots.length || 8}, 1fr)`, gap: 6 }}>
        {d.slots.map((s) => {
          const active = s.elapsed_fraction > 0 && s.elapsed_fraction < 1;
          const bg = s.actual == null ? "#0a1a12" : s.hit ? "#0f7a3d" : "#7a2018";
          const notCounted = s.actual != null && s.counted === false;
          return (
            <div key={s.start_hour} title={notCounted ? "Entered ahead of time — not counted yet" : undefined} style={{ background: bg, borderRadius: 8, padding: "8px 2px", textAlign: "center", border: active ? "2px solid #ffd75e" : "2px solid transparent", opacity: notCounted ? 0.45 : 1 }}>
              <div style={{ fontSize: "clamp(11px, 0.95vw, 16px)", opacity: 0.8, fontWeight: 600 }}>{slotShort(s)}</div>
              <div style={{ fontSize: "clamp(22px, 2.1vw, 40px)", fontWeight: 800, lineHeight: 1.05 }}>{s.actual == null ? "—" : fmt(s.actual)}</div>
              <div style={{ fontSize: "clamp(11px, 0.9vw, 15px)", opacity: 0.7 }}>/{fmt(s.target ?? 0)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ProductionWallboard() {
  const [payload, setPayload] = useState(null);
  const [err, setErr] = useState(null);
  const [updated, setUpdated] = useState(null);
  const [clock, setClock] = useState(new Date());
  const initialDate = new URLSearchParams(window.location.search).get("date") || "";
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const selectedDateRef = useRef(initialDate);
  const boardRef = useRef(null);

  const load = useCallback(async (dateOverride) => {
    try {
      // An empty date uses the backend's latest available day fallback. A
      // selected date is sent explicitly so historical boards are reproducible.
      const dateParam = dateOverride === undefined
        ? selectedDateRef.current
        : dateOverride;
      const { data } = await api.get("/production/hourly-tracker", {
        forceFresh: true,
        params: dateParam ? { work_date: dateParam } : undefined,
      });
      setPayload(data);
      setUpdated(new Date());
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.detail || e?.message || "Failed to load");
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    const ck = setInterval(() => setClock(new Date()), 1000);
    return () => { clearInterval(id); clearInterval(ck); };
  }, [load]);

  const goFullscreen = () => {
    const el = boardRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  };

  const chooseDate = (value) => {
    selectedDateRef.current = value;
    setSelectedDate(value);
    const search = new URLSearchParams(window.location.search);
    if (value) search.set("date", value);
    else search.delete("date");
    const query = search.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
    load(value);
  };

  const t = payload?.totals;
  const dateLabel = payload
    ? new Date(payload.work_date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })
    : "";
  const agoSec = updated ? Math.max(0, Math.round((clock - updated) / 1000)) : null;

  return (
    <div ref={boardRef} style={{ minHeight: "100vh", background: "#0a140e", padding: "18px 22px", overflow: "auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, marginBottom: 12, color: "#eafaf1", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: "clamp(26px, 2.6vw, 46px)", fontWeight: 800, letterSpacing: 1.5 }}>PRODUCTION TRACKER</span>
          <span style={{ fontSize: "clamp(16px, 1.5vw, 26px)", opacity: 0.85 }}>{dateLabel}</span>
          {payload && !payload.is_today && (
            <span style={{ background: payload.is_future ? "#4a5568" : "#c98a00", color: "#fff", fontWeight: 800, borderRadius: 999, padding: "4px 16px", fontSize: "clamp(13px, 1.2vw, 20px)" }}>
              {payload.is_future
                ? "SCHEDULED DAY — not started yet"
                : selectedDate
                  ? "HISTORICAL VIEW — actuals only"
                  : "LAST RECORDED DAY — waiting for today's first entry"}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#eafaf1", fontSize: 15, fontWeight: 700 }}>
            <span>VIEW DATE</span>
            <select
              value={selectedDate || payload?.work_date || ""}
              onChange={(e) => chooseDate(e.target.value)}
              aria-label="View production date"
              style={{ background: "#eafaf1", color: "#12261c", border: "1px solid #9fd8b8", borderRadius: 8, padding: "9px 10px", fontSize: 15, fontWeight: 700, minWidth: 170 }}
            >
              <option value="">Latest available</option>
              {(payload?.available_dates || []).slice().reverse().map((date) => (
                <option key={date} value={date}>
                  {new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                </option>
              ))}
            </select>
          </label>
          <span style={{ fontSize: "clamp(13px, 1vw, 17px)", opacity: 0.7 }}>
            {agoSec == null ? "" : agoSec < 5 ? "updated just now" : `updated ${agoSec}s ago`}
          </span>
          <span style={{ fontSize: "clamp(26px, 2.4vw, 44px)", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
            {clock.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Nairobi" })}
          </span>
          <button onClick={goFullscreen} style={{ background: "#1d3a2a", color: "#eafaf1", border: "1px solid #2e5941", borderRadius: 10, padding: "8px 16px", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
            ⛶ Fullscreen
          </button>
        </div>
      </div>

      {err && (
        <div style={{ background: "#7a2018", color: "#fff", borderRadius: 10, padding: "10px 16px", fontWeight: 700, marginBottom: 12, fontSize: "clamp(14px, 1.2vw, 20px)" }}>
          Connection problem — showing last loaded data. ({String(err)})
        </div>
      )}

      {payload?.warnings && (payload.warnings.duplicate_rows > 0 || payload.warnings.skipped_rows > 0 || payload.warnings.future_actuals > 0) && (
        <div style={{ background: "#3d3212", color: "#ffd75e", borderRadius: 10, padding: "8px 16px", fontWeight: 700, marginBottom: 12, fontSize: "clamp(13px, 1vw, 17px)" }}>
          Sheet check:
          {payload.warnings.duplicate_rows > 0 && ` ${payload.warnings.duplicate_rows} duplicate row(s) — latest kept.`}
          {payload.warnings.skipped_rows > 0 && ` ${payload.warnings.skipped_rows} unreadable row(s) skipped.`}
          {payload.warnings.future_actuals > 0 && ` ${payload.warnings.future_actuals} entry(ies) in future hours — not counted yet.`}
        </div>
      )}

      {/* Factory totals */}
      {t && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 14, color: "#eafaf1" }}>
          <Metric label="FACTORY MADE" value={fmt(t.made_so_far)} sub={`of ${fmt(t.daily_target)} target`} />
          <Metric label="% OF TARGET" value={`${t.pct_achieved}%`} sub={`should be ${fmt(t.expected_by_now)} by now`} />
          <Metric label="PROJECTED LANDING" value={fmt(t.projected_landing)} sub={`${t.projected_pct}% of target`} bg={t.projected_pct >= 97 ? "#0f7a3d" : t.projected_pct >= 85 ? "#c98a00" : "#7a2018"} />
          <Metric label="MANPOWER" value={fmt(t.manpower)} sub={`${t.manpower_set || 0}/${payload.lines.length} lines set`} />
          <Metric label="SEWING LINES" value={payload.lines.length} sub="reporting today" />
        </div>
      )}

      {/* Line boards */}
      {!payload && !err && (
        <div style={{ color: "#eafaf1", fontSize: 28, opacity: 0.7, padding: 40 }}>Loading tracker…</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(620px, 1fr))", gap: 14 }}>
        {(payload?.lines || []).map((l) => <LineBoard key={l.sewing_line} d={l} />)}
      </div>
    </div>
  );
}
