export const RANGE_PLAN_AOS_DEFAULT = 400;
export const RANGE_PLAN_AOS_COLUMN_SQL =
  `aos_units INTEGER NOT NULL DEFAULT ${RANGE_PLAN_AOS_DEFAULT}`;

export const rangePlanAosDefault = () => RANGE_PLAN_AOS_DEFAULT;

export function rangePlanAosDefaultMigrationSql(schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error("Invalid PostgreSQL schema name");
  }
  return `ALTER TABLE ${schema}.range_plan_rows ALTER COLUMN aos_units SET DEFAULT ${RANGE_PLAN_AOS_DEFAULT}`;
}