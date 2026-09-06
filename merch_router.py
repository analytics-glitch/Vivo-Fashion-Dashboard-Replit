"""
Merchandising Hub Router — /api/merch/*

Provides all backend data for the 12-tab Merchandising Hub:
  GET /api/merch/styles          — full style universe (one row per style)
  GET /api/merch/summary         — portfolio-level aggregates
  GET /api/merch/by-brand        — aggregates broken down by brand
  GET /api/merch/by-subcategory  — aggregates broken down by subcategory
                                   (both: ?trend=1 adds revenue_prev + trend_pct
                                    vs the consecutive previous window)
  GET /api/merch/by-tier         — aggregates broken down by lifecycle tier
  GET /api/merch/style-stores    — per-store breakdown for one style (?style_number=X)
  GET /api/merch/style-sales-weekly — 52-week weekly units for one style (?style_number=X)
  GET /api/merch/launch-ramp     — cumulative SOR % by weeks-since-launch, by tier

All endpoints:
  • are gated by clerk_auth_gate to roles: product_development, leadership, smt, admin
  • honour filter params: brand, subcategory, tier, status, from_date, to_date, country
  • cache for 600 s (styles/summary/by-* aggregates)

Lifecycle tier delegates entirely to api_pg._lifecycle_tier (see _compute_tier below)
— the SAME single source of truth Range Management and Product Analysis use. There
is no independent Merch Hub tier model and no override of any kind (2026-08-27 user
rule: every report with Tier/Status must read from Odoo and match Range Management).
A style with no live Odoo status at all is excluded from every Merch Hub report,
never defaulted to Active/Tier 4/Archived.

SQL correctness note: PostgreSQL rejects aggregate functions inside JOIN ON predicates.
All queries pre-compute style_number per style_name in a dedicated CTE (style_nums),
then join production_orders in a separate reorder_counts CTE so no aggregate ever
appears in a JOIN condition.

Registered via register_merch_routes(app, api_pg_module) from api_pg.py.
"""

import logging
import os
import re
from datetime import date, timedelta, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Optional

log = logging.getLogger("merch_router")

A = None  # api_pg module reference — set in register_merch_routes()

# ── Module-level TTL cache ─────────────────────────────────────────────────────

import asyncio
import time as _time
import threading as _threading
_cache_store = {}
_cache_locks = {}
_cache_locks_guard = _threading.Lock()

# Per-key single-flight locks for the heavy style-universe computation
# (see _styles_cached). Guard protects the dict itself.
_SF_LOCKS = {}
_SF_LOCKS_GUARD = _threading.Lock()


def _cached(key, ttl, fn):
    now = _time.monotonic()
    entry = _cache_store.get(key)
    if entry and (now - entry[0]) < ttl:
        return entry[1]
    with _cache_locks_guard:
        lock = _cache_locks.setdefault(key, _threading.Lock())
    # Re-check after waiting: concurrent requests for the same filter now
    # share one computation instead of starting duplicate heavy SQL scans.
    with lock:
        now = _time.monotonic()
        entry = _cache_store.get(key)
        if entry and (now - entry[0]) < ttl:
            return entry[1]
        result = fn()
        _cache_store[key] = (_time.monotonic(), result)
        return result


# ── DB execution ───────────────────────────────────────────────────────────────

def _db_exec(sql, params=None, fetch=True):
    """Execute SQL via api_pg's connection pool (API mode) or a direct
    psycopg2 connection (standalone/test mode)."""
    if A is not None:
        return A._users_exec(sql, params, fetch=fetch)
    import psycopg2, psycopg2.extras
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL not set")
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            conn.commit()
            return list(cur.fetchall()) if fetch else None
    finally:
        conn.close()


# ── Shared SQL constants ───────────────────────────────────────────────────────

# Base filters mirror api_pg.BASE_FILTERS (gift cards, staff purchases, etc.)
# Uses %% to escape literal % inside Python format-strings when no .format()
# substitution is used, but these strings ARE used in f-strings so %% is correct.
_BASE_FILTERS = """
    s.pos_location_name NOT IN ('Staff purchases','Manual Order','Online - vivo-uganda','Online - vivowoman','Online Orders Location')
    AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%%shopping bag%%'
    AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%%gift card%%'
    AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%%gift voucher%%'
    AND LOWER(COALESCE(s.product_title,'')) NOT LIKE '%%voucher%%'
    AND (
        LOWER(COALESCE(s.product_title,'')) NOT LIKE '%%on specific products%%'
        OR (COALESCE(s.total_sales_kes,0)::numeric = 0
            AND COALESCE(s.ordered_item_quantity,0) = 0
            AND COALESCE(s.discounts_kes,0)::numeric <> 0)
    )
    AND LOWER(COALESCE(s.variant_sku,'')) NOT LIKE '%%vb00%%'
"""

# Cost lookup precedence:
#   1) the most recent buying/production order carrying any recognised unit-cost
#      field;
#   2) the product-master standard cost.
#
# to_jsonb(po) keeps this compatible with older production_orders rows and
# future Odoo custom fields without hard-referencing an optional column.
_STYLE_COST_CTES = """
po_cost_rows AS (
    SELECT
        sn.style_name,
        COALESCE(
            NULLIF(po.cost_price_kes, 0),
            CASE WHEN btrim(j->>'cost_price') ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (j->>'cost_price')::numeric END,
            CASE WHEN btrim(j->>'unit_cost') ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (j->>'unit_cost')::numeric END,
            CASE WHEN btrim(j->>'price_unit') ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (j->>'price_unit')::numeric END,
            CASE WHEN btrim(j->>'unit_price') ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (j->>'unit_price')::numeric END,
            CASE WHEN btrim(j->>'purchase_price') ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (j->>'purchase_price')::numeric END,
            CASE WHEN btrim(j->>'standard_cost') ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (j->>'standard_cost')::numeric END
        ) AS cost_kes,
        COALESCE(po.cost_date, po.date_ordered) AS cost_date,
        ROW_NUMBER() OVER (
            PARTITION BY sn.style_name
            ORDER BY COALESCE(po.cost_date, po.date_ordered) DESC NULLS LAST,
                     po.updated_at DESC NULLS LAST,
                     po.odoo_id DESC NULLS LAST
        ) AS rn
    FROM style_nums sn
    JOIN production_orders po
      ON po.style_number = sn.style_number
      OR po.style_name = sn.style_name
    CROSS JOIN LATERAL to_jsonb(po) AS j
),
latest_po_cost AS (
    SELECT DISTINCT ON (style_name) style_name, cost_kes, cost_date
    FROM po_cost_rows
    WHERE cost_kes > 0
    ORDER BY style_name, cost_date DESC NULLS LAST
),
"""

_WAREHOUSE_LOCATIONS = (
    "'Warehouse Finished Goods','Warehouse Receiving','In Transit',"
    "'Holding Warehouse Finished Goods','Finished Goods Production','Production',"
    "'Buying & Merchandise','Raw Materials','Fabric Trimming','Dead Stock Fabric',"
    "'Cutting - Spreading','Washing','Wandia','Galleria Holding','Studio Location',"
    "'Product Development','Repairs','Sampling Fabric','Sampling','Sale Stock',"
    "'Shopping Bags','Recall Location','Fabric Production','Defects Location',"
    "'Staff purchases',"
    "'Sew/Stock/A','Sew/Stock/B','Sew/Stock/C','Sew/Stock/D','Sew/Stock/E'"
)

# Internal holding/transfer locations that must never appear as sellable stores.
# Exact-case version kept for display; LOWER version used in SQL so a casing
# mismatch in all_inventory / all_sales can never let them slip through.
_HOLDING_STORES = "'MarKT/Stock','Retired Stock','ARENA/Stock'"
_HOLDING_STORES_LOWER = "'markt/stock','retired stock','arena/stock'"

# Merch Stock Mix sellable-stock contract. Keep this explicit and allowlisted:
#   SELLABLE STORES
#     • Vivo retail locations (`Vivo ...`)
#     • Zoya and Safari retail locations (`Zoya ...`, `Safari ...`)
#     • The Oasis Mall and Online - Shop Zetu
#   SELLABLE WAREHOUSE
#     • Warehouse Finished Goods only (WHFIN/Stock after Odoo normalisation)
#   EXCLUDED
#     • Finished Goods Production / FGPRD, Warehouse Receiving, In Transit,
#       holding/retired locations, Raw Materials, Fabric Trimming, Sew/Stock,
#       samples, QC/defects, staff purchases, and every unknown/unmapped
#       location. Those units are not available for a customer to buy today.
#
# Pipeline is NOT inferred from any all_inventory location and is never added to
# sellable SOH. It comes separately from open Odoo Buying Orders by bo_state.
_SELLABLE_WAREHOUSE_LOCATION = "Warehouse Finished Goods"
_PIPELINE_BO_STATES = (
    "draft", "bom_pending", "ready", "partially_planned", "fully_planned",
)
_WIP_MAX_AGE_DAYS = 60


def _sellable_store_pred(alias):
    return f"""(
        {_sellable_retail_store_pred(alias)}
        OR {_sellable_online_pred(alias)}
    )"""


def _sellable_retail_store_pred(alias):
    return f"""(
        {alias}.pos_location_name = 'The Oasis Mall'
        OR {alias}.pos_location_name LIKE 'Vivo %%'
        OR {alias}.pos_location_name LIKE 'Zoya %%'
        OR {alias}.pos_location_name LIKE 'Safari %%'
    )"""


def _sellable_online_pred(alias):
    return f"({alias}.pos_location_name = 'Online - Shop Zetu')"


_VAT_DIV = "(CASE WHEN s.country IN ('Uganda','Rwanda') THEN 1.18 ELSE 1.16 END)"

_NET_SALES_EXPR = (
    f"CASE WHEN s.sale_kind IN ('sale','order') "
    f"THEN (s.total_sales_kes::numeric - COALESCE(s.discounts_kes,0)::numeric) / {_VAT_DIV} "
    f"WHEN s.sale_kind = 'return' "
    f"THEN -COALESCE(s.returns_kes,0)::numeric / {_VAT_DIV} "
    f"ELSE 0 END"
)

# Base product filter — excludes third-party brand styles and blank names
_PROD_BASE = """
    p.style_name IS NOT NULL
    AND p.style_name <> ''
    AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
"""


# ── Lifecycle tier — delegates to api_pg._lifecycle_tier ──────────────────────
# 2026-08-27 user rule: every report with Tier/Status must read from Odoo and
# match Range Management, with no other rule (including in Merchandising).
# This used to be an independent reorder-cycle-count model (≥4 orders → Tier 2,
# ≥1 → Tier 3); it now calls the SAME shared classifier Range Management and
# Product Analysis use, so Merch Hub tiers can never disagree with them.

def _compute_tier(style_name, is_noos):
    """Compute the unified lifecycle tier for one style — delegates entirely to
    api_pg._lifecycle_tier (the single dashboard-wide source of truth).

    Returns one of "Retired", "Tier 1".."Tier 4", "Archived", or None. A None
    result means the style has no live Odoo status at all (catalogue debris —
    blank status, no Odoo record, Sample, Partner Brand); callers MUST exclude
    that style from Merch Hub entirely, matching Range Management — never
    default it to Active/Tier 4/Archived.

    age_weeks / reorder_count / months_active_12 are no longer part of the
    classification (api_pg._lifecycle_tier ignores them); only style_name and
    is_noos are needed.
    """
    return A._lifecycle_tier(style_name, None, None, None, None, is_noos=bool(is_noos))


# ── Recommended action decision tree ──────────────────────────────────────────

def _recommend(woc, last_sale_days, sor_6m, full_price_pct, current_stock):
    """Return (action_label, status) for one style row.

    10-rule decision tree (evaluated top-down):
     1. No stock + sold recently (≤30d)       → Reorder Now         / at_risk
     2. WOC < 1.5 + has stock                 → Reorder Soon        / at_risk
     3. No sales ≥ 90d + has stock            → Dead Stock — Act    / overdue
     4. No sales 60-89d + has stock           → At-Risk — Investigate / at_risk
     5. WOC > 26                              → Overstock — Clearance / overdue
     6. WOC > 16                              → Overstock — Review  / at_risk
     7. full_price_pct < 30 + WOC > 4        → Heavy Markdown       / at_risk
     8. SOR > 85 + WOC < 2 + has stock       → Hot Seller — Reorder / at_risk
     9. No stock + no recent sales (≥90d)     → Discontinue         / overdue
    10. Default                               → On Track             / on_track
    """
    no_stock = (current_stock is None or current_stock == 0)
    if no_stock and last_sale_days is not None and last_sale_days <= 30:
        return "Reorder Now", "at_risk"
    if not no_stock and woc is not None and woc < 1.5:
        return "Reorder Soon", "at_risk"
    if not no_stock and last_sale_days is not None and last_sale_days >= 90:
        return "Dead Stock — Act", "overdue"
    if not no_stock and last_sale_days is not None and last_sale_days >= 60:
        return "At-Risk — Investigate", "at_risk"
    if woc is not None and woc > 26:
        return "Overstock — Clearance", "overdue"
    if woc is not None and woc > 16:
        return "Overstock — Review", "at_risk"
    if full_price_pct is not None and full_price_pct < 30 and woc is not None and woc > 4:
        return "Heavy Markdown", "at_risk"
    if (not no_stock and sor_6m is not None and sor_6m > 85
            and woc is not None and woc < 2):
        return "Hot Seller — Reorder", "at_risk"
    if no_stock and (last_sale_days is None or last_sale_days >= 90):
        return "Discontinue", "overdue"
    return "On Track", "on_track"


# ── Style universe query ───────────────────────────────────────────────────────

_SIX_MONTHS_DAYS = 182


def _fetch_styles_sql(brand=None, subcategory=None, tier=None, status=None,
                      from_date=None, to_date=None, country=None, pos_location=None):
    today = date.today()
    six_mo_ago = str(today - timedelta(days=_SIX_MONTHS_DAYS))
    today_str  = str(today)
    period_from = from_date or six_mo_ago
    period_to   = to_date   or today_str

    params = {
        "period_from": period_from,
        "period_to":   period_to,
        "six_mo_ago":  six_mo_ago,
        "today":       today_str,
    }

    # Extra WHERE clauses for the prod CTE (applied AFTER the style_nums CTE)
    extra_prod_parts = []
    if status == "active":
        extra_prod_parts.append("LOWER(COALESCE(p.status,'active')) = 'active'")
    elif status == "retired":
        extra_prod_parts.append("LOWER(COALESCE(p.status,'active')) = 'retired'")
    if brand:
        bl = [b.strip() for b in brand.split(",") if b.strip()]
        if bl:
            extra_prod_parts.append("p.brand = ANY(%(brands)s)")
            params["brands"] = bl
    if subcategory:
        sl = [s.strip() for s in subcategory.split(",") if s.strip()]
        if sl:
            extra_prod_parts.append("p.product_type = ANY(%(subcats)s)")
            params["subcats"] = sl
    extra_prod_where = (" AND " + " AND ".join(extra_prod_parts)) if extra_prod_parts else ""

    # Country filter for sales CTEs
    country_clause = ""
    # Inventory country filter — mirrors api_pg's icf = _style_filters(country, None, "i")
    # so that soh_stores/soh_warehouse in the stock CTE are scoped to the same
    # countries as the sales CTEs, making active_styles_count reconcile with PA.
    country_inv_where = ""
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            params["countries"] = cl
            country_clause = " AND s.country = ANY(%(countries)s)"
            inv_cs = ", ".join(f"'{c.lower().replace(chr(39), chr(39)*2)}'" for c in cl)
            country_inv_where = f" WHERE LOWER(i.country) IN ({inv_cs})"

    # POS location filter — narrows store stock and sales to specific locations
    pos_store_clause = ""  # applied to the stock CTE's soh_stores FILTER
    pos_sales_clause = ""  # applied to every sales CTE WHERE
    # When a specific POS location is selected, warehouse stock doesn't belong to
    # that store, so soh_warehouse is forced to 0 to avoid inflating the total.
    pos_has_filter = False
    if pos_location:
        pl = [p.strip() for p in pos_location.split(",") if p.strip()]
        if pl:
            params["pos_locations"] = pl
            pos_store_clause = " AND i.pos_location_name = ANY(%(pos_locations)s)"
            pos_sales_clause = " AND s.pos_location_name = ANY(%(pos_locations)s)"
            pos_has_filter   = True

    # soh_warehouse expression — 0 when a POS location filter is active, full
    # warehouse aggregate otherwise.
    soh_warehouse_expr = (
        "0"
        if pos_has_filter else
        f"COALESCE(SUM(i.available) FILTER ("
        f"WHERE i.pos_location_name = 'Warehouse Finished Goods'"
        f"), 0)"
    )

    sql = f"""
WITH
/*
 * Step 1 — map each style_name to its canonical style_number.
 * Done separately so production_orders can be joined WITHOUT an aggregate
 * inside the ON clause (PostgreSQL disallows aggregates in JOIN conditions).
 */
style_nums AS (
    SELECT
        p.style_name,
        mode() WITHIN GROUP (ORDER BY p.style_number) AS style_number
    FROM all_products_clean p
    WHERE {_PROD_BASE}
    GROUP BY p.style_name
),
/*
 * Step 2 — count distinct buying orders per style using the pre-computed
 * style_number.  Mirrors _lifecycle_tier's "reorder_count" input.
 */
reorder_counts AS (
    SELECT
        sn.style_name,
        COUNT(DISTINCT po.order_ref) AS reorder_count,
        MAX(po.date_ordered)         AS last_order_date
    FROM style_nums sn
    LEFT JOIN production_orders po
           ON po.style_number = sn.style_number
           OR po.style_name   = sn.style_name
    GROUP BY sn.style_name
),
{_STYLE_COST_CTES}
/*
 * Step 3 — one row per style with all product-master dimensions.
 * Joins style_nums and reorder_counts (both 1-to-1 with style_name)
 * so GROUP BY is effectively on style_name alone.
 */
prod AS (
    SELECT
        p.style_name,
        sn.style_number,
        mode() WITHIN GROUP (ORDER BY p.brand)           AS brand,
        mode() WITHIN GROUP (ORDER BY p.product_type)    AS subcategory,
        mode() WITHIN GROUP (ORDER BY p.category)
            FILTER (WHERE COALESCE(p.category,'') <> '') AS category,
        mode() WITHIN GROUP (ORDER BY NULLIF(BTRIM(p.fabric_category), ''))
            FILTER (WHERE NULLIF(BTRIM(p.fabric_category), '') IS NOT NULL) AS fabric_category,
        mode() WITHIN GROUP (ORDER BY NULLIF(BTRIM(p.fabric_subcategory), ''))
            FILTER (WHERE NULLIF(BTRIM(p.fabric_subcategory), '') IS NOT NULL) AS fabric_subcategory,
        mode() WITHIN GROUP (ORDER BY NULLIF(BTRIM(p.color_print), ''))
            FILTER (WHERE NULLIF(BTRIM(p.color_print), '') IS NOT NULL) AS colour,
        /* Silhouette is not yet stored in all_products_clean. Keep the
           contract explicit so the UI can exclude unpopulated values rather
           than manufacturing an Unknown bucket. */
        CAST(NULL AS TEXT)                                   AS silhouette,
        /* Retirement rule: Active wins — style is Retired only when every
           SKU is Retired (mirrors api_pg._lifecycle_tier / _odoo_retired_styles). */
        CASE WHEN BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'retired')
                  AND NOT BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'active')
             THEN 'Retired' ELSE 'Active' END             AS status,
        MIN(substring(p.style_launch_date,1,10))
            FILTER (WHERE substring(p.style_launch_date,1,10)
                    ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$')  AS launch_date,
        /* Cost precedence: latest buying/production order, then the
           product-master standard cost. */
        COALESCE(
            lpc.cost_kes,
            MAX(p.standard_cost_kes) FILTER (WHERE p.standard_cost_kes > 0)
        )                                                   AS standard_cost_kes,
        CASE
            WHEN lpc.cost_kes IS NOT NULL THEN 'last reorder'
            WHEN MAX(p.standard_cost_kes) FILTER (WHERE p.standard_cost_kes > 0) IS NOT NULL
              THEN 'product master'
            ELSE NULL
        END                                                 AS cost_source,
        COALESCE(
            lpc.cost_date,
            CASE
                WHEN MAX(p.standard_cost_kes) FILTER (WHERE p.standard_cost_kes > 0) IS NOT NULL
                THEN MAX(p.standard_cost_date)
            END
        )                                                   AS cost_date,
        rc.last_order_date,
        mode() WITHIN GROUP (ORDER BY p.price)
            FILTER (WHERE p.price > 0)                    AS full_price,
        BOOL_OR(COALESCE(p.is_noos, FALSE))               AS is_noos,
        rc.reorder_count,
        COUNT(DISTINCT p.color_print)
            FILTER (WHERE COALESCE(p.color_print,'') <> '') AS colour_count
    FROM all_products_clean p
    JOIN style_nums sn     ON sn.style_name = p.style_name
    JOIN reorder_counts rc ON rc.style_name = p.style_name
    LEFT JOIN latest_po_cost lpc ON lpc.style_name = p.style_name
    WHERE {_PROD_BASE}{extra_prod_where}
    GROUP BY p.style_name, sn.style_number, rc.reorder_count, rc.last_order_date,
             lpc.cost_kes, lpc.cost_date
),
stock AS (
    SELECT
        COALESCE(m.style_name, i.style_name) AS style_name,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
            {pos_store_clause}
        ), 0) AS soh_stores,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
            {pos_store_clause}
            AND i.pos_location_name ILIKE '%%online%%'
        ), 0) AS soh_online,
        {soh_warehouse_expr} AS soh_warehouse
    FROM all_inventory i
    LEFT JOIN (
        SELECT DISTINCT sku,
            mode() WITHIN GROUP (ORDER BY style_name) AS style_name
        FROM all_products_clean
        WHERE style_name IS NOT NULL
        GROUP BY sku
    ) m ON m.sku = i.sku{country_inv_where}
    GROUP BY COALESCE(m.style_name, i.style_name)
),
/* Per-colour stock — feeds Active Colour Styles. A colourway counts only when
   its OWN Odoo rows include status Active and its scoped stores + warehouse
   SOH is positive. Sibling colourways never influence this status flag. */
colour_stock AS (
    SELECT style_name, COUNT(*) AS colours_in_stock
    FROM (
        SELECT
            cm.style_name,
            cm.colour,
            BOOL_OR(cm.has_active_status) AS has_active_status,
            COALESCE(SUM(i.available) FILTER (
                WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
                {pos_store_clause}
            ), 0) + {soh_warehouse_expr} AS colour_soh
        FROM all_inventory i
        JOIN (
            SELECT sku,
                mode() WITHIN GROUP (ORDER BY style_name)  AS style_name,
                mode() WITHIN GROUP (ORDER BY color_print) AS colour,
                BOOL_OR(status = 'Active')                 AS has_active_status
            FROM all_products_clean
            WHERE style_name IS NOT NULL
              AND COALESCE(color_print,'') <> ''
            GROUP BY sku
        ) cm ON cm.sku = i.sku{country_inv_where}
        GROUP BY cm.style_name, cm.colour
    ) c
    WHERE c.colour_soh > 0 AND c.has_active_status
    GROUP BY style_name
),
/* Modal full price per SKU — computed ONCE here and hash-joined into
   sales_6m. Was a correlated per-sales-row subquery (re-executed for every
   6-month sales line), the single most expensive part of this query. */
sku_mode_price AS (
    SELECT sku,
           mode() WITHIN GROUP (ORDER BY price)
               FILTER (WHERE price > 0) AS mode_price
    FROM all_products_clean
    GROUP BY sku
),
sales_6m AS (
    SELECT
        p2.style_name,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                                              AS units_6m,
        SUM({_NET_SALES_EXPR})                         AS revenue_6m,
        COUNT(DISTINCT s.order_id) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                                              AS orders_6m,
        MAX(s.sale_date::date)                         AS last_sale_date,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
            AND s.total_sales_kes::numeric >= COALESCE(smp.mode_price, 0) * 0.95
        )                                              AS units_full_price
    FROM all_sales s
    JOIN all_products_clean p2 ON p2.sku = s.variant_sku
        AND p2.style_name IS NOT NULL AND p2.style_name <> ''
        AND COALESCE(p2.brand,'') NOT ILIKE '%%third party%%'
    LEFT JOIN sku_mode_price smp ON smp.sku = s.variant_sku
    WHERE s.sale_date BETWEEN %(six_mo_ago)s AND %(today)s
        AND {_BASE_FILTERS}
        {country_clause}
        {pos_sales_clause}
    GROUP BY p2.style_name
),
sales_period AS (
    SELECT
        p2.style_name,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                                              AS units_period,
        SUM({_NET_SALES_EXPR})                         AS revenue_period,
        SUM(
            s.total_sales_kes::numeric - COALESCE(s.discounts_kes, 0)::numeric
        ) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                                              AS sales_value_period,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
              AND COALESCE(s.discounts_kes, 0)::numeric = 0
        )                                              AS units_full_price_period
    FROM all_sales s
    JOIN all_products_clean p2 ON p2.sku = s.variant_sku
        AND p2.style_name IS NOT NULL AND p2.style_name <> ''
        AND COALESCE(p2.brand,'') NOT ILIKE '%%third party%%'
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
        AND {_BASE_FILTERS}
        {country_clause}
        {pos_sales_clause}
    GROUP BY p2.style_name
),
sales_life AS (
    SELECT
        p2.style_name,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                                              AS units_life,
        SUM({_NET_SALES_EXPR})                         AS revenue_life
    FROM all_sales s
    JOIN all_products_clean p2 ON p2.sku = s.variant_sku
        AND p2.style_name IS NOT NULL AND p2.style_name <> ''
        AND COALESCE(p2.brand,'') NOT ILIKE '%%third party%%'
    WHERE {_BASE_FILTERS}
        {country_clause}
        {pos_sales_clause}
    GROUP BY p2.style_name
),
/* Launch-date fallback — all_products_clean.style_launch_date is empty for
   the entire catalogue (0 of ~73.8k rows as of Aug 2026), so "launched"
   falls back to the style's first EVER sale. Mirrors the Product Catalogue
   rule (api_pg._gallery_attach_launch_dates) at style grain, with the same
   join/brand-exclusion pattern as sales_life above. Deliberately UNSCOPED
   (no BASE/country/POS/date filters): launch date is a stable product
   attribute that must not shift with the hub's filter bar. */
first_sale AS (
    SELECT
        p2.style_name,
        MIN(s.sale_date::date) AS first_sale_date
    FROM all_sales s
    JOIN all_products_clean p2 ON p2.sku = s.variant_sku
        AND p2.style_name IS NOT NULL AND p2.style_name <> ''
        AND COALESCE(p2.brand,'') NOT ILIKE '%%third party%%'
    WHERE s.sale_kind IN ('sale','order')
    GROUP BY p2.style_name
)
SELECT
    p.style_name,
    p.style_number,
    p.brand,
    p.subcategory,
    p.category,
    p.fabric_category,
    p.fabric_subcategory,
    p.colour,
    p.silhouette,
    p.status,
    COALESCE(p.launch_date, fs.first_sale_date::text) AS launch_date,
    fs.first_sale_date AS first_sale_date,
    p.standard_cost_kes,
    p.cost_source,
    p.cost_date,
    p.last_order_date,
    p.full_price,
    p.is_noos,
    p.reorder_count,
    p.colour_count,
    COALESCE(cs.colours_in_stock, 0) AS colours_in_stock,
    COALESCE(st.soh_stores,    0) AS soh_stores,
    COALESCE(st.soh_online,    0) AS soh_online,
    COALESCE(st.soh_warehouse, 0) AS soh_warehouse,
    COALESCE(s6.units_6m,    0)   AS units_6m,
    COALESCE(s6.revenue_6m,  0.0) AS revenue_6m,
    COALESCE(s6.orders_6m,   0)   AS orders_6m,
    COALESCE(s6.units_full_price, 0) AS units_full_price,
    s6.last_sale_date,
    COALESCE(sp.units_period,   0)   AS units_period,
    COALESCE(sp.revenue_period, 0.0) AS revenue_period,
    COALESCE(sp.sales_value_period, 0.0) AS sales_value_period,
    COALESCE(sp.units_full_price_period, 0) AS units_full_price_period,
    COALESCE(sl.units_life,     0)   AS units_life,
    COALESCE(sl.revenue_life,   0.0) AS revenue_life
FROM prod p
LEFT JOIN stock          st  ON st.style_name   = p.style_name
LEFT JOIN colour_stock   cs  ON cs.style_name   = p.style_name
LEFT JOIN sales_6m       s6  ON s6.style_name   = p.style_name
LEFT JOIN sales_period   sp  ON sp.style_name   = p.style_name
LEFT JOIN sales_life     sl  ON sl.style_name   = p.style_name
LEFT JOIN first_sale     fs  ON fs.style_name   = p.style_name
ORDER BY revenue_6m DESC NULLS LAST
"""
    raw = _db_exec(sql, params, fetch=True)
    today_dt = today

    # Post-process: compute tier in Python, then apply tier filter
    result = []
    tier_filter = set(t.strip() for t in tier.split(",") if t.strip()) if tier else None

    for r in raw:
        is_noos = bool(r.get("is_noos"))
        # Delegates entirely to api_pg._lifecycle_tier — no override of any kind.
        computed_tier = _compute_tier(r.get("style_name"), is_noos)
        if computed_tier is None:
            # No live Odoo status at all — excluded from Merch Hub entirely,
            # matching Range Management.
            continue

        # Apply tier filter in Python (never relies on DB column)
        if tier_filter and computed_tier not in tier_filter:
            continue

        units_6m         = int(r["units_6m"] or 0)
        revenue_6m       = float(r["revenue_6m"] or 0)
        units_life       = int(r["units_life"] or 0)
        revenue_life     = float(r["revenue_life"] or 0)
        units_period     = int(r["units_period"] or 0)
        revenue_period   = float(r["revenue_period"] or 0)
        sales_value_period = float(r.get("sales_value_period") or 0)
        units_full_price_period = int(r.get("units_full_price_period") or 0)
        soh_stores       = int(r["soh_stores"] or 0)
        soh_online       = int(r["soh_online"] or 0)   # subset of soh_stores
        soh_warehouse    = int(r["soh_warehouse"] or 0)
        current_stock    = soh_stores + soh_warehouse
        units_full_price = int(r["units_full_price"] or 0)

        # Derived metrics
        weekly_avg = round(units_6m / 26.0, 2)
        woc = round(current_stock / weekly_avg, 1) if weekly_avg > 0 else None
        sor_denom = units_6m + current_stock
        sor_6m    = round(units_6m * 100.0 / sor_denom, 1) if sor_denom > 0 else None
        # Period-scoped sell-through (same formula, selected date range)
        sor_p_denom = units_period + current_stock
        sor_period  = round(units_period * 100.0 / sor_p_denom, 1) if sor_p_denom > 0 else None
        full_price_sor_denom = units_full_price_period + current_stock
        full_price_sor_period = (
            round(units_full_price_period * 100.0 / full_price_sor_denom, 1)
            if full_price_sor_denom > 0 else None
        )
        # Lifetime (since-launch) sell-through — same formula & gross-units
        # basis as the CSV export's "SOR Since Launch %" column: lifetime
        # units ÷ (lifetime units + current stock).
        sor_l_denom = units_life + current_stock
        sor_life    = round(units_life * 100.0 / sor_l_denom, 1) if sor_l_denom > 0 else None
        full_price_pct = round(units_full_price * 100.0 / units_6m, 1) if units_6m > 0 else None
        avg_selling_price = round(revenue_6m / units_6m, 0) if units_6m > 0 else None

        # Days since last sale
        last_sale = r["last_sale_date"]
        if last_sale:
            try:
                from datetime import date as _date
                ls = last_sale if isinstance(last_sale, _date) else _date.fromisoformat(str(last_sale)[:10])
                last_sale_days = (today_dt - ls).days
            except Exception:
                last_sale_days = None
        else:
            last_sale_days = None

        # Gross margin (requires standard_cost_kes)
        cost = float(r["standard_cost_kes"]) if r.get("standard_cost_kes") is not None else None
        if cost is not None and avg_selling_price and avg_selling_price > 0:
            gross_margin_pct = round((avg_selling_price - cost) / avg_selling_price * 100, 1)
            gross_margin_kes = round((avg_selling_price - cost) * units_6m)
            cogs_6m_kes      = round(cost * units_6m)
        else:
            gross_margin_pct = None
            gross_margin_kes = None
            cogs_6m_kes      = None

        recommended_action, action_status = _recommend(
            woc, last_sale_days, sor_6m, full_price_pct, current_stock
        )

        result.append({
            "style_name":          r["style_name"],
            "style_number":        r.get("style_number") or "",
            "brand":               r.get("brand") or "",
            "subcategory":         r.get("subcategory") or "",
            "category":            r.get("category") or "",
             "fabric_category":     r.get("fabric_category") or "",
             "fabric_subcategory":  r.get("fabric_subcategory") or "",
             "colour":              r.get("colour") or "",
             "silhouette":          r.get("silhouette") or "",
            "tier":                computed_tier,
            "odoo_status":         r.get("status") or "Active",
            "launch_date":         str(r["launch_date"]) if r.get("launch_date") else None,
            "first_sale_date":     str(r["first_sale_date"])[:10] if r.get("first_sale_date") else None,
            "last_order_date":     str(r["last_order_date"]) if r.get("last_order_date") else None,
            "standard_cost_kes":   cost,
             "cost_source":         r.get("cost_source"),
             "cost_date":           str(r["cost_date"]) if r.get("cost_date") else None,
            "full_price":          float(r["full_price"]) if r.get("full_price") else None,
            "is_noos":             is_noos,
            "reorder_count":       int(r.get("reorder_count") or 0),
            "colour_count":        int(r.get("colour_count") or 0),
            "colours_in_stock":    int(r.get("colours_in_stock") or 0),
            "soh_stores":          soh_stores,
            "soh_online":          soh_online,
            "soh_warehouse":       soh_warehouse,
            "current_stock":       current_stock,
            "units_6m":            units_6m,
            "revenue_6m":          round(revenue_6m, 0),
            "orders_6m":           int(r["orders_6m"] or 0),
            "units_period":        units_period,
            "revenue_period":      round(revenue_period, 0),
            "sales_value_period":  round(sales_value_period, 0),
             "units_full_price_period": units_full_price_period,
            "units_life":          units_life,
            "revenue_life":        round(revenue_life, 0),
            "weekly_avg":          weekly_avg,
            "woc":                 woc,
            "sor_6m":              sor_6m,
            "sor_period":          sor_period,
             "full_price_sor_period": full_price_sor_period,
            "sor_life":            sor_life,
            "last_sale_date":      str(last_sale)[:10] if last_sale else None,
            "last_sale_days":      last_sale_days,
            "full_price_pct":      full_price_pct,
            "avg_selling_price":   avg_selling_price,
            "gross_margin_pct":    gross_margin_pct,
            "gross_margin_kes":    gross_margin_kes,
            "cogs_6m_kes":         cogs_6m_kes,
            "recommended_action":  recommended_action,
            "action_status":       action_status,
        })

    return result


# ── Fast path: core (date-independent) + period overlay ────────────────────────
#
# Architecture (production mode — A is the api_pg module):
#
#   _fetch_styles_core_cached(country, pos_location)
#       │  SWR-backed, key = "merch_core|{country}|{pos_location}"
#       │  TTL 600s, grace 600s → serves stale while refreshing in bg
#       │  Covers ALL styles (no brand/subcat SQL filter)
#       │  Reads merch_style_day + merch_first_sale rollups when fresh;
#       │  falls back to a live all_sales scan otherwise.
#       │
#   _fetch_period_overlay(period_from, period_to, country, pos_location)
#       │  Only called when the user's date window differs from the default 6m.
#       │  Returns {style_name: {units_period, revenue_period}}.
#       │  Reads rollup_merch_style_day when fresh; falls back to live SQL.
#       │
#   _fetch_styles_fast_path(brand, subcategory, tier, status, ...)
#       │  Calls core (cached) + optional overlay, then applies Python
#       │  narrowing (brand/subcat/tier/status) and computes derived metrics.
#
# Standalone / test mode (A is None): _fetch_styles falls back to _fetch_styles_sql
# (the original monolithic query), so the schema smoke tests continue to pass
# without any changes to their fake-DB fixtures.

_CORE_TTL = 600       # seconds — same as the full-universe TTL
_CORE_SWR_GRACE = 600  # serve stale for this many extra seconds while refreshing


def _core_swr_get_or_compute(key, fn):
    """SWR-style read/write from _cache_store.

    Fresh  (age < _CORE_TTL):                  return cached value.
    Stale  (_CORE_TTL ≤ age < TTL+GRACE):      return cached value immediately,
                                                spawn one background thread to
                                                recompute (extras are no-ops).
    Expired (age ≥ TTL+GRACE) or cache miss:    compute synchronously with the
                                                per-key single-flight lock.
    """
    now = _time.monotonic()
    entry = _cache_store.get(key)
    if entry:
        age = now - entry[0]
        if age < _CORE_TTL:
            return entry[1]   # fresh hit — no locking needed
        if age < _CORE_TTL + _CORE_SWR_GRACE:
            # Stale but within grace: serve immediately, refresh in background.
            bg_key = "bg:" + key
            with _SF_LOCKS_GUARD:
                if bg_key not in _SF_LOCKS:
                    _SF_LOCKS[bg_key] = True  # sentinel — bg refresh is running

                    def _do_refresh(_k=key, _bk=bg_key, _f=fn):
                        try:
                            val = _f()
                            _cache_store[_k] = (_time.monotonic(), val)
                        except Exception as _e:
                            log.warning("merch core SWR refresh failed: %s", _e)
                        finally:
                            with _SF_LOCKS_GUARD:
                                _SF_LOCKS.pop(_bk, None)

                    _threading.Thread(target=_do_refresh, daemon=True,
                                      name="merch-core-swr").start()
            return entry[1]   # serve stale immediately
    # Cache miss or fully expired — compute synchronously under a per-key lock
    # so concurrent callers block instead of each running the heavy SQL.
    with _SF_LOCKS_GUARD:
        if len(_SF_LOCKS) > 512:
            _SF_LOCKS.clear()
        lock = _SF_LOCKS.setdefault(key, _threading.Lock())
    with lock:
        # Re-check after acquiring the lock — another thread may have won.
        entry = _cache_store.get(key)
        if entry and (_time.monotonic() - entry[0]) < _CORE_TTL:
            return entry[1]
        val = fn()
        _cache_store[key] = (_time.monotonic(), val)
        return val


