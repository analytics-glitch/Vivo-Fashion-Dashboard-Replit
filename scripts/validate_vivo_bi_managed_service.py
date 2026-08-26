#!/usr/bin/env python3
"""Fail-closed validation for the one managed Vivo BI preview owner."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


PORT = 18659
WORKSPACE = Path("/home/runner/workspace")
ARTIFACT_DIR = WORKSPACE / "artifacts" / "vivo-bi"


def run(*command: str) -> str:
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    return completed.stdout


def listener_pids() -> list[int]:
    raw = run("lsof", "-nP", f"-iTCP:{PORT}", "-sTCP:LISTEN", "-t")
    return sorted({int(pid) for pid in raw.split() if pid.isdigit()})


def processes() -> dict[int, tuple[int, str]]:
    rows: dict[int, tuple[int, str]] = {}
    for line in run("ps", "-eo", "pid=,ppid=,args=").splitlines():
        match = re.match(r"\s*(\d+)\s+(\d+)\s+(.*)", line)
        if match:
            rows[int(match.group(1))] = (int(match.group(2)), match.group(3))
    return rows


def ancestors(pid: int, rows: dict[int, tuple[int, str]]) -> list[str]:
    chain: list[str] = []
    seen: set[int] = set()
    while pid in rows and pid not in seen:
        seen.add(pid)
        parent, args = rows[pid]
        chain.append(args)
        pid = parent
    return chain


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
    if 'localPort = 18659' not in config or 'run = "pnpm --filter @workspace/vivo-bi run dev"' not in config:
        raise RuntimeError("Vivo BI artifact service no longer declares the required managed web owner")

    pids = listener_pids()
    if len(pids) != 1:
        raise RuntimeError(f"expected exactly one listener on {PORT}, found {pids or 'none'}")
    rows = processes()
    pid = pids[0]
    chain = ancestors(pid, rows)
    if not chain or "vite" not in chain[0] or str(ARTIFACT_DIR) not in chain[0]:
        raise RuntimeError(f"listener PID {pid} is not the Vivo BI Vite process")
    if not any("pnpm --filter @workspace/vivo-bi run dev" in args for args in chain):
        raise RuntimeError(
            f"listener PID {pid} has no managed Vivo BI workflow parent; treat it as an orphan and do not start another Vite process"
        )

    liveness = require_endpoint("http://127.0.0.1:8080/api/healthz")
    readiness = require_endpoint("http://127.0.0.1:8080/api/readyz", require_ready=True)
    print(json.dumps({
        "ok": True,
        "vivo_bi_listener_pid": pid,
        "vivo_bi_listener_count": len(pids),
        "api_liveness": liveness.get("status"),
        "api_ready": readiness.get("ready"),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Vivo BI managed-service validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)