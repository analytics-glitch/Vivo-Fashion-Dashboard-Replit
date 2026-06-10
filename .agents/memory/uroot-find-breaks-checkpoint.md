---
name: u-root-cmds shadows GNU coreutils and breaks the agent checkpoint
description: Why mark_task_complete can fail with UNKNOWN_NOT_GIT, and how to fix it
---

# Rule
If the Nix package `u-root-cmds` is in `.replit` `[nix].packages`, it puts u-root's
minimal Go reimplementations of `find`, `rm`, `head`, etc. FIRST on PATH, shadowing GNU
coreutils. These only support a tiny flag set and exit 1 on GNU flags like
`-not/-path/-prune/-exec` and `rm -rf`. This breaks search/glob tooling AND the agent
checkpoint (its `find ... -exec rm -rf {} +` cleanup), which surfaces as
`mark_task_complete` failing with `UNKNOWN_NOT_GIT`. (Real GNU binaries still live at
`/usr/bin/*` and work, but the checkpoint invokes the bare names.)

# Fix
Remove `u-root-cmds` from `.replit` `[nix].packages`, then fully restart the workspace
(`kill 1`) so PATH is regenerated. `replit.nix` already provides `pkgs.findutils`, but it
does NOT help while u-root is present because the u-root store dir precedes it on PATH.

**Why:** the running agent caches its PATH; a workflow restart is not enough, and
`uninstallSystemDependencies` does not actually clear the entry in-session. Only removing
the `.replit` line + full restart works. `.replit` is tool-owned, so the *user* must make
this edit and run `kill 1`.

**How to apply:** suspect this when a checkpoint/commit fails with `UNKNOWN_NOT_GIT` and
`which find` resolves into a `u-root` nix-store path.

# Note
Deployment/publish builds from the workspace filesystem, not the checkpoint, so a failing
checkpoint blocks only save/rollback and `mark_task_complete` — never publishing.