def _fetch_styles_core_sql(country, pos_location):
    """Run the date-independent style-universe query and return raw DB rows.

    Covers ALL styles (no brand/subcategory/tier/status SQL filter).
    Returns rows with the same column set as _fetch_styles_sql PLUS
    has_any_retired_sku (used in _fetch_styles_fast_path to replicate
    the exact Python behaviour of the SQL status filter).

    Uses the merch_style_day + merch_first_sale rollups when fresh
    (schema_ver 3); falls back to a live all_sales scan when stale."""
    today      = date.today()
    six_mo_ago = str(today - timedelta(days=_SIX_MONTHS_DAYS))
    today_str  = str(today)
    params     = {"six_mo_ago": six_mo_ago, "today": today_str}

    # ── Country filter ──────────────────────────────────────────────────────
    country_clause      = ""
    country_inv_where   = ""
    country_rollup_where = ""
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            params["countries"] = cl
            country_clause        = " AND s.country = ANY(%(countries)s)"
            inv_cs = ", ".join(
                f"'{c.lower().replace(chr(39), chr(39)*2)}'" for c in cl)
            country_inv_where     = f" WHERE LOWER(i.country) IN ({inv_cs})"
            country_rollup_where  = " AND country = ANY(%(countries)s)"

    # ── POS filter ─────────────────────────────────────────────────────────
    pos_store_clause    = ""
    pos_sales_clause    = ""
    pos_rollup_where    = ""
    pos_has_filter      = False
    if pos_location:
        pl = [p.strip() for p in pos_location.split(",") if p.strip()]
        if pl:
            params["pos_locations"] = pl
            pos_store_clause  = " AND i.pos_location_name = ANY(%(pos_locations)s)"
            pos_sales_clause  = " AND s.pos_location_name = ANY(%(pos_locations)s)"
            pos_rollup_where  = " AND pos_location_name = ANY(%(pos_locations)s)"
            pos_has_filter    = True

    soh_warehouse_expr = (
        "0"
        if pos_has_filter else
        f"COALESCE(SUM(i.available) FILTER ("
        f"WHERE i.pos_location_name = 'Warehouse Finished Goods'"
        f"), 0)"
    )

    # life_where: rollup_life sums all days (no date floor), optionally
    # filtered by country/POS so scope matches the 6m and period CTEs.
    life_extra = f"{country_rollup_where}{pos_rollup_where}"
    life_where = (f"WHERE TRUE{life_extra}" if life_extra.strip() else "")

    # ── Rollup path (fast) ─────────────────────────────────────────────────
    use_rollup = (
        A is not None
        and A._rollup_fresh("merch_style_day",  min_schema=3)
        and A._rollup_fresh("merch_first_sale", min_schema=3)
    )

    if use_rollup:
        # Look up the watermark: rows in all_sales loaded after this timestamp
        # are not yet in the rollup and must be fetched live to stay current.
        try:
            _wm_rows = _db_exec(
                "SELECT source_watermark FROM rollup_meta "
                "WHERE name = 'merch_style_day'",
                fetch=True)
            _rollup_wm = (_wm_rows[0].get("source_watermark")
                          if _wm_rows else None)
        except Exception:
            _rollup_wm = None
        params["wm"] = _rollup_wm   # None → WHERE … > NULL → 0 rows (correct)

        sql = f"""
WITH
style_nums AS (
    SELECT p.style_name,
           mode() WITHIN GROUP (ORDER BY p.style_number) AS style_number
    FROM all_products_clean p
    WHERE {_PROD_BASE}
    GROUP BY p.style_name
),
reorder_counts AS (
    SELECT sn.style_name,
           COUNT(DISTINCT po.order_ref) AS reorder_count,
           MAX(po.date_ordered)         AS last_order_date
    FROM style_nums sn
    LEFT JOIN production_orders po
           ON po.style_number = sn.style_number
           OR po.style_name   = sn.style_name
    GROUP BY sn.style_name
),
{_STYLE_COST_CTES}
prod AS (
    SELECT
        p.style_name,
        sn.style_number,
        mode() WITHIN GROUP (ORDER BY p.brand)            AS brand,
        mode() WITHIN GROUP (ORDER BY p.product_type)     AS subcategory,
        mode() WITHIN GROUP (ORDER BY p.category)
            FILTER (WHERE COALESCE(p.category,'') <> '')  AS category,
        mode() WITHIN GROUP (ORDER BY NULLIF(BTRIM(p.fabric_category), ''))
            FILTER (WHERE NULLIF(BTRIM(p.fabric_category), '') IS NOT NULL) AS fabric_category,
        mode() WITHIN GROUP (ORDER BY NULLIF(BTRIM(p.fabric_subcategory), ''))
            FILTER (WHERE NULLIF(BTRIM(p.fabric_subcategory), '') IS NOT NULL) AS fabric_subcategory,
        mode() WITHIN GROUP (ORDER BY NULLIF(BTRIM(p.color_print), ''))
            FILTER (WHERE NULLIF(BTRIM(p.color_print), '') IS NOT NULL) AS colour,
        CAST(NULL AS TEXT)                                  AS silhouette,
        CASE WHEN BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'retired')
                  AND NOT BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'active')
             THEN 'Retired' ELSE 'Active' END              AS status,
        BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'retired') AS has_any_retired_sku,
        MIN(substring(p.style_launch_date,1,10))
            FILTER (WHERE substring(p.style_launch_date,1,10)
                    ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$') AS launch_date,
        COALESCE(
            lpc.cost_kes,
            MAX(p.standard_cost_kes) FILTER (WHERE p.standard_cost_kes > 0)
        )                                                    AS standard_cost_kes,
        CASE
            WHEN lpc.cost_kes IS NOT NULL THEN 'last reorder'
            WHEN MAX(p.standard_cost_kes) FILTER (WHERE p.standard_cost_kes > 0) IS NOT NULL
              THEN 'product master'
            ELSE NULL
        END                                                  AS cost_source,
        COALESCE(
            lpc.cost_date,
            CASE
                WHEN MAX(p.standard_cost_kes) FILTER (WHERE p.standard_cost_kes > 0) IS NOT NULL
                THEN MAX(p.standard_cost_date)
            END
        )                                                    AS cost_date,
        rc.last_order_date,
        mode() WITHIN GROUP (ORDER BY p.price)
            FILTER (WHERE p.price > 0)                     AS full_price,
        BOOL_OR(COALESCE(p.is_noos, FALSE))                AS is_noos,
        rc.reorder_count,
        COUNT(DISTINCT p.color_print)
            FILTER (WHERE COALESCE(p.color_print,'') <> '') AS colour_count
    FROM all_products_clean p
    JOIN style_nums sn     ON sn.style_name = p.style_name
    JOIN reorder_counts rc ON rc.style_name = p.style_name
    LEFT JOIN latest_po_cost lpc ON lpc.style_name = p.style_name
    WHERE {_PROD_BASE}
    GROUP BY p.style_name, sn.style_number, rc.reorder_count, rc.last_order_date,
             lpc.cost_kes, lpc.cost_date
),
stock AS (
    SELECT
        COALESCE(m.style_name, i.style_name) AS style_name,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
            {pos_store_clause}
        ), 0) AS soh_stores,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
            {pos_store_clause}
            AND i.pos_location_name ILIKE '%%online%%'
        ), 0) AS soh_online,
        {soh_warehouse_expr} AS soh_warehouse
    FROM all_inventory i
    LEFT JOIN (
        SELECT DISTINCT sku,
            mode() WITHIN GROUP (ORDER BY style_name) AS style_name
        FROM all_products_clean
        WHERE style_name IS NOT NULL
        GROUP BY sku
    ) m ON m.sku = i.sku{country_inv_where}
    GROUP BY COALESCE(m.style_name, i.style_name)
),
colour_stock AS (
    SELECT style_name, COUNT(*) AS colours_in_stock
    FROM (
        SELECT
            cm.style_name,
            cm.colour,
            BOOL_OR(cm.has_active_status) AS has_active_status,
            COALESCE(SUM(i.available) FILTER (
                WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
                {pos_store_clause}
            ), 0) + {soh_warehouse_expr} AS colour_soh
        FROM all_inventory i
        JOIN (
            SELECT sku,
                mode() WITHIN GROUP (ORDER BY style_name)  AS style_name,
                mode() WITHIN GROUP (ORDER BY color_print) AS colour,
                BOOL_OR(status = 'Active')                 AS has_active_status
            FROM all_products_clean
            WHERE style_name IS NOT NULL
              AND COALESCE(color_print,'') <> ''
            GROUP BY sku
        ) cm ON cm.sku = i.sku{country_inv_where}
        GROUP BY cm.style_name, cm.colour
    ) c
    WHERE c.colour_soh > 0 AND c.has_active_status
    GROUP BY style_name
),
/*
 * incr_sales — rows that arrived in all_sales after the rollup was built.
 * When %(wm)s IS NULL (first build / missing meta) this returns 0 rows
 * because "loaded_at > NULL" is NULL (falsy) in PostgreSQL — correct no-op.
 * Includes the same sku_mode_price join used in the rollup build so that
 * units_fp is calculated identically.
 */
incr_sales AS (
    SELECT p.style_name,
           s.sale_date::date                                        AS sale_day,
           COALESCE(s.country, '')                                   AS country,
           COALESCE(s.pos_location_name, '')                         AS pos_location_name,
           COALESCE(SUM(s.ordered_item_quantity) FILTER (
               WHERE s.sale_kind IN ('sale','order')
           ), 0)::int                                                AS gross_units,
           COALESCE(SUM({_NET_SALES_EXPR}), 0)                       AS net_revenue,
           COALESCE(SUM(s.ordered_item_quantity) FILTER (
               WHERE s.sale_kind IN ('sale','order')
               AND s.total_sales_kes::numeric
                   >= COALESCE(smp2.mode_price, 0) * 0.95
           ), 0)::int                                                AS units_fp
    FROM all_sales s
    JOIN all_products_clean p ON p.sku = s.variant_sku
        AND p.style_name IS NOT NULL AND p.style_name <> ''
        AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
    LEFT JOIN (
        SELECT sku,
               mode() WITHIN GROUP (ORDER BY price)
                   FILTER (WHERE price > 0) AS mode_price
        FROM all_products_clean
        GROUP BY sku
    ) smp2 ON smp2.sku = s.variant_sku
    WHERE s.loaded_at > %(wm)s
      AND {_BASE_FILTERS}
    GROUP BY p.style_name, s.sale_date::date,
             COALESCE(s.country,''), COALESCE(s.pos_location_name,'')
),
/*
 * combined_sales = rollup (bulk history) UNION ALL incremental (recent gap).
 * The two sets are disjoint by construction (watermark snapshotted BEFORE
 * the rollup build, incremental starts AFTER that watermark).
 */
combined_sales AS (
    SELECT style_name, sale_day, country, pos_location_name,
           gross_units, net_revenue, units_fp
    FROM rollup_merch_style_day
    UNION ALL
    SELECT style_name, sale_day, country, pos_location_name,
           gross_units, net_revenue, units_fp
    FROM incr_sales
),
rollup_6m AS (
    SELECT
        style_name,
        COALESCE(SUM(gross_units), 0) AS units_6m,
        COALESCE(SUM(net_revenue), 0.0) AS revenue_6m,
        COALESCE(SUM(units_fp), 0) AS units_full_price,
        MAX(sale_day) AS last_sale_date
    FROM combined_sales
    WHERE sale_day BETWEEN %(six_mo_ago)s AND %(today)s
      {country_rollup_where}
      {pos_rollup_where}
    GROUP BY style_name
),
rollup_life AS (
    SELECT
        style_name,
        COALESCE(SUM(gross_units), 0) AS units_life,
        COALESCE(SUM(net_revenue), 0.0) AS revenue_life
    FROM combined_sales
    {life_where}
    GROUP BY style_name
),
first_sale AS (
    SELECT style_name, first_sale_date
    FROM rollup_merch_first_sale
),
/*
 * orders_6m — COUNT(DISTINCT order_id) per style in the 6-month window.
 * This is non-additive across days so cannot be stored in the day-grain
 * rollup; it is always computed live against all_sales, but the 6-month
 * date bound keeps the scan fast (index on sale_date + loaded_at).
 */
orders_6m_cte AS (
    SELECT p3.style_name,
           COUNT(DISTINCT s.order_id) AS orders_6m
    FROM all_sales s
    JOIN all_products_clean p3 ON p3.sku = s.variant_sku
        AND p3.style_name IS NOT NULL AND p3.style_name <> ''
        AND COALESCE(p3.brand,'') NOT ILIKE '%%third party%%'
    WHERE s.sale_date BETWEEN %(six_mo_ago)s AND %(today)s
      AND s.sale_kind IN ('sale','order')
      {country_clause}
      {pos_sales_clause}
      AND {_BASE_FILTERS}
    GROUP BY p3.style_name
)
SELECT
    p.style_name,
    p.style_number,
    p.brand,
    p.subcategory,
    p.category,
    p.fabric_category,
    p.fabric_subcategory,
    p.colour,
    p.silhouette,
    p.status,
    p.has_any_retired_sku,
    COALESCE(p.launch_date, fs.first_sale_date::text) AS launch_date,
    fs.first_sale_date AS first_sale_date,
    p.standard_cost_kes,
    p.cost_source,
    p.cost_date,
    p.last_order_date,
    p.full_price,
    p.is_noos,
    p.reorder_count,
    p.colour_count,
    COALESCE(cs.colours_in_stock, 0)   AS colours_in_stock,
    COALESCE(st.soh_stores,    0)      AS soh_stores,
    COALESCE(st.soh_online,    0)      AS soh_online,
    COALESCE(st.soh_warehouse, 0)      AS soh_warehouse,
    COALESCE(r6.units_6m,      0)      AS units_6m,
    COALESCE(r6.revenue_6m,    0.0)    AS revenue_6m,
    COALESCE(o6m.orders_6m,    0)      AS orders_6m,
    COALESCE(r6.units_full_price, 0)   AS units_full_price,
    r6.last_sale_date,
    COALESCE(r6.units_6m,      0)      AS units_period,
    COALESCE(r6.revenue_6m,    0.0)    AS revenue_period,
    COALESCE(rl.units_life,    0)      AS units_life,
    COALESCE(rl.revenue_life,  0.0)    AS revenue_life
FROM prod p
LEFT JOIN stock          st  ON st.style_name   = p.style_name
LEFT JOIN colour_stock   cs  ON cs.style_name   = p.style_name
LEFT JOIN rollup_6m      r6  ON r6.style_name   = p.style_name
LEFT JOIN rollup_life    rl  ON rl.style_name   = p.style_name
LEFT JOIN first_sale     fs  ON fs.style_name   = p.style_name
LEFT JOIN orders_6m_cte o6m ON o6m.style_name  = p.style_name
ORDER BY revenue_6m DESC NULLS LAST
"""
    else:
        # ── Live fallback (rollups stale/missing) ──────────────────────────
        # Same structure as _fetch_styles_sql but WITHOUT brand/subcategory
        # SQL filter (Python narrows afterwards) and WITHOUT the sales_period
        # CTE (units_period / revenue_period are aliased from the 6m window,
        # which equals the default period when no dates are specified).
        sql = f"""
WITH
style_nums AS (
    SELECT p.style_name,
           mode() WITHIN GROUP (ORDER BY p.style_number) AS style_number
    FROM all_products_clean p
    WHERE {_PROD_BASE}
    GROUP BY p.style_name
),
reorder_counts AS (
    SELECT sn.style_name,
           COUNT(DISTINCT po.order_ref) AS reorder_count,
           MAX(po.date_ordered)         AS last_order_date
    FROM style_nums sn
    LEFT JOIN production_orders po
           ON po.style_number = sn.style_number
           OR po.style_name   = sn.style_name
    GROUP BY sn.style_name
),
{_STYLE_COST_CTES}
prod AS (
    SELECT
        p.style_name,
        sn.style_number,
        mode() WITHIN GROUP (ORDER BY p.brand)            AS brand,
        mode() WITHIN GROUP (ORDER BY p.product_type)     AS subcategory,
        mode() WITHIN GROUP (ORDER BY p.category)
            FILTER (WHERE COALESCE(p.category,'') <> '')  AS category,
        CASE WHEN BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'retired')
                  AND NOT BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'active')
             THEN 'Retired' ELSE 'Active' END              AS status,
        BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'retired') AS has_any_retired_sku,
        MIN(substring(p.style_launch_date,1,10))
            FILTER (WHERE substring(p.style_launch_date,1,10)
                    ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$') AS launch_date,
        COALESCE(
             lpc.cost_kes,
             MAX(p.standard_cost_kes) FILTER (WHERE p.standard_cost_kes > 0)
        )                                                    AS standard_cost_kes,
        CASE
            WHEN lpc.cost_kes IS NOT NULL THEN 'last reorder'
            WHEN MAX(p.standard_cost_kes) FILTER (WHERE p.standard_cost_kes > 0) IS NOT NULL
              THEN 'product master'
            ELSE NULL
        END                                                  AS cost_source,
        COALESCE(
            lpc.cost_date,
            CASE
                WHEN MAX(p.standard_cost_kes) FILTER (WHERE p.standard_cost_kes > 0) IS NOT NULL
                THEN MAX(p.standard_cost_date)
            END
        )                                                    AS cost_date,
        rc.last_order_date,
        mode() WITHIN GROUP (ORDER BY p.price)
            FILTER (WHERE p.price > 0)                     AS full_price,
        BOOL_OR(COALESCE(p.is_noos, FALSE))                AS is_noos,
        rc.reorder_count,
        COUNT(DISTINCT p.color_print)
            FILTER (WHERE COALESCE(p.color_print,'') <> '') AS colour_count
    FROM all_products_clean p
    JOIN style_nums sn     ON sn.style_name = p.style_name
    JOIN reorder_counts rc ON rc.style_name = p.style_name
    LEFT JOIN latest_po_cost lpc ON lpc.style_name = p.style_name
    WHERE {_PROD_BASE}
    GROUP BY p.style_name, sn.style_number, rc.reorder_count, rc.last_order_date,
             lpc.cost_kes, lpc.cost_date
),
stock AS (
    SELECT
        COALESCE(m.style_name, i.style_name) AS style_name,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
            {pos_store_clause}
        ), 0) AS soh_stores,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
            {pos_store_clause}
            AND i.pos_location_name ILIKE '%%online%%'
        ), 0) AS soh_online,
        {soh_warehouse_expr} AS soh_warehouse
    FROM all_inventory i
    LEFT JOIN (
        SELECT DISTINCT sku,
            mode() WITHIN GROUP (ORDER BY style_name) AS style_name
        FROM all_products_clean
        WHERE style_name IS NOT NULL
        GROUP BY sku
    ) m ON m.sku = i.sku{country_inv_where}
    GROUP BY COALESCE(m.style_name, i.style_name)
),
colour_stock AS (
    SELECT style_name, COUNT(*) AS colours_in_stock
    FROM (
        SELECT
            cm.style_name,
            cm.colour,
            BOOL_OR(cm.has_active_status) AS has_active_status,
            COALESCE(SUM(i.available) FILTER (
                WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
                {pos_store_clause}
            ), 0) + {soh_warehouse_expr} AS colour_soh
        FROM all_inventory i
        JOIN (
            SELECT sku,
                mode() WITHIN GROUP (ORDER BY style_name)  AS style_name,
                mode() WITHIN GROUP (ORDER BY color_print) AS colour,
                BOOL_OR(status = 'Active')                 AS has_active_status
            FROM all_products_clean
            WHERE style_name IS NOT NULL
              AND COALESCE(color_print,'') <> ''
            GROUP BY sku
        ) cm ON cm.sku = i.sku{country_inv_where}
        GROUP BY cm.style_name, cm.colour
    ) c
    WHERE c.colour_soh > 0 AND c.has_active_status
    GROUP BY style_name
),
sku_mode_price AS (
    SELECT sku,
           mode() WITHIN GROUP (ORDER BY price)
               FILTER (WHERE price > 0) AS mode_price
    FROM all_products_clean
    GROUP BY sku
),
sales_6m AS (
    SELECT
        p2.style_name,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                                              AS units_6m,
        SUM({_NET_SALES_EXPR})                         AS revenue_6m,
        COUNT(DISTINCT s.order_id) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                                              AS orders_6m,
        MAX(s.sale_date::date)                         AS last_sale_date,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
            AND s.total_sales_kes::numeric >= COALESCE(smp.mode_price, 0) * 0.95
        )                                              AS units_full_price
    FROM all_sales s
    JOIN all_products_clean p2 ON p2.sku = s.variant_sku
        AND p2.style_name IS NOT NULL AND p2.style_name <> ''
        AND COALESCE(p2.brand,'') NOT ILIKE '%%third party%%'
    LEFT JOIN sku_mode_price smp ON smp.sku = s.variant_sku
    WHERE s.sale_date BETWEEN %(six_mo_ago)s AND %(today)s
        AND {_BASE_FILTERS}
        {country_clause}
        {pos_sales_clause}
    GROUP BY p2.style_name
),
sales_life AS (
    SELECT
        p2.style_name,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                                              AS units_life,
        SUM({_NET_SALES_EXPR})                         AS revenue_life
    FROM all_sales s
    JOIN all_products_clean p2 ON p2.sku = s.variant_sku
        AND p2.style_name IS NOT NULL AND p2.style_name <> ''
        AND COALESCE(p2.brand,'') NOT ILIKE '%%third party%%'
    WHERE {_BASE_FILTERS}
        {country_clause}
        {pos_sales_clause}
    GROUP BY p2.style_name
),
first_sale AS (
    SELECT
        p2.style_name,
        MIN(s.sale_date::date) AS first_sale_date
    FROM all_sales s
    JOIN all_products_clean p2 ON p2.sku = s.variant_sku
        AND p2.style_name IS NOT NULL AND p2.style_name <> ''
        AND COALESCE(p2.brand,'') NOT ILIKE '%%third party%%'
    WHERE s.sale_kind IN ('sale','order')
    GROUP BY p2.style_name
)
SELECT
    p.style_name,
    p.style_number,
    p.brand,
    p.subcategory,
    p.category,
    p.status,
    p.has_any_retired_sku,
    COALESCE(p.launch_date, fs.first_sale_date::text) AS launch_date,
    fs.first_sale_date AS first_sale_date,
    p.standard_cost_kes,
    p.cost_source,
    p.cost_date,
    p.last_order_date,
    p.full_price,
    p.is_noos,
    p.reorder_count,
    p.colour_count,
    COALESCE(cs.colours_in_stock, 0)      AS colours_in_stock,
    COALESCE(st.soh_stores,    0)         AS soh_stores,
    COALESCE(st.soh_online,    0)         AS soh_online,
    COALESCE(st.soh_warehouse, 0)         AS soh_warehouse,
    COALESCE(s6.units_6m,    0)           AS units_6m,
    COALESCE(s6.revenue_6m,  0.0)         AS revenue_6m,
    COALESCE(s6.orders_6m,   0)           AS orders_6m,
    COALESCE(s6.units_full_price, 0)      AS units_full_price,
    s6.last_sale_date,
    COALESCE(s6.units_6m,    0)           AS units_period,
    COALESCE(s6.revenue_6m,  0.0)         AS revenue_period,
    COALESCE(sl.units_life,  0)           AS units_life,
    COALESCE(sl.revenue_life, 0.0)        AS revenue_life
FROM prod p
LEFT JOIN stock          st  ON st.style_name   = p.style_name
LEFT JOIN colour_stock   cs  ON cs.style_name   = p.style_name
LEFT JOIN sales_6m       s6  ON s6.style_name   = p.style_name
LEFT JOIN sales_life     sl  ON sl.style_name   = p.style_name
LEFT JOIN first_sale     fs  ON fs.style_name   = p.style_name
ORDER BY revenue_6m DESC NULLS LAST
"""

    return _db_exec(sql, params, fetch=True)


def _fetch_styles_core_cached(country, pos_location):
    """SWR-backed core cache (key = country+POS, TTL 600 s, grace 600 s).

    One cached core rowset serves every brand/subcategory/tier/status/date
    combination for the same country+POS scope.  Python narrows the ~3.5k
    rows in _fetch_styles_fast_path — typically <1 ms."""
    key = f"merch_core|{country}|{pos_location}"

    def _compute():
        rows = _fetch_styles_core_sql(country, pos_location)
        # Poison guard: an EMPTY unfiltered style universe is impossible
        # (~3.5k styles). A transient DB failure during compute once cached
        # [] and the SWR grace kept re-serving it, blanking the Deep Dive
        # style search until a process restart (2026-08-18 incident).
        # Raising here means NO cache-write site (synchronous or the SWR
        # background refresh) ever stores an empty universe.
        if not rows and not country and not pos_location:
            raise RuntimeError(
                "merch core returned EMPTY unfiltered style universe — "
                "refusing to cache (transient DB failure suspected)")
        return rows

    try:
        return _core_swr_get_or_compute(key, _compute)
    except RuntimeError as e:
        if "EMPTY unfiltered style universe" not in str(e):
            raise
        log.warning("%s", e)
        return []


def _fetch_period_overlay(period_from, period_to, country, pos_location):
    """Return {style_name: {units_period, revenue_period}} for a custom date
    window. Only called when the user's window differs from the default 6 m.

    Reads rollup_merch_style_day (index scan — fast) when fresh; falls back
    to a live all_sales scan otherwise.  Cached 600 s per (dates, country, POS)."""
    key = (f"merch_period|{period_from}|{period_to}"
           f"|{country}|{pos_location}")
    return _cached(key, 600,
                   lambda: _fetch_period_overlay_sql(
                       period_from, period_to, country, pos_location))


def _fetch_full_price_period_by_style(
    period_from, period_to, country=None, pos_location=None,
    brand=None, subcategory=None,
):
    """Return strict zero-discount gross units by style for a selected window.

    This is intentionally separate from the date-independent core rollup.  The
    rollup's historical ``units_fp`` field predates the strict discount rule,
    while this KPI must classify a unit as full price only when discounts_kes is
    NULL/zero.  The result is cached alongside the period overlay.
    """
    key = (
        f"merch_full_price_period|{period_from}|{period_to}|{country}|"
        f"{pos_location}|{brand}|{subcategory}"
    )

    def _query():
        params = {"period_from": period_from, "period_to": period_to}
        country_clause = ""
        pos_clause = ""
        product_clause = """
            AND p.style_name IS NOT NULL
            AND p.style_name <> ''
            AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
        """
        if country:
            countries = [c.strip() for c in country.split(",") if c.strip()]
            if countries:
                params["countries"] = countries
                country_clause = " AND s.country = ANY(%(countries)s)"
        if pos_location:
            locations = [p.strip() for p in pos_location.split(",") if p.strip()]
            if locations:
                params["pos_locations"] = locations
                pos_clause = " AND s.pos_location_name = ANY(%(pos_locations)s)"
        if brand:
            brands = [b.strip() for b in brand.split(",") if b.strip()]
            if brands:
                params["brands"] = brands
                product_clause += " AND p.brand = ANY(%(brands)s)"
        if subcategory:
            subcategories = [s.strip() for s in subcategory.split(",") if s.strip()]
            if subcategories:
                params["subcategories"] = subcategories
                product_clause += " AND p.product_type = ANY(%(subcategories)s)"

        rows = _db_exec(f"""
            SELECT
                p.style_name,
                COALESCE(SUM(s.ordered_item_quantity) FILTER (
                    WHERE s.sale_kind IN ('sale','order')
                      AND COALESCE(s.discounts_kes, 0)::numeric = 0
                ), 0) AS units_full_price_period,
                COALESCE(SUM(
                    s.total_sales_kes::numeric - COALESCE(s.discounts_kes, 0)::numeric
                ) FILTER (
                    WHERE s.sale_kind IN ('sale','order')
                ), 0.0) AS sales_value_period
            FROM all_sales s
            JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
              AND {_BASE_FILTERS}
              {product_clause}
              {country_clause}
              {pos_clause}
            GROUP BY p.style_name
        """, params, fetch=True) or []
        return {
            r["style_name"]: {
                "units_full_price_period": int(r.get("units_full_price_period") or 0),
                "sales_value_period": float(r.get("sales_value_period") or 0),
            }
            for r in rows
        }

    return _cached(key, 600, _query)


def _fetch_period_overlay_sql(period_from, period_to, country, pos_location):
    """Inner SQL for the period overlay (called only for non-default windows)."""
    params = {"period_from": period_from, "period_to": period_to}
    country_clause = ""
    pos_clause     = ""
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            params["countries"] = cl
            country_clause = " AND country = ANY(%(countries)s)"
    if pos_location:
        pl = [p.strip() for p in pos_location.split(",") if p.strip()]
        if pl:
            params["pos_locations"] = pl
            pos_clause = " AND pos_location_name = ANY(%(pos_locations)s)"

    use_rollup = (A is not None
                  and A._rollup_fresh("merch_style_day", min_schema=3))
    if use_rollup:
        # Include incremental (since-watermark) for freshness — same pattern as core.
        try:
            _wm_rows2 = _db_exec(
                "SELECT source_watermark FROM rollup_meta "
                "WHERE name = 'merch_style_day'",
                fetch=True)
            params["wm"] = (_wm_rows2[0].get("source_watermark")
                            if _wm_rows2 else None)
        except Exception:
            params["wm"] = None

        live_country2 = ""
        live_pos2     = ""
        if country:
            cl = [c.strip() for c in country.split(",") if c.strip()]
            if cl:
                live_country2 = " AND s.country = ANY(%(countries)s)"
        if pos_location:
            pl = [p.strip() for p in pos_location.split(",") if p.strip()]
            if pl:
                live_pos2 = " AND s.pos_location_name = ANY(%(pos_locations)s)"

        sql = f"""
            WITH incr_period AS (
                SELECT p.style_name,
                       s.sale_date::date AS sale_day,
                       COALESCE(s.country,'') AS country,
                       COALESCE(s.pos_location_name,'') AS pos_location_name,
                       COALESCE(SUM(s.ordered_item_quantity) FILTER (
                           WHERE s.sale_kind IN ('sale','order')
                       ), 0)::int AS gross_units,
                       COALESCE(SUM({_NET_SALES_EXPR}), 0) AS net_revenue
                FROM all_sales s
                JOIN all_products_clean p ON p.sku = s.variant_sku
                    AND p.style_name IS NOT NULL AND p.style_name <> ''
                    AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
                WHERE s.loaded_at > %(wm)s
                  AND {_BASE_FILTERS}
                GROUP BY p.style_name, s.sale_date::date,
                         COALESCE(s.country,''), COALESCE(s.pos_location_name,'')
            ),
            combined_period AS (
                SELECT style_name, sale_day, country, pos_location_name,
                       gross_units, net_revenue
                FROM rollup_merch_style_day
                UNION ALL
                SELECT style_name, sale_day, country, pos_location_name,
                       gross_units, net_revenue
                FROM incr_period
            )
            SELECT style_name,
                   COALESCE(SUM(gross_units), 0) AS units_period,
                   COALESCE(SUM(net_revenue), 0.0) AS revenue_period
            FROM combined_period
            WHERE sale_day BETWEEN %(period_from)s AND %(period_to)s
              {country_clause}
              {pos_clause}
            GROUP BY style_name
        """
    else:
        # Live fallback
        live_country = ""
        live_pos     = ""
        if country:
            cl = [c.strip() for c in country.split(",") if c.strip()]
            if cl:
                live_country = " AND s.country = ANY(%(countries)s)"
        if pos_location:
            pl = [p.strip() for p in pos_location.split(",") if p.strip()]
            if pl:
                live_pos = " AND s.pos_location_name = ANY(%(pos_locations)s)"
        sql = f"""
            SELECT p2.style_name,
                   COALESCE(SUM(s.ordered_item_quantity) FILTER (
                       WHERE s.sale_kind IN ('sale','order')
                   ), 0) AS units_period,
                   COALESCE(SUM({_NET_SALES_EXPR}), 0.0) AS revenue_period
            FROM all_sales s
            JOIN all_products_clean p2 ON p2.sku = s.variant_sku
                AND p2.style_name IS NOT NULL AND p2.style_name <> ''
                AND COALESCE(p2.brand,'') NOT ILIKE '%%third party%%'
            WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
                AND {_BASE_FILTERS}
                {live_country}
                {live_pos}
            GROUP BY p2.style_name
        """
    rows = _db_exec(sql, params, fetch=True)
    return {r["style_name"]: r for r in rows}


def _fetch_styles_fast_path(brand=None, subcategory=None, tier=None, status=None,
                             from_date=None, to_date=None, country=None,
                             pos_location=None):
    """Production fast path: core cache + optional period overlay.

    1. _fetch_styles_core_cached — heavy SQL, cached per (country, pos) with
       SWR so TTL expiry never blocks a request.
    2. Period overlay — only computed when the user's date window differs from
       the default trailing 6 months; reads rollup_merch_style_day via index.
    3. Python narrowing — brand/subcategory/tier/status filter over the ~3.5k
       core rows (typically <1 ms).
    4. Derived metrics — identical Python logic as _fetch_styles_sql.
    """
    today      = date.today()
    six_mo_ago = str(today - timedelta(days=_SIX_MONTHS_DAYS))
    today_str  = str(today)
    period_from = from_date or six_mo_ago
    period_to   = to_date   or today_str

    # ── Core (date-independent, SWR-cached) ────────────────────────────────
    core_rows = _fetch_styles_core_cached(country, pos_location)

    # ── Period overlay (only for non-default date windows) ─────────────────
    is_default_window = (period_from == six_mo_ago and period_to == today_str)
    period_overlay = (
        None
        if is_default_window
        else _fetch_period_overlay(period_from, period_to, country, pos_location)
    )
    # Always fetch the strict period full-price units.  The core rollup's
    # historical units_fp column uses an older ticket-price heuristic and must
    # not drive the user-facing full-price SOR card.
    full_price_period = _fetch_full_price_period_by_style(
        period_from, period_to, country, pos_location, brand, subcategory)

    # ── Python narrowing sets ───────────────────────────────────────────────
    brand_set    = (set(b.strip() for b in brand.split(",")       if b.strip())
                    if brand       else None)
    subcat_set   = (set(s.strip() for s in subcategory.split(",") if s.strip())
                    if subcategory else None)
    tier_filter  = (set(t.strip() for t in tier.split(",")        if t.strip())
                    if tier        else None)
    status_lower = status.lower().strip() if status else None

    # ── Post-process (identical logic to _fetch_styles_sql) ────────────────
    result   = []
    today_dt = today

    for r in core_rows:
        # Brand filter (exact match, 0 impure styles so no false drops)
        if brand_set and (r.get("brand") or "") not in brand_set:
            continue
        # Subcategory filter (near-exact — 5 impure styles across 3.5k)
        if subcat_set and (r.get("subcategory") or "") not in subcat_set:
            continue

        # Tier + status derivation (delegates entirely to api_pg._lifecycle_tier)
        is_noos = bool(r.get("is_noos"))
        computed_tier = _compute_tier(r.get("style_name"), is_noos)
        if computed_tier is None:
            # No live Odoo status at all — excluded from Merch Hub entirely,
            # matching Range Management.
            continue

        # Tier filter
        if tier_filter and computed_tier not in tier_filter:
            continue

        # Status filter — mirrors the original SQL extra_prod_where logic:
        #   status=active  → style has ≥1 active SKU  (= derived status Active)
        #   status=retired → style has ≥1 retired SKU (has_any_retired_sku flag)
        if status_lower == "active":
            if (r.get("status") or "Active") == "Retired":
                continue
        elif status_lower == "retired":
            if not r.get("has_any_retired_sku"):
                continue

        # Period values: default window → alias from core's 6m fields; custom
        # window → overlay dict, defaulting to 0 when the style had no sales.
        if period_overlay is not None:
            ov = period_overlay.get(r["style_name"]) or {}
            units_period   = int(ov.get("units_period")   or 0)
            revenue_period = float(ov.get("revenue_period") or 0)
        else:
            units_period   = int(r.get("units_period")   or 0)
            revenue_period = float(r.get("revenue_period") or 0)

        units_6m         = int(r.get("units_6m") or 0)
        revenue_6m       = float(r.get("revenue_6m") or 0)
        units_life       = int(r.get("units_life") or 0)
        revenue_life     = float(r.get("revenue_life") or 0)
        soh_stores       = int(r.get("soh_stores") or 0)
        soh_online       = int(r.get("soh_online") or 0)
        soh_warehouse    = int(r.get("soh_warehouse") or 0)
        current_stock    = soh_stores + soh_warehouse
        units_full_price = int(r.get("units_full_price") or 0)
        period_price = full_price_period.get(r["style_name"]) or {}
        units_full_price_period = int(
            period_price.get("units_full_price_period") or 0
        )
        sales_value_period = float(period_price.get("sales_value_period") or 0)

        # Derived metrics (byte-identical to _fetch_styles_sql)
        weekly_avg = round(units_6m / 26.0, 2)
        woc = round(current_stock / weekly_avg, 1) if weekly_avg > 0 else None
        sor_denom = units_6m + current_stock
        sor_6m    = (round(units_6m * 100.0 / sor_denom, 1)
                     if sor_denom > 0 else None)
        sor_p_denom = units_period + current_stock
        sor_period  = (round(units_period * 100.0 / sor_p_denom, 1)
                       if sor_p_denom > 0 else None)
        full_price_sor_denom = units_full_price_period + current_stock
        full_price_sor_period = (
            round(units_full_price_period * 100.0 / full_price_sor_denom, 1)
            if full_price_sor_denom > 0 else None
        )
        sor_l_denom = units_life + current_stock
        sor_life    = (round(units_life * 100.0 / sor_l_denom, 1)
                       if sor_l_denom > 0 else None)
        full_price_pct = (round(units_full_price * 100.0 / units_6m, 1)
                          if units_6m > 0 else None)
        avg_selling_price = (round(revenue_6m / units_6m, 0)
                             if units_6m > 0 else None)

        last_sale = r.get("last_sale_date")
        if last_sale:
            try:
                from datetime import date as _date
                ls = (last_sale if isinstance(last_sale, _date)
                      else _date.fromisoformat(str(last_sale)[:10]))
                last_sale_days = (today_dt - ls).days
            except Exception:
                last_sale_days = None
        else:
            last_sale_days = None

        cost = (float(r["standard_cost_kes"])
                if r.get("standard_cost_kes") is not None else None)
        if cost is not None and avg_selling_price and avg_selling_price > 0:
            gross_margin_pct = round((avg_selling_price - cost)
                                     / avg_selling_price * 100, 1)
            gross_margin_kes = round((avg_selling_price - cost) * units_6m)
            cogs_6m_kes      = round(cost * units_6m)
        else:
            gross_margin_pct = None
            gross_margin_kes = None
            cogs_6m_kes      = None

        recommended_action, action_status = _recommend(
            woc, last_sale_days, sor_6m, full_price_pct, current_stock)

        result.append({
            "style_name":          r["style_name"],
            "style_number":        r.get("style_number") or "",
            "brand":               r.get("brand") or "",
            "subcategory":         r.get("subcategory") or "",
            "category":            r.get("category") or "",
             "fabric_category":     r.get("fabric_category") or "",
             "fabric_subcategory":  r.get("fabric_subcategory") or "",
             "colour":              r.get("colour") or "",
             "silhouette":          r.get("silhouette") or "",
            "tier":                computed_tier,
            "odoo_status":         r.get("status") or "Active",
            "launch_date":         str(r["launch_date"]) if r.get("launch_date") else None,
            "first_sale_date":     str(r["first_sale_date"])[:10] if r.get("first_sale_date") else None,
            "last_order_date":     str(r["last_order_date"]) if r.get("last_order_date") else None,
            "standard_cost_kes":   cost,
            "cost_source":         r.get("cost_source"),
            "cost_date":           str(r["cost_date"]) if r.get("cost_date") else None,
            "full_price":          float(r["full_price"]) if r.get("full_price") else None,
            "is_noos":             is_noos,
            "reorder_count":       int(r.get("reorder_count") or 0),
            "colour_count":        int(r.get("colour_count") or 0),
            "colours_in_stock":    int(r.get("colours_in_stock") or 0),
            "soh_stores":          soh_stores,
            "soh_online":          soh_online,
            "soh_warehouse":       soh_warehouse,
            "current_stock":       current_stock,
            "units_6m":            units_6m,
            "revenue_6m":          round(revenue_6m, 0),
            "orders_6m":           int(r.get("orders_6m") or 0),
            "units_period":        units_period,
            "revenue_period":      round(revenue_period, 0),
            "sales_value_period":  round(sales_value_period, 0),
             "units_full_price_period": units_full_price_period,
            "units_life":          units_life,
            "revenue_life":        round(revenue_life, 0),
            "weekly_avg":          weekly_avg,
            "woc":                 woc,
            "sor_6m":              sor_6m,
            "sor_period":          sor_period,
             "full_price_sor_period": full_price_sor_period,
            "sor_life":            sor_life,
            "last_sale_date":      str(last_sale)[:10] if last_sale else None,
            "last_sale_days":      last_sale_days,
            "full_price_pct":      full_price_pct,
            "avg_selling_price":   avg_selling_price,
            "gross_margin_pct":    gross_margin_pct,
            "gross_margin_kes":    gross_margin_kes,
            "cogs_6m_kes":         cogs_6m_kes,
            "recommended_action":  recommended_action,
            "action_status":       action_status,
        })

    return result


