import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleBudgetResults, inspectBundle } from './performance-lib.mjs';

test('production bundle is present and stays within checked-in budgets', () => {
  const bundle = inspectBundle();
  assert.ok(bundle.available, 'dist/public/index.html is required; run pnpm build before this check');
  assert.ok(bundle.entry, 'Vite HTML must reference an entry script');
  assert.ok(bundle.assets.some((asset) => asset.extension === '.css'), 'expected an emitted stylesheet');
  for (const result of bundleBudgetResults(bundle)) {
    assert.ok(
      result.pass,
      `${result.metric}: ${result.actual} bytes exceeds ${result.budget} byte budget`,
    );
  }
});

test('browser request manifest separates initial shell and lazy route chunks', () => {
  const bundle = inspectBundle();
  const manifest = bundle.browserRequestManifest;
  assert.ok(manifest.initialRequests.length > 0, 'expected initial browser requests');
  assert.ok(manifest.lazyRequests.length > 0, 'expected route chunks outside the initial shell');
  assert.ok(
    manifest.initialRequests.some((request) => request.endsWith('.css')),
    'only a document-linked stylesheet may count toward initial CSS',
  );
  const emittedCss = bundle.assets.filter((asset) => asset.extension === '.css').map((asset) => asset.path);
  const manifestCss = [...manifest.initialRequests, ...manifest.lazyRequests].filter((path) => path.endsWith('.css'));
  assert.deepEqual([...new Set(manifestCss)].sort(), emittedCss.sort(), 'every emitted stylesheet must be initial or lazy');
});