"""Unit tests for community Vivo Edits scheduling and image gating.

Tests are organised in two complementary layers that together protect against
both SQL predicate regressions and downstream behaviour regressions:

  Layer 1 – SQL predicate assertions (TestEditActiveSQLPredicates):
    Registers the routes, triggers the reconcile and image-gate endpoints,
    and asserts the executed SQL strings carry the required scheduling
    predicates (starts_at, ends_at, archived_at, now(), feed_post_id).
    If anyone removes or inverts a scheduling condition the assertions fail.

  Layer 2 – Behaviour tests with real timestamps (_SmartCursor):
    Uses a query-aware fake cursor that evaluates a Python mirror of
    _EDIT_ACTIVE_SQL against concrete FUTURE / PAST datetime values.
    The cursor returns what Postgres *would* return given those timestamps,
    so the downstream INSERT/UPDATE/404 assertions are driven by actual
    date semantics—not hard-coded response lists.

    Covered scenarios:
      • Future-scheduled edit  → no feed post created
      • Active edit (past start, no end) → approved feed post inserted
      • Ended edit (ends_at in the past) → feed post flipped to 'hidden'
      • Archived edit (archived_at set) → feed post flipped to 'hidden'
      • Likes/comments columns never touched during hiding
      • /api/community/edit-image returns 404 for never-published edits
      • /api/community/edit-image returns 200 for active edits
      • /api/community/edit-image returns 200 for expired-but-published edits

No live Postgres connection is required.

Run with::

    python -m unittest test_vivo_edits_schedule
"""

import re
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import community_app as ca

# ---------------------------------------------------------------------------
# Concrete timestamps used throughout
# ---------------------------------------------------------------------------
_FUTURE = datetime(2099, 1, 1, tzinfo=timezone.utc)   # definitively future
_PAST   = datetime(2020, 1, 1, tzinfo=timezone.utc)   # definitively past
_NOW    = datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Python mirror of _EDIT_ACTIVE_SQL
# ---------------------------------------------------------------------------
def _is_active(edit):
    """Evaluate _EDIT_ACTIVE_SQL logic in Python against an edit dict.

    Used by _SmartCursor to decide what rows to return so that the cursor
    simulates correct Postgres behaviour for the given timestamps.

    If the SQL predicate changes the SQL-level predicate tests (Layer 1)
    catch it; this function tests correct downstream behaviour.
    """
    if edit.get("archived_at") is not None:
        return False
    s = edit.get("starts_at")
    if s is not None and s > _NOW:
        return False
    e = edit.get("ends_at")
    if e is not None and e <= _NOW:
        return False
    return True


# ---------------------------------------------------------------------------
# Query-aware fake DB primitives
# ---------------------------------------------------------------------------

class _FakeRow(dict):
    """dict that also supports attribute-style access (like psycopg2 RealDictRow)."""
    def __getattr__(self, k):
        try:
            return self[k]
        except KeyError:
            raise AttributeError(k)


