import ast
import unittest
from pathlib import Path


def _load_functions():
    source = Path("api_pg.py").read_text()
    tree = ast.parse(source)
    wanted = {"_norm_style", "_build_odoo_status_sets"}
    nodes = [
        node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted
    ]
    module = ast.Module(body=nodes, type_ignores=[])
    namespace = {"unicodedata": __import__("unicodedata"), "re": __import__("re")}
    exec(compile(module, "api_pg.py", "exec"), namespace)
    return namespace


class ProductStatusSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.ns = _load_functions()

    def test_statuses_are_built_from_one_result_and_active_wins_retired(self):
        rows = [
            {"style_name": "Active A", "has_active": True, "has_retired": False, "has_archived": False},
            {"style_name": "Mixed", "has_active": True, "has_retired": True, "has_archived": False},
            {"style_name": "Retired R", "has_active": False, "has_retired": True, "has_archived": False},
            {"style_name": "Archived Z", "has_active": False, "has_retired": False, "has_archived": True},
        ]
        result = self.ns["_build_odoo_status_sets"](rows)
        self.assertEqual(result["active"], frozenset({"active a", "mixed"}))
        self.assertEqual(result["retired"], frozenset({"retired r"}))
        self.assertEqual(result["archived"], frozenset({"archived z"}))

    def test_zero_status_among_populated_statuses_is_rejected(self):
        rows = [
            {"style_name": "Retired R", "has_active": False, "has_retired": True, "has_archived": False},
            {"style_name": "Archived Z", "has_active": False, "has_retired": False, "has_archived": True},
        ]
        with self.assertRaisesRegex(RuntimeError, "active=0"):
            self.ns["_build_odoo_status_sets"](rows)

    def test_all_empty_statuses_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "all status sets are empty"):
            self.ns["_build_odoo_status_sets"]([])


if __name__ == "__main__":
    unittest.main()