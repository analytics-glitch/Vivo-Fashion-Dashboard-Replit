---
name: google-drive drive.file scope folder limitation
description: Why a Sheet can't be auto-placed into a user's pre-existing Drive folder with the google-sheet connector, and the My-Drive-root workaround.
---

# drive.file can't write into a user's pre-existing folder

The `google-sheet` connector carries scopes `drive.appdata`, `drive.file`,
`spreadsheets.readonly`, `spreadsheets`. The `drive.file` scope only grants access
to files **this OAuth app created itself**. Creating a file *inside* a folder the
user already owns (i.e. setting `parents:[<user_folder_id>]` on create, or adding
that parent later) returns **403 `insufficientParentPermissions`**. Full `drive`
scope (the separate `google-drive` connector) is required to write into a
pre-existing user folder.

**Workaround when the user declines the broader `google-drive` authorization:**
create the spreadsheet in **My Drive root** (Drive `files.create` with
`mimeType=application/vnd.google-apps.spreadsheet` and **no** `parents`), write
values with the `spreadsheets` scope, and have the user drag it into their folder
once, manually.

**Idempotency across dev/prod (separate DBs, same Google account+app):** search
with Drive `files.list q="name = '<name>' and mimeType='...spreadsheet' and
trashed=false"` using the **google-sheet** token. Because `drive.file` lists only
app-created files, a name match is guaranteed to be our own previously-created
sheet — so the dev and prod sync loops reuse it instead of duplicating. No parent
constraint needed in the query.

**Why:** Task #295 fabric category tracker delivers a Google Sheet; the user
dismissed the `google-drive` connector twice, so the folder-placement path was
abandoned for the root-create path. See `fabric_category_tracker.py`
(`ensure_sheet_target` / `_find_file`).
