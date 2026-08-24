"""Regression checks for PD Flow boot-time stage persistence."""

import inspect
import unittest
from unittest import mock

import pd_flow_router


class PDFlowStageRecoveryTests(unittest.TestCase):
    def test_excel_bootstrap_never_overwrites_existing_lifecycle_state(self):
        source = inspect.getsource(pd_flow_router.ensure_pd_tables)

        self.assertNotIn('_sets += ["current_stage = %s", "status = %s"]', source)
        self.assertIn("_reconcile_pd_stage_state_from_movements()", source)

    def test_recovery_uses_latest_append_only_movement(self):
        with mock.patch.object(pd_flow_router, "_db", return_value=[{"id": 42}]) as db:
            repaired = pd_flow_router._reconcile_pd_stage_state_from_movements()

        self.assertEqual(repaired, 1)
        query = db.call_args.args[0]
        self.assertIn("SELECT DISTINCT ON (style_id)", query)
        self.assertIn("ORDER BY style_id, created_at DESC, id DESC", query)
        self.assertIn("current_stage = COALESCE(m.to_stage, s.current_stage)", query)
        self.assertIn("m.direction = 'approve'", query)
        self.assertIn("RETURNING s.id", query)


if __name__ == "__main__":
    unittest.main()