---
name: Behavioral database coverage
description: When source-contract checks are insufficient for workflow and transaction guarantees.
---

Source-text assertions may protect route names or required snippets, but they do not count as coverage for authorization, concurrency, atomic history, or idempotent imports. Those guarantees require executed behavior against an isolated disposable PostgreSQL cluster.

**Why:** A feature can compile and satisfy string-based contract tests while still failing at runtime through response-shape drift, partial commits, or ineffective permission checks.

**How to apply:** For database-backed operational workflows, keep fast pure/contract tests, but add disposable-Postgres API tests for role boundaries, duplicate races, transaction rollback, audit history, reporting isolation, and importer reruns. Never point concurrency tests at the shared development or production database.