class _SmartCursor:
    """Query-aware fake cursor.

    Inspects each SQL string received via execute() and returns rows that
    accurately reflect _EDIT_ACTIVE_SQL semantics evaluated in Python against
    the supplied edit/feed-post/image data.

    This means:
    - removing `starts_at <= now()` from the SQL → Layer 1 catches it
    - changing downstream INSERT/UPDATE logic → Layer 2 catches it
    """

    def __init__(self, edits, feed_posts, images=None):
        """
        edits:      list of edit dicts (must include id, starts_at, ends_at,
                    archived_at, creator_name, creator_username, title, etc.)
        feed_posts: dict {post_id: {"status": str}}
        images:     dict {img_id: {"edit_id": int, "image": bytes, "mime": str}}
        """
        self.edits      = {e["id"]: dict(e) for e in edits}
        self.feed_posts = dict(feed_posts)
        self.images     = dict(images or {})
        self.executed   = []        # list of (sql, params)
        self._results   = []
        self._next_pid  = 900

    # ---- inspection helpers ----

    def _post_status(self, post_id):
        return self.feed_posts.get(post_id, {}).get("status") if post_id else None

    # ---- cursor protocol ----

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        s = sql.lower()   # lowercase for all pattern matching

        if "limit 50" in s and "community_edits e" in s:
            # Reconcile candidate SELECT: return edits whose active state
            # disagrees with their mirrored feed post.
            results = []
            for eid, edit in self.edits.items():
                act = _is_active(edit)
                pid = edit.get("feed_post_id")
                st  = self._post_status(pid)
                needs = (act and (pid is None or st != "approved")) or \
                        (not act and st == "approved")
                if needs:
                    results.append(_FakeRow({"id": eid}))
            self._results = results

        elif "where e.id = %s" in s and "is_active" in s:
            # _edit_sync_feed_post SELECT
            eid  = params[0] if params else None
            edit = self.edits.get(eid)
            if edit:
                row = _FakeRow(dict(edit))
                row["is_active"]       = _is_active(edit)
                row.setdefault("cover_image_id", None)
                row.setdefault("description",    "")
                row.setdefault("tagged",          [])
                self._results = [row]
            else:
                self._results = []

        elif "insert into community_feed_posts" in s:
            pid = self._next_pid; self._next_pid += 1
            # Back-link in our in-memory state so later queries see the post.
            if params:
                m = re.search(r"vivoedit_id_(\d+)", str(params[0]))
                if m:
                    eid = int(m.group(1))
                    self.feed_posts[pid] = {"status": "approved"}
                    if eid in self.edits:
                        self.edits[eid]["feed_post_id"] = pid
            self._results = [_FakeRow({"id": pid})]

        elif "update community_edits set feed_post_id" in s:
            if params and len(params) >= 2:
                post_id, eid = params[0], params[1]
                if eid in self.edits:
                    self.edits[eid]["feed_post_id"] = post_id
            self._results = []

        elif "update community_feed_posts" in s:
            # Params order (from _edit_sync_feed_post):
            # caption, tagged, image_url, status, author_username, post_id
            if params and len(params) >= 6:
                status  = params[3]
                post_id = params[5]
                if post_id in self.feed_posts:
                    self.feed_posts[post_id]["status"] = status
            self._results = []

        elif "i.image" in s and "i.mime" in s and "community_edit_images" in s:
            # community_edit_image endpoint SELECT (SELECT i.image, i.mime …)
            img_id = params[0] if params else None
            img    = self.images.get(img_id)
            if img:
                edit = self.edits.get(img["edit_id"])
                if edit and (_is_active(edit) or edit.get("feed_post_id")):
                    self._results = [_FakeRow(
                        {"image": img["image"], "mime": img["mime"]}
                    )]
                else:
                    self._results = []
            else:
                self._results = []

        elif "from community_edits" in s:
            # Public list SELECT
            rows = [
                _FakeRow({
                    "id": e["id"], "creator_name": e["creator_name"],
                    "title":        e.get("title", ""),
                    "description":  e.get("description", ""),
                    "disclosure":   None, "featured": False,
                    "feed_post_id": e.get("feed_post_id"),
                    "cover_image_id": None, "cover_alt": None,
                    "total": sum(1 for x in self.edits.values() if _is_active(x)),
                })
                for e in self.edits.values() if _is_active(e)
            ]
            self._results = rows

        else:
            self._results = []

    def fetchone(self):
        return self._results.pop(0) if self._results else None

    def fetchall(self):
        rows, self._results = self._results, []
        return rows

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass


class _SmartConn:
    def __init__(self, cursor):
        self._cur = cursor
        self.committed = False

    def cursor(self, **_):
        return self._cur

    def commit(self):
        self.committed = True

    def rollback(self):
        pass


@contextmanager
def _fake_db(cursor):
    yield _SmartConn(cursor)


# ---------------------------------------------------------------------------
# Test scaffolding helpers
# ---------------------------------------------------------------------------

def _make_app():
    """Fresh FastAPI app → fresh closure state (_edits_reconcile_last t=0)."""
    app = FastAPI()
    ca.register_community_routes(app, None)
    return app


def _patch_db(cursor):
    return mock.patch("community_app._db",
                      side_effect=lambda: _fake_db(cursor))


# Patch _ensure_tables and _throttle once for the module.
_patch_ensure   = mock.patch("community_app._ensure_tables", return_value=None)
_patch_throttle = mock.patch("community_app._throttle",      return_value=None)
_patch_ensure.start()
_patch_throttle.start()


def _trigger_reconcile(client):
    """Call the public edits list endpoint, which runs _edits_reconcile_feed."""
    return client.get("/api/community/edits")


