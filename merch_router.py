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

Lifecycle tier is computed from status + is_noos + production_orders reorder count —
the same one-source model used in Product Analysis and Range Management — never from
the potentially-absent all_products_clean.tier column.

SQL correctness note: PostgreSQL rejects aggregate functions inside JOIN ON predicates.
All queries pre-compute style_number per style_name in a dedicated CTE (style_nums),
then join production_orders in a separate reorder_counts CTE so no aggregate ever
appears in a JOIN condition.

Registered via register_merch_routes(app, api_pg_module) from api_pg.py.
"""

import logging
import os
from datetime import date, timedelta
from typing import Optional

log = logging.getLogger("merch_router")

A = None  # api_pg module reference — set in register_merch_routes()

# ── Module-level TTL cache ─────────────────────────────────────────────────────

import time as _time
_cache_store = {}


def _cached(key, ttl, fn):
    now = _time.monotonic()
    entry = _cache_store.get(key)
    if entry and (now - entry[0]) < ttl:
        return entry[1]
    result = fn()
    _cache_store[key] = (now, result)
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


# ── Lifecycle tier — mirrors api_pg._lifecycle_tier logic ─────────────────────

def _compute_tier(is_noos, reorder_count, odoo_status=None):
    """Compute the unified lifecycle tier from Odoo status + flags + reorder history.

    Mirrors api_pg._lifecycle_tier exactly:
      Retired  = Odoo status field says Retired (hard retirement, checked first)
      Tier 1   = NOOS flag in Odoo (is_noos = TRUE)
      Tier 2   = ≥4 production buying orders (proven, established style)
      Tier 3   = ≥1 production buying orders (gaining traction)
      Tier 4   = no reorders yet (brand new or not yet reordered)

    `odoo_status` is the raw value from all_products_clean.status, compared
    case-insensitively to 'retired'.  When None / blank, the style is treated
    as Active (same as Product Analysis / Range Management).
    """
    if odoo_status and str(odoo_status).strip().lower() == "retired":
        return "Retired"
    if is_noos:
        return "Tier 1"
    rc = reorder_count or 0
    if rc >= 4:
        return "Tier 2"
    if rc >= 1:
        return "Tier 3"
    return "Tier 4"


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


def _fetch_styles(brand=None, subcategory=None, tier=None, status=None,
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
        /* Retirement rule: Active wins — style is Retired only when every
           SKU is Retired (mirrors api_pg._lifecycle_tier / _odoo_retired_styles). */
        CASE WHEN BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'retired')
                  AND NOT BOOL_OR(LOWER(COALESCE(p.status,'active')) = 'active')
             THEN 'Retired' ELSE 'Active' END             AS status,
        MIN(substring(p.style_launch_date,1,10))
            FILTER (WHERE substring(p.style_launch_date,1,10)
                    ~ '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}$')  AS launch_date,
        MAX(p.cost)                                        AS standard_cost_kes,
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
    WHERE {_PROD_BASE}{extra_prod_where}
    GROUP BY p.style_name, sn.style_number, rc.reorder_count, rc.last_order_date
),
stock AS (
    SELECT
        COALESCE(m.style_name, i.style_name) AS style_name,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
            {pos_store_clause}
        ), 0) AS soh_stores,
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
            AND s.total_sales_kes::numeric >= COALESCE(
                (SELECT mode() WITHIN GROUP (ORDER BY price)
                    FILTER (WHERE price > 0)
                 FROM all_products_clean pp WHERE pp.sku = s.variant_sku), 0
            ) * 0.95
        )                                              AS units_full_price
    FROM all_sales s
    JOIN all_products_clean p2 ON p2.sku = s.variant_sku
        AND p2.style_name IS NOT NULL AND p2.style_name <> ''
        AND COALESCE(p2.brand,'') NOT ILIKE '%%third party%%'
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
        SUM({_NET_SALES_EXPR})                         AS revenue_period
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
/* Manual tier/status overrides loaded from the import spreadsheet.
   A row here wins over the computed _compute_tier() result. */
tier_overrides AS (
    SELECT style_number, tier AS ov_tier, status AS ov_status
    FROM style_tier_overrides
    WHERE style_number IS NOT NULL AND style_number <> ''
)
SELECT
    p.style_name,
    p.style_number,
    p.brand,
    p.subcategory,
    p.status,
    p.launch_date,
    p.standard_cost_kes,
    p.last_order_date,
    p.full_price,
    p.is_noos,
    p.reorder_count,
    p.colour_count,
    COALESCE(st.soh_stores,    0) AS soh_stores,
    COALESCE(st.soh_warehouse, 0) AS soh_warehouse,
    COALESCE(s6.units_6m,    0)   AS units_6m,
    COALESCE(s6.revenue_6m,  0.0) AS revenue_6m,
    COALESCE(s6.orders_6m,   0)   AS orders_6m,
    COALESCE(s6.units_full_price, 0) AS units_full_price,
    s6.last_sale_date,
    COALESCE(sp.units_period,   0)   AS units_period,
    COALESCE(sp.revenue_period, 0.0) AS revenue_period,
    COALESCE(sl.units_life,     0)   AS units_life,
    COALESCE(sl.revenue_life,   0.0) AS revenue_life,
    tov.ov_tier,
    tov.ov_status
FROM prod p
LEFT JOIN stock          st  ON st.style_name   = p.style_name
LEFT JOIN sales_6m       s6  ON s6.style_name   = p.style_name
LEFT JOIN sales_period   sp  ON sp.style_name   = p.style_name
LEFT JOIN sales_life     sl  ON sl.style_name   = p.style_name
LEFT JOIN tier_overrides tov ON tov.style_number = p.style_number
ORDER BY revenue_6m DESC NULLS LAST
"""
    raw = _db_exec(sql, params, fetch=True)
    today_dt = today

    # Post-process: compute tier in Python, then apply tier filter
    result = []
    tier_filter = set(t.strip() for t in tier.split(",") if t.strip()) if tier else None

    for r in raw:
        odoo_status   = r.get("status") or "active"
        is_noos       = bool(r.get("is_noos"))
        reorder_count = int(r.get("reorder_count") or 0)
        # Manual override wins when present (loaded from style_tier_overrides).
        ov_tier   = r.get("ov_tier")
        ov_status = r.get("ov_status")
        if ov_tier:
            computed_tier = ov_tier
            if ov_status:
                odoo_status = ov_status
        else:
            # _compute_tier mirrors api_pg._lifecycle_tier: Retired beats NOOS beats reorders
            computed_tier = _compute_tier(is_noos, reorder_count, odoo_status=odoo_status)

        # Apply tier filter in Python (never relies on DB column)
        if tier_filter and computed_tier not in tier_filter:
            continue

        units_6m         = int(r["units_6m"] or 0)
        revenue_6m       = float(r["revenue_6m"] or 0)
        units_life       = int(r["units_life"] or 0)
        revenue_life     = float(r["revenue_life"] or 0)
        units_period     = int(r["units_period"] or 0)
        revenue_period   = float(r["revenue_period"] or 0)
        soh_stores       = int(r["soh_stores"] or 0)
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
            "tier":                computed_tier,
            "odoo_status":         odoo_status,
            "launch_date":         str(r["launch_date"]) if r.get("launch_date") else None,
            "last_order_date":     str(r["last_order_date"]) if r.get("last_order_date") else None,
            "standard_cost_kes":   cost,
            "full_price":          float(r["full_price"]) if r.get("full_price") else None,
            "is_noos":             is_noos,
            "reorder_count":       reorder_count,
            "colour_count":        int(r.get("colour_count") or 0),
            "soh_stores":          soh_stores,
            "soh_warehouse":       soh_warehouse,
            "current_stock":       current_stock,
            "units_6m":            units_6m,
            "revenue_6m":          round(revenue_6m, 0),
            "orders_6m":           int(r["orders_6m"] or 0),
            "units_period":        units_period,
            "revenue_period":      round(revenue_period, 0),
            "units_life":          units_life,
            "revenue_life":        round(revenue_life, 0),
            "weekly_avg":          weekly_avg,
            "woc":                 woc,
            "sor_6m":              sor_6m,
            "sor_period":          sor_period,
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


