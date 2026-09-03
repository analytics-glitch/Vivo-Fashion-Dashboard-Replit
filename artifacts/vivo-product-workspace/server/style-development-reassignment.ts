export type PatternMakerAssignmentRow = {
  id: number;
  assignmentKey: string;
  patternMaker: string | null;
};

export type PatternMakerChange = {
  id: number;
  oldAssignmentKey: string;
  newAssignmentKey: string;
  oldMaker: string;
  newMaker: string;
};

export type PatternQueueStyle = {
  id: number;
  styleName: string;
  styleNumber: string | null;
  stage: string;
  sourceStatus?: string;
  category: string;
  workingDaysWaiting: number;
  effortDays: number;
};

export type PatternQueueOwner = {
  assignmentKey: string;
  patternMaker: string;
  effectiveCapacity: number;
  queueStyles: PatternQueueStyle[];
};

export function isPatternQueueStage(stage: unknown, sourceStatus?: unknown) {
  return stage === "Pattern"
    || stage === "Transfer to CAD"
    || (stage === "CAD" && String(sourceStatus ?? "").trim().toUpperCase() === "TRANSFER TO CAD");
}

export function summarizePatternQueue(queueStyles: PatternQueueStyle[]) {
  const oldest = [...queueStyles].sort((a, b) => b.workingDaysWaiting - a.workingDaysWaiting)[0];
  const categoryMix = Object.values(queueStyles.reduce<Record<string, { category: string; count: number; effortDays: number }>>((out, style) => {
    const entry = out[style.category] ?? { category: style.category, count: 0, effortDays: 0 };
    entry.count += 1;
    entry.effortDays += style.effortDays;
    out[style.category] = entry;
    return out;
  }, {})).sort((a, b) => b.effortDays - a.effortDays || a.category.localeCompare(b.category));
  return {
    queueStyleCount: queueStyles.length,
    patternAwaitingCount: queueStyles.filter((style) => style.stage === "Pattern").length,
    transferToCadCount: queueStyles.filter((style) =>
      style.stage === "Transfer to CAD"
      || (style.stage === "CAD" && String(style.sourceStatus ?? "").trim().toUpperCase() === "TRANSFER TO CAD")
    ).length,
    queueEffortDays: queueStyles.reduce((sum, style) => sum + style.effortDays, 0),
    oldestWaitingWorkingDays: oldest?.workingDaysWaiting ?? 0,
    oldestStyleName: oldest?.styleName ?? null,
    categoryMix,
  };
}

export function isAssignablePatternMaker(target: string, activeAssignmentKeys: string[]) {
  return target === "" || activeAssignmentKeys.includes(target);
}

export function planPatternMakerChanges(
  rows: PatternMakerAssignmentRow[],
  targetAssignmentKey: string,
  targetDisplayName: string,
): PatternMakerChange[] {
  return rows
    .filter((row) => row.assignmentKey !== targetAssignmentKey)
    .map((row) => ({
      id: row.id,
      oldAssignmentKey: row.assignmentKey,
      newAssignmentKey: targetAssignmentKey,
      oldMaker: (row.patternMaker ?? "").trim() || "Unassigned",
      newMaker: targetDisplayName || "Unassigned",
    }));
}

export function patternMakerLoads(rows: PatternMakerAssignmentRow[]) {
  return rows.reduce<Record<string, number>>((loads, row) => {
    const assignmentKey = row.assignmentKey || "unassigned";
    loads[assignmentKey] = (loads[assignmentKey] ?? 0) + 1;
    return loads;
  }, {});
}

export function isPassedAround(reassignmentCategories: Array<string | null | undefined>) {
  return reassignmentCategories.some((category) => category === "style");
}

export function reassignmentLoadDeltas(before: Record<string, number>, after: Record<string, number>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].reduce<Record<string, number>>((deltas, maker) => {
    const delta = (after[maker] ?? 0) - (before[maker] ?? 0);
    if (delta !== 0) deltas[maker] = delta;
    return deltas;
  }, {});
}

export function capacityForecast(baseMakers: number, unavailableCapacities: number[], daysPerPattern = 2) {
  const effectiveMakers = Math.max(0, baseMakers - unavailableCapacities.reduce((sum, value) => sum + value, 0));
  return {
    effectiveMakers,
    weeklyCapacity: effectiveMakers * 5 / daysPerPattern,
  };
}

export function recommendQueueRebalance(owners: PatternQueueOwner[], limit = 5) {
  const state = owners
    .filter((owner) => owner.effectiveCapacity > 0)
    .map((owner) => ({
      ...owner,
      queueStyles: [...owner.queueStyles],
      effortDays: owner.queueStyles.reduce((sum, style) => sum + style.effortDays, 0),
    }));
  const moved = new Set<number>();
  const suggestions: Array<PatternQueueStyle & {
    fromAssignmentKey: string;
    toAssignmentKey: string;
    fromPatternMaker: string;
    toPatternMaker: string;
    fromWeeksBefore: number;
    fromWeeksAfter: number;
    toWeeksBefore: number;
    toWeeksAfter: number;
  }> = [];
  const weeks = (owner: typeof state[number], effortDays = owner.effortDays) =>
    effortDays / (5 * owner.effectiveCapacity);

  while (suggestions.length < limit && state.length > 1) {
    const ranked = [...state].sort((a, b) => weeks(b) - weeks(a));
    const from = ranked[0];
    const to = ranked[ranked.length - 1];
    const spreadBefore = weeks(from) - weeks(to);
    if (spreadBefore <= 0.5) break;

    let best: { style: PatternQueueStyle; spreadAfter: number; fromAfter: number; toAfter: number } | null = null;
    for (const style of from.queueStyles) {
      if (moved.has(style.id)) continue;
      const fromAfter = weeks(from, from.effortDays - style.effortDays);
      const toAfter = weeks(to, to.effortDays + style.effortDays);
      const projected = state.map((owner) => owner === from ? fromAfter : owner === to ? toAfter : weeks(owner));
      const spreadAfter = Math.max(...projected) - Math.min(...projected);
      if (spreadAfter >= spreadBefore) continue;
      if (!best || spreadAfter < best.spreadAfter
        || (spreadAfter === best.spreadAfter && style.workingDaysWaiting > best.style.workingDaysWaiting)) {
        best = { style, spreadAfter, fromAfter, toAfter };
      }
    }
    if (!best) break;

    const fromBefore = weeks(from);
    const toBefore = weeks(to);
    from.effortDays -= best.style.effortDays;
    to.effortDays += best.style.effortDays;
    from.queueStyles = from.queueStyles.filter((style) => style.id !== best?.style.id);
    to.queueStyles.push(best.style);
    moved.add(best.style.id);
    suggestions.push({
      ...best.style,
      fromAssignmentKey: from.assignmentKey,
      toAssignmentKey: to.assignmentKey,
      fromPatternMaker: from.patternMaker,
      toPatternMaker: to.patternMaker,
      fromWeeksBefore: fromBefore,
      fromWeeksAfter: best.fromAfter,
      toWeeksBefore: toBefore,
      toWeeksAfter: best.toAfter,
    });
  }
  return suggestions;
}