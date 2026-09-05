import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateNewnessCommitment,
  isNewnessOrderType,
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

test("Range Refreshed remains distinct but counts as newness", () => {
  assert.equal(isNewnessOrderType("New"), true);
  assert.equal(isNewnessOrderType("Range Refreshed"), true);
  assert.equal(isNewnessOrderType("range_refreshed"), true);
  assert.equal(isNewnessOrderType("RR"), true);
  assert.equal(isNewnessOrderType("Re-order"), false);
  assert.equal(isNewnessOrderType("Replenishment"), false);
});

test("week 36 newness includes the 400 Range Refreshed units", () => {
  const lines = [
    { type: "New", units: 2_160 },
    { type: "Range Refreshed", units: 400 },
    { type: "Re-order", units: 1_395 },
    { type: "Replenishment", units: 1_950 },
  ];
  const total = lines.reduce((sum, line) => sum + line.units, 0);
  const newUnits = lines.filter((line) => isNewnessOrderType(line.type)).reduce((sum, line) => sum + line.units, 0);
  assert.equal(total, 5_905);
  assert.equal(newUnits, 2_560);
  assert.ok(Math.abs(newUnits / total * 100 - 43.35309) < 0.0001);
});