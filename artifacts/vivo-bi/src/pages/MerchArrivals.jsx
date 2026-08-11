import React, { useEffect, useState, useMemo } from "react";
import { apiFetch, fmtKES, fmtNum, fmtPct } from "@/lib/api";
import { KPICard } from "@/components/KPICard";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { useMerchFilters } from "./MerchandisingHub";
import { SubcatFilter } from "./merch/MerchHelpers";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
  LineChart, Line, ReferenceLine, Legend, LabelList, Cell,
  PieChart, Pie,
} from "recharts";
import { Rocket, CalendarBlank, CurrencyCircleDollar, Percent, CheckCircle } from "@phosphor-icons/react";

// ── colours ───────────────────────────────────────────────────────────────────
const STATUS_COLORS  = { "On Track": "#1a5c38", "At Risk": "#d97706", "Overdue": "#ef4444" };
const TIER_LINE_COLORS = { "Tier 1": "#1a5c38", "Tier 2": "#4b7bec", "Tier 3/4": "#d97706" };
const BRAND_COLORS   = ["#1a5c38", "#4b7bec", "#d97706", "#7c3aed"];

// ── custom tip ────────────────────────────────────────────────────────────────
const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-border rounded-lg shadow-lg p-2.5 text-[11.5px] max-w-[200px]">
      <div className="font-semibold mb-1 truncate">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color || p.fill }} />
          <span className="text-muted">{p.name}:</span>
          <span className="font-semibold tabular-nums">{p.value}</span>
        </div>
      ))}
    </div>
  );
};

// ── month label helper ─────────────────────────────────────────────────────────
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthLabel = (iso) => {
  if (!iso) return "";
  const [, m] = iso.split("-");
  return MONTHS[parseInt(m, 10) - 1] || iso;
};

