#!/usr/bin/env python3
"""Dev launcher for the API server.

The dev workflow used to invoke ``uvicorn api_pg:app`` directly. If a previous
uvicorn from an earlier run was left holding :PORT, the new process failed to
bind (``address already in use``) while the orphan kept serving STALE code — the
exact failure that broke the Fabric BI Excel export. This launcher clears that
orphan via the shared port guard, then hands off to uvicorn unchanged.

Production does NOT use this file — there the watchdog supervises uvicorn and runs
the same guard before spawning it.
"""

import os

# Replit reserves DATABASE_URL for its managed Dev/Prod database workflow.
# Vivo's operational database may remain external under VIVO_DATABASE_URL;
# mirror it into DATABASE_URL before importing the application so legacy
# modules continue to share one connection setting.
if os.environ.get("VIVO_DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["VIVO_DATABASE_URL"]

import uvicorn

from port_guard import free_port

PORT = int(os.environ.get("PORT", "8080"))

if __name__ == "__main__":
    free_port(PORT)
    uvicorn.run("api_pg:app", host="0.0.0.0", port=PORT)
