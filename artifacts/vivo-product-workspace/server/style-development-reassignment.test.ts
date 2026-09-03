import assert from "node:assert/strict";
import test from "node:test";
import {
  capacityForecast,
  isAssignablePatternMaker,
  isPatternQueueStage,
  isPassedAround,
  patternMakerLoads,
  planPatternMakerChanges,
  recommendQueueRebalance,
  summarizePatternQueue,
  reassignmentLoadDeltas,
  type PatternMakerAssignmentRow,
} from "./style-development-reassignment.js";

const activeOptions = ["user:1", "user:2", "user:3", "user:4", "user:5", "route:6", "route:7"];

test("only active configured pattern makers and Unassigned are valid destinations", () => {
  assert.equal(isAssignablePatternMaker("user:2", activeOptions), true);
  assert.equal(isAssignablePatternMaker("", activeOptions), true);
  assert.equal(isAssignablePatternMaker("user:99", activeOptions), false);
  assert.equal(isAssignablePatternMaker("Mercy", activeOptions), false);
});

test("a single reassignment carries explicit old and new history values", () => {
  assert.deepEqual(
    planPatternMakerChanges([{ id: 7, assignmentKey: "user:2", patternMaker: "Mercy" }], "user:3", "Victoria Orlando"),
    [{ id: 7, oldAssignmentKey: "user:2", newAssignmentKey: "user:3", oldMaker: "Mercy", newMaker: "Victoria Orlando" }],
  );
});

test("bulk reassignment plans one audit row per changed style and skips no-ops", () => {
  const rows: PatternMakerAssignmentRow[] = [
    { id: 1, assignmentKey: "user:2", patternMaker: "Mercy" },
    { id: 2, assignmentKey: "user:1", patternMaker: "Alex Wanjohi" },
    { id: 3, assignmentKey: "", patternMaker: null },
  ];
  assert.deepEqual(planPatternMakerChanges(rows, "user:1", "Alex Wanjohi"), [
    { id: 1, oldAssignmentKey: "user:2", newAssignmentKey: "user:1", oldMaker: "Mercy", newMaker: "Alex Wanjohi" },
    { id: 3, oldAssignmentKey: "", newAssignmentKey: "user:1", oldMaker: "Unassigned", newMaker: "Alex Wanjohi" },
  ]);
  assert.deepEqual(planPatternMakerChanges([{ id: 2, assignmentKey: "user:1", patternMaker: "Wanjohi" }], "user:1", "Alex Wanjohi"), []);
});

test("assignment changes immediately alter capacity loads", () => {
  const before: PatternMakerAssignmentRow[] = [
    { id: 1, assignmentKey: "user:2", patternMaker: "Mercy" },
    { id: 2, assignmentKey: "user:1", patternMaker: "Alex Wanjohi" },
    { id: 3, assignmentKey: "", patternMaker: null },
  ];
  const after = before.map((row) => row.id === 1 || row.id === 3
    ? { ...row, assignmentKey: "user:1", patternMaker: "Alex Wanjohi" }
    : row);
  assert.deepEqual(patternMakerLoads(before), { "user:2": 1, "user:1": 1, unassigned: 1 });
  assert.deepEqual(patternMakerLoads(after), { "user:1": 3 });
});

test("an unassigned style becomes assigned with an auditable transition", () => {
  assert.deepEqual(
    planPatternMakerChanges([{ id: 12, assignmentKey: "", patternMaker: "" }], "user:4", "Florence Bwibo"),
    [{ id: 12, oldAssignmentKey: "", newAssignmentKey: "user:4", oldMaker: "Unassigned", newMaker: "Florence Bwibo" }],
  );
});

test("only style-related reassignment reasons flag a style as passed around", () => {
  assert.equal(isPassedAround(["operational", "operational"]), false);
  assert.equal(isPassedAround(["operational", "style"]), true);
  assert.equal(isPassedAround([]), false);
});

test("queue redistribution exposes every maker load delta", () => {
  assert.deepEqual(
    reassignmentLoadDeltas({ Mercy: 20, Wanjohi: 26, Unassigned: 3 }, { Mercy: 15, Wanjohi: 30, Unassigned: 4 }),
    { Mercy: -5, Wanjohi: 4, Unassigned: 1 },
  );
});

