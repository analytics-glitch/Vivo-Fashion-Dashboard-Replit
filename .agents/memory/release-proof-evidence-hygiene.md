---
name: Release-proof evidence hygiene
description: Rules for retaining browser-test evidence without retaining test credentials or incomplete cleanup records.
---

Release proof directories are review artifacts, not ordinary ignored test output. Keep them run-specific and validate their report, screenshots, traces, browser logs, manifest, and cleanup receipt before review. Redact known short-lived session values from every retained file, including the contents of trace ZIP entries.

**Why:** Browser traces can capture cookie-backed requests even when the test code never writes a token to a report. A green test marker alone cannot prove evidence exists, fixture cleanup completed, or a review bundle is safe to commit.

**How to apply:** For any retained authenticated browser proof, persist private run ownership until database cleanup and residue verification succeed, sanitize the output before deleting that private state, and use a validator that rejects missing evidence, live token patterns, or non-zero cleanup counts.