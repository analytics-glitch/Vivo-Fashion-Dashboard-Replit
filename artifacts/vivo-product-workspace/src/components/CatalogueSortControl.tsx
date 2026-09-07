import { ChevronDown } from 'lucide-react';

export const CATALOGUE_SORT_OPTIONS = [
  { value: 'units_desc', label: 'Best Sellers — Units' },
  { value: 'revenue_desc', label: 'Best Sellers — Revenue' },
  { value: 'revenue_asc', label: 'Revenue — Low to High' },
  { value: 'sell_through_desc', label: 'Sell-through — High to Low' },
  { value: 'sell_through_asc', label: 'Sell-through — Low to High' },
  { value: 'weeks_of_cover_asc', label: 'Cover — Low to High' },
  { value: 'weeks_of_cover_desc', label: 'Cover — High to Low' },
  { value: 'stock_pipeline_desc', label: 'SOH + Pipeline — High to Low' },
  { value: 'stock_pipeline_asc', label: 'SOH + Pipeline — Low to High' },
  { value: 'newest', label: 'Launch Date — Newest' },
  { value: 'oldest', label: 'Launch Date — Oldest' },
  { value: 'last_order_asc', label: 'Last Order — Oldest' },
  { value: 'last_order_desc', label: 'Last Order — Newest' },
  { value: 'sor_desc', label: 'Period SOR — Highest' },
  { value: 'price_desc', label: 'Price — High to Low' },
  { value: 'price_asc', label: 'Price — Low to High' },
  { value: 'stock_desc', label: 'Sellable Stock — High to Low' },
  { value: 'stock_asc', label: 'Sellable Stock — Low to High' },
  { value: 'days_since_last_sale_desc', label: 'Days Since Last Sale — Highest' },
  { value: 'name_asc', label: 'Name A–Z' },
  { value: 'name_desc', label: 'Name Z–A' },
] as const;

export type CatalogueSortKey = (typeof CATALOGUE_SORT_OPTIONS)[number]['value'];

export default function CatalogueSortControl({
  value,
  onChange,
  testId,
}: {
  value: CatalogueSortKey;
  onChange: (value: CatalogueSortKey) => void;
  testId: string;
}) {
  return (
    <label className="catalogue-sort-control">
      <span>SORT</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as CatalogueSortKey)}
        aria-label="Sort by"
        data-testid={testId}
      >
        {CATALOGUE_SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <ChevronDown size={13} aria-hidden="true" />
    </label>
  );
}