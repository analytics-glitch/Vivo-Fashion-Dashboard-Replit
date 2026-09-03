import unittest

from merch_router import (
    _product_workspace_cogs,
    _product_workspace_reconciliations,
)


class ProductWorkspaceContractTests(unittest.TestCase):
    def test_cogs_excludes_invalid_rows_and_uses_vat_exclusive_price(self):
        result = _product_workspace_cogs([
            {"units": 2, "unitCost": 58, "sellingPriceVatInclusive": 116},
            {"units": 0, "unitCost": 10, "sellingPriceVatInclusive": 100},
            {"units": 1, "unitCost": "bad", "sellingPriceVatInclusive": 100},
        ])
        self.assertEqual(result["includedRowCount"], 1)
        self.assertEqual(result["excludedRowCount"], 2)
        self.assertAlmostEqual(result["rows"][0]["inputCogs"], 0.58)
        self.assertAlmostEqual(result["blended"], 0.58)

    def test_reconciliation_reports_stock_and_active_count_failures(self):
        styles = [{"style_number": "A", "tier": "Tier 1"}]
        summary = {"active_stock_units": 10, "active_styles_all_count": 2}
        stock_mix = {"totals": {"stock_units": 9}}
        checks = _product_workspace_reconciliations(styles, summary, stock_mix)
        self.assertEqual([c["status"] for c in checks], ["fail", "fail"])
        self.assertEqual(checks[0]["expected"], 10)
        self.assertEqual(checks[0]["actual"], 9)


if __name__ == "__main__":
    unittest.main()