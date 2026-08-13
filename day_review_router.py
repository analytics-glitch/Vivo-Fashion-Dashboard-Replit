"""
Day in Review router — deterministic daily trading-day decomposition.

Productizes the manual "what drove yesterday" analysis: headline vs the
prior-4-same-weekday norm, 12-month weekday rank, store movers BOTH
directions, orders/AOV/ASP decomposition, discounts & returns vs norm,
online gross-vs-returns split, category mix shifts, new-launch cohort
(first sale ≤14 days) plus style spikes AND decliners vs the trailing
28-day run-rate, big-order concentration, new-vs-returning customers,
and per-store footfall traffic-vs-conversion — then turns the payload
into deterministic "What worked" / "What's not working" callouts.

Registered from api_pg via register_day_review_routes(app, module) —
same pattern as retail_desk_router. Every money measure uses the
canonical Total Sales basis (total − discounts − returns; gross units)
through A.BASE_FILTERS so the headline reconciles with /api/kpis
exactly. The headline card itself CALLS A.get_kpis to guarantee
byte-equality with Overview.

Endpoint:
  GET /api/day-review/report?date=YYYY-MM-DD   (default: yesterday EAT)

Caching: one payload per date. Closed historical days are effectively
immutable → long TTL; yesterday still receives late-syncing rows →
short TTL. Per-date single-flight so concurrent opens don't recompute.
Access: admin + leadership only, enforced by the /api/day-review gate
in api_pg's clerk_auth_gate middleware (client nav hiding is UX only).
"""

import logging
import re
import threading
import time
from datetime import date as _date, datetime, timedelta, timezone

log = logging.getLogger("day_review")

# Set by register_day_review_routes — the api_pg module (run_query,
# BASE_FILTERS, get_kpis, footfall helpers...).
A = None

EAT = timezone(timedelta(hours=3))
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
            "Saturday", "Sunday"]

# ── Materiality floors for the callouts engine (deterministic rules) ─────────
HEADLINE_PCT = 10.0          # |% vs weekday norm| to call the day itself out
STORE_MIN_KES = 30_000       # store mover: min |Δ| vs norm …
STORE_MIN_PCT = 25.0         # … AND min |Δ%| vs norm
COUNTRY_MIN_KES = 30_000     # country drag: min −Δ …
COUNTRY_MIN_PCT = 15.0       # … AND min −Δ%
LAUNCH_MIN_KES = 50_000      # launch cohort worth a bullet
SPIKE_MIN_KES = 25_000       # style spike: min day sales …
SPIKE_MIN_RATIO = 3.0        # … AND ≥ 3× trailing 28-day daily run-rate
DECLINE_MIN_TRAIL = 8_000    # style cooldown: trailing run-rate ≥ 8k/day …
DECLINE_MAX_RATIO = 0.35     # … AND day ≤ 35% of it
RETURNS_MIN_KES = 10_000     # returns above norm: min Δ …
RETURNS_MIN_RATIO = 1.5      # … AND ≥ 1.5× the weekday norm
ONLINE_RET_PCT = 15.0        # online returns burden: ≥ 15% of gross
ONLINE_RET_MIN = 15_000      #   … and at least this many KES of returns
DISC_DELTA_PP = 3.0          # discount rate vs norm worth a bullet (pp)
CONC_TOP1_PCT = 5.0          # top order ≥ 5% of the day = concentration flag
BROAD_TOP1_PCT = 3.0         # top order ≤ 3% on an up day = broad-based
CONV_DROP_PP = 1.5           # conversion −1.5pp while traffic up ≥ +10%
TRAFFIC_UP_PCT = 10.0
NEWCUST_UP_RATIO = 1.3       # new customers ≥ 1.3× norm = working
NEWCUST_DOWN_RATIO = 0.6     # new customers ≤ 0.6× norm = not working

# ── Per-date payload cache with single-flight ────────────────────────────────
_CACHE_LOCK = threading.Lock()
_REPORT_CACHE = {}   # date_str -> (payload, cached_at_epoch, ttl_seconds)
_DATE_LOCKS = {}     # date_str -> threading.Lock
_CACHE_MAX = 90      # dates kept (a quarter of browsing history)

TTL_RECENT = 900     # yesterday (late rows may still sync) — 15 min
TTL_CLOSED = 21600   # closed historical days are immutable — 6 h


def _eat_today():
    return datetime.now(EAT).date()


def _date_lock(ds):
    with _CACHE_LOCK:
        lk = _DATE_LOCKS.get(ds)
        if lk is None:
            lk = threading.Lock()
            _DATE_LOCKS[ds] = lk
        return lk


def _cache_get(ds):
    with _CACHE_LOCK:
        hit = _REPORT_CACHE.get(ds)
    if not hit:
        return None
    payload, at, ttl = hit
    if time.time() - at > ttl:
        return None
    return payload


def _cache_put(ds, payload, ttl):
    with _CACHE_LOCK:
        _REPORT_CACHE[ds] = (payload, time.time(), ttl)
        if len(_REPORT_CACHE) > _CACHE_MAX:
            # evict oldest entries
            for k in sorted(_REPORT_CACHE, key=lambda k: _REPORT_CACHE[k][1])[
                    : len(_REPORT_CACHE) - _CACHE_MAX]:
                _REPORT_CACHE.pop(k, None)
                _DATE_LOCKS.pop(k, None)


# ── SQL fragments ────────────────────────────────────────────────────────────
# Canonical per-row Total Sales contribution (sums to the /api/kpis formula:
# SUM(total) − SUM(discounts) − SUM(returns); verified equal on 2026-08-11).
ROW_TOTAL = ("CASE WHEN s.sale_kind IN ('sale','order') "
             "THEN s.total_sales_kes::numeric - COALESCE(s.discounts_kes,0)::numeric "
             "WHEN s.sale_kind = 'return' THEN COALESCE(-s.returns_kes::numeric,0) "
             "ELSE 0 END")


def _base():
    return A.BASE_FILTERS


def _f(v):
    """Defensive float (run_query returns Decimals/None)."""
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _r0(v):
    return int(round(_f(v)))


def _pct(part, whole):
    w = _f(whole)
    return round(_f(part) / w * 100.0, 1) if w else None


def _delta_pct(day, base):
    b = _f(base)
    if b <= 0:
        return None
    return round((_f(day) - b) / b * 100.0, 1)


def _prior_same_weekdays(d, n=4):
    return [(d - timedelta(days=7 * i)).isoformat() for i in range(1, n + 1)]


