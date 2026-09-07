import assert from "node:assert/strict";
import test from "node:test";
import { actualOrderCountForStyle, actualOrderHistoryForStyle, computeReorderSignal } from "./assortment-signal.js";

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
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 4 · New", firstSaleDate: "2026-08-01", sellThroughPct: 10, orderCount: 2 }).action, "GRADUATE");
  assert.equal(computeReorderSignal({ ...base, tier: "Tier 3 · Recent", firstSaleDate: "2025-10-01", orderCount: 4, planningCoverWeeks: 20 }).label, "Graduate to Tier 2");
});

test("reorder takes precedence over graduation", () => {
  const tier4Early = computeReorderSignal({
    ...base,
    tier: "Tier 4 · New",
    firstSaleDate: "2026-08-10",
    sellThroughPct: 67,
    orderCount: 3,
    planningCoverWeeks: null,
  });
  assert.equal(tier4Early.action, "REORDER");
  assert.equal(tier4Early.label, "Strong early candidate");

  const tier4WeekSix = computeReorderSignal({
    ...base,
    tier: "Tier 4 · New",
    firstSaleDate: "2026-07-20",
    sellThroughPct: 70,
    orderCount: 2,
    planningCoverWeeks: 5,
  });
  assert.equal(tier4WeekSix.action, "REORDER");
  assert.equal(tier4WeekSix.label, "Passed week 6 read — full rollout");

  const tier3 = computeReorderSignal({
    ...base,
    tier: "Tier 3 · Recent",
    firstSaleDate: "2025-10-01",
    orderCount: 4,
  });
  assert.equal(tier3.action, "REORDER");
});

test("retire beats graduate and graduate beats watch", () => {
  assert.equal(computeReorderSignal({
    ...base,
    tier: "Tier 4 · New",
    firstSaleDate: "2026-06-01",
    sellThroughPct: 65,
    orderCount: 2,
  }).action, "RETIRE");
  assert.equal(computeReorderSignal({
    ...base,
    tier: "Tier 4 · New",
    firstSaleDate: "2026-06-01",
    sellThroughPct: 75,
    orderCount: 2,
  }).action, "GRADUATE");
});

test("actual order count ignores pipeline and zero-quantity drafts", () => {
  assert.equal(actualOrderCountForStyle("V0426032", "Vivo Long Sleeve Wrap Dress in Satin", [
    { orderRef: "BO00328", styleNumber: "V0426032", styleName: "Vivo Long Sleeve Wrap Dress in Satin", quantity: 307 },
    { orderRef: "BO00330", styleNumber: "", styleName: "Vivo Long Sleeve Wrap Dress in Satin", quantity: 0 },
    { orderRef: "BO00328", styleNumber: "V0426032", styleName: "Vivo Long Sleeve Wrap Dress in Satin", quantity: 307 },
  ]), 1);
});

test("order history includes the first order and returns its latest date", () => {
  const history = actualOrderHistoryForStyle("V0226020", "Dalia", [
    { orderRef: "CT-1", orderDate: "2026-02-20", styleNumber: "V0226020", styleName: "Dalia", quantity: 579 },
  ]);
  assert.deepEqual(history, { count: 1, lastOrderDate: "2026-02-20" });
});

test("Tier 4 styles past week 16 remain eligible for reorder", () => {
  const signal = computeReorderSignal({
    ...base,
    tier: "Tier 4 · New",
    firstSaleDate: "2026-03-09",
    sellThroughPct: 84.3,
    fullPricePct: 97.3,
    daysSinceLastSale: 4,
    sellableCoverWeeks: 5,
    planningCoverWeeks: 5,
    orderCount: 1,
    today: new Date("2026-09-07T00:00:00Z"),
  });
  assert.equal(signal.action, "REORDER");
});

test("Tier 1-3 reorder gate does not depend on sell-through", () => {
  assert.equal(computeReorderSignal({ ...base, sellThroughPct: 0 }).action, "REORDER");
});

test("unavailable cover blocks cover-based reorders without blocking other Tier 4 rules", () => {
  assert.equal(computeReorderSignal({
    ...base,
    planningCoverWeeks: null,
    sellableCoverWeeks: null,
  }).action, null);
  const tier4WeekSix = computeReorderSignal({
    ...base,
    tier: "Tier 4 · New",
    firstSaleDate: "2026-07-20",
    planningCoverWeeks: null,
    sellableCoverWeeks: null,
    sellThroughPct: 60,
  });
  assert.equal(tier4WeekSix.label, "No action");
  assert.notEqual(tier4WeekSix.label, "Passed week 6 read — full rollout");
  assert.equal(computeReorderSignal({
    ...base,
    tier: "Tier 4 · New",
    firstSaleDate: "2026-08-01",
    planningCoverWeeks: null,
    sellableCoverWeeks: null,
    sellThroughPct: 40,
  }).action, "REORDER");
});

test("Tier 4 uses only the highest age band reached", () => {
  const weekEightLowSellThrough = computeReorderSignal({
    ...base,
    tier: "Tier 4 · New",
    firstSaleDate: "2026-07-10",
    sellThroughPct: 31,
    fullPricePct: 100,
    daysSinceLastSale: 2,
    planningCoverWeeks: 57,
  });
  assert.equal(weekEightLowSellThrough.action, null);
  assert.equal(weekEightLowSellThrough.label, "No action");

  const weekTenHighStock = computeReorderSignal({
    ...base,
    tier: "Tier 4 · New",
    firstSaleDate: "2026-06-26",
    sellThroughPct: 57,
    fullPricePct: 98,
    daysSinceLastSale: 1,
    planningCoverWeeks: 43,
  });
  assert.equal(weekTenHighStock.action, null);

  const weekFiveStrongEarlyCandidate = computeReorderSignal({
    ...base,
    tier: "Tier 4 · New",
    firstSaleDate: "2026-07-30",
    sellThroughPct: 68,
    planningCoverWeeks: null,
  });
  assert.equal(weekFiveStrongEarlyCandidate.action, "REORDER");
  assert.equal(weekFiveStrongEarlyCandidate.label, "Strong early candidate");
});