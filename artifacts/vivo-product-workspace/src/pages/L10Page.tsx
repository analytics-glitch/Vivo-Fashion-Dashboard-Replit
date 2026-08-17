import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  Flag,
  GripVertical,
  ListChecks,
  Save,
  Target,
  X,
} from 'lucide-react';
import {
  getGetWorkspaceL10MeetingQueryKey,
  getListWorkspaceL10MeetingsQueryKey,
  useCreateWorkspaceL10Issue,
  useCreateWorkspaceL10TodoFromIssue,
  useEndWorkspaceL10Meeting,
  useGetWorkspaceL10Meeting,
  useListWorkspaceL10Meetings,
  useReorderWorkspaceL10Issues,
  useUpdateWorkspaceL10Checkins,
  useUpdateWorkspaceL10CascadingMessage,
  useUpdateWorkspaceL10Headlines,
  useUpdateWorkspaceL10Issue,
  useUpdateWorkspaceL10Ratings,
  useUpdateWorkspaceL10Rock,
  useUpdateWorkspaceL10ScorecardEntry,
  useUpdateWorkspaceL10Todos,
} from '@workspace/api-client-react';
import type {
  WorkspaceL10Checkin,
  WorkspaceL10Headline,
  WorkspaceL10Issue,
  WorkspaceL10Meeting,
  WorkspaceL10MeetingDetail,
  WorkspaceL10Rating,
  WorkspaceL10Rock,
  WorkspaceL10ScorecardMetric,
  WorkspaceL10Todo,
} from '@workspace/api-client-react';

const AGENDA = [
  { key: 'check-in', label: 'Check-In', durationMinutes: 5 },
  { key: 'scorecard', label: 'Scorecard', durationMinutes: 5 },
  { key: 'rocks', label: 'Rocks', durationMinutes: 5 },
  { key: 'headlines', label: 'Headlines', durationMinutes: 5 },
  { key: 'todos', label: "To Do's", durationMinutes: 5 },
  { key: 'ids', label: 'IDS', durationMinutes: 60 },
  { key: 'conclude', label: 'Conclude', durationMinutes: 5 },
] as const;

const dateLabel = (value: string, weekday = true) => {
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', weekday
    ? { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' }
    : { day: '2-digit', month: 'short', year: 'numeric' });
};

const shortDate = (value?: string | null) => value ? dateLabel(value, false) : '—';

const displayTime = (value: string) => {
  const match = value.match(/(\d{1,2}):(\d{2})/);
  if (!match) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour >= 12 ? 'PM' : 'AM'}`;
};

const meetingStart = (meeting: WorkspaceL10Meeting) => {
  const time = meeting.startTime.match(/\d{1,2}:\d{2}/)?.[0] || '11:30';
  const parsed = new Date(`${meeting.meetingDate.slice(0, 10)}T${time}:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const agendaWithTimes = AGENDA.reduce<Array<typeof AGENDA[number] & { start: string; end: string }>>((items, item) => {
  const previous = items[items.length - 1];
  const [hour, minute] = previous ? previous.end.split(':').map(Number) : [11, 30];
  const startMinutes = hour * 60 + minute;
  const endMinutes = startMinutes + item.durationMinutes;
  const format = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  items.push({ ...item, start: format(startMinutes), end: format(endMinutes) });
  return items;
}, []);

type L10ScorecardMetricWithKey = WorkspaceL10ScorecardMetric & { metricKey?: string | null };
type LiveScorecardMetric = { value: number; uom: string; source: 'live' };
type LiveScorecardResponse = { weekStart: string; metrics: Record<string, LiveScorecardMetric> };

const scorecardGoalStatus = (value: number | null, goal: string) => {
  if (value == null || !Number.isFinite(value)) return null;
  const normalized = goal.trim().replace(/%/g, '');
  const range = normalized.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/);
  if (range) return value >= Number(range[1]) && value <= Number(range[2]);
  if (/^all\s+\d+/i.test(goal)) return value >= 100;
  const operator = normalized.match(/^(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)/);
  if (!operator) return null;
  const target = Number(operator[2]);
  if (operator[1] === '>=') return value >= target;
  if (operator[1] === '<=') return value <= target;
  if (operator[1] === '>') return value > target;
  if (operator[1] === '<') return value < target;
  return value === target;
};

function L10Loading() {
  return <section className="page l10-page"><div className="l10-skeleton l10-skeleton-heading" /><div className="l10-skeleton l10-skeleton-banner" /><div className="l10-skeleton l10-skeleton-panel" /><div className="l10-skeleton l10-skeleton-panel short" /></section>;
}

