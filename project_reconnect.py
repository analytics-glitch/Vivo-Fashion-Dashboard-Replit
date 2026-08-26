"""Project Reconnect — Cohort & Test-Allocation Export.

One-off (but re-runnable) data pull for the Aug-Sep "Project Reconnect" churn
micro-test programme (Data Prep Brief, Achieng — Head of Retail & CX). Builds
a cleaned, contactable Kenya customer population, splits it into two churn
cohorts (At-Risk / True Churn), and allocates every customer to exactly one
of 15 identical tests/arms per cohort, stratified by value band and drawn
without replacement, then exports the result as an Excel workbook.

Registered via register_project_reconnect_routes(app, api_pg_module) from
api_pg.py. Gate: /api/project-reconnect/* and /reconnect require
customer_service, leadership, smt or admin (enforced in clerk_auth_gate) —
this is a bulk PII (phone/email) export, so it stays behind the same kind of
role fence as the CRM/Order Explorer surfaces, not open to every role.

IMPORTANT — this module is fully independent of the platform's canonical
churn/at-risk definitions:
  * Cohort boundaries here (182 / 365 days) are THIS PROGRAMME's own recency
    cuts from the brief. They are NOT CUSTOMER_AT_RISK_MIN_DAYS/MAX_DAYS or
    CUSTOMER_CHURN_DAYS (api_pg.py ~line 7279) and must never be aliased to
    them — the Customers-page churn thresholds must not change because of
    this export.
  * This module never touches the Reactivation Opportunity feature or its
    CSV export. It is a standalone, from-scratch build.

Data lineage (reused, unmodified, from api_pg.py):
  * _WALKIN_PSEUDO_COND / _not_walkin_pseudo_sql — canonical walk-in/pseudo
    exclusion, reused verbatim for pseudo-account cleaning.
  * BASE_FILTERS — canonical sales-row filter (Staff purchases location,
    Manual Order, gift cards/vouchers, shopping bags, ...).
  * "Lifetime value" = the /api/churned-customers lifetime-spend formula:
    SUM(total_sales_kes - discounts_kes) per customer (returns are already
    netted in via negative total_sales_kes on return rows).
  * The one-profile-per-customer collapse (customer_id, store_id is the PK on
    all_customers) uses the same MAX(NULLIF(TRIM(...), '')) pattern as the
    /api/customers cust_profile CTE.
  * "Online" is folded into the Kenya scope as the existing pseudo-country
    used everywhere else for Kenya's Shop Zetu online channel.

Known, explicitly documented limitations (surfaced on the Notes/QA tab, not
silently hidden):
  * There is no wholesale/staff flag anywhere in the customer or sales data
    model. Wholesale/staff exclusion here is a best-available heuristic
    (known + typo internal Vivo email domains) and is NOT equivalent to the
    brief's original hand-curated "54 wholesale/staff accounts" list, which
    is unavailable to this rebuild.
  * No suppression-list / live-campaign registry exists — Q3 in the brief
    (cross-check against other live campaigns) stays an open sign-off item.
  * CH4's realistic per-agent daily call capacity is unconfirmed — the
    ~150/arm sample size assumes it is achievable; also an open sign-off
    item.
"""

import hashlib
import io
import logging
import random
import re
from datetime import date, datetime

log = logging.getLogger("project_reconnect")

A = None  # api_pg module reference — set in register_project_reconnect_routes()

# ── Programme-specific constants (Project Reconnect brief) ─────────────────
# Deliberately separate from CUSTOMER_AT_RISK_MIN_DAYS / CUSTOMER_CHURN_DAYS —
# see module docstring.
PR_EXCLUDED_MAX_DAYS = 181          # < 182 days since last purchase
PR_AT_RISK_MIN_DAYS = 182
PR_AT_RISK_MAX_DAYS = 364           # 182-364 days
PR_TRUE_CHURN_MIN_DAYS = 365        # 365+ days

PR_VALUE_HIGH_MIN_KES = 100_000     # High:   >= 100,000
PR_VALUE_MEDIUM_MIN_KES = 20_000    # Medium: 20,000-99,999 ; Low: < 20,000

# Brief reference figures (pull date on the original brief) to reconcile
# against. "Excluded" there reflects the brief's own (narrower / differently
# scoped) source list, not a redefinition of this export's Excluded bucket.
BRIEF_REFERENCE = {
    "At-Risk":    {"population": 30_996, "ltv_kes": 1_510_000_000},
    "True Churn": {"population": 98_127, "ltv_kes": 1_810_000_000},
    "Excluded":   {"population": 11_468, "ltv_kes": 660_000_000},
}
# A relative difference at or beyond this threshold on population or LTV is
# called out as "material" on the Notes tab (no threshold was specified in
# the brief; 10% is a standard QA reconciliation tolerance).
MATERIAL_DIFF_PCT = 0.10

COHORT_ORDER = ["At-Risk", "True Churn"]

