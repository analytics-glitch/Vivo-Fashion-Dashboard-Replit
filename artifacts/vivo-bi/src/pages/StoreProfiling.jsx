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
  good:  { fg: "#15803d", bg: "#f0fdf4", bdr: "#86efac" },
  ok:    { fg: "#0f766e", bg: "#f0fdfa", bdr: "#99f6e4" },
  warn:  { fg: "#b45309", bg: "#fffbeb", bdr: "#fde68a" },
  bad:   { fg: "#dc2626", bg: "#fef2f2", bdr: "#fecaca" },
  crit:  { fg: "#7f1d1d", bg: "#fff1f2", bdr: "#fca5a5" },
  muted: { fg: "#6b7280", bg: "#f9fafb", bdr: "#e5e7eb" },
  amber: { fg: "#92400e", bg: "#fffbeb", bdr: "#fde68a" },
  blue:  { fg: "#1d4ed8", bg: "#eff6ff", bdr: "#bfdbfe" },
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
function Sparkline({ values, w = 90, h = 26 }) {
  const vals = (values || []).filter(v => v != null);
  if (vals.length < 2) return <span style={{ color: "#d1d5db" }}>—</span>;
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const pts = values.map((v, i) => v == null ? null : `${(i / (values.length - 1)) * w},${h - 3 - ((v - min) / range) * (h - 6)}`).filter(Boolean).join(" ");
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={up ? "#16a34a" : "#dc2626"} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
function SectionTitle({ icon, title, subtitle, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, margin: "28px 0 14px" }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 900, color: "#111827", letterSpacing: "-0.02em" }}>{icon} {title}</div>
        {subtitle && <div style={{ fontSize: 13, color: "#6b7280", marginTop: 2 }}>{subtitle}</div>}
      </div>
      {right}
    </div>
  );
}

// ── KPI metadata ─────────────────────────────────────────────────────────────
const KPI_META = [
  { key: "revenue",                label: "Revenue",         f: "kes_c", vol: true,  unit: "" },
  { key: "units",                  label: "Items Sold",      f: "num",   vol: true,  unit: "items" },
  { key: "transactions",           label: "Transactions",    f: "num",   vol: true,  unit: "txns" },
  { key: "asp",                    label: "ASP",             f: "kes_c", rate: true, note: "Revenue ÷ Units" },
  { key: "abv",                    label: "ABV",             f: "kes_c", rate: true, note: "Revenue ÷ Transactions" },
  { key: "footfall",               label: "Footfall",        f: "num",   vol: true,  unit: "visitors" },
  { key: "conversion",             label: "Conversion",      f: "pct",   rate: true },
  { key: "customer_count",         label: "Customers",       f: "num",   vol: true,  unit: "customers" },
  { key: "new_customer_pct",       label: "% New Cust.",     f: "pct",   rate: true },
  { key: "returning_customer_pct", label: "% Returning",     f: "pct",   rate: true },
  { key: "discount_rate",          label: "Discount Rate",   f: "pct",   rate: true, lowerBetter: true },
  { key: "return_rate",            label: "Return Rate",     f: "pct",   rate: true, lowerBetter: true },
];

// health status vs baseline: compare projected full-month vs baseline (like-for-like)
function healthOf(projected, baseline, lowerBetter) {
  if (projected == null || baseline == null || baseline === 0) return null;
  let delta = (projected - baseline) / Math.abs(baseline) * 100;
  if (lowerBetter) delta = -delta;
  if (delta >= 3)   return { status: "strong", c: C.good,  label: "Strong",  delta };
  if (delta >= -6)  return { status: "steady", c: C.ok,    label: "Steady",  delta };
  if (delta >= -18) return { status: "watch",  c: C.warn,  label: "Watch",   delta };
  return { status: "issue", c: C.bad, label: "Issue", delta };
}

// ══════════════════════════════════════════════════════════════════════════════
// 0 · PRIORITY FOCUS — impact-ranked levers + metric interlinks
// ══════════════════════════════════════════════════════════════════════════════
const LEVER_C = {
  "traffic→sales":     C.blue,
  "traffic":           C.blue,
  "basket":            C.ok,
  "price/mix":         C.ok,
  "margin guardrail":  C.warn,
  "quality guardrail": C.warn,
  "pipeline":          C.muted,
};

