#!/usr/bin/env bash
set -euo pipefail

# This runner is intentionally the only release-proof entry point. It never
# starts Vite; the managed Vivo BI service must already pass the read-only
# validator before browser coverage begins.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

python3 scripts/validate_vivo_bi_managed_service.py

run_id="${VIVO_E2E_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
review_dir="${VIVO_E2E_REVIEW_DIR:-$root/e2e/review/production-workspace-release-main-$run_id}"
if [[ -e "$review_dir" ]]; then
  echo "Refusing to overwrite existing release evidence: $review_dir" >&2
  exit 1
fi

export VIVO_E2E_RUN_ID="$run_id"
export VIVO_E2E_OUTPUT_DIR="$review_dir"

# This gate proves exactly the four release flows the validator's fixed
# manifest expects (title order, screenshot set, and hashes are all locked
# to that list). production-command-centre.spec.js has since grown further
# coverage (standalone workspace, L10, Work Orders) for other features; those
# run under the general `test:e2e` suite, not this narrow exact-commit gate.
# No anchors: Playwright's --grep matches the full "file > project > title"
# string, not the bare test title, so a leading ^ never matches.
release_flow_grep='Command Centre desktop handles filters, refresh failure, recovery, partial data, and every enabled drill-down|Command Centre has no page-level overflow on phone or tablet|Production role can use production destinations but is denied Order Tracker|Quality role redacts personnel productivity at phone width'

set +e
bash e2e/run-playwright.sh e2e/production-command-centre.spec.js --grep "$release_flow_grep"
test_status=$?
set -e

if [[ "$test_status" -ne 0 ]]; then
  echo "Release suite failed; retained incomplete evidence in $review_dir" >&2
  exit "$test_status"
fi

# Playwright's internal status marker is runtime state, not review evidence.
# The exact-contract validator rejects it rather than allowing a stale rerun to
# look complete.
rm -f "$review_dir/.last-run.json"

# Build a manifest once from the run's exact disk inventory before staging it.
# The final invocation below re-reads that manifest and fails closed if Git,
# disk, hashes or sizes disagree.
python3 e2e/validate-production-release-proof.py --build "$review_dir"

# A release-proof bundle is only reviewable once its complete inventory is
# explicitly tracked. Stage the fresh run before the independent validator
# compares the disk, manifest and Git inventories.
git add -- "$review_dir"
python3 e2e/validate-production-release-proof.py "$review_dir"
echo "Production Workspace release proof retained in $review_dir"