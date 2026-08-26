---
name: Release-proof gate is a fixed four-flow contract
description: Why e2e/run-production-release-proof.sh can start failing as production-command-centre.spec.js grows, and the Playwright --grep gotcha that fixes it.
---

`e2e/validate-production-release-proof.py` hard-codes an exact list of expected test titles, a fixed screenshot manifest per title, and asserts the Playwright JSON report's `stats.expected == 4` with zero unexpected/flaky/skipped. It is a narrow "prove these specific flows still work, byte-for-byte" contract, not a general regression gate.

**Why:** `production-command-centre.spec.js` is a shared file that keeps growing (standalone workspace, L10, Work Orders, etc.), but nobody is expected to touch the validator's fixed list for every new test added elsewhere in that file — so the release-proof runner must scope itself to exactly the four original titles, or it fails the moment someone adds an unrelated test to the same spec file.

**How to apply:** `e2e/run-production-release-proof.sh` passes `--grep '<alternation of the 4 exact titles>'` to Playwright to select only those flows. New feature coverage in the same spec file belongs to the general `test:e2e` suite, not this gate. Also: Playwright's `--grep` matches the full `file › project › title` string, not the bare test title — a `^...$`-anchored pattern silently matches zero tests ("No tests found"); drop the anchors and use a plain alternation.
