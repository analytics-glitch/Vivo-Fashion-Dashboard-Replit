/**
 * GrowthModel — KES 5 Billion / 5-year north star flagship page.
 *
 * Sections:
 *  1. KPI Strip — T12M actual · Target · Monthly compound rate · MTD position
 *  2. Revenue Bridge & Levers — editable same-store / new-stores / online splits
 *  3. Trajectory Chart — actual (area) vs required path (line), 24m back + 24m fwd
 *  4. Store Contribution Paths — per-store MTD actual vs required, sorted by gap
 *  5. Version History — collapsible, auditable lever history
 *
 * Access: leadership + admin (server-gated on /api/growth/*).
 */
import React, { useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ComposedChart,
  Area,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from "recharts";
import {
  RocketLaunch,
  ArrowUp,
  ArrowDown,
  Warning,
  CaretDown,
  CaretUp,
  CheckCircle,
  Clock,
} from "@phosphor-icons/react";
import { api } from "@/lib/api";

// ── Formatters ────────────────────────────────────────────────────────────────

const fmtKes = (v, short = true) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (short) {
    if (a >= 1e9) return `KES ${(v / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `KES ${(v / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `KES ${(v / 1e3).toFixed(0)}K`;
    return `KES ${v.toFixed(0)}`;
  }
  return `KES ${Number(v).toLocaleString("en-KE", { minimumFractionDigits: 0 })}`;
};

const fmtM = (v) => (v == null ? "—" : `${(v / 1e6).toFixed(1)}M`);

const fmtMonth = (s) => {
  if (!s) return "";
  const d = new Date(s + "T00:00:00");
  return d.toLocaleString("en-US", { month: "short", year: "2-digit" });
};

const fmtPct = (v, signed = true) => {
  if (v == null) return "—";
  return `${signed && v > 0 ? "+" : ""}${Number(v).toFixed(1)}%`;
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, accent, icon: Icon, badge, badgeColor }) {
  return (
    <div className="card-white px-4 py-3 flex flex-col gap-1 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-muted uppercase tracking-wide">{label}</span>
        {Icon && <Icon size={14} className="text-muted/50 flex-shrink-0" />}
      </div>
      <div className={`text-[22px] font-bold leading-tight ${accent || "text-foreground"}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
      {badge && (
        <span
          className={`inline-flex items-center gap-0.5 text-[10px] font-semibold rounded-full px-1.5 py-px w-fit ${badgeColor || "bg-sand text-muted"}`}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    ahead:   { label: "Ahead",   cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    at_risk: { label: "At Risk", cls: "bg-amber-50  text-amber-700  border-amber-200"  },
    behind:  { label: "Behind",  cls: "bg-red-50    text-red-700    border-red-200"    },
  };
  const { label, cls } = map[status] || map.at_risk;
  return (
    <span className={`inline-block text-[10px] font-semibold px-1.5 py-px rounded border ${cls}`}>
      {label}
    </span>
  );
}

function GapCell({ gap_kes, gap_pct }) {
  if (gap_kes == null) return <span className="text-muted">—</span>;
  const pos = gap_kes >= 0;
  return (
    <span className={`font-semibold ${pos ? "text-emerald-600" : "text-red-600"}`}>
      {pos ? "+" : ""}
      {fmtKes(gap_kes)}
      {" "}
      <span className="text-[10px] font-normal">
        ({fmtPct(gap_pct)})
      </span>
    </span>
  );
}

// ── Trajectory Chart ──────────────────────────────────────────────────────────

function TrajectoryChart({ trajectory, zoom }) {
  const targetMonthlyM = ((trajectory?.target_kes || 5e9) / 12 / 1e6);

  const data = useMemo(() => {
    if (!trajectory?.rows) return [];
    return trajectory.rows
      .filter((r) => r.month_offset >= -zoom && r.month_offset <= zoom)
      .map((r) => ({
        month:    r.month_start,
        label:    fmtMonth(r.month_start),
        required: r.required != null ? parseFloat((r.required / 1e6).toFixed(2)) : null,
        actual:   r.actual_total != null ? parseFloat((r.actual_total / 1e6).toFixed(2)) : null,
        isMtd:    r.is_mtd,
        offset:   r.month_offset,
      }));
  }, [trajectory, zoom]);

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    return (
      <div className="bg-white border border-border/60 rounded-lg p-3 shadow text-[12px] min-w-[180px]">
        <p className="font-semibold text-foreground mb-2">{label}{d?.isMtd ? " (MTD)" : ""}</p>
        {payload.map((p) => (
          <div key={p.name} className="flex justify-between gap-4">
            <span className="text-muted">{p.name}</span>
            <span className="font-mono font-semibold" style={{ color: p.color }}>
              KES {(p.value || 0).toFixed(1)}M
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: "#6b7280" }}
          interval="preserveStartEnd"
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "#6b7280" }}
          tickFormatter={(v) => `${v.toFixed(0)}M`}
          tickLine={false}
          axisLine={false}
          width={42}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: "11px", color: "#6b7280", paddingTop: "8px" }}
          iconSize={10}
        />
        {/* Target reference line */}
        <ReferenceLine
          y={targetMonthlyM}
          stroke="#ef4444"
          strokeDasharray="6 3"
          strokeWidth={1.5}
          label={{ value: "KES 5B/12", position: "insideRight", fontSize: 9, fill: "#ef4444" }}
        />
        {/* Actual (area for past months) */}
        <Area
          dataKey="actual"
          name="Actual"
          fill="#1a5c38"
          fillOpacity={0.15}
          stroke="#1a5c38"
          strokeWidth={2}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
        {/* Required path (line, all months) */}
        <Line
          dataKey="required"
          name="Required Path"
          stroke="#374151"
          strokeWidth={2}
          strokeDasharray="6 3"
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Lever control ─────────────────────────────────────────────────────────────

function LeverRow({ label, pctKey, levers, onChange, monthlyTarget, currentT12mMonthly, unconfigured, sub }) {
  const v = levers[pctKey] ?? 0;
  const monthlyRequired = (monthlyTarget * v) / 100;
  const currentShare    = currentT12mMonthly * (v / 100);

  return (
    <div className={`rounded-lg border px-4 py-3 space-y-2 ${unconfigured ? "border-amber-200 bg-amber-50/40" : "border-border/50 bg-white"}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="text-[13px] font-semibold text-foreground">{label}</span>
          {unconfigured && (
            <span className="ml-2 text-[10px] bg-amber-100 text-amber-700 border border-amber-300 rounded px-1.5 py-px font-semibold">
              Unconfigured · estimate only
            </span>
          )}
          {sub && <p className="text-[11px] text-muted mt-0.5">{sub}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={v}
            onChange={(e) => onChange(pctKey, parseFloat(e.target.value) || 0)}
            className="w-16 text-right text-[13px] font-bold border border-border/50 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
          <span className="text-[13px] font-bold text-muted">%</span>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={v}
        onChange={(e) => onChange(pctKey, parseFloat(e.target.value))}
        className="w-full accent-brand h-1.5"
      />
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span>
          Today: <strong className="text-foreground">{fmtKes(currentShare)}/mo</strong>
        </span>
        <span>
          At target: <strong className="text-foreground">{fmtKes(monthlyRequired)}/mo</strong>
        </span>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function GrowthModel() {
  const qc = useQueryClient();

  const { data: summary, isLoading: loadSum } = useQuery({
    queryKey: ["growth-summary"],
    queryFn:  () => api.get("/api/growth/summary").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const { data: trajectory, isLoading: loadTraj } = useQuery({
    queryKey: ["growth-trajectory"],
    queryFn:  () => api.get("/api/growth/trajectory").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const { data: storePaths, isLoading: loadStores } = useQuery({
    queryKey: ["growth-store-paths"],
    queryFn:  () => api.get("/api/growth/store-paths").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const { data: versionsData, isLoading: loadVersions } = useQuery({
    queryKey: ["growth-assumptions"],
    queryFn:  () => api.get("/api/growth/assumptions").then((r) => r.data),
    staleTime: 60 * 1000,
    retry: 1,
  });

  // Lever state — seeded from current assumption on first load
  const assumption = summary?.assumption || {};
  const [levers, setLevers] = useState(null);
  const [notes, setNotes]   = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [showHistory, setShowHistory]  = useState(false);
  const [zoom, setZoom] = useState(12);

  // Seed levers from current assumption once loaded
  const effectiveLevers = levers ?? {
    same_store:  assumption.same_store_pct  ?? 60,
    new_stores:  assumption.new_stores_pct  ?? 25,
    online:      assumption.online_pct      ?? 15,
  };

  const handleLeverChange = useCallback((key, val) => {
    setLevers((prev) => ({
      ...(prev ?? {
        same_store: assumption.same_store_pct ?? 60,
        new_stores: assumption.new_stores_pct ?? 25,
        online:     assumption.online_pct     ?? 15,
      }),
      [key]: Math.max(0, Math.min(100, val)),
    }));
  }, [assumption]);

  const leverSum  = effectiveLevers.same_store + effectiveLevers.new_stores + effectiveLevers.online;
  const leverOk   = Math.abs(leverSum - 100) < 0.01;
  const leversChanged = levers !== null && (
    Math.abs(effectiveLevers.same_store - (assumption.same_store_pct ?? 60)) > 0.01 ||
    Math.abs(effectiveLevers.new_stores - (assumption.new_stores_pct ?? 25)) > 0.01 ||
    Math.abs(effectiveLevers.online     - (assumption.online_pct     ?? 15)) > 0.01
  );

  const handleSave = async () => {
    if (!leverOk || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await api.post("/api/growth/assumptions", {
        same_store_pct: effectiveLevers.same_store,
        new_stores_pct: effectiveLevers.new_stores,
        online_pct:     effectiveLevers.online,
        target_kes:     assumption.target_kes     || 5e9,
        target_months:  assumption.target_months  || 60,
        notes,
      });
      setSaveMsg("Saved successfully");
      setLevers(null);
      setNotes("");
      qc.invalidateQueries({ queryKey: ["growth-summary"] });
      qc.invalidateQueries({ queryKey: ["growth-trajectory"] });
      qc.invalidateQueries({ queryKey: ["growth-store-paths"] });
      qc.invalidateQueries({ queryKey: ["growth-assumptions"] });
    } catch (e) {
      setSaveMsg("Save failed — " + (e?.response?.data?.error || "unknown error"));
    } finally {
      setSaving(false);
    }
  };

  // Derived from summary
  const baseline    = summary?.baseline    || {};
  const cm          = summary?.current_month || {};
  const rPct        = summary?.monthly_rate_pct || 0;
  const annualPct   = ((Math.pow(1 + rPct / 100, 12) - 1) * 100).toFixed(1);
  const targetDate  = summary?.target_date;
  const bm          = baseline.monthly_baseline || 0;
  // Live milestone for "month 1" (current month) with current levers
  const liveM1 = bm * Math.pow(1 + rPct / 100, 1);

  const versions = versionsData?.versions || [];

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-8">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-brand/10 flex items-center justify-center flex-shrink-0">
            <RocketLaunch size={18} weight="duotone" className="text-brand" />
          </div>
          <div>
            <h1 className="text-[22px] font-bold text-foreground leading-tight">Growth Model</h1>
            <p className="text-[12.5px] text-muted mt-0.5">
              KES 5 Billion · 5-year north star · compound monthly trajectory
            </p>
          </div>
        </div>
        {assumption.version && (
          <span className="text-[10.5px] text-muted border border-border/50 rounded px-2 py-1 flex-shrink-0">
            Assumption v{assumption.version} · {assumption.author_email}
          </span>
        )}
      </div>

      {/* ── KPI Strip ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="T12M Net Sales"
          value={loadSum ? "…" : fmtKes(baseline.t12m_total_kes)}
          sub={`Retail ${fmtKes(baseline.t12m_retail_kes)} · Online ${fmtKes(baseline.t12m_online_kes)}`}
          icon={RocketLaunch}
        />
        <KpiCard
          label="5-Year Target"
          value="KES 5.00B"
          sub={targetDate ? `Deadline: ${targetDate}` : "60 months"}
          accent="text-brand"
        />
        <KpiCard
          label="Required Monthly Rate"
          value={loadSum ? "…" : `+${rPct.toFixed(3)}%`}
          sub={`≈ ${annualPct}% p.a. (compound)`}
        />
        <KpiCard
          label={`MTD ${cm.month_start ? new Date(cm.month_start + "T00:00:00").toLocaleString("en-US", { month: "short", year: "numeric" }) : ""}`}
          value={loadSum ? "…" : fmtKes(cm.gap_kes)}
          sub={
            cm.mtd_actual != null
              ? `Actual ${fmtKes(cm.mtd_actual)} vs prorated ${fmtKes(cm.prorated_target)} (day ${cm.elapsed_days}/${cm.total_days})`
              : "—"
          }
          accent={cm.gap_kes >= 0 ? "text-emerald-600" : "text-red-600"}
          badge={
            cm.gap_kes == null ? null
              : cm.gap_kes >= 0 ? `Ahead ${fmtPct(cm.gap_pct)}`
              : `Behind ${fmtPct(Math.abs(cm.gap_pct))}`
          }
          badgeColor={
            cm.gap_kes >= 0
              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }
          icon={cm.gap_kes >= 0 ? ArrowUp : ArrowDown}
        />
      </div>

      {/* ── Revenue Bridge & Levers ── */}
      <div className="card-white p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[14px] font-bold text-foreground">Revenue Bridge &amp; Growth Levers</h2>
            <p className="text-[11.5px] text-muted mt-0.5">
              Adjust the split between growth channels. All levers must sum to 100%.
            </p>
          </div>
          <span
            className={`text-[11px] font-semibold px-2 py-1 rounded border ${
              leverOk
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-red-50 text-red-700 border-red-200"
            }`}
          >
            {leverOk ? `100% ✓` : `${leverSum.toFixed(1)}% — must sum to 100`}
          </span>
        </div>

        <div className="grid md:grid-cols-3 gap-3">
          <LeverRow
            label="Same-Store Growth"
            pctKey="same_store"
            levers={effectiveLevers}
            onChange={handleLeverChange}
            monthlyTarget={liveM1}
            currentT12mMonthly={bm}
            sub="Revenue growth from existing stores — the primary lever."
          />
          <LeverRow
            label="New Stores"
            pctKey="new_stores"
            levers={effectiveLevers}
            onChange={handleLeverChange}
            monthlyTarget={liveM1}
            currentT12mMonthly={bm}
            unconfigured
            sub="No pipeline data — estimate only. Add store opening plan to configure."
          />
          <LeverRow
            label="Online / E-commerce"
            pctKey="online"
            levers={effectiveLevers}
            onChange={handleLeverChange}
            monthlyTarget={liveM1}
            currentT12mMonthly={bm}
            sub="Shop Zetu + future digital channels (live from all_sales)."
          />
        </div>

        {/* Save controls */}
        <div className="mt-4 border-t border-border/30 pt-4 flex items-end gap-3">
          <div className="flex-1">
            <label className="text-[11px] font-semibold text-muted block mb-1">
              Notes (optional)
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Updated after Q3 board review"
              maxLength={200}
              className="w-full text-[12.5px] border border-border/50 rounded px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
          </div>
          <button
            onClick={handleSave}
            disabled={!leverOk || saving || !leversChanged}
            className="flex-shrink-0 flex items-center gap-1.5 bg-brand text-white text-[12.5px] font-semibold px-4 py-2 rounded-lg hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? (
              <><span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Saving…</>
            ) : (
              <><CheckCircle size={13} weight="bold" /> Save as new version</>
            )}
          </button>
          {saveMsg && (
            <span className={`text-[11.5px] ${saveMsg.startsWith("Saved") ? "text-emerald-600" : "text-red-600"}`}>
              {saveMsg}
            </span>
          )}
        </div>
      </div>

      {/* ── Trajectory Chart ── */}
      <div className="card-white p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-[14px] font-bold text-foreground">Revenue Trajectory</h2>
            <p className="text-[11.5px] text-muted mt-0.5">
              Monthly net sales (ex-VAT) vs compound required path
            </p>
          </div>
          <div className="flex items-center gap-1">
            {[
              { label: "12m", v: 12 },
              { label: "24m", v: 24 },
              { label: "Full", v: 60 },
            ].map(({ label, v }) => (
              <button
                key={v}
                onClick={() => setZoom(v)}
                className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                  zoom === v
                    ? "bg-brand text-white border-brand"
                    : "text-muted border-border/50 hover:border-brand/40"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {loadTraj ? (
          <div className="h-[280px] flex items-center justify-center">
            <span className="text-muted text-[12px]">Loading trajectory…</span>
          </div>
        ) : (
          <TrajectoryChart trajectory={trajectory} zoom={zoom} />
        )}
        <p className="text-[10.5px] text-muted/60 mt-2">
          Dashed line = required compound path to KES 5B. Green area = actual net sales.
          Red dashed = KES 5B ÷ 12 monthly target. Past months show completed actuals; current month shows MTD.
        </p>
      </div>

      {/* ── Store Contribution Paths ── */}
      <div className="card-white p-5">
        <div className="mb-4">
          <h2 className="text-[14px] font-bold text-foreground">Store Contribution Paths</h2>
          <p className="text-[11.5px] text-muted mt-0.5">
            Same-store lever ({effectiveLevers.same_store}%) distributed by each store's T12M revenue share.
            Sorted by gap (most behind first).
          </p>
        </div>

        {loadStores ? (
          <div className="h-24 flex items-center justify-center text-muted text-[12px]">Loading store paths…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-border/30">
                  {[
                    "Store", "T12M Net", "Share", "Monthly Req",
                    "MTD Req (prorated)", "MTD Actual", "Gap vs Path", "Status",
                  ].map((h) => (
                    <th key={h} className="text-left font-semibold text-muted pb-2 pr-3 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(storePaths?.stores || []).map((s) => (
                  <tr
                    key={s.store}
                    className="border-b border-border/20 hover:bg-sand/30 transition-colors"
                  >
                    <td className="py-2 pr-3 font-medium text-foreground whitespace-nowrap">{s.store}</td>
                    <td className="py-2 pr-3 font-mono text-muted whitespace-nowrap">{fmtKes(s.t12m_net)}</td>
                    <td className="py-2 pr-3 text-muted whitespace-nowrap">{s.retail_share_pct}%</td>
                    <td className="py-2 pr-3 font-mono whitespace-nowrap">{fmtKes(s.monthly_req)}</td>
                    <td className="py-2 pr-3 font-mono text-muted whitespace-nowrap">{fmtKes(s.mtd_req)}</td>
                    <td className="py-2 pr-3 font-mono whitespace-nowrap">{fmtKes(s.mtd_actual)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <GapCell gap_kes={s.gap_kes} gap_pct={s.gap_pct} />
                    </td>
                    <td className="py-2">
                      <StatusBadge status={s.status} />
                    </td>
                  </tr>
                ))}
                {/* Online summary row */}
                {storePaths && (
                  <tr className="border-b border-border/20 bg-blue-50/30">
                    <td className="py-2 pr-3 font-medium text-blue-700 italic whitespace-nowrap">
                      Online / Shop Zetu
                    </td>
                    <td className="py-2 pr-3 font-mono text-muted whitespace-nowrap">
                      {fmtKes(summary?.baseline?.t12m_online_kes)}
                    </td>
                    <td className="py-2 pr-3 text-muted whitespace-nowrap">
                      {baseline.t12m_total_kes
                        ? ((baseline.t12m_online_kes / baseline.t12m_total_kes) * 100).toFixed(1) + "%"
                        : "—"}
                    </td>
                    <td
                      colSpan={5}
                      className="py-2 pr-3 text-[11px] text-muted italic"
                    >
                      Online contribution tracked via Shop Zetu · lever: {effectiveLevers.online}% of monthly path ·
                      See trajectory chart for channel split
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {storePaths?.stores?.length === 0 && !loadStores && (
          <p className="text-[12px] text-muted text-center py-6">
            No store data available. Sales history may be loading.
          </p>
        )}
      </div>

      {/* ── Data Gap Notice ── */}
      <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3">
        <div className="flex items-start gap-2">
          <Warning size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-[12px] text-amber-800 space-y-1">
            <p className="font-semibold">Data gaps — not fabricated</p>
            <p>
              <strong>New-store lever (25% default):</strong> No store-opening pipeline data available.
              This lever is an estimate only — the required monthly KES cannot be split by individual planned store.
              To configure: provide store pipeline data.
            </p>
            <p>
              <strong>Margin by channel:</strong> Gross margin and cost data are not available at channel level.
              This model tracks net revenue (ex-VAT, post-discounts and returns) only.
            </p>
          </div>
        </div>
      </div>

      {/* ── Assumption History ── */}
      <div className="card-white p-5">
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="flex items-center gap-2 w-full text-left"
        >
          <Clock size={14} className="text-muted" />
          <span className="text-[13px] font-bold text-foreground">Assumption History</span>
          <span className="text-[10px] text-muted">({versions.length} versions)</span>
          <span className="ml-auto text-muted">
            {showHistory ? <CaretUp size={13} /> : <CaretDown size={13} />}
          </span>
        </button>

        {showHistory && (
          <div className="mt-4 space-y-2">
            {loadVersions && (
              <p className="text-[12px] text-muted">Loading…</p>
            )}
            {versions.map((v) => (
              <div
                key={v.id}
                className={`rounded border px-3 py-2 text-[12px] ${
                  v.is_current
                    ? "border-brand/30 bg-brand/5"
                    : "border-border/30 bg-white"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold text-foreground">v{v.version}</span>
                  {v.is_current && (
                    <span className="text-[10px] bg-brand text-white rounded px-1.5 py-px font-semibold">
                      current
                    </span>
                  )}
                  <span className="text-muted ml-auto text-[10.5px]">
                    {v.author_email} · {v.created_at?.slice(0, 16).replace("T", " ")}
                  </span>
                </div>
                <div className="flex gap-4 text-muted">
                  <span>Same-store: <strong>{v.same_store_pct}%</strong></span>
                  <span>New stores: <strong>{v.new_stores_pct}%</strong></span>
                  <span>Online: <strong>{v.online_pct}%</strong></span>
                  <span>Target: <strong>{fmtKes(v.target_kes)}</strong></span>
                </div>
                {v.notes && <p className="mt-1 text-muted/70 italic">{v.notes}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
