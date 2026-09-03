export type StyleDevelopmentGroupBy =
  | 'stage'
  | 'status'
  | 'targetOrderWeek'
  | 'category'
  | 'subCategory'
  | 'type'
  | 'tier'
  | 'brand'
  | 'patternMaker'
  | 'designer'
  | 'collection'
  | 'theme'
  | 'knitOrWoven'
  | 'printOrSolid'
  | 'launchMonth'
  | 'blocked';

type GroupableStyle = Partial<Record<StyleDevelopmentGroupBy, unknown>> & { blocked?: boolean };

export function styleDevelopmentGroupLabel(item: GroupableStyle, groupBy: StyleDevelopmentGroupBy) {
  if (groupBy === 'blocked') return item.blocked ? 'Blocked' : 'Not Blocked';
  const value = item[groupBy];
  if (value !== null && value !== undefined && String(value).trim()) return String(value);
  return groupBy === 'category' || groupBy === 'subCategory' ? 'Uncategorised' : 'Unassigned';
}

export function groupStyleDevelopmentItems<T extends GroupableStyle>(items: T[], groupBy: StyleDevelopmentGroupBy) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const label = styleDevelopmentGroupLabel(item, groupBy);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return groups;
}