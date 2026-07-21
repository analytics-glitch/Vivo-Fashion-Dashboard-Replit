"""
One-shot import of Q3 2026 PD Tracker Excel into pd_styles.
Upserts on (style_number, style_name) — safe to re-run.
"""
import os, sys
import openpyxl
import psycopg2
import psycopg2.extras
from datetime import datetime, date

DB = os.environ["DATABASE_URL"]

# ── Stage mapping ─────────────────────────────────────────────────────────────
# Excel Status  → (pd_stages stage_key, completed?)
STATUS_MAP = {
    "PRODUCTION":      ("final_review", True),   # already in production = flow complete
    "APPROVED FOR S/S":("final_review", False),  # set-sample approved, awaiting order
    "SET SAMPLING":    ("set_sample",   False),
    "SAMPLE REVIEW":   ("review",       False),
    "SAMPLING":        ("sampling",     False),
    "PATTERN":         ("pattern",      False),
    "N/A":             ("adopted",      False),
}

def norm_brand(raw):
    if not raw:
        return None
    r = str(raw).strip()
    if r.upper() in ("SBV", "SAFARI BY VIVO", "SAFARI By Vivo".upper()):
        return "Safari by Vivo"
    if r.upper() in ("VIVO", "VIVO  "):
        return "Vivo"
    return r

def clean(v):
    if v is None:
        return None
    s = str(v).strip()
    return s if s and s.lower() not in ("none", "false", " ", "????") else None

def to_date(v):
    if isinstance(v, (datetime, date)):
        return v.date() if isinstance(v, datetime) else v
    return None

def main():
    wb = openpyxl.load_workbook(
        "attached_assets/Q3_2026_Product_Development_Tracker_of_New_Styles_1784641645356.xlsx",
        data_only=True
    )
    ws = wb["Q3 NEW STYLES"]

    # Row 2 is headers, data starts at row 3
    HDR = [c.value for c in list(ws.iter_rows(min_row=2, max_row=2))[0]]
    IDX = {h: i for i, h in enumerate(HDR) if h}

    rows = [r for r in ws.iter_rows(min_row=3, values_only=True)
            if any(v is not None for v in r)]

    conn = psycopg2.connect(DB)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Ensure new columns exist (idempotent)
    for col, typ in [
        ("adoption_date",        "DATE"),
        ("target_order_week",    "TEXT"),
        ("fabric_type",          "TEXT"),
        ("fabric_name",          "TEXT"),
        ("sample_colour",        "TEXT"),
        ("theme",                "TEXT"),
        ("print_solid",          "TEXT"),
        ("pattern_maker",        "TEXT"),
        ("order_date",           "DATE"),
        ("sample_approval_date", "DATE"),
    ]:
        cur.execute(f"ALTER TABLE pd_styles ADD COLUMN IF NOT EXISTS {col} {typ}")

    inserted = updated = skipped = 0

    for r in rows:
        style_number   = clean(r[IDX.get("Style Number", 0)])
        style_name     = clean(r[IDX.get("Style Name",   2)])
        if not style_name:
            skipped += 1
            continue

        raw_status = clean(r[IDX.get("Status", 4)]) or ""
        stage_key, is_completed = STATUS_MAP.get(raw_status.upper(), ("adopted", False))

        brand          = norm_brand(r[IDX.get("Brand",          25)])
        category       = clean(r[IDX.get("Category",            5)])
        sub_cat        = clean(r[IDX.get("Sub Category",        26)])
        lifecycle_type = clean(r[IDX.get("Type",                3)])
        pattern_maker  = clean(r[IDX.get("Pattern Maker",       7)])
        target_wk      = clean(r[IDX.get("Target Order Week",   8)])
        adoption_date  = to_date(r[IDX.get("Adoption Date",     6)])
        order_date     = to_date(r[IDX.get("Order Date",        9)])
        samp_appr_date = to_date(r[IDX.get("Sample Approval Date", 10)])
        fabric_type    = clean(r[IDX.get("Fabric Type",         23)])
        fabric_name    = clean(r[IDX.get("Fabric Name",         27)])
        sample_colour  = clean(r[IDX.get("Sample Colour",       28)])
        theme          = clean(r[IDX.get("Theme",               21)])
        print_solid    = clean(r[IDX.get("P / S",               24)])

        now = datetime.utcnow()
        stage_entered = adoption_date or now.date()

        # Check for existing row
        cur.execute(
            "SELECT id FROM pd_styles WHERE style_number = %s AND style_name = %s",
            (style_number, style_name)
        )
        existing = cur.fetchone()

        if existing:
            cur.execute("""
                UPDATE pd_styles SET
                    brand = %s, category = %s, sub_category = %s,
                    lifecycle_type = %s, pattern_maker = %s,
                    current_stage = %s,
                    completed_at = %s,
                    adoption_date = %s, target_order_week = %s,
                    fabric_type = %s, fabric_name = %s,
                    sample_colour = %s, theme = %s, print_solid = %s,
                    order_date = %s, sample_approval_date = %s,
                    assignee_name = COALESCE(assignee_name, %s)
                WHERE id = %s
            """, (
                brand, category, sub_cat,
                lifecycle_type, pattern_maker,
                stage_key,
                now if is_completed else None,
                adoption_date, target_wk,
                fabric_type, fabric_name,
                sample_colour, theme, print_solid,
                order_date, samp_appr_date,
                pattern_maker,
                existing["id"]
            ))
            updated += 1
        else:
            cur.execute("""
                INSERT INTO pd_styles (
                    style_name, style_number, brand, category, sub_category,
                    lifecycle_type, pattern_maker,
                    current_stage, stage_entered_at,
                    completed_at, status,
                    adoption_date, target_order_week,
                    fabric_type, fabric_name,
                    sample_colour, theme, print_solid,
                    order_date, sample_approval_date,
                    assignee_name, created_by_email, created_by_name, created_at
                ) VALUES (
                    %s, %s, %s, %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s,
                    %s, %s, %s,
                    %s, %s,
                    %s, %s, %s, %s
                )
            """, (
                style_name, style_number, brand, category, sub_cat,
                lifecycle_type, pattern_maker,
                stage_key, stage_entered,
                now if is_completed else None,
                raw_status,
                adoption_date, target_wk,
                fabric_type, fabric_name,
                sample_colour, theme, print_solid,
                order_date, samp_appr_date,
                pattern_maker, "import@vivofashiongroup.com", "Q3 Import", now
            ))
            inserted += 1

    conn.commit()
    cur.close()
    conn.close()
    print(f"Done: {inserted} inserted, {updated} updated, {skipped} skipped")

if __name__ == "__main__":
    main()
