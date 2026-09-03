export type PatternMakerAssignmentRow = {
  id: number;
  patternMaker: string | null;
};

export type PatternMakerChange = {
  id: number;
  oldMaker: string;
  newMaker: string;
};

export function isAssignablePatternMaker(target: string, activeNames: string[]) {
  return target === "" || activeNames.includes(target);
}

export function planPatternMakerChanges(rows: PatternMakerAssignmentRow[], target: string): PatternMakerChange[] {
  return rows
    .filter((row) => (row.patternMaker ?? "").trim() !== target)
    .map((row) => ({
      id: row.id,
      oldMaker: (row.patternMaker ?? "").trim() || "Unassigned",
      newMaker: target || "Unassigned",
    }));
}

export function patternMakerLoads(rows: PatternMakerAssignmentRow[]) {
  return rows.reduce<Record<string, number>>((loads, row) => {
    const maker = (row.patternMaker ?? "").trim() || "Unassigned";
    loads[maker] = (loads[maker] ?? 0) + 1;
    return loads;
  }, {});
}