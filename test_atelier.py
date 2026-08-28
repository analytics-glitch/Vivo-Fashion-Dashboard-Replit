import pathlib
import unittest
from unittest import mock

import atelier


class AtelierPureTests(unittest.TestCase):
    def test_phone_normalization(self):
        expected = "+254712345678"
        for value in ("0712345678", "712345678", "+254 712 345 678", "00254-712345678"):
            self.assertEqual(atelier.normalize_kenyan_phone(value), expected)

    def test_phone_rejects_non_kenyan_or_landline(self):
        for value in ("", "123", "+256712345678", "0201234567"):
            with self.assertRaises(ValueError):
                atelier.normalize_kenyan_phone(value)

    def test_status_transitions(self):
        self.assertTrue(atelier.validate_status_transition("intake", "in_progress"))
        with self.assertRaises(ValueError):
            atelier.validate_status_transition("intake", "collected")
        with self.assertRaises(ValueError):
            atelier.validate_status_transition("ready", "ready")

    def test_measurement_validation(self):
        name, value, unit = atelier.validate_measurement("Waist", "72.5", "cm")
        self.assertEqual((name, str(value), unit), ("Waist", "72.5", "cm"))
        for value in (0, -1, 1001, "nan", "bad"):
            with self.assertRaises(ValueError):
                atelier.validate_measurement("Waist", value)


class AtelierContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = pathlib.Path("atelier.py").read_text(encoding="utf-8")
        cls.api_source = pathlib.Path("api_pg.py").read_text(encoding="utf-8")

    def test_registered_before_static_catchall(self):
        registration = self.api_source.index("atelier.register_atelier_routes")
        catchall = self.api_source.index("from fastapi.staticfiles import StaticFiles")
        self.assertLess(registration, catchall)

    def test_customer_master_not_duplicated(self):
        self.assertNotIn("CREATE TABLE IF NOT EXISTS atelier_customers", self.source)
        self.assertIn("INSERT INTO all_customers", self.source)

    def test_audit_and_financial_contracts(self):
        self.assertIn("CREATE TABLE IF NOT EXISTS atelier_status_history", self.source)
        self.assertIn("CREATE TABLE IF NOT EXISTS atelier_measurements", self.source)
        self.assertIn("CREATE TABLE IF NOT EXISTS atelier_customer_measurements", self.source)
        self.assertIn("/api/atelier/customers/{customer_id}/measurements", self.source)
        self.assertIn("/api/atelier/admin/financial-report", self.source)
        self.assertIn("_staff(request, admin=True)", self.source)

    def test_frontend_configuration_and_operations_contracts(self):
        self.assertIn('"branches":', self.source)
        self.assertIn('"alteration_types":', self.source)
        self.assertIn('"authorization":', self.source)
        self.assertIn("/api/atelier/admin/branches", self.source)
        self.assertIn("/api/atelier/admin/alteration-types", self.source)
        self.assertIn("/api/atelier/reports/operations", self.source)

    def test_june_policy_resource_and_version_contract(self):
        policy = pathlib.Path("atelier_policy_june_2026.txt").read_text(encoding="utf-8")
        self.assertIn("1.  PURPOSE", policy)
        self.assertIn("The Junction store is the initial pilot location", policy)
        self.assertIn("Maximillia Kubochi", self.source)
        self.assertIn("CREATE TABLE IF NOT EXISTS atelier_policy_versions", self.source)
        self.assertIn("POLICY_TEXT", self.source)
        self.assertIn("INSERT INTO atelier_policy_versions", self.source)
        self.assertIn("/api/atelier/admin/policies/{key}/history", self.source)

    def test_policy_alteration_type_seed_and_zero_pricing_contract(self):
        for code in ("hemming", "sleeve_shortening", "waist_adjustment", "tapering", "minor_repairs"):
            self.assertIn("'" + code + "'", self.source)
        self.assertIn("pricing_active BOOLEAN NOT NULL DEFAULT FALSE", self.source)

    def test_staff_entitlement_and_admin_listing_contract(self):
        self.assertIn("def atelier_user_enabled(user_id, role)", self.source)
        self.assertIn("except Exception:\n        return False", self.source)
        self.assertIn("@app.get(\"/api/atelier/admin/staff\")", self.source)
        self.assertIn("atelier_enabled", self.source)
        self.assertIn("atelier.atelier_user_enabled", self.api_source)
        self.assertIn('u["atelier_enabled"]', self.api_source)

    def test_final_review_privacy_and_historical_contracts(self):
        self.assertIn("A.mask_pii_rows", self.source)
        self.assertIn('phones=("customer_phone",)', self.source)
        self.assertIn("historical_customer_name", self.source)
        self.assertIn("historical_phone", self.source)
        self.assertIn("condition_notes", self.source)
        self.assertIn("alteration_type_id", self.source)
        self.assertIn("uq_atelier_jobs_source", self.source)
        self.assertIn('u["atelier_admin"]', self.api_source)
        self.assertIn("SELECT value FROM atelier_config WHERE key='ticket'", self.source)
        self.assertIn("store_id: str = None", self.source)
        settings = pathlib.Path(
            "artifacts/vivo-crm/src/pages/AtelierSettings.jsx"
        ).read_text(encoding="utf-8")
        dashboard = pathlib.Path(
            "artifacts/vivo-crm/src/pages/AtelierDashboard.jsx"
        ).read_text(encoding="utf-8")
        self.assertIn("ph.data.versions", settings)
        self.assertNotIn('value="inch"', dashboard)

    def test_safe_image_and_pricing_contracts(self):
        self.assertIn("ImageOps.exif_transpose", self.source)
        self.assertIn("MAX_IMAGE_PIXELS", self.source)
        self.assertIn("image.thumbnail((2400, 2400)", self.source)
        self.assertIn("Pricing is not enabled for Atelier", self.source)

    def test_operations_report_does_not_select_financial_fields(self):
        section = self.source[
            self.source.index('def operations_report('):
            self.source.index('@app.get("/api/atelier/admin/financial-report')
        ]
        self.assertNotIn("service_charge", section)
        self.assertNotIn("amount_paid", section)

    def test_all_sql_placeholders_are_parameter_style(self):
        self.assertNotIn(".format(", self.source)
        self.assertNotIn("customer_id='", self.source)