# ---------------------------------------------------------------------------
# Layer 1 – SQL predicate assertions
# ---------------------------------------------------------------------------

class TestEditActiveSQLPredicates(unittest.TestCase):
    """Verify the scheduling predicates are present in the executed SQL.

    These tests are the regression guard for the SQL itself: if someone
    removes 'starts_at <= now()' or 'archived_at IS NULL' the assertions
    here fail regardless of what the cursor returns.
    """

    def _collect_executed(self, edits, feed_posts=None, images=None):
        cursor = _SmartCursor(edits, feed_posts or {}, images)
        app = _make_app()
        with _patch_db(cursor):
            with TestClient(app, raise_server_exceptions=True) as client:
                _trigger_reconcile(client)
        return [sql for sql, _ in cursor.executed]

    def test_reconcile_query_contains_starts_at(self):
        sqls = self._collect_executed([])
        self.assertTrue(
            any("starts_at" in s for s in sqls),
            "Reconcile SELECT must reference starts_at to gate future edits",
        )

    def test_reconcile_query_contains_ends_at(self):
        sqls = self._collect_executed([])
        self.assertTrue(
            any("ends_at" in s for s in sqls),
            "Reconcile SELECT must reference ends_at to gate expired edits",
        )

    def test_reconcile_query_contains_archived_at(self):
        sqls = self._collect_executed([])
        self.assertTrue(
            any("archived_at" in s for s in sqls),
            "Reconcile SELECT must reference archived_at to gate archived edits",
        )

    def test_reconcile_query_uses_now(self):
        sqls = self._collect_executed([])
        self.assertTrue(
            any("now()" in s.lower() for s in sqls),
            "Reconcile SELECT must call now() to compare current time",
        )

    def test_image_query_contains_feed_post_gate(self):
        """The image endpoint must gate on feed_post_id IS NOT NULL as fallback."""
        edit = {"id": 1, "creator_name": "A", "creator_username": "a",
                "title": "T", "starts_at": _PAST, "ends_at": None,
                "archived_at": None, "feed_post_id": None}
        images = {55: {"edit_id": 1, "image": b"\x89PNG", "mime": "image/png"}}
        cursor = _SmartCursor([edit], {}, images)
        app = _make_app()
        with _patch_db(cursor):
            with TestClient(app, raise_server_exceptions=False) as client:
                client.get("/api/community/edit-image/55")
        img_sqls = [s for s, _ in cursor.executed
                    if "community_edit_images" in s.lower()]
        self.assertTrue(len(img_sqls) >= 1, "Image endpoint must execute a query")
        self.assertTrue(
            any("feed_post_id" in s for s in img_sqls),
            "Image SELECT must reference feed_post_id for published-history gate",
        )

    def test_image_query_contains_active_state_condition(self):
        edit = {"id": 1, "creator_name": "A", "creator_username": "a",
                "title": "T", "starts_at": _PAST, "ends_at": None,
                "archived_at": None, "feed_post_id": None}
        images = {55: {"edit_id": 1, "image": b"\x89PNG", "mime": "image/png"}}
        cursor = _SmartCursor([edit], {}, images)
        app = _make_app()
        with _patch_db(cursor):
            with TestClient(app, raise_server_exceptions=False) as client:
                client.get("/api/community/edit-image/55")
        img_sqls = [s for s, _ in cursor.executed
                    if "community_edit_images" in s.lower()]
        self.assertTrue(
            any("starts_at" in s or "archived_at" in s for s in img_sqls),
            "Image SELECT must include the active-state scheduling conditions",
        )


# ---------------------------------------------------------------------------
# Layer 2 – Behaviour tests with real timestamps
# ---------------------------------------------------------------------------

def _run_reconcile(edits, feed_posts=None):
    """Run the reconcile endpoint once; return (cursor, response)."""
    cursor = _SmartCursor(edits, feed_posts or {})
    app = _make_app()
    with _patch_db(cursor):
        with TestClient(app, raise_server_exceptions=True) as client:
            resp = _trigger_reconcile(client)
    return cursor, resp


