#!/usr/bin/env python3
"""Run Production Tracker Sheet (Task #1607) integration tests against a
disposable local PostgreSQL cluster — never the application DATABASE_URL."""

import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _postgres_bin():
    postgres = shutil.which("postgres")
    if not postgres:
        raise RuntimeError("postgres is required for the PostgreSQL integration test")
    return Path(postgres).parent


def main():
    pg_bin = _postgres_bin()
    port = _free_port()
    db_user = "production_tracker_sheet_test_runner"
    with tempfile.TemporaryDirectory(prefix="production-tracker-sheet-pg-test-") as tmp:
        root = Path(tmp)
        data = root / "data"
        log = root / "postgres.log"
        subprocess.run([
            str(pg_bin / "initdb"), "-D", str(data),
            "--auth=trust", "--no-locale", "--encoding=UTF8",
            f"--username={db_user}",
        ], check=True, stdout=subprocess.DEVNULL)
        started = False
        try:
            subprocess.run([
                str(pg_bin / "pg_ctl"), "-D", str(data),
                "-l", str(log), "-o",
                f"-h 127.0.0.1 -k {root} -p {port} -F",
                "-w", "start",
            ], check=True, stdout=subprocess.DEVNULL)
            started = True
            subprocess.run([
                str(pg_bin / "createdb"), "-h", "127.0.0.1",
                "-p", str(port), "-U", db_user,
                "production_tracker_sheet_test",
            ], check=True)

            env = os.environ.copy()
            env.pop("DATABASE_URL_DIRECT", None)
            test_db_url = (
                f"postgresql://{db_user}@127.0.0.1:{port}/"
                "production_tracker_sheet_test?sslmode=disable"
            )
            env["TEST_DATABASE_URL"] = test_db_url
            # production_tracker_sheet_sync.py reads DATABASE_URL at import time for its
            # module-level constant, but the tests never open a connection through it
            # (they pass cursors from the disposable cluster explicitly) — point it at
            # the same throwaway database so import succeeds without ever touching the
            # application's real DATABASE_URL.
            env["DATABASE_URL"] = test_db_url
            subprocess.run([
                sys.executable, "-m", "unittest", "-v",
                "test_production_tracker_sheet",
            ], check=True, env=env)
        finally:
            if started:
                subprocess.run([
                    str(pg_bin / "pg_ctl"), "-D", str(data),
                    "-m", "fast", "-w", "stop",
                ], check=False, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
