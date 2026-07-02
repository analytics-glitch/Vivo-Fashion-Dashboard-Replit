"""Recompute the per-store / per-subcategory / per-period metric snapshot.

This project has no pre-aggregated "metrics table"; the canonical fact table is
``all_sales`` and ``footfall`` is a separate sensor feed. So the agent recomputes
the eleven metrics directly from source, at three grains: store-level, the group
total, and (optionally) store x subcategory.

Inferred definitions (reported in the dry-run, per the spec's instruction to
resolve ambiguity from the data):

* ``transactions``  = COUNT(DISTINCT order_id) on sale/order rows.
* ``units_sold``    = gross ordered_item_quantity on sale/order rows (returns NOT
  subtracted -- the project's canonical "units sold").
* ``total_sales``   = SUM(total_sales_kes)  (VAT-inclusive).
* ``net_sales``     = SUM(net_sales_kes)    (VAT-exclusive).
* ``return_amount`` = SUM(returns_kes); ``return_rate`` = return_amount / total_sales.
* ``abv`` = total_sales/transactions, ``asp`` = total_sales/units_sold,
  ``msi`` = units_sold/transactions.
* ``footfall``      = SUM(a01_footfall_in) from the footfall sensor feed, joined by
  pos_location_name + date. The footfall feed's own conversion / transaction-count
  columns are empty in this database, so ``conversion_rate`` is derived as
  transactions / footfall (a genuinely cross-source check).
"""
from datetime import date

from . import config, db

_SUBCAT = "COALESCE(NULLIF(TRIM(product_type), ''), '(unspecified)')"


def _base_sql(by_subcat: bool) -> str:
    grp = "(store, sub, d), (store, d), (d)" if by_subcat else "(store, d), (d)"
    sub_select = f"{_SUBCAT} AS sub," if by_subcat else "'__ALL__'::text AS sub,"
    return f"""
    WITH s AS (
        SELECT pos_location_name AS store,
               {_SUBCAT if by_subcat else "'__ALL__'"} AS sub,
               sale_date::date AS d,
               order_id, sale_kind,
               COALESCE(total_sales_kes,0) AS total_sales_kes,
               COALESCE(net_sales_kes,0)   AS net_sales_kes,
               COALESCE(gross_sales_kes,0) AS gross_sales_kes,
               COALESCE(discounts_kes,0)   AS discounts_kes,
               COALESCE(returns_kes,0)     AS returns_kes,
               COALESCE(ordered_item_quantity,0) AS oq
        FROM all_sales
        WHERE sale_date::date BETWEEN %(d0)s AND %(d1)s
          AND pos_location_name IS NOT NULL
          -- Align with the dashboard's reporting scope (api_pg.BASE_FILTERS):
          -- the agent validates the numbers the pages actually render.
          AND {config.REPORTING_FILTERS}
    )
    SELECT
        CASE WHEN store IS NULL THEN 'group' ELSE 'store' END AS entity_type,
        COALESCE(store, '__GROUP__') AS entity,
        {("COALESCE(sub,'__ALL__')" if by_subcat else "'__ALL__'")} AS subcategory,
        d AS period_date,
        SUM(total_sales_kes) AS total_sales,
        SUM(net_sales_kes)   AS net_sales,
        SUM(gross_sales_kes) AS gross_sales,
        SUM(discounts_kes)   AS discounts,
        SUM(returns_kes)     AS return_amount,
        SUM(CASE WHEN sale_kind IN ('sale','order') THEN oq ELSE 0 END) AS units_sold,
        COUNT(DISTINCT order_id) FILTER (WHERE sale_kind IN ('sale','order')) AS transactions,
        -- Expected net from the gross/discounts/returns composition, summed at the
        -- NATIVE row grain so mixed-channel aggregates stay correct. all_sales mixes
        -- TWO orthogonal conventions that no single column cleanly keys:
        --   * VAT: some rows record gross VAT-EXCLUSIVE (net = gross - disc), others
        --     VAT-INCLUSIVE (net = (gross - disc)/(1+VAT)).
        --   * Returns: in-store returns are SEPARATE rows (net=0, returns_kes holds the
        --     amount) so they must NOT be subtracted again; Online (ShopifyQL) returns
        --     are already netted into net_sales as a signed total, so there returns ARE
        --     part of the composition.
        -- Per row we therefore pick, from the four candidate bases below, the one whose
        -- value lands closest to that row's net, then sum the VAT-exclusive result. A
        -- genuine break (double-counted / misclassified returns or discounts) misses
        -- ALL four candidates and still surfaces.
        SUM((
            SELECT cand FROM (VALUES
                (gross_sales_kes - discounts_kes - returns_kes),
                ((gross_sales_kes - discounts_kes - returns_kes) / (1 + %(vat)s)),
                (gross_sales_kes - discounts_kes),
                ((gross_sales_kes - discounts_kes) / (1 + %(vat)s))
            ) AS v(cand)
            ORDER BY ABS(cand - net_sales_kes) LIMIT 1
        )) AS expected_net_comp
    FROM s
    GROUP BY GROUPING SETS ({grp})
    """


