import React, { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Loading, ErrorBox } from "@/components/common";
import {
  CalendarBlank,
  CheckSquare,
  ChartBar,
  Medal,
  Newspaper,
  ListChecks,
  Lightbulb,
  Flag,
  Gear,
  Plus,
  Trash,
  CaretDown,
  CaretUp,
  PencilSimple,
  Check,
  X,
  ArrowUp,
  ArrowDown,
  Link as LinkIcon,
  DownloadSimple,
  ArrowSquareOut,
  UploadSimple,
  CheckCircle,
  Warning,
  Database,
  CircleNotch,
} from "@phosphor-icons/react";

const TABS = [
  { id: "agenda", label: "Agenda", icon: CalendarBlank },
  { id: "checkin", label: "Check-In", icon: CheckSquare },
  { id: "scorecard", label: "Scorecard", icon: ChartBar },
  { id: "rocks", label: "Rocks", icon: Medal },
  { id: "headlines", label: "Headlines", icon: Newspaper },
  { id: "todos", label: "To-Dos", icon: ListChecks },
  { id: "ids", label: "IDS", icon: Lightbulb },
  { id: "conclude", label: "Conclude", icon: Flag },
  { id: "admin", label: "Admin", icon: Gear },
];

const AGENDA_ITEMS = [
  { section: "Segue / Check-In", duration: 5 },
  { section: "Scorecard Review", duration: 5 },
  { section: "Rock Review", duration: 5 },
  { section: "Customer / Employee Headlines", duration: 5 },
  { section: "To-Do List Review", duration: 5 },
  { section: "IDS (Identify, Discuss, Solve)", duration: 60 },
  { section: "Conclude", duration: 5 },
];

function addMinutes(timeStr, mins) {
  const [h, m] = timeStr.split(":").map(Number);
  const total = h * 60 + (m || 0) + mins;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h < 12 ? "AM" : "PM";
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short", year: "numeric",
    });
  } catch { return iso; }
}

function getQuarterLabel(isoDate) {
  if (!isoDate) return "Unknown";
  try {
    const d = new Date(isoDate + "T00:00:00");
    return `Q${Math.ceil((d.getMonth() + 1) / 3)} ${d.getFullYear()}`;
  } catch { return "Unknown"; }
}

function scorecardTrafficLight(value, goal, direction) {
  if (value === null || value === undefined || value === "") return null;
  const v = parseFloat(value);
  if (isNaN(v)) return null;
  if (!goal && goal !== 0) return null;
  const goalStr = String(goal).trim();
  // Try range goal: min-max (hyphen, en-dash, em-dash, with optional spaces), e.g. "4-6", "4–6", "4 - 6"
  const rangeMatch = goalStr.match(/^(-?\d+(?:\.\d+)?)\s*[-\u2013\u2014]\s*(-?\d+(?:\.\d+)?)(?=\s|$)/);
  if (rangeMatch) {
    const rMin = parseFloat(rangeMatch[1]);
    const rMax = parseFloat(rangeMatch[2]);
    if (!isNaN(rMin) && !isNaN(rMax)) {
      return v >= rMin && v <= rMax ? "green" : "red";
    }
  }
  // Try operator prefix: >=, <=, >, <, =, and Unicode ≥ (U+2265) / ≤ (U+2264)
  const opMatch = goalStr.match(/^(>=|<=|\u2265|\u2264|>|<|=)\s*(-?\d+(?:\.\d+)?)(?=\s|$)/);
  if (opMatch) {
    const op = opMatch[1];
    const g = parseFloat(opMatch[2]);
    if (isNaN(g)) return null;
    // Normalise Unicode ≥/≤ to ASCII equivalents
    const normOp = op === "\u2265" ? ">=" : op === "\u2264" ? "<=" : op;
    let meets = false;
    if (normOp === ">=") meets = v >= g;
    else if (normOp === "<=") meets = v <= g;
    else if (normOp === ">")  meets = v > g;
    else if (normOp === "<")  meets = v < g;
    else if (normOp === "=")  meets = v === g;
    return meets ? "green" : "red";
  }
  // Plain numeric goal — fall back to goal_direction
  const g = parseFloat(goalStr);
  if (isNaN(g)) return null;
  const meets = direction === "down" ? v <= g : v >= g;
  return meets ? "green" : "red";
}

function trafficLightCls(tl, base = "") {
  if (tl === "green") return `${base} bg-emerald-100 text-emerald-800`;
  if (tl === "red") return `${base} bg-red-100 text-red-700`;
  return `${base} bg-muted/40 text-foreground`;
}

function isoWeekLabel() {
  const d = new Date();
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1);
  const diff = d - startOfWeek1;
  const week = Math.floor(diff / 604800000) + 1;
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function nextMondayDate() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun, 1=Mon
  const daysUntilMonday = day === 0 ? 1 : (8 - day) % 7 || 7;
  d.setDate(d.getDate() + daysUntilMonday);
  return d.toISOString().slice(0, 10);
}

const InlineEdit = ({ value, onSave, placeholder = "—", className = "", multiline = false }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const inputRef = useRef(null);

  useEffect(() => { setDraft(value || ""); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== (value || "")) onSave(draft);
  };

  if (!editing) {
    return (
      <span
        className={`cursor-pointer hover:bg-muted/60 rounded px-1 -mx-1 min-w-[60px] inline-block ${className}`}
        onClick={() => setEditing(true)}
        title="Click to edit"
      >
        {value || <span className="text-muted-foreground">{placeholder}</span>}
      </span>
    );
  }

  if (multiline) {
    return (
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Escape") { setDraft(value || ""); setEditing(false); } }}
        className={`w-full border border-primary/40 rounded px-1 py-0.5 text-sm bg-white outline-none ${className}`}
        rows={2}
      />
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setDraft(value || ""); setEditing(false); }
      }}
      className={`border border-primary/40 rounded px-1 py-0.5 text-sm bg-white outline-none ${className}`}
    />
  );
};

