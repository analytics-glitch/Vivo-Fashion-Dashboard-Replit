import { ChevronDown } from 'lucide-react';

export const CATALOGUE_SORT_OPTIONS = [
  { value: 'units_desc', label: 'Best Sellers — Units' },
  { value: 'revenue_desc', label: 'Best Sellers — Revenue' },
  { value: 'sor_desc', label: 'SOR % — Highest' },
  { value: 'newest', label: 'Newest First' },
  { value: 'oldest', label: 'Oldest First' },
  { value: 'price_desc', label: 'Price — High to Low' },
  { value: 'price_asc', label: 'Price — Low to High' },
  { value: 'stock_desc', label: 'Stock — Most Available' },
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