#!/usr/bin/env python3
"""Build and independently validate a sanitised four-flow release-proof run."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any, Iterable


EXPECTED_TITLES = [
    "Command Centre desktop handles filters, refresh failure, recovery, partial data, and every enabled drill-down",
    "Command Centre has no page-level overflow on phone or tablet",
    "Production role can use production destinations but is denied Order Tracker",
    "Quality role redacts personnel productivity at phone width",
]
FLOW_SCREENSHOTS = {
    EXPECTED_TITLES[0]: {
        "command-centre-desktop-healthy.png",
        "command-centre-partial-data.png",
        "command-centre-refresh-error.png",
        "command-drill-quality.png",
        "command-drill-execution-capture.png",
        "command-drill-production-tracker.png",
        "command-drill-production-report.png",
        "command-drill-order-tracker.png",
        "command-drill-planning-workspace.png",
        "command-drill-productivity-recovery.png",
    },
    EXPECTED_TITLES[1]: {"command-centre-phone.png", "command-centre-tablet.png"},
    EXPECTED_TITLES[2]: {"production-role-denied-order-tracker.png"},
    EXPECTED_TITLES[3]: {"quality-role-redaction-phone.png"},
}
EXPECTED_SCREENSHOTS = set().union(*FLOW_SCREENSHOTS.values())
TOKEN_PATTERN = re.compile(rb"e2e_production_(?:admin|operator|quality)_[0-9a-f-]+")
UNSAFE_EVIDENCE_PATTERNS = (
    TOKEN_PATTERN,
    re.compile(rb"VIVO_E2E_(?:TOKEN|PRODUCTION_TOKEN|QUALITY_TOKEN)\s*="),
    re.compile(rb"Authorization:\s*Bearer\s+e2e_", re.IGNORECASE),
    re.compile(rb"(?i)(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n\"']+"),
    re.compile(rb"(?i)\bbearer\s+[a-z0-9._~+/-]{12,}"),
    re.compile(rb"(?i)(?:access_token|id_token|session_token|token)=([^&\s\"']+)"),
    re.compile(rb"https?://[^\s\"']*googleusercontent\.com/[^\s\"']+"),
    re.compile(rb"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b"),
    re.compile(rb"(?is)(\"name\"\s*:\s*\"(?:cookie|set-cookie|authorization|proxy-authorization)\"\s*,\s*\"value\"\s*:\s*\")(?!\[REDACTED\])[^\"]*(\")"),
    re.compile(rb"(?is)(\"value\"\s*:\s*\")(?!\[REDACTED\])[^\"]*(\"\s*,\s*\"name\"\s*:\s*\"(?:cookie|set-cookie|authorization|proxy-authorization)\")"),
)
REQUIRED_TOP_LEVEL = {
    "release-proof-report.json",
    "production-release-cleanup.json",
    "release-proof-manifest.json",
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def iter_specs(report: dict[str, Any]) -> Iterable[dict[str, Any]]:
    def visit(suite: dict[str, Any]) -> Iterable[dict[str, Any]]:
        yield from suite.get("specs", [])
        for child in suite.get("suites", []):
            yield from visit(child)

    for suite in report.get("suites", []):
        yield from visit(suite)


def report_specs(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    specs = list(iter_specs(report))
    if [spec.get("title") for spec in specs] != EXPECTED_TITLES:
        fail("the report does not contain the four release flows in the required order")
    if any(len(spec.get("tests", [])) != 1 for spec in specs):
        fail("each release flow must have exactly one test result")
    return {spec["title"]: spec for spec in specs}


def read_zip_bytes(path: Path) -> bytes:
    with zipfile.ZipFile(path) as archive:
        return b"\n".join(archive.read(info) for info in archive.infolist())


def contains_unsafe_evidence(path: Path) -> bool:
    data = read_zip_bytes(path) if path.suffix == ".zip" else path.read_bytes()
    return any(pattern.search(data) for pattern in UNSAFE_EVIDENCE_PATTERNS)


def relative_path(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except ValueError as error:
        fail(f"evidence path escapes its run directory: {path}")
        raise AssertionError from error


def flow_files(output: Path, report: dict[str, Any]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for title, spec in report_specs(report).items():
        test = spec["tests"][0]
        results = test.get("results", [])
        if len(results) != 1 or results[0].get("status") != "passed":
            fail(f"flow {title!r} does not have one passing result")
        attachments = results[0].get("attachments", [])
        traces = [
            Path(item["path"]).resolve()
            for item in attachments
            if item.get("name") == "trace" and item.get("path")
        ]
        if len(traces) != 1:
            fail(f"flow {title!r} must map to exactly one trace attachment")
        trace = traces[0]
        flow_dir = trace.parent
        if not trace.is_file() or trace.name != "trace.zip":
            fail(f"flow {title!r} trace is not the retained trace.zip")
        log = flow_dir / "browser-console.txt"
        if not log.is_file() or log.stat().st_size == 0:
            fail(f"flow {title!r} is missing one non-empty browser-console.txt")
        names = {
            path.name
            for path in flow_dir.iterdir()
            if path.is_file()
        }
        expected = {"browser-console.txt", "trace.zip"} | FLOW_SCREENSHOTS[title]
        if names != expected:
            fail(f"flow {title!r} has unexpected or missing files: {sorted(names ^ expected)}")
        for screenshot in FLOW_SCREENSHOTS[title]:
            screenshot_path = flow_dir / screenshot
            if not screenshot_path.is_file() or screenshot_path.stat().st_size == 0:
                fail(f"flow {title!r} is missing non-empty screenshot {screenshot}")
        result[title] = {relative_path(flow_dir / name, output) for name in expected}
    return result


def disk_files(output: Path) -> dict[str, Path]:
    files = {
        relative_path(path, output): path
        for path in output.rglob("*")
        if path.is_file()
    }
    if set(files) & {".last-run.json"}:
        fail("Playwright run-state .last-run.json must not be retained")
    return files


def git_inventory(output: Path, workspace: Path) -> set[str]:
    output_rel = relative_path(output, workspace)
    tracked = subprocess.run(
        ["git", "ls-files", "--cached", "--", output_rel],
        check=False,
        capture_output=True,
        text=True,
        cwd=workspace,
    )
    if tracked.returncode:
        fail(f"could not read committed evidence inventory: {tracked.stderr.strip()}")
    untracked = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "--", output_rel],
        check=False,
        capture_output=True,
        text=True,
        cwd=workspace,
    )
    if untracked.returncode:
        fail(f"could not read untracked evidence inventory: {untracked.stderr.strip()}")
    ignored: list[str] = []
    for path in output.rglob("*"):
        if path.is_file():
            check = subprocess.run(
                ["git", "check-ignore", "-q", "--", relative_path(path, workspace)],
                check=False,
                cwd=workspace,
            )
            if check.returncode == 0:
                ignored.append(relative_path(path, workspace))
    if untracked.stdout.strip() or ignored:
        fail(f"evidence contains untracked or ignored files: {untracked.stdout.strip()} {ignored}")
    return {
        line
        for line in tracked.stdout.splitlines()
        if line
    }


def run_identity(output: Path) -> str:
    prefix = "production-workspace-release-main-"
    if not output.name.startswith(prefix) or len(output.name) == len(prefix):
        fail("release evidence directory is not run-specific")
    return output.name[len(prefix):]


def validate_manifest(output: Path, manifest: dict[str, Any], expected_paths: set[str]) -> None:
    if manifest.get("flow_count") != 4 or manifest.get("run_id") != run_identity(output):
        fail("manifest run identity or flow count is invalid")
    entries = manifest.get("files")
    if not isinstance(entries, list):
        fail("manifest files inventory is missing")
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"path", "bytes", "sha256"}:
            fail("manifest contains a malformed file entry")
        path = entry["path"]
        if not isinstance(path, str) or path in seen or path not in expected_paths:
            fail(f"manifest contains unexpected or duplicate path: {path!r}")
        seen.add(path)
        disk_path = output / path
        if not disk_path.is_file():
            fail(f"manifest artifact is absent on disk: {path}")
        if entry["bytes"] != disk_path.stat().st_size or entry["sha256"] != sha256(disk_path):
            fail(f"manifest hash or size mismatch: {path}")
    if seen != expected_paths:
        fail(f"manifest inventory differs from disk: {sorted(seen ^ expected_paths)}")


def main(output: Path, *, build_manifest: bool = False) -> int:
    workspace = Path(__file__).resolve().parents[1]
    output = output.resolve()
    if not output.is_dir():
        fail(f"release evidence directory does not exist: {output}")
    report_path = output / "release-proof-report.json"
    receipt_path = output / "production-release-cleanup.json"
    manifest_path = output / "release-proof-manifest.json"
    if not report_path.is_file() or not receipt_path.is_file():
        fail("missing Playwright JSON report or cleanup receipt")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    stats = report.get("stats", {})
    if (
        stats.get("expected") != 4
        or stats.get("unexpected") != 0
        or stats.get("flaky") != 0
        or stats.get("skipped") != 0
    ):
        fail("the report does not prove four non-flaky passing release flows")
    specs = report_specs(report)

    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if (
        receipt.get("suite_run_id") != run_identity(output)
        or not receipt.get("ok")
        or not receipt.get("evidence_sanitized")
        or not receipt.get("run_state_removed")
        or receipt.get("sanitization_scan") != {"unsafe_matches": 0}
    ):
        fail("cleanup receipt does not prove this run was sanitised and its state removed")
    expected_remaining = {
        "sessions", "role_users", "meetings", "ratings", "execution_output",
        "execution_events", "assignments", "operations", "plan_versions",
        "work_items", "shifts", "lines", "factories", "operators", "attendance",
    }
    remaining = receipt.get("remaining")
    if (
        not isinstance(remaining, dict)
        or set(remaining) != expected_remaining
        or any(remaining[key] != 0 for key in expected_remaining)
    ):
        fail("cleanup receipt does not independently prove zero residue for every run-owned dependency")

    mapped = flow_files(output, report)
    all_files = disk_files(output)
    files = {
        path: disk_path
        for path, disk_path in all_files.items()
        if path != "release-proof-manifest.json"
    }
    expected_paths = set(REQUIRED_TOP_LEVEL)
    for paths in mapped.values():
        expected_paths.update(paths)
    if set(files) != expected_paths - {"release-proof-manifest.json"}:
        fail(f"disk inventory contains unexpected or missing evidence: {sorted(set(files) ^ (expected_paths - {'release-proof-manifest.json'}))}")
    for path, disk_path in files.items():
        if contains_unsafe_evidence(disk_path):
            fail(f"unsafe evidence found in retained file: {path}")
    if build_manifest and not manifest_path.is_file():
        manifest = {
            "suite": "Production Command Centre release proof",
            "run_id": run_identity(output),
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
            "flows": {
                title: sorted(paths)
                for title, paths in mapped.items()
            },
            "cleanup": {
                "evidence_sanitized": True,
                "run_state_removed": True,
                "remaining": {key: remaining[key] for key in sorted(expected_remaining)},
            },
            "files": [
                {
                    "path": path,
                    "bytes": disk_path.stat().st_size,
                    "sha256": sha256(disk_path),
                }
                for path, disk_path in sorted(files.items())
            ],
        }
        temporary = manifest_path.with_name(".release-proof-manifest.json.tmp")
        temporary.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temporary.replace(manifest_path)
    if not manifest_path.is_file():
        fail("release-proof manifest is absent; build it once before final verification")
    if set(disk_files(output)) != expected_paths:
        fail("manifest creation changed the exact evidence inventory")
    # The manifest is deliberately re-read after it is written. Validation
    # never trusts the in-memory object used to build it.
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    validate_manifest(output, manifest, set(files))
    expected_committed = {relative_path(path, workspace) for path in files.values()} | {
        relative_path(manifest_path, workspace)
    }
    if not build_manifest:
        committed = git_inventory(output, workspace)
        if committed != expected_committed:
            fail(f"committed evidence inventory differs from disk: {sorted(committed ^ expected_committed)}")
    print(json.dumps({
        "ok": True,
        "flow_count": 4,
        "manifest": str(manifest_path),
        "files": len(expected_committed),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        arguments = sys.argv[1:]
        build_manifest = arguments[:1] == ["--build"]
        if build_manifest:
            arguments = arguments[1:]
        if len(arguments) != 1:
            fail("usage: validate-production-release-proof.py [--build] <review-directory>")
        raise SystemExit(main(Path(arguments[0]), build_manifest=build_manifest))
    except (IndexError, RuntimeError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        print(f"Release-proof validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)