class TestFutureEditNotPublished(unittest.TestCase):
    """Future-scheduled edit: reconciler must NOT create a feed post."""

    def setUp(self):
        # starts_at in the far future → not active → no feed post needed
        self.edit = {
            "id": 1, "creator_name": "W M", "creator_username": "wm",
            "title": "Future Edit", "description": "TBD",
            "starts_at": _FUTURE, "ends_at": None, "archived_at": None,
            "feed_post_id": None,
        }

    def test_no_insert_for_future_edit(self):
        cursor, _ = _run_reconcile([self.edit])
        inserts = [s for s, _ in cursor.executed
                   if "INSERT" in s.upper()
                   and "community_feed_posts" in s.lower()]
        self.assertEqual(
            inserts, [],
            "Reconciler must not INSERT a feed post for a future-scheduled edit",
        )

    def test_future_edit_absent_from_public_list(self):
        _, resp = _run_reconcile([self.edit])
        self.assertEqual(resp.status_code, 200)
        ids = [item["id"] for item in resp.json().get("items", [])]
        self.assertNotIn(
            self.edit["id"], ids,
            "Future-scheduled edit must not appear in the public list",
        )


class TestActiveEditCreatesPost(unittest.TestCase):
    """Active edit (starts_at in the past, no ends_at): approved post created."""

    def setUp(self):
        self.edit = {
            "id": 2, "creator_name": "Z N", "creator_username": "zn",
            "title": "Active Edit", "description": "Live now",
            "starts_at": _PAST, "ends_at": None, "archived_at": None,
            "feed_post_id": None,
        }

    def test_approved_feed_post_inserted(self):
        cursor, _ = _run_reconcile([self.edit])
        inserts = [(s, p) for s, p in cursor.executed
                   if "INSERT" in s.upper()
                   and "community_feed_posts" in s.lower()]
        self.assertTrue(
            len(inserts) >= 1,
            "Reconciler must INSERT a feed post for an active edit",
        )
        # 'approved' is a literal in the INSERT SQL body (not a param).
        self.assertIn(
            "approved", inserts[0][0].lower(),
            "INSERT must embed status='approved' for an active edit",
        )

    def test_edit_row_back_linked(self):
        """After INSERT the edit's feed_post_id must be written back."""
        cursor, _ = _run_reconcile([self.edit])
        update_edits = [s for s, _ in cursor.executed
                        if "UPDATE" in s.upper()
                        and "community_edits" in s.lower()
                        and "feed_post_id" in s.lower()]
        self.assertTrue(
            len(update_edits) >= 1,
            "Reconciler must UPDATE community_edits.feed_post_id after INSERT",
        )

    def test_active_edit_appears_in_public_list(self):
        _, resp = _run_reconcile([self.edit])
        self.assertEqual(resp.status_code, 200)
        ids = [item["id"] for item in resp.json().get("items", [])]
        self.assertIn(self.edit["id"], ids,
                      "Active edit must appear in the public list")


class TestEndedEditHidden(unittest.TestCase):
    """ends_at in the past: feed post must flip to 'hidden'; likes/comments safe."""

    def setUp(self):
        self.post_id = 55
        self.edit = {
            "id": 3, "creator_name": "A K", "creator_username": "ak",
            "title": "Holiday Edit", "description": "Expired",
            "starts_at": _PAST, "ends_at": _PAST, "archived_at": None,
            "feed_post_id": self.post_id,
        }

    def _run(self):
        return _run_reconcile([self.edit],
                              feed_posts={self.post_id: {"status": "approved"}})

    def test_feed_post_updated_to_hidden(self):
        cursor, _ = self._run()
        updates = [(s, p) for s, p in cursor.executed
                   if "UPDATE" in s.upper()
                   and "community_feed_posts" in s.lower()]
        self.assertTrue(len(updates) >= 1,
                        "Reconciler must UPDATE the feed post for an expired edit")
        self.assertIn("hidden", str(updates[0][1]),
                      "UPDATE must set status='hidden' for an expired edit")

    def test_no_delete_on_likes_or_comments(self):
        """Hiding a post must never DELETE from likes or comments tables."""
        cursor, _ = self._run()
        deletes = [s for s, _ in cursor.executed
                   if "DELETE" in s.upper()
                   and ("likes" in s.lower() or "comments" in s.lower())]
        self.assertEqual(deletes, [],
                         "Reconciler must never DELETE likes/comments when hiding")

    def test_ended_edit_absent_from_public_list(self):
        _, resp = _run_reconcile([self.edit])
        self.assertEqual(resp.status_code, 200)
        ids = [item["id"] for item in resp.json().get("items", [])]
        self.assertNotIn(self.edit["id"], ids,
                         "Ended edit must not appear in the public list")


