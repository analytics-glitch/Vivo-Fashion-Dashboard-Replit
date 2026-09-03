---
name: PLM Style Team
description: Role-based ownership for editable Product Workspace styles.
---

The editable Product Workspace style model has independent nullable team assignments for Designer, Pattern Maker, CAD, Sample Maker, and Buyer. They reference the workspace team directory rather than login users. New styles must write those references directly; free-text people are not valid assignment inputs. Legacy `owner` remains as a fallback, and is only migrated into Designer when the normalized names match exactly.

**Why:** one owner could not represent the cross-functional handoff, while deleting or overwriting legacy owner text would lose attribution for names that are not in the current team directory.

**How to apply:** use the role IDs for writes and the joined role objects for cards/grouping. Pattern Maker grouping uses the assigned member first, then the legacy pattern-maker text; keep the legacy owner visible until a Designer is assigned.

The same identity rule applies to mutable L10 owners and PLM tech-pack, grading, pattern, and sample assignments: current writes use Settings-user IDs, current reads join the latest Settings name, and unmatched legacy labels remain fallback-only. Historical actors, comments, attendance, feedback submitters, and audit snapshots stay as text.

**Why:** Live work must follow renames without fragmenting ownership, but historical evidence must preserve what was recorded at the time.

**How to apply:** Do not convert arbitrary JSON assignee payloads or historical names merely because they contain person-like text; only introduce references where the field is an active editable assignment with established Settings-user semantics.

Former team members may remain in the workspace identity table as non-current records so historic Designer references continue to resolve, but they must be excluded from current-team pickers and new assignment choices. Grace is the first such historical-only designer. Rose is a current CAD member and remains eligible as a referenced designer even while unavailable.

**Why:** Deleting a departed person breaks historic attribution, while leaving them selectable creates incorrect new assignments.

**How to apply:** Join historic references regardless of current-member status, but require current-member status for any changed Designer assignment and for public/current team directories.