export type FabricAvailability = {
  colour: string | null;
  fabricName?: string | null;
  fabricBarcode?: string | null;
  exactMetres: number | null;
  otherColourMetres: number | null;
};

export type ReorderSignalTone = "green" | "amber" | "grey";

export type ReorderSignal = {
  tone: ReorderSignalTone;
  label: string;
  fabricChecked: boolean;
  fabricNote: string;
};

type SignalInput = {
  tier: string | null;
  sellThroughPct: number | null;
  fullPricePct: number | null;
  daysSinceLastSale: number | null;
  firstSaleDate: string | null;
  sellableCoverWeeks: number | null;
  planningCoverWeeks: number | null;
  fabricAvailability: FabricAvailability[];
  fabricConsumptionMetresPerUnit: number | null;
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
  const withFabric = (tone: ReorderSignalTone, label: string): ReorderSignal => ({
    tone,
    label,
    fabricChecked: fabric.checked,
    fabricNote: fabric.note,
  });
  const tradingFresh = input.daysSinceLastSale !== null && input.daysSinceLastSale <= 7;
  const fullPricePass = input.fullPricePct !== null && input.fullPricePct > 90;
  const isTier4 = String(input.tier ?? "").startsWith("Tier 4");

  if (isTier4) {
    const ageWeeks = weeksSinceFirstSale(input.firstSaleDate, input.today);
    if (ageWeeks === null) return withFabric("grey", "Not yet selling");
    if (ageWeeks < 6) return withFabric("grey", `Too early · week ${ageWeeks + 1}`);
    const passedRead = input.sellThroughPct !== null
      && input.sellThroughPct >= 60
      && fullPricePass
      && tradingFresh
      && input.planningCoverWeeks !== null
      && input.planningCoverWeeks <= 6;
    if (passedRead) {
      if (fabric.checked && fabric.supportsFullBuy === false) return withFabric("amber", "Fabric short");
      return withFabric("green", "Passed week 6 read");
    }
    if (ageWeeks < 12) return withFabric("amber", "Watch · week 12 backstop");
    return withFabric("grey", "Missed read");
  }

  if (!fullPricePass || !tradingFresh) return withFabric("grey", "Not a candidate");
  const sellablePass = input.sellableCoverWeeks !== null && input.sellableCoverWeeks <= 8;
  const pipelinePass = input.planningCoverWeeks !== null && input.planningCoverWeeks <= 8;
  if (sellablePass && !pipelinePass) return withFabric("amber", "Order in production");
  if (!pipelinePass) return withFabric("grey", "Not a candidate");
  if (fabric.checked && fabric.supportsFullBuy === false) return withFabric("amber", "Fabric short");
  return withFabric("green", "Reorder candidate");
}