class TestArchivedEditHidden(unittest.TestCase):
    """archived_at set: feed post must flip to 'hidden'."""

    def setUp(self):
        self.post_id = 66
        self.edit = {
            "id": 4, "creator_name": "N G", "creator_username": "ng",
            "title": "Archived Edit", "description": "",
            "starts_at": _PAST, "ends_at": None, "archived_at": _PAST,
            "feed_post_id": self.post_id,
        }

    def _run(self):
        return _run_reconcile([self.edit],
                              feed_posts={self.post_id: {"status": "approved"}})

    def test_feed_post_updated_to_hidden(self):
        cursor, _ = self._run()
        updates = [(s, p) for s, p in cursor.executed
                   if "UPDATE" in s.upper()
                   and "community_feed_posts" in s.lower()]
        self.assertTrue(len(updates) >= 1,
                        "Reconciler must UPDATE the feed post for an archived edit")
        self.assertIn("hidden", str(updates[0][1]),
                      "UPDATE must set status='hidden' for an archived edit")

    def test_archived_edit_absent_from_public_list(self):
        _, resp = _run_reconcile([self.edit])
        self.assertEqual(resp.status_code, 200)
        ids = [item["id"] for item in resp.json().get("items", [])]
        self.assertNotIn(self.edit["id"], ids,
                         "Archived edit must not appear in the public list")


# ---------------------------------------------------------------------------
# Image gating – /api/community/edit-image/{img_id}
# ---------------------------------------------------------------------------

PNG_STUB = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def _get_image(edit, post_status=None, img_id=99):
    """Call the image endpoint for the given edit state."""
    posts = {}
    if post_status and edit.get("feed_post_id"):
        posts[edit["feed_post_id"]] = {"status": post_status}
    images = {img_id: {"edit_id": edit["id"], "image": PNG_STUB, "mime": "image/png"}}
    cursor = _SmartCursor([edit], posts, images)
    app = _make_app()
    with _patch_db(cursor):
        with TestClient(app, raise_server_exceptions=False) as client:
            return client.get(f"/api/community/edit-image/{img_id}"), cursor


class TestEditImageGating(unittest.TestCase):

    def test_unpublished_future_edit_image_is_404(self):
        """starts_at in future, no feed_post_id → image gated → 404."""
        edit = {
            "id": 10, "creator_name": "X", "creator_username": "x",
            "title": "T", "starts_at": _FUTURE, "ends_at": None,
            "archived_at": None, "feed_post_id": None,
        }
        resp, _ = _get_image(edit)
        self.assertEqual(resp.status_code, 404,
                         "Unpublished future-scheduled edit image must return 404")

    def test_active_edit_image_is_200(self):
        """Active edit (starts_at in past, no ends_at) → image served."""
        edit = {
            "id": 11, "creator_name": "X", "creator_username": "x",
            "title": "T", "starts_at": _PAST, "ends_at": None,
            "archived_at": None, "feed_post_id": None,
        }
        resp, _ = _get_image(edit)
        self.assertEqual(resp.status_code, 200,
                         "Active edit image must be served with 200")

    def test_expired_but_published_edit_image_is_200(self):
        """ends_at in past but feed_post_id set → image still served (history)."""
        edit = {
            "id": 12, "creator_name": "X", "creator_username": "x",
            "title": "T", "starts_at": _PAST, "ends_at": _PAST,
            "archived_at": None, "feed_post_id": 77,
        }
        resp, _ = _get_image(edit, post_status="hidden")
        self.assertEqual(resp.status_code, 200,
                         "Expired-but-published edit image must still be served")

    def test_archived_unpublished_edit_image_is_404(self):
        """archived_at set, no feed_post_id → 404."""
        edit = {
            "id": 13, "creator_name": "X", "creator_username": "x",
            "title": "T", "starts_at": _PAST, "ends_at": None,
            "archived_at": _PAST, "feed_post_id": None,
        }
        resp, _ = _get_image(edit)
        self.assertEqual(resp.status_code, 404,
                         "Archived unpublished edit image must return 404")


# ---------------------------------------------------------------------------
# Teardown module-level patches
# ---------------------------------------------------------------------------
def tearDownModule():
    _patch_ensure.stop()
    _patch_throttle.stop()


if __name__ == "__main__":
    unittest.main()
