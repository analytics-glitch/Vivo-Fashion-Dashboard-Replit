---
name: Style Tracker warehouse gate toggle
description: The ≥90% move-to-Warehouse gate flag and its current state
---
- `_ST_WAREHOUSE_GATE_ENABLED` (api_pg.py, single boolean) gates the Style Tracker rule that a style must be ≥90% physically moved before it can be advanced to the Warehouse stage.
- State: **ON (True)**. It was temporarily set to False on 2026-08-04 for a user data-cleanup exercise and restored to True the same day at the user's explicit request ("return the 90% gate").
- If users report styles stuck / unable to move to Warehouse in Style Tracker, this gate is the first thing to check before debugging deeper.
