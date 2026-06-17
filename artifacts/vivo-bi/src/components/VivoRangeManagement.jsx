import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { useFilters } from "@/lib/filters";
import { Loading, ErrorBox } from "@/components/common";
import { Stack, Warning, ArrowDown } from "@phosphor-icons/react";

/**
 * Vivo Range Management — a living recreation of the June 2026
 * "Range & Store Performance" report, rendered at the bottom of Product
 * Analysis. Every data-driven section is computed LIVE from the canonical
 * range classifier (GET /range-mgmt/classify) — the same tiering used by the
 * Range Management page — so the figures stay current and reconcile with the
 * rest of the cockpit. Because the live style universe and methodology differ
 * from the static PDF, the numbers will drift from the original deck (this was
 * an explicit choice). Sections that depend on data NOT held in the warehouse
 * (store sq ft / revenue-per-sq-ft, supply-chain narrative) are reproduced as
 * static text from the report and labelled as such.
 *
 * It is date-independent: the classifier reads each style's lifetime / 24-month
 * history regardless of the page's date filter, so this section does not react
 * to the date range above (it does honour the global Country / Channel filter).
 */

const BRAND_LABEL = { Vivo: "Vivo", Safari: "Safari by Vivo", Zoya: "Zoya" };
const BRAND_ORDER = ["Safari by Vivo", "Vivo", "Zoya"];
const BRAND_DOT = { "Safari by Vivo": "#b45309", Vivo: "#1a5c38", Zoya: "#7c3aed" };
const TIERS = ["Tier 1", "Tier 2", "Tier 3", "Tier 4"];

const TIER_TONE = {
  "Tier 1": { bg: "#fef3c7", text: "#854d0e" },
  "Tier 2": { bg: "#dcfce7", text: "#166534" },
  "Tier 3": { bg: "#dbeafe", text: "#1e40af" },
  "Tier 4": { bg: "#f1f5f9", text: "#334155" },
};
const TIER_TAG = {
  "Tier 1": "NOOS / never out of stock",
  "Tier 2": "Core performers",
  "Tier 3": "Developing / watch",
  "Tier 4": "Trial / new entry",
};
const TIER_DESC = {
  "Tier 1":
    "Never Out Of Stock — always-on core range. Automatic reorder when WOC ≤ 8. Highest accountability, most visibility.",
  "Tier 2":
    "Core performers. Proven demand, regular reorder cadence. Largest tier by revenue. Average SOR on par with Tier 1.",
  "Tier 3":
    "Recent performers. Developing range, watched for graduation to Tier 2 or demotion. Largest tier by style count — rationalisation needed.",
  "Tier 4":
    "Trial styles and new entries. Gate at Week 12 — graduate the winners, exit the rest.",
};

