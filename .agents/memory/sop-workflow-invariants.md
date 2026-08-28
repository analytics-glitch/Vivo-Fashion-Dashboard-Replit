---
name: SOP workflow stage and revision invariants
description: Durable compatibility and audit rules for the staged SOP repository.
---

Keep legacy Approved and Obsolete stage IDs stable when inserting or reordering workflow stages; display order and internal identity are separate concerns.

**Why:** Existing SOP rows and historical stage events refer to internal IDs, so renumbering IDs would silently reinterpret history.

**How to apply:** Add new stages with unused IDs, then control user-facing numbering through stage names/order.

Every SOP content save and every stage transition must append an immutable content snapshot in the same database statement as the update.

**Why:** A stage event alone proves that a move happened but cannot prove which exact wording was reviewed or approved.

**How to apply:** Retained direct transition routes and editor transitions must both increment the revision and insert the snapshot atomically. Replacing a stage-one upload starts a clean revision history.

Approved master copies must preserve the meaning and structure of the reviewed content; reject anything that cannot be faithfully rendered before running approval SQL.

**Why:** A technically valid PDF can still corrupt text or flatten tables into ambiguous lines, making the master document differ materially from what reviewers approved.

**How to apply:** Keep fidelity checks shared by every approval route, test semantic layout as well as text presence, and leave the SOP revision and stage unchanged when rendering is unsafe.

DOCX fidelity checks must inspect note content, not merely package-part presence; Word may include empty comments parts and separator-only footnote/endnote parts. Ordinary font face, size, and colour metadata may be normalized by the editor.

**Why:** Treating template-only OOXML parts or routine font metadata as unsupported content falsely rejects otherwise readable modern Word SOPs.

**How to apply:** Reject comments and notes only when their XML contains real user records (excluding footnote/endnote IDs -1 and 0), while retaining strict rejection for content the editor would actually lose.