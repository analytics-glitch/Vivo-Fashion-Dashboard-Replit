export type FabricAvailability = {
  colour: string | null;
  fabricName?: string | null;
  fabricBarcode?: string | null;
  exactMetres: number | null;
  otherColourMetres: number | null;
};

export type ReorderSignalTone = "green" | "amber" | "grey";
export type ProposedAction = "REORDER" | "GRADUATE" | "RETIRE" | "WATCH" | null;

export type ReorderSignal = {
  tone: ReorderSignalTone;
  label: string;
  action: ProposedAction;
  actionPriority: number;
  fabricChecked: boolean;
  fabricNote: string;
};

export type LifecycleRules = {
  tier4: Array<{ ruleKey: string; minWeeks: number; minSellThroughPct: number | null; maxSellThroughPct: number | null; minFullPricePct: number | null; maxDaysSinceLastSale: number | null; maxCoverWeeks: number | null; action: Exclude<ProposedAction, null>; label: string; priority: number }>;
  graduation: Array<{ ruleKey: string; fromTier: number; toTier: number; minMonths: number; minOrders: number; label: string }>;
  reorderGate: { minFullPricePct: number; maxDaysSinceLastSale: number; maxCoverWeeks: number };
};

type SignalInput = {
  tier: string | null;
  sellThroughPct: number | null;
  fullPricePct: number | null;
  daysSinceLastSale: number | null;
  firstSaleDate: string | null;
  orderCount: number | null;
  sellableCoverWeeks: number | null;
  planningCoverWeeks: number | null;
  fabricAvailability: FabricAvailability[];
  fabricConsumptionMetresPerUnit: number | null;
  rules: LifecycleRules;
  today?: Date;
};

const DEFAULT_FULL_BUY_UNITS = 300;

const finite = (value: unknown): number | null => {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : null;
};

export function weeksSinceFirstSale(firstSaleDate: string | null, today = new Date()): number | null {
  if (!firstSaleDate || !/^\d{4}-\d{2}-\d{2}$/.test(firstSaleDate.slice(0, 10))) return null;
  const [year, month, day] = firstSaleDate.slice(0, 10).split("-").map(Number);
  const first = Date.UTC(year, month - 1, day);
  const current = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (!Number.isFinite(first) || current < first) return null;
  return Math.floor((current - first) / (7 * 24 * 60 * 60 * 1000));
}

export function actualOrderCountForStyle(
  styleNumber: string | null | undefined,
  styleName: string | null | undefined,
  orders: Array<{ orderRef: string; styleNumber: string; styleName: string; quantity: number }>,
) {
  return actualOrderHistoryForStyle(styleNumber, styleName, orders).count;
}