const Pill = ({ on, onClick, label, size = "sm" }) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium border transition-colors text-${size}
      ${on
        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
        : "bg-red-50 text-red-600 border-red-200"
      }`}
  >
    {label || (on ? "On Track" : "Off Track")}
  </button>
);

const Accordion = ({ title, children, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-muted/30 hover:bg-muted/50 text-sm font-medium text-left"
      >
        {title}
        {open ? <CaretUp size={14} /> : <CaretDown size={14} />}
      </button>
      {open && <div className="p-4">{children}</div>}
    </div>
  );
};

// ─── Agenda Tab ──────────────────────────────────────────────────────────────
const AgendaTab = ({ meeting, settings }) => {
  const startTime = meeting?.start_time || settings?.default_start_time || "08:00";
  let cursor = startTime;
  const rows = AGENDA_ITEMS.map((item) => {
    const from = cursor;
    const to = addMinutes(cursor, item.duration);
    cursor = to;
    return { ...item, from, to };
  });

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-5">
        <h2 className="text-base font-semibold mb-1">Standard 90-Minute L10 Agenda</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Meeting starts at <strong>{fmtTime(startTime)}</strong>. Same time, same place, every week.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground text-left">
                <th className="py-2 pr-4 font-medium">Section</th>
                <th className="py-2 pr-4 font-medium">Duration</th>
                <th className="py-2 pr-4 font-medium">Start</th>
                <th className="py-2 font-medium">End</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="py-2 pr-4 font-medium">{r.section}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{r.duration} min</td>
                  <td className="py-2 pr-4 font-mono text-xs">{fmtTime(r.from)}</td>
                  <td className="py-2 font-mono text-xs">{fmtTime(r.to)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="rounded-xl border bg-card p-5">
        <h3 className="text-sm font-semibold mb-2">EOS Level 10 Principles</h3>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
          <li>Same time, same place every week — discipline drives results</li>
          <li>Start on time, end on time — respect everyone&apos;s schedule</li>
          <li>Everyone participates — no phones, no multitasking</li>
          <li>Rate the meeting at the end — continuous improvement</li>
          <li>IDS is the engine — solve root problems, not symptoms</li>
        </ul>
      </div>
    </div>
  );
};

// ─── Check-In Tab ────────────────────────────────────────────────────────────
const CheckInTab = ({ meetingId, members, folderId = 1 }) => {
  const [rows, setRows] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!meetingId) return;
    setLoading(true);
    Promise.all([
      api.get(`/l10/checkin/${meetingId}`, { forceFresh: true }),
      api.get(`/l10/checkin/history`, { params: { exclude_meeting_id: meetingId, folder_id: folderId }, forceFresh: true }),
    ]).then(([c, h]) => {
      const existing = {};
      (c.data || []).forEach((r) => { existing[r.member_name] = r; });
      setRows(
        members.filter((m) => m.active).map((m) => ({
          member_name: m.name,
          personal_news: existing[m.name]?.personal_news || "",
          professional_news: existing[m.name]?.professional_news || "",
        }))
      );
      setHistory(h.data || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [meetingId, members]);

  const save = useCallback((updatedRows) => {
    if (!meetingId) return;
    api.put(`/l10/checkin/${meetingId}`, { rows: updatedRows }).catch(() => {});
  }, [meetingId]);

  const update = (idx, field, val) => {
    setRows((prev) => {
      const next = prev.map((r, i) => i === idx ? { ...r, [field]: val } : r);
      save(next);
      return next;
    });
  };

  if (loading) return <Loading label="Loading check-in…" />;

  const byMeeting = {};
  history.forEach((r) => {
    const key = r.week_label;
    if (!byMeeting[key]) byMeeting[key] = { week_label: r.week_label, date: r.meeting_date, rows: [] };
    byMeeting[key].rows.push(r);
  });

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20">
          <h2 className="text-sm font-semibold">This Week — Personal &amp; Professional Good News</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground text-left">
                <th className="py-2 px-4 font-medium w-40">Name</th>
                <th className="py-2 px-4 font-medium">Personal Good News</th>
                <th className="py-2 px-4 font-medium">Professional Good News</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.member_name} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="py-2 px-4 font-medium">{r.member_name}</td>
                  <td className="py-2 px-4">
                    <InlineEdit
                      value={r.personal_news}
                      onSave={(v) => update(i, "personal_news", v)}
                      placeholder="Share something…"
                      className="w-full"
                    />
                  </td>
                  <td className="py-2 px-4">
                    <InlineEdit
                      value={r.professional_news}
                      onSave={(v) => update(i, "professional_news", v)}
                      placeholder="Share something…"
                      className="w-full"
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={3} className="py-6 text-center text-muted-foreground text-sm">
                  No members configured. Add members in the Admin tab.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {Object.keys(byMeeting).length > 0 && (
        <Accordion title={`Previous Check-Ins (${Object.keys(byMeeting).length} weeks)`}>
          <div className="space-y-3">
            {Object.values(byMeeting).map((wk) => (
              <div key={wk.week_label}>
                <div className="text-xs font-semibold text-muted-foreground mb-1">
                  {wk.week_label} — {fmtDate(wk.date)}
                </div>
                <table className="w-full text-xs border rounded overflow-hidden">
                  <thead><tr className="bg-muted/30 text-left">
                    <th className="py-1.5 px-3 font-medium w-36">Name</th>
                    <th className="py-1.5 px-3 font-medium">Personal</th>
                    <th className="py-1.5 px-3 font-medium">Professional</th>
                  </tr></thead>
                  <tbody>
                    {wk.rows.map((r) => (
                      <tr key={r.member_name} className="border-t">
                        <td className="py-1.5 px-3 font-medium">{r.member_name}</td>
                        <td className="py-1.5 px-3 text-muted-foreground">{r.personal_news || "—"}</td>
                        <td className="py-1.5 px-3 text-muted-foreground">{r.professional_news || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </Accordion>
      )}
    </div>
  );
};

// ─── Scorecard Tab ───────────────────────────────────────────────────────────
const ScorecardTab = ({ meetingId, folderId = 1, onRedMetrics, isAdmin = false }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const notifyRedMetrics = useCallback((metrics, meetings, currentMeetingId) => {
    if (!onRedMetrics) return;
    const red = [];
    metrics.forEach((metric) => {
      const cell = metric.values?.[currentMeetingId];
      if (!cell || cell.value === null || cell.value === "") return;
      const tl = scorecardTrafficLight(cell.value, metric.goal, metric.goal_direction);
      if (tl === "red") red.push({ id: metric.id, measurable: metric.measurable, who: metric.who, value: cell.value, goal: metric.goal });
    });
    onRedMetrics(red);
  }, [onRedMetrics]);

  const reload = useCallback(() => {
    setLoading(true);
    api.get("/l10/scorecard", { params: { meetings: 8, folder_id: folderId }, forceFresh: true })
      .then((r) => {
        setData(r.data);
        if (r.data && meetingId) notifyRedMetrics(r.data.metrics || [], r.data.meetings || [], meetingId);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [folderId, meetingId, notifyRedMetrics]);

  useEffect(() => { reload(); }, [reload]);

  const saveValue = (targetMeetingId, metricId, value, goalDirection, goalStr) => {
    if (!targetMeetingId) return;
    let on_track = null;
    const numVal = parseFloat(value);
    // Range goal: min-max (hyphen, en-dash, em-dash, with optional spaces), e.g. "4-6"
    const rangeMatchSave = goalStr ? String(goalStr).trim().match(/^(-?\d+(?:\.\d+)?)\s*[-\u2013\u2014]\s*(-?\d+(?:\.\d+)?)(?=\s|$)/) : null;
    if (rangeMatchSave && !isNaN(numVal)) {
      const rMin = parseFloat(rangeMatchSave[1]);
      const rMax = parseFloat(rangeMatchSave[2]);
      if (!isNaN(rMin) && !isNaN(rMax)) {
        on_track = numVal >= rMin && numVal <= rMax;
      }
    } else {
      const opMatchSave = goalStr ? String(goalStr).trim().match(/^(>=|<=|\u2265|\u2264|>|<|=)\s*(-?\d+(?:\.\d+)?)(?=\s|$)/) : null;
      if (opMatchSave && !isNaN(numVal)) {
        const rawOp = opMatchSave[1];
        const normOpSave = rawOp === "\u2265" ? ">=" : rawOp === "\u2264" ? "<=" : rawOp;
        const g = parseFloat(opMatchSave[2]);
        if (!isNaN(g)) {
          if (normOpSave === ">=") on_track = numVal >= g;
          else if (normOpSave === "<=") on_track = numVal <= g;
          else if (normOpSave === ">")  on_track = numVal > g;
          else if (normOpSave === "<")  on_track = numVal < g;
          else if (normOpSave === "=")  on_track = numVal === g;
        }
      } else {
        const numGoal = parseFloat(String(goalStr).trim());
        if (!isNaN(numVal) && !isNaN(numGoal)) {
          on_track = goalDirection === "up" ? numVal >= numGoal : numVal <= numGoal;
        }
      }
    }
    api.put(`/l10/scorecard/${targetMeetingId}`, {
      values: [{ metric_id: metricId, value, on_track }]
    }).then(() => reload()).catch(() => {});
  };

  if (loading) return <Loading label="Loading scorecard…" />;
  if (!data) return null;

  const { meetings, metrics } = data;

  // Meetings where at least one metric value has been saved (non-null).
  // Past weeks with zero saved values remain editable; once any value is
  // saved the whole week flips to read-only (matching the current-week rule).
  const savedMeetingIds = new Set(
    meetings
      .filter((m) =>
        metrics.some((metric) => {
          const v = metric.values?.[m.id];
          return v && v.value !== null && v.value !== undefined && v.value !== "";
        })
      )
      .map((m) => m.id)
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-emerald-100 border border-emerald-300" /> Meets goal</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-red-100 border border-red-300" /> Below goal (auto-added to IDS)</span>
      </div>
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Weekly Scorecard</h2>
          <span className="text-xs text-muted-foreground">{isAdmin ? "Admin — every week is editable" : "Current week and unsaved prior weeks editable — saved prior weeks read-only"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="text-sm min-w-full">
            <thead>
              <tr className="border-b text-xs text-muted-foreground bg-muted/20">
                <th className="py-2 px-3 font-medium text-left sticky left-0 bg-white z-10 border-r">Who</th>
                <th className="py-2 px-3 font-medium text-left sticky left-[80px] bg-white z-10 border-r w-44">Measurable</th>
                <th className="py-2 px-3 font-medium text-left w-20">Goal</th>
                <th className="py-2 px-3 font-medium text-left w-16">UOM</th>
                {meetings.map((m) => (
                  <th key={m.id} className={`py-2 px-3 font-medium text-center whitespace-nowrap min-w-[80px] ${m.id === meetingId ? "bg-emerald-50/60" : ""}`}>
                    <div>{m.week_label}</div>
                    <div className="text-[10px] text-muted-foreground font-normal">{fmtDate(m.meeting_date)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.id} className="border-b last:border-0 bg-white hover:bg-muted/20">
                  <td className="py-2 px-3 sticky left-0 bg-white hover:bg-inherit z-10 border-r text-muted-foreground text-xs">{metric.who || "—"}</td>
                  <td className="py-2 px-3 sticky left-[80px] bg-white hover:bg-inherit z-10 border-r font-medium">{metric.measurable}</td>
                  <td className="py-2 px-3 text-xs">
                    <span className="flex items-center gap-0.5">
                      {metric.goal_direction === "up" ? <ArrowUp size={11} className="text-emerald-600" /> : <ArrowDown size={11} className="text-red-500" />}
                      {metric.goal || "—"}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">{metric.uom || "—"}</td>
                  {meetings.map((m) => {
                    const cell = metric.values?.[m.id] || { value: null };
                    const isCurrent = m.id === meetingId;
                    // Editable when: current week, past week with no saved values
                    // yet, or the viewer is an admin (admins can correct any week)
                    const isEditable = isAdmin || isCurrent || !savedMeetingIds.has(m.id);
                    const tl = scorecardTrafficLight(cell.value, metric.goal, metric.goal_direction);
                    return (
                      <td key={m.id} className={`py-1.5 px-2 text-center ${isCurrent ? "bg-emerald-50/20" : ""}`}>
                        {isEditable ? (
                          <ScorecardCell
                            value={cell.value}
                            trafficLight={tl}
                            goal={metric.goal}
                            goalDirection={metric.goal_direction}
                            onSave={(v) => saveValue(m.id, metric.id, v, metric.goal_direction, metric.goal)}
                          />
                        ) : (
                          // No value entered → plain unstyled dash, no badge background
                          (cell.value === null || cell.value === undefined || cell.value === "") ? (
                            <span className="text-xs font-mono text-muted-foreground">—</span>
                          ) : tl ? (
                            // Value + resolvable goal → coloured badge
                            <span className={`rounded px-1.5 py-0.5 text-xs font-mono ${trafficLightCls(tl)}`}>
                              {cell.value}
                            </span>
                          ) : (
                            // Value exists but no/unparsable goal → show value plain, no badge
                            <span className="text-xs font-mono">
                              {cell.value}
                            </span>
                          )
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {metrics.length === 0 && (
                <tr><td colSpan={4 + meetings.length} className="py-8 text-center text-muted-foreground text-sm">
                  No scorecard metrics configured. Add them in the Admin tab.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const ScorecardCell = ({ value, trafficLight: _trafficLightProp, goal, goalDirection, onSave }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const inputRef = useRef(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  useEffect(() => { setDraft(value || ""); }, [value]);
  const commit = () => { setEditing(false); onSave(draft); };
  if (editing) {
    // scorecardTrafficLight handles range goals (e.g. "4-6") so the live preview is correct too.
    const liveTl = scorecardTrafficLight(draft, goal, goalDirection);
    const inputBg = liveTl === "green" ? "bg-emerald-100" : liveTl === "red" ? "bg-red-100" : "bg-white";
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className={`w-16 border border-primary/40 rounded px-1 py-0.5 text-xs text-center outline-none ${inputBg}`}
      />
    );
  }
  // Compute traffic-light colour directly from value+goal.
  const staticTl = scorecardTrafficLight(value, goal, goalDirection);
  const isEmpty = value === null || value === undefined || value === "";
  if (isEmpty) {
    // No value entered → plain unstyled dash, no badge background
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-xs font-mono cursor-pointer hover:opacity-80 min-w-[48px] text-muted-foreground"
      >
        —
      </button>
    );
  }
  if (!staticTl) {
    // Value exists but no/unparsable goal → show value plain, no badge
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-xs font-mono cursor-pointer hover:opacity-80 min-w-[48px]"
      >
        {value}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={`rounded px-2 py-0.5 text-xs font-mono cursor-pointer hover:opacity-80 min-w-[48px] ${trafficLightCls(staticTl)}`}
    >
      {value}
    </button>
  );
};

// ─── Rocks Tab ───────────────────────────────────────────────────────────────
const RocksTab = ({ members, folderId = 1, isAdmin = false }) => {
  const [rocks, setRocks] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    api.get("/l10/rocks", { params: { folder_id: folderId }, forceFresh: true })
      .then((r) => setRocks(r.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [folderId]);

  useEffect(() => { reload(); }, [reload]);

  const update = (id, patch) => {
    api.put(`/l10/rocks/${id}`, patch).then(reload).catch(() => {});
  };

  if (loading) return <Loading label="Loading rocks…" />;

  const quarters = [...new Set(rocks.map((r) => r.quarter_label).filter(Boolean))];
  const byQuarter = {};
  quarters.forEach((q) => { byQuarter[q] = rocks.filter((r) => r.quarter_label === q); });
  const noQuarter = rocks.filter((r) => !r.quarter_label);

  const doneCount = rocks.filter((r) => r.done).length;
  const pct = rocks.length ? Math.round((doneCount / rocks.length) * 100) : 0;

  const memberNames = (members || []).filter((m) => m.active !== false).map((m) => m.name);

  const RockRow = ({ rock }) => (
    <div className="flex items-start gap-3 py-2.5 border-b last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
            rock.rock_type === "Company" ? "bg-brand/10 text-brand" : "bg-violet-50 text-violet-700"
          }`}>{rock.rock_type}</span>
          {isAdmin ? (
            <select
              value={rock.owner || ""}
              onChange={(e) => update(rock.id, { owner: e.target.value || null })}
              className="border border-border rounded px-1 py-0.5 text-xs bg-white text-muted-foreground"
              data-testid={`select-rock-owner-${rock.id}`}
            >
              <option value="">Owner…</option>
              {(rock.owner && !memberNames.includes(rock.owner) ? [rock.owner, ...memberNames] : memberNames).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-muted-foreground">{rock.owner || "—"}</span>
          )}
        </div>
        <div className="mt-0.5 font-medium text-sm">
          {isAdmin ? (
            <InlineEdit
              value={rock.description}
              onSave={(v) => { if (v && v.trim()) update(rock.id, { description: v.trim() }); }}
              className="w-full"
              multiline
            />
          ) : (
            rock.description
          )}
        </div>
        {isAdmin ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            <InlineEdit
              value={rock.results || ""}
              onSave={(v) => update(rock.id, { results: v })}
              placeholder="Add results / notes…"
              className="w-full"
            />
          </div>
        ) : rock.results ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{rock.results}</div>
        ) : null}
        {rock.link && (
          <a href={rock.link} target="_blank" rel="noopener noreferrer"
            className="mt-0.5 inline-flex items-center gap-1 text-xs text-primary hover:underline">
            <LinkIcon size={10} /> Link
          </a>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => update(rock.id, { done: !rock.done, on_track: !rock.done ? true : rock.on_track })}
          className={`rounded-full text-xs px-2.5 py-1 border font-medium transition-colors ${
            rock.done
              ? "bg-emerald-100 text-emerald-800 border-emerald-300"
              : "bg-muted/40 text-muted-foreground border-border"
          }`}
        >
          {rock.done ? "Done" : "Mark Done"}
        </button>
        {!rock.done && (
          <button
            type="button"
            onClick={() => update(rock.id, { on_track: !rock.on_track })}
            className={`rounded-full text-xs px-2.5 py-1 border font-medium transition-colors ${
              rock.on_track
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-red-50 text-red-600 border-red-200"
            }`}
          >
            {rock.on_track ? "On Track" : "Off Track"}
          </button>
        )}
        {isAdmin && (
          <button
            type="button"
            onClick={() => update(rock.id, { active: false })}
            title="Archive rock"
            className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-500"
            data-testid={`button-archive-rock-${rock.id}`}
          >
            <Trash size={13} />
          </button>
        )}
      </div>
    </div>
  );

  const companyRocks = rocks.filter((r) => r.rock_type === "Company");
  const personRocks = rocks.filter((r) => r.rock_type !== "Company");
  const personOwners = [...new Set(personRocks.map((r) => r.owner).filter(Boolean))];

  return (
    <div className="space-y-4">
      {rocks.length > 0 && (
        <div className="flex items-center gap-3">
          <div className="text-sm font-medium">{doneCount}/{rocks.length} rocks complete</div>
          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-sm text-muted-foreground">{pct}%</div>
        </div>
      )}

      <div className="rounded-xl border bg-card">
        <div className="px-4 py-3 border-b bg-muted/20">
          <h2 className="text-sm font-semibold">Company Rocks</h2>
        </div>
        <div className="px-4">
          {companyRocks.length === 0 ? (
            <div className="py-6 text-center text-muted-foreground text-sm">
              No company rocks. Add rocks in the Admin tab.
            </div>
          ) : (
            companyRocks.map((r) => <RockRow key={r.id} rock={r} />)
          )}
        </div>
      </div>

      {personOwners.length > 0 && (
        <div className="rounded-xl border bg-card">
          <div className="px-4 py-3 border-b bg-muted/20">
            <h2 className="text-sm font-semibold">Rocks — by Person</h2>
          </div>
          <div className="px-4 divide-y">
            {personOwners.map((owner) => (
              <div key={owner} className="py-3">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{owner}</div>
                {personRocks.filter((r) => r.owner === owner).map((r) => <RockRow key={r.id} rock={r} />)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Headlines Tab ───────────────────────────────────────────────────────────
const HeadlinesTab = ({ meetingId, members, folderId = 1 }) => {
  const [rows, setRows] = useState([{ headline: "", date: new Date().toISOString().slice(0, 10), added_by: "", link: "" }]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!meetingId) return;
    setLoading(true);
    Promise.all([
      api.get(`/l10/headlines/${meetingId}`, { forceFresh: true }),
      api.get("/l10/headlines/history", { params: { exclude_meeting_id: meetingId, folder_id: folderId }, forceFresh: true }),
    ]).then(([c, h]) => {
      const cur = c.data || [];
      setRows(cur.length ? cur : [{ headline: "", date: new Date().toISOString().slice(0, 10), added_by: "", link: "" }]);
      setHistory(h.data || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [meetingId]);

  const save = useCallback((r) => {
    if (!meetingId) return;
    api.put(`/l10/headlines/${meetingId}`, { rows: r }).catch(() => {});
  }, [meetingId]);

  const update = (idx, field, val) => {
    setRows((prev) => {
      const next = prev.map((row, i) => i === idx ? { ...row, [field]: val } : row);
      save(next);
      return next;
    });
  };

  const addRow = () => setRows((prev) => [...prev, { headline: "", date: new Date().toISOString().slice(0, 10), added_by: "", link: "" }]);
  const removeRow = (idx) => setRows((prev) => {
    const next = prev.filter((_, i) => i !== idx);
    save(next);
    return next;
  });

  if (loading) return <Loading label="Loading headlines…" />;

  const memberNames = members.filter((m) => m.active).map((m) => m.name);
  const byMeeting = {};
  history.forEach((r) => {
    if (!byMeeting[r.week_label]) byMeeting[r.week_label] = { week_label: r.week_label, date: r.meeting_date, rows: [] };
    byMeeting[r.week_label].rows.push(r);
  });

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
          <h2 className="text-sm font-semibold">This Week — Headlines</h2>
          <button type="button" onClick={addRow} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            <Plus size={12} /> Add row
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground text-left">
                <th className="py-2 px-3 font-medium w-8">#</th>
                <th className="py-2 px-3 font-medium">Headline</th>
                <th className="py-2 px-3 font-medium w-32">Date</th>
                <th className="py-2 px-3 font-medium w-36">Added By</th>
                <th className="py-2 px-3 font-medium w-28">Link</th>
                <th className="py-2 px-3 font-medium w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="py-1.5 px-3 text-muted-foreground text-xs">{i + 1}</td>
                  <td className="py-1.5 px-3">
                    <InlineEdit value={row.headline} onSave={(v) => update(i, "headline", v)} placeholder="Headline text…" className="w-full" />
                  </td>
                  <td className="py-1.5 px-3">
                    <input type="date" value={row.date || ""} onChange={(e) => update(i, "date", e.target.value)}
                      className="border border-border rounded px-1.5 py-0.5 text-xs w-full bg-white" />
                  </td>
                  <td className="py-1.5 px-3">
                    <select value={row.added_by || ""} onChange={(e) => update(i, "added_by", e.target.value)}
                      className="border border-border rounded px-1.5 py-0.5 text-xs w-full bg-white">
                      <option value="">Select…</option>
                      {memberNames.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </td>
                  <td className="py-1.5 px-3">
                    <InlineEdit value={row.link} onSave={(v) => update(i, "link", v)} placeholder="URL…" className="w-full text-xs" />
                  </td>
                  <td className="py-1.5 px-3">
                    <button type="button" onClick={() => removeRow(i)} className="text-muted-foreground hover:text-red-500">
                      <Trash size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {Object.keys(byMeeting).length > 0 && (
        <Accordion title={`Previous Headlines (${Object.keys(byMeeting).length} weeks)`}>
          <div className="space-y-3">
            {Object.values(byMeeting).map((wk) => (
              <div key={wk.week_label}>
                <div className="text-xs font-semibold text-muted-foreground mb-1">{wk.week_label} — {fmtDate(wk.date)}</div>
                <table className="w-full text-xs border rounded overflow-hidden">
                  <thead><tr className="bg-muted/30 text-left">
                    <th className="py-1.5 px-3 font-medium">#</th>
                    <th className="py-1.5 px-3 font-medium">Headline</th>
                    <th className="py-1.5 px-3 font-medium">Added By</th>
                  </tr></thead>
                  <tbody>
                    {wk.rows.map((r, i) => (
                      <tr key={r.id} className="border-t">
                        <td className="py-1.5 px-3 text-muted-foreground">{i + 1}</td>
                        <td className="py-1.5 px-3">{r.headline}</td>
                        <td className="py-1.5 px-3 text-muted-foreground">{r.added_by || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </Accordion>
      )}
    </div>
  );
};

// ─── To-Dos Tab ──────────────────────────────────────────────────────────────
const TodosTab = ({ meetingId, members, folderId = 1 }) => {
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newTodo, setNewTodo] = useState({ description: "", owner: "", open_date: new Date().toISOString().slice(0, 10) });

  const reload = useCallback(() => {
    setLoading(true);
    api.get("/l10/todos", { params: { folder_id: folderId }, forceFresh: true })
      .then((r) => setTodos(r.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [folderId]);

  useEffect(() => { reload(); }, [reload]);

  const toggle = (todo) => {
    const newStatus = todo.status === "done" ? "open" : "done";
    api.put(`/l10/todos/${todo.id}`, {
      status: newStatus,
      closed_meeting_id: newStatus === "done" ? meetingId : null,
    }).then(reload).catch(() => {});
  };

  const addTodo = () => {
    if (!newTodo.description.trim()) return;
    api.post("/l10/todos", { ...newTodo, opened_meeting_id: meetingId, folder_id: folderId })
      .then(() => { setAdding(false); setNewTodo({ description: "", owner: "", open_date: new Date().toISOString().slice(0, 10) }); reload(); })
      .catch(() => {});
  };

  const deleteTodo = (id) => {
    api.delete(`/l10/todos/${id}`).then(reload).catch(() => {});
  };

  if (loading) return <Loading label="Loading to-dos…" />;

  const memberNames = members.filter((m) => m.active).map((m) => m.name);
  const open = todos.filter((t) => t.status !== "done");
  const done = todos.filter((t) => t.status === "done");
  const donePct = todos.length ? Math.round((done.length / todos.length) * 100) : 0;

  const TodoRow = ({ todo }) => (
    <tr className="border-b last:border-0 hover:bg-muted/20">
      <td className="py-2 px-3 w-32">
        <select
          value={todo.status === "done" ? "done" : "open"}
          onChange={(e) => toggle({ ...todo, status: e.target.value === "done" ? "open" : "done" })}
          className={`border rounded px-1.5 py-0.5 text-xs w-full font-medium ${
            todo.status === "done"
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-amber-300 bg-amber-50 text-amber-800"
          }`}
        >
          <option value="open">Not Done</option>
          <option value="done">Done</option>
        </select>
      </td>
      <td className={`py-2 px-3 text-sm ${todo.status === "done" ? "line-through text-muted-foreground" : ""}`}>
        {todo.description}
      </td>
      <td className="py-2 px-3 text-xs text-muted-foreground">{todo.open_date || "—"}</td>
      <td className="py-2 px-3 text-xs text-muted-foreground">{todo.owner || "—"}</td>
      <td className="py-2 px-3">
        {todo.link && (
          <a href={todo.link} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            <LinkIcon size={10} /> Link
          </a>
        )}
      </td>
      <td className="py-2 px-3">
        <button type="button" onClick={() => deleteTodo(todo.id)} className="text-muted-foreground hover:text-red-500">
          <Trash size={13} />
        </button>
      </td>
    </tr>
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-amber-50 border-amber-200 px-4 py-2.5 text-sm text-amber-800">
        <strong>90% Rule:</strong> 90% of To-Dos should be completed within 7 days. Today: {donePct}% done ({done.length}/{todos.length}).
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Open To-Dos ({open.length})</h2>
          <button type="button" onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-primary text-primary-foreground hover:opacity-90">
            <Plus size={12} /> Add To-Do
          </button>
        </div>
        {adding && (
          <div className="px-4 py-3 border-b bg-muted/10 flex flex-wrap items-end gap-2">
            <input placeholder="Task description…" value={newTodo.description}
              onChange={(e) => setNewTodo((p) => ({ ...p, description: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm flex-1 min-w-[200px]" />
            <select value={newTodo.owner} onChange={(e) => setNewTodo((p) => ({ ...p, owner: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm min-w-[120px]">
              <option value="">Owner…</option>
              {memberNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <input type="date" value={newTodo.open_date} onChange={(e) => setNewTodo((p) => ({ ...p, open_date: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm" />
            <button type="button" onClick={addTodo}
              className="px-3 py-1 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90">Save</button>
            <button type="button" onClick={() => setAdding(false)}
              className="px-3 py-1 rounded-lg border text-sm hover:bg-muted">Cancel</button>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground text-left">
                <th className="py-2 px-3 w-8" />
                <th className="py-2 px-3 font-medium">Task</th>
                <th className="py-2 px-3 font-medium w-28">Open Date</th>
                <th className="py-2 px-3 font-medium w-28">Owner</th>
                <th className="py-2 px-3 font-medium w-20">Link</th>
                <th className="py-2 px-3 w-8" />
              </tr>
            </thead>
            <tbody>
              {open.map((t) => <TodoRow key={t.id} todo={t} />)}
              {open.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-muted-foreground text-sm">All to-dos are done.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {done.length > 0 && (
        <Accordion title={`Completed To-Dos (${done.length})`}>
          <table className="w-full text-sm">
            <tbody>
              {done.map((t) => <TodoRow key={t.id} todo={t} />)}
            </tbody>
          </table>
        </Accordion>
      )}
    </div>
  );
};

// ─── IDS Tab ─────────────────────────────────────────────────────────────────
const IDSTab = ({ meetingId, members, folderId = 1, redMetrics = [] }) => {
  const [rows, setRows] = useState([{ issue: "", raised_by: "", status: "open" }]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!meetingId) return;
    setLoading(true);
    Promise.all([
      api.get(`/l10/ids/${meetingId}`, { forceFresh: true }),
      api.get("/l10/ids/history", { params: { exclude_meeting_id: meetingId, folder_id: folderId }, forceFresh: true }),
    ]).then(([c, h]) => {
      const cur = c.data || [];
      setRows(cur.length ? cur : [{ issue: "", raised_by: "", status: "open" }]);
      setHistory(h.data || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [meetingId]);

  const save = useCallback((r) => {
    if (!meetingId) return;
    api.put(`/l10/ids/${meetingId}`, { rows: r }).catch(() => {});
  }, [meetingId]);

  const update = (idx, field, val) => {
    setRows((prev) => {
      const next = prev.map((row, i) => i === idx ? { ...row, [field]: val } : row);
      save(next);
      return next;
    });
  };

  const addRow = () => setRows((prev) => [...prev, { issue: "", raised_by: "", status: "open" }]);
  const removeRow = (idx) => setRows((prev) => {
    const next = prev.filter((_, i) => i !== idx);
    save(next);
    return next;
  });



  if (loading) return <Loading label="Loading IDS…" />;

  const memberNames = members.filter((m) => m.active).map((m) => m.name);
  const byMeeting = {};
  history.forEach((r) => {
    if (!byMeeting[r.week_label]) byMeeting[r.week_label] = { week_label: r.week_label, date: r.meeting_date, rows: [] };
    byMeeting[r.week_label].rows.push(r);
  });

  return (
    <div className="space-y-4">

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Issues List — Identify, Discuss, Solve</h2>
          <button type="button" onClick={addRow} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            <Plus size={12} /> Add issue
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground text-left">
                <th className="py-2 px-3 font-medium w-8">#</th>
                <th className="py-2 px-3 font-medium">Issue</th>
                <th className="py-2 px-3 font-medium w-36">Raised/Owned By</th>
                <th className="py-2 px-3 font-medium w-36">Status</th>
                <th className="py-2 px-3 w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const isAuto = !!(row.scorecard_metric_id || row.rock_id);
                const isRock = !!(row.rock_id && !row.scorecard_metric_id);
                return (
                  <tr key={i} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="py-1.5 px-3 text-muted-foreground text-xs">{i + 1}</td>
                    <td className="py-1.5 px-3">
                      <div className="flex items-center gap-1.5">
                        {row.scorecard_metric_id && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 shrink-0 whitespace-nowrap">
                            📊 Scorecard
                          </span>
                        )}
                        {isRock && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 shrink-0 whitespace-nowrap">
                            🪨 Rock
                          </span>
                        )}
                        {isAuto
                          ? <span className="text-sm">{row.issue}</span>
                          : <InlineEdit value={row.issue} onSave={(v) => update(i, "issue", v)} placeholder="Describe the issue…" className="w-full" />
                        }
                      </div>
                    </td>
                    <td className="py-1.5 px-3">
                      <select value={row.raised_by || ""} onChange={(e) => update(i, "raised_by", e.target.value)}
                        className="border border-border rounded px-1.5 py-0.5 text-xs w-full bg-white">
                        <option value="">Select…</option>
                        {memberNames.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </td>
                    <td className="py-1.5 px-3">
                      <select value={row.status || "open"} onChange={(e) => update(i, "status", e.target.value)}
                        className={`border rounded px-1.5 py-0.5 text-xs w-full bg-white ${
                          row.status === "resolved" ? "border-emerald-300 text-emerald-700" :
                          row.status === "discussed" ? "border-amber-300 text-amber-700" :
                          "border-border"
                        }`}>
                        <option value="open">Open</option>
                        <option value="discussed">Discussed</option>
                        <option value="resolved">Resolved</option>
                      </select>
                    </td>
                    <td className="py-1.5 px-3">
                      {!isAuto && (
                        <button type="button" onClick={() => removeRow(i)} className="text-muted-foreground hover:text-red-500">
                          <Trash size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {Object.keys(byMeeting).length > 0 && (
        <Accordion title={`Discussed / Raised / Resolved History (${history.length} issues)`}>
          <div className="space-y-3">
            {Object.values(byMeeting).map((wk) => (
              <div key={wk.week_label}>
                <div className="text-xs font-semibold text-muted-foreground mb-1">{wk.week_label} — {fmtDate(wk.date)}</div>
                <table className="w-full text-xs border rounded overflow-hidden">
                  <thead><tr className="bg-muted/30 text-left">
                    <th className="py-1.5 px-3 font-medium">#</th>
                    <th className="py-1.5 px-3 font-medium">Issue</th>
                    <th className="py-1.5 px-3 font-medium">By</th>
                    <th className="py-1.5 px-3 font-medium">Status</th>
                  </tr></thead>
                  <tbody>
                    {wk.rows.map((r, i) => (
                      <tr key={r.id} className="border-t">
                        <td className="py-1.5 px-3 text-muted-foreground">{i + 1}</td>
                        <td className="py-1.5 px-3">{r.issue}</td>
                        <td className="py-1.5 px-3 text-muted-foreground">{r.raised_by || "—"}</td>
                        <td className="py-1.5 px-3">
                          <span className={`font-medium ${r.status === "resolved" ? "text-emerald-700" : "text-amber-700"}`}>
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </Accordion>
      )}
    </div>
  );
};

// ─── Conclude Tab ─────────────────────────────────────────────────────────────
const ConcludeTab = ({ meetingId, members, folderId = 1 }) => {
  const [cascading, setCascading] = useState("");
  const [ratingsData, setRatingsData] = useState({ meetings: [], ratings_by_key: [] });
  const [ratings, setRatings] = useState({});
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);

  const reload = useCallback(() => {
    if (!meetingId) return;
    setLoading(true);
    Promise.all([
      api.get(`/l10/conclude/${meetingId}`, { forceFresh: true }),
      api.get("/l10/ratings/history", { params: { limit: 8, folder_id: folderId }, forceFresh: true }),
    ]).then(([c, h]) => {
      setCascading(c.data?.cascading_messages || "");
      const curRatings = {};
      (c.data?.ratings || []).forEach((r) => { curRatings[r.member_name] = r.rating; });
      setRatings(curRatings);
      setRatingsData(h.data || { meetings: [], ratings_by_key: [] });
    }).catch(() => {}).finally(() => setLoading(false));
  }, [meetingId, folderId]);

  useEffect(() => { reload(); }, [reload]);

  const saveCascading = useCallback((val) => {
    if (!meetingId) return;
    api.put(`/l10/conclude/${meetingId}`, { cascading_messages: val }).catch(() => {});
  }, [meetingId]);

  const onCascadingChange = (e) => {
    const val = e.target.value;
    setCascading(val);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => saveCascading(val), 800);
  };

  const saveRating = (memberName, value) => {
    if (!meetingId) return;
    setRatings((prev) => ({ ...prev, [memberName]: value }));
    api.put(`/l10/conclude/${meetingId}`, {
      ratings: [{ member_name: memberName, rating: value === "" ? null : parseInt(value, 10) }]
    }).catch(() => {});
  };

  if (loading) return <Loading label="Loading conclude…" />;

  const memberNames = members.filter((m) => m.active).map((m) => m.name);
  const { meetings, ratings_by_key } = ratingsData;

  // Build ratings lookup for history: { member_name: { meeting_id: rating } }
  const histRatings = {};
  (ratings_by_key || []).forEach((r) => {
    if (!histRatings[r.member_name]) histRatings[r.member_name] = {};
    histRatings[r.member_name][r.meeting_id] = r.rating;
  });

  const allMembers = [...new Set([...memberNames, ...Object.keys(histRatings)])];

  const colAvg = (mtgId) => {
    const vals = allMembers.map((m) => histRatings[m]?.[mtgId] ?? (mtgId === meetingId ? ratings[m] : null)).filter((v) => v != null && v !== "");
    if (!vals.length) return null;
    return (vals.reduce((a, b) => a + Number(b), 0) / vals.length).toFixed(1);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card">
        <div className="px-4 py-3 border-b bg-muted/20">
          <h2 className="text-sm font-semibold">Cascading Messages</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Key messages to cascade to your teams after this meeting</p>
        </div>
        <div className="p-4">
          <textarea
            value={cascading}
            onChange={onCascadingChange}
            placeholder="What needs to be communicated to the broader team?"
            rows={4}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-white resize-y focus:outline-none focus:border-primary/50"
          />
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20">
          <h2 className="text-sm font-semibold">Meeting Ratings</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Rate the meeting 1–10 (10 = best meeting ever)</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground bg-muted/20">
                <th className="py-2 px-3 font-medium text-left sticky left-0 bg-white z-10 border-r w-36">Member</th>
                {meetings.map((m) => (
                  <th key={m.id} className={`py-2 px-3 font-medium text-center whitespace-nowrap min-w-[80px] ${m.id === meetingId ? "bg-emerald-50/60" : ""}`}>
                    <div>{m.week_label}</div>
                    <div className="text-[10px] font-normal">{fmtDate(m.meeting_date)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allMembers.map((member) => (
                <tr key={member} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="py-2 px-3 font-medium sticky left-0 bg-white border-r">{member}</td>
                  {meetings.map((m) => {
                    const isCurrent = m.id === meetingId;
                    const val = isCurrent ? (ratings[member] ?? "") : (histRatings[member]?.[m.id] ?? "");
                    if (isCurrent) {
                      return (
                        <td key={m.id} className="py-1.5 px-2 text-center bg-emerald-50/30">
                          <input
                            type="number" min={1} max={10} value={val}
                            onChange={(e) => saveRating(member, e.target.value)}
                            className="w-14 border border-border rounded px-1 py-0.5 text-xs text-center bg-white"
                            placeholder="1–10"
                          />
                        </td>
                      );
                    }
                    return (
                      <td key={m.id} className="py-2 px-3 text-center text-muted-foreground text-xs">
                        {val !== "" ? val : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="bg-muted/20 font-semibold">
                <td className="py-2 px-3 sticky left-0 bg-muted/20 border-r text-xs uppercase tracking-wide text-muted-foreground">Avg</td>
                {meetings.map((m) => {
                  const avg = colAvg(m.id);
                  return (
                    <td key={m.id} className={`py-2 px-3 text-center text-sm ${m.id === meetingId ? "bg-emerald-50/40" : ""}`}>
                      {avg != null ? avg : "—"}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// ─── L10 Data Migration Panel ─────────────────────────────────────────────────
const L10MigrationPanel = () => {
  // ── Export ──────────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const { data } = await api.get("/admin/l10/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.download = `l10-snapshot-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e?.response?.data?.detail || e.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };

  // ── Import ──────────────────────────────────────────────────────────────────
  const fileRef = useRef(null);
  const [parsed, setParsed] = useState(null);
  const [parseError, setParseError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState(null);

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsed(null);
    setParseError(null);
    setImportResult(null);
    setImportError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data?.tables || !data?.row_counts) {
          throw new Error("File does not look like an L10 snapshot (missing tables or row_counts).");
        }
        setParsed(data);
      } catch (err) {
        setParseError(err.message);
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!parsed) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const { data } = await api.post("/admin/l10/import", parsed);
      setImportResult(data);
      setParsed(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setImportError(e?.response?.data?.detail || e.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleCancel = () => {
    setParsed(null);
    setParseError(null);
    setImportResult(null);
    setImportError(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="rounded-xl border bg-card">
      <div className="px-4 py-3 border-b bg-muted/20 flex items-center gap-2">
        <Database size={14} className="text-muted-foreground" />
        <h2 className="text-sm font-semibold">Data Migration</h2>
        <span className="text-xs text-muted-foreground">— export or import a Main BI L10 snapshot</span>
      </div>
      <div className="p-4 space-y-5">

        {/* Export */}
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">Export &amp; Download</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Downloads a JSON file containing Main BI L10 folders, meetings, members, rocks, scorecard metrics, and history.
            </p>
          </div>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="inline-flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-4 py-1.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {exporting
              ? <><CircleNotch size={13} className="animate-spin" /> Exporting…</>
              : <><ArrowSquareOut size={13} /> Export &amp; Download</>}
          </button>
          {exportError && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              <Warning size={13} weight="fill" className="mt-0.5 shrink-0" />
              {exportError}
            </div>
          )}
        </div>

        <div className="border-t" />

        {/* Import */}
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">Import Snapshot</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Select a JSON file exported from another environment. Folders present in the file are replaced; others are left untouched.
            </p>
          </div>

          {/* File picker */}
          {!parsed && !importResult && (
            <label className="flex items-center gap-3 cursor-pointer border-2 border-dashed border-border rounded-lg px-4 py-4 hover:border-primary/40 transition-colors">
              <UploadSimple size={20} className="text-muted-foreground shrink-0" />
              <div>
                <span className="text-sm font-medium">Choose a snapshot file</span>
                <span className="text-xs text-muted-foreground ml-2">(.json)</span>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="sr-only"
                onChange={handleFileChange}
              />
            </label>
          )}

          {/* Parse error */}
          {parseError && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
              <Warning size={13} weight="fill" className="mt-0.5 shrink-0" />
              <span className="flex-1">{parseError}</span>
              <button type="button" onClick={handleCancel} className="underline text-red-600 hover:text-red-800">Clear</button>
            </div>
          )}

          {/* Row-count preview */}
          {parsed && !importResult && (
            <div className="space-y-3">
              <p className="text-xs font-semibold">
                Snapshot preview
                <span className="ml-2 font-normal text-muted-foreground">
                  exported {parsed.exported_at ? new Date(parsed.exported_at).toLocaleString() : "unknown"}
                </span>
              </p>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/20">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Table</th>
                      <th className="text-right px-3 py-2 font-semibold text-muted-foreground">Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(parsed.row_counts).map(([tbl, n]) => (
                      <tr key={tbl} className="border-t border-border">
                        <td className="px-3 py-1.5 font-mono">{tbl}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{n.toLocaleString()}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border bg-muted/20">
                      <td className="px-3 py-1.5 font-semibold">Total</td>
                      <td className="px-3 py-1.5 text-right font-semibold tabular-nums">
                        {Object.values(parsed.row_counts).reduce((s, n) => s + n, 0).toLocaleString()}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {importError && (
                <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                  <Warning size={13} weight="fill" className="mt-0.5 shrink-0" />
                  {importError}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={importing}
                  className="inline-flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-4 py-1.5 rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {importing ? <><CircleNotch size={13} className="animate-spin" /> Importing…</> : <>Confirm Import</>}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={importing}
                  className="text-sm font-semibold text-muted-foreground border border-border px-4 py-1.5 rounded-lg hover:bg-muted disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Success result */}
          {importResult && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-4 py-3">
                <CheckCircle size={15} weight="fill" className="shrink-0" />
                Import complete — {Object.values(importResult.imported || {}).reduce((s, n) => s + n, 0).toLocaleString()} rows written
                {importResult.folder_ids?.length > 0 && (
                  <span className="ml-2 text-xs font-normal text-emerald-600">
                    (folder{importResult.folder_ids.length !== 1 ? "s" : ""} {importResult.folder_ids.join(", ")})
                  </span>
                )}
              </div>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/20">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Table</th>
                      <th className="text-right px-3 py-2 font-semibold text-muted-foreground">Rows inserted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(importResult.imported || {}).map(([tbl, n]) => (
                      <tr key={tbl} className="border-t border-border">
                        <td className="px-3 py-1.5 font-mono">{tbl}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{n.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" onClick={handleCancel} className="text-xs text-muted-foreground underline hover:text-foreground">
                Import another file
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Finance & Operations Recovery (admin only) ───────────────────────────────
const FinanceOperationsRestorePanel = ({ onRestored }) => {
  const fileRef = useRef(null);
  const [status, setStatus] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState(null);

  const loadStatus = useCallback(() => {
    api.get("/admin/l10/finance-operations/status", { forceFresh: true })
      .then((r) => setStatus(r.data))
      .catch((e) => setError(e?.response?.data?.detail || e.message || "Could not check recovery status."));
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const clear = () => {
    setSnapshot(null);
    setPreview(null);
    setError(null);
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const selectSnapshot = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setPreview(null);
    setResult(null);
    const reader = new FileReader();
    reader.onload = async (readEvent) => {
      try {
        const parsed = JSON.parse(readEvent.target.result);
        if (!parsed?.tables || !parsed?.row_counts) {
          throw new Error("Choose a complete L10 JSON export with tables and row_counts.");
        }
        setSnapshot(parsed);
        const { data } = await api.post("/admin/l10/finance-operations/restore", {
          snapshot: parsed,
          confirm: false,
        });
        setPreview(data);
      } catch (e) {
        setSnapshot(null);
        setError(e?.response?.data?.detail || e.message || "The recovery source could not be verified.");
      }
    };
    reader.readAsText(file);
  };

  const downloadCurrentBackup = async () => {
    const { data } = await api.get("/admin/l10/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `l10-before-finance-operations-restore-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const downloadDurableBackup = async () => {
    if (!result?.pre_restore_backup?.download_path) return;
    try {
      const { data } = await api.get(result.pre_restore_backup.download_path);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `l10-server-backup-before-finance-operations-restore-${result.pre_restore_backup.id}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e?.response?.data?.detail || e.message || "Could not download the server backup.");
    }
  };

  const restore = async () => {
    if (!snapshot || !preview) return;
    setRestoring(true);
    setError(null);
    try {
      // The backup must finish before the request that can replace department rows.
      await downloadCurrentBackup();
      const { data } = await api.post("/admin/l10/finance-operations/restore", {
        snapshot,
        confirm: true,
      });
      setResult(data);
      setSnapshot(null);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
      loadStatus();
      if (data?.target?.folder_id) onRestored?.(data.target.folder_id);
    } catch (e) {
      setError(e?.response?.data?.detail || e.message || "Restore failed. Live L10 data was not changed.");
    } finally {
      setRestoring(false);
    }
  };

  const rows = result?.restored_counts || preview?.source_counts;
  const isPresent = status?.status === "restored_workspace_present";

  return (
    <div className="rounded-xl border bg-card" data-testid="finance-operations-restore">
      <div className="px-4 py-3 border-b bg-muted/20 flex items-center gap-2">
        <Database size={14} className="text-muted-foreground" />
        <div>
          <h2 className="text-sm font-semibold">Finance &amp; Operations Recovery</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Restores only this Main BI department. SLT and Supply Chain are never included.
          </p>
        </div>
      </div>
      <div className="p-4 space-y-3">
        {status && (
          <div className={`text-xs rounded-md border px-3 py-2 ${
            isPresent
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}>
            {status.message}
          </div>
        )}

        {!snapshot && !result && (
          <label className="flex items-center gap-3 cursor-pointer border-2 border-dashed border-border rounded-lg px-4 py-3 hover:border-primary/40 transition-colors">
            <UploadSimple size={18} className="text-muted-foreground shrink-0" />
            <span className="text-sm font-medium">Choose verified Finance &amp; Operations snapshot</span>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              onChange={selectSnapshot}
              data-testid="finance-operations-restore-file"
            />
          </label>
        )}

        {error && (
          <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            <Warning size={13} weight="fill" className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={clear} className="underline">Clear</button>
          </div>
        )}

        {rows && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/20">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Verified section</th>
                  <th className="text-right px-3 py-2 font-semibold text-muted-foreground">
                    {result ? "Restored rows" : "Source rows"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(rows).map(([table, count]) => (
                  <tr key={table} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono">{table}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{Number(count).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {preview && !result && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Source: <strong className="text-foreground">{preview.source?.folder_name}</strong>
              {preview.source?.exported_at && <> · exported {new Date(preview.source.exported_at).toLocaleString()}</>}
              {" "}· the current Main BI snapshot will download before restore.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={restore}
                disabled={restoring}
                className="inline-flex items-center gap-2 text-sm font-semibold bg-primary text-primary-foreground px-4 py-1.5 rounded-lg hover:opacity-90 disabled:opacity-50"
              >
                {restoring ? <><CircleNotch size={13} className="animate-spin" /> Restoring…</> : <>Download Backup &amp; Restore</>}
              </button>
              <button
                type="button"
                onClick={clear}
                disabled={restoring}
                className="text-sm font-semibold text-muted-foreground border border-border px-4 py-1.5 rounded-lg hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
              <CheckCircle size={15} weight="fill" />
              Restored and reconciled — {result.total_rows?.toLocaleString()} rows in Finance &amp; Operations.
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {result.pre_restore_backup?.id && (
                <button type="button" onClick={downloadDurableBackup} className="text-xs font-medium text-primary underline hover:opacity-80">
                  Download server backup #{result.pre_restore_backup.id}
                </button>
              )}
              <button type="button" onClick={clear} className="text-xs text-muted-foreground underline hover:text-foreground">
                Restore another verified source
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Admin Tab ────────────────────────────────────────────────────────────────
const AdminTab = ({ members, onMembersChanged, settings, onSettingsChanged, onFinanceRestored, folderId = 1, isAdmin = false }) => {
  const [metrics, setMetrics] = useState([]);
  const [rocks, setRocks] = useState([]);
  const [loadingMetrics, setLoadingMetrics] = useState(true);
  const [loadingRocks, setLoadingRocks] = useState(true);

  const [newMember, setNewMember] = useState("");
  const [newMetric, setNewMetric] = useState({ who: "", measurable: "", goal: "", uom: "", goal_direction: "up" });
  const [newRock, setNewRock] = useState({ description: "", rock_type: "Company", owner: "", quarter_label: "" });
  const [editingMetricId, setEditingMetricId] = useState(null);
  const [editDraft, setEditDraft] = useState({});
  const [metricSaveError, setMetricSaveError] = useState(null);
  const [startTime, setStartTime] = useState(settings?.default_start_time || "08:00");

  const reloadMetrics = useCallback(() => {
    setLoadingMetrics(true);
    api.get("/l10/scorecard-metrics", { params: { include_inactive: true, folder_id: folderId }, forceFresh: true })
      .then((r) => setMetrics(r.data || []))
      .catch(() => {})
      .finally(() => setLoadingMetrics(false));
  }, [folderId]);

  const reloadRocks = useCallback(() => {
    setLoadingRocks(true);
    api.get("/l10/rocks", { params: { include_archived: true, folder_id: folderId }, forceFresh: true })
      .then((r) => setRocks(r.data || []))
      .catch(() => {})
      .finally(() => setLoadingRocks(false));
  }, [folderId]);

  useEffect(() => { reloadMetrics(); reloadRocks(); }, [reloadMetrics, reloadRocks]);

  const addMember = () => {
    if (!newMember.trim()) return;
    api.post("/l10/members", { name: newMember.trim(), folder_id: folderId }).then(() => { setNewMember(""); onMembersChanged(); }).catch(() => {});
  };

  const moveMember = (id, dir, idx) => {
    const target = members[dir === "up" ? idx - 1 : idx + 1];
    if (!target) return;
    api.put(`/l10/members/${id}`, { sort_order: target.sort_order })
      .then(() => api.put(`/l10/members/${target.id}`, { sort_order: members[idx].sort_order }))
      .then(onMembersChanged).catch(() => {});
  };

  const archiveMember = (id) => {
    api.delete(`/l10/members/${id}`).then(onMembersChanged).catch(() => {});
  };

  const addMetric = () => {
    if (!newMetric.measurable.trim()) return;
    api.post("/l10/scorecard-metrics", { ...newMetric, folder_id: folderId }).then(() => {
      setNewMetric({ who: "", measurable: "", goal: "", uom: "", goal_direction: "up" });
      reloadMetrics();
    }).catch(() => {});
  };

  const archiveMetric = (id) => {
    api.delete(`/l10/scorecard-metrics/${id}`).then(reloadMetrics).catch(() => {});
  };

  const addRock = () => {
    if (!newRock.description.trim()) return;
    api.post("/l10/rocks", { ...newRock, folder_id: folderId }).then(() => {
      setNewRock({ description: "", rock_type: "Company", owner: "", quarter_label: "" });
      reloadRocks();
    }).catch(() => {});
  };

  const archiveRock = (id) => {
    api.delete(`/l10/rocks/${id}`).then(reloadRocks).catch(() => {});
  };

  const saveSettings = () => {
    api.put("/l10/settings", { default_start_time: startTime }).then(() => onSettingsChanged()).catch(() => {});
  };

  const memberNames = members.filter((m) => m.active).map((m) => m.name);

  return (
    <div className="space-y-4">
      {/* Members */}
      <div className="rounded-xl border bg-card">
        <div className="px-4 py-3 border-b bg-muted/20">
          <h2 className="text-sm font-semibold">Members</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Names used across all meeting tabs</p>
        </div>
        <div className="p-4 space-y-2">
          <div className="flex gap-2">
            <input value={newMember} onChange={(e) => setNewMember(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addMember(); }}
              placeholder="Full name…"
              className="flex-1 border border-border rounded px-2.5 py-1.5 text-sm" />
            <button type="button" onClick={addMember}
              className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90">
              Add
            </button>
          </div>
          <div className="divide-y">
            {members.filter((m) => m.active).map((m, idx, arr) => (
              <div key={m.id} className="flex items-center gap-2 py-1.5">
                <span className="flex-1 text-sm">{m.name}</span>
                <button type="button" onClick={() => moveMember(m.id, "up", idx)} disabled={idx === 0}
                  className="p-1 rounded hover:bg-muted disabled:opacity-30"><ArrowUp size={13} /></button>
                <button type="button" onClick={() => moveMember(m.id, "down", idx)} disabled={idx === arr.length - 1}
                  className="p-1 rounded hover:bg-muted disabled:opacity-30"><ArrowDown size={13} /></button>
                <button type="button" onClick={() => archiveMember(m.id)}
                  className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-500"><Trash size={13} /></button>
              </div>
            ))}
            {members.filter((m) => m.active).length === 0 && (
              <p className="py-3 text-sm text-muted-foreground text-center">No members yet.</p>
            )}
          </div>
        </div>
      </div>

      {/* Scorecard Metrics */}
      <div className="rounded-xl border bg-card">
        <div className="px-4 py-3 border-b bg-muted/20">
          <h2 className="text-sm font-semibold">Scorecard Metrics</h2>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 p-3 border border-dashed rounded-lg">
            <select value={newMetric.who} onChange={(e) => setNewMetric((p) => ({ ...p, who: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm">
              <option value="">Who…</option>
              {memberNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <input placeholder="Measurable *" value={newMetric.measurable} onChange={(e) => setNewMetric((p) => ({ ...p, measurable: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm col-span-2 sm:col-span-1" />
            <input placeholder=">2 or >=95 or <5 or =100" value={newMetric.goal} onChange={(e) => setNewMetric((p) => ({ ...p, goal: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm" />
            <input placeholder="UOM" value={newMetric.uom} onChange={(e) => setNewMetric((p) => ({ ...p, uom: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm" />
            <div className="flex gap-2 col-span-2 sm:col-span-1">
              <select value={newMetric.goal_direction} onChange={(e) => setNewMetric((p) => ({ ...p, goal_direction: e.target.value }))}
                className="border border-border rounded px-2 py-1 text-sm flex-1">
                <option value="up">Higher is better</option>
                <option value="down">Lower is better</option>
              </select>
              <button type="button" onClick={addMetric} disabled={!newMetric.who || !newMetric.measurable.trim()}
                className="px-3 py-1 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed">
                Add
              </button>
            </div>
          </div>
          {loadingMetrics ? <Loading label="Loading metrics…" /> : (
            <div className="divide-y">
              {metrics.map((m) => {
                const whoStale = m.who && !memberNames.includes(m.who);
                if (editingMetricId === m.id) {
                  // Inline edit row
                  const whoOptions = memberNames.includes(editDraft.who)
                    ? memberNames
                    : editDraft.who
                    ? [editDraft.who, ...memberNames]
                    : memberNames;
                  return (
                    <div key={m.id} className="py-2 space-y-2">
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        <select value={editDraft.who} onChange={(e) => { setMetricSaveError(null); setEditDraft((p) => ({ ...p, who: e.target.value })); }}
                          className="border border-border rounded px-2 py-1 text-sm">
                          <option value="">Who…</option>
                          {whoOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <input placeholder="Measurable *" value={editDraft.measurable}
                          onChange={(e) => { setMetricSaveError(null); setEditDraft((p) => ({ ...p, measurable: e.target.value })); }}
                          className="border border-border rounded px-2 py-1 text-sm col-span-2 sm:col-span-1" />
                        <input placeholder=">2 or >=95 or <5 or =100" value={editDraft.goal}
                          onChange={(e) => { setMetricSaveError(null); setEditDraft((p) => ({ ...p, goal: e.target.value })); }}
                          className="border border-border rounded px-2 py-1 text-sm" />
                        <input placeholder="UOM" value={editDraft.uom}
                          onChange={(e) => { setMetricSaveError(null); setEditDraft((p) => ({ ...p, uom: e.target.value })); }}
                          className="border border-border rounded px-2 py-1 text-sm" />
                        <select value={editDraft.goal_direction}
                          onChange={(e) => { setMetricSaveError(null); setEditDraft((p) => ({ ...p, goal_direction: e.target.value })); }}
                          className="border border-border rounded px-2 py-1 text-sm col-span-2 sm:col-span-1">
                          <option value="up">Higher is better</option>
                          <option value="down">Lower is better</option>
                        </select>
                      </div>
                      {metricSaveError && (
                        <p className="text-xs text-red-600">{metricSaveError}</p>
                      )}
                      <div className="flex gap-2 justify-end">
                        <button type="button" onClick={() => { setEditingMetricId(null); setMetricSaveError(null); }}
                          className="px-3 py-1 rounded-lg border border-border text-sm hover:bg-muted">Cancel</button>
                        <button type="button" onClick={() => {
                          setMetricSaveError(null);
                          api.put(`/l10/scorecard-metrics/${m.id}`, editDraft)
                            .then(() => { reloadMetrics(); setEditingMetricId(null); })
                            .catch(() => { setMetricSaveError("Save failed — try again"); });
                        }}
                          className="px-3 py-1 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90">Save</button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={m.id} className={`flex items-center gap-2 py-1.5 ${!m.active ? "opacity-50" : ""}`}>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{m.measurable}</span>
                      {m.who && (
                        <span className="text-xs text-muted-foreground ml-2">
                          ({m.who}
                          {whoStale && (
                            <span title="WHO not in current members list" className="ml-1 text-amber-500">⚠</span>
                          )}
                          )
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground ml-2">Goal: {m.goal || "—"} {m.uom || ""} [{m.goal_direction === "up" ? "higher better" : "lower better"}]</span>
                    </div>
                    {m.active && (
                      <>
                        <button type="button" onClick={() => { setEditingMetricId(m.id); setEditDraft({ who: m.who || "", measurable: m.measurable || "", goal: m.goal || "", uom: m.uom || "", goal_direction: m.goal_direction || "up" }); }}
                          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"><PencilSimple size={13} /></button>
                        <button type="button" onClick={() => archiveMetric(m.id)}
                          className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-500"><Trash size={13} /></button>
                      </>
                    )}
                  </div>
                );
              })}
              {metrics.length === 0 && <p className="py-3 text-sm text-muted-foreground text-center">No metrics yet.</p>}
            </div>
          )}
        </div>
      </div>

      {/* Rocks Admin */}
      <div className="rounded-xl border bg-card">
        <div className="px-4 py-3 border-b bg-muted/20">
          <h2 className="text-sm font-semibold">Rocks</h2>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3 border border-dashed rounded-lg">
            <input placeholder="Rock description *" value={newRock.description}
              onChange={(e) => setNewRock((p) => ({ ...p, description: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm col-span-2" />
            <select value={newRock.rock_type} onChange={(e) => setNewRock((p) => ({ ...p, rock_type: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm">
              <option value="Company">Company Rock</option>
              <option value="Individual">Individual Rock</option>
            </select>
            <select value={newRock.owner} onChange={(e) => setNewRock((p) => ({ ...p, owner: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm">
              <option value="">Owner…</option>
              {memberNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <input placeholder="Quarter (e.g. Q3 2026)" value={newRock.quarter_label}
              onChange={(e) => setNewRock((p) => ({ ...p, quarter_label: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm col-span-2" />
            <button type="button" onClick={addRock}
              className="px-3 py-1 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90 col-span-2">
              Add Rock
            </button>
          </div>
          {loadingRocks ? <Loading label="Loading rocks…" /> : (
            <div className="divide-y">
              {rocks.map((r) => (
                <div key={r.id} className={`flex items-center gap-2 py-1.5 ${!r.active ? "opacity-50" : ""}`}>
                  <div className="flex-1 min-w-0">
                    <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded mr-1.5 ${
                      r.rock_type === "Company" ? "bg-brand/10 text-brand" : "bg-violet-50 text-violet-700"
                    }`}>{r.rock_type}</span>
                    <span className="text-sm">{r.description}</span>
                    {r.owner && <span className="text-xs text-muted-foreground ml-1.5">— {r.owner}</span>}
                    {r.quarter_label && <span className="text-xs text-muted-foreground ml-1.5">({r.quarter_label})</span>}
                  </div>
                  {r.active && (
                    <button type="button" onClick={() => archiveRock(r.id)}
                      className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-500"><Trash size={13} /></button>
                  )}
                </div>
              ))}
              {rocks.length === 0 && <p className="py-3 text-sm text-muted-foreground text-center">No rocks yet.</p>}
            </div>
          )}
        </div>
      </div>

      {/* Settings */}
      <div className="rounded-xl border bg-card">
        <div className="px-4 py-3 border-b bg-muted/20">
          <h2 className="text-sm font-semibold">Settings</h2>
        </div>
        <div className="p-4 flex items-end gap-3">
          <label className="text-sm">
            <div className="text-xs text-muted-foreground mb-1">Default meeting start time</div>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
              className="border border-border rounded px-2.5 py-1.5 text-sm" />
          </label>
          <button type="button" onClick={saveSettings}
            className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90">
            Save
          </button>
        </div>
      </div>

      {/* Data Migration — admin only */}
      {isAdmin && (
        <>
          <FinanceOperationsRestorePanel onRestored={onFinanceRestored} />
          <L10MigrationPanel />
        </>
      )}
    </div>
  );
};

// ─── Main L10 Component ───────────────────────────────────────────────────────

// Color dot for folder picker
const FOLDER_COLORS = [
  "#1a5c38","#7c3aed","#d97706","#0ea5e9","#e11d48","#64748b","#0d9488","#9333ea",
];

const MeetingHistoryTable = ({ meetings, meetingId, onSelect }) => {
  const [collapsedQuarters, setCollapsedQuarters] = useState(new Set());

  if (!meetings || meetings.length === 0) return null;

  // Group meetings by quarter (newest first)
  const currentQuarter = meetings[0] ? getQuarterLabel(meetings[0].meeting_date) : null;
  const byQuarter = [];
  const quarterMap = {};
  meetings.forEach((m) => {
    const q = getQuarterLabel(m.meeting_date);
    if (!quarterMap[q]) { quarterMap[q] = []; byQuarter.push(q); }
    quarterMap[q].push(m);
  });

  const toggleQuarter = (q) => setCollapsedQuarters((prev) => {
    const next = new Set(prev);
    if (next.has(q)) next.delete(q); else next.add(q);
    return next;
  });

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/20">
        <h2 className="text-sm font-semibold">Meeting History</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {byQuarter.length} quarter{byQuarter.length !== 1 ? "s" : ""} — click any row to view that week&apos;s meeting
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground bg-muted/10 text-left">
              <th className="py-2 px-4 font-medium">Week</th>
              <th className="py-2 px-4 font-medium">Date</th>
              <th className="py-2 px-4 font-medium">Day</th>
              <th className="py-2 px-4 font-medium w-24" />
            </tr>
          </thead>
          <tbody>
            {byQuarter.map((q) => {
              const qMeetings = quarterMap[q];
              const isCurrentQ = q === currentQuarter;
              const isCollapsed = collapsedQuarters.has(q);
              return (
                <React.Fragment key={q}>
                  <tr
                    className={`border-b cursor-pointer select-none ${
                      isCurrentQ ? "bg-emerald-50/40 hover:bg-emerald-50/60" : "bg-muted/20 hover:bg-muted/30"
                    }`}
                    onClick={() => toggleQuarter(q)}
                  >
                    <td colSpan={4} className="py-2 px-4">
                      <span className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        {isCollapsed ? <CaretDown size={12} /> : <CaretUp size={12} />}
                        {q}
                        <span className="font-normal normal-case">({qMeetings.length} meeting{qMeetings.length !== 1 ? "s" : ""})</span>
                        {isCurrentQ && (
                          <span className="ml-1 px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-semibold uppercase tracking-wide normal-case">
                            Current
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                  {!isCollapsed && qMeetings.map((m) => {
                    const isCurrent = m.id === meetingId;
                    let dayName = "";
                    try { dayName = new Date(m.meeting_date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long" }); } catch {}
                    return (
                      <tr
                        key={m.id}
                        onClick={() => onSelect(m.id)}
                        className={`border-b last:border-0 cursor-pointer transition-colors ${
                          isCurrent ? "bg-emerald-50/60 hover:bg-emerald-50" : "hover:bg-muted/30"
                        }`}
                      >
                        <td className="py-2.5 px-4 font-medium pl-8">{m.week_label}</td>
                        <td className="py-2.5 px-4 text-muted-foreground">
                          {(() => { try { return new Date(m.meeting_date + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); } catch { return m.meeting_date; } })()}
                        </td>
                        <td className="py-2.5 px-4 text-muted-foreground text-xs">{dayName}</td>
                        <td className="py-2.5 px-4 text-right">
                          {isCurrent ? (
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">Viewing</span>
                          ) : (
                            <span className="text-xs text-primary hover:underline">View</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const L10 = () => {
  const { user } = useAuth();
  const isAdmin = String(user?.role || "").toLowerCase() === "admin";
  const [tab, setTab] = useState("agenda");
  const [folders, setFolders] = useState([]);
  const [excelLoading, setExcelLoading] = useState(false);
  const [excelError, setExcelError] = useState(null);
  const [folderId, setFolderId] = useState(() => {
    const param = new URLSearchParams(window.location.search).get('folder_id');
    const parsed = param ? parseInt(param, 10) : NaN;
    return (!isNaN(parsed) && parsed > 0 && parsed !== 2) ? parsed : 1;
  });
  const [meetings, setMeetings] = useState([]);
  const [meetingId, setMeetingId] = useState(null);
  const [members, setMembers] = useState([]);
  const [settings, setSettings] = useState({ default_start_time: "08:00" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [redMetrics, setRedMetrics] = useState([]);
  const [editingDate, setEditingDate] = useState(false);
  const [dateDraft, setDateDraft] = useState("");
  const [dateSaving, setDateSaving] = useState(false);
  const [dateError, setDateError] = useState(null);

  const currentMeeting = meetings.find((m) => m.id === meetingId);

  const reloadFolders = useCallback(() => (
    api.get("/l10/folders", { forceFresh: true })
      .then((r) => setFolders((r.data || []).filter((folder) => folder.id !== 2)))
      .catch(() => {})
  ), []);

  // Load folders once and again after an admin restores a department.
  useEffect(() => { reloadFolders(); }, [reloadFolders]);

  const reloadMeetings = useCallback((folderIdOverride) => {
    const fid = folderIdOverride ?? folderId;
    api.get("/l10/meetings", { params: { folder_id: fid }, forceFresh: true })
      .then((r) => {
        const list = r.data || [];
        setMeetings(list);
        if (list.length > 0) {
          setMeetingId(list[0].id);
        } else {
          setMeetingId(null);
        }
      })
      .catch((e) => setError(e?.response?.data?.detail || e.message));
  }, [folderId]);

  const reloadMembers = useCallback(() => {
    api.get("/l10/members", { params: { folder_id: folderId }, forceFresh: true })
      .then((r) => setMembers(r.data || []))
      .catch(() => {});
  }, [folderId]);

  const reloadSettings = useCallback(() => {
    api.get("/l10/settings", { forceFresh: true })
      .then((r) => setSettings(r.data || {}))
      .catch(() => {});
  }, []);

  // Initial load
  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get("/l10/meetings", { params: { folder_id: folderId }, forceFresh: true }),
      api.get("/l10/members", { params: { folder_id: folderId }, forceFresh: true }),
      api.get("/l10/settings", { forceFresh: true }),
    ]).then(([m, mem, s]) => {
      const list = m.data || [];
      setMeetings(list);
      if (list.length > 0) setMeetingId(list[0].id);
      setMembers(mem.data || []);
      setSettings(s.data || {});
      setError(null);
    }).catch((e) => {
      setError(e?.response?.data?.detail || e.message);
    }).finally(() => setLoading(false));
  }, [folderId]);

  const switchFolder = (id) => {
    if (id === 2 || id === folderId) return;
    setFolderId(id);
    setMeetingId(null);
    setMeetings([]);
    setMembers([]);
  };

  const handleFinanceRestored = (id) => {
    reloadFolders();
    setTab("agenda");
    switchFolder(id);
  };

  const downloadExcel = async () => {
    setExcelLoading(true);
    setExcelError(null);
    try {
      const resp = await api.get("/l10/export/excel", {
        params: { folder_id: folderId, meetings: 8 },
        responseType: "blob",
      });
      const blob = new Blob([resp.data], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      // Try to get the filename from Content-Disposition header
      const cd = resp.headers?.["content-disposition"] || "";
      const match = cd.match(/filename="?([^"]+)"?/);
      a.download = match ? match[1] : `L10-export.xlsx`;
      a.href = url;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExcelError("Export failed — please try again.");
    } finally {
      setExcelLoading(false);
    }
  };

  const createMeeting = async () => {
    setCreating(true);
    try {
      const res = await api.post("/l10/meetings", {
        folder_id: folderId,
        start_time: settings.default_start_time || "08:00",
      });
      await reloadMeetings();
      if (res.data?.id) setMeetingId(res.data.id);
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    } finally {
      setCreating(false);
    }
  };

  const saveMeetingDate = async () => {
    if (!meetingId || !dateDraft) return;
    setDateSaving(true);
    setDateError(null);
    try {
      await api.put(`/l10/meetings/${meetingId}`, { meeting_date: dateDraft });
      // Refresh the meetings list but keep the same meeting selected
      const r = await api.get("/l10/meetings", { params: { folder_id: folderId }, forceFresh: true });
      setMeetings(r.data || []);
      setEditingDate(false);
    } catch (e) {
      setDateError(e?.response?.data?.detail || e.message);
    } finally {
      setDateSaving(false);
    }
  };

  if (loading) return <Loading label="Loading L10 Meeting Tracker…" />;
  if (error) return <ErrorBox message={error} />;

  const currentFolder = folders.find((f) => f.id === folderId) || { id: 1, name: "SLT", color: "#1a5c38" };

  return (
    <div className="space-y-4" data-testid="l10-page">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-3 justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">L10 Meeting Tracker</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            EOS Level 10 weekly meeting — same time, same place, same agenda.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {meetings.length > 0 && (
            <select
              value={meetingId || ""}
              onChange={(e) => setMeetingId(Number(e.target.value))}
              className="border border-border rounded-lg px-3 py-1.5 text-sm bg-white"
            >
              {(() => {
                const byQ = [];
                const qMap = {};
                meetings.forEach((m) => {
                  const q = getQuarterLabel(m.meeting_date);
                  if (!qMap[q]) { qMap[q] = []; byQ.push(q); }
                  qMap[q].push(m);
                });
                return byQ.map((q) => (
                  <optgroup key={q} label={q}>
                    {qMap[q].map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.week_label} — {fmtDate(m.meeting_date)}
                      </option>
                    ))}
                  </optgroup>
                ));
              })()}
            </select>
          )}
          <button
            type="button"
            onClick={downloadExcel}
            disabled={excelLoading}
            title="Download all tabs as Excel"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white text-sm px-3 py-1.5 hover:bg-muted disabled:opacity-50"
          >
            <DownloadSimple size={14} />
            {excelLoading ? "Exporting…" : "Excel"}
          </button>
          {excelError && (
            <span className="text-xs text-red-600">{excelError}</span>
          )}
          <button
            type="button"
            onClick={createMeeting}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground text-sm px-3 py-1.5 hover:opacity-90 disabled:opacity-50"
          >
            <Plus size={14} />
            {creating ? "Creating…" : "New Meeting"}
          </button>
        </div>
      </div>

      {/* Folder picker */}
      {folders.length > 1 && (
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Department:</span>
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => switchFolder(f.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                folderId === f.id
                  ? "text-white border-transparent shadow-sm"
                  : "bg-white text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
              }`}
              style={folderId === f.id ? { backgroundColor: f.color || "#1a5c38", borderColor: f.color || "#1a5c38" } : {}}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: folderId === f.id ? "rgba(255,255,255,0.7)" : (f.color || "#1a5c38") }}
              />
              {f.name}
            </button>
          ))}
        </div>
      )}

      {meetings.length === 0 && (
        <div className="rounded-xl border bg-card p-10 text-center">
          <CalendarBlank size={40} className="mx-auto mb-3 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No meetings yet for <strong>{currentFolder.name}</strong>. Click "New Meeting" to get started.
          </p>
        </div>
      )}

      {meetings.length > 0 && currentMeeting && (
        <>
          {/* Meeting info bar */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
            <CalendarBlank size={14} />
            {editingDate ? (
              <span className="inline-flex items-center gap-1.5">
                <input
                  type="date"
                  value={dateDraft}
                  onChange={(e) => setDateDraft(e.target.value)}
                  className="border border-border rounded px-1.5 py-0.5 text-xs bg-white"
                  data-testid="input-meeting-date"
                />
                <button
                  type="button"
                  onClick={saveMeetingDate}
                  disabled={dateSaving || !dateDraft}
                  className="inline-flex items-center gap-1 rounded bg-primary text-primary-foreground text-xs px-2 py-1 hover:opacity-90 disabled:opacity-50"
                  data-testid="button-save-meeting-date"
                >
                  <Check size={11} /> {dateSaving ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditingDate(false); setDateError(null); }}
                  className="inline-flex items-center gap-1 rounded border border-border text-xs px-2 py-1 hover:bg-muted"
                  data-testid="button-cancel-meeting-date"
                >
                  <X size={11} /> Cancel
                </button>
                {dateError && <span className="text-xs text-red-600" data-testid="text-meeting-date-error">{dateError}</span>}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => { setDateDraft((currentMeeting.meeting_date || "").slice(0, 10)); setEditingDate(true); setDateError(null); }}
                className="inline-flex items-center gap-1 hover:text-foreground"
                title="Edit meeting date"
                data-testid="button-edit-meeting-date"
              >
                <span>{fmtDate(currentMeeting.meeting_date)}</span>
                <PencilSimple size={12} />
              </button>
            )}
            <span>·</span>
            <span>Starts {fmtTime(currentMeeting.start_time)}</span>
            {folders.length > 0 && (
              <>
                <span>·</span>
                <span
                  className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full text-white"
                  style={{ backgroundColor: currentFolder.color || "#1a5c38" }}
                >
                  {currentFolder.name}
                </span>
              </>
            )}
          </div>

          {/* Tab bar */}
          <div className="flex flex-wrap gap-1 border-b pb-0 -mb-px">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  tab === t.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                }`}
              >
                <t.icon size={14} weight={tab === t.id ? "fill" : "regular"} />
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="mt-0">
            {tab === "agenda" && <AgendaTab meeting={currentMeeting} settings={settings} />}
            {tab === "checkin" && <CheckInTab meetingId={meetingId} members={members} folderId={folderId} />}
            {tab === "scorecard" && <ScorecardTab meetingId={meetingId} folderId={folderId} onRedMetrics={setRedMetrics} isAdmin={isAdmin} />}
            {tab === "rocks" && <RocksTab members={members} folderId={folderId} isAdmin={isAdmin} />}
            {tab === "headlines" && <HeadlinesTab meetingId={meetingId} members={members} folderId={folderId} />}
            {tab === "todos" && <TodosTab meetingId={meetingId} members={members} folderId={folderId} />}
            {tab === "ids" && <IDSTab meetingId={meetingId} members={members} folderId={folderId} redMetrics={redMetrics} />}
            {tab === "conclude" && <ConcludeTab meetingId={meetingId} members={members} folderId={folderId} />}
            {tab === "admin" && (
              <AdminTab
                members={members}
                onMembersChanged={reloadMembers}
                settings={settings}
                onSettingsChanged={reloadSettings}
                onFinanceRestored={handleFinanceRestored}
                folderId={folderId}
                isAdmin={isAdmin}
              />
            )}
          </div>

          {/* Previous Meetings history table */}
          {meetings.length > 1 && (
            <MeetingHistoryTable
              meetings={meetings}
              meetingId={meetingId}
              onSelect={(id) => setMeetingId(id)}
            />
          )}
        </>
      )}
    </div>
  );
};

export default L10;
