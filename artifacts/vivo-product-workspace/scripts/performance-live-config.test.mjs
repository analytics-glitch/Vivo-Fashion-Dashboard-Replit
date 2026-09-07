import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { LIVE_BUDGETS } from './performance-lib.mjs';

test('live budgets explicitly cover baseline, warm, payload, and 12 readers', () => {
  assert.equal(LIVE_BUDGETS.concurrentReaders, 12);
  assert.ok(LIVE_BUDGETS.maxColdOrBaselineMs >= LIVE_BUDGETS.maxWarmMs);
  assert.ok(LIVE_BUDGETS.maxResponseBytes > 0);
  assert.ok(LIVE_BUDGETS.maxConcurrentP95Ms > 0);
});

test('enforced live benchmark fails rather than skipping without target and auth', () => {
  const env = { ...process.env, PERF_ENFORCE_BUDGETS: 'true' };
  delete env.PERF_BENCH_BASE_URL;
  delete env.PERF_BENCH_AUTH_HEADER;
  const result = spawnSync(process.execPath, ['scripts/performance-live.mjs'], {
    cwd: process.cwd(), env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires PERF_BENCH_BASE_URL and PERF_BENCH_AUTH_HEADER/);
});