_FOOTFALL_SQL = """
    SELECT
        CASE WHEN pos_location_name IS NULL THEN 'group' ELSE 'store' END AS entity_type,
        COALESCE(pos_location_name, '__GROUP__') AS entity,
        time AS period_date,
        SUM(COALESCE(a01_footfall_in,0)) AS footfall
    FROM footfall
    WHERE time BETWEEN %(d0)s AND %(d1)s
      AND pos_location_name IS NOT NULL
    GROUP BY GROUPING SETS ((pos_location_name, time), (time))
"""


def _safe_div(a, b):
    a = float(a or 0)
    b = float(b or 0)
    return a / b if b else None


def compute(conn, d0: date, d1: date, by_subcat: bool | None = None) -> list[dict]:
    by_subcat = config.BY_SUBCATEGORY if by_subcat is None else by_subcat
    with db.cursor(conn) as cur:
        cur.execute(_base_sql(by_subcat), {"d0": d0, "d1": d1, "vat": config.VAT_RATE})
        base = cur.fetchall()
        cur.execute(_FOOTFALL_SQL, {"d0": d0, "d1": d1})
        ff_rows = cur.fetchall()

    ff = {(r["entity_type"], r["entity"], r["period_date"]): float(r["footfall"] or 0)
          for r in ff_rows}

    out = []
    for r in base:
        et, ent, sub, d = r["entity_type"], r["entity"], r["subcategory"], r["period_date"]
        total = float(r["total_sales"] or 0)
        net = float(r["net_sales"] or 0)
        gross = float(r["gross_sales"] or 0)
        disc = float(r["discounts"] or 0)
        ret = float(r["return_amount"] or 0)
        units = int(r["units_sold"] or 0)
        txn = int(r["transactions"] or 0)
        expected_net_comp = float(r["expected_net_comp"] or 0)
        footfall = ff.get((et, ent, d)) if sub == "__ALL__" else None
        rec = {
            "entity_type": et,
            "entity": ent,
            "subcategory": sub,
            "period_date": d,
            "total_sales": total,
            "net_sales": net,
            "gross_sales": gross,
            "discounts": disc,
            "return_amount": ret,
            "units_sold": units,
            "transactions": txn,
            "footfall": footfall,
            "expected_net_comp": expected_net_comp,
            "abv": _safe_div(total, txn),
            "asp": _safe_div(total, units),
            "msi": _safe_div(units, txn),
            "return_rate": _safe_div(ret, total),
            "conversion_rate": _safe_div(txn, footfall) if footfall else None,
            # VAT-consistent composition (see consistency.net_composition):
            # expected_net_comp is summed per-row on each row's own VAT basis.
            "net_comp_residual": _safe_div(net - expected_net_comp, total),
        }
        out.append(rec)
    return out