def _in_list(dates):
    return "(" + ", ".join("'" + x + "'" for x in dates) + ")"


# ── Sections ─────────────────────────────────────────────────────────────────

def _daily_series_sql(lo, hi):
    return f"""
        SELECT s.sale_date AS d,
               SUM({ROW_TOTAL}) AS total_sales,
               COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order')
                                   THEN s.order_id END) AS orders,
               SUM(CASE WHEN s.sale_kind IN ('sale','order')
                        THEN COALESCE(s.ordered_item_quantity,0) ELSE 0 END) AS units,
               SUM(CASE WHEN s.sale_kind IN ('sale','order')
                        THEN COALESCE(s.discounts_kes,0)::numeric ELSE 0 END) AS discounts,
               SUM(CASE WHEN s.sale_kind = 'return'
                        THEN COALESCE(s.returns_kes,0)::numeric ELSE 0 END) AS returns,
               SUM(CASE WHEN s.sale_kind IN ('sale','order')
                        THEN COALESCE(s.total_sales_kes,0)::numeric ELSE 0 END) AS gross
        FROM all_sales s
        WHERE s.sale_date BETWEEN '{lo}' AND '{hi}'
          AND {_base()}
        GROUP BY 1 ORDER BY 1
    """


def _series_rows(d):
    """Daily canonical aggregates for the 365 days ending at d.

    Every date within the last year slices ONE shared 2-year scan (cached
    ~1h by run_query since its date_to is a closed day) instead of paying a
    fresh 365-day scan per browsed date — the series was the cold-latency
    long pole. Deeper history falls back to a per-date scan.

    Rows come straight from the run_query cache: treat them as READ-ONLY
    (shared with other requests) — build new dicts for any mutation.
    """
    yesterday = _eat_today() - timedelta(days=1)
    lo_needed = d - timedelta(days=364)
    shared_lo = yesterday - timedelta(days=729)
    ds = d.isoformat()
    if lo_needed >= shared_lo and d <= yesterday:
        rows = A.run_query(
            _daily_series_sql(shared_lo.isoformat(), yesterday.isoformat()),
            date_to=yesterday.isoformat())
        lo_s = lo_needed.isoformat()
        return [r for r in rows if lo_s <= str(r["d"]) <= ds]
    return A.run_query(_daily_series_sql(lo_needed.isoformat(), ds),
                       date_to=ds)


def _headline(d, series):
    """Headline vs prior-4-same-weekday norm + 12-month weekday rank.

    total_sales/orders/units for day D come from A.get_kpis so the card is
    byte-identical to Overview for the same day + default filters.
    """
    ds = d.isoformat()
    k = A.get_kpis(date_from=ds, date_to=ds, country=None, channel=None)
    by_date = {str(r["d"]): r for r in series}
    day_row = by_date.get(ds)

    prior = [by_date.get(x) for x in _prior_same_weekdays(d)]
    n_prior = 4  # divide by 4 even when a date traded zero — matches the
    # manual-analysis convention verified against 2026-08-11 movers.

    def base_avg(col):
        return sum(_f(p[col]) for p in prior if p) / n_prior

    norm_total = base_avg("total_sales")
    norm_orders = base_avg("orders")
    norm_units = base_avg("units")
    norm_disc = base_avg("discounts")
    norm_ret = base_avg("returns")
    norm_gross = base_avg("gross")

    total = _f(k.get("total_sales"))
    orders = _f(k.get("total_orders"))
    units = _f(k.get("total_units"))
    disc = _f(day_row["discounts"]) if day_row else 0.0
    ret = _f(day_row["returns"]) if day_row else 0.0
    gross = _f(day_row["gross"]) if day_row else 0.0

    aov = total / orders if orders else None
    norm_aov = (norm_total / norm_orders) if norm_orders else None
    asp = total / units if units else None
    norm_asp = (norm_total / norm_units) if norm_units else None

    # 12-month same-weekday rank (values from the same canonical series).
    wd = d.weekday()
    same_wd = [(str(r["d"]), _f(r["total_sales"])) for r in series
               if _date.fromisoformat(str(r["d"])).weekday() == wd]
    day_v = next((v for x, v in same_wd if x == ds), _f(day_row["total_sales"]) if day_row else 0.0)
    n_all = len(same_wd)
    rank = 1 + sum(1 for _, v in same_wd if v > day_v)
    rank_bottom = 1 + sum(1 for _, v in same_wd if v < day_v)
    nodec = [(x, v) for x, v in same_wd
             if _date.fromisoformat(x).month != 12]
    n_nodec = len(nodec)
    rank_nodec = 1 + sum(1 for _, v in nodec if v > day_v)
    wd_name = WEEKDAYS[wd]

    if n_all <= 1:
        rank_label = f"Only {wd_name} on record in the window"
    elif rank == 1:
        rank_label = f"Best {wd_name} in the last 12 months"
    elif d.month != 12 and rank_nodec == 1:
        rank_label = f"Best non-December {wd_name} in the last 12 months"
    elif rank_bottom == 1:
        rank_label = f"Worst {wd_name} in the last 12 months"
    else:
        rank_label = f"#{rank} of {n_all} {wd_name}s in the last 12 months"

    disc_rate = _pct(disc, gross)
    norm_disc_rate = _pct(norm_disc, norm_gross)
    ret_rate = _pct(ret, gross)
    norm_ret_rate = _pct(norm_ret, norm_gross)

    return {
        "date": ds,
        "weekday": wd_name,
        "total_sales": _r0(total),
        "norm_total_sales": _r0(norm_total),
        "delta_kes": _r0(total - norm_total),
        "delta_pct": _delta_pct(total, norm_total),
        "orders": _r0(orders),
        "norm_orders": round(norm_orders, 1),
        "orders_delta_pct": _delta_pct(orders, norm_orders),
        "units": _r0(units),
        "norm_units": round(norm_units, 1),
        "units_delta_pct": _delta_pct(units, norm_units),
        "aov": _r0(aov) if aov is not None else None,
        "norm_aov": _r0(norm_aov) if norm_aov is not None else None,
        "aov_delta_pct": _delta_pct(aov, norm_aov) if aov is not None and norm_aov else None,
        "asp": _r0(asp) if asp is not None else None,
        "norm_asp": _r0(norm_asp) if norm_asp is not None else None,
        "asp_delta_pct": _delta_pct(asp, norm_asp) if asp is not None and norm_asp else None,
        "discounts": _r0(disc),
        "norm_discounts": _r0(norm_disc),
        "discount_rate_pct": disc_rate,
        "norm_discount_rate_pct": norm_disc_rate,
        "returns": _r0(ret),
        "norm_returns": _r0(norm_ret),
        "returns_delta_pct": _delta_pct(ret, norm_ret),
        "return_rate_pct": ret_rate,
        "norm_return_rate_pct": norm_ret_rate,
        "rank": rank, "rank_n": n_all,
        "rank_non_dec": rank_nodec, "rank_non_dec_n": n_nodec,
        "rank_from_bottom": rank_bottom,
        "rank_label": rank_label,
        "baseline_dates": _prior_same_weekdays(d),
    }