function L10Error({ onRetry, detail = false }: { onRetry: () => void; detail?: boolean }) {
  return <section className="page l10-page"><div className="l10-empty l10-error"><CircleAlert size={22} /><h2>{detail ? 'This meeting could not be opened' : 'The L10 room is unavailable'}</h2><p>We could not reach the workspace service. Your meeting notes are safe.</p><button className="button button-dark" onClick={onRetry} data-testid="button-retry-l10">Try again</button></div></section>;
}

function MeetingHome() {
  const meetings = useListWorkspaceL10Meetings({ query: { queryKey: getListWorkspaceL10MeetingsQueryKey() } });
  const [, setLocation] = useLocation();
  const orderedMeetings = useMemo(() => [...(meetings.data || [])].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || String(b.meetingDate).localeCompare(String(a.meetingDate))), [meetings.data]);
  const current = orderedMeetings.find((meeting) => meeting.isCurrent);
  const archive = orderedMeetings.filter((meeting) => !meeting.isCurrent);
  if (meetings.isLoading) return <L10Loading />;
  if (meetings.isError) return <L10Error onRetry={() => meetings.refetch()} />;
  return (
    <section className="page l10-page l10-home">
      <div className="page-heading l10-heading"><div><div className="eyebrow">Product department / EOS operating room</div><h1>L10 Meeting</h1><p>A focused weekly room for clear owners, honest numbers, and the next right action.</p></div><div className="l10-heading-mark" aria-hidden="true"><ListChecks size={25} /><span>90 MIN<br />MONDAYS</span></div></div>
      {current ? <section className="l10-current-card" aria-labelledby="current-meeting-title"><div className="l10-current-copy"><div className="eyebrow gold-eyebrow">Current Monday</div><h2 id="current-meeting-title">{current.weekLabel}</h2><p className="l10-current-date">{dateLabel(current.meetingDate)} · {displayTime(current.startTime)}–{displayTime(current.endTime)}</p><div className="l10-meta-line"><Clock3 size={15} /> {current.durationMinutes || 90} minutes <span>·</span> {current.location}</div><button className="button button-gold" onClick={() => setLocation(`/product-workspace/l10/${current.id}`)} data-testid="button-open-current-l10">Open live meeting <ArrowRight size={16} /></button></div><div className="l10-current-agenda"><span className="eyebrow">Today's cadence</span>{agendaWithTimes.map((item) => <div className="l10-agenda-mini-row" key={item.key}><span className="mono">{item.start}</span><strong>{item.label}</strong><span>{item.durationMinutes}m</span></div>)}</div></section> : <div className="l10-empty"><Target size={22} /><h2>No current Monday meeting</h2><p>When the next product room is scheduled, it will appear here.</p></div>}
      <div className="l10-section-title"><div><span className="eyebrow">Meeting archive</span><h2>Previous rooms</h2></div><span className="mono">{archive.length} {archive.length === 1 ? 'meeting' : 'meetings'}</span></div>
      {archive.length ? <div className="l10-archive-grid">{archive.map((meeting) => <Link className="l10-archive-card" href={`/product-workspace/l10/${meeting.id}`} key={meeting.id}><div className="l10-archive-number">{String(meeting.id).padStart(2, '0')}</div><div className="l10-archive-copy"><span className="eyebrow">{shortDate(meeting.meetingDate)}</span><h3>{meeting.weekLabel}</h3><p>{displayTime(meeting.startTime)}–{displayTime(meeting.endTime)} <span>·</span> {meeting.location}</p></div><ArrowRight size={17} /></Link>)}</div> : <div className="l10-empty l10-empty-inline"><FileText size={20} /><p>Archived meetings will stay here as the team builds its cadence.</p></div>}
    </section>
  );
}

function ElapsedTimer({ meeting }: { meeting: WorkspaceL10Meeting }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const elapsedSeconds = Math.max(0, Math.floor((now - meetingStart(meeting).getTime()) / 1000));
  const elapsedMinutes = elapsedSeconds / 60;
  const overtime = elapsedMinutes > 90;
  const progress = Math.min(100, (elapsedMinutes / 90) * 100);
  return <aside className={`l10-timer ${overtime ? 'is-overtime' : ''}`} aria-label="Elapsed meeting timer"><div className="l10-timer-top"><span className="eyebrow">{overtime ? 'Overtime' : 'Elapsed'}</span><Clock3 size={16} /></div><strong>{String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}<small>:</small>{String(elapsedSeconds % 60).padStart(2, '0')}</strong><div className="l10-timer-track"><span style={{ width: `${progress}%` }} /></div><div className="l10-timer-foot"><span>{overtime ? `${Math.floor(elapsedMinutes - 90)}m overtime` : '90 minute room'}</span><b>{Math.round(progress)}%</b></div></aside>;
}

