// Date utilities for preset ranges (returns ISO YYYY-MM-DD strings).
const iso = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const addDays = (d, n) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };

const startOfWeek = (d) => {
  // Sunday-based week
  const c = new Date(d);
  c.setDate(c.getDate() - c.getDay());
  return c;
};

export const todayDate = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; };
export const today = () => iso(todayDate());
export const yesterday = () => iso(addDays(todayDate(), -1));

export const PRESETS = [
  { key: "today",       label: "Today",          group: "quick",    range: () => { const d = todayDate(); return [iso(d), iso(d)]; } },
  { key: "yesterday",   label: "Yesterday",      group: "quick",    range: () => { const d = addDays(todayDate(), -1); return [iso(d), iso(d)]; } },
  { key: "last7",       label: "Last 7 days",    group: "last",     range: () => [iso(addDays(todayDate(), -6)), iso(todayDate())] },
  { key: "last30",      label: "Last 30 days",   group: "last",     range: () => [iso(addDays(todayDate(), -29)), iso(todayDate())] },
  { key: "last90",      label: "Last 90 days",   group: "last",     range: () => [iso(addDays(todayDate(), -89)), iso(todayDate())] },
  { key: "last365",     label: "Last 365 days",  group: "last",     range: () => [iso(addDays(todayDate(), -364)), iso(todayDate())] },
  { key: "lastweek",    label: "Last week",      group: "last",     range: () => {
      const sow = startOfWeek(todayDate());
      const lastSun = addDays(sow, -7);
      const lastSat = addDays(sow, -1);
      return [iso(lastSun), iso(lastSat)];
    } },
  { key: "lastmonth",   label: "Last month",     group: "last",     range: () => {
      const d = todayDate();
      const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const last  = new Date(d.getFullYear(), d.getMonth(), 0);
      return [iso(first), iso(last)];
    } },
  { key: "lastquarter", label: "Last quarter",   group: "last",     range: () => {
      const d = todayDate();
      const q = Math.floor(d.getMonth() / 3);
      const startMonth = (q - 1) * 3;
      const year = q === 0 ? d.getFullYear() - 1 : d.getFullYear();
      const realStart = q === 0 ? 9 : startMonth;
      const first = new Date(year, realStart, 1);
      const last  = new Date(year, realStart + 3, 0);
      return [iso(first), iso(last)];
    } },
  { key: "last12mo",    label: "Last 12 months", group: "last",     range: () => {
      const d = todayDate();
      const start = new Date(d.getFullYear() - 1, d.getMonth(), d.getDate());
      return [iso(start), iso(d)];
    } },
  { key: "lastyear",    label: "Last year",      group: "last",     range: () => {
      const d = todayDate();
      const start = new Date(d.getFullYear() - 1, 0, 1);
      const end   = new Date(d.getFullYear() - 1, 11, 31);
      return [iso(start), iso(end)];
    } },
  { key: "mtd",         label: "Month to date",  group: "period",   range: () => {
      const d = todayDate();
      return [iso(new Date(d.getFullYear(), d.getMonth(), 1)), iso(d)];
    } },
  { key: "qtd",         label: "Quarter to date",group: "period",   range: () => {
      const d = todayDate();
      const q = Math.floor(d.getMonth() / 3);
      return [iso(new Date(d.getFullYear(), q * 3, 1)), iso(d)];
    } },
  { key: "ytd",         label: "Year to date",   group: "period",   range: () => {
      const d = todayDate();
      return [iso(new Date(d.getFullYear(), 0, 1)), iso(d)];
    } },
];

/** Identify which preset (if any) matches a [from, to] pair. */
export const matchPreset = (from, to) => {
  for (const p of PRESETS) {
    const [pf, pt] = p.range();
    if (pf === from && pt === to) return p;
  }
  return null;
};

export const parseISO = (s) => {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/**
 * Given a date range [from, to], return the immediately-preceding window of the same length.
 * Example: 2026-05-15 → 2026-05-21 (7 days) becomes 2026-05-08 → 2026-05-14.
 */
export const previousPeriod = (from, to) => {
  const f = parseISO(from);
  const t = parseISO(to);
  if (!f || !t) return { from, to };
  const days = Math.round((t - f) / (24 * 60 * 60 * 1000)) + 1;
  const prevTo = new Date(f); prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (days - 1));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: iso(prevFrom), to: iso(prevTo) };
};
