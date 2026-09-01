"""Unit coverage for Vivo Johari My Size recommendation rules."""

import unittest

from fastapi import HTTPException

import community_app as ca


class CommunityMySizeTests(unittest.TestCase):
    def test_exact_measurement_rows(self):
        cases = [
            ((33, 25, 37), "XS"),
            ((35, 27, 39), "S"),
            ((37, 29, 41), "M"),
            ((39, 31, 43), "L"),
            ((44, 36, 48), "1X"),
            ((47, 39, 51), "2X"),
            ((50, 42, 54), "3X"),
        ]
        for measurements, expected in cases:
            with self.subTest(measurements=measurements):
                self.assertEqual(
                    ca._recommend_size_from_measurements(*measurements),
                    (expected, False),
                )

    def test_mixed_rows_choose_larger_and_warn(self):
        self.assertEqual(
            ca._recommend_size_from_measurements(37, 29, 43),
            ("L", True),
        )

    def test_overlapping_l_and_1x_bust_does_not_force_larger_row(self):
        self.assertEqual(
            ca._recommend_size_from_measurements(40, 32, 44),
            ("L", False),
        )

    def test_measurements_outside_chart_use_nearest_defined_row(self):
        self.assertEqual(
            ca._recommend_size_from_measurements(31, 23, 35),
            ("XS", False),
        )
        self.assertEqual(
            ca._recommend_size_from_measurements(55, 46, 58),
            ("3X", False),
        )

    def test_known_uk_and_us_sizes(self):
        self.assertEqual(ca._recommend_size_from_known("UK", "12–14"), "M")
        self.assertEqual(ca._recommend_size_from_known("US", "8-10"), "M")
        self.assertEqual(ca._recommend_size_from_known("UK", "20"), "1X")

    def test_known_size_rejects_values_outside_chart(self):
        with self.assertRaises(HTTPException) as ctx:
            ca._recommend_size_from_known("US", "22")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_measurement_payload_is_normalised(self):
        profile = ca._clean_size_profile({
            "method": "measurements",
            "bust_in": "37",
            "waist_in": 29,
            "hips_in": 43,
        })
        self.assertEqual(profile["recommended_size"], "L")
        self.assertTrue(profile["size_up"])
        self.assertIsNone(profile["known_size"])

    def test_known_size_payload_is_normalised(self):
        profile = ca._clean_size_profile({
            "method": "known",
            "known_size_system": "us",
            "known_size": "16",
        })
        self.assertEqual(profile["recommended_size"], "1X")
        self.assertEqual(profile["known_size_system"], "US")
        self.assertFalse(profile["size_up"])


if __name__ == "__main__":
    unittest.main()