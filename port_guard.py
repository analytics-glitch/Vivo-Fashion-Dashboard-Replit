"""Free a TCP port held by a stale/orphaned API process before (re)binding.

Why this exists
---------------
The API server binds :PORT (default 8080). If a previous `uvicorn api_pg:app`
run is replaced (workflow restart, crashed supervisor, redeploy) but its process
is not reaped, the leftover keeps the port. The new server then dies with
``[Errno 98] address already in use`` — and because the dev workflow shows
"failed" while the *orphan* keeps serving, the site silently serves STALE code
(this is exactly what broke the Fabric BI Excel export: the live process predated
the endpoint that the workflow was trying to (re)start).

This guard is invoked from the two places that actually launch uvicorn — the dev
launcher (``run_api.py``) and the production supervisor (``watchdog.py``) — BEFORE
the bind. It is deliberately NOT run as an import side-effect of ``api_pg`` because
many scripts/tests import that module and must never kill the running server.

Safety: the guard kills ONLY the process(es) that actually hold the LISTEN socket
on the target port — it maps the port's socket inode from ``/proc/net/tcp`` and
resolves it to a PID via ``/proc/<pid>/fd``. The ``uvicorn``+``api_pg`` cmdline
match is an additional guardrail (AND), never the sole selector. If the holder
cannot be confidently attributed to our own uvicorn, the guard logs and leaves it
alone (returns False) rather than risk killing the wrong process — startup stays
non-fatal but safe. ``ss``/``lsof`` are unreliable in this container, hence the
raw ``/proc`` reads.
"""

from __future__ import annotations

import os
import signal
import socket
import time


def _port_free(port: int) -> bool:
    """True if uvicorn could bind the port right now (nothing is *listening*).

    Mirrors uvicorn by setting ``SO_REUSEADDR`` so a socket merely lingering in
    ``TIME_WAIT`` (the normal aftermath of killing the previous server) does NOT
    read as busy — only a process actively LISTENing on the port does.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("0.0.0.0", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return os.path.isdir(f"/proc/{pid}")


def _listening_inodes(port: int) -> set[str]:
    """Socket inodes of LISTEN sockets bound to ``port`` (IPv4 + IPv6)."""
    inodes: set[str] = set()
    want = f"{port:04X}"
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path) as fh:
                next(fh, None)  # header
                for line in fh:
                    parts = line.split()
                    # local_address  st            inode
                    if len(parts) < 10:
                        continue
                    if parts[3] != "0A":  # 0A == TCP_LISTEN
                        continue
                    local = parts[1]
                    if ":" not in local:
                        continue
                    if local.rsplit(":", 1)[1].upper() == want:
                        inodes.add(parts[9])
        except (FileNotFoundError, PermissionError, OSError):
            continue
    return inodes


def _pids_holding(inodes: set[str]) -> set[int]:
    """PIDs (excluding ourselves) with an open fd to any of ``inodes``."""
    if not inodes:
        return set()
    targets = {f"socket:[{i}]" for i in inodes}
    me = os.getpid()
    pids: set[int] = set()
    try:
        entries = os.listdir("/proc")
    except OSError:
        return pids
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == me:
            continue
        fddir = f"/proc/{pid}/fd"
        try:
            fds = os.listdir(fddir)
        except (FileNotFoundError, ProcessLookupError, PermissionError, OSError):
            continue
        for fd in fds:
            try:
                if os.readlink(f"{fddir}/{fd}") in targets:
                    pids.add(pid)
                    break
            except (FileNotFoundError, ProcessLookupError, PermissionError, OSError):
                continue
    return pids


def _cmdline(pid: int) -> str:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            return fh.read().replace(b"\x00", b" ").decode("utf-8", "replace")
    except (FileNotFoundError, ProcessLookupError, PermissionError, OSError):
        return ""


def _is_our_uvicorn(pid: int) -> bool:
    cl = _cmdline(pid)
    return "uvicorn" in cl and "api_pg" in cl


def free_port(port: int = 8080, log=None) -> bool:
    """Ensure ``port`` is bindable, killing a stale ``uvicorn api_pg`` if needed.

    Kills ONLY the process(es) that actually hold the LISTEN socket on ``port``
    AND whose cmdline is our uvicorn. If the holder can't be attributed to our
    own uvicorn, it is left alone. Returns True if the port is free (or was
    freed), False otherwise. Never raises — a guard must not take down the thing
    it is guarding.
    """
    def _say(msg: str) -> None:
        if log is None:
            print(msg, flush=True)
        else:
            log(msg)

    try:
        if _port_free(port):
            return True

        holders = _pids_holding(_listening_inodes(port))
        if not holders:
            _say(f"[port-guard] :{port} busy but the holder could not be "
                 f"attributed via /proc — leaving it alone")
            return _port_free(port)

        targets = sorted(p for p in holders if _is_our_uvicorn(p))
        others = sorted(holders - set(targets))
        if not targets:
            _say(f"[port-guard] :{port} held by pid(s) {others} which are NOT "
                 f"'uvicorn api_pg' — leaving it alone (refusing to kill an "
                 f"unrelated process)")
            return _port_free(port)
        if others:
            _say(f"[port-guard] :{port} also held by non-uvicorn pid(s) "
                 f"{others} — leaving those alone")

        _say(f"[port-guard] :{port} held by stale uvicorn api_pg pid(s) "
             f"{targets} — terminating before bind")

        for sig in (signal.SIGTERM, signal.SIGKILL):
            alive = [p for p in targets if _alive(p)]
            if not alive:
                break
            for p in alive:
                try:
                    os.kill(p, sig)
                except (ProcessLookupError, PermissionError):
                    pass
            for _ in range(10):
                if _port_free(port):
                    _say(f"[port-guard] :{port} freed")
                    return True
                time.sleep(0.3)

        ok = _port_free(port)
        _say(f"[port-guard] :{port} {'freed' if ok else 'STILL busy after kill'}")
        return ok
    except Exception as e:  # pragma: no cover - defensive: never block startup
        _say(f"[port-guard] error while freeing :{port}: {e} — continuing")
        try:
            return _port_free(port)
        except Exception:
            return False
