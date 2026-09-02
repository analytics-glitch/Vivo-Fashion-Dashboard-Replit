#!/bin/bash
set -e

# Install workspace dependencies (frozen to the committed lockfile).
# This setup script never starts a frontend process. Replit may restart the
# managed artifact service after package installation; that service must enter
# through scripts/start_vivo_bi_managed.py, which owns the port lock and
# lifecycle record. Its one-time legacy recovery is attestation-gated there;
# do not add pnpm/vite dev commands or alternate recovery here.
pnpm install --frozen-lockfile
bash scripts/install_sop_pdf_dependencies.sh

# NOTE: we intentionally do NOT run `drizzle-kit push` here.
# This Postgres database is owned by the Python backend (api_pg.py), which
# creates/maintains ALL of its tables idempotently on startup (all_sales,
# footfall, app_users, crm_*, fabric_*, sync_health_log, etc.). The Drizzle
# schema in lib/db only declares 3 unused scaffold tables, so `drizzle-kit push`
# diffs the whole DB and tries to DROP every Python-managed table/sequence —
# data loss, and an interactive prompt that fails under the non-TTY post-merge
# runner. Schema changes for the live app are applied by the Python startup DDL,
# not by Drizzle, so there is nothing for push to do here.
