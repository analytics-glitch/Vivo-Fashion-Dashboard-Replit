#!/bin/bash
# Local prod-parity entrypoint. In the pnpm-workspace deployment, production is
# actually driven by each artifact's artifact.toml (the api-server service runs
# watchdog.py). This script lets you run the same supervised stack locally.
set -Eeuo pipefail

cd /home/runner/workspace

WORKSPACE_API_PORT="${WORKSPACE_API_PORT:-23661}"
WORKSPACE_API_HEALTH="http://127.0.0.1:${WORKSPACE_API_PORT}/api/workspace/healthz"
WORKSPACE_API_DIR="/home/runner/workspace/artifacts/vivo-product-workspace"
WORKSPACE_API_LOG="${WORKSPACE_API_LOG:-/tmp/vivo-product-workspace-api.log}"
WORKSPACE_API_PID=""
WATCHDOG_PID=""
SUPERVISOR_PID=""

workspace_api_process_exists() {
  ps -eo args= | grep -E '[v]ivo-product-workspace/(server/(dist/index\.js|index\.ts)|node_modules/.*/tsx.*server/index\.ts)' >/dev/null 2>&1
}

workspace_api_healthy() {
  curl -fsS --max-time 1 "$WORKSPACE_API_HEALTH" >/dev/null 2>&1
}

start_workspace_api() {
  if workspace_api_healthy; then
    echo "Product Workspace API already serving on ${WORKSPACE_API_PORT}"
    return 0
  fi
  if workspace_api_process_exists; then
    echo "Product Workspace API process exists; waiting for ${WORKSPACE_API_PORT}"
    return 0
  fi

  echo "Starting Product Workspace API on ${WORKSPACE_API_PORT}"
  (
    cd "$WORKSPACE_API_DIR"
    env PORT="$WORKSPACE_API_PORT" pnpm run build:server &&
      exec env PORT="$WORKSPACE_API_PORT" pnpm run server
  ) >>"$WORKSPACE_API_LOG" 2>&1 &
  WORKSPACE_API_PID=$!
}

supervise_workspace_api() {
  # Artifact-managed services normally come up independently. Give that
  # service a grace period so this root supervisor never races it for 23661.
  for _ in $(seq 1 30); do
    workspace_api_healthy && break
    workspace_api_process_exists && sleep 1 || sleep 1
  done

  while true; do
    if workspace_api_healthy; then
      sleep 5
      continue
    fi

    if [[ -n "$WORKSPACE_API_PID" ]] && kill -0 "$WORKSPACE_API_PID" 2>/dev/null; then
      sleep 2
      continue
    fi

    WORKSPACE_API_PID=""
    start_workspace_api
    sleep 2
  done
}

cleanup() {
  trap - EXIT INT TERM
  [[ -n "$SUPERVISOR_PID" ]] && kill "$SUPERVISOR_PID" 2>/dev/null || true
  [[ -n "$WATCHDOG_PID" ]] && kill "$WATCHDOG_PID" 2>/dev/null || true
  [[ -n "$WORKSPACE_API_PID" ]] && kill "$WORKSPACE_API_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

python3 watchdog.py &
WATCHDOG_PID=$!
supervise_workspace_api &
SUPERVISOR_PID=$!

# Keep the root process alive while both the BI watchdog and Product Workspace
# supervisor are running. If either exits, cleanup stops the sibling processes.
wait -n "$WATCHDOG_PID" "$SUPERVISOR_PID"
