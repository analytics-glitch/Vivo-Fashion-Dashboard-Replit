#!/usr/bin/env python3
"""
production_tracker_sheet_sync.py
---------------------------------
Governed, read-only ingestion of the "Production Tracker 2026" Google Sheet
into the Production Workspace.

Pipeline: fetch -> stage -> validate -> promote, all committed inside one
transaction per run. A run that fails to fetch (permission/network) or fails
validation catastrophically leaves the previously PUBLISHED metrics
untouched — the workspace always shows the last-known-good snapshot, never a
half-written one. Promotion is an idempotent upsert keyed by
(metric_group, dimension, period_type, period_key), never by run, so
re-running against unchanged source data never duplicates or drifts rows.

This module NEVER calls a Google Sheets write endpoint, regardless of the
OAuth scopes actually granted to the connector token — every request here is
a GET against .../values/{range}.

Two independent data paths feed the same tables:
  1. `run_seed()` — the one-time, dated baseline described in Task #1607,
     loaded verbatim from confirmed figures (source-updated 11 Aug 2026).
     Runs exactly once (a `trigger_kind='seed'` run already existing is a
     no-op), so it never clobbers a later live sync.
  2. `run_sync()` — the live sheet fetch + parse, used for both the manual
     "Sync now" action and the unattended daily-class schedule.

IMPORTANT — provisional live-sheet layout: as of this writing the target
spreadsheet has not yet been shared with the connector's Google identity
(a direct read probe returned 403 PERMISSION_DENIED), so the exact real
tab/row layout could not be confirmed against live data. The parser below
therefore works from a documented, reasonable convention (`_parse_summary_tab`,
`_parse_monthly_tab`, `_parse_process_tab`) driven by label-matching rather
than fixed cell coordinates, so it tolerates label wording drift and flags
(never silently drops) anything it can't confidently recognize. Once the
sheet is shared, calibrate the regexes/`tab_map` against the real layout —
the `production_tracker_sheet_sources.tab_map` column exists precisely so
that a tab-name mismatch can be fixed via the Setup panel, not a code change.

Run:
    python3 production_tracker_sheet_sync.py --seed-baseline
    python3 production_tracker_sheet_sync.py --scheduled
    python3 production_tracker_sheet_sync.py --manual --actor=<user id or name>
"""

import argparse
import calendar
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import execute_values
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("production_tracker_sheet_sync")

DATABASE_URL = os.environ["DATABASE_URL"]
SOURCE_KEY = "production_tracker_2026"
DEFAULT_SPREADSHEET_ID = "1DvwLrR980mcd9sj3fAbTxWDq4xDHGLlo3cX6AXko9U8"
DEFAULT_TAB_MAP = {"summary": "Summary", "monthly": "Monthly", "process": "Process"}
SYNC_CLAIM_KEY = "production_tracker_sheet_sync"
SYNC_CLAIM_TTL_MINUTES = 15
SCHEMA_MARKER = "-- Production Tracker Sheet Feed (governed Google Sheets ingestion)"


class SheetPermissionError(Exception):
    """The source sheet is not (yet) shared with the connector's identity."""


class SheetFetchError(Exception):
    """A transient/structural failure reading the sheet (not a permission issue)."""


# --------------------------------------------------------------------------- #
# Read-only Google Sheets client (mirrors the existing connector pattern;     #
# GET only, never a values:append/update/batchUpdate call).                  #
# --------------------------------------------------------------------------- #
def _connector_access_token(connector="google-sheet"):
    hostname = os.environ.get("REPLIT_CONNECTORS_HOSTNAME")
    if not hostname:
        raise RuntimeError("connectors host unavailable")
    repl_identity = os.environ.get("REPL_IDENTITY")
    web_renewal = os.environ.get("WEB_REPL_RENEWAL")
    if repl_identity:
        xtok = "repl " + repl_identity
    elif web_renewal:
        xtok = "depl " + web_renewal
    else:
        raise RuntimeError("no repl identity token available")
    r = requests.get(
        f"https://{hostname}/api/v2/connection",
        params={"include_secrets": "true", "connector_names": connector},
        headers={"Accept": "application/json", "X_REPLIT_TOKEN": xtok},
        timeout=20,
    )
    r.raise_for_status()
    items = (r.json() or {}).get("items") or []
    if not items:
        # The proxy's connector_names filter has been observed returning []
        # even for a healthy connection; fall back to an unfiltered list.
        r = requests.get(
            f"https://{hostname}/api/v2/connection",
            params={"include_secrets": "true"},
            headers={"Accept": "application/json", "X_REPLIT_TOKEN": xtok},
            timeout=20,
        )
        r.raise_for_status()
        items = [i for i in ((r.json() or {}).get("items") or [])
                 if (i.get("connector_name") or i.get("connectorName")) == connector]
    if not items:
        raise RuntimeError(f"no '{connector}' connection configured")
    s = items[0].get("settings") or {}
    tok = (s.get("access_token")
           or (((s.get("oauth") or {}).get("credentials") or {}).get("access_token")))
    if not tok:
        raise RuntimeError("connection has no access token")
    return tok


