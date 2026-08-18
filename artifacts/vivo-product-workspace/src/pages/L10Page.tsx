import { ArrowRight, Clock3, ListChecks } from 'lucide-react';

// The L10 page is a single persistent meeting hub. The team runs the whole
// quarter out of ONE Google Sheet (updated weekly, reviewed at each Monday
// meeting), so there is no per-week room creation and no workspace-room
// connection — "Open live meeting" links straight to the sheet.
const L10_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1-sTlZzGem2tKMWaUL8T9LUOPtC5XgFs3apSCasi0a_I/edit';

const AGENDA = [
  { key: 'check-in', label: 'Check-In', durationMinutes: 5 },
  { key: 'scorecard', label: 'Scorecard', durationMinutes: 5 },
  { key: 'rocks', label: 'Rocks', durationMinutes: 5 },
  { key: 'headlines', label: 'Headlines', durationMinutes: 5 },
  { key: 'todos', label: "To Do's", durationMinutes: 5 },
  { key: 'ids', label: 'IDS', durationMinutes: 60 },
  { key: 'conclude', label: 'Conclude', durationMinutes: 5 },
] as const;

const agendaWithTimes = AGENDA.reduce<Array<typeof AGENDA[number] & { start: string; end: string }>>((items, item) => {
  const previous = items[items.length - 1];
  const [hour, minute] = previous ? previous.end.split(':').map(Number) : [11, 30];
  const startMinutes = hour * 60 + minute;
  const endMinutes = startMinutes + item.durationMinutes;
  const format = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  items.push({ ...item, start: format(startMinutes), end: format(endMinutes) });
  return items;
}, []);

// Monday of the current week (a meeting week runs Monday→Sunday).
const currentMonday = () => {
  const now = new Date();
  const monday = new Date(now);
  monday.setHours(12, 0, 0, 0);
  const day = monday.getDay();
  monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1));
  return monday;
};

const isoWeekNumber = (date: Date) => {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
};

const FLOW_STEPS = [
  { title: 'Before the meeting', copy: 'The team updates KPIs and rocks in the sheet ahead of Monday.' },
  { title: 'During the meeting', copy: 'Anything off-track is dropped to the Issues List as it comes up.' },
  { title: '60 minutes of IDS', copy: 'Identify, discuss, solve — the room works the Issues List top-down.' },
  { title: "To Do's agreed", copy: 'Every resolution leaves with a small, owned next action.' },
  { title: 'Reviewed next Monday', copy: "Last week's To Do's are checked first at the start of the next meeting." },
] as const;

export default function L10Page() {
  const monday = currentMonday();
  const weekLabel = `Wk ${isoWeekNumber(monday)}`;
  const dateText = monday.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  return (
    <section className="page l10-page l10-home">
      <div className="page-heading l10-heading">
        <div>
          <div className="eyebrow">Product department / EOS operating room</div>
          <h1>L10 Meeting</h1>
          <p>A focused weekly room for clear owners, honest numbers, and the next right action.</p>
        </div>
        <div className="l10-heading-mark" aria-hidden="true"><ListChecks size={25} /><span>90 MIN<br />MONDAYS</span></div>
      </div>
      <section className="l10-current-card" aria-labelledby="current-meeting-title">
        <div className="l10-current-copy">
          <div className="eyebrow gold-eyebrow">Current Monday</div>
          <h2 id="current-meeting-title">{weekLabel}</h2>
          <p className="l10-current-date">{dateText} · 11:30 AM–1:00 PM</p>
          <div className="l10-meta-line"><Clock3 size={15} /> 90 minutes <span>·</span> Design Board Room</div>
          <a
            className="button button-gold"
            href={L10_SHEET_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="button-open-current-l10"
          >
            Open live meeting <ArrowRight size={16} />
          </a>
        </div>
        <div className="l10-current-agenda">
          <span className="eyebrow">Today's cadence</span>
          {agendaWithTimes.map((item) => (
            <div className="l10-agenda-mini-row" key={item.key}>
              <span className="mono">{item.start}</span><strong>{item.label}</strong><span>{item.durationMinutes}m</span>
            </div>
          ))}
        </div>
      </section>
      <div className="l10-section-title">
        <div><span className="eyebrow">How the room runs</span><h2>One sheet, one quarter</h2></div>
        <span className="mono">{FLOW_STEPS.length} steps</span>
      </div>
      <div className="l10-flow-grid">
        {FLOW_STEPS.map((step, index) => (
          <div className="l10-flow-card" key={step.title}>
            <div className="l10-archive-number">{String(index + 1).padStart(2, '0')}</div>
            <div><h3>{step.title}</h3><p>{step.copy}</p></div>
          </div>
        ))}
      </div>
    </section>
  );
}
