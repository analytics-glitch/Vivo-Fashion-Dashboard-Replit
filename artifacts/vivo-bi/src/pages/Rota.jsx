import React, { useState, useCallback, useRef, useMemo } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Loading, ErrorBox } from "@/components/common";
import {
  CalendarBlank,
  ChartBar,
  Users,
  Warning,
  Check,
  X,
  CaretLeft,
  CaretRight,
  Lock,
  LockOpen,
  Copy,
  Plus,
  Download,
  ArrowsClockwise,
  UserPlus,
  Sliders,
  MapPin,
  Buildings,
} from "@phosphor-icons/react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Legend,
} from "recharts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isoMonday(d) {
  const dt = d ? new Date(d) : new Date();
  const day = dt.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const mon = new Date(dt);
  mon.setDate(dt.getDate() + diff);
  return mon.toISOString().slice(0, 10);
}

function addDays(isoDate, n) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtWeek(isoDate) {
  if (!isoDate) return "";
  const d = new Date(isoDate);
  const end = new Date(isoDate);
  end.setDate(d.getDate() + 6);
  const opts = { day: "numeric", month: "short" };
  return `${d.toLocaleDateString("en-GB", opts)} – ${end.toLocaleDateString("en-GB", opts)}`;
}

function fmtDate(isoDate) {
  if (!isoDate) return "";
  return new Date(isoDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function csvDownload(filename, columns, rows) {
  const header = columns.join(",");
  const body = rows.map(r => Object.values(r).map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([header + "\n" + body], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Staff colour — deterministic palette colour keyed on staff name
// ---------------------------------------------------------------------------
const _STAFF_PALETTE = [
  "#1a5c38", "#2563eb", "#7c3aed", "#dc2626", "#d97706",
  "#0891b2", "#be185d", "#16a34a", "#9333ea", "#0369a1",
  "#b45309", "#0f766e", "#1d4ed8", "#92400e", "#6d28d9",
  "#047857", "#b91c1c", "#0e7490", "#c2410c", "#4338ca",
];
function staffColor(name = "") {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(31, h) + name.charCodeAt(i)) | 0;
  return _STAFF_PALETTE[Math.abs(h) % _STAFF_PALETTE.length];
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------
function KpiCard({ label, value, sub }) {
  return (
    <div className="bg-white rounded-lg border border-gray-100 p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">{label}</span>
      <span className="text-2xl font-semibold text-gray-900">{value ?? "—"}</span>
      {sub && <span className="text-xs text-gray-400">{sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab strip
// ---------------------------------------------------------------------------
const TABS = [
  { id: "overview", label: "Overview", icon: ChartBar },
  { id: "rota", label: "Weekly Rota", icon: CalendarBlank },
  { id: "leave", label: "Leave", icon: Users },
  { id: "coverage", label: "Coverage", icon: Warning },
  { id: "reports", label: "Reports", icon: Download },
];

function TabStrip({ active, onChange }) {
  return (
    <div className="flex gap-1 border-b border-gray-200 mb-6">
      {TABS.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            active === t.id
              ? "border-[#1a5c38] text-[#1a5c38]"
              : "border-transparent text-gray-500 hover:text-gray-800"
          }`}
        >
          <t.icon size={15} />
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------
function OverviewTab() {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    setLoading(true);
    api.get("/rota/overview", { forceFresh: true })
      .then(r => { setData(r.data); setLoading(false); })
      .catch(e => { setError(e.message || "Failed to load"); setLoading(false); });
  }, []);

  if (loading) return <div className="py-10"><Loading label="Loading overview…" /></div>;
  if (error) return <ErrorBox message={error} />;
  if (!data) return null;

  const { kpis, per_day_chart, dept_hours, leave_trend, ot_trend } = data;

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard label="Total Staff" value={kpis.total_staff} />
        <KpiCard label="Scheduled Today" value={kpis.scheduled_today} />
        <KpiCard label="On Leave" value={kpis.on_leave} />
        <KpiCard label="Open Shifts Today" value={kpis.open_shifts} />
        <KpiCard label="Weekly Hours Scheduled" value={`${kpis.weekly_hours?.toFixed(0)} h`} />
        <KpiCard label="Coverage" value={`${kpis.coverage_pct}%`} />
        <KpiCard label="Staff Exceeding 45h" value={kpis.overtime_staff} sub="over 45h/week limit" />
        <KpiCard label="Excess Hours" value={`${kpis.overtime_hours?.toFixed(1)} h`} sub="hours over 45h/week" />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg border border-gray-100 p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Staff Scheduled per Day — Current Week</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={per_day_chart} barSize={32}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="count" name="Staff" fill="#1a5c38" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-lg border border-gray-100 p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Hours by Department — Current Week</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dept_hours} layout="vertical" barSize={16}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis type="number" tick={{ fontSize: 12 }} />
              <YAxis dataKey="department" type="category" tick={{ fontSize: 11 }} width={100} />
              <Tooltip />
              <Bar dataKey="hours" name="Hours" fill="#2563eb" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Trend charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg border border-gray-100 p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Approved Leave — 8-Week Trend</h3>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={leave_trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="week" tickFormatter={v => v?.slice(5)} tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Line type="monotone" dataKey="count" name="Leave" stroke="#f59e0b" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-white rounded-lg border border-gray-100 p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Staff Exceeding 45h/week — 8-Week Trend</h3>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={ot_trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="week" tickFormatter={v => v?.slice(5)} tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Line type="monotone" dataKey="count" name="Staff" stroke="#ef4444" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weekly rota tab
// ---------------------------------------------------------------------------
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function ShiftPicker({ shifts, onSelect, onClose }) {
  return (
    <div className="absolute z-50 bg-white rounded-lg border border-gray-200 shadow-lg p-2 w-44 top-full left-0 mt-1">
      <button
        onClick={() => { onSelect(null); onClose(); }}
        className="w-full text-left px-2 py-1.5 text-sm text-gray-500 hover:bg-gray-50 rounded"
      >
        — Clear
      </button>
      {shifts.map(s => (
        <button
          key={s.id}
          onClick={() => { onSelect(s); onClose(); }}
          className="w-full text-left px-2 py-1.5 text-sm hover:bg-gray-50 rounded flex items-center gap-2"
        >
          <span className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: s.colour }} />
          <span>{s.name}</span>
          {s.start_time && <span className="text-gray-400 text-xs ml-auto">{s.start_time}</span>}
        </button>
      ))}
    </div>
  );
}

function RotaCell({ day, isPublished, shift, warnings, shifts, onSave, color }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef(null);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleClick = () => {
    if (isPublished && !confirming) { setConfirming(true); return; }
    setConfirming(false);
    setOpen(true);
  };

  const handleSelect = (s) => {
    onSave(day.date, s ? s.id : null, isPublished);
  };

  return (
    <td className="border border-gray-100 p-1 relative min-w-[88px]" ref={ref}>
      {confirming && (
        <div className="absolute z-50 bg-white rounded-lg border border-amber-300 shadow-lg p-2 w-52 top-full left-0 mt-1 text-xs text-amber-800">
          Week is published. Edit anyway?
          <div className="flex gap-2 mt-2">
            <button onClick={() => { setConfirming(false); setOpen(true); }} className="flex-1 bg-amber-500 text-white rounded px-2 py-1">Edit</button>
            <button onClick={() => setConfirming(false)} className="flex-1 bg-gray-100 rounded px-2 py-1">Cancel</button>
          </div>
        </div>
      )}
      {open && (
        <ShiftPicker shifts={shifts} onSelect={handleSelect} onClose={() => setOpen(false)} />
      )}
      <button
        onClick={handleClick}
        className="w-full text-left"
        title={warnings?.length > 0 ? warnings.join("\n") : undefined}
      >
        {day.shift_name ? (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-white w-full"
            style={{ background: color || "#6b7280" }}
          >
            {warnings?.length > 0 && (
              <Warning size={11} className="flex-shrink-0" title={warnings.join("\n")} />
            )}
            <span className="truncate">{day.shift_name}</span>
          </span>
        ) : (
          <span className="text-gray-300 text-xs px-1">—</span>
        )}
      </button>
    </td>
  );
}

function WeeklyRotaTab() {
  const [weekStart, setWeekStart] = useState(isoMonday(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [warnings, setWarnings] = useState({}); // key: "staffId-date" -> [strings]
  const [saving, setSaving] = useState(false);
  const [addStaffOpen, setAddStaffOpen] = useState(false);
  const [newStaff, setNewStaff] = useState({ name: "", department: "", role: "", store: "" });
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [deptFilter, setDeptFilter] = useState("All");
  const [storeViewOpen, setStoreViewOpen] = useState(false);

  // Hooks must be called unconditionally — before any early returns.
  // Guard for null data inside the memo bodies.
  const storesByDay = useMemo(() => {
    if (!data) return {};
    const rows = data.rows || [];
    const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const result = {};
    dates.forEach(date => {
      const byStore = {};
      rows.forEach(staff => {
        const store = staff.store;
        if (!store) return;
        const day = (staff.days || []).find(d => d.date === date);
        if (day?.shift_hours > 0) {
          if (!byStore[store]) byStore[store] = [];
          byStore[store].push({ name: staff.name, shift: day.shift_name, color: staffColor(staff.name) });
        }
      });
      result[date] = byStore;
    });
    return result;
  }, [data, weekStart]);

  const allStores = useMemo(() => {
    if (!data) return [];
    const rows = data.rows || [];
    const s = new Set(rows.map(r => r.store).filter(Boolean));
    return [...s].sort();
  }, [data]);

  const load = useCallback((ws) => {
    setLoading(true);
    setError(null);
    api.get("/rota/week", { params: { week_start: ws }, forceFresh: true })
      .then(r => { setData(r.data); setLoading(false); })
      .catch(e => { setError(e.message || "Failed to load"); setLoading(false); });
  }, []);

  React.useEffect(() => { load(weekStart); }, [weekStart, load]);

  const prevWeek = () => setWeekStart(addDays(weekStart, -7));
  const nextWeek = () => setWeekStart(addDays(weekStart, 7));

  const handleSave = async (staffId, date, shiftId, isPublished) => {
    setSaving(true);
    try {
      const resp = await api.put("/rota/entry", {
        staff_id: staffId,
        entry_date: date,
        shift_id: shiftId,
        override_published: isPublished,
      });
      const w = resp?.data?.warnings || [];
      setWarnings(prev => ({
        ...prev,
        [`${staffId}-${date}`]: w,
      }));
      load(weekStart);
    } catch (e) {
      // surface error inline
    } finally {
      setSaving(false);
    }
  };

  const handleCopyWeek = async () => {
    const prevWs = addDays(weekStart, -7);
    try {
      await api.post("/rota/copy-week", { from_week_start: prevWs, to_week_start: weekStart });
      load(weekStart);
    } catch (e) {}
  };

  const handlePublish = async (publish) => {
    try {
      await api.put("/rota/publish", { week_start: weekStart, publish });
      load(weekStart);
    } catch (e) {}
  };

  const handleAddStaff = async () => {
    if (!newStaff.name.trim()) return;
    try {
      await api.post("/rota/staff", newStaff);
      setAddStaffOpen(false);
      setNewStaff({ name: "", department: "", role: "", store: "" });
      load(weekStart);
    } catch (e) {}
  };

  const handleImportStaff = async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const resp = await api.post("/rota/import-staff", {});
      const { inserted, skipped, total_source } = resp?.data || {};
      setImportResult({ inserted: inserted ?? 0, skipped: skipped ?? 0, total_source: total_source ?? 0 });
      if (inserted > 0) load(weekStart);
    } catch (e) {
      const msg = e?.response?.data?.detail || e.message || "Import failed";
      setImportResult({ error: msg });
    } finally {
      setImporting(false);
    }
  };

  if (loading) return <div className="py-10"><Loading label="Loading rota…" /></div>;
  if (error) return <ErrorBox message={error} />;
  if (!data) return null;

  const { rows, shifts, is_published, departments: allDepts = [], max_weekly_hours = 45, max_weekly_days = 5 } = data;
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // Department filter
  const filteredRows = deptFilter === "All" ? rows : rows.filter(r => (r.department || "Unassigned") === deptFilter);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 border border-gray-200 rounded-lg overflow-hidden bg-white">
          <button onClick={prevWeek} className="px-2 py-1.5 hover:bg-gray-50 transition-colors"><CaretLeft size={16} /></button>
          <span className="px-3 text-sm font-medium text-gray-700">{fmtWeek(weekStart)}</span>
          <button onClick={nextWeek} className="px-2 py-1.5 hover:bg-gray-50 transition-colors"><CaretRight size={16} /></button>
        </div>

        {is_published ? (
          <span className="flex items-center gap-1 text-xs bg-green-50 text-green-700 border border-green-200 rounded px-2 py-1">
            <Lock size={12} /> Published
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded px-2 py-1">
            <LockOpen size={12} /> Draft
          </span>
        )}

        {/* Department filter */}
        <select
          value={deptFilter}
          onChange={e => setDeptFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[#1a5c38]"
        >
          <option value="All">All departments</option>
          {allDepts.map(d => <option key={d} value={d}>{d}</option>)}
        </select>

        <button
          onClick={handleCopyWeek}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-gray-200 rounded-lg bg-white hover:bg-gray-50 transition-colors"
        >
          <Copy size={14} /> Copy previous week
        </button>

        {is_published ? (
          <button
            onClick={() => handlePublish(false)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-amber-300 text-amber-700 rounded-lg bg-amber-50 hover:bg-amber-100 transition-colors"
          >
            <LockOpen size={14} /> Unpublish
          </button>
        ) : (
          <button
            onClick={() => handlePublish(true)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-[#1a5c38] text-white rounded-lg hover:bg-[#154a2d] transition-colors"
          >
            <Lock size={14} /> Publish week
          </button>
        )}

        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={() => setStoreViewOpen(o => !o)}
            className={`flex items-center gap-1.5 text-sm px-3 py-1.5 border rounded-lg transition-colors ${storeViewOpen ? "bg-[#1a5c38] text-white border-[#1a5c38]" : "border-gray-200 bg-white hover:bg-gray-50"}`}
          >
            <Buildings size={14} /> Store view
          </button>
          <button
            onClick={handleImportStaff}
            disabled={importing}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-[#1a5c38] text-[#1a5c38] rounded-lg bg-white hover:bg-green-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ArrowsClockwise size={14} className={importing ? "animate-spin" : ""} />
            {importing ? "Importing…" : "Import from HR roster"}
          </button>
          <button
            onClick={() => setAddStaffOpen(true)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-gray-200 rounded-lg bg-white hover:bg-gray-50 transition-colors"
          >
            <UserPlus size={14} /> Add staff
          </button>
        </div>
      </div>

      {/* Import result banner */}
      {importResult && (
        <div className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm ${importResult.error ? "bg-red-50 border-red-200 text-red-700" : importResult.inserted === 0 ? "bg-gray-50 border-gray-200 text-gray-600" : "bg-green-50 border-green-200 text-green-700"}`}>
          <span>
            {importResult.error
              ? importResult.error
              : importResult.inserted === 0
                ? `All ${importResult.skipped} staff already in the rota — nothing new to import.`
                : `Imported ${importResult.inserted} staff member${importResult.inserted !== 1 ? "s" : ""} from the HR roster${importResult.skipped > 0 ? ` (${importResult.skipped} already present, skipped)` : ""}.`}
          </span>
          <button onClick={() => setImportResult(null)} className="flex-shrink-0 opacity-60 hover:opacity-100 transition-opacity"><X size={14} /></button>
        </div>
      )}

      {/* Add staff modal */}
      {addStaffOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-4">Add Staff Member</h3>
            <div className="space-y-3">
              {[
                ["Name", "name", "text", true],
                ["Department", "department", "text", false],
                ["Role / Position", "role", "text", false],
                ["Store", "store", "text", false],
              ].map(([label, key, type, required]) => (
                <div key={key}>
                  <label className="block text-xs font-medium text-gray-600 mb-1">{label}{required && " *"}</label>
                  <input
                    type={type}
                    value={newStaff[key]}
                    onChange={e => setNewStaff(p => ({ ...p, [key]: e.target.value }))}
                    className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#1a5c38]"
                  />
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={handleAddStaff} className="flex-1 bg-[#1a5c38] text-white text-sm rounded-lg py-2 hover:bg-[#154a2d] transition-colors">Add</button>
              <button onClick={() => setAddStaffOpen(false)} className="flex-1 border border-gray-200 text-sm rounded-lg py-2 hover:bg-gray-50 transition-colors">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Shift reference */}
      <div className="flex flex-wrap gap-3">
        {shifts.filter(s => s.hours > 0 && !s.is_leave).map(s => (
          <span key={s.id} className="flex items-center gap-1.5 text-xs text-gray-600 bg-white border border-gray-100 rounded px-2 py-1">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: s.colour }} />
            <strong>{s.name}</strong>
            {s.start_time && s.end_time && <span className="text-gray-400">{s.start_time}–{s.end_time}</span>}
            <span className="text-gray-400">({s.hours}h)</span>
          </span>
        ))}
        <span className="text-xs text-gray-400 self-center">Max: {max_weekly_hours}h / {max_weekly_days} days per week</span>
      </div>

      {/* Staff colour legend */}
      <div className="flex flex-wrap gap-2">
        {filteredRows.map(s => (
          <span key={s.staff_id} className="flex items-center gap-1.5 text-xs text-gray-600">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: staffColor(s.name) }} />
            {s.name}
          </span>
        ))}
      </div>

      {/* Grid */}
      {rows.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-100 p-8 text-center text-gray-400 text-sm">
          No staff members added yet. Use "Add staff" to get started.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm bg-white">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="sticky left-0 bg-gray-50 z-10 text-left px-3 py-2 font-semibold text-gray-700 min-w-[160px] border-r border-gray-200">
                  Staff
                </th>
                <th className="px-2 py-2 text-left font-medium text-gray-600 min-w-[100px] border-r border-gray-100">
                  <MapPin size={13} className="inline mr-1" />Store
                </th>
                {dates.map((d, i) => (
                  <th key={d} className="px-1 py-2 text-center font-medium text-gray-600 min-w-[88px]">
                    <div>{DAYS[i]}</div>
                    <div className="text-xs text-gray-400 font-normal">{d.slice(5).replace("-", "/")}</div>
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium text-gray-600 min-w-[64px]">Hrs / Days</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(staff => {
                const totalHrs = staff.days.reduce((sum, d) => sum + (d.shift_hours || 0), 0);
                const workingDays = staff.days.filter(d => d.shift_hours > 0).length;
                const overHours = totalHrs > max_weekly_hours;
                const overDays = workingDays > max_weekly_days;
                const color = staffColor(staff.name);
                return (
                  <tr key={staff.staff_id} className="border-b border-gray-100 hover:bg-gray-50/50 transition-colors">
                    <td className="sticky left-0 bg-white z-10 px-3 py-2 border-r border-gray-100">
                      <div className="flex items-center gap-1.5">
                        <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                        <span className="font-medium text-gray-800 leading-tight">{staff.name}</span>
                      </div>
                      {staff.department && <div className="text-xs text-gray-400 ml-3.5">{staff.department}</div>}
                      {staff.carryover_hours > 0 && (
                        <div className="ml-3.5 mt-0.5">
                          <span className="inline-block text-xs bg-orange-100 text-orange-700 border border-orange-200 rounded px-1 py-0.5">
                            carry-in: −{staff.carryover_hours.toFixed(1)}h
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-xs text-gray-500 border-r border-gray-100">
                      {staff.store || <span className="text-gray-300">—</span>}
                    </td>
                    {staff.days.map(day => {
                      const wKey = `${staff.staff_id}-${day.date}`;
                      const dayWarnings = warnings[wKey] || [];
                      return (
                        <RotaCell
                          key={day.date}
                          day={day}
                          isPublished={is_published}
                          shift={day}
                          warnings={dayWarnings}
                          shifts={shifts}
                          onSave={(date, shiftId, pub) => handleSave(staff.staff_id, date, shiftId, pub)}
                          color={color}
                        />
                      );
                    })}
                    <td className={`px-3 py-2 text-right text-xs font-medium ${overHours || overDays ? "text-red-600" : "text-gray-700"}`}>
                      <div className={overHours ? "text-red-600" : ""}>
                        {totalHrs > 0 ? `${totalHrs.toFixed(1)}h` : "—"}
                        {overHours && <Warning size={11} className="inline ml-1 text-red-500" />}
                      </div>
                      <div className={`text-xs ${overDays ? "text-red-600" : "text-gray-400"}`}>
                        {workingDays > 0 ? `${workingDays}d` : ""}
                        {overDays && <Warning size={11} className="inline ml-0.5 text-red-500" />}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Store View panel */}
      {storeViewOpen && allStores.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="bg-gray-50 border-b border-gray-200 px-4 py-2.5 flex items-center gap-2">
            <Buildings size={15} className="text-[#1a5c38]" />
            <h3 className="text-sm font-semibold text-gray-700">Staff by Store — {fmtWeek(weekStart)}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="px-4 py-2 text-left font-medium text-gray-600 min-w-[120px]">Store</th>
                  {dates.map((d, i) => (
                    <th key={d} className="px-2 py-2 text-center font-medium text-gray-500 text-xs min-w-[110px]">
                      <div>{DAYS[i]}</div>
                      <div className="text-gray-400 font-normal">{d.slice(5).replace("-", "/")}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allStores.map(store => (
                  <tr key={store} className="border-b border-gray-100">
                    <td className="px-4 py-2 font-medium text-gray-800 whitespace-nowrap">
                      <MapPin size={12} className="inline mr-1 text-gray-400" />{store}
                    </td>
                    {dates.map(date => {
                      const staffHere = storesByDay[date]?.[store] || [];
                      return (
                        <td key={date} className="px-2 py-2 align-top">
                          {staffHere.length === 0 ? (
                            <span className="text-gray-200 text-xs">—</span>
                          ) : (
                            <div className="flex flex-col gap-0.5">
                              {staffHere.map((s, idx) => (
                                <span key={idx} className="inline-flex items-center gap-1 text-xs text-white rounded px-1.5 py-0.5 whitespace-nowrap" style={{ background: s.color }}>
                                  {s.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {storeViewOpen && allStores.length === 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 text-center text-gray-400 text-sm">
          No store assignments found. Assign stores to staff members to see this view.
        </div>
      )}

      {saving && <div className="text-xs text-gray-400 text-right">Saving…</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leave management tab
// ---------------------------------------------------------------------------
const LEAVE_STATUSES = ["All", "Pending", "Approved", "Declined"];
const LEAVE_TYPES = ["Annual Leave", "Sick Leave", "Training", "Other"];

function LeaveTab() {
  const [status, setStatus] = useState("All");
  const [staffSearch, setStaffSearch] = useState("");
  const [leaves, setLeaves] = useState(null);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ staff_id: "", start_date: "", end_date: "", type: "Annual Leave", reason: "" });
  const [actioning, setActioning] = useState(null);

  const load = useCallback((s) => {
    setLoading(true);
    Promise.all([
      api.get("/rota/leave", { params: { status: s }, forceFresh: true }),
      api.get("/rota/staff", { forceFresh: true }),
    ])
      .then(([lr, sr]) => { setLeaves(lr.data); setStaff(sr.data || []); setLoading(false); })
      .catch(e => { setError(e.message || "Failed to load"); setLoading(false); });
  }, []);

  React.useEffect(() => { load(status); }, [status, load]);

  const filteredLeaves = React.useMemo(() => {
    if (!leaves) return [];
    if (!staffSearch.trim()) return leaves;
    const q = staffSearch.trim().toLowerCase();
    return leaves.filter(l => (l.staff_name || "").toLowerCase().includes(q));
  }, [leaves, staffSearch]);

  const handleAction = async (id, newStatus) => {
    setActioning(id);
    try {
      await api.put(`/rota/leave/${id}`, { status: newStatus });
      load(status);
    } catch (e) {} finally { setActioning(null); }
  };

  const handleRequest = async () => {
    if (!form.staff_id || !form.start_date || !form.end_date) return;
    try {
      await api.post("/rota/leave", { ...form, staff_id: parseInt(form.staff_id) });
      setModalOpen(false);
      setForm({ staff_id: "", start_date: "", end_date: "", type: "Annual Leave", reason: "" });
      load(status);
    } catch (e) {}
  };

  const STATUS_COLOR = { Pending: "text-amber-700 bg-amber-50 border-amber-200", Approved: "text-green-700 bg-green-50 border-green-200", Declined: "text-red-700 bg-red-50 border-red-200" };

  if (loading) return <div className="py-10"><Loading label="Loading leave…" /></div>;
  if (error) return <ErrorBox message={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {LEAVE_STATUSES.map(s => (
            <button key={s} onClick={() => setStatus(s)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${status === s ? "bg-[#1a5c38] text-white" : "border border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
              {s}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Filter by name…"
          value={staffSearch}
          onChange={e => setStaffSearch(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-44 focus:outline-none focus:ring-1 focus:ring-[#1a5c38]"
        />
        <button onClick={() => setModalOpen(true)}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-[#1a5c38] text-white rounded-lg hover:bg-[#154a2d] transition-colors ml-auto">
          <Plus size={14} /> Request Leave
        </button>
      </div>

      {/* Request modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-4">Request Leave</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Staff Member *</label>
                <select value={form.staff_id} onChange={e => setForm(p => ({ ...p, staff_id: e.target.value }))}
                  className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#1a5c38]">
                  <option value="">Select…</option>
                  {staff.map(s => <option key={s.id} value={s.id}>{s.name} ({s.department || "—"})</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Start Date *</label>
                  <input type="date" value={form.start_date} onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))}
                    className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#1a5c38]" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">End Date *</label>
                  <input type="date" value={form.end_date} onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))}
                    className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#1a5c38]" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
                <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}
                  className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#1a5c38]">
                  {LEAVE_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
                <textarea value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
                  rows={2} className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#1a5c38] resize-none" />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={handleRequest} className="flex-1 bg-[#1a5c38] text-white text-sm rounded-lg py-2 hover:bg-[#154a2d]">Submit</button>
              <button onClick={() => setModalOpen(false)} className="flex-1 border border-gray-200 text-sm rounded-lg py-2 hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      {!leaves || filteredLeaves.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-100 p-8 text-center text-gray-400 text-sm">
          {staffSearch.trim() ? `No results for "${staffSearch}".` : "No leave requests found."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm bg-white">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-left">
                <th className="px-4 py-2.5 font-semibold text-gray-700">Staff</th>
                <th className="px-4 py-2.5 font-semibold text-gray-700">Department</th>
                <th className="px-4 py-2.5 font-semibold text-gray-700">Type</th>
                <th className="px-4 py-2.5 font-semibold text-gray-700">Dates</th>
                <th className="px-4 py-2.5 font-semibold text-gray-700">Status</th>
                <th className="px-4 py-2.5 font-semibold text-gray-700">Reason</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {filteredLeaves.map(l => (
                <tr key={l.id} className="border-b border-gray-100 hover:bg-gray-50/50">
                  <td className="px-4 py-2.5 font-medium text-gray-800">{l.staff_name}</td>
                  <td className="px-4 py-2.5 text-gray-500">{l.department || "—"}</td>
                  <td className="px-4 py-2.5 text-gray-700">{l.type}</td>
                  <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">
                    {fmtDate(l.start_date)} – {fmtDate(l.end_date)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded border ${STATUS_COLOR[l.status] || ""}`}>
                      {l.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500 max-w-[200px] truncate">{l.reason || "—"}</td>
                  <td className="px-4 py-2.5">
                    {l.status === "Pending" && (
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleAction(l.id, "Approved")}
                          disabled={actioning === l.id}
                          className="p-1 rounded hover:bg-green-50 text-green-600 disabled:opacity-50 transition-colors"
                          title="Approve"
                        >
                          <Check size={16} />
                        </button>
                        <button
                          onClick={() => handleAction(l.id, "Declined")}
                          disabled={actioning === l.id}
                          className="p-1 rounded hover:bg-red-50 text-red-500 disabled:opacity-50 transition-colors"
                          title="Decline"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Coverage tab — per-day headcount
// ---------------------------------------------------------------------------
const STATUS_DOT = { green: "bg-green-500", amber: "bg-amber-400", red: "bg-red-500" };
const STATUS_TEXT = { green: "text-green-700", amber: "text-amber-700", red: "text-red-600" };
const STATUS_BG   = { green: "bg-green-50",  amber: "bg-amber-50",  red: "bg-red-50"  };

function CoverageTab() {
  const [weekStart, setWeekStart] = useState(isoMonday(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [thresholdOpen, setThresholdOpen] = useState(false);
  const [threshold, setThreshold] = useState({ min: 2, ideal: 4 });
  const [thresholdSaving, setThresholdSaving] = useState(false);
  const [thresholdSaved, setThresholdSaved] = useState(false);
  const [expandedDay, setExpandedDay] = useState(null);

  const load = useCallback((ws) => {
    setLoading(true);
    Promise.all([
      api.get("/rota/coverage", { params: { week_start: ws }, forceFresh: true }),
      api.get("/rota/coverage/thresholds"),
    ])
      .then(([cr, tr]) => {
        setData(cr.data);
        if (tr.data && typeof tr.data === "object") setThreshold(tr.data);
        setLoading(false);
      })
      .catch(e => { setError(e.message || "Failed to load"); setLoading(false); });
  }, []);

  React.useEffect(() => { load(weekStart); }, [weekStart, load]);

  const saveThresholds = async () => {
    setThresholdSaving(true);
    try {
      await api.put("/rota/coverage/thresholds", threshold);
      setThresholdSaved(true);
      setTimeout(() => setThresholdSaved(false), 2000);
      load(weekStart);
    } catch (e) {}
    setThresholdSaving(false);
  };

  if (loading) return <div className="py-10"><Loading label="Loading coverage…" /></div>;
  if (error) return <ErrorBox message={error} />;
  if (!data) return null;

  const { days, departments } = data;

  return (
    <div className="space-y-6">
      {/* Week picker + threshold toggle */}
      <div className="flex items-center flex-wrap gap-3">
        <div className="flex items-center gap-1 border border-gray-200 rounded-lg overflow-hidden bg-white">
          <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="px-2 py-1.5 hover:bg-gray-50"><CaretLeft size={16} /></button>
          <span className="px-3 text-sm font-medium text-gray-700">{fmtWeek(weekStart)}</span>
          <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="px-2 py-1.5 hover:bg-gray-50"><CaretRight size={16} /></button>
        </div>
        <button
          onClick={() => setThresholdOpen(o => !o)}
          className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border transition-colors ${thresholdOpen ? "bg-[#1a5c38] text-white border-[#1a5c38]" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}
        >
          <Sliders size={14} /> Staffing Thresholds
        </button>
      </div>

      {/* Threshold admin panel */}
      {thresholdOpen && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">Daily Staffing Thresholds — Min / Ideal headcount per day</h3>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-600 w-16">Min / day</label>
              <input
                type="number" min={0} max={20}
                value={threshold.min ?? 2}
                onChange={e => setThreshold(p => ({ ...p, min: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                className="w-16 border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[#1a5c38]"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-gray-600 w-16">Ideal / day</label>
              <input
                type="number" min={0} max={20}
                value={threshold.ideal ?? 4}
                onChange={e => setThreshold(p => ({ ...p, ideal: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                className="w-16 border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[#1a5c38]"
              />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={saveThresholds}
              disabled={thresholdSaving}
              className="px-4 py-1.5 text-sm bg-[#1a5c38] text-white rounded-lg hover:bg-[#154a2d] disabled:opacity-60 transition-colors"
            >
              {thresholdSaving ? "Saving…" : "Save Thresholds"}
            </button>
            {thresholdSaved && <span className="text-xs text-green-600">Saved.</span>}
          </div>
        </div>
      )}

      {/* Per-day coverage grid */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-2.5 text-left font-semibold text-gray-700 w-32">Day</th>
              <th className="px-4 py-2.5 text-center font-semibold text-gray-700 w-24">Staff</th>
              <th className="px-4 py-2.5 text-center font-semibold text-gray-700 w-24">Status</th>
              <th className="px-4 py-2.5 text-left font-semibold text-gray-700">Scheduled</th>
            </tr>
          </thead>
          <tbody>
            {days.map(d => {
              const expanded = expandedDay === d.date;
              return (
                <React.Fragment key={d.date}>
                  <tr
                    className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50/50 ${STATUS_BG[d.status] ? "" : ""}`}
                    onClick={() => setExpandedDay(expanded ? null : d.date)}
                  >
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {d.label}
                      <span className="text-xs text-gray-400 ml-1.5">{d.date.slice(5).replace("-", "/")}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-sm font-semibold ${STATUS_TEXT[d.status]}`}>{d.count}</span>
                      <span className="text-xs text-gray-400"> / {d.ideal}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${
                        d.status === "green" ? "bg-green-50 text-green-700 border-green-200" :
                        d.status === "amber" ? "bg-amber-50 text-amber-700 border-amber-200" :
                        "bg-red-50 text-red-600 border-red-200"
                      }`}>
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${STATUS_DOT[d.status]}`} />
                        {d.status === "green" ? "Fully staffed" : d.status === "amber" ? "Slightly under" : "Critical"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {d.staff?.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {d.staff.slice(0, expanded ? undefined : 4).map((s, i) => (
                            <span key={i} className="inline-block text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">
                              {s.name}
                            </span>
                          ))}
                          {!expanded && d.staff.length > 4 && (
                            <span className="text-xs text-gray-400 self-center">+{d.staff.length - 4} more</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-300 text-xs">No staff scheduled</span>
                      )}
                    </td>
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex gap-4 text-xs text-gray-600">
        <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" /> Fully staffed (≥ ideal)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-400" /> Slightly under (≥ min)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500" /> Critical (below min)</span>
        <span className="text-gray-400">Click a row to expand staff list.</span>
      </div>

      {/* Department table */}
      {departments?.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Department Coverage — Current Week</h3>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left">
                  <th className="px-4 py-2.5 font-semibold text-gray-700">Department</th>
                  <th className="px-4 py-2.5 font-semibold text-gray-700 text-right">Total Staff</th>
                  <th className="px-4 py-2.5 font-semibold text-gray-700 text-right">Shifts Scheduled</th>
                  <th className="px-4 py-2.5 font-semibold text-gray-700 text-right">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {departments.map(d => {
                  const pct = d.total_staff > 0 ? Math.round(d.staff_scheduled / (d.total_staff * 7) * 100) : 0;
                  const status = pct >= 80 ? "green" : pct >= 50 ? "amber" : "red";
                  return (
                    <tr key={d.department} className="border-b border-gray-100 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 font-medium text-gray-800">{d.department}</td>
                      <td className="px-4 py-2.5 text-right text-gray-600">{d.total_staff}</td>
                      <td className="px-4 py-2.5 text-right text-gray-600">{d.staff_scheduled}</td>
                      <td className="px-4 py-2.5 text-right">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium ${STATUS_TEXT[status]}`}>
                          <span className={`inline-block w-2 h-2 rounded-full ${STATUS_DOT[status]}`} />
                          {pct}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reports tab
// ---------------------------------------------------------------------------
const REPORT_TYPES = [
  { id: "weekly_hours", label: "Weekly Hours" },
  { id: "monthly_hours", label: "Monthly Hours" },
  { id: "leave", label: "Leave Summary" },
  { id: "overtime", label: "Overtime Alerts" },
];

function ReportsTab() {
  const [reportType, setReportType] = useState("weekly_hours");
  const [weekStart, setWeekStart] = useState(isoMonday(new Date()));
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = { type: reportType };
    if (reportType === "weekly_hours" || reportType === "overtime") params.week_start = weekStart;
    if (reportType === "monthly_hours") params.month = month;
    api.get("/rota/report", { params, forceFresh: true })
      .then(r => { setData(r.data); setLoading(false); })
      .catch(e => { setError(e.message || "Failed to load"); setLoading(false); });
  }, [reportType, weekStart, month]);

  React.useEffect(() => { load(); }, [load]);

  const handleExport = () => {
    if (!data) return;
    csvDownload(`rota-${reportType}.csv`, data.columns, data.rows);
  };

  return (
    <div className="space-y-4">
      {/* Sub-report selector */}
      <div className="flex gap-1 border-b border-gray-200 pb-0">
        {REPORT_TYPES.map(r => (
          <button key={r.id} onClick={() => setReportType(r.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${reportType === r.id ? "border-[#1a5c38] text-[#1a5c38]" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
            {r.label}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        {(reportType === "weekly_hours" || reportType === "overtime") && (
          <div className="flex items-center gap-1 border border-gray-200 rounded-lg overflow-hidden bg-white">
            <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="px-2 py-1.5 hover:bg-gray-50"><CaretLeft size={16} /></button>
            <span className="px-3 text-sm font-medium text-gray-700">{fmtWeek(weekStart)}</span>
            <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="px-2 py-1.5 hover:bg-gray-50"><CaretRight size={16} /></button>
          </div>
        )}
        {reportType === "monthly_hours" && (
          <input type="month" value={month} onChange={e => setMonth(e.target.value)}
            className="border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#1a5c38]" />
        )}
        {data && (
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 border border-gray-200 rounded-lg bg-white hover:bg-gray-50 transition-colors ml-auto"
          >
            <Download size={14} /> Export CSV
          </button>
        )}
      </div>

      {loading && <div className="py-10"><Loading label="Loading report…" /></div>}
      {error && <ErrorBox message={error} />}

      {!loading && data && (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full text-sm bg-white">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-left">
                {data.columns.map(c => (
                  <th key={c} className="px-4 py-2.5 font-semibold text-gray-700">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr><td colSpan={data.columns.length} className="px-4 py-8 text-center text-gray-400">No data for this period.</td></tr>
              ) : (
                data.rows.map((r, i) => (
                  <tr key={i} className="border-b border-gray-100 hover:bg-gray-50/50">
                    {Object.values(r).map((v, j) => (
                      <td key={j} className="px-4 py-2.5 text-gray-700">{v ?? "—"}</td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Rota page
// ---------------------------------------------------------------------------
export default function Rota() {
  const { user } = useAuth();
  const [tab, setTab] = useState("overview");

  if (!user) return null;

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Staff Rota</h1>
        <p className="text-sm text-gray-500 mt-0.5">Schedule, leave management, and coverage tracking</p>
      </div>

      <TabStrip active={tab} onChange={setTab} />

      {tab === "overview"  && <OverviewTab />}
      {tab === "rota"      && <WeeklyRotaTab />}
      {tab === "leave"     && <LeaveTab />}
      {tab === "coverage"  && <CoverageTab />}
      {tab === "reports"   && <ReportsTab />}
    </div>
  );
}
