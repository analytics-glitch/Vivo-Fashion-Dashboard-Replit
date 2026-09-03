export const DEFAULT_NEW_STYLE_ORDER_UNITS = 300;

export type NewnessCommitment = {
  targetUnits: number;
  plannedNewUnits: number;
  plannedTotalUnits: number;
  capacityUnits: number;
  orderSizeUnits: number;
  impliedStyles: number;
  plannedNewStyles: number;
  shortfallUnits: number;
  shortfallStyles: number;
  meetsTarget: boolean;
  outcomePct: number;
  targetPctOfCapacity: number;
};

export function calculateNewnessCommitment({
  targetUnits,
  plannedNewUnits,
  plannedTotalUnits,
  capacityUnits,
  orderSizeUnits = DEFAULT_NEW_STYLE_ORDER_UNITS,
  plannedNewStyles = 0,
}: {
  targetUnits: number;
  plannedNewUnits: number;
  plannedTotalUnits: number;
  capacityUnits: number;
  orderSizeUnits?: number;
  plannedNewStyles?: number;
}): NewnessCommitment {
  const safeTarget = Math.max(0, Number(targetUnits) || 0);
  const safePlannedNew = Math.max(0, Number(plannedNewUnits) || 0);
  const safePlannedTotal = Math.max(0, Number(plannedTotalUnits) || 0);
  const safeCapacity = Math.max(0, Number(capacityUnits) || 0);
  const safeOrderSize = Math.max(1, Number(orderSizeUnits) || DEFAULT_NEW_STYLE_ORDER_UNITS);
  const shortfallUnits = Math.max(0, safeTarget - safePlannedNew);
  return {
    targetUnits: safeTarget,
    plannedNewUnits: safePlannedNew,
    plannedTotalUnits: safePlannedTotal,
    capacityUnits: safeCapacity,
    orderSizeUnits: safeOrderSize,
    impliedStyles: Math.ceil(safeTarget / safeOrderSize),
    plannedNewStyles: Math.max(0, Number(plannedNewStyles) || 0),
    shortfallUnits,
    shortfallStyles: Math.ceil(shortfallUnits / safeOrderSize),
    meetsTarget: safePlannedNew >= safeTarget,
    outcomePct: safePlannedTotal > 0 ? safePlannedNew / safePlannedTotal * 100 : 0,
    targetPctOfCapacity: safeCapacity > 0 ? safeTarget / safeCapacity * 100 : 0,
  };
}

export type MonthlyNewnessTarget = {
  monthStart: string;
  monthLabel: string;
  targetUnits: number;
};

const utcDate = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`);
const dayMs = 24 * 60 * 60 * 1000;

export function weeklyNewnessTarget(
  weekStart: string,
  weekEnd: string,
  months: MonthlyNewnessTarget[],
) {
  const start = utcDate(weekStart);
  const end = utcDate(weekEnd);
  const components = months.map((month) => {
    const monthStart = utcDate(month.monthStart);
    const nextMonth = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
    const monthEnd = new Date(nextMonth.getTime() - dayMs);
    const overlapStart = new Date(Math.max(start.getTime(), monthStart.getTime()));
    const overlapEnd = new Date(Math.min(end.getTime(), monthEnd.getTime()));
    const overlapDays = overlapEnd < overlapStart ? 0 : Math.floor((overlapEnd.getTime() - overlapStart.getTime()) / dayMs) + 1;
    const daysInMonth = monthEnd.getUTCDate();
    const share = daysInMonth > 0 ? overlapDays / daysInMonth : 0;
    return {
      monthStart: month.monthStart,
      monthLabel: month.monthLabel,
      monthlyTargetUnits: Math.max(0, Number(month.targetUnits) || 0),
      overlapDays,
      daysInMonth,
      sharePct: share * 100,
      targetUnits: Math.round(Math.max(0, Number(month.targetUnits) || 0) * share),
    };
  }).filter((component) => component.overlapDays > 0);
  return {
    targetUnits: components.reduce((sum, component) => sum + component.targetUnits, 0),
    components,
  };
}