def _stores(d):
    """Per-store day vs prior-4-same-weekday average — BOTH directions.

    Verified against the 2026-08-11 manual analysis: Online +160,148,
    Galleria +158,375, Kigali Heights −56,806.
    """
    dates = [d.isoformat()] + _prior_same_weekdays(d)
    ds = d.isoformat()
    sql = f"""
        WITH per AS (
            SELECT s.pos_location_name AS store, MAX(s.country) AS country,
                   s.sale_date AS sd, SUM({ROW_TOTAL}) AS v
            FROM all_sales s
            WHERE s.sale_date IN {_in_list(dates)}
              AND {_base()}
            GROUP BY s.pos_location_name, s.sale_date
        )
        SELECT store, MAX(country) AS country,
               SUM(CASE WHEN sd = '{ds}' THEN v ELSE 0 END) AS day_v,
               SUM(CASE WHEN sd <> '{ds}' THEN v ELSE 0 END) / 4.0 AS base_avg,
               COUNT(*) FILTER (WHERE sd <> '{ds}') AS base_days_present
        FROM per GROUP BY store
    """
    rows = A.run_query(sql, date_to=ds)
    out = []
    for r in rows:
        day_v = _f(r["day_v"])
        base = _f(r["base_avg"])
        out.append({
            "store": r["store"],
            "country": r["country"],
            "day_kes": _r0(day_v),
            "norm_kes": _r0(base),
            "delta_kes": _r0(day_v - base),
            "delta_pct": _delta_pct(day_v, base),
            "base_days_present": int(r["base_days_present"] or 0),
        })
    out.sort(key=lambda x: -x["delta_kes"])
    day_total = sum(x["day_kes"] for x in out)
    return {"rows": out, "day_total": day_total}


def _countries(stores_section):
    """Country-level day vs norm, aggregated from the store rows (Online is
    its own bucket, matching the dashboard's country filter)."""
    agg = {}
    for r in stores_section.get("rows", []):
        c = r.get("country") or "Unknown"
        a = agg.setdefault(c, {"country": c, "day_kes": 0, "norm_kes": 0})
        a["day_kes"] += r["day_kes"]
        a["norm_kes"] += r["norm_kes"]
    out = []
    for a in agg.values():
        a["delta_kes"] = a["day_kes"] - a["norm_kes"]
        a["delta_pct"] = _delta_pct(a["day_kes"], a["norm_kes"])
        out.append(a)
    out.sort(key=lambda x: -x["delta_kes"])
    return {"rows": out}


def _online(d):
    """Online gross-vs-returns decomposition vs the same-weekday norm."""
    dates = [d.isoformat()] + _prior_same_weekdays(d)
    ds = d.isoformat()
    sql = f"""
        SELECT s.sale_date AS sd,
               SUM(CASE WHEN s.sale_kind IN ('sale','order')
                        THEN s.total_sales_kes::numeric
                             - COALESCE(s.discounts_kes,0)::numeric
                        ELSE 0 END) AS gross,
               SUM(CASE WHEN s.sale_kind = 'return'
                        THEN COALESCE(s.returns_kes,0)::numeric ELSE 0 END) AS returns,
               COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order')
                                   THEN s.order_id END) AS orders,
               SUM(CASE WHEN s.sale_kind IN ('sale','order')
                        THEN COALESCE(s.ordered_item_quantity,0) ELSE 0 END) AS units
        FROM all_sales s
        WHERE s.sale_date IN {_in_list(dates)}
          AND s.country = 'Online'
          AND {_base()}
        GROUP BY 1
    """
    rows = {str(r["sd"]): r for r in A.run_query(sql, date_to=ds)}
    day = rows.get(ds)
    prior = [rows.get(x) for x in _prior_same_weekdays(d)]

    def avg(col):
        return sum(_f(p[col]) for p in prior if p) / 4.0

    g = _f(day["gross"]) if day else 0.0
    ret = _f(day["returns"]) if day else 0.0
    orders = _f(day["orders"]) if day else 0.0
    units = _f(day["units"]) if day else 0.0
    ng, nret, nord = avg("gross"), avg("returns"), avg("orders")
    return {
        "gross_kes": _r0(g),
        "returns_kes": _r0(ret),
        "net_kes": _r0(g - ret),
        "orders": _r0(orders),
        "units": _r0(units),
        "aov": _r0(g / orders) if orders else None,
        "return_burden_pct": _pct(ret, g),
        "norm_gross_kes": _r0(ng),
        "norm_returns_kes": _r0(nret),
        "norm_net_kes": _r0(ng - nret),
        "norm_orders": round(nord, 1),
        "norm_return_burden_pct": _pct(nret, ng),
        "net_delta_kes": _r0((g - ret) - (ng - nret)),
        "net_delta_pct": _delta_pct(g - ret, ng - nret),
    }


def _categories(d):
    """Category mix: day KES + share vs the trailing-28-day share."""
    ds = d.isoformat()
    t0 = (d - timedelta(days=28)).isoformat()
    t1 = (d - timedelta(days=1)).isoformat()
    sql = f"""
        SELECT COALESCE(NULLIF(TRIM(p.category), ''), 'Uncategorised') AS category,
               SUM(CASE WHEN s.sale_date = '{ds}' THEN {ROW_TOTAL} ELSE 0 END) AS day_v,
               SUM(CASE WHEN s.sale_date = '{ds}' AND s.sale_kind IN ('sale','order')
                        THEN COALESCE(s.ordered_item_quantity,0) ELSE 0 END) AS day_units,
               SUM(CASE WHEN s.sale_date < '{ds}' THEN {ROW_TOTAL} ELSE 0 END) / 28.0 AS trail_daily
        FROM all_sales s
        LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_date BETWEEN '{t0}' AND '{ds}'
          AND {_base()}
        GROUP BY 1
    """
    rows = A.run_query(sql, date_to=ds)
    day_total = sum(_f(r["day_v"]) for r in rows)
    trail_total = sum(_f(r["trail_daily"]) for r in rows)
    out = []
    for r in rows:
        dv, tv = _f(r["day_v"]), _f(r["trail_daily"])
        day_share = _pct(dv, day_total)
        trail_share = _pct(tv, trail_total)
        out.append({
            "category": r["category"],
            "day_kes": _r0(dv),
            "day_units": _r0(r["day_units"]),
            "trail_daily_kes": _r0(tv),
            "delta_pct": _delta_pct(dv, tv),
            "day_share_pct": day_share,
            "trail_share_pct": trail_share,
            "share_delta_pp": (round(day_share - trail_share, 1)
                               if day_share is not None and trail_share is not None
                               else None),
        })
    out.sort(key=lambda x: -x["day_kes"])
    return {"rows": out[:14]}


