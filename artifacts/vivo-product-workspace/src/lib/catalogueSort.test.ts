import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOGUE_SORT_OPTIONS } from '../components/CatalogueSortControl';

test('catalogue sort menu exposes the complete ordered contract', () => {
  assert.deepEqual(
    CATALOGUE_SORT_OPTIONS.map(({ value }) => value),
    [
      'units_desc',
      'revenue_desc',
      'sor_desc',
      'newest',
      'oldest',
      'price_desc',
      'price_asc',
      'stock_desc',
      'name_asc',
      'name_desc',
    ],
  );
  assert.equal(CATALOGUE_SORT_OPTIONS[0].label, 'Best Sellers — Units');
  assert.equal(new Set(CATALOGUE_SORT_OPTIONS.map(({ value }) => value)).size, CATALOGUE_SORT_OPTIONS.length);
});