#!/usr/bin/env python3
"""Run Community referral integration tests against disposable PostgreSQL."""

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
    db_user = "community_referral_test_runner"
    with tempfile.TemporaryDirectory(prefix="community-referral-pg-test-") as tmp:
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
                "community_referral_test",
            ], check=True)

            env = os.environ.copy()
            # Never let a test accidentally inherit an application connection.
            env.pop("DATABASE_URL", None)
            env.pop("DATABASE_URL_DIRECT", None)
            env["TEST_DATABASE_URL"] = (
                f"postgresql://{db_user}@127.0.0.1:{port}/"
                "community_referral_test?sslmode=disable"
            )
            subprocess.run([
                sys.executable, "-m", "unittest", "-v",
                "test_community_referrals.CommunityReferralPostgresTests",
            ], check=True, env=env)
        finally:
            if started:
                subprocess.run([
                    str(pg_bin / "pg_ctl"), "-D", str(data),
                    "-m", "fast", "-w", "stop",
                ], check=False, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    main()