def _gsheet_values(sheet_id, tab, rng="A1:R400"):
    """GET-only read of a tab's cell matrix. Never issues a write call."""
    tok = _connector_access_token("google-sheet")
    range_q = requests.utils.quote(f"{tab}!{rng}", safe="")
    r = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}/values/{range_q}",
        headers={"Authorization": f"Bearer {tok}"},
        timeout=30,
    )
    if r.status_code in (401, 403, 404):
        raise SheetPermissionError(
            f"Cannot read tab '{tab}' of spreadsheet {sheet_id} (HTTP {r.status_code}). "
            "Share the sheet with the Replit Google Sheets connector's account "
            "(Share -> add that account as Viewer), or set link sharing to "
            "\"Anyone with the link - Viewer\", then try Sync now again."
        )
    r.raise_for_status()
    return (r.json() or {}).get("values") or []


def fetch_sheet_payload(spreadsheet_id, tab_map):
    """Fetch every configured tab. Raises SheetPermissionError distinctly
    from SheetFetchError so callers can render a "connection pending" state
    instead of a generic failure."""
    payload = {}
    for key, tab_name in (tab_map or DEFAULT_TAB_MAP).items():
        try:
            payload[key] = _gsheet_values(spreadsheet_id, tab_name)
        except SheetPermissionError:
            raise
        except RuntimeError as e:
            raise SheetPermissionError(str(e)) from e
        except requests.RequestException as e:
            raise SheetFetchError(f"Failed to read tab '{tab_name}': {e}") from e
    return payload


