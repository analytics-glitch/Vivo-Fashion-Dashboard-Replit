import React, { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";

// Factory-floor wallboard: large, glanceable, auto-refreshing. Shows each
// sewing line's hourly output vs target and the projected end-of-day landing.

const REFRESH_MS = 60000; // pull fresh every 60s

function statusColor(status) {
  switch (status) {
    case "On track":       return { bg: "#0f7a3d", fg: "#ffffff", label: "ON TRACK" };
    case "Slightly behind":return { bg: "#c98a00", fg: "#ffffff", label: "SLIGHTLY BEHIND" };
    case "Behind":         return { bg: "#c0392b", fg: "#ffffff", label: "BEHIND" };
    case "Not started":    return { bg: "#555555", fg: "#ffffff", label: "NOT STARTED" };
    default:               return { bg: "#555555", fg: "#ffffff", label: String(status || "—") };
  }
}

function LineBoard({ data }) {
  const sc = statusColor(data.status);
  const pct = data.pct_achieved ?? 0;
  const projPct = data.projected_pct ?? 0;
  return (
    <div style={{
      background: "#12261c", borderRadius: 18, padding: "26px 30px",
      color: "#eafaf1", boxShadow: "0 4px 24px rgba(0,0,0,.35)",
      display: "flex", flexDirection: "column", gap: 18, minWidth: 0,
    }}>
      {/* Header row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <span style={{ fontSize: 46, fontWeight: 800, letterSpacing: 1 }}>LINE {data.sewing_line}</span>
          <span style={{ fontSize: 20, opacity: .8, fontWeight: 500 }}>{data.style || ""}</span>
        </div>
        <span style={{
          background: sc.bg, color: sc.fg, fontWeight: 800, fontSize: 24,
          padding: "8px 22px", borderRadius: 999, whiteSpace: "nowrap",
        }}>{sc.label}</span>
      </div>

      {/* Big numbers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 18 }}>
        <Metric label="MADE SO FAR" value={data.made_so_far} sub={`of ${data.daily_target}`} />
        <Metric label="% OF TARGET" value={`${pct}%`} sub={`should be ${data.expected_by_now}`} />
        <Metric label="PACE / HOUR" value={data.pace_per_hour} sub={`${data.hours_completed}/${data.productive_hours} hrs`} />
        <Metric label="PROJECTED" value={data.projected_landing} sub={`${projPct}% of target`}
                highlight={sc.bg} />
      </div>

      {/* Progress bar: actual vs target, with an "expected by now" marker */}
      <div style={{ position: "relative", height: 34, background: "#0a1a12", borderRadius: 8, overflow: "hidden" }}>
        <div style={{
          width: `${Math.min(100, pct)}%`, height: "100%",
          background: sc.bg, transition: "width .6s ease",
        }} />
        {data.daily_target > 0 && (
          <div title="Where you should be now" style={{
            position: "absolute", top: 0, bottom: 0,
            left: `${Math.min(100, 100 * (data.expected_by_now / data.daily_target))}%`,
            width: 3, background: "#ffffff", opacity: .85,
          }} />
        )}
      </div>

      {/* Hourly cells */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${data.slots.length || 8}, 1fr)`, gap: 8 }}>
        {data.slots.map((s) => {
          const a = s.actual;
          const t = s.target || 0;
          const hit = a != null && t > 0 && a >= t;
          const bg = a == null ? "#0a1a12" : hit ? "#0f7a3d" : "#7a2018";
          return (
            <div key={s.slot} style={{ background: bg, borderRadius: 8, padding: "10px 6px", textAlign: "center" }}>
              <div style={{ fontSize: 13, opacity: .75 }}>{s.slot}</div>
              <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1 }}>{a == null ? "—" : a}</div>
              <div style={{ fontSize: 12, opacity: .7 }}>/{t}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Metric({ label, value, sub, highlight }) {
  return (
    <div style={{
      background: highlight ? highlight : "#0a1a12",
      borderRadius: 12, padding: "14px 16px", textAlign: "center",
    }}>
      <div style={{ fontSize: 14, opacity: .8, fontWeight: 600, letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 44, fontWeight: 800, lineHeight: 1.05 }}>{value}</div>
      <div style={{ fontSize: 14, opacity: .75 }}>{sub}</div>
    </div>
  );
}

export default function ProductionWallboard() {
  const [lines, setLines] = useState([]);   // one payload per sewing line
  const [updated, setUpdated] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      // First call: default day + first line, also returns available_lines.
      const { data: first } = await api.get("/production/hourly-tracker", { forceFresh: true });
      const day = first.work_date;
      const avail = first.available_lines && first.available_lines.length ? first.available_lines : [first.sewing_line];
      // Fetch each line for that day.
      const results = await Promise.all(
        avail.map((ln) =>
          api.get(`/production/hourly-tracker`, { params: { work_date: day, sewing_line: ln }, forceFresh: true })
             .then((r) => r.data)
        )
      );
      setLines(results);
      setUpdated(new Date());
      setErr(null);
    } catch (e) {
      setErr(e?.message || "Failed to load");
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const day = lines[0]?.work_date;

  return (
    <div style={{ minHeight: "100vh", background: "#0a140e", padding: "28px 34px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
        <div style={{ color: "#eafaf1", fontSize: 40, fontWeight: 800, letterSpacing: 1 }}>
          PRODUCTION — HOURLY OUTPUT
        </div>
        <div style={{ color: "#9fd8b8", fontSize: 18, textAlign: "right" }}>
          <div style={{ fontSize: 26, fontWeight: 700 }}>{day || "—"}</div>
          <div>{updated ? `Updated ${updated.toLocaleTimeString()}` : "Loading…"}</div>
        </div>
      </div>

      {err && (
        <div style={{ color: "#ffb4a8", fontSize: 20, padding: 20 }}>
          {err}
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: lines.length > 1 ? "repeat(auto-fit, minmax(560px, 1fr))" : "1fr",
        gap: 22,
      }}>
        {lines.map((d) => <LineBoard key={d.sewing_line} data={d} />)}
      </div>

      {!err && lines.length === 0 && (
        <div style={{ color: "#9fd8b8", fontSize: 22, padding: 30 }}>No production data yet for today.</div>
      )}
    </div>
  );
}