def _styles_query(d):
    """The bounded 365-day style scan (first-sale lookup window — NOT a
    full-history per-style scan) joined to the product master via SKU."""
    ds = d.isoformat()
    d0 = (d - timedelta(days=364)).isoformat()
    t0 = (d - timedelta(days=28)).isoformat()
    t1 = (d - timedelta(days=1)).isoformat()
    day_v_expr = f"SUM(CASE WHEN s.sale_date = '{ds}' THEN {ROW_TOTAL} ELSE 0 END)"
    day_u_expr = (f"SUM(CASE WHEN s.sale_date = '{ds}' AND s.sale_kind IN ('sale','order') "
                  f"THEN COALESCE(s.ordered_item_quantity,0) ELSE 0 END)")
    trail_expr = (f"SUM(CASE WHEN s.sale_date BETWEEN '{t0}' AND '{t1}' "
                  f"THEN {ROW_TOTAL} ELSE 0 END)")
    sql = f"""
        SELECT COALESCE(NULLIF(TRIM(p.style_name), ''), s.product_title, 'Unknown') AS style,
               MAX(COALESCE(NULLIF(TRIM(p.category), ''), p.product_type)) AS category,
               MIN(s.sale_date) FILTER (WHERE s.sale_kind IN ('sale','order')) AS first_sale,
               {day_v_expr} AS day_v,
               {day_u_expr} AS day_units,
               {trail_expr} AS trail_v
        FROM all_sales s
        LEFT JOIN all_products_clean p ON p.sku = s.variant_sku
        WHERE s.sale_date BETWEEN '{d0}' AND '{ds}'
          AND {_base()}
        GROUP BY 1
        HAVING {day_u_expr} > 0 OR {day_v_expr} <> 0
            OR {trail_expr} >= {DECLINE_MIN_TRAIL * 28 * 0.25}
        LIMIT 5000
    """
    return A.run_query(sql, date_to=ds)


def _styles(d, day_total, rows=None):
    """New-launch cohort + style spikes AND decliners vs trailing 28d."""
    if rows is None:
        rows = _styles_query(d)
    launch_floor = (d - timedelta(days=13)).isoformat()
    launches, spikes, decliners = [], [], []
    launch_sum = 0.0
    launch_n = 0
    for r in rows:
        day_v = _f(r["day_v"])
        trail_daily = _f(r["trail_v"]) / 28.0
        first_sale = str(r["first_sale"] or "")
        is_launch = bool(first_sale) and first_sale >= launch_floor
        item = {
            "style": r["style"],
            "category": r["category"],
            "first_sale": first_sale or None,
            "day_kes": _r0(day_v),
            "day_units": _r0(r["day_units"]),
            "trail_daily_kes": _r0(trail_daily),
            "ratio": (round(day_v / trail_daily, 1) if trail_daily > 0 else None),
            "share_of_day_pct": _pct(day_v, day_total),
        }
        if is_launch and (day_v > 0 or _f(r["day_units"]) > 0):
            launch_n += 1
            launch_sum += day_v
            launches.append(item)
        elif day_v >= SPIKE_MIN_KES and (trail_daily <= 0 or day_v >= SPIKE_MIN_RATIO * trail_daily):
            spikes.append(item)
        if (not is_launch and trail_daily >= DECLINE_MIN_TRAIL
                and day_v <= DECLINE_MAX_RATIO * trail_daily):
            decliners.append(dict(item, gap_kes=_r0(trail_daily - day_v)))
    launches.sort(key=lambda x: -x["day_kes"])
    spikes.sort(key=lambda x: -x["day_kes"])
    decliners.sort(key=lambda x: -x["gap_kes"])
    return {
        "launch_cohort": {
            "n_styles": launch_n,
            "day_kes": _r0(launch_sum),
            "share_of_day_pct": _pct(launch_sum, day_total),
            "window_days": 14,
            "top": launches[:10],
        },
        "spikes": spikes[:8],
        "decliners": decliners[:8],
    }


def _big_orders_query(d):
    ds = d.isoformat()
    sql = f"""
        SELECT s.order_id,
               MAX(s.order_name) AS order_name,
               MAX(s.pos_location_name) AS store,
               SUM(s.total_sales_kes::numeric
                   - COALESCE(s.discounts_kes,0)::numeric) AS v,
               SUM(COALESCE(s.ordered_item_quantity,0)) AS units
        FROM all_sales s
        WHERE s.sale_date = '{ds}'
          AND s.sale_kind IN ('sale','order')
          AND {_base()}
        GROUP BY s.order_id
        ORDER BY v DESC
        LIMIT 8
    """
    return A.run_query(sql, date_to=ds)


def _big_orders(d, day_total, rows=None):
    """Big-order concentration: top orders + how much of the day they carried."""
    if rows is None:
        rows = _big_orders_query(d)
    top = [{
        "order_name": r["order_name"] or str(r["order_id"]),
        "store": r["store"],
        "kes": _r0(r["v"]),
        "units": _r0(r["units"]),
        "share_of_day_pct": _pct(r["v"], day_total),
    } for r in rows]
    top1 = top[0] if top else None
    over_50k = [t for t in top if t["kes"] >= 50_000]
    return {
        "top": top[:5],
        "top1_share_pct": top1["share_of_day_pct"] if top1 else None,
        "orders_over_50k": len(over_50k),
        "over_50k_kes": sum(t["kes"] for t in over_50k),
        "over_50k_share_pct": _pct(sum(t["kes"] for t in over_50k), day_total),
    }