# --------------------------------------------------------------------------- #
# Singleflight claim (same pooler-safe pattern as sync_production_tracker.py) #
# --------------------------------------------------------------------------- #
def claim_sync():
    owner = uuid.uuid4().hex
    conn = psycopg2.connect(DATABASE_URL)
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS app_singleflight (
                    key TEXT PRIMARY KEY,
                    owner TEXT NOT NULL,
                    claimed_at TIMESTAMPTZ NOT NULL
                )
            """)
            cur.execute("""
                INSERT INTO app_singleflight (key, owner, claimed_at)
                VALUES (%s, %s, now())
                ON CONFLICT (key) DO UPDATE
                   SET owner = EXCLUDED.owner, claimed_at = now()
                 WHERE app_singleflight.claimed_at
                       < now() - (%s * interval '1 minute')
                RETURNING key
            """, (SYNC_CLAIM_KEY, owner, SYNC_CLAIM_TTL_MINUTES))
            won = cur.fetchone() is not None
        return conn, (owner if won else None)
    except Exception:
        conn.close()
        raise


def release_sync_claim(conn, owner):
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM app_singleflight WHERE key = %s AND owner = %s",
                (SYNC_CLAIM_KEY, owner),
            )
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Schema + source config                                                      #
# --------------------------------------------------------------------------- #
def ensure_schema(cur):
    """Idempotently create this feature's tables, executing the exact slice
    of production_tracker_schema.sql that defines them (single source of
    truth for the DDL, shared with production_workspace.py's own
    lazy-schema bootstrap)."""
    schema_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "production_tracker_schema.sql")
    with open(schema_path, encoding="utf-8") as f:
        schema_sql = f.read()
    idx = schema_sql.index(SCHEMA_MARKER)
    cur.execute(schema_sql[idx:])


def ensure_source(cur):
    cur.execute("""SELECT id, spreadsheet_id, tab_map, enabled, schedule_hint
                   FROM production_tracker_sheet_sources WHERE source_key=%s""",
                (SOURCE_KEY,))
    row = cur.fetchone()
    if row:
        return {"id": row[0], "spreadsheet_id": row[1], "tab_map": row[2] or {},
                "enabled": row[3], "schedule_hint": row[4]}
    cur.execute("""
        INSERT INTO production_tracker_sheet_sources
            (source_key, spreadsheet_id, tab_map, enabled, schedule_hint,
             created_by, updated_by)
        VALUES (%s,%s,%s::jsonb,TRUE,'daily','system','system')
        RETURNING id, spreadsheet_id, tab_map, enabled, schedule_hint
    """, (SOURCE_KEY, DEFAULT_SPREADSHEET_ID, json.dumps(DEFAULT_TAB_MAP)))
    row = cur.fetchone()
    return {"id": row[0], "spreadsheet_id": row[1], "tab_map": row[2] or {},
            "enabled": row[3], "schedule_hint": row[4]}


# --------------------------------------------------------------------------- #
# Parsing helpers                                                             #
# --------------------------------------------------------------------------- #
def _month_key(year, month):
    return f"{year}-{month:02d}"


def _working_days_in_month(period_key):
    year, month = (int(p) for p in period_key.split("-"))
    _, days_in_month = calendar.monthrange(year, month)
    return sum(1 for d in range(1, days_in_month + 1)
               if datetime(year, month, d).weekday() < 5)


def _parse_number(text):
    if text is None:
        return None
    t = str(text).strip().replace(",", "")
    if t == "" or t.lower() in {"-", "\u2014", "n/a", "na"}:
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _row_label(row):
    return (row[0] if row else "").strip() if row else ""


def _extract_year(label, default_year=2026):
    m = re.search(r"(20\d{2})", label)
    return int(m.group(1)) if m else default_year


SUMMARY_LABELS = [
    (re.compile(r"buying\s*quant", re.I), "annual_totals", "buying_quantity"),
    (re.compile(r"expected\s*output", re.I), "annual_totals", "expected_output"),
    (re.compile(r"in.?house", re.I), "annual_totals", "in_house"),
    (re.compile(r"outsourced", re.I), "annual_totals", "outsourced"),
    (re.compile(r"monthly\s*(production\s*)?plan", re.I), "annual_totals", "monthly_plan_rollup"),
    (re.compile(r"quarterly\s*plan", re.I), "annual_totals", "quarterly_plan_total"),
    (re.compile(r"dresses", re.I), "category_mix", "dresses"),
    (re.compile(r"\btops\b", re.I), "category_mix", "tops"),
    (re.compile(r"outerwear", re.I), "category_mix", "outerwear"),
    (re.compile(r"bottoms", re.I), "category_mix", "bottoms"),
    (re.compile(r"skirts", re.I), "category_mix", "skirts"),
    (re.compile(r"accessories", re.I), "category_mix", "accessories"),
    (re.compile(r"^men$|men.?s\b", re.I), "category_mix", "men"),
]


def _parse_summary_tab(rows, run_warnings):
    out = []
    for row in rows:
        label = _row_label(row)
        if not label:
            continue
        value_text = row[1] if len(row) > 1 else None
        value = _parse_number(value_text)
        matched = False
        for pattern, group, dim in SUMMARY_LABELS:
            if pattern.search(label):
                matched = True
                out.append({
                    "metric_group": group, "dimension": dim,
                    "period_type": "year", "period_key": "2026",
                    "raw_label": label, "raw_value_text": value_text,
                    "parsed_value": value, "is_available": value is not None,
                    "is_partial_period": False,
                    "source_label": label, "normalized_label": None,
                })
                break
        if not matched:
            run_warnings.append({
                "code": "unrecognized_sheet_row", "severity": "info",
                "message": f"Summary tab row not recognized and was not imported: {label!r}",
                "detail": {"tab": "summary", "label": label},
            })
    return out


MONTHLY_ROW_LABELS = [
    (re.compile(r"stitched.*actual.*2025|2025.*stitched.*actual", re.I), "stitched_output", "actual_prior_year"),
    (re.compile(r"stitched.*actual", re.I), "stitched_output", "actual"),
    (re.compile(r"stitched.*plan", re.I), "stitched_output", "plan"),
    (re.compile(r"transfer.*actual", re.I), "transfer_output", "actual"),
    (re.compile(r"transfer.*plan", re.I), "transfer_output", "plan"),
    (re.compile(r"wooven|woven", re.I), "fabric_mix", "woven"),
    (re.compile(r"knit", re.I), "fabric_mix", "knit"),
]


def _parse_monthly_tab(rows, as_of, run_warnings):
    out = []
    for row in rows:
        label = _row_label(row)
        if not label:
            continue
        year = _extract_year(label)
        matched = None
        for pattern, group, dim in MONTHLY_ROW_LABELS:
            if pattern.search(label):
                matched = (group, dim)
                break
        if not matched:
            run_warnings.append({
                "code": "unrecognized_sheet_row", "severity": "info",
                "message": f"Monthly tab row not recognized and was not imported: {label!r}",
                "detail": {"tab": "monthly", "label": label},
            })
            continue
        group, dim = matched
        normalized_label = "Woven" if (group, dim) == ("fabric_mix", "woven") else None
        for i, cell in enumerate(row[1:13], start=1):
            value = _parse_number(cell)
            period_key = _month_key(year, i)
            is_current_month = (year == as_of.year and i == as_of.month)
            out.append({
                "metric_group": group, "dimension": dim,
                "period_type": "month", "period_key": period_key,
                "raw_label": label, "raw_value_text": cell,
                "parsed_value": value, "is_available": value is not None,
                "is_partial_period": bool(value is not None and is_current_month),
                "source_label": label, "normalized_label": normalized_label,
            })
    return out


PROCESS_ROW_LABELS = [
    (re.compile(r"average\s*output\s*per\s*person|avg\s*output\s*per\s*person", re.I), None, None),
    (re.compile(r"stitch.*output", re.I), "stitched", "output"),
    (re.compile(r"stitch.*operator", re.I), "stitched", "operators"),
    (re.compile(r"cut.*output", re.I), "cut", "output"),
    (re.compile(r"cutt?ers?", re.I), "cut", "operators"),
    (re.compile(r"bundl.*output", re.I), "bundled", "output"),
    (re.compile(r"bundlers?", re.I), "bundled", "operators"),
    (re.compile(r"trim.*output", re.I), "trimmed", "output"),
    (re.compile(r"trimmers?", re.I), "trimmed", "operators"),
]

# Quality/defect rows are a distinct governed metric group ("quality_defects"),
# never folded into process_productivity. As of the confirmed baseline (11 Aug
# 2026) the sheet carries no defect data at all — see DEFECT_METRIC_DIMENSIONS
# below, which seeds those dimensions as explicitly unavailable rather than
# omitting the metric group entirely. If a future live sync's Process tab (or
# any other tab) DOES contain a row matching one of these labels, it is
# captured here rather than falling through to "unrecognized_sheet_row".
QUALITY_ROW_LABELS = [
    (re.compile(r"defect", re.I), "defect_units"),
    (re.compile(r"reject", re.I), "rejected_units"),
    (re.compile(r"rework", re.I), "reworked_units"),
]
DEFECT_METRIC_DIMENSIONS = ("defect_units", "rejected_units", "reworked_units")


def _parse_process_tab(rows, run_warnings):
    out = []
    raw_avg_rows = []
    for row in rows:
        label = _row_label(row)
        if not label:
            continue
        year = _extract_year(label)
        quality_dim = None
        for pattern, dim in QUALITY_ROW_LABELS:
            if pattern.search(label):
                quality_dim = dim
                break
        if quality_dim:
            for i, cell in enumerate(row[1:13], start=1):
                value = _parse_number(cell)
                out.append({
                    "metric_group": "quality_defects", "dimension": quality_dim,
                    "period_type": "month", "period_key": _month_key(year, i),
                    "raw_label": label, "raw_value_text": cell,
                    "parsed_value": value, "is_available": value is not None,
                    "is_partial_period": False,
                    "source_label": label, "normalized_label": None,
                })
            continue
        matched = None
        is_avg_row = False
        for pattern, proc, dim in PROCESS_ROW_LABELS:
            if pattern.search(label):
                if proc is None:
                    is_avg_row = True
                else:
                    matched = (proc, dim)
                break
        if is_avg_row:
            raw_avg_rows.append({"label": label, "values": row[1:13]})
            continue
        if not matched:
            run_warnings.append({
                "code": "unrecognized_sheet_row", "severity": "info",
                "message": f"Process tab row not recognized and was not imported: {label!r}",
                "detail": {"tab": "process", "label": label},
            })
            continue
        proc, dim = matched
        for i, cell in enumerate(row[1:13], start=1):
            value = _parse_number(cell)
            out.append({
                "metric_group": "process_productivity",
                "dimension": f"{proc}_{dim}",
                "period_type": "month", "period_key": _month_key(year, i),
                "raw_label": label, "raw_value_text": cell,
                "parsed_value": value, "is_available": value is not None,
                "is_partial_period": False,
                "source_label": label, "normalized_label": None,
            })

    # The sheet's own "Average Output per Person" formula is never trusted —
    # it does not reconcile against output / headcount. Always surface it as
    # a data-quality warning and compute our own value from the raw rows.
    if raw_avg_rows:
        run_warnings.append({
            "code": "broken_average_output_formula", "severity": "warning",
            "message": "The source sheet's 'Average Output per Person' formula is "
                        "internally broken (does not reconcile with output ÷ "
                        "headcount) and is never used; charts show an independently "
                        "computed output-per-operator-per-day figure instead.",
            "detail": {"source_rows": raw_avg_rows},
        })

    outputs = {r["period_key"]: r["parsed_value"] for r in out if r["dimension"] == "stitched_output"}
    heads = {r["period_key"]: r["parsed_value"] for r in out if r["dimension"] == "stitched_operators"}
    for period_key, output in outputs.items():
        headcount = heads.get(period_key)
        wd = _working_days_in_month(period_key)
        computed = (round(output / headcount / wd, 2)
                    if (output is not None and headcount and wd) else None)
        out.append({
            "metric_group": "process_productivity",
            "dimension": "stitched_output_per_operator_day",
            "period_type": "month", "period_key": period_key,
            "raw_label": "(computed) stitched output \u00f7 operators \u00f7 working days",
            "raw_value_text": None,
            "parsed_value": computed, "is_available": computed is not None,
            "is_partial_period": False,
            "source_label": None, "normalized_label": None,
        })
    return out


def parse_payload(payload, as_of):
    warnings = []
    rows = []
    if "summary" in payload:
        rows.extend(_parse_summary_tab(payload["summary"], warnings))
    if "monthly" in payload:
        rows.extend(_parse_monthly_tab(payload["monthly"], as_of, warnings))
    if "process" in payload:
        rows.extend(_parse_process_tab(payload["process"], warnings))
    return rows, warnings


def validate(rows):
    """Row-level validation. A quarantined row is excluded from promotion but
    still recorded in staging with its reason — it never blocks the rest of
    the run."""
    for r in rows:
        if r.get("is_available") and r.get("parsed_value") is None:
            r["validation_status"] = "quarantined"
            r["validation_reason"] = "marked available but no parseable numeric value"
        elif r.get("parsed_value") is not None and r["parsed_value"] < 0:
            r["validation_status"] = "quarantined"
            r["validation_reason"] = "negative value is implausible for a production count"
        else:
            r["validation_status"] = "ok"
            r["validation_reason"] = None
    return rows


# --------------------------------------------------------------------------- #
# Confirmed baseline seed (source-updated 11 Aug 2026)                        #
# --------------------------------------------------------------------------- #
ANNUAL_TOTALS = {
    "buying_quantity": 422533,
    "expected_output": 402413,
    "in_house": 362171.70,
    "outsourced": 40241.30,
    "monthly_plan_rollup": 387960,
    "quarterly_plan_total": 374780,
}
CATEGORY_MIX_2026 = {
    "dresses": 144869, "tops": 104627, "outerwear": 80483, "bottoms": 50704,
    "skirts": 12072, "accessories": 8048, "men": 1610,
}
STITCHED_ACTUAL_2026 = [21754, 26001, 28806, 29622, 27538, 24091, 27436, 4559]  # Jan-Aug, Aug partial
STITCHED_PLAN_2026 = [28800, 28800, 28800, 30800, 30210, 33390, 36570, 33390, 34980, 33390, 33390, 22260]
STITCHED_ACTUAL_2025 = [19300, 16594, 21653, 24474, 18639, 26933, 32438, 22659, 28739, 22849, 30019, 18037]
TRANSFER_ACTUAL_2026 = [17504, 27492, 28715, 30289, 27012, 24817, 27104, 5121]  # Jan-Aug, Aug partial
TRANSFER_PLAN_2026 = [27500, 27500, 27500, 27500, 28700, 31721, 34742, 31721, 33231, 31721, 31721, 21147]
KNIT_ACTUAL_2026 = [9754, 9354, 10599, 16281, 15145, 10956, 10637]  # Jan-Jul only
WOVEN_ACTUAL_2026 = [11989, 16660, 18207, 13341, 13223, 13283, 14499]  # Jan-Jul only, source label "Wooven"
PROCESS_2026 = {  # Jan-May only
    "stitched": {"output": [21754, 26001, 28806, 29622, 27538],
                 "operators": [95, 94, 96, 91, 99],
                 "output_per_operator_day": [11, 14, 14, 16, 14]},
    "cut": {"output": [21666, 28216, 34461, 29068, 31449], "operators": [8, 8, 8, 7, 8]},
    "bundled": {"output": [19700, 27979, 33298, 29662, 29602], "operators": [6, 5, 6, 5, 6]},
    "trimmed": {"output": [19550, 26163, 30215, 29572, 26380], "operators": [6, 7, 7, 7, 7]},
}


def baseline_seed_rows():
    rows = []

    def add(metric_group, dimension, period_type, period_key, value,
            is_available=True, is_partial=False, source_label=None, normalized_label=None):
        rows.append({
            "metric_group": metric_group, "dimension": dimension,
            "period_type": period_type, "period_key": period_key,
            "raw_label": source_label, "raw_value_text": (str(value) if value is not None else None),
            "parsed_value": value, "is_available": is_available,
            "is_partial_period": is_partial,
            "source_label": source_label, "normalized_label": normalized_label,
        })

    for dim, val in ANNUAL_TOTALS.items():
        add("annual_totals", dim, "year", "2026", val)
    for dim, val in CATEGORY_MIX_2026.items():
        add("category_mix", dim, "year", "2026", val)

    for i, val in enumerate(STITCHED_ACTUAL_2026, start=1):
        add("stitched_output", "actual", "month", _month_key(2026, i), val, is_partial=(i == 8))
    for m in range(len(STITCHED_ACTUAL_2026) + 1, 13):
        add("stitched_output", "actual", "month", _month_key(2026, m), None, is_available=False)
    for i, val in enumerate(STITCHED_PLAN_2026, start=1):
        add("stitched_output", "plan", "month", _month_key(2026, i), val)
    for i, val in enumerate(STITCHED_ACTUAL_2025, start=1):
        add("stitched_output", "actual_prior_year", "month", _month_key(2025, i), val)

    for i, val in enumerate(TRANSFER_ACTUAL_2026, start=1):
        add("transfer_output", "actual", "month", _month_key(2026, i), val, is_partial=(i == 8))
    for m in range(len(TRANSFER_ACTUAL_2026) + 1, 13):
        add("transfer_output", "actual", "month", _month_key(2026, m), None, is_available=False)
    for i, val in enumerate(TRANSFER_PLAN_2026, start=1):
        add("transfer_output", "plan", "month", _month_key(2026, i), val)

    for i, val in enumerate(KNIT_ACTUAL_2026, start=1):
        add("fabric_mix", "knit", "month", _month_key(2026, i), val,
            source_label="Knit", normalized_label="Knit")
    add("fabric_mix", "knit", "month", _month_key(2026, 8), None, is_available=False,
        source_label="Knit", normalized_label="Knit")
    for i, val in enumerate(WOVEN_ACTUAL_2026, start=1):
        add("fabric_mix", "woven", "month", _month_key(2026, i), val,
            source_label="Wooven", normalized_label="Woven")
    add("fabric_mix", "woven", "month", _month_key(2026, 8), None, is_available=False,
        source_label="Wooven", normalized_label="Woven")

    for proc, d in PROCESS_2026.items():
        for i, val in enumerate(d["output"], start=1):
            add("process_productivity", f"{proc}_output", "month", _month_key(2026, i), val)
        for i, val in enumerate(d["operators"], start=1):
            add("process_productivity", f"{proc}_operators", "month", _month_key(2026, i), val)
        if "output_per_operator_day" in d:
            for i, val in enumerate(d["output_per_operator_day"], start=1):
                add("process_productivity", f"{proc}_output_per_operator_day", "month",
                    _month_key(2026, i), val)

    # The confirmed baseline (source-updated 11 Aug 2026) carries no defect,
    # reject or rework figures anywhere in the sheet. That absence is a fact
    # about the source, not a zero — every dimension of the governed
    # "quality_defects" metric group is explicitly recorded as unavailable
    # for every month the rest of the feed covers (Jan-Aug 2026, matching the
    # stitched-output actual window), so the Setup panel/UI can say "not
    # available" rather than simply having nothing to query. A live sync that
    # later finds a real Defects/Rejects/Rework row (see QUALITY_ROW_LABELS)
    # will overwrite these placeholders via the normal idempotent upsert.
    for dim in DEFECT_METRIC_DIMENSIONS:
        for i in range(1, len(STITCHED_ACTUAL_2026) + 1):
            add("quality_defects", dim, "month", _month_key(2026, i), None,
                is_available=False,
                source_label="Not present in Production Tracker 2026 (baseline as of 11 Aug 2026)")

    validate(rows)

    warnings = [
        {
            "code": "conflicting_annual_totals", "severity": "warning",
            "message": "The source sheet states three different totals for annual "
                        "production plan/output that do not reconcile. All three are "
                        "shown side by side rather than picking or averaging one.",
            "detail": {
                "annual_expected_output": ANNUAL_TOTALS["expected_output"],
                "monthly_plan_rollup_total": ANNUAL_TOTALS["monthly_plan_rollup"],
                "quarterly_plan_total": ANNUAL_TOTALS["quarterly_plan_total"],
            },
        },
        {
            "code": "broken_average_output_formula", "severity": "warning",
            "message": "The source sheet's 'Average Output per Person' formula is "
                        "internally broken (does not reconcile with output \u00f7 "
                        "headcount for the baseline period) and is not used. "
                        "Operator Productivity shows an independently computed "
                        "output-per-operator-per-day figure instead.",
            "detail": {"source": "Production Tracker 2026, baseline as of 11 Aug 2026"},
        },
    ]
    return rows, warnings


# --------------------------------------------------------------------------- #
# Staging / promotion                                                         #
# --------------------------------------------------------------------------- #
def stage_rows(cur, run_id, rows):
    if not rows:
        return
    execute_values(cur, """
        INSERT INTO production_tracker_sheet_staging_metrics
            (run_id, metric_group, dimension, period_type, period_key,
             raw_label, raw_value_text, parsed_value, is_available,
             is_partial_period, validation_status, validation_reason)
        VALUES %s
    """, [
        (run_id, r["metric_group"], r["dimension"], r["period_type"], r["period_key"],
         r.get("raw_label"), r.get("raw_value_text"), r.get("parsed_value"),
         bool(r.get("is_available")), bool(r.get("is_partial_period")),
         r.get("validation_status", "ok"), r.get("validation_reason"))
        for r in rows
    ])


def promote(cur, run_id, rows):
    ok_rows = [r for r in rows if r.get("validation_status", "ok") == "ok"]
    if not ok_rows:
        return 0
    execute_values(cur, """
        INSERT INTO production_tracker_sheet_metrics
            (metric_group, dimension, period_type, period_key, value,
             is_available, is_partial_period, source_label, normalized_label,
             source_run_id, version_token, updated_at)
        VALUES %s
        ON CONFLICT (metric_group, dimension, period_type, period_key) DO UPDATE
            SET value = EXCLUDED.value,
                is_available = EXCLUDED.is_available,
                is_partial_period = EXCLUDED.is_partial_period,
                source_label = EXCLUDED.source_label,
                normalized_label = EXCLUDED.normalized_label,
                source_run_id = EXCLUDED.source_run_id,
                version_token = production_tracker_sheet_metrics.version_token + 1,
                updated_at = now()
    """, [
        (r["metric_group"], r["dimension"], r["period_type"], r["period_key"],
         r.get("parsed_value"), bool(r.get("is_available")), bool(r.get("is_partial_period")),
         r.get("source_label"), r.get("normalized_label"), run_id, 1)
        for r in ok_rows
    ], template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())")
    return len(ok_rows)


def record_warnings(cur, run_id, warnings):
    for w in warnings:
        cur.execute("""
            INSERT INTO production_tracker_sheet_warnings (run_id, code, severity, message, detail)
            VALUES (%s,%s,%s,%s,%s::jsonb)
        """, (run_id, w["code"], w.get("severity", "warning"), w["message"],
              json.dumps(w.get("detail") or {})))


def _finish_run(conn, run_id, status, error_message=None, row_count=None, warning_count=None, promoted=False):
    with conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE production_tracker_sheet_sync_runs
                   SET status=%s, finished_at=now(), error_message=%s,
                       row_count=COALESCE(%s, row_count),
                       warning_count=COALESCE(%s, warning_count),
                       promoted=%s
                 WHERE id=%s
            """, (status, error_message, row_count, warning_count, promoted, run_id))