# ── Summary aggregates ─────────────────────────────────────────────────────────

# ── Shared KPI bucket membership ─────────────────────────────────────────────
# Single source of truth for which styles sit behind each Inventory & Stock
# Health KPI card. _compute_summary consumes these predicates for its counts
# and the CSV export endpoint reuses them, so card counts and export rows can
# never diverge.
_ACTIVE_TIERS = ("Tier 1", "Tier 2", "Tier 3", "Tier 4")


def _kpi_dedup_key(s):
    """Dedup by style_number, falling back to style_name when blank —
    mirrors Range Management's _dedup_raw_by_style_number()."""
    snum = (s.get("style_number") or "").strip()
    return snum if snum else s.get("style_name", "")


def _is_active_tier(s):
    return (s.get("tier") or "Tier 4") in _ACTIVE_TIERS


def _is_retired_tier(s):
    return (s.get("tier") or "Tier 4") == "Retired"


def _has_stock(s):
    return (s.get("current_stock") or 0) > 0


def _has_any_stock(s):
    """Stores-or-warehouse stock — the Active-universe gate _compute_summary
    uses (mirrors RM; can differ from current_stock for warehouse-only rows)."""
    return (s.get("soh_stores") or 0) > 0 or (s.get("soh_warehouse") or 0) > 0


