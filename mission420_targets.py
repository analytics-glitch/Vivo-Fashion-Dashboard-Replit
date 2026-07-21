#!/usr/bin/env python3
"""Upsert Mission 420 Q3 2026 regional targets into targets_monthly.

Distributes each Q3 total across Jul/Aug/Sep weighted by calendar days
(31 / 31 / 30 = 92 total) so the quarter-scorecard sum reconciles exactly.

Run:  python3 mission420_targets.py
"""
import os, sys
from datetime import date
import psycopg2

MISSION_420 = {
    "Kenya - Retail": 335_000_000,
    "Rwanda":          12_000_000,
    "Uganda":          31_000_000,
    "Kenya - Online":  42_000_000,
}
REGION_COUNTRY = {
    "Kenya - Retail": "Kenya",
    "Rwanda": "Rwanda",
    "Uganda": "Uganda",
    "Kenya - Online": "Online",
}
# Q3 2026: July (31d) + August (31d) + September (30d) = 92 days
MONTHLY_DAYS = {7: 31, 8: 31, 9: 30}
TOTAL_DAYS = sum(MONTHLY_DAYS.values())

UPSERT = (
    "INSERT INTO targets_monthly (scope, name, country, month, target_kes, source) "
    "VALUES (%s,%s,%s,%s,%s,'budget') "
    "ON CONFLICT (scope, name, month, source) DO UPDATE SET "
    "target_kes = EXCLUDED.target_kes, updated_at = now()"
)


def main():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    cur = conn.cursor()

    n = 0
    for bucket, q3_total in MISSION_420.items():
        for month_num, days in MONTHLY_DAYS.items():
            val = round(q3_total * days / TOTAL_DAYS)
            cur.execute(UPSERT, (
                "region", bucket, REGION_COUNTRY[bucket],
                date(2026, month_num, 1), val,
            ))
            n += 1

    conn.commit()
    print(f"Upserted {n} Mission 420 target rows.")

    cur.execute(
        "SELECT name, SUM(target_kes) FROM targets_monthly "
        "WHERE scope='region' AND source='budget' "
        "AND month BETWEEN '2026-07-01' AND '2026-09-30' "
        "GROUP BY name ORDER BY name"
    )
    grand = 0
    print("\nQ3 2026 regional targets (Jul + Aug + Sep):")
    for name, tot in cur.fetchall():
        m = float(tot) / 1_000_000
        grand += float(tot)
        print(f"  {name:20s}  {m:6.1f}M")
    print(f"  {'TOTAL':20s}  {grand/1_000_000:6.1f}M  ← mission target")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
