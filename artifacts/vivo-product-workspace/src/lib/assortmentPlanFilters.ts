export const assortmentFilterKeys = [
  'tier',
  'status',
  'category',
  'subCategory',
  'fabricCategory',
  'brand',
  'primaryColour',
  'edit',
  'proposedAction',
] as const;

export type AssortmentFilterKey = typeof assortmentFilterKeys[number];
export type AssortmentFilterState = Record<AssortmentFilterKey, string[]>;
export type AssortmentFilterableStyle = Record<AssortmentFilterKey, string | null>;
export type AssortmentSortableStyle = AssortmentFilterableStyle & {
  name: string | null;
  styleNumber: string | null;
  unitsSold?: number | null;
  revenueKes?: number | null;
  sorPct?: number | null;
  launchDate?: string | null;
  price?: number | null;
  stockUnits?: number | null;
  stockPlusPipelineUnits?: number | null;
  weeksOfCover?: number | null;
  planningCoverWeeks?: number | null;
  sellThroughPct?: number | null;
  lifetimeSellThroughPct?: number | null;
  daysSinceLastSale?: number | null;
  lastOrderDate?: string | null;
  reorderSignal?: { actionPriority?: number | null } | null;
};

export const proposedActionOptions = [
  'Reorder',
  'Retire',
  'Graduate',
  'Watch',
  'Too early / not enough history',
  'No action',
] as const;

export function proposedActionForStyle(style: {
  coverAvailable?: boolean | null;
  coverUnavailableReason?: string | null;
  reorderSignal?: { action?: string | null; label?: string | null } | null;
}) {
  const action = String(style.reorderSignal?.action ?? '').toUpperCase();
  if (action === 'REORDER') return 'Reorder';
  if (action === 'RETIRE') return 'Retire';
  if (action === 'GRADUATE') return 'Graduate';
  if (action === 'WATCH') return 'Watch';
  const label = String(style.reorderSignal?.label ?? '').toLowerCase();
  if (
    label.startsWith('too early')
    || label === 'not yet selling'
    || style.coverAvailable === false
    || Boolean(style.coverUnavailableReason)
  ) return 'Too early / not enough history';
  return 'No action';
}

export type AssortmentSearchableStyle = {
  styleNumber?: string | null;
  name?: string | null;
  designer?: string | null;
};
export type AssortmentSortKey =
  | 'units_desc'
  | 'revenue_desc'
  | 'revenue_asc'
  | 'sor_desc'
  | 'newest'
  | 'oldest'
  | 'price_desc'
  | 'price_asc'
  | 'stock_desc'
  | 'stock_asc'
  | 'stock_pipeline_desc'
  | 'stock_pipeline_asc'
  | 'weeks_of_cover_asc'
  | 'weeks_of_cover_desc'
  | 'sell_through_desc'
  | 'sell_through_asc'
  | 'last_order_asc'
  | 'last_order_desc'
  | 'days_since_last_sale_desc'
  | 'name_asc'
  | 'name_desc';

export function matchesAssortmentFilters(
  style: AssortmentFilterableStyle,
  filters: AssortmentFilterState,
) {
  return assortmentFilterKeys.every((key) => (
    filters[key].length === 0 || filters[key].includes(String(style[key] ?? ''))
  ));
}

// Keep the catalogue search contract: one case-insensitive partial match across
// the style identity and its designer.
export function matchesStyleCatalogueSearch(
  style: AssortmentSearchableStyle,
  search: string,
) {
  const term = search.trim().toLocaleLowerCase();
  if (!term) return true;
  return [style.styleNumber, style.name, style.designer]
    .some((value) => String(value ?? '').toLocaleLowerCase().includes(term));
}

export function countAssortmentStyles(styles: AssortmentFilterableStyle[]) {
  return {
    total: styles.length,
    tier1: styles.filter((style) => style.tier === 'Tier 1 · NOOS').length,
    tier2: styles.filter((style) => style.tier === 'Tier 2 · Core').length,
    tier3: styles.filter((style) => style.tier === 'Tier 3 · Recent').length,
    tier4: styles.filter((style) => style.tier === 'Tier 4 · New').length,
    retired: styles.filter((style) => style.tier === 'Retired').length,
  };
}

