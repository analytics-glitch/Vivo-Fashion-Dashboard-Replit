---
name: Production API compile gate
description: Explains why an unrelated malformed Python test can take down every published API route before FastAPI starts.
---

The production watchdog runs the repository-wide Python compile check before spawning uvicorn. The scan includes backend test files, so a syntax error in any scanned test prevents port 8080 from opening; static pages may still load while every routed `/api/*` request returns a plain proxy-level HTTP 500.

**Why:** A published login failure looked like an authentication regression, but FastAPI never received the request because the watchdog failed closed on a corrupted merchandising test.

**How to apply:** When the live static shell loads but unrelated API paths and `/api/healthz` all return plain 500 responses with no FastAPI access log, inspect deployment logs for the compile gate and run `python3 check_python_syntax.py` before changing endpoint logic.