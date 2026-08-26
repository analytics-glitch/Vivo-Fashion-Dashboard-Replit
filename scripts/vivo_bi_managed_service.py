#!/usr/bin/env python3
"""Shared ownership checks for the managed Vivo BI preview service.

This module intentionally uses process metadata in addition to the listening
port.  A port number alone is never sufficient evidence that a process belongs
to this workspace.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import signal
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any


PORT = 18659
WORKSPACE = Path("/home/runner/workspace").resolve()
ARTIFACT_DIR = (WORKSPACE / "artifacts" / "vivo-bi").resolve()
LOCK_PATH = WORKSPACE / ".replit-artifact-vivo-bi-18659.lock"
OWNER_PATH = WORKSPACE / ".replit-artifact-vivo-bi-18659.owner.json"
WRAPPER_PATH = (WORKSPACE / "scripts" / "start_vivo_bi_managed.py").resolve()
WORKFLOW_COMMAND = "pnpm --filter @workspace/vivo-bi run dev"
OWNER_MARKER = "vivo-bi-managed"


def _run(*command: str) -> str:
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    return completed.stdout


def listener_pids() -> list[int]:
    raw = _run("lsof", "-nP", f"-iTCP:{PORT}", "-sTCP:LISTEN", "-t")
    return sorted({int(pid) for pid in raw.split() if pid.isdigit()})


def process_rows() -> dict[int, tuple[int, str]]:
    rows: dict[int, tuple[int, str]] = {}
    for line in _run("ps", "-eo", "pid=,ppid=,args=").splitlines():
        match = re.match(r"\s*(\d+)\s+(\d+)\s+(.*)", line)
        if match:
            rows[int(match.group(1))] = (int(match.group(2)), match.group(3))
    return rows


def ancestors(pid: int, rows: dict[int, tuple[int, str]] | None = None) -> list[tuple[int, str]]:
    rows = rows or process_rows()
    chain: list[tuple[int, str]] = []
    seen: set[int] = set()
    while pid in rows and pid not in seen:
        seen.add(pid)
        parent, args = rows[pid]
        chain.append((pid, args))
        pid = parent
    return chain


def proc_start_ticks(pid: int) -> str | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").split()
        return fields[21]
    except (FileNotFoundError, IndexError, PermissionError):
        return None


def proc_cwd(pid: int) -> Path | None:
    try:
        return Path(os.readlink(f"/proc/{pid}/cwd")).resolve()
    except (FileNotFoundError, PermissionError, OSError):
        return None


def proc_exe(pid: int) -> Path | None:
    try:
        return Path(os.readlink(f"/proc/{pid}/exe")).resolve()
    except (FileNotFoundError, PermissionError, OSError):
        return None


def proc_environment(pid: int) -> dict[str, str]:
    try:
        data = Path(f"/proc/{pid}/environ").read_bytes()
    except (FileNotFoundError, PermissionError):
        return {}
    values: dict[str, str] = {}
    for entry in data.split(b"\0"):
        if b"=" in entry:
            key, value = entry.split(b"=", 1)
            values[key.decode("utf-8", "replace")] = value.decode("utf-8", "replace")
    return values


def read_owner() -> dict[str, Any] | None:
    try:
        value = json.loads(OWNER_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def write_owner(owner: dict[str, Any]) -> None:
    temporary = OWNER_PATH.with_name(f".{OWNER_PATH.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(owner, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, OWNER_PATH)


def clear_owner_if_owned(listener_pid: int | None, run_id: str) -> None:
    owner = read_owner()
    if owner and owner.get("run_id") == run_id and (
        listener_pid is None or owner.get("listener_pid") == listener_pid
    ):
        try:
            OWNER_PATH.unlink()
        except FileNotFoundError:
            pass


def inspect_listener(
    pid: int,
    *,
    owner: dict[str, Any] | None = None,
    require_live_wrapper: bool = True,
) -> dict[str, Any]:
    rows = process_rows()
    chain = ancestors(pid, rows)
    args = chain[0][1] if chain else ""
    environment = proc_environment(pid)
    cwd = proc_cwd(pid)
    exe = proc_exe(pid)
    owner = owner or read_owner()
    reasons: list[str] = []
    if not chain:
        reasons.append("listener process is absent from the process table")
    if "vite" not in args or str(ARTIFACT_DIR) not in args:
        reasons.append("listener command is not the Vivo BI Vite process")
    if cwd != ARTIFACT_DIR:
        reasons.append(f"listener cwd is {cwd}, expected {ARTIFACT_DIR}")
    if exe is None or exe.name not in {"node", "nodejs"}:
        reasons.append("listener executable is not Node.js")
    if not any(WORKFLOW_COMMAND in ancestor_args for _, ancestor_args in chain):
        reasons.append("managed pnpm-to-Vite workflow ancestry is absent")
    if environment.get("VIVO_BI_MANAGED_OWNER") != OWNER_MARKER:
        reasons.append("managed owner environment marker is absent")
    if environment.get("VIVO_BI_MANAGED_WORKSPACE") != str(WORKSPACE):
        reasons.append("managed workspace identity marker is absent")
    if environment.get("VIVO_BI_MANAGED_ARTIFACT") != str(ARTIFACT_DIR):
        reasons.append("managed artifact identity marker is absent")
    if environment.get("VIVO_BI_MANAGED_PORT") != str(PORT):
        reasons.append("managed port identity marker is absent")
    if not owner:
        reasons.append("managed owner record is absent")
    else:
        if owner.get("listener_pid") != pid:
            reasons.append("owner record does not identify this listener PID")
        if owner.get("listener_start_ticks") != proc_start_ticks(pid):
            reasons.append("owner record start identity does not match this listener")
        if owner.get("run_id") != environment.get("VIVO_BI_MANAGED_RUN_ID"):
            reasons.append("owner record run identity does not match listener metadata")
        wrapper_pid = owner.get("wrapper_pid")
        if require_live_wrapper and (
            not isinstance(wrapper_pid, int)
            or proc_start_ticks(wrapper_pid) != owner.get("wrapper_start_ticks")
        ):
            reasons.append("owner wrapper is no longer the recorded process")
        if not require_live_wrapper and isinstance(wrapper_pid, int) and (
            proc_start_ticks(wrapper_pid) == owner.get("wrapper_start_ticks")
        ):
            reasons.append("owner wrapper is still live")
    return {
        "pid": pid,
        "args": args,
        "cwd": str(cwd) if cwd else None,
        "executable": str(exe) if exe else None,
        "environment": {
            key: environment.get(key)
            for key in (
                "VIVO_BI_MANAGED_OWNER",
                "VIVO_BI_MANAGED_WORKSPACE",
                "VIVO_BI_MANAGED_ARTIFACT",
                "VIVO_BI_MANAGED_PORT",
                "VIVO_BI_MANAGED_RUN_ID",
            )
            if key in environment
        },
        "start_ticks": proc_start_ticks(pid),
        "ancestry": [
            {"pid": item_pid, "args": item_args, "start_ticks": proc_start_ticks(item_pid)}
            for item_pid, item_args in chain
        ],
        "owner": owner,
        "verified": not reasons,
        "reasons": reasons,
    }


def stable_listener(timeout: float = 1.5) -> tuple[int | None, str | None]:
    first = listener_pids()
    time.sleep(min(0.25, timeout / 3))
    second = listener_pids()
    if first != second:
        return None, f"port ownership changed during inspection ({first} -> {second})"
    if len(first) > 1:
        return None, f"expected one listener on {PORT}, found {first}"
    return (first[0], None) if first else (None, None)


def acquire_lock(blocking: bool = True) -> Any:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    handle = LOCK_PATH.open("a+")
    flags = fcntl.LOCK_EX
    if not blocking:
        flags |= fcntl.LOCK_NB
    fcntl.flock(handle.fileno(), flags)
    return handle


def managed_ancestor_pids(listener_pid: int) -> list[int]:
    rows = process_rows()
    return [
        pid
        for pid, args in ancestors(listener_pid, rows)
        if (
            str(ARTIFACT_DIR) in args
            or WORKFLOW_COMMAND in args
            or str(WRAPPER_PATH) in args
        )
    ]


def _managed_pid_identities(inspection: dict[str, Any]) -> dict[int, str]:
    return {
        int(item["pid"]): str(item.get("start_ticks") or "")
        for item in inspection.get("ancestry", [])
        if (
            str(ARTIFACT_DIR) in str(item.get("args", ""))
            or WORKFLOW_COMMAND in str(item.get("args", ""))
            or str(WRAPPER_PATH) in str(item.get("args", ""))
        )
    }


def _verified_termination_targets(
    listener_pid: int,
    expected: dict[str, Any],
) -> dict[int, tuple[str, int]]:
    """Return pidfds only after a fresh, complete stale-owner identity proof."""
    expected_owner = expected.get("owner")
    if not expected.get("verified") or not isinstance(expected_owner, dict):
        raise RuntimeError("refusing to terminate an unverified port owner")

    current_owner = read_owner()
    current = inspect_listener(
        listener_pid,
        owner=current_owner,
        require_live_wrapper=False,
    )
    identity_fields = (
        "listener_pid", "listener_start_ticks", "run_id", "child_pid",
        "wrapper_pid", "wrapper_start_ticks",
    )
    if (
        not current.get("verified")
        or current.get("start_ticks") != expected.get("start_ticks")
        or current_owner != expected_owner
        or any(current_owner.get(key) != expected_owner.get(key) for key in identity_fields)
    ):
        raise RuntimeError("verified owner changed before termination; nothing was signalled")

    expected_pids = _managed_pid_identities(expected)
    current_pids = _managed_pid_identities(current)
    if not expected_pids or current_pids != expected_pids or listener_pid not in current_pids:
        raise RuntimeError("managed process ancestry changed before termination; nothing was signalled")
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("pidfd signalling is unavailable; refusing non-atomic stale-owner termination")

    targets: dict[int, tuple[str, int]] = {}
    try:
        for pid, expected_ticks in current_pids.items():
            if not expected_ticks or proc_start_ticks(pid) != expected_ticks:
                raise RuntimeError("managed process identity changed before termination; nothing was signalled")
            pidfd = os.pidfd_open(pid)
            if proc_start_ticks(pid) != expected_ticks:
                os.close(pidfd)
                raise RuntimeError("managed process identity changed before termination; nothing was signalled")
            targets[pid] = (expected_ticks, pidfd)
    except Exception:
        for _, pidfd in targets.values():
            os.close(pidfd)
        raise
    return targets


def _signal_verified_owner(listener_pid: int, expected: dict[str, Any], signum: int) -> None:
    """Reprove every target immediately before signal; pidfds pin process identity."""
    targets = _verified_termination_targets(listener_pid, expected)
    try:
        # Parent first lets pnpm shut down its Vite child cleanly. Every signal
        # uses a pidfd, so even a rapid PID recycle cannot hit another process.
        for pid in reversed(list(targets)):
            try:
                signal.pidfd_send_signal(targets[pid][1], signum)
            except ProcessLookupError:
                continue
    finally:
        for _, pidfd in targets.values():
            os.close(pidfd)


def terminate_verified_owner(listener_pid: int, inspection: dict[str, Any]) -> None:
    if not inspection.get("verified"):
        raise RuntimeError("refusing to terminate an unverified port owner")
    _signal_verified_owner(listener_pid, inspection, signal.SIGTERM)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if not listener_pids():
            return
        time.sleep(0.2)
    _signal_verified_owner(listener_pid, inspection, signal.SIGKILL)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if not listener_pids():
            return
        time.sleep(0.2)
    raise RuntimeError(f"verified stale owner did not release port {PORT}")


def new_run_id() -> str:
    return str(uuid.uuid4())