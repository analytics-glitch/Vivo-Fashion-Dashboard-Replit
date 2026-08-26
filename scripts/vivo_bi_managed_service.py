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
import shutil
import signal
import subprocess
import time
import tomllib
import uuid
from pathlib import Path
from typing import Any


PORT = 18659
WORKSPACE = Path("/home/runner/workspace").resolve()
ARTIFACT_DIR = (WORKSPACE / "artifacts" / "vivo-bi").resolve()
LOCK_PATH = WORKSPACE / ".replit-artifact-vivo-bi-18659.lock"
OWNER_PATH = WORKSPACE / ".replit-artifact-vivo-bi-18659.owner.json"
LEGACY_MIGRATION_PATH = WORKSPACE / ".replit-artifact-vivo-bi-18659.legacy-migrated.json"
WRAPPER_PATH = (WORKSPACE / "scripts" / "start_vivo_bi_managed.py").resolve()
WORKFLOW_COMMAND = "pnpm --filter @workspace/vivo-bi run dev"
OWNER_MARKER = "vivo-bi-managed"
ARTIFACT_MANIFEST = ARTIFACT_DIR / ".replit-artifact" / "artifact.toml"
MANAGED_ENV_PREFIX = "VIVO_BI_MANAGED_"


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


def proc_cmdline(pid: int) -> list[str]:
    try:
        data = Path(f"/proc/{pid}/cmdline").read_bytes()
    except (FileNotFoundError, PermissionError):
        return []
    return [
        value.decode("utf-8", "replace")
        for value in data.split(b"\0")
        if value
    ]


def _node_executable(executable: Path | None) -> bool:
    return executable is not None and executable.name in {"node", "nodejs"}


def _legacy_vite_command(argv: list[str]) -> bool:
    """Recognise the exact Vite command produced by the legacy service."""
    expected_script = (ARTIFACT_DIR / "node_modules" / "vite" / "bin" / "vite.js").resolve()
    return (
        len(argv) == 6
        and Path(argv[0]).name in {"node", "nodejs"}
        and Path(argv[1]).resolve() == expected_script
        and argv[2:] == ["--config", "vite.config.ts", "--host", "0.0.0.0"]
    )


def canonical_pnpm_launcher() -> Path | None:
    """Return the pnpm executable this workspace's workflow may launch."""
    launcher = shutil.which("pnpm")
    if not launcher:
        return None
    try:
        return Path(launcher).resolve(strict=True)
    except OSError:
        return None


def _legacy_pnpm_command(argv: list[str]) -> bool:
    """Match the Vivo BI workflow, not merely a similar pnpm invocation."""
    launcher = canonical_pnpm_launcher()
    return (
        launcher is not None
        and len(argv) == 6
        and Path(argv[0]).name in {"node", "nodejs"}
        and Path(argv[1]).resolve() == launcher
        and argv[2:] == ["--filter", "@workspace/vivo-bi", "run", "dev"]
    )


def workflow_registration_evidence() -> dict[str, Any]:
    """Return the local artifact registration proof used by legacy recovery."""
    try:
        config = tomllib.loads(ARTIFACT_MANIFEST.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, tomllib.TOMLDecodeError) as exc:
        return {
            "available": False,
            "verified": False,
            "reasons": [f"artifact workflow registration is unavailable: {exc}"],
        }
    services = config.get("services")
    web_services = [
        service
        for service in services
        if isinstance(service, dict) and service.get("name") == "web"
    ] if isinstance(services, list) else []
    if len(web_services) != 1:
        return {
            "available": True,
            "verified": False,
            "reasons": ["artifact registration must contain exactly one web service"],
        }
    web_service = web_services[0]
    development = web_service.get("development")
    if not isinstance(development, dict):
        development = {}
    checks = {
        "artifact_path": web_service.get("paths") == ["/"],
        "port": web_service.get("localPort") == PORT,
        "guarded_run": development.get("run") == "python3 ../../scripts/start_vivo_bi_managed.py",
    }
    reasons = [
        f"artifact registration is missing {name.replace('_', ' ')}"
        for name, passed in checks.items()
        if not passed
    ]
    return {
        "available": True,
        "verified": not reasons,
        "checks": checks,
        "reasons": reasons,
    }


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


def legacy_migration_available() -> bool:
    """Legacy takeover is a one-time migration, never a normal fallback."""
    return not LEGACY_MIGRATION_PATH.exists()