function CollapsibleSection({ number, title, duration, timestamp, open, onToggle, children }: { number: number; title: string; duration: number; timestamp: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = `l10-${title.toLowerCase().replaceAll(' ', '-').replaceAll("'", '')}`;
  return <section className={`l10-section ${open ? 'is-open' : ''}`} id={id}><button className="l10-section-header" onClick={onToggle} aria-expanded={open} data-testid={`button-toggle-l10-${id}`}><span className="l10-section-index">{String(number).padStart(2, '0')}</span><span className="l10-section-heading"><strong>{title}</strong><small>{timestamp} · {duration} min</small></span>{open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>{open && <div className="l10-section-body">{children}</div>}</section>;
}

function CheckInSection({ meetingId, rows, onSaved, readOnly }: { meetingId: number; rows: WorkspaceL10Checkin[]; onSaved: () => void; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const save = useUpdateWorkspaceL10Checkins({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); onSaved(); } } });
  const [drafts, setDrafts] = useState(rows);
  const initializedFor = useRef<number | null>(null);
  useEffect(() => { if (initializedFor.current !== meetingId) { initializedFor.current = meetingId; setDrafts(rows); } }, [meetingId, rows]);
  return <div><div className="l10-section-intro"><p>One good thing personally, one good thing professionally. Keep it human and keep it moving.</p><button className="button button-dark" onClick={() => save.mutate({ meetingId, data: { rows: drafts } })} disabled={readOnly || save.isPending}><Save size={14} /> {save.isPending ? 'Saving…' : 'Save check-ins'}</button></div><div className="l10-checkin-grid">{drafts.map((row, index) => <div className="l10-checkin-card" key={row.id}><div className="l10-person"><span className="avatar l10-avatar">{row.memberName.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</span><strong>{row.memberName}</strong><span className="mono">0{index + 1}</span></div><label>Personal good news<textarea disabled={readOnly} value={row.personalGoodNews} onChange={(event) => setDrafts((current) => current.map((item) => item.id === row.id ? { ...item, personalGoodNews: event.target.value } : item))} /></label><label>Professional good news<textarea disabled={readOnly} value={row.professionalGoodNews} onChange={(event) => setDrafts((current) => current.map((item) => item.id === row.id ? { ...item, professionalGoodNews: event.target.value } : item))} /></label></div>)}</div>{!drafts.length && <div className="l10-empty l10-empty-inline"><p>No check-in rows are assigned to this meeting.</p></div>}</div>;
}

function ScorecardRow({ meetingId, metric, liveMetric, onSaved, onDropToIssues, readOnly }: { meetingId: number; metric: L10ScorecardMetricWithKey; liveMetric?: LiveScorecardMetric; onSaved: () => void; onDropToIssues: (metric: L10ScorecardMetricWithKey) => void; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const saveMetric = useUpdateWorkspaceL10ScorecardEntry({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); onSaved(); } } });
  const isLive = liveMetric != null;
  const shownValue: number | null = liveMetric?.value ?? metric.thisWeek ?? null;
  const [value, setValue] = useState(shownValue == null ? '' : String(shownValue));
  const [onTrack, setOnTrack] = useState(scorecardGoalStatus(shownValue, metric.goal) ?? metric.onTrack !== false);
  useEffect(() => {
    const nextValue: number | null = liveMetric?.value ?? metric.thisWeek ?? null;
    setValue(nextValue == null ? '' : String(nextValue));
    setOnTrack(scorecardGoalStatus(nextValue, metric.goal) ?? metric.onTrack !== false);
  }, [liveMetric?.value, metric.thisWeek, metric.onTrack, metric.goal]);
  return <div className={`l10-scorecard-row ${isLive ? 'is-live' : ''}`}><div className="l10-scorecard-measure"><span className="eyebrow">{metric.owner}</span><strong><i className="l10-live-dot-small" aria-hidden="true" />{metric.measurable}</strong><small>Goal {metric.goal} {metric.uom}</small></div><div className="l10-scorecard-value"><label>This week<input className={isLive ? 'is-live-value' : ''} disabled={readOnly || isLive} type="number" value={value} onChange={(event) => setValue(event.target.value)} /></label><span>{metric.uom}</span>{isLive && <span className="l10-live-badge">Live</span>}</div><div className="l10-scorecard-status"><span className="mono">Status</span><button disabled={readOnly || isLive} className={`l10-track-toggle ${onTrack ? 'is-on-track' : 'is-off-track'}`} onClick={() => setOnTrack((current) => !current)} aria-pressed={onTrack}><i />{onTrack ? 'On Track' : 'Off Track'}</button></div><div className="l10-scorecard-actions">{isLive ? <span className="l10-live-source">Auto-populated</span> : <button className="button button-quiet" disabled={readOnly || saveMetric.isPending} onClick={() => saveMetric.mutate({ meetingId, metricId: metric.id, data: { value: value === '' ? null : Number(value), onTrack } })}><Check size={14} /> Save</button>}{!onTrack && <button className="l10-drop-issue" disabled={readOnly} onClick={() => onDropToIssues({ ...metric, thisWeek: value === '' ? null : Number(value), onTrack })}><Flag size={13} /> Drop to Issues</button>}</div></div>;
}