def _customers(d):
    """New vs returning from the first-purchase rollup (day figures via the
    shared customer-type-split endpoint so they reconcile with Total Sales
    exactly), plus a prior-4-same-weekday norm from ONE bounded query that
    LEFT JOINs the rollup and classifies unmatched identified customers as
    new — 5 separate endpoint scans thrashed the DB."""
    ds = d.isoformat()
    day = A.get_kpis_customer_type_split(date_from=ds, date_to=ds,
                                         country=None, channel=None)

    base_new_c, base_new_s, base_tot, n_ok = 0.0, 0.0, 0.0, 0
    base_dates = _prior_same_weekdays(d)
    try:
        # Identified-customer gates live inside CASE (not WHERE) so
        # SUM(ROW_TOTAL) is the FULL day total — same denominator as the
        # day-side share. The rollup join is PK-grain (no fan-out).
        ident = (f"(s.customer_id IS NOT NULL AND "
                 f"LOWER(COALESCE(s.customer_type,'')) IN "
                 f"('new','returning','registered') AND "
                 f"{A._not_walkin_pseudo_sql('s')})")
        is_new = (f"({ident} AND (r.first_purchase_date IS NULL "
                  f"OR r.first_purchase_date::text = s.sale_date))")
        sql = f"""
            SELECT s.sale_date AS sd,
                   COUNT(DISTINCT CASE WHEN {is_new}
                         THEN s.customer_id END) AS new_customers,
                   SUM(CASE WHEN {is_new} THEN {ROW_TOTAL} ELSE 0 END)
                       AS new_sales,
                   SUM({ROW_TOTAL}) AS day_total
            FROM all_sales s
            LEFT JOIN rollup_customer_first_purchase r
              ON r.customer_id = s.customer_id
            WHERE s.sale_date IN {_in_list(base_dates)}
              AND {_base()}
            GROUP BY 1
        """
        for p in A.run_query(sql, date_to=ds):
            base_new_c += _f(p.get("new_customers"))
            base_new_s += _f(p.get("new_sales"))
            base_tot += _f(p.get("day_total"))
            n_ok += 1
    except Exception as e:  # baseline is best-effort context
        log.warning("day-review customer baseline for %s failed: %s", ds, e)
        n_ok = 0
    out = {k: day.get(k) for k in (
        "total_sales", "new_sales", "returning_sales", "walk_in_sales",
        "new_customers", "returning_customers", "identified_sales")
        if k in day}
    # tolerate field-name drift in the shared endpoint
    for k, v in day.items():
        if k not in out and isinstance(v, (int, float)):
            out[k] = v
    out["norm_new_customers"] = round(base_new_c / n_ok, 1) if n_ok else None
    out["norm_new_sales"] = _r0(base_new_s / n_ok) if n_ok else None
    # The split payload has no total_sales key; the buckets are exhaustive
    # (new + returning + walk-in == Total Sales), so the sum IS the day total.
    day_tot = _f(day.get("total_sales")) or (
        _f(day.get("new_sales")) + _f(day.get("returning_sales"))
        + _f(day.get("walk_in_sales")))
    out["new_share_pct"] = _pct(day.get("new_sales"), day_tot)
    out["norm_new_share_pct"] = _pct(base_new_s, base_tot) if base_tot else None
    return out


def _footfall(d):
    """Per-store traffic vs conversion using the canonical footfall mapping
    + sensor-gap handling: a store selling with zero counted visitors on any
    of the five dates is flagged instead of polluting conversion."""
    dates = [d.isoformat()] + _prior_same_weekdays(d)
    ds = d.isoformat()
    lo = min(dates)
    hi = (d + timedelta(days=1)).isoformat()
    canon = A.ff_canon_sql()
    master_pred = A.ff_store_master_predicate()
    sql = f"""
        WITH ff_daily AS (
            SELECT {canon} AS loc, f.time::date AS fd,
                   SUM(COALESCE(f.a01_footfall_in, 0)) AS ff
            FROM footfall f
            WHERE f.time >= '{lo}' AND f.time < '{hi}'
              AND f.time::date IN {_in_list(dates)}
              AND {master_pred}
            GROUP BY 1, 2
        ),
        sales_daily AS (
            SELECT s.pos_location_name AS loc, s.sale_date::date AS fd,
                   COUNT(DISTINCT CASE WHEN s.sale_kind IN ('sale','order')
                                       THEN s.order_id END) AS orders,
                   SUM({ROW_TOTAL}) AS sales
            FROM all_sales s
            WHERE s.sale_date IN {_in_list(dates)}
              AND {_base()}
            GROUP BY 1, 2
        ),
        ff_locs AS (SELECT DISTINCT loc FROM ff_daily)
        SELECT COALESCE(f.loc, sd.loc) AS loc,
               COALESCE(f.fd, sd.fd)::text AS fd,
               COALESCE(f.ff, 0) AS ff,
               COALESCE(sd.orders, 0) AS orders,
               COALESCE(sd.sales, 0) AS sales
        FROM ff_daily f
        FULL OUTER JOIN sales_daily sd ON sd.loc = f.loc AND sd.fd = f.fd
        WHERE COALESCE(f.loc, sd.loc) IN (SELECT loc FROM ff_locs)
    """
    rows = A.run_query(sql, date_to=ds)
    per = {}
    for r in rows:
        per.setdefault(r["loc"], []).append(r)
    out, sensors_down = [], []
    fleet_ff_d = fleet_ff_b = fleet_ord_d = fleet_ord_b = 0.0
    for loc, rs in per.items():
        day_r = next((r for r in rs if str(r["fd"]) == ds), None)
        base_rs = [r for r in rs if str(r["fd"]) != ds]
        clean_base = [r for r in base_rs if _f(r["ff"]) > 0]
        ff_day = _f(day_r["ff"]) if day_r else 0.0
        orders_day = _f(day_r["orders"]) if day_r else 0.0
        sales_day = _f(day_r["sales"]) if day_r else 0.0
        sensor_down = ff_day <= 0 and orders_day > 0
        base_ff = (sum(_f(r["ff"]) for r in clean_base) / len(clean_base)
                   if clean_base else None)
        base_conv = None
        b_ff = sum(_f(r["ff"]) for r in clean_base)
        b_ord = sum(_f(r["orders"]) for r in clean_base)
        if b_ff > 0:
            base_conv = b_ord / b_ff * 100.0
        conv_day = (orders_day / ff_day * 100.0) if ff_day > 0 else None
        row = {
            "store": loc,
            "footfall": _r0(ff_day) if not sensor_down else None,
            "norm_footfall": _r0(base_ff) if base_ff is not None else None,
            "traffic_delta_pct": (_delta_pct(ff_day, base_ff)
                                  if base_ff and not sensor_down else None),
            "conversion_pct": round(conv_day, 1) if conv_day is not None else None,
            "norm_conversion_pct": round(base_conv, 1) if base_conv is not None else None,
            "conversion_delta_pp": (round(conv_day - base_conv, 1)
                                    if conv_day is not None and base_conv is not None
                                    else None),
            "orders": _r0(orders_day),
            "sales_kes": _r0(sales_day),
            "sensor_down": sensor_down,
        }
        if sensor_down:
            sensors_down.append({"store": loc, "sales_kes": _r0(sales_day),
                                 "orders": _r0(orders_day)})
        elif ff_day > 0 and clean_base:
            fleet_ff_d += ff_day
            fleet_ff_b += (b_ff / len(clean_base))
            fleet_ord_d += orders_day
            fleet_ord_b += (b_ord / len(clean_base))
        if ff_day > 0 or orders_day > 0 or clean_base:
            out.append(row)
    out.sort(key=lambda x: -(x["footfall"] or 0))
    fleet = {
        "footfall": _r0(fleet_ff_d),
        "norm_footfall": _r0(fleet_ff_b),
        "traffic_delta_pct": _delta_pct(fleet_ff_d, fleet_ff_b),
        "conversion_pct": _pct(fleet_ord_d, fleet_ff_d),
        "norm_conversion_pct": _pct(fleet_ord_b, fleet_ff_b),
    }
    if fleet["conversion_pct"] is not None and fleet["norm_conversion_pct"] is not None:
        fleet["conversion_delta_pp"] = round(
            fleet["conversion_pct"] - fleet["norm_conversion_pct"], 1)
    else:
        fleet["conversion_delta_pp"] = None
    return {"rows": out, "fleet": fleet, "sensors_down": sensors_down}


