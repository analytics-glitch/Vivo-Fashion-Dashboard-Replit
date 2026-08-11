"""
Merchandising Hub Router — /api/merch/*

Provides all backend data for the 12-tab Merchandising Hub:
  GET /api/merch/styles          — full style universe (one row per style)
  GET /api/merch/summary         — portfolio-level aggregates
  GET /api/merch/by-brand        — aggregates broken down by brand
  GET /api/merch/by-subcategory  — aggregates broken down by subcategory
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
    if country:
        cl = [c.strip() for c in country.split(",") if c.strip()]
        if cl:
            params["countries"] = cl
            country_clause = " AND s.country = ANY(%(countries)s)"

    # POS location filter — narrows store stock and sales to specific locations
    pos_store_clause = ""  # applied to the stock CTE's soh_stores FILTER
    pos_sales_clause = ""  # applied to every sales CTE WHERE
    if pos_location:
        pl = [p.strip() for p in pos_location.split(",") if p.strip()]
        if pl:
            params["pos_locations"] = pl
            pos_store_clause = " AND i.pos_location_name = ANY(%(pos_locations)s)"
            pos_sales_clause = " AND s.pos_location_name = ANY(%(pos_locations)s)"

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
        COUNT(DISTINCT po.order_ref) AS reorder_count
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
        NULL::date                                         AS last_order_date,
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
    GROUP BY p.style_name, sn.style_number, rc.reorder_count
),
stock AS (
    SELECT
        COALESCE(m.style_name, i.style_name) AS style_name,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
            {pos_store_clause}
        ), 0) AS soh_stores,
        COALESCE(SUM(i.available) FILTER (
            WHERE i.pos_location_name = 'Warehouse Finished Goods'
        ), 0) AS soh_warehouse
    FROM all_inventory i
    LEFT JOIN (
        SELECT DISTINCT sku,
            mode() WITHIN GROUP (ORDER BY style_name) AS style_name
        FROM all_products_clean
        WHERE style_name IS NOT NULL
        GROUP BY sku
    ) m ON m.sku = i.sku
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
    COALESCE(sl.revenue_life,   0.0) AS revenue_life
FROM prod p
LEFT JOIN stock        st ON st.style_name = p.style_name
LEFT JOIN sales_6m     s6 ON s6.style_name = p.style_name
LEFT JOIN sales_period sp ON sp.style_name = p.style_name
LEFT JOIN sales_life   sl ON sl.style_name = p.style_name
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

def _compute_summary(styles):
    if not styles:
        return _empty_summary()
    today = date.today()
    on_track = at_risk = overdue = 0
    total_stock = revenue_6m = units_6m = 0
    zero_stock = no_sale_30d = woc_lt4 = woc_gt20 = 0
    launched_current = launched_prior = 0
    woc_vals = []; fp_vals = []; sor_vals = []; gm_pct_vals = []
    total_cogs = 0.0; total_gm = 0.0
    active_styles = 0; active_colour_styles = 0; warehouse_stock = 0

    for s in styles:
        st = s["action_status"]
        if st == "on_track":    on_track += 1
        elif st == "at_risk":   at_risk  += 1
        elif st == "overdue":   overdue  += 1

        total_stock  += s["current_stock"] or 0
        revenue_6m   += s["revenue_6m"] or 0
        units_6m     += s["units_6m"] or 0
        warehouse_stock += s.get("soh_warehouse") or 0

        is_active = (s.get("odoo_status") or "active").lower() != "retired"
        if is_active:
            active_styles += 1
            active_colour_styles += s.get("colour_count") or 0

        if (s["current_stock"] or 0) == 0:   zero_stock  += 1
        if s["last_sale_days"] is not None and s["last_sale_days"] >= 30: no_sale_30d += 1
        if s["woc"] is not None:
            woc_vals.append(s["woc"])
            if s["woc"] < 4:  woc_lt4  += 1
            if s["woc"] > 20: woc_gt20 += 1
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
        "warehouse_stock_units":        warehouse_stock,
        "on_track_count":               on_track,
        "at_risk_count":                at_risk,
        "overdue_count":                overdue,
        "total_stock_units":            total_stock,
        "revenue_6m":                   round(revenue_6m, 0),
        "units_6m":                     units_6m,
        "weekly_velocity":              round(units_6m / 26.0, 1) if units_6m else 0,
        "avg_woc":                      _avg(woc_vals),
        "avg_full_price_pct":           _avg(fp_vals),
        "avg_sor_6m":                   _avg(sor_vals),
        "zero_stock_count":             zero_stock,
        "no_sale_30d_count":            no_sale_30d,
        "woc_lt4_count":                woc_lt4,
        "woc_gt20_count":               woc_gt20,
        "styles_launched_current_year": launched_current,
        "styles_launched_prior_year":   launched_prior,
        "avg_gross_margin_pct":         _avg(gm_pct_vals),
        "total_cogs_6m_kes":            round(total_cogs, 0) if total_cogs else None,
        "total_gross_margin_kes":       round(total_gm, 0)   if total_gm   else None,
    }


def _empty_summary():
    return {k: None for k in [
        "total_styles", "active_styles_count", "active_colour_styles_count",
        "warehouse_stock_units",
        "on_track_count", "at_risk_count", "overdue_count",
        "total_stock_units", "revenue_6m", "units_6m", "weekly_velocity",
        "avg_woc", "avg_full_price_pct", "avg_sor_6m", "zero_stock_count",
        "no_sale_30d_count", "woc_lt4_count", "woc_gt20_count",
        "styles_launched_current_year", "styles_launched_prior_year",
        "avg_gross_margin_pct", "total_cogs_6m_kes", "total_gross_margin_kes",
    ]}


# ── Dimension aggregation ──────────────────────────────────────────────────────

def _agg_by_dim(styles, dim_key):
    buckets = {}
    for s in styles:
        key = s.get(dim_key) or "—"
        if key not in buckets:
            buckets[key] = {
                dim_key: key, "style_count": 0, "units_6m": 0,
                "revenue_6m": 0.0, "current_stock": 0,
                "_woc": [], "_sor": [], "_fp": [], "_gm": [],
                "total_cogs": 0.0, "_has_cogs": False, "total_gm": 0.0,
            }
        b = buckets[key]
        b["style_count"]   += 1
        b["units_6m"]      += s["units_6m"] or 0
        b["revenue_6m"]    += s["revenue_6m"] or 0
        b["current_stock"] += s["current_stock"] or 0
        if s["woc"] is not None:              b["_woc"].append(s["woc"])
        if s["sor_6m"] is not None:           b["_sor"].append(s["sor_6m"])
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
            "current_stock":           b["current_stock"],
            "avg_woc":                 _avg(b["_woc"]),
            "avg_sor_6m":              _avg(b["_sor"]),
            "avg_full_price_pct":      _avg(b["_fp"]),
            "avg_gross_margin_pct":    _avg(b["_gm"]),
            "total_cogs_6m_kes":       round(b["total_cogs"], 0) if b["_has_cogs"] else None,
            "total_gross_margin_kes":  round(b["total_gm"], 0)   if b["_has_cogs"] else None,
        })
    result.sort(key=lambda x: x["revenue_6m"] or 0, reverse=True)
    return result


# ── Style-stores endpoint ──────────────────────────────────────────────────────

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
)
SELECT
    COALESCE(st.store, sa.store)   AS store,
    COALESCE(st.current_stock, 0)  AS current_stock,
    COALESCE(sa.units_6m, 0)       AS units_6m,
    COALESCE(sa.revenue_6m, 0.0)   AS revenue_6m,
    COALESCE(t.store_tier, '—')    AS store_tier,
    sm.cost_kes
FROM stock st
FULL OUTER JOIN sales sa ON sa.store = st.store
LEFT  JOIN store_tiers t  ON t.store  = COALESCE(st.store, sa.store)
CROSS JOIN style_meta sm
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

        weekly_avg = round(units_6m / 26.0, 2) if units_6m else 0
        woc = round(current_stock / weekly_avg, 1) if weekly_avg > 0 else None
        ros = weekly_avg

        gm_contrib = None
        if cost is not None and units_6m > 0 and revenue_6m > 0:
            avg_asp = revenue_6m / units_6m
            if avg_asp > 0:
                gm_contrib = round((avg_asp - cost) * units_6m)

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

def _fetch_launch_ramp(from_date=None, to_date=None, country=None):
    """Cumulative SOR % by weeks-since-launch, broken down by lifecycle tier.

    Like _fetch_styles, this pre-computes style_number per style_name so that
    production_orders can be joined without aggregate functions in ON clauses.
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
                    from_date=None, to_date=None, country=None):
    """Per-store aggregated KPIs for the Store Detail tab.

    Aggregates all_sales + all_inventory by pos_location_name, excluding
    warehouse/internal locations.  Store tier (A/B/C) computed from trailing-90d
    net revenue via NTILE(3), consistent with style-stores and api_pg.
    """
    today      = date.today()
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
        COALESCE(SUM(s.ordered_item_quantity) FILTER (
            WHERE s.sale_kind IN ('sale','order')
        ), 0)                                            AS units_6m,
        COALESCE(SUM({_NET_SALES_EXPR}), 0.0)           AS revenue_6m
    FROM all_sales s
    LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
    WHERE s.sale_date BETWEEN %(period_from)s AND %(period_to)s
        AND {_BASE_FILTERS}
        AND s.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
        AND s.pos_location_name NOT ILIKE '%%online%%'
        {country_clause}
    GROUP BY s.pos_location_name
),
store_stock AS (
    SELECT
        i.pos_location_name                 AS store,
        COALESCE(SUM(i.available), 0)       AS total_stock
    FROM all_inventory i
    WHERE i.pos_location_name NOT IN ({_WAREHOUSE_LOCATIONS})
      AND i.pos_location_name NOT ILIKE '%%online%%'
    GROUP BY i.pos_location_name
)
SELECT
    COALESCE(ss.store, sk.store)   AS store,
    COALESCE(t.store_tier, '—')    AS store_tier,
    COALESCE(ss.style_count, 0)    AS style_count,
    COALESCE(ss.units_6m, 0)       AS units_6m,
    COALESCE(ss.revenue_6m, 0.0)   AS revenue_6m,
    COALESCE(sk.total_stock, 0)    AS total_stock
