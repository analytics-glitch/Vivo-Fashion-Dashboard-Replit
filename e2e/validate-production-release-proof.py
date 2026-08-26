#!/usr/bin/env python3
"""Validate and manifest a sanitised Production Workspace release-proof run."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path


EXPECTED_TITLES = {
    "Command Centre desktop handles filters, refresh failure, recovery, partial data, and every enabled drill-down",
    "Command Centre has no page-level overflow on phone or tablet",
    "Production role can use production destinations but is denied Order Tracker",
    "Quality role redacts personnel productivity at phone width",
}
EXPECTED_SCREENSHOTS = {
    "command-centre-desktop-healthy.png",
    "command-centre-phone.png",
    "command-centre-tablet.png",
    "command-centre-partial-data.png",
    "command-centre-refresh-error.png",
    "command-drill-quality.png",
    "command-drill-execution-capture.png",
    "command-drill-production-tracker.png",
    "command-drill-production-report.png",
    "command-drill-order-tracker.png",
    "command-drill-planning-workspace.png",
    "command-drill-productivity-recovery.png",
    "production-role-denied-order-tracker.png",
    "quality-role-redaction-phone.png",
}
TOKEN_PATTERN = re.compile(rb"e2e_production_(?:admin|operator|quality)_[0-9a-f-]+")


def fail(message: str) -> None:
    raise RuntimeError(message)


def contains_token(path: Path) -> bool:
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as archive:
            return any(TOKEN_PATTERN.search(archive.read(info)) for info in archive.infolist())
    return bool(TOKEN_PATTERN.search(path.read_bytes()))


def report_titles(report: dict) -> set[str]:
    return {
        spec["title"]
        for suite in report.get("suites", [])
        for spec in suite.get("specs", [])
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main(output: Path) -> int:
    if not output.is_dir():
        fail(f"release evidence directory does not exist: {output}")
    report_path = output / "release-proof-report.json"
    receipt_path = output / "production-release-cleanup.json"
    if not report_path.is_file() or not receipt_path.is_file():
        fail("missing Playwright JSON report or cleanup receipt")

    report = json.loads(report_path.read_text(encoding="utf-8"))
    stats = report.get("stats", {})
    if (
        stats.get("expected") != 4
        or stats.get("unexpected") != 0
        or stats.get("flaky") != 0
        or stats.get("skipped") != 0
        or report_titles(report) != EXPECTED_TITLES
    ):
        fail("the report does not prove the required four release flows")

    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if not receipt.get("ok") or not receipt.get("evidence_sanitized") or not receipt.get("run_state_removed"):
        fail("cleanup did not complete with sanitised evidence and removed private run state")
    remaining = receipt.get("remaining")
    expected_remaining = {
        "sessions", "role_users", "meetings", "ratings", "execution_output",
        "execution_events", "assignments", "operations", "plan_versions",
        "work_items", "shifts", "lines", "factories", "operators", "attendance",
    }
    if not isinstance(remaining, dict) or not expected_remaining.issubset(remaining) or any(remaining[key] != 0 for key in expected_remaining):
        fail("cleanup receipt does not independently prove zero residue for every run-owned dependency")

    files = [path for path in output.rglob("*") if path.is_file()]
    names = {path.name for path in files}
    missing_screenshots = EXPECTED_SCREENSHOTS - names
    if missing_screenshots:
        fail(f"missing expected screenshots: {sorted(missing_screenshots)}")
    if sum(path.name == "browser.log" for path in files) < 4:
        fail("missing per-flow browser logs")
    if sum(path.suffix == ".zip" for path in files) < 4:
        fail("missing per-flow traces")

    for path in files:
        if path.name != "release-proof-manifest.json" and contains_token(path):
            fail(f"live session token found in retained evidence: {path.relative_to(output)}")

    manifest = {
        "suite": "Production Command Centre release proof",
        "flow_count": 4,
        "viewport_contract": {
            "desktop": "1440x768",
            "tablet_width": 768,
            "phone_width": 390,
        },
        "direct_drills": [
            "Quality", "Capture", "Tracker", "Report", "Order Tracker",
            "Planning", "Recovery history",
        ],
        "cleanup": {
            "evidence_sanitized": True,
            "run_state_removed": True,
            "remaining": {key: remaining[key] for key in sorted(expected_remaining)},
        },
        "files": [
            {
                "path": str(path.relative_to(output)),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
            for path in sorted(files)
            if path.name != "release-proof-manifest.json"
        ],
    }
    (output / "release-proof-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"ok": True, "manifest": str(output / "release-proof-manifest.json")}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(Path(sys.argv[1]).resolve()))
    except (IndexError, RuntimeError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        print(f"Release-proof validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)