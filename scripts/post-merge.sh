#!/bin/bash
set -e

# Install workspace dependencies (frozen to the committed lockfile).
pnpm install --frozen-lockfile

# NOTE: we intentionally do NOT run `drizzle-kit push` here.
# This Postgres database is owned by the Python backend (api_pg.py), which
# creates/maintains ALL of its tables idempotently on startup (all_sales,
# footfall, app_users, crm_*, fabric_*, sync_health_log, etc.). The Drizzle
# schema in lib/db only declares 3 unused scaffold tables, so `drizzle-kit push`
# diffs the whole DB and tries to DROP every Python-managed table/sequence —
# data loss, and an interactive prompt that fails under the non-TTY post-merge
# runner. Schema changes for the live app are applied by the Python startup DDL,
# not by Drizzle, so there is nothing for push to do here.
