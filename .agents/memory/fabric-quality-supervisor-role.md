---
name: Fabric Quality Supervisor RBAC role
description: Role for fabric QC supervisors who approve inspection tickets and sign off delivery batches — no email hardcoding.
---

## Rule
`fabric_quality_supervisor` is a first-class VALID_ROLES entry (alongside `fabric_warehouse`). QC approval rights derive from this role — never from a hardcoded email set.

**Why:** `_INSPECTION_SUPERVISOR_EMAILS` was a hardcoded set that required code changes to add/remove supervisors. The role is now managed through the admin Users panel like every other role.

**How to apply:**
- `_insp_can_approve(request)` in `fabric_router.py` is strictly role-based: `role in ("admin", "fabric_quality_supervisor")`. Does NOT inherit _fabric_full_admin's email allowance — receiving-admin and QC-approval authority are intentionally separate.
- `fabric_quality_supervisor` pages: `["fabric", "sops"]` — same as the const in `permissions.js`.
- The fabric QC supervisor's account is seeded to this role via `_seed_fabric_quality_supervisor()` in `api_pg.py` (deferred startup, idempotent, won't demote an admin).
- Delivery signoff columns (`delivery_approved_by`, `delivery_approved_by_email`, `delivery_approved_at`) are on `fabric_receiving_po_sheets`, added via lazy `ALTER TABLE ADD COLUMN IF NOT EXISTS` in `_ensure_receiving_tables`.
- Approve endpoint: `POST /api/fabric/receiving/po/{po_id}/approve-delivery` — 422 if any rolls have Pending quality without an Approved 4-Point ticket; 409 if already approved; audit row `action='delivery_approved'` in `fabric_recv_audit`.
- `GET /api/fabric/receiving/rights` now returns `can_approve_delivery` boolean (used by the dashboard's `recvCanApproveDelivery` flag).
- `GET /api/fabric/qc/report` returns `delivery_approvals[]` array — one entry per PO in the filtered roll set.