# The 15-test table, identical in structure for both cohorts. Allocation
# walks this list top-to-bottom for each cohort so results are reproducible.
TEST_TABLE = [
    {"code": "M1",  "name": "Relevant/newness vs. generic messaging",
     "arms": ["Relevant/newness", "Generic"], "sample_per_arm": 800},
    {"code": "M2",  "name": "Newness-led vs. relationship-led messaging",
     "arms": ["Newness-led", "Relationship-led"], "sample_per_arm": 800},
    {"code": "M3",  "name": "Store-specific vs. Vivo-wide messaging",
     "arms": ["Store-specific", "Vivo-wide"], "sample_per_arm": 800},
    {"code": "I1",  "name": "No incentive vs. 5% incentive",
     "arms": ["No incentive", "5%"], "sample_per_arm": 800},
    {"code": "I2",  "name": "5% vs. 10% incentive",
     "arms": ["5%", "10%"], "sample_per_arm": 800},
    {"code": "I3",  "name": "Recognition vs. small gift incentive",
     "arms": ["Recognition", "Small gift"], "sample_per_arm": 800},
    {"code": "C1",  "name": "Emotional vs. commercial tone",
     "arms": ["Emotional", "Commercial"], "sample_per_arm": 800},
    {"code": "C2",  "name": "Short vs. longer copy",
     "arms": ["Short copy", "Longer copy"], "sample_per_arm": 800},
    {"code": "C3",  "name": "Product image vs. text-only",
     "arms": ["Product image", "Text-only"], "sample_per_arm": 800},
    {"code": "J1",  "name": "One touch vs. two touches vs. no-contact",
     "arms": ["One touch", "Two touches", "No-contact"], "sample_per_arm": 800},
    {"code": "J2",  "name": "3-4 day vs. 7-10 day reminder timing",
     "arms": ["3-4 day reminder", "7-10 day reminder"], "sample_per_arm": 800},
    {"code": "CH1", "name": "WhatsApp vs. SMS",
     "arms": ["WhatsApp", "SMS"], "sample_per_arm": 800},
    {"code": "CH2", "name": "WhatsApp vs. Email newsletter",
     "arms": ["WhatsApp", "Email newsletter"], "sample_per_arm": 800,
     "email_only": True},
    {"code": "CH3", "name": "SMS vs. Email newsletter",
     "arms": ["SMS", "Email newsletter"], "sample_per_arm": 800,
     "email_only": True},
    {"code": "CH4", "name": "Best digital channel vs. phone call (High value only)",
     "arms": ["Best digital channel", "Phone call"], "sample_per_arm": 150,
     "high_value_only": True},
]
TARGET_PER_COHORT = sum(t["sample_per_arm"] * len(t["arms"]) for t in TEST_TABLE)  # 23,500

# ── Cleaning heuristics ──────────────────────────────────────────────────────

# Best-available wholesale/staff heuristic: known + observed-typo internal
# Vivo email domains. This is NOT the brief's original 54-account list (that
# list is unavailable to this rebuild) — it only catches staff/testing rows
# that registered with a company email address. Documented as a limitation
# on the Notes tab, not presented as equivalent to a true wholesale flag.
_STAFF_DOMAIN_RE = re.compile(
    r"@(vivofashiongroup|vivoactivewear|vivofashiogroup|vivifashiongroup|"
    r"vivofahiongroup|fashiongroup|vivo\.co\.ke|vivo\.com|vivoenergy|"
    r"shopzetu|vivowoman)\.",
    re.IGNORECASE,
)

_PHONE_DIGITS_RE = re.compile(r"[^0-9]")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def normalize_kenya_phone(raw):
    """Normalize toward full international +254XXXXXXXXX.

    Returns (normalized_or_None, is_valid). A number is only "valid" (i.e.
    contactable) when it resolves to a 9-digit Kenyan mobile number (starts
    07/01 locally, or bare 7xxxxxxxx/1xxxxxxxx, or already 254-prefixed).
    Anything else (non-Kenya numbers, too short/long, non-numeric) is
    reported as malformed and excluded from the contactable population.
    """
    if not raw:
        return None, False
    digits = _PHONE_DIGITS_RE.sub("", str(raw))
    if not digits:
        return None, False
    if digits.startswith("254"):
        rest = digits[3:]
    elif digits.startswith("0"):
        rest = digits[1:]
    elif len(digits) == 9:
        rest = digits
    else:
        rest = None
    if rest and len(rest) == 9 and rest[0] in ("7", "1"):
        return "+254" + rest, True
    return None, False


def is_valid_email(raw):
    return bool(raw) and bool(_EMAIL_RE.match(str(raw).strip()))


def value_band_for(ltv_kes):
    if ltv_kes >= PR_VALUE_HIGH_MIN_KES:
        return "High"
    if ltv_kes >= PR_VALUE_MEDIUM_MIN_KES:
        return "Medium"
    return "Low"


def cohort_for_days(days_since):
    if days_since < PR_AT_RISK_MIN_DAYS:
        return "Excluded"
    if days_since <= PR_AT_RISK_MAX_DAYS:
        return "At-Risk"
    return "True Churn"


# ── DB exec (dual mode: API / standalone), mirrors growth_router.py's pattern ──

def _db_exec(sql, params=None, fetch=True):
    if A is not None:
        return A._users_exec(sql, params, fetch=fetch)
    import os
    import psycopg2
    import psycopg2.extras
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL not set")
    conn = psycopg2.connect(db_url)
    try:
        conn.autocommit = True
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()] if fetch else None
        cur.close()
        return rows
    finally:
        conn.close()


def _walkin_pseudo_cond(alias):
    # Reuse the exact canonical predicate — never redefine it here.
    return A._not_walkin_pseudo_sql(alias)


def _base_filters():
    return A.BASE_FILTERS


# ── Step 1+2: build the cleaned, classified source population ──────────────

