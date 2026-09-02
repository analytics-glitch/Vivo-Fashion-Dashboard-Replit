#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/.pythonlibs/lib/python3.11/site-packages"

mkdir -p "$TARGET_DIR"
cd "$ROOT_DIR"
uv pip install \
  --target "$TARGET_DIR" \
  --upgrade \
  "fonttools==4.63.0" \
  "weasyprint==69.0"