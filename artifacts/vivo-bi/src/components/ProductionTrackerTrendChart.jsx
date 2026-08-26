import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  CartesianGrid, XAxis, YAxis, Tooltip, Legend,
} from "recharts";
import { api } from "@/lib/api";

/**
 * Trend visuals for the Production Tracker 2026 Google Sheet feed.
 *
 * Every number here comes from `production_tracker_sheet_metrics`
 * (governed backend table, never a frontend constant). Unavailable data
 * is rendered as a genuine gap (`null`, `connectNulls={false}`) — never
 * coerced to zero. The three conflicting annual totals are shown
 * side-by-side and are never reconciled against one another. The
 * sheet's own "Average Output per Person" figure is never plotted —
 * the `process_productivity` variant only shows the independently
 * computed `stitched_output_per_operator_day` replacement.
 */

const MONTH_LABEL = (periodKey) => {
  if (!periodKey || !periodKey.includes("-")) return periodKey;
  const [, month] = periodKey.split("-");
  return ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month)] || periodKey;
};

function useTrackerMetrics(metricGroup) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.get("/production-workspace/tracker-sheet/metrics", { params: { metric_group: metricGroup }, forceFresh: true })
      .then((res) => { if (alive) setRows(res.data?.metrics || []); })
      .catch((err) => { if (alive) setError(err?.response?.data?.detail || "Tracker sheet metrics are unavailable."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [metricGroup]);
  return { rows, loading, error };
}

const slugify = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function ChartShell({ eyebrow, title, subtitle, loading, error, empty, emptyNote, children }) {
  // Every chart shares the same eyebrow ("Production Tracker 2026 · Sheet
  // feed"), so the testid must be keyed off the (unique) title, not the
  // eyebrow, or every chart on a page collides on one selector.
  return <section className="pw-panel p-4" data-testid={`pw-tracker-chart-${slugify(title) || "trend"}`}>
    <div className="pw-eyebrow">{eyebrow}</div>
    <div className="mt-1 font-bold" style={{ color: "var(--pw-navy)" }}>{title}</div>
    {subtitle && <div className="mt-1 text-xs" style={{ color: "var(--pw-text-muted)" }}>{subtitle}</div>}
    <div className="mt-3">
      {loading ? <div className="py-8 text-center text-xs" style={{ color: "var(--pw-text-muted)" }}>Loading tracker sheet metrics…</div>
        : error ? <div className="py-8 text-center text-xs" style={{ color: "#a8321d" }}>{error}</div>
        : empty ? <div className="py-8 text-center text-xs" style={{ color: "var(--pw-text-muted)" }}>{emptyNote || "No metric is available for this view yet."}</div>
        : children}
    </div>
  </section>;
}

// ---------------------------------------------------------------------------
// variant: monthly_output — Stitched vs Transfer output, actual vs plan,
// month-by-month across 2026. Sep–Dec actuals and any other missing month
// are absent points (a break in the line), never a zero.
// ---------------------------------------------------------------------------
function MonthlyOutputChart() {
  const stitched = useTrackerMetrics("stitched_output");
  const transfer = useTrackerMetrics("transfer_output");
  const loading = stitched.loading || transfer.loading;
  const error = stitched.error || transfer.error;
  const chartData = useMemo(() => {
    const byMonth = {};
    const ensure = (key) => (byMonth[key] ||= { period_key: key, label: MONTH_LABEL(key) });
    stitched.rows.forEach((row) => {
      if (row.dimension === "actual") ensure(row.period_key).stitched_actual = row.is_available ? row.value : null;
      if (row.dimension === "plan") ensure(row.period_key).stitched_plan = row.is_available ? row.value : null;
    });
    transfer.rows.forEach((row) => {
      if (row.dimension === "actual") ensure(row.period_key).transfer_actual = row.is_available ? row.value : null;
      if (row.dimension === "plan") ensure(row.period_key).transfer_plan = row.is_available ? row.value : null;
    });
    return Object.values(byMonth).sort((a, b) => a.period_key.localeCompare(b.period_key));
  }, [stitched.rows, transfer.rows]);
  const anyPartial = stitched.rows.some((row) => row.is_partial_period) || transfer.rows.some((row) => row.is_partial_period);
  return <ChartShell
    eyebrow="Production Tracker 2026 · Sheet feed" title="Stitched & transfer output — actual vs plan"
    subtitle="Monthly units from the governed Production Tracker sheet. A missing month (e.g. Sep–Dec actuals) is a real gap in the line, never plotted as zero."
    loading={loading} error={error} empty={!chartData.length}>
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={chartData} margin={{ top: 8, right: 14, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--pw-border-light)" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--pw-text-muted)" />
        <YAxis tick={{ fontSize: 10 }} stroke="var(--pw-text-muted)" />
        <Tooltip formatter={(value) => (value == null ? "Unavailable" : value.toLocaleString())} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line type="monotone" dataKey="stitched_actual" name="Stitched actual" stroke="#0A192F" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="stitched_plan" name="Stitched plan" stroke="#C5A059" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="transfer_actual" name="Transfer actual" stroke="#236541" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="transfer_plan" name="Transfer plan" stroke="#885b08" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
    {anyPartial && <div className="mt-2 text-[11px]" style={{ color: "var(--pw-text-muted)" }}>The current month's point reflects a partial period (month in progress) — treat it as directional, not a completed total.</div>}
  </ChartShell>;
}

// ---------------------------------------------------------------------------
// variant: fabric_mix — Woven vs Knit monthly units. August (and any other
// month the sheet does not report) is a real gap, never plotted as zero.
// The source sheet's "Wooven" typo is normalized to "Woven" server-side
// (normalized_label); the raw source_label is kept in the data but never
// shown to users.
// ---------------------------------------------------------------------------
function FabricMixChart() {
  const { rows, loading, error } = useTrackerMetrics("fabric_mix");
  const chartData = useMemo(() => {
    const byMonth = {};
    const ensure = (key) => (byMonth[key] ||= { period_key: key, label: MONTH_LABEL(key) });
    rows.forEach((row) => { ensure(row.period_key)[row.dimension] = row.is_available ? row.value : null; });
    return Object.values(byMonth).sort((a, b) => a.period_key.localeCompare(b.period_key));
  }, [rows]);
  const dimLabel = useMemo(() => {
    const map = {};
    rows.forEach((row) => { map[row.dimension] = row.normalized_label || row.dimension; });
    return map;
  }, [rows]);
  return <ChartShell
    eyebrow="Production Tracker 2026 · Sheet feed" title="Fabric mix — Woven vs Knit"
    subtitle="Monthly units by fabric type from the governed Production Tracker sheet. A missing month (e.g. August) is a real gap in the line, never plotted as zero. The source sheet's 'Wooven' label is normalized to 'Woven' for display."
    loading={loading} error={error} empty={!chartData.length}>
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ top: 8, right: 14, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--pw-border-light)" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--pw-text-muted)" />
        <YAxis tick={{ fontSize: 10 }} stroke="var(--pw-text-muted)" />
        <Tooltip formatter={(value) => (value == null ? "Unavailable" : value.toLocaleString())} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line type="monotone" dataKey="woven" name={dimLabel.woven || "Woven"} stroke="#0A192F" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="knit" name={dimLabel.knit || "Knit"} stroke="#C5A059" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </ChartShell>;
}

// ---------------------------------------------------------------------------
// variant: annual_totals — the sheet states three DIFFERENT annual plan
// totals (Expected Output on Summary, the Monthly Plan rollup, and the
// Quarterly Plan total). They are shown side by side and are deliberately
// never reconciled or averaged into a single "true" number.
// ---------------------------------------------------------------------------
const ANNUAL_TOTAL_LABELS = {
  expected_output: "Expected output (Summary tab)",
  monthly_plan_rollup: "Monthly plan rollup",
  quarterly_plan_total: "Quarterly plan total",
};
const ANNUAL_CONTEXT_LABELS = {
  buying_quantity: "Buying quantity",
  in_house: "In-house",
  outsourced: "Outsourced",
};

function AnnualTotalsChart() {
  const { rows, loading, error } = useTrackerMetrics("annual_totals");
  const conflicting = useMemo(() => rows
    .filter((row) => ANNUAL_TOTAL_LABELS[row.dimension])
    .map((row) => ({ label: ANNUAL_TOTAL_LABELS[row.dimension], value: row.is_available ? row.value : null }))
  , [rows]);
  const context = useMemo(() => rows
    .filter((row) => ANNUAL_CONTEXT_LABELS[row.dimension])
    .map((row) => ({ label: ANNUAL_CONTEXT_LABELS[row.dimension], value: row.is_available ? row.value : null }))
  , [rows]);
  return <ChartShell
    eyebrow="Production Tracker 2026 · Sheet feed" title="2026 annual plan — three conflicting totals"
    subtitle="The source sheet states three different annual totals across its Summary, Monthly and Quarterly views. They disagree with each other in the sheet itself — shown here exactly as-is, never reconciled or averaged into a single figure."
    loading={loading} error={error} empty={!conflicting.length}>
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={conflicting} margin={{ top: 8, right: 14, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--pw-border-light)" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--pw-text-muted)" interval={0} />
        <YAxis tick={{ fontSize: 10 }} stroke="var(--pw-text-muted)" />
        <Tooltip formatter={(value) => (value == null ? "Unavailable" : value.toLocaleString())} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
        <Bar dataKey="value" name="Annual total (units)" fill="#C5A059" radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
    {context.length > 0 && <div className="mt-4 grid grid-cols-3 gap-3">{context.map((item) => <div key={item.label}><div className="pw-metric-label">{item.label}</div><div className="pw-metric-value mt-1">{item.value == null ? "Unavailable" : item.value.toLocaleString()}</div></div>)}</div>}
    <div className="mt-3 text-[11px]" style={{ color: "var(--pw-text-muted)" }}>These three totals are surfaced, not reconciled — treat the gap between them as a source data-quality issue to raise with whoever maintains the sheet.</div>
  </ChartShell>;
}

// ---------------------------------------------------------------------------
// variant: process_productivity — output per operator per working day,
// computed independently (output ÷ operators ÷ working days in month).
// The sheet's own "Average Output per Person" row is never plotted; its
// brokenness is raised separately as a warning in the Setup panel.
// ---------------------------------------------------------------------------
function ProcessProductivityChart() {
  const { rows, loading, error } = useTrackerMetrics("process_productivity");
  const chartData = useMemo(() => rows
    .filter((row) => row.dimension === "stitched_output_per_operator_day")
    .map((row) => ({ period_key: row.period_key, label: MONTH_LABEL(row.period_key), value: row.is_available ? row.value : null }))
    .sort((a, b) => a.period_key.localeCompare(b.period_key))
  , [rows]);
  return <ChartShell
    eyebrow="Production Tracker 2026 · Sheet feed" title="Stitched output per operator per day"
    subtitle="Independently computed as stitched output ÷ operators ÷ working days in the month. The sheet's own 'Average Output per Person' formula does not reconcile with output ÷ headcount and is never used here — see the Setup panel warning."
    loading={loading} error={error} empty={!chartData.length}>
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={chartData} margin={{ top: 8, right: 14, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--pw-border-light)" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--pw-text-muted)" />
        <YAxis tick={{ fontSize: 10 }} stroke="var(--pw-text-muted)" />
        <Tooltip formatter={(value) => (value == null ? "Unavailable" : value.toLocaleString())} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
        <Line type="monotone" dataKey="value" name="Units / operator / day" stroke="#0A192F" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </ChartShell>;
}

// ---------------------------------------------------------------------------
// variant: quality_defects — defect/reject/rework units from the sheet.
// The confirmed baseline carries none of this data at all: every dimension
// is explicitly `is_available=false` rather than absent, so this renders a
// clear "not available" state instead of quietly having nothing to show.
// A future live sync that finds a real Defects/Rejects/Rework row on the
// sheet populates the same governed rows without any frontend change.
// ---------------------------------------------------------------------------
const DEFECT_DIMENSION_LABELS = {
  defect_units: "Defects",
  rejected_units: "Rejects",
  reworked_units: "Rework",
};

function DefectMetricsChart() {
  const { rows, loading, error } = useTrackerMetrics("quality_defects");
  const chartData = useMemo(() => {
    const byMonth = {};
    const ensure = (key) => (byMonth[key] ||= { period_key: key, label: MONTH_LABEL(key) });
    rows.forEach((row) => {
      if (DEFECT_DIMENSION_LABELS[row.dimension]) {
        ensure(row.period_key)[row.dimension] = row.is_available ? row.value : null;
      }
    });
    return Object.values(byMonth).sort((a, b) => a.period_key.localeCompare(b.period_key));
  }, [rows]);
  const anyAvailable = rows.some((row) => row.is_available);
  return <ChartShell
    eyebrow="Production Tracker 2026 · Sheet feed" title="Defects, rejects & rework"
    subtitle="Monthly defect/reject/rework units from the governed Production Tracker sheet. Not available is never shown as zero."
    loading={loading} error={error} empty={!anyAvailable}
    emptyNote="Not available — the Production Tracker 2026 sheet does not currently report defect, reject or rework figures. This is tracked as an unavailable metric, not assumed to be zero.">
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ top: 8, right: 14, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--pw-border-light)" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="var(--pw-text-muted)" />
        <YAxis tick={{ fontSize: 10 }} stroke="var(--pw-text-muted)" />
        <Tooltip formatter={(value) => (value == null ? "Unavailable" : value.toLocaleString())} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line type="monotone" dataKey="defect_units" name="Defects" stroke="#a8321d" strokeWidth={2.5} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="rejected_units" name="Rejects" stroke="#885b08" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="reworked_units" name="Rework" stroke="#236541" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </ChartShell>;
}

export default function ProductionTrackerTrendChart({ variant }) {
  if (variant === "annual_totals") return <AnnualTotalsChart />;
  if (variant === "process_productivity") return <ProcessProductivityChart />;
  if (variant === "quality_defects") return <DefectMetricsChart />;
  if (variant === "fabric_mix") return <FabricMixChart />;
  return <MonthlyOutputChart />;
}
