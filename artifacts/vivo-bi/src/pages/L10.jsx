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
const ScorecardTab = ({ meetingId, folderId = 1 }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    api.get("/l10/scorecard", { params: { meetings: 8, folder_id: folderId }, forceFresh: true })
      .then((r) => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const saveValue = (metricId, value, goalDirection, goalStr) => {
    if (!meetingId) return;
    let on_track = null;
    const numVal = parseFloat(value);
    const numGoal = parseFloat(goalStr);
    if (!isNaN(numVal) && !isNaN(numGoal)) {
      on_track = goalDirection === "up" ? numVal >= numGoal : numVal <= numGoal;
    }
    api.put(`/l10/scorecard/${meetingId}`, {
      values: [{ metric_id: metricId, value, on_track }]
    }).then(() => reload()).catch(() => {});
  };

  if (loading) return <Loading label="Loading scorecard…" />;
  if (!data) return null;

  const { meetings, metrics } = data;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Weekly Scorecard</h2>
          <span className="text-xs text-muted-foreground">Current week editable — prior weeks read-only</span>
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
                <tr key={metric.id} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="py-2 px-3 sticky left-0 bg-white z-10 border-r text-muted-foreground text-xs">{metric.who || "—"}</td>
                  <td className="py-2 px-3 sticky left-[80px] bg-white z-10 border-r font-medium">{metric.measurable}</td>
                  <td className="py-2 px-3 text-xs">
                    <span className="flex items-center gap-0.5">
                      {metric.goal_direction === "up" ? <ArrowUp size={11} className="text-emerald-600" /> : <ArrowDown size={11} className="text-red-500" />}
                      {metric.goal || "—"}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">{metric.uom || "—"}</td>
                  {meetings.map((m) => {
                    const cell = metric.values?.[m.id] || { value: null, on_track: null };
                    const isCurrent = m.id === meetingId;
                    const bg = cell.on_track === true ? "bg-emerald-50 text-emerald-800" :
                               cell.on_track === false ? "bg-red-50 text-red-700" : "";
                    return (
                      <td key={m.id} className={`py-1.5 px-2 text-center ${isCurrent ? "bg-emerald-50/30" : ""}`}>
                        {isCurrent ? (
                          <ScorecardCell
                            value={cell.value}
                            onTrack={cell.on_track}
                            onSave={(v) => saveValue(metric.id, v, metric.goal_direction, metric.goal)}
                          />
                        ) : (
                          <span className={`rounded px-1.5 py-0.5 text-xs font-mono ${bg}`}>
                            {cell.value ?? "—"}
                          </span>
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

const ScorecardCell = ({ value, onTrack, onSave }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const inputRef = useRef(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  const commit = () => { setEditing(false); onSave(draft); };
  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        className="w-16 border border-primary/40 rounded px-1 py-0.5 text-xs text-center bg-white outline-none"
      />
    );
  }
  const bg = onTrack === true ? "bg-emerald-100 text-emerald-800" :
             onTrack === false ? "bg-red-100 text-red-700" : "bg-muted/40";
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={`rounded px-2 py-0.5 text-xs font-mono cursor-pointer hover:opacity-80 min-w-[48px] ${bg}`}
    >
      {value ?? "—"}
    </button>
  );
};

// ─── Rocks Tab ───────────────────────────────────────────────────────────────
const RocksTab = ({ members, folderId = 1 }) => {
  const [rocks, setRocks] = useState([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    api.get("/l10/rocks", { params: { folder_id: folderId }, forceFresh: true })
      .then((r) => setRocks(r.data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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

  const RockRow = ({ rock }) => (
    <div className="flex items-start gap-3 py-2.5 border-b last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
            rock.rock_type === "Company" ? "bg-brand/10 text-brand" : "bg-violet-50 text-violet-700"
          }`}>{rock.rock_type}</span>
          <span className="text-xs text-muted-foreground">{rock.owner || "—"}</span>
        </div>
        <div className="mt-0.5 font-medium text-sm">{rock.description}</div>
        {rock.results && (
          <div className="mt-0.5 text-xs text-muted-foreground">{rock.results}</div>
        )}
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
  }, []);

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
      <td className="py-2 px-3">
        <button type="button" onClick={() => toggle(todo)}
          className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
            todo.status === "done" ? "bg-emerald-500 border-emerald-500 text-white" : "border-border"
          }`}>
          {todo.status === "done" && <Check size={10} weight="bold" />}
        </button>
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
const IDSTab = ({ meetingId, members, folderId = 1 }) => {
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
              {rows.map((row, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="py-1.5 px-3 text-muted-foreground text-xs">{i + 1}</td>
                  <td className="py-1.5 px-3">
                    <InlineEdit value={row.issue} onSave={(v) => update(i, "issue", v)} placeholder="Describe the issue…" className="w-full" />
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
  }, [meetingId]);

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

// ─── Admin Tab ────────────────────────────────────────────────────────────────
const AdminTab = ({ members, onMembersChanged, settings, onSettingsChanged, folderId = 1 }) => {
  const [metrics, setMetrics] = useState([]);
  const [rocks, setRocks] = useState([]);
  const [loadingMetrics, setLoadingMetrics] = useState(true);
  const [loadingRocks, setLoadingRocks] = useState(true);

  const [newMember, setNewMember] = useState("");
  const [newMetric, setNewMetric] = useState({ who: "", measurable: "", goal: "", uom: "", goal_direction: "up" });
  const [newRock, setNewRock] = useState({ description: "", rock_type: "Company", owner: "", quarter_label: "" });
  const [startTime, setStartTime] = useState(settings?.default_start_time || "08:00");

  const reloadMetrics = useCallback(() => {
    setLoadingMetrics(true);
    api.get("/l10/scorecard-metrics", { params: { include_inactive: true, folder_id: folderId }, forceFresh: true })
      .then((r) => setMetrics(r.data || []))
      .catch(() => {})
      .finally(() => setLoadingMetrics(false));
  }, []);

  const reloadRocks = useCallback(() => {
    setLoadingRocks(true);
    api.get("/l10/rocks", { params: { include_archived: true, folder_id: folderId }, forceFresh: true })
      .then((r) => setRocks(r.data || []))
      .catch(() => {})
      .finally(() => setLoadingRocks(false));
  }, []);

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
            <input placeholder="Who" value={newMetric.who} onChange={(e) => setNewMetric((p) => ({ ...p, who: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm" />
            <input placeholder="Measurable *" value={newMetric.measurable} onChange={(e) => setNewMetric((p) => ({ ...p, measurable: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm col-span-2 sm:col-span-1" />
            <input placeholder="Goal" value={newMetric.goal} onChange={(e) => setNewMetric((p) => ({ ...p, goal: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm" />
            <input placeholder="UOM" value={newMetric.uom} onChange={(e) => setNewMetric((p) => ({ ...p, uom: e.target.value }))}
              className="border border-border rounded px-2 py-1 text-sm" />
            <div className="flex gap-2 col-span-2 sm:col-span-1">
              <select value={newMetric.goal_direction} onChange={(e) => setNewMetric((p) => ({ ...p, goal_direction: e.target.value }))}
                className="border border-border rounded px-2 py-1 text-sm flex-1">
                <option value="up">Higher is better</option>
                <option value="down">Lower is better</option>
              </select>
              <button type="button" onClick={addMetric}
                className="px-3 py-1 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90 whitespace-nowrap">
                Add
              </button>
            </div>
          </div>
          {loadingMetrics ? <Loading label="Loading metrics…" /> : (
            <div className="divide-y">
              {metrics.map((m) => (
                <div key={m.id} className={`flex items-center gap-2 py-1.5 ${!m.active ? "opacity-50" : ""}`}>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{m.measurable}</span>
                    {m.who && <span className="text-xs text-muted-foreground ml-2">({m.who})</span>}
                    <span className="text-xs text-muted-foreground ml-2">Goal: {m.goal || "—"} {m.uom || ""} [{m.goal_direction === "up" ? "higher better" : "lower better"}]</span>
                  </div>
                  {m.active && (
                    <button type="button" onClick={() => archiveMetric(m.id)}
                      className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-500"><Trash size={13} /></button>
                  )}
                </div>
              ))}
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
    </div>
  );
};

// ─── Main L10 Component ───────────────────────────────────────────────────────

// Color dot for folder picker
const FOLDER_COLORS = [
  "#1a5c38","#7c3aed","#d97706","#0ea5e9","#e11d48","#64748b","#0d9488","#9333ea",
];

const MeetingHistoryTable = ({ meetings, meetingId, onSelect }) => {
  if (!meetings || meetings.length === 0) return null;
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/20">
        <h2 className="text-sm font-semibold">Previous Meetings</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Click any row to view that week's meeting</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground bg-muted/10 text-left">
              <th className="py-2 px-4 font-medium">Week</th>
              <th className="py-2 px-4 font-medium">Date</th>
              <th className="py-2 px-4 font-medium">Day</th>
              <th className="py-2 px-4 font-medium w-24"></th>
            </tr>
          </thead>
          <tbody>
            {meetings.map((m) => {
              const isCurrent = m.id === meetingId;
              let dayName = "";
              try {
                dayName = new Date(m.meeting_date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "long" });
              } catch {}
              return (
                <tr
                  key={m.id}
                  onClick={() => onSelect(m.id)}
                  className={`border-b last:border-0 cursor-pointer transition-colors ${
                    isCurrent
                      ? "bg-emerald-50/60 hover:bg-emerald-50"
                      : "hover:bg-muted/30"
                  }`}
                >
                  <td className="py-2.5 px-4 font-medium">{m.week_label}</td>
                  <td className="py-2.5 px-4 text-muted-foreground">
                    {(() => {
                      try {
                        return new Date(m.meeting_date + "T00:00:00").toLocaleDateString("en-GB", {
                          day: "numeric", month: "short", year: "numeric"
                        });
                      } catch { return m.meeting_date; }
                    })()}
                  </td>
                  <td className="py-2.5 px-4 text-muted-foreground text-xs">{dayName}</td>
                  <td className="py-2.5 px-4 text-right">
                    {isCurrent ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                        Viewing
                      </span>
                    ) : (
                      <span className="text-xs text-primary hover:underline">View</span>
                    )}
                  </td>
                </tr>
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
  const [tab, setTab] = useState("agenda");
  const [folders, setFolders] = useState([]);
  const [folderId, setFolderId] = useState(1);
  const [meetings, setMeetings] = useState([]);
  const [meetingId, setMeetingId] = useState(null);
  const [members, setMembers] = useState([]);
  const [settings, setSettings] = useState({ default_start_time: "08:00" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const currentMeeting = meetings.find((m) => m.id === meetingId);

  // Load folders once
  useEffect(() => {
    api.get("/l10/folders", { forceFresh: true })
      .then((r) => setFolders(r.data || []))
      .catch(() => {});
  }, []);

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
    if (id === folderId) return;
    setFolderId(id);
    setMeetingId(null);
    setMeetings([]);
    setMembers([]);
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
        <div className="flex items-center gap-2">
          {meetings.length > 0 && (
            <select
              value={meetingId || ""}
              onChange={(e) => setMeetingId(Number(e.target.value))}
              className="border border-border rounded-lg px-3 py-1.5 text-sm bg-white"
            >
              {meetings.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.week_label} — {fmtDate(m.meeting_date)}
                </option>
              ))}
            </select>
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
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CalendarBlank size={14} />
            <span>{fmtDate(currentMeeting.meeting_date)}</span>
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
            {tab === "scorecard" && <ScorecardTab meetingId={meetingId} folderId={folderId} />}
            {tab === "rocks" && <RocksTab members={members} folderId={folderId} />}
            {tab === "headlines" && <HeadlinesTab meetingId={meetingId} members={members} folderId={folderId} />}
            {tab === "todos" && <TodosTab meetingId={meetingId} members={members} folderId={folderId} />}
            {tab === "ids" && <IDSTab meetingId={meetingId} members={members} folderId={folderId} />}
            {tab === "conclude" && <ConcludeTab meetingId={meetingId} members={members} folderId={folderId} />}
            {tab === "admin" && (
              <AdminTab
                members={members}
                onMembersChanged={reloadMembers}
                settings={settings}
                onSettingsChanged={reloadSettings}
                folderId={folderId}
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
