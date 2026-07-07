---
name: Metro crashes on repo-root .cache churn
description: Why the Expo bundler dies with an uncaught ENOENT watch error, and the durable fix
---

The Expo app's `metro.config.js` sets `config.watchFolders = [workspaceRoot]` (the
repo root) so EAS/Metro can resolve `@workspace/*` packages. That also makes Metro's
file walker crawl+watch churny tooling dirs at the root — notably `.cache/uv/.tmp*`,
where `uv` (our Python package installs) writes short-lived temp dirs. When such a
dir is deleted mid-crawl, Metro's FallbackWatcher throws an **uncaught** `ENOENT:
watch '.../.cache/uv/.tmpXXXX/...'` and takes the whole `expo start` process down
(pnpm exit status 7). Symptom in logs: a `walker`/`FallbackWatcher` stack ending in
`fs watch` ENOENT on a `.cache/...` path.

**The failure recurs after a Python dependency install** (e.g. adding google-auth +
cryptography), not just cold Metro caches.

**Fix (durable):** exclude non-source churn dirs from Metro's crawl/watch via
`config.resolver.blockList = /[\\/]\.(cache|git)[\\/].*/;`. blockList feeds
metro-file-map's ignore pattern, so those dirs are never watched.

**Debugging gotcha that cost time here:** the workflow log file is timestamp-named;
`ls -t | head -1` on the glob kept returning a STALE pre-fix log, so restarts looked
like they were "still failing" identically (same random `.tmpXXXX` name every time —
that sameness is the tell it's a stale file, since a live crawl couldn't rediscover a
deleted random-named dir). Always confirm current workflow state with
`refresh_all_logs`, not by tailing an old glob match.