_POPULATION_SQL_TMPL = """
    WITH cust_profile AS (
        SELECT customer_id,
            MAX(NULLIF(TRIM(COALESCE(first_name,'')),'')) AS first_name,
            MAX(NULLIF(TRIM(COALESCE(last_name,'')),'')) AS last_name,
            MAX(NULLIF(TRIM(COALESCE(email,'')),'')) AS email,
            MAX(NULLIF(TRIM(COALESCE(phone,'')),'')) AS phone
        FROM all_customers
        WHERE customer_id IS NOT NULL
        GROUP BY customer_id
    ),
    lifetime AS (
        SELECT s.customer_id,
            MAX(s.sale_date::date) AS last_purchase_date,
            MIN(s.sale_date::date) AS first_purchase_date,
            ROUND(SUM(s.total_sales_kes::numeric - COALESCE(s.discounts_kes,0)::numeric), 0) AS lifetime_value_kes
        FROM all_sales s
        WHERE s.sale_kind IN ('sale','order')
          AND s.customer_id IS NOT NULL AND s.customer_id NOT IN ('None','null','')
          AND s.country IN ('Kenya','Online')
          AND {base_filters}
          AND {walkin_sales}
        GROUP BY s.customer_id
    )
    SELECT lt.customer_id, lt.last_purchase_date, lt.first_purchase_date,
           lt.lifetime_value_kes,
           cp.first_name, cp.last_name, cp.email, cp.phone
    FROM lifetime lt
    LEFT JOIN cust_profile cp ON cp.customer_id = lt.customer_id
"""


def _fetch_raw_population():
    # _not_walkin_pseudo_sql(alias) already expands to a full
    # "alias.customer_id NOT IN (SELECT ... FROM all_customers WHERE ...)"
    # predicate against the canonical pseudo/walk-in rule — applied once,
    # here, against the sales alias, matching every other customer-lifecycle
    # surface in this codebase.
    sql = _POPULATION_SQL_TMPL.format(
        base_filters=_base_filters(),
        walkin_sales=_walkin_pseudo_cond("s"),
    )
    return _db_exec(sql, fetch=True) or []


def build_population(pull_date=None):
    """Query + clean + classify the full Project Reconnect source population.

    Returns a dict:
      pull_date, rows_by_cohort {cohort: [record,...]}, stats (exclusion
      counts + per-cohort population/LTV/email-coverage/band mix), and
      reconciliation vs BRIEF_REFERENCE.
    """
    pull_date = pull_date or date.today()
    raw = _fetch_raw_population()

    stats = {
        "rows_pulled": len(raw),
        "excluded_staff_domain": 0,
        "excluded_no_phone": 0,
        "excluded_malformed_phone": 0,
        "contactable_total": 0,
    }
    rows_by_cohort = {"Excluded": [], "At-Risk": [], "True Churn": []}

    for r in raw:
        email_raw = (r.get("email") or "").strip()
        if _STAFF_DOMAIN_RE.search(email_raw):
            stats["excluded_staff_domain"] += 1
            continue
        phone_raw = r.get("phone")
        if not phone_raw or not str(phone_raw).strip():
            stats["excluded_no_phone"] += 1
            continue
        phone_norm, phone_ok = normalize_kenya_phone(phone_raw)
        if not phone_ok:
            stats["excluded_malformed_phone"] += 1
            continue

        last_purchase = r.get("last_purchase_date")
        if not last_purchase:
            # Should not happen (lifetime CTE requires >=1 qualifying sale),
            # but fail safe rather than crash on a bad row.
            continue
        if isinstance(last_purchase, datetime):
            last_purchase = last_purchase.date()
        days_since = (pull_date - last_purchase).days
        cohort = cohort_for_days(days_since)

        ltv = float(r.get("lifetime_value_kes") or 0)
        band = value_band_for(ltv)
        has_email = is_valid_email(email_raw)
        name = " ".join(p for p in [r.get("first_name"), r.get("last_name")] if p) or None

        record = {
            "customer_id": r["customer_id"],
            "contact": phone_norm,
            "name": name,
            "email": email_raw if has_email else None,
            "has_email": has_email,
            "days_since": days_since,
            "ltv_kes": ltv,
            "value_band": band,
            "cohort": cohort,
        }
        rows_by_cohort[cohort].append(record)
        stats["contactable_total"] += 1

    # Per-cohort summary + reconciliation vs the brief's reference figures.
    cohort_stats = {}
    for cohort in ("Excluded", "At-Risk", "True Churn"):
        recs = rows_by_cohort[cohort]
        population = len(recs)
        ltv_total = round(sum(rec["ltv_kes"] for rec in recs))
        with_email = sum(1 for rec in recs if rec["has_email"])
        band_mix = {"High": 0, "Medium": 0, "Low": 0}
        for rec in recs:
            band_mix[rec["value_band"]] += 1
        ref = BRIEF_REFERENCE[cohort]
        pop_diff_pct = ((population - ref["population"]) / ref["population"]) if ref["population"] else None
        ltv_diff_pct = ((ltv_total - ref["ltv_kes"]) / ref["ltv_kes"]) if ref["ltv_kes"] else None
        cohort_stats[cohort] = {
            "population": population,
            "ltv_kes": ltv_total,
            "email_coverage": (with_email / population) if population else 0.0,
            "band_mix": band_mix,
            "reference_population": ref["population"],
            "reference_ltv_kes": ref["ltv_kes"],
            "population_diff_pct": pop_diff_pct,
            "ltv_diff_pct": ltv_diff_pct,
            "population_material": bool(pop_diff_pct is not None and abs(pop_diff_pct) >= MATERIAL_DIFF_PCT),
            "ltv_material": bool(ltv_diff_pct is not None and abs(ltv_diff_pct) >= MATERIAL_DIFF_PCT),
        }

    return {
        "pull_date": pull_date,
        "rows_by_cohort": rows_by_cohort,
        "exclusion_stats": stats,
        "cohort_stats": cohort_stats,
    }


