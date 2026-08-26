---
name: Production Workspace e2e fixtures
description: Lifecycle rules for creating and cleaning isolated Production Workspace browser-test data.
---

Create plan inputs (operations, assignments, and captured output dependencies) while the plan is `draft`; only then submit or approve the fixture so operational reads include it.

**Why:** The database enforces immutable inputs once a plan is submitted. A cleanup that tries to delete assignments or operations from an approved plan is rejected, which can leave test fixtures behind.

**How to apply:** For run-owned browser fixtures, make all plan inputs before approval. During teardown, delete output/event facts, transition only the run-owned plan to `reopened`, then delete plan inputs and parent rows in dependency order. Retain the run ownership record until the cleanup verification succeeds.