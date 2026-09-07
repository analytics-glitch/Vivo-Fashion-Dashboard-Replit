import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

export const KIB = 1024;

export const BUNDLE_BUDGETS = {
  // The current shell includes shared React/vendor modules. This ratchets from
  // observed output while still preventing a further large shared-entry jump.
  initialJavaScriptBytes: 1100 * KIB,
  initialCssBytes: 450 * KIB,
  totalJavaScriptBytes: 3 * 1024 * KIB,
  largestLazyChunkBytes: 650 * KIB,
};

export const LIVE_BUDGETS = {
  // This is deliberately looser than warm: the runner cannot reset caches and
  // calls the first result "cold-or-baseline" unless reset happens externally.
  maxColdOrBaselineMs: 10_000,
  maxWarmMs: 5_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxConcurrentP95Ms: 10_000,
  concurrentReaders: 12,
};

function filesBelow(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function importsFrom(source) {
  const imports = new Set();
  for (const match of source.matchAll(/(?:import|from)\s*["'](\.?\/[^"']+\.js)["']/g)) imports.add(match[1]);
  return [...imports];
}

function emittedAssetPath(url) {
  const assetsOffset = url.indexOf('/assets/');
  return assetsOffset >= 0 ? url.slice(assetsOffset + 1) : null;
}

/**
 * Reads Vite's emitted assets without requiring a browser. Dynamic imports are
 * recorded separately so the report distinguishes initial shell bytes from
 * route-only chunks.
 */
export function inspectBundle(distDirectory = 'dist/public') {
  const assetsDirectory = join(distDirectory, 'assets');
  const files = filesBelow(assetsDirectory);
  const assets = files.map((path) => ({
    path: relative(distDirectory, path).replaceAll('\\', '/'),
    name: basename(path),
    extension: extname(path),
    bytes: statSync(path).size,
  }));
  const htmlPath = join(distDirectory, 'index.html');
  const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : '';
  const entryMatch = html.match(/<script[^>]+src=["']([^"']+\.js)["']/);
  // Vite's configured base (for example /product-workspace/) precedes assets
  // in HTML but is not part of the emitted filesystem path.
  const entry = emittedAssetPath(entryMatch?.[1] ?? '');
  const initialStylesheets = new Set(
    [...html.matchAll(/<link\b[^>]*>/gi)]
      .filter(([tag]) => /\brel=["']stylesheet["']/i.test(tag))
      .map(([tag]) => tag.match(/\bhref=["']([^"']+)["']/i)?.[1])
      .map((href) => href ? emittedAssetPath(href) : null)
      .filter(Boolean),
  );
  const byPath = new Map(assets.map((asset) => [asset.path, asset]));
  const initial = new Set();
  const visit = (assetPath) => {
    if (initial.has(assetPath)) return;
    initial.add(assetPath);
    const diskPath = join(distDirectory, assetPath);
    if (!existsSync(diskPath)) return;
    for (const imported of importsFrom(readFileSync(diskPath, 'utf8'))) {
      const resolved = join(assetPath, '..', imported).replaceAll('\\', '/');
      visit(resolved);
    }
  };
  if (entry) visit(entry);
  const javascript = assets.filter((asset) => asset.extension === '.js');
  const css = assets.filter((asset) => asset.extension === '.css');
  const initialJavaScript = javascript.filter((asset) => initial.has(asset.path));
  const lazyJavaScript = javascript.filter((asset) => !initial.has(asset.path));
  const lazyCss = css.filter((asset) => !initialStylesheets.has(asset.path));
  return {
    available: existsSync(htmlPath),
    distDirectory,
    entry,
    assets,
    browserRequestManifest: {
      method: 'static Vite import graph (not a browser trace)',
      initialRequests: [...new Set([...initial, ...initialStylesheets])].sort(),
      lazyRequests: [...lazyJavaScript, ...lazyCss].map((asset) => asset.path).sort(),
    },
    totals: {
      initialJavaScriptBytes: initialJavaScript.reduce((sum, asset) => sum + asset.bytes, 0),
      initialCssBytes: css
        .filter((asset) => initialStylesheets.has(asset.path))
        .reduce((sum, asset) => sum + asset.bytes, 0),
      totalJavaScriptBytes: javascript.reduce((sum, asset) => sum + asset.bytes, 0),
      largestLazyChunkBytes: Math.max(0, ...lazyJavaScript.map((asset) => asset.bytes)),
    },
  };
}

export function bundleBudgetResults(bundle) {
  return Object.entries(BUNDLE_BUDGETS).map(([metric, budget]) => ({
    metric,
    actual: bundle.totals[metric],
    budget,
    pass: bundle.totals[metric] <= budget,
  }));
}

export function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}