# ── Callouts engine (deterministic, every claim carries its numbers) ─────────

def _kes(v):
    v = _f(v)
    a = abs(v)
    if a >= 1_000_000:
        return f"KES {v / 1_000_000:.1f}M"
    if a >= 1_000:
        return f"KES {v / 1_000:.0f}k"
    return f"KES {v:.0f}"


def _sgn(v):
    return f"+{_kes(v)[4:]}" if _f(v) >= 0 else f"−{_kes(abs(v))[4:]}"


def _callouts(p):
    good, bad = [], []

    def G(kind, text):
        good.append({"kind": kind, "text": text})

    def B(kind, text):
        bad.append({"kind": kind, "text": text})

    h = p.get("headline") or {}
    if h and not h.get("error"):
        wd = h.get("weekday", "day")
        if _f(h.get("total_sales")) <= 0:
            B("no_data", f"No sales recorded for this date — if it isn't a "
                         f"closure day, check the sync.")
            return {"working": good, "not_working": bad}
        dp = h.get("delta_pct")
        if dp is not None and dp >= HEADLINE_PCT:
            G("headline", f"Total Sales {_kes(h['total_sales'])} — {dp:+.0f}% vs a "
                          f"typical {wd} ({_kes(h['norm_total_sales'])}). {h['rank_label']}.")
        elif dp is not None and dp <= -HEADLINE_PCT:
            B("headline", f"Total Sales {_kes(h['total_sales'])} — {dp:.0f}% vs a "
                          f"typical {wd} ({_kes(h['norm_total_sales'])}).")
        # Orders vs AOV decomposition
        op, ap = h.get("orders_delta_pct"), h.get("aov_delta_pct")
        if op is not None and ap is not None:
            if dp is not None and dp >= HEADLINE_PCT:
                if op >= 10 and ap < 5:
                    G("decomposition", f"Traffic-led: {h['orders']} orders ({op:+.0f}% vs "
                                       f"norm {h['norm_orders']:.0f}) with AOV steady at "
                                       f"{_kes(h['aov'])} ({ap:+.0f}%).")
                elif ap >= 10 and op < 5:
                    G("decomposition", f"Basket-led: AOV {_kes(h['aov'])} ({ap:+.0f}% vs "
                                       f"norm {_kes(h['norm_aov'])}) on {h['orders']} orders "
                                       f"({op:+.0f}%).")
                elif op >= 5 and ap >= 5:
                    G("decomposition", f"Both levers up: orders {op:+.0f}% ({h['orders']} vs "
                                       f"norm {h['norm_orders']:.0f}) and AOV {ap:+.0f}% "
                                       f"({_kes(h['aov'])}).")
            elif dp is not None and dp <= -HEADLINE_PCT:
                if op <= -10 and ap > -5:
                    B("decomposition", f"Order count is the problem: {h['orders']} orders "
                                       f"({op:.0f}% vs norm {h['norm_orders']:.0f}) while AOV "
                                       f"held at {_kes(h['aov'])} ({ap:+.0f}%).")
                elif ap <= -10 and op > -5:
                    B("decomposition", f"Basket is the problem: AOV {_kes(h['aov'])} "
                                       f"({ap:.0f}% vs norm {_kes(h['norm_aov'])}) on flat "
                                       f"orders ({op:+.0f}%).")
        # Discounts
        dr, ndr = h.get("discount_rate_pct"), h.get("norm_discount_rate_pct")
        if dr is not None and ndr is not None:
            if dr <= ndr - DISC_DELTA_PP and (dp or 0) > 0:
                G("discounts", f"Done with LESS discounting: {dr:.1f}% of gross vs "
                               f"{ndr:.1f}% typical ({_kes(h['discounts'])} given).")
            elif dr >= ndr + DISC_DELTA_PP and _f(h.get("discounts")) >= 50_000:
                B("discounts", f"Heavier discounting than typical: {dr:.1f}% of gross vs "
                               f"{ndr:.1f}% ({_kes(h['discounts'])} given away).")
        # Returns vs weekday norm
        ret, nret = _f(h.get("returns")), _f(h.get("norm_returns"))
        if ret >= RETURNS_MIN_RATIO * max(nret, 1.0) and ret - nret >= RETURNS_MIN_KES:
            B("returns", f"Returns {_kes(ret)} vs {_kes(nret)} typical for a {wd} "
                         f"({(ret / nret - 1) * 100:+.0f}%)." if nret > 0 else
                         f"Returns {_kes(ret)} on a day that normally sees none.")

    st = p.get("stores") or {}
    if st and not st.get("error"):
        rows = st.get("rows", [])
        ups = [r for r in rows if r["delta_kes"] >= STORE_MIN_KES
               and (r["delta_pct"] is None or r["delta_pct"] >= STORE_MIN_PCT)]
        downs = [r for r in rows if r["delta_kes"] <= -STORE_MIN_KES
                 and r["delta_pct"] is not None and r["delta_pct"] <= -STORE_MIN_PCT]
        for r in ups[:3]:
            pct_txt = (f", {r['delta_pct']:+.0f}%" if r["delta_pct"] is not None
                       else ", no recent baseline")
            G("store_up", f"{r['store']}: {_kes(r['day_kes'])} vs {_kes(r['norm_kes'])} "
                          f"norm ({_sgn(r['delta_kes'])}{pct_txt}).")
        for r in sorted(downs, key=lambda x: x["delta_kes"])[:3]:
            B("store_down", f"{r['store']}: {_kes(r['day_kes'])} vs {_kes(r['norm_kes'])} "
                            f"norm ({_sgn(r['delta_kes'])}, {r['delta_pct']:.0f}%).")

    co = p.get("countries") or {}
    if co and not co.get("error"):
        for r in co.get("rows", []):
            if (r["delta_kes"] <= -COUNTRY_MIN_KES and r["delta_pct"] is not None
                    and r["delta_pct"] <= -COUNTRY_MIN_PCT):
                B("country", f"{r['country']} dragged: {_kes(r['day_kes'])} vs "
                             f"{_kes(r['norm_kes'])} norm ({_sgn(r['delta_kes'])}, "
                             f"{r['delta_pct']:.0f}%).")

    sty = p.get("styles") or {}
    if sty and not sty.get("error"):
        lc = sty.get("launch_cohort") or {}
        if _f(lc.get("day_kes")) >= LAUNCH_MIN_KES:
            tops = ", ".join(f"{t['style']} ({_kes(t['day_kes'])})"
                             for t in (lc.get("top") or [])[:3])
            G("launches", f"New launches (first sale ≤14 days) brought "
                          f"{_kes(lc['day_kes'])} across {lc['n_styles']} styles"
                          f" — {lc.get('share_of_day_pct') or 0:.0f}% of the day. "
                          f"Top: {tops}.")
        for s in (sty.get("spikes") or [])[:2]:
            if s["ratio"] is not None:
                G("style_spike", f"{s['style']} spiked to {_kes(s['day_kes'])} vs "
                                 f"~{_kes(s['trail_daily_kes'])}/day trailing "
                                 f"(×{s['ratio']:.1f}).")
            else:
                G("style_spike", f"{s['style']} woke up: {_kes(s['day_kes'])} after "
                                 f"~zero sales in the prior 28 days.")
        for s in (sty.get("decliners") or [])[:2]:
            B("style_cooling", f"{s['style']} cooling: {_kes(s['day_kes'])} vs "
                               f"~{_kes(s['trail_daily_kes'])}/day trailing run-rate.")

    on = p.get("online") or {}
    if on and not on.get("error"):
        ndp = on.get("net_delta_pct")
        if _f(on.get("net_delta_kes")) >= STORE_MIN_KES and (ndp is None or ndp >= STORE_MIN_PCT):
            G("online", f"Online net {_kes(on['net_kes'])} vs {_kes(on['norm_net_kes'])} "
                        f"norm ({_sgn(on['net_delta_kes'])}) — gross {_kes(on['gross_kes'])} "
                        f"minus {_kes(on['returns_kes'])} returns.")
        rb = on.get("return_burden_pct")
        if rb is not None and rb >= ONLINE_RET_PCT and _f(on.get("returns_kes")) >= ONLINE_RET_MIN:
            B("online_returns", f"Online returns ate {rb:.0f}% of gross "
                                f"({_kes(on['returns_kes'])} of {_kes(on['gross_kes'])}; "
                                f"typical burden {on.get('norm_return_burden_pct') or 0:.0f}%).")

    bo = p.get("big_orders") or {}
    if bo and not bo.get("error") and bo.get("top"):
        t1 = bo["top"][0]
        if _f(bo.get("top1_share_pct")) >= CONC_TOP1_PCT or t1["kes"] >= 100_000:
            B("concentration", f"Concentration risk: top order {t1['order_name']} "
                               f"({t1['store']}) was {_kes(t1['kes'])} — "
                               f"{bo['top1_share_pct']:.1f}% of the day.")
        elif h and _f(h.get("delta_pct")) >= HEADLINE_PCT and \
                _f(bo.get("top1_share_pct")) <= BROAD_TOP1_PCT:
            G("broad_based", f"Broad-based demand — biggest order was only "
                             f"{_kes(t1['kes'])} ({bo['top1_share_pct']:.1f}% of the day).")

    cu = p.get("customers") or {}
    if cu and not cu.get("error"):
        nc, nn = _f(cu.get("new_customers")), cu.get("norm_new_customers")
        if nn and nn >= 5:
            if nc >= NEWCUST_UP_RATIO * nn:
                G("new_customers", f"{nc:.0f} new customers vs ~{nn:.0f} typical "
                                   f"({_kes(cu.get('new_sales'))} of revenue).")
            elif nc <= NEWCUST_DOWN_RATIO * nn:
                B("new_customers", f"Only {nc:.0f} new customers vs ~{nn:.0f} typical "
                                   f"— acquisition was weak.")

    ff = p.get("footfall") or {}
    if ff and not ff.get("error"):
        fl = ff.get("fleet") or {}
        tdp, cdp = fl.get("traffic_delta_pct"), fl.get("conversion_delta_pp")
        if tdp is not None and cdp is not None and tdp >= TRAFFIC_UP_PCT and cdp >= -0.5:
            G("footfall", f"Fleet footfall {tdp:+.0f}% vs norm with conversion holding "
                          f"({fl['conversion_pct']:.1f}% vs {fl['norm_conversion_pct']:.1f}%).")
        for r in ff.get("rows", []):
            if (r.get("traffic_delta_pct") is not None
                    and r.get("conversion_delta_pp") is not None
                    and r["traffic_delta_pct"] >= TRAFFIC_UP_PCT
                    and r["conversion_delta_pp"] <= -CONV_DROP_PP
                    and r.get("orders", 0) >= 5):
                B("conversion_drop", f"{r['store']}: footfall {r['traffic_delta_pct']:+.0f}% "
                                     f"but conversion fell to {r['conversion_pct']:.1f}% "
                                     f"({r['conversion_delta_pp']:+.1f}pp vs norm) — traffic "
                                     f"came, buying didn't.")
        if len([b for b in bad if b["kind"] == "conversion_drop"]) > 3:
            keep = [b for b in bad if b["kind"] != "conversion_drop"]
            drops = [b for b in bad if b["kind"] == "conversion_drop"][:3]
            bad[:] = keep + drops
        sd = ff.get("sensors_down") or []
        if sd:
            names = ", ".join(f"{s['store']} ({_kes(s['sales_kes'])} sold)"
                              for s in sd[:4])
            B("sensor_down", f"Footfall sensor dark at {names} — zero visitors counted "
                             f"despite sales; conversion not measurable there.")

    return {"working": good, "not_working": bad}