function PriorityFocus({ rpt }) {
  const drivers = rpt?.priority_drivers || [];
  if (!drivers.length) {
    return (
      <div style={{ padding: "14px 18px", background: C.good.bg, border: `1px solid ${C.good.bdr}`, borderRadius: 10, fontSize: 14, color: C.good.fg }}>
        ✅ No metric is projecting below its baseline — hold the current playbook and defend conversion & basket.
      </div>
    );
  }
  const maxImpact = Math.max(...drivers.map(d => d.kes_impact || 0), 1);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {drivers.map(d => {
        const lc = LEVER_C[d.lever] || C.muted;
        const top = d.rank === 1;
        return (
          <div key={d.key} style={{ display: "flex", gap: 14, alignItems: "flex-start", background: "#fff", border: `1px solid ${top ? "#fca5a5" : "#e5e7eb"}`, borderLeft: `5px solid ${top ? C.bad.fg : lc.fg}`, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ width: 34, height: 34, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 15, background: top ? C.bad.bg : "#f3f4f6", color: top ? C.bad.fg : "#374151", border: `1px solid ${top ? C.bad.bdr : "#e5e7eb"}` }}>{d.rank}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>{d.label}</span>
                <Pill c={lc}>{d.lever}</Pill>
                <span style={{ fontSize: 12.5, color: "#6b7280" }}>{d.gap_text}</span>
              </div>
              <div style={{ fontSize: 13, color: "#4b5563", marginTop: 4 }}>{d.note}</div>
              {d.linked?.length > 0 && (
                <div style={{ fontSize: 11.5, color: "#6b7280", marginTop: 6 }}>
                  🔗 Moves with: {d.linked.map(k => KPI_META.find(m => m.key === k)?.label || k).join(" · ")}
                </div>
              )}
            </div>
            <div style={{ textAlign: "right", minWidth: 150, flexShrink: 0 }}>
              {d.kes_impact != null ? (
                <>
                  <div style={{ fontSize: 17, fontWeight: 900, color: top ? C.bad.fg : "#111827" }}>+{fmtKES(d.kes_impact)}</div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>if back to baseline{d.pct_of_gap != null ? ` · ~${d.pct_of_gap}% of gap` : ""}</div>
                  <div style={{ marginTop: 6, width: 140, marginLeft: "auto" }}>
                    <Bar value={d.kes_impact} max={maxImpact} color={top ? C.bad.fg : lc.fg} h={6} />
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic" }}>Future-month impact</div>
              )}
            </div>
          </div>
        );
      })}
      <div style={{ fontSize: 11.5, color: "#9ca3af" }}>
        Impact = extra full-month revenue if that one metric returns to baseline while the others stay at their projected level. Levers overlap (e.g. ASP feeds ABV) — treat the ranking as where attention pays most, not additive amounts.
      </div>
    </div>
  );
}

