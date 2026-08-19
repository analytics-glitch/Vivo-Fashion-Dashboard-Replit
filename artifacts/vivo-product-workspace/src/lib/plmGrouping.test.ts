import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceStyle } from '@workspace/api-client-react';
import {
  buildPlmBoardColumns,
  GROUP_BY_OPTIONS,
  groupKeysFor,
  groupValueFor,
  PLM_GROUP_STAGES,
  PRODUCT_TIER_ORDER,
} from './plmGrouping';

const style = (id: number, values: Partial<WorkspaceStyle> & { season?: string | null } = {}): WorkspaceStyle => ({
  id,
  code: `ST-${id}`,
  name: `Style ${id}`,
  brand: 'Vivo',
  category: 'Dresses',
  status: 'active',
  owner: 'Unassigned',
  targetDate: '2026-08-20',
  currentStage: 'concept',
  ...values,
});

test('offers the requested PLM grouping modes in order', () => {
  assert.deepEqual(
    GROUP_BY_OPTIONS.map((option) => option.label),
    [
      'PLM Stage',
      'By Designer',
      'By Status',
      'By Collection',
      'By Sub-category',
      'By Edit',
      'By Brand',
      'By Product Tier',
      'By Launch Week',
    ],
  );
});

test('changing the group mode rebuilds the board columns', () => {
  const styles = [
    style(1, { currentStage: 'pattern', designer: 'Amina' }),
    style(2, { currentStage: 'sampling', designer: 'Wanjiku' }),
  ];
  const stageColumns = buildPlmBoardColumns(styles, 'stage');
  const designerColumns = buildPlmBoardColumns(styles, 'designer');

  assert.deepEqual(stageColumns.map((column) => column.key), [...PLM_GROUP_STAGES]);
  assert.deepEqual(designerColumns.map((column) => column.key), ['Amina', 'Wanjiku']);
  assert.equal(designerColumns[0].styles[0].id, 1);
  assert.equal(designerColumns[1].styles[0].id, 2);
});

test('applies filters before assigning cards and counts to columns', () => {
  const allStyles = [
    style(1, { designer: 'Amina', brand: 'Vivo' }),
    style(2, { designer: 'Amina', brand: 'Safari by Vivo' }),
    style(3, { designer: 'Wanjiku', brand: 'Vivo' }),
  ];
  const filtered = allStyles.filter((item) => item.brand === 'Vivo');
  const columns = buildPlmBoardColumns(filtered, 'designer', allStyles);

  assert.deepEqual(columns.map((column) => [column.key, column.styles.length]), [
    ['Amina', 1],
    ['Wanjiku', 1],
  ]);
  assert.deepEqual(columns.flatMap((column) => column.styles.map((item) => item.id)), [1, 3]);
});

test('falls back to an Unassigned designer column', () => {
  const item = style(1, { designer: '', owner: '', styleTeam: { design: null, pattern: null, cad: null, sample: null, buying: null } });
  assert.equal(groupValueFor(item, 'designer'), 'Unassigned');
});

test('uses requested stage, brand, and product-tier ordering', () => {
  const styles = [
    style(1, { currentStage: 'set_sample', brand: 'Zoya', rangeTier: 'Tier 4' }),
    style(2, { currentStage: 'fit_session', brand: 'Vivo', rangeTier: 'Tier 1' }),
    style(3, { currentStage: 'production', brand: 'Safari by Vivo', rangeTier: 'Tier 2' }),
  ];

  assert.deepEqual(groupKeysFor(styles, 'stage'), [...PLM_GROUP_STAGES]);
  assert.deepEqual(groupKeysFor(styles, 'brand'), ['Vivo', 'Safari by Vivo', 'Zoya']);
  assert.deepEqual(groupKeysFor(styles, 'productTier'), [...PRODUCT_TIER_ORDER]);
  assert.equal(groupValueFor(styles[0], 'stage'), 'Pre-Production Sample');
  assert.equal(groupValueFor(styles[1], 'stage'), 'Fit Sample');
});

test('groups source collection, edit, sub-category, status, and tier values', () => {
  const item = style(1, {
    season: 'Q4 2026',
    theme: 'Resort',
    subCategory: 'Maxi Dresses',
    currentStage: 'production',
    rangeTier: 'Tier 3',
  });

  assert.equal(groupValueFor(item, 'collection'), 'Q4 2026');
  assert.equal(groupValueFor(item, 'edit'), 'Resort');
  assert.equal(groupValueFor(item, 'subCategory'), 'Maxi Dresses');
  assert.equal(groupValueFor(item, 'status'), 'Near Launch');
  assert.equal(groupValueFor(item, 'productTier'), 'Tier 3 · Recent');
});

test('normalizes and chronologically sorts launch weeks', () => {
  const styles = [
    style(1, { season: 'Q4 2026', targetOrderWeek: 'WK 41' }),
    style(2, { season: 'Q3 2026', targetOrderWeek: 'WK 33' }),
    style(3, { season: 'Q4 2026', targetOrderWeek: 'Week 3 2027' }),
    style(4, { targetOrderWeek: null }),
  ];

  assert.deepEqual(groupKeysFor(styles, 'launchWeek'), [
    'Week 33 · 2026',
    'Week 41 · 2026',
    'Week 3 · 2027',
    'No launch week',
  ]);
});