function ScorecardSection({ meetingId, metrics, liveMetrics, onSaved, onDropToIssues, readOnly }: { meetingId: number; metrics: L10ScorecardMetricWithKey[]; liveMetrics: Record<string, LiveScorecardMetric>; onSaved: () => void; onDropToIssues: (metric: L10ScorecardMetricWithKey) => void; readOnly: boolean }) {
  return <div className="l10-scorecard">{metrics.length ? metrics.map((metric) => <ScorecardRow key={metric.id} meetingId={meetingId} metric={metric} liveMetric={metric.metricKey ? liveMetrics[metric.metricKey] : undefined} onSaved={onSaved} onDropToIssues={onDropToIssues} readOnly={readOnly} />) : <div className="l10-empty l10-empty-inline"><p>No scorecard measures are set for this meeting.</p></div>}</div>;
}

function RocksSection({ meetingId, rocks, onSaved, readOnly }: { meetingId: number; rocks: WorkspaceL10Rock[]; onSaved: () => void; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const updateRock = useUpdateWorkspaceL10Rock({ mutation: { onSuccess: () => { onSaved(); queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); } } });
  return <div className="l10-rock-list">{rocks.length ? rocks.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((rock) => <div className={`l10-rock-row ${rock.status === 'Done' ? 'is-done' : ''}`} key={rock.id}><div className="l10-rock-copy"><span className="l10-rock-check">{rock.status === 'Done' ? <Check size={14} /> : <span />}</span><strong>{rock.description}</strong><small>{rock.owner}</small></div><div className="l10-rock-statuses">{(['On Track', 'Off Track', 'Done'] as const).map((status) => <button key={status} disabled={readOnly || updateRock.isPending} className={`l10-rock-status ${status === rock.status ? `is-${status.toLowerCase().replace(' ', '-')}` : ''}`} onClick={() => updateRock.mutate({ rockId: rock.id, data: { status } })}>{status}</button>)}</div></div>) : <div className="l10-empty l10-empty-inline"><p>No rocks are on the board for this meeting.</p></div>}</div>;
}

function HeadlineSection({ meetingId, detail, onSaved, readOnly }: { meetingId: number; detail: WorkspaceL10MeetingDetail; onSaved: () => void; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const save = useUpdateWorkspaceL10Headlines({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); onSaved(); } } });
  const [rows, setRows] = useState<WorkspaceL10Headline[]>(detail.headlines);
  useEffect(() => setRows(detail.headlines), [detail.headlines]);
  const add = () => setRows((current) => [...current, { id: 0, headline: '', headlineDate: detail.meeting.meetingDate, addedBy: detail.teamMembers[0] || '', needsDiscussion: false, sortOrder: current.length }]);
  const update = (id: number, patch: Partial<WorkspaceL10Headline>, index: number) => setRows((current) => current.map((row, rowIndex) => (row.id === id && (id > 0 || rowIndex === index) ? { ...row, ...patch } : row)));
  return <div><div className="l10-section-intro"><p>Share customer and employee news. Flag anything that needs the room's attention.</p><div className="l10-inline-actions"><button className="button button-quiet" onClick={add} disabled={readOnly}><span>+</span> Add headline</button><button className="button button-dark" disabled={readOnly || save.isPending} onClick={() => save.mutate({ meetingId, data: { rows } })}><Save size={14} /> {save.isPending ? 'Saving…' : 'Save headlines'}</button></div></div><div className="l10-data-table"><div className="l10-data-row l10-data-head"><span>#</span><span>Headline</span><span>Date</span><span>Added By</span><span>Discussion</span><span /></div>{rows.map((row, index) => <div className="l10-data-row" key={`${row.id}-${index}`}><span className="mono">{index + 1}</span><input disabled={readOnly} value={row.headline} placeholder="Add a headline…" onChange={(event) => update(row.id, { headline: event.target.value }, index)} /><input disabled={readOnly} type="date" value={row.headlineDate?.slice(0, 10) || ''} onChange={(event) => update(row.id, { headlineDate: event.target.value }, index)} /><select disabled={readOnly} value={row.addedBy} onChange={(event) => update(row.id, { addedBy: event.target.value }, index)}><option value="">Select</option>{[...new Set([...detail.teamMembers, row.addedBy].filter(Boolean))].map((name) => <option key={name}>{name}</option>)}</select><button className={`l10-discussion-toggle ${row.needsDiscussion ? 'is-active' : ''}`} disabled={readOnly} onClick={() => update(row.id, { needsDiscussion: !row.needsDiscussion }, index)}>{row.needsDiscussion ? <><Flag size={13} /> Drop to Issues ↓</> : 'No discussion'}</button><button className="icon-button" disabled={readOnly} onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))} aria-label="Remove headline"><X size={15} /></button></div>)}</div></div>;
}