export function filteredAssortmentQuarterCounts<Quarter extends string>(
  quarterStyles: Record<Quarter, AssortmentFilterableStyle[]>,
  filters: AssortmentFilterState,
) {
  return Object.fromEntries(
    Object.entries(quarterStyles).map(([quarter, styles]) => [
      quarter,
      (styles as AssortmentFilterableStyle[]).filter((style) => (
        matchesAssortmentFilters(style, filters)
      )).length,
    ]),
  ) as Record<Quarter, number>;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function compareNullable(left: number | null, right: number | null, direction: 1 | -1) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return (left - right) * direction;
}

function finite(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateValue(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sortAssortmentStyles<Style extends AssortmentSortableStyle>(
  styles: Style[],
  sort: AssortmentSortKey,
) {
  return [...styles].sort((left, right) => {
    let primary = 0;
    switch (sort) {
      case 'units_desc': primary = compareNullable(finite(left.unitsSold), finite(right.unitsSold), -1); break;
      case 'revenue_desc': primary = compareNullable(finite(left.revenueKes), finite(right.revenueKes), -1); break;
      case 'revenue_asc': primary = compareNullable(finite(left.revenueKes), finite(right.revenueKes), 1); break;
      case 'sor_desc': primary = compareNullable(finite(left.sorPct), finite(right.sorPct), -1); break;
      case 'newest': primary = compareNullable(dateValue(left.launchDate), dateValue(right.launchDate), -1); break;
      case 'oldest': primary = compareNullable(dateValue(left.launchDate), dateValue(right.launchDate), 1); break;
      case 'price_desc': primary = compareNullable(finite(left.price), finite(right.price), -1); break;
      case 'price_asc': primary = compareNullable(finite(left.price), finite(right.price), 1); break;
      case 'stock_desc': primary = compareNullable(finite(left.stockUnits), finite(right.stockUnits), -1); break;
      case 'stock_asc': primary = compareNullable(finite(left.stockUnits), finite(right.stockUnits), 1); break;
      case 'stock_pipeline_desc': primary = compareNullable(finite(left.stockPlusPipelineUnits), finite(right.stockPlusPipelineUnits), -1); break;
      case 'stock_pipeline_asc': primary = compareNullable(finite(left.stockPlusPipelineUnits), finite(right.stockPlusPipelineUnits), 1); break;
      case 'weeks_of_cover_asc': primary = compareNullable(finite(left.planningCoverWeeks ?? left.weeksOfCover), finite(right.planningCoverWeeks ?? right.weeksOfCover), 1); break;
      case 'weeks_of_cover_desc': primary = compareNullable(finite(left.planningCoverWeeks ?? left.weeksOfCover), finite(right.planningCoverWeeks ?? right.weeksOfCover), -1); break;
      case 'sell_through_desc': primary = compareNullable(finite(left.lifetimeSellThroughPct ?? left.sellThroughPct), finite(right.lifetimeSellThroughPct ?? right.sellThroughPct), -1); break;
      case 'sell_through_asc': primary = compareNullable(finite(left.lifetimeSellThroughPct ?? left.sellThroughPct), finite(right.lifetimeSellThroughPct ?? right.sellThroughPct), 1); break;
      case 'last_order_asc': primary = compareNullable(dateValue(left.lastOrderDate), dateValue(right.lastOrderDate), 1); break;
      case 'last_order_desc': primary = compareNullable(dateValue(left.lastOrderDate), dateValue(right.lastOrderDate), -1); break;
      case 'days_since_last_sale_desc': primary = compareNullable(finite(left.daysSinceLastSale), finite(right.daysSinceLastSale), -1); break;
      case 'name_asc': primary = collator.compare(left.name ?? '', right.name ?? ''); break;
      case 'name_desc': primary = collator.compare(right.name ?? '', left.name ?? ''); break;
    }
    return primary
      || collator.compare(left.name ?? '', right.name ?? '')
      || collator.compare(left.styleNumber ?? '', right.styleNumber ?? '');
  });
}

export function sortAssortmentStylesByAction<Style extends AssortmentSortableStyle>(
  styles: Style[],
  sort: AssortmentSortKey,
) {
  const secondary = sortAssortmentStyles(styles, sort);
  return secondary.sort((left, right) => (
    (finite(left.reorderSignal?.actionPriority) ?? 5)
    - (finite(right.reorderSignal?.actionPriority) ?? 5)
  ));
}