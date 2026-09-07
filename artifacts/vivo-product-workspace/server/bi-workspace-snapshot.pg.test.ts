import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { claimBiWorkspaceSnapshot } from "./bi-workspace-snapshot.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("only one process can claim an empty BI snapshot", {
  skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is required",
}, async () => {
  const schema = `bi_snapshot_claim_${process.pid}`;
  const setup = new pg.Client({ connectionString: testDatabaseUrl });
  await setup.connect();
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`
      CREATE TABLE ${schema}.bi_workspace_snapshot (
        singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        payload jsonb,
        refresh_claimed_until timestamptz,
        refresh_claim_token text
      )
    `);
    await setup.query(
      `INSERT INTO ${schema}.bi_workspace_snapshot(singleton,payload)
       VALUES(TRUE,NULL)`,
    );

    const clients = Array.from(
      { length: 12 },
      () => new pg.Client({ connectionString: testDatabaseUrl }),
    );
    await Promise.all(clients.map((client) => client.connect()));
    try {
      const claims = await Promise.all(
        clients.map((client, index) =>
          claimBiWorkspaceSnapshot(client, schema, `claimer-${index}`)),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      const owner = await setup.query<{ refresh_claim_token: string }>(
        `SELECT refresh_claim_token
           FROM ${schema}.bi_workspace_snapshot
          WHERE singleton=TRUE`,
      );
      assert.match(owner.rows[0]?.refresh_claim_token ?? "", /^claimer-\d+$/);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  } finally {
    await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await setup.end();
  }
});