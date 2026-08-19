export const assortmentFilterKeys = [
  'tier',
  'status',
  'category',
  'subCategory',
  'fabricCategory',
  'brand',
  'primaryColour',
  'edit',
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
};
export type AssortmentSortKey =
  | 'units_desc'
  | 'revenue_desc'
  | 'sor_desc'
  | 'newest'
  | 'oldest'
  | 'price_desc'
  | 'price_asc'
  | 'stock_desc'
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
      case 'sor_desc': primary = compareNullable(finite(left.sorPct), finite(right.sorPct), -1); break;
      case 'newest': primary = compareNullable(dateValue(left.launchDate), dateValue(right.launchDate), -1); break;
      case 'oldest': primary = compareNullable(dateValue(left.launchDate), dateValue(right.launchDate), 1); break;
      case 'price_desc': primary = compareNullable(finite(left.price), finite(right.price), -1); break;
      case 'price_asc': primary = compareNullable(finite(left.price), finite(right.price), 1); break;
      case 'stock_desc': primary = compareNullable(finite(left.stockUnits), finite(right.stockUnits), -1); break;
      case 'name_asc': primary = collator.compare(left.name ?? '', right.name ?? ''); break;
      case 'name_desc': primary = collator.compare(right.name ?? '', left.name ?? ''); break;
    }
    return primary
      || collator.compare(left.name ?? '', right.name ?? '')
      || collator.compare(left.styleNumber ?? '', right.styleNumber ?? '');
  });
}