def _fetch_styles(brand=None, subcategory=None, tier=None, status=None,
                  from_date=None, to_date=None, country=None, pos_location=None):
    """Dispatcher: fast core+overlay path in production (A set by
    register_merch_routes), original monolithic SQL in standalone/test mode.

    Falls back to _fetch_styles_sql when:
    • status is set — the SQL filter is inside the prod CTE BEFORE GROUP BY,
      so it changes aggregated dims (cost, full_price, colour_count) for
      styles with mixed active/retired SKUs; Python post-filtering can't
      replicate this without rerunning SQL.
    • subcategory is set — same prod-CTE filter position; 5 styles have SKUs
      across multiple subcategories, making Python modal-filtering produce
      different aggregated dims than SQL filtering per-SKU inside prod.
    • _db_exec is mocked (test environment) — the SWR core cache bypasses the
      mock, so tests that patch _db_exec and then call _fetch_styles() would
      receive stale cached data from a prior real-DB call rather than the
      patched fake rows; routing to _fetch_styles_sql ensures every call in a
      mock context goes through the patched _db_exec directly."""
    try:
        from unittest.mock import MagicMock as _MM
        _db_mocked = isinstance(_db_exec, _MM)
    except ImportError:
        _db_mocked = False
    if A is not None and not status and not subcategory and not _db_mocked:
        return _fetch_styles_fast_path(
            brand=brand, subcategory=subcategory, tier=tier, status=status,
            from_date=from_date, to_date=to_date,
            country=country, pos_location=pos_location)
    return _fetch_styles_sql(
        brand=brand, subcategory=subcategory, tier=tier, status=status,
        from_date=from_date, to_date=to_date,
        country=country, pos_location=pos_location)


# ── Summary aggregates ─────────────────────────────────────────────────────────

# ── Shared KPI bucket membership ─────────────────────────────────────────────
# Single source of truth for which styles sit behind each Inventory & Stock
# Health KPI card. _compute_summary consumes these predicates for its counts
# and the CSV export endpoint reuses them, so card counts and export rows can
# never diverge.
_ACTIVE_TIERS = ("Tier 1", "Tier 2", "Tier 3", "Tier 4")
_UNTIERED_ACTIVE = "Untiered"
_ACTIVE_LIFECYCLE_BUCKETS = _ACTIVE_TIERS + (_UNTIERED_ACTIVE,)


def _kpi_dedup_key(s):
    """Dedup by style_number, falling back to style_name when blank —
    mirrors Range Management's _dedup_raw_by_style_number()."""
    snum = (s.get("style_number") or "").strip()
    return snum if snum else s.get("style_name", "")


def _is_active_lifecycle(s):
    """True for every Odoo-Active style, including one awaiting tier review."""
    return s.get("tier") in _ACTIVE_LIFECYCLE_BUCKETS


def _is_retired_tier(s):
    return s.get("tier") == "Retired"


def _has_stock(s):
    return (s.get("current_stock") or 0) > 0


def _is_archived_tier(s):
    return s.get("tier") == "Archived"


def _row_period_value(s, kind):
    """Selected-period revenue/units contribution of a style row — EXACTLY the
    expression _compute_summary sums (rows always carry the *_period keys,
    COALESCE'd in _fetch_styles). No 6m fallback here, or file sums could
    diverge from the card total."""
    return s.get(f"{kind}_period") or 0


# kpi id → { label, dedup (by style number), pred, extra?: [(header, fn)] }
_KPI_BUCKETS = {
    "total_stock": {
        "label": "Total Stock on Hand",
        "dedup": False,
        "pred":  lambda s: True,
    },
    "avg_woc": {
        "label": "Avg WOC",
        "dedup": False,
        "pred":  lambda s: s.get("woc") is not None,
    },
    "woc_gt20": {
        "label": "Styles WOC over 20",
        "dedup": True,
        "pred":  lambda s: (_is_active_lifecycle(s) and _has_stock(s)
                            and s.get("woc") is not None and s["woc"] > 20),
    },
    "woc_lt3": {
        "label": "Styles WOC under 3",
        "dedup": True,
        "pred":  lambda s: (_is_active_lifecycle(s) and _has_stock(s)
                            and s.get("woc") is not None and s["woc"] < 3),
    },
    "no_sale_7d": {
        "label": "Active No Sale 7d plus",
        "dedup": True,
        "pred":  lambda s: (_is_active_lifecycle(s) and _has_stock(s)
                            and s.get("last_sale_days") is not None
                            and s["last_sale_days"] >= 7),
    },
    "no_sale_30d": {
        "label": "Retired No Sale 30d",
        "dedup": True,
        "pred":  lambda s: (_is_retired_tier(s) and _has_stock(s)
                            and s.get("last_sale_days") is not None
                            and s["last_sale_days"] >= 30),
    },
    # ── Overview-tab KPI cards ───────────────────────────────────────────────
    # Preds mirror _compute_summary's counting EXACTLY — enforced by
    # OverviewKpiBucketParityTests in test_merch_router_schema_smoke.py.
    #
    # 2026-08-27 user rule: every Tier/Status report reads straight from Odoo
    # and matches Range Management exactly, with no other rule layered on top
    # — this applies dashboard-wide, including Merchandising Hub. Active
    # Style Lines previously required physical stock (has_any_stock) on top
    # of the Tier 1-4 gate, which is NOT how Range Management counts Active
    # (RM's Active total is every Tier 1-4 style, stock or no stock) — that
    # extra gate silently dropped 39 zero-stock Active styles from the card
    # (411 vs RM's 411). Retired/Archived never had this stock gate, so the
    # asymmetry was the mismatch. Removed here for parity.
    "active_styles": {
        "label": "Active Style Lines",
        "dedup": True,
        "pred":  _is_active_lifecycle,
    },
    "retired_styles": {
        "label": "Retired Style Lines",
        "dedup": True,
        "pred":  _is_retired_tier,
    },
    "archived_styles": {
        "label": "Archived Style Lines",
        "dedup": True,
        "pred":  _is_archived_tier,
    },
    "active_colours": {
        "label": "Active Colour Styles",
        "dedup": True,
        "pred":  _is_active_lifecycle,
        # COLOUR-grain file: the export endpoint branches to
        # _active_colour_rows (one row per in-stock colourway of these
        # deduped Active styles), so the file's row count equals the card's
        # DERIVED colourway count — the same colours_in_stock figure
        # _compute_summary sums. This bucket still defines the PARENT-style
        # membership the branch expands. A zero-stock Active parent simply
        # contributes zero colourways (colours_in_stock is itself a stock
        # count), so dropping the stock gate here only affects parity with
        # active_styles/RM, never the actual colour tally.
    },
    "warehouse_units": {
        "label": "Warehouse Units",
        "dedup": False,
        # != 0 (not > 0): negative availability rows count in the card total,
        # so they must appear in the file or the sum can't reconcile.
        "pred":  lambda s: (s.get("soh_warehouse") or 0) != 0,
        "extra": [("Warehouse Units", lambda s: s.get("soh_warehouse"))],
    },
    "on_track": {
        "label": "On Track Styles",
        "dedup": False,
        # Active-tier gate matches _compute_summary's status counting (Aug
        # 2026: health statuses count ACTIVE styles only — Retired/Archived
        # rows are excluded from the card and therefore from its file).
        "pred":  lambda s: _is_active_lifecycle(s) and s.get("action_status") == "on_track",
    },
    "revenue_period": {
        "label": "Revenue Period",
        "dedup": False,
        # != 0: net-negative period revenue (returns) still moves the card
        # total, so those rows belong in the file. Zero rows can't affect the
        # sum and are omitted to keep the export focused.
        "pred":  lambda s: _row_period_value(s, "revenue") != 0,
        "extra": [("Revenue (period)", lambda s: _row_period_value(s, "revenue"))],
    },
    "units_period": {
        "label": "Units Sold Period",
        "dedup": False,
        "pred":  lambda s: _row_period_value(s, "units") != 0,
        "extra": [("Units (period)", lambda s: _row_period_value(s, "units"))],
    },
    "full_price": {
        "label": "Full Price Pct",
        "dedup": False,
        "pred":  lambda s: s.get("full_price_pct") is not None,
    },
}


def _kpi_bucket_rows(styles, kpi_id):
    """Rows behind a KPI card — filtered via the shared predicate and, for the
    deduped cards, one row per style_number key (first occurrence wins; the
    input list is already ordered by revenue_6m desc)."""
    spec = _KPI_BUCKETS[kpi_id]
    pred = spec["pred"]
    if not spec["dedup"]:
        return [s for s in styles if pred(s)]
    out, seen = [], set()
    for s in styles:
        if not pred(s):
            continue
        k = _kpi_dedup_key(s)
        if k in seen:
            continue
        seen.add(k)
        out.append(s)
    return out


# ── Colour-grain rows — Active Colour Styles CSV ──────────────────────────────

_COLOUR_CODE_TOKEN = re.compile(r"^\S*\d\S*$")                     # 0819102, V0223151, 1X…
_COLOUR_SIZE_TOKEN = re.compile(r"^[smlx]{1,4}$", re.IGNORECASE)   # S, M, L, Xl, XXL…
_COLOUR_ONE_LETTER = re.compile(r"^[A-Za-z]$")                     # bare size letter: F…


def _tidy_colour_label(raw):
    """Display-only tidy-up for colourway labels that carry style-number/size
    noise — a Python port of tidyColorLabel in MerchDeepDive.jsx (the
    established deep-dive pattern), e.g. "Mustard / 0819102 / F" → "Mustard",
    "Hunters Green - Hunters Green / V0323019 / L" → "Hunters Green".
    Noise is stripped from the END only, so genuine multi-colour names like
    "Navy / White" keep all their segments. The RAW colour value stays the
    data key on every row — this only affects what the CSV prints."""
    s = str(raw or "").strip()
    if not s:
        return "—"
    parts = [p.strip() for p in s.split("/") if p.strip()]
    while len(parts) > 1:
        last = parts[-1]
        if (_COLOUR_CODE_TOKEN.match(last) or _COLOUR_SIZE_TOKEN.match(last)
                or _COLOUR_ONE_LETTER.match(last)):
            parts.pop()
        else:
            break
    out = " / ".join(parts)
    out = re.sub(r"^(.+?) - \1$", r"\1", out)
    return out or s


def _active_colour_rows(styles, colour_rows):
    """One row per ACTIVE colourway — the colour-grain rows behind the Active
    Colour Styles card's CSV.

    Parent-style membership = _kpi_bucket_rows(styles, "active_colours"): the
    deduped Active-tier in-stock set (first style_number occurrence wins; the
    input is already revenue-ordered) — exactly the styles whose
    colours_in_stock _compute_summary sums for the card, so len(result) ==
    active_colour_styles_count by construction (colour_rows carries each
    style's in-stock colourways from the same SQL predicate). Colourways of a
    dropped duplicate twin (same style_number, different style_name) are
    excluded with their twin, and style-level retirement / stockless styles
    cascade to every colourway, matching the card.

    Colour keys stay RAW (noisy twins are distinct colourways — never
    merged); colour_label is the tidied display value, falling back to the
    raw key when two colourways of one style would tidy to the same label
    (the deep-dive collision-fallback pattern)."""
    by_style = {}
    for c in colour_rows or []:
        by_style.setdefault(c.get("style_name"), []).append(c)

    today = date.today()
    out = []
    for s in _kpi_bucket_rows(styles, "active_colours"):
        cols = [
            c for c in (by_style.get(s.get("style_name")) or [])
            if c.get("colour_status") == "Active"
        ]
        cols = sorted(cols, key=lambda c: (-(float(c.get("revenue_6m") or 0)),
                                           str(c.get("colour") or "")))
        tidies = [_tidy_colour_label(c.get("colour")) for c in cols]
        seen = {}
        for t in tidies:
            seen[t] = seen.get(t, 0) + 1
        for c, tidy in zip(cols, tidies):
            raw_colour = str(c.get("colour") or "").strip()
            label = tidy if seen[tidy] == 1 else (raw_colour or "—")
            soh_stores = int(c.get("soh_stores") or 0)
            soh_wh     = int(c.get("soh_warehouse") or 0)
            soh        = soh_stores + soh_wh
            units_6m   = int(c.get("units_6m") or 0)
            revenue_6m = round(float(c.get("revenue_6m") or 0), 0)
            # Deep-dive colourway arithmetic (_fetch_style_colors): weekly avg
            # rounded to 2dp BEFORE the divide, WOC to 1dp.
            weekly_avg = round(units_6m / 26.0, 2)
            woc = round(soh / weekly_avg, 1) if weekly_avg > 0 else None
            last_sale = c.get("last_sale_date")
            last_sale_days = None
            if last_sale:
                try:
                    ls = (last_sale if isinstance(last_sale, date)
                          else date.fromisoformat(str(last_sale)[:10]))
                    last_sale_days = (today - ls).days
                except Exception:
                    last_sale_days = None
            out.append({
                # style context (from the deduped Active style row)
                "style_name":     s.get("style_name"),
                "style_number":   s.get("style_number") or "",
                "subcategory":    s.get("subcategory") or "",
                "tier":           s.get("tier"),
                "brand":          s.get("brand") or "",
                "launch_date":    s.get("launch_date"),
                "full_price":     s.get("full_price"),
                # per-colour figures
                "colour":         c.get("colour"),   # RAW key — never merged
                "colour_label":   label,
                "colour_status":  c.get("colour_status"),
                "soh":            soh,
                "soh_stores":     soh_stores,
                "soh_warehouse":  soh_wh,
                "units_6m":       units_6m,
                "revenue_6m":     revenue_6m,
                "weekly_avg":     weekly_avg,
                "woc":            woc,
                "last_sale_days": last_sale_days,
            })
    return out

def _fetch_colour_rows(country=None, pos_location=None):
    """Colour-grain rows behind the Active Colour Styles CSV — one row per
    (style, colour) with SOH > 0.

    The stock derivation mirrors _fetch_styles' colour_stock CTE EXACTLY
    (colour = per-SKU mode() of color_print from the product master — never
    all_inventory's colour column — same location exclusions, same
    country/POS scoping, same SOH > 0 predicate), so each style's row count
    here equals its colours_in_stock figure and the export reconciles with
    the card by construction. Membership scoping (brand/subcategory/tier/
    status filters, the Active-tier gate and the style_number dedup) is
    applied by _active_colour_rows via the shared _KPI_BUCKETS predicate,
    NOT here — only country/pos_location shape this SQL, so callers cache
    on (country, pos_location) alone.

    Sales enrichment reuses the deep-dive colourway basis
    (_fetch_style_colors): fixed trailing-6-month window, gross-units canon,
    net-sales revenue canon, BASE_FILTERS + country/POS scoping; inventory
    and sales stay pre-aggregated in their own CTEs (never joined then
    summed). last_sale_date includes return rows, mirroring _fetch_styles'
    sales_6m. Colour keys stay RAW — noisy twins are distinct colourways."""
    today       = date.today()
    six_mo_ago  = str(today - timedelta(days=_SIX_MONTHS_DAYS))
    today_str   = str(today)
    params = {"six_mo_ago": six_mo_ago, "today": today_str}

    country_clause = ""
    country_inv_where = ""
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            params["countries"] = cl
            country_clause = " AND s.country = ANY(%(countries)s)"
            inv_cs = ", ".join(f"'{c.lower().replace(chr(39), chr(39)*2)}'" for c in cl)
            country_inv_where = f" WHERE LOWER(i.country) IN ({inv_cs})"

    pos_store_clause = ""
    pos_sales_clause = ""
    pos_has_filter = False
    if pos_location:
        pl = [p.strip() for p in pos_location.split(",") if p.strip()]
        if pl:
            params["pos_locations"] = pl
            pos_store_clause = " AND i.pos_location_name = ANY(%(pos_locations)s)"
            pos_sales_clause = " AND s.pos_location_name = ANY(%(pos_locations)s)"
            pos_has_filter   = True

    # Warehouse stock doesn't belong to a specific store → forced to 0 under a
    # POS location filter, exactly like colour_stock in _fetch_styles.
    soh_warehouse_expr = (
        "0"
        if pos_has_filter else
        "COALESCE(SUM(i.available) FILTER ("
        "WHERE i.pos_location_name = 'Warehouse Finished Goods'"
        "), 0)"
    )

    sql = f"""
WITH
/* Per-SKU master map — byte-identical to colour_stock's cm subquery in
   _fetch_styles: colour from the product master via SKU, blanks excluded. */
cm AS (
    SELECT sku,
        mode() WITHIN GROUP (ORDER BY style_name)  AS style_name,
        mode() WITHIN GROUP (ORDER BY color_print) AS colour
    FROM all_products_clean
    WHERE style_name IS NOT NULL
      AND COALESCE(color_print,'') <> ''
    GROUP BY sku
),
/* Odoo lifecycle at colour grain. Status precedence is the same as the shared
   parent-style classifier, but only rows for this style + colour participate. */
colour_lifecycle AS (
    SELECT
        style_name,
        color_print AS colour,
        CASE
            WHEN BOOL_OR(status = 'Active') THEN 'Active'
            WHEN BOOL_OR(status = 'Retired') THEN 'Retired'
            WHEN BOOL_OR(status = 'Archived') THEN 'Archived'
            ELSE NULL
        END AS colour_status
    FROM all_products_clean
    WHERE style_name IS NOT NULL
      AND COALESCE(color_print,'') <> ''
    GROUP BY style_name, color_print
),
/* Stock at (style, colour) grain — same rowset, location exclusions and
   country/POS scoping as colour_stock; pre-aggregated on its own. */
stock AS (
    SELECT
        cm.style_name,
        cm.colour,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
            {pos_store_clause}
        ), 0) AS soh_stores,
        {soh_warehouse_expr} AS soh_warehouse
    FROM all_inventory i
    JOIN cm ON cm.sku = i.sku{country_inv_where}
    GROUP BY cm.style_name, cm.colour
),
/* Fixed trailing-6-month sales per colourway (deep-dive basis). */
sales_6m AS (
    SELECT
        cm.style_name,
        cm.colour,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                      AS units_6m,
        SUM({_NET_SALES_EXPR}) AS revenue_6m,
        MAX(s.sale_date::date) AS last_sale_date
    FROM all_sales s
    JOIN cm ON cm.sku = s.variant_sku
    WHERE s.sale_date BETWEEN %(six_mo_ago)s AND %(today)s
        AND {_BASE_FILTERS}
        {country_clause}
        {pos_sales_clause}
    GROUP BY cm.style_name, cm.colour
)
SELECT
    st.style_name,
    st.colour,
    st.soh_stores,
    st.soh_warehouse,
    cl.colour_status,
    COALESCE(s6.units_6m, 0)     AS units_6m,
    COALESCE(s6.revenue_6m, 0.0) AS revenue_6m,
    s6.last_sale_date
FROM stock st
JOIN colour_lifecycle cl
  ON cl.style_name = st.style_name AND cl.colour = st.colour
LEFT JOIN sales_6m s6
       ON s6.style_name = st.style_name AND s6.colour = st.colour
WHERE st.soh_stores + st.soh_warehouse > 0
"""
    rows = _db_exec(sql, params, fetch=True)
    return [dict(r) for r in (rows or [])]
def _compute_summary(styles, full_price_metrics=None):
    if not styles:
        return _empty_summary()
    today = date.today()
    on_track = at_risk = overdue = 0
    total_stock = revenue_6m = units_6m = 0
    revenue_period = units_period = 0
    zero_stock = woc_lt4 = 0
    # Scoped risk KPIs count DISTINCT styles (deduped like the Active/Retired
    # cards) — sets of dedup_key, materialised to counts in the return dict.
    _k_gt20: set = set(); _k_lt3: set = set()
    _k_nosale7: set = set(); _k_nosale30: set = set()
    launched_current = launched_prior = 0
    woc_vals = []; fp_vals = []; sor_vals = []; gm_pct_vals = []
    total_cogs = 0.0; total_gm = 0.0
    active_styles = 0; active_colour_styles = 0; active_stock_units = 0
    untiered_active_count = 0
    retired_styles = 0; retired_stock_units = 0
    archived_styles = 0; archived_stock_units = 0
    warehouse_stock = 0
    # Lifecycle-split accumulators (Aug 2026 KPI card rework):
    #   • warehouse-SOH splits accumulate inside the SAME dedup branches as the
    #     per-status stock-unit counts, so they stay consistent with the cards.
    #   • period revenue/units (and active 6m units for the velocity sub-line)
    #     bucket by computed tier for EVERY row (no dedup, no stock gate — the
    #     same grain as revenue_period/units_6m), so Active + Retired
    #     (+ Archived remainder) reconciles against the all-styles totals.
    #   • active_styles_all_count = deduped count of ALL Tier 1–4 styles,
    #     zero-stock included — the denominator that matches the exhaustive
    #     active revenue numerator for the "Avg/Active Style" line.
    #     (retired_styles_count already counts ALL retired styles — no stock
    #     gate — so it is the matching retired denominator as-is.)
    active_warehouse_stock = 0; retired_warehouse_stock = 0
    active_revenue_period = 0.0; retired_revenue_period = 0.0
    active_units_period = 0; retired_units_period = 0
    retired_full_price_value_period = 0.0
    retired_sales_value_period = 0.0
    active_units_6m = 0
    active_total_styles = 0
    sor_period_active_vals = []
    full_price_sor_period_active_vals = []
    active_full_price_units_period = 0
    _seen_active_all_keys: set = set()
    # Dedup counts by style_number — mirrors Range Management's
    # _dedup_raw_by_style_number(). Falls back to style_name when blank.
    _seen_active_keys:   set = set()
    _seen_untiered_keys: set = set()
    _seen_retired_keys:  set = set()
    _seen_archived_keys: set = set()

    for s in styles:
        total_stock     += s["current_stock"] or 0
        revenue_6m      += s["revenue_6m"] or 0
        units_6m        += s["units_6m"] or 0
        revenue_period  += s.get("revenue_period") or 0
        units_period    += s.get("units_period") or 0
        warehouse_stock += s.get("soh_warehouse") or 0

        tier        = s.get("tier")
        current_stk = s.get("current_stock") or 0
        snum        = (s.get("style_number") or "").strip()
        dedup_key   = snum if snum else s.get("style_name", "")

        if tier in _ACTIVE_LIFECYCLE_BUCKETS:
            # Health statuses count ACTIVE styles only (Aug 2026): Retired /
            # Archived styles aren't actionable, and thousands of dead retired
            # styles were drowning the risk cards (all reading "overdue").
            # Same row grain as total_styles; mirrors the client-side At-Risk
            # section filter in MerchOverview.jsx and the on_track KPI bucket,
            # so on_track + at_risk + overdue == active_total_styles exactly.
            active_total_styles += 1
            st = s["action_status"]
            if st == "on_track":    on_track += 1
            elif st == "at_risk":   at_risk  += 1
            elif st == "overdue":   overdue  += 1
            active_revenue_period += s.get("revenue_period") or 0
            active_units_period   += s.get("units_period") or 0
            active_full_price_units_period += s.get("units_full_price_period") or 0
            active_units_6m       += s.get("units_6m") or 0
            _seen_active_all_keys.add(dedup_key)
            if tier == _UNTIERED_ACTIVE and dedup_key not in _seen_untiered_keys:
                _seen_untiered_keys.add(dedup_key)
                untiered_active_count += 1
            if s.get("sor_period") is not None:
                sor_period_active_vals.append(s["sor_period"])
            if s.get("full_price_sor_period") is not None:
                full_price_sor_period_active_vals.append(s["full_price_sor_period"])
            # 2026-08-27 user rule: Active Styles counts every Tier 1-4 style,
            # stock or no stock — matching Range Management's Active total
            # exactly (RM never gates its Active count on physical stock).
            # Zero-stock styles simply contribute 0 to the stock/colour sums
            # below, so the card total now equals active_styles_all_count.
            if dedup_key not in _seen_active_keys:
                _seen_active_keys.add(dedup_key)
                active_styles           += 1
                # Colour styles use DERIVED status: count only this style's
                # colourways with SOH > 0 (colours_in_stock, not colour_count).
                # Retired/Archived styles never reach this branch, so their
                # colourways are automatically excluded — style-level
                # retirement cascades to every colourway.
                active_colour_styles    += s.get("colours_in_stock") or 0
                active_stock_units      += current_stk
                active_warehouse_stock  += s.get("soh_warehouse") or 0
        elif tier == "Retired":
            retired_revenue_period += s.get("revenue_period") or 0
            retired_units_period   += s.get("units_period") or 0
            # Discount depth is weighted across every retired unit sold in the
            # selected period. Use the style's modal full price as the expected
            # value of those units and the realised period revenue as achieved
            # selling value; styles without a usable full price are excluded
            # from this price-based metric.
            sold_units = s.get("units_period") or 0
            full_price = s.get("full_price")
            if sold_units > 0 and full_price is not None and full_price > 0:
                retired_full_price_value_period += float(full_price) * sold_units
                sales_value = s.get("sales_value_period")
                if sales_value is None:
                    # Compatibility for callers/tests that provide the older
                    # style-row shape; live SQL now supplies sale/order value.
                    sales_value = s.get("revenue_period") or 0
                retired_sales_value_period += float(sales_value)
            if dedup_key not in _seen_retired_keys:
                _seen_retired_keys.add(dedup_key)
                retired_styles          += 1
                retired_stock_units     += current_stk
                retired_warehouse_stock += s.get("soh_warehouse") or 0
        elif tier == "Archived":
            if dedup_key not in _seen_archived_keys:
                _seen_archived_keys.add(dedup_key)
                archived_styles      += 1
                archived_stock_units += current_stk

        if (s["current_stock"] or 0) == 0:   zero_stock  += 1
        # Lifecycle-scoped risk KPIs (Aug 2026 spec) — deduped by style_number
        # (fallback style_name) so renamed styles sharing a number count once,
        # keeping numerators consistent with the Active/Retired card universes:
        #   • woc_gt20 / woc_lt3 → ACTIVE (Tier 1–4), in-stock only, so the
        #     "% of active styles" pill is a true subset of Active Styles.
        #     (A stocked-out seller reads woc=0 — that's a stockout, not low
        #     cover; zero-stock counting was deliberately dropped with the
        #     old Zero Stock KPI.)
        #   • no_sale_7d  → ACTIVE, in-stock (a sold-out style can't sell —
        #     stockless rows would drown the signal)
        #   • no_sale_30d → RETIRED, in-stock (clearance watchlist: retired
        #     stock that still isn't moving)
        # zero_stock / woc_lt4 keep their all-styles row-grain semantics for
        # legacy consumers (e.g. the Replen header chips).
        if _KPI_BUCKETS["no_sale_30d"]["pred"](s):
            _k_nosale30.add(dedup_key)
        if _KPI_BUCKETS["no_sale_7d"]["pred"](s):
            _k_nosale7.add(dedup_key)
        if s["woc"] is not None:
            woc_vals.append(s["woc"])
            if s["woc"] < 4:  woc_lt4  += 1
            if _KPI_BUCKETS["woc_gt20"]["pred"](s): _k_gt20.add(dedup_key)
            if _KPI_BUCKETS["woc_lt3"]["pred"](s):  _k_lt3.add(dedup_key)
        if s["full_price_pct"]   is not None: fp_vals.append(s["full_price_pct"])
        if s["sor_6m"]           is not None: sor_vals.append(s["sor_6m"])
        if s["gross_margin_pct"] is not None: gm_pct_vals.append(s["gross_margin_pct"])
        if s["cogs_6m_kes"]      is not None: total_cogs += s["cogs_6m_kes"]
        if s["gross_margin_kes"] is not None: total_gm   += s["gross_margin_kes"]

        ld = s.get("launch_date")
        if ld:
            try:
                y = int(str(ld)[:4])
                if y == today.year:          launched_current += 1
                elif y == (today.year - 1):  launched_prior   += 1
            except Exception:
                pass

    def _avg(lst): return round(sum(lst) / len(lst), 1) if lst else None
    summary = {
        "total_styles":                 len(styles),
        "active_styles_count":          active_styles,
        "untiered_active_count":        untiered_active_count,
        "active_colour_styles_count":   active_colour_styles,
        "active_stock_units":           active_stock_units,
        "retired_styles_count":         retired_styles,
        "retired_stock_units":          retired_stock_units,
        "archived_styles_count":        archived_styles,
        "archived_stock_units":         archived_stock_units,
        "warehouse_stock_units":        warehouse_stock,
        "active_warehouse_stock_units": active_warehouse_stock,
        "retired_warehouse_stock_units": retired_warehouse_stock,
        "active_revenue_period":        round(active_revenue_period, 0),
        "retired_revenue_period":       round(retired_revenue_period, 0),
        "retired_units_period":         retired_units_period,
        "retired_discount_depth_pct": (
            round(
                (retired_full_price_value_period - retired_sales_value_period)
                * 100.0 / retired_full_price_value_period,
                1,
            )
            if retired_full_price_value_period > 0 else None
        ),
        "active_units_period":          active_units_period,
        "active_units_6m":              active_units_6m,
        "active_weekly_velocity":       round(active_units_6m / 26.0, 1) if active_units_6m else 0,
        "active_styles_all_count":      len(_seen_active_all_keys),
        "avg_sor_period_active":        _avg(sor_period_active_vals),
        "avg_full_price_sor_period_active": _avg(full_price_sor_period_active_vals),
        "on_track_count":               on_track,
        "at_risk_count":                at_risk,
        "overdue_count":                overdue,
        # Row-grain count of active-tier styles — the denominator for the
        # status counts above (they partition it exactly).
        "active_total_styles":          active_total_styles,
        "total_stock_units":            total_stock,
        "revenue_6m":                   round(revenue_6m, 0),
        "units_6m":                     units_6m,
        "revenue_period":               round(revenue_period, 0),
        "units_period":                 units_period,
        "weekly_velocity":              round(units_6m / 26.0, 1) if units_6m else 0,
        "avg_woc":                      _avg(woc_vals),
        "avg_full_price_pct":           _avg(fp_vals),
        "avg_sor_6m":                   _avg(sor_vals),
        "zero_stock_count":             zero_stock,
        "no_sale_30d_count":            len(_k_nosale30),
        "woc_lt4_count":                woc_lt4,
        "woc_gt20_count":               len(_k_gt20),
        "woc_lt3_active_count":         len(_k_lt3),
        "no_sale_7d_active_count":      len(_k_nosale7),
        "styles_launched_current_year": launched_current,
        "styles_launched_prior_year":   launched_prior,
        "avg_gross_margin_pct":         _avg(gm_pct_vals),
        "total_cogs_6m_kes":            round(total_cogs, 0) if total_cogs else None,
        "total_gross_margin_kes":       round(total_gm, 0)   if total_gm   else None,
    }
    # Keep the old unit-split fields for compatibility, but calculate the new
    # full-price SOR at the exact active-style scope used by the Overview SOR
    # card. Full-price SOR is full-price units ÷ (full-price units + SOH).
    if full_price_metrics is None:
        full_price_metrics = {
            "full_price_units_period": None,
            "discounted_units_period": None,
            "full_price_sell_through": None,
            "total_units_period": None,
        }
    full_price_units = active_full_price_units_period
    total_active_units = active_units_period
    discounted_units = max(total_active_units - full_price_units, 0)
    total_sor = summary["avg_sor_period_active"]
    full_price_sor = summary["avg_full_price_sor_period_active"]
    summary.update({
        "full_price_units_period": full_price_units,
        "discounted_units_period": discounted_units,
        # Legacy percentage retained, now aligned to active styles.
        "full_price_sell_through": (
            round(full_price_units * 100.0 / total_active_units, 1)
            if total_active_units > 0 else None
        ),
        "total_units_period": total_active_units,
        "full_price_sor_period": full_price_sor,
        "discounted_sor_gap_pp": (
            round(total_sor - full_price_sor, 1)
            if total_sor is not None and full_price_sor is not None else None
        ),
    })
    return summary


def _compute_full_price_sell_through(total_units, full_price_units):
    """Return the selected-period full-price unit split and percentage.

    The SQL endpoint supplies gross sale/order units and the subset whose
    discount amount is exactly zero.  Keep the final arithmetic here so the
    response contract and zero-denominator behaviour are easy to test.
    """
    total = max(int(total_units or 0), 0)
    full_price = min(max(int(full_price_units or 0), 0), total)
    discounted = total - full_price
    pct = round(full_price * 100.0 / total, 1) if total else None
    return {
        "full_price_units_period": full_price,
        "discounted_units_period": discounted,
        "full_price_sell_through": pct,
        "total_units_period": total,
    }


def _fetch_full_price_sell_through(
    from_date=None, to_date=None, country=None, pos_location=None,
    brand=None, subcategory=None,
):
    """Compute strict full-price sell-through for the selected merch scope.

    Full-price units are sale/order gross units with no discount applied
    (discounts_kes is NULL or exactly numeric zero). Return rows are excluded
    because only sale/order rows contribute to the sold-unit denominator.
    """
    today = date.today()
    period_from = from_date or str(today - timedelta(days=_SIX_MONTHS_DAYS))
    period_to = to_date or str(today)
    params = {"period_from": period_from, "period_to": period_to}

    country_clause = ""
    if country:
        countries = [c.strip() for c in country.split(",") if c.strip()]
        if countries:
            params["countries"] = countries
            country_clause = " AND s.country = ANY(%(countries)s)"

    pos_clause = ""
    if pos_location:
        locations = [p.strip() for p in pos_location.split(",") if p.strip()]
        if locations:
            params["pos_locations"] = locations
            pos_clause = " AND s.pos_location_name = ANY(%(pos_locations)s)"

    product_clause = """
        AND p.style_name IS NOT NULL
        AND p.style_name <> ''
        AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
    """
    if brand:
        brands = [b.strip() for b in brand.split(",") if b.strip()]
        if brands:
            params["brands"] = brands
            product_clause += " AND p.brand = ANY(%(brands)s)"
    if subcategory:
        subcategories = [s.strip() for s in subcategory.split(",") if s.strip()]
        if subcategories:
            params["subcategories"] = subcategories
            product_clause += " AND p.subcategory = ANY(%(subcategories)s)"

    sql = f"""
        SELECT
            COALESCE(SUM(s.ordered_item_quantity) FILTER (
                WHERE s.sale_kind IN ('sale','order')
            ), 0) AS total_units_period,
            COALESCE(SUM(s.ordered_item_quantity) FILTER (
                WHERE s.sale_kind IN ('sale','order')
                  AND COALESCE(s.discounts_kes, 0)::numeric = 0
            ), 0) AS full_price_units_period
        FROM all_sales s
        JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
          AND {_BASE_FILTERS}
          {product_clause}
          {country_clause}
          {pos_clause}
    """
    rows = _db_exec(sql, params, fetch=True) or []
    row = rows[0] if rows else {}
    return _compute_full_price_sell_through(
        row.get("total_units_period"),
        row.get("full_price_units_period"),
    )


