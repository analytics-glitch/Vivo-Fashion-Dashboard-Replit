"""Focused ownership tests for the guarded managed Vivo BI starter."""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from scripts import start_vivo_bi_managed as starter
from scripts import vivo_bi_managed_service as managed


class ManagedVivoBiStartTests(unittest.TestCase):
    def common_patches(self):
        return patch.multiple(
            starter,
            acquire_lock=MagicMock(return_value=SimpleNamespace(close=lambda: None)),
            write_owner=MagicMock(),
            clear_owner_if_owned=MagicMock(),
            proc_start_ticks=MagicMock(return_value="123"),
            listener_pids=MagicMock(return_value=[]),
        )

    def test_clean_start_spawns_only_the_managed_pnpm_chain(self):
        child = SimpleNamespace(pid=71, poll=lambda: 0, wait=lambda: 0)
        with self.common_patches(), patch.object(starter, "stable_listener", return_value=(None, None)), patch.object(
            starter.subprocess, "Popen", return_value=child
        ) as popen:
            self.assertEqual(starter.main(), 0)
        self.assertEqual(popen.call_args.args[0], ["pnpm", "--filter", "@workspace/vivo-bi", "run", "dev"])

    def test_healthy_managed_owner_is_adopted_without_a_second_start(self):
        with self.common_patches(), patch.object(starter, "stable_listener", return_value=(71, None)), patch.object(
            starter, "inspect_listener", return_value={"verified": True}
        ), patch.object(starter.subprocess, "Popen") as popen:
            self.assertEqual(starter.main(), 0)
        popen.assert_not_called()

    def test_proven_stale_owner_is_released_before_replacement(self):
        child = SimpleNamespace(pid=72, poll=lambda: 0, wait=lambda: 0)
        inspections = [
            {"verified": False, "reasons": ["owner wrapper is no longer the recorded process"]},
            {"verified": True, "reasons": []},
        ]
        with self.common_patches(), patch.object(
            starter, "stable_listener", side_effect=[(71, None), (None, None), (None, None)]
        ), patch.object(starter, "read_owner", return_value={"listener_pid": 71}), patch.object(
            starter, "inspect_listener", side_effect=inspections
        ), patch.object(starter, "terminate_verified_owner") as terminate, patch.object(
            starter.subprocess, "Popen", return_value=child
        ):
            self.assertEqual(starter.main(), 0)
        terminate.assert_called_once_with(71, inspections[1])

    def test_unproven_listener_is_refused_without_termination(self):
        with self.common_patches(), patch.object(starter, "stable_listener", return_value=(71, None)), patch.object(
            starter, "inspect_listener", return_value={"verified": False, "reasons": ["identity metadata is absent"]}
        ), patch.object(starter, "read_owner", return_value=None), patch.object(
            starter, "terminate_verified_owner"
        ) as terminate, patch.object(starter.subprocess, "Popen") as popen:
            self.assertEqual(starter.main(), 1)
        terminate.assert_not_called()
        popen.assert_not_called()

    def test_termination_refuses_a_listener_identity_change_before_signalling(self):
        owner = {
            "listener_pid": 71,
            "listener_start_ticks": "old",
            "run_id": "old-run",
            "child_pid": 70,
            "wrapper_pid": 69,
            "wrapper_start_ticks": "old-wrapper",
        }
        stale_proof = {
            "verified": True,
            "pid": 71,
            "start_ticks": "old",
            "owner": owner,
            "ancestry": [{"pid": 71, "args": f"vite {managed.ARTIFACT_DIR}", "start_ticks": "old"}],
        }
        changed = {**stale_proof, "start_ticks": "replacement"}
        with patch.object(managed, "read_owner", return_value=owner), patch.object(
            managed, "inspect_listener", return_value=changed
        ), patch.object(managed.signal, "pidfd_send_signal") as signal_process:
            with self.assertRaisesRegex(RuntimeError, "changed before termination"):
                managed.terminate_verified_owner(71, stale_proof)
        signal_process.assert_not_called()


if __name__ == "__main__":
    unittest.main()