import React, { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import {
  Medal,
  ArrowClockwise,
  CheckCircle,
  Warning,
  DropHalf,
  ChartBar,
} from "@phosphor-icons/react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
} from "recharts";

/**
 * Quality Dashboard — four trackers from the Quality Google Sheet:
 *   1. Repairs per sewing line vs production (bar chart, daily/weekly/monthly)
 *   2. Overall repairs vs production with repair rate % (line + bar)
 *   3. Customer complaint types per week (stacked bar)
 *   4. Washing qty vs production per week (bar + line)
 */

const PERIOD_OPTIONS = ["daily", "weekly", "monthly"];

const LINE_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899"];

const pct = (a, b) => (b && b > 0 ? ((a / b) * 100).toFixed(1) + "%" : "—");

const shortLabel = (lbl, period) => {
  if (!lbl) return "";
  if (period === "monthly") return lbl.slice(0, 7);
  // For weekly/daily show MM/DD
  try {
    const d = new Date(lbl);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch {
    return lbl;
  }
};

// ── KPI summary pill ──────────────────────────────────────────────────────────
const KPIPill = ({ label, value, sub, accent }) => (
  <div className={`rounded-lg border px-4 py-3 flex flex-col gap-0.5 ${accent || "bg-white border-gray-200"}`}>
    <span className="text-xs text-gray-500 font-medium">{label}</span>
    <span className="text-2xl font-bold text-gray-900">{value ?? "—"}</span>
    {sub && <span className="text-xs text-gray-400">{sub}</span>}
  </div>
);

// ── Period selector ───────────────────────────────────────────────────────────
const PeriodToggle = ({ value, onChange }) => (
  <div className="flex gap-1 rounded-lg bg-gray-100 p-1 text-xs font-medium">
    {PERIOD_OPTIONS.map((p) => (
      <button
        key={p}
        onClick={() => onChange(p)}
        className={`px-3 py-1 rounded-md capitalize transition-colors ${
          value === p
            ? "bg-white text-gray-900 shadow-sm"
            : "text-gray-500 hover:text-gray-700"
        }`}
      >
        {p}
      </button>
    ))}
  </div>
);

// ── Section wrapper ───────────────────────────────────────────────────────────
const Section = ({ title, icon: Icon, children, controls }) => (
  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
    <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-100">
      <div className="flex items-center gap-2 text-gray-700 font-semibold text-sm">
        {Icon && <Icon size={16} />}
        {title}
      </div>
      {controls}
    </div>
    <div className="p-5">{children}</div>
  </div>
);

// ── 1. Repairs per line ───────────────────────────────────────────────────────
const RepairsByLine = () => {
  const [period, setPeriod] = useState("weekly");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api(`/quality/repairs?period=${period}`);
      setData(res.data);
    } catch (e) {
      setErr(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const rows = data?.data || [];
  // Collect all line keys (A, B, C, …)
  const lineKeys = Array.from(
    new Set(rows.flatMap((r) => Object.keys(r.lines || {})))
  ).sort();

  const chartData = rows.map((r) => ({
    label: shortLabel(r.period_label, period),
    production: r.production,
    ...lineKeys.reduce((acc, k) => { acc[k] = (r.lines || {})[k] || 0; return acc; }, {}),
  }));

  // Latest period repair rate
  const latest = rows[rows.length - 1];
  const totalRepairs = latest
    ? lineKeys.reduce((s, k) => s + ((latest.lines || {})[k] || 0), 0)
    : null;

  return (
    <Section
      title="Repairs per Sewing Line vs Production"
      icon={ChartBar}
      controls={<PeriodToggle value={period} onChange={setPeriod} />}
    >
      {loading && <Loading />}
      {err && <ErrorBox message={err} />}
      {!loading && !err && rows.length === 0 && (
        <Empty message="No repairs data found in the Quality sheet." />
      )}
      {!loading && !err && rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <KPIPill
              label="Latest repair rate"
              value={pct(totalRepairs, latest?.production)}
              sub={`${period} — ${latest?.period_label}`}
            />
            <KPIPill
              label="Latest production"
              value={latest?.production?.toLocaleString()}
              sub="units"
            />
            <KPIPill
              label="Latest repairs"
              value={totalRepairs?.toLocaleString()}
              sub="all lines"
            />
            <KPIPill
              label="Lines tracked"
              value={lineKeys.length}
              sub={lineKeys.join(", ")}
            />
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              {lineKeys.map((k, i) => (
                <Bar key={k} dataKey={k} name={`Line ${k}`} stackId="lines"
                  fill={LINE_COLORS[i % LINE_COLORS.length]} radius={i === lineKeys.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
              ))}
              <Bar dataKey="production" name="Production" fill="#d1d5db" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
    </Section>
  );
};

// ── 2. Overall repairs ────────────────────────────────────────────────────────
const OverallRepairs = () => {
  const [period, setPeriod] = useState("weekly");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api(`/quality/overall-repairs?period=${period}`);
      setData(res.data);
    } catch (e) {
      setErr(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const rows = data?.data || [];
  const chartData = rows.map((r) => ({
    label: shortLabel(r.period_label, period),
    repairs: r.repairs,
    production: r.production,
    repairRate: r.production > 0 ? parseFloat(((r.repairs / r.production) * 100).toFixed(2)) : 0,
  }));

  const latest = rows[rows.length - 1];
  const avgRate = rows.length > 0
    ? (rows.reduce((s, r) => s + (r.production > 0 ? (r.repairs / r.production) * 100 : 0), 0) / rows.length).toFixed(1)
    : null;

  return (
    <Section
      title="Overall Repairs vs Production"
      icon={Warning}
      controls={<PeriodToggle value={period} onChange={setPeriod} />}
    >
      {loading && <Loading />}
      {err && <ErrorBox message={err} />}
      {!loading && !err && rows.length === 0 && (
        <Empty message="No overall-repairs data found in the Quality sheet." />
      )}
      {!loading && !err && rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <KPIPill
              label="Latest repair rate"
              value={pct(latest?.repairs, latest?.production)}
              sub={`${period} — ${latest?.period_label}`}
              accent={
                latest && latest.production > 0 && (latest.repairs / latest.production) > 0.05
                  ? "bg-red-50 border-red-200"
                  : "bg-green-50 border-green-200"
              }
            />
            <KPIPill label="Latest repairs" value={latest?.repairs?.toLocaleString()} sub="units" />
            <KPIPill label="Latest production" value={latest?.production?.toLocaleString()} sub="units" />
            <KPIPill label={`Avg repair rate (${rows.length} ${period}s)`} value={avgRate ? avgRate + "%" : "—"} />
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 4, right: 40, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => v + "%"} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v, name) => name === "Repair Rate %" ? v + "%" : v.toLocaleString()} />
              <Legend />
              <Bar yAxisId="left" dataKey="repairs" name="Repairs" fill="#ef4444" radius={[3, 3, 0, 0]} />
              <Bar yAxisId="left" dataKey="production" name="Production" fill="#d1d5db" radius={[3, 3, 0, 0]} />
              <Line yAxisId="right" type="monotone" dataKey="repairRate" name="Repair Rate %" stroke="#f59e0b" strokeWidth={2} dot={false} />
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
    </Section>
  );
};

// ── 3. Customer complaints ────────────────────────────────────────────────────
const Complaints = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api("/quality/complaints")
      .then((r) => setData(r.data))
      .catch((e) => setErr(e.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const rows = data?.data || [];
  // All complaint types across all weeks
  const allTypes = Array.from(
    new Set(rows.flatMap((r) => (r.breakdown || []).map((b) => b.type)))
  ).sort();

  const chartData = rows.map((r) => {
    const row = { label: shortLabel(r.week_start, "weekly") };
    (r.breakdown || []).forEach((b) => { row[b.type] = b.count; });
    return row;
  });

  return (
    <Section title="Customer Complaint Types" icon={CheckCircle}>
      {loading && <Loading />}
      {err && <ErrorBox message={err} />}
      {!loading && !err && rows.length === 0 && (
        <Empty message="No complaints data found. Add data to the Quality sheet or use the manual entry below." />
      )}
      {!loading && !err && rows.length > 0 && (
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={chartData} margin={{ top: 4, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Legend />
            {allTypes.map((t, i) => (
              <Bar key={t} dataKey={t} stackId="complaints"
                fill={LINE_COLORS[i % LINE_COLORS.length]}
                radius={i === allTypes.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </Section>
  );
};

// ── 4. Washing ────────────────────────────────────────────────────────────────
const Washing = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api("/quality/washing")
      .then((r) => setData(r.data))
      .catch((e) => setErr(e.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const rows = data?.data || [];
  const chartData = rows.map((r) => ({
    label: shortLabel(r.week_start, "weekly"),
    washing_qty: r.washing_qty,
    production_qty: r.production_qty,
    washingRate: r.production_qty > 0
      ? parseFloat(((r.washing_qty / r.production_qty) * 100).toFixed(2))
      : 0,
  }));

  const latest = rows[rows.length - 1];

  return (
    <Section title="Washing Qty vs Production" icon={DropHalf}>
      {loading && <Loading />}
      {err && <ErrorBox message={err} />}
      {!loading && !err && rows.length === 0 && (
        <Empty message="No washing data found in the Quality sheet." />
      )}
      {!loading && !err && rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
            <KPIPill
              label="Latest washing rate"
              value={pct(latest?.washing_qty, latest?.production_qty)}
              sub={`w/c ${latest?.week_start}`}
            />
            <KPIPill label="Latest washing qty" value={latest?.washing_qty?.toLocaleString()} sub="units" />
            <KPIPill label="Latest production" value={latest?.production_qty?.toLocaleString()} sub="units" />
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData} margin={{ top: 4, right: 40, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => v + "%"} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v, name) => name === "Washing Rate %" ? v + "%" : v.toLocaleString()} />
              <Legend />
              <Bar yAxisId="left" dataKey="washing_qty" name="Washing Qty" fill="#6366f1" radius={[3, 3, 0, 0]} />
              <Bar yAxisId="left" dataKey="production_qty" name="Production" fill="#d1d5db" radius={[3, 3, 0, 0]} />
              <Line yAxisId="right" type="monotone" dataKey="washingRate" name="Washing Rate %" stroke="#10b981" strokeWidth={2} dot={false} />
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
    </Section>
  );
};

// ── Page root ─────────────────────────────────────────────────────────────────
export default function Quality() {
  return (
    <div className="px-4 sm:px-6 py-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-50 rounded-lg">
            <Medal size={22} className="text-indigo-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Quality Dashboard</h1>
            <p className="text-sm text-gray-500">
              Repairs, defect rates, complaints and washing — sourced from the Quality tracker sheet
            </p>
          </div>
        </div>
      </div>

      {/* Sections */}
      <OverallRepairs />
      <RepairsByLine />
      <Complaints />
      <Washing />
    </div>
  );
}