function TodoSection({ meetingId, detail, onSaved, readOnly }: { meetingId: number; detail: WorkspaceL10MeetingDetail; onSaved: () => void; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const save = useUpdateWorkspaceL10Todos({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); onSaved(); } } });
  const [rows, setRows] = useState<WorkspaceL10Todo[]>(detail.todos);
  useEffect(() => setRows(detail.todos), [detail.todos]);
  const owners = (row: WorkspaceL10Todo) => [...new Set([...detail.teamMembers, row.owner].filter(Boolean))];
  const add = () => setRows((current) => [...current, { id: 0, description: '', openDate: detail.meeting.meetingDate, owner: detail.teamMembers[0] || '', status: 'Not Done' }]);
  const update = (index: number, patch: Partial<WorkspaceL10Todo>) => setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  const stat = detail.todosStat;
  return <div><div className="l10-todo-stat"><strong>{stat.completedOnTime} of {stat.total}</strong><span>To Do's from last week completed on time <b>(goal: 90%)</b></span></div><div className="l10-section-intro"><p>Keep the next actions small, owned, and visible.</p><div className="l10-inline-actions"><button className="button button-quiet" onClick={add} disabled={readOnly}><span>+</span> Add To Do</button><button className="button button-dark" disabled={readOnly || save.isPending} onClick={() => save.mutate({ meetingId, data: { rows } })}><Save size={14} /> {save.isPending ? 'Saving…' : 'Save To Do’s'}</button></div></div><div className="l10-data-table l10-todo-table"><div className="l10-data-row l10-data-head"><span>To Do</span><span>Open Date</span><span>Owner</span><span>Status</span><span /></div>{rows.map((row, index) => <div className={`l10-data-row ${row.status === 'Done' ? 'is-done' : ''}`} key={`${row.id}-${index}`}><input className="l10-todo-description" disabled={readOnly} value={row.description} placeholder="Describe the next action…" onChange={(event) => update(index, { description: event.target.value })} /><input disabled={readOnly} type="date" value={row.openDate?.slice(0, 10) || ''} onChange={(event) => update(index, { openDate: event.target.value })} /><select disabled={readOnly} value={row.owner} onChange={(event) => update(index, { owner: event.target.value })}><option value="">Select owner</option>{owners(row).map((name) => <option key={name}>{name}</option>)}</select><button className={`l10-status-button ${row.status === 'Done' ? 'is-done' : ''}`} disabled={readOnly} onClick={() => update(index, { status: row.status === 'Done' ? 'Not Done' : 'Done' })}>{row.status}</button><button className="icon-button" disabled={readOnly} onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))} aria-label="Remove To Do"><X size={15} /></button></div>)}</div></div>;
}

function IssueRow({ issue, index, onResolve, onTodo, readOnly, draggable, onDragStart, onDrop }: { issue: WorkspaceL10Issue; index: number; onResolve: (issue: WorkspaceL10Issue) => void; onTodo: (issue: WorkspaceL10Issue) => void; readOnly: boolean; draggable: boolean; onDragStart?: () => void; onDrop?: () => void }) {
  return <div className="l10-issue-row" draggable={draggable && !readOnly} onDragStart={onDragStart} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><span className="l10-issue-drag">{draggable && <GripVertical size={15} />}</span><span className="mono">{index + 1}</span><span className="l10-issue-copy"><strong>{issue.issue}</strong>{issue.resolutionNotes && <small>{issue.resolutionNotes}</small>}</span><span>{issue.raisedBy}</span><span className="l10-priority">P{issue.priority}</span>{issue.issueType === 'resolved' ? <span className="l10-resolved-note"><Check size={14} /> Resolved</span> : <div className="l10-issue-actions"><button className="button button-quiet" disabled={readOnly} onClick={() => onTodo(issue)}>Create To Do</button><button className="button button-dark" disabled={readOnly} onClick={() => onResolve(issue)}>Mark Resolved</button></div>}</div>;
}

