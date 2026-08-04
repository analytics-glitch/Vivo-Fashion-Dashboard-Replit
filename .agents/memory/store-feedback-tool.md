---
name: Store Feedback tool
description: Rules and access model for the store-feedback page (staff log customer feedback, HQ triages) in the BI app.
---

# Store Feedback tool (page id `store-feedback`)

Staff-facing customer-feedback capture + HQ triage loop inside vivo-bi. Backend is a standalone module registered onto the API app (endpoints under `/api/store-feedback`).

## Access model
- **Submit is open to every authenticated BI user** (any role): meta, product-search, POST, `/mine`, and owner access to own items/attachments.
- **Review surface is reviewer-only: roles `admin`, `leadership`, `smt`** — list, summary KPIs, PATCH status/notes, CSV export. The gate lives **inside the handlers** (not middleware); client tab-hiding is UX only.
- **Why:** submissions should never be blocked by role plumbing, but triage/PII-bearing lists must not leak to store staff.
- Employee self-signup fence deliberately NOT widened for this — store managers already have proper accounts.
- Page id is in `_LEADERSHIP_PAGES` AND granted to retail/store_manager/customer_service/marketing in DEFAULT_ROLE_PAGES, mirrored in permissions.js (lockstep rule).

## Distinct from legacy "feedback" page
`feedback` (page id) = dashboard-feedback-to-BI-team inbox (`/admin/feedback`). `store-feedback` = customer voice from stores. Never merge or confuse the two.

## Data & workflow rules
- Status workflow: `new → reviewed → actioned → dismissed`; reviewer notes are shown back to the submitter ("Response from HQ") — closing the loop is the point of the tool.
- Attachments: BYTEA rows in a child table (same deploy-safe pattern as sop_files), size-capped, client compresses images before upload. Serving is owner-or-reviewer gated (IDOR guard).
- **Upload type = server-side magic-byte sniff, NEVER client MIME** (JPEG/PNG/WebP/GIF/PDF allowlist; SVG banned — active content). Stored content_type comes from the sniff; serving re-sniffs + sends nosniff + CSP sandbox + sanitized filename. Architect caught the original client-MIME trust as a stored-XSS vector against reviewers — reuse this pattern for any future upload endpoint.
- Tables are lazily created (`_ensure_tables`) — any new reader endpoint must call it or 500s on fresh DBs (same lesson as fabric reservations).
- Notifications reuse `user_notifications` with dedupe_key ON CONFLICT DO NOTHING: fan-out to active admins on new submission, notify submitter on status change.
- Store list = DISTINCT pos_location_name from last-365d sales (includes Online rows — acceptable; online feedback is legitimate).
- Product autocomplete = style-grain search over all_products_clean; free-text fallback allowed ("Use as typed") so a missing product never blocks a submission.

## How to apply
Any new endpoint on this module: decide submitter-vs-reviewer explicitly, add the role check in the handler, call `_ensure_tables`, and keep owner-or-reviewer on anything id-addressed (items, attachments).