# ── Report assembly ──────────────────────────────────────────────────────────

def _build_report(d):
    from concurrent.futures import ThreadPoolExecutor

    payload = {}
    timings = {}

    def section(name, fn, *args):
        t0 = time.time()
        try:
            payload[name] = fn(*args)
        except Exception as e:
            log.warning("day-review section '%s' failed for %s: %s",
                        name, d.isoformat(), e, exc_info=True)
            payload[name] = {"error": f"{type(e).__name__}: {e}"}
        finally:
            timings[name] = int((time.time() - t0) * 1000)

    # Independent sections run concurrently (run_query / the shared pool are
    # already used from worker threads elsewhere). max_workers stays LOW:
    # more concurrency just thrashes the shared Postgres (measured: 6 workers
    # + 5 nested split scans pushed a 1.4s series scan to ~9s). Heavy scans
    # submitted first; sub-100ms queries backfill freed slots.
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_series = ex.submit(_series_rows, d)
        f_sty_rows = ex.submit(_styles_query, d)
        f_cust = ex.submit(_customers, d)
        f_ff = ex.submit(_footfall, d)
        f_stores = ex.submit(_stores, d)
        f_online = ex.submit(_online, d)
        f_cats = ex.submit(_categories, d)
        f_big_rows = ex.submit(_big_orders_query, d)

        series = []
        try:
            series = f_series.result()
        except Exception as e:
            log.warning("day-review series failed for %s: %s", d.isoformat(), e)

        section("headline", _headline, d, series)
        section("stores", f_stores.result)
        section("online", f_online.result)
        section("categories", f_cats.result)
        section("customers", f_cust.result)
        section("footfall", f_ff.result)

        if isinstance(payload.get("stores"), dict) and not payload["stores"].get("error"):
            section("countries", _countries, payload["stores"])
        else:
            payload["countries"] = {"error": "store section unavailable"}

        day_total = _f((payload.get("headline") or {}).get("total_sales"))

        def styles_with(rows_fut):
            return _styles(d, day_total, rows=rows_fut.result())

        def big_with(rows_fut):
            return _big_orders(d, day_total, rows=rows_fut.result())

        section("styles", styles_with, f_sty_rows)
        section("big_orders", big_with, f_big_rows)
    try:
        payload["callouts"] = _callouts(payload)
    except Exception as e:
        log.warning("day-review callouts failed for %s: %s", d.isoformat(), e,
                    exc_info=True)
        payload["callouts"] = {"error": f"{type(e).__name__}: {e}",
                               "working": [], "not_working": []}

    data_through = str(series[-1]["d"]) if series else None
    payload["meta"] = {
        "date": d.isoformat(),
        "weekday": WEEKDAYS[d.weekday()],
        "baseline_dates": _prior_same_weekdays(d),
        "data_through": data_through,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "timings_ms": timings,  # per-section wall time (waits on futures incl.)
    }
    return payload


