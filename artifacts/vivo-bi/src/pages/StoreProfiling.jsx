import React, { useState, useEffect, useMemo } from "react";
import { useApi } from "@/lib/useApi";

// ── Formatters ───────────────────────────────────────────────────────────────
const fmtKES = (v, compact = true) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (!compact) return `KES ${Number(v).toLocaleString()}`;
  if (a >= 1_000_000) return `KES ${(v / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000)     return `KES ${(v / 1_000).toFixed(0)}k`;
  return `KES ${Number(v).toFixed(0)}`;
};
const fmtNum = (v) => v == null ? "—" : Number(v).toLocaleString();
const fmtPct = (v) => v == null ? "—" : `${Number(v).toFixed(1)}%`;
const fmt    = (f, v) => f === "kes" ? fmtKES(v, false) : f === "kes_c" ? fmtKES(v, true) : f === "pct" ? fmtPct(v) : fmtNum(v);

// ── Colour tokens ────────────────────────────────────────────────────────────
const C = {
  good:    { fg: "#15803d", bg: "#f0fdf4", bdr: "#86efac" },
  ok:      { fg: "#0f766e", bg: "#f0fdfa", bdr: "#99f6e4" },
  warn:    { fg: "#b45309", bg: "#fffbeb", bdr: "#fde68a" },
  bad:     { fg: "#dc2626", bg: "#fef2f2", bdr: "#fecaca" },
  crit:    { fg: "#7f1d1d", bg: "#fff1f2", bdr: "#fca5a5" },
  muted:   { fg: "#6b7280", bg: "#f9fafb", bdr: "#e5e7eb" },
  amber:   { fg: "#92400e", bg: "#fffbeb", bdr: "#fde68a" },
  blue:    { fg: "#1d4ed8", bg: "#eff6ff", bdr: "#bfdbfe" },
  indigo:  { fg: "#4338ca", bg: "#eef2ff", bdr: "#c7d2fe" },
};

const BAR_COLORS = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ec4899","#8b5cf6","#14b8a6","#f97316"];

function scorePct(pct, lowerBetter = false) {
  const v = lowerBetter ? 200 - pct : pct;
  if (v >= 100) return C.good;
  if (v >= 88)  return C.ok;
  if (v >= 70)  return C.warn;
  if (v >= 45)  return C.bad;
  return C.crit;
}

// ── Primitives ───────────────────────────────────────────────────────────────
function Skeleton({ rows = 5 }) {
  return (
    <div style={{ padding: "8px 0" }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ height: 18, background: "#f3f4f6", borderRadius: 4, marginBottom: 10, width: `${55 + (i % 5) * 9}%` }} />
      ))}
    </div>
  );
}

function ErrBox({ msg }) {
  return (
    <div style={{ padding: 16, background: "#fef2f2", borderRadius: 8, color: "#dc2626", fontSize: 14, border: "1px solid #fca5a5" }}>
      ⚠ {msg || "Could not load data"}
    </div>
  );
}

function Bar({ value, max, color = "#6366f1", h = 10 }) {
  const pct = max > 0 ? Math.min(value / max * 100, 100) : 0;
  return (
    <div style={{ background: "#e5e7eb", borderRadius: h, height: h, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, background: color, height: "100%", borderRadius: h, minWidth: pct > 0 ? 4 : 0, transition: "width 0.4s ease" }} />
    </div>
  );
}

function Pill({ children, c }) {
  const col = c || C.muted;
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: col.bg, color: col.fg, border: `1px solid ${col.bdr}`, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

// ── Revenue Headline ─────────────────────────────────────────────────────────
function RevenueBlock({ mtdRev, target, projected, daysDone, daysIn, daysLeft, reqDaily }) {
  const progPct = mtdRev && target ? Math.round(mtdRev / target * 100) : null;
  const projPct = projected && target ? Math.round(projected / target * 100) : null;
  const sc = projPct != null ? scorePct(projPct) : C.muted;
  const gap = target && projected ? Math.max(0, target - projected) : null;
  const dailyAvg = mtdRev && daysDone > 0 ? Math.round(mtdRev / daysDone) : null;

  return (
    <div style={{ background: "#fff", border: `2px solid ${sc.bdr}`, borderRadius: 14, padding: "24px 28px", marginBottom: 24 }}>
      {/* Title row */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em" }}>
            Revenue · August Target
          </div>
          <div style={{ fontSize: 44, fontWeight: 900, color: "#111827", lineHeight: 1.1, marginTop: 4 }}>
            {fmtKES(target, false)}
          </div>
          <div style={{ fontSize: 13, color: "#9ca3af", marginTop: 4 }}>Day {daysDone} of {daysIn} · {daysLeft} days remaining</div>
        </div>
        <div style={{ textAlign: "right" }}>
          {projPct != null && (
            <>
              <div style={{ fontSize: 13, color: "#6b7280" }}>Projected Month-End</div>
              <div style={{ fontSize: 30, fontWeight: 900, color: sc.fg }}>{fmtKES(projected)}</div>
              <Pill c={sc}>{projPct}% of target</Pill>
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: 6 }}>
        <Bar value={mtdRev || 0} max={target || 1} color={sc.fg} h={16} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6b7280", marginBottom: 20 }}>
        <span>MTD: <strong style={{ color: "#111827" }}>{fmtKES(mtdRev)} ({progPct ?? "—"}%)</strong></span>
        <span>Target: <strong style={{ color: "#111827" }}>{fmtKES(target)}</strong></span>
      </div>

      {/* Three-state row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {/* WHERE WE ARE */}
        <div style={{ background: C.blue.bg, border: `1px solid ${C.blue.bdr}`, borderRadius: 10, padding: "14px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.blue.fg, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
            📍 Where We Are
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#111827" }}>{fmtKES(mtdRev, false)}</div>
          <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>
            {dailyAvg ? `${fmtKES(dailyAvg, false)}/day avg so far` : "Day 1"}
          </div>
        </div>
        {/* WHERE WE NEED TO BE */}
        <div style={{ background: C.amber.bg, border: `1px solid ${C.amber.bdr}`, borderRadius: 10, padding: "14px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.amber.fg, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
            🎯 Where We Need To Be
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.amber.fg }}>{fmtKES(target, false)}</div>
          <div style={{ fontSize: 13, color: "#b45309", marginTop: 4 }}>August budget target</div>
        </div>
        {/* WHAT TO DO */}
        <div style={{ background: gap > 0 ? C.bad.bg : C.good.bg, border: `1px solid ${gap > 0 ? C.bad.bdr : C.good.bdr}`, borderRadius: 10, padding: "14px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: gap > 0 ? C.bad.fg : C.good.fg, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
            ⚡ What To Do
          </div>
          {gap > 0 ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.bad.fg }}>{fmtKES(reqDaily, false)}/day</div>
              <div style={{ fontSize: 13, color: "#374151", marginTop: 4 }}>
                for {daysLeft} days · gap {fmtKES(gap)}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 20, fontWeight: 800, color: C.good.fg, marginTop: 4 }}>✓ On Track</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Single KPI card ──────────────────────────────────────────────────────────
const VOL_KEYS  = new Set(["units","transactions","footfall","customer_count"]);
const RATE_KEYS = new Set(["asp","abv"]);
const PCT_KEYS  = new Set(["conversion","new_customer_pct","returning_customer_pct","discount_rate","return_rate"]);

const UNIT_LABEL = {
  units: "items", transactions: "txns", footfall: "visitors",
  customer_count: "customers",
};

function KpiCard({ kpiKey, label, fmtStr, lowerBetter, actual, target, projected, daysDone, daysLeft, daysIn }) {
  const isVol  = VOL_KEYS.has(kpiKey);
  const isRate = RATE_KEYS.has(kpiKey);

  // Volume derived
  const dailyActual = isVol && actual != null && daysDone > 0 ? Math.round(actual / daysDone) : null;
  const remaining   = isVol && actual != null && target != null ? Math.max(0, target - actual) : null;
  const dailyNeeded = isVol && remaining != null && daysLeft > 0 ? Math.round(remaining / daysLeft) : null;
  const dailyGap    = dailyNeeded != null && dailyActual != null ? dailyNeeded - dailyActual : null;
  const onTrack     = dailyGap != null ? dailyGap <= 0 : null;

  // Progress %
  const progPct = actual != null && target != null && target > 0 ? Math.round(actual / target * 100) : null;
  const projPct = projected != null && target != null && target > 0 ? Math.round(projected / target * 100) : null;
  const sc = projPct != null ? scorePct(projPct, lowerBetter) : C.muted;

  // Rate gap
  const rateGap = (isRate || PCT_KEYS.has(kpiKey)) && actual != null && target != null ? target - actual : null;
  const rateOk  = rateGap != null && (lowerBetter ? rateGap >= 0 : rateGap <= 0);

  return (
    <div style={{ background: "#fff", border: `1px solid ${sc.bdr}`, borderRadius: 12, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 0 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
        {projPct != null && <Pill c={sc}>{projPct}%</Pill>}
      </div>

      {/* WHERE WE ARE */}
      <div style={{ background: C.blue.bg, border: `1px solid ${C.blue.bdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: C.blue.fg, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>📍 Where We Are</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: "#111827", lineHeight: 1.1 }}>{fmt(fmtStr, actual)}</div>
        {isVol && dailyActual != null && (
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>avg {fmtNum(dailyActual)} {UNIT_LABEL[kpiKey] || ""}/day so far</div>
        )}
        {isRate && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>current average</div>}
        {isVol && target != null && actual != null && (
          <div style={{ marginTop: 8 }}>
            <Bar value={actual} max={target} color={sc.fg} h={7} />
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>{progPct ?? "—"}% of target</div>
          </div>
        )}
      </div>

      {/* WHERE WE NEED TO BE */}
      <div style={{ background: C.amber.bg, border: `1px solid ${C.amber.bdr}`, borderRadius: 8, padding: "10px 14px", marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: C.amber.fg, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>🎯 Where We Need To Be</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: C.amber.fg }}>{fmt(fmtStr, target)}</div>
        {isVol && target != null && (
          <div style={{ fontSize: 12, color: "#b45309", marginTop: 3 }}>
            = {fmtNum(Math.round(target / daysIn))} {UNIT_LABEL[kpiKey] || ""}/day pace (full month)
          </div>
        )}
        {isRate && <div style={{ fontSize: 12, color: "#b45309", marginTop: 3 }}>required to hit revenue target</div>}
        {PCT_KEYS.has(kpiKey) && <div style={{ fontSize: 12, color: "#b45309", marginTop: 3 }}>required rate</div>}
      </div>

      {/* WHAT TO DO */}
      <div style={{ background: isVol ? (onTrack ? C.good.bg : C.bad.bg) : (rateOk ? C.good.bg : C.bad.bg), border: `1px solid ${isVol ? (onTrack ? C.good.bdr : C.bad.bdr) : (rateOk ? C.good.bdr : C.bad.bdr)}`, borderRadius: 8, padding: "10px 14px" }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>⚡ What To Do</div>
        {isVol && (
          dailyNeeded != null ? (
            <>
              <div style={{ fontSize: 18, fontWeight: 800, color: onTrack ? C.good.fg : C.bad.fg }}>
                {fmtNum(dailyNeeded)}/day needed
              </div>
              <div style={{ fontSize: 12, color: "#374151", marginTop: 3 }}>for {daysLeft} remaining days</div>
              {dailyGap != null && (
                <div style={{ fontSize: 13, fontWeight: 700, marginTop: 5, color: onTrack ? C.good.fg : C.bad.fg }}>
                  {onTrack ? `✓ ${fmtNum(Math.abs(dailyGap))}/day ahead of pace` : `▲ Need ${fmtNum(dailyGap)}/day more than now`}
                </div>
              )}
            </>
          ) : <div style={{ fontSize: 14, fontWeight: 700, color: C.good.fg }}>✓ On Track</div>
        )}
        {(isRate || PCT_KEYS.has(kpiKey)) && rateGap != null && (
          <div style={{ fontSize: 15, fontWeight: 700, color: rateOk ? C.good.fg : C.bad.fg }}>
            {rateOk
              ? (lowerBetter ? `✓ ${fmt(fmtStr, Math.abs(rateGap))} below required` : `✓ ${fmt(fmtStr, Math.abs(rateGap))} above required`)
              : (lowerBetter ? `▼ Reduce by ${fmt(fmtStr, Math.abs(rateGap))}` : `▲ Lift by ${fmt(fmtStr, Math.abs(rateGap))}`)}
          </div>
        )}
        {(isRate || PCT_KEYS.has(kpiKey)) && rateGap == null && (
          <div style={{ fontSize: 13, color: "#9ca3af" }}>No target set</div>
        )}
      </div>
    </div>
  );
}

