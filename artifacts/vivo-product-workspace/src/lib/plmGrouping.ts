import type { WorkspaceStyle } from '@workspace/api-client-react';

export const MAIN_STAGES = [
  'Concept',
  'Initial Design Tech Pack',
  'Pattern',
  'Initial Sample',
  'Fit Session',
  'Approved',
  'Grading',
  'Costing Sample',
  'In Development',
  'Production',
  'Launched',
] as const;

export const SIDE_STAGES = ['On Hold', 'Dropped'] as const;
export const ALL_STAGES = [...MAIN_STAGES, ...SIDE_STAGES];

export const PLM_GROUP_STAGES = [
  'Concept',
  'Initial Design Tech Pack',
  'Pattern',
  'Initial Sample',
  'Fit Sample',
  'Pre-Production Sample',
  'Production',
  'Launched',
  ...SIDE_STAGES,
] as const;

export type PlmStage = typeof ALL_STAGES[number];
export type GroupBy =
  | 'stage'
  | 'designer'
  | 'status'
  | 'collection'
  | 'subCategory'
  | 'edit'
  | 'brand'
  | 'productTier'
  | 'launchWeek';

type PlmGroupingStyle = WorkspaceStyle & {
  season?: string | null;
  edit?: string | null;
};

export const GROUP_BY_OPTIONS: Array<{ value: GroupBy; label: string }> = [
  { value: 'stage', label: 'PLM Stage' },
  { value: 'designer', label: 'By Designer' },
  { value: 'status', label: 'By Status' },
  { value: 'collection', label: 'By Collection' },
  { value: 'subCategory', label: 'By Sub-category' },
  { value: 'edit', label: 'By Edit' },
  { value: 'brand', label: 'By Brand' },
  { value: 'productTier', label: 'By Product Tier' },
  { value: 'launchWeek', label: 'By Launch Week' },
];

const BRAND_ORDER = ['Vivo', 'Safari by Vivo', 'Safari', 'Zoya'] as const;
const STATUS_ORDER = ['Active', 'On Hold', 'Dropped', 'Near Launch'] as const;
export const PRODUCT_TIER_ORDER = [
  'Tier 1 · NOOS',
  'Tier 2 · Core',
  'Tier 3 · Recent',
  'Tier 4 · New',
] as const;

const cleanText = (value: unknown, fallback: string) => {
  if (value === null || value === undefined) return fallback;
  const cleaned = String(value).trim();
  return cleaned || fallback;
};

const PLM_STAGE_ALIASES: Record<string, PlmStage> = {
  brief: 'Concept',
  concept: 'Concept',
  idea: 'Concept',
  review: 'Initial Design Tech Pack',
  initial_design_tech_pack: 'Initial Design Tech Pack',
  pattern: 'Pattern',
  sampling: 'Initial Sample',
  sample: 'Initial Sample',
  initial_sample: 'Initial Sample',
  sample_review: 'Fit Session',
  fit: 'Fit Session',
  fit_session: 'Fit Session',
  approved: 'Approved',
  adopted: 'Approved',
  grading: 'Grading',
  set_sample: 'Costing Sample',
  costing_sample: 'Costing Sample',
  development: 'In Development',
  in_development: 'In Development',
  in_progress: 'In Development',
  buying: 'Production',
  production: 'Production',
  launched: 'Launched',
  live: 'Launched',
  on_hold: 'On Hold',
  hold: 'On Hold',
  dropped: 'Dropped',
  archived: 'Dropped',
  cancelled: 'Dropped',
};

export const stageFor = (style: WorkspaceStyle): PlmStage => {
  const candidate = cleanText(style.currentStage || style.stage || style.status, 'Concept');
  const normalized = candidate.toLowerCase().replace(/[-\s]+/g, '_');
  return PLM_STAGE_ALIASES[normalized]
    || ALL_STAGES.find((stage) => stage.toLowerCase() === candidate.toLowerCase())
    || (candidate.match(/hold/i) ? 'On Hold' : candidate.match(/drop|cancel|archiv/i) ? 'Dropped' : 'Concept');
};

export const stageIndex = (stage: string) => MAIN_STAGES.indexOf(stage as typeof MAIN_STAGES[number]);

const plmGroupStageFor = (style: WorkspaceStyle): typeof PLM_GROUP_STAGES[number] => {
  const stage = stageFor(style);
  if (stage === 'Fit Session') return 'Fit Sample';
  if (['Approved', 'Grading', 'Costing Sample', 'In Development'].includes(stage)) return 'Pre-Production Sample';
  return stage as typeof PLM_GROUP_STAGES[number];
};

const statusFor = (style: WorkspaceStyle) => {
  const stage = stageFor(style);
  if (stage === 'On Hold' || stage === 'Dropped') return stage;
  const rawStatus = cleanText(style.status, '');
  if (rawStatus && !/^(active|open|in progress)$/i.test(rawStatus)) return rawStatus;
  return stageIndex(stage) >= 8 ? 'Near Launch' : 'Active';
};

