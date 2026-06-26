#!/usr/bin/env python3
"""Pre-deploy code-health check: byte-compile every backend Python file.

This is the guard against shipping a syntactically broken backend (e.g. a
botched edit that leaves a file unparseable, like the sync_incremental.py
IndentationError that once crash-looped production for hours).

It compiles every top-level ``*.py`` module in the repo root (where all of this
project's backend lives) with ``py_compile`` and exits non-zero — listing each
offending file — if any of them fail to parse/compile. It is used two ways:

  1. As a registered ``compile`` validation command (a CI-style quality gate).
  2. As a boot-time gate inside ``watchdog.py`` (the deployment entrypoint), so a
     broken backend fails the deploy's startup health check and the previous
     healthy version keeps serving instead of a broken one going live.

Vendored / generated trees we do not own (``.pythonlibs``, ``node_modules``,
etc.) are never scanned, so third-party files can't produce false failures.
"""
import os
import sys
import py_compile

ROOT = os.path.dirname(os.path.abspath(__file__))


def iter_backend_files():
    """Yield the project's own top-level backend Python modules."""
    for name in sorted(os.listdir(ROOT)):
        path = os.path.join(ROOT, name)
        if name.endswith(".py") and os.path.isfile(path):
            yield path


def main():
    failures = []
    checked = 0
    for path in iter_backend_files():
        checked += 1
        try:
            py_compile.compile(path, doraise=True)
        except py_compile.PyCompileError as e:
            failures.append((path, str(e)))

    if failures:
        print(
            f"\u274c Python compile check FAILED \u2014 "
            f"{len(failures)} of {checked} backend file(s) do not compile:\n"
        )
        for path, err in failures:
            print(f"  \u2022 {os.path.relpath(path, ROOT)}")
            for line in err.strip().splitlines():
                print(f"      {line}")
        print("\nFix the syntax error(s) above before publishing.")
        return 1

    print(
        f"\u2705 Python compile check passed \u2014 "
        f"{checked} backend file(s) compile cleanly."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