// ── Category Targets ─────────────────────────────────────────────────────────
function CategoryTargets({ store, rpt }) {
  const [selCat, setSelCat] = useState("");

  const targetUnits = rpt?.derived_targets?.units;
  const daysIn      = rpt?.days_in_month  || 31;
  const daysLeft    = rpt?.days_remaining || 28;
  const daysDone    = rpt?.days_done      || 0;
  const targetRev   = rpt?.target_revenue;

  const curMonth = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, []);

  // August MTD per-category data
  const { data: mtdMix, isLoading: loadMtd } = useApi(
    "store-profile/category-mix",
    { store, month: curMonth, ...(selCat ? { category: selCat } : {}) },
    { enabled: !!store }
  );

  // 6-month baseline for target proportions (SWR deduplicates when same key)
  const { data: baseMix, isLoading: loadBase } = useApi(
    "store-profile/category-mix",
    { store },
    { enabled: !!store }
  );

  const totalBase = baseMix?.total_units || 0;

  const toTgt = (baseUnits) => {
    if (!targetUnits || !totalBase || !baseUnits) return null;
    return Math.round(targetUnits * (baseUnits / totalBase));
  };

  const toRevTgt = (baseRev) => {
    if (!targetRev || !((baseMix?.total_revenue) || 0) || !baseRev) return null;
    return Math.round(targetRev * (baseRev / baseMix.total_revenue));
  };

  const enrichRows = (rows, keyField, baseCats, subCatKey) =>
    (rows || []).map((row, ci) => {
      const name = row[keyField] || row.category || row.subcategory || row.name;
      const bc = baseCats?.find(c => (c[keyField] || c.category || c.subcategory) === name);
      const tgt = toTgt(bc?.units);
      const rem = tgt != null && row.units != null ? Math.max(0, tgt - row.units) : null;
      const da  = daysDone > 0 && row.units != null ? +(row.units / daysDone).toFixed(1) : null;
      const dn  = daysLeft > 0 && rem != null ? +(rem / daysLeft).toFixed(1) : null;
      return {
        ...row, name, tgt, rem,
        dailyActual: da,
        dailyNeeded: dn,
        dailyGap: dn != null && da != null ? dn - da : null,
        revTgt: toRevTgt(bc?.revenue),
        color: BAR_COLORS[ci % BAR_COLORS.length],
        subs: !subCatKey ? undefined : enrichRows(
          row[subCatKey] || [],
          "subcategory",
          bc?.[subCatKey] || [],
          null,
        ),
      };
    });

  const rows = useMemo(() => {
    if (!mtdMix) return [];
    const baseCats = baseMix?.categories || [];
    if (!selCat) {
      return enrichRows(mtdMix.categories || [], "category", baseCats, "subcategories");
    }
    const cat = (mtdMix.categories || []).find(c => c.category === selCat);
    if (!cat) return [];
    const bc  = baseCats.find(c => c.category === selCat);
    return enrichRows(cat.subcategories || [], "subcategory", bc?.subcategories || [], null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mtdMix, baseMix, selCat, targetUnits, totalBase, daysLeft, daysDone]);

  const loading = loadMtd || loadBase;

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 24, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "18px 24px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 800, color: "#111827" }}>
            Category & Sub-Category Targets — August {new Date().getFullYear()}
          </div>
          <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>
            {selCat ? `${selCat} → sub-categories` : "All categories"} · August MTD actuals vs full-month targets
          </div>
        </div>
        {selCat && (
          <button onClick={() => setSelCat("")}
            style={{ background: "none", border: "1px solid #d1d5db", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#374151" }}>
            ← All categories
          </button>
        )}
      </div>

      <div style={{ padding: "0 0 0 0" }}>
        {loading && <div style={{ padding: 24 }}><Skeleton rows={7} /></div>}
        {!loading && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "14px 20px", color: "#374151", fontWeight: 700, fontSize: 13, borderBottom: "2px solid #e5e7eb", minWidth: 200, background: "#f9fafb" }}>
                    {selCat ? "Sub-Category" : "Category"}
                  </th>
                  <th style={{ textAlign: "center", padding: "14px 16px", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #e5e7eb", minWidth: 170, background: "#eff6ff", color: C.blue.fg }}>
                    📍 WHERE WE ARE<br />
                    <span style={{ fontWeight: 400, fontSize: 11, color: "#6b7280" }}>August MTD · daily avg</span>
                  </th>
                  <th style={{ textAlign: "center", padding: "14px 16px", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #e5e7eb", minWidth: 170, background: "#fffbeb", color: C.amber.fg }}>
                    🎯 WHERE WE NEED TO BE<br />
                    <span style={{ fontWeight: 400, fontSize: 11, color: "#6b7280" }}>Full-month target · /day pace</span>
                  </th>
                  <th style={{ textAlign: "center", padding: "14px 16px", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #e5e7eb", minWidth: 190, background: "#fff1f2", color: C.bad.fg }}>
                    ⚡ WHAT TO DO<br />
                    <span style={{ fontWeight: 400, fontSize: 11, color: "#6b7280" }}>Units/day needed · gap vs current pace</span>
                  </th>
                  <th style={{ textAlign: "right", padding: "14px 16px", color: "#374151", fontWeight: 700, fontSize: 12, borderBottom: "2px solid #e5e7eb", minWidth: 120, background: "#f9fafb" }}>
                    ASP<br /><span style={{ fontWeight: 400, color: "#9ca3af" }}>(avg price)</span>
                  </th>
                  <th style={{ textAlign: "right", padding: "14px 16px", color: "#374151", fontWeight: 700, fontSize: 12, borderBottom: "2px solid #e5e7eb", minWidth: 130, background: "#f9fafb" }}>
                    Revenue MTD
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => {
                  const onTrack = row.dailyGap != null ? row.dailyGap <= 0 : null;
                  const bg = idx % 2 === 0 ? "#fff" : "#fafafa";
                  const progPct = row.tgt && row.units != null ? Math.round(row.units / row.tgt * 100) : null;
                  return (
                    <tr key={row.name} style={{ borderBottom: "1px solid #e5e7eb", background: bg, cursor: row.subs?.length ? "pointer" : "default" }}
                        onClick={() => row.subs?.length && setSelCat(row.name)}
                        onMouseEnter={e => (e.currentTarget.style.background = "#f0f4ff")}
                        onMouseLeave={e => (e.currentTarget.style.background = bg)}>

                      {/* Name */}
                      <td style={{ padding: "16px 20px", fontWeight: 700, fontSize: 15, color: "#111827" }}>
                        <span style={{ display: "inline-block", width: 11, height: 11, borderRadius: 2, background: row.color, marginRight: 10, verticalAlign: "middle", flexShrink: 0 }} />
                        {row.name}
                        {row.subs?.length > 0 && <span style={{ fontSize: 11, color: "#6366f1", marginLeft: 8 }}>↵ drill in</span>}
                      </td>

                      {/* WHERE WE ARE */}
                      <td style={{ textAlign: "center", padding: "16px 16px", background: "#f8faff", verticalAlign: "middle" }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: C.blue.fg }}>{fmtNum(row.units)}</div>
                        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>
                          {row.dailyActual != null ? `${row.dailyActual} units/day avg` : "—"}
                        </div>
                        {row.tgt != null && row.units != null && (
                          <div style={{ marginTop: 8, maxWidth: 120, margin: "8px auto 0" }}>
                            <Bar value={row.units} max={row.tgt} color={C.blue.fg} h={6} />
                            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 3 }}>{progPct ?? "—"}% of target</div>
                          </div>
                        )}
                      </td>

                      {/* WHERE WE NEED TO BE */}
                      <td style={{ textAlign: "center", padding: "16px 16px", background: "#fffef5", verticalAlign: "middle" }}>
                        {row.tgt != null ? (
                          <>
                            <div style={{ fontSize: 22, fontWeight: 800, color: C.amber.fg }}>{fmtNum(row.tgt)}</div>
                            <div style={{ fontSize: 12, color: "#b45309", marginTop: 3 }}>
                              {Math.round(row.tgt / daysIn)} units/day pace
                            </div>
                            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>
                              {row.rem != null && row.rem > 0 ? `${fmtNum(row.rem)} still to sell` : row.rem === 0 ? "✓ Target reached" : "—"}
                            </div>
                          </>
                        ) : <span style={{ color: "#9ca3af", fontSize: 13 }}>No budget set</span>}
                      </td>

                      {/* WHAT TO DO */}
                      <td style={{ textAlign: "center", padding: "16px 16px", verticalAlign: "middle" }}>
                        {row.dailyNeeded != null ? (
                          <div style={{ display: "inline-block", background: onTrack ? C.good.bg : C.bad.bg, border: `1px solid ${onTrack ? C.good.bdr : C.bad.bdr}`, borderRadius: 10, padding: "10px 16px", minWidth: 130 }}>
                            <div style={{ fontSize: 20, fontWeight: 800, color: onTrack ? C.good.fg : C.bad.fg }}>
                              {row.dailyNeeded}/day
                            </div>
                            <div style={{ fontSize: 12, color: "#374151", marginTop: 3 }}>for {daysLeft} days</div>
                            {row.dailyGap != null && (
                              <div style={{ fontSize: 12, fontWeight: 700, marginTop: 5, color: onTrack ? C.good.fg : C.bad.fg }}>
                                {onTrack
                                  ? `✓ ${Math.abs(row.dailyGap).toFixed(1)}/day ahead`
                                  : `▲ +${row.dailyGap.toFixed(1)}/day more needed`}
                              </div>
                            )}
                          </div>
                        ) : (
                          row.rem === 0
                            ? <Pill c={C.good}>✓ Target hit</Pill>
                            : <span style={{ color: "#9ca3af" }}>—</span>
                        )}
                      </td>

                      {/* ASP */}
                      <td style={{ textAlign: "right", padding: "16px 16px", fontSize: 15, fontWeight: 600, color: "#374151", verticalAlign: "middle" }}>
                        {fmtKES(row.asp)}
                      </td>

                      {/* Revenue MTD */}
                      <td style={{ textAlign: "right", padding: "16px 16px", fontSize: 15, color: "#374151", verticalAlign: "middle" }}>
                        {fmtKES(row.revenue)}
                        {row.revTgt && (
                          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                            of {fmtKES(row.revTgt)} target
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: "center", padding: 40, color: "#9ca3af", fontSize: 14 }}>
                      No category data for August yet — sales start appearing as the month progresses
                    </td>
                  </tr>
                )}
              </tbody>
              {/* Totals footer */}
              {rows.length > 1 && (
                <tfoot>
                  <tr style={{ borderTop: "2px solid #d1d5db", background: "#f9fafb" }}>
                    <td style={{ padding: "12px 20px", fontWeight: 700, fontSize: 14, color: "#374151" }}>Total</td>
                    <td style={{ textAlign: "center", padding: "12px 16px", fontWeight: 800, fontSize: 16, color: C.blue.fg, background: "#f8faff" }}>
                      {fmtNum(rows.reduce((s, r) => s + (r.units || 0), 0))}
                      <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 400 }}>
                        {daysDone > 0 ? `${(rows.reduce((s, r) => s + (r.units || 0), 0) / daysDone).toFixed(1)}/day avg` : ""}
                      </div>
                    </td>
                    <td style={{ textAlign: "center", padding: "12px 16px", fontWeight: 800, fontSize: 16, color: C.amber.fg, background: "#fffef5" }}>
                      {targetUnits ? fmtNum(rows.reduce((s, r) => s + (r.tgt || 0), 0)) : "—"}
                      {targetUnits && <div style={{ fontSize: 11, color: "#b45309", fontWeight: 400 }}>{Math.round(rows.reduce((s,r)=>s+(r.tgt||0),0)/daysIn)}/day pace</div>}
                    </td>
                    <td style={{ textAlign: "center", padding: "12px 16px" }}>
                      {daysLeft > 0 && targetUnits && (
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#374151" }}>
                          {fmtNum(Math.round(rows.reduce((s,r)=>s+(r.rem||0),0) / daysLeft))}/day needed
                        </div>
                      )}
                    </td>
                    <td />
                    <td style={{ textAlign: "right", padding: "12px 16px", fontWeight: 700, fontSize: 15 }}>
                      {fmtKES(rows.reduce((s, r) => s + (r.revenue || 0), 0))}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Action plan ──────────────────────────────────────────────────────────────
const P_STYLE = {
  critical: { ...C.crit, icon: "🚨" },
  high:     { ...C.bad,  icon: "⚠️" },
  medium:   { ...C.warn, icon: "●" },
  good:     { ...C.good, icon: "✓" },
  info:     { ...C.muted, icon: "ℹ" },
};
function ActionPlan({ actions }) {
  if (!actions?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 24, overflow: "hidden" }}>
      <div style={{ padding: "18px 24px", borderBottom: "1px solid #f3f4f6", background: "#fafafa" }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: "#111827" }}>Priority Actions to Hit Target</div>
        <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>Data-driven steps — ordered by urgency</div>
      </div>
      <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
        {actions.map((a, i) => {
          const p = P_STYLE[a.priority] || P_STYLE.info;
          return (
            <div key={i} style={{ border: `1px solid ${p.bdr}`, background: p.bg, borderRadius: 10, padding: "14px 18px", display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{ fontSize: 20, flexShrink: 0, lineHeight: 1, marginTop: 2 }}>{p.icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: p.fg }}>
                  {a.title}
                  <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, background: p.fg, color: "#fff", borderRadius: 3, padding: "1px 6px", textTransform: "uppercase" }}>{a.priority}</span>
                </div>
                <div style={{ fontSize: 13, color: "#374151", marginTop: 5, lineHeight: 1.7 }}>{a.detail}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Historical context (collapsible) ────────────────────────────────────────
const HIST_KPIS = [
  { key: "revenue",      label: "Revenue",       f: "kes_c" },
  { key: "units",        label: "Items Sold",    f: "num" },
  { key: "transactions", label: "Transactions",  f: "num" },
  { key: "asp",          label: "ASP",           f: "kes_c", note: "Avg Selling Price = Revenue ÷ Units" },
  { key: "abv",          label: "ABV",           f: "kes_c", note: "Avg Basket Value = Revenue ÷ Transactions" },
  { key: "footfall",     label: "Footfall",      f: "num" },
  { key: "conversion",   label: "Conversion",    f: "pct" },
  { key: "customer_count","label": "Customers",  f: "num" },
  { key: "discount_rate", label: "Discount Rate",f: "pct" },
];

function HistoricalBaseline({ trendData, loading }) {
  const [open, setOpen] = useState(false);
  const months = trendData?.months || [];

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 24, overflow: "hidden" }}>
      <div onClick={() => setOpen(o => !o)}
           style={{ padding: "16px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", background: "#fafafa", borderBottom: open ? "1px solid #f3f4f6" : "none" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#374151" }}>6-Month Historical Baseline (reference)</div>
          <div style={{ fontSize: 12, color: "#9ca3af" }}>Used to derive targets · click to {open ? "collapse" : "expand"}</div>
        </div>
        <div style={{ fontSize: 18, color: "#9ca3af" }}>{open ? "▲" : "▼"}</div>
      </div>
      {open && (
        <div style={{ padding: "16px 24px", overflowX: "auto" }}>
          {loading && <Skeleton />}
          {!loading && months.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ background: "#f9fafb" }}>
                  <th style={{ textAlign: "left", padding: "10px 14px", color: "#6b7280", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #e5e7eb", minWidth: 160 }}>KPI</th>
                  {months.map(m => (
                    <th key={m.month} style={{ textAlign: "right", padding: "10px 14px", color: "#6b7280", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #e5e7eb", minWidth: 100 }}>{m.label}</th>
                  ))}
                  <th style={{ textAlign: "right", padding: "10px 14px", color: "#374151", fontSize: 12, fontWeight: 700, borderBottom: "2px solid #e5e7eb", minWidth: 110, background: "#f3f4f6" }}>6M Avg</th>
                </tr>
              </thead>
              <tbody>
                {HIST_KPIS.map(({ key, label, f, note }, ri) => {
                  const vals = months.map(m => m[key]).filter(v => v != null);
                  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                  return (
                    <tr key={key} style={{ borderBottom: "1px solid #f3f4f6", background: ri % 2 === 0 ? "#fff" : "#fafafa" }}>
                      <td style={{ padding: "11px 14px", fontWeight: 600, color: "#374151", fontSize: 14 }}>
                        {label}
                        {note && <div style={{ fontSize: 11, color: "#9ca3af", fontWeight: 400 }}>{note}</div>}
                      </td>
                      {months.map((m, i) => {
                        const v    = m[key];
                        const prev = months[i - 1]?.[key];
                        const chg  = v != null && prev != null && prev !== 0 ? (v - prev) / Math.abs(prev) * 100 : null;
                        return (
                          <td key={i} style={{ textAlign: "right", padding: "11px 14px", fontSize: 14, color: "#6b7280" }}>
                            {fmt(f, v)}
                            {chg != null && Math.abs(chg) >= 2 && (
                              <div style={{ fontSize: 10, color: chg >= 0 ? "#16a34a" : "#dc2626" }}>
                                {chg >= 0 ? "▲" : "▼"}{Math.abs(chg).toFixed(0)}%
                              </div>
                            )}
                          </td>
                        );
                      })}
                      <td style={{ textAlign: "right", padding: "11px 14px", fontWeight: 700, color: "#374151", fontSize: 14, background: "#f3f4f6" }}>
                        {fmt(f, avg)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════════════
const VOL_KPIS = [
  { key: "units",          label: "Items Sold",    fmtStr: "num" },
  { key: "transactions",   label: "Transactions",  fmtStr: "num" },
  { key: "footfall",       label: "Footfall",      fmtStr: "num" },
  { key: "customer_count", label: "Customers",     fmtStr: "num" },
];
const RATE_KPIS = [
  { key: "asp",                    label: "ASP — Avg Selling Price",   fmtStr: "kes" },
  { key: "abv",                    label: "ABV — Avg Basket Value",    fmtStr: "kes" },
  { key: "conversion",             label: "Conversion Rate",           fmtStr: "pct" },
  { key: "new_customer_pct",       label: "% New Customers",           fmtStr: "pct" },
  { key: "returning_customer_pct", label: "% Returning Customers",     fmtStr: "pct" },
  { key: "discount_rate",          label: "Discount Rate",             fmtStr: "pct", lowerBetter: true },
  { key: "return_rate",            label: "Return Rate",               fmtStr: "pct", lowerBetter: true },
];

export default function StoreProfiling() {
  const LS_KEY = "vivo_store_profile_last_store";

  const { data: locsData, isLoading: locsLoading } = useApi("store-profile/locations");
  const stores = locsData?.stores || [];

  const [store, setStore] = useState(() => {
    try { return localStorage.getItem(LS_KEY) || null; } catch { return null; }
  });
  useEffect(() => { if (!store && stores.length) setStore(stores[0].store); }, [store, stores]);
  useEffect(() => { if (store) { try { localStorage.setItem(LS_KEY, store); } catch {} } }, [store]);

  const { data: trendData, isLoading: trendLoading } = useApi("store-profile/kpi-trend", { store }, { enabled: !!store });
  const { data: rpt, isLoading: rptLoading, error: rptError } = useApi(
    "store-profile/performance-report", { store }, { enabled: !!store, staleTime: 5 * 60_000 }
  );

  const storeCountry = useMemo(() => stores.find(s => s.store === store)?.country || "", [stores, store]);
  const COUNTRY_C = { Kenya: { bg: "#f0fdf4", fg: "#15803d" }, Uganda: { bg: "#fffbeb", fg: "#b45309" }, Rwanda: { bg: "#f0fdfa", fg: "#0f766e" } };
  const cc = COUNTRY_C[storeCountry] || { bg: "#f3f4f6", fg: "#6b7280" };

  const {
    days_done = 0, days_in_month = 31, days_remaining = 28,
    target_revenue, required_daily_revenue,
    mtd, projected_eom, derived_targets,
    expected_source, actions = [], woc, msi, soh,
  } = rpt || {};

  return (
    <div style={{ maxWidth: 1320, margin: "0 auto", padding: "20px 16px" }}>
      {/* Page header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 26, fontWeight: 900, color: "#111827", margin: 0, letterSpacing: "-0.03em" }}>
          Store Performance Report
        </h1>
        <p style={{ fontSize: 13, color: "#6b7280", margin: "4px 0 0" }}>
          Head of Retail · August {new Date().getFullYear()} · Where we are · Where we need to be · What to do
        </p>
      </div>

      {/* Store selector bar */}
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "16px 22px", marginBottom: 24, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em", marginBottom: 4 }}>SELECT STORE</div>
          {locsLoading ? <div style={{ width: 240, height: 40, background: "#f3f4f6", borderRadius: 8 }} /> : (
            <select value={store || ""} onChange={e => setStore(e.target.value)}
              style={{ border: "2px solid #d1d5db", borderRadius: 8, padding: "8px 16px", fontSize: 16, fontWeight: 700, color: "#111827", minWidth: 260, background: "#fff", cursor: "pointer" }}>
              {stores.map(s => <option key={s.store} value={s.store}>{s.store}</option>)}
            </select>
          )}
        </div>
        {storeCountry && <div style={{ padding: "6px 14px", borderRadius: 6, fontSize: 13, fontWeight: 700, background: cc.bg, color: cc.fg }}>{storeCountry}</div>}
        {rpt && (
          <div style={{ fontSize: 14, color: "#374151" }}>
            <strong>Day {days_done}</strong> of {days_in_month} · <strong>{days_remaining} days remaining</strong>
            {expected_source && <span style={{ marginLeft: 10, color: "#9ca3af", fontSize: 13 }}>Baseline: {expected_source}</span>}
          </div>
        )}
        {woc != null && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 20, fontSize: 13, color: "#374151", flexWrap: "wrap" }}>
            <span>📦 SOH <strong>{fmtNum(soh)}</strong> units</span>
            <span>⏱ WOC <strong>{woc}w</strong></span>
            <span>📅 MSI <strong>{msi}mo</strong></span>
          </div>
        )}
      </div>

      {store && (
        <>
          {/* Revenue block */}
          {rptLoading && <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 32, marginBottom: 24 }}><Skeleton rows={4} /></div>}
          {rptError && <ErrBox msg={rptError?.message} />}
          {rpt && !target_revenue && (
            <div style={{ padding: "16px 20px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, marginBottom: 24, fontSize: 14, color: "#92400e" }}>
              ⚠ No August budget target found for this store. Performance shown against historical baseline only.
            </div>
          )}
          {rpt && target_revenue && (
            <RevenueBlock
              mtdRev={mtd?.revenue} target={target_revenue}
              projected={projected_eom?.revenue}
              daysDone={days_done} daysIn={days_in_month}
              daysLeft={days_remaining} reqDaily={required_daily_revenue}
            />
          )}

          {/* Volume KPI grid */}
          {rpt && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#111827", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
                Volume KPIs
                <span style={{ fontSize: 12, color: "#9ca3af", fontWeight: 400 }}>Targets derived at historical rates · ASP and ABV are averages (not counted here)</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 14 }}>
                {VOL_KPIS.map(({ key, fmtStr, label }) => (
                  <KpiCard key={key} kpiKey={key} label={label} fmtStr={fmtStr}
                    actual={mtd?.[key]} target={derived_targets?.[key]} projected={projected_eom?.[key]}
                    daysDone={days_done} daysLeft={days_remaining} daysIn={days_in_month} />
                ))}
              </div>
            </div>
          )}

          {/* Rate KPI grid */}
          {rpt && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#111827", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
                Performance Rates
                <span style={{ fontSize: 12, color: "#9ca3af", fontWeight: 400 }}>ASP = Revenue ÷ Units · ABV = Revenue ÷ Transactions · these are averages, not daily counts</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 14 }}>
                {RATE_KPIS.map(({ key, fmtStr, label, lowerBetter }) => (
                  <KpiCard key={key} kpiKey={key} label={label} fmtStr={fmtStr} lowerBetter={lowerBetter}
                    actual={mtd?.[key]} target={derived_targets?.[key]} projected={projected_eom?.[key]}
                    daysDone={days_done} daysLeft={days_remaining} daysIn={days_in_month} />
                ))}
              </div>
            </div>
          )}

          {/* Category targets */}
          <CategoryTargets store={store} rpt={rpt} />

          {/* Action plan */}
          {rpt && <ActionPlan actions={actions} />}

          {/* Historical baseline */}
          <HistoricalBaseline trendData={trendData} loading={trendLoading} />
        </>
      )}
    </div>
  );
}
