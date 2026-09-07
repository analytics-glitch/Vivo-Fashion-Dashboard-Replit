import assert from "node:assert/strict";
import test from "node:test";
import { minimumColourwayCount, weeklyClassificationSummary } from "./weekly-order-plan-classification.js";

test("classification KPIs use the classified-style basis without hiding partial coverage", () => {
  assert.deepEqual(weeklyClassificationSummary([
    { patternType: "Print", fabricStructure: "Knit" },
    { patternType: "Plain", fabricStructure: "Woven" },
    {},
  ]), {
    printPct: 50,
    printBasisCount: 2,
    knitPct: 50,
    knitBasisCount: 2,
    totalCount: 3,
  });
});

test("classification KPIs remain unavailable until at least one style is classified", () => {
  assert.deepEqual(weeklyClassificationSummary([{}]), {
    printPct: null,
    printBasisCount: 0,
    knitPct: null,
    knitBasisCount: 0,
    totalCount: 1,
  });
});

test("Plain styles require four colourways and Print styles require two", () => {
  assert.equal(minimumColourwayCount("Plain"), 4);
  assert.equal(minimumColourwayCount("Print"), 2);
});