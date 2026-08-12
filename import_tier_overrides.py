"""
One-time import: load style tier + status overrides from the uploaded Excel sheet
and classify all other active Odoo styles as Archived.

Run:  python3 import_tier_overrides.py
"""
import os, sys
import openpyxl
import psycopg2
import psycopg2.extras

EXCEL_PATH = "attached_assets/Product_Status_12_Aug_2026_1786516175744.xlsx"

TIER_MAP = {
    "TIER 1": "Tier 1",
    "TIER 2": "Tier 2",
    "TIER 3": "Tier 3",
    "TIER 4": "Tier 4",
    "RETIRED": "Retired",
    "SAMPLE":  "Tier 4",   # single outlier — treat as newest active tier
}

def tier_to_status(tier: str) -> str:
    if tier == "Retired":
        return "Retired"
    if tier == "Archived":
        return "Archived"
    return "Active"

def main():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        sys.exit("DATABASE_URL not set")

    # ── Read spreadsheet ────────────────────────────────────────────────────
    wb = openpyxl.load_workbook(EXCEL_PATH)
    ws = wb.active
    rows = list(ws.iter_rows(min_row=2, values_only=True))

    sheet_rows = []
    for r in rows:
        snum = str(r[0]).strip() if r[0] else ""
        raw_tier = str(r[1]).strip().upper() if r[1] else ""
        tier = TIER_MAP.get(raw_tier)
        if not snum or not tier:
            print(f"  SKIP: bad row {r}")
            continue
        sheet_rows.append((snum, tier, tier_to_status(tier)))

    print(f"Spreadsheet: {len(sheet_rows)} valid rows")
    sheet_nums = {r[0] for r in sheet_rows}

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # ── Create table ────────────────────────────────────────────────────────
    cur.execute("""
        CREATE TABLE IF NOT EXISTS style_tier_overrides (
            style_number  TEXT PRIMARY KEY,
            tier          TEXT NOT NULL,
            status        TEXT NOT NULL,
            imported_at   TIMESTAMPTZ DEFAULT NOW()
        )
    """)

    # ── Truncate and re-import (idempotent) ─────────────────────────────────
    cur.execute("TRUNCATE style_tier_overrides")

    # ── Insert the 1,240 from the sheet ─────────────────────────────────────
    psycopg2.extras.execute_values(cur, """
        INSERT INTO style_tier_overrides (style_number, tier, status)
        VALUES %s
    """, sheet_rows)
    print(f"Inserted {len(sheet_rows)} rows from spreadsheet")

    # ── Find all active Odoo styles NOT in the sheet → Archived ─────────────
    # style_number derived same way as merch_router: mode() within group
    cur.execute("""
        SELECT
            mode() WITHIN GROUP (ORDER BY p.style_number) AS style_number,
            p.style_name
        FROM all_products_clean p
        WHERE p.style_name IS NOT NULL
          AND p.style_name <> ''
          AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
          AND p.style_number IS NOT NULL
          AND p.style_number <> ''
          AND LOWER(COALESCE(p.status,'active')) = 'active'
        GROUP BY p.style_name
    """)
    all_active = cur.fetchall()

    archived_rows = []
    for row in all_active:
        snum = (row["style_number"] or "").strip()
        if snum and snum not in sheet_nums:
            archived_rows.append((snum, "Archived", "Archived"))

    if archived_rows:
        psycopg2.extras.execute_values(cur, """
            INSERT INTO style_tier_overrides (style_number, tier, status)
            VALUES %s
            ON CONFLICT (style_number) DO NOTHING
        """, archived_rows)
        print(f"Inserted {len(archived_rows)} Archived styles (active in Odoo, not in sheet)")

    conn.commit()

    # ── Summary ─────────────────────────────────────────────────────────────
    cur.execute("""
        SELECT tier, status, COUNT(*) AS n
        FROM style_tier_overrides
        GROUP BY tier, status
        ORDER BY n DESC
    """)
    print("\nFinal override table breakdown:")
    for r in cur.fetchall():
        print(f"  {r['tier']:12s} / {r['status']:8s}  →  {r['n']}")

    cur.close()
    conn.close()
    print("\nDone.")

if __name__ == "__main__":
    main()
