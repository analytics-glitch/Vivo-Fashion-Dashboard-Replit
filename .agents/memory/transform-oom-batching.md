---
name: Rebuild transform OOM + background-process reaping
description: Why the all_sales rebuild died silently and how to run/monitor long batch jobs safely
---

**Rule 1:** `transform_all_sales.py`'s Shopify phase must stream via a server-side cursor (separate read connection, itersize 50k) and insert in 50k batches. Never `fetchall()` ~1.4M wide rows and build a second full tuple list.
**Why:** With all web/expo workflows running (~3.5GB available of 8GB), the double in-memory copy got the process OOM-killed with NO traceback — the log just stops after "Shopify deduped rows".

**Rule 2:** Long-running batch jobs started with `nohup ... &` inside an agent bash tool call are killed when the shell session is reaped — they die silently mid-run. Run them under a workflow instead.
**How to apply:** A rebuild that "fails" with no error in the log = check for OOM (memory headroom) or session reaping; monitor progress via `SELECT COUNT(*)` (authoritative) — workflow log globs can be stale, and `pgrep -f` matches your own `bash -c` wrapper (always `grep [t]ransform` via ps instead).

**Rule 3:** A platform merge/restart auto-starts ALL configured workflows, including destructive batch ones (`Rebuild all_sales` truncates first). That is how dev all_sales got wiped. Consider keeping destructive batch commands out of configured workflows, or the first line of the script should guard (e.g. require an env flag).
