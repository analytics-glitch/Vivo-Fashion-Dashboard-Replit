export type IsoWeek = { isoYear: number; isoWeek: number };

const nairobiCalendarParts = (date: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
};

export function isoWeekForCalendarDate(year: number, month: number, day: number): IsoWeek {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return { isoYear, isoWeek };
}

export function currentNairobiIsoWeek(now = new Date()): IsoWeek {
  const { year, month, day } = nairobiCalendarParts(now);
  return isoWeekForCalendarDate(year, month, day);
}

export function adjacentIsoWeek(current: IsoWeek, offset: -1 | 1): IsoWeek {
  const januaryFourth = new Date(Date.UTC(current.isoYear, 0, 4));
  const januaryFourthWeekday = januaryFourth.getUTCDay() || 7;
  const weekOneMonday = new Date(januaryFourth);
  weekOneMonday.setUTCDate(januaryFourth.getUTCDate() - januaryFourthWeekday + 1);
  weekOneMonday.setUTCDate(weekOneMonday.getUTCDate() + ((current.isoWeek - 1 + offset) * 7));
  return isoWeekForCalendarDate(
    weekOneMonday.getUTCFullYear(),
    weekOneMonday.getUTCMonth() + 1,
    weekOneMonday.getUTCDate(),
  );
}