# ── Step 3: stratified, without-replacement test allocation ────────────────

def _seeded_rng(cohort, test_code):
    # Deterministic per (cohort, test) seed so a re-run against the SAME
    # underlying population reproduces the identical allocation — documented
    # on the Notes tab as the sampling method.
    h = hashlib.md5(f"project-reconnect::{cohort}::{test_code}".encode()).hexdigest()
    return random.Random(int(h[:16], 16))


def _split_evenly(total, n_parts):
    """Split `total` into `n_parts` near-equal non-negative ints (remainder
    goes to the first parts, in order) — used to divide a band's allocation
    across a test's arms."""
    base = total // n_parts
    rem = total % n_parts
    return [base + (1 if i < rem else 0) for i in range(n_parts)]


def allocate_test(pool, test):
    """Allocate one test's arms from `pool` (dict band -> list[record],
    mutated in place — allocated records are removed so the caller's shared
    pool reflects "without replacement" across all 15 tests).

    Returns (assignments, report) where assignments is a list of
    (record, arm_label) and report describes target vs. actual per arm plus
    the band mix actually delivered.
    """
    arms = test["arms"]
    n_arms = len(arms)
    target_per_arm = test["sample_per_arm"]
    rng = _seeded_rng(test.get("_cohort", ""), test["code"])

    if test.get("high_value_only"):
        eligible_bands = ["High"]
    else:
        eligible_bands = ["High", "Medium", "Low"]

    email_only = bool(test.get("email_only"))

    # Snapshot eligible counts per band (after the email-only filter, if any)
    # to compute a proportional stratification target for this test.
    def eligible_list(band):
        lst = pool.get(band, [])
        if email_only:
            return [rec for rec in lst if rec["has_email"]]
        return lst

    band_available = {b: len(eligible_list(b)) for b in eligible_bands}
    total_available = sum(band_available.values())
    total_target = target_per_arm * n_arms

    # Proportional band split of the test's total target, based on the
    # CURRENT remaining pool's composition (so arms stay comparable to each
    # other, not to the original population) — capped by availability, with
    # any leftover target reassigned to bands that still have room
    # (largest-remainder-style top-up) so a scarce band in one direction
    # doesn't waste target the pool could otherwise fill.
    if total_available == 0 or total_target == 0:
        band_target = {b: 0 for b in eligible_bands}
    else:
        raw = {b: total_target * (band_available[b] / total_available) for b in eligible_bands}
        band_target = {b: min(band_available[b], int(round(raw[b]))) for b in eligible_bands}
        # Top up remaining shortfall into whichever bands still have spare
        # capacity, largest-available-first, until either the target is met
        # or every band is exhausted.
        assigned = sum(band_target.values())
        shortfall = min(total_target, total_available) - assigned
        if shortfall > 0:
            spare_bands = sorted(
                eligible_bands,
                key=lambda b: band_available[b] - band_target[b],
                reverse=True,
            )
            i = 0
            while shortfall > 0 and any(band_available[b] - band_target[b] > 0 for b in eligible_bands):
                b = spare_bands[i % len(spare_bands)]
                if band_available[b] - band_target[b] > 0:
                    band_target[b] += 1
                    shortfall -= 1
                i += 1

    # Split each band's target evenly across arms.
    per_arm_band_target = {}  # arm_idx -> {band: n}
    for b in eligible_bands:
        parts = _split_evenly(band_target[b], n_arms)
        for i in range(n_arms):
            per_arm_band_target.setdefault(i, {})[b] = parts[i]

    assignments = []
    arm_delivered = [0] * n_arms
    arm_band_delivered = [{"High": 0, "Medium": 0, "Low": 0} for _ in range(n_arms)]

    for i in range(n_arms):
        for b in eligible_bands:
            n = per_arm_band_target[i][b]
            if n <= 0:
                continue
            candidates = eligible_list(b)
            rng.shuffle(candidates)
            take = candidates[:n]
            for rec in take:
                pool[b].remove(rec)
                assignments.append((rec, arms[i]))
                arm_delivered[i] += 1
                arm_band_delivered[i][b] += 1

    report = {
        "code": test["code"],
        "name": test["name"],
        "arms": [
            {
                "arm": arms[i],
                "target": target_per_arm,
                "delivered": arm_delivered[i],
                "shortfall": max(0, target_per_arm - arm_delivered[i]),
                "band_mix": arm_band_delivered[i],
            }
            for i in range(n_arms)
        ],
        "email_only": email_only,
        "high_value_only": bool(test.get("high_value_only")),
        # Pool size available to THIS test, right before its own draw (i.e.
        # after every earlier test in the sequence has already removed its
        # allocation) — explains WHY a scarcity-driven shortfall happened,
        # since a test late in the sequence can be starved by earlier,
        # unrestricted tests happening to draw from the same limited subset
        # (e.g. CH2/CH3 both competing for the same has-email customers).
        "eligible_available_before": total_available,
        "total_target": total_target,
    }
    return assignments, report


