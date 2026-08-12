---
name: Rebase-replay repairs main drift
description: How to resolve task-completion rebase conflicts when main has LOST content this task already merged (another task's merge resolution clobbered it)
---

**Rule:** In a task-completion rebase, when a conflict (or a failing test) shows main *missing* content this task already merged in an earlier completion, main regressed — typically another concurrently-branched task's merge resolution overwrote the shared file region. Do not assume "ours = newest". Resolve by union: `git checkout --ours` (keeps main's later evolution), then graft back the replayed commit's genuine additions hunk-by-hunk from `git show :3:<file>`.

**Why:** This repo runs many concurrent tasks over shared hot files (merch_router.py, Merch*.jsx). A task branched before your merge can resurrect old code when *its* conflicts get resolved in its favour. Seen 2026-08: main lost the soh_online CSV split AND reverted the derived colour-count semantics (`colours_in_stock` → `colour_count`), while a main-side test class was authored against the reverted semantics — so after the rebase restored the right code, the main-authored test failed.

**How to apply:**
- Diff the two sides first: `diff <(git show :2:file) <(git show :3:file)` — classify each hunk as "main evolution (keep)" vs "my commit's addition main lost (graft back)".
- Compare against the pre-rebase branch tip (`git rev-parse HEAD@{N}` from `reflog | grep 'rebase (start)'` minus one) to learn which semantics actually passed the last 12 validations.
- Main-authored tests/consumers written against the regressed semantics must be re-aligned to the restored canon (fixture fields + assertions), not appeased by re-reverting the code.
- After the rebase completes: grep for restored markers, re-run the schema smoke suite locally BEFORE markTaskComplete, and restart the api-server (the rebased tree now contains other tasks' backend changes the running process lacks).
