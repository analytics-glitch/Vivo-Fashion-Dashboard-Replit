import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

import api_pg


def _request(user):
    return SimpleNamespace(state=SimpleNamespace(user=user))


class SopWorkflowRulesTests(unittest.TestCase):
    def test_fixed_stage_and_department_taxonomy(self):
        self.assertEqual(
            [stage["name"] for stage in api_pg.SOP_STAGES],
            [
                "01. SOP Submission",
                "02. SOPs Under Review",
                "03. Approved SOPs (Master Repository)",
                "04. Obsolete SOPs",
            ],
        )
        self.assertEqual(len(api_pg.SOP_DEPARTMENTS), 11)
        self.assertEqual(
            api_pg.SOP_DEPARTMENTS[-1]["name"], "Warehouse & Logistics")

    def test_regular_users_only_access_submission_and_approved(self):
        user = {"role": "retail", "email": "staff@vivofashiongroup.com"}
        self.assertTrue(api_pg._sop_can_access_stage(user, 1))
        self.assertFalse(api_pg._sop_can_access_stage(user, 2))
        self.assertTrue(api_pg._sop_can_access_stage(user, 3))
        self.assertFalse(api_pg._sop_can_access_stage(user, 4))

    def test_named_reviewers_and_approvers(self):
        frankie = {
            "role": "retail",
            "email": "FRANCKIE@VIVOFASHIONGROUP.COM",
        }
        stephen = {
            "role": "leadership",
            "email": "stephen@vivofashiongroup.com",
        }
        self.assertTrue(api_pg._sop_can_access_stage(frankie, 2))
        self.assertTrue(api_pg._sop_can_review(frankie))
        self.assertFalse(api_pg._sop_can_approve(frankie))
        self.assertTrue(api_pg._sop_can_approve(stephen))

    @patch.object(api_pg, "_ensure_sop_tables")
    @patch.object(api_pg, "_users_exec")
    def test_hidden_stage_is_rejected_before_query(self, users_exec, ensure):
        with self.assertRaises(HTTPException) as raised:
            api_pg.sops_files(
                _request({
                    "role": "marketing",
                    "email": "staff@vivofashiongroup.com",
                }),
                stage=2,
                department="marketing",
            )
        self.assertEqual(raised.exception.status_code, 403)
        ensure.assert_not_called()
        users_exec.assert_not_called()

    @patch.object(api_pg, "_log_activity")
    @patch.object(api_pg, "_ensure_sop_tables")
    @patch.object(api_pg, "_users_exec")
    def test_frankie_can_atomically_review_stage_one(
        self, users_exec, ensure, log_activity
    ):
        users_exec.return_value = [{
            "id": 17,
            "filename": "Store opening SOP.pdf",
            "department": "retail-operations",
            "stage": 2,
        }]
        result = api_pg.sops_review(
            17,
            _request({
                "role": "retail",
                "email": "franckie@vivofashiongroup.com",
            }),
        )
        self.assertTrue(result["ok"])
        self.assertIn("WHERE id=%s AND stage=1", users_exec.call_args.args[0])
        log_activity.assert_called_once()

    def test_frankie_cannot_approve(self):
        with self.assertRaises(HTTPException) as raised:
            api_pg.sops_approve(
                17,
                _request({
                    "role": "retail",
                    "email": "franckie@vivofashiongroup.com",
                }),
            )
        self.assertEqual(raised.exception.status_code, 403)

    @patch.object(api_pg, "_log_activity")
    @patch.object(api_pg, "_ensure_sop_tables")
    @patch.object(api_pg, "_sop_user_grants", return_value={"finance"})
    @patch.object(api_pg, "_users_exec")
    def test_submitter_delete_cannot_cross_review_transition(
        self, users_exec, grants, ensure, log_activity
    ):
        users_exec.side_effect = [
            [{
                "id": 17,
                "stage": 1,
                "department": "finance",
                "filename": "Finance SOP.pdf",
            }],
            [],
        ]
        with self.assertRaises(HTTPException) as raised:
            api_pg.sops_delete(
                17,
                _request({
                    "user_id": "submitter-1",
                    "role": "finance",
                    "email": "submitter@vivofashiongroup.com",
                }),
            )
        self.assertEqual(raised.exception.status_code, 409)
        delete_sql = users_exec.call_args_list[1].args[0]
        self.assertIn("stage=1", delete_sql)
        log_activity.assert_not_called()

    @patch.object(api_pg, "_log_activity")
    @patch.object(api_pg, "_ensure_sop_tables")
    @patch.object(api_pg, "_users_exec")
    def test_frankie_can_atomically_retire_approved_sop(
        self, users_exec, ensure, log_activity
    ):
        users_exec.return_value = [{
            "id": 23,
            "filename": "Store opening SOP.pdf",
            "department": "retail-operations",
            "stage": 4,
        }]
        result = api_pg.sops_obsolete(
            23,
            _request({
                "role": "retail",
                "email": "franckie@vivofashiongroup.com",
            }),
        )
        self.assertTrue(result["ok"])
        self.assertIn("WHERE id=%s AND stage=3", users_exec.call_args.args[0])
        self.assertIn("SELECT id, 3, 4", users_exec.call_args.args[0])
        log_activity.assert_called_once()


if __name__ == "__main__":
    unittest.main()