def run_allocation(rows_by_cohort):
    """Runs the full 15-test allocation for both cohorts. Returns:
      allocations: {cohort: {test_code: [(record, arm), ...]}}
      reports: {cohort: [test_report, ...]}
      leftover: {cohort: [record, ...]} (never allocated to any test)
    """
    allocations = {}
    reports = {}
    leftover = {}
    for cohort in COHORT_ORDER:
        pool = {"High": [], "Medium": [], "Low": []}
        for rec in rows_by_cohort.get(cohort, []):
            pool[rec["value_band"]].append(dict(rec))
        allocations[cohort] = {}
        reports[cohort] = []
        for test in TEST_TABLE:
            test_c = dict(test)
            test_c["_cohort"] = cohort
            assignments, report = allocate_test(pool, test_c)
            allocations[cohort][test["code"]] = assignments
            reports[cohort].append(report)
        leftover[cohort] = pool["High"] + pool["Medium"] + pool["Low"]
    return allocations, reports, leftover


# ── Step 4: Excel workbook export ───────────────────────────────────────────

_TEST_TAB_COLUMNS = [
    "Customer ID", "Contact", "Name", "Email", "Cohort", "Test", "Arm",
    "Days Since Last Purchase", "Lifetime Value (KES)", "Value Band",
]


def _xlsx_header(ws, cols, fill_hex="1A5C38"):
    from openpyxl.styles import Font, PatternFill, Alignment
    fill = PatternFill("solid", fgColor=fill_hex)
    font = Font(bold=True, color="FFFFFF")
    for ci, h in enumerate(cols, 1):
        c = ws.cell(row=1, column=ci, value=h)
        c.fill = fill
        c.font = font
        c.alignment = Alignment(horizontal="left", vertical="center")
        ws.column_dimensions[c.column_letter].width = max(12, min(40, len(str(h)) + 4))
    ws.freeze_panes = "A2"


def _sheet_title(name, used):
    t = re.sub(r'[:\\/?*\[\]]', '-', str(name or "Sheet"))[:31] or "Sheet"
    base, i = t, 2
    while t.lower() in used:
        suffix = f" ({i})"
        t = (base[:31 - len(suffix)] + suffix)
        i += 1
    used.add(t.lower())
    return t


def _pct(x):
    return "n/a" if x is None else f"{x * 100:.1f}%"


def _fmt_money(x):
    try:
        return f"KES {round(float(x)):,}"
    except Exception:
        return str(x)


