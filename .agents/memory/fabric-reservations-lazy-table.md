---
name: Fabric reservations lazy table
description: The fabric_reservations table is created lazily; any reader that joins it must ensure it first.
---

Buying-team manual reservations live in an app-owned `fabric_reservations` table in `fabric_router.py`, created by `_ensure_fabric_tables(conn)` (idempotent DDL, guarded by a module flag so it only runs DDL once per process).

**Rule:** every endpoint whose SQL references `fabric_reservations` MUST call `_ensure_fabric_tables(conn)` right after opening its connection — not just the reservation write/read endpoints. The register endpoint joins an active-reservation aggregate CTE (`resv` → `team_reserved_kg`/`team_reserved_metres`), so it also has to ensure the table.

**Why:** on a fresh DB (and prod is a SEPARATE DB), the table won't exist until some reservation endpoint has been hit. A reader that joins it without ensuring first fails with `relation "fabric_reservations" does not exist`. This bit the register query, which always references the table now.

**How to apply:** when adding any new fabric query that touches `fabric_reservations` (reports, exports, dashboards), add the `_ensure_fabric_tables(conn)` call. This is distinct from Odoo's ERP `raw_fabric_inventory.reserved_qty` (shown as `reserved_kg`/`available_kg`) — the manual reservation column is `team_reserved_kg`/`team_reserved_metres`.
