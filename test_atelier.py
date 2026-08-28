import pathlib
import unittest

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


if __name__ == "__main__":
    unittest.main()