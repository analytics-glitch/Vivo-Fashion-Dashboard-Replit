"""Focused ownership tests for the guarded managed Vivo BI starter."""

from __future__ import annotations

import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from scripts import start_vivo_bi_managed as starter
from scripts import vivo_bi_managed_service as managed


class ManagedVivoBiStartTests(unittest.TestCase):
    def common_patches(self):
        return patch.multiple(
            starter,
            acquire_lock=MagicMock(return_value=SimpleNamespace(close=lambda: None)),
            claim_legacy_migration=MagicMock(),
            write_owner=MagicMock(),
            clear_owner_if_owned=MagicMock(),
            legacy_migration_available=MagicMock(return_value=True),
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
            starter, "inspect_legacy_listener", return_value={"verified": False, "reasons": ["legacy proof is incomplete"]}
        ), patch.object(
            starter, "terminate_verified_owner"
        ) as terminate, patch.object(starter, "terminate_verified_legacy_owner") as legacy_terminate, patch.object(
            starter.subprocess, "Popen"
        ) as popen:
            self.assertEqual(starter.main(), 1)
        terminate.assert_not_called()
        legacy_terminate.assert_not_called()
        popen.assert_not_called()

    def test_exact_legacy_owner_is_released_once_before_managed_replacement(self):
        child = SimpleNamespace(pid=72, poll=lambda: 0, wait=lambda: 0)
        legacy_proof = {
            "legacy": True,
            "verified": True,
            "reasons": [],
            "pid": 71,
            "target_identities": {71: "legacy-vite", 70: "legacy-pnpm"},
        }
        with self.common_patches(), patch.object(
            starter, "stable_listener", side_effect=[(71, None), (None, None)]
        ), patch.object(
            starter, "inspect_listener", return_value={"verified": False, "reasons": ["owner record is absent"]}
        ), patch.object(
            starter, "read_owner", return_value=None
        ), patch.object(
            starter, "inspect_legacy_listener", return_value=legacy_proof
        ), patch.object(
            starter, "claim_legacy_migration"
        ) as claim, patch.object(
            starter, "legacy_migration_available", return_value=True
        ), patch.object(
            starter, "terminate_verified_legacy_owner"
        ) as terminate, patch.object(
            starter, "terminate_verified_owner"
        ) as marked_terminate, patch.object(
            starter.subprocess, "Popen", return_value=child
        ) as popen:
            self.assertEqual(starter.main(), 0)
        claim.assert_called_once_with(legacy_proof)
        terminate.assert_called_once_with(71, legacy_proof)
        marked_terminate.assert_not_called()
        self.assertEqual(
            popen.call_args.args[0],
            ["pnpm", "--filter", "@workspace/vivo-bi", "run", "dev"],
        )

    def test_partial_or_unrelated_legacy_listener_is_not_signalled(self):
        for reasons in (
            ["legacy pnpm-to-Vite ancestry is incomplete or ambiguous"],
            ["listener cwd is /tmp, expected workspace artifact"],
            ["listener command is not the exact legacy Vivo BI Vite process"],
        ):
            with self.subTest(reasons=reasons), self.common_patches(), patch.object(
                starter, "stable_listener", return_value=(71, None)
            ), patch.object(
                starter, "inspect_listener", return_value={"verified": False, "reasons": ["owner record is absent"]}
            ), patch.object(
                starter, "read_owner", return_value=None
            ), patch.object(
                starter, "inspect_legacy_listener", return_value={"legacy": True, "verified": False, "reasons": reasons}
            ), patch.object(
                starter, "terminate_verified_legacy_owner"
            ) as terminate, patch.object(
                starter.subprocess, "Popen"
            ) as popen:
                self.assertEqual(starter.main(), 1)
            terminate.assert_not_called()
            popen.assert_not_called()

    def test_claimed_legacy_migration_cannot_adopt_another_unmarked_listener(self):
        with self.common_patches(), patch.object(
            starter, "stable_listener", return_value=(71, None)
        ), patch.object(
            starter, "inspect_listener", return_value={"verified": False, "reasons": ["owner record is absent"]}
        ), patch.object(
            starter, "read_owner", return_value=None
        ), patch.object(
            starter, "legacy_migration_available", return_value=False
        ), patch.object(
            starter, "inspect_legacy_listener"
        ) as inspect_legacy, patch.object(
            starter, "claim_legacy_migration"
        ) as claim, patch.object(
            starter, "terminate_verified_legacy_owner"
        ) as terminate, patch.object(
            starter.subprocess, "Popen"
        ) as popen:
            self.assertEqual(starter.main(), 1)
        inspect_legacy.assert_not_called()
        claim.assert_not_called()
        terminate.assert_not_called()
        popen.assert_not_called()

    def test_legacy_attestation_requires_exact_workspace_parent_chain(self):
        vite_args = (
            f"/nix/node {managed.ARTIFACT_DIR}/node_modules/.bin/../vite/bin/vite.js "
            "--config vite.config.ts --host 0.0.0.0"
        )
        pnpm_args = f"/nix/node /nix/pnpm {managed.WORKFLOW_COMMAND}"
        rows = {71: (70, vite_args), 70: (1, pnpm_args), 1: (0, "pid2")}
        cwd = {71: managed.ARTIFACT_DIR, 70: managed.ARTIFACT_DIR}
        cmdlines = {
            71: [
                "/nix/node",
                str(managed.ARTIFACT_DIR / "node_modules/.bin/../vite/bin/vite.js"),
                "--config",
                "vite.config.ts",
                "--host",
                "0.0.0.0",
            ],
            70: [
                "/nix/node",
                "/nix/pnpm",
                "--filter",
                "@workspace/vivo-bi",
                "run",
                "dev",
            ],
        }
        with patch.object(managed, "stable_listener", return_value=(71, None)), patch.object(
            managed, "process_rows", return_value=rows
        ), patch.object(
            managed, "canonical_pnpm_launcher", return_value=Path("/nix/pnpm")
        ), patch.object(
            managed, "proc_cmdline", side_effect=lambda pid: cmdlines.get(pid, [])
        ), patch.object(
            managed, "proc_cwd", side_effect=lambda pid: cwd.get(pid)
        ), patch.object(
            managed, "proc_exe", return_value=Path("/nix/store/node")
        ), patch.object(
            managed, "proc_environment", return_value={}
        ), patch.object(
            managed, "proc_start_ticks", side_effect=lambda pid: f"ticks-{pid}"
        ):
            proof = managed.inspect_legacy_listener(
                71,
                registration={"available": True, "verified": True, "reasons": []},
            )
        self.assertTrue(proof["verified"], proof["reasons"])
        self.assertEqual(proof["target_identities"], {71: "ticks-71", 70: "ticks-70"})

    def test_legacy_attestation_refuses_similar_or_extended_commands(self):
        vite_args = (
            f"/nix/node {managed.ARTIFACT_DIR}/node_modules/.bin/../vite/bin/vite.js "
            "--config vite.config.ts --host 0.0.0.0"
        )
        pnpm_args = f"/nix/node /nix/pnpm {managed.WORKFLOW_COMMAND}"
        rows = {71: (70, vite_args), 70: (1, pnpm_args), 1: (0, "pid2")}
        cwd = {71: managed.ARTIFACT_DIR, 70: managed.ARTIFACT_DIR}
        base_cmdlines = {
            71: [
                "/nix/node",
                str(managed.ARTIFACT_DIR / "node_modules/.bin/../vite/bin/vite.js"),
                "--config",
                "vite.config.ts",
                "--host",
                "0.0.0.0",
            ],
            70: [
                "/nix/node",
                "/nix/pnpm",
                "--filter",
                "@workspace/vivo-bi",
                "run",
                "dev",
            ],
        }
        variants = (
            {**base_cmdlines, 71: [*base_cmdlines[71], "--unsafe-extra"]},
            {**base_cmdlines, 70: ["/nix/node", "/tmp/wrapper.js", *base_cmdlines[70][2:]]},
            {**base_cmdlines, 70: ["/nix/node", "/tmp/pnpm", *base_cmdlines[70][2:]]},
        )
        for cmdlines in variants:
            with self.subTest(cmdlines=cmdlines), patch.object(
                managed, "stable_listener", return_value=(71, None)
            ), patch.object(
                managed, "process_rows", return_value=rows
            ), patch.object(
                managed, "canonical_pnpm_launcher", return_value=Path("/nix/pnpm")
            ), patch.object(
                managed, "proc_cmdline", side_effect=lambda pid: cmdlines.get(pid, [])
            ), patch.object(
                managed, "proc_cwd", side_effect=lambda pid: cwd.get(pid)
            ), patch.object(
                managed, "proc_exe", return_value=Path("/nix/store/node")
            ), patch.object(
                managed, "proc_environment", return_value={}
            ), patch.object(
                managed, "proc_start_ticks", side_effect=lambda pid: f"ticks-{pid}"
            ):
                proof = managed.inspect_legacy_listener(
                    71,
                    registration={"available": True, "verified": True, "reasons": []},
                )
            self.assertFalse(proof["verified"])
            self.assertTrue(
                any(
                    reason in proof["reasons"]
                    for reason in (
                        "listener command is not the exact legacy Vivo BI Vite process",
                        "legacy pnpm-to-Vite ancestry is incomplete or ambiguous",
                    )
                ),
                proof["reasons"],
            )

    def test_legacy_termination_refuses_identity_change_before_signalling(self):
        proof = {
            "legacy": True,
            "verified": True,
            "start_ticks": "legacy-vite",
            "args": "vite",
            "cwd": str(managed.ARTIFACT_DIR),
            "executable": "/nix/node",
            "pnpm_pid": 70,
            "ancestry": [{"pid": 71, "args": "vite", "start_ticks": "legacy-vite"}],
            "target_identities": {71: "legacy-vite", 70: "legacy-pnpm"},
            "registration": {"available": True, "verified": True, "reasons": []},
        }
        changed = {**proof, "start_ticks": "replacement-vite"}
        with patch.object(managed, "stable_listener", return_value=(71, None)), patch.object(
            managed, "read_owner", return_value=None
        ), patch.object(
            managed, "inspect_legacy_listener", return_value=changed
        ), patch.object(managed.signal, "pidfd_send_signal") as signal_process:
            with self.assertRaisesRegex(RuntimeError, "identity changed before termination"):
                managed.terminate_verified_legacy_owner(71, proof)
        signal_process.assert_not_called()

    def test_legacy_termination_refuses_changed_workflow_registration(self):
        proof = {
            "legacy": True,
            "verified": True,
            "start_ticks": "legacy-vite",
            "args": "vite",
            "cwd": str(managed.ARTIFACT_DIR),
            "executable": "/nix/node",
            "pnpm_pid": 70,
            "ancestry": [{"pid": 71, "args": "vite", "start_ticks": "legacy-vite"}],
            "target_identities": {71: "legacy-vite", 70: "legacy-pnpm"},
            "registration": {"available": True, "verified": True, "checks": {"port": True}, "reasons": []},
        }
        changed = {
            **proof,
            "registration": {
                "available": True,
                "verified": False,
                "checks": {"port": False},
                "reasons": ["artifact registration is missing port"],
            },
        }
        with patch.object(managed, "stable_listener", return_value=(71, None)), patch.object(
            managed, "read_owner", return_value=None
        ), patch.object(
            managed, "inspect_legacy_listener", return_value=changed
        ) as inspect_legacy, patch.object(
            managed.signal, "pidfd_send_signal"
        ) as signal_process:
            with self.assertRaisesRegex(RuntimeError, "identity changed before termination"):
                managed.terminate_verified_legacy_owner(71, proof)
        inspect_legacy.assert_called_once_with(71, check_stability=False)
        signal_process.assert_not_called()

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