def build_workbook(pop, allocations, reports, leftover, actor_email=None):
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    wb.remove(wb.active)
    used = set()

    # -- One tab per test (15 tabs), rows from BOTH cohorts --------------------
    for test in TEST_TABLE:
        ws = wb.create_sheet(_sheet_title(f"{test['code']} {test['name']}", used))
        _xlsx_header(ws, _TEST_TAB_COLUMNS)
        for cohort in COHORT_ORDER:
            for rec, arm in allocations[cohort][test["code"]]:
                ws.append([
                    rec["customer_id"], rec["contact"], rec["name"] or "",
                    rec["email"] or "", cohort, f"{test['code']} — {test['name']}", arm,
                    rec["days_since"], round(rec["ltv_kes"]), rec["value_band"],
                ])

    # -- Master summary tab -----------------------------------------------------
    ws = wb.create_sheet(_sheet_title("Master Summary", used))
    ws.append(["Project Reconnect — Test Allocation Summary"])
    ws["A1"].font = Font(bold=True, size=13)
    ws.append([f"Build run: {datetime.now().isoformat(timespec='seconds')}"
               + (f" by {actor_email}" if actor_email else "")])
    ws.append([])
    cols = ["Test Code", "Test Name", "Cohort", "Arm", "Target/Arm",
            "Delivered", "Shortfall", "High", "Medium", "Low",
            "Email-only test", "High-value-only test"]
    header_row = ws.max_row + 1
    for ci, h in enumerate(cols, 1):
        ws.cell(row=header_row, column=ci, value=h)
    for c in ws[header_row]:
        c.font = Font(bold=True)
    for cohort in COHORT_ORDER:
        for report in reports[cohort]:
            for arm_rep in report["arms"]:
                bm = arm_rep["band_mix"]
                ws.append([
                    report["code"], report["name"], cohort, arm_rep["arm"],
                    arm_rep["target"], arm_rep["delivered"], arm_rep["shortfall"],
                    bm["High"], bm["Medium"], bm["Low"],
                    "Yes" if report["email_only"] else "",
                    "Yes" if report["high_value_only"] else "",
                ])
    for col_cells in ws.columns:
        length = max((len(str(c.value)) for c in col_cells if c.value is not None), default=8)
        try:
            ws.column_dimensions[col_cells[0].column_letter].width = max(10, min(38, length + 2))
        except Exception:
            pass
    ws.freeze_panes = f"A{header_row + 1}"

    # -- Notes / QA tab -----------------------------------------------------------
    ws = wb.create_sheet(_sheet_title("Notes & QA", used))
    bold = Font(bold=True)

    def line(text="", is_bold=False):
        ws.append([text])
        if is_bold:
            ws.cell(row=ws.max_row, column=1).font = bold

    line("Project Reconnect — Notes & QA", True)
    line(f"Data pull date: {pop['pull_date'].isoformat()}")
    line()

    line("Cleaning & exclusion criteria applied", True)
    stats = pop["exclusion_stats"]
    line(f"1. Scope: Kenya customers, including the 'Online' pseudo-country used "
         f"elsewhere for Kenya's Shop Zetu online channel. Lifetime value and last-"
         f"purchase date are computed only from Kenya + Online sales rows.")
    line(f"2. Walk-in / placeholder / pseudo accounts excluded using the platform's "
         f"existing shared exclusion rule (name/email pattern match) — same rule as "
         f"every other customer-lifecycle report.")
    line(f"3. Wholesale/staff exclusion (best-available — see limitation below): rows "
         f"whose email matches a known or observed-typo internal Vivo staff email "
         f"domain were excluded. {stats['excluded_staff_domain']} rows excluded this way.")
    line(f"4. Contactability / malformed-contact handling: every phone number was "
         f"normalized to full international format (+254XXXXXXXXX). Rows with no "
         f"phone on file ({stats['excluded_no_phone']}) or a phone that could not be "
         f"resolved to a valid Kenyan mobile number ({stats['excluded_malformed_phone']}) "
         f"were excluded from the contactable population.")
    line(f"5. Total rows pulled before cleaning: {stats['rows_pulled']:,}. "
         f"Contactable population after cleaning: {stats['contactable_total']:,}.")
    line()
    line("LIMITATION: there is no wholesale/staff flag anywhere in the customer or "
         "sales data model. The email-domain heuristic above only catches staff/test "
         "rows registered with a company email — it is NOT equivalent to the brief's "
         "original hand-curated list of 54 wholesale/staff accounts, which is not "
         "available to this rebuild. Treat the wholesale/staff exclusion count above "
         "as a floor, not a guarantee.")
    line()

    line("Population reconciliation vs. brief reference figures", True)
    cols2 = ["Cohort", "Recomputed Population", "Reference Population", "Diff %",
             "Recomputed LTV (KES)", "Reference LTV (KES)", "Diff %", "Material?"]
    ws.append(cols2)
    for c in ws[ws.max_row]:
        c.font = bold
    for cohort in ("Excluded", "At-Risk", "True Churn"):
        cs = pop["cohort_stats"][cohort]
        material = cs["population_material"] or cs["ltv_material"]
        ws.append([
            cohort, cs["population"], cs["reference_population"], _pct(cs["population_diff_pct"]),
            cs["ltv_kes"], cs["reference_ltv_kes"], _pct(cs["ltv_diff_pct"]),
            "YES — see note below" if material else "No",
        ])
    line()
    line("Note on the 'Excluded' (<182 days) reconciliation: this export's Excluded "
         "bucket has no lower bound — it is every contactable Kenya customer whose "
         "last purchase was under 182 days ago, including customers who bought "
         "yesterday. If the brief's ~11,468 reference figure came from a source list "
         "that was already scoped to some minimum inactivity window, that would "
         "explain a materially larger recomputed Excluded population here. This "
         "export deliberately follows the task's literal '<182 days' instruction; "
         "flagging the gap for sign-off rather than silently narrowing the bucket "
         "to match the old number.")
    line()

    line("Value bands", True)
    line(f"High: LTV >= KES {PR_VALUE_HIGH_MIN_KES:,}   |   "
         f"Medium: KES {PR_VALUE_MEDIUM_MIN_KES:,}-{PR_VALUE_HIGH_MIN_KES - 1:,}   |   "
         f"Low: < KES {PR_VALUE_MEDIUM_MIN_KES:,}")
    line()

    line("Sampling / allocation method", True)
    line("For each cohort (At-Risk, True Churn) independently: the 15 tests are "
         "processed in the brief's listed order (M1, M2, M3, I1, I2, I3, C1, C2, C3, "
         "J1, J2, CH1, CH2, CH3, CH4). Each test draws from whatever remains of the "
         "cohort's pool after every earlier test — once a customer is allocated to a "
         "test/arm, they are removed from the pool before the next test draws "
         "(sampling without replacement). Within a test, the target sample is split "
         "across value bands in proportion to the CURRENT remaining pool's High/"
         "Medium/Low mix, then each band's allocation is split evenly across the "
         "test's arms — so every arm within a test gets a comparable value-band mix. "
         "CH2/CH3 draw only from customers with a valid email on file; CH4 draws only "
         "from the High value band. The random draw within each band is seeded "
         "deterministically per (cohort, test), so re-running the build against an "
         "unchanged population reproduces an identical allocation.")
    line()

    line("Email coverage (CH2 / CH3 reach)", True)
    for cohort in COHORT_ORDER:
        cs = pop["cohort_stats"][cohort]
        line(f"{cohort}: {cs['population']:,} contactable customers, "
             f"{_pct(cs['email_coverage'])} have a usable email on file.")
    line()

    line("High-value pool available for CH4", True)
    for cohort in COHORT_ORDER:
        bm = pop["cohort_stats"][cohort]["band_mix"]
        ch4_report = next(r for r in reports[cohort] if r["code"] == "CH4")
        line(f"{cohort}: {bm['High']:,} High-value customers in the total cohort "
             f"population; {ch4_report['eligible_available_before']:,} still remained "
             f"unallocated when CH4 (test 15 of 15) drew "
             f"(CH4 target: {ch4_report['total_target']:,} total).")
    line()

    line("Sample-size shortfalls (target not fully met)", True)
    any_shortfall = False
    for cohort in COHORT_ORDER:
        for test_idx, report in enumerate(reports[cohort], start=1):
            arm_shortfalls = [a for a in report["arms"] if a["shortfall"] > 0]
            if not arm_shortfalls:
                continue
            any_shortfall = True
            why = ""
            if report["email_only"]:
                why = (f" Reason: {report['code']} draws only from customers with a "
                       f"usable email on file; only {report['eligible_available_before']:,} "
                       f"such customers remained in the {cohort} pool by the time this test "
                       f"drew (test #{test_idx} of 15) against a combined arm target of "
                       f"{report['total_target']:,}. CH2 and CH3 compete for the same limited "
                       f"has-email subset within a cohort, and earlier unrestricted tests can "
                       f"also draw away members of that subset before either runs.")
            elif report["high_value_only"]:
                why = (f" Reason: {report['code']} draws only from the High value band; only "
                       f"{report['eligible_available_before']:,} High-value customers remained "
                       f"in the {cohort} pool by the time this test drew, against a combined "
                       f"arm target of {report['total_target']:,}.")
            for arm_rep in arm_shortfalls:
                line(f"{cohort} / {report['code']} ({report['name']}) / "
                     f"arm '{arm_rep['arm']}': targeted {arm_rep['target']:,}, "
                     f"delivered {arm_rep['delivered']:,}, "
                     f"short by {arm_rep['shortfall']:,}.{why}")
                why = ""  # only state the reason once per test
    if not any_shortfall:
        line("None — every test/arm/cohort combination hit its full target sample size.")
    line()
    line(f"Unallocated leftover pool (never assigned to any test): "
         f"At-Risk {len(leftover.get('At-Risk', [])):,}, "
         f"True Churn {len(leftover.get('True Churn', [])):,}.")
    line()

    line("Open items still needing business sign-off", True)
    line("1. No suppression-list / live-campaign registry exists on this platform, so "
         "this cohort has NOT been cross-checked against any other currently running "
         "campaign or message stream. Confirm there is no overlap before sending.")
    line("2. CH4's realistic per-agent daily call capacity is unconfirmed. The "
         "150-per-arm sample size assumes that volume of outbound calls is "
         "achievable within the test window — confirm capacity before launch.")
    for col_cells in ws.columns:
        length = max((len(str(c.value)) for c in col_cells if c.value is not None), default=8)
        try:
            ws.column_dimensions[col_cells[0].column_letter].width = max(14, min(110, length + 2))
        except Exception:
            pass

    # Move Notes tab to the front for visibility, keep test tabs, summary last-ish.
    wb.move_sheet(ws.title, offset=-(len(wb.sheetnames) - 1))

    return wb


