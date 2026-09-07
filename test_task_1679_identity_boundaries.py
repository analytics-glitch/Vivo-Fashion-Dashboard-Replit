"""Unit coverage for task 1679 identity-boundary behavior.

These tests deliberately use cursors/modules faked at the narrow helper
boundary.  They need no database URL and, in particular, never select a
production DATABASE_URL.
"""

import unittest
from unittest.mock import patch

from fastapi import HTTPException

import community_app
import crm_clienteling


class _MemberCursor:
    """Small dict-cursor fake for canonical-link and session helpers."""

    def __init__(self, canonical_result):
        self.canonical_result = canonical_result
        self.calls = []
        self.sessions = {}
        self._row = None

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        if "FROM customer_identity ci" in sql:
            self._row = self.canonical_result
        elif "INSERT INTO community_sessions" in sql:
            token_hash, member_id, phone, purpose, _ttl = params
            self.sessions[(token_hash, purpose)] = {
                "token_hash": token_hash, "member_id": member_id, "phone": phone,
            }
            self._row = None
        elif "FROM community_sessions" in sql:
            self._row = self.sessions.get((params[0], params[1]))
        else:
            self._row = None

    def fetchone(self):
        return self._row


class CommunityCanonicalLinkBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.old_cache = dict(community_app._me_cache)
        community_app._me_cache.clear()

    def tearDown(self):
        community_app._me_cache.clear()
        community_app._me_cache.update(self.old_cache)

    def test_two_member_accounts_and_sessions_can_share_one_person(self):
        cur = _MemberCursor({"person_ids": [901], "unsafe": False})
        first = {"id": 41, "phone": "254700000001",
                 "canonical_person_id": None, "canonical_link_status": "pending"}
        second = {"id": 42, "phone": "254700000001",
                  "canonical_person_id": None, "canonical_link_status": "pending"}

        linked_first = community_app._resolve_member_person_link(cur, first)
        linked_second = community_app._resolve_member_person_link(cur, second)
        token_first = community_app._new_session(cur, first["phone"], first["id"])
        token_second = community_app._new_session(cur, second["phone"], second["id"])

        self.assertEqual(
            (linked_first["canonical_person_id"], linked_second["canonical_person_id"]),
            (901, 901),
        )
        self.assertEqual(
            (linked_first["canonical_link_status"], linked_second["canonical_link_status"]),
            ("linked", "linked"),
        )
        # Authentication/account principals remain member-specific even where
        # their analytics person is shared.
        self.assertNotEqual(token_first, token_second)
        self.assertEqual(community_app._session_for(cur, token_first)["member_id"], 41)
        self.assertEqual(community_app._session_for(cur, token_second)["member_id"], 42)
        self.assertNotEqual(community_app._member_barcode(41),
                            community_app._member_barcode(42))

        member_updates = [
            params for sql, params in cur.calls
            if "UPDATE community_members" in sql
        ]
        self.assertEqual([params[-1] for params in member_updates], [41, 42])

    def test_shared_or_ambiguous_phone_is_not_linked_and_is_audited(self):
        cur = _MemberCursor({"person_ids": [901, 902], "unsafe": False})
        member = {"id": 43, "phone": "254700000099",
                  "canonical_person_id": None, "canonical_link_status": "pending"}

        resolved = community_app._resolve_member_person_link(cur, member)

        self.assertIsNone(resolved["canonical_person_id"])
        self.assertEqual(resolved["canonical_link_status"], "ambiguous")
        self.assertEqual(resolved["canonical_link_method"], "ambiguous_phone")
        audit_params = [
            params for sql, params in cur.calls
            if "community_member_person_link_audit" in sql
        ]
        self.assertEqual(len(audit_params), 1)
        self.assertEqual(audit_params[0][0], 43)
        self.assertEqual(audit_params[0][4:7],
                         ("ambiguous", "ambiguous_phone", "ambiguous_phone"))


class _IdentityModule:
    def __init__(self, people_by_legacy_id):
        self.people_by_legacy_id = people_by_legacy_id

    def _users_exec(self, sql, params=None, fetch=False):
        if "SELECT DISTINCT person_id FROM customer_identity" in sql:
            return [{"person_id": pid} for pid in self.people_by_legacy_id.get(params[0], [])]
        raise AssertionError("Unexpected CRM identity query: " + sql)


class CrmLegacyAliasFallbackTest(unittest.TestCase):
    def test_unique_legacy_alias_resolves_but_colliding_alias_fails_closed(self):
        fake_api = _IdentityModule({"unique-old-id": [700], "colliding-old-id": [700, 701]})
        with patch.object(crm_clienteling, "A", fake_api):
            unique = crm_clienteling._person_ref("unique-old-id", required=True)
            colliding_optional = crm_clienteling._person_ref("colliding-old-id")
            with self.assertRaises(HTTPException) as error:
                crm_clienteling._person_ref("colliding-old-id", required=True)

        self.assertEqual(unique["person_id"], 700)
        self.assertEqual(unique["ref"], "person:700")
        self.assertEqual(unique["legacy_ids"], ["unique-old-id"])
        self.assertIsNone(colliding_optional)
        self.assertEqual(error.exception.status_code, 409)
        self.assertIn("Ambiguous legacy customer ID", error.exception.detail)


if __name__ == "__main__":
    unittest.main()