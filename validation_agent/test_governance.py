"""Unit tests for the governance fence (governance.decide + apply_fix safety).

Locks in the fence rules:
  * red vs amber severity for structural / material / immaterial exceptions,
  * escalate-by-default when no fix patterns are registered (the fence is
    closed until an operator enables a pattern),
  * auto_fix ONLY when pattern match + DATA_ERROR + below-materiality all hold,
  * REAL_BUSINESS_EVENT learned_range findings auto-resolve (amber),
  * apply_fix rejects fixes with forbidden verbs (DELETE/DROP/TRUNCATE/...),
    multiple statements (";"), non-UPDATE statements, and fixes that do not
    reference an allowlisted target table.

All fixtures are synthetic dicts -- no database is touched.
"""
import unittest
from unittest.mock import patch

from validation_agent import config, governance


def _exc(check_code="net_composition", classification="DATA_ERROR",
         materiality=1_000.0, **extra) -> dict:
    e = {"check_code": check_code, "materiality_kes": materiality,
         "diagnosis": {"classification": classification}}
    e.update(extra)
    return e


class DecideSeverityAndAction(unittest.TestCase):

    def setUp(self):
        # The fence must be tested closed: no registered patterns.
        self.assertEqual(governance.FIX_PATTERNS, {})

    def test_default_is_escalate_with_no_patterns(self):
        d = governance.decide(_exc())
        self.assertEqual(d["action"], "escalate")
        self.assertFalse(d["auto_fixable"])
        self.assertIsNone(d["matched_pattern"])

    def test_structural_exception_is_red(self):
        d = governance.decide(_exc(check_code="net_le_total"))
        self.assertEqual(d["severity"], "red")
        self.assertEqual(d["action"], "escalate")

    def test_material_exception_is_red(self):
        d = governance.decide(_exc(materiality=config.MATERIALITY_KES + 1))
        self.assertEqual(d["severity"], "red")
        self.assertFalse(d["below_threshold"])

    def test_immaterial_nonstructural_is_amber(self):
        d = governance.decide(_exc(materiality=config.MATERIALITY_KES - 1))
        self.assertEqual(d["severity"], "amber")
        self.assertEqual(d["action"], "escalate")

    def test_real_business_event_material_is_red(self):
        d = governance.decide(_exc(classification="REAL_BUSINESS_EVENT",
                                   materiality=config.MATERIALITY_KES + 1))
        self.assertEqual(d["severity"], "red")

    def test_real_business_event_immaterial_is_amber(self):
        d = governance.decide(_exc(classification="REAL_BUSINESS_EVENT",
                                   materiality=100.0))
        self.assertEqual(d["severity"], "amber")

    def test_real_business_event_learned_range_auto_resolves(self):
        # A range finding on a legitimate busy day auto-resolves regardless of
        # materiality -- it is a fact about trading, not a defect.
        d = governance.decide(_exc(check_code="learned_range",
                                   classification="REAL_BUSINESS_EVENT",
                                   materiality=config.MATERIALITY_KES * 10))
        self.assertEqual(d["action"], "auto_resolve")
        self.assertEqual(d["severity"], "amber")
        self.assertFalse(d["auto_fixable"])

    def test_data_error_learned_range_does_not_auto_resolve(self):
        d = governance.decide(_exc(check_code="learned_range",
                                   classification="DATA_ERROR"))
        self.assertEqual(d["action"], "escalate")

    def test_informational_auto_resolves(self):
        d = governance.decide({"check_code": "low_volume",
                               "informational": True, "materiality_kes": 0.0})
        self.assertEqual(d["action"], "auto_resolve")
        self.assertEqual(d["severity"], "amber")


