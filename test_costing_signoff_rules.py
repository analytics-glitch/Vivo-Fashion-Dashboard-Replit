"""Unit tests pinning the costing sign-off rights + separation-of-duties rules.

The three-step Product Costing sign-off (Prepared / Checked / Approved) is
enforced server-side in ``fabric_router.costing_sheet_sign``:

* per-step email rights — each step has its OWN allowlist
  (``_COSTING_STEP_EMAILS``); only those emails may sign that step;
* ordered signing — a step can only be signed once every earlier step is;
* separation of duties — whoever holds the PRECEDING step's signature may not
  sign the next one (prepared→checked, checked→approved), compared by email
  with a user_id fallback, and judged against the CURRENT holder (so an
  unsign-then-resign is re-checked against the new signer);
* the combined tab/API allowlist ``_FABRIC_COSTING_EMAILS`` is exactly the
  union of the step sets.

These were verified manually end-to-end but had no automated coverage — a
future edit to the endpoint could silently let the wrong person sign. The
tests call the REAL endpoint functions (``costing_sheet_sign`` /
``costing_sheet_unsign``) against an in-memory fake signoff store (no live
Postgres, no HTTP server): ``q``/``_get_conn`` and the side-effect helpers
(history log, bell notifications, sheet payload) are stubbed, while the rule
logic — rights check, order check, SoD check, ON CONFLICT already-signed
race — runs unmodified.

Run with the stdlib test path (no pytest in this env)::

    python -m unittest test_costing_signoff_rules
"""
import re
import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

import fabric_router as fr


# ─────────────────────────────────────────────────────────────────────────────
# In-memory fake of the fabric_costing_signoffs table + connection plumbing
# ─────────────────────────────────────────────────────────────────────────────

class FakeSignoffStore:
    """sheet_id -> {step: row}. Mimics the two SQL statements the endpoints
    run against fabric_costing_signoffs (INSERT ... ON CONFLICT DO NOTHING
    RETURNING id, and DELETE ... step >= %s RETURNING id)."""

    def __init__(self):
        self.rows = {}      # sheet_id -> {step: row-dict}
        self.next_id = 1

    def insert(self, sheet_id, step, title, uid, uname):
        sheet = self.rows.setdefault(sheet_id, {})
        if step in sheet:                       # ON CONFLICT DO NOTHING
            return None
        row = {"id": self.next_id, "step": step, "title": title,
               "signed_by": uid, "signed_by_name": uname, "signed_at": None}
        self.next_id += 1
        sheet[step] = row
        return row["id"]

    def delete_from(self, sheet_id, step):
        sheet = self.rows.get(sheet_id, {})
        removed = [sheet.pop(s)["id"] for s in (1, 2, 3)
                   if s >= step and s in sheet]
        return removed

    def signoff_rows(self, sheet_id):
        return [dict(r) for r in self.rows.get(sheet_id, {}).values()]


class FakeCursor:
    def __init__(self, store):
        self.store = store
        self._result = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        if s.startswith("INSERT INTO fabric_costing_signoffs"):
            sheet_id, step, title, uid, uname = params
            new_id = self.store.insert(sheet_id, step, title, uid, uname)
            self._result = [] if new_id is None else [(new_id,)]
        elif s.startswith("DELETE FROM fabric_costing_signoffs"):
            sheet_id, step = params
            self._result = [(i,) for i in self.store.delete_from(sheet_id, step)]
        else:
            raise AssertionError(f"unexpected SQL in fake cursor: {s[:80]}")

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)


class FakeConn:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self, *a, **k):
        return FakeCursor(self.store)

    def commit(self):
        pass


def _request_for(email, uid=None, name=None):
    user = {"email": email, "user_id": uid or f"local:{email}",
            "name": name or email.split("@")[0]}
    return SimpleNamespace(state=SimpleNamespace(user=user))


# ─────────────────────────────────────────────────────────────────────────────
# Test base: patch the DB/side-effect seams, keep the rule logic real
# ─────────────────────────────────────────────────────────────────────────────