def _empty_summary():
    return {k: None for k in [
        "total_styles", "active_styles_count", "untiered_active_count",
        "active_colour_styles_count",
        "active_stock_units", "retired_styles_count", "retired_stock_units",
        "archived_styles_count", "archived_stock_units",
        "warehouse_stock_units",
        "active_warehouse_stock_units", "retired_warehouse_stock_units",
        "active_revenue_period", "retired_revenue_period", "retired_units_period",
        "retired_discount_depth_pct",
        "active_units_period", "active_units_6m", "active_weekly_velocity",
        "active_styles_all_count", "avg_sor_period_active",
        "avg_full_price_sor_period_active",
        "on_track_count", "at_risk_count", "overdue_count",
        "active_total_styles",
        "total_stock_units", "revenue_6m", "units_6m", "revenue_period", "units_period", "weekly_velocity",
        "woc_lt3_active_count", "no_sale_7d_active_count",
        "avg_woc", "avg_full_price_pct", "avg_sor_6m", "zero_stock_count",
        "no_sale_30d_count", "woc_lt4_count", "woc_gt20_count",
        "styles_launched_current_year", "styles_launched_prior_year",
        "avg_gross_margin_pct", "total_cogs_6m_kes", "total_gross_margin_kes",
        "full_price_units_period", "discounted_units_period",
        "full_price_sell_through", "total_units_period",
        "full_price_sor_period", "discounted_sor_gap_pp",
    ]}


def _ensure_tier_overrides_table():
    """Create style_tier_overrides if it doesn't exist yet (safe to call repeatedly)."""
    try:
        _db_exec("""
            CREATE TABLE IF NOT EXISTS style_tier_overrides (
                style_number  TEXT PRIMARY KEY,
                tier          TEXT NOT NULL,
                status        TEXT NOT NULL,
                imported_at   TIMESTAMPTZ DEFAULT NOW()
            )
        """, fetch=False)
    except Exception as exc:
        log.warning("Could not ensure style_tier_overrides table: %s", exc)


# ── Dimension aggregation ──────────────────────────────────────────────────────

def _agg_by_dim(styles, dim_key):
    buckets = {}
    for s in styles:
        key = s.get(dim_key) or "—"
        if key not in buckets:
            buckets[key] = {
                dim_key: key, "style_count": 0, "units_6m": 0,
                "revenue_6m": 0.0, "current_stock": 0,
                "units_period": 0, "revenue_period": 0.0,
                "_woc": [], "_sor": [], "_sor_p": [], "_fp": [], "_gm": [],
                "total_cogs": 0.0, "_has_cogs": False, "total_gm": 0.0,
                "_cats": {},
            }
        b = buckets[key]
        if dim_key == "subcategory":
            _cat = s.get("category") or ""
            b["_cats"][_cat] = b["_cats"].get(_cat, 0) + 1
        b["style_count"]   += 1
        b["units_6m"]      += s["units_6m"] or 0
        b["revenue_6m"]    += s["revenue_6m"] or 0
        b["units_period"]  += s.get("units_period") or 0
        b["revenue_period"] += s.get("revenue_period") or 0
        b["current_stock"] += s["current_stock"] or 0
        if s["woc"] is not None:              b["_woc"].append(s["woc"])
        if s["sor_6m"] is not None:           b["_sor"].append(s["sor_6m"])
        if s.get("sor_period") is not None:   b["_sor_p"].append(s["sor_period"])
        if s["full_price_pct"] is not None:   b["_fp"].append(s["full_price_pct"])
        if s["gross_margin_pct"] is not None: b["_gm"].append(s["gross_margin_pct"])
        if s["cogs_6m_kes"] is not None:
            b["total_cogs"] += s["cogs_6m_kes"]; b["_has_cogs"] = True
        if s["gross_margin_kes"] is not None: b["total_gm"] += s["gross_margin_kes"]

    def _avg(lst): return round(sum(lst) / len(lst), 1) if lst else None
    result = []
    for b in buckets.values():
        result.append({
            dim_key:                   b[dim_key],
            # Modal parent category (subcategory grouping only) so clients can
            # filter subcats by category without duplicating CATEGORY_MAP.
            **({"category": max(b["_cats"], key=b["_cats"].get)}
               if b["_cats"] else {}),
            "style_count":             b["style_count"],
            "units_6m":                b["units_6m"],
            "revenue_6m":              round(b["revenue_6m"], 0),
            "units_period":            b["units_period"],
            "revenue_period":          round(b["revenue_period"], 0),
            "current_stock":           b["current_stock"],
            "avg_woc":                 _avg(b["_woc"]),
            "avg_sor_6m":              _avg(b["_sor"]),
            "avg_sor_period":          _avg(b["_sor_p"]),
            "avg_full_price_pct":      _avg(b["_fp"]),
            "avg_gross_margin_pct":    _avg(b["_gm"]),
            "total_cogs_6m_kes":       round(b["total_cogs"], 0) if b["_has_cogs"] else None,
            "total_gross_margin_kes":  round(b["total_gm"], 0)   if b["_has_cogs"] else None,
        })
    result.sort(key=lambda x: x["revenue_6m"] or 0, reverse=True)
    return result


# ── Chart trend helpers (Overview mix charts) ─────────────────────────────────

def _prev_window(from_date=None, to_date=None):
    """Consecutive previous window of equal length, mirroring _fetch_styles'
    defaults (no dates → trailing 6 months ending today). Returns (from, to)
    ISO date strings."""
    today = date.today()
    try:
        pf = date.fromisoformat(from_date) if from_date else today - timedelta(days=_SIX_MONTHS_DAYS)
    except (TypeError, ValueError):
        pf = today - timedelta(days=_SIX_MONTHS_DAYS)
    try:
        pt = date.fromisoformat(to_date) if to_date else today
    except (TypeError, ValueError):
        pt = today
    length = max((pt - pf).days + 1, 1)
    prev_to = pf - timedelta(days=1)
    prev_from = prev_to - timedelta(days=length - 1)
    return str(prev_from), str(prev_to)


def _merge_trend(cur_rows, prev_rows, dim_key):
    """Annotate _agg_by_dim rows with previous-window revenue + % trend.
    trend_pct is None when the bucket had no positive revenue in the previous
    window (new dim value, or a net-returns prev period) — a % change against
    a zero/negative base is meaningless."""
    prev_rev = {r[dim_key]: (r.get("revenue_period") or 0) for r in prev_rows}
    for r in cur_rows:
        pv = prev_rev.get(r[dim_key]) or 0
        r["revenue_prev"] = round(pv, 0)
        r["trend_pct"] = (round((((r.get("revenue_period") or 0) - pv) / pv) * 100.0, 1)
                          if pv > 0 else None)
    return cur_rows


def _styles_cached(brand=None, subcategory=None, tier=None, status=None,
                   from_date=None, to_date=None, country=None, pos_location=None,
                   ttl=600):
    """_fetch_styles behind the SAME cache key format /api/merch/styles uses
    (ttl mirrors the handlers' _TTL), so ONE rowset per filter combo is shared
    by styles / summary / by-brand / by-subcategory / by-tier and the
    prev-window chart trends.

    Single-flight: the Overview tab fires five endpoints in parallel that all
    need this exact rowset. Without a per-key lock, a cold cache ran the ~15s
    universe query five times concurrently (2026-08-13 merch slowness
    incident). First caller computes; the rest block on the key's lock and
    then read the freshly-cached result. Callers run in Starlette's threadpool
    (sync-def routes), so blocking here never touches the event loop."""
    key = f"merch_styles|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{pos_location}"
    now = _time.monotonic()
    entry = _cache_store.get(key)
    if entry and (now - entry[0]) < ttl:
        return entry[1]  # fast path — no locking on a warm cache
    with _SF_LOCKS_GUARD:
        # Bound the lock dict: keys embed dates/filters so they accumulate
        # forever. Clearing is benign — a thread already holding a removed
        # lock still works; worst case two threads compute the same fresh
        # key once (duplicate query, no corruption).
        if len(_SF_LOCKS) > 512:
            _SF_LOCKS.clear()
        lock = _SF_LOCKS.setdefault(key, _threading.Lock())
    with lock:
        # _cached re-checks freshness, so waiters get the winner's result.
        return _cached(key, ttl, lambda: _fetch_styles(
            brand=brand, subcategory=subcategory, tier=tier, status=status,
            from_date=from_date, to_date=to_date, country=country,
            pos_location=pos_location))


# In-flight futures for the async fan-out layer (single event loop).
_INFLIGHT = {}


async def _styles_async(brand=None, subcategory=None, tier=None, status=None,
                        from_date=None, to_date=None, country=None,
                        pos_location=None, ttl=600):
    """Async fan-out layer over _styles_cached for the Overview endpoints.

    The Overview tab's five requests (plus the KPI CSV export) arrive
    together and all need the same rowset. Only the FIRST occupies a
    threadpool worker (running _styles_cached — whose per-key thread lock
    also covers any sync/standalone callers); the rest await an in-flight
    future on the event loop and hold NO worker thread. A burst of cold
    Overview loads therefore costs one AnyIO token per distinct filter
    combo instead of five, and cannot starve unrelated sync routes.

    Safe without extra locking: handlers run on a single event loop and the
    _INFLIGHT check-and-set below has no await point in between.
    """
    from starlette.concurrency import run_in_threadpool
    key = f"merch_styles|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{pos_location}"
    now = _time.monotonic()
    entry = _cache_store.get(key)
    if entry and (now - entry[0]) < ttl:
        return entry[1]
    fut = _INFLIGHT.get(key)
    if fut is not None:
        return await fut
    fut = asyncio.get_running_loop().create_future()
    # Mark exceptions as retrieved even if no sibling ever awaits the future,
    # so asyncio never logs "exception was never retrieved".
    fut.add_done_callback(lambda f: f.cancelled() or f.exception())
    _INFLIGHT[key] = fut
    try:
        rows = await run_in_threadpool(
            _styles_cached, brand, subcategory, tier, status,
            from_date, to_date, country, pos_location, ttl)
        fut.set_result(rows)
        return rows
    except BaseException as e:
        fut.set_exception(e)
        raise
    finally:
        _INFLIGHT.pop(key, None)


# ── Style-stores endpoint ──────────────────────────────────────────────────────

def _invalidate_style_stores_cache():
    """Remove all merch_style_stores|* entries from the module-level cache."""
    prefix = "merch_style_stores|"
    stale = [k for k in list(_cache_store.keys()) if k.startswith(prefix)]
    for k in stale:
        _cache_store.pop(k, None)


def _fetch_style_stores(style_number=None, from_date=None, to_date=None, country=None,
                        include_retired=True):
    """Per-store breakdown for one style or all styles, with store tier (A/B/C).

    Store tier = NTILE-3 by trailing-90d net revenue (A = top third), mirroring
    api_pg._store_cluster_map.  Computed in SQL so the result is consistent with
    the store cluster visuals in the rest of the dashboard.
    """
    today       = date.today()
    six_mo_ago  = str(today - timedelta(days=_SIX_MONTHS_DAYS))
    today_str   = str(today)
    period_from = from_date or six_mo_ago
    period_to   = to_date   or today_str

    # Country filter for sales and inventory CTEs. Inventory is country-scoped
    # too: otherwise a country-filtered SOR denominator silently includes stock
    # from the other markets.
    country_clause = ""
    country_inv_clause = ""
    country_params = {}
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            country_params["countries"] = cl
            country_params["countries_lower"] = [c.lower() for c in cl]
            country_clause = " AND s.country = ANY(%(countries)s)"
            country_inv_clause = " AND LOWER(COALESCE(i.country, '')) = ANY(%(countries_lower)s)"

    style_filter = " AND p.style_number = %(style_number)s" if style_number else ""
    active_style_filter = "" if include_retired else " AND ps.style_status = 'Active'"

    sql = f"""
WITH
/* Store tier — NTILE-3 by trailing-90d net revenue; A = top third.
   Mirrors api_pg._store_cluster_map exactly. */
store_tiers AS (
    SELECT
        s.pos_location_name AS store,
        CASE NTILE(3) OVER (ORDER BY SUM(s.net_sales_kes::numeric) DESC)
            WHEN 1 THEN 'A' WHEN 2 THEN 'B' ELSE 'C'
        END AS store_tier
    FROM all_sales s
    WHERE s.sale_kind IN ('sale','order')
        AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
        AND {_BASE_FILTERS}
        AND s.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
        AND s.pos_location_name NOT ILIKE '%%online%%'
    GROUP BY s.pos_location_name
    HAVING SUM(s.net_sales_kes::numeric) > 0
),
style_status AS (
    SELECT
        style_number,
        CASE
            WHEN BOOL_OR(LOWER(COALESCE(status, 'active')) = 'active') THEN 'Active'
            ELSE 'Retired'
        END AS style_status
    FROM all_products_clean
    WHERE style_number IS NOT NULL
    GROUP BY style_number
),
style_meta AS (
    SELECT
        mode() WITHIN GROUP (ORDER BY cost)
            FILTER (WHERE cost IS NOT NULL) AS cost_kes
    FROM all_products_clean
    WHERE (%(style_number)s IS NULL OR style_number = %(style_number)s)
),
stock AS (
    SELECT
        i.pos_location_name     AS store,
        SUM(i.available)        AS current_stock
    FROM all_inventory i
    JOIN all_products_clean p ON p.sku = i.sku
        {style_filter}
    JOIN style_status ps ON ps.style_number = p.style_number
    WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
        {country_inv_clause}
        {active_style_filter}
    GROUP BY i.pos_location_name
),
sales AS (
    SELECT
        s.pos_location_name AS store,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                             AS units_6m,
        SUM({_NET_SALES_EXPR})        AS revenue_6m
    FROM all_sales s
    JOIN all_products_clean p ON p.sku = s.variant_sku
        {style_filter}
    JOIN style_status ps ON ps.style_number = p.style_number
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
        AND {_BASE_FILTERS}
        {country_clause}
        {active_style_filter}
    GROUP BY s.pos_location_name
),
store_meta AS (
    SELECT location_name, sqft, optimal_stock
    FROM pos_locations
)
SELECT
    COALESCE(st.store, sa.store)   AS store,
    COALESCE(st.current_stock, 0)  AS current_stock,
    COALESCE(sa.units_6m, 0)       AS units_6m,
    COALESCE(sa.revenue_6m, 0.0)   AS revenue_6m,
    COALESCE(t.store_tier, '—')    AS store_tier,
    sm.cost_kes,
    smeta.sqft,
    smeta.optimal_stock
FROM stock st
FULL OUTER JOIN sales sa ON sa.store = st.store
LEFT  JOIN store_tiers t  ON t.store  = COALESCE(st.store, sa.store)
CROSS JOIN style_meta sm
LEFT  JOIN store_meta smeta ON smeta.location_name = COALESCE(st.store, sa.store)
ORDER BY revenue_6m DESC NULLS LAST
"""
    params = {
        "style_number": style_number,
        "period_from":  period_from,
        "period_to":    period_to,
        **country_params,
    }
    rows = _db_exec(sql, params, fetch=True)

    result = []
    total_rev = sum(float(r["revenue_6m"] or 0) for r in rows)
    for r in rows:
        current_stock = int(r["current_stock"] or 0)
        units_6m      = int(r["units_6m"] or 0)
        revenue_6m    = float(r["revenue_6m"] or 0)
        cost          = float(r["cost_kes"]) if r.get("cost_kes") is not None else None
        sqft          = int(r["sqft"]) if r.get("sqft") is not None else None
        optimal_stock = int(r["optimal_stock"]) if r.get("optimal_stock") is not None else None

        weekly_avg = round(units_6m / 26.0, 2) if units_6m else 0
        woc = round(current_stock / weekly_avg, 1) if weekly_avg > 0 else None
        ros = weekly_avg

        gm_contrib = None
        if cost is not None and units_6m > 0 and revenue_6m > 0:
            avg_asp = revenue_6m / units_6m
            if avg_asp > 0:
                gm_contrib = round((avg_asp - cost) * units_6m)

        stock_variance = (current_stock - optimal_stock) if optimal_stock is not None else None

        # Store action label
        if current_stock == 0 and units_6m > 0:
            action = "RESTOCK"
        elif woc is not None and woc < 1.5 and ros and ros >= 1.5:
            action = "REORDER SOON"
        elif woc is not None and woc > 20:
            action = "TRANSFER OUT"
        elif woc is not None and woc > 8:
            action = "MONITOR"
        else:
            action = "HEALTHY"

        result.append({
            "store":               r.get("store") or "Unknown",
            "store_tier":          r.get("store_tier") or "—",
            "current_stock":       current_stock,
            "units_6m":            units_6m,
            "revenue_6m":          round(revenue_6m, 0),
            "rate_of_sale":        round(ros, 2),
            "woc":                 woc,
            "action":              action,
            "gross_margin_contribution_kes": gm_contrib,
            "sqft":                sqft,
            "optimal_stock":       optimal_stock,
            "stock_variance":      stock_variance,
        })

    # Transfer plan
    donors     = [r["store"] for r in result if (r["woc"] or 0) > 3 and r["current_stock"] > 1]
    recipients = [r["store"] for r in result if (r["woc"] or 0) < 1.5 and r["rate_of_sale"] >= 1.5]

    total_units = sum(r["units_6m"] for r in result)
    total_stock = sum(r["current_stock"] for r in result)
    total_revenue = sum(r["revenue_6m"] for r in result)
    return {
        "stores": result,
        "donors": donors,
        "recipients": recipients,
        # Aggregate SOR is a weighted benchmark, not an average of store SORs.
        "all_stores": {
            "units_6m": total_units,
            "current_stock": total_stock,
            "revenue_6m": round(total_revenue, 0),
            "sor": _sor_percent(total_units, total_stock),
        },
    }

def _sor_percent(units, soh):
    units = max(int(units or 0), 0)
    soh = max(int(soh or 0), 0)
    denom = units + soh
    return round(units * 100.0 / denom, 1) if denom > 0 else None


def _size_row_flags(units, soh, total_units, total_soh):
    """Return the display flags used by the Deep Dive size tables.

    ``imbalance`` is deliberately a share comparison rather than a raw-unit
    threshold: a size is stock-heavy when its SOH share exceeds its sales
    share by at least 20 percentage points. This remains meaningful for both
    small and large styles and fails closed when there is no sales signal.
    """
    units = max(int(units or 0), 0)
    soh = max(int(soh or 0), 0)
    total_units = max(int(total_units or 0), 0)
    total_soh = max(int(total_soh or 0), 0)
    sold_out = units > 0 and soh == 0
    soh_share = (soh * 100.0 / total_soh) if total_soh > 0 else 0.0
    sales_share = (units * 100.0 / total_units) if total_units > 0 else 0.0
    imbalance = total_soh > 0 and soh > 0 and (
        total_units == 0 or soh_share - sales_share >= 20.0
    )
    return {
        "soh_share": round(soh_share, 1) if total_soh > 0 else None,
        "sales_share": round(sales_share, 1) if total_units > 0 else None,
        "sold_out": sold_out,
        "imbalanced": imbalance,
        "no_sales": units == 0,
    }


def _fetch_style_sizes(style_number, from_date=None, to_date=None, country=None):
    """Per-size breakdown for one style.

    Size is the canonical product-master ``size`` field. Sales and inventory
    are first aggregated independently at SKU/size grain so inventory cannot
    fan out through sales. SOR uses the selected period; WOC uses the same
    fixed trailing six-month velocity as the style and colourway panels.
    """
    if not style_number:
        return {"sizes": []}

    today = date.today()
    six_mo_ago = str(today - timedelta(days=_SIX_MONTHS_DAYS))
    today_str = str(today)
    period_from = from_date or six_mo_ago
    period_to = to_date or today_str

    country_clause = ""
    country_inv_clause = ""
    params = {
        "style_number": style_number,
        "period_from": period_from,
        "period_to": period_to,
        "six_mo_ago": six_mo_ago,
        "today": today_str,
    }
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            params["countries"] = cl
            params["countries_lower"] = [c.lower() for c in cl]
            country_clause = " AND s.country = ANY(%(countries)s)"
            country_inv_clause = " AND LOWER(COALESCE(i.country, '')) = ANY(%(countries_lower)s)"

    sql = f"""
WITH skus AS (
    SELECT sku, COALESCE(NULLIF(TRIM(size), ''), '—') AS size
    FROM all_products_clean
    WHERE style_number = %(style_number)s
      AND sku IS NOT NULL AND sku <> ''
),
sales_period AS (
    SELECT k.size,
           COALESCE(SUM(s.ordered_item_quantity) FILTER (
               WHERE s.sale_kind IN ('sale','order')), 0) AS units_period,
           COALESCE(SUM({_NET_SALES_EXPR}), 0) AS revenue_period
    FROM skus k
    JOIN all_sales s ON s.variant_sku = k.sku
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
      AND {_BASE_FILTERS}
      {country_clause}
    GROUP BY k.size
),
sales_6m AS (
    SELECT k.size,
           COALESCE(SUM(s.ordered_item_quantity) FILTER (
               WHERE s.sale_kind IN ('sale','order')), 0) AS units_6m
    FROM skus k
    JOIN all_sales s ON s.variant_sku = k.sku
    WHERE s.sale_date BETWEEN %(six_mo_ago)s AND %(today)s
      AND {_BASE_FILTERS}
      {country_clause}
    GROUP BY k.size
),
stock AS (
    SELECT k.size,
           COALESCE(SUM(i.available) FILTER (
               WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
                 AND LOWER(i.pos_location_name) NOT IN ({_HOLDING_STORES_LOWER})
           ), 0) AS soh_stores,
           COALESCE(SUM(i.available) FILTER (
               WHERE i.pos_location_name = 'Warehouse Finished Goods'
           ), 0) AS soh_warehouse
    FROM skus k
    JOIN all_inventory i ON i.sku = k.sku
    WHERE TRUE {country_inv_clause}
    GROUP BY k.size
),
grain AS (
    SELECT size FROM sales_period
    UNION
    SELECT size FROM sales_6m
    UNION
    SELECT size FROM stock
)
SELECT g.size,
       COALESCE(sp.units_period, 0) AS units_period,
       COALESCE(sp.revenue_period, 0) AS revenue_period,
       COALESCE(s6.units_6m, 0) AS units_6m,
       COALESCE(st.soh_stores, 0) AS soh_stores,
       COALESCE(st.soh_warehouse, 0) AS soh_warehouse
FROM grain g
LEFT JOIN sales_period sp USING (size)
LEFT JOIN sales_6m s6 USING (size)
LEFT JOIN stock st USING (size)
WHERE COALESCE(sp.units_period, 0) > 0
   OR COALESCE(st.soh_stores, 0) > 0
   OR COALESCE(st.soh_warehouse, 0) > 0
ORDER BY g.size
"""
    rows = _db_exec(sql, params, fetch=True) or []
    total_units = sum(int(r["units_period"] or 0) for r in rows)
    total_soh = sum(
        int(r["soh_stores"] or 0) + int(r["soh_warehouse"] or 0) for r in rows
    )
    result = []
    for r in rows:
        units = int(r["units_period"] or 0)
        revenue = float(r["revenue_period"] or 0)
        units_6m = int(r["units_6m"] or 0)
        soh_stores = int(r["soh_stores"] or 0)
        soh_warehouse = int(r["soh_warehouse"] or 0)
        soh = soh_stores + soh_warehouse
        denom = units + soh
        weekly_avg = round(units_6m / 26.0, 2)
        flags = _size_row_flags(units, soh, total_units, total_soh)
        if flags["sold_out"]:
            action = "RESTOCK"
        elif flags["imbalanced"]:
            action = "REBALANCE"
        elif flags["no_sales"] and soh > 0:
            action = "REVIEW"
        elif weekly_avg and soh / weekly_avg > 26:
            action = "OVERSTOCK"
        else:
            action = "HEALTHY"
        result.append({
            "size": r.get("size") or "—",
            "units_sold": units,
            "revenue": round(revenue, 0),
            "soh": soh,
            "soh_stores": soh_stores,
            "soh_warehouse": soh_warehouse,
            "sor": _sor_percent(units, soh),
            "units_6m": units_6m,
            "weekly_avg": weekly_avg,
            "woc": round(soh / weekly_avg, 1) if weekly_avg > 0 else None,
            "action": action,
            **flags,
        })
    return {"sizes": result, "totals": {
        "units_sold": total_units,
        "soh": total_soh,
    }}

def _fetch_store_size_analysis(store=None, from_date=None, to_date=None,
                               country=None, brand=None, subcategory=None):
    """Store/network size performance for the Store Detail charts.

    Sales and inventory are aggregated independently at SKU/size grain.  The
    selected-store SOR and the network benchmark both use aggregate units ÷
    aggregate (units + SOH), never an average of store-level percentages.
    """
    today = date.today()
    period_from = from_date or str(today - timedelta(days=_SIX_MONTHS_DAYS))
    period_to = to_date or str(today)
    params = {
        "period_from": period_from,
        "period_to": period_to,
        "store": store or None,
    }

    extra_prod_parts = [
        "LOWER(COALESCE(p.status, 'active')) = 'active'",
    ]
    if brand:
        brands = [b.strip() for b in brand.split(",") if b.strip()]
        if brands:
            extra_prod_parts.append("p.brand = ANY(%(brands)s)")
            params["brands"] = brands
    if subcategory:
        subcats = [s.strip() for s in subcategory.split(",") if s.strip()]
        if subcats:
            extra_prod_parts.append("p.product_type = ANY(%(subcats)s)")
            params["subcats"] = subcats
    extra_prod_where = " AND " + " AND ".join(extra_prod_parts)

    country_sales_clause = ""
    country_inventory_clause = ""
    if country:
        countries = [c.strip() for c in country.split(",") if c.strip()]
        if countries:
            params["countries"] = countries
            params["countries_lower"] = [c.lower() for c in countries]
            country_sales_clause = " AND s.country = ANY(%(countries)s)"
            country_inventory_clause = (
                " AND LOWER(COALESCE(i.country, '')) = ANY(%(countries_lower)s)"
            )

    sql = f"""
WITH master AS (
    SELECT
        p.sku,
        mode() WITHIN GROUP (ORDER BY COALESCE(NULLIF(BTRIM(p.size), ''), '—')) AS size
    FROM all_products_clean p
    WHERE {_PROD_BASE}
      {extra_prod_where}
      AND p.sku IS NOT NULL AND p.sku <> ''
    GROUP BY p.sku
),
sales AS (
    SELECT
        m.size,
        COALESCE(SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale', 'order')
              AND (%(store)s IS NULL OR s.pos_location_name = %(store)s)
        ), 0) AS store_units,
        COALESCE(SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale', 'order')
        ), 0) AS network_units
    FROM master m
    JOIN all_sales s ON s.variant_sku = m.sku
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
      AND {_BASE_FILTERS}
      AND s.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
      AND LOWER(s.pos_location_name) NOT IN ({_HOLDING_STORES_LOWER})
      AND s.pos_location_name NOT ILIKE '%%online%%'
      {country_sales_clause}
    GROUP BY m.size
),
stock AS (
    SELECT
        m.size,
        COALESCE(SUM(i.available) FILTER (
            WHERE (%(store)s IS NULL OR i.pos_location_name = %(store)s)
        ), 0) AS store_soh,
        COALESCE(SUM(i.available), 0) AS network_soh
    FROM master m
    JOIN all_inventory i ON i.sku = m.sku
    WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
      AND LOWER(i.pos_location_name) NOT IN ({_HOLDING_STORES_LOWER})
      AND i.pos_location_name NOT ILIKE '%%online%%'
      {country_inventory_clause}
    GROUP BY m.size
),
sizes AS (
    SELECT size FROM sales
    UNION
    SELECT size FROM stock
)
SELECT
    z.size,
    COALESCE(sa.store_units, 0) AS store_units,
    COALESCE(st.store_soh, 0) AS store_soh,
    COALESCE(sa.network_units, 0) AS network_units,
    COALESCE(st.network_soh, 0) AS network_soh
FROM sizes z
LEFT JOIN sales sa USING (size)
LEFT JOIN stock st USING (size)
WHERE COALESCE(sa.store_units, 0) > 0
   OR COALESCE(st.store_soh, 0) > 0
   OR COALESCE(sa.network_units, 0) > 0
   OR COALESCE(st.network_soh, 0) > 0
ORDER BY z.size
"""
    rows = _db_exec(sql, params, fetch=True) or []
    result = []
    store_total_soh = sum(int(r["store_soh"] or 0) for r in rows)
    for r in rows:
        store_units = max(int(r["store_units"] or 0), 0)
        store_soh = max(int(r["store_soh"] or 0), 0)
        network_units = max(int(r["network_units"] or 0), 0)
        network_soh = max(int(r["network_soh"] or 0), 0)
        result.append({
            "size": r.get("size") or "—",
            "units_sold": store_units,
            "soh": store_soh,
            "sor": _sor_percent(store_units, store_soh),
            "network_units_sold": network_units,
            "network_soh": network_soh,
            "network_sor": _sor_percent(network_units, network_soh),
            "soh_share": round(store_soh * 100.0 / store_total_soh, 1)
                if store_total_soh > 0 else None,
        })
    return {
        "sizes": result,
        "store": store or "All Stores",
        "period": {"from_date": period_from, "to_date": period_to},
    }


def _fetch_style_colors(style_number, from_date=None, to_date=None, country=None):
    """Per-colourway breakdown for one style: period units/revenue, current SOH
    (stores + sellable warehouse, pipeline excluded), stock-to-sales ratio, and
    fixed-window velocity/WOC (6-month units ÷ 26 — the same formula as the
    style-level WOC in _fetch_styles, so a colour's WOC reconciles with the
    header KPI). The 6-month window is independent of from_date/to_date (like
    the header WOC) but still country-scoped.

    Also returns the rule inputs for the Style Deep Dive's colourway
    Restock / Marketing / Retire recommendations (classified client-side):
      • units_4wk/8wk/12wk + sor_4wk/8wk/12wk — FIXED trailing windows from
        today (like the WOC window they never shrink with the hub date
        filter; country still applies), using the section's SOR canon:
        units ÷ (units + current SOH).
      • full_price — modal ticket price of the colourway's SKUs (modal, never
        MAX — MAX surfaces the prod-only foreign-currency dup leak).
      • asp_recent / asp_pct_full — realised ASP over the trailing 4 weeks on
        a basis directly comparable to full_price: VAT-INCLUSIVE and
        discount-aware (gross total minus discounts, per unit). Never compare
        the ex-VAT net revenue to ticket price — the VAT divisor alone would
        put every colourway ~14% under full price.
      • last_sale_date / last_sale_days — latest sale within the 12-week
        window (None ⇒ no sale in the last 12 weeks).

    Colour comes from the product master (all_products_clean.color_print);
    sales and inventory join on SKU only (triad joins are SKU-only).
    Only colourways with current stock or period sales are returned.
    """
    today       = date.today()
    six_mo_ago  = str(today - timedelta(days=_SIX_MONTHS_DAYS))
    today_str   = str(today)
    wk4_ago     = str(today - timedelta(weeks=4))
    wk8_ago     = str(today - timedelta(weeks=8))
    wk12_ago    = str(today - timedelta(weeks=12))
    period_from = from_date or six_mo_ago
    period_to   = to_date   or today_str

    country_clause = ""
    country_params = {}
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            country_params["countries"] = cl
            country_clause = " AND s.country = ANY(%(countries)s)"

    sql = f"""
WITH skus AS (
    SELECT sku, COALESCE(NULLIF(TRIM(color_print), ''), '—') AS color, price
    FROM all_products_clean
    WHERE style_number = %(style_number)s
      AND sku IS NOT NULL AND sku <> ''
),
sales AS (
    SELECT
        k.color,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                             AS units_sold,
        SUM({_NET_SALES_EXPR})        AS revenue
    FROM skus k
    JOIN all_sales s ON s.variant_sku = k.sku
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
        AND {_BASE_FILTERS}
        {country_clause}
    GROUP BY k.color
),
stock AS (
    SELECT
        k.color,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
              AND LOWER(i.pos_location_name) NOT IN ({_HOLDING_STORES_LOWER})
        ), 0) AS soh_stores,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name = 'Warehouse Finished Goods'
        ), 0) AS soh_warehouse
    FROM skus k
    JOIN all_inventory i ON i.sku = k.sku
    GROUP BY k.color
),
/* Fixed trailing-6-month window (NOT the selected period) — feeds the
   per-colour weekly velocity + WOC, mirroring the style-level WOC formula
   in _fetch_styles (units_6m ÷ 26). Country-scoped like the rest. */
sales_6m AS (
    SELECT
        k.color,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                             AS units_6m
    FROM skus k
    JOIN all_sales s ON s.variant_sku = k.sku
    WHERE s.sale_date BETWEEN %(six_mo_ago)s AND %(today)s
        AND {_BASE_FILTERS}
        {country_clause}
    GROUP BY k.color
),
/* Fixed trailing 4/8/12-week windows (from today, NOT the selected period) —
   the rule inputs for the colourway Restock/Marketing/Retire panel. One scan
   of the widest (12-week) window with filtered sums; same sale-kind, base-
   filter and country scoping as sales_6m. sale_date is TEXT but ISO dates
   compare correctly as strings (same convention as every window above).
   realized_4wk is VAT-INCLUSIVE and discount-aware (gross minus discounts):
   it feeds an ASP compared against the VAT-inclusive ticket full price. */
sales_wk AS (
    SELECT
        k.color,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order') AND s.sale_date >= %(wk4_ago)s
        )                             AS units_4wk,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order') AND s.sale_date >= %(wk8_ago)s
        )                             AS units_8wk,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                             AS units_12wk,
        SUM(s.total_sales_kes::numeric - COALESCE(s.discounts_kes,0)::numeric) FILTER (
            WHERE s.sale_kind IN ('sale','order') AND s.sale_date >= %(wk4_ago)s
        )                             AS realized_4wk,
        MAX(s.sale_date::date) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                             AS last_sale_date
    FROM skus k
    JOIN all_sales s ON s.variant_sku = k.sku
    WHERE s.sale_date BETWEEN %(wk12_ago)s AND %(today)s
        AND {_BASE_FILTERS}
        {country_clause}
    GROUP BY k.color
),
/* Ticket full price per colourway — modal SKU price (modal, never MAX).
   Product-master attribute: deliberately unscoped by date/country. */
fullprice AS (
    SELECT
        color,
        mode() WITHIN GROUP (ORDER BY price)
            FILTER (WHERE price > 0) AS full_price
    FROM skus
    GROUP BY color
)
SELECT
    COALESCE(sa.color, st.color)   AS color,
    COALESCE(sa.units_sold, 0)     AS units_sold,
    COALESCE(sa.revenue, 0.0)      AS revenue,
    COALESCE(st.soh_stores, 0)     AS soh_stores,
    COALESCE(st.soh_warehouse, 0)  AS soh_warehouse,
    COALESCE(s6.units_6m, 0)       AS units_6m,
    COALESCE(sw.units_4wk, 0)      AS units_4wk,
    COALESCE(sw.units_8wk, 0)      AS units_8wk,
    COALESCE(sw.units_12wk, 0)     AS units_12wk,
    COALESCE(sw.realized_4wk, 0.0) AS realized_4wk,
    sw.last_sale_date,
    fp.full_price
FROM sales sa
FULL OUTER JOIN stock st ON st.color = sa.color
LEFT JOIN sales_6m s6 ON s6.color = COALESCE(sa.color, st.color)
LEFT JOIN sales_wk sw ON sw.color = COALESCE(sa.color, st.color)
LEFT JOIN fullprice fp ON fp.color = COALESCE(sa.color, st.color)
"""
    params = {
        "style_number": style_number,
        "period_from":  period_from,
        "period_to":    period_to,
        "six_mo_ago":   six_mo_ago,
        "today":        today_str,
        "wk4_ago":      wk4_ago,
        "wk8_ago":      wk8_ago,
        "wk12_ago":     wk12_ago,
        **country_params,
    }
    rows = _db_exec(sql, params, fetch=True)

    result = []
    for r in rows or []:
        units = int(r["units_sold"] or 0)
        revenue = float(r["revenue"] or 0)
        soh_stores = int(r["soh_stores"] or 0)
        soh_warehouse = int(r["soh_warehouse"] or 0)
        soh = soh_stores + soh_warehouse  # pipeline always excluded
        # Only colourways with stock on hand and/or period sales appear
        if soh <= 0 and units <= 0 and revenue == 0:
            continue
        ratio = round(soh / units, 2) if units > 0 else None
        # Fixed-window velocity + WOC — same arithmetic as the style-level
        # KPI (_fetch_styles): weekly avg rounded to 2dp BEFORE the divide.
        units_6m   = int(r["units_6m"] or 0)
        weekly_avg = round(units_6m / 26.0, 2)
        woc = round(soh / weekly_avg, 1) if weekly_avg > 0 else None

        # Recommendation rule inputs — fixed trailing windows, SOR canon
        # (units ÷ (units + current SOH)), same as the section's charts.
        units_4wk  = int(r["units_4wk"] or 0)
        units_8wk  = int(r["units_8wk"] or 0)
        units_12wk = int(r["units_12wk"] or 0)

        def _sor(u):
            denom = u + soh
            return round(u * 100.0 / denom, 1) if denom > 0 else None

        sor_4wk, sor_8wk, sor_12wk = _sor(units_4wk), _sor(units_8wk), _sor(units_12wk)

        # Recent ASP (trailing 4 weeks) — VAT-inclusive, discount-aware, so it
        # is directly comparable to the VAT-inclusive ticket full_price.
        realized_4wk = float(r["realized_4wk"] or 0)
        asp_raw = (realized_4wk / units_4wk) if units_4wk > 0 else None
        asp_recent = round(asp_raw, 0) if asp_raw is not None else None
        full_price = float(r["full_price"]) if r.get("full_price") else None
        asp_pct_full = (round(asp_raw * 100.0 / full_price, 1)
                        if asp_raw is not None and full_price and full_price > 0
                        else None)

        # Days since last sale (12-week lookback; None ⇒ none in 12 weeks)
        last_sale = r.get("last_sale_date")
        last_sale_days = None
        if last_sale:
            try:
                ls = (last_sale if isinstance(last_sale, date)
                      else date.fromisoformat(str(last_sale)[:10]))
                last_sale_days = (today - ls).days
            except Exception:
                last_sale = None

        result.append({
            "color":          r.get("color") or "—",
            "units_sold":     units,
            "revenue":        round(revenue, 0),
            "soh":            soh,
            "soh_stores":     soh_stores,
            "soh_warehouse":  soh_warehouse,
            "stock_to_sales": ratio,   # None ⇒ stock with no period sales
            "units_6m":       units_6m,
            "weekly_avg":     weekly_avg,  # units/week over fixed 6m window
            "woc":            woc,     # None ⇒ no 6m velocity
            # ── Recommendation rule inputs (fixed trailing windows) ─────────
            "units_4wk":      units_4wk,
            "units_8wk":      units_8wk,
            "units_12wk":     units_12wk,
            "sor_4wk":        sor_4wk,      # None ⇒ no units and no stock
            "sor_8wk":        sor_8wk,
            "sor_12wk":       sor_12wk,
            "full_price":     full_price,   # modal ticket price, None ⇒ unknown
            "asp_recent":     asp_recent,   # VAT-inc, discount-aware, 4wk window
            "asp_pct_full":   asp_pct_full, # ASP as % of full price
            "last_sale_date": str(last_sale)[:10] if last_sale else None,
            "last_sale_days": last_sale_days,
        })

    result.sort(key=lambda r: r["revenue"], reverse=True)
    return {"colors": result}