test("dated unavailability reduces effective makers and weekly throughput", () => {
  assert.deepEqual(capacityForecast(3.5, [1]), { effectiveMakers: 2.5, weeklyCapacity: 6.25 });
  assert.deepEqual(capacityForecast(3.5, [1, 0.5]), { effectiveMakers: 2, weeklyCapacity: 5 });
  assert.deepEqual(capacityForecast(0.5, [1]), { effectiveMakers: 0, weeklyCapacity: 0 });
});

test("rebalance recommendations use effort weeks and half-capacity rather than raw style counts", () => {
  const suggestions = recommendQueueRebalance([
    {
      assignmentKey: "user:4",
      patternMaker: "Florence",
      effectiveCapacity: 0.5,
      queueStyles: Array.from({ length: 6 }, (_, index) => ({
        id: index + 1, styleName: `Florence ${index + 1}`, styleNumber: null,
        stage: "Pattern", category: "Dresses", workingDaysWaiting: 8 - index, effortDays: 2,
      })),
    },
    {
      assignmentKey: "user:3",
      patternMaker: "Victoria",
      effectiveCapacity: 1,
      queueStyles: Array.from({ length: 4 }, (_, index) => ({
        id: index + 20, styleName: `Victoria ${index + 1}`, styleNumber: null,
        stage: "Pattern", category: "Tops", workingDaysWaiting: 4 - index, effortDays: 2,
      })),
    },
  ], 1);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].fromPatternMaker, "Florence");
  assert.equal(suggestions[0].toPatternMaker, "Victoria");
  assert.ok(suggestions[0].fromWeeksAfter < suggestions[0].fromWeeksBefore);
  assert.ok(suggestions[0].toWeeksAfter > suggestions[0].toWeeksBefore);
});

test("adjusted style effort changes the recommended queue move", () => {
  const suggestions = recommendQueueRebalance([
    {
      assignmentKey: "user:2",
      patternMaker: "Mercy", effectiveCapacity: 1,
      queueStyles: [
        { id: 1, styleName: "Simple top", styleNumber: null, stage: "Pattern", category: "Tops", workingDaysWaiting: 3, effortDays: 1 },
        { id: 2, styleName: "Tailored coat", styleNumber: null, stage: "Pattern", category: "Outerwear", workingDaysWaiting: 2, effortDays: 5 },
      ],
    },
    {
      assignmentKey: "user:3",
      patternMaker: "Victoria", effectiveCapacity: 1,
      queueStyles: [{ id: 3, styleName: "Top", styleNumber: null, stage: "Pattern", category: "Tops", workingDaysWaiting: 1, effortDays: 1 }],
    },
  ], 1);
  assert.equal(suggestions[0].styleName, "Simple top");
  assert.equal(suggestions[0].effortDays, 1);
});

test("the capacity queue includes Pattern and Transfer to CAD only", () => {
  assert.equal(isPatternQueueStage("Pattern"), true);
  assert.equal(isPatternQueueStage("Transfer to CAD"), true);
  assert.equal(isPatternQueueStage("CAD", "TRANSFER TO CAD"), true);
  assert.equal(isPatternQueueStage("CAD", "CAD PROCESSING SS"), false);
  assert.equal(isPatternQueueStage("CAD Processing SS"), false);
});

test("queue summary retains effort mix and the oldest waiting style", () => {
  const summary = summarizePatternQueue([
    { id: 1, styleName: "Top", styleNumber: null, stage: "Pattern", category: "Tops", workingDaysWaiting: 3, effortDays: 1 },
    { id: 2, styleName: "Coat", styleNumber: null, stage: "CAD", sourceStatus: "TRANSFER TO CAD", category: "Outerwear", workingDaysWaiting: 12, effortDays: 5 },
    { id: 3, styleName: "Dress", styleNumber: null, stage: "Pattern", category: "Dresses", workingDaysWaiting: 4, effortDays: 2 },
  ]);
  assert.equal(summary.queueStyleCount, 3);
  assert.equal(summary.patternAwaitingCount, 2);
  assert.equal(summary.transferToCadCount, 1);
  assert.equal(summary.queueEffortDays, 8);
  assert.equal(summary.oldestStyleName, "Coat");
  assert.equal(summary.oldestWaitingWorkingDays, 12);
  assert.deepEqual(summary.categoryMix[0], { category: "Outerwear", count: 1, effortDays: 5 });
});