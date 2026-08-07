---
name: Port-cleanup kill hazards
description: Killing "the node process on a port" can take down the whole workflow supervisor — how to clean up orphaned dev servers safely
---

**Rule:** When clearing orphaned dev servers, only kill PIDs whose full `ps -o args=` you have inspected and matched to a known dev command (vite/serve.js/expo). Never kill a PID just because `lsof` shows it with "node" on a port, and never kill low-PID processes (pid1/14/small numbers) — they are platform infra.

**Why:** Aug 2026: an `lsof | awk '/node/'` sweep killed pid 31, which was part of the platform session — the shell disconnected mid-command and EVERY workflow (api-server, watchdog, all vite apps) went down and had to be restarted. The port squatters themselves (leftover vite/expo from task-merge restarts) were fine to kill by inspected PID.

**How to apply:**
- For each suspect PID: `ps -o args= -p $PID`, kill only on an explicit match; skip anything unrecognized.
- `lsof` COMMAND column truncates ("MainThrea") — it is not enough to identify a process; always confirm via ps args.
- Expect that after any accidental infra kill, all workflows are down: restart api-server first, then watchdog, then the artifact dev servers, then re-run smoke checks (loyalty-smoke).
- Related: `pkill -f` self-kills (see rogue-watchdog memory) — always kill by inspected PID list.
