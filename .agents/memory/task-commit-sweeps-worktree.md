---
name: Task completion commits sweep stray working-tree changes
description: Why to diff against the merge base before markTaskComplete — uncommitted env leftovers ride into the task commit and fail code review.
---

**Rule:** Before calling `markTaskComplete`, run `git status` and `git diff <merge-base> --stat` (merge base = the `main-repl/main` remote-tracking head) and confirm the diff contains ONLY this task's intended changes.

**Why:** The completion flow commits the ENTIRE working tree. A task environment can arrive seeded with someone else's uncommitted in-progress work; it silently rides into the completion commit and the completion code review judges it as yours. One Rolls-only task was rejected because ~550 lines of unrelated half-finished attendance/production code (with a real auth-bypass bug) were sitting uncommitted in the snapshot and got swept in.

**How to apply:**
- If stray changes are found and they are NOT part of the task: restore tracked files from the merge base (`git checkout <base> -- <files>`), delete stray new files, then re-apply your own edits to any mixed files.
- Leave `attached_assets/` uploads alone — they are user-provided and inert; deleting user assets is the riskier direction.
- After the revert, re-run compile + restart the affected workflow and re-verify your own feature before completing again.
- If the sweep already happened (completion committed it and review rejected): do NOT rewrite history (gitsafe backup refs exist) — restore unrelated tracked files from the base, `git rm` stray new files, and commit the revert on top; the swept-in work stays recoverable through the rejected commit. Confirm `git diff <base>..HEAD --stat` is task-only before re-completing.
- Expect sibling task branches seeded from the same snapshot to carry the same contamination + revert pair; their rebases conflict wherever the stray code lived — resolve those regions to main's version (contamination out, merged work intact).