const brandOf = (r) => BRAND_LABEL[r.brand] || r.brand || "Other";
const n0 = (v) => fmtNum(Math.round(v || 0));
const kesBig = (v) => {
  const a = Math.abs(v || 0);
  if (a >= 1e9) return `KES ${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e7) return `KES ${n0(v / 1e6)}M`;
  if (a >= 1e6) return `KES ${(v / 1e6).toFixed(1)}M`;
  return `KES ${n0(v)}`;
};
const pct1 = (v) => (v == null || isNaN(v) ? "—" : `${Number(v).toFixed(1)}%`);
const woc1 = (v) => (v == null ? "—" : `${Number(v).toFixed(1)} wk`);

// ---- Static report data (NOT in the warehouse) -----------------------------

// Kenya store performance — May 2026 snapshot. sq ft / rev-per-sq-ft are not
// held in the BI warehouse, so this table is reproduced verbatim from the deck.
const STORE_ROWS = [
  ["Junction", 1830, 1, 8.93, 4880], ["Sarit", 1096, 1, 8.02, 7318],
  ["Mama Ngina", 1291, 2, 5.73, 4438], ["Village", 780, 2, 4.86, 6232],
  ["Yaya", 797, 2, 4.84, 6076], ["Moi Avenue", 2500, 2, 4.74, 1896],
  ["Garden City", 678, 2, 3.61, 5323], ["Galleria", 667, 2, 3.44, 5157],
  ["Mombasa Citymall", 840, 2, 3.09, 3679], ["Imaara", 1916, 2, 3.06, 1597],
  ["TRM", 1549, 2, 3.04, 1963], ["Runda Mall", 1042, 2, 3.02, 2898],
  ["Two Rivers", 775, 2, 3.01, 3884], ["Capital", 650, 2, 2.93, 4508],
  ["Hub", 397, 2, 2.74, 6898], ["Kisumu", 568, 3, 2.68, 4718],
  ["Eldoret", 517, 3, 2.56, 4952], ["Nakuru", 517, 3, 2.53, 4894],
  ["TMall", 486, 3, 2.24, 4609], ["Sarit Safari/Zoya", 1229, 3, 2.13, 1734],
  ["Greenspan", 506, 4, 1.71, 3379], ["Mombasa CBD", 1497, 3, 1.57, 1049],
  ["Signature Mall", 1100, 4, 1.44, 1309], ["Kileleshwa", 800, 4, 1.36, 1700],
  ["Greenwood", 704, 4, 1.06, 1506],
];

const PRIORITY_ACTIONS = [
  { n: "01", when: "Immediate", title: "Exit Men's category & Short/Mini Skirts",
    body: "Men's Tops (114 WOC), Men's Bottoms (95 WOC), Short & Mini Skirts (480 WOC). Mark down to clear, do not reorder. Retire remaining active styles." },
  { n: "02", when: "This month", title: "Markdown plan for 6 overstocked categories",
    body: "Shorts & Skorts (61 WOC), Hoodies (59 WOC), Skirts & Top Set (38 WOC), Maxi Skirts (31 WOC), Midi & Capri Dresses (28 WOC), Fitted Tops (21 WOC). Markdown or bundle." },
  { n: "03", when: "Next buying cycle", title: "Rationalise Loose Tops and Fitted Tops",
    body: "Loose Tops: 11% of range, 5.7% of revenue — overrepresented. Fitted Tops: 7.9% of range, 21 WOC, underperforming. Reduce style count in both at next range review." },
  { n: "04", when: "Next buying cycle", title: "Increase depth in Sweaters & Ponchos",
    body: "4% of styles driving 8.4% of revenue — one of the best revenue-to-range-width ratios in the portfolio. Invest in more depth and colourway breadth at next OTB allocation." },
  { n: "05", when: "Lease review", title: "Review large-footprint stores against RPSF",
    body: "Mombasa CBD (1,497 sq ft, KES 1,049/sq ft), Moi Avenue (2,500 sq ft, KES 1,896/sq ft), Imaara (1,916 sq ft, KES 1,597/sq ft) all significantly below the KES 3,410 network average." },
  { n: "06", when: "Ongoing", title: "Track 'never reordered' as a product-team KPI",
    body: "~19 retired styles reached only 1 purchase order and were never reordered. This is the clearest signal of initial buying errors. Tracking this rate holds the buying team accountable to launch quality." },
];

const SectionCard = ({ title, subtitle, right, children, testId }) => (
  <div className="card-white p-4 space-y-3" data-testid={testId}>
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div>
        <div className="font-bold text-[15px] text-foreground">{title}</div>
        {subtitle && <div className="text-muted text-[12px] mt-0.5">{subtitle}</div>}
      </div>
      {right}
    </div>
    {children}
  </div>
);

const TierBadge = ({ tier }) => {
  const t = TIER_TONE[tier] || TIER_TONE["Tier 4"];
  return (
    <span className="inline-block px-2 py-0.5 rounded-full text-[10.5px] font-bold whitespace-nowrap"
      style={{ background: t.bg, color: t.text }}>{tier}</span>
  );
};

const VivoRangeManagement = ({ channelsOverride } = {}) => {
  const { applied } = useFilters();
  const { countries, channels: globalChannels, dataVersion } = applied || {};
  // An on-page POS Location filter (RangeManagement) takes precedence over the
  // global filter bar's POS selector when set, so the whole page scopes to the
  // chosen store(s).
  const channels = (channelsOverride && channelsOverride.length) ? channelsOverride : globalChannels;

  const wrapRef = useRef(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Lazy-load: only fetch the (heavy, ~13s) classifier once this section
  // scrolls into view, so it never blocks the main Product Analysis page.
  useEffect(() => {
    if (shouldLoad) return;
    const el = wrapRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setShouldLoad(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setShouldLoad(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [shouldLoad]);

  useEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const countryCsv = countries?.length ? countries.map((c) => c.toLowerCase()).join(",") : undefined;
    const locationsCsv = channels?.length ? channels.join(",") : undefined;
    api
      .get("/range-mgmt/classify", { params: { country: countryCsv, channel: locationsCsv } })
      .then((r) => { if (!cancelled) setData(r.data || null); })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldLoad, JSON.stringify(countries), JSON.stringify(channels), dataVersion]);

  const model = useMemo(() => {
    if (!data) return null;
    const ts = data.summary?.tier_summary || {};
    const active = (data.rows || []).filter((r) => TIERS.includes(r.tier));
    const flaggedRetire = (data.rows || []).filter((r) => r.tier === "Retire");
    const retired = [...(data.retired_rows || []), ...flaggedRetire];
    const all = [...active, ...retired];

    // Brand × tier matrix
    const zero = () => ({ "Tier 1": 0, "Tier 2": 0, "Tier 3": 0, "Tier 4": 0, Retired: 0 });
    const matrix = {};
    for (const r of active) { const b = brandOf(r); (matrix[b] = matrix[b] || zero())[r.tier]++; }
    for (const r of retired) { const b = brandOf(r); (matrix[b] = matrix[b] || zero()).Retired++; }
    const matrixBrands = [...BRAND_ORDER.filter((b) => matrix[b]),
      ...Object.keys(matrix).filter((b) => !BRAND_ORDER.includes(b))];
    const grand = zero();
    for (const b of matrixBrands) for (const k of Object.keys(grand)) grand[k] += matrix[b][k];
    const matrixRows = matrixBrands.map((b) => {
      const m = matrix[b];
      const total = m["Tier 1"] + m["Tier 2"] + m["Tier 3"] + m["Tier 4"] + m.Retired;
      return { brand: b, ...m, total };
    });
    const grandTotal = grand["Tier 1"] + grand["Tier 2"] + grand["Tier 3"] + grand["Tier 4"] + grand.Retired;

    // Portfolio split
    const activeCount = active.length;
    const retiredCount = retired.length;
    const totalCount = activeCount + retiredCount;

    // Brand performance (full universe)
    const perf = {};
    for (const r of all) {
      const b = brandOf(r);
      const p = perf[b] = perf[b] || { styles: 0, stock: 0, units: 0, rev: 0 };
      p.styles++; p.stock += r.current_stock || 0;
      p.units += r.units_since_launch || 0; p.rev += r.sales_since_launch || 0;
    }
    const totalRev = Object.values(perf).reduce((a, p) => a + p.rev, 0);
    const perfRows = [...BRAND_ORDER.filter((b) => perf[b]),
      ...Object.keys(perf).filter((b) => !BRAND_ORDER.includes(b))].map((b) => {
      const p = perf[b];
      return { brand: b, ...p, asp: p.units ? p.rev / p.units : 0,
        pctRev: totalRev ? (p.rev / totalRev) * 100 : 0 };
    });

    // Retired summary (per brand: retired count + % of brand total)
    const retiredSummary = matrixRows
      .filter((m) => m.Retired > 0)
      .map((m) => ({ brand: m.brand, retired: m.Retired,
        pctOfBrand: m.total ? (m.Retired / m.total) * 100 : 0 }))
      .sort((a, b) => b.retired - a.retired);

    // Tier deep dives
    const tierData = TIERS.map((t) => {
      const block = ts[t] || {};
      const rows = active.filter((r) => r.tier === t);
      const stock = rows.reduce((a, r) => a + (r.current_stock || 0), 0);
      const prices = rows.map((r) => r.avg_price_since_launch).filter((v) => v > 0);
      const avgPrice = prices.length ? prices.reduce((a, v) => a + v, 0) / prices.length : 0;
      const top5 = [...rows].sort((a, b) => (b.sales_since_launch || 0) - (a.sales_since_launch || 0)).slice(0, 5);
      const watch = rows
        .filter((r) => (r.current_stock || 0) > 0 && r.sor_since_launch != null)
        .sort((a, b) => a.sor_since_launch - b.sor_since_launch)
        .slice(0, 3);
      return {
        tier: t,
        count: block.count ?? rows.length,
        revenue: block.revenue_lifetime ?? rows.reduce((a, r) => a + (r.sales_since_launch || 0), 0),
        units: block.units_lifetime ?? rows.reduce((a, r) => a + (r.units_since_launch || 0), 0),
        sor: block.sor_lifetime_pct,
        stock, avgPrice, top5, watch,
      };
    });

    // Active range by subcategory (Tier 1–4 only)
    const sub = {};
    for (const r of active) {
      const k = r.subcategory || "(Uncategorised)";
      const s = sub[k] = sub[k] || { sub: k, styles: 0, stock: 0, units: 0, rev: 0, wk: 0 };
      s.styles++; s.stock += r.current_stock || 0; s.units += r.units_since_launch || 0;
      s.rev += r.sales_since_launch || 0; s.wk += r.weekly_avg || 0;
    }
    const subList = Object.values(sub);
    const subTot = subList.reduce((a, s) => ({
      styles: a.styles + s.styles, stock: a.stock + s.stock,
      units: a.units + s.units, rev: a.rev + s.rev,
    }), { styles: 0, stock: 0, units: 0, rev: 0 });
    const subRows = subList.map((s) => ({
      ...s,
      woc: s.wk > 0 ? s.stock / s.wk : null,
      pctRange: subTot.styles ? (s.styles / subTot.styles) * 100 : 0,
      pctStock: subTot.stock ? (s.stock / subTot.stock) * 100 : 0,
      pctUnits: subTot.units ? (s.units / subTot.units) * 100 : 0,
      pctRev: subTot.rev ? (s.rev / subTot.rev) * 100 : 0,
    })).sort((a, b) => b.rev - a.rev);

    // Revenue concentration headline — share held by the top 5 subcats
    const top5RevShare = subRows.slice(0, 5).reduce((a, s) => a + s.pctRev, 0);

    // Category WOC overview (bars capped at 100 wk for readability)
    const wocRows = subRows
      .filter((s) => s.woc != null)
      .map((s) => ({ sub: s.sub, woc: s.woc }))
      .sort((a, b) => b.woc - a.woc);
    const wocMax = 100;

    return {
      matrixRows, grand, grandTotal, activeCount, retiredCount, totalCount,
      perfRows, totalRev, retiredSummary, tierData, subRows, subTot,
      top5RevShare, wocRows, wocMax,
      tierTotalActive: tierData.reduce((a, t) => a + t.count, 0),
    };
  }, [data]);

  return (
    <div ref={wrapRef} className="space-y-4" data-testid="vivo-range-management">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Stack size={20} weight="duotone" style={{ color: "#1a5c38" }} />
          <div>
            <div className="font-extrabold text-[18px] text-foreground leading-tight">Vivo Range Management</div>
            <div className="text-muted text-[12px]">
              Range &amp; store performance — recreated from the June 2026 report with live data
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold"
          style={{ background: "#dcfce7", color: "#166534" }} data-testid="range-live-pill">
          Live data
        </span>
      </div>

      <p className="text-[11.5px] text-muted leading-snug card-white p-3" data-testid="range-method-note">
        <strong>How to read this:</strong> the data sections below recompute live from the canonical range
        classifier (the same tiering used on the Range Management page), so figures stay current and reconcile
        with the rest of the cockpit. They are a <strong>lifetime / 24-month</strong> analysis and so are
        <strong> independent of the date filter</strong> above (they do honour the Country / Channel filter).
        Because the live style universe and tiering methodology differ from the original deck, the numbers will
        not match the static June 2026 PDF exactly. Store sq ft, revenue-per-sq-ft and the supply-chain
        narrative are not held in the warehouse and are reproduced as a static snapshot, clearly labelled.
      </p>

      {!shouldLoad && (
        <div className="card-white p-6 text-center text-muted text-[13px]">Scroll to load the range analysis…</div>
      )}
      {shouldLoad && loading && <Loading label="Classifying every style for the range report…" />}
      {shouldLoad && error && <ErrorBox message={error} />}

      {model && (
        <>
          {/* 1 — Range composition */}
          <SectionCard
            title="Range composition"
            subtitle={`${n0(model.totalCount)} styles across ${model.matrixRows.length} brands · ${n0(model.activeCount)} active (Tier 1–4) · ${n0(model.retiredCount)} retired`}
            testId="range-composition"
          >
            <div className="grid lg:grid-cols-2 gap-4">
              <div>
                <div className="eyebrow text-[10.5px] mb-1">Styles by brand &amp; tier</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px] num">
                    <thead>
                      <tr className="text-muted text-left border-b border-default">
                        <th className="py-1.5 pr-2 font-semibold text-left">Brand</th>
                        {["Tier 1", "Tier 2", "Tier 3", "Tier 4", "Retired", "Total"].map((h) => (
                          <th key={h} className="py-1.5 px-2 font-semibold text-right">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {model.matrixRows.map((m) => (
                        <tr key={m.brand} className="border-b border-default/60">
                          <td className="py-1.5 pr-2 text-left whitespace-nowrap">
                            <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                              style={{ background: BRAND_DOT[m.brand] || "#94a3b8" }} />
                            {m.brand}
                          </td>
                          <td className="py-1.5 px-2 text-right">{n0(m["Tier 1"])}</td>
                          <td className="py-1.5 px-2 text-right">{n0(m["Tier 2"])}</td>
                          <td className="py-1.5 px-2 text-right">{n0(m["Tier 3"])}</td>
                          <td className="py-1.5 px-2 text-right">{n0(m["Tier 4"])}</td>
                          <td className="py-1.5 px-2 text-right text-muted">{n0(m.Retired)}</td>
                          <td className="py-1.5 px-2 text-right font-semibold">{n0(m.total)}</td>
                        </tr>
                      ))}
                      <tr className="font-bold">
                        <td className="py-1.5 pr-2 text-left">Grand Total</td>
                        <td className="py-1.5 px-2 text-right">{n0(model.grand["Tier 1"])}</td>
                        <td className="py-1.5 px-2 text-right">{n0(model.grand["Tier 2"])}</td>
                        <td className="py-1.5 px-2 text-right">{n0(model.grand["Tier 3"])}</td>
                        <td className="py-1.5 px-2 text-right">{n0(model.grand["Tier 4"])}</td>
                        <td className="py-1.5 px-2 text-right">{n0(model.grand.Retired)}</td>
                        <td className="py-1.5 px-2 text-right">{n0(model.grandTotal)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {/* Portfolio split bar */}
                <div className="mt-3">
                  <div className="eyebrow text-[10.5px] mb-1">Portfolio split</div>
                  <div className="flex h-5 rounded-md overflow-hidden text-[10px] font-bold text-white">
                    <div className="flex items-center justify-center" style={{
                      width: `${model.totalCount ? (model.activeCount / model.totalCount) * 100 : 0}%`,
                      background: "#1a5c38" }}>
                      {model.totalCount ? Math.round((model.activeCount / model.totalCount) * 100) : 0}% active
                    </div>
                    <div className="flex items-center justify-center" style={{
                      width: `${model.totalCount ? (model.retiredCount / model.totalCount) * 100 : 0}%`,
                      background: "#94a3b8" }}>
                      {model.totalCount ? Math.round((model.retiredCount / model.totalCount) * 100) : 0}% retired
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <div className="eyebrow text-[10.5px] mb-1">Active range (Tier 1–4)</div>
                <div className="grid grid-cols-2 gap-2">
                  {model.tierData.map((t) => {
                    const tone = TIER_TONE[t.tier];
                    return (
                      <div key={t.tier} className="rounded-lg p-2.5 border"
                        style={{ background: tone.bg, borderColor: tone.text + "22" }}>
                        <div className="text-[10px] uppercase tracking-wide font-bold" style={{ color: tone.text, opacity: 0.75 }}>{t.tier}</div>
                        <div className="font-extrabold num leading-none mt-0.5" style={{ color: tone.text, fontSize: "22px" }}>{n0(t.count)}</div>
                        <div className="text-[10.5px] mt-0.5" style={{ color: tone.text }}>{TIER_TAG[t.tier]}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="eyebrow text-[10.5px] mt-3 mb-1">Retired styles summary</div>
                <div className="space-y-1">
                  <div className="flex justify-between text-[12px]">
                    <span className="text-muted">Total retired across all brands</span>
                    <span className="font-bold num">{n0(model.retiredCount)}</span>
                  </div>
                  {model.retiredSummary.map((r) => (
                    <div key={r.brand} className="flex justify-between text-[12px]">
                      <span>
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                          style={{ background: BRAND_DOT[r.brand] || "#94a3b8" }} />
                        {r.brand}<span className="text-muted"> · {Math.round(r.pctOfBrand)}% of brand range</span>
                      </span>
                      <span className="font-semibold num">{n0(r.retired)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </SectionCard>

          {/* 2 — Brand performance */}
          <SectionCard title="Brand performance"
            subtitle={`Stock, units sold, revenue & ASP by brand · ${kesBig(model.totalRev)} total (lifetime)`}
            testId="range-brand-performance">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] num">
                <thead>
                  <tr className="text-muted text-left border-b border-default">
                    <th className="py-1.5 pr-2 font-semibold text-left">Brand</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Styles</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Current stock</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Units sold</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Revenue</th>
                    <th className="py-1.5 px-2 font-semibold text-right">% of total</th>
                    <th className="py-1.5 px-2 font-semibold text-right">ASP (KES)</th>
                  </tr>
                </thead>
                <tbody>
                  {model.perfRows.map((p) => (
                    <tr key={p.brand} className="border-b border-default/60">
                      <td className="py-1.5 pr-2 text-left whitespace-nowrap">
                        <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                          style={{ background: BRAND_DOT[p.brand] || "#94a3b8" }} />
                        {p.brand}
                      </td>
                      <td className="py-1.5 px-2 text-right">{n0(p.styles)}</td>
                      <td className="py-1.5 px-2 text-right">{n0(p.stock)}</td>
                      <td className="py-1.5 px-2 text-right">{n0(p.units)}</td>
                      <td className="py-1.5 px-2 text-right">{kesBig(p.rev)}</td>
                      <td className="py-1.5 px-2 text-right">{pct1(p.pctRev)}</td>
                      <td className="py-1.5 px-2 text-right">{n0(p.asp)}</td>
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="py-1.5 pr-2 text-left">Grand Total</td>
                    <td className="py-1.5 px-2 text-right">{n0(model.subTot ? model.perfRows.reduce((a, p) => a + p.styles, 0) : 0)}</td>
                    <td className="py-1.5 px-2 text-right">{n0(model.perfRows.reduce((a, p) => a + p.stock, 0))}</td>
                    <td className="py-1.5 px-2 text-right">{n0(model.perfRows.reduce((a, p) => a + p.units, 0))}</td>
                    <td className="py-1.5 px-2 text-right">{kesBig(model.totalRev)}</td>
                    <td className="py-1.5 px-2 text-right">100%</td>
                    <td className="py-1.5 px-2 text-right">
                      {n0(model.perfRows.reduce((a, p) => a + p.units, 0)
                        ? model.totalRev / model.perfRows.reduce((a, p) => a + p.units, 0) : 0)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </SectionCard>

          {/* 3 — Tier deep dives */}
          {model.tierData.map((t) => (
            <SectionCard key={t.tier}
              title={<span className="flex items-center gap-2"><TierBadge tier={t.tier} />{TIER_TAG[t.tier]}</span>}
              subtitle={TIER_DESC[t.tier]} testId={`range-tier-${t.tier.replace(/\s+/g, "-")}`}>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
                {[
                  ["Styles", n0(t.count)],
                  ["Revenue", kesBig(t.revenue)],
                  ["Current stock", n0(t.stock)],
                  ["Units sold", n0(t.units)],
                  ["Avg SOR", pct1(t.sor)],
                  ["Avg price", `KES ${n0(t.avgPrice)}`],
                ].map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-panel p-2.5">
                    <div className="text-[10px] uppercase tracking-wide text-muted font-bold">{k}</div>
                    <div className="font-bold num text-[15px] mt-0.5 text-foreground">{v}</div>
                  </div>
                ))}
              </div>
              <div className="grid lg:grid-cols-2 gap-4 mt-1">
                <div>
                  <div className="eyebrow text-[10.5px] mb-1">Top 5 styles by revenue</div>
                  <table className="w-full text-[11.5px] num">
                    <thead>
                      <tr className="text-muted text-left border-b border-default">
                        <th className="py-1 pr-2 font-semibold text-left">Style</th>
                        <th className="py-1 px-2 font-semibold text-right">Revenue</th>
                        <th className="py-1 px-2 font-semibold text-right">Units</th>
                        <th className="py-1 px-2 font-semibold text-right">SOR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.top5.map((r) => (
                        <tr key={r.style_name} className="border-b border-default/60">
                          <td className="py-1 pr-2 text-left">
                            <div className="font-medium text-foreground leading-tight">{r.style_name}</div>
                            <div className="text-muted text-[10px]">{r.subcategory}</div>
                          </td>
                          <td className="py-1 px-2 text-right">{kesBig(r.sales_since_launch)}</td>
                          <td className="py-1 px-2 text-right">{n0(r.units_since_launch)}</td>
                          <td className="py-1 px-2 text-right">{pct1(r.sor_since_launch)}</td>
                        </tr>
                      ))}
                      {!t.top5.length && <tr><td colSpan={4} className="py-2 text-muted text-center">No styles in this tier.</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="eyebrow text-[10.5px] mb-1 flex items-center gap-1">
                    <Warning size={12} weight="bold" className="text-amber-600" /> Lowest SOR — watch list
                  </div>
                  <table className="w-full text-[11.5px] num">
                    <thead>
                      <tr className="text-muted text-left border-b border-default">
                        <th className="py-1 pr-2 font-semibold text-left">Style</th>
                        <th className="py-1 px-2 font-semibold text-right">SOR</th>
                        <th className="py-1 px-2 font-semibold text-right">Stock</th>
                        <th className="py-1 px-2 font-semibold text-right">WOC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.watch.map((r) => (
                        <tr key={r.style_name} className="border-b border-default/60">
                          <td className="py-1 pr-2 text-left">
                            <div className="font-medium text-foreground leading-tight">{r.style_name}</div>
                            <div className="text-muted text-[10px]">{r.subcategory}</div>
                          </td>
                          <td className="py-1 px-2 text-right font-semibold text-rose-700">{pct1(r.sor_since_launch)}</td>
                          <td className="py-1 px-2 text-right">{n0(r.current_stock)}</td>
                          <td className="py-1 px-2 text-right">{woc1(r.woc)}</td>
                        </tr>
                      ))}
                      {!t.watch.length && <tr><td colSpan={4} className="py-2 text-muted text-center">No at-risk stock in this tier.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </SectionCard>
          ))}

          {/* 4 — Active range inventory snapshot by subcategory */}
          <SectionCard title="Active range — inventory snapshot"
            subtitle={`By subcategory (Tier 1–4) · top 5 subcategories drive ${pct1(model.top5RevShare)} of active revenue`}
            testId="range-subcat-snapshot">
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px] num">
                <thead>
                  <tr className="text-muted text-left border-b border-default">
                    <th className="py-1.5 pr-2 font-semibold text-left">Subcategory</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Styles</th>
                    <th className="py-1.5 px-2 font-semibold text-right">% range</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Stock</th>
                    <th className="py-1.5 px-2 font-semibold text-right">% stock</th>
                    <th className="py-1.5 px-2 font-semibold text-right">WOC</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Units</th>
                    <th className="py-1.5 px-2 font-semibold text-right">% units</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Revenue</th>
                    <th className="py-1.5 px-2 font-semibold text-right">% rev</th>
                  </tr>
                </thead>
                <tbody>
                  {model.subRows.map((s) => (
                    <tr key={s.sub} className="border-b border-default/60">
                      <td className="py-1.5 pr-2 text-left">{s.sub}</td>
                      <td className="py-1.5 px-2 text-right">{n0(s.styles)}</td>
                      <td className="py-1.5 px-2 text-right text-muted">{pct1(s.pctRange)}</td>
                      <td className="py-1.5 px-2 text-right">{n0(s.stock)}</td>
                      <td className="py-1.5 px-2 text-right text-muted">{pct1(s.pctStock)}</td>
                      <td className="py-1.5 px-2 text-right">{woc1(s.woc)}</td>
                      <td className="py-1.5 px-2 text-right">{n0(s.units)}</td>
                      <td className="py-1.5 px-2 text-right text-muted">{pct1(s.pctUnits)}</td>
                      <td className="py-1.5 px-2 text-right">{kesBig(s.rev)}</td>
                      <td className="py-1.5 px-2 text-right font-semibold">{pct1(s.pctRev)}</td>
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="py-1.5 pr-2 text-left">Total</td>
                    <td className="py-1.5 px-2 text-right">{n0(model.subTot.styles)}</td>
                    <td className="py-1.5 px-2 text-right">100%</td>
                    <td className="py-1.5 px-2 text-right">{n0(model.subTot.stock)}</td>
                    <td className="py-1.5 px-2 text-right">100%</td>
                    <td className="py-1.5 px-2 text-right">—</td>
                    <td className="py-1.5 px-2 text-right">{n0(model.subTot.units)}</td>
                    <td className="py-1.5 px-2 text-right">100%</td>
                    <td className="py-1.5 px-2 text-right">{kesBig(model.subTot.rev)}</td>
                    <td className="py-1.5 px-2 text-right">100%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </SectionCard>

          {/* 5 — Category WOC overview */}
          <SectionCard title="Category weeks-of-cover overview"
            subtitle="Active subcategories ranked by weeks of cover · bars capped at 100 wk for readability"
            testId="range-woc-overview">
            <div className="space-y-1.5">
              {model.wocRows.map((w) => {
                const over = w.woc > model.wocMax;
                const pctW = Math.min(100, (w.woc / model.wocMax) * 100);
                const tone = w.woc >= 26 ? "#dc2626" : w.woc >= 13 ? "#d97706" : "#1a5c38";
                return (
                  <div key={w.sub} className="flex items-center gap-2 text-[11.5px]">
                    <div className="w-44 shrink-0 truncate text-right text-muted">{w.sub}</div>
                    <div className="flex-1 h-3.5 rounded bg-panel overflow-hidden">
                      <div className="h-full rounded" style={{ width: `${pctW}%`, background: tone }} />
                    </div>
                    <div className="w-20 shrink-0 num text-right font-semibold" style={{ color: tone }}>
                      {Math.round(w.woc)} wk{over ? "*" : ""}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-[10.5px] text-muted mt-1">* Bars capped at 100 wk; actual value shown on the right.</p>
          </SectionCard>

          {/* 6 — Priority actions (static) */}
          <SectionCard title="Priority actions — June 2026"
            subtitle="Static — leadership priorities from the original report"
            testId="range-priority-actions">
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
              {PRIORITY_ACTIONS.map((a) => (
                <div key={a.n} className="rounded-lg border border-default p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-extrabold num text-[16px]" style={{ color: "#1a5c38" }}>{a.n}</span>
                    <span className="text-[9.5px] uppercase tracking-wide font-bold text-muted">{a.when}</span>
                  </div>
                  <div className="font-semibold text-[12.5px] text-foreground leading-tight">{a.title}</div>
                  <div className="text-[11px] text-muted mt-1 leading-snug">{a.body}</div>
                </div>
              ))}
            </div>
          </SectionCard>

          {/* 7 — Kenya store performance (static) */}
          <SectionCard title="Kenya store performance — May 2026"
            subtitle="Static — store sq ft / revenue-per-sq-ft are not held in the warehouse · 25 stores · 24,732 sq ft · KES 84.3M gross · KES 3,410 avg rev/sq ft"
            testId="range-store-performance">
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px] num">
                <thead>
                  <tr className="text-muted text-left border-b border-default">
                    <th className="py-1.5 pr-2 font-semibold text-left">Store</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Sq ft</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Tier</th>
                    <th className="py-1.5 px-2 font-semibold text-right">May rev</th>
                    <th className="py-1.5 px-2 font-semibold text-right">Rev/sq ft</th>
                  </tr>
                </thead>
                <tbody>
                  {STORE_ROWS.map(([name, sqft, tier, rev, rpsf]) => (
                    <tr key={name} className="border-b border-default/60">
                      <td className="py-1.5 pr-2 text-left">{name}</td>
                      <td className="py-1.5 px-2 text-right">{n0(sqft)}</td>
                      <td className="py-1.5 px-2 text-right text-muted">{tier}</td>
                      <td className="py-1.5 px-2 text-right">KES {rev.toFixed(2)}M</td>
                      <td className="py-1.5 px-2 text-right font-semibold"
                        style={{ color: rpsf < 2000 ? "#dc2626" : rpsf >= 5000 ? "#1a5c38" : "inherit" }}>
                        {n0(rpsf)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted mt-1 leading-snug">
              <strong>Insight:</strong> floor space is not driving revenue proportionally. Several of the highest
              rev/sq ft stores (Sarit KES 7,318; Hub KES 6,898; Village KES 6,232) are among the smallest, while
              the largest footprints (Moi Avenue, Mombasa CBD, Imaara) sit well below the KES 3,410 network
              average. Footprint size and store tier are not always aligned.
            </p>
          </SectionCard>

          {/* 8 — Narrative (static) */}
          <SectionCard title="Operating context"
            subtitle="Static — supply chain, team & financials from the original report"
            testId="range-narrative">
            <div className="grid md:grid-cols-2 gap-4 text-[12px] leading-relaxed">
              <div className="space-y-2">
                <div>
                  <div className="font-semibold text-foreground">Vertical supply chain &amp; lead times</div>
                  <p className="text-muted">Sourcing: ~3 weeks to organise a container in China (multiple suppliers); ships only after payment, then ~4 weeks to arrive and clear. Styles take ~6 weeks concept-to-sign-off, then ~3 weeks sign-off-to-launch. Nairobi stores can receive stock daily; upcountry stores once or twice a week; out-of-country stores weekly.</p>
                </div>
                <div>
                  <div className="font-semibold text-foreground">Product team structure</div>
                  <p className="text-muted">Managed by Wandia, 25 people: Buying (10, Mary Nyambura), Pattern &amp; Sampling (10, Florence Bwibo), CAD (5, Re Amulyoto). Stephen owns overall budget planning and sign-off.</p>
                </div>
              </div>
              <div className="space-y-2">
                <div>
                  <div className="font-semibold text-foreground">Financials &amp; margin health</div>
                  <p className="text-muted">Current intake margin 32% vs net achieved margin 38%. Annual board-approved budget is broken down into quarters &amp; months, with a monthly Product Plan defining the order book to support the next month's revenue target.</p>
                </div>
                <div>
                  <div className="font-semibold text-foreground">Information not yet available</div>
                  <p className="text-muted">Ecomm 24-month sales depth, best/worst styles by quarter &amp; store, seasonal/cultural peaks, the core/flow vs new-drop mix, entry/mid/exit price architecture, and aged fabric-stock meterage are not yet structured in the data.</p>
                </div>
              </div>
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
};

export default VivoRangeManagement;