# ── Registration ─────────────────────────────────────────────────────────────

def register_day_review_routes(app, api_pg_module):
    global A
    A = api_pg_module

    from fastapi import HTTPException, Query

    @app.get("/api/day-review/report")
    def day_review_report(date: str = Query(default=None)):
        # Strict validation — the date is interpolated into SQL, so it must
        # match YYYY-MM-DD exactly and parse as a real calendar date.
        yesterday = _eat_today() - timedelta(days=1)
        if date is None or date == "":
            d = yesterday
        else:
            if not _DATE_RE.match(date):
                raise HTTPException(status_code=400,
                                    detail="date must be YYYY-MM-DD")
            try:
                d = _date.fromisoformat(date)
            except ValueError:
                raise HTTPException(status_code=400, detail="invalid date")
        if d > yesterday:
            raise HTTPException(
                status_code=400,
                detail="Day in Review covers closed trading days only — "
                       "pick yesterday or earlier (today is still trading).")
        if d < _date(2021, 6, 1):
            raise HTTPException(status_code=400,
                                detail="date is before available sales history")

        ds = d.isoformat()
        cached = _cache_get(ds)
        if cached is not None:
            return cached
        with _date_lock(ds):
            cached = _cache_get(ds)   # double-check inside the lock
            if cached is not None:
                return cached
            payload = _build_report(d)
            ttl = TTL_RECENT if d >= _eat_today() - timedelta(days=1) else TTL_CLOSED
            # Don't let a fully-failed report poison the cache for 6 h.
            failed = sum(1 for k, v in payload.items()
                         if isinstance(v, dict) and v.get("error"))
            if failed >= 4:
                ttl = 60
            _cache_put(ds, payload, ttl)
            return payload

    def _prewarm_loop():
        """Keep YESTERDAY's report warm so the page's default view opens
        instantly. First run waits out the boot prewarm burst; afterwards a
        10-minute cadence re-builds only once the short TTL lapses. Queries
        only — no DDL, nothing that could block the port bind."""
        time.sleep(180)
        while True:
            try:
                y = _eat_today() - timedelta(days=1)
                ds = y.isoformat()
                if _cache_get(ds) is None:
                    with _date_lock(ds):
                        if _cache_get(ds) is None:
                            payload = _build_report(y)
                            failed = sum(1 for k, v in payload.items()
                                         if isinstance(v, dict) and v.get("error"))
                            _cache_put(ds, payload,
                                       60 if failed >= 4 else TTL_RECENT)
                            log.info("day-review prewarmed %s (%d sections failed)",
                                     ds, failed)
            except Exception as e:
                log.warning("day-review prewarm failed: %s", e)
            time.sleep(600)

    threading.Thread(target=_prewarm_loop, daemon=True,
                     name="day-review-prewarm").start()

    log.info("Day in Review routes registered (/api/day-review/report)")