FROM store_sales ss
FULL OUTER JOIN store_stock sk ON sk.store = ss.store
LEFT  JOIN store_tiers     t  ON t.store  = COALESCE(ss.store, sk.store)
ORDER BY revenue_6m DESC NULLS LAST
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
        result.append({
            "store":       store,
            "store_tier":  r.get("store_tier") or "—",
            "style_count": int(r.get("style_count") or 0),
            "units_6m":    int(r.get("units_6m") or 0),
            "revenue_6m":  round(float(r.get("revenue_6m") or 0), 0),
            "total_stock": int(r.get("total_stock") or 0),
            "avg_woc":     ws.get("avg_woc"),
            "avg_sor":     ws.get("avg_sor"),
        })

    # Apply tier filter in Python (mirrors _fetch_styles approach)
    if tier:
        tier_filter = set(t.strip() for t in tier.split(",") if t.strip())
        # Store-level has no "tier" — tier filter is not meaningful here, skip.
        pass

    return result


# ── Route registration ─────────────────────────────────────────────────────────

def register_merch_routes(app, api_pg_module):
    global A
    A = api_pg_module

    from fastapi import Request, Query
    from fastapi.responses import JSONResponse

    _TTL = 600  # seconds

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
    ):
        key = f"merch_by_brand|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{pos_location}"
        result = _cached(key, _TTL, lambda: _agg_by_dim(
            _fetch_styles(brand=brand, subcategory=subcategory, tier=tier, status=status,
                          from_date=from_date, to_date=to_date, country=country,
                          pos_location=pos_location),
            "brand",
        ))
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
    ):
        key = f"merch_by_sub|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}|{pos_location}"
        result = _cached(key, _TTL, lambda: _agg_by_dim(
            _fetch_styles(brand=brand, subcategory=subcategory, tier=tier, status=status,
                          from_date=from_date, to_date=to_date, country=country,
                          pos_location=pos_location),
            "subcategory",
        ))
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
        request:   Request,
        from_date: Optional[str] = Query(None),
        to_date:   Optional[str] = Query(None),
        country:   Optional[str] = Query(None),
    ):
        """Cumulative SOR %% by weeks-since-launch, broken down by lifecycle tier."""
        key = f"merch_launch_ramp|{from_date}|{to_date}|{country}"
        result = _cached(key, _TTL, lambda: _fetch_launch_ramp(
            from_date=from_date, to_date=to_date, country=country))
        return JSONResponse(result)

    @app.get("/api/merch/by-store")
    async def merch_by_store(
        request:     Request,
        brand:       Optional[str] = Query(None),
        subcategory: Optional[str] = Query(None),
        tier:        Optional[str] = Query(None),
        status:      Optional[str] = Query(None),
        from_date:   Optional[str] = Query(None),
        to_date:     Optional[str] = Query(None),
        country:     Optional[str] = Query(None),
    ):
        """Per-store aggregated merchandising KPIs (stock, units, revenue, avg WOC, avg SOR)."""
        key = f"merch_by_store|{brand}|{subcategory}|{tier}|{status}|{from_date}|{to_date}|{country}"
        result = _cached(key, _TTL, lambda: _fetch_by_store(
            brand=brand, subcategory=subcategory, tier=tier, status=status,
            from_date=from_date, to_date=to_date, country=country,
        ))
        return JSONResponse({"rows": result})

    log.info("Merchandising Hub routes registered (/api/merch/*)")
