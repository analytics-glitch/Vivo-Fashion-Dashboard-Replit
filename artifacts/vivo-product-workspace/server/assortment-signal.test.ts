import assert from "node:assert/strict";
import test from "node:test";
import { computeReorderSignal } from "./assortment-signal.js";

const rules = {
  tier4: [
    { ruleKey: "week_16_retire", minWeeks: 16, minSellThroughPct: null, maxSellThroughPct: 80, minFullPricePct: null, maxDaysSinceLastSale: null, maxCoverWeeks: null, action: "RETIRE" as const, label: "Retire", priority: 10 },
    { ruleKey: "week_12_graduate", minWeeks: 12, minSellThroughPct: 80, maxSellThroughPct: null, minFullPricePct: null, maxDaysSinceLastSale: null, maxCoverWeeks: null, action: "GRADUATE" as const, label: "Graduate to Tier 3", priority: 20 },
    { ruleKey: "week_12_retire", minWeeks: 12, minSellThroughPct: null, maxSellThroughPct: 70, minFullPricePct: null, maxDaysSinceLastSale: null, maxCoverWeeks: null, action: "RETIRE" as const, label: "Retire", priority: 30 },
    { ruleKey: "week_12_watch", minWeeks: 12, minSellThroughPct: 70, maxSellThroughPct: 80, minFullPricePct: null, maxDaysSinceLastSale: null, maxCoverWeeks: null, action: "WATCH" as const, label: "Watch — 4 weeks to prove", priority: 40 },
    { ruleKey: "week_6_rollout", minWeeks: 6, minSellThroughPct: 60, maxSellThroughPct: null, minFullPricePct: 90, maxDaysSinceLastSale: 7, maxCoverWeeks: 6, action: "REORDER" as const, label: "Passed week 6 read — full rollout", priority: 50 },
    { ruleKey: "week_2_early", minWeeks: 2, minSellThroughPct: 30, maxSellThroughPct: null, minFullPricePct: null, maxDaysSinceLastSale: null, maxCoverWeeks: null, action: "REORDER" as const, label: "Strong early candidate", priority: 60 },
  ],
  graduation: [
    { ruleKey: "tier4_to_tier3", fromTier: 4, toTier: 3, minMonths: 0, minOrders: 2, label: "Graduate to Tier 3" },
    { ruleKey: "tier3_to_tier2", fromTier: 3, toTier: 2, minMonths: 9, minOrders: 4, label: "Graduate to Tier 2" },
  ],
  reorderGate: { minFullPricePct: 90, maxDaysSinceLastSale: 7, maxCoverWeeks: 8 },
};

const base = {
  tier: "Tier 2 · Core",
  sellThroughPct: 70,
  fullPricePct: 95,
  daysSinceLastSale: 3,
  firstSaleDate: "2025-01-01",
  orderCount: 1,
  sellableCoverWeeks: 6,
  planningCoverWeeks: 7,
  fabricAvailability: [],
  fabricConsumptionMetresPerUnit: null,
  rules,
  today: new Date("2026-09-05T00:00:00Z"),
};

test("missing fabric never suppresses a trading-qualified reorder signal", () => {
  const signal = computeReorderSignal(base);
  assert.equal(signal.label, "Reorder candidate");
  assert.equal(signal.action, "REORDER");
  assert.equal(signal.fabricChecked, false);
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
  assert.equal(signal.label, "Passed week 6 read — full rollout");
  assert.equal(signal.tone, "green");
});

test("Tier 4 follows the editable lifecycle ladder", () => {
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: null }).label, "Not yet selling");
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: "2026-08-29" }).label, "Too early · week 2");
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: "2026-06-01", sellThroughPct: 75 }).action, "WATCH");
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: "2026-06-01", sellThroughPct: 82 }).action, "GRADUATE");
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: "2026-05-01", sellThroughPct: 79, orderCount: 5 }).action, "RETIRE");
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: "2026-08-01", sellThroughPct: 40 }).label, "Strong early candidate");
});

test("Tier 4 graduates on two total orders and Tier 3 on nine months plus four", () => {
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: "2026-08-01", orderCount: 2 }).action, "GRADUATE");
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 3 · Recent", firstSaleDate: "2025-10-01", orderCount: 4 }).label, "Graduate to Tier 2");
});

test("Tier 1-3 reorder gate does not depend on sell-through", () => {
  assert.equal(computeReorderSignal({ ...base, sellThroughPct: 0 }).action, "REORDER");
});