def run_full_build(actor_email=None):
    pop = build_population()
    allocations, reports, leftover = run_allocation(pop["rows_by_cohort"])
    wb = build_workbook(pop, allocations, reports, leftover, actor_email=actor_email)
    return wb


# ── Standalone page ──────────────────────────────────────────────────────────

_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Project Reconnect — Cohort &amp; Test-Allocation Export</title>
<style>
  :root { --brand:#1a5c38; --brand-soft:rgba(26,92,56,.08); --bg:#f6f7f6; --card:#fff;
    --border:#e4e7e4; --text:#17221b; --muted:#6b7a70; --rose:#e11d48; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
    background:var(--bg); color:var(--text); font-size:14px; }
  .wrap { max-width:760px; margin:0 auto; padding:40px 20px 80px; }
  h1 { font-size:22px; margin:0 0 6px; letter-spacing:-.02em; }
  .sub { font-size:13.5px; color:var(--muted); line-height:1.55; margin:0 0 22px; max-width:640px; }
  .card { border:1px solid var(--border); border-radius:14px; background:var(--card); padding:22px; }
  label { display:block; font-size:12.5px; font-weight:600; margin:14px 0 6px; }
  input { width:100%; padding:9px 11px; border:1px solid var(--border); border-radius:8px; font-size:13.5px; }
  .btn { display:inline-flex; align-items:center; gap:8px; border:none; cursor:pointer; border-radius:9px;
    font-weight:600; font-size:13.5px; padding:10px 18px; background:var(--brand); color:#fff; margin-top:18px; }
  .btn:disabled { opacity:.5; cursor:default; }
  .msg { margin-top:16px; padding:10px 13px; border-radius:9px; font-size:13px; }
  .msg.err { background:rgba(225,29,72,.08); color:var(--rose); }
  .msg.ok { background:var(--brand-soft); color:var(--brand); }
  .note { font-size:12px; color:var(--muted); margin-top:20px; line-height:1.5; }
  .center { display:flex; align-items:center; justify-content:center; min-height:60vh; }
  .box { max-width:420px; padding:28px; border:1px solid var(--border); border-radius:14px; background:var(--card); }
</style>
</head>
<body>
<div id="app"></div>
<script>
"use strict";
var API = "/api";
function token() { try { return localStorage.getItem("vivo_token"); } catch (e) { return null; } }
function req(method, path, body, wantBlob) {
  var headers = { "Accept": "application/json" };
  var t = token();
  if (t) headers["Authorization"] = "Bearer " + t;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(API + path, { method: method, headers: headers, credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body) }).then(function (r) {
    if (wantBlob) {
      if (!r.ok) return r.json().catch(function(){ return {}; }).then(function(d){
        var e = new Error((d && d.detail) || ("Request failed (" + r.status + ")")); e.status = r.status; throw e;
      });
      return r.blob().then(function (b) {
        var cd = r.headers.get("Content-Disposition") || "";
        var m = /filename="([^"]+)"/.exec(cd);
        return { blob: b, filename: m ? m[1] : "project-reconnect.xlsx" };
      });
    }
    return r.text().then(function (txt) {
      var data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
      if (!r.ok) {
        var err = new Error((data && data.detail) || ("Request failed (" + r.status + ")"));
        err.status = r.status; throw err;
      }
      return data;
    });
  });
}
var state = { phase: "boot", loginError: null, loginBusy: false, runBusy: false, msg: null, user: null };
function render() {
  var el = document.getElementById("app");
  if (state.phase === "boot") { el.innerHTML = '<div class="center">Loading…</div>'; return; }
  if (state.phase === "login") {
    el.innerHTML =
      '<div class="center"><div class="box">' +
      '<h1>Project Reconnect</h1>' +
      '<p class="sub">Sign in with your Vivo platform account.</p>' +
      (state.loginError ? '<div class="msg err">' + escHtml(state.loginError) + '</div>' : '') +
      '<label>Email</label><input id="email" type="email" />' +
      '<label>Password</label><input id="pw" type="password" />' +
      '<button class="btn" id="loginBtn" ' + (state.loginBusy ? 'disabled' : '') + '>Sign in</button>' +
      '</div></div>';
    document.getElementById("loginBtn").onclick = function () {
      doLogin(document.getElementById("email").value, document.getElementById("pw").value);
    };
    return;
  }
  if (state.phase === "forbidden") {
    el.innerHTML = '<div class="center"><div class="box"><h1>Not available</h1>' +
      '<p class="sub">Your account does not have access to Project Reconnect.</p></div></div>';
    return;
  }
  el.innerHTML =
    '<div class="wrap">' +
    '<h1>Project Reconnect</h1>' +
    '<p class="sub">Rebuilds the cleaned, contactable Kenya customer population against ' +
    'current data, splits it into the At-Risk / True Churn cohorts, allocates every ' +
    'customer to exactly one of the 15 tests/arms (stratified by value band, drawn ' +
    'without replacement), and returns a downloadable Excel workbook.</p>' +
    '<div class="card">' +
    '<button class="btn" id="runBtn" ' + (state.runBusy ? 'disabled' : '') + '>' +
    (state.runBusy ? 'Building… this can take a minute' : 'Run build &amp; download workbook') + '</button>' +
    (state.msg ? '<div class="msg ' + (state.msg.ok ? 'ok' : 'err') + '">' + escHtml(state.msg.text) + '</div>' : '') +
    '<p class="note">Every run reads live data — no rows are cached. Re-running later will ' +
    'reflect any customers who have since purchased, churned further, or changed contact ' +
    'details. See the workbook\\'s Notes &amp; QA tab for cleaning criteria, population ' +
    'reconciliation, and open sign-off items.</p>' +
    '</div></div>';
  document.getElementById("runBtn").onclick = runBuild;
}
function escHtml(v) {
  return String(v == null ? "" : v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function boot() {
  state.phase = "boot"; render();
  req("GET", "/auth/me").then(function (me) {
    if (!me || !(me.user_id || me.id) || (me.status && me.status !== "active")) {
      state.phase = "login"; render(); return;
    }
    state.user = me;
    var role = me.role;
    if (["admin","leadership","smt","customer_service"].indexOf(role) === -1) {
      state.phase = "forbidden"; render(); return;
    }
    state.phase = "app"; render();
  }).catch(function () { state.phase = "login"; render(); });
}
function doLogin(email, password) {
  state.loginBusy = true; state.loginError = null; render();
  req("POST", "/auth/login", { email: email, password: password }).then(function (data) {
    if (data && data.token) { try { localStorage.setItem("vivo_token", data.token); } catch (e) {} }
    state.loginBusy = false; boot();
  }).catch(function (e) {
    state.loginBusy = false; state.loginError = e.message || "Login failed"; render();
  });
}
function runBuild() {
  state.runBusy = true; state.msg = null; render();
  req("GET", "/project-reconnect/export.xlsx", undefined, true).then(function (res) {
    state.runBusy = false;
    state.msg = { ok: true, text: "Workbook generated — download started." };
    render();
    var url = URL.createObjectURL(res.blob);
    var a = document.createElement("a");
    a.href = url; a.download = res.filename; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
  }).catch(function (e) {
    state.runBusy = false;
    if (e.status === 401) { state.phase = "login"; render(); return; }
    if (e.status === 403) { state.phase = "forbidden"; render(); return; }
    state.msg = { ok: false, text: e.message || "Build failed" };
    render();
  });
}
boot();
</script>
</body>
</html>
"""


def register_project_reconnect_routes(app, api_pg_module):
    global A
    A = api_pg_module

    from fastapi import Request
    from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse

    @app.get("/reconnect")
    async def serve_project_reconnect_page():
        resp = HTMLResponse(content=_PAGE_HTML)
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp

    @app.get("/reconnect/{sub_path:path}")
    async def serve_project_reconnect_subpath(sub_path: str):
        return await serve_project_reconnect_page()

    @app.get("/api/project-reconnect/export.xlsx")
    async def project_reconnect_export(request: Request):
        user = getattr(request.state, "user", None) or {}
        actor_email = user.get("email")
        try:
            wb = await A.run_in_threadpool(run_full_build, actor_email)
        except Exception as e:
            log.exception("Project Reconnect build failed")
            return JSONResponse({"detail": f"Build failed: {e}"}, status_code=500)
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        filename = f"Project_Reconnect_{date.today().isoformat()}.xlsx"
        return StreamingResponse(
            buf,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
