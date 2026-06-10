---
name: Python deps live in .pythonlibs
description: How to add a Python package in this repl — pip and installLanguagePackages both fail; install into .pythonlibs with uv.
---

Python packages for the FastAPI backend (`api_pg.py`, `sync_incremental.py`) live in
`/home/runner/workspace/.pythonlibs/lib/python3.11/site-packages` — NOT in
`pyproject.toml` (its `dependencies` array is empty and unused).

**Rule:** to add a Python dependency, run:
`uv pip install --python python3 --target /home/runner/workspace/.pythonlibs/lib/python3.11/site-packages <pkg>`

**Why:** `pip install` is blocked (externally-managed Nix env) and the
`installLanguagePackages` tool fails here too. `.pythonlibs` is NOT gitignored, so a
package installed there persists into the repl and to deployment.

**How to apply:** any time a backend import is missing (e.g. openpyxl for xlsx export),
install with the uv `--target` command above, then verify with `python3 -c "import <pkg>"`.