class SignoffTestBase(unittest.TestCase):
    SHEET_ID = 7

    def setUp(self):
        self.store = FakeSignoffStore()
        self.conn = FakeConn(self.store)
        # email directory the real _costing_signer_email resolves through
        self.user_emails = {}   # user_id -> email

        def fake_q(conn, sql, params=()):
            s = " ".join(sql.split()).lower()
            if "from fabric_costing_sheets" in s:
                sheet_id = params[0]
                if sheet_id != self.SHEET_ID:
                    return []
                return [{"style_name": "Test Style", "color": "Black"}]
            if "from fabric_costing_signoffs" in s:
                return self.store.signoff_rows(params[0])
            if "from app_users" in s:
                uid = params[0]
                email = self.user_emails.get(uid)
                return [{"email": email}] if email else []
            raise AssertionError(f"unexpected SQL in fake q: {s[:80]}")

        patches = [
            mock.patch.object(fr, "_get_conn", lambda: self.conn),
            mock.patch.object(fr, "_ensure_costing_tables", lambda conn: None),
            mock.patch.object(fr, "q", fake_q),
            mock.patch.object(fr, "_costing_history_write",
                              lambda *a, **k: None),
            mock.patch.object(fr, "_notify_costing_users",
                              lambda *a, **k: None),
            mock.patch.object(fr, "_sheet_payload",
                              lambda conn, sheet_id: {"id": sheet_id}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    # helpers ----------------------------------------------------------------
    def sign(self, step, email, uid=None):
        if uid:
            self.user_emails[uid] = email
        else:
            uid = f"local:{email}"
            self.user_emails[uid] = email
        return fr.costing_sheet_sign(
            self.SHEET_ID, _request_for(email, uid=uid), body={"step": step})

    def unsign(self, step, email):
        return fr.costing_sheet_unsign(
            self.SHEET_ID, step, _request_for(email))

    def assertHTTPError(self, status, fn, *args, detail_re=None, **kw):
        with self.assertRaises(HTTPException) as ctx:
            fn(*args, **kw)
        self.assertEqual(ctx.exception.status_code, status,
                         f"detail: {ctx.exception.detail}")
        if detail_re:
            self.assertRegex(str(ctx.exception.detail), detail_re)
        return ctx.exception

    def signed_steps(self):
        return sorted(self.store.rows.get(self.SHEET_ID, {}))


# Fixture allowlists with a deliberate overlap at EVERY boundary so the SoD
# mechanism itself (not just the current real membership) is exercised:
# carol may both check and approve, alice may both prepare and check.
FIXTURE_STEPS = {
    1: {"alice@x.com", "prep@x.com"},
    2: {"alice@x.com", "carol@x.com"},
    3: {"carol@x.com", "boss@x.com"},
}


class FixtureStepsMixin:
    """Run the endpoint against the fixture allowlists."""

    def setUp(self):
        super().setUp()
        p = mock.patch.object(fr, "_COSTING_STEP_EMAILS", FIXTURE_STEPS)
        p.start()
        self.addCleanup(p.stop)


# ─────────────────────────────────────────────────────────────────────────────
# 1. Allowlist shape: combined set == union of the step sets
# ─────────────────────────────────────────────────────────────────────────────

class TestAllowlistUnion(unittest.TestCase):
    def test_combined_allowlist_is_union_of_step_sets(self):
        self.assertEqual(
            fr._FABRIC_COSTING_EMAILS,
            frozenset().union(*fr._COSTING_STEP_EMAILS.values(),
                              fr._COSTING_VIEW_EMAILS),
            "_FABRIC_COSTING_EMAILS must be the union of the per-step "
            "sign-off sets and the view-only set")

    def test_step_sets_cover_steps_1_2_3_and_are_nonempty(self):
        self.assertEqual(set(fr._COSTING_STEP_EMAILS), {1, 2, 3})
        for step, emails in fr._COSTING_STEP_EMAILS.items():
            self.assertTrue(emails, f"step {step} allowlist is empty")

    def test_emails_are_normalized_lowercase(self):
        # the endpoint compares the user's lowercased email against the sets
        # verbatim, so any uppercase/whitespace in the sets would never match
        for step, emails in fr._COSTING_STEP_EMAILS.items():
            for e in emails:
                self.assertEqual(e, e.strip().lower(),
                                 f"step {step} email {e!r} is not normalized")
                self.assertRegex(e, re.compile(r"^[^@\s]+@[^@\s]+$"),
                                 f"step {step} email {e!r} malformed")

    def test_tab_gate_admits_every_step_signer_and_nobody_else(self):
        for emails in fr._COSTING_STEP_EMAILS.values():
            for e in emails:
                self.assertTrue(fr._fabric_costing_allowed({"email": e}))
                self.assertTrue(fr._fabric_costing_allowed(
                    {"email": "  " + e.upper() + " "}),
                    "gate must normalize case/whitespace")
        self.assertFalse(fr._fabric_costing_allowed(
            {"email": "outsider@vivofashiongroup.com"}))
        self.assertFalse(fr._fabric_costing_allowed({}))
        self.assertFalse(fr._fabric_costing_allowed(None))


# ─────────────────────────────────────────────────────────────────────────────
# 2. Per-step email rights (real production sets)
# ─────────────────────────────────────────────────────────────────────────────

class TestPerStepRights(SignoffTestBase):
    def test_each_step_only_accepts_its_own_allowlist(self):
        all_emails = set(fr._FABRIC_COSTING_EMAILS) | {"outsider@x.com"}
        for step in (1, 2, 3):
            for email in sorted(all_emails):
                self.store.rows.clear()
                # pre-sign the earlier steps with distinct authorized signers
                # so only the RIGHTS check decides the outcome
                self._presign_up_to(step)
                if email in fr._COSTING_STEP_EMAILS[step] and not \
                        self._would_trip_sod(step, email):
                    self.sign(step, email)
                    self.assertIn(step, self.signed_steps())
                elif email not in fr._COSTING_STEP_EMAILS[step]:
                    self.assertHTTPError(
                        403, self.sign, step, email,
                        detail_re="not authorized to sign")

    def _presign_up_to(self, step):
        # pick a signer for each earlier step that doesn't collide with later
        # SoD checks: costing@ prepares, stephen checks
        seed = {1: "costing@vivofashiongroup.com",
                2: "stephen@vivofashiongroup.com"}
        for s in range(1, step):
            self.sign(s, seed[s])

    def _would_trip_sod(self, step, email):
        if step in (2, 3):
            prev = self.store.rows.get(self.SHEET_ID, {}).get(step - 1)
            if prev and self.user_emails.get(prev["signed_by"]) == email:
                return True
        return False

    def test_step_arg_validation(self):
        self.assertHTTPError(400, fr.costing_sheet_sign, self.SHEET_ID,
                             _request_for("bedan@vivofashiongroup.com"),
                             body={"step": "nope"})
        self.assertHTTPError(400, fr.costing_sheet_sign, self.SHEET_ID,
                             _request_for("bedan@vivofashiongroup.com"),
                             body={"step": 4})

    def test_missing_sheet_404s_for_authorized_signer(self):
        self.assertHTTPError(
            404, fr.costing_sheet_sign, 999,
            _request_for("bedan@vivofashiongroup.com"), body={"step": 1})


# ─────────────────────────────────────────────────────────────────────────────
# 3. Ordered signing + already-signed
# ─────────────────────────────────────────────────────────────────────────────

class TestOrderedSigning(FixtureStepsMixin, SignoffTestBase):
    def test_cannot_sign_step2_before_step1(self):
        self.assertHTTPError(400, self.sign, 2, "carol@x.com",
                             detail_re="in order")

    def test_cannot_sign_step3_before_step2(self):
        self.sign(1, "alice@x.com")
        self.assertHTTPError(400, self.sign, 3, "boss@x.com",
                             detail_re="in order")

    def test_already_signed_step_409s(self):
        self.sign(1, "alice@x.com")
        self.assertHTTPError(409, self.sign, 1, "prep@x.com",
                             detail_re="already signed")

    def test_full_happy_path_signs_all_three(self):
        self.sign(1, "alice@x.com")
        self.sign(2, "carol@x.com")
        self.sign(3, "boss@x.com")
        self.assertEqual(self.signed_steps(), [1, 2, 3])


# ─────────────────────────────────────────────────────────────────────────────
# 4. Separation of duties
# ─────────────────────────────────────────────────────────────────────────────

class TestSeparationOfDuties(FixtureStepsMixin, SignoffTestBase):
    def test_preparer_cannot_check_same_sheet(self):
        self.sign(1, "alice@x.com")
        self.assertHTTPError(403, self.sign, 2, "alice@x.com",
                             detail_re="Separation of duties")

    def test_checker_cannot_approve_same_sheet(self):
        self.sign(1, "alice@x.com")
        self.sign(2, "carol@x.com")
        self.assertHTTPError(403, self.sign, 3, "carol@x.com",
                             detail_re="Separation of duties")

    def test_preparer_may_approve(self):
        # SoD only fences the IMMEDIATELY preceding step
        p = mock.patch.object(
            fr, "_COSTING_STEP_EMAILS",
            {1: {"alice@x.com"}, 2: {"carol@x.com"},
             3: {"alice@x.com", "boss@x.com"}})
        p.start()
        self.addCleanup(p.stop)
        self.sign(1, "alice@x.com")
        self.sign(2, "carol@x.com")
        self.sign(3, "alice@x.com")   # allowed: alice checked nothing
        self.assertEqual(self.signed_steps(), [1, 2, 3])

    def test_sod_matches_by_email_across_different_user_ids(self):
        # same person, different login ids (local: vs google:) — email is the
        # canonical identity, so the SoD fence must still fire
        self.sign(1, "alice@x.com", uid="local:alice")
        self.user_emails["google:alice"] = "alice@x.com"
        self.assertHTTPError(
            403, fr.costing_sheet_sign, self.SHEET_ID,
            _request_for("alice@x.com", uid="google:alice"), body={"step": 2},
            detail_re="Separation of duties")

    def test_sod_falls_back_to_user_id_when_email_unresolvable(self):
        self.sign(1, "alice@x.com", uid="local:alice")
        del self.user_emails["local:alice"]   # app_users lookup finds nothing
        # same uid signing step 2 (email differs) → uid fallback blocks it
        self.user_emails["local:alice"] = None
        self.assertHTTPError(
            403, fr.costing_sheet_sign, self.SHEET_ID,
            _request_for("carol@x.com", uid="local:alice"), body={"step": 2},
            detail_re="Separation of duties")


# ─────────────────────────────────────────────────────────────────────────────
# 5. Unsign, then re-sign
# ─────────────────────────────────────────────────────────────────────────────

class TestUnsignResign(FixtureStepsMixin, SignoffTestBase):
    def test_unsign_clears_the_step_and_every_later_step(self):
        self.sign(1, "alice@x.com")
        self.sign(2, "carol@x.com")
        self.sign(3, "boss@x.com")
        self.unsign(2, "carol@x.com")
        self.assertEqual(self.signed_steps(), [1])

    def test_unsign_unsigned_step_400s(self):
        self.assertHTTPError(400, self.unsign, 1, "alice@x.com",
                             detail_re="not signed")

    def test_sod_judged_against_current_holder_after_resign(self):
        # alice prepared → carol checked; then step 1 is unsigned (clearing
        # step 2 too) and PREP re-signs step 1. Now alice — who originally
        # prepared — may check, because she no longer holds step 1 ...
        self.sign(1, "alice@x.com")
        self.sign(2, "carol@x.com")
        self.unsign(1, "alice@x.com")
        self.assertEqual(self.signed_steps(), [])
        self.sign(1, "prep@x.com")
        self.sign(2, "alice@x.com")
        self.assertEqual(self.signed_steps(), [1, 2])
        # ... and prep@ (the CURRENT step-1 holder) is who step 2 is fenced
        # against: unsign step 2 and prep@ must be blocked from checking.
        self.unsign(2, "alice@x.com")
        p = mock.patch.object(
            fr, "_COSTING_STEP_EMAILS",
            {1: {"alice@x.com", "prep@x.com"},
             2: {"alice@x.com", "carol@x.com", "prep@x.com"},
             3: {"carol@x.com", "boss@x.com"}})
        p.start()
        self.addCleanup(p.stop)
        self.assertHTTPError(403, self.sign, 2, "prep@x.com",
                             detail_re="Separation of duties")

    def test_resign_same_step_by_same_person_is_allowed(self):
        # unsign-then-resign of one's own signature is not an SoD violation
        self.sign(1, "alice@x.com")
        self.unsign(1, "alice@x.com")
        self.sign(1, "alice@x.com")
        self.assertEqual(self.signed_steps(), [1])


if __name__ == "__main__":
    unittest.main()
