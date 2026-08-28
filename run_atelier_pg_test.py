#!/usr/bin/env python3
"""Run Task 1617 Atelier integration tests on a fresh local PostgreSQL."""
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


def main():
    postgres = shutil.which("postgres")
    if not postgres:
        raise RuntimeError("postgres is required for the PostgreSQL integration test")
    pg_bin, port, user = Path(postgres).parent, _free_port(), "atelier_test_runner"
    with tempfile.TemporaryDirectory(prefix="atelier-pg-test-") as directory:
        root, data, log = Path(directory), Path(directory) / "data", Path(directory) / "postgres.log"
        subprocess.run([str(pg_bin / "initdb"), "-D", str(data), "--auth=trust",
                        "--no-locale", "--encoding=UTF8", f"--username={user}"],
                       check=True, stdout=subprocess.DEVNULL)
        started = False
        try:
            subprocess.run([str(pg_bin / "pg_ctl"), "-D", str(data), "-l", str(log), "-o",
                            f"-h 127.0.0.1 -k {root} -p {port} -F", "-w", "start"],
                           check=True, stdout=subprocess.DEVNULL)
            started = True
            subprocess.run([str(pg_bin / "createdb"), "-h", "127.0.0.1", "-p", str(port),
                            "-U", user, "atelier_test"], check=True)
            env = os.environ.copy()
            env.pop("DATABASE_URL", None)
            env.pop("DATABASE_URL_DIRECT", None)
            env["TEST_DATABASE_URL"] = f"postgresql://{user}@127.0.0.1:{port}/atelier_test?sslmode=disable"
            subprocess.run([sys.executable, "-m", "unittest", "-v",
                            "test_atelier_pg.AtelierPostgresTests"], check=True, env=env)
        finally:
            if started:
                subprocess.run([str(pg_bin / "pg_ctl"), "-D", str(data), "-m", "fast", "-w", "stop"],
                               check=False, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()