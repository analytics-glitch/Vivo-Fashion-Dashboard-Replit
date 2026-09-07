# Task 1707 performance verification report

## How to reproduce

1. Build the workspace, then run `pnpm perf:bundle` (CI-safe budget test) and
   `pnpm perf:report` (machine-readable static report). These inspect
   `dist/public`; they do not start a server or contact an environment.
2. Run the opt-in live probe only against an approved environment:

   ```sh
   PERF_BENCH_BASE_URL=https://workspace.example \
   PERF_BENCH_AUTH_HEADER='Cookie: session=…' \
   PERF_ENFORCE_BUDGETS=true pnpm perf:live > performance/after-live.json
   ```

   `PERF_BENCH_TARGETS` can be a JSON array of `[name, path]` pairs where a
   deployment has different authenticated routes. Save stdout as the "after"
   evidence for the release.

## Before / after evidence

| Measure | Before | After | Budget / interpretation |
| --- | ---: | ---: | --- |
| Initial JS / CSS / route chunks | `baseline-before.json` | `pnpm perf:report` | 1,100 KiB initial JS; 450 KiB CSS; 650 KiB largest lazy chunk |
| Readiness, Home, catalogue, Weekly, large endpoint cold + warm | Not measured—no approved live target | `pnpm perf:live` JSON | First pass ≤ 10,000 ms; warm ≤ 5,000 ms; status < 300; body ≤ 2 MiB |
| Server phases | Not available in supplied evidence | `serverTiming` and `workspaceHeaders` fields from response | Captures every `X-Workspace-*` timing/pool/payload/cache/query header verbatim |
| 12 concurrent catalogue readers | Not measured—no approved live target | `concurrent` field from live JSON | Each status/body is checked; catalogue p95 ≤ 10,000 ms |
| Browser requests | Static import graph only | `browserRequestManifest` from static report | Initial vs lazy requests are explicitly separated; initial CSS is only `<link rel="stylesheet">` in `index.html` |

The baseline intentionally records only observed build artifacts. It does not
invent database, BI-source, pool, cold-cache, or browser timing measurements.

### Authenticated recovery sample

The final local recovery verification used a short-lived database session and
the real development services after restarting both APIs:

- The cold internal BI document completed in 56 seconds and returned 8.5 MB.
  Its three independent source reads now execute concurrently; this timing is
  operational evidence for snapshot generation, not a browser-page budget.
- The saved PostgreSQL snapshot occupied 1.50 MB and reported fresh cache
  diagnostics.
- Assortment Plan returned HTTP 200 in 3 seconds with a 1.03 MB response.
- Style Development returned HTTP 200 in 2 seconds with a 385 KB response.
- Workspace readiness returned HTTP 200 in 1.2 ms with fresh BI-cache headers.

These are a dated development-environment sample, not a replacement for the
repeatable `perf:live` release evidence against an approved signed-in target.

## Operational notes

The live runner first labels its first pass `cold-or-baseline`: it cannot
truthfully reset process/database/BI caches itself. Use an approved disposable
environment reset before invoking it when a true cold measurement is required;
do not relabel an unreset pass as cold. `PERF_ENFORCE_BUDGETS=true` requires
both the target URL and explicit auth header and fails rather than silently
skipping. It enforces first-pass and warm latency, response status/bytes, and
the twelve-reader checks.
Each response records status, elapsed time, decoded response bytes,
`Content-Length`, `Server-Timing`, and `Link`. The server currently may omit
some diagnostics; null is reported rather than inferred.

The static inspector does not charge route CSS to the shell: `initialCssBytes`
is the sum of document-linked stylesheets only. Emitted stylesheets not linked
by `index.html` are listed among the lazy browser requests.