# --------------------------------------------------------------------------- #
# Entry points                                                                #
# --------------------------------------------------------------------------- #
def run_seed(actor=None):
    """One-time, dated baseline load. No-ops if a seed run already exists."""
    claim_conn, owner = claim_sync()
    if owner is None:
        claim_conn.close()
        log.info("Seed skipped: another sync/seed is currently running")
        return {"status": "skipped_running"}
    try:
        conn = psycopg2.connect(DATABASE_URL)
        try:
            with conn:
                with conn.cursor() as cur:
                    ensure_schema(cur)
                    source = ensure_source(cur)
                    cur.execute("""
                        SELECT id FROM production_tracker_sheet_sync_runs
                         WHERE source_id=%s AND trigger_kind='seed' LIMIT 1
                    """, (source["id"],))
                    already = cur.fetchone()
            if already:
                log.info("Baseline seed already loaded (run id %s); no-op", already[0])
                return {"status": "already_seeded", "run_id": already[0]}

            rows, warnings = baseline_seed_rows()
            with conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        INSERT INTO production_tracker_sheet_sync_runs
                            (source_id, run_key, trigger_kind, triggered_by, status,
                             source_updated_label)
                        VALUES (%s,%s,'seed',%s,'running','2026-08-11')
                        RETURNING id
                    """, (source["id"], uuid.uuid4().hex, actor or "system"))
                    run_id = cur.fetchone()[0]
                    stage_rows(cur, run_id, rows)
                    promoted = promote(cur, run_id, rows)
                    record_warnings(cur, run_id, warnings)
                    cur.execute("""
                        UPDATE production_tracker_sheet_sync_runs
                           SET status='ok', finished_at=now(), row_count=%s,
                               warning_count=%s, promoted=TRUE
                         WHERE id=%s
                    """, (len(rows), len(warnings), run_id))
            log.info("Baseline seed loaded: %s staged rows (%s promoted), %s warnings",
                      len(rows), promoted, len(warnings))
            return {"status": "ok", "run_id": run_id, "row_count": len(rows),
                    "warning_count": len(warnings), "promoted_count": promoted}
        finally:
            conn.close()
    finally:
        release_sync_claim(claim_conn, owner)


def run_sync(trigger_kind, actor=None):
    """Live fetch -> stage -> validate -> promote. trigger_kind is 'manual' or 'scheduled'."""
    claim_conn, owner = claim_sync()
    if owner is None:
        claim_conn.close()
        log.info("Sync already running; skipping duplicate %s request", trigger_kind)
        return {"status": "skipped_running"}
    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                ensure_schema(cur)
                source = ensure_source(cur)
        if not source["enabled"]:
            log.info("Source disabled; skipping %s sync", trigger_kind)
            return {"status": "disabled"}

        with conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO production_tracker_sheet_sync_runs
                        (source_id, run_key, trigger_kind, triggered_by, status)
                    VALUES (%s,%s,%s,%s,'running') RETURNING id
                """, (source["id"], uuid.uuid4().hex, trigger_kind, actor))
                run_id = cur.fetchone()[0]

        try:
            payload = fetch_sheet_payload(source["spreadsheet_id"], source["tab_map"])
        except SheetPermissionError as e:
            _finish_run(conn, run_id, "connection_pending", error_message=str(e))
            log.warning("Sheet sync connection pending: %s", e)
            return {"status": "connection_pending", "run_id": run_id, "detail": str(e)}
        except SheetFetchError as e:
            _finish_run(conn, run_id, "failed", error_message=str(e))
            log.error("Sheet sync fetch failed: %s", e)
            return {"status": "failed", "run_id": run_id, "detail": str(e)}

        as_of = datetime.now(timezone.utc).date()
        rows, warnings = parse_payload(payload, as_of)
        validate(rows)
        try:
            with conn:
                with conn.cursor() as cur:
                    stage_rows(cur, run_id, rows)
                    promoted = promote(cur, run_id, rows)
                    record_warnings(cur, run_id, warnings)
                    cur.execute("""
                        UPDATE production_tracker_sheet_sync_runs
                           SET status='ok', finished_at=now(), row_count=%s,
                               warning_count=%s, promoted=TRUE
                         WHERE id=%s
                    """, (len(rows), len(warnings), run_id))
            log.info("Sheet sync ok: %s rows (%s promoted), %s warnings",
                      len(rows), promoted, len(warnings))
            return {"status": "ok", "run_id": run_id, "row_count": len(rows),
                    "warning_count": len(warnings), "promoted_count": promoted}
        except Exception as e:  # noqa: BLE001 - must record and preserve last-known-good
            _finish_run(conn, run_id, "failed", error_message=str(e))
            log.exception("Sheet sync failed during validate/promote")
            return {"status": "failed", "run_id": run_id, "detail": str(e)}
    finally:
        conn.close()
        release_sync_claim(claim_conn, owner)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seed-baseline", action="store_true", help="Load the one-time confirmed baseline dataset")
    ap.add_argument("--scheduled", action="store_true", help="Run as the unattended daily-class sync")
    ap.add_argument("--manual", action="store_true", help="Run as an authorized user's manual Sync now")
    ap.add_argument("--actor", default=None, help="Actor id/name for manual runs (audit trail)")
    args = ap.parse_args()

    if args.seed_baseline:
        result = run_seed(actor=args.actor)
    elif args.manual:
        result = run_sync("manual", actor=args.actor)
    else:
        result = run_sync("scheduled", actor=args.actor)

    log.info("Result: %s", result)
    if result.get("status") == "failed":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