// ── main component ─────────────────────────────────────────────────────────────
const MerchArrivals = () => {
  const filters = useMerchFilters();
  const [localSubcat, setLocalSubcat] = useState(null);
  const effectiveSubcat = localSubcat !== null ? localSubcat : (filters.subcategory || "");
  const params = {
    from_date:    filters.from_date,
    to_date:      filters.to_date,
    country:      filters.country,
    pos_location: filters.pos_location,
    brand:        filters.brand,
    ...(effectiveSubcat ? { subcategory: effectiveSubcat } : {}),
  };

  const [summary, setSummary]  = useState(null);
  const [styles, setStyles]    = useState([]);
  const [ramp, setRamp]        = useState(null);
  const [loading, setLoading]  = useState(true);
  const [error, setError]      = useState(null);

  const currentYear = new Date().getFullYear();
  const priorYear   = currentYear - 1;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      apiFetch("/merch/summary", { params }),
      apiFetch("/merch/styles",  { params }),
      apiFetch("/merch/launch-ramp", { params: {
        from_date: params.from_date,
        to_date:   params.to_date,
        country:   params.country,
      } }),
    ])
      .then(([sum, st, rampData]) => {
        if (cancelled) return;
        setSummary(sum);
        setStyles(st.styles || []);
        setRamp(rampData.by_tier || {});
      })
      .catch(e => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.from_date, filters.to_date, filters.country, filters.brand, filters.dataVersion, localSubcat]);

  // ── current-year launches ────────────────────────────────────────────────
  const cyLaunches = useMemo(() =>
    styles.filter(s => s.launch_date && s.launch_date.startsWith(String(currentYear))),
    [styles, currentYear]);

  const pyLaunches = useMemo(() =>
    styles.filter(s => s.launch_date && s.launch_date.startsWith(String(priorYear))),
    [styles, priorYear]);

  const avgAgeCY = useMemo(() => {
    if (!cyLaunches.length) return 0;
    const now = Date.now();
    const total = cyLaunches.reduce((a, s) => {
      const d = new Date(s.launch_date);
      return a + (now - d.getTime()) / (7 * 24 * 3600 * 1000);
    }, 0);
    return Math.round(total / cyLaunches.length);
  }, [cyLaunches]);

  const revCY = useMemo(() => cyLaunches.reduce((a, s) => a + (s.revenue_6m || 0), 0), [cyLaunches]);

  const onTrackCY = useMemo(() =>
    cyLaunches.filter(s => s.action_status === "on_track").length,
    [cyLaunches]);
  const onTrackPct = cyLaunches.length ? Math.round(onTrackCY / cyLaunches.length * 100) : 0;

  // ── launches by subcategory ──────────────────────────────────────────────
  const bySubcatChart = useMemo(() => {
    const map = {};
    for (const s of cyLaunches) {
      map[s.subcategory || "Other"] = (map[s.subcategory || "Other"] || 0) + 1;
    }
    return Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));
  }, [cyLaunches]);

  // ── SOR ramp chart ───────────────────────────────────────────────────────
  const rampChart = useMemo(() => {
    const tiers = Object.keys(ramp || {});
    const maxWeek = 32;
    const weekSet = new Set();
    for (const tier of tiers) {
      for (const pt of (ramp[tier] || [])) {
        if (pt.week_n <= maxWeek) weekSet.add(pt.week_n);
      }
    }
    const weeks = [...weekSet].sort((a, b) => a - b);
    return weeks.map(w => {
      const row = { week: w };
      for (const tier of tiers) {
        const pt = (ramp[tier] || []).find(p => p.week_n === w);
        row[tier] = pt ? +pt.avg_cumulative_sor_pct.toFixed(1) : undefined;
      }
      return row;
    });
  }, [ramp]);

  // ── launch status donut ──────────────────────────────────────────────────
  const statusDonut = useMemo(() => {
    const map = {};
    for (const s of cyLaunches) {
      const key = s.action_status === "on_track" ? "On Track" :
                  s.action_status === "overdue"  ? "Overdue"  : "At Risk";
      map[key] = (map[key] || 0) + 1;
    }
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  }, [cyLaunches]);

  // ── top recent launches by SOR ───────────────────────────────────────────
  const topSOR = useMemo(() =>
    [...cyLaunches]
      .filter(s => s.sor_6m > 0)
      .sort((a, b) => b.sor_6m - a.sor_6m)
      .slice(0, 8)
      .map(s => {
        const ageWks = s.launch_date
          ? Math.round((Date.now() - new Date(s.launch_date).getTime()) / (7 * 24 * 3600 * 1000))
          : 0;
        return { name: s.style_name, sor: +s.sor_6m.toFixed(1), age: ageWks };
      }),
    [cyLaunches]);

  // ── monthly launch cadence ───────────────────────────────────────────────
  const cadenceChart = useMemo(() => {
    const map = {};
    for (const s of cyLaunches) {
      if (!s.launch_date) continue;
      const mon = s.launch_date.slice(0, 7); // YYYY-MM
      if (!map[mon]) map[mon] = { on: 0, risk: 0 };
      if (s.action_status === "on_track") map[mon].on++;
      else map[mon].risk++;
    }
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([mon, v]) => ({ name: monthLabel(mon), onTrack: v.on, atRisk: v.risk }));
  }, [cyLaunches]);

  // ── by brand donut ───────────────────────────────────────────────────────
  const brandDonut = useMemo(() => {
    const map = {};
    for (const s of cyLaunches) {
      map[s.brand || "Other"] = (map[s.brand || "Other"] || 0) + 1;
    }
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  }, [cyLaunches]);

  if (loading) return <Loading label="Loading New Arrivals & Pipeline…" />;
  if (error)   return <ErrorBox message={error} />;

  const subcatSelector = <SubcatFilter value={localSubcat} onChange={setLocalSubcat} />;

  return (
    <div className="space-y-6 pb-8">
      {subcatSelector}
      {/* Header */}
      <div>
        <h2 className="text-[22px] font-bold text-foreground">New Arrivals &amp; Pipeline Performance</h2>
        <p className="text-[12px] text-muted mt-0.5">
          {priorYear}–{currentYear} Launches, Early SOR &amp; Velocity Ramp · As at {new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
        </p>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KPICard
          label={`Styles Launched ${currentYear}`}
          value={fmtNum(summary?.styles_launched_current_year ?? cyLaunches.length)}
          sub={`In first 52 weeks`}
          icon={Rocket}
          accent showDelta={false}
          testId="arr-cy-count"
        />
        <KPICard
          label={`Styles Launched ${priorYear}`}
          value={fmtNum(summary?.styles_launched_prior_year ?? pyLaunches.length)}
          sub="Full year"
          icon={CalendarBlank}
          accent showDelta={false}
          testId="arr-py-count"
        />
        <KPICard
          label={`Avg Age (${currentYear} styles)`}
          value={avgAgeCY + " wks"}
          sub="Early lifecycle"
          accent showDelta={false}
          testId="arr-avg-age"
        />
        <KPICard
          label={`${currentYear} Revenue`}
          value={fmtKES(revCY) + "+"}
          sub="Estimated 6m"
          icon={CurrencyCircleDollar}
          accent showDelta={false}
          testId="arr-cy-rev"
        />
        <KPICard
          label="Styles On Track"
          value={onTrackPct + "%"}
          sub={`Of ${currentYear} launches`}
          icon={CheckCircle}
          accent showDelta={false}
          testId="arr-on-track"
        />
      </div>

      {/* Row 1: Launches by subcategory + SOR Ramp by Tier + Status donut */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Launches by subcategory — 4 */}
        <div className="lg:col-span-4 card-white p-5">
          <SectionTitle title={`${currentYear} Launches by Subcategory`} subtitle={`Styles Launched in ${currentYear}`} />
          {bySubcatChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={bySubcatChart}
                  layout="vertical"
                  margin={{ top: 4, right: 40, left: 8, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={110} />
                  <Tooltip />
                  <Bar dataKey="count" name="Launches" fill="#1a5c38" radius={[0, 3, 3, 0]}>
                    <LabelList dataKey="count" position="right" style={{ fontSize: 10 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* SOR Ramp — 5 */}
        <div className="lg:col-span-5 card-white p-5">
          <SectionTitle title={`SOR Ramp by Tier — ${currentYear} Launches`} subtitle="Cumulative SOR %" />
          {rampChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={rampChart} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="week" tick={{ fontSize: 10 }} label={{ value: "Weeks Since Launch", position: "insideBottom", offset: -4, style: { fontSize: 10 } }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={v => v + "%"} domain={[0, 100]} />
                  <Tooltip formatter={(v, n) => [v + "%", n]} />
                  <Legend wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
                  <ReferenceLine y={60} stroke="#d97706" strokeDasharray="5 3"
                    label={{ value: "Target 60%", position: "right", style: { fontSize: 9, fill: "#d97706" } }} />
                  {Object.keys(ramp || {}).map(tier => (
                    <Line
                      key={tier}
                      type="monotone"
                      dataKey={tier}
                      name={tier}
                      stroke={TIER_LINE_COLORS[tier] || "#4b7bec"}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* Launch Status donut — 3 */}
        <div className="lg:col-span-3 card-white p-5">
          <SectionTitle title={`${currentYear} Launch Status`} />
          {statusDonut.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={statusDonut}
                    cx="50%"
                    cy="42%"
                    innerRadius={55}
                    outerRadius={82}
                    dataKey="value"
                    nameKey="name"
                    label={({ name, value }) => `${name} (${value})`}
                    labelLine
                  >
                    {statusDonut.map((entry, i) => (
                      <Cell key={i} fill={STATUS_COLORS[entry.name] || "#4b7bec"} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, n) => [v + " styles", n]} />
                </PieChart>
              </ResponsiveContainer>
            )}
        </div>
      </div>

      {/* Row 2: Top SOR + Monthly Cadence + Brand Donut */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Top Recent Launches by SOR — 4 */}
        <div className="lg:col-span-4 card-white p-5">
          <SectionTitle title="Top Recent Launches by SOR" subtitle="Lifetime SOR %" />
          {topSOR.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={topSOR}
                  layout="vertical"
                  margin={{ top: 4, right: 70, left: 8, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10 }} domain={[97, 101]}
                    tickFormatter={v => v + "%"} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={130} />
                  <Tooltip formatter={(v, n) => [v + "%", n]} />
                  <Bar dataKey="sor" name="SOR %" fill="#4b7bec" radius={[0, 3, 3, 0]}>
                    <LabelList
                      dataKey="sor"
                      position="right"
                      style={{ fontSize: 9 }}
                      formatter={(v, _, row) => `${v}% (${topSOR.find(s => s.sor === v)?.age ?? "?"}wks)`}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* Monthly Cadence stacked — 5 */}
        <div className="lg:col-span-5 card-white p-5">
          <SectionTitle title={`${currentYear} Monthly Launch Cadence`} subtitle="Styles Launched" />
          {cadenceChart.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={cadenceChart} margin={{ top: 16, right: 8, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="onTrack" name="On Track" stackId="a" fill="#1a5c38" radius={[0, 0, 0, 0]}>
                    <LabelList dataKey="onTrack" position="inside" style={{ fontSize: 9, fill: "#fff" }} />
                  </Bar>
                  <Bar dataKey="atRisk" name="At Risk" stackId="a" fill="#ef4444" radius={[3, 3, 0, 0]}>
                    <LabelList dataKey="atRisk" position="top" style={{ fontSize: 9 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
        </div>

        {/* Brand Donut — 3 */}
        <div className="lg:col-span-3 card-white p-5">
          <SectionTitle title={`${currentYear} Launches by Brand`} />
          {brandDonut.length === 0
            ? <Empty />
            : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={brandDonut}
                    cx="50%"
                    cy="42%"
                    innerRadius={55}
                    outerRadius={82}
                    dataKey="value"
                    nameKey="name"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                  >
                    {brandDonut.map((_, i) => (
                      <Cell key={i} fill={BRAND_COLORS[i % BRAND_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, n) => [v + " styles", n]} />
                </PieChart>
              </ResponsiveContainer>
            )}
        </div>
      </div>
    </div>
  );
};

export default MerchArrivals;