class AtelierPageAccessTests(unittest.TestCase):
    def test_catalog_and_default_roles(self):
        import api_pg

        self.assertIn("atelier", api_pg.ALL_PAGE_IDS)
        default_roles = {
            role for role, pages in api_pg.DEFAULT_ROLE_PAGES.items()
            if "atelier" in pages
        }
        self.assertEqual(
            default_roles,
            {"leadership", "smt", "customer_service", "retail"},
        )

    def test_effective_page_requires_staff_entitlement(self):
        import api_pg

        denied = {
            "user_id": "not-enabled",
            "role": "leadership",
            "allowed_pages": api_pg._default_pages_for_role("leadership"),
        }
        with mock.patch.object(
            api_pg.atelier, "atelier_user_enabled", return_value=False
        ):
            api_pg._apply_atelier_entitlement(denied)
        self.assertFalse(denied["atelier_enabled"])
        self.assertNotIn("atelier", denied["allowed_pages"])

        enabled = {
            "user_id": "enabled",
            "role": "leadership",
            "allowed_pages": api_pg._default_pages_for_role("leadership"),
        }
        with mock.patch.object(
            api_pg.atelier, "atelier_user_enabled", return_value=True
        ):
            api_pg._apply_atelier_entitlement(enabled)
        self.assertTrue(enabled["atelier_enabled"])
        self.assertIn("atelier", enabled["allowed_pages"])

        admin = {"user_id": "admin", "role": "admin", "allowed_pages": ["atelier"]}
        with mock.patch.object(
            api_pg.atelier,
            "atelier_user_enabled",
            side_effect=RuntimeError("schema unavailable"),
        ):
            api_pg._apply_atelier_entitlement(admin)
        self.assertTrue(admin["atelier_enabled"])
        self.assertTrue(admin["atelier_admin"])
        self.assertIn("atelier", admin["allowed_pages"])

    def test_group_override_remains_an_independent_requirement(self):
        import api_pg

        with mock.patch.object(
            api_pg, "_role_page_overrides", return_value={"leadership": []}
        ):
            pages = api_pg._effective_pages_for_role("leadership")
        user = {"user_id": "enabled", "role": "leadership", "allowed_pages": pages}
        with mock.patch.object(
            api_pg.atelier, "atelier_user_enabled", return_value=True
        ):
            api_pg._apply_atelier_entitlement(user)
        self.assertNotIn("atelier", user["allowed_pages"])

        with mock.patch.object(
            api_pg, "_role_page_overrides", return_value={"warehouse": ["atelier"]}
        ):
            pages = api_pg._effective_pages_for_role("warehouse")
        user = {"user_id": "enabled", "role": "warehouse", "allowed_pages": pages}
        with mock.patch.object(
            api_pg.atelier, "atelier_user_enabled", return_value=True
        ):
            api_pg._apply_atelier_entitlement(user)
        self.assertIn("atelier", user["allowed_pages"])

    def test_bi_guard_and_crm_relocation_contract(self):
        permissions = pathlib.Path(
            "artifacts/vivo-bi/src/lib/permissions.js"
        ).read_text(encoding="utf-8")
        hidden_guard = "hidden.includes(pageId)"
        atelier_guard = 'pageId === "atelier" && !user.atelier_enabled'
        self.assertIn(atelier_guard, permissions)
        self.assertLess(permissions.index(hidden_guard), permissions.index(atelier_guard))

        bi_app = pathlib.Path("artifacts/vivo-bi/src/App.js").read_text(
            encoding="utf-8"
        )
        self.assertIn('path="/atelier/*"', bi_app)
        self.assertNotIn('path="/atelier/jobs/:id"', bi_app)

        for crm_path in (
            "artifacts/vivo-crm/src/App.jsx",
            "artifacts/vivo-crm/src/components/AppShell.jsx",
        ):
            crm_source = pathlib.Path(crm_path).read_text(encoding="utf-8")
            self.assertNotIn('path="/atelier', crm_source)
            self.assertNotIn('to: "/atelier', crm_source)
            self.assertNotIn("@/pages/Atelier", crm_source)

    def test_api_guard_composes_page_grant_and_staff_entitlement(self):
        denied_request = mock.Mock()
        denied_request.state.user = {
            "user_id": "staff-without-page",
            "role": "leadership",
            "status": "active",
            "allowed_pages": [],
        }
        with self.assertRaisesRegex(Exception, "Atelier page access required"):
            atelier._staff(denied_request)

        allowed_request = mock.Mock()
        allowed_request.state.user = {
            "user_id": "staff-with-page",
            "role": "warehouse",
            "status": "active",
            "allowed_pages": ["atelier"],
        }
        with mock.patch.object(
            atelier, "_db", return_value=[{"active": True}]
        ):
            self.assertEqual(
                atelier._staff(allowed_request)["user_id"],
                "staff-with-page",
            )

    def test_bi_does_not_cache_shared_atelier_reads(self):
        api_source = pathlib.Path("artifacts/vivo-bi/src/lib/api.js").read_text(
            encoding="utf-8"
        )
        no_cache = api_source[
            api_source.index("const NO_CACHE_PATHS = ["):
            api_source.index("];", api_source.index("const NO_CACHE_PATHS = ["))
        ]
        self.assertIn('"/atelier/"', no_cache)


if __name__ == "__main__":
    unittest.main()
