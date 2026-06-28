---
name: Rogue watchdog squats the API port (dev)
description: Why the api-server workflow can get stuck FAILED with "address already in use" and serve a stale-env (old secret) API.
---

# Rogue watchdog.py squatting the dev API port

`watchdog.py` reads `MANAGE_API = os.environ.get("WATCHDOG_MANAGE_API","1") != "0"`,
so a watchdog started **without** `WATCHDOG_MANAGE_API=0` will spawn AND supervise
uvicorn on port 8080 (respawning it within ~10s of any kill). The dev "Sync
Watchdog" workflow sets `WATCHDOG_MANAGE_API=0` (sync-only); the dev API is meant
to be the separate `artifacts/api-server` workflow running uvicorn directly.

**Failure mode:** a stray watchdog with MANAGE_API enabled (env var unset) ends up
running too. It owns port 8080 and keeps respawning uvicorn, so the api-server
workflow can never bind → it shows **FAILED** with `[Errno 98] address already in
use` on every `restart_workflow`, even though `/api/healthz` returns 200 (the
watchdog's uvicorn is serving).

**Stale secrets symptom:** the squatting uvicorn is a *child* of the rogue
watchdog and inherits the watchdog's environment, frozen at the watchdog's start
time. Newly-saved secrets (e.g. `FACEBOOK_PAGE_ACCESS_TOKEN`) never reach it, so
diagnostics keep reading the OLD token no matter how many times the secret is
re-saved. Respawning uvicorn does NOT help — Popen children re-inherit the stale
parent env. Only restarting the *supervisor* picks up fresh secrets.

**Diagnose / fix:**
- Map watchdogs: `ps -eo pid,ppid,etimes,cmd | grep '[w]atchdog.py'`; read each
  one's `WATCHDOG_MANAGE_API` from `/proc/<pid>/environ`. The legit Sync Watchdog
  has `=0`; the rogue one has it **unset**.
- `kill -9 <rogue-watchdog-pid>` FIRST (so it stops respawning), then
  `kill -9 <its uvicorn child>`. Confirm port 8080 is free (health → 502) and only
  the `MANAGE_API=0` watchdog remains. Then `restart_workflow artifacts/api-server`
  binds cleanly with fresh secret env.

**`pkill` self-kill gotcha:** `pkill -f "uvicorn api_pg"` matches the agent's OWN
shell command line (which contains that string) and SIGKILLs the shell (exit 137)
before killing uvicorn — leaving the target alive. Kill by **PID**, or match with
the `[u]vicorn`/`[w]atchdog` bracket trick so the pattern can't match itself.

**Automatic guard (now in place):** `port_guard.free_port(port)` scans `/proc`
for a stale `uvicorn`+`api_pg` process holding the port and SIGTERM→SIGKILLs it
*before* binding. It runs from the two launch sites only — the dev launcher
`run_api.py` (the api-server dev `run` command is now `python3 run_api.py`, NOT
`uvicorn …` directly) and `watchdog.py` `main()` before `spawn("api")`. It is
deliberately NOT an `api_pg` import side-effect (9 scripts/tests import api_pg and
must never kill the server). `_port_free` sets `SO_REUSEADDR` to mirror uvicorn so
a normal `TIME_WAIT` after a restart does not read as "busy" (only an active
LISTEN does). This makes the dev orphan-squat self-heal on restart; the manual
kill-by-PID procedure above is now only a fallback (e.g. a rogue *watchdog* that
respawns its child, which the guard won't stop since it kills uvicorn not the
supervisor).