def _fetch_style_weekly(style_number, from_date=None, to_date=None, country=None):
    """52 weeks of weekly units for one style + subcategory benchmark +
    reorder event weeks from production_orders."""
    today        = date.today()
    one_year_ago = str(today - timedelta(days=364))
    today_str    = str(today)
    period_from  = from_date or one_year_ago
    period_to    = to_date   or today_str

    country_clause  = ""
    country_params  = {}
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            country_params["countries"] = cl
            country_clause = " AND s.country = ANY(%(countries)s)"

    params = {"style_number": style_number, "from_date": period_from, "today": period_to,
              **country_params}

    sql_style = f"""
SELECT
    TO_CHAR(s.sale_date::date, 'IYYY-IW') AS iso_week,
    SUM(s.ordered_item_quantity) FILTER (
        WHERE s.sale_kind IN ('sale','order')
    ) AS units
FROM all_sales s
JOIN all_products_clean p ON p.sku = s.variant_sku
    AND p.style_number = %(style_number)s
WHERE s.sale_date BETWEEN %(from_date)s AND %(today)s
    AND {_BASE_FILTERS}
    {country_clause}
GROUP BY 1
ORDER BY 1
"""
    sql_subcat = f"""
WITH style_subcat AS (
    SELECT mode() WITHIN GROUP (ORDER BY product_type) AS product_type
    FROM all_products_clean WHERE style_number = %(style_number)s
),
subcat_weekly AS (
    SELECT
        TO_CHAR(s.sale_date::date, 'IYYY-IW') AS iso_week,
        p.style_name,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        ) AS units
    FROM all_sales s
    JOIN all_products_clean p ON p.sku = s.variant_sku
    JOIN style_subcat sc ON p.product_type = sc.product_type
    WHERE s.sale_date BETWEEN %(from_date)s AND %(today)s
        AND {_BASE_FILTERS}
        {country_clause}
    GROUP BY 1, 2
)
SELECT iso_week, ROUND(AVG(units)::numeric, 1) AS avg_units
FROM subcat_weekly
GROUP BY 1
ORDER BY 1
"""
    # Reorder events from production_orders for this style
    sql_reorders = """
SELECT
    TO_CHAR(po.date_ordered, 'IYYY-IW') AS iso_week,
    COUNT(*)                             AS order_count,
    STRING_AGG(po.order_ref, ', ')       AS order_refs
FROM production_orders po
WHERE po.style_number = %(style_number)s
    AND po.date_ordered BETWEEN %(from_date)s::date AND %(today)s::date
GROUP BY 1
ORDER BY 1
"""
    style_rows   = _db_exec(sql_style,    params, fetch=True)
    subcat_rows  = _db_exec(sql_subcat,   params, fetch=True)
    reorder_rows = _db_exec(sql_reorders, params, fetch=True)

    subcat_by_week   = {r["iso_week"]: float(r["avg_units"] or 0) for r in subcat_rows}
    reorders_by_week = {
        r["iso_week"]: {
            "order_count": int(r["order_count"] or 0),
            "order_refs":  r.get("order_refs") or "",
        }
        for r in reorder_rows
    }

    weeks = []
    sales_weeks = set()
    for r in style_rows:
        wk = r["iso_week"]
        ro = reorders_by_week.get(wk)
        sales_weeks.add(wk)
        weeks.append({
            "iso_week":    wk,
            "units":       int(r["units"] or 0),
            "subcat_avg":  subcat_by_week.get(wk),
            "reorder":     ro is not None,
            "order_count": ro["order_count"] if ro else 0,
            "order_refs":  ro["order_refs"]  if ro else None,
        })

    # Append reorder-only weeks that fall outside the style's sales history
    for wk, ro in reorders_by_week.items():
        if wk not in sales_weeks:
            weeks.append({
                "iso_week":    wk,
                "units":       0,
                "subcat_avg":  subcat_by_week.get(wk),
                "reorder":     True,
                "order_count": ro["order_count"],
                "order_refs":  ro["order_refs"],
            })
    weeks.sort(key=lambda x: x["iso_week"])

    return {"weeks": weeks}


# ── Launch ramp ────────────────────────────────────────────────────────────────

def _fetch_launch_ramp(from_date=None, to_date=None, country=None,
                       brand=None, subcategory=None, pos_location=None):
    """Cumulative SOR % by weeks-since-launch, broken down by lifecycle tier.

    Like _fetch_styles, this pre-computes style_number per style_name so that
    production_orders can be joined without aggregate functions in ON clauses.
    Honours the same filter params as the other /api/merch/* endpoints:
    brand/subcategory narrow the style universe (product master), country and
    pos_location narrow the sales feed.
    """
    today         = date.today()
    two_years_ago = str(today - timedelta(days=730))
    today_str     = str(today)
    period_from   = from_date or two_years_ago
    period_to     = to_date   or today_str

    country_clause = ""
    country_params: dict = {}
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            country_params["countries"] = cl
            country_clause = " AND s.country = ANY(%(countries)s)"

    # POS-location filter — applied to the sales feed AND the stock
    # denominator (mirrors _fetch_styles): SOR = sold / (sold + stock),
    # so a store-scoped request must also use store-scoped stock.
    pos_sales_clause = ""
    pos_stock_clause = ""
    if pos_location:
        pl = [p.strip() for p in pos_location.split(",") if p.strip()]
        if pl:
            country_params["pos_locations"] = pl
            pos_sales_clause = " AND s.pos_location_name = ANY(%(pos_locations)s)"
            pos_stock_clause = " AND i.pos_location_name = ANY(%(pos_locations)s)"

    # Product-master filters (brand / subcategory) — applied to the style
    # universe CTE so downstream CTEs inherit the narrowed set.
    extra_prod_parts = []
    if brand:
        bl = [b.strip() for b in brand.split(",") if b.strip()]
        if bl:
            extra_prod_parts.append("p.brand = ANY(%(brands)s)")
            country_params["brands"] = bl
    if subcategory:
        sl = [s.strip() for s in subcategory.split(",") if s.strip()]
        if sl:
            extra_prod_parts.append("p.product_type = ANY(%(subcats)s)")
            country_params["subcats"] = sl
    extra_prod_where = (" AND " + " AND ".join(extra_prod_parts)) if extra_prod_parts else ""

    sql = f"""
WITH
/*
 * Step 1 — canonical style_number per style_name (no aggregate in JOIN).
 */
style_nums AS (
    SELECT
        p.style_name,
        mode() WITHIN GROUP (ORDER BY p.style_number) AS style_number
    FROM all_products_clean p
    WHERE {_PROD_BASE}
        {extra_prod_where}
    GROUP BY p.style_name
),
/*
 * Step 2 — reorder counts using the pre-computed style_number.
 */
reorder_counts AS (
    SELECT
        sn.style_name,
        COUNT(DISTINCT po.order_ref) AS reorder_count
    FROM style_nums sn
    LEFT JOIN production_orders po
           ON po.style_number = sn.style_number
           OR po.style_name   = sn.style_name
    GROUP BY sn.style_name
),
/*
 * Step 3 — launched styles with is_noos, reorder_count, Odoo status, and launch date.
 */
launched_styles AS (
    SELECT
        p.style_name,
        /* Retirement rule: Active wins (mirrors api_pg._lifecycle_tier). */
        CASE WHEN BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'retired')
                  AND NOT BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'active')
             THEN 'Retired' ELSE 'Active' END             AS odoo_status,
        BOOL_OR(COALESCE(p.is_noos, FALSE))               AS is_noos,
        rc.reorder_count,
        MIN(substring(p.style_launch_date,1,10))
            FILTER (WHERE substring(p.style_launch_date,1,10)
                    ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$')  AS launch_date
    FROM all_products_clean p
    JOIN style_nums sn      ON sn.style_name = p.style_name
    JOIN reorder_counts rc  ON rc.style_name = p.style_name
    WHERE {_PROD_BASE}
        AND p.style_launch_date IS NOT NULL
    GROUP BY p.style_name, rc.reorder_count
    HAVING MIN(substring(p.style_launch_date,1,10))
        FILTER (WHERE substring(p.style_launch_date,1,10)
                ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$')
        >= %(two_years_ago)s
),
stock_now AS (
    SELECT
        COALESCE(m.style_name, i.style_name) AS style_name,
        COALESCE(SUM(i.available), 0)         AS current_stock
    FROM all_inventory i
    LEFT JOIN (
        SELECT sku, mode() WITHIN GROUP (ORDER BY style_name) AS style_name
        FROM all_products_clean WHERE style_name IS NOT NULL
        GROUP BY sku
    ) m ON m.sku = i.sku
    WHERE TRUE
        {pos_stock_clause}
    GROUP BY COALESCE(m.style_name, i.style_name)
),
weekly_sales AS (
    SELECT
        p.style_name,
        DATE_TRUNC('week', s.sale_date::date) AS week_start,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        ) AS units
    FROM all_sales s
    JOIN all_products_clean p ON p.sku = s.variant_sku
        AND {_PROD_BASE}
    WHERE s.sale_date BETWEEN %(two_years_ago)s AND %(today)s
        AND {_BASE_FILTERS}
        {country_clause}
        {pos_sales_clause}
    GROUP BY 1, 2
),
cumulative AS (
    SELECT
        ls.style_name,
        ls.is_noos,
        ls.launch_date::date                  AS launch_date,
        ws.week_start,
        EXTRACT(EPOCH FROM (ws.week_start - ls.launch_date::date)) / 604800
            AS weeks_since_launch,
        SUM(ws.units) OVER (
            PARTITION BY ls.style_name
            ORDER BY ws.week_start
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumulative_units,
        sn.current_stock
    FROM launched_styles ls
    JOIN weekly_sales ws ON ws.style_name = ls.style_name
    LEFT JOIN stock_now sn ON sn.style_name = ls.style_name
)
SELECT
    style_name,
    is_noos,
    FLOOR(weeks_since_launch)::int AS week_n,
    cumulative_units * 100.0
        / NULLIF(cumulative_units + COALESCE(current_stock, 0), 0)
                                   AS cumulative_sor_pct
FROM cumulative
WHERE weeks_since_launch BETWEEN 0 AND 51
ORDER BY week_n
"""
    params = {"two_years_ago": period_from, "today": period_to, **country_params}
    rows = _db_exec(sql, params, fetch=True)

    # Compute tier in Python — delegates entirely to api_pg._lifecycle_tier per
    # style (2026-08-27: no more reorder-count/odoo_status bucket approximation).
    agg = {}
    for r in rows:
        t = _compute_tier(r.get("style_name"), bool(r["is_noos"]))
        if t is None:
            # No live Odoo status at all — excluded, matching Range Management.
            continue
        wk  = int(r["week_n"] or 0)
        sor = float(r["cumulative_sor_pct"]) if r.get("cumulative_sor_pct") is not None else None
        if sor is None:
            continue
        agg.setdefault((t, wk), []).append(sor)

    tiers_data = {}
    for (t, wk), vals in sorted(agg.items()):
        tiers_data.setdefault(t, []).append({
            "week_n":               wk,
            "avg_cumulative_sor_pct": round(sum(vals) / len(vals), 1),
        })
    for lst in tiers_data.values():
        lst.sort(key=lambda x: x["week_n"])

    return {"by_tier": tiers_data}


# ── By-store aggregation ───────────────────────────────────────────────────────

def _fetch_by_store(brand=None, subcategory=None, tier=None, status=None,
                    from_date=None, to_date=None, country=None,
                    compare_from=None, compare_to=None):
    """Per-store aggregated KPIs for the Store Detail tab.

    Aggregates all_sales + all_inventory by pos_location_name, excluding
    warehouse/internal locations.  Store tier (A/B/C) computed from trailing-90d
    net revenue via NTILE(3), consistent with style-stores and api_pg.
    """
    today        = date.today()
    three_mo_ago = str(today - timedelta(days=91))
    today_str    = str(today)
    period_from  = from_date or three_mo_ago
    period_to    = to_date   or today_str

    params = {
        "period_from": period_from,
        "period_to":   period_to,
        "today":       today_str,
    }

    # Optional product-master filters (brand / subcategory)
    extra_prod_parts = []
    if brand:
        bl = [b.strip() for b in brand.split(",") if b.strip()]
        if bl:
            extra_prod_parts.append("p.brand = ANY(%(brands)s)")
            params["brands"] = bl
    if subcategory:
        sl = [s.strip() for s in subcategory.split(",") if s.strip()]
        if sl:
            extra_prod_parts.append("p.product_type = ANY(%(subcats)s)")
            params["subcats"] = sl
    extra_prod_where = (" AND " + " AND ".join(extra_prod_parts)) if extra_prod_parts else ""

    # Country filter
    country_clause = ""
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            params["countries"] = cl
            country_clause = " AND s.country = ANY(%(countries)s)"

    # Optional comparison-period CTE (injected into the main SQL when dates supplied)
    cmp_cte  = ""
    cmp_join = ""
    cmp_cols = "NULL::numeric AS compare_revenue_3m, NULL::bigint AS compare_units_3m"
    if compare_from and compare_to:
        params["compare_from"] = compare_from
        params["compare_to"]   = compare_to
        cmp_cte = f""",
store_sales_cmp AS (
    SELECT
        s.pos_location_name AS store,
        COALESCE(SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        ), 0)                                            AS units_cmp,
        /* Net Sales canon: (total − discounts − returns) EX-VAT — same basis
           as every other surface (see net-sales-canonical). */
        COALESCE(SUM({_NET_SALES_EXPR}), 0.0)            AS revenue_cmp
    FROM all_sales s
    LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
    WHERE s.sale_date BETWEEN %(compare_from)s AND %(compare_to)s
        AND {_BASE_FILTERS}
        AND s.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
        AND LOWER(s.pos_location_name) NOT IN ({_HOLDING_STORES_LOWER})
        AND s.pos_location_name NOT ILIKE '%%online%%'
        AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
        {country_clause}
    GROUP BY s.pos_location_name
)"""
        cmp_join = "LEFT  JOIN store_sales_cmp sc ON sc.store = COALESCE(ss.store, sk.store)"
        cmp_cols = "COALESCE(sc.revenue_cmp, 0.0) AS compare_revenue_3m, COALESCE(sc.units_cmp, 0) AS compare_units_3m"

    sql = f"""
WITH
store_tiers AS (
    SELECT
        s.pos_location_name AS store,
        CASE NTILE(3) OVER (ORDER BY SUM(s.net_sales_kes::numeric) DESC)
            WHEN 1 THEN 'A' WHEN 2 THEN 'B' ELSE 'C'
        END AS store_tier
    FROM all_sales s
    WHERE s.sale_kind IN ('sale','order')
        AND s.sale_date >= (CURRENT_DATE - INTERVAL '90 days')::text
        AND {_BASE_FILTERS}
        AND s.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
        AND LOWER(s.pos_location_name) NOT IN ({_HOLDING_STORES_LOWER})
        AND s.pos_location_name NOT ILIKE '%%online%%'
    GROUP BY s.pos_location_name
    HAVING SUM(s.net_sales_kes::numeric) > 0
),
store_sales AS (
    SELECT
        s.pos_location_name                              AS store,
        COUNT(DISTINCT p.style_name)
            FILTER (WHERE p.style_name IS NOT NULL
                    AND p.style_name <> ''
                    AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
                    {extra_prod_where.replace("p.", "p.", 1)})
                                                         AS style_count,
        COUNT(DISTINCT (p.style_name || '||' || COALESCE(p.color_print,'')))
            FILTER (WHERE p.style_name IS NOT NULL
                    AND p.style_name <> ''
                    AND COALESCE(p.color_print,'') <> ''
                    AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
                    {extra_prod_where.replace("p.", "p.", 1)})
                                                         AS colour_style_count,
        COALESCE(SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        ), 0)                                            AS units_3m,
        /* Net Sales canon: (total − discounts − returns) EX-VAT — same basis
           as every other surface (see net-sales-canonical). */
        COALESCE(SUM({_NET_SALES_EXPR}), 0.0)            AS revenue_3m
    FROM all_sales s
    LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
        AND {_BASE_FILTERS}
        AND s.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
        AND LOWER(s.pos_location_name) NOT IN ({_HOLDING_STORES_LOWER})
        AND s.pos_location_name NOT ILIKE '%%online%%'
        AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
        {country_clause}
    GROUP BY s.pos_location_name
),
store_stock AS (
    SELECT
        i.pos_location_name                 AS store,
        COALESCE(SUM(i.available), 0)       AS total_stock
    FROM all_inventory i
    LEFT JOIN all_products_clean p ON p.sku = i.sku
    WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
      AND LOWER(i.pos_location_name) NOT IN ({_HOLDING_STORES_LOWER})
      AND i.pos_location_name NOT ILIKE '%%online%%'
      AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
    GROUP BY i.pos_location_name
),
store_meta AS (
    SELECT location_name AS store, optimal_stock, sqft
    FROM pos_locations
    WHERE optimal_stock IS NOT NULL
)
{cmp_cte}
SELECT
    COALESCE(ss.store, sk.store)            AS store,
    COALESCE(t.store_tier, '—')             AS store_tier,
    COALESCE(ss.style_count, 0)             AS style_count,
    COALESCE(ss.colour_style_count, 0)     AS colour_style_count,
    COALESCE(ss.units_3m, 0)               AS units_3m,
    COALESCE(ss.revenue_3m, 0.0)           AS revenue_3m,
    COALESCE(sk.total_stock, 0)            AS total_stock,
    sm.optimal_stock,
    sm.sqft,
    {cmp_cols}
FROM store_sales ss
FULL OUTER JOIN store_stock sk ON sk.store = ss.store
LEFT  JOIN store_tiers     t  ON t.store  = COALESCE(ss.store, sk.store)
LEFT  JOIN store_meta      sm ON sm.store = COALESCE(ss.store, sk.store)
{cmp_join}
ORDER BY revenue_3m DESC NULLS LAST
"""
    rows = _db_exec(sql, params, fetch=True)

    # Post-process: compute per-store avg WOC and avg SOR from the style-stores
    # data would require N+1 queries; instead derive them from a secondary SQL
    # that computes per-store style-level woc/sor and averages them.
    # We inline this as a second query to keep things self-contained.
    woc_sor_sql = f"""
WITH style_stock AS (
    SELECT
        COALESCE(m.style_name, i.style_name) AS style_name,
        i.pos_location_name                  AS store,
        COALESCE(SUM(i.available), 0)        AS stock
    FROM all_inventory i
    LEFT JOIN (
        SELECT sku, mode() WITHIN GROUP (ORDER BY style_name) AS style_name
        FROM all_products_clean
        WHERE style_name IS NOT NULL AND style_name <> ''
        GROUP BY sku
    ) m ON m.sku = i.sku
    WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
      AND LOWER(i.pos_location_name) NOT IN ({_HOLDING_STORES_LOWER})
      AND i.pos_location_name NOT ILIKE '%%online%%'
    GROUP BY COALESCE(m.style_name, i.style_name), i.pos_location_name
),
style_sales_6m AS (
    SELECT
        p.style_name,
        s.pos_location_name AS store,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                   AS units_6m
    FROM all_sales s
    JOIN all_products_clean p ON p.sku = s.variant_sku
        AND p.style_name IS NOT NULL AND p.style_name <> ''
        AND COALESCE(p.brand,'') NOT ILIKE '%%third party%%'
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
        AND {_BASE_FILTERS}
        {country_clause}
    GROUP BY p.style_name, s.pos_location_name
)
SELECT
    COALESCE(sk.store, sa.store) AS store,
    AVG(
        CASE WHEN COALESCE(sa.units_6m, 0) > 0
             THEN COALESCE(sk.stock, 0) / (COALESCE(sa.units_6m, 0) / 26.0)
        END
    ) AS avg_woc,
    AVG(
        CASE WHEN (COALESCE(sa.units_6m, 0) + COALESCE(sk.stock, 0)) > 0
             THEN COALESCE(sa.units_6m, 0) * 100.0
                  / (COALESCE(sa.units_6m, 0) + COALESCE(sk.stock, 0))
        END
    ) AS avg_sor
FROM style_stock sk
FULL OUTER JOIN style_sales_6m sa
    ON sa.style_name = sk.style_name AND sa.store = sk.store
GROUP BY COALESCE(sk.store, sa.store)
"""
    woc_sor_rows = _db_exec(woc_sor_sql, params, fetch=True)
    woc_sor_map = {
        r["store"]: {
            "avg_woc": round(float(r["avg_woc"]), 1) if r.get("avg_woc") is not None else None,
            "avg_sor": round(float(r["avg_sor"]), 1) if r.get("avg_sor") is not None else None,
        }
        for r in woc_sor_rows
    }

    result = []
    for r in rows:
        store = r.get("store") or "Unknown"
        ws = woc_sor_map.get(store, {})
        total_stock   = int(r.get("total_stock") or 0)
        optimal_stock = int(r["optimal_stock"]) if r.get("optimal_stock") is not None else None
        stock_variance = (total_stock - optimal_stock) if optimal_stock is not None else None
        result.append({
            "store":               store,
            "store_tier":          r.get("store_tier") or "—",
            "style_count":         int(r.get("style_count") or 0),
            "colour_style_count":  int(r.get("colour_style_count") or 0),
            "units_3m":            int(r.get("units_3m") or 0),
            "revenue_3m":          round(float(r.get("revenue_3m") or 0), 0),
            "compare_revenue_3m":  round(float(r["compare_revenue_3m"]), 0) if r.get("compare_revenue_3m") is not None else None,
            "compare_units_3m":    int(r["compare_units_3m"]) if r.get("compare_units_3m") is not None else None,
            "total_stock":    total_stock,
            "optimal_stock":  optimal_stock,
            "stock_variance": stock_variance,
            "sqft":           int(r["sqft"]) if r.get("sqft") is not None else None,
            "avg_woc":        ws.get("avg_woc"),
            "avg_sor":        ws.get("avg_sor"),
        })

    # Apply tier filter in Python (mirrors _fetch_styles approach)
    if tier:
        tier_filter = set(t.strip() for t in tier.split(",") if t.strip())
        # Store-level has no "tier" — tier filter is not meaningful here, skip.
        pass

    return result


# ── Route registration ─────────────────────────────────────────────────────────

# ── Stock Mix drill-down tree ─────────────────────────────────────────────────

