#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/.pythonlibs/lib/python3.11/site-packages"
LOCKED_REQUIREMENTS="$(mktemp)"
trap 'rm -f "$LOCKED_REQUIREMENTS"' EXIT

mkdir -p "$TARGET_DIR"
cd "$ROOT_DIR"
uv export \
  --locked \
  --no-dev \
  --no-emit-project \
  --no-header \
  --no-annotate \
  --format requirements-txt \
  --output-file "$LOCKED_REQUIREMENTS" \
  >/dev/null
uv pip install \
  --target "$TARGET_DIR" \
  --upgrade \
  --requirements "$LOCKED_REQUIREMENTS"