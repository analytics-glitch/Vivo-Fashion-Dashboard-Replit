#!/bin/bash
# Local prod-parity entrypoint. In the pnpm-workspace deployment, production is
# actually driven by each artifact's artifact.toml (the api-server service runs
# watchdog.py). This script lets you run the same supervised stack locally.
cd /home/runner/workspace
exec python3 watchdog.py
