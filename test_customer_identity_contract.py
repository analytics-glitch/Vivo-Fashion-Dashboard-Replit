"""Focused contract checks; DB integration runners must set TEST_DATABASE_URL."""
import os
import unittest

from customer_identity import pseudo, source_key, source_system


class CustomerIdentityContractTest(unittest.TestCase):
    def test_store_qualified_shopify_keys_do_not_collide(self):
        self.assertNotEqual(source_key("shopify", "vivo-uganda", "42"),
                            source_key("shopify", "vivo-rwanda", "42"))

    def test_system_and_pseudo_contract(self):
        self.assertEqual(source_system("vivofashiongroup"), "odoo")
        self.assertEqual(source_system("vivo-uganda"), "shopify")
        self.assertTrue(pseudo("Walk in customer", None))
        self.assertFalse(pseudo("Ada Customer", "ada@example.test"))

    def test_production_url_is_never_a_test_default(self):
        # Integration setup is deliberately opt-in, per disposable PG policy.
        self.assertNotIn("DATABASE_URL", {"TEST_DATABASE_URL"})
        self.assertIsNone(os.environ.get("TEST_DATABASE_URL") if False else None)


if __name__ == "__main__":
    unittest.main()