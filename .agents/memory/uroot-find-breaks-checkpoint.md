---
name: u-root-cmds shadows GNU find and breaks the agent checkpoint
description: Why mark_task_complete can fail with UNKNOWN_NOT_GIT, and how to fix it
---

# Symptom
`mark_task_complete` fails at the checkpoint step with:
`RiverServiceException ... code: UNKNOWN_NOT_GIT` and a `find ... -prune ... -exec rm -rf {} +` command with `code:1`.

# Root cause
The Nix package `u-root-cmds` (listed in `.replit` under `[nix] packages`) puts u-root's
minimal Go reimplementation of `find` FIRST on PATH (a `/nix/store/...u-root.../bin/find`).
That `find` only supports `-d/-l/-mode/-name/-type` and errors (exit 1) on the GNU flags
`-not/-path/-prune/-exec` that the checkpoint's git-cleanup command uses. GNU find still
exists at `/usr/bin/find` and runs the exact command fine (exit 0), but bare `find` resolves
to u-root first.

**Why hard to fix in-session:** `uninstallSystemDependencies({packages:["u-root-cmds"]})`
reports success (and appears to update config), but the *running* agent/checkpoint process
keeps its stale PATH — bare `find` still resolves into the u-root nix store path even after
a workflow restart. Direct edits to `.replit` are blocked (a tool owns that file). The first
PATH entries are all read-only nix-store dirs (openssl, rustc-wrapper, u-root, ...), so there
is no writable dir preceding u-root in which to drop a GNU `find` shim. GNU find still exists
at `/usr/bin/find` and runs the checkpoint's command fine, but the checkpoint invokes bare
`find`, which hits u-root first.

# Fix
Remove `u-root-cmds` from the workspace's Nix/System dependencies (the `[nix] packages`
array in `.replit`) via the Dependencies UI, then fully restart the workspace so the agent
process gets a regenerated PATH with GNU `find` first. After that, checkpoint/commit works.

**How to apply:** If a checkpoint/commit fails with UNKNOWN_NOT_GIT and `which find` points
into a `u-root` nix store path, this is the cause.

# Additional findings (confirmed)
- It's not just `find`: bare `rm` is ALSO u-root (`rm -rf` errors with "flag provided but not
  defined: -rf"). The checkpoint's `find ... -exec rm -rf {} +` therefore fails on two counts.
  GNU equivalents live at `/usr/bin/find` and `/usr/bin/rm` and work; only the bare names on
  PATH are shadowed.
- There are TWO nix manifests in this repl: `replit.nix` (`deps = [pkgs.findutils]`, a prior
  GNU-find fix attempt) AND `.replit` `[nix].packages` (which still lists `u-root-cmds`). Both
  contribute to PATH; the u-root nix-store bin dir precedes findutils, so u-root wins. Adding
  findutils via replit.nix does NOT fix the shadowing.
- `uninstallSystemDependencies({packages:["u-root-cmds"]})` returns success but does NOT remove
  `u-root-cmds` from `.replit` `[nix].packages` within the session (verified: line unchanged
  after the call). So the in-session uninstall is ineffective; the entry must be cleared and the
  workspace fully restarted (user action) — a workflow restart is not enough.
- Deployment/publish builds from the workspace filesystem, not from the agent checkpoint, so a
  failing checkpoint does NOT block publishing the current code — it only blocks the save/rollback
  point and `mark_task_complete`.