def _is_archived_tier(s):
    return (s.get("tier") or "Tier 4") == "Archived"


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
        "pred":  lambda s: (_is_active_tier(s) and _has_stock(s)
                            and s.get("woc") is not None and s["woc"] > 20),
    },
    "woc_lt3": {
        "label": "Styles WOC under 3",
        "dedup": True,
        "pred":  lambda s: (_is_active_tier(s) and _has_stock(s)
                            and s.get("woc") is not None and s["woc"] < 3),
    },
    "no_sale_7d": {
        "label": "Active No Sale 7d plus",
        "dedup": True,
        "pred":  lambda s: (_is_active_tier(s) and _has_stock(s)
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
    "active_styles": {
        "label": "Active Style Lines",
        "dedup": True,
        "pred":  lambda s: _is_active_tier(s) and _has_any_stock(s),
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
        "pred":  lambda s: _is_active_tier(s) and _has_any_stock(s),
        # style-grain rows; this column sums to the card's style×colour count
        "extra": [("Colours (per style)", lambda s: s.get("colour_count"))],
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
        "pred":  lambda s: s.get("action_status") == "on_track",
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


def _compute_summary(styles):
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
    retired_styles = 0; retired_stock_units = 0
    archived_styles = 0; archived_stock_units = 0
    warehouse_stock = 0
    # Dedup counts by style_number — mirrors Range Management's
    # _dedup_raw_by_style_number(). Falls back to style_name when blank.
    _seen_active_keys:   set = set()
    _seen_retired_keys:  set = set()
    _seen_archived_keys: set = set()

    for s in styles:
        st = s["action_status"]
        if st == "on_track":    on_track += 1
        elif st == "at_risk":   at_risk  += 1
        elif st == "overdue":   overdue  += 1

        total_stock     += s["current_stock"] or 0
        revenue_6m      += s["revenue_6m"] or 0
        units_6m        += s["units_6m"] or 0
        revenue_period  += s.get("revenue_period") or 0
        units_period    += s.get("units_period") or 0
        warehouse_stock += s.get("soh_warehouse") or 0

        tier        = s.get("tier") or "Tier 4"
        has_stock   = (s.get("soh_stores") or 0) > 0 or (s.get("soh_warehouse") or 0) > 0
        current_stk = s.get("current_stock") or 0
        snum        = (s.get("style_number") or "").strip()
        dedup_key   = snum if snum else s.get("style_name", "")

        if tier in ("Tier 1", "Tier 2", "Tier 3", "Tier 4"):
            # Active styles: only count those with physical stock (mirrors RM universe)
            if has_stock and dedup_key not in _seen_active_keys:
                _seen_active_keys.add(dedup_key)
                active_styles        += 1
                active_colour_styles += s.get("colour_count") or 0
                active_stock_units   += current_stk
        elif tier == "Retired":
            if dedup_key not in _seen_retired_keys:
                _seen_retired_keys.add(dedup_key)
                retired_styles      += 1
                retired_stock_units += current_stk
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
    return {
        "total_styles":                 len(styles),
        "active_styles_count":          active_styles,
        "active_colour_styles_count":   active_colour_styles,
        "active_stock_units":           active_stock_units,
        "retired_styles_count":         retired_styles,
        "retired_stock_units":          retired_stock_units,
        "archived_styles_count":        archived_styles,
        "archived_stock_units":         archived_stock_units,
        "warehouse_stock_units":        warehouse_stock,
        "on_track_count":               on_track,
        "at_risk_count":                at_risk,
        "overdue_count":                overdue,
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


def _empty_summary():
    return {k: None for k in [
        "total_styles", "active_styles_count", "active_colour_styles_count",
        "active_stock_units", "retired_styles_count", "retired_stock_units",
        "archived_styles_count", "archived_stock_units",
        "warehouse_stock_units",
        "on_track_count", "at_risk_count", "overdue_count",
        "total_stock_units", "revenue_6m", "units_6m", "revenue_period", "units_period", "weekly_velocity",
        "woc_lt3_active_count", "no_sale_7d_active_count",
        "avg_woc", "avg_full_price_pct", "avg_sor_6m", "zero_stock_count",
        "no_sale_30d_count", "woc_lt4_count", "woc_gt20_count",
        "styles_launched_current_year", "styles_launched_prior_year",
        "avg_gross_margin_pct", "total_cogs_6m_kes", "total_gross_margin_kes",
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
            }
        b = buckets[key]
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
    (ttl mirrors the handlers' _TTL), so the prev-window rows fetched for chart
    trends are shared between by-brand and by-subcategory instead of running
    the heavy query twice."""
    key = f"merch_styles|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{pos_location}"
    return _cached(key, ttl, lambda: _fetch_styles(
        brand=brand, subcategory=subcategory, tier=tier, status=status,
        from_date=from_date, to_date=to_date, country=country,
        pos_location=pos_location))


# ── Style-stores endpoint ──────────────────────────────────────────────────────

def _invalidate_style_stores_cache():
    """Remove all merch_style_stores|* entries from the module-level cache."""
    prefix = "merch_style_stores|"
    stale = [k for k in list(_cache_store.keys()) if k.startswith(prefix)]
    for k in stale:
        _cache_store.pop(k, None)


def _fetch_style_stores(style_number, from_date=None, to_date=None, country=None):
    """Per-store breakdown for one style, with store tier (A/B/C) and transfer plan.

    Store tier = NTILE-3 by trailing-90d net revenue (A = top third), mirroring
    api_pg._store_cluster_map.  Computed in SQL so the result is consistent with
    the store cluster visuals in the rest of the dashboard.
    """
    today       = date.today()
    six_mo_ago  = str(today - timedelta(days=_SIX_MONTHS_DAYS))
    today_str   = str(today)
    period_from = from_date or six_mo_ago
    period_to   = to_date   or today_str

    # Country filter for sales CTEs
    country_clause = ""
    country_params = {}
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            country_params["countries"] = cl
            country_clause = " AND s.country = ANY(%(countries)s)"

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
style_meta AS (
    SELECT
        mode() WITHIN GROUP (ORDER BY cost)
            FILTER (WHERE cost IS NOT NULL) AS cost_kes
    FROM all_products_clean
    WHERE style_number = %(style_number)s
),
stock AS (
    SELECT
        i.pos_location_name     AS store,
        SUM(i.available)        AS current_stock
    FROM all_inventory i
    JOIN all_products_clean p ON p.sku = i.sku
        AND p.style_number = %(style_number)s
    WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
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
        AND p.style_number = %(style_number)s
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
        AND {_BASE_FILTERS}
        {country_clause}
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

    return {"stores": result, "donors": donors, "recipients": recipients}


# ── Style weekly timeline ──────────────────────────────────────────────────────

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
        ls.odoo_status,
        ls.is_noos,
        ls.reorder_count,
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
    odoo_status,
    is_noos,
    reorder_count,
    FLOOR(weeks_since_launch)::int AS week_n,
    AVG(
        cumulative_units * 100.0
        / NULLIF(cumulative_units + COALESCE(current_stock, 0), 0)
    )                              AS avg_cumulative_sor_pct
FROM cumulative
WHERE weeks_since_launch BETWEEN 0 AND 51
GROUP BY 1, 2, 3, 4
ORDER BY 4
"""
    params = {"two_years_ago": period_from, "today": period_to, **country_params}
    rows = _db_exec(sql, params, fetch=True)

    # Compute tier in Python (mirrors _lifecycle_tier including Retired check)
    agg = {}
    for r in rows:
        t = _compute_tier(
            bool(r["is_noos"]),
            int(r["reorder_count"] or 0),
            odoo_status=r.get("odoo_status"),
        )
        wk  = int(r["week_n"] or 0)
        sor = float(r["avg_cumulative_sor_pct"]) if r.get("avg_cumulative_sor_pct") is not None else None
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

def _fetch_stock_mix(brand=None, subcategory=None, from_date=None, to_date=None,
                     country=None, pos_location=None):
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

    Dims come from the product master only: category = p.category,
    subcategory = p.product_type, colour = per-SKU mode of p.color_print
    (NEVER all_inventory's colour column). A style resolves to exactly ONE
    category/subcategory via mode() of its SKU dims, so it never splits
    across branches.
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

    # Same predicates as _fetch_styles' stock CTE. When a POS location filter
    # is active, warehouse stock doesn't belong to that store → forced to 0.
    stores_pred = f"i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS}){pos_store_clause}"
    wh_pred = "FALSE" if pos_has_filter else "i.pos_location_name = 'Warehouse Finished Goods'"
    soh_warehouse_expr = (
        "0" if pos_has_filter else
        f"COALESCE(SUM(i.available) FILTER (WHERE {wh_pred}), 0)"
    )

    sql = f"""
WITH
/* Style universe + one canonical category/subcategory per style (mode of its
   SKU dims over the SAME filtered rowset _fetch_styles' prod CTE uses, so a
   spot-check against /api/merch/by-subcategory buckets identically). */
prod AS (
    SELECT
        p.style_name,
        mode() WITHIN GROUP (ORDER BY p.style_number)  AS style_number,
        mode() WITHIN GROUP (ORDER BY p.category)      AS category,
        mode() WITHIN GROUP (ORDER BY p.product_type)  AS subcategory
    FROM all_products_clean p
    WHERE {_PROD_BASE}{extra_prod_where}
    GROUP BY p.style_name
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
        BOOL_OR(COALESCE(brand,'') ILIKE '%%third party%%') AS is_third_party
    FROM all_products_clean
    WHERE style_name IS NOT NULL
    GROUP BY sku
),
/* Stock at (style, colour) grain — pre-aggregated on its own (never join
   inventory to sales then SUM). Same row scope + filters as the KPI's stock
   CTE; stock value = available × per-SKU cost over the SAME rows. */
stock AS (
    SELECT
        COALESCE(m.style_name, i.style_name)  AS style_name,
        COALESCE(m.colour, '')                AS colour,
        COALESCE(SUM(i.available) FILTER (WHERE {stores_pred}), 0) AS soh_stores,
        {soh_warehouse_expr} AS soh_warehouse,
        COALESCE(SUM(i.available * COALESCE(m.cost, 0)) FILTER (
            WHERE ({stores_pred}) OR {wh_pred}), 0)                AS stock_value,
        COUNT(DISTINCT i.sku) FILTER (
            WHERE (({stores_pred}) OR {wh_pred})
              AND i.available > 0)                                 AS skus_in_stock
    FROM all_inventory i
    LEFT JOIN msku m ON m.sku = i.sku{country_inv_where}
    GROUP BY 1, 2
),
/* Period sales at (style, colour) grain — gross units canon
   (ordered_item_quantity, sale_kind IN ('sale','order')). */
sales_period AS (
    SELECT
        m.style_name,
        COALESCE(m.colour, '') AS colour,
        COALESCE(SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')), 0)             AS units_period,
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
    g.colour,
    COALESCE(st.soh_stores, 0) + COALESCE(st.soh_warehouse, 0) AS stock_units,
    COALESCE(st.stock_value, 0)    AS stock_value,
    COALESCE(st.skus_in_stock, 0)  AS skus_in_stock,
    COALESCE(sp.units_period, 0)   AS units_period,
    COALESCE(sp.skus_sold, 0)      AS skus_sold,
    COALESCE(s6.units_6m, 0)       AS units_6m
FROM grain g
JOIN prod p               ON p.style_name  = g.style_name
LEFT JOIN stock st        ON st.style_name = g.style_name AND st.colour = g.colour
LEFT JOIN sales_period sp ON sp.style_name = g.style_name AND sp.colour = g.colour
LEFT JOIN sales_6m s6     ON s6.style_name = g.style_name AND s6.colour = g.colour
"""
    raw = _db_exec(sql, params, fetch=True)

    # ── Assemble the nested tree ──────────────────────────────────────────────
    cats = {}
    tot_su = 0; tot_sv = 0.0; tot_up = 0

    def _bucket(store, name, child_key):
        node = store.get(name)
        if node is None:
            node = {"name": name, "stock_units": 0, "stock_value": 0.0,
                    "units_period": 0, "_u6": 0, child_key: {}}
            store[name] = node
        return node

    for r in raw:
        su = int(r.get("stock_units") or 0)
        sv = float(r.get("stock_value") or 0)
        up = int(r.get("units_period") or 0)
        u6 = int(r.get("units_6m") or 0)
        cat_name = r.get("category") or "Uncategorised"
        sub_name = r.get("subcategory") or "Uncategorised"
        sty_name = r.get("style_name")
        col_name = r.get("colour") or "Unspecified"

        tot_su += su; tot_sv += sv; tot_up += up

        c  = _bucket(cats, cat_name, "subcategories")
        sb = _bucket(c["subcategories"], sub_name, "styles")
        st = _bucket(sb["styles"], sty_name, "colours")
        if "style_number" not in st:
            st["style_number"] = r.get("style_number")
        col = st["colours"].get(col_name)
        if col is None:
            col = {"name": col_name, "stock_units": 0, "stock_value": 0.0,
                   "units_period": 0, "_u6": 0, "skus_in_stock": 0, "skus_sold": 0}
            st["colours"][col_name] = col
        for node in (c, sb, st, col):
            node["stock_units"]  += su
            node["stock_value"]  += sv
            node["units_period"] += up
            node["_u6"]          += u6
        col["skus_in_stock"] += int(r.get("skus_in_stock") or 0)
        col["skus_sold"]     += int(r.get("skus_sold") or 0)

    # Only nodes with stock or period sales are shown. Pruned nodes carry 0
    # stock and 0 period units, so grand totals (and KPI reconciliation) are
    # unaffected; parents keep the pruned leaves' units_6m in their WOC
    # denominator (matching the tab's style-level WOC semantics).
    def _keep(n):
        return (n["stock_units"] != 0 or n["units_period"] != 0
                or abs(n["stock_value"]) >= 0.5)

    counts = {"categories": 0, "subcategories": 0, "styles": 0, "colours": 0}

    def _finish(node):
        u6 = node.pop("_u6", 0)
        node["stock_value"] = round(node["stock_value"])
        node["woc"] = round(node["stock_units"] / (u6 / 26.0), 1) if u6 > 0 else None

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

    return {
        "categories": _sorted(cat_list),
        "totals": {
            "stock_units":  tot_su,
            "stock_value":  round(tot_sv),
            "units_period": tot_up,
        },
        "period": {"from": period_from, "to": period_to},
        "counts": counts,
    }


def register_merch_routes(app, api_pg_module):
    global A
    A = api_pg_module

    from fastapi import Request, Query
    from fastapi.responses import JSONResponse

    _TTL = 600  # seconds

    # Ensure the tier-overrides table exists on first registration.
    _ensure_tier_overrides_table()

    @app.get("/api/merch/filter-options")
    async def merch_filter_options(request: Request):
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
        key = f"merch_styles|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{pos_location}"
        result = _cached(key, _TTL, lambda: _fetch_styles(
            brand=brand, subcategory=subcategory, tier=tier, status=status,
            from_date=from_date, to_date=to_date, country=country, pos_location=pos_location,
        ))
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
        result = _cached(key, _TTL, lambda: _compute_summary(
            _fetch_styles(brand=brand, subcategory=subcategory, tier=tier, status=status,
                          from_date=from_date, to_date=to_date, country=country,
                          pos_location=pos_location)
        ))
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
        (22 cols) plus optional per-KPI extra columns.
        Reuses the cached _fetch_styles rows + the shared _KPI_BUCKETS
        predicates so the file always matches the on-card count."""
        if kpi not in _KPI_BUCKETS:
            return JSONResponse({"detail": f"Unknown kpi '{kpi}'"}, status_code=400)

        key = f"merch_styles|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{pos_location}"
        styles = _cached(key, _TTL, lambda: _fetch_styles(
            brand=brand, subcategory=subcategory, tier=tier, status=status,
            from_date=from_date, to_date=to_date, country=country, pos_location=pos_location,
        ))
        rows = _kpi_bucket_rows(styles, kpi)

        import csv as _csv
        import io as _io
        headers = [
            "Style Name", "Subcategory", "Style Number", "Tier", "SOH",
            "Launch Date", "Age (Weeks)", "6m SOR", "6m Units Sold", "6m Rev",
            "Full Price (Kes)", "ASP (6m)", "% Full Price", "Mark Down",
            "Weekly Units Sold", "6m WOC", "Last Sale (days)", "Last Order Date",
            "Inventory Value (at Full Price)", "SOR Since Launch %", "Brand",
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
            markdown = round(100 - fp_pct, 1) if fp_pct is not None else ""
            full_price = s.get("full_price")
            soh = s.get("current_stock") or 0
            inv_value = round(soh * full_price) if full_price is not None else ""
            # SOR Since Launch — same gross-units basis as the tab's 6m SOR
            units_life = s.get("units_life") or 0
            sl_denom = units_life + soh
            sor_life = round(units_life * 100.0 / sl_denom, 1) if sl_denom > 0 else ""
            def _v(x):
                return "" if x is None else x
            w.writerow([
                _v(s.get("style_name")),
                _v(s.get("subcategory")),
                _v(s.get("style_number")),
                _v(s.get("tier")),
                soh,
                _v(s.get("launch_date")),
                age_weeks,
                _v(s.get("sor_6m")),
                _v(s.get("units_6m")),
                _v(s.get("revenue_6m")),
                _v(full_price),
                _v(s.get("avg_selling_price")),
                _v(fp_pct),
                markdown,
                _v(s.get("weekly_avg")),
                _v(s.get("woc")),
                _v(s.get("last_sale_days")),
                _v(s.get("last_order_date")),
                inv_value,
                sor_life,
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

        def _build():
            rows = _agg_by_dim(
                _fetch_styles(brand=brand, subcategory=subcategory, tier=tier, status=status,
                              from_date=from_date, to_date=to_date, country=country,
                              pos_location=pos_location),
                "brand",
            )
            if trend:  # opt-in (Overview charts) — adds revenue_prev + trend_pct
                pf, pt = _prev_window(from_date, to_date)
                rows = _merge_trend(rows, _agg_by_dim(
                    _styles_cached(brand=brand, subcategory=subcategory, tier=tier,
                                   status=status, from_date=pf, to_date=pt,
                                   country=country, pos_location=pos_location),
                    "brand",
                ), "brand")
            return rows

        result = _cached(key, _TTL, _build)
        return JSONResponse({"rows": result})

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

        def _build():
            rows = _agg_by_dim(
                _fetch_styles(brand=brand, subcategory=subcategory, tier=tier, status=status,
                              from_date=from_date, to_date=to_date, country=country,
                              pos_location=pos_location),
                "subcategory",
            )
            if trend:  # opt-in (Overview charts) — adds revenue_prev + trend_pct
                pf, pt = _prev_window(from_date, to_date)
                rows = _merge_trend(rows, _agg_by_dim(
                    _styles_cached(brand=brand, subcategory=subcategory, tier=tier,
                                   status=status, from_date=pf, to_date=pt,
                                   country=country, pos_location=pos_location),
                    "subcategory",
                ), "subcategory")
            return rows

        result = _cached(key, _TTL, _build)
        return JSONResponse({"rows": result})

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
        result = _cached(key, _TTL, lambda: _agg_by_dim(
            _fetch_styles(brand=brand, subcategory=subcategory, tier=tier, status=status,
                          from_date=from_date, to_date=to_date, country=country,
                          pos_location=pos_location),
            "tier",
        ))
        return JSONResponse({"rows": result})

    @app.get("/api/merch/style-stores")
    async def merch_style_stores(
        request:      Request,
        style_number: Optional[str] = Query(None),
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
    ):
        """Per-store breakdown for one style including store tier (A/B/C) and transfer plan."""
        if not style_number:
            return JSONResponse({"detail": "style_number is required"}, status_code=400)
        key = f"merch_style_stores|{style_number}|{from_date}|{to_date}|{country}"
        result = _cached(key, 300, lambda: _fetch_style_stores(
            style_number, from_date=from_date, to_date=to_date, country=country))
        return JSONResponse(result)

    @app.get("/api/admin/store-profiles")
    async def admin_store_profiles_list(request: Request):
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
    async def merch_style_weekly(
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
    async def merch_launch_ramp(
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
    async def merch_by_store(
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
        from_date:    Optional[str] = Query(None),
        to_date:      Optional[str] = Query(None),
        country:      Optional[str] = Query(None),
        pos_location: Optional[str] = Query(None),
    ):
        """Category → Sub Category → Style → Colour stock-mix drill-down tree
        (the fabric Stock Mix pattern for finished goods). Plain `def` on
        purpose: the cache-miss query is heavy, and a sync route runs in
        Starlette's threadpool instead of blocking the event loop."""
        key = f"merch_stock_mix|{brand}|{subcategory}|{from_date}|{to_date}|{country}|{pos_location}"
        result = _cached(key, _TTL, lambda: _fetch_stock_mix(
            brand=brand, subcategory=subcategory,
            from_date=from_date, to_date=to_date,
            country=country, pos_location=pos_location,
        ))
        return JSONResponse(result)

    log.info("Merchandising Hub routes registered (/api/merch/*)")
