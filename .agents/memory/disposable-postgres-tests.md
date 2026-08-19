---
name: Disposable PostgreSQL tests
description: Safety boundary and Replit runtime requirements for database-backed concurrency tests.
---

Database-backed integration and concurrency tests must run against a fresh local PostgreSQL cluster exposed only through `TEST_DATABASE_URL`. Never default or fall back to the application's `DATABASE_URL`, even for schema-isolated tests.

**Why:** The application URL may target a transaction pooler and production data. Session-level schema state is not a safe isolation boundary there. Replit's local PostgreSQL also needs an explicit Unix-socket directory and test role because `/run/postgresql` may be absent and inherited PG variables may name a role that the disposable cluster does not contain.

**How to apply:** Use a registered validation runner that initializes and tears down a local cluster, removes application database variables from the test subprocess, sets `TEST_DATABASE_URL`, and establishes any private schema in every connection's startup options.