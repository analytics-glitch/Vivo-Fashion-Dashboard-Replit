# community_seeds/

Boot-time seed assets for the Vivo Community app.

This directory ships with the production deployment image (it is **not** listed
in `.replitignore`). Files here are read once at startup by `_seed_vivo_edits`
in `community_app.py` and stored as BYTEA in the `community_edit_images` table.

## Contents

| File | Used by |
|------|---------|
| `Sharon_1_*.png` | Launch edit — Sharon, cover image |
| `Sharon_2_*.png` | Launch edit — Sharon, second image |
| `Phinie_1__*.png` | Launch edit — Phinie, cover image |
| `Phinie_2_*.png` | Launch edit — Phinie, second image |
| `Grace_1_*.png` | Launch edit — Grace, cover image |
| `Grace_2_*.png` | Launch edit — Grace, second image |

## Adding new launch edits

1. Drop the PNG(s) here.
2. Add an entry to `_VIVO_EDIT_SEEDS` in `community_app.py`.
3. The seed is idempotent — existing `edit_key` rows are never overwritten.

## Source files

The originals live in `attached_assets/` (excluded from prod deploys).
Keep this directory in sync when the source photos change.
