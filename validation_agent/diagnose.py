"""Step 3 -- LLM diagnosis of each flagged exception.

Calls the Anthropic Messages API (default model claude-sonnet-4-6). The key is
read from ANTHROPIC_API_KEY if the user supplied their own, otherwise from the
Replit-managed Anthropic integration. Diagnosis never blocks a run: any failure
is captured as an inconclusive result.
"""
import json

import requests

from . import config

SYSTEM = (
    "You are a financial data-quality auditor for a retail group. Given a flagged "
    "metric, its expected range and the underlying rows, classify it as a DATA ERROR "
    "or a REAL BUSINESS EVENT, explain the most likely cause in two sentences, and if "
    "it is a data error propose an exact PostgreSQL fix. Never invent figures. If the "
    "rows are insufficient to decide, say so and state what additional data you need.\n\n"
    "Facts about this data model (all_sales) — do NOT diagnose these as errors:\n"
    "- all_sales is LINE-ITEM grain: one row per product line, so the same order_id "
    "appearing on many rows is one multi-item order, NOT duplication or fan-out. "
    "Distinguish lines by variant_sku: rows sharing an order_id but with different "
    "variant_sku values (or the same price on different SKUs) are distinct items. "
    "A large order (15+ distinct SKUs) is a normal bulk purchase. Only identical "
    "(order_id, variant_sku, amount) rows suggest duplication.\n"
    "- Returns are SEPARATE rows (sale_kind='return') with the refunded amount in "
    "returns_kes and total/net = 0. Order rows normally carry returns_kes = 0; a "
    "day's return_amount comes from its return rows, not from the order rows shown.\n"
    "- Rows with sale_kind='order' and NEGATIVE amounts are the POS refund "
    "convention (a refund posted as a negative order line). They are systematic and "
    "expected, not corruption.\n"
    "- total_sales_kes is VAT-inclusive; net_sales_kes is VAT-exclusive. They are "
    "not supposed to match.\n"
    "- Metrics are computed under the dashboard's reporting filters (internal "
    "locations, gift cards/vouchers, shopping bags excluded) and the sample rows "
    "are filtered the same way.\n"
    "Only propose a SQL fix for genuine corruption (e.g. the same order_id + SKU + "
    "amount duplicated by a double-loaded batch, impossible values, orphaned rows). "
    "When the rows are consistent with a busy trading day, a bulk order or a large "
    "legitimate return, classify it as REAL_BUSINESS_EVENT."
)

_TOOL = {
    "name": "record_diagnosis",
    "description": "Record the structured diagnosis of the flagged metric.",
    "input_schema": {
        "type": "object",
        "properties": {
            "classification": {
                "type": "string",
                "enum": ["DATA_ERROR", "REAL_BUSINESS_EVENT", "INSUFFICIENT_DATA"],
            },
            "cause": {"type": "string", "description": "At most two sentences."},
            "proposed_fix_sql": {
                "type": "string",
                "description": "Exact PostgreSQL statement, or empty if not a data error.",
            },
            "confidence": {"type": "number"},
            "needed_data": {"type": "string"},
        },
        "required": ["classification", "cause"],
    },
}


def _endpoint_and_key():
    if config.ANTHROPIC_API_KEY:
        return "https://api.anthropic.com/v1/messages", config.ANTHROPIC_API_KEY
    if config.ANTHROPIC_BASE and config.ANTHROPIC_PROXY_KEY:
        return config.ANTHROPIC_BASE.rstrip("/") + "/v1/messages", config.ANTHROPIC_PROXY_KEY
    return None, None


def diagnose(exc: dict, raw_rows: list[dict]) -> dict:
    url, key = _endpoint_and_key()
    if not url:
        return {"classification": "INSUFFICIENT_DATA",
                "cause": "LLM diagnosis disabled (no Anthropic credentials configured).",
                "confidence": 0.0}

    context = {
        "metric": exc.get("metric"),
        "entity": f'{exc.get("entity_type")}:{exc.get("entity")}',
        "subcategory": exc.get("subcategory"),
        "period_date": str(exc.get("period_date")),
        "observed_value": exc.get("observed"),
        "expected_low": exc.get("expected_low"),
        "expected_high": exc.get("expected_high"),
        "broken_identity": exc.get("broken_identity"),
        "tier": exc.get("tier"),
        "currency": "KES",
        "sample_rows": raw_rows[:25],
    }
    body = {
        "model": config.LLM_MODEL,
        "max_tokens": 1024,
        "system": SYSTEM,
        "tools": [_TOOL],
        "tool_choice": {"type": "tool", "name": "record_diagnosis"},
        "messages": [{
            "role": "user",
            "content": "Diagnose this flagged retail metric.\n\n"
                       + json.dumps(context, default=str, indent=2),
        }],
    }
    try:
        r = requests.post(
            url,
            headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json=body, timeout=config.LLM_TIMEOUT_SEC,
        )
        if r.status_code != 200:
            return {"classification": "INSUFFICIENT_DATA",
                    "cause": f"LLM call failed ({r.status_code}): {r.text[:200]}",
                    "confidence": 0.0}
        data = r.json()
        for block in data.get("content", []):
            if block.get("type") == "tool_use":
                return block.get("input", {})
        text = " ".join(b.get("text", "") for b in data.get("content", [])
                        if b.get("type") == "text")
        return {"classification": "INSUFFICIENT_DATA",
                "cause": text[:400] or "No structured diagnosis returned.",
                "confidence": 0.0}
    except Exception as e:  # noqa: BLE001
        return {"classification": "INSUFFICIENT_DATA",
                "cause": f"LLM call error: {e}", "confidence": 0.0}


def sample_rows(conn, exc: dict, limit: int = 25) -> list[dict]:
    from . import db
    # Sample under the SAME reporting scope the metrics are computed with, so the
    # LLM sees the rows that actually make up the flagged number (an excluded
    # gift-card or staff-purchase line would otherwise mislead the diagnosis).
    where = [config.REPORTING_FILTERS.strip(), "sale_date::date = %(d)s"]
    params = {"d": exc.get("period_date"), "lim": limit}
    if exc.get("entity_type") == "store":
        where.append("pos_location_name = %(ent)s")
        params["ent"] = exc.get("entity")
    if exc.get("subcategory") and exc.get("subcategory") not in ("__ALL__", None):
        where.append("COALESCE(NULLIF(TRIM(product_type),''),'(unspecified)') = %(sub)s")
        params["sub"] = exc.get("subcategory")
    sql = f"""
        SELECT order_id, sale_kind, variant_sku, product_type, pos_location_name,
               total_sales_kes, net_sales_kes, gross_sales_kes,
               discounts_kes, returns_kes, ordered_item_quantity
        FROM all_sales
        WHERE {' AND '.join(where)}
        ORDER BY ABS(COALESCE(total_sales_kes,0)) DESC
        LIMIT %(lim)s
    """
    try:
        with db.cursor(conn) as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]
    except Exception:
        return []
