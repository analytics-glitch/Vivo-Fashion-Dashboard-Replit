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

set +e
bash e2e/run-playwright.sh e2e/production-command-centre.spec.js
test_status=$?
set -e

if [[ "$test_status" -ne 0 ]]; then
  echo "Release suite failed; retained incomplete evidence in $review_dir" >&2
  exit "$test_status"
fi

python3 e2e/validate-production-release-proof.py "$review_dir"
echo "Production Workspace release proof retained in $review_dir"