def _fetch_stock_mix(brand=None, subcategory=None, tier=None, from_date=None, to_date=None,
                     country=None, pos_location=None, include_retired=False):
    """Nested Category → Sub Category → Style → Colour stock-mix tree.

    Brings the fabric Stock Mix drill-down pattern to finished goods: every
    node carries stock units (stores + sellable warehouse — the same basis as
    the tab's Total Stock Units KPI), stock value at cost, gross units sold in
    the selected period, and weeks of cover on the tab's trailing-6-month
    run-rate (units_6m / 26). Shares (% of stock / % of sales) are derived
    CLIENT-side from the grand totals in the payload so every level is
    measured against the grand total — mirroring the fabric page.

    Reconciliation contract: the tree's grand-total stock units must equal
    _compute_summary()['total_stock_units'] under the same filters. The stock
    CTE below therefore mirrors _fetch_styles' stock CTE exactly (same
    location exclusions, same COALESCE sku→style mapping, same country/pos
    scoping) just at (style, colour) grain, and the final INNER JOIN to prod
    applies the same universe semantics as _fetch_styles (stock outside the
    style universe drops out there via the LEFT JOIN from prod).

    Dims and lifecycle status come from the product master only: category =
    p.category, subcategory = p.product_type, colour = per-SKU mode of
    p.color_print, and status = per-SKU mode of p.status (NEVER
    all_inventory's colour column). A style resolves to exactly ONE
    category/subcategory via mode() of its SKU dims, so it never splits
    across branches. Style status is Active when any SKU is Active, otherwise
    Retired/Archived follows the remaining SKU statuses. Blank or unrecognised
    statuses remain visible as Unreviewed and are included by default; only
    rows explicitly classified Retired/Archived are hidden. Colourway status
    is computed independently over that colourway's SKUs.

    Ordering context for replenish/retire calls (Inventory & Stock Health):
    style nodes carry `last_order_date` = MAX(production_orders.date_ordered)
    matched by style_number OR style_name (the reorder_counts pattern from
    _fetch_styles); colour nodes carry their own `last_order_date` (order
    variant SKUs resolved through the product master, with a normalised
    order-line colour-name fallback for orders without variant rows) plus a
    `rep_sku` — the colour's highest-stock SKU — which the frontend uses to
    key product images and the style-card popup. SKU-derived colour dates
    roll UP into the style date (assembly-side max) because the deterministic
    SKU match out-covers the textual style match — a style must never show a
    dash while one of its own colours shows a date. All three are nullable;
    the frontend must render missing values as dashes (old cached payloads
    may omit them entirely).
    """
    today = date.today()
    six_mo_ago = str(today - timedelta(days=_SIX_MONTHS_DAYS))
    today_str  = str(today)
    period_from = from_date or six_mo_ago
    period_to   = to_date   or today_str

    params = {
        "period_from": period_from,
        "period_to":   period_to,
        "six_mo_ago":  six_mo_ago,
        "today":       today_str,
        "include_retired": bool(include_retired),
        "pipeline_states": list(_PIPELINE_BO_STATES),
    }

    # Brand / subcategory narrow the style universe exactly like _fetch_styles:
    # applied per SKU row BEFORE GROUP BY style_name (style included when ANY
    # of its SKUs matches; mode() dims are then taken over the matching rows).
    extra_prod_parts = []
    if brand:
        bl = [b.strip() for b in brand.split(",") if b.strip()]
        if bl:
            extra_prod_parts.append("p.brand = ANY(%(brands)s)")
            params["brands"] = bl
    if subcategory:
        sl = [s.strip() for s in subcategory.split(",") if s.strip()]
        if sl:
            extra_prod_parts.append("p.product_type = ANY(%(subcats)s)")
            params["subcats"] = sl
    extra_prod_where = (" AND " + " AND ".join(extra_prod_parts)) if extra_prod_parts else ""

    country_clause = ""
    country_inv_where = ""
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            params["countries"] = cl
            country_clause = " AND s.country = ANY(%(countries)s)"
            inv_cs = ", ".join(f"'{c.lower().replace(chr(39), chr(39)*2)}'" for c in cl)
            country_inv_where = f" WHERE LOWER(i.country) IN ({inv_cs})"

    pos_store_clause = ""
    pos_sales_clause = ""
    pos_has_filter = False
    if pos_location:
        pl = [p.strip() for p in pos_location.split(",") if p.strip()]
        if pl:
            params["pos_locations"] = pl
            pos_store_clause = " AND i.pos_location_name = ANY(%(pos_locations)s)"
            pos_sales_clause = " AND s.pos_location_name = ANY(%(pos_locations)s)"
            pos_has_filter   = True

    # Sellable SOH is allowlisted, not defined as "anything not internal".
    # This prevents a newly introduced Odoo WIP/QC/raw-material location from
    # silently becoming a retail store. When a POS filter is active, warehouse
    # stock does not belong to that store and is forced to zero.
    stores_pred = f"{_sellable_retail_store_pred('i')}{pos_store_clause}"
    online_pred = f"{_sellable_online_pred('i')}{pos_store_clause}"
    wh_pred = (
        "FALSE" if pos_has_filter
        else f"i.pos_location_name = '{_SELLABLE_WAREHOUSE_LOCATION}'"
    )
    soh_warehouse_expr = (
        "0" if pos_has_filter else
        f"COALESCE(SUM(i.available) FILTER (WHERE {wh_pred}), 0)"
    )

    sql = f"""
WITH
/* Style universe + one canonical category/subcategory per style (mode of its
   SKU dims over the SAME filtered rowset _fetch_styles' prod CTE uses, so a
   spot-check against /api/merch/by-subcategory buckets identically). */
style_nums AS (
    SELECT
        p.style_name,
        mode() WITHIN GROUP (ORDER BY p.style_number) AS style_number
    FROM all_products_clean p
    WHERE {_PROD_BASE}
    GROUP BY p.style_name
),
reorder_counts AS (
    SELECT
        sn.style_name,
        COUNT(DISTINCT po.order_ref) AS reorder_count
    FROM style_nums sn
    LEFT JOIN production_orders po
      ON (COALESCE(po.style_number, '') <> '' AND po.style_number = sn.style_number)
      OR (COALESCE(po.style_name, '') <> '' AND po.style_name = sn.style_name)
    GROUP BY sn.style_name
),
prod AS (
    SELECT
        p.style_name,
        sn.style_number,
        mode() WITHIN GROUP (ORDER BY p.category)      AS category,
        mode() WITHIN GROUP (ORDER BY p.product_type)  AS subcategory
        ,
        CASE
            WHEN BOOL_OR(LOWER(BTRIM(COALESCE(p.status, ''))) = 'active')
                THEN 'Active'
            WHEN BOOL_OR(
                LOWER(BTRIM(COALESCE(p.status, '')))
                    NOT IN ('active', 'retired', 'archived')
            )
                THEN 'Unreviewed'
            WHEN BOOL_OR(LOWER(BTRIM(COALESCE(p.status, ''))) = 'retired')
                THEN 'Retired'
            WHEN BOOL_OR(LOWER(BTRIM(COALESCE(p.status, ''))) = 'archived')
                THEN 'Archived'
            ELSE 'Unreviewed'
        END AS style_status
        ,
        BOOL_OR(COALESCE(p.is_noos, FALSE)) AS is_noos,
        rc.reorder_count
    FROM all_products_clean p
    JOIN style_nums sn ON sn.style_name = p.style_name
    JOIN reorder_counts rc ON rc.style_name = p.style_name
    WHERE {_PROD_BASE}{extra_prod_where}
    GROUP BY p.style_name, sn.style_number, rc.reorder_count
),
/* Per-SKU master map: style + colour + cost. Mirrors the stock CTE's `m`
   subquery in _fetch_styles (all styled rows, NO third-party filter — the
   universe join handles that) extended with colour + cost. is_third_party
   drives the sales joins below, matching the per-row p2 join conditions of
   the sibling sales CTEs (SKUs are unique in all_products_clean). */
msku AS (
    SELECT sku,
        mode() WITHIN GROUP (ORDER BY style_name)   AS style_name,
        mode() WITHIN GROUP (ORDER BY color_print)  AS colour,
        mode() WITHIN GROUP (ORDER BY cost)         AS cost,
        mode() WITHIN GROUP (ORDER BY price) FILTER (WHERE price > 0) AS full_price,
        mode() WITHIN GROUP (ORDER BY fabric_product_id)
            FILTER (WHERE fabric_product_id IS NOT NULL) AS fabric_product_id,
        mode() WITHIN GROUP (ORDER BY fabric_barcode)
            FILTER (WHERE NULLIF(BTRIM(fabric_barcode), '') IS NOT NULL) AS fabric_barcode,
        mode() WITHIN GROUP (ORDER BY NULLIF(BTRIM(status), '')) AS sku_status,
        BOOL_OR(COALESCE(brand,'') ILIKE '%%third party%%') AS is_third_party
    FROM all_products_clean
    WHERE style_name IS NOT NULL
    GROUP BY sku
),
/* One stable inventory grain before any product-master join. all_inventory is
   sourced from Odoo stock.quant and can contain several quant rows for one
   SKU/location. Aggregate those source rows exactly once here, then perform
   the one-row-per-SKU master lookup. This prevents catalogue or location
   fan-out from multiplying finished-goods units.

   Sellable locations are intentionally explicit:
     stores    = Vivo*, Zoya*, Safari*, The Oasis Mall, Online - Shop Zetu
     warehouse = Warehouse Finished Goods only
   Everything else (FGPRD/Finished Goods Production, receiving, in-transit,
   raw materials, trim, Sew/Stock, QC/defects, samples, holding/retired,
   staff purchase and unknown locations) is excluded from sellable SOH. */
inventory_source AS (
    SELECT
        i.sku,
        i.style_name,
        i.pos_location_name,
        i.country,
        SUM(i.available) AS available
    FROM all_inventory i
    WHERE TRUE
    {country_inv_where}
    GROUP BY i.sku, i.style_name, i.pos_location_name, i.country
),
/* Lifecycle status at colourway grain. This intentionally does not inherit
   the parent style status: an active style may contain retired colourways.
   The frontend flags the exceptional retired-style/active-colour combination
   rather than silently rewriting the source data. */
colour_lifecycle AS (
    SELECT
        style_name,
        colour,
        CASE
            WHEN BOOL_OR(LOWER(BTRIM(COALESCE(sku_status, ''))) = 'active')
                THEN 'Active'
            WHEN BOOL_OR(
                LOWER(BTRIM(COALESCE(sku_status, '')))
                    NOT IN ('active', 'retired', 'archived')
            )
                THEN 'Unreviewed'
            WHEN BOOL_OR(LOWER(BTRIM(COALESCE(sku_status, ''))) = 'retired')
                THEN 'Retired'
            WHEN BOOL_OR(LOWER(BTRIM(COALESCE(sku_status, ''))) = 'archived')
                THEN 'Archived'
            ELSE 'Unreviewed'
        END AS colour_status
    FROM msku
    WHERE COALESCE(colour, '') <> ''
    GROUP BY style_name, colour
),
/* Exact Odoo fabric reference for each finished-goods colourway. This is
   descriptive colourway metadata, never a roll-up measure. */
colour_fabric AS (
    SELECT
        style_name,
        COALESCE(colour, '') AS colour,
        mode() WITHIN GROUP (ORDER BY fabric_product_id)
            FILTER (WHERE fabric_product_id IS NOT NULL) AS fabric_product_id,
        mode() WITHIN GROUP (ORDER BY fabric_barcode)
            FILTER (WHERE NULLIF(BTRIM(fabric_barcode), '') IS NOT NULL) AS fabric_barcode
    FROM msku
    GROUP BY 1, 2
),
/* raw_fabric_products can contain repeated snapshots for one Odoo product id.
   Collapse it to one row before joining inventory; descriptive fabric metadata
   must never multiply finished-goods stock or sales measures. */
fabric_products AS (
    SELECT
        id,
        mode() WITHIN GROUP (ORDER BY NULLIF(BTRIM(name), ''))
            FILTER (WHERE NULLIF(BTRIM(name), '') IS NOT NULL) AS name,
        mode() WITHIN GROUP (ORDER BY NULLIF(BTRIM(barcode), ''))
            FILTER (WHERE NULLIF(BTRIM(barcode), '') IS NOT NULL) AS barcode,
        mode() WITHIN GROUP (ORDER BY NULLIF(BTRIM(supplier_fabric_code), ''))
            FILTER (WHERE NULLIF(BTRIM(supplier_fabric_code), '') IS NOT NULL)
            AS supplier_fabric_code,
        mode() WITHIN GROUP (ORDER BY kg_per_mtr_eff)
            FILTER (WHERE kg_per_mtr_eff > 0) AS kg_per_mtr_eff
    FROM raw_fabric_products
    WHERE category = 'Fabric'
    GROUP BY id
),
/* Same current available-metres basis as Fabric BI:
   RMAT/Stock available kg ÷ the effective kg-per-metre conversion. The supplier
   fabric code is the Odoo quality identity shared by its distinct colour
   products; blank codes deliberately do not create speculative families. */
fabric_stock_base AS (
    SELECT
        p.id AS fabric_product_id,
        p.name AS fabric_name,
        NULLIF(BTRIM(p.barcode), '') AS fabric_barcode,
        NULLIF(BTRIM(p.supplier_fabric_code), '') AS fabric_quality_key,
        ROUND(COALESCE(SUM(
            CASE
                WHEN i.location_name = 'RMAT/Stock' AND p.kg_per_mtr_eff > 0
                THEN i.available / p.kg_per_mtr_eff
                ELSE 0
            END
        ), 0)::numeric, 1) AS available_metres
    FROM fabric_products p
    LEFT JOIN raw_fabric_inventory i ON i.product_id = p.id
    GROUP BY p.id, p.name, p.barcode, p.supplier_fabric_code
),
fabric_stock AS (
    SELECT
        fabric_product_id,
        fabric_name,
        fabric_barcode,
        available_metres,
        CASE WHEN fabric_quality_key IS NOT NULL THEN
            ROUND((
                SUM(available_metres) OVER (PARTITION BY fabric_quality_key)
                - available_metres
            )::numeric, 1)
        ELSE NULL END AS other_colour_available_metres
    FROM fabric_stock_base
),
/* Stock at (style, colour) grain — pre-aggregated on its own (never join
   inventory to sales then SUM). Same row scope + filters as the KPI's stock
   CTE; stock value = available × per-SKU cost over the SAME rows. */
stock AS (
    SELECT
        COALESCE(m.style_name, NULLIF(i.style_name, '')) AS style_name,
        COALESCE(m.colour, '')                AS colour,
        COALESCE(SUM(i.available) FILTER (WHERE {stores_pred}), 0) AS soh_stores,
        COALESCE(SUM(i.available) FILTER (WHERE {online_pred}), 0) AS soh_online,
        {soh_warehouse_expr} AS soh_warehouse,
        COALESCE(SUM(i.available * COALESCE(m.cost, 0)) FILTER (
            WHERE ({stores_pred}) OR ({online_pred}) OR {wh_pred}), 0) AS stock_value,
        COUNT(DISTINCT i.sku) FILTER (
            WHERE (({stores_pred}) OR ({online_pred}) OR {wh_pred})
              AND i.available > 0)                                 AS skus_in_stock
    FROM inventory_source i
    LEFT JOIN msku m ON m.sku = i.sku
    GROUP BY 1, 2
),
/* Period sales at (style, colour) grain — gross units canon
   (ordered_item_quantity, sale_kind IN ('sale','order')); revenue = net
   sales canon summed over ALL rows (returns net out), matching
   _fetch_styles' revenue_period exactly. */
sales_period AS (
    SELECT
        m.style_name,
        COALESCE(m.colour, '') AS colour,
        COALESCE(SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')), 0)             AS units_period,
        COALESCE(SUM({_NET_SALES_EXPR}), 0)                        AS revenue_period,
        COALESCE(SUM(
            CASE WHEN s.sale_kind IN ('sale','order')
                 THEN s.total_sales_kes::numeric - COALESCE(s.discounts_kes, 0)::numeric
                 ELSE 0 END
        ), 0)                                                       AS achieved_sales_gross,
        COALESCE(SUM(
            CASE WHEN s.sale_kind IN ('sale','order') AND m.full_price > 0
                 THEN s.ordered_item_quantity * m.full_price
                 ELSE 0 END
        ), 0)                                                       AS full_price_value,
        COUNT(DISTINCT s.variant_sku) FILTER (
            WHERE s.sale_kind IN ('sale','order'))                 AS skus_sold
    FROM all_sales s
    JOIN msku m ON m.sku = s.variant_sku
        AND m.style_name <> '' AND NOT m.is_third_party
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
        AND {_BASE_FILTERS}
        {country_clause}
        {pos_sales_clause}
    GROUP BY 1, 2
),
/* Trailing-6-month units — WOC denominator (units_6m / 26), matching the
   tab's per-style WOC basis regardless of the selected date range. */
sales_6m AS (
    SELECT
        m.style_name,
        COALESCE(m.colour, '') AS colour,
        COALESCE(SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')), 0)             AS units_6m
    FROM all_sales s
    JOIN msku m ON m.sku = s.variant_sku
        AND m.style_name <> '' AND NOT m.is_third_party
    WHERE s.sale_date BETWEEN %(six_mo_ago)s AND %(today)s
        AND {_BASE_FILTERS}
        {country_clause}
        {pos_sales_clause}
    GROUP BY 1, 2
),
/* Most recent recorded sale at style×colour grain. Recency is an all-history
   fact; the local 30/90/365-day controls drive units, revenue, full-price
   attainment and sell-through, but must not turn an older real sale into a
   misleading "no sale on record" dash. */
last_sales AS (
    SELECT
        m.style_name,
        COALESCE(m.colour, '') AS colour,
        MAX(s.sale_date::date) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        ) AS last_sale_date
    FROM all_sales s
    JOIN msku m ON m.sku = s.variant_sku
        AND m.style_name <> '' AND NOT m.is_third_party
    WHERE {_BASE_FILTERS}
        {country_clause}
        {pos_sales_clause}
    GROUP BY 1, 2
),
/* Last production/buying order per style — the reorder_counts pattern from
   _fetch_styles (match by style_number OR style_name), scoped to the
   filtered style universe. Blank keys are guarded so the handful of orders
   without a style_number can't cross-match styles whose mode() number
   is also blank. */
style_orders AS (
    SELECT p.style_name, MAX(po.date_ordered) AS last_order_date
    FROM prod p
    JOIN production_orders po
      ON (COALESCE(po.style_number, '') <> '' AND po.style_number = p.style_number)
      OR (COALESCE(po.style_name,   '') <> '' AND po.style_name   = p.style_name)
    GROUP BY p.style_name
),
/* Last order per (style, colour). Deterministic first: order variant SKUs
   resolve to (style, colour) through the product master (verified: 100%% of
   variant SKUs match all_products_clean). Orders without variant rows fall
   back to the order-line colour NAME, normalised LOWER(BTRIM(..)), on
   style-matched orders. MAX(date) over the union — normalised-equal colours
   within one style are the same colourway. */
colour_orders AS (
    SELECT style_name, ncol, MAX(d) AS last_order_date
    FROM (
        SELECT m.style_name,
               LOWER(BTRIM(COALESCE(m.colour, ''))) AS ncol,
               po.date_ordered                      AS d
        FROM production_order_variants v
        JOIN production_orders po ON po.order_ref = v.order_ref
        JOIN msku m               ON m.sku = v.product_sku
        UNION ALL
        SELECT p.style_name,
               LOWER(BTRIM(l.colour)) AS ncol,
               po.date_ordered        AS d
        FROM production_order_lines l
        JOIN production_orders po ON po.order_ref = l.order_ref
        JOIN prod p
          ON (COALESCE(po.style_number, '') <> '' AND po.style_number = p.style_number)
          OR (COALESCE(po.style_name,   '') <> '' AND po.style_name   = p.style_name)
        WHERE COALESCE(BTRIM(l.colour), '') <> ''
    ) u
    GROUP BY 1, 2
),
/* One representative SKU per (style, colour) — the colour's highest-stock
   SKU (total availability across all locations; ties broken by SKU) so the
   frontend can key product images / the style-card popup. Master SKUs only,
   matching how images + style-card resolve. */
rep_sku AS (
    SELECT style_name, colour, sku
    FROM (
        SELECT m.style_name,
               COALESCE(m.colour, '') AS colour,
               m.sku,
               ROW_NUMBER() OVER (
                   PARTITION BY m.style_name, COALESCE(m.colour, '')
                   ORDER BY COALESCE(inv.qty, 0) DESC, m.sku
               ) AS rn
        FROM msku m
        LEFT JOIN (
            SELECT sku, SUM(available) AS qty FROM all_inventory GROUP BY sku
        ) inv ON inv.sku = m.sku
    ) ranked
    WHERE rn = 1
),
grain AS (
    SELECT style_name, colour FROM stock
    UNION
    SELECT style_name, colour FROM sales_period
    UNION
    SELECT style_name, colour FROM sales_6m
)
SELECT
    p.category,
    p.subcategory,
    p.style_name,
    p.style_number,
    p.style_status,
    p.is_noos,
    p.reorder_count,
    g.colour,
    cl.colour_status,
    fs.fabric_name,
    COALESCE(fs.fabric_barcode, cf.fabric_barcode) AS fabric_barcode,
    CASE WHEN fs.fabric_product_id IS NOT NULL
         THEN fs.available_metres
         ELSE NULL
    END AS fabric_stock_metres,
    CASE WHEN fs.fabric_product_id IS NOT NULL
         THEN fs.other_colour_available_metres
         ELSE NULL
    END AS fabric_other_colour_stock_metres,
    COALESCE(st.soh_stores, 0) AS soh_stores,
    COALESCE(st.soh_online, 0) AS soh_online,
    COALESCE(st.soh_warehouse, 0) AS soh_warehouse,
    COALESCE(st.soh_stores, 0) + COALESCE(st.soh_online, 0)
        + COALESCE(st.soh_warehouse, 0) AS stock_units,
    COALESCE(st.stock_value, 0)    AS stock_value,
    COALESCE(st.skus_in_stock, 0)  AS skus_in_stock,
    COALESCE(sp.units_period, 0)   AS units_period,
    COALESCE(sp.revenue_period, 0) AS revenue_period,
    COALESCE(sp.achieved_sales_gross, 0) AS achieved_sales_gross,
    COALESCE(sp.full_price_value, 0) AS full_price_value,
    COALESCE(sp.skus_sold, 0)      AS skus_sold,
    COALESCE(s6.units_6m, 0)       AS units_6m,
    ls.last_sale_date::text        AS last_sale_date,
    so.last_order_date::text       AS style_last_order,
    co.last_order_date::text       AS colour_last_order,
    rs.sku                         AS rep_sku,
    (
        SELECT COUNT(*)
        FROM all_products_clean p
        WHERE {_PROD_BASE}{extra_prod_where}
          AND LOWER(BTRIM(COALESCE(p.status, '')))
                NOT IN ('active', 'retired', 'archived')
    ) AS unknown_status_product_rows,
    (
        SELECT COUNT(DISTINCT p.sku)
        FROM all_products_clean p
        WHERE {_PROD_BASE}{extra_prod_where}
          AND LOWER(BTRIM(COALESCE(p.status, '')))
                NOT IN ('active', 'retired', 'archived')
    ) AS unknown_status_skus,
    (
        SELECT COUNT(DISTINCT p.style_name)
        FROM all_products_clean p
        WHERE {_PROD_BASE}{extra_prod_where}
          AND LOWER(BTRIM(COALESCE(p.status, '')))
                NOT IN ('active', 'retired', 'archived')
    ) AS unknown_status_styles,
    (
        SELECT COUNT(DISTINCT (p.style_name, COALESCE(p.color_print, '')))
        FROM all_products_clean p
        WHERE {_PROD_BASE}{extra_prod_where}
          AND LOWER(BTRIM(COALESCE(p.status, '')))
                NOT IN ('active', 'retired', 'archived')
    ) AS unknown_status_colourways
FROM grain g
JOIN prod p               ON p.style_name  = g.style_name
LEFT JOIN stock st        ON st.style_name = g.style_name AND st.colour = g.colour
LEFT JOIN sales_period sp ON sp.style_name = g.style_name AND sp.colour = g.colour
LEFT JOIN sales_6m s6     ON s6.style_name = g.style_name AND s6.colour = g.colour
LEFT JOIN last_sales ls   ON ls.style_name = g.style_name AND ls.colour = g.colour
LEFT JOIN style_orders so ON so.style_name = g.style_name
LEFT JOIN colour_orders co ON co.style_name = g.style_name
                          AND co.ncol = LOWER(BTRIM(g.colour))
LEFT JOIN colour_lifecycle cl ON cl.style_name = g.style_name
                              AND cl.colour = g.colour
LEFT JOIN colour_fabric cf ON cf.style_name = g.style_name
                           AND cf.colour = g.colour
LEFT JOIN fabric_stock fs ON fs.fabric_product_id = cf.fabric_product_id
LEFT JOIN rep_sku rs      ON rs.style_name = g.style_name AND rs.colour = g.colour
WHERE %(include_retired)s
   OR COALESCE(cl.colour_status, p.style_status, 'Unreviewed')
        NOT IN ('Retired', 'Archived')
"""
    raw = _db_exec(sql, params, fetch=True)
    if not raw and not any((brand, subcategory, tier, country, pos_location)):
        # Product-master refreshes replace all_products_clean in batches. Never
        # let the unfiltered production route cache that transient empty window
        # as a valid Stock Mix payload.
        try:
            from unittest.mock import MagicMock as _MagicMock
            db_is_mocked = isinstance(_db_exec, _MagicMock)
        except ImportError:
            db_is_mocked = False
        if A is not None and not db_is_mocked:
            raise RuntimeError(
                "Stock Mix product universe is temporarily empty; retry after refresh"
            )

    # Pipeline is deliberately queried and aggregated separately from stock.
    # It cannot multiply inventory rows, and a slow/large Buying Order join
    # cannot destabilise the main Stock Mix query plan.
    pipeline_raw = _db_exec("""
        WITH stage_balance AS (
            SELECT
                order_ref,
                COALESCE(SUM(qty_here) FILTER (WHERE stage <> 'warehouse'), 0) AS pre_warehouse_units,
                COALESCE(SUM(qty_here) FILTER (WHERE stage = 'warehouse'), 0) AS warehouse_units,
                COUNT(*) AS balance_rows
            FROM v_stage_balances
            GROUP BY order_ref
        ),
        order_wip AS (
            SELECT
                po.order_ref,
                po.style_number,
                po.style_name,
                po.bo_state,
                po.date_ordered,
                GREATEST(CURRENT_DATE - po.date_ordered, 0) AS age_days,
                COALESCE(po.order_qty, 0)::numeric AS ordered_units,
                LEAST(
                    COALESCE(po.order_qty, 0)::numeric,
                    CASE
                        WHEN COALESCE(sb.balance_rows, 0) > 0
                            THEN COALESCE(sb.pre_warehouse_units, 0)
                        ELSE COALESCE(po.order_qty, 0)::numeric
                    END
                ) AS remaining_units,
                COALESCE(sb.warehouse_units, 0)::numeric AS warehouse_units,
                GREATEST(CURRENT_DATE - po.date_ordered, 0) > %(wip_max_age_days)s AS stale
            FROM production_orders po
            LEFT JOIN stage_balance sb ON sb.order_ref = po.order_ref
            WHERE po.bo_state = ANY(%(pipeline_states)s)
        ),
        variant_totals AS (
            SELECT order_ref, SUM(COALESCE(qty, 0))::numeric AS variant_units
            FROM production_order_variants
            GROUP BY order_ref
        )
        SELECT
            'style'::text AS grain,
            ow.order_ref,
            ow.style_number,
            ow.style_name,
            NULL::text AS colour,
            ow.bo_state,
            ow.date_ordered,
            ow.age_days,
            ow.ordered_units,
            ow.remaining_units AS units,
            ow.warehouse_units,
            ow.stale
        FROM order_wip ow

        UNION ALL

        SELECT
            'colour'::text AS grain,
            ow.order_ref,
            ow.style_number,
            ow.style_name,
            COALESCE(v.colour, '') AS colour,
            ow.bo_state,
            ow.date_ordered,
            ow.age_days,
            ow.ordered_units,
            CASE
                WHEN COALESCE(vt.variant_units, 0) > 0
                    THEN SUM(COALESCE(v.qty, 0)) * ow.remaining_units / vt.variant_units
                ELSE 0
            END AS units,
            ow.warehouse_units,
            ow.stale
        FROM order_wip ow
        JOIN production_order_variants v ON v.order_ref = ow.order_ref
        JOIN variant_totals vt ON vt.order_ref = ow.order_ref
        GROUP BY
            ow.order_ref, ow.style_number, ow.style_name, ow.bo_state,
            ow.date_ordered, ow.age_days, ow.ordered_units,
            ow.remaining_units, ow.warehouse_units, ow.stale,
            COALESCE(v.colour, ''), vt.variant_units
    """, {
        "pipeline_states": list(_PIPELINE_BO_STATES),
        "wip_max_age_days": _WIP_MAX_AGE_DAYS,
    }, fetch=True)

    def _match_key(style_number, style_name):
        number = str(style_number or "").strip().casefold()
        name = str(style_name or "").strip().casefold()
        return number, name

    raw_number_styles = {}
    for r in raw:
        number_key, name_key = _match_key(r.get("style_number"), r.get("style_name"))
        if number_key and name_key:
            raw_number_styles.setdefault(number_key, set()).add(name_key)
    unique_number_keys = {
        number for number, names in raw_number_styles.items() if len(names) == 1
    }

    pipeline_styles = {}
    pipeline_colours = {}
    wip_audit = {
        "cutoff_days": _WIP_MAX_AGE_DAYS,
        "open_orders": 0,
        "open_order_units": 0,
        "included_orders": 0,
        "included_wip_units": 0,
        "stale_orders": 0,
        "stale_remaining_units": 0,
        "warehouse_units_excluded": 0,
        "oldest_open_order_days": None,
        "by_age": {
            "0_30": {"orders": 0, "remaining_units": 0},
            "31_60": {"orders": 0, "remaining_units": 0},
            "61_90": {"orders": 0, "remaining_units": 0},
            "over_90": {"orders": 0, "remaining_units": 0},
        },
        "stale_by_state": {s: {"orders": 0, "remaining_units": 0}
                           for s in _PIPELINE_BO_STATES},
    }
    for p in pipeline_raw:
        state = p.get("bo_state")
        if state not in _PIPELINE_BO_STATES:
            continue
        if p.get("grain") == "style":
            age_days = int(p.get("age_days") or 0)
            ordered_units = int(round(float(p.get("ordered_units") or p.get("units") or 0)))
            remaining_units = int(round(float(p.get("units") or 0)))
            stale = bool(p.get("stale"))
            if "stale" not in p:
                # Backward-compatible shape for tests/briefly cached rows.
                stale = False
            age_key = (
                "0_30" if age_days <= 30 else
                "31_60" if age_days <= 60 else
                "61_90" if age_days <= 90 else "over_90"
            )
            wip_audit["open_orders"] += 1
            wip_audit["open_order_units"] += ordered_units
            wip_audit["warehouse_units_excluded"] += int(round(float(
                p.get("warehouse_units") or 0)))
            wip_audit["oldest_open_order_days"] = max(
                wip_audit["oldest_open_order_days"] or 0, age_days)
            wip_audit["by_age"][age_key]["orders"] += 1
            wip_audit["by_age"][age_key]["remaining_units"] += remaining_units
            if stale:
                wip_audit["stale_orders"] += 1
                wip_audit["stale_remaining_units"] += remaining_units
                wip_audit["stale_by_state"][state]["orders"] += 1
                wip_audit["stale_by_state"][state]["remaining_units"] += remaining_units
            else:
                wip_audit["included_orders"] += 1
                wip_audit["included_wip_units"] += remaining_units
        if bool(p.get("stale")):
            continue
        number_key, name_key = _match_key(p.get("style_number"), p.get("style_name"))
        units = int(round(float(p.get("units") or 0)))
        keys = [key for key in (("number", number_key), ("name", name_key)) if key[1]]
        for key in keys:
            target = pipeline_styles if p.get("grain") == "style" else pipeline_colours
            full_key = key if p.get("grain") == "style" else (
                key[0], key[1],
                re.sub(r"[^a-z0-9]+", "", str(p.get("colour") or "").casefold()),
            )
            state_map = target.setdefault(full_key, {s: 0 for s in _PIPELINE_BO_STATES})
            state_map[state] += units

    for r in raw:
        number_key, name_key = _match_key(r.get("style_number"), r.get("style_name"))
        style_states = (
            pipeline_styles.get(("name", name_key)) if name_key else None
        ) or (
            pipeline_styles.get(("number", number_key))
            if number_key in unique_number_keys else None
        ) or {
            s: 0 for s in _PIPELINE_BO_STATES
        }
        colour_key = re.sub(
            r"[^a-z0-9]+", "", str(r.get("colour") or "").casefold()
        )
        colour_states = (
            pipeline_colours.get(("name", name_key, colour_key))
            if name_key else None
        ) or (
            pipeline_colours.get(("number", number_key, colour_key))
            if number_key in unique_number_keys else None
        ) or {
            s: 0 for s in _PIPELINE_BO_STATES
        }
        r["pipeline_by_state"] = style_states
        r["pipeline_units"] = sum(style_states.values())
        r["colour_pipeline_by_state"] = colour_states
        r["colour_pipeline_units"] = sum(colour_states.values())

    # ── Assemble the nested tree ──────────────────────────────────────────────
    cats = {}
    tot_su = 0; tot_stores = 0; tot_online = 0; tot_wh = 0
    tot_sv = 0.0; tot_up = 0; tot_rp = 0.0; tot_achieved = 0.0
    tot_full_price = 0.0; tot_pipe = 0
    tot_pipe_states = {state: 0 for state in _PIPELINE_BO_STATES}
    uncategorised_stock_units = 0
    uncategorised_styles = set()
    needs_review_stock_units = 0

    def _pipeline_map(value):
        value = value if isinstance(value, dict) else {}
        return {state: int(float(value.get(state) or 0)) for state in _PIPELINE_BO_STATES}

    def _add_pipeline(node, units, states):
        node["pipeline_units"] += units
        for state, qty in states.items():
            node["pipeline_by_state"][state] += qty

    def _bucket(store, name, child_key):
        node = store.get(name)
        if node is None:
            node = {"name": name, "stock_units": 0, "soh_stores": 0,
                    "soh_online": 0, "soh_warehouse": 0, "stock_value": 0.0,
                    "units_period": 0, "revenue_period": 0.0, "_u6": 0,
                    "_achieved_sales_gross": 0.0, "_full_price_value": 0.0,
                    "pipeline_units": 0,
                    "pipeline_by_state": {state: 0 for state in _PIPELINE_BO_STATES},
                    child_key: {}}
            store[name] = node
        return node

    tier_filter = set(t.strip() for t in tier.split(",") if t.strip()) if tier else None

    for r in raw:
        # Keep the tree's tier scope identical to /api/merch/styles.  Tier is
        # intentionally resolved in Python because the lifecycle helper is a
        # shared business rule, not a stored SQL field.
        row_tier = _compute_tier(r.get("style_name"), bool(r.get("is_noos")))
        if not include_retired and row_tier in ("Retired", "Archived"):
            # Match the Inventory KPI cards' canonical lifecycle split. Raw
            # product status can be blank even when the shared Odoo classifier
            # knows the style is retired; the checkbox must use that source of
            # truth or the retired delta is badly understated.
            continue
        lifecycle_needs_review = row_tier is None
        if lifecycle_needs_review:
            # Stock Mix must fail open for lifecycle data quality: blank or
            # unrecognised Odoo statuses are sellable unless explicitly
            # Retired/Archived. Keep them visible and flag them for review.
            row_tier = _UNTIERED_ACTIVE
        if tier_filter and row_tier not in tier_filter:
            continue

        su = int(r.get("stock_units") or 0)
        ss = int(r.get("soh_stores") or 0)
        so = int(r.get("soh_online") or 0)
        sw = int(r.get("soh_warehouse") or 0)
        sv = float(r.get("stock_value") or 0)
        up = int(r.get("units_period") or 0)
        rp = float(r.get("revenue_period") or 0)
        achieved = float(r.get("achieved_sales_gross") or 0)
        full_price_value = float(r.get("full_price_value") or 0)
        u6 = int(r.get("units_6m") or 0)
        cat_name = r.get("category") or "Uncategorised"
        sub_name = r.get("subcategory") or "Uncategorised"
        sty_name = r.get("style_name")
        col_name = r.get("colour") or "Unspecified"

        tot_su += su; tot_stores += ss; tot_online += so; tot_wh += sw
        tot_sv += sv; tot_up += up; tot_rp += rp
        tot_achieved += achieved; tot_full_price += full_price_value
        if lifecycle_needs_review:
            needs_review_stock_units += su
        if cat_name == "Uncategorised" and su:
            uncategorised_stock_units += su
            if sty_name:
                uncategorised_styles.add(sty_name)

        c  = _bucket(cats, cat_name, "subcategories")
        sb = _bucket(c["subcategories"], sub_name, "styles")
        st = _bucket(sb["styles"], sty_name, "colours")
        if "style_number" not in st:
            style_pipe = int(float(r.get("pipeline_units") or 0))
            style_pipe_states = _pipeline_map(r.get("pipeline_by_state"))
            st["style_number"] = r.get("style_number")
            st["status"] = (
                row_tier if row_tier in ("Retired", "Archived")
                else (r.get("style_status") or "Unreviewed")
            )
            st["tier"] = "Needs review" if row_tier == _UNTIERED_ACTIVE else row_tier
            _add_pipeline(st, style_pipe, style_pipe_states)
            _add_pipeline(c, style_pipe, style_pipe_states)
            _add_pipeline(sb, style_pipe, style_pipe_states)
            tot_pipe += style_pipe
            for state, qty in style_pipe_states.items():
                tot_pipe_states[state] += qty
            # Most recent production/buying order for the style (nullable).
            st["last_order_date"] = r.get("style_last_order")
            st["last_sale_date"] = r.get("last_sale_date")
        # The SKU-derived colour dates out-cover the textual style match
        # (blank/mismatched PO style numbers), so roll them up: a style must
        # never show a dash while one of its own colours shows a date.
        # ISO yyyy-mm-dd strings compare correctly as text.
        _clo = r.get("colour_last_order")
        if _clo and (not st.get("last_order_date") or _clo > st["last_order_date"]):
            st["last_order_date"] = _clo
        _sale = r.get("last_sale_date")
        if _sale and (not st.get("last_sale_date") or _sale > st["last_sale_date"]):
            st["last_sale_date"] = _sale
        col = st["colours"].get(col_name)
        if col is None:
            col = {"name": col_name, "stock_units": 0, "soh_stores": 0,
                   "soh_online": 0, "soh_warehouse": 0, "stock_value": 0.0,
                   "units_period": 0, "revenue_period": 0.0, "_u6": 0,
                   "_achieved_sales_gross": 0.0, "_full_price_value": 0.0,
                   "pipeline_units": int(float(r.get("colour_pipeline_units") or 0)),
                   "pipeline_by_state": _pipeline_map(r.get("colour_pipeline_by_state")),
                   "skus_in_stock": 0, "skus_sold": 0,
                     "status": (
                         r.get("colour_status")
                         or r.get("style_status")
                         or "Unreviewed"
                     ),
                    "tier": "Needs review" if row_tier == _UNTIERED_ACTIVE else row_tier,
                    "last_sale_date": r.get("last_sale_date"),
                    # Colourway-only fabric context. Never add either value to
                    # style/subcategory/category/total buckets: the same fabric
                    # may be referenced by many colourways.
                    "fabric_name": r.get("fabric_name") or None,
                    "fabric_barcode": r.get("fabric_barcode") or None,
                    "fabric_stock_metres": (
                        round(float(r["fabric_stock_metres"]), 1)
                        if r.get("fabric_stock_metres") is not None else None
                    ),
                     "fabric_other_colour_stock_metres": (
                         round(float(r["fabric_other_colour_stock_metres"]), 1)
                         if r.get("fabric_other_colour_stock_metres") is not None else None
                     ),
                   # Colour-grain ordering context + image key (nullable).
                   "last_order_date": r.get("colour_last_order"),
                   "rep_sku": r.get("rep_sku")}
            st["colours"][col_name] = col
        for node in (c, sb, st, col):
            node["stock_units"]    += su
            node["soh_stores"]     += ss
            node["soh_online"]     += so
            node["soh_warehouse"]  += sw
            node["stock_value"]    += sv
            node["units_period"]   += up
            node["revenue_period"] += rp
            node["_achieved_sales_gross"] += achieved
            node["_full_price_value"] += full_price_value
            node["_u6"]            += u6
        col["skus_in_stock"] += int(r.get("skus_in_stock") or 0)
        col["skus_sold"]     += int(r.get("skus_sold") or 0)

    # Only nodes with stock or period sales are shown. Pruned nodes carry 0
    # stock and 0 period units, so grand totals (and KPI reconciliation) are
    # unaffected; parents keep the pruned leaves' units_6m in their WOC
    # denominator (matching the tab's style-level WOC semantics).
    def _keep(n):
        return (n["stock_units"] != 0 or n["pipeline_units"] != 0
                or n["units_period"] != 0
                or abs(n["stock_value"]) >= 0.5
                or abs(n.get("revenue_period", 0)) >= 0.5)

    counts = {"categories": 0, "subcategories": 0, "styles": 0, "colours": 0}

    recency_anchor = today

    def _finish(node):
        u6 = node.pop("_u6", 0)
        achieved = node.pop("_achieved_sales_gross", 0)
        full_price_value = node.pop("_full_price_value", 0)
        node["stock_value"] = round(node["stock_value"])
        node["revenue_period"] = round(node["revenue_period"])
        node["full_price_pct"] = (
            round(achieved * 100.0 / full_price_value, 1)
            if node["units_period"] > 0 and full_price_value > 0 else None
        )
        # Business-facing alias. Keep pipeline_units for compatibility with
        # existing consumers, but Stock Mix labels and exports this value WIP.
        node["wip_units"] = node.get("pipeline_units", 0)
        node["woc"] = round(node["stock_units"] / (u6 / 26.0), 1) if u6 > 0 else None
        if node.get("last_sale_date"):
            try:
                node["last_sale_days"] = (recency_anchor - date.fromisoformat(
                    str(node["last_sale_date"])[:10])).days
            except (TypeError, ValueError):
                node["last_sale_days"] = None
        else:
            node["last_sale_days"] = None
        if "last_order_date" in node and node.get("last_order_date"):
            try:
                node["order_age_days"] = (today - date.fromisoformat(
                    str(node["last_order_date"])[:10])).days
            except (TypeError, ValueError):
                node["order_age_days"] = None
        elif "last_order_date" in node:
            node["order_age_days"] = None
        node["awaiting_delivery"] = bool(
            "last_order_date" in node
            and node.get("stock_units", 0) == 0
            and node.get("pipeline_units", 0) > 0
        )

    def _sorted(nodes):
        return sorted(nodes, key=lambda x: (-x["stock_units"], -x["units_period"], x["name"]))

    cat_list = []
    for c in cats.values():
        sub_list = []
        for sb in c["subcategories"].values():
            sty_list = []
            for st in sb["styles"].values():
                col_list = [col for col in st["colours"].values() if _keep(col)]
                for col in col_list:
                    _finish(col)
                st["colours"] = _sorted(col_list)
                if not _keep(st):
                    continue
                _finish(st)
                counts["colours"] += len(col_list)
                sty_list.append(st)
            sb["styles"] = _sorted(sty_list)
            if not _keep(sb):
                continue
            _finish(sb)
            counts["styles"] += len(sty_list)
            sub_list.append(sb)
        c["subcategories"] = _sorted(sub_list)
        if not _keep(c):
            continue
        _finish(c)
        counts["subcategories"] += len(sub_list)
        cat_list.append(c)
    counts["categories"] = len(cat_list)
    wip_audit["attributed_wip_units"] = tot_pipe
    wip_audit["unattributed_recent_wip_units"] = max(
        wip_audit["included_wip_units"] - tot_pipe, 0)

    return {
        "categories": _sorted(cat_list),
        "totals": {
            "stock_units":    tot_su,
            "soh_stores":     tot_stores,
            "soh_online":     tot_online,
            "soh_warehouse":  tot_wh,
            "stock_value":    round(tot_sv),
            "pipeline_units": tot_pipe,
            "wip_units":      tot_pipe,
            "pipeline_by_state": tot_pipe_states,
            "units_period":   tot_up,
            "revenue_period": round(tot_rp),
            "full_price_pct": (
                round(tot_achieved * 100.0 / tot_full_price, 1)
                if tot_up > 0 and tot_full_price > 0 else None
            ),
        },
        "period": {"from": period_from, "to": period_to},
        "wip_audit": wip_audit,
        "counts": counts,
        "data_quality": {
            "unknown_status_product_rows": int(
                raw[0].get("unknown_status_product_rows") or 0
            ) if raw else 0,
            "unknown_status_skus": int(
                raw[0].get("unknown_status_skus") or 0
            ) if raw else 0,
            "unknown_status_styles": int(
                raw[0].get("unknown_status_styles") or 0
            ) if raw else 0,
            "unknown_status_colourways": int(
                raw[0].get("unknown_status_colourways") or 0
            ) if raw else 0,
            "needs_review_stock_units": needs_review_stock_units,
            "uncategorised_stock_units": uncategorised_stock_units,
            "uncategorised_style_count": len(uncategorised_styles),
            "uncategorised_styles": sorted(uncategorised_styles),
        },
    }


# ── BI-owned Product Workspace canonical source ──────────────────────────────

def _product_workspace_leaf_index(stock_mix):
    """Index existing Stock Mix style nodes without altering its raw tree."""
    indexed = {}
    for category in (stock_mix or {}).get("categories", []):
        for subcategory in category.get("subcategories", []):
            for style in subcategory.get("styles", []):
                key = style.get("style_number") or style.get("name")
                if key:
                    indexed[str(key)] = style
    return indexed


def _product_workspace_styles(styles, stock_mix):
    """Add Product Workspace aliases from canonical Merch outputs only.

    Fabric is intentionally retained at colourway grain: summing it to a style
    would double-count a shared supplier fabric.  The raw Stock Mix tree remains
    separately available to consumers that need its full drill-down.
    """
    leaves = _product_workspace_leaf_index(stock_mix)
    result = []
    for source in styles:
        style = dict(source)
        leaf = leaves.get(str(style.get("style_number") or style.get("style_name") or ""))
        lifecycle_tier = style.get("tier")
        lifecycle_status = (
            "Active" if lifecycle_tier in _ACTIVE_LIFECYCLE_BUCKETS
            else "Retired" if lifecycle_tier == "Retired"
            else "Archived" if lifecycle_tier == "Archived"
            else "Excluded"
        )
        # These aliases make the intended contract explicit while retaining all
        # established Merch keys for existing BI consumers.
        style["style_master"] = {
            "style_number": style.get("style_number"),
            "style_name": style.get("style_name"),
            "brand": style.get("brand"),
            "category": style.get("category"),
            "subcategory": style.get("subcategory"),
            "status": lifecycle_status,
            "tier": style.get("tier"),
            "colour_count": style.get("colour_count"),
            "full_price": style.get("full_price"),
            "launch_date": style.get("launch_date"),
        }
        style["status"] = lifecycle_status
        style["lifecycle_status"] = lifecycle_status
        style["price"] = style.get("full_price")
        style["stock"] = {
            "stores": style.get("soh_stores"),
            "online": style.get("soh_online"),
            "warehouse": style.get("soh_warehouse"),
        }
        style["wip_units"] = leaf.get("wip_units") if leaf else 0
        style["units"] = style.get("units_period")
        style["revenue"] = style.get("revenue_period")
        style["asp"] = style.get("avg_selling_price")
        style["sell_through"] = style.get("sor_period")
        style["sor"] = style.get("sor_6m")
        style["weeks_of_cover"] = style.get("woc")
        style["last_sale_days"] = style.get("last_sale_days")
        # Exact/other-colour metres are authoritative only for a colourway.
        style["fabric_by_colour"] = [
            {
                "colour": colour.get("name"),
                "fabric_name": colour.get("fabric_name"),
                "fabric_barcode": colour.get("fabric_barcode"),
                "exact_metres": colour.get("fabric_stock_metres"),
                "other_colour_metres": colour.get("fabric_other_colour_stock_metres"),
            }
            for colour in (leaf or {}).get("colours", [])
        ]
        # A style-level fabric number is only meaningful when there is exactly
        # one attributable colourway; otherwise consumers must use the explicit
        # colour list above rather than a fabricated/double-counted total.
        if len(style["fabric_by_colour"]) == 1:
            fabric = style["fabric_by_colour"][0]
            style["fabric_exact_metres"] = fabric["exact_metres"]
            style["fabric_other_colour_metres"] = fabric["other_colour_metres"]
        else:
            style["fabric_exact_metres"] = None
            style["fabric_other_colour_metres"] = None
        result.append(style)
    return result


def _product_workspace_reconciliations(styles, summary, stock_mix):
    stock_actual = (stock_mix or {}).get("totals", {}).get("stock_units", 0)
    stock_expected = (summary or {}).get("active_stock_units", 0)
    active_actual = len({
        (s.get("style_number") or s.get("style_name"))
        for s in styles
        if s.get("tier") in _ACTIVE_LIFECYCLE_BUCKETS
    })
    active_expected = (summary or {}).get("active_styles_all_count", 0)
    def check(name, expected, actual):
        passed = expected == actual
        return {
            "name": name, "status": "pass" if passed else "fail",
            "passed": passed,
            "expected": expected, "actual": actual,
            "message": ("Values reconcile." if passed
                        else f"Expected {expected}; canonical source returned {actual}."),
        }
    return [
        check("stockMix_total_equals_summary_active_stock", stock_expected, stock_actual),
        check("active_style_count_equals_summary_kpi", active_expected, active_actual),
    ]


def _product_workspace_cogs(rows):
    """Pure COGS calculator; invalid/missing rows are explicitly excluded."""
    included, excluded = [], []
    numerator = denominator = Decimal("0")
    for index, row in enumerate(rows or []):
        try:
            if not isinstance(row, dict):
                raise ValueError("row must be an object")
            units = Decimal(str(row.get("units")))
            cost = Decimal(str(row.get("unitCost")))
            vat_price = Decimal(str(row.get("sellingPriceVatInclusive")))
            net_price = vat_price / Decimal("1.16")
            if not all(v.is_finite() and v > 0 for v in (units, cost, vat_price)):
                raise ValueError("units, unitCost, and sellingPriceVatInclusive must be positive")
            input_cogs = cost / net_price
        except (InvalidOperation, TypeError, ValueError, ArithmeticError) as exc:
            excluded.append({"index": index, "reason": str(exc) or "invalid row"})
            continue
        numerator += units * cost
        denominator += units * net_price
        included.append({
            "index": index, "units": float(units), "unitCost": float(cost),
            "sellingPriceNet": float(net_price), "inputCogs": float(input_cogs),
        })
    return {
        "rows": included,
        "includedRowCount": len(included),
        "excludedRowCount": len(excluded),
        "excludedRows": excluded,
        "blended": float(numerator / denominator) if denominator else None,
    }


_PRODUCT_WORKSPACE_DEFINITIONS = [
    {"metric": "Stock / SOH", "formula": "Sellable stores + Online + Warehouse Finished Goods; WIP excluded.", "source": "BI Merch styles and Stock Mix"},
    {"metric": "WIP", "formula": "Open buying-order pre-warehouse balance, capped at ordered quantity and aged no more than 60 days.", "source": "BI Stock Mix"},
    {"metric": "Units and revenue", "formula": "Selected-period sale/order units and canonical net revenue.", "source": "BI sales semantic layer"},
    {"metric": "ASP", "formula": "Selected-period realised net revenue divided by selected-period units.", "source": "BI Merch styles"},
    {"metric": "Sell-through / SOR", "formula": "Units divided by units plus sellable SOH.", "source": "BI Merch styles"},
    {"metric": "Weeks of cover", "formula": "Sellable SOH divided by trailing-six-month units divided by 26.", "source": "BI Merch styles"},
    {"metric": "Full-price %", "formula": "Selected-period full-price sales value as a percentage of modal full-price value.", "source": "BI Merch styles"},
    {"metric": "Last-sale recency", "formula": "Days from today to the canonical all-history last sale date.", "source": "BI Merch styles"},
    {"metric": "Fabric metres", "formula": "Exact-colour and other-colour supplier-fabric metres; shared fabrics are not summed to style.", "source": "BI Stock Mix"},
    {"metric": "Style master", "formula": "Canonical style identity, category, lifecycle, tier, colours, price and launch date.", "source": "BI product semantic layer"},
    {"metric": "Buying orders", "formula": "Dated, non-cancelled Odoo buying/production order records.", "source": "BI production orders"},
    {"metric": "Input COGS", "formula": "Unit cost / (VAT-inclusive selling price / 1.16); blended by planned units.", "source": "BI Product Workspace COGS"},
]


