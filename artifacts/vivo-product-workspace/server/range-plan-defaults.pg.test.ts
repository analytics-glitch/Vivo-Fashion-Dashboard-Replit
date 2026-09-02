import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import {
  RANGE_PLAN_AOS_COLUMN_SQL,
  rangePlanAosDefaultMigrationSql,
} from "./range-plan-defaults.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("the database persists AOS 400 when an insert omits the column", {
  skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is required",
}, async () => {
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  const schema = `range_plan_default_${process.pid}`;
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TYPE ${schema}.range_plan_tier AS ENUM ('Core')`);
    await client.query(`
      CREATE TABLE ${schema}.range_plan_seasons (
        id SERIAL PRIMARY KEY
      )
    `);
    await client.query(`INSERT INTO ${schema}.range_plan_seasons DEFAULT VALUES`);
    await client.query(`
      CREATE TABLE ${schema}.range_plan_rows (
        id SERIAL PRIMARY KEY,
        season_id INTEGER NOT NULL REFERENCES ${schema}.range_plan_seasons(id),
        sub_category TEXT NOT NULL,
        tier ${schema}.range_plan_tier NOT NULL,
        ${RANGE_PLAN_AOS_COLUMN_SQL}
      )
    `);

    await client.query(`ALTER TABLE ${schema}.range_plan_rows ALTER COLUMN aos_units SET DEFAULT 350`);
    await client.query(rangePlanAosDefaultMigrationSql(schema));
    const inserted = await client.query<{ aos_units: number }>(`
      INSERT INTO ${schema}.range_plan_rows (season_id, sub_category, tier)
      VALUES ((SELECT id FROM ${schema}.range_plan_seasons LIMIT 1), 'Dresses', 'Core')
      RETURNING aos_units
    `);

    assert.equal(inserted.rows[0]?.aos_units, 400);
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
});