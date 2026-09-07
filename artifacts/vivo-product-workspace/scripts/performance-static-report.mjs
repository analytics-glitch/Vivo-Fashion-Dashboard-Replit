import { bundleBudgetResults, inspectBundle } from './performance-lib.mjs';

const bundle = inspectBundle();
if (!bundle.available) {
  console.error('No dist/public build is available. Run `pnpm build` before generating a static performance report.');
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    kind: 'static-bundle-report',
    bundle,
    budgets: bundleBudgetResults(bundle),
  }, null, 2));
}