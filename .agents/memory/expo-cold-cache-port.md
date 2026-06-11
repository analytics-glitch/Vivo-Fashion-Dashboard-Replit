---
name: Expo first-build cold-cache port timeout
description: First Expo workflow start can time out with DIDNT_OPEN_A_PORT because Metro's cold bundle exceeds the detector window; warm the cache then restart.
---

# Expo first build: DIDNT_OPEN_A_PORT on cold cache

On the very first run of a new Expo artifact, `restart_workflow` can fail with
`DIDNT_OPEN_A_PORT` even though the logs show `Web is waiting on http://localhost:<PORT>`.

**Why:** Metro prints "Web is waiting" before the web port actually accepts
connections. With React Compiler + a cold Metro cache, the first bundle/optimization
can take longer than the workflow's port-detection window (even ~240s), and the tool
SIGKILLs the process before it binds. Typecheck passing confirms the code is fine —
this is a cold-cache timing issue, not a code bug.

**How to apply:** Warm the Metro cache once, out-of-band, then hand back to the workflow:
1. Run the dev script in the background with the workflow's env injected:
   `PORT=<port> BASE_PATH=<path> nohup pnpm --filter @workspace/<slug> run dev > /tmp/expo-warm.log 2>&1 &`
2. Poll `curl localhost:<port>/status` until it returns `200` (the Expo packager
   status endpoint; the artifact.toml uses `ensurePreviewReachable = "/status"`).
3. Kill the background process so the port frees up (`pkill -f "vivo-mobile run dev"`
   — note pkill may return 143 / kill the calling shell; just re-verify the port is closed).
4. `restart_workflow` now binds quickly because the Metro cache is warm.

Diagnose port binding with `curl -s -o /dev/null -w "%{http_code}" localhost:<port>/status`.
Note: u-root coreutils shadow breaks `ls -t`/`glob`; read the log path printed by refresh_all_logs directly.