// ── AI Diagnosis — model reads the health check and names the real issues ────
const SEV_C = { high: C.bad, medium: C.warn, low: C.muted };
function AiDiagnosis({ store }) {
  const { data, isLoading, error } = useApi("store-profile/ai-diagnosis", { store }, { enabled: !!store, staleTime: 30 * 60_000 });
  if (isLoading) {
    return (
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 18px", fontSize: 13, color: "#6b7280", display: "flex", alignItems: "center", gap: 8 }}>
        <span className="pulse" style={{ fontSize: 16 }}>🤖</span> AI is reading this store's health check…
      </div>
    );
  }
  if (error || !data || data.configured === false || data.error) return null;
  const issues = data.issues || [];
  if (!issues.length && !data.summary) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #c7d2fe", borderRadius: 12, padding: "16px 18px", marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 16 }}>🤖</span>
        <span style={{ fontSize: 13.5, fontWeight: 800, color: "#3730a3" }}>AI Diagnosis</span>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>root-cause read of the numbers above</span>
      </div>
      {data.summary && <div style={{ fontSize: 13.5, color: "#374151", marginBottom: issues.length ? 10 : 0 }}>{data.summary}</div>}
      <div style={{ display: "grid", gap: 8 }}>
        {issues.map((it, i) => {
          const c = SEV_C[it.severity] || C.muted;
          const label = KPI_META.find(m => m.key === it.kpi)?.label || it.kpi;
          return (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: c.bg, border: `1px solid ${c.bdr}`, borderRadius: 8, padding: "10px 12px" }}>
              <Pill c={c}>{it.severity}</Pill>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#111827" }}>{label}</span>
                <span style={{ fontSize: 13, color: "#4b5563" }}> — {it.why}</span>
                {it.action && <div style={{ fontSize: 12.5, color: "#374151", marginTop: 3 }}><strong>Do:</strong> {it.action}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Driver interlink chain: how one metric leads to a change in the other
function DriverChain({ rpt }) {
  const statusByKey = useMemo(() => {
    const m = {};
    (rpt?.kpi_rows || []).forEach(r => { m[r.key] = r; });
    return m;
  }, [rpt]);
  const projected = rpt?.projected_eom || {};
  const expected  = rpt?.expected || {};

  const Node = ({ k, label, sub }) => {
    const meta = KPI_META.find(m => m.key === k);
    const h = healthOf(projected?.[k], expected?.[k], meta?.lowerBetter);
    const col = h?.c || C.muted;
    return (
      <div style={{ background: col.bg, border: `1.5px solid ${col.bdr}`, borderRadius: 10, padding: "10px 14px", textAlign: "center", minWidth: 108 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: "#111827" }}>{label}</div>
        <div style={{ fontSize: 14, fontWeight: 900, color: col.fg, marginTop: 2 }}>{fmt(meta?.f === "kes_c" ? "kes_c" : meta?.f, projected?.[k])}</div>
        {sub && <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{sub}</div>}
        {h && <div style={{ fontSize: 10, fontWeight: 700, color: col.fg, marginTop: 2 }}>{h.label}{h.delta != null ? ` ${h.delta > 0 ? "▲" : "▼"}${Math.abs(h.delta).toFixed(0)}%` : ""}</div>}
      </div>
    );
  };
  const Op = ({ children }) => (
    <div style={{ fontSize: 16, fontWeight: 900, color: "#9ca3af", padding: "0 2px", alignSelf: "center" }}>{children}</div>
  );

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px" }}>
      {/* Main revenue equation */}
      <div style={{ display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap", justifyContent: "center" }}>
        <Node k="footfall" label="Footfall" sub="visitors in" />
        <Op>×</Op>
        <Node k="conversion" label="Conversion" sub="visitors → buyers" />
        <Op>=</Op>
        <Node k="transactions" label="Transactions" sub="baskets sold" />
        <Op>×</Op>
        <Node k="abv" label="ABV" sub="value per basket" />
        <Op>=</Op>
        <Node k="revenue" label="Revenue" sub="net, projected" />
      </div>
      {/* Feeder relationships */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, marginTop: 16 }}>
        {[
          { kids: [["asp", "ASP"]], arrow: "→ ABV", note: "ABV = ASP × items per basket. Higher price per item lifts every basket." },
          { kids: [["discount_rate", "Discount Rate"]], arrow: "↓ ASP", note: "Deeper markdowns pull ASP (and so ABV) down — margin guardrail." },
          { kids: [["return_rate", "Return Rate"]], arrow: "↓ Revenue", note: "Returns subtract straight from net revenue after the sale." },
          { kids: [["new_customer_pct", "% New Cust."]], arrow: "→ future Footfall", note: "Today's new customers become the returning traffic of coming months." },
        ].map(({ kids, arrow, note }, i) => (
          <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 12px" }}>
            {kids.map(([k, label]) => <Node key={k} k={k} label={label} />)}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#374151" }}>{arrow}</div>
              <div style={{ fontSize: 11.5, color: "#6b7280", marginTop: 2 }}>{note}</div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: "#9ca3af", marginTop: 12 }}>
        Node colour = projected month vs baseline (green strong · teal steady · amber watch · red issue). Fixing an upstream metric (left) flows into every metric to its right.
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 1 · STORE HEALTH CHECK — issue radar
// ══════════════════════════════════════════════════════════════════════════════
function HealthCheck({ rpt }) {
  const { mtd, projected_eom, expected } = rpt || {};
  const tiles = useMemo(() => {
    if (!rpt) return [];
    const sevRank = { issue: 0, watch: 1, steady: 2, strong: 3 };
    return KPI_META.map(m => {
      const h = healthOf(projected_eom?.[m.key], expected?.[m.key], m.lowerBetter);
      return { ...m, actual: mtd?.[m.key], proj: projected_eom?.[m.key], base: expected?.[m.key], h };
    }).sort((a, b) => (a.h ? sevRank[a.h.status] : 9) - (b.h ? sevRank[b.h.status] : 9));
  }, [rpt]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = tiles.reduce((acc, t) => { if (t.h) acc[t.h.status] = (acc[t.h.status] || 0) + 1; return acc; }, {});

  return (
    <div>
      <SectionTitle icon="🩺" title="Store Health Check"
        subtitle="Each KPI's projected month vs its historical baseline — issues first, so problems surface immediately"
        right={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {counts.issue  > 0 && <Pill c={C.bad}>🔴 {counts.issue} issue{counts.issue > 1 ? "s" : ""}</Pill>}
            {counts.watch  > 0 && <Pill c={C.warn}>🟡 {counts.watch} watch</Pill>}
            {(counts.steady || 0) + (counts.strong || 0) > 0 && <Pill c={C.good}>🟢 {(counts.steady || 0) + (counts.strong || 0)} healthy</Pill>}
          </div>
        } />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
        {tiles.map(t => {
          const c = t.h?.c || C.muted;
          return (
            <div key={t.key} style={{ background: "#fff", border: `1px solid ${c.bdr}`, borderLeft: `5px solid ${c.fg}`, borderRadius: 10, padding: "12px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t.label}</span>
                {t.h && <Pill c={c}>{t.h.label}</Pill>}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#111827" }}>
                {fmt(t.f, t.actual)}
                {t.key === "new_customer_pct" && mtd?.new_customers != null && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#6b7280", marginLeft: 6 }}>· {mtd.new_customers} of {mtd.customer_count}</span>
                )}
                {t.key === "returning_customer_pct" && mtd?.returning_customers != null && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#6b7280", marginLeft: 6 }}>· {mtd.returning_customers} of {mtd.customer_count}</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: "#9ca3af" }}>MTD{t.note ? ` · ${t.note}` : ""}</div>
              {t.h && (
                <div style={{ fontSize: 12, fontWeight: 700, marginTop: 6, color: c.fg }}>
                  {t.h.delta >= 0 ? "▲" : "▼"} {Math.abs(t.h.delta).toFixed(0)}% vs baseline
                  <span style={{ fontWeight: 400, color: "#9ca3af" }}> ({fmt(t.f, t.base)})</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 2 · AUGUST TARGET TRACKER — revenue headline + compact KPI table
// ══════════════════════════════════════════════════════════════════════════════
function RevenueBlock({ mtdRev, target, projected, daysDone, daysIn, daysLeft, reqDaily }) {
  const progPct = mtdRev && target ? Math.round(mtdRev / target * 100) : null;
  const projPct = projected && target ? Math.round(projected / target * 100) : null;
  const sc = projPct != null ? scorePct(projPct) : C.muted;
  const gap = target && projected ? Math.max(0, target - projected) : null;
  const dailyAvg = mtdRev && daysDone > 0 ? Math.round(mtdRev / daysDone) : null;
  // TOTAL sales needed per remaining day to land exactly on target (what the
  // store must actually ring up each day — not the lift over current pace).
  const totalDaily = target != null && mtdRev != null && daysLeft > 0
    ? Math.max(0, Math.round((target - mtdRev) / daysLeft))
    : null;

  return (
    <div style={{ background: "#fff", border: `2px solid ${sc.bdr}`, borderRadius: 14, padding: "22px 26px", marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em" }}>Revenue · August Target</div>
          <div style={{ fontSize: 38, fontWeight: 900, color: "#111827", lineHeight: 1.1, marginTop: 2 }}>{fmtKES(target, false)}</div>
        </div>
        {projPct != null && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 12, color: "#6b7280" }}>Projected Month-End</div>
            <div style={{ fontSize: 26, fontWeight: 900, color: sc.fg }}>{fmtKES(projected)}</div>
            <Pill c={sc}>{projPct}% of target</Pill>
          </div>
        )}
      </div>
      <Bar value={mtdRev || 0} max={target || 1} color={sc.fg} h={14} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6b7280", margin: "6px 0 16px" }}>
        <span>MTD: <strong style={{ color: "#111827" }}>{fmtKES(mtdRev)} ({progPct ?? "—"}%)</strong> · {dailyAvg ? `${fmtKES(dailyAvg)}/day avg` : ""}</span>
        <span>Day {daysDone} of {daysIn}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        <div style={{ background: C.blue.bg, border: `1px solid ${C.blue.bdr}`, borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.blue.fg, textTransform: "uppercase" }}>📍 Where we are</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#111827", marginTop: 2 }}>{fmtKES(mtdRev, false)}</div>
        </div>
        <div style={{ background: C.amber.bg, border: `1px solid ${C.amber.bdr}`, borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: C.amber.fg, textTransform: "uppercase" }}>🎯 Where we need to be</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.amber.fg, marginTop: 2 }}>{fmtKES(target, false)}</div>
        </div>
        <div style={{ background: gap > 0 ? C.bad.bg : C.good.bg, border: `1px solid ${gap > 0 ? C.bad.bdr : C.good.bdr}`, borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: gap > 0 ? C.bad.fg : C.good.fg, textTransform: "uppercase" }}>⚡ What to do</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: gap > 0 ? C.bad.fg : C.good.fg, marginTop: 2 }}>
            {gap > 0 ? `Sell ${fmtKES(totalDaily, false)}/day` : "✓ On track"}
          </div>
          {gap > 0 && (
            <div style={{ fontSize: 11, color: "#374151" }}>
              total per day for the next {daysLeft} days
              {dailyAvg != null && reqDaily != null && (
                <> · currently {fmtKES(dailyAvg)}/day, so <strong>+{fmtKES(reqDaily)}/day more</strong></>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiTargetTable({ rpt }) {
  const { mtd, derived_targets, projected_eom, days_done, days_in_month, days_remaining, target_basis } = rpt || {};
  if (!rpt) return null;

  const rows = KPI_META.filter(m => m.key !== "revenue").map(m => {
    const actual = mtd?.[m.key];
    const tgt    = derived_targets?.[m.key];
    const proj   = projected_eom?.[m.key];
    const projPct = proj != null && tgt ? Math.round(proj / tgt * 100) : null;
    const sc = projPct != null ? scorePct(projPct, m.lowerBetter) : C.muted;

    let dailyAvg = null, needLabel = "—";
    if (m.vol) {
      dailyAvg = actual != null && days_done > 0 ? Math.round(actual / days_done) : null;
      const rem = actual != null && tgt != null ? Math.max(0, tgt - actual) : null;
      if (tgt == null)               needLabel = "no target set";
      else if (rem === 0)            needLabel = "✓ target reached";
      else if (days_remaining <= 0)  needLabel = "month complete";
      else if (rem != null)          needLabel = `${fmtNum(Math.round(rem / days_remaining))}/day for ${days_remaining}d`;
    } else if (tgt == null) {
      needLabel = "no target set";
    } else if (actual != null && tgt != null) {
      const gap = tgt - actual;
      const okDir = m.lowerBetter ? gap >= 0 : gap <= 0;
      needLabel = okDir
        ? "✓ at required level"
        : (m.lowerBetter ? `reduce by ${fmt(m.f, Math.abs(gap))}` : `lift by ${fmt(m.f, Math.abs(gap))}`);
    }
    return { ...m, actual, tgt, proj, projPct, sc, dailyAvg, needLabel, basis: target_basis?.[m.key] };
  });

  const th = { textAlign: "right", padding: "10px 14px", color: "#6b7280", fontWeight: 700, fontSize: 12, borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap", background: "#f9fafb" };
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", minWidth: 140 }}>KPI</th>
              <th style={{ ...th, background: "#eff6ff", color: C.blue.fg }}>MTD Actual</th>
              <th style={th}>Daily Avg</th>
              <th style={{ ...th, background: "#fffbeb", color: C.amber.fg }}>Month Target</th>
              <th style={th}>Projected</th>
              <th style={{ ...th, background: "#fff1f2", color: C.bad.fg, textAlign: "left", minWidth: 170 }}>⚡ What To Do</th>
              <th style={{ ...th, textAlign: "center" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key} style={{ borderBottom: "1px solid #f3f4f6", background: i % 2 ? "#fafafa" : "#fff" }}>
                <td style={{ padding: "11px 14px", fontWeight: 700, color: "#111827" }}>
                  {r.label}
                  {r.note && <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 400 }}>{r.note}</div>}
                </td>
                <td style={{ textAlign: "right", padding: "11px 14px", fontWeight: 800, fontSize: 15, color: C.blue.fg, background: "#f8faff" }}>{fmt(r.f, r.actual)}</td>
                <td style={{ textAlign: "right", padding: "11px 14px", color: "#6b7280" }}>{r.vol ? (r.dailyAvg != null ? `${fmtNum(r.dailyAvg)}/day` : "—") : "n/a"}</td>
                <td style={{ textAlign: "right", padding: "11px 14px", fontWeight: 800, fontSize: 15, color: C.amber.fg, background: "#fffef5" }} title={r.basis || ""}>{fmt(r.f, r.tgt)}</td>
                <td style={{ textAlign: "right", padding: "11px 14px", color: "#374151" }}>{fmt(r.f, r.proj)}</td>
                <td style={{ padding: "11px 14px", fontWeight: 700, fontSize: 13, color: r.needLabel.startsWith("✓") ? C.good.fg : C.bad.fg }}>{r.needLabel}</td>
                <td style={{ textAlign: "center", padding: "11px 14px" }}>{r.projPct != null ? <Pill c={r.sc}>{r.projPct}%</Pill> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 3 · PRODUCT PROFILE — category mix + embedded targets
// ══════════════════════════════════════════════════════════════════════════════
function CategoryTargets({ store, rpt }) {
  const [selCat, setSelCat] = useState("");

  const targetUnits = rpt?.derived_targets?.units;
  const daysIn      = rpt?.days_in_month  || 31;
  const daysLeft    = rpt?.days_remaining || 28;
  const daysDone    = rpt?.days_done      || 0;

  const curMonth = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }, []);

  const { data: mtdMix, isLoading: loadMtd } = useApi(
    "store-profile/category-mix",
    { store, month: curMonth, ...(selCat ? { category: selCat } : {}) },
    { enabled: !!store }
  );
  const { data: baseMix, isLoading: loadBase } = useApi(
    "store-profile/category-mix", { store }, { enabled: !!store }
  );

  const totalBase = baseMix?.total_units || 0;
  const toTgt = (baseUnits) => (!targetUnits || !totalBase || !baseUnits) ? null : Math.round(targetUnits * (baseUnits / totalBase));

  const rows = useMemo(() => {
    if (!mtdMix) return [];
    const baseCats = baseMix?.categories || [];
    const enrich = (list, keyField, baseList, baseDen, mtdDen) => (list || []).map((row, ci) => {
      const name = row[keyField];
      const bc = (baseList || []).find(c => c[keyField] === name);
      const tgt = toTgt(bc?.units);
      const rem = tgt != null && row.units != null ? Math.max(0, tgt - row.units) : null;
      const da  = daysDone > 0 && row.units != null ? +(row.units / daysDone).toFixed(1) : null;
      const dn  = daysLeft > 0 && rem != null ? +(rem / daysLeft).toFixed(1) : null;
      // Same-scope denominators: store-level for categories, category-level for sub-categories
      const basePct = baseDen && bc?.units ? bc.units / baseDen * 100 : null;
      const mtdPct  = mtdDen && row.units ? row.units / mtdDen * 100 : null;
      const mixShift = basePct != null && mtdPct != null ? mtdPct - basePct : null;
      const soh = row.soh ?? null;
      // Days of stock at the pace the target demands (fall back to actual pace)
      const rate = (dn != null && dn > 0) ? dn : (da != null && da > 0 ? da : null);
      const coverDays = soh != null && rate ? Math.round(soh / rate) : null;
      const stockShort = soh != null && rem != null && rem > 0 && soh < rem;
      return {
        ...row, name, tgt, rem, dailyActual: da, dailyNeeded: dn,
        soh, coverDays, stockShort,
        dailyGap: dn != null && da != null ? dn - da : null,
        basePct, mtdPct, mixShift,
        baseAsp: bc?.asp,
        color: BAR_COLORS[ci % BAR_COLORS.length],
        hasSubs: !!(row.subcategories || []).length,
      };
    });
    if (!selCat) return enrich(mtdMix.categories || [], "category", baseCats, totalBase, mtdMix.total_units);
    const cat = (mtdMix.categories || []).find(c => c.category === selCat);
    const bc  = baseCats.find(c => c.category === selCat);
    return enrich(cat?.subcategories || [], "subcategory", bc?.subcategories || [], bc?.units, cat?.units);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mtdMix, baseMix, selCat, targetUnits, totalBase, daysLeft, daysDone]);

  const loading = loadMtd || loadBase;
  const th = { padding: "10px 14px", color: "#6b7280", fontWeight: 700, fontSize: 12, borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap", background: "#f9fafb" };

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "14px 20px", borderBottom: "1px solid #f3f4f6", background: "#fafafa", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#374151" }}>
          {selCat ? `${selCat} → sub-categories` : "All categories"} · August MTD vs full-month targets · mix shift vs 6-month norm
        </div>
        {selCat && (
          <button onClick={() => setSelCat("")}
            style={{ background: "none", border: "1px solid #d1d5db", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#374151" }}>
            ← All categories
          </button>
        )}
      </div>
      {loading && <div style={{ padding: 20 }}><Skeleton rows={6} /></div>}
      {!loading && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left", minWidth: 170 }}>{selCat ? "Sub-Category" : "Category"}</th>
                <th style={{ ...th, textAlign: "right", background: "#eff6ff", color: C.blue.fg }}>MTD Units</th>
                <th style={{ ...th, textAlign: "right" }}>Pace</th>
                <th style={{ ...th, textAlign: "right", background: "#fffbeb", color: C.amber.fg }}>Aug Target</th>
                <th style={{ ...th, textAlign: "left", background: "#fff1f2", color: C.bad.fg, minWidth: 160 }}>⚡ What To Do</th>
                <th style={{ ...th, textAlign: "right" }} title="Units currently in stock at this store, and how many days that lasts at the pace the target requires">Stock (Cover)</th>
                <th style={{ ...th, textAlign: "right" }}>Mix vs Norm</th>
                <th style={{ ...th, textAlign: "right" }}>ASP</th>
                <th style={{ ...th, textAlign: "right" }}>Revenue MTD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const onTrack = row.dailyGap != null ? row.dailyGap <= 0 : null;
                const bg = idx % 2 ? "#fafafa" : "#fff";
                const progPct = row.tgt && row.units != null ? Math.round(row.units / row.tgt * 100) : null;
                const aspDelta = row.asp != null && row.baseAsp ? (row.asp - row.baseAsp) / row.baseAsp * 100 : null;
                return (
                  <tr key={row.name} style={{ borderBottom: "1px solid #f3f4f6", background: bg, cursor: !selCat && row.hasSubs ? "pointer" : "default" }}
                      onClick={() => !selCat && row.hasSubs && setSelCat(row.name)}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f0f4ff")}
                      onMouseLeave={e => (e.currentTarget.style.background = bg)}>
                    <td style={{ padding: "12px 14px", fontWeight: 700, color: "#111827" }}>
                      <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: row.color, marginRight: 9, verticalAlign: "middle" }} />
                      {row.name}
                      {!selCat && row.hasSubs && <span style={{ fontSize: 10, color: "#6366f1", marginLeft: 7 }}>↵ drill</span>}
                    </td>
                    <td style={{ textAlign: "right", padding: "12px 14px", background: "#f8faff" }}>
                      <div style={{ fontWeight: 800, fontSize: 15, color: C.blue.fg }}>{fmtNum(row.units)}</div>
                      {row.tgt != null && <div style={{ fontSize: 11, color: "#9ca3af" }}>{progPct}% of target</div>}
                    </td>
                    <td style={{ textAlign: "right", padding: "12px 14px", color: "#6b7280", fontSize: 13 }}>
                      {row.dailyActual != null ? `${row.dailyActual}/day` : "—"}
                    </td>
                    <td style={{ textAlign: "right", padding: "12px 14px", background: "#fffef5" }}>
                      {row.tgt != null ? (
                        <>
                          <div style={{ fontWeight: 800, fontSize: 15, color: C.amber.fg }}>{fmtNum(row.tgt)}</div>
                          <div style={{ fontSize: 11, color: "#b45309" }}>{Math.round(row.tgt / daysIn)}/day pace</div>
                        </>
                      ) : <span style={{ color: "#9ca3af", fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ padding: "12px 14px" }}>
                      {row.dailyNeeded != null ? (
                        <span style={{ fontWeight: 700, fontSize: 13, color: onTrack ? C.good.fg : C.bad.fg }}>
                          {row.dailyNeeded}/day needed
                          {row.dailyGap != null && (
                            <span style={{ fontWeight: 400, display: "block", fontSize: 11, color: onTrack ? C.good.fg : C.bad.fg }}>
                              {onTrack ? `✓ ${Math.abs(row.dailyGap).toFixed(1)}/day ahead` : `▲ +${row.dailyGap.toFixed(1)}/day more`}
                            </span>
                          )}
                        </span>
                      ) : row.rem === 0 ? <Pill c={C.good}>✓ Target hit</Pill> : <span style={{ color: "#9ca3af" }}>—</span>}
                      {row.stockShort && (
                        <div style={{ fontSize: 11, fontWeight: 700, color: C.amber.fg, marginTop: 2 }}>
                          ⚠ only {fmtNum(row.soh)} in stock vs {fmtNum(row.rem)} to sell — needs replenishment
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: "right", padding: "12px 14px", fontSize: 13 }}>
                      {row.soh != null ? (
                        <>
                          <div style={{ fontWeight: 700, color: row.stockShort ? C.amber.fg : "#374151" }}>{fmtNum(row.soh)}</div>
                          {row.coverDays != null && (
                            <div style={{ fontSize: 10, color: row.coverDays < daysLeft ? C.amber.fg : "#9ca3af" }}>
                              ~{row.coverDays}d cover
                            </div>
                          )}
                        </>
                      ) : "—"}
                    </td>
                    <td style={{ textAlign: "right", padding: "12px 14px", fontSize: 13 }}>
                      {row.mixShift != null ? (
                        <span style={{ fontWeight: 700, color: Math.abs(row.mixShift) < 1.5 ? "#6b7280" : row.mixShift > 0 ? C.good.fg : C.bad.fg }}>
                          {row.mixShift > 0 ? "▲" : "▼"} {Math.abs(row.mixShift).toFixed(1)}pp
                        </span>
                      ) : "—"}
                    </td>
                    <td style={{ textAlign: "right", padding: "12px 14px", fontSize: 14, fontWeight: 600, color: "#374151" }}>
                      {fmtKES(row.asp)}
                      {aspDelta != null && Math.abs(aspDelta) >= 3 && (
                        <div style={{ fontSize: 10, color: aspDelta > 0 ? C.good.fg : C.bad.fg }}>{aspDelta > 0 ? "▲" : "▼"}{Math.abs(aspDelta).toFixed(0)}% vs norm</div>
                      )}
                    </td>
                    <td style={{ textAlign: "right", padding: "12px 14px", fontSize: 14, color: "#374151" }}>{fmtKES(row.revenue)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={9} style={{ textAlign: "center", padding: 36, color: "#9ca3af" }}>No category data for August yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 4 · TREND PROFILE — 6-month table with sparklines
// ══════════════════════════════════════════════════════════════════════════════
function TrendProfile({ trendData, loading }) {
  const months = trendData?.months || [];
  const th = { textAlign: "right", padding: "9px 12px", color: "#6b7280", fontWeight: 700, fontSize: 12, borderBottom: "2px solid #e5e7eb", whiteSpace: "nowrap", background: "#f9fafb" };
  if (loading) return <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 20 }}><Skeleton rows={8} /></div>;
  if (!months.length) return null;

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", minWidth: 130 }}>KPI</th>
              {months.map(m => <th key={m.month} style={th}>{m.label}</th>)}
              <th style={{ ...th, background: "#f3f4f6" }}>6M Avg</th>
              <th style={{ ...th, textAlign: "center" }}>Trend</th>
            </tr>
          </thead>
          <tbody>
            {KPI_META.map(({ key, label, f, note }, ri) => {
              const vals = months.map(m => m[key]);
              const valid = vals.filter(v => v != null);
              const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
              return (
                <tr key={key} style={{ borderBottom: "1px solid #f3f4f6", background: ri % 2 ? "#fafafa" : "#fff" }}>
                  <td style={{ padding: "9px 12px", fontWeight: 700, color: "#374151" }}>
                    {label}
                    {note && <div style={{ fontSize: 10, color: "#9ca3af", fontWeight: 400 }}>{note}</div>}
                  </td>
                  {vals.map((v, i) => {
                    const prev = vals[i - 1];
                    const chg = v != null && prev != null && prev !== 0 ? (v - prev) / Math.abs(prev) * 100 : null;
                    return (
                      <td key={i} style={{ textAlign: "right", padding: "9px 12px", color: "#6b7280" }}>
                        {fmt(f, v)}
                        {chg != null && Math.abs(chg) >= 2 && (
                          <div style={{ fontSize: 10, color: chg >= 0 ? "#16a34a" : "#dc2626" }}>{chg >= 0 ? "▲" : "▼"}{Math.abs(chg).toFixed(0)}%</div>
                        )}
                      </td>
                    );
                  })}
                  <td style={{ textAlign: "right", padding: "9px 12px", fontWeight: 700, color: "#374151", background: "#f3f4f6" }}>{fmt(f, avg)}</td>
                  <td style={{ padding: "9px 12px", textAlign: "center" }}><Sparkline values={vals} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 5 · ACTION PLAN
// ══════════════════════════════════════════════════════════════════════════════
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
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {actions.map((a, i) => {
        const p = P_STYLE[a.priority] || P_STYLE.info;
        return (
          <div key={i} style={{ border: `1px solid ${p.bdr}`, background: p.bg, borderRadius: 10, padding: "13px 17px", display: "flex", gap: 13, alignItems: "flex-start" }}>
            <div style={{ fontSize: 19, flexShrink: 0, lineHeight: 1, marginTop: 2 }}>{p.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: p.fg }}>
                {a.title}
                <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, background: p.fg, color: "#fff", borderRadius: 3, padding: "1px 6px", textTransform: "uppercase" }}>{a.priority}</span>
              </div>
              <div style={{ fontSize: 13, color: "#374151", marginTop: 4, lineHeight: 1.65 }}>{a.detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE — the Store Profile
// ══════════════════════════════════════════════════════════════════════════════
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
    mtd, projected_eom, expected_source, actions = [], woc, msi, soh,
  } = rpt || {};

  // Stock health flag
  const stockFlag = woc == null ? null
    : woc < 6  ? { c: C.bad,  label: "Low cover — replenish risk" }
    : woc > 30 ? { c: C.warn, label: "Heavy cover — overstock risk" }
    : { c: C.good, label: "Healthy cover" };

  return (
    <div style={{ maxWidth: 1340, margin: "0 auto", padding: "20px 16px" }}>
      {/* ── Store identity header ── */}
      <div style={{ background: "linear-gradient(135deg, #111827 0%, #1f2937 100%)", borderRadius: 14, padding: "22px 26px", marginBottom: 20, color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.1em", marginBottom: 6 }}>STORE PROFILE</div>
            {locsLoading ? <div style={{ width: 260, height: 44, background: "#374151", borderRadius: 8 }} /> : (
              <select value={store || ""} onChange={e => setStore(e.target.value)}
                style={{ border: "1px solid #4b5563", borderRadius: 8, padding: "9px 16px", fontSize: 20, fontWeight: 800, color: "#fff", minWidth: 280, background: "#1f2937", cursor: "pointer" }}>
                {stores.map(s => <option key={s.store} value={s.store}>{s.store}</option>)}
              </select>
            )}
            <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {storeCountry && <span style={{ padding: "3px 10px", borderRadius: 5, fontSize: 12, fontWeight: 700, background: cc.bg, color: cc.fg }}>{storeCountry}</span>}
              <span style={{ fontSize: 13, color: "#d1d5db" }}>August {new Date().getFullYear()} · Day {days_done} of {days_in_month} · {days_remaining} days left</span>
              {expected_source && <span style={{ fontSize: 12, color: "#9ca3af" }}>Baseline: {expected_source}</span>}
            </div>
          </div>
          {/* Quick facts */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {[
              { label: "Stock on Hand", val: fmtNum(soh), sub: "units" },
              { label: "Weeks of Cover", val: woc != null ? `${woc}w` : "—", sub: stockFlag?.label, subColor: stockFlag?.c?.fg },
              { label: "Months of Stock", val: msi != null ? `${msi}mo` : "—", sub: "MSI" },
              { label: "MTD Revenue", val: fmtKES(mtd?.revenue), sub: `${target_revenue ? Math.round((mtd?.revenue || 0) / target_revenue * 100) : "—"}% of target` },
            ].map(({ label, val, sub, subColor }) => (
              <div key={label} style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, padding: "12px 18px", minWidth: 130 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 900, marginTop: 3 }}>{val}</div>
                {sub && <div style={{ fontSize: 11, color: subColor ? "#fbbf24" : "#9ca3af", marginTop: 1 }}>{sub}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {store && (
        <>
          {rptError && <ErrBox msg={rptError?.message} />}
          {rptLoading && <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 24 }}><Skeleton rows={6} /></div>}

          {/* 1 · Health Check — where the issues are */}
          {rpt && <HealthCheck rpt={rpt} />}

          {/* 1b · Priority Focus — impact-ranked levers to hit target */}
          {rpt && (
            <>
              <SectionTitle icon="🎯" title="Priority Focus"
                subtitle="Ranked by revenue impact — fix the top item first, it recovers the most of the gap to target" />
              <PriorityFocus rpt={rpt} />
              <AiDiagnosis store={store} />
              <SectionTitle icon="🔗" title="How the Metrics Interlink"
                subtitle="One metric leads to a change in the next — the revenue equation this store runs on" />
              <DriverChain rpt={rpt} />
            </>
          )}

          {/* 2 · August Target Tracker */}
          {rpt && (
            <>
              <SectionTitle icon="🎯" title="August Target Tracker"
                subtitle="Where we are · where we need to be · what to do — every KPI against the monthly budget" />
              {!target_revenue && (
                <div style={{ padding: "14px 18px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, marginBottom: 14, fontSize: 14, color: "#92400e" }}>
                  ⚠ No August budget target found for this store — tracking against historical baseline only.
                </div>
              )}
              {target_revenue && (
                <RevenueBlock mtdRev={mtd?.revenue} target={target_revenue} projected={projected_eom?.revenue}
                  daysDone={days_done} daysIn={days_in_month} daysLeft={days_remaining} reqDaily={required_daily_revenue} />
              )}
              <KpiTargetTable rpt={rpt} />
            </>
          )}

          {/* 3 · Product Profile */}
          <SectionTitle icon="👗" title="Product Profile"
            subtitle="Category & sub-category performance — MTD progress vs targets, plus mix shifts vs the store's 6-month norm" />
          <CategoryTargets store={store} rpt={rpt} />

          {/* 4 · Priority Actions */}
          {rpt && actions.length > 0 && (
            <>
              <SectionTitle icon="⚡" title="Priority Actions" subtitle="Data-driven steps, ordered by urgency" />
              <ActionPlan actions={actions} />
            </>
          )}

          {/* 5 · Trend Profile */}
          <SectionTitle icon="📈" title="6-Month Trend Profile"
            subtitle="How this store has been performing — the baseline behind the targets" />
          <TrendProfile trendData={trendData} loading={trendLoading} />

          <div style={{ height: 30 }} />
        </>
      )}
    </div>
  );
}
