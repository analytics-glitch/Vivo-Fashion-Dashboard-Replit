import assert from 'node:assert/strict';
import test from 'node:test';
import { groupStyleDevelopmentItems } from './styleDevelopmentBoard';

test('grouping only counts rows that remain after filters', () => {
  const rows = [
    { id: 1, brand: 'Vivo', designer: 'Mercy' },
    { id: 2, brand: 'Vivo', designer: 'Mercy' },
    { id: 3, brand: 'Zoya', designer: 'Victoria Orlando' },
  ];
  const filtered = rows.filter(row => row.brand === 'Vivo');
  const grouped = groupStyleDevelopmentItems(filtered, 'designer');
  assert.deepEqual([...grouped.entries()].map(([label, items]) => [label, items.length]), [['Mercy', 2]]);
});

test('blank categories and assignments remain visible in explicit buckets', () => {
  const rows = [{ id: 1, category: '' }, { id: 2, category: null }, { id: 3, category: 'Dresses' }];
  const categories = groupStyleDevelopmentItems(rows, 'category');
  assert.equal(categories.get('Uncategorised')?.length, 2);
  assert.equal(categories.get('Dresses')?.length, 1);

  const designers = groupStyleDevelopmentItems([{ designer: '' }, { designer: null }], 'designer');
  assert.equal(designers.get('Unassigned')?.length, 2);
});