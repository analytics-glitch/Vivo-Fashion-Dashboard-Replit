---
name: CRM complaint escalation & resolution notify
description: How the CEM 2.1 complaint case-management ladder, lazy SLA sweep, and closed-loop resolution notification behave in api_pg.py.
---

# CRM complaint escalation (CEM 2.1)

The escalation ladder and closed-loop resolution notification are **complaint-only**
constructs. General enquiry tickets (issue_category not in the complaint set) must
never enter the ladder.

## Rules
- Ladder: `associate -> team_lead -> head_of_cx` (`CRM_ESCALATION_LADDER`). 400 when
  escalating past the top.
- Manual escalate (`POST /api/crm/tickets/{id}/escalate`) **rejects non-complaints
  with 400** — guard with `_crm_is_complaint(issue_category)` before bumping.
- Gold/VIP customers' complaints auto-jump to `head_of_cx` at ticket-create time
  (tier from enrolment OR spend fallback via `_crm_customer_tier`).
- Lazy SLA-breach sweep `_crm_escalate_overdue()` runs on the **tickets-list read**
  (no cron, same pattern as loyalty points expiry). It MUST filter
  `LOWER(issue_category) = ANY(%s)` against `CRM_COMPLAINT_CATEGORIES` or it will
  escalate ordinary enquiries.

## Resolution notify idempotency
`_crm_notify_resolution` must be idempotent at the **DB level**, not via a pre-read
flag. Use a conditional update and emit side effects only when a row is returned:

```sql
UPDATE crm_tickets SET resolution_notified_at=now(), resolution_notify_channel=%s
WHERE id=%s AND resolution_notified_at IS NULL RETURNING id
```

**Why:** a pre-update read of `now_resolving` + unconditional side-effect insert lets
two concurrent resolve/close PATCHes both notify (duplicate system message +
interaction + audit). The conditional update means only the request that flips
`resolution_notified_at` from NULL wins; the loser returns early (`None`).

**How to apply:** any new closed-loop notification (CSAT trigger, etc.) that should
fire once per ticket should follow the same flip-a-null-timestamp-conditionally
pattern rather than guarding on a value read earlier in the request.
