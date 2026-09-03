import assert from "node:assert/strict";
import test from "node:test";
import {
  isAssignablePatternMaker,
  patternMakerLoads,
  planPatternMakerChanges,
  type PatternMakerAssignmentRow,
} from "./style-development-reassignment.js";

const activeOptions = ["Wanjohi", "Mercy", "Victoria", "Florence", "Abigail", "CAD", "Ken Knit"];

test("only active configured pattern makers and Unassigned are valid destinations", () => {
  assert.equal(isAssignablePatternMaker("Mercy", activeOptions), true);
  assert.equal(isAssignablePatternMaker("", activeOptions), true);
  assert.equal(isAssignablePatternMaker("Removed maker", activeOptions), false);
  assert.equal(isAssignablePatternMaker("mercy", activeOptions), false);
});

test("a single reassignment carries explicit old and new history values", () => {
  assert.deepEqual(
    planPatternMakerChanges([{ id: 7, patternMaker: "Mercy" }], "Victoria"),
    [{ id: 7, oldMaker: "Mercy", newMaker: "Victoria" }],
  );
});

test("bulk reassignment plans one audit row per changed style and skips no-ops", () => {
  const rows: PatternMakerAssignmentRow[] = [
    { id: 1, patternMaker: "Mercy" },
    { id: 2, patternMaker: "Wanjohi" },
    { id: 3, patternMaker: null },
  ];
  assert.deepEqual(planPatternMakerChanges(rows, "Wanjohi"), [
    { id: 1, oldMaker: "Mercy", newMaker: "Wanjohi" },
    { id: 3, oldMaker: "Unassigned", newMaker: "Wanjohi" },
  ]);
  assert.deepEqual(planPatternMakerChanges([{ id: 2, patternMaker: "Wanjohi" }], "Wanjohi"), []);
});

test("assignment changes immediately alter capacity loads", () => {
  const before: PatternMakerAssignmentRow[] = [
    { id: 1, patternMaker: "Mercy" },
    { id: 2, patternMaker: "Wanjohi" },
    { id: 3, patternMaker: null },
  ];
  const after = before.map((row) => row.id === 1 || row.id === 3 ? { ...row, patternMaker: "Wanjohi" } : row);
  assert.deepEqual(patternMakerLoads(before), { Mercy: 1, Wanjohi: 1, Unassigned: 1 });
  assert.deepEqual(patternMakerLoads(after), { Wanjohi: 3 });
});

test("an unassigned style becomes assigned with an auditable transition", () => {
  assert.deepEqual(
    planPatternMakerChanges([{ id: 12, patternMaker: "" }], "Florence"),
    [{ id: 12, oldMaker: "Unassigned", newMaker: "Florence" }],
  );
});