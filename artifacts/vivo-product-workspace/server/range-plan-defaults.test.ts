import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  RANGE_PLAN_AOS_COLUMN_SQL,
  rangePlanAosDefault,
  rangePlanAosDefaultMigrationSql,
} from "./range-plan-defaults.js";

test("new Range Plan rows use 400 AOS unless an explicit value is supplied", () => {
  const resolveRowAos = (value: unknown) => Number(value ?? rangePlanAosDefault());

  assert.equal(resolveRowAos(undefined), 400);
  assert.equal(resolveRowAos(null), 400);
  assert.equal(resolveRowAos(725), 725);
  assert.equal(RANGE_PLAN_AOS_COLUMN_SQL, "aos_units INTEGER NOT NULL DEFAULT 400");
  assert.equal(
    rangePlanAosDefaultMigrationSql("product_workspace"),
    "ALTER TABLE product_workspace.range_plan_rows ALTER COLUMN aos_units SET DEFAULT 400",
  );
});

test("all Range Plan insertion paths use the zero-argument helper", async () => {
  const serverSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const helperCalls = [...serverSource.matchAll(/rangePlanAosDefault\(([^)]*)\)/g)];

  assert.ok(helperCalls.length >= 3);
  assert.ok(helperCalls.every((match) => match[1] === ""));
  assert.match(serverSource, /aosUnits: Number\(row\.aosUnits \?\? rangePlanAosDefault\(\)\)/);
  assert.equal((serverSource.match(/\$\{RANGE_PLAN_AOS_COLUMN_SQL\}/g) ?? []).length, 2);
  assert.match(serverSource, /rangePlanAosDefaultMigrationSql\(schema\)/);
});