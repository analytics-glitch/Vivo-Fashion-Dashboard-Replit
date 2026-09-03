import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateNewnessCommitment,
  weeklyNewnessTarget,
} from "./range-plan-newness.js";

test("September keeps 10,500 new units when capacity falls to 25,000", () => {
  const result = calculateNewnessCommitment({
    targetUnits: 10_500,
    plannedNewUnits: 10_500,
    plannedTotalUnits: 25_300,
    capacityUnits: 25_000,
    orderSizeUnits: 300,
    plannedNewStyles: 35,
  });

  assert.equal(result.impliedStyles, 35);
  assert.equal(result.meetsTarget, true);
  assert.equal(result.shortfallUnits, 0);
  assert.equal(result.shortfallStyles, 0);
  assert.equal(result.targetPctOfCapacity, 42);
  assert.ok(Math.abs(result.outcomePct - 41.501976) < 0.0001);
});

test("a 300-unit gap is reported as one missing style", () => {
  const result = calculateNewnessCommitment({
    targetUnits: 10_500,
    plannedNewUnits: 10_200,
    plannedTotalUnits: 25_000,
    capacityUnits: 25_000,
    orderSizeUnits: 300,
    plannedNewStyles: 34,
  });

  assert.equal(result.meetsTarget, false);
  assert.equal(result.shortfallUnits, 300);
  assert.equal(result.shortfallStyles, 1);
});

test("week 36 receives the six September days it contains", () => {
  const result = weeklyNewnessTarget("2026-08-31", "2026-09-06", [{
    monthStart: "2026-09-01",
    monthLabel: "September 2026",
    targetUnits: 10_500,
  }]);

  assert.equal(result.targetUnits, 2_100);
  assert.deepEqual(result.components.map((component) => ({
    overlapDays: component.overlapDays,
    daysInMonth: component.daysInMonth,
    sharePct: component.sharePct,
  })), [{ overlapDays: 6, daysInMonth: 30, sharePct: 20 }]);
});