# Production Workspace preview and release-proof recovery

The managed Vivo BI artifact service is the only approved owner of port `18659`.
Do not run `pnpm --filter @workspace/vivo-bi run dev`, `vite`, or
`vite --port 18659` from the root shell as a recovery shortcut. A second Vite
process can serve an older build or prevent the managed service from binding.

## Post-merge or startup check

1. Run `python3 scripts/validate_vivo_bi_managed_service.py`.
   It is read-only: it confirms the artifact manifest still owns port `18659`,
   requires exactly one listener, checks that listener's process ancestry for
   the managed Vivo BI command, and probes API liveness and readiness.
2. If it passes, leave the listener alone. It is already the managed service.
3. If it reports no listener, restart **only** the managed workflow:
   `artifacts/vivo-bi: web`. Then rerun the validator.
4. If it reports an orphan or more than one listener, inspect the exact PID and
   process tree with `lsof -nP -iTCP:18659 -sTCP:LISTEN` and
   `ps -fp <pid>`. Stop only the confirmed orphan, then restart
   `artifacts/vivo-bi: web` through the managed workflow lifecycle. Never
   start a replacement Vite process manually.
5. If the API check fails, restart **only** `artifacts/api-server: API Server`
   through the managed workflow lifecycle, wait for `/api/readyz`, and rerun
   the validator.

The validator deliberately does not start, stop, or kill anything. That keeps
the recovery path from accidentally creating a competing frontend owner.

## Release-proof run

With the validator green, run:

```sh
VIVO_E2E_RUN_ID=<reviewable-run-id> pnpm test:e2e:production-release
```

The command runs only the four authenticated Production Command Centre flows,
uses isolated development fixtures, and writes a run-specific review directory
under `e2e/review/`. The evidence validator rejects a run unless the report,
screenshots, traces, per-flow browser logs, sanitised cleanup receipt, and
manifest are complete. Do not move these files into the ignored
`artifacts/vivo-bi/test-results/` directory.