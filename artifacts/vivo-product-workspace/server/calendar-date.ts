const CALENDAR_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

function validCalendarDate(year: number, month: number, day: number) {
  return Number.isInteger(year) && year >= 1000 && year <= 9999
    && Number.isInteger(month) && month >= 1 && month <= 12
    && Number.isInteger(day) && day >= 1 && day <= new Date(year, month, 0).getDate();
}

export function calendarDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const year = value.getFullYear();
    const month = value.getMonth() + 1;
    const day = value.getDate();
    return validCalendarDate(year, month, day)
      ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      : null;
  }
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return validCalendarDate(year, month, day) ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function legacyCalendarDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const isoDate = calendarDate(raw);
  if (isoDate) return isoDate;
  const legacy = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  const wordy = raw.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/i);
  const year = Number(legacy?.[3] ?? wordy?.[3]);
  const monthName = String(legacy?.[2] ?? wordy?.[1]).toLowerCase();
  const month = CALENDAR_MONTHS.indexOf(monthName as typeof CALENDAR_MONTHS[number]) + 1;
  const day = Number(legacy?.[1] ?? wordy?.[2]);
  if (!validCalendarDate(year, month, day)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function styleDateInput(value: unknown, fieldName: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = legacyCalendarDate(raw);
  if (!normalized) throw new Error(`${fieldName} must be a valid date in YYYY-MM-DD format.`);
  return normalized;
}