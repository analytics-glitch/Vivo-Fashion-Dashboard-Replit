---
name: Product Workspace calendar dates
description: Calendar-date serialization and validation rules for the Product Workspace API and forms.
---

Serialize PostgreSQL `DATE` values from the JavaScript date object's local year, month, and day fields. Never use `toISOString()` or `String(date).slice(0, 10)` for these fields.

**Why:** The workspace operates in East Africa Time. UTC conversion can move a local calendar date back one day, while slicing `Date.toString()` produces values such as `Tue Sep 01` that HTML date inputs and PostgreSQL reject.

**How to apply:** Return `YYYY-MM-DD`, validate or unambiguously normalize incoming date fields before SQL, and name the failing field in validation errors. Preserve unreadable legacy text separately so unrelated edits remain saveable without silently overwriting it. For “current week” defaults, derive the Africa/Nairobi calendar date at page mount and calculate its Monday-based ISO year/week; never initialize from server UTC, saved data, cache state, or a hard-coded week.