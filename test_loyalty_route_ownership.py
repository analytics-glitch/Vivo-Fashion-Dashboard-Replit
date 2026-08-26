"""Regression coverage for the API-owned loyalty entry point."""

from __future__ import annotations

import pathlib
import tomllib
import unittest

from fastapi.testclient import TestClient

import api_pg


WORKSPACE = pathlib.Path(__file__).resolve().parent
API_MANIFEST = WORKSPACE / "artifacts" / "api-server" / ".replit-artifact" / "artifact.toml"


class LoyaltyRouteOwnershipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(api_pg.app, raise_server_exceptions=False)

    def test_api_is_the_only_loyalty_route_owner(self) -> None:
        owners: list[pathlib.Path] = []
        for manifest in (WORKSPACE / "artifacts").glob("*/.replit-artifact/artifact.toml"):
            config = tomllib.loads(manifest.read_text(encoding="utf-8"))
            for service in config.get("services", []):
                if any(
                    path.rstrip("/") == "/loyalty-app"
                    or path.startswith("/loyalty-app/")
                    for path in service.get("paths", [])
                ):
                    owners.append(manifest)

        self.assertEqual(
            owners,
            [API_MANIFEST],
            "Only the API service may claim the public /loyalty-app route.",
        )

    def test_loyalty_entry_and_health_contract(self) -> None:
        redirect = self.client.get("/loyalty-app", follow_redirects=False)
        self.assertEqual(redirect.status_code, 301)
        self.assertEqual(redirect.headers.get("location"), "/loyalty-app/")

        page = self.client.get("/loyalty-app/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("text/html", page.headers.get("content-type", "").lower())
        self.assertIn("loyalty.vivofashionbrands.com", page.text)

        health = self.client.get("/loyalty-app/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json(), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()