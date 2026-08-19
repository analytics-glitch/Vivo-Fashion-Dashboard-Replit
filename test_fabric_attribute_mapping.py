"""Focused regression tests for metadata-driven Fabric Odoo attributes."""
import os
import unittest

os.environ.setdefault("ODOO_URL", "https://odoo.test")
os.environ.setdefault("ODOO_DB", "test")
os.environ.setdefault("ODOO_USER", "test")
os.environ.setdefault("ODOO_PASSWORD", "test")
os.environ.setdefault("DATABASE_URL", "postgresql://test")

import extract_fabric as ef


def metadata(ids=None, ambiguous_width=False):
    ids = ids or {
        "width_m": "x_vivo_attr_250",
        "gsm": "x_vivo_attr_380",
        "plain_print": "x_vivo_attr_100",
        "fabric_structure": "x_vivo_attr_101",
        "supplier": "x_vivo_attr_420",
        "primary_color": "x_vivo_attr_480",
        "source_country": "x_vivo_attr_125",
    }
    labels = {
        "width_m": "Width (m)", "gsm": "GSM",
        "plain_print": "Plain/Print", "fabric_structure": "Fabric Structure",
        "supplier": "Vendor/Supplier", "primary_color": "Primary Color",
        "source_country": "Source Country",
    }
    out = {field: {"string": labels[concept], "type": "many2one"}
           for concept, field in ids.items()}
    if ambiguous_width:
        out["x_studio_width"] = {"string": "Width (m)", "type": "many2one"}
    return out


class FabricAttributeMappingTests(unittest.TestCase):
    def test_moved_ids_resolve_by_business_label(self):
        resolved = ef.resolve_fabric_fields(metadata())
        self.assertEqual(resolved["width_m"], "x_vivo_attr_250")
        self.assertEqual(resolved["gsm"], "x_vivo_attr_380")
        self.assertEqual(resolved["supplier"], "x_vivo_attr_420")

    def test_required_mapping_missing_or_ambiguous_fails(self):
        fields = metadata()
        del fields["x_vivo_attr_380"]
        with self.assertRaisesRegex(RuntimeError, "gsm.*missing"):
            ef.resolve_fabric_fields(fields)
        with self.assertRaisesRegex(RuntimeError, "width_m.*ambiguous"):
            ef.resolve_fabric_fields(metadata(ambiguous_width=True))

    def test_many2one_numeric_values_and_optional_fields_are_safe(self):
        record = {
            "x_width": [501, "1.52"],
            "x_gsm": (502, "185"),
            "x_supplier": [503, "Acme Mills"],
        }
        self.assertEqual(ef._fabric_value(record, "x_width", numeric=True), 1.52)
        self.assertEqual(ef._fabric_value(record, "x_gsm", numeric=True), 185.0)
        self.assertEqual(ef._fabric_value(record, "x_supplier"), "Acme Mills")
        self.assertIsNone(ef._fabric_value(record, None))

    def test_property_backed_labels_are_normalized(self):
        props = ef._props_by_label([
            {"string": "Fabric Name", "value": "  Summer Linen "},
            {"string": "Fabric Colour", "value": "Navy"},
        ])
        self.assertEqual(props[ef._label_key("Fabric Name")], "Summer Linen")
        self.assertEqual(props[ef._label_key("Fabric Colour")], "Navy")


if __name__ == "__main__":
    unittest.main()