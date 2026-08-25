---
name: L10 meeting tracker rules
description: L10 IDS auto-listing/reconcile, meeting-date editing, admin edit-rights, and department recovery safety
---
- IDS auto-entries: the scorecard save and `GET /api/l10/ids/{meeting}` share one helper (`_l10_sync_metric_ids_entry`); the GET also runs `_l10_reconcile_scorecard_ids`, making the IDS list self-healing for weeks whose values were saved before auto-listing existed.
  Rules: red metric → update the open auto-entry, else insert ONLY if no entry exists at all; green/empty → delete open auto-entries; discussed/resolved entries are never touched or resurrected.
- Meeting date edit: `PUT /api/l10/meetings/{id}` recomputes week_label via `_l10_iso_week`; the duplicate check is BY DATE RANGE (Monday–Sunday of the target week), NOT label equality — legacy week_labels mix "2026-W30" and "2026-06-28" formats, so label comparison misses duplicates. Editing normalizes the label to ISO form (accepted).
- Date editing is open to all L10 users (not admin-gated): supply-chain leads (folder 2) must fix their own meeting dates; the auth middleware already folder-scopes `/api/l10/meetings/{id}`.
- Admin edit rights are client-side UX gating only (`role === 'admin'` from useAuth): unlocks every scorecard week for editing and adds rock description/results/owner inline edits + archive. The backend PUTs were already open to all L10 users.

**Why:** L10 is the EOS weekly leadership meeting. Weeks saved before auto-IDS existed had missed-target metrics absent from IDS, and mis-entered meeting dates could not be corrected at all.

**How to apply:** any new "auto-list X into IDS" rule should go through the same sync/reconcile helper pattern (upsert-open / delete-open / never-resurrect), and any new meeting-identity logic must tolerate the mixed legacy week_label formats.

- Finance & Operations recovery is snapshot-only: accept exactly one explicitly named Main BI department with every L10 table, declared count, and internal reference validated; preview is non-mutating and restore remaps every generated ID in one transaction.
  **Why:** no historical Finance source is present in the live environments, so a best-effort reconstruction would invent or disconnect EOS history. Legacy cross-department foreign-key links can also cascade into protected workspaces during a delete.
  **How to apply:** before replacing a restored department, capture and persist the current Main BI snapshot server-side under the restore lock (a browser download is only a second copy), reconcile per-section source versus inserted counts, reject external meeting/metric/rock/to-do links, and never use the path for SLT or Fabric-owned Supply Chain.
