import { LIVE_BUDGETS, percentile } from './performance-lib.mjs';

const baseUrl = process.env.PERF_BENCH_BASE_URL?.replace(/\/$/, '');
const authHeader = process.env.PERF_BENCH_AUTH_HEADER;
const targets = process.env.PERF_BENCH_TARGETS
  ? JSON.parse(process.env.PERF_BENCH_TARGETS)
  : [
      ['readiness', '/api/workspace/readyz'],
      ['home', '/api/workspace/dashboard'],
      ['catalogue', '/api/workspace/catalogue-products'],
      ['weekly', '/api/workspace/weekly-order-plan'],
      ['large', '/api/workspace/style-development-tracker'],
    ];

const enforceBudgets = process.env.PERF_ENFORCE_BUDGETS === 'true';
if (!baseUrl || !authHeader) {
  const reason = 'Live benchmarking requires PERF_BENCH_BASE_URL and PERF_BENCH_AUTH_HEADER.';
  if (enforceBudgets) {
    console.error(`${reason} Budget enforcement cannot skip an unconfigured benchmark.`);
    process.exit(1);
  } else {
    console.log(JSON.stringify({
    skipped: true,
      reason: `${reason} It is opt-in while PERF_ENFORCE_BUDGETS is not true.`,
    }));
  }
  process.exit(0);
}

const headers = authHeader ? (() => {
  const separator = authHeader.indexOf(':');
  if (separator < 1) throw new Error('PERF_BENCH_AUTH_HEADER must be "Header-Name: value"');
  return { [authHeader.slice(0, separator).trim()]: authHeader.slice(separator + 1).trim() };
})() : {};

async function request(name, path) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, { headers, redirect: 'manual' });
  const body = await response.arrayBuffer();
  return {
    name,
    path,
    status: response.status,
    durationMs: Number((performance.now() - started).toFixed(1)),
    responseBytes: body.byteLength,
    serverTiming: response.headers.get('server-timing'),
    contentLength: response.headers.get('content-length'),
    link: response.headers.get('link'),
    workspaceHeaders: Object.fromEntries(
      [...response.headers.entries()].filter(([name]) => name.toLowerCase().startsWith('x-workspace-')),
    ),
  };
}

async function pass(label) {
  return { label, results: await Promise.all(targets.map(([name, path]) => request(name, path))) };
}

const cold = await pass('cold-or-baseline');
const warm = await pass('warm');
const [concurrentTarget] = targets.filter(([name]) => name === 'catalogue').length
  ? targets.filter(([name]) => name === 'catalogue')
  : targets;
const concurrent = await Promise.all(
  Array.from({ length: LIVE_BUDGETS.concurrentReaders }, () => request(...concurrentTarget)),
);
const concurrentP95Ms = percentile(concurrent.map((result) => result.durationMs), 0.95);
const checks = [
  ...[cold, warm].flatMap((benchmarkPass) => benchmarkPass.results.map((result) => ({
    target: `${result.name}: HTTP status`, actual: result.status, budget: 299,
    pass: result.status <= 299,
  }))),
  ...[cold, warm].flatMap((benchmarkPass) => benchmarkPass.results.map((result) => ({
    target: `${result.name}: ${benchmarkPass.label} duration`,
    actual: result.durationMs,
    budget: benchmarkPass.label === 'warm' ? LIVE_BUDGETS.maxWarmMs : LIVE_BUDGETS.maxColdOrBaselineMs,
    pass: result.durationMs <= (benchmarkPass.label === 'warm'
      ? LIVE_BUDGETS.maxWarmMs : LIVE_BUDGETS.maxColdOrBaselineMs),
  }))),
  ...[cold, warm].flatMap((benchmarkPass) => benchmarkPass.results.map((result) => ({
    target: `${result.name}: response bytes`, actual: result.responseBytes, budget: LIVE_BUDGETS.maxResponseBytes,
    pass: result.responseBytes <= LIVE_BUDGETS.maxResponseBytes,
  }))),
  ...concurrent.flatMap((result, index) => [
    { target: `concurrent reader ${index + 1}: HTTP status`, actual: result.status, budget: 299, pass: result.status <= 299 },
    { target: `concurrent reader ${index + 1}: response bytes`, actual: result.responseBytes, budget: LIVE_BUDGETS.maxResponseBytes, pass: result.responseBytes <= LIVE_BUDGETS.maxResponseBytes },
  ]),
  {
    target: '12 concurrent readers catalogue p95', actual: concurrentP95Ms,
    budget: LIVE_BUDGETS.maxConcurrentP95Ms, pass: concurrentP95Ms <= LIVE_BUDGETS.maxConcurrentP95Ms,
  },
];
const report = {
  generatedAt: new Date().toISOString(), baseUrl, targets, budgets: LIVE_BUDGETS,
  passes: [cold, warm], concurrent: { readers: concurrent.length, target: concurrentTarget[0], results: concurrent, p95Ms: concurrentP95Ms },
  checks,
  browserRequestManifest: 'Not collected by the stdlib live runner; use `pnpm perf:report` for the static Vite request manifest.',
};
console.log(JSON.stringify(report, null, 2));
if (enforceBudgets && checks.some((check) => !check.pass)) process.exitCode = 1;