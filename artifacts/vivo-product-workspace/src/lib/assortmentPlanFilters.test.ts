import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assortmentFilterKeys,
  countAssortmentStyles,
  filteredAssortmentQuarterCounts,
  matchesAssortmentFilters,
  sortAssortmentStyles,
  type AssortmentFilterState,
  type AssortmentFilterableStyle,
} from './assortmentPlanFilters';

const emptyFilters = (): AssortmentFilterState => ({
  tier: [],
  status: [],
  category: [],
  subCategory: [],
  fabricCategory: [],
  brand: [],
  primaryColour: [],
  edit: [],
});

const activeStyle: AssortmentFilterableStyle = {
  tier: 'Tier 1 · NOOS',
  status: 'Active',
  category: 'Dresses',
  subCategory: 'Maxi Dresses',
  fabricCategory: 'Knit',
  brand: 'Vivo',
  primaryColour: 'Blue',
  edit: 'Essentials',
};

const retiredStyle: AssortmentFilterableStyle = {
  tier: 'Retired',
  status: 'Retired',
  category: 'Tops',
  subCategory: 'Blouses',
  fabricCategory: 'Woven',
  brand: 'Safari',
  primaryColour: 'Red',
  edit: 'Archive',
};

test('each of the eight filters matches its selected database value', () => {
  for (const key of assortmentFilterKeys) {
    const filters = emptyFilters();
    filters[key] = [String(activeStyle[key])];
    assert.equal(matchesAssortmentFilters(activeStyle, filters), true, key);
    assert.equal(matchesAssortmentFilters(retiredStyle, filters), false, key);
  }
});

test('multi-select is OR within a filter and AND across filters', () => {
  const filters = emptyFilters();
  filters.tier = ['Tier 1 · NOOS', 'Retired'];
  assert.equal(matchesAssortmentFilters(activeStyle, filters), true);
  assert.equal(matchesAssortmentFilters(retiredStyle, filters), true);

  filters.status = ['Active'];
  assert.equal(matchesAssortmentFilters(activeStyle, filters), true);
  assert.equal(matchesAssortmentFilters(retiredStyle, filters), false);
});

test('a null active tier stays visible unfiltered and is excluded by tier selections', () => {
  const unclassified = { ...activeStyle, tier: null };
  assert.equal(matchesAssortmentFilters(unclassified, emptyFilters()), true);

  const filters = emptyFilters();
  filters.tier = ['Tier 1 · NOOS'];
  assert.equal(matchesAssortmentFilters(unclassified, filters), false);
});

test('tier summaries and both quarter badges use the filtered style sets', () => {
  const tier2 = { ...activeStyle, tier: 'Tier 2 · Core' };
  assert.deepEqual(countAssortmentStyles([activeStyle, tier2, retiredStyle]), {
    total: 3,
    tier1: 1,
    tier2: 1,
    tier3: 0,
    tier4: 0,
    retired: 1,
  });

  const filters = emptyFilters();
  filters.status = ['Active'];
  assert.deepEqual(filteredAssortmentQuarterCounts({
    'Q3 2026': [activeStyle, retiredStyle],
    'Q4 2026': [activeStyle, tier2, retiredStyle],
  }, filters), {
    'Q3 2026': 1,
    'Q4 2026': 2,
  });
});

test('catalogue-style sorting is deterministic and places null metrics last', () => {
  const styles = [
    { ...activeStyle, name: 'Bravo', styleNumber: 'B-2', unitsSold: 12, price: 2000, launchDate: '2026-02-01' },
    { ...activeStyle, name: 'Alpha', styleNumber: 'A-1', unitsSold: 12, price: 1000, launchDate: '2026-01-01' },
    { ...activeStyle, name: 'Unlaunched', styleNumber: 'U-9', unitsSold: null, price: null, launchDate: null },
  ];
  assert.deepEqual(
    sortAssortmentStyles(styles, 'units_desc').map((style) => style.styleNumber),
    ['A-1', 'B-2', 'U-9'],
  );
  assert.deepEqual(
    sortAssortmentStyles(styles, 'price_asc').map((style) => style.styleNumber),
    ['A-1', 'B-2', 'U-9'],
  );
  assert.deepEqual(
    sortAssortmentStyles(styles, 'name_desc').map((style) => style.styleNumber),
    ['U-9', 'B-2', 'A-1'],
  );
});