import assert from "node:assert/strict";
import test from "node:test";
import { computeReorderSignal } from "./assortment-signal.js";

const base = {
  tier: "Tier 2 · Core",
  sellThroughPct: 70,
  fullPricePct: 95,
  daysSinceLastSale: 3,
  firstSaleDate: "2025-01-01",
  sellableCoverWeeks: 6,
  planningCoverWeeks: 7,
  fabricAvailability: [],
  fabricConsumptionMetresPerUnit: null,
  today: new Date("2026-09-05T00:00:00Z"),
};

test("missing fabric never suppresses a trading-qualified reorder signal", () => {
  assert.deepEqual(computeReorderSignal(base), {
    tone: "green",
    label: "Reorder candidate",
    fabricChecked: false,
    fabricNote: "Fabric could not be checked",
  });
});

test("pipeline can turn a sellable-stock pass into order in production", () => {
  const signal = computeReorderSignal({ ...base, planningCoverWeeks: 10 });
  assert.equal(signal.label, "Order in production");
  assert.equal(signal.tone, "amber");
});

test("known insufficient fabric becomes fabric short", () => {
  const signal = computeReorderSignal({
    ...base,
    fabricAvailability: [{ colour: "Black", exactMetres: 100, otherColourMetres: 0 }],
    fabricConsumptionMetresPerUnit: 1.5,
  });
  assert.equal(signal.label, "Fabric short");
  assert.equal(signal.fabricChecked, true);
});

test("Tier 4 uses first sale and the six-week pipeline-inclusive cover threshold", () => {
  const signal = computeReorderSignal({
    ...base,
    tier: "Tier 4 · New",
    firstSaleDate: "2026-07-20",
    planningCoverWeeks: 6,
    sellThroughPct: 60,
  });
  assert.equal(signal.label, "Passed week 6 read");
  assert.equal(signal.tone, "green");
});

test("Tier 4 has explicit no-sale, early, backstop and missed-read states", () => {
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: null }).label, "Not yet selling");
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: "2026-08-29" }).label, "Too early · week 2");
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: "2026-07-01", sellThroughPct: 20 }).label, "Watch · week 12 backstop");
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: "2026-05-01", sellThroughPct: 20 }).label, "Missed read");
});