const productTierFor = (style: WorkspaceStyle) => {
  const raw = cleanText(style.rangeTier || style.tier, '').toLowerCase();
  if (raw === 'tier 1' || raw === '1' || raw === 'noos') return PRODUCT_TIER_ORDER[0];
  if (raw === 'tier 2' || raw === '2' || raw === 'core') return PRODUCT_TIER_ORDER[1];
  if (raw === 'tier 3' || raw === '3' || raw === 'recent') return PRODUCT_TIER_ORDER[2];
  if (raw === 'tier 4' || raw === '4' || raw === 'new') return PRODUCT_TIER_ORDER[3];
  return 'No product tier';
};

const isoWeekParts = (value: Date) => {
  const date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year, week };
};

const launchWeekParts = (style: PlmGroupingStyle) => {
  const raw = cleanText(style.plannedLaunchWeek || style.targetOrderWeek, '');
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const parsed = new Date(`${raw.slice(0, 10)}T12:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) return isoWeekParts(parsed);
  }

  const weekMatch = raw.match(/(?:^|\b)(?:wk|week|w)?\s*[-:]?\s*(\d{1,2})(?:\b|$)/i);
  if (weekMatch) {
    const week = Number(weekMatch[1]);
    if (week >= 1 && week <= 53) {
      const explicitYear = raw.match(/\b(20\d{2})\b/)?.[1];
      const seasonYear = cleanText(style.season, '').match(/\b(20\d{2})\b/)?.[1];
      const targetYear = cleanText(style.targetDate, '').match(/^(\d{4})/)?.[1];
      const year = Number(explicitYear || seasonYear || targetYear || 0);
      return { year, week };
    }
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : isoWeekParts(parsed);
};

const launchWeekFor = (style: PlmGroupingStyle) => {
  const parts = launchWeekParts(style);
  if (!parts) return cleanText(style.plannedLaunchWeek || style.targetOrderWeek, 'No launch week');
  return parts.year ? `Week ${parts.week} · ${parts.year}` : `Week ${parts.week}`;
};

const launchWeekSortKey = (label: string) => {
  if (label === 'No launch week') return Number.MAX_SAFE_INTEGER;
  const match = label.match(/^Week (\d{1,2})(?: · (20\d{2}))?$/);
  if (!match) return Number.MAX_SAFE_INTEGER - 1;
  return Number(match[2] || 0) * 100 + Number(match[1]);
};

export const groupLabel = (groupBy: GroupBy) =>
  GROUP_BY_OPTIONS.find((option) => option.value === groupBy)?.label || 'PLM Stage';

export const groupSlug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'uncategorised';

export const groupValueFor = (workspaceStyle: WorkspaceStyle, groupBy: GroupBy): string => {
  const style = workspaceStyle as PlmGroupingStyle;
  if (groupBy === 'stage') return plmGroupStageFor(style);
  if (groupBy === 'designer') return cleanText(style.styleTeam?.design?.name || style.designer || style.owner, 'Unassigned');
  if (groupBy === 'status') return statusFor(style);
  if (groupBy === 'collection') return cleanText(style.season, 'No collection');
  if (groupBy === 'subCategory') return cleanText(style.subCategory, 'Uncategorised');
  if (groupBy === 'edit') return cleanText(style.edit || style.theme, 'No edit');
  if (groupBy === 'brand') return cleanText(style.brand, 'No brand');
  if (groupBy === 'productTier') return productTierFor(style);
  return launchWeekFor(style);
};

const distinctValues = (styles: WorkspaceStyle[], groupBy: GroupBy) =>
  Array.from(new Set(styles.map((style) => groupValueFor(style, groupBy))));

const orderedActualValues = (values: string[], preferredOrder: readonly string[]) => {
  const preferred = preferredOrder.filter((value) => values.includes(value));
  const remaining = values
    .filter((value) => !preferredOrder.includes(value))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return [...preferred, ...remaining];
};

export const groupKeysFor = (styles: WorkspaceStyle[], groupBy: GroupBy) => {
  if (groupBy === 'stage') return [...PLM_GROUP_STAGES];
  const values = distinctValues(styles, groupBy);
  if (groupBy === 'brand') return orderedActualValues(values, BRAND_ORDER);
  if (groupBy === 'status') return orderedActualValues(values, STATUS_ORDER);
  if (groupBy === 'productTier') {
    const missing = values.includes('No product tier') ? ['No product tier'] : [];
    return [...PRODUCT_TIER_ORDER, ...missing];
  }
  if (groupBy === 'launchWeek') {
    return values.sort((a, b) => launchWeekSortKey(a) - launchWeekSortKey(b) || a.localeCompare(b));
  }
  return values.sort((a, b) => {
    const aMissing = /^(unassigned|no |uncategorised)/i.test(a);
    const bMissing = /^(unassigned|no |uncategorised)/i.test(b);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
};

export const buildPlmBoardColumns = (
  visibleStyles: WorkspaceStyle[],
  groupBy: GroupBy,
  keySourceStyles: WorkspaceStyle[] = visibleStyles,
) => groupKeysFor(keySourceStyles, groupBy).map((key) => ({
  key,
  styles: visibleStyles.filter((style) => groupValueFor(style, groupBy) === key),
}));