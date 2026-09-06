import unittest
from datetime import date, timedelta

import merch_router


class MerchCoverEligibilityTest(unittest.TestCase):
    def test_requires_six_completed_weeks_and_six_units(self):
        today = date(2026, 9, 6)
        self.assertFalse(
            merch_router._cover_availability(
                today - timedelta(weeks=5), 100, today
            )[0]
        )
        self.assertFalse(
            merch_router._cover_availability(
                today - timedelta(weeks=6), 5, today
            )[0]
        )
        self.assertEqual(
            merch_router._cover_availability(
                today - timedelta(weeks=6), 6, today
            ),
            (True, None),
        )

    def test_unavailable_cover_cannot_trigger_cover_recommendations(self):
        self.assertEqual(
            merch_router._recommend(None, 0, 3.6, 100, 373),
            ("On Track", "on_track"),
        )


if __name__ == "__main__":
    unittest.main()