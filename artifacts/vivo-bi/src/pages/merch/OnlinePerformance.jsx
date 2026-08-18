/**
 * Online Performance tab — Merchandising Hub
 * Channel split: online (Shop Zetu / online feed) vs retail stores.
 *
 * API contracts:
 *   online-performance → { has_channel, granularity, kpis:{...}, trend:[...],
 *                          categories:[...], sizes:[...], colours:[...],
 *                          mix:{online,retail}, soh_by_category:[...] }
 *   online-subcats     → { category, rows:[{subcategory, online_sor,
 *                          retail_sor, online_units, retail_units}] }
 *
 * Honours the global period / brand / subcategory / country filters via
 * useMerchFilters; adds a local "Online only / Compare" toggle. Every card
 * has a Download CSV control exporting that section's underlying rows.
 */
import React, { useMemo, useState, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, CartesianGrid,
  Tooltip, Legend, LineChart, Line, Cell, ReferenceArea,
  ComposedChart, LabelList,
} from "recharts";
import { DownloadSimple, ArrowCounterClockwise, Megaphone, XCircle } from "@phosphor-icons/react";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import {
  useMerchData, MerchKPICard, ChartCard, C, fmtKESM, fmtAxisM,
  useMerchPeriodLabel, wocColor, fmtNum,
} from "./MerchHelpers";
import { useMerchFilters } from "@/pages/MerchandisingHub";
import { api, fmtKES, fmtPct } from "@/lib/api";

const ONLINE_C = C.blue;
const RETAIL_C = C.teal;

// ── CSV helper (client-side, per-section) ────────────────────────────────────
const downloadCsv = (rows, filename) => {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

const DownloadBtn = ({ rows, filename, testId }) => (
  <button
    type="button"
    onClick={() => downloadCsv(rows, filename)}
    disabled={!rows?.length}
    className="shrink-0 px-1.5 py-1 rounded-md inline-flex items-center gap-1 text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-40"
    title="Download CSV"
    data-testid={testId}
  >
    <DownloadSimple size={14} />
    <span className="text-[10.5px] font-semibold whitespace-nowrap">Download CSV</span>
  </button>
);

// ChartCard with a Download CSV control in the header (same visual shell)
const DlChartCard = ({ title, rows, filename, children, className = "", testId }) => (
  <div className={`bg-white rounded-xl shadow-sm p-4 sm:p-5 ${className}`} data-testid={testId}>
    <div className="flex items-start justify-between gap-2 mb-3">
      <div className="text-[12px] font-semibold text-slate-500">{title}</div>
      <DownloadBtn rows={rows} filename={filename} testId={testId ? `${testId}-download` : undefined} />
    </div>
    {children}
  </div>
);

// ── SIZE ANALYSIS (online-scoped twin of the store cockpit section) ──────────
const OnlineSizeAnalysis = ({ rows, periodLabel }) => {
  const sorRows = useMemo(() => [...(rows || [])]
    .map((r) => ({
      ...r,
      name: r.size || "—",
      sorValue: r.online_sor == null ? -1 : Number(r.online_sor),
      sorLabel: r.online_sor == null ? "—" : `${Number(r.online_sor).toFixed(1)}%`,
    }))
    .sort((a, b) => (b.sorValue - a.sorValue) || (b.online_units - a.online_units)), [rows]);
  const sohRows = useMemo(() => [...(rows || [])]
    .map((r) => ({
      ...r,
      name: r.size || "—",
      sohValue: Number(r.online_soh || 0),
      sohLabel: `${fmtNum(r.online_soh)} · ${r.online_soh_share == null ? "—" : `${Number(r.online_soh_share).toFixed(1)}%`}`,
    }))
    .sort((a, b) => (b.sohValue - a.sohValue) || a.name.localeCompare(b.name)), [rows]);

  if (!rows?.length) return null;
  return (
    <div className="card-white p-5" data-testid="op-size-analysis">
      <div className="mb-3">
        <div className="eyebrow">Size Analysis</div>
        <div className="text-[11.5px] text-muted mt-1">
          Online · {periodLabel || "selected period"} · active styles only
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-4 gap-y-5">
        <div>
          <div className="text-[11.5px] font-semibold text-foreground/70 mb-1">
            Sell-Through by Size (Online SOR)
          </div>
          <div className="text-[10px] text-foreground/50 mb-1">
            Online SOR with weighted benchmark by size
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={sorRows} margin={{ top: 20, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 8 }} interval={0}
                angle={-45} textAnchor="end" height={64} />
              <YAxis tick={{ fontSize: 9 }} domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} />
              <Tooltip content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
                    <div className="font-bold mb-0.5">{d.name}</div>
                    <div>Online SOR: <span className="font-semibold">{d.online_sor == null ? "—" : `${Number(d.online_sor).toFixed(1)}%`}</span></div>
                    <div>Online benchmark: {d.benchmark_sor == null ? "—" : `${Number(d.benchmark_sor).toFixed(1)}%`}</div>
                    <div>Units sold: {fmtNum(d.online_units)}</div>
                    <div>SOH: {fmtNum(d.online_soh)}</div>
                  </div>
                );
              }} />
              <Bar dataKey="online_sor" fill="#4b7bec" radius={[3, 3, 0, 0]} minPointSize={2}>
                <LabelList dataKey="sorLabel" position="top"
                  style={{ fontSize: 8, fill: "#64748b", fontWeight: 700 }} />
              </Bar>
              <Line type="monotone" dataKey="benchmark_sor" name="Online benchmark"
                stroke="#1f2937" strokeWidth={2} dot={{ r: 3, fill: "#1f2937" }}
                activeDot={{ r: 4 }} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="mt-1 text-[10px] text-foreground/60">
            <span className="inline-block w-7 border-t-2 border-[#1f2937] align-middle mr-1.5" />
            Online benchmark per size
          </div>
        </div>
        <div>
          <div className="text-[11.5px] font-semibold text-foreground/70 mb-1">
            Online Stock on Hand by Size
          </div>
          <div className="text-[10px] text-foreground/50 mb-1">
            Current online stock · labels show units and share of online SOH
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={sohRows} margin={{ top: 20, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 8 }} interval={0}
                angle={-45} textAnchor="end" height={64} />
              <YAxis tick={{ fontSize: 9 }} />
              <Tooltip content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload;
                return (
                  <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
                    <div className="font-bold mb-0.5">{d.name}</div>
                    <div>Online SOH: <span className="font-semibold">{fmtNum(d.online_soh)}</span></div>
                    <div>Share of online SOH: {d.online_soh_share == null ? "—" : `${Number(d.online_soh_share).toFixed(1)}%`}</div>
                    <div>Online SOR: {d.online_sor == null ? "—" : `${Number(d.online_sor).toFixed(1)}%`}</div>
                  </div>
                );
              }} />
              <Bar dataKey="online_soh" fill="#4b7bec" radius={[3, 3, 0, 0]} minPointSize={2}>
                <LabelList dataKey="sohLabel" position="top"
                  style={{ fontSize: 8, fill: "#64748b", fontWeight: 700 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};

const PctTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
      <div className="font-semibold text-slate-700 mb-1 max-w-[200px] truncate">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex gap-2 items-center">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.fill || p.color || p.stroke }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="font-semibold">{p.value === null || p.value === undefined ? "—" : `${Number(p.value).toFixed(1)}%`}</span>
        </div>
      ))}
    </div>
  );
};

const KesTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
      <div className="font-semibold text-slate-700 mb-1">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex gap-2 items-center">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.stroke || p.fill }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="font-semibold">{fmtKESM(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

const twoVal = (a, b, fmt = (v) => (v === null || v === undefined ? "—" : `${v}%`)) => (
  <span className="tabular-nums">
    <span style={{ color: ONLINE_C }}>{fmt(a)}</span>
    <span className="text-slate-300 mx-1.5">/</span>
    <span style={{ color: RETAIL_C }}>{fmt(b)}</span>
  </span>
);

// ── Auto insights ─────────────────────────────────────────────────────────────
const buildInsights = (d, compare) => {
  if (!d) return [];
  const out = [];
  const { kpis, sizes = [], categories = [], trend = [] } = d;

  if (compare) {
    for (const s of sizes) {
      if (s.gap_pp !== null && Math.abs(s.gap_pp) > 10) {
        out.push(`${s.size || "Unsized"} SOR is ${Math.abs(s.gap_pp).toFixed(0)}pp ${s.gap_pp > 0 ? "higher" : "lower"} online than in retail (${s.online_sor}% vs ${s.retail_sor}%).`);
      }
    }
    for (const c of categories) {
      if (c.online_sor !== null && c.retail_sor !== null && c.retail_sor - c.online_sor > 10) {
        out.push(`${c.category}: online SOR (${c.online_sor}%) is materially below retail (${c.retail_sor}%) — ${(c.retail_sor - c.online_sor).toFixed(0)}pp gap.`);
      }
      if (c.online_rev_share !== null && c.retail_rev_share !== null && c.online_rev_share - c.retail_rev_share > 8) {
        out.push(`${c.category} over-indexes online: ${c.online_rev_share}% of online revenue vs ${c.retail_rev_share}% of retail.`);
      }
    }
  }
  // discount depth trend: last 4 buckets vs prior 4
  const depths = trend.map((t) => t.depth_online).filter((v) => v !== null && v !== undefined);
  if (depths.length >= 8) {
    const last4 = depths.slice(-4), prior4 = depths.slice(-8, -4);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const dl = avg(last4), dp = avg(prior4);
    if (dl - dp > 2) out.push(`Online discount depth is trending up: ${dl.toFixed(1)}% avg over the last 4 ${d.granularity}s vs ${dp.toFixed(1)}% in the prior 4.`);
  }
  if (kpis?.online_share_pct !== null && kpis?.online_share_pct !== undefined) {
    out.push(`Online contributes ${kpis.online_share_pct}% of total revenue in the selected period.`);
  }
  return out.slice(0, 8);
};

