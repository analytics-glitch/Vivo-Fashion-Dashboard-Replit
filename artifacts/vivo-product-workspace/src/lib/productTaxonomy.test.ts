import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FISCAL_WEEKS_2026,
  MERCHANDISING_CATEGORIES,
  MERCHANDISING_SUBCATEGORIES,
  subcategoriesForCategory,
} from './productTaxonomy';

test('uses the approved top-level merchandising category order', () => {
  assert.deepEqual(MERCHANDISING_CATEGORIES, [
    'Tops',
    'Dresses',
    'Bottoms',
    'Outerwear',
    'Skirts',
    'Accessories',
    "Men's",
  ]);
});

test('provides only the approved dependent subcategories', () => {
  assert.equal(Object.keys(MERCHANDISING_SUBCATEGORIES).length, 7);
  assert.ok(subcategoriesForCategory('Tops').includes('Loose & Oversized Tops'));
  assert.ok(subcategoriesForCategory('Dresses').includes('Kaftan Dresses'));
  assert.deepEqual(subcategoriesForCategory("Men's"), ["Men's Tops", "Men's Bottoms", "Men's Outerwear"]);
  assert.ok(!subcategoriesForCategory('Tops').includes("Men's Tops"));
  assert.ok(!subcategoriesForCategory('Bottoms').includes("Men's Bottoms"));
  assert.deepEqual(subcategoriesForCategory('Two-Piece Sets'), []);
  assert.deepEqual(subcategoriesForCategory('Gift Vouchers'), []);
  assert.deepEqual(subcategoriesForCategory('Sale'), []);
  assert.deepEqual(subcategoriesForCategory(''), []);
  assert.deepEqual(subcategoriesForCategory('Other'), []);
});

test('provides the remaining 2026 fiscal weeks as Sunday end dates', () => {
  assert.equal(FISCAL_WEEKS_2026.length, 18);
  assert.equal(FISCAL_WEEKS_2026[0].label, 'Wk 35 (Aug 24 – Aug 30) (Q3)');
  assert.equal(FISCAL_WEEKS_2026[0].value, '2026-08-30');
  assert.equal(FISCAL_WEEKS_2026.at(-1)?.label, 'Wk 52 (Dec 21 – Dec 27) (Q4)');
  assert.equal(FISCAL_WEEKS_2026.at(-1)?.value, '2026-12-27');
  assert.deepEqual(FISCAL_WEEKS_2026.map((week) => week.value), [
    '2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27',
    '2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01',
    '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29', '2026-12-06',
    '2026-12-13', '2026-12-20', '2026-12-27',
  ]);
});