def claim_legacy_migration(inspection: dict[str, Any]) -> None:
    """Persist the one-time legacy handoff before any process is signalled.

    Callers hold the managed-start lock.  A failed handoff therefore fails
    closed rather than opening a second chance to adopt another process later.
    """
    if not inspection.get("verified") or not inspection.get("legacy"):
        raise RuntimeError("refusing to claim an unverified legacy migration")
    payload = {
        "listener_pid": inspection.get("pid"),
        "listener_start_ticks": inspection.get("start_ticks"),
        "pnpm_pid": inspection.get("pnpm_pid"),
        "pnpm_start_ticks": inspection.get("target_identities", {}).get(
            inspection.get("pnpm_pid")
        ),
    }
    try:
        # O_EXCL prevents a second caller from converting a missing sentinel
        # into a repeat migration if the lock contract is ever regressed.
        descriptor = os.open(LEGACY_MIGRATION_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as target:
            target.write((json.dumps(payload, sort_keys=True) + "\n").encode("utf-8"))
            target.flush()
            os.fsync(target.fileno())
        directory = os.open(LEGACY_MIGRATION_PATH.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except FileExistsError as exc:
        raise RuntimeError("legacy migration was already claimed; refusing repeat recovery") from exc


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
    if not _node_executable(exe):
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


def inspect_legacy_listener(
    pid: int,
    *,
    registration: dict[str, Any] | None = None,
    check_stability: bool = True,
) -> dict[str, Any]:
    """Attest one pre-guard Vivo BI listener for one-time migration.

    This is deliberately separate from ``inspect_listener``.  It accepts no
    managed marker and no owner record, and it requires the exact legacy
    pnpm-to-Vite parent relationship.  A caller must still hold the start
    lock before using this proof to terminate anything.
    """
    reasons: list[str] = []
    stable_pid: int | None = None
    if check_stability:
        stable_pid, instability = stable_listener()
        if instability:
            reasons.append(instability)
        elif stable_pid != pid:
            reasons.append(
                f"stable port listener changed during legacy attestation "
                f"({stable_pid} != {pid})"
            )

    rows = process_rows()
    chain = ancestors(pid, rows)
    args = chain[0][1] if chain else ""
    argv = proc_cmdline(pid)
    environment = proc_environment(pid)
    cwd = proc_cwd(pid)
    exe = proc_exe(pid)
    registration = registration or workflow_registration_evidence()

    if not chain or chain[0][0] != pid:
        reasons.append("legacy listener process is absent from the process table")
    if not _legacy_vite_command(argv):
        reasons.append("listener command is not the exact legacy Vivo BI Vite process")
    if cwd != ARTIFACT_DIR:
        reasons.append(f"legacy listener cwd is {cwd}, expected {ARTIFACT_DIR}")
    if not _node_executable(exe):
        reasons.append("legacy listener executable is not Node.js")
    if any(key.startswith(MANAGED_ENV_PREFIX) for key in environment):
        reasons.append("managed owner metadata is present; legacy recovery is unavailable")

    if len(chain) < 2:
        reasons.append("legacy pnpm-to-Vite ancestry is incomplete or ambiguous")
        pnpm_pid = None
        pnpm_args = ""
    else:
        pnpm_pid, pnpm_args = chain[1]
        if not _legacy_pnpm_command(proc_cmdline(pnpm_pid)):
            reasons.append("legacy pnpm-to-Vite ancestry is incomplete or ambiguous")
        pnpm_cwd = proc_cwd(pnpm_pid)
        pnpm_exe = proc_exe(pnpm_pid)
        if pnpm_cwd != ARTIFACT_DIR:
            reasons.append(
                f"legacy pnpm cwd is {pnpm_cwd}, expected {ARTIFACT_DIR}"
            )
        if not _node_executable(pnpm_exe):
            reasons.append("legacy pnpm executable is not Node.js")
        if any(key.startswith(MANAGED_ENV_PREFIX) for key in proc_environment(pnpm_pid)):
            reasons.append("legacy pnpm process carries managed owner metadata")

    if not registration.get("available") or not registration.get("verified"):
        reasons.extend(registration.get("reasons", ["artifact workflow registration is unverified"]))

    ancestry = [
        {
            "pid": item_pid,
            "args": item_args,
            "start_ticks": proc_start_ticks(item_pid),
        }
        for item_pid, item_args in chain
    ]
    if any(not item["start_ticks"] for item in ancestry):
        reasons.append("legacy process start identity is unavailable")

    # The migration target is intentionally only the listener and the exact
    # pnpm parent.  Never infer a broad process subtree from a similar command.
    target_pids = [pid]
    if pnpm_pid is not None and pnpm_pid not in target_pids:
        target_pids.append(pnpm_pid)
    target_identities = {
        target_pid: proc_start_ticks(target_pid)
        for target_pid in target_pids
    }
    if any(not ticks for ticks in target_identities.values()):
        reasons.append("legacy termination target identity is unavailable")

    return {
        "legacy": True,
        "pid": pid,
        "stable_listener_pid": stable_pid,
        "args": args,
        "cwd": str(cwd) if cwd else None,
        "executable": str(exe) if exe else None,
        "environment": {
            key: environment.get(key)
            for key in ("BASE_PATH", "PORT", "REPL_SLUG")
            if key in environment
        },
        "start_ticks": proc_start_ticks(pid),
        "ancestry": ancestry,
        "pnpm_pid": pnpm_pid,
        "pnpm_args": pnpm_args,
        "registration": registration,
        "target_identities": target_identities,
        "verified": not reasons,
        "reasons": list(dict.fromkeys(reasons)),
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


def _verified_legacy_termination_targets(
    listener_pid: int,
    expected: dict[str, Any],
) -> dict[int, tuple[str, int]]:
    """Open pidfds only after a fresh, complete legacy identity proof."""
    if not expected.get("verified") or not expected.get("legacy"):
        raise RuntimeError("refusing to terminate an unverified legacy owner")

    stable_pid, instability = stable_listener()
    if instability or stable_pid != listener_pid:
        raise RuntimeError(
            "legacy owner changed before termination; nothing was signalled"
        )
    if read_owner() is not None:
        raise RuntimeError(
            "managed owner metadata appeared before legacy termination; nothing was signalled"
        )

    current = inspect_legacy_listener(
        listener_pid,
        check_stability=False,
    )
    identity_keys = ("start_ticks", "args", "cwd", "executable", "pnpm_pid")
    if (
        not current.get("verified")
        or any(current.get(key) != expected.get(key) for key in identity_keys)
        or current.get("ancestry") != expected.get("ancestry")
        or current.get("target_identities") != expected.get("target_identities")
        or current.get("registration") != expected.get("registration")
    ):
        raise RuntimeError(
            "legacy owner identity changed before termination; nothing was signalled"
        )

    target_identities = current.get("target_identities")
    if not isinstance(target_identities, dict) or set(target_identities) != {
        listener_pid,
        current.get("pnpm_pid"),
    }:
        raise RuntimeError(
            "legacy process ancestry changed before termination; nothing was signalled"
        )
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError(
            "pidfd signalling is unavailable; refusing non-atomic legacy-owner termination"
        )

    targets: dict[int, tuple[str, int]] = {}
    try:
        for pid, expected_ticks in target_identities.items():
            if not isinstance(pid, int) or not expected_ticks:
                raise RuntimeError(
                    "legacy process identity is incomplete; nothing was signalled"
                )
            if proc_start_ticks(pid) != expected_ticks:
                raise RuntimeError(
                    "legacy process identity changed before termination; nothing was signalled"
                )
            pidfd = os.pidfd_open(pid)
            if proc_start_ticks(pid) != expected_ticks:
                os.close(pidfd)
                raise RuntimeError(
                    "legacy process identity changed before termination; nothing was signalled"
                )
            targets[pid] = (str(expected_ticks), pidfd)
    except Exception:
        for _, pidfd in targets.values():
            os.close(pidfd)
        raise
    return targets


def _signal_verified_legacy_owner(
    listener_pid: int,
    expected: dict[str, Any],
    signum: int,
) -> None:
    targets = _verified_legacy_termination_targets(listener_pid, expected)
    try:
        # Parent first lets pnpm shut down its Vite child.  pidfds prevent a
        # recycled PID from receiving a signal intended for the old owner.
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


def terminate_verified_legacy_owner(
    listener_pid: int,
    inspection: dict[str, Any],
) -> None:
    """Replace one freshly re-proven pre-guard owner and nothing else."""
    if not inspection.get("verified") or not inspection.get("legacy"):
        raise RuntimeError("refusing to terminate an unverified legacy owner")
    _signal_verified_legacy_owner(listener_pid, inspection, signal.SIGTERM)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if not listener_pids():
            return
        time.sleep(0.2)
    _signal_verified_legacy_owner(listener_pid, inspection, signal.SIGKILL)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if not listener_pids():
            return
        time.sleep(0.2)
    raise RuntimeError(f"verified legacy owner did not release port {PORT}")


def new_run_id() -> str:
    return str(uuid.uuid4())