export function actualOrderHistoryForStyle(
  styleNumber: string | null | undefined,
  styleName: string | null | undefined,
  orders: Array<{ orderRef: string; orderDate?: string; styleNumber: string; styleName: string; quantity: number }>,
) {
  const numberKey = String(styleNumber ?? "").trim().toLowerCase();
  const nameKey = String(styleName ?? "").trim().toLowerCase();
  const matching = orders
    .filter((order) => order.quantity > 0 && (
      (numberKey !== "" && order.styleNumber.trim().toLowerCase() === numberKey)
      || (nameKey !== "" && order.styleName.trim().toLowerCase() === nameKey)
    ));
  const dated = matching.map((order) => String(order.orderDate ?? "").slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
  return {
    count: new Set(matching.map((order) => order.orderRef)).size,
    lastOrderDate: dated.at(-1) ?? null,
  };
}

export function fabricCheck(
  availability: FabricAvailability[],
  metresPerUnit: number | null,
) {
  const rate = finite(metresPerUnit);
  const colourwayMetres = availability
    .map((row) => {
      const exact = finite(row.exactMetres);
      const other = finite(row.otherColourMetres);
      return (exact ?? 0) + (other ?? 0);
    })
    .filter((value) => value > 0);
  if (!rate || rate <= 0 || colourwayMetres.length === 0) {
    return { checked: false, supportsFullBuy: null, note: "Fabric could not be checked" };
  }
  const requiredMetres = DEFAULT_FULL_BUY_UNITS * rate;
  const supportsFullBuy = colourwayMetres.some((metres) => metres >= requiredMetres);
  return {
    checked: true,
    supportsFullBuy,
    note: supportsFullBuy ? "Fabric supports a full buy" : "Fabric is short of a full buy",
  };
}

export function computeReorderSignal(input: SignalInput): ReorderSignal {
  const fabric = fabricCheck(input.fabricAvailability, input.fabricConsumptionMetresPerUnit);
  const result = (tone: ReorderSignalTone, label: string, action: ProposedAction = null): ReorderSignal => ({
    tone,
    label,
    action,
    actionPriority: action === "REORDER" ? 1 : action === "RETIRE" ? 2 : action === "GRADUATE" ? 3 : action === "WATCH" ? 4 : 5,
    fabricChecked: fabric.checked,
    fabricNote: fabric.note,
  });
  const withReorderFabric = (label: string): ReorderSignal => {
    if (fabric.checked && fabric.supportsFullBuy === false) return result("amber", "Fabric short", "REORDER");
    return result("green", label, "REORDER");
  };
  const gate = input.rules.reorderGate;
  const tradingFresh = input.daysSinceLastSale !== null && input.daysSinceLastSale <= gate.maxDaysSinceLastSale;
  const fullPricePass = input.fullPricePct !== null && input.fullPricePct > gate.minFullPricePct;
  const isTier4 = String(input.tier ?? "").startsWith("Tier 4");
  const isTier3 = String(input.tier ?? "").startsWith("Tier 3");

  if (isTier4) {
    const ageWeeks = weeksSinceFirstSale(input.firstSaleDate, input.today);
    if (ageWeeks === null) return result("grey", "Not yet selling");
    const lifetime = input.sellThroughPct;
    const orderedRules = [...input.rules.tier4].sort((a, b) => a.priority - b.priority);
    const matches = (key: string) => orderedRules.find((rule) => rule.ruleKey === key);
    const applies = (rule: LifecycleRules["tier4"][number] | undefined) => Boolean(rule
      && ageWeeks >= rule.minWeeks
      && lifetime !== null
      && (rule.minSellThroughPct === null || lifetime >= rule.minSellThroughPct)
      && (rule.maxSellThroughPct === null || lifetime < rule.maxSellThroughPct));
    const orderGraduation = input.rules.graduation.find((rule) => rule.fromTier === 4);
    const graduationSignal = orderGraduation
      && input.orderCount !== null
      && input.orderCount >= orderGraduation.minOrders
      ? result("green", orderGraduation.label, "GRADUATE")
      : null;
    const hardStop = matches("week_16_retire");
    if (ageWeeks >= 16) {
      if (applies(hardStop)) return result("grey", hardStop!.label, "RETIRE");
      const sellablePass = input.sellableCoverWeeks !== null && input.sellableCoverWeeks <= gate.maxCoverWeeks;
      const pipelinePass = input.planningCoverWeeks !== null && input.planningCoverWeeks <= gate.maxCoverWeeks;
      if (fullPricePass && tradingFresh && pipelinePass) return withReorderFabric("Reorder candidate");
      if (fullPricePass && tradingFresh && sellablePass && !pipelinePass) {
        return graduationSignal ?? result("amber", "Order in production");
      }
      return graduationSignal ?? result("grey", "No action");
    }
    if (ageWeeks < 2) return graduationSignal ?? result("grey", `Too early · week ${ageWeeks + 1}`);
    if (ageWeeks >= 12) {
      for (const key of ["week_12_graduate", "week_12_retire", "week_12_watch"]) {
        const rule = matches(key);
        if (!applies(rule)) continue;
        const lifecycleSignal = result(rule!.action === "RETIRE" ? "grey" : rule!.action === "WATCH" ? "amber" : "green", rule!.label, rule!.action);
        if (lifecycleSignal.action === "RETIRE") return lifecycleSignal;
        if (lifecycleSignal.action === "GRADUATE") return lifecycleSignal;
        return graduationSignal ?? lifecycleSignal;
      }
      return graduationSignal ?? result("grey", "No action");
    }
    if (ageWeeks >= 6) {
      const passedRule = matches("week_6_rollout");
      const passedRead = applies(passedRule)
        && passedRule!.minFullPricePct !== null && input.fullPricePct !== null && input.fullPricePct > passedRule!.minFullPricePct
        && passedRule!.maxDaysSinceLastSale !== null && input.daysSinceLastSale !== null && input.daysSinceLastSale <= passedRule!.maxDaysSinceLastSale
        && input.planningCoverWeeks !== null
        && passedRule!.maxCoverWeeks !== null
        && input.planningCoverWeeks <= passedRule!.maxCoverWeeks;
      return passedRead ? withReorderFabric(passedRule!.label) : graduationSignal ?? result("grey", "No action");
    }
    const earlyRule = matches("week_2_early");
    if (applies(earlyRule)) return withReorderFabric(earlyRule!.label);
    return graduationSignal ?? result("grey", "No action");
  }

  let graduationSignal: ReorderSignal | null = null;
  if (isTier3) {
    const ageWeeks = weeksSinceFirstSale(input.firstSaleDate, input.today);
    const graduation = input.rules.graduation.find((rule) => rule.fromTier === 3);
    if (graduation && ageWeeks !== null && ageWeeks >= graduation.minMonths * 52 / 12
      && input.orderCount !== null && input.orderCount >= graduation.minOrders) {
      graduationSignal = result("green", graduation.label, "GRADUATE");
    }
  }
  if (!fullPricePass || !tradingFresh) return graduationSignal ?? result("grey", "No action");
  const sellablePass = input.sellableCoverWeeks !== null && input.sellableCoverWeeks <= gate.maxCoverWeeks;
  const pipelinePass = input.planningCoverWeeks !== null && input.planningCoverWeeks <= gate.maxCoverWeeks;
  if (sellablePass && !pipelinePass) return graduationSignal ?? result("amber", "Order in production");
  if (!pipelinePass) return graduationSignal ?? result("grey", "No action");
  return withReorderFabric("Reorder candidate");
}