#!/usr/bin/env python3
"""Start the only approved Vivo BI frontend owner.

The workflow manager launches this file.  It serializes starts, adopts a
healthy managed owner, and only stops a stale owner whose complete identity is
still verifiable.  It never takes over an unrelated listener.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

try:  # Direct workflow execution keeps scripts/ on sys.path.
    from vivo_bi_managed_service import (
        ARTIFACT_DIR,
        OWNER_MARKER,
        PORT,
        WORKSPACE,
        WORKFLOW_COMMAND,
        acquire_lock,
        clear_owner_if_owned,
        inspect_listener,
        listener_pids,
        new_run_id,
        proc_start_ticks,
        read_owner,
        stable_listener,
        terminate_verified_owner,
        write_owner,
    )
except ModuleNotFoundError:  # Module imports are used by focused unit tests.
    from scripts.vivo_bi_managed_service import (
        ARTIFACT_DIR,
        OWNER_MARKER,
        PORT,
        WORKSPACE,
        WORKFLOW_COMMAND,
        acquire_lock,
        clear_owner_if_owned,
        inspect_listener,
        listener_pids,
        new_run_id,
        proc_start_ticks,
        read_owner,
        stable_listener,
        terminate_verified_owner,
        write_owner,
    )


def main() -> int:
    lock = acquire_lock()
    listener_pid, instability = stable_listener()
    if instability:
        print(f"Vivo BI managed start refused: {instability}", file=sys.stderr)
        return 1
    if listener_pid is not None:
        inspection = inspect_listener(listener_pid)
        if inspection["verified"]:
            print(f"Vivo BI managed owner already healthy (listener PID {listener_pid})")
            return 0
        owner = read_owner()
        # A stale owner is actionable only when the listener still carries the
        # exact managed marker and matches an atomically-written owner record.
        # Unmarked or changed processes are deliberately left untouched.
        if not owner or owner.get("listener_pid") != listener_pid:
            print(
                "Vivo BI managed start refused: port 18659 is held by an "
                "unproven or unrelated process; nothing was terminated",
                file=sys.stderr,
            )
            return 1
        stale_proof = inspect_listener(
            listener_pid,
            owner=owner,
            require_live_wrapper=False,
        )
        if not stale_proof["verified"]:
            print(
                "Vivo BI managed start refused: existing listener failed "
                f"identity proof ({'; '.join(stale_proof['reasons'])}); nothing was terminated",
                file=sys.stderr,
            )
            return 1
        terminate_verified_owner(listener_pid, stale_proof)
        listener_pid, instability = stable_listener()
        if instability or listener_pid is not None:
            print(
                "Vivo BI managed start refused: port ownership changed while "
                "confirming stale-owner recovery",
                file=sys.stderr,
            )
            return 1

    run_id = new_run_id()
    env = {
        **os.environ,
        "VIVO_BI_MANAGED_OWNER": OWNER_MARKER,
        "VIVO_BI_MANAGED_WORKSPACE": str(WORKSPACE),
        "VIVO_BI_MANAGED_ARTIFACT": str(ARTIFACT_DIR),
        "VIVO_BI_MANAGED_PORT": str(PORT),
        "VIVO_BI_MANAGED_RUN_ID": run_id,
    }
    command = ["pnpm", "--filter", "@workspace/vivo-bi", "run", "dev"]
    child = subprocess.Popen(command, cwd=WORKSPACE, env=env)
    write_owner({
        "owner": OWNER_MARKER,
        "workspace": str(WORKSPACE),
        "artifact": str(ARTIFACT_DIR),
        "port": PORT,
        "workflow_command": WORKFLOW_COMMAND,
        "wrapper_pid": os.getpid(),
        "wrapper_start_ticks": proc_start_ticks(os.getpid()),
        "child_pid": child.pid,
        "run_id": run_id,
    })

    def stop(_signum: int, _frame: object) -> None:
        if child.poll() is None:
            child.send_signal(signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while child.poll() is None:
            listener_pid, instability = stable_listener(timeout=1.0)
            if instability:
                child.terminate()
                raise RuntimeError(instability)
            if listener_pid is not None:
                owner = read_owner() or {}
                owner.update({
                    "listener_pid": listener_pid,
                    "listener_start_ticks": proc_start_ticks(listener_pid),
                })
                write_owner(owner)
                break
            time.sleep(0.2)
        return child.wait()
    finally:
        listener_pid = next(iter(listener_pids()), None)
        clear_owner_if_owned(listener_pid, run_id)
        lock.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BlockingIOError:
        print("Vivo BI managed start refused: another start is in progress", file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        print(f"Vivo BI managed start failed: {error}", file=sys.stderr)
        raise SystemExit(1)