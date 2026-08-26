#!/usr/bin/env python3
"""Read-only, fail-closed audit for the managed Vivo BI preview owner."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

try:  # Direct script execution is the normal recovery path.
    from vivo_bi_managed_service import (
        ARTIFACT_DIR,
        PORT,
        WORKSPACE,
        inspect_listener,
        stable_listener,
    )
except ModuleNotFoundError:
    from scripts.vivo_bi_managed_service import (
        ARTIFACT_DIR,
        PORT,
        WORKSPACE,
        inspect_listener,
        stable_listener,
    )


def require_endpoint(url: str, *, require_ready: bool = False) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            body = response.read().decode("utf-8")
            payload = json.loads(body)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{url} is not healthy: {exc}") from exc
    if require_ready and payload.get("ready") is not True:
        raise RuntimeError(f"{url} reported not ready")
    return payload


def main() -> int:
    manifest = ARTIFACT_DIR / ".replit-artifact" / "artifact.toml"
    config = manifest.read_text(encoding="utf-8")
    expected_run = 'run = "python3 ../../scripts/start_vivo_bi_managed.py"'
    if f"localPort = {PORT}" not in config or expected_run not in config:
        raise RuntimeError(
            "Vivo BI artifact service no longer declares the guarded managed web owner"
        )
    listener_pid, instability = stable_listener()
    if instability:
        raise RuntimeError(f"unstable port ownership: {instability}")
    if listener_pid is None:
        raise RuntimeError(f"expected exactly one listener on {PORT}, found none")
    inspection = inspect_listener(listener_pid)
    if not inspection["verified"]:
        raise RuntimeError(
            f"listener PID {listener_pid} failed managed-owner proof: "
            + "; ".join(inspection["reasons"])
        )
    # A second stable read protects the report from a listener that disappeared
    # between its identity inspection and API health checks.
    stable_pid, instability = stable_listener()
    if instability or stable_pid != listener_pid:
        raise RuntimeError("listener changed during managed-service audit")
    liveness = require_endpoint("http://127.0.0.1:8080/api/healthz")
    readiness = require_endpoint("http://127.0.0.1:8080/api/readyz", require_ready=True)
    print(json.dumps({
        "ok": True,
        "workspace": str(WORKSPACE),
        "vivo_bi_listener_pid": listener_pid,
        "vivo_bi_listener_count": 1,
        "listener": {
            "args": inspection["args"],
            "cwd": inspection["cwd"],
            "executable": inspection["executable"],
            "start_ticks": inspection["start_ticks"],
            "environment": inspection["environment"],
            "ancestry": inspection["ancestry"],
            "owner": inspection["owner"],
        },
        "api_liveness": liveness.get("status"),
        "api_ready": readiness.get("ready"),
        "workflow_ready_recovery_evidence": {
            "guarded_run_command": expected_run,
            "stable_listener": True,
            "managed_ancestry": True,
            "owner_record_verified": True,
        },
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Vivo BI managed-service validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)