// ── Online Colourway Performance ──────────────────────────────────────────────
// Full mirror of the Style Deep Dive's Colourway Performance section, scoped
// entirely to online channel data and lifted to page level: colourways are
// (style · colour) rows across the whole online assortment. Signal
// classification (same COLOR_REC thresholds, Restock › Marketing › Retire
// precedence) is server-side because it needs style facts across many styles.

// Display-only tidy-up for colour labels carrying style-number/size noise —
// same rules as the deep dive's tidyColorLabel (raw value stays the data key).
const CW_CODE_TOKEN = /^\S*\d\S*$/;
const CW_SIZE_TOKEN = /^[smlx]{1,4}$/i;
const tidyColour = (raw) => {
  const s = String(raw || "").trim();
  if (!s) return "—";
  const parts = s.split("/").map((p) => p.trim()).filter(Boolean);
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (CW_CODE_TOKEN.test(last) || CW_SIZE_TOKEN.test(last) || /^[A-Za-z]$/.test(last)) parts.pop();
    else break;
  }
  const out = parts.join(" / ").replace(/^(.+?) - \1$/, "$1");
  return out || s;
};

const CW_GROUP_STYLES = {
  restock:   { bg: "bg-emerald-50", border: "border-emerald-300", title: "text-emerald-800", tag: "bg-emerald-700", chip: "border-emerald-200" },
  marketing: { bg: "bg-amber-50",   border: "border-amber-300",   title: "text-amber-800",   tag: "bg-amber-600",   chip: "border-amber-200" },
  retire:    { bg: "bg-rose-50",    border: "border-rose-300",    title: "text-rose-700",    tag: "bg-rose-600",    chip: "border-rose-200" },
};

const cwDaysAgo = (d) =>
  d === null || d === undefined ? "—" : d <= 0 ? "today" : d === 1 ? "1d ago" : `${d}d ago`;

// One signal group card — header + rule line + colourway chips (or the
// "None qualify." state; a group never disappears). Mirrors the deep dive's
// RecGroup, with the style name added to each chip (page-level context).
const CwRecGroup = ({ variant, icon: Icon, title, rule, group, renderFigures }) => {
  const st = CW_GROUP_STYLES[variant];
  const items = group?.items || [];
  const count = group?.count ?? items.length;
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${st.bg} ${st.border}`}>
      <div className={`flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wide ${st.title}`}>
        <Icon size={13} weight="bold" className="flex-shrink-0" />
        <span className="truncate">{title}</span>
        <span className={`ml-auto flex-shrink-0 min-w-[18px] text-center text-[10px] px-1.5 py-0.5 rounded-full text-white ${st.tag}`}>
          {count}
        </span>
      </div>
      <div className="mt-0.5 text-[9.5px] leading-snug text-foreground/50">{rule}</div>
      {items.length === 0 ? (
        <div className="mt-2 text-[10.5px] italic text-foreground/50">None qualify.</div>
      ) : (
        <div className="mt-2 space-y-1.5">
          {items.map((c) => (
            <div key={`${c.style_number}|${c.color}`} className={`bg-white/80 rounded-md border px-2 py-1.5 ${st.chip}`}>
              <div className="text-[11px] font-bold text-foreground truncate" title={`${c.style_name} · ${c.color}`}>
                {tidyColour(c.color)} · {c.style_name}
              </div>
              <div className="mt-0.5 text-[10px] text-foreground/70 flex flex-wrap gap-x-2 gap-y-0.5 tabular-nums">
                {renderFigures(c)}
              </div>
            </div>
          ))}
          {count > items.length && (
            <div className="text-[9.5px] italic text-foreground/50">
              +{count - items.length} more qualify (top {items.length} shown)
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function OnlineColourwayPerformance({ filters, periodLabel }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [view, setView] = useState("colour"); // "colour" | "size"

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get("/merch/online-colourways", {
      params: {
        from_date: filters.from_date,
        to_date: filters.to_date,
        country: filters.country || undefined,
        brand: filters.brand || undefined,
        subcategory: filters.subcategory || undefined,
      },
    })
      .then((r) => { if (!cancelled) setState({ loading: false, data: r.data, error: null }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, data: null, error: e?.message || "Failed to load colourway performance" }); });
    return () => { cancelled = true; };
  }, [filters.from_date, filters.to_date, filters.country, filters.brand, filters.subcategory]);

  const { data } = state;

  // Chart rows — one label per (style · colour); left chart top 12 by revenue,
  // right chart top 12 by online SOH (backend returns the union of both sets).
  const chart = useMemo(() => {
    const src = view === "size" ? (data?.sizes || []) : (data?.colors || []);
    const rows = src.map((r) => ({
      ...r,
      name: view === "size"
        ? `${tidyColour(r.color)} · ${r.size}`
        : `${tidyColour(r.color)} · ${r.style_name}`,
      revenueK: Math.round((r.revenue || 0) / 1000),
    }));
    const cap = view === "size" ? 20 : 12;
    return {
      byRev: [...rows].sort((a, b) => b.revenueK - a.revenueK).slice(0, cap),
      bySoh: [...rows].sort((a, b) => (b.soh || 0) - (a.soh || 0)).slice(0, cap),
    };
  }, [data, view]);

  const cwTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div className="bg-white border border-border rounded-lg shadow-md px-3 py-2 text-[11px]">
        <div className="font-bold mb-0.5">{tidyColour(d.color)} · {d.style_name}{d.size ? ` · ${d.size}` : ""}</div>
        <div>Revenue: KES {fmtNum(d.revenueK)}K</div>
        <div>Units sold: {fmtNum(d.units_sold)}</div>
        <div>Online SOH: {fmtNum(d.soh)}</div>
      </div>
    );
  };

  return (
    <div className="card-white p-5" data-testid="op-colourway-perf">
      <SectionTitle
        title={`Colourway Performance (Online · ${periodLabel || "selected period"})`}
        subtitle="Revenue, online stock on hand, and online sell-through by colourway · colourways with no online stock and no period sales are hidden"
        action={(
          <div className="inline-flex rounded-md border border-border/70 p-0.5 bg-muted/20 shrink-0" role="tablist" aria-label="Colourway breakdown">
            {[
              { value: "colour", label: "By Colour" },
              { value: "size", label: "By Size" },
            ].map(({ value, label }) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={view === value}
                onClick={() => setView(value)}
                className={`px-2.5 py-1 text-[10px] font-semibold rounded ${
                  view === value
                    ? "bg-white text-[#1a5c38] shadow-sm"
                    : "text-foreground/55 hover:text-foreground/80"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      />
      {state.loading ? <Loading /> : state.error ? <ErrorBox message={state.error} /> : !data ? null : (
        <>
          {/* ── Signal cards — same rules as the deep dive, online figures ── */}
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
            <CwRecGroup
              variant="restock"
              icon={ArrowCounterClockwise}
              title="Restock"
              rule="4-wk online sell-through > 40% · online WOC < 4 · ASP > 90% of full price · sold online in last 2 days"
              group={data.signals?.restock}
              renderFigures={(c) => (<>
                <span>ST 4wk <b>{c.sor_4wk == null ? "—" : c.sor_4wk + "%"}</b></span>
                <span>WOC <b>{c.woc == null ? "—" : Number(c.woc).toFixed(1)}</b></span>
                <span>ASP <b>{c.asp_pct_full == null ? "—" : c.asp_pct_full + "%"}</b> of full</span>
                <span>sold <b>{cwDaysAgo(c.last_sale_days)}</b></span>
              </>)}
            />
            <CwRecGroup
              variant="marketing"
              icon={Megaphone}
              title="Marketing push"
              rule="Production order < 3 months ago · online WOC > 8 · 8-wk online sell-through < 70%"
              group={data.signals?.marketing}
              renderFigures={(c) => (<>
                <span>ST 8wk <b>{c.sor_8wk == null ? "—" : c.sor_8wk + "%"}</b></span>
                <span>WOC <b>{c.woc == null ? "—" : Number(c.woc).toFixed(1)}</b></span>
                <span>SOH <b>{fmtNum(c.soh)}</b></span>
                <span>ordered <b>{cwDaysAgo(c.last_order_days)}</b></span>
              </>)}
            />
            <CwRecGroup
              variant="retire"
              icon={XCircle}
              title="Retire candidates"
              rule="New styles only (Tier 4 / launched < 12 mo, on sale ≥ 12 wks) · 12-wk online sell-through < 70%"
              group={data.signals?.retire}
              renderFigures={(c) => (<>
                <span>ST 12wk <b>{c.sor_12wk == null ? "—" : c.sor_12wk + "%"}</b></span>
                <span>WOC <b>{c.woc == null ? "—" : Number(c.woc).toFixed(1)}</b></span>
                <span>SOH <b>{fmtNum(c.soh)}</b></span>
                <span>last sale <b>{c.last_sale_days == null ? "none in 12 wks" : cwDaysAgo(c.last_sale_days)}</b></span>
              </>)}
            />
          </div>
          <div className="mt-1.5 text-[9.5px] text-foreground/45">
            Advisory only · online figures · fixed trailing windows (4/8/12-wk sell-through, 6-mo WOC) — independent
            of the date filter, country/brand filters apply · each colourway appears in at most one group (Restock › Marketing › Retire)
          </div>

          {/* ── Two side-by-side charts ── */}
          {chart.byRev.length === 0 ? (
            <Empty label="No colourways with online stock or online sales in the selected period." />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-4 gap-y-5 mt-2">
              <div>
                <div className="text-[11.5px] font-semibold text-foreground/70 mb-1">
                  Revenue (KES Thousands){view === "size" ? " — by size within colourway" : ""}
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chart.byRev} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 8 }} interval={0} angle={-45} textAnchor="end" height={64} />
                    <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => v + "K"} />
                    <Tooltip content={cwTooltip} />
                    <Bar dataKey="revenueK" fill="#1a5c38" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div>
                <div className="text-[11.5px] font-semibold text-foreground/70 mb-1">
                  Online Stock on Hand (units){view === "size" ? " — by size within colourway" : ""}
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chart.bySoh} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 8 }} interval={0} angle={-45} textAnchor="end" height={64} />
                    <YAxis tick={{ fontSize: 9 }} />
                    <Tooltip content={cwTooltip} />
                    <Bar dataKey="soh" fill="#4b7bec" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          {(data.total_colourways || 0) > (data.colors || []).length && view === "colour" && (
            <div className="mt-1 text-[9.5px] text-foreground/45">
              Top colourways shown ({fmtNum(data.total_colourways)} colourways have online stock or sales in the period — signal cards scan all of them).
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function OnlinePerformance() {
  const filters = useMerchFilters();
  const periodLabel = useMerchPeriodLabel();
  const [mode, setMode] = useState("compare"); // "compare" | "online"
  const compare = mode === "compare";

  const { loading, error, onlinePerformance: d } = useMerchData(["online-performance"]);

  // Subcategory drill-down
  const cats = filters.filterOptions?.categories || [];
  const catList = useMemo(() => {
    const fromData = (d?.categories || []).map((c) => c.category).filter(Boolean);
    return fromData.length ? fromData : cats;
  }, [d, cats]);
  const [drillCat, setDrillCat] = useState(null);
  useEffect(() => {
    if (!drillCat && catList.length) {
      setDrillCat(catList.find((c) => /top/i.test(c)) || catList[0]);
    }
  }, [catList, drillCat]);

  const [sub, setSub] = useState({ loading: false, rows: [], error: null });
  useEffect(() => {
    if (!drillCat || !d) return;
    let cancelled = false;
    setSub((s) => ({ ...s, loading: true, error: null }));
    api.get("/merch/online-subcats", {
      params: {
        category: drillCat,
        from_date: filters.from_date,
        to_date: filters.to_date,
        country: filters.country || undefined,
        brand: filters.brand || undefined,
        subcategory: filters.subcategory || undefined,
      },
    })
      .then((r) => { if (!cancelled) setSub({ loading: false, rows: r.data.rows || [], error: null }); })
      .catch((e) => { if (!cancelled) setSub({ loading: false, rows: [], error: e?.message || "Failed" }); });
    return () => { cancelled = true; };
  }, [drillCat, d, filters.from_date, filters.to_date, filters.country, filters.brand, filters.subcategory]);

  const insights = useMemo(() => buildInsights(d, compare), [d, compare]);

  if (loading) return <Loading label="Loading Online Performance…" />;
  if (error) return <ErrorBox message={error} />;
  if (!d) return <Empty label="No data" />;

  const k = d.kpis || {};
  const trend = d.trend || [];
  // promo bands: buckets where online promo share > 30%
  const promoBands = trend
    .map((t, i) => ({ ...t, i }))
    .filter((t) => (t.promo_share_online ?? 0) > 30);
  const mixRows = ["online", "retail"]
    .filter((ch) => compare || ch === "online")
    .map((ch) => ({
      channel: ch === "online" ? "Online" : "Retail",
      "Full price %": d.mix?.[ch]?.fp_pct,
      "Discounted %": d.mix?.[ch]?.disc_pct,
    }));
  const sizeCallouts = (d.sizes || []).filter((s) => s.gap_pp !== null && Math.abs(s.gap_pp) > 10);

  return (
    <div className="space-y-4" data-testid="online-performance-page">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-bold text-foreground">Online Performance</h2>
          <p className="text-[12px] text-muted mt-0.5">Channel split: online vs retail · {periodLabel}</p>
        </div>
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-[11.5px] font-semibold">
          {[["compare", "Compare online vs retail"], ["online", "Online only"]].map(([v, l]) => (
            <button
              key={v}
              type="button"
              onClick={() => setMode(v)}
              className={`px-3 py-1.5 rounded-md transition-colors ${mode === v ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-700"}`}
              data-testid={`op-mode-${v}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* ── KPI cards ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <MerchKPICard
          label={`Online Revenue (${periodLabel})`}
          value={fmtKESM(k.online_rev)}
          sub={k.online_rev_yoy_pct === null ? "No sales same period last year" : `${k.online_rev_yoy_pct > 0 ? "+" : ""}${k.online_rev_yoy_pct}% vs same period LY`}
          testId="op-kpi-rev"
          onDownload={() => downloadCsv([{ metric: "online_revenue_net", value: k.online_rev, same_period_last_year: k.online_rev_ly, yoy_pct: k.online_rev_yoy_pct }], "online_revenue.csv")}
        />
        <MerchKPICard
          label="Online Share of Total Revenue"
          value={k.online_share_pct === null ? "—" : `${k.online_share_pct}%`}
          sub="of company net revenue"
          testId="op-kpi-share"
        />
        <MerchKPICard
          label="Full-Price SOR % — Online / Retail"
          value={twoVal(k.fp_sor_online, k.fp_sor_retail)}
          sub="full-price units ÷ (full-price units + SOH)"
          testId="op-kpi-fpsor"
        />
        <MerchKPICard
          label="Online SOH"
          value={fmtNum(k.online_soh)}
          sub={k.online_woc === null ? "No online sales velocity" : `${k.online_woc} avg weeks of cover`}
          testId="op-kpi-soh"
          onDownload={() => downloadCsv(d.soh_by_category || [], "online_soh_by_category.csv")}
          downloadCount={(d.soh_by_category || []).length}
        />
        <MerchKPICard
          label="Online SOR %"
          value={k.online_sor === null ? "—" : `${k.online_sor}%`}
          sub="units sold ÷ (units sold + SOH)"
          testId="op-kpi-sor"
        />
        <MerchKPICard
          label="Avg Discount Depth — Online / Retail"
          value={twoVal(k.discount_depth_online, k.discount_depth_retail)}
          sub="discounts ÷ gross sales"
          testId="op-kpi-depth"
        />
        <MerchKPICard
          label="% Revenue on Promotion — Online / Retail"
          value={twoVal(k.promo_share_online, k.promo_share_retail)}
          sub="revenue from discounted lines"
          testId="op-kpi-promo"
        />
        <MerchKPICard
          label="Online Return Rate"
          value={k.return_rate_online === null ? "—" : `${k.return_rate_online}%`}
          sub="returns value ÷ gross online sales"
          testId="op-kpi-returns"
        />
      </div>

      {/* ── a) Revenue trend ─────────────────────────────────────────────── */}
      <DlChartCard
        title={`Revenue Trend — ${compare ? "Online vs Retail" : "Online"} (${d.granularity === "week" ? "weekly" : "monthly"})`}
        rows={trend}
        filename="online_revenue_trend.csv"
        testId="op-trend"
      >
        {trend.length === 0 ? <Empty label="No sales in the selected period" /> : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={trend} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
              <YAxis tickFormatter={fmtAxisM} tick={{ fontSize: 10 }} />
              <Tooltip content={<KesTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {promoBands.map((b) => (
                <ReferenceArea key={b.bucket} x1={b.bucket} x2={b.bucket} fill={C.amber} fillOpacity={0.12} />
              ))}
              <Line type="monotone" dataKey="online" name="Online" stroke={ONLINE_C} strokeWidth={2} dot={false} />
              {compare && <Line type="monotone" dataKey="retail" name="Retail" stroke={RETAIL_C} strokeWidth={2} dot={false} />}
            </LineChart>
          </ResponsiveContainer>
        )}
        <div className="text-[10.5px] text-slate-400 mt-1">Shaded bands = high promo activity ({d.granularity}s where &gt;30% of online revenue was on discount)</div>
      </DlChartCard>

      {/* ── b) Performance by category ────────────────────────────────────── */}
      <DlChartCard
        title={`Performance by Category — ${compare ? "Online vs Retail" : "Online"}`}
        rows={d.categories}
        filename="online_by_category.csv"
        testId="op-categories"
      >
        {(d.categories || []).length === 0 ? <Empty label="No category data" /> : (
          <>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={d.categories} margin={{ top: 6, right: 12, left: 0, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="category" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" interval={0} />
                <YAxis tick={{ fontSize: 10 }} unit="%" />
                <Tooltip content={<PctTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="online_rev_share" name="Online rev share %" fill={ONLINE_C} radius={[3, 3, 0, 0]} />
                {compare && <Bar dataKey="retail_rev_share" name="Retail rev share %" fill={RETAIL_C} radius={[3, 3, 0, 0]} />}
                <Bar dataKey="online_fp_sor" name="Online FP SOR %" fill={C.purple} radius={[3, 3, 0, 0]} />
                {compare && <Bar dataKey="retail_fp_sor" name="Retail FP SOR %" fill={C.muted} radius={[3, 3, 0, 0]} />}
              </BarChart>
            </ResponsiveContainer>
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-[11.5px]">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-slate-100">
                    <th className="py-1.5 pr-2 font-semibold">Category</th>
                    <th className="py-1.5 pr-2 font-semibold text-right">Online Rev</th>
                    <th className="py-1.5 pr-2 font-semibold text-right">Online SOR%</th>
                    <th className="py-1.5 pr-2 font-semibold text-right">Online FP SOR%</th>
                    {compare && <>
                      <th className="py-1.5 pr-2 font-semibold text-right">Retail Rev</th>
                      <th className="py-1.5 pr-2 font-semibold text-right">Retail SOR%</th>
                      <th className="py-1.5 pr-2 font-semibold text-right">Retail FP SOR%</th>
                      <th className="py-1.5 font-semibold text-right">Gap (pp)</th>
                    </>}
                  </tr>
                </thead>
                <tbody>
                  {d.categories.map((c) => (
                    <tr key={c.category} className="border-b border-slate-50">
                      <td className="py-1.5 pr-2 font-medium text-slate-700">{c.category}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{fmtKESM(c.online_rev)}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{c.online_sor ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{c.online_fp_sor ?? "—"}</td>
                      {compare && <>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{fmtKESM(c.retail_rev)}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{c.retail_sor ?? "—"}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{c.retail_fp_sor ?? "—"}</td>
                        <td className={`py-1.5 text-right tabular-nums font-semibold ${c.gap_pp > 0 ? "text-emerald-600" : c.gap_pp < 0 ? "text-rose-600" : "text-slate-400"}`}>
                          {c.gap_pp === null ? "—" : `${c.gap_pp > 0 ? "+" : ""}${c.gap_pp}`}
                        </td>
                      </>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DlChartCard>

      {/* ── c) Subcategory drill-down ─────────────────────────────────────── */}
      <DlChartCard
        title={`Subcategory Drill-Down — ${drillCat || ""}`}
        rows={sub.rows}
        filename={`online_subcats_${(drillCat || "").toLowerCase().replace(/\W+/g, "_")}.csv`}
        testId="op-subcats"
      >
        <div className="mb-3">
          <select
            value={drillCat || ""}
            onChange={(e) => setDrillCat(e.target.value)}
            className="text-[12px] border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-700"
            data-testid="op-subcat-select"
          >
            {catList.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {sub.loading ? <Loading label="Loading subcategories…" /> :
         sub.error ? <ErrorBox message={sub.error} /> :
         sub.rows.length === 0 ? <Empty label="No subcategory data for this category" /> : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={sub.rows} margin={{ top: 6, right: 12, left: 0, bottom: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="subcategory" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" interval={0} />
              <YAxis tick={{ fontSize: 10 }} unit="%" />
              <Tooltip content={<PctTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="online_sor" name="Online SOR %" fill={ONLINE_C} radius={[3, 3, 0, 0]} />
              {compare && <Bar dataKey="retail_sor" name="Retail SOR %" fill={RETAIL_C} radius={[3, 3, 0, 0]} />}
            </BarChart>
          </ResponsiveContainer>
        )}
      </DlChartCard>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* ── d) Sell-through by colour (online) ──────────────────────────── */}
        <DlChartCard title="Sell-Through by Colour — Online" rows={d.colours} filename="online_sor_by_colour.csv" testId="op-colours">
          {(d.colours || []).length === 0 ? <Empty label="No online colour data" /> : (
            <ResponsiveContainer width="100%" height={Math.max(220, d.colours.length * 26)}>
              <BarChart data={d.colours} layout="vertical" margin={{ top: 4, right: 40, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} unit="%" domain={[0, 100]} />
                <YAxis type="category" dataKey="colour" width={110} tick={{ fontSize: 10 }} />
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const r = payload[0].payload;
                  return (
                    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
                      <div className="font-semibold text-slate-700">{r.colour}</div>
                      <div>SOR: <b>{r.sor ?? "—"}%</b> · Units: <b>{fmtNum(r.units)}</b> · SOH: <b>{fmtNum(r.soh)}</b></div>
                    </div>
                  );
                }} />
                <Bar dataKey="sor" name="SOR %" fill={ONLINE_C} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </DlChartCard>

        {/* ── e) Sell-through by size ─────────────────────────────────────── */}
        <DlChartCard title={`Sell-Through by Size — ${compare ? "Online vs Retail" : "Online"}`} rows={d.sizes} filename="online_sor_by_size.csv" testId="op-sizes">
          {(d.sizes || []).length === 0 ? <Empty label="No size data" /> : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={d.sizes} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="size" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} unit="%" />
                  <Tooltip content={<PctTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="online_sor" name="Online SOR %" radius={[3, 3, 0, 0]}>
                    {d.sizes.map((s) => (
                      <Cell key={s.size} fill={s.gap_pp !== null && Math.abs(s.gap_pp) > 10 ? C.amber : ONLINE_C} />
                    ))}
                  </Bar>
                  {compare && <Bar dataKey="retail_sor" name="Retail SOR %" fill={RETAIL_C} radius={[3, 3, 0, 0]} />}
                </BarChart>
              </ResponsiveContainer>
              {compare && sizeCallouts.length > 0 && (
                <div className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[11.5px] text-amber-800">
                  {sizeCallouts.map((s) => (
                    <div key={s.size}>
                      <b>{s.size}</b>: online and retail SOR differ by {Math.abs(s.gap_pp).toFixed(0)}pp ({s.online_sor}% online vs {s.retail_sor}% retail)
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </DlChartCard>

        {/* ── f) Full-price vs discounted mix ─────────────────────────────── */}
        <DlChartCard title={`Full-Price vs Discounted Mix — ${compare ? "Online vs Retail" : "Online"}`} rows={mixRows} filename="online_fp_mix.csv" testId="op-mix">
          {mixRows.every((r) => r["Full price %"] === null) ? <Empty label="No sales in the selected period" /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={mixRows} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="channel" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} unit="%" domain={[0, 100]} />
                <Tooltip content={<PctTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Full price %" stackId="mix" fill={C.green} radius={[0, 0, 0, 0]} />
                <Bar dataKey="Discounted %" stackId="mix" fill={C.red} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </DlChartCard>

        {/* ── g) Discount depth trend ─────────────────────────────────────── */}
        <DlChartCard title={`Discount Depth Trend — ${compare ? "Online vs Retail" : "Online"}`} rows={trend.map(({ bucket, depth_online, depth_retail }) => ({ bucket, depth_online, depth_retail }))} filename="discount_depth_trend.csv" testId="op-depth-trend">
          {trend.length === 0 ? <Empty label="No sales in the selected period" /> : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trend} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} unit="%" />
                <Tooltip content={<PctTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {promoBands.map((b) => (
                  <ReferenceArea key={b.bucket} x1={b.bucket} x2={b.bucket} fill={C.amber} fillOpacity={0.12} />
                ))}
                <Line type="monotone" dataKey="depth_online" name="Online depth %" stroke={ONLINE_C} strokeWidth={2} dot={false} />
                {compare && <Line type="monotone" dataKey="depth_retail" name="Retail depth %" stroke={RETAIL_C} strokeWidth={2} dot={false} />}
              </LineChart>
            </ResponsiveContainer>
          )}
        </DlChartCard>
      </div>

      {/* ── SIZE ANALYSIS (online-scoped) ───────────────────────────────────── */}
      <OnlineSizeAnalysis rows={d.sizes} periodLabel={periodLabel} />

      {/* ── COLOURWAY PERFORMANCE (online-scoped) ───────────────────────────── */}
      <OnlineColourwayPerformance filters={filters} periodLabel={periodLabel} />

      {/* ── h) SOH by category with WOC risk ────────────────────────────────── */}
      <DlChartCard title="Online SOH by Category (colour = weeks-of-cover risk)" rows={d.soh_by_category} filename="online_soh_by_category.csv" testId="op-soh-cat">
        {(d.soh_by_category || []).length === 0 ? <Empty label="No online stock" /> : (
          <>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={d.soh_by_category} margin={{ top: 6, right: 12, left: 0, bottom: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="category" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" interval={0} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const r = payload[0].payload;
                  return (
                    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-[11px] border border-slate-100">
                      <div className="font-semibold text-slate-700">{r.category}</div>
                      <div>SOH: <b>{fmtNum(r.soh)}</b> · WOC: <b>{r.woc ?? "—"}</b></div>
                    </div>
                  );
                }} />
                <Bar dataKey="soh" name="Online SOH units" radius={[3, 3, 0, 0]}>
                  {d.soh_by_category.map((r) => (
                    <Cell key={r.category} fill={r.woc === null ? C.muted : wocColor(r.woc)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="text-[10.5px] text-slate-400 mt-1">Green = healthy cover · Amber = building up · Teal = overstock · Grey = no online sales velocity</div>
          </>
        )}
      </DlChartCard>

      {/* ── Patterns & watch items ──────────────────────────────────────────── */}
      <div className="bg-white rounded-xl shadow-sm p-4 sm:p-5" data-testid="op-insights">
        <SectionTitle title="Patterns & Watch Items" subtitle="Auto-generated from the data in view — regenerates when filters change" />
        {insights.length === 0 ? (
          <div className="text-[12px] text-slate-400 mt-2">No notable patterns detected for the current filters.</div>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {insights.map((t, i) => (
              <li key={i} className="flex gap-2 text-[12.5px] text-slate-700">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0" style={{ background: ONLINE_C }} />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