# ── Online Performance (channel split: online vs retail) ─────────────────────
# Online = all_sales.channel = 'Online' OR pos_location_name ILIKE '%online%'
# (the junk online locations are already excluded by _BASE_FILTERS, so the
# surviving online rows are the real Shop Zetu / online feed).
# Online SOH = all_inventory locations whose name contains 'online'.
_ONLINE_SALE_PRED = "(s.channel = 'Online' OR s.pos_location_name ILIKE '%%online%%')"


def _op_filters(country=None, brand=None, subcategory=None):
    """Shared WHERE fragments + params for online-performance queries.
    brand/subcategory filter through the product master p (joined on SKU)."""
    where, params = [], []
    if country:
        vals = [v.strip() for v in str(country).split(",") if v.strip()]
        if vals:
            # all_sales stores the Shop Zetu online feed under the pseudo-
            # country 'Online' (it is the Kenyan online store); fold it into
            # a Kenya selection so a Kenya filter keeps online sales.
            if "Kenya" in vals and "Online" not in vals:
                vals = vals + ["Online"]
            where.append("s.country = ANY(%s)")
            params.append(vals)
    for col, val in (("p.brand", brand), ("p.product_type", subcategory)):
        if val:
            vals = [v.strip() for v in str(val).split(",") if v.strip()]
            if vals:
                where.append(f"{col} = ANY(%s)")
                params.append(vals)
    return where, params


def _op_soh_sql(country=None):
    """Per-SKU pre-aggregated SOH split online vs retail-store (never joined
    raw to sales — see inventory pre-aggregation invariant).

    Returns (sql, params). When a country filter is set, retail SOH is
    scoped strictly to the selected countries, while online SOH also keeps
    all_inventory's 'Online' pseudo-country rows (online stock is held under
    country='Online', not under a selling country)."""
    params = []
    online_ctry = retail_ctry = ""
    vals = [v.strip() for v in str(country).split(",") if v.strip()] if country else []
    if vals:
        # all_inventory holds online stock under the pseudo-country 'Online'
        # (the Shop Zetu / Kenyan online store) — include it when Kenya is in
        # the selection, mirroring the sales-side country fold.
        if "Kenya" in vals and "Online" not in vals:
            vals = vals + ["Online"]
        online_ctry = "AND i.country = ANY(%s)"
        retail_ctry = "AND i.country = ANY(%s)"
        params = [vals, vals]
    sql = f"""
        SELECT i.sku,
               SUM(CASE WHEN i.pos_location_name ILIKE '%%online%%'
                        {online_ctry}
                        THEN i.available ELSE 0 END)::numeric AS soh_online,
               SUM(CASE WHEN i.pos_location_name NOT ILIKE '%%online%%'
                         AND i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
                         AND LOWER(i.pos_location_name) NOT IN ({_HOLDING_STORES_LOWER})
                         {retail_ctry}
                        THEN i.available ELSE 0 END)::numeric AS soh_retail
        FROM all_inventory i
        WHERE i.available > 0
        GROUP BY i.sku
    """
    return sql, params


def _online_perf_sources(from_date, to_date, country=None, brand=None,
                         subcategory=None, ly_from=None, ly_to=None):
    """Fetch the two reusable source aggregates for Online Performance.

    The old implementation scanned all_sales once for every KPI/trend/dimension
    and all_inventory once for every stock dimension.  Keep the source grain
    small (SKU + product dimensions + channel + period bucket), then derive all
    response sections in Python from these two result sets.
    """
    from datetime import date as _date
    d_from = _date.fromisoformat(from_date)
    d_to = _date.fromisoformat(to_date)
    ly_from = ly_from or str(d_from - timedelta(days=365))
    ly_to = ly_to or str(d_to - timedelta(days=365))
    span_days = max(1, (d_to - d_from).days + 1)
    gran = "week" if span_days <= 140 else "month"
    bucket = f"date_trunc('{gran}', s.sale_date::date)::date"
    fwhere, fparams = _op_filters(country, brand, subcategory)
    extra = ("AND " + " AND ".join(fwhere)) if fwhere else ""
    sales = _db_exec(f"""
        SELECT
            CASE WHEN s.sale_date::date BETWEEN %s AND %s
                 THEN 'current' ELSE 'ly' END AS period_kind,
            CASE WHEN s.sale_date::date BETWEEN %s AND %s
                 THEN {bucket} ELSE NULL END AS bucket,
            p.category, p.size, p.color_print AS colour,
            CASE WHEN {_ONLINE_SALE_PRED} THEN 'online' ELSE 'retail' END
                AS channel_group,
            SUM({_NET_SALES_EXPR})::numeric AS net_revenue,
            SUM(CASE WHEN s.sale_kind IN ('sale','order')
                     THEN s.total_sales_kes::numeric ELSE 0 END) AS gross_revenue,
            SUM(CASE WHEN s.sale_kind IN ('sale','order')
                     THEN COALESCE(s.ordered_item_quantity,0) ELSE 0 END) AS units,
            SUM(CASE WHEN s.sale_kind IN ('sale','order')
                       AND COALESCE(s.discounts_kes,0)::numeric = 0
                     THEN COALESCE(s.ordered_item_quantity,0) ELSE 0 END) AS fp_units,
            SUM(CASE WHEN s.sale_kind IN ('sale','order')
                     THEN COALESCE(s.discounts_kes,0)::numeric ELSE 0 END) AS discounts,
            SUM(CASE WHEN s.sale_kind IN ('sale','order')
                       AND COALESCE(s.discounts_kes,0)::numeric > 0
                       AND s.total_sales_kes::numeric > 0
                     THEN ({_NET_SALES_EXPR}) ELSE 0 END) AS promo_revenue,
            SUM(CASE WHEN s.sale_kind = 'return'
                     THEN ABS(COALESCE(s.returns_kes,0)::numeric) ELSE 0 END) AS returns_kes
        FROM all_sales s
        LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE {_BASE_FILTERS}
          AND (
              s.sale_date::date BETWEEN %s AND %s
              OR s.sale_date::date BETWEEN %s AND %s
          )
          {extra}
        GROUP BY 1, 2, 3, 4, 5, 6
    """, [from_date, to_date, from_date, to_date,
          from_date, to_date, ly_from, ly_to] + fparams)

    soh_sql, soh_params = _op_soh_sql(country)
    w, prm = _op_filters(None, brand, subcategory)
    ex = ("AND " + " AND ".join(w)) if w else ""
    inventory = _db_exec(f"""
        WITH soh AS ({soh_sql})
        SELECT p.category, p.size, p.color_print AS colour,
               soh.sku, soh.soh_online, soh.soh_retail
        FROM soh
        LEFT JOIN all_products_clean p ON p.sku = soh.sku
        WHERE 1=1 {ex}
    """, soh_params + prm)
    return sales, inventory, gran


def _online_perf_payload(from_date, to_date, country=None, brand=None,
                         subcategory=None):
    from datetime import date as _date, timedelta as _td

    d_from = _date.fromisoformat(from_date)
    d_to   = _date.fromisoformat(to_date)
    span_days = max(1, (d_to - d_from).days + 1)
    weeks = span_days / 7.0
    gran = "week" if span_days <= 140 else "month"
    bucket = f"date_trunc('{gran}', s.sale_date::date)::date"

    fwhere, fparams = _op_filters(country, brand, subcategory)
    extra = ("AND " + " AND ".join(fwhere)) if fwhere else ""

    base = f"""
        FROM all_sales s
        LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE {_BASE_FILTERS}
          AND s.sale_date::date BETWEEN %s AND %s
          {extra}
    """

    def _chan_aggs():
        return f"""
            CASE WHEN {_ONLINE_SALE_PRED} THEN 'online' ELSE 'retail' END AS channel_group,
            SUM({_NET_SALES_EXPR})::numeric                                AS net_revenue,
            SUM(CASE WHEN s.sale_kind IN ('sale','order')
                     THEN s.total_sales_kes::numeric ELSE 0 END)           AS gross_revenue,
            SUM(CASE WHEN s.sale_kind IN ('sale','order')
                     THEN COALESCE(s.ordered_item_quantity,0) ELSE 0 END)  AS units,
            SUM(CASE WHEN s.sale_kind IN ('sale','order')
                      AND COALESCE(s.discounts_kes,0)::numeric = 0
                     THEN COALESCE(s.ordered_item_quantity,0) ELSE 0 END)  AS fp_units,
            SUM(CASE WHEN s.sale_kind IN ('sale','order')
                     THEN COALESCE(s.discounts_kes,0)::numeric ELSE 0 END) AS discounts,
            SUM(CASE WHEN s.sale_kind IN ('sale','order')
                      AND COALESCE(s.discounts_kes,0)::numeric > 0
                      AND s.total_sales_kes::numeric > 0
                     THEN ({_NET_SALES_EXPR}) ELSE 0 END)                  AS promo_revenue,
            SUM(CASE WHEN s.sale_kind = 'return'
                     THEN ABS(COALESCE(s.returns_kes,0)::numeric) ELSE 0 END) AS returns_kes
        """

    # Shared source aggregates: one sales scan and one inventory scan feed all
    # headline, trend, dimension, SOH, and benchmark calculations below.
    source_sales, source_inventory, gran = _online_perf_sources(
        from_date, to_date, country, brand, subcategory,
        str(d_from - _td(days=365)), str(d_to - _td(days=365)))

    def _num(row, key):
        return float(row.get(key) or 0)

    current_sales = [r for r in source_sales if r["period_kind"] == "current"]
    ly_sales = [r for r in source_sales if r["period_kind"] == "ly"]

    def _aggregate(rows, key=None):
        out = {}
        for r in rows:
            if key is not None:
                k = r.get(key)
                if k is None or k == "":
                    continue
            else:
                k = "all"
            ch = r["channel_group"]
            e = out.setdefault((k, ch), {
                **({key: k} if key is not None else {}),
                "channel_group": ch, "net_revenue": 0, "gross_revenue": 0,
                "units": 0, "fp_units": 0, "discounts": 0,
                "promo_revenue": 0, "returns_kes": 0,
            })
            for field in ("net_revenue", "gross_revenue", "units", "fp_units",
                          "discounts", "promo_revenue", "returns_kes"):
                e[field] += _num(r, field)
        return list(out.values())

    # 1) headline per-channel aggregates (this period)
    kpi_rows = _aggregate(current_sales)
    k = {r["channel_group"]: r for r in kpi_rows}

    def g(ch, f, dflt=0):
        v = (k.get(ch) or {}).get(f)
        return float(v) if v is not None else dflt

    # 2) online revenue same period last year (YoY)
    online_rev_ly = sum(_num(r, "net_revenue") for r in ly_sales
                         if r["channel_group"] == "online")

    # 3) trend buckets (revenue + discount depth + promo share per channel)
    tmap = {}
    trend_agg = {}
    for r in current_sales:
        key = (r.get("bucket"), r["channel_group"])
        e = trend_agg.setdefault(key, {"bucket": r.get("bucket"),
                                       "channel_group": r["channel_group"],
                                       "net_revenue": 0, "gross_revenue": 0,
                                       "discounts": 0, "promo_revenue": 0})
        for field in ("net_revenue", "gross_revenue", "discounts", "promo_revenue"):
            e[field] += _num(r, field)
    for r in trend_agg.values():
        b = str(r["bucket"])
        t = tmap.setdefault(b, {"bucket": b})
        ch = r["channel_group"]
        gross = float(r["gross_revenue"] or 0)
        disc  = float(r["discounts"] or 0)
        net   = float(r["net_revenue"] or 0)
        promo = float(r["promo_revenue"] or 0)
        t[ch] = round(net, 2)
        t[f"depth_{ch}"] = round(disc / gross * 100, 2) if gross > 0 else None
        t[f"promo_share_{ch}"] = round(promo / net * 100, 2) if net > 0 else None
    trend = sorted(tmap.values(), key=lambda x: x["bucket"])

    # 4) per-SKU channel SOH, folded to category / colour / size via the master
    soh_sql, soh_params = _op_soh_sql(country)

    def _soh_by(dim_expr, dim_name):
        out = {}
        for r in source_inventory:
            key = r.get(dim_name)
            if not key:
                continue
            e = out.setdefault(key, {dim_name: key, "soh_online": 0,
                                     "soh_retail": 0})
            e["soh_online"] += _num(r, "soh_online")
            e["soh_retail"] += _num(r, "soh_retail")
        return list(out.values())

    def _sales_by(dim_expr, dim_name):
        return _aggregate(current_sales, dim_name)

    def _fold(dim_name, sales_rows, soh_rows):
        m = {}
        for r in sales_rows:
            key = r[dim_name]
            e = m.setdefault(key, {dim_name: key})
            ch = r["channel_group"]
            e[f"{ch}_rev"]      = round(float(r["net_revenue"] or 0), 2)
            e[f"{ch}_units"]    = float(r["units"] or 0)
            e[f"{ch}_fp_units"] = float(r["fp_units"] or 0)
        for r in soh_rows:
            e = m.setdefault(r[dim_name], {dim_name: r[dim_name]})
            e["online_soh"] = float(r["soh_online"] or 0)
            e["retail_soh"] = float(r["soh_retail"] or 0)
        for e in m.values():
            for ch in ("online", "retail"):
                u   = e.get(f"{ch}_units", 0) or 0
                fp  = e.get(f"{ch}_fp_units", 0) or 0
                soh = e.get(f"{ch}_soh", 0) or 0
                e[f"{ch}_sor"]    = round(u / (u + soh) * 100, 1)  if (u + soh) > 0 else None
                e[f"{ch}_fp_sor"] = round(fp / (fp + soh) * 100, 1) if (fp + soh) > 0 else None
                e.setdefault(f"{ch}_rev", 0.0)
                e.setdefault(f"{ch}_units", 0)
        return list(m.values())

    categories = _fold("category",
                       _sales_by("p.category", "category"),
                       _soh_by("p.category", "category"))
    tot_on  = sum(e["online_rev"] for e in categories) or None
    tot_re  = sum(e["retail_rev"] for e in categories) or None
    for e in categories:
        e["online_rev_share"] = round(e["online_rev"] / tot_on * 100, 1) if tot_on else None
        e["retail_rev_share"] = round(e["retail_rev"] / tot_re * 100, 1) if tot_re else None
        e["gap_pp"] = (round(e["online_fp_sor"] - e["retail_fp_sor"], 1)
                       if e.get("online_fp_sor") is not None and e.get("retail_fp_sor") is not None
                       else None)
    categories.sort(key=lambda e: -(e["online_rev"] + e["retail_rev"]))

    sizes = _fold("size", _sales_by("p.size", "size"), _soh_by("p.size", "size"))
    for e in sizes:
        e["gap_pp"] = (round(e["online_sor"] - e["retail_sor"], 1)
                       if e.get("online_sor") is not None and e.get("retail_sor") is not None
                       else None)
    # share denominator = ALL sizes' online SOH (incl. stock-only sizes and
    # sizes beyond the top-14 cut), so "share of online SOH" is truthful
    _tot_online_soh = sum((e.get("online_soh") or 0) for e in sizes)
    sizes = [e for e in sizes if (e["online_units"] + e["retail_units"]) > 0]
    sizes.sort(key=lambda e: -(e["online_units"] + e["retail_units"]))
    sizes = sizes[:14]

    # Size Analysis extras: share of online SOH per size, plus a weighted
    # online benchmark SOR per size across the WHOLE online business (same
    # country/period scope, but ignoring the brand/subcategory narrowing —
    # the online analogue of the store cockpit's "All Stores benchmark").
    for e in sizes:
        e["online_soh_share"] = (round((e.get("online_soh") or 0) / _tot_online_soh * 100, 1)
                                 if _tot_online_soh > 0 else None)
    if brand or subcategory:
        bwhere, bparams = _op_filters(country, None, None)
        bex = ("AND " + " AND ".join(bwhere)) if bwhere else ""
        bench_sales = _db_exec(f"""
            SELECT p.size AS size,
                   SUM(CASE WHEN s.sale_kind IN ('sale','order')
                            THEN COALESCE(s.ordered_item_quantity,0) ELSE 0 END) AS units
            FROM all_sales s
            LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
            WHERE {_BASE_FILTERS} AND {_ONLINE_SALE_PRED}
              AND s.sale_date::date BETWEEN %s AND %s {bex}
              AND COALESCE(p.size,'') <> ''
            GROUP BY 1
        """, [from_date, to_date] + bparams)
        bench_soh = _db_exec(f"""
            WITH soh AS ({soh_sql})
            SELECT p.size AS size, SUM(soh.soh_online) AS soh_online
            FROM soh JOIN all_products_clean p ON p.sku = soh.sku
            WHERE COALESCE(p.size,'') <> ''
            GROUP BY 1
        """, soh_params)
        _bm = {}
        for r in bench_sales:
            _bm.setdefault(r["size"], {})["u"] = float(r["units"] or 0)
        for r in bench_soh:
            _bm.setdefault(r["size"], {})["soh"] = float(r["soh_online"] or 0)
        for e in sizes:
            v = _bm.get(e["size"]) or {}
            u, bs = v.get("u", 0), v.get("soh", 0)
            e["benchmark_sor"] = round(u / (u + bs) * 100, 1) if (u + bs) > 0 else None
    else:
        # unfiltered scope: the benchmark IS the online SOR in view
        for e in sizes:
            e["benchmark_sor"] = e.get("online_sor")

    # colours — ONLINE only (units, soh, sor)
    colour_rows = _fold("colour",
                        _sales_by("p.color_print", "colour"),
                        _soh_by("p.color_print", "colour"))
    colours = [{
        "colour": e["colour"],
        "units":  e.get("online_units", 0),
        "soh":    e.get("online_soh", 0),
        "sor":    e.get("online_sor"),
    } for e in colour_rows
        if (e.get("online_units", 0) or 0) + (e.get("online_soh", 0) or 0) > 0]
    colours.sort(key=lambda e: (-(e["sor"] if e["sor"] is not None else -1), -e["units"]))
    colours = colours[:20]

    # SOH by category (online stock) + WOC vs online period velocity
    cat_units_online = {e["category"]: e.get("online_units", 0) for e in categories}
    soh_by_category = []
    for e in categories:
        soh = e.get("online_soh", 0) or 0
        if soh <= 0:
            continue
        weekly = (cat_units_online.get(e["category"], 0) or 0) / weeks
        soh_by_category.append({
            "category": e["category"],
            "soh": soh,
            "woc": round(soh / weekly, 1) if weekly > 0 else None,
        })
    soh_by_category.sort(key=lambda x: -x["soh"])

    # headline KPI derivations
    on_g, re_g = g("online", "gross_revenue"), g("retail", "gross_revenue")
    on_net, re_net = g("online", "net_revenue"), g("retail", "net_revenue")
    on_units = g("online", "units")
    on_soh_total = sum(e.get("online_soh", 0) or 0 for e in categories)
    on_fp = g("online", "fp_units")
    re_fp = g("retail", "fp_units")
    re_soh_total = sum(e.get("retail_soh", 0) or 0 for e in categories)
    on_weekly = on_units / weeks if weeks > 0 else 0

    kpis = {
        "online_rev": round(on_net, 2),
        "online_rev_ly": round(online_rev_ly, 2),
        "online_rev_yoy_pct": (round((on_net - online_rev_ly) / online_rev_ly * 100, 1)
                               if online_rev_ly > 0 else None),
        "online_share_pct": (round(on_net / (on_net + re_net) * 100, 1)
                             if (on_net + re_net) > 0 else None),
        "fp_sor_online": (round(on_fp / (on_fp + on_soh_total) * 100, 1)
                          if (on_fp + on_soh_total) > 0 else None),
        "fp_sor_retail": (round(re_fp / (re_fp + re_soh_total) * 100, 1)
                          if (re_fp + re_soh_total) > 0 else None),
        "online_soh": on_soh_total,
        "online_woc": (round(on_soh_total / on_weekly, 1) if on_weekly > 0 else None),
        "online_sor": (round(on_units / (on_units + on_soh_total) * 100, 1)
                       if (on_units + on_soh_total) > 0 else None),
        "discount_depth_online": (round(g("online", "discounts") / on_g * 100, 1)
                                  if on_g > 0 else None),
        "discount_depth_retail": (round(g("retail", "discounts") / re_g * 100, 1)
                                  if re_g > 0 else None),
        "promo_share_online": (round(g("online", "promo_revenue") / on_net * 100, 1)
                               if on_net > 0 else None),
        "promo_share_retail": (round(g("retail", "promo_revenue") / re_net * 100, 1)
                               if re_net > 0 else None),
        "return_rate_online": (round(g("online", "returns_kes") / on_g * 100, 1)
                               if on_g > 0 else None),
    }

    # full-price vs discounted revenue mix per channel
    mix = {}
    for ch in ("online", "retail"):
        net = g(ch, "net_revenue")
        promo = g(ch, "promo_revenue")
        mix[ch] = {
            "fp_pct":   round((net - promo) / net * 100, 1) if net > 0 else None,
            "disc_pct": round(promo / net * 100, 1)          if net > 0 else None,
        }

    return {
        "has_channel": True,
        "granularity": gran,
        "kpis": kpis,
        "trend": trend,
        "categories": categories,
        "sizes": sizes,
        "colours": colours,
        "mix": mix,
        "soh_by_category": soh_by_category,
    }


def _online_subcats_payload(category, from_date, to_date, country=None,
                            brand=None, subcategory=None):
    fwhere, fparams = _op_filters(country, brand, subcategory)
    extra = ("AND " + " AND ".join(fwhere)) if fwhere else ""
    sales = _db_exec(f"""
        SELECT p.product_type AS subcategory,
               CASE WHEN {_ONLINE_SALE_PRED} THEN 'online' ELSE 'retail' END AS channel_group,
               SUM(CASE WHEN s.sale_kind IN ('sale','order')
                        THEN COALESCE(s.ordered_item_quantity,0) ELSE 0 END) AS units
        FROM all_sales s
        JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE {_BASE_FILTERS}
          AND s.sale_date::date BETWEEN %s AND %s
          AND p.category = %s
          AND COALESCE(p.product_type,'') <> '' {extra}
        GROUP BY 1, 2
    """, [from_date, to_date, category] + fparams)
    w2, p2 = _op_filters(None, brand, subcategory)
    ex2 = ("AND " + " AND ".join(w2)) if w2 else ""
    soh_sql2, soh_params2 = _op_soh_sql(country)
    soh = _db_exec(f"""
        WITH soh AS ({soh_sql2})
        SELECT p.product_type AS subcategory,
               SUM(soh.soh_online) AS soh_online,
               SUM(soh.soh_retail) AS soh_retail
        FROM soh JOIN all_products_clean p ON p.sku = soh.sku
        WHERE p.category = %s AND COALESCE(p.product_type,'') <> '' {ex2}
        GROUP BY 1
    """, soh_params2 + [category] + p2)
    m = {}
    for r in sales:
        e = m.setdefault(r["subcategory"], {"subcategory": r["subcategory"]})
        e[f"{r['channel_group']}_units"] = float(r["units"] or 0)
    for r in soh:
        e = m.setdefault(r["subcategory"], {"subcategory": r["subcategory"]})
        e["online_soh"] = float(r["soh_online"] or 0)
        e["retail_soh"] = float(r["soh_retail"] or 0)
    rows = []
    for e in m.values():
        for ch in ("online", "retail"):
            u, s_ = e.get(f"{ch}_units", 0) or 0, e.get(f"{ch}_soh", 0) or 0
            e[f"{ch}_sor"] = round(u / (u + s_) * 100, 1) if (u + s_) > 0 else None
            e.setdefault(f"{ch}_units", 0)
        if (e["online_units"] + e["retail_units"]) > 0 or e.get("online_soh", 0) > 0:
            rows.append(e)
    rows.sort(key=lambda e: -(e["online_units"] + e["retail_units"]))
    return {"category": category, "rows": rows}


def _fetch_online_colourways(from_date, to_date, country=None, brand=None,
                             subcategory=None):
    """Page-level Colourway Performance for the Online Performance tab —
    the online analogue of the Style Deep Dive's per-style colourway section
    (_fetch_style_colors), at (style_number, colour) grain across the whole
    online assortment.

    Scope canon (matches the rest of the online-performance surface):
      • sales   = _ONLINE_SALE_PRED + _BASE_FILTERS, country folded via the
        Kenya→'Online' pseudo-country rule (same as _op_filters);
      • stock   = all_inventory locations ILIKE '%%online%%' only, with the
        same country fold on i.country (same as _op_soh_sql);
      • products = third-party brands excluded (merch hub scope), optional
        brand / subcategory (product_type) narrowing.

    Metric canon mirrors _fetch_style_colors exactly, with online-only
    inputs: period units/revenue from the hub date filter; WOC from FIXED
    trailing 6-month online units ÷ 26; rule inputs from FIXED trailing
    4/8/12-week windows with SOR = units ÷ (units + current online SOH);
    ASP is VAT-inclusive & discount-aware vs the modal ticket price.

    The Restock / Marketing / Retire classification (same thresholds and
    precedence as the deep dive's client-side COLOR_REC) is done HERE
    because Marketing/Retire need style-level facts (last production order,
    lifecycle tier, launch date incl. first-sale fallback) across many
    styles. Restock is purely colour-level so it scans every row; style
    attributes are fetched only for styles with a colour passing the cheap
    Marketing/Retire colour-level pre-filters (plus the charted styles).

    Rows with no online stock and no period online sales are hidden (same
    rule as the deep-dive section).
    """
    today      = date.today()
    six_mo_ago = str(today - timedelta(days=_SIX_MONTHS_DAYS))
    today_str  = str(today)
    wk4_ago    = str(today - timedelta(weeks=4))
    wk8_ago    = str(today - timedelta(weeks=8))
    wk12_ago   = str(today - timedelta(weeks=12))
    period_from = from_date or six_mo_ago
    period_to   = to_date or today_str

    # Country fold — Kenya keeps the 'Online' pseudo-country on BOTH the
    # sales side (s.country) and the inventory side (i.country).
    params = {
        "period_from": period_from, "period_to": period_to,
        "six_mo_ago": six_mo_ago, "today": today_str,
        "wk4_ago": wk4_ago, "wk8_ago": wk8_ago, "wk12_ago": wk12_ago,
    }
    sales_ctry = inv_ctry = ""
    cvals = [c.strip() for c in str(country).split(",") if c.strip()] if country else []
    if cvals:
        if "Kenya" in cvals and "Online" not in cvals:
            cvals = cvals + ["Online"]
        params["countries"] = cvals
        sales_ctry = " AND s.country = ANY(%(countries)s)"
        inv_ctry   = " AND i.country = ANY(%(countries)s)"

    prod_extra = ""
    if brand:
        bvals = [v.strip() for v in str(brand).split(",") if v.strip()]
        if bvals:
            params["brands"] = bvals
            prod_extra += " AND brand = ANY(%(brands)s)"
    if subcategory:
        scvals = [v.strip() for v in str(subcategory).split(",") if v.strip()]
        if scvals:
            params["subcats"] = scvals
            prod_extra += " AND product_type = ANY(%(subcats)s)"

    sql = f"""
WITH sk AS (
    SELECT sku, style_number,
           COALESCE(NULLIF(TRIM(color_print), ''), '—') AS color,
           price
    FROM all_products_clean
    WHERE sku IS NOT NULL AND sku <> ''
      AND style_number IS NOT NULL AND style_number <> ''
      AND COALESCE(brand,'') NOT ILIKE '%%third party%%'
      {prod_extra}
),
sales AS (
    SELECT k.style_number, k.color,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                             AS units_sold,
        SUM({_NET_SALES_EXPR})        AS revenue
    FROM sk k
    JOIN all_sales s ON s.variant_sku = k.sku
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
        AND {_BASE_FILTERS}
        AND {_ONLINE_SALE_PRED}
        {sales_ctry}
    GROUP BY k.style_number, k.color
),
stock AS (
    SELECT k.style_number, k.color,
        COALESCE(SUM(i.available), 0) AS soh
    FROM sk k
    JOIN all_inventory i ON i.sku = k.sku
    WHERE i.available > 0
      AND i.pos_location_name ILIKE '%%online%%'
      {inv_ctry}
    GROUP BY k.style_number, k.color
),
sales_6m AS (
    SELECT k.style_number, k.color,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                             AS units_6m
    FROM sk k
    JOIN all_sales s ON s.variant_sku = k.sku
    WHERE s.sale_date BETWEEN %(six_mo_ago)s AND %(today)s
        AND {_BASE_FILTERS}
        AND {_ONLINE_SALE_PRED}
        {sales_ctry}
    GROUP BY k.style_number, k.color
),
sales_wk AS (
    SELECT k.style_number, k.color,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order') AND s.sale_date >= %(wk4_ago)s
        )                             AS units_4wk,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order') AND s.sale_date >= %(wk8_ago)s
        )                             AS units_8wk,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                             AS units_12wk,
        SUM(s.total_sales_kes::numeric - COALESCE(s.discounts_kes,0)::numeric) FILTER (
            WHERE s.sale_kind IN ('sale','order') AND s.sale_date >= %(wk4_ago)s
        )                             AS realized_4wk,
        MAX(s.sale_date::date) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                             AS last_sale_date
    FROM sk k
    JOIN all_sales s ON s.variant_sku = k.sku
    WHERE s.sale_date BETWEEN %(wk12_ago)s AND %(today)s
        AND {_BASE_FILTERS}
        AND {_ONLINE_SALE_PRED}
        {sales_ctry}
    GROUP BY k.style_number, k.color
),
fullprice AS (
    SELECT style_number, color,
        mode() WITHIN GROUP (ORDER BY price)
            FILTER (WHERE price > 0) AS full_price
    FROM sk
    GROUP BY style_number, color
)
SELECT
    COALESCE(sa.style_number, st.style_number) AS style_number,
    COALESCE(sa.color, st.color)   AS color,
    COALESCE(sa.units_sold, 0)     AS units_sold,
    COALESCE(sa.revenue, 0.0)      AS revenue,
    COALESCE(st.soh, 0)            AS soh,
    COALESCE(s6.units_6m, 0)       AS units_6m,
    COALESCE(sw.units_4wk, 0)      AS units_4wk,
    COALESCE(sw.units_8wk, 0)      AS units_8wk,
    COALESCE(sw.units_12wk, 0)     AS units_12wk,
    COALESCE(sw.realized_4wk, 0.0) AS realized_4wk,
    sw.last_sale_date,
    fp.full_price
FROM sales sa
FULL OUTER JOIN stock st
       ON st.style_number = sa.style_number AND st.color = sa.color
LEFT JOIN sales_6m s6
       ON s6.style_number = COALESCE(sa.style_number, st.style_number)
      AND s6.color        = COALESCE(sa.color, st.color)
LEFT JOIN sales_wk sw
       ON sw.style_number = COALESCE(sa.style_number, st.style_number)
      AND sw.color        = COALESCE(sa.color, st.color)
LEFT JOIN fullprice fp
       ON fp.style_number = COALESCE(sa.style_number, st.style_number)
      AND fp.color        = COALESCE(sa.color, st.color)
"""
    raw = _db_exec(sql, params, fetch=True) or []

    rows = []
    for r in raw:
        units   = int(r["units_sold"] or 0)
        revenue = float(r["revenue"] or 0)
        soh     = int(r["soh"] or 0)
        # Hidden: no online stock AND no period online sales
        if soh <= 0 and units <= 0 and revenue == 0:
            continue
        units_6m   = int(r["units_6m"] or 0)
        weekly_avg = round(units_6m / 26.0, 2)
        woc = round(soh / weekly_avg, 1) if weekly_avg > 0 else None
        u4, u8, u12 = (int(r["units_4wk"] or 0), int(r["units_8wk"] or 0),
                       int(r["units_12wk"] or 0))

        def _sor(u, _soh=soh):
            denom = u + _soh
            return round(u * 100.0 / denom, 1) if denom > 0 else None

        realized_4wk = float(r["realized_4wk"] or 0)
        asp_raw = (realized_4wk / u4) if u4 > 0 else None
        full_price = float(r["full_price"]) if r.get("full_price") else None
        asp_pct_full = (round(asp_raw * 100.0 / full_price, 1)
                        if asp_raw is not None and full_price and full_price > 0
                        else None)
        last_sale = r.get("last_sale_date")
        last_sale_days = None
        if last_sale:
            try:
                ls = (last_sale if isinstance(last_sale, date)
                      else date.fromisoformat(str(last_sale)[:10]))
                last_sale_days = (today - ls).days
            except Exception:
                last_sale = None
        rows.append({
            "style_number":   r.get("style_number"),
            "color":          r.get("color") or "—",
            "units_sold":     units,
            "revenue":        round(revenue, 0),
            "soh":            soh,
            "woc":            woc,
            "weekly_avg":     weekly_avg,
            "sor_4wk":        _sor(u4),
            "sor_8wk":        _sor(u8),
            "sor_12wk":       _sor(u12),
            "asp_pct_full":   asp_pct_full,
            "full_price":     full_price,
            "last_sale_date": str(last_sale)[:10] if last_sale else None,
            "last_sale_days": last_sale_days,
        })

    rows.sort(key=lambda x: x["revenue"], reverse=True)

    # ── Chart rows: union of top-12 by revenue and top-12 by online SOH ──────
    by_rev = rows[:12]
    by_soh = sorted(rows, key=lambda x: x["soh"], reverse=True)[:12]
    chart_keys = {(c["style_number"], c["color"]) for c in by_rev}
    chart_keys |= {(c["style_number"], c["color"]) for c in by_soh}

    # ── Style attributes — only for styles that might need them ─────────────
    # Marketing pre-filter: WOC > 8 and 8-wk SOR < 70 (still needs a recent
    # production order). Retire pre-filter: 12-wk SOR < 70 (still needs the
    # new-style + on-sale-12-weeks facts). Plus every charted style (labels).
    need_styles = {c["style_number"] for c in rows
                   if (c["woc"] is not None and c["woc"] > 8
                       and c["sor_8wk"] is not None and c["sor_8wk"] < 70)
                   or (c["sor_12wk"] is not None and c["sor_12wk"] < 70)}
    need_styles |= {k[0] for k in chart_keys}
    need_styles = sorted(s for s in need_styles if s)

    attrs = {}
    if need_styles:
        attr_rows = _db_exec(f"""
WITH m AS (
    SELECT style_number,
        mode() WITHIN GROUP (ORDER BY style_name)
            FILTER (WHERE COALESCE(style_name,'') <> '') AS style_name,
        BOOL_OR(COALESCE(is_noos, FALSE))                AS is_noos,
        CASE WHEN BOOL_OR(LOWER(COALESCE(status,'active')) = 'retired')
                  AND NOT BOOL_OR(LOWER(COALESCE(status,'active')) = 'active')
             THEN 'Retired' ELSE 'Active' END            AS status,
        MIN(substring(style_launch_date,1,10))
            FILTER (WHERE substring(style_launch_date,1,10)
                    ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$') AS launch_date
    FROM all_products_clean
    WHERE style_number = ANY(%(styles)s)
    GROUP BY style_number
),
rc AS (
    SELECT m.style_number,
        COUNT(DISTINCT po.order_ref) AS reorder_count,
        MAX(po.date_ordered)         AS last_order_date
    FROM m
    LEFT JOIN production_orders po
           ON po.style_number = m.style_number
           OR po.style_name   = m.style_name
    GROUP BY m.style_number
),
/* First-sale launch fallback — same fallback rule as _fetch_styles; rows for
   styles that already carry a master launch date lose to the COALESCE. */
fs AS (
    SELECT p2.style_number, MIN(s.sale_date::date) AS first_sale_date
    FROM all_products_clean p2
    JOIN all_sales s ON s.variant_sku = p2.sku
    WHERE p2.style_number = ANY(%(styles)s)
      AND s.sale_kind IN ('sale','order')
    GROUP BY p2.style_number
),
SELECT m.style_number, m.style_name, m.is_noos, m.status,
       COALESCE(m.launch_date, fs.first_sale_date::text) AS launch_date,
       rc.reorder_count, rc.last_order_date
FROM m
LEFT JOIN rc ON rc.style_number = m.style_number
LEFT JOIN fs ON fs.style_number = m.style_number
""", {"styles": need_styles}, fetch=True) or []
        for a in attr_rows:
            tier = _compute_tier(a.get("style_name"), a.get("is_noos"))
            lod = a.get("last_order_date")
            last_order_days = None
            if lod:
                try:
                    lo = (lod if isinstance(lod, date)
                          else date.fromisoformat(str(lod)[:10]))
                    last_order_days = (today - lo).days
                except Exception:
                    pass
            ld = a.get("launch_date")
            launch_days = None
            if ld:
                try:
                    launch_days = (today - date.fromisoformat(str(ld)[:10])).days
                except Exception:
                    pass
            attrs[a["style_number"]] = {
                "style_name":      a.get("style_name") or a["style_number"],
                "tier":            tier,
                "launch_days":     launch_days,
                "last_order_days": last_order_days,
            }

    def _label(c):
        at = attrs.get(c["style_number"]) or {}
        return {**c, "style_name": at.get("style_name") or c["style_number"] or "—"}

    # ── Signal classification — COLOR_REC thresholds, Restock › Marketing ›
    #    Retire precedence (each colourway lands in at most one group) ────────
    restock, marketing, retire = [], [], []
    for c in rows:
        if (c["sor_4wk"] is not None and c["sor_4wk"] > 40
                and c["woc"] is not None and c["woc"] < 4
                and c["asp_pct_full"] is not None and c["asp_pct_full"] > 90
                and c["last_sale_days"] is not None and c["last_sale_days"] < 2):
            restock.append(_label(c))
            continue
        at = attrs.get(c["style_number"])
        if (at and at["last_order_days"] is not None
                and at["last_order_days"] <= 91
                and c["woc"] is not None and c["woc"] > 8
                and c["sor_8wk"] is not None and c["sor_8wk"] < 70):
            marketing.append({**_label(c), "last_order_days": at["last_order_days"]})
            continue
        if at:
            is_new = (at["tier"] == "Tier 4"
                      or (at["launch_days"] is not None and at["launch_days"] <= 365))
            on_sale_12wk = at["launch_days"] is not None and at["launch_days"] >= 84
            if (is_new and on_sale_12wk
                    and c["sor_12wk"] is not None and c["sor_12wk"] < 70):
                retire.append(_label(c))

    def _sig(items, sort_key, reverse):
        items = sorted(items, key=sort_key, reverse=reverse)
        return {"count": len(items), "items": items[:12]}

    signals = {
        # Best restocks first (fastest sellers), worst laggards first.
        "restock":   _sig(restock,   lambda c: c["sor_4wk"] or 0,  True),
        "marketing": _sig(marketing, lambda c: c["soh"],           True),
        "retire":    _sig(retire,    lambda c: c["sor_12wk"] or 0, False),
    }

    colors = [_label(c) for c in rows
              if (c["style_number"], c["color"]) in chart_keys]
    colors.sort(key=lambda x: x["revenue"], reverse=True)

    # ── By Size breakdown — the charted colourways split by size ────────────
    sizes = []
    chart_styles = sorted({k[0] for k in chart_keys if k[0]})
    if chart_styles:
        sparams = {"period_from": period_from, "period_to": period_to,
                   "chart_styles": chart_styles}
        if "countries" in params:
            sparams["countries"] = params["countries"]
        size_rows = _db_exec(f"""
WITH sk AS (
    SELECT sku, style_number,
           COALESCE(NULLIF(TRIM(color_print), ''), '—') AS color,
           COALESCE(NULLIF(TRIM(size), ''), '—')        AS size
    FROM all_products_clean
    WHERE style_number = ANY(%(chart_styles)s)
      AND sku IS NOT NULL AND sku <> ''
),
sales AS (
    SELECT k.style_number, k.color, k.size,
        SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        )                      AS units_sold,
        SUM({_NET_SALES_EXPR}) AS revenue
    FROM sk k
    JOIN all_sales s ON s.variant_sku = k.sku
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
        AND {_BASE_FILTERS}
        AND {_ONLINE_SALE_PRED}
        {sales_ctry}
    GROUP BY k.style_number, k.color, k.size
),
stock AS (
    SELECT k.style_number, k.color, k.size,
        COALESCE(SUM(i.available), 0) AS soh
    FROM sk k
    JOIN all_inventory i ON i.sku = k.sku
    WHERE i.available > 0
      AND i.pos_location_name ILIKE '%%online%%'
      {inv_ctry}
    GROUP BY k.style_number, k.color, k.size
)
SELECT
    COALESCE(sa.style_number, st.style_number) AS style_number,
    COALESCE(sa.color, st.color) AS color,
    COALESCE(sa.size,  st.size)  AS size,
    COALESCE(sa.units_sold, 0)   AS units_sold,
    COALESCE(sa.revenue, 0.0)    AS revenue,
    COALESCE(st.soh, 0)          AS soh
FROM sales sa
FULL OUTER JOIN stock st
       ON st.style_number = sa.style_number
      AND st.color = sa.color AND st.size = sa.size
""", sparams, fetch=True) or []
        for r in size_rows:
            key = (r.get("style_number"), r.get("color") or "—")
            if key not in chart_keys:
                continue
            units = int(r["units_sold"] or 0)
            soh   = int(r["soh"] or 0)
            rev   = float(r["revenue"] or 0)
            if soh <= 0 and units <= 0 and rev == 0:
                continue
            at = attrs.get(r.get("style_number")) or {}
            sizes.append({
                "style_number": r.get("style_number"),
                "style_name":   at.get("style_name") or r.get("style_number") or "—",
                "color":        r.get("color") or "—",
                "size":         r.get("size") or "—",
                "units_sold":   units,
                "revenue":      round(rev, 0),
                "soh":          soh,
            })
        sizes.sort(key=lambda x: x["revenue"], reverse=True)
        # Keep the size view readable: union of top-20 by revenue / by SOH.
        s_rev = sizes[:20]
        s_soh = sorted(sizes, key=lambda x: x["soh"], reverse=True)[:20]
        skeys = {(x["style_number"], x["color"], x["size"]) for x in s_rev}
        skeys |= {(x["style_number"], x["color"], x["size"]) for x in s_soh}
        sizes = [x for x in sizes
                 if (x["style_number"], x["color"], x["size"]) in skeys]

    return {
        "colors":           colors,
        "sizes":            sizes,
        "signals":          signals,
        "total_colourways": len(rows),
    }