function IDSSection({ meetingId, issues, onSaved, readOnly }: { meetingId: number; issues: WorkspaceL10Issue[]; onSaved: () => void; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const reorder = useReorderWorkspaceL10Issues({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); onSaved(); } } });
  const resolve = useUpdateWorkspaceL10Issue({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); onSaved(); } } });
  const createTodo = useCreateWorkspaceL10TodoFromIssue({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); onSaved(); } } });
  const [parkingOpen, setParkingOpen] = useState(false);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const active = issues.filter((issue) => issue.issueType === 'active').sort((a, b) => a.sortOrder - b.sortOrder);
  const parking = issues.filter((issue) => issue.issueType === 'parking').sort((a, b) => a.sortOrder - b.sortOrder);
  const resolved = issues.filter((issue) => issue.issueType === 'resolved').sort((a, b) => a.sortOrder - b.sortOrder);
  const reorderActive = (targetId: number) => {
    if (draggedId == null || draggedId === targetId) return;
    const next = [...active];
    const from = next.findIndex((row) => row.id === draggedId);
    const to = next.findIndex((row) => row.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    reorder.mutate({ meetingId, data: { rows: next.map((row, sortOrder) => ({ ...row, sortOrder })) } });
    setDraggedId(null);
  };
  const markResolved = (issue: WorkspaceL10Issue) => {
    const resolutionNotes = window.prompt('Resolution note (optional):', '') ?? '';
    resolve.mutate({ issueId: issue.id, data: { action: 'resolve', resolutionNotes } });
  };
  return <div className="l10-ids"><div className="l10-section-intro"><p>Get to the root, decide the next move, and move on. Drag active issues to prioritise the room.</p></div><div className="l10-ids-subsection"><div className="l10-subsection-heading"><div><span className="eyebrow">Active Issues</span><h3>What needs the room now</h3></div><span className="mono">{active.length} active</span></div><div className="l10-issue-list">{active.map((issue, index) => <IssueRow key={issue.id} issue={issue} index={index} onResolve={markResolved} onTodo={(row) => createTodo.mutate({ issueId: row.id })} readOnly={readOnly} draggable onDragStart={() => setDraggedId(issue.id)} onDrop={() => reorderActive(issue.id)} />)}{!active.length && <div className="l10-empty l10-empty-inline"><p>No active issues. Keep the room clear.</p></div>}</div></div><div className="l10-ids-subsection l10-collapsed-subsection"><button className="l10-subsection-toggle" onClick={() => setParkingOpen((current) => !current)}><span><span className="eyebrow">Long-Term Issues (Parking Lot)</span><strong>Things outside the 90-day cycle — park it here and be free for now.</strong></span>{parkingOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>{parkingOpen && <div className="l10-issue-list">{parking.map((issue, index) => <IssueRow key={issue.id} issue={issue} index={index} onResolve={markResolved} onTodo={(row) => createTodo.mutate({ issueId: row.id })} readOnly={readOnly} draggable={false} />)}{!parking.length && <div className="l10-empty l10-empty-inline"><p>No parked issues.</p></div>}</div>}</div><div className="l10-ids-subsection l10-collapsed-subsection"><button className="l10-subsection-toggle" onClick={() => setResolvedOpen((current) => !current)}><span><span className="eyebrow">Discussed / Resolved</span><strong>{resolved.length} resolved issue{resolved.length === 1 ? '' : 's'}</strong></span>{resolvedOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>{resolvedOpen && <div className="l10-issue-list">{resolved.map((issue, index) => <IssueRow key={issue.id} issue={issue} index={index} onResolve={markResolved} onTodo={(row) => createTodo.mutate({ issueId: row.id })} readOnly={true} draggable={false} />)}</div>}</div></div>;
}

function ConcludeSection({ meetingId, detail, onSaved, readOnly, onEnd }: { meetingId: number; detail: WorkspaceL10MeetingDetail; onSaved: () => void; readOnly: boolean; onEnd: () => void }) {
  const queryClient = useQueryClient();
  const saveMessage = useUpdateWorkspaceL10CascadingMessage({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); onSaved(); } } });
  const saveRatings = useUpdateWorkspaceL10Ratings({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); onSaved(); } } });
  const [message, setMessage] = useState(detail.cascadingMessage);
  const [ratings, setRatings] = useState<WorkspaceL10Rating[]>(detail.ratings);
  useEffect(() => { setMessage(detail.cascadingMessage); setRatings(detail.ratings); }, [detail.cascadingMessage, detail.ratings]);
  const average = ratings.filter((row) => row.rating != null).reduce((sum, row) => sum + Number(row.rating), 0) / Math.max(1, ratings.filter((row) => row.rating != null).length);
  const setRating = (index: number, value: string) => setRatings((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, rating: value === '' ? null : Number(value) } : row));
  return <div className="l10-conclude"><div className="l10-conclude-block"><div className="l10-subsection-heading"><div><span className="eyebrow">Cascading messages</span><h3>Share with the wider team</h3></div></div><textarea disabled={readOnly} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="What should the wider team hear after this meeting?" /><button className="button button-dark" disabled={readOnly || saveMessage.isPending} onClick={() => saveMessage.mutate({ meetingId, data: { message } })}><Save size={14} /> {saveMessage.isPending ? 'Saving…' : 'Save message'}</button></div><div className="l10-conclude-block"><div className="l10-subsection-heading"><div><span className="eyebrow">Meeting Rating</span><h3>How valuable was this room?</h3></div><strong className="l10-team-average">{Number.isFinite(average) ? average.toFixed(1) : '—'} <small>team average</small></strong></div><div className="l10-rating-grid"><div className="l10-rating-row l10-rating-head"><span>Name</span><span>Score (1–10)</span></div>{ratings.map((row, index) => <div className="l10-rating-row" key={`${row.id}-${row.teamMemberName}`}><strong>{row.teamMemberName}</strong><input disabled={readOnly} type="number" min="1" max="10" value={row.rating ?? ''} onChange={(event) => setRating(index, event.target.value)} /></div>)}</div><button className="button button-dark" disabled={readOnly || saveRatings.isPending} onClick={() => saveRatings.mutate({ meetingId, data: { rows: ratings } })}><Save size={14} /> {saveRatings.isPending ? 'Saving…' : 'Save ratings'}</button></div><div className="l10-history-ratings"><span className="eyebrow">Historical team average</span><div>{detail.ratingHistory.map((row) => <span key={row.weekLabel}><b>{row.weekLabel.replace('Wk ', '')}</b>{row.average == null ? '—' : row.average.toFixed(1)}</span>)}</div></div>{readOnly ? <div className="l10-concluded-banner"><Check size={16} /> Meeting concluded and locked on {detail.meeting.concludedAt ? dateLabel(detail.meeting.concludedAt, false) : 'this day'}.</div> : <button className="button button-gold l10-end-meeting" onClick={onEnd}><Check size={16} /> End Meeting</button>}</div>;
}

