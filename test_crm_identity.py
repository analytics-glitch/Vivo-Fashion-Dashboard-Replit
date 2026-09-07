"""Focused no-database regression tests for CRM identity boundary helpers."""
import unittest
import inspect
from unittest.mock import patch

import crm_clienteling as crm


class CustomerIdentityResolverTests(unittest.TestCase):
    def test_ambiguous_bare_id_fails_closed(self):
        # A bare Shopify-style ID found on two people must not expose history.
        with patch.object(crm, "_one", return_value=None), \
             patch.object(crm, "_ex", return_value=[{"person_id": 4}, {"person_id": 9}]):
            with self.assertRaises(crm.HTTPException) as raised:
                crm._person_ref("42", required=True)
        self.assertEqual(raised.exception.status_code, 409)

    def test_canonical_history_clause_uses_only_safe_aliases(self):
        with patch.object(crm, "_one", return_value={"person_id": 7}), \
             patch.object(crm, "_ex", return_value=[{"source_customer_id": "safe"}]):
            identity = crm._person_ref("person:7", required=True)
        clause, params = crm._person_owned_clause("i", identity)
        self.assertIn("i.person_id=%s", clause)
        self.assertIn("customer_id = ANY(%s)", clause)
        self.assertEqual(params, [7, ["safe"]])

    def test_source_key_keeps_exact_provenance_on_write(self):
        row = {"person_id": 7, "source_key": "shopify:vivo-uganda:42",
               "source_customer_id": "42"}
        with patch.object(crm, "_one", return_value=row), \
             patch.object(crm, "_ex", return_value=[{"source_customer_id": "42"}]):
            identity = crm._person_ref(row["source_key"], required=True)
        self.assertEqual(identity["source_key"], row["source_key"])
        self.assertEqual(identity["ref"], "person:7")

    def test_colliding_bare_loyalty_id_is_not_considered_an_account(self):
        ident = {"person_id": 7, "ref": "person:7", "source_key": None,
                 "legacy_ids": []}
        aliases = [{"source_key": "shopify:a:42", "source_customer_id": "42"}]
        seen = {}

        def fake_ex(sql, params=None, fetch=False):
            seen["params"] = params
            return []

        with patch.object(crm, "_person_ref", return_value=ident), \
             patch.object(crm, "_person_aliases", return_value=aliases), \
             patch.object(crm, "_safe_legacy_ids", return_value=[]), \
             patch.object(crm, "_ex", side_effect=fake_ex):
            _ident, selected, account, available = crm._loyalty_account_ref("person:7")
        self.assertEqual(seen["params"][1], ["42"])
        self.assertIsNone(selected)
        self.assertIsNone(account)
        self.assertFalse(available[0]["enrolled"])

    def test_same_person_multi_store_legacy_loyalty_id_requires_review(self):
        ident = {"person_id": 7, "ref": "person:7", "source_key": None,
                 "legacy_ids": ["42"]}
        aliases = [
            {"source_key": "shopify:a:42", "source_customer_id": "42"},
            {"source_key": "shopify:b:42", "source_customer_id": "42"},
        ]
        unqualified = [{"customer_id": "42", "source_key": None, "tier": "Gold"}]
        with patch.object(crm, "_person_ref", return_value=ident), \
             patch.object(crm, "_person_aliases", return_value=aliases), \
             patch.object(crm, "_ex", return_value=unqualified):
            with self.assertRaises(crm.HTTPException) as raised:
                crm._loyalty_account_ref(
                    "person:7", {"source_key": "shopify:a:42"}
                )
        self.assertEqual(raised.exception.status_code, 409)

    def test_new_and_reorder_contracts_are_canonical(self):
        source = inspect.getsource(crm._reg_insights)
        for route in ('"/api/insights/new-customers"', '"/api/insights/reorder-candidates"'):
            self.assertIn(route, source)
        self.assertIn("JOIN customer_identity ci ON ci.source_customer_id=s.customer_id::text", source)
        self.assertIn("('person:'||f.person_id)::text customer_id", source)
        self.assertIn("('person:'||c.person_id)::text customer_id", source)
        self.assertIn('_identity_source_key_sql("ci")', source)

    def test_cohort_triangle_reads_person_ids_from_canonical_sales_cte(self):
        source = inspect.getsource(crm._reg_insights)
        cohort = source.split("def _cohort_triangle():", 1)[1].split(
            '@app.get("/api/insights/cohorts/triangle")', 1
        )[0]
        self.assertIn("FROM sales s WHERE s.sale_date", cohort)
        self.assertNotIn("FROM all_sales s WHERE s.sale_date", cohort)

    def test_grid_keeps_city_facets_and_source_alias_search(self):
        grid = inspect.getsource(crm._grid_base)
        matched = inspect.getsource(crm._grid_matched)
        self.assertIn("cities.city", grid)
        self.assertNotIn("NULL::text city", grid)
        self.assertIn('r.get("provenance")', matched)


if __name__ == "__main__":
    unittest.main()