---
name: Production workspace feasibility governance
description: Rules that keep production capacity, targets, and readiness states trustworthy.
---

Production workspace feasibility may only use capacity allocated from a saved calendar inside the plan's date window, and total allocations may not exceed that calendar's approved minutes. A manually supplied capacity number is an allocation, never a new denominator.

Approved production targets are approver-published master data. A plan with no applicable approved target, or a planned quantity above its summed dated target, is incomplete rather than feasible.

Plan operations snapshot the selected active operation/SAM definition into the revision. Subsequent master-data edits must not rewrite frozen history.

Readiness owners and due dates are accountable plan inputs. A status/evidence edit must preserve them unless it explicitly changes them; waived gates require an authorized exception and rationale.

**Why:** A feasibility badge influences line commitments. Letting an editor borrow out-of-window minutes, self-approve an output target, or silently erase accountability would make the badge falsely reassuring.

**How to apply:** When adding new capacity, target, or readiness routes, retain the plan-date, approved-master, optimistic-version, audit, and frozen-revision constraints in both API validation and the UI contract.