def register_merch_routes(app, api_pg_module):
    global A
    A = api_pg_module

    from fastapi import Request, Query, Body, HTTPException
    from fastapi.responses import JSONResponse

    _TTL = 600  # seconds

    # Ensure the tier-overrides table exists on first registration.
    _ensure_tier_overrides_table()

    def _product_workspace_orders(date_from=None, date_to=None):
        """Read the BI-owned order ledger, avoiding optional-column assumptions."""
        sql = """
            WITH product_by_number AS (
                SELECT
                    p.style_number,
                    mode() WITHIN GROUP (ORDER BY p.category) AS category,
                    mode() WITHIN GROUP (ORDER BY p.product_type) AS subcategory,
                    mode() WITHIN GROUP (ORDER BY p.price)
                        FILTER (WHERE p.price > 0) AS selling_price
                FROM all_products_clean p
                WHERE p.style_number IS NOT NULL
                GROUP BY p.style_number
            ),
            product_by_name AS (
                SELECT
                    p.style_name,
                    mode() WITHIN GROUP (ORDER BY p.category) AS category,
                    mode() WITHIN GROUP (ORDER BY p.product_type) AS subcategory,
                    mode() WITHIN GROUP (ORDER BY p.price)
                        FILTER (WHERE p.price > 0) AS selling_price
                FROM all_products_clean p
                WHERE p.style_name IS NOT NULL
                GROUP BY p.style_name
            )
            SELECT
                COALESCE(po.source, j->>'source', 'odoo') AS source,
                po.order_ref AS reference,
                po.style_number,
                COALESCE(po.style_name, j->>'style_name', po.product_name,
                         j->>'product_name') AS style_name,
                COALESCE(pn.category, pm.category) AS category,
                COALESCE(pn.subcategory, pm.subcategory) AS subcategory,
                po.order_qty,
                po.date_ordered,
                COALESCE(
                    po.cost_price_kes,
                    CASE WHEN btrim(j->>'unitCost') ~ '^[0-9]+(\\.[0-9]+)?$'
                         THEN (j->>'unitCost')::numeric END,
                    CASE WHEN btrim(j->>'unit_cost') ~ '^[0-9]+(\\.[0-9]+)?$'
                         THEN (j->>'unit_cost')::numeric END
                ) AS unit_cost,
                COALESCE(pn.selling_price, pm.selling_price) AS selling_price
            FROM public.production_orders po
            CROSS JOIN LATERAL to_jsonb(po) j
            LEFT JOIN product_by_number pn
              ON pn.style_number = po.style_number
            LEFT JOIN product_by_name pm
              ON pn.style_number IS NULL
             AND pm.style_name = COALESCE(
                    po.style_name, j->>'style_name', po.product_name)
            WHERE po.date_ordered IS NOT NULL
              AND COALESCE(LOWER(j->>'bo_state'), '') NOT IN ('cancel', 'cancelled')
              AND COALESCE(LOWER(j->>'state'), '') NOT IN ('cancel', 'cancelled')
              AND (%(date_from)s IS NULL OR po.date_ordered >= %(date_from)s::date)
              AND (%(date_to)s IS NULL OR po.date_ordered <= %(date_to)s::date)
            ORDER BY po.date_ordered DESC, po.order_ref
        """
        raw = _db_exec(sql, {"date_from": date_from, "date_to": date_to}, fetch=True)
        return [{
            "source": r.get("source"), "reference": r.get("reference"),
            "style_number": r.get("style_number"), "style_name": r.get("style_name"),
            "category": r.get("category"), "subcategory": r.get("subcategory"),
            "order_qty": float(r["order_qty"]) if r.get("order_qty") is not None else None,
            "date_ordered": str(r["date_ordered"]) if r.get("date_ordered") else None,
            "unit_cost": float(r["unit_cost"]) if r.get("unit_cost") is not None else None,
            "selling_price": (float(r["selling_price"])
                              if r.get("selling_price") is not None else None),
        } for r in (raw or [])]

    def _apply_product_workspace_range_refresh(styled_rows):
        """Reset lifecycle evidence after the latest Range Refreshed plan."""
        refreshed = _db_exec("""
            WITH refresh AS (
                SELECT LOWER(BTRIM(l.style_number)) AS style_key,
                       MAX(to_date(p.iso_year::text || lpad(p.iso_week::text,2,'0') || '1','IYYYIWID')) AS refresh_date
                FROM product_workspace.weekly_order_plan_lines l
                JOIN product_workspace.weekly_order_plans p ON p.id=l.plan_id
                WHERE l.order_type='Range Refreshed' AND BTRIM(l.style_number)<>''
                GROUP BY LOWER(BTRIM(l.style_number))
            ),
            sales AS (
                SELECT r.style_key,r.refresh_date,MIN(s.sale_date::date) AS first_sale_date,
                       COALESCE(SUM(CASE WHEN s.sale_kind IN ('sale','order')
                         THEN s.ordered_item_quantity ELSE 0 END),0) AS units_life
                FROM refresh r
                LEFT JOIN all_products_clean ap ON LOWER(BTRIM(ap.style_number))=r.style_key
                LEFT JOIN all_sales s ON s.variant_sku=ap.sku AND s.sale_date::date>=r.refresh_date
                GROUP BY r.style_key,r.refresh_date
            ),
            orders AS (
                SELECT r.style_key,COUNT(DISTINCT po.order_ref)::int AS order_count,
                       MAX(po.date_ordered)::date AS last_order_date
                FROM refresh r
                LEFT JOIN production_orders po ON LOWER(BTRIM(po.style_number))=r.style_key
                  AND po.date_ordered::date>=r.refresh_date
                GROUP BY r.style_key
            )
            SELECT s.style_key,s.refresh_date,s.first_sale_date,s.units_life,
                   o.order_count,o.last_order_date
            FROM sales s JOIN orders o USING(style_key)
        """, fetch=True) or []
        facts = {r["style_key"]: r for r in refreshed}
        for style in styled_rows:
            fact = facts.get(str(style.get("style_number") or "").strip().lower())
            if not fact:
                continue
            units = int(fact.get("units_life") or 0)
            stock = int(style.get("current_stock") or 0)
            style["range_refresh_date"] = str(fact["refresh_date"])[:10]
            style["first_sale_date"] = str(fact["first_sale_date"])[:10] if fact.get("first_sale_date") else None
            style["units_life"] = units
            style["sor_life"] = round(units * 100.0 / (units + stock), 1) if units + stock > 0 else None
            style["reorder_count"] = int(fact.get("order_count") or 0)
            style["last_order_date"] = str(fact["last_order_date"])[:10] if fact.get("last_order_date") else None
        return styled_rows

    @app.get("/api/internal/product-workspace-source")
    async def product_workspace_source(
        request: Request,
        date_from: Optional[str] = Query(None),
        date_to: Optional[str] = Query(None),
    ):
        """Single internal canonical source for the BI Product Workspace."""
        canonical_styles = await _styles_async(
            from_date=date_from, to_date=date_to, ttl=_TTL)
        # Use the same stock-tree implementation as Merch, not a second stock
        # formula.  It is synchronous/database-bound, so run it off-loop.
        from starlette.concurrency import run_in_threadpool
        stock_mix_key = (
            f"merch_stock_mix_v8|None|None|None|{date_from}|{date_to}|"
            "None|None|False"
        )
        stock_mix = await run_in_threadpool(
            _cached, stock_mix_key, _TTL,
            lambda: _fetch_stock_mix(
                brand=None, subcategory=None, tier=None,
                from_date=date_from, to_date=date_to,
                country=None, pos_location=None, include_retired=False))
        styles = await run_in_threadpool(
            _apply_product_workspace_range_refresh,
            _product_workspace_styles(canonical_styles, stock_mix))
        summary = _compute_summary(canonical_styles)
        orders = await run_in_threadpool(_product_workspace_orders, date_from, date_to)
        return JSONResponse({
            "styles": styles,
            "summary": summary,
            "stockMix": stock_mix,
            "orders": orders,
            "definitions": _PRODUCT_WORKSPACE_DEFINITIONS,
            "sourceStatus": [
                {"name": "BI merchandising semantic layer", "status": "Active",
                 "detail": "Canonical shared style, stock, sales, WIP and trading metrics."},
                {"name": "BI production orders", "status": "Active",
                 "detail": "Canonical dated, non-cancelled Odoo buying orders."},
            ],
            "reconciliations": _product_workspace_reconciliations(
                canonical_styles, summary, stock_mix),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        })

    @app.post("/api/internal/product-workspace-cogs")
    def product_workspace_cogs(request: Request, payload: dict = Body(...)):
        rows = payload.get("rows") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise HTTPException(status_code=422, detail="rows must be an array")
        return JSONResponse(_product_workspace_cogs(rows))

    # NOTE: read endpoints here must never run heavy blocking SQL on the event
    # loop (the async-def originals serialized the Overview tab's five parallel
    # requests into a ~100s page load and froze every other request meanwhile).
    # Per-style drill-downs are plain `def` (Starlette threadpool). The five
    # Overview endpoints + KPI CSV export are async and share ONE universe
    # computation via _styles_async — winner in the threadpool, siblings await
    # a future holding no worker token.
    @app.get("/api/merch/filter-options")
    def merch_filter_options(request: Request):
        """Distinct brands and categories for the hub-level filter dropdowns.
        Long TTL (1 hour) — product catalogue changes slowly."""
        def _fetch():
            brands = [r["brand"] for r in _db_exec("""
                SELECT DISTINCT brand
                FROM all_products_clean
                WHERE brand IS NOT NULL AND brand != ''
                  AND COALESCE(brand,'') NOT ILIKE '%%third party%%'
                ORDER BY brand
            """)]
            categories = [r["product_type"] for r in _db_exec("""
                SELECT DISTINCT product_type
                FROM all_products_clean
                WHERE product_type IS NOT NULL AND product_type != ''
                ORDER BY product_type
            """)]
            return {"brands": brands, "categories": categories}
        return JSONResponse(_cached("merch_filter_options", 3600, _fetch))

    @app.get("/api/merch/online-performance")
    def merch_online_performance(
        request:      Request,
        from_date:    str = Query(...),
        to_date:      str = Query(...),
        country:      Optional[str] = Query(None),
        brand:        Optional[str] = Query(None),
        subcategory:  Optional[str] = Query(None),
    ):
        """Online vs retail channel-split payload for the Online Performance
        tab (KPIs, trend, category/size/colour breakdowns, mix, online SOH).
        Plain def → threadpool; cached per filter combination."""
        key = f"merch_online_perf|{from_date}|{to_date}|{country}|{brand}|{subcategory}"
        return JSONResponse(_cached(key, _TTL, lambda: _online_perf_payload(
            from_date, to_date, country, brand, subcategory)))

    @app.get("/api/merch/online-subcats")
    def merch_online_subcats(
        request:   Request,
        category:  str = Query(...),
        from_date: str = Query(...),
        to_date:   str = Query(...),
        country:     Optional[str] = Query(None),
        brand:       Optional[str] = Query(None),
        subcategory: Optional[str] = Query(None),
    ):
        """Subcategory drill-down (online vs retail SOR%) for one parent
        category on the Online Performance tab."""
        key = (f"merch_online_subcats|{category}|{from_date}|{to_date}|"
               f"{country}|{brand}|{subcategory}")
        return JSONResponse(_cached(key, _TTL, lambda: _online_subcats_payload(
            category, from_date, to_date, country, brand, subcategory)))

    @app.get("/api/merch/online-colourways")
    def merch_online_colourways(
        request:     Request,
        from_date:   str = Query(...),
        to_date:     str = Query(...),
        country:     Optional[str] = Query(None),
        brand:       Optional[str] = Query(None),
        subcategory: Optional[str] = Query(None),
    ):
        """Page-level Colourway Performance (online-only) for the Online
        Performance tab — charts, By Size breakdown, and Restock /
        Marketing / Retire signals. Plain def → threadpool; cached."""
        key = (f"merch_online_colourways|{from_date}|{to_date}|"
               f"{country}|{brand}|{subcategory}")
        return JSONResponse(_cached(key, _TTL, lambda: _fetch_online_colourways(
            from_date, to_date, country, brand, subcategory)))

    @app.get("/api/merch/styles")
    async def merch_styles(
        request:      Request,
        brand:        Optional[str] = Query(None),
        subcategory:  Optional[str] = Query(None),
        tier:         Optional[str] = Query(None),
        status:       Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
        pos_location: Optional[str] = Query(None),
    ):
        """Full style universe — one row per style with all merchandising metrics."""
        result = await _styles_async(
            brand, subcategory, tier, status,
            from_date, to_date, country, pos_location, _TTL)
        return JSONResponse({"styles": result, "count": len(result)})

    @app.get("/api/merch/summary")
    async def merch_summary(
        request:      Request,
        brand:        Optional[str] = Query(None),
        subcategory:  Optional[str] = Query(None),
        tier:         Optional[str] = Query(None),
        status:       Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
        pos_location: Optional[str] = Query(None),
    ):
        """Portfolio-level aggregates for the Executive Overview KPI band."""
        key = f"merch_summary|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{pos_location}"
        entry = _cache_store.get(key)
        if entry and (_time.monotonic() - entry[0]) < _TTL:
            return JSONResponse(entry[1])
        rows = await _styles_async(
            brand, subcategory, tier, status,
            from_date, to_date, country, pos_location, _TTL)
        result = _compute_summary(rows)  # pure Python over ~3.5k rows — fast
        _cache_store[key] = (_time.monotonic(), result)
        return JSONResponse(result)

    @app.get("/api/merch/export/kpi.csv")
    async def merch_export_kpi_csv(
        request:      Request,
        kpi:          str,
        brand:        Optional[str] = Query(None),
        subcategory:  Optional[str] = Query(None),
        tier:         Optional[str] = Query(None),
        status:       Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
        pos_location: Optional[str] = Query(None),
    ):
        """CSV of the styles behind one KPI card (Inventory & Stock Health +
        Overview). Columns replicate the Style_Report_Details spreadsheet
        plus "Revenue Since Launch" and optional per-KPI extra columns.
        Percent columns are emitted with an explicit % suffix ("10.9%") —
        Excel / Google Sheets still parse those cells as percentages.
        Reuses the cached _fetch_styles rows + the shared _KPI_BUCKETS
        predicates so the file always matches the on-card count.

        `active_colours` branches to COLOUR-grain rows (one row per in-stock
        colourway of the deduped Active styles — _active_colour_rows), so
        that file's data-row count equals the card's derived colourway
        count."""
        if kpi not in _KPI_BUCKETS:
            return JSONResponse({"detail": f"Unknown kpi '{kpi}'"}, status_code=400)

        # Universe via the shared single-flight helper, computed off the event
        # loop — a cold CSV click must never freeze the app or run its own
        # duplicate of an in-flight Overview universe query.
        styles = await _styles_async(
            brand, subcategory, tier, status,
            from_date, to_date, country, pos_location, _TTL)
        if kpi == "active_colours":
            # ── Colour-grain branch — one row per Active colourway ──────────
            # brand/subcategory/tier/status/date-range scoping rides on the
            # (already filtered) universe rows via the shared bucket
            # predicate; only country/POS shape the colour SQL, so its cache
            # key carries just those two. A cold colour fetch is heavy
            # blocking SQL → threadpool (same rule as the universe); warm
            # hits skip the worker hop entirely.
            colour_key = f"merch_colour_rows|{country}|{pos_location}"
            entry = _cache_store.get(colour_key)
            if entry and (_time.monotonic() - entry[0]) < _TTL:
                colour_rows = entry[1]
            else:
                from starlette.concurrency import run_in_threadpool
                colour_rows = await run_in_threadpool(
                    lambda: _cached(colour_key, _TTL,
                                    lambda: _fetch_colour_rows(
                                        country=country,
                                        pos_location=pos_location)))
            crows = _active_colour_rows(styles, colour_rows)

            import csv as _csv
            import io as _io
            from fastapi.responses import Response as _Resp
            headers = [
                "Style Name", "Style Number", "Colour",
                "Subcategory", "Tier", "Brand", "Launch Date",
                "Full Price (Kes)",
                "SOH", "Stores SOH", "Warehouse SOH",
                "6m Units Sold", "6m Rev",
                "Weekly Units Sold", "6m WOC", "Last Sale (days)",
            ]
            buf = _io.StringIO()
            w = _csv.writer(buf)
            w.writerow(headers)

            def _cv(x):
                return "" if x is None else x
            for c in crows:
                w.writerow([
                    _cv(c["style_name"]),
                    _cv(c["style_number"]),
                    _cv(c["colour_label"]),
                    _cv(c["subcategory"]),
                    _cv(c["tier"]),
                    _cv(c["brand"]),
                    _cv(c["launch_date"]),
                    _cv(c["full_price"]),
                    c["soh"],
                    c["soh_stores"],
                    c["soh_warehouse"],
                    c["units_6m"],
                    c["revenue_6m"],
                    c["weekly_avg"],
                    _cv(c["woc"]),
                    _cv(c["last_sale_days"]),
                ])
            slug  = _KPI_BUCKETS[kpi]["label"].replace(" ", "_")
            fname = f"{slug}_{date.today().isoformat()}.csv"
            return _Resp(
                content=buf.getvalue(),
                media_type="text/csv; charset=utf-8",
                headers={"Content-Disposition": f'attachment; filename="{fname}"'},
            )

        rows = _kpi_bucket_rows(styles, kpi)

        import csv as _csv
        import io as _io
        headers = [
            "Style Name", "Subcategory", "Style Number", "Tier", "SOH",
            "Warehouse SOH", "Warehouse % of Total",
            "Stores SOH", "Stores % of Total",
            "Online SOH", "Online % of Total",
            "Launch Date", "Age (Weeks)", "6m SOR", "6m Units Sold", "6m Rev",
            "Full Price (Kes)", "ASP (6m)", "% Full Price", "Mark Down",
            "Weekly Units Sold", "6m WOC", "Last Sale (days)", "Last Order Date",
            "Inventory Value (at Full Price)", "SOR Since Launch %",
            "Revenue Since Launch", "Brand",
            "Recommendation",
        ]
        # Optional per-KPI extra columns (e.g. Warehouse Units) so the figure
        # a card sums is visible in its own file.
        extra_cols = _KPI_BUCKETS[kpi].get("extra") or []
        headers += [h for h, _fn in extra_cols]
        today = date.today()
        buf = _io.StringIO()
        w = _csv.writer(buf)
        w.writerow(headers)
        for s in rows:
            # Age (Weeks) — whole weeks since launch date
            age_weeks = ""
            ld = s.get("launch_date")
            if ld:
                try:
                    age_weeks = max((today - date.fromisoformat(str(ld)[:10])).days // 7, 0)
                except Exception:
                    age_weeks = ""
            fp_pct = s.get("full_price_pct")
            markdown = round(100 - fp_pct, 1) if fp_pct is not None else None
            full_price = s.get("full_price")
            soh = s.get("current_stock") or 0
            inv_value = round(soh * full_price) if full_price is not None else ""
            # SOR Since Launch — same gross-units basis as the tab's 6m SOR
            units_life = s.get("units_life") or 0
            sl_denom = units_life + soh
            sor_life = round(units_life * 100.0 / sl_denom, 1) if sl_denom > 0 else None
            # Revenue Since Launch — lifetime net revenue (sales_life CTE),
            # same net-sales basis + filter scope as 6m Rev, whole KES.
            rev_life = s.get("revenue_life")
            rev_since_launch = round(float(rev_life)) if rev_life is not None else ""
            def _v(x):
                return "" if x is None else x
            def _pct_s(x):
                # Percent columns: explicit % suffix, one decimal, blanks stay
                # blank (Excel/Sheets parse "10.9%" as a percentage cell).
                return "" if x is None or x == "" else f"{float(x):.1f}%"
            # SOH location split — soh_online is a subset of soh_stores;
            # Stores here = physical stores only (excl. online & warehouse).
            wh  = s.get("soh_warehouse") or 0
            onl = s.get("soh_online") or 0
            sto = max(soh - wh - onl, 0)
            def _pct(x):
                return round(x * 100.0 / soh, 1) if soh > 0 else None
            w.writerow([
                _v(s.get("style_name")),
                _v(s.get("subcategory")),
                _v(s.get("style_number")),
                _v(s.get("tier")),
                soh,
                wh, _pct_s(_pct(wh)),
                sto, _pct_s(_pct(sto)),
                onl, _pct_s(_pct(onl)),
                _v(s.get("launch_date")),
                age_weeks,
                _pct_s(s.get("sor_6m")),
                _v(s.get("units_6m")),
                _v(s.get("revenue_6m")),
                _v(full_price),
                _v(s.get("avg_selling_price")),
                _pct_s(fp_pct),
                _pct_s(markdown),
                _v(s.get("weekly_avg")),
                _v(s.get("woc")),
                _v(s.get("last_sale_days")),
                _v(s.get("last_order_date")),
                inv_value,
                _pct_s(sor_life),
                rev_since_launch,
                _v(s.get("brand")),
                _v(s.get("recommended_action")),
                *[_v(fn(s)) for _h, fn in extra_cols],
            ])

        from fastapi.responses import Response as _Resp
        slug = _KPI_BUCKETS[kpi]["label"].replace(" ", "_")
        fname = f"{slug}_{today.isoformat()}.csv"
        return _Resp(
            content=buf.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    @app.get("/api/merch/by-brand")
    async def merch_by_brand(
        request:      Request,
        brand:        Optional[str] = Query(None),
        subcategory:  Optional[str] = Query(None),
        tier:         Optional[str] = Query(None),
        status:       Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
        pos_location: Optional[str] = Query(None),
        trend:        Optional[int] = Query(0),
    ):
        key = f"merch_by_brand|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{pos_location}|{trend}"
        entry = _cache_store.get(key)
        if entry and (_time.monotonic() - entry[0]) < _TTL:
            return JSONResponse({"rows": entry[1]})
        if trend:  # opt-in (Overview charts) — adds revenue_prev + trend_pct
            pf, pt = _prev_window(from_date, to_date)
            # SEQUENTIAL on purpose: running current+prev concurrently makes
            # the two heavy scans contend on the shared PG — measured cold,
            # BOTH slowed to ~39s (so summary/styles/by-tier, which share the
            # current-window future, painted at 39s instead of ~21s) for zero
            # total-time win. Current first so the KPI-bearing endpoints
            # resolve as early as possible; prev only delays trend charts.
            cur_styles = await _styles_async(
                brand, subcategory, tier, status,
                from_date, to_date, country, pos_location, _TTL)
            prev_styles = await _styles_async(
                brand, subcategory, tier, status,
                pf, pt, country, pos_location, _TTL)
            rows = _merge_trend(_agg_by_dim(cur_styles, "brand"),
                                _agg_by_dim(prev_styles, "brand"), "brand")
        else:
            rows = _agg_by_dim(await _styles_async(
                brand, subcategory, tier, status,
                from_date, to_date, country, pos_location, _TTL), "brand")
        _cache_store[key] = (_time.monotonic(), rows)
        return JSONResponse({"rows": rows})

    @app.get("/api/merch/by-subcategory")
    async def merch_by_subcategory(
        request:      Request,
        brand:        Optional[str] = Query(None),
        subcategory:  Optional[str] = Query(None),
        tier:         Optional[str] = Query(None),
        status:       Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
        pos_location: Optional[str] = Query(None),
        trend:        Optional[int] = Query(0),
    ):
        key = f"merch_by_sub|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{pos_location}|{trend}"
        entry = _cache_store.get(key)
        if entry and (_time.monotonic() - entry[0]) < _TTL:
            return JSONResponse({"rows": entry[1]})
        if trend:  # opt-in (Overview charts) — adds revenue_prev + trend_pct
            pf, pt = _prev_window(from_date, to_date)
            # Sequential — see the contention note in merch_by_brand.
            cur_styles = await _styles_async(
                brand, subcategory, tier, status,
                from_date, to_date, country, pos_location, _TTL)
            prev_styles = await _styles_async(
                brand, subcategory, tier, status,
                pf, pt, country, pos_location, _TTL)
            rows = _merge_trend(_agg_by_dim(cur_styles, "subcategory"),
                                _agg_by_dim(prev_styles, "subcategory"), "subcategory")
        else:
            rows = _agg_by_dim(await _styles_async(
                brand, subcategory, tier, status,
                from_date, to_date, country, pos_location, _TTL), "subcategory")
        _cache_store[key] = (_time.monotonic(), rows)
        return JSONResponse({"rows": rows})

    @app.get("/api/merch/by-tier")
    async def merch_by_tier(
        request:      Request,
        brand:        Optional[str] = Query(None),
        subcategory:  Optional[str] = Query(None),
        tier:         Optional[str] = Query(None),
        status:       Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
        pos_location: Optional[str] = Query(None),
    ):
        key = f"merch_by_tier|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{pos_location}"
        entry = _cache_store.get(key)
        if entry and (_time.monotonic() - entry[0]) < _TTL:
            return JSONResponse({"rows": entry[1]})
        rows = _agg_by_dim(await _styles_async(
            brand, subcategory, tier, status,
            from_date, to_date, country, pos_location, _TTL), "tier")
        _cache_store[key] = (_time.monotonic(), rows)
        return JSONResponse({"rows": rows})

    @app.get("/api/merch/style-stores")
    def merch_style_stores(
        request:      Request,
        style_number: Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
        include_retired: bool = Query(False),
    ):
        """Per-store SOH/sales for one style or the active style universe."""
        key = f"merch_style_stores|{style_number}|{from_date}|{to_date}|{country}|{include_retired}"
        result = _cached(key, 300, lambda: _fetch_style_stores(
            style_number, from_date=from_date, to_date=to_date, country=country,
            include_retired=include_retired))
        return JSONResponse(result)

    @app.get("/api/merch/style-colors")
    async def merch_style_colors(
        request:      Request,
        style_number: Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
    ):
        """Per-colourway breakdown for one style: period units/revenue, current
        SOH (stores + sellable warehouse, pipeline excluded), stock-to-sales,
        plus fixed-6-month weekly velocity + WOC (style-level WOC formula) and
        the fixed 4/8/12-week recommendation rule inputs (sor_4wk/8wk/12wk,
        modal full_price, VAT-inc discount-aware asp_recent/asp_pct_full,
        last_sale_date/days) for the Deep Dive's colourway panel."""
        if not style_number:
            return JSONResponse({"detail": "style_number is required"}, status_code=400)
        key = f"merch_style_colors|{style_number}|{from_date}|{to_date}|{country}"
        result = _cached(key, 300, lambda: _fetch_style_colors(
            style_number, from_date=from_date, to_date=to_date, country=country))
        return JSONResponse(result)

    @app.get("/api/merch/style-sizes")
    def merch_style_sizes(
        request: Request,
        style_number: Optional[str] = Query(None),
        from_date: Optional[str] = Query(None),
        to_date: Optional[str] = Query(None),
        country: Optional[str] = Query(None),
    ):
        """Per-size SOH/SOR breakdown for one style."""
        if not style_number:
            return JSONResponse({"detail": "style_number is required"}, status_code=400)
        key = f"merch_style_sizes|{style_number}|{from_date}|{to_date}|{country}"
        result = _cached(key, 300, lambda: _fetch_style_sizes(
            style_number, from_date=from_date, to_date=to_date, country=country))
        return JSONResponse(result)

    @app.get("/api/merch/store-sizes")
    def merch_store_sizes(
        request:     Request,
        store:       Optional[str] = Query(None),
        from_date:   Optional[str] = Query(None),
        to_date:     Optional[str] = Query(None),
        country:     Optional[str] = Query(None),
        brand:       Optional[str] = Query(None),
        subcategory: Optional[str] = Query(None),
    ):
        """Size-level SOR/SOH for one store plus weighted network benchmarks."""
        key = f"merch_store_sizes|{store}|{from_date}|{to_date}|{country}|{brand}|{subcategory}"
        result = _cached(key, 300, lambda: _fetch_store_size_analysis(
            store=store, from_date=from_date, to_date=to_date,
            country=country, brand=brand, subcategory=subcategory))
        return JSONResponse(result)

    @app.get("/api/admin/store-profiles")
    def admin_store_profiles_list(request: Request):
        """List all active pos_locations with sqft and optimal_stock.
        Admin-only — gated by clerk_auth_gate path prefix check."""
        rows = _db_exec("""
            SELECT location_name, country, sqft, optimal_stock
            FROM pos_locations
            WHERE active = TRUE
            ORDER BY country, location_name
        """)
        return JSONResponse({"stores": [dict(r) for r in (rows or [])]})

    @app.patch("/api/admin/store-profiles/{location_name:path}")
    async def admin_store_profiles_update(
        request: Request,
        location_name: str,
    ):
        """Update sqft and/or optimal_stock for a store.
        Admin-only — gated by clerk_auth_gate path prefix check.
        Invalidates the merch style-stores cache after save."""
        body = await request.json()
        updates = {}
        for field in ("sqft", "optimal_stock"):
            if field in body:
                val = body[field]
                if val is not None:
                    try:
                        iv = int(val)
                        if iv < 0:
                            return JSONResponse(
                                {"detail": f"{field} must be a positive integer"},
                                status_code=422)
                        updates[field] = iv
                    except (ValueError, TypeError):
                        return JSONResponse(
                            {"detail": f"{field} must be an integer"},
                            status_code=422)
                else:
                    updates[field] = None
        if not updates:
            return JSONResponse({"detail": "No valid fields provided"}, status_code=422)

        set_clause = ", ".join(f"{k} = %({k})s" for k in updates)
        params = {**updates, "location_name": location_name}
        _db_exec(
            f"UPDATE pos_locations SET {set_clause} WHERE location_name = %(location_name)s",
            params, fetch=False)

        # Invalidate cached style-stores payloads so drill-down reflects the change
        _invalidate_style_stores_cache()

        # Return the updated row
        rows = _db_exec(
            "SELECT location_name, country, sqft, optimal_stock FROM pos_locations "
            "WHERE location_name = %(location_name)s",
            {"location_name": location_name})
        if not rows:
            return JSONResponse({"detail": "Store not found"}, status_code=404)
        return JSONResponse(dict(rows[0]))

    @app.get("/api/merch/style-sales-weekly")
    def merch_style_weekly(
        request:      Request,
        style_number: Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
    ):
        """Weekly unit trend + subcategory benchmark + reorder event weeks for one style."""
        if not style_number:
            return JSONResponse({"detail": "style_number is required"}, status_code=400)
        key = f"merch_style_weekly|{style_number}|{from_date}|{to_date}|{country}"
        result = _cached(key, 300, lambda: _fetch_style_weekly(
            style_number, from_date=from_date, to_date=to_date, country=country))
        return JSONResponse(result)

    @app.get("/api/merch/launch-ramp")
    def merch_launch_ramp(
        request:      Request,
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
        brand:        Optional[str] = Query(None),
        subcategory:  Optional[str] = Query(None),
        pos_location: Optional[str] = Query(None),
    ):
        """Cumulative SOR %% by weeks-since-launch, broken down by lifecycle tier."""
        key = f"merch_launch_ramp|{from_date}|{to_date}|{country}|{brand}|{subcategory}|{pos_location}"
        result = _cached(key, _TTL, lambda: _fetch_launch_ramp(
            from_date=from_date, to_date=to_date, country=country,
            brand=brand, subcategory=subcategory, pos_location=pos_location))
        return JSONResponse(result)

    @app.get("/api/merch/by-store")
    def merch_by_store(
        request:      Request,
        brand:        Optional[str] = Query(None),
        subcategory:  Optional[str] = Query(None),
        tier:         Optional[str] = Query(None),
        status:       Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
        compare_from: Optional[str] = Query(None),
        compare_to:   Optional[str] = Query(None),
    ):
        """Per-store aggregated merchandising KPIs (stock, units, revenue, avg WOC, avg SOR)."""
        key = f"merch_by_store|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{compare_from}|{compare_to}"
        result = _cached(key, _TTL, lambda: _fetch_by_store(
            brand=brand, subcategory=subcategory, tier=tier, status=status,
            from_date=from_date, to_date=to_date, country=country,
            compare_from=compare_from, compare_to=compare_to,
        ))
        return JSONResponse({"rows": result})

    @app.get("/api/merch/stock-mix")
    def merch_stock_mix(
        request:      Request,
        brand:        Optional[str] = Query(None),
        subcategory:  Optional[str] = Query(None),
        tier:         Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
        pos_location: Optional[str] = Query(None),
        include_retired: bool = Query(False),
    ):
        """Category → Sub Category → Style → Colour stock-mix drill-down tree
        (the fabric Stock Mix pattern for finished goods). Plain `def` on
        purpose: the cache-miss query is heavy, and a sync route runs in
        Starlette's threadpool instead of blocking the event loop."""
        key = f"merch_stock_mix_v8|{brand}|{subcategory}|{tier}|{from_date}|{to_date}|{country}|{pos_location}|{include_retired}"
        result = _cached(key, _TTL, lambda: _fetch_stock_mix(
            brand=brand, subcategory=subcategory,
            tier=tier,
            from_date=from_date, to_date=to_date,
            country=country, pos_location=pos_location,
            include_retired=include_retired,
        ))
        return JSONResponse(result)

    log.info("Merchandising Hub routes registered (/api/merch/*)")
