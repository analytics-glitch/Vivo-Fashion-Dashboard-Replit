"""Pure-function tests for the community Style Quiz: answer sanitising,
completion gating, DNA composition, and the personalisation score SQL.
DB/HTTP behaviour (one-time award, share consent) is covered by the
community smoke script."""
import re
import unittest

import community_app as ca


class QuizCleanTests(unittest.TestCase):
    def test_whitelists_caps_and_dedupe(self):
        a = ca._quiz_clean_answers({
            "styles": ["bold_colourful", "nope", "classic_polished", "relaxed_easy", "modern_minimal"],
            "occasions": ["work", "work", "events", "bogus"],
            "reach_for": "dresses",
            "fit_priorities": ["comfort", "curves", "shaping"],
            "colours": ["jewel", "prints", "nah"],
            "size_range": "m_l",
            "fit_lean": "hacker",
        })
        self.assertEqual(a["styles"], ["bold_colourful", "classic_polished", "relaxed_easy"])
        self.assertEqual(a["occasions"], ["work", "events"])
        self.assertEqual(a["fit_priorities"], ["comfort", "curves"])
        self.assertEqual(a["colours"], ["jewel", "prints"])
        self.assertEqual(a["size_range"], "m_l")
        self.assertEqual(a["fit_lean"], "")  # unknown id dropped, never 500s

    def test_non_dict_payload_is_safe_and_incomplete(self):
        for junk in (None, [], "x", 7):
            a = ca._quiz_clean_answers(junk)
            self.assertFalse(ca._quiz_complete(a))


class QuizDnaTests(unittest.TestCase):
    @staticmethod
    def base():
        return {"styles": ["bold_colourful", "classic_polished"], "occasions": ["events"],
                "reach_for": "both", "fit_priorities": ["comfort"], "colours": ["jewel"],
                "size_range": "", "fit_lean": ""}

    def test_complete_and_compose(self):
        a = self.base()
        self.assertTrue(ca._quiz_complete(a))
        self.assertEqual(ca._compose_style_dna(a),
                         ["Bold & Polished", "Event-Ready", "Comfort-First"])

    def test_single_style_descriptor(self):
        a = self.base()
        a["styles"] = ["print_loving"]
        self.assertEqual(ca._compose_style_dna(a)[0], "Print-Loving")

    def test_member_pick_order_respected(self):
        a = self.base()
        a["occasions"] = ["travel", "events"]
        a["fit_priorities"] = ["curves", "comfort"]
        dna = ca._compose_style_dna(a)
        self.assertEqual(dna[1], "Travel-Light")
        self.assertEqual(dna[2], "Curve-Celebrating")

    def test_private_fields_never_gate_completion(self):
        a = self.base()
        a["size_range"] = ""
        a["fit_lean"] = ""
        self.assertTrue(ca._quiz_complete(a))
        a["colours"] = []
        self.assertFalse(ca._quiz_complete(a))


class QuizScoreSqlTests(unittest.TestCase):
    def test_empty_quiz_scores_zero(self):
        expr = ca._quiz_score_sql({"styles": [], "occasions": [], "reach_for": "",
                                   "fit_priorities": [], "colours": []})
        self.assertEqual(expr, "0")

    def test_expression_shape_and_percent_escaping(self):
        expr = ca._quiz_score_sql({"styles": ["print_loving"], "occasions": ["work"],
                                   "reach_for": "dresses", "fit_priorities": ["comfort"],
                                   "colours": ["jewel", "brights"]})
        self.assertIn("c.category ILIKE '%%dress%%'", expr)
        self.assertIn("CASE WHEN", expr)
        # The route executes with a params dict, so every literal % must be
        # doubled or psycopg2 raises "tuple index out of range".
        self.assertIsNone(re.search(r"(?<!%)%(?!%)", expr))

    def test_unknown_ids_never_reach_sql(self):
        expr = ca._quiz_score_sql({"styles": ["x'); DROP TABLE members;--"],
                                   "occasions": ["hack"], "reach_for": "junk",
                                   "fit_priorities": [], "colours": ["nope"]})
        self.assertEqual(expr, "0")


if __name__ == "__main__":
    unittest.main()