class DecideAutoFixGate(unittest.TestCase):
    """auto_fix requires ALL of: matched pattern + DATA_ERROR + below threshold."""

    PATTERNS = {"p1": {"matcher": lambda exc, diag: True,
                       "builder": lambda exc: ("UPDATE all_sales SET x=%s", (1,)),
                       "targets": {"all_sales"}}}

    def _decide(self, **kw):
        with patch.dict(governance.FIX_PATTERNS, self.PATTERNS, clear=True):
            return governance.decide(_exc(**kw))

    def test_all_three_hold_auto_fix(self):
        d = self._decide(classification="DATA_ERROR", materiality=1_000.0)
        self.assertEqual(d["action"], "auto_fix")
        self.assertTrue(d["auto_fixable"])
        self.assertEqual(d["matched_pattern"], "p1")
        self.assertEqual(d["severity"], "amber")

    def test_not_data_error_no_auto_fix(self):
        d = self._decide(classification="REAL_BUSINESS_EVENT",
                         materiality=1_000.0)
        self.assertNotEqual(d["action"], "auto_fix")

    def test_at_or_above_threshold_no_auto_fix(self):
        d = self._decide(classification="DATA_ERROR",
                         materiality=config.MATERIALITY_KES)
        self.assertNotEqual(d["action"], "auto_fix")
        self.assertEqual(d["action"], "escalate")

    def test_no_matching_pattern_no_auto_fix(self):
        patterns = {"p1": {**self.PATTERNS["p1"],
                           "matcher": lambda exc, diag: False}}
        with patch.dict(governance.FIX_PATTERNS, patterns, clear=True):
            d = governance.decide(_exc(classification="DATA_ERROR",
                                       materiality=1_000.0))
        self.assertEqual(d["action"], "escalate")

    def test_matcher_exception_treated_as_no_match(self):
        def boom(exc, diag):
            raise RuntimeError("matcher blew up")
        patterns = {"p1": {**self.PATTERNS["p1"], "matcher": boom}}
        with patch.dict(governance.FIX_PATTERNS, patterns, clear=True):
            d = governance.decide(_exc(classification="DATA_ERROR",
                                       materiality=1_000.0))
        self.assertEqual(d["action"], "escalate")


class FixSafetyFence(unittest.TestCase):
    """_fix_is_safe / apply_fix must reject anything irreversible or off-target."""

    TARGETS = {"all_sales"}

    def _safe(self, sql):
        return governance._fix_is_safe(sql, self.TARGETS)

    def test_reversible_update_on_target_passes(self):
        ok, reason = self._safe(
            "UPDATE all_sales SET net_sales = %s WHERE id = %s")
        self.assertTrue(ok, reason)

    def test_delete_rejected(self):
        ok, _ = self._safe("DELETE FROM all_sales WHERE id = %s")
        self.assertFalse(ok)

    def test_drop_rejected_even_inside_update(self):
        ok, _ = self._safe("UPDATE all_sales SET x = 1; DROP TABLE all_sales")
        self.assertFalse(ok)

    def test_truncate_rejected(self):
        ok, _ = self._safe("TRUNCATE all_sales")
        self.assertFalse(ok)

    def test_insert_rejected(self):
        ok, _ = self._safe("INSERT INTO all_sales VALUES (1)")
        self.assertFalse(ok)

    def test_multiple_statements_rejected(self):
        ok, reason = self._safe(
            "UPDATE all_sales SET x = 1; UPDATE all_sales SET y = 2")
        self.assertFalse(ok)

    def test_trailing_semicolon_alone_is_allowed(self):
        ok, reason = self._safe("UPDATE all_sales SET net_sales = %s WHERE id = %s;")
        self.assertTrue(ok, reason)

    def test_non_allowlisted_table_rejected(self):
        ok, reason = self._safe("UPDATE app_users SET role = 'admin'")
        self.assertFalse(ok)
        self.assertIn("allowlisted", reason)

    def test_apply_fix_rejects_unsafe_sql_without_touching_db(self):
        patterns = {"bad": {
            "matcher": lambda exc, diag: True,
            "builder": lambda exc: ("DELETE FROM all_sales WHERE id = %s", (1,)),
            "targets": {"all_sales"},
        }}
        with patch.dict(governance.FIX_PATTERNS, patterns, clear=True):
            res = governance.apply_fix(conn=None, exc=_exc(), pattern_code="bad")
        self.assertFalse(res["applied"])
        self.assertIn("fence rejected fix", res["reason"])

    def test_apply_fix_rejects_off_target_update_without_touching_db(self):
        patterns = {"offtarget": {
            "matcher": lambda exc, diag: True,
            "builder": lambda exc: ("UPDATE app_users SET role = %s", ("admin",)),
            "targets": {"all_sales"},
        }}
        with patch.dict(governance.FIX_PATTERNS, patterns, clear=True):
            res = governance.apply_fix(conn=None, exc=_exc(),
                                       pattern_code="offtarget")
        self.assertFalse(res["applied"])
        self.assertIn("fence rejected fix", res["reason"])

    def test_apply_fix_unknown_pattern(self):
        with patch.dict(governance.FIX_PATTERNS, {}, clear=True):
            res = governance.apply_fix(conn=None, exc=_exc(),
                                       pattern_code="nope")
        self.assertFalse(res["applied"])
        self.assertEqual(res["reason"], "unknown pattern")


if __name__ == "__main__":
    unittest.main()