function LiveMeeting({ meetingId }: { meetingId: number }) {
  const detailQuery = useGetWorkspaceL10Meeting(meetingId, { query: { queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) } });
  const liveScorecardQuery = useQuery<LiveScorecardResponse>({
    queryKey: ['/api/l10/scorecard/live'],
    queryFn: async () => {
      const response = await fetch('/api/l10/scorecard/live', { credentials: 'include' });
      if (!response.ok) throw new Error(`Live scorecard request failed (${response.status})`);
      return response.json() as Promise<LiveScorecardResponse>;
    },
    staleTime: 60_000,
    retry: 1,
  });
  const queryClient = useQueryClient();
  const createIssue = useCreateWorkspaceL10Issue({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); showSaved(); } } });
  const endMeeting = useEndWorkspaceL10Meeting({ mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceL10MeetingQueryKey(meetingId) }); queryClient.invalidateQueries({ queryKey: getListWorkspaceL10MeetingsQueryKey() }); showSaved(); } } });
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(AGENDA.map((item) => [item.key, true])));
  const [notice, setNotice] = useState('');
  const showSaved = () => { setNotice('Saved to the meeting record.'); window.setTimeout(() => setNotice(''), 2800); };
  if (detailQuery.isLoading) return <L10Loading />;
  if (detailQuery.isError || !detailQuery.data) return <L10Error detail onRetry={() => detailQuery.refetch()} />;
  const detail: WorkspaceL10MeetingDetail = detailQuery.data;
  const readOnly = detail.meeting.concluded;
  const dropToIssues = (metric: L10ScorecardMetricWithKey) => createIssue.mutate({ meetingId, data: { issue: `${metric.measurable} — owner ${metric.owner}`, raisedBy: metric.owner, priority: 0 } });
  const toggle = (key: string) => setOpen((current) => ({ ...current, [key]: !current[key] }));
  return <section className="page l10-page l10-live"><Link className="back-link l10-back-link" href="/product-workspace/l10"><ArrowLeft size={15} /> All L10 meetings</Link><div className="l10-live-head"><div><div className="eyebrow">{readOnly ? 'Concluded EOS meeting' : 'Live EOS meeting'} / {detail.meeting.weekLabel}</div><h1>{dateLabel(detail.meeting.meetingDate)}</h1><p>{displayTime(detail.meeting.startTime)}–{displayTime(detail.meeting.endTime)} · {detail.meeting.location}</p></div><div className={`l10-live-state ${readOnly ? 'is-concluded' : ''}`}><span className="l10-live-dot" /> {readOnly ? 'Meeting concluded' : 'Meeting room open'}</div></div><div className="l10-live-layout"><div className="l10-live-main"><div className="l10-agenda-strip"><div className="l10-agenda-strip-head"><span className="eyebrow">The cadence</span><span className="mono">11:30 AM start · 90 minutes</span></div><div className="l10-agenda-track">{agendaWithTimes.map((item) => <a href={`#l10-${item.label.toLowerCase().replaceAll(' ', '-').replaceAll("'", '')}`} className="l10-agenda-step" key={item.key}><span className="mono">{item.start}</span><b>{item.label}</b><small>{item.durationMinutes}m</small></a>)}</div></div>{notice && <div className="l10-notice" role="status"><Check size={15} /> {notice}</div>}<CollapsibleSection number={1} title="Check-In" duration={5} timestamp="11:30" open={!!open['check-in']} onToggle={() => toggle('check-in')}><CheckInSection meetingId={meetingId} rows={detail.checkins} onSaved={showSaved} readOnly={readOnly} /></CollapsibleSection><CollapsibleSection number={2} title="Scorecard" duration={5} timestamp="11:35" open={!!open.scorecard} onToggle={() => toggle('scorecard')}><ScorecardSection meetingId={meetingId} metrics={detail.metrics as L10ScorecardMetricWithKey[]} liveMetrics={liveScorecardQuery.data?.metrics ?? {}} onSaved={showSaved} onDropToIssues={dropToIssues} readOnly={readOnly} /></CollapsibleSection><CollapsibleSection number={3} title="Rocks" duration={5} timestamp="11:40" open={!!open.rocks} onToggle={() => toggle('rocks')}><RocksSection meetingId={meetingId} rocks={detail.rocks} onSaved={showSaved} readOnly={readOnly} /></CollapsibleSection><CollapsibleSection number={4} title="Customer / Employee Headlines" duration={5} timestamp="11:45" open={!!open.headlines} onToggle={() => toggle('headlines')}><HeadlineSection meetingId={meetingId} detail={detail} onSaved={showSaved} readOnly={readOnly} /></CollapsibleSection><CollapsibleSection number={5} title="To Do's" duration={5} timestamp="11:50" open={!!open.todos} onToggle={() => toggle('todos')}><TodoSection meetingId={meetingId} detail={detail} onSaved={showSaved} readOnly={readOnly} /></CollapsibleSection><CollapsibleSection number={6} title="IDS — Issues List" duration={60} timestamp="11:55" open={!!open.ids} onToggle={() => toggle('ids')}><IDSSection meetingId={meetingId} issues={detail.issues} onSaved={showSaved} readOnly={readOnly} /></CollapsibleSection><CollapsibleSection number={7} title="Conclude" duration={5} timestamp="12:55" open={!!open.conclude} onToggle={() => toggle('conclude')}><ConcludeSection meetingId={meetingId} detail={detail} onSaved={showSaved} readOnly={readOnly} onEnd={() => endMeeting.mutate({ meetingId })} /></CollapsibleSection></div><div className="l10-live-aside"><ElapsedTimer meeting={detail.meeting} /><div className="l10-room-card"><span className="eyebrow">Room details</span><strong>Design Board Room</strong><p>{dateLabel(detail.meeting.meetingDate, false)}<br />Monday · {detail.meeting.location}</p><div className="l10-room-rule" /><span className="mono">EOS / PRODUCT DEVELOPMENT</span></div></div></div></section>;
}

export default function L10Page() {
  const params = useParams<{ id?: string }>();
  const meetingId = params.id ? Number(params.id) : null;
  return meetingId && Number.isFinite(meetingId) ? <LiveMeeting meetingId={meetingId} /> : <MeetingHome />;
}