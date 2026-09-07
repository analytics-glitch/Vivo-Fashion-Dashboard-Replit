export type WeeklyClassificationLine = {
  patternType?: unknown;
  fabricStructure?: unknown;
};

export function weeklyClassificationSummary(lines: WeeklyClassificationLine[]) {
  const pattern = lines.filter((line) =>
    ["print", "plain"].includes(String(line.patternType ?? "").trim().toLowerCase()));
  const construction = lines.filter((line) =>
    ["knit", "woven"].includes(String(line.fabricStructure ?? "").trim().toLowerCase()));
  return {
    printPct: pattern.length
      ? 100 * pattern.filter((line) => String(line.patternType).trim().toLowerCase() === "print").length / pattern.length
      : null,
    printBasisCount: pattern.length,
    knitPct: construction.length
      ? 100 * construction.filter((line) => String(line.fabricStructure).trim().toLowerCase() === "knit").length / construction.length
      : null,
    knitBasisCount: construction.length,
    totalCount: lines.length,
  };
}

export function minimumColourwayCount(patternType: unknown) {
  const value = String(patternType ?? "").trim().toLowerCase();
  if (value === "plain") return 4;
  if (value === "print") return 2;
  return null;
}