# Production Workspace preview and release-proof recovery

The managed Vivo BI artifact service is the only approved owner of port `18659`.
It starts through a crash-safe lock wrapper that records the listener identity
and only reclaims a demonstrably stale, prior managed owner from this workspace.
As a one-time migration only, it can also replace the exact pre-guard artifact
service after independently proving a stable single listener, the artifact
directory and Vite command, Node executable, direct pnpm parent, process start
identities, and the current artifact workflow registration. Missing, changed,
ambiguous, or merely similar processes are never adopted or signalled.
Do not run `pnpm --filter @workspace/vivo-bi run dev`, `vite`, the wrapper, or
`vite --port 18659` from the root shell as a recovery shortcut. A second Vite
process can serve an older build or prevent the managed service from binding.

## Post-merge or startup check

1. Run `python3 scripts/validate_vivo_bi_managed_service.py`.
   It is read-only: it confirms the artifact manifest still owns port `18659`,
   requires a stable single listener, checks the listener command, executable,
   working directory, managed identity metadata, owner record, and
   pnpm-to-Vite ancestry, then probes API liveness and readiness.
2. If it passes, leave the listener alone. It is already the managed service.
3. If it reports no listener, restart **only** the managed workflow:
   `artifacts/vivo-bi: web`. Then rerun the validator.
4. If it reports a proven stale managed owner, restart
   `artifacts/vivo-bi: web` through the managed workflow lifecycle. The wrapper
   serializes concurrent starts and may stop only that owner after a second
   identity check. A listener created before the guard can be migrated only once
   when every legacy attestation fact still matches immediately before pidfd
   signalling; the replacement is the normal marked wrapper-to-pnpm-to-Vite
   chain. If it reports an orphan, unrelated, or unproven listener, leave it
   untouched and escalate with the reported PID and process tree; the wrapper
   deliberately fails closed rather than guessing.
5. If the API check fails, restart **only** `artifacts/api-server: API Server`
   through the managed workflow lifecycle, wait for `/api/readyz`, and rerun
   the validator.

The validator deliberately does not start, stop, or kill anything. Dependency
installation also never starts Vite directly. Recovery remains inside the
managed workflow so the ownership lock and metadata survive normal lifecycle
transitions.

## Release-proof run

With the validator green, run:

```sh
VIVO_E2E_RUN_ID=<reviewable-run-id> pnpm test:e2e:production-release
```

The command runs only the four authenticated Production Command Centre flows,
uses isolated development fixtures, and writes a run-specific review directory
under `e2e/review/`. It removes runtime-only Playwright state, stages the new
bundle, then independently checks the report, exact per-flow browser logs and
traces, required screenshots, sanitised cleanup receipt, manifest hashes and
sizes, disk inventory, and Git inventory. Do not move these files into the
ignored `artifacts/vivo-bi/test-results/` directory or add other files to the
run directory.