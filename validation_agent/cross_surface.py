"""Step 6 -- cross-surface (cross-endpoint) metric consistency.

The same business metric, under the same filters, must read the SAME number on
every dashboard page. Each page is backed by a DIFFERENT ``/api`` endpoint, so a
SQL drift in one endpoint silently makes two pages disagree even though the
underlying data is fine. This step reconciles the headline KPI endpoint against
every endpoint that decomposes the same measures -- by country, by store+channel,
by day -- plus the inventory pair, over a few representative filter scenarios.

It is strictly READ-ONLY against the running API: it logs in once with the
seed-admin credentials, caches the Bearer token, and only issues GETs. It NEVER
modifies any dashboard or endpoint code and NEVER writes to the source tables --
a mismatch becomes a ``validation_exceptions`` row like any other Tier-1 break.
It degrades gracefully: if the API is unreachable, login fails, or a single
endpoint errors, it returns the exceptions found so far plus a skip reason and
never raises into the caller (the always-on sync loop).

Reconciliation map (all under identical filters):
* ``/api/kpis`` headline  ==  ``/api/analytics/total-sales-summary`` (direct)
* ``/api/kpis``  ==  Σ ``/api/daily-trend`` rows           (date[, country])
* ``/api/kpis``  ==  Σ ``/api/sales-summary`` rows         (date, country, channel)
* ``/api/kpis``  ==  Σ ``/api/country-summary`` rows       (date only)
* ``/api/inventory-summary``  ==  ``/api/analytics/inventory-summary`` and
  ``total_units``  ==  Σ ``by_location``  ==  Σ ``by_subcat`` (internal)
* Product pages (style-count / breakdown totals that MUST tally):
  - ``/api/analytics/product-analysis`` lifecycle partition (task #420): under
    EVERY ``style_status`` filter (all/active/retired) ``active_styles +
    retired_styles == styles``; and the filtered slices partition the ``all``
    universe (``[active].styles == [all].active_styles``, ``[retired].styles ==
    [all].retired_styles``)
  - ``/api/analytics/product-analysis`` summary ``styles``/``units``/``stock_units``
    ==  Σ ``by_subcategory``  ==  Σ ``by_brand``  (a page's chart must add up to
    the page's own KPI)
  - ``/api/range-mgmt/classify`` ``summary.total_active_styles``  ==  Σ
    ``tier_counts``  ==  ``len(rows)``
  - ``/api/inventory-style-counts`` ``active_styles + retired_styles``  ==
    ``total_styles``
  - cross-PAGE: product-analysis ``summary.styles``  ==  range-mgmt
    ``len(rows) + len(retired_rows)`` (both are the "styles with current stock"
    universe, shown on the Products / Product Analysis and Range Management pages)

Reconciled measures per endpoint: ``total_sales``, ``gross_sales``,
``orders``/``transactions`` and ``units`` are reconciled against EVERY endpoint
above. ``net_sales`` is reconciled ONLY against ``/api/analytics/total-sales-
summary`` -- see ``INTENTIONAL_SKIPS``: the breakdown endpoints (country-summary,
sales-summary, daily-trend) do not expose ``net_sales`` and it is NOT derivable
from their returned fields, so reconciling it there would be a false comparison.
"""
from datetime import date, timedelta

import requests

from . import config


# Reconciliations intentionally NOT performed, with rationale (surfaced in the
# ``validation_audit`` cross_surface row for audit visibility). ``kpis.net_sales``
# is now the CANONICAL Net Sales (NET_SALES_CANON in api_pg.py: total_sales -
# discounts - returns, VAT-inclusive), NOT the stored per-row ``net_sales_kes``
# column (that ex-VAT figure is surfaced separately as "Net Sales ex-VAT").
# The breakdown endpoints (country-summary, sales-summary, daily-trend) do not
# expose net_sales, so it is reconciled ONLY against
# /analytics/total-sales-summary, which computes the SAME canonical expression.
INTENTIONAL_SKIPS = [
    "net_sales vs Σ country-summary/sales-summary/daily-trend: skipped -- those "
    "endpoints do not expose net_sales. kpis.net_sales is the canonical "
    "total - discounts - returns (VAT-incl) figure and is reconciled directly "
    "vs analytics/total-sales-summary, which uses the same NET_SALES_CANON SQL.",
    "product-analysis.active_styles vs range-mgmt.total_active_styles: skipped -- "
    "DIFFERENT 'active' definitions (PA active = lifecycle status: not manually "
    "retired and not gated to the 'Retire' tier; range-mgmt active = SOP-gated tier "
    "T1-T4), so they are not expected to match. Only the TOTAL styles-with-stock "
    "universe is reconciled across the two pages.",
    "product-analysis.retired_styles vs range-mgmt retired_rows: skipped -- "
    "DIFFERENT 'retired' definitions BY DESIGN (task #420). PA Retired = manually "
    "retired OR gated to the 'Retire' lifecycle tier; range-mgmt Retired = "
    "hard/manual retirement only. They are not expected to match -- only the TOTAL "
    "styles-with-stock universe (active+retired) is reconciled across the two pages.",
    "inventory-style-counts.total_styles vs product-analysis/range-mgmt total: "
    "skipped -- inventory-style-counts counts the sold(182d) UNION in-stock "
    "universe (includes sold-but-no-stock styles), a wider set than the "
    "stock-only universe of the Products/Range pages. Each is reconciled "
    "internally (active+retired==total) instead.",
    "product subcategory/sales breakdowns vs headline kpis units/sales: skipped -- "
    "the per-subcategory product breakdowns only cover items mapped to a product "
    "subcategory (dropping unmapped rows) and report NET sales under a 'total_sales' "
    "label, so they intentionally do not sum to the all-items headline KPIs.",
]


class _Skip(Exception):
    """A graceful, expected reason to stop (unreachable API, bad login, …)."""


_TOKEN = None


def _login(session: requests.Session) -> str:
    if not config.CROSS_SURFACE_LOGIN_PASSWORD:
        raise _Skip("no api credentials (SEED_ADMIN_PASSWORD unset)")
    try:
        r = session.post(
            config.CROSS_SURFACE_API_BASE + "/auth/login",
            json={"email": config.CROSS_SURFACE_LOGIN_EMAIL,
                  "password": config.CROSS_SURFACE_LOGIN_PASSWORD},
            timeout=config.CROSS_SURFACE_TIMEOUT_SEC)
    except requests.RequestException as e:
        raise _Skip(f"api unreachable: {e}")
    if r.status_code != 200:
        raise _Skip(f"login failed ({r.status_code})")
    tok = (r.json() or {}).get("token")
    if not tok:
        raise _Skip("login returned no token")
    return tok


def _get(session: requests.Session, path: str, params: dict, timeout: float = None):
    """GET a JSON endpoint, re-logging in once on a 401. Raises _Skip on failure.

    ``timeout`` overrides the default fast-endpoint budget (used for the heavy
    product-analysis scan, which has its own longer timeout)."""
    global _TOKEN
    tmo = timeout if timeout is not None else config.CROSS_SURFACE_TIMEOUT_SEC
    for attempt in (1, 2):
        headers = {"Authorization": f"Bearer {_TOKEN}"} if _TOKEN else {}
        try:
            r = session.get(config.CROSS_SURFACE_API_BASE + path, params=params,
                            headers=headers, timeout=tmo)
        except requests.RequestException as e:
            raise _Skip(f"GET {path}: {e}")
        if r.status_code == 401 and attempt == 1:
            _TOKEN = _login(session)
            continue
        if r.status_code != 200:
            raise _Skip(f"GET {path} -> {r.status_code}")
        try:
            return r.json()
        except ValueError as e:
            raise _Skip(f"GET {path}: bad json ({e})")
    raise _Skip(f"GET {path}: unauthorized after retry")


def _sum(rows, key: str) -> float:
    return sum(float((r or {}).get(key) or 0) for r in (rows or []))


def _filters(params: dict) -> dict:
    """Normalise the concrete filter context (date_from/date_to/country/channel)
    carried by a comparison, so every exception records EXACTLY which filters were
    applied (an empty value means the param was not applied to that endpoint)."""
    return {
        "date_from": (params or {}).get("date_from", ""),
        "date_to": (params or {}).get("date_to", ""),
        "country": (params or {}).get("country", ""),
        "channel": (params or {}).get("channel", ""),
    }


def _cmp(scenario, metric, identity, check_code, a, b, money, period, params):
    """Return an exception dict when observed ``a`` disagrees with expected ``b``
    beyond tolerance, else None. Severity: RED for a material money gap or a large
    relative gap, else AMBER. Cross-surface breaks are never auto-fixable.

    ``params`` is the concrete filter dict applied to this comparison; it is
    persisted (structured) on the exception so an investigation is deterministic.
    """
    a = float(a or 0)
    b = float(b or 0)
    gap = abs(a - b)
    denom = max(abs(a), abs(b))
    rel = gap / denom if denom else 0.0
    floor = config.CROSS_SURFACE_MONEY_FLOOR if money else config.CROSS_SURFACE_COUNT_FLOOR
    if rel <= config.CROSS_SURFACE_TOL or gap <= floor:
        return None
    money_gap = gap if money else 0.0
    severity = "red" if (money_gap >= config.MATERIALITY_KES
                         or rel >= config.CROSS_SURFACE_RED_REL) else "amber"
    filters = _filters(params)
    return {
        "tier": 1,
        "entity_type": "cross_surface",
        "entity": scenario,
        "subcategory": "__ALL__",
        "metric": metric,
        "period_date": period,
        "check_code": check_code,
        "broken_identity": identity,
        "observed": a,
        "expected_low": b * (1 - config.CROSS_SURFACE_TOL),
        "expected_high": b * (1 + config.CROSS_SURFACE_TOL),
        "materiality_kes": money_gap,
        "severity": severity,
        "auto_fixable": False,
        "diagnosis": {"classification": "DATA_ERROR", "source": "cross_surface",
                      "filters": filters,
                      "cause": f"{identity}: observed {a:,.2f} vs expected {b:,.2f} "
                               f"({rel * 100:.3f}% gap) under filters "
                               f"date_from={filters['date_from']} "
                               f"date_to={filters['date_to']} "
                               f"country={filters['country'] or 'ALL'} "
                               f"channel={filters['channel'] or 'ALL'}"},
        "raw_rows": {"scenario": scenario, "filters": filters,
                     "observed": a, "expected": b,
                     "abs_gap": gap, "rel_gap": rel},
    }


def _check_sales_scenario(session, name, params, period, out, include_country_summary):
    kpis = _get(session, "/kpis", params)
    tss = _get(session, "/analytics/total-sales-summary", params)

    # total-sales-summary shares the full kpis filter contract (date/country/
    # channel). net_sales is reconciled HERE (the only breakdown that exposes it).
    pairs = [
        ("total_sales", "kpis.total_sales == total-sales-summary.total_sales",
         "xsurf_kpis_vs_tss", kpis.get("total_sales"), tss.get("total_sales"), True, params),
        ("net_sales", "kpis.net_sales == total-sales-summary.net_sales",
         "xsurf_kpis_vs_tss", kpis.get("net_sales"), tss.get("net_sales"), True, params),
        ("gross_sales", "kpis.gross_sales == total-sales-summary.gross_sales",
         "xsurf_kpis_vs_tss", kpis.get("gross_sales"), tss.get("gross_sales"), True, params),
        ("total_orders", "kpis.total_orders == total-sales-summary.orders",
         "xsurf_kpis_vs_tss", kpis.get("total_orders"), tss.get("orders"), False, params),
        ("total_units", "kpis.total_units == total-sales-summary.units",
         "xsurf_kpis_vs_tss", kpis.get("total_units"), tss.get("units"), False, params),
    ]

    # daily-trend honours date_from/date_to/country (NOT channel). It exposes no
    # net_sales column → net_sales not reconcilable here (see INTENTIONAL_SKIPS).
    dt_params = {k: v for k, v in params.items()
                 if k in ("date_from", "date_to", "country")}
    dtrend = _get(session, "/daily-trend", dt_params)
    pairs += [
        ("total_sales", "kpis.total_sales == Σ daily-trend.total_sales",
         "xsurf_kpis_vs_daily_trend", kpis.get("total_sales"), _sum(dtrend, "total_sales"), True, dt_params),
        ("gross_sales", "kpis.gross_sales == Σ daily-trend.gross_sales",
         "xsurf_kpis_vs_daily_trend", kpis.get("gross_sales"), _sum(dtrend, "gross_sales"), True, dt_params),
        ("total_orders", "kpis.total_orders == Σ daily-trend.orders",
         "xsurf_kpis_vs_daily_trend", kpis.get("total_orders"), _sum(dtrend, "orders"), False, dt_params),
        ("total_units", "kpis.total_units == Σ daily-trend.units",
         "xsurf_kpis_vs_daily_trend", kpis.get("total_units"), _sum(dtrend, "units"), False, dt_params),
    ]

    # sales-summary honours date/country/channel — same filter contract as kpis.
    # It exposes no net_sales column → net_sales not reconcilable here.
    ssum = _get(session, "/sales-summary", params)
    pairs += [
        ("total_sales", "kpis.total_sales == Σ sales-summary.total_sales",
         "xsurf_kpis_vs_sales_summary", kpis.get("total_sales"), _sum(ssum, "total_sales"), True, params),
        ("gross_sales", "kpis.gross_sales == Σ sales-summary.gross_sales",
         "xsurf_kpis_vs_sales_summary", kpis.get("gross_sales"), _sum(ssum, "gross_sales"), True, params),
        ("total_orders", "kpis.total_orders == Σ sales-summary.orders",
         "xsurf_kpis_vs_sales_summary", kpis.get("total_orders"), _sum(ssum, "orders"), False, params),
        ("total_units", "kpis.total_units == Σ sales-summary.units_sold",
         "xsurf_kpis_vs_sales_summary", kpis.get("total_units"), _sum(ssum, "units_sold"), False, params),
    ]

    if include_country_summary:
        # country-summary takes date only — compare against the date-only kpis.
        # It exposes no net_sales column → net_sales not reconcilable here.
        cs_params = {k: v for k, v in params.items() if k in ("date_from", "date_to")}
        kpis_date = (kpis if set(params) <= {"date_from", "date_to"}
                     else _get(session, "/kpis", cs_params))
        csum = _get(session, "/country-summary", cs_params)
        pairs += [
            ("total_sales", "kpis.total_sales == Σ country-summary.total_sales",
             "xsurf_kpis_vs_country_summary", kpis_date.get("total_sales"), _sum(csum, "total_sales"), True, cs_params),
            ("gross_sales", "kpis.gross_sales == Σ country-summary.gross_sales",
             "xsurf_kpis_vs_country_summary", kpis_date.get("gross_sales"), _sum(csum, "gross_sales"), True, cs_params),
            ("total_orders", "kpis.total_orders == Σ country-summary.orders",
             "xsurf_kpis_vs_country_summary", kpis_date.get("total_orders"), _sum(csum, "orders"), False, cs_params),
            ("total_units", "kpis.total_units == Σ country-summary.units_sold",
             "xsurf_kpis_vs_country_summary", kpis_date.get("total_units"), _sum(csum, "units_sold"), False, cs_params),
        ]

    for metric, identity, code, a, b, money, fparams in pairs:
        exc = _cmp(name, metric, identity, code, a, b, money, period, fparams)
        if exc:
            out.append(exc)


def _check_inventory(session, period, out):
    inv = _get(session, "/inventory-summary", {})
    inv2 = _get(session, "/analytics/inventory-summary", {})
    checks = [
        ("inventory_units",
         "inventory-summary.total_units == analytics/inventory-summary.total_units",
         "xsurf_inventory_pair", inv.get("total_units"), inv2.get("total_units"), False),
        ("inventory_units",
         "inventory-summary.total_units == Σ by_location.units",
         "xsurf_inventory_by_location", inv.get("total_units"),
         _sum(inv.get("by_location"), "units"), False),
        ("inventory_units",
         "inventory-summary.total_units == Σ by_subcat.units",
         "xsurf_inventory_by_subcat", inv.get("total_units"),
         _sum(inv.get("by_subcat"), "units"), False),
    ]
    for metric, identity, code, a, b, money in checks:
        exc = _cmp("inventory", metric, identity, code, a, b, money, period, {})
        if exc:
            out.append(exc)


def _check_products(session, period, out):
    """Reconcile the product-page style/units/stock totals that MUST tally.

    These are universe-stable (no date filter, all-country) so the comparison is
    a structural one: a SQL drift that makes a breakdown chart stop summing to its
    page KPI, or makes the Products / Range pages disagree on the styles-with-stock
    count, surfaces here. Totals that differ BY DESIGN (different 'active'
    definitions, the wider inventory-style-counts universe, the unmapped-row
    subcategory sales breakdowns) are deliberately NOT compared -- see
    ``INTENTIONAL_SKIPS`` -- exactly as net_sales is excluded above.
    """
    # Fetch product-analysis under each lifecycle status filter. Task #420 made
    # Active/Retired a lifecycle PARTITION (Retired = manually retired OR gated to
    # the 'Retire' tier; Active = everything else in the stock-only universe), so
    # active_styles + retired_styles == styles must hold under EVERY filter and the
    # filtered universes must partition the 'all' universe exactly. See below.
    pa_by_status = {}
    for _status in ("all", "active", "retired"):
        pa_by_status[_status] = _get(
            session, "/analytics/product-analysis", {"style_status": _status},
            timeout=config.CROSS_SURFACE_PRODUCT_TIMEOUT_SEC)

    pa = pa_by_status["all"]
    pasum = pa.get("summary") or {}
    by_subcat = pa.get("by_subcategory")
    by_brand = pa.get("by_brand")

    # Invariant (task #420): within EACH status filter the lifecycle counts
    # partition the kept universe -> active_styles + retired_styles == styles.
    for _status in ("all", "active", "retired"):
        s = pa_by_status[_status].get("summary") or {}
        exc = _cmp(
            "products", "style_count",
            f"product-analysis[{_status}].active_styles + retired_styles == styles",
            f"xsurf_pa_partition_{_status}",
            float(s.get("active_styles") or 0) + float(s.get("retired_styles") or 0),
            s.get("styles"), False, period, {})
        if exc:
            out.append(exc)

    # And the two filtered slices must partition the 'all' universe: the active
    # filter must return exactly the 'all' active_styles (with zero retired), the
    # retired filter exactly the 'all' retired_styles (with zero active).
    _active_sum = pa_by_status["active"].get("summary") or {}
    _retired_sum = pa_by_status["retired"].get("summary") or {}

    # Range Management response (used for its internal checks below AND the
    # cross-page total in the cross-call block).
    rm = _get(session, "/range-mgmt/classify", {})

    # ---- Cross-CALL style-count identities (retry once on mismatch) --------
    # Each side of these three identities comes from a DIFFERENT HTTP response.
    # Every response is internally consistent, but the style universe is
    # stock-driven and all_inventory refreshes every ~5 min — so a refresh
    # landing between two calls (or between their cache fills) skews the pair
    # with ZERO calculation drift. The API now keys the product-analysis cache
    # on the inventory snapshot, so on a mismatch we refetch every involved
    # response ONCE and re-evaluate: a real definitional break reproduces
    # identically; transient snapshot skew heals and is not a finding.
    def _cross_call_checks(all_sum, act_sum, ret_sum, rm_resp):
        rm_rows = rm_resp.get("rows") or []
        rm_retired = rm_resp.get("retired_rows") or []
        return [
            ("product-analysis[active].styles == product-analysis[all].active_styles",
             "xsurf_pa_active_slice", act_sum.get("styles"), all_sum.get("active_styles")),
            ("product-analysis[retired].styles == product-analysis[all].retired_styles",
             "xsurf_pa_retired_slice", ret_sum.get("styles"), all_sum.get("retired_styles")),
            # Cross-PAGE: the Products / Product Analysis pages and the Range
            # Management page describe the SAME 'styles with current stock'
            # universe -- they must agree on its size.
            ("product-analysis.summary.styles == range-mgmt rows+retired_rows",
             "xsurf_pa_vs_rm_total", all_sum.get("styles"),
             len(rm_rows) + len(rm_retired)),
        ]

    def _eval_cross(checks):
        found = []
        for identity, code, a, b in checks:
            exc = _cmp("products", "style_count", identity, code, a, b, False, period, {})
            if exc:
                found.append(exc)
        return found

    cross_excs = _eval_cross(_cross_call_checks(pasum, _active_sum, _retired_sum, rm))
    if cross_excs:
        pa2 = {}
        for _status in ("all", "active", "retired"):
            pa2[_status] = _get(
                session, "/analytics/product-analysis", {"style_status": _status},
                timeout=config.CROSS_SURFACE_PRODUCT_TIMEOUT_SEC)
        rm2 = _get(session, "/range-mgmt/classify", {})
        cross_excs = _eval_cross(_cross_call_checks(
            pa2["all"].get("summary") or {},
            pa2["active"].get("summary") or {},
            pa2["retired"].get("summary") or {}, rm2))
    out.extend(cross_excs)
    checks = [
        # Product Analysis page: each breakdown chart must add up to the page KPI.
        ("style_count", "product-analysis.summary.styles == Σ by_subcategory.styles",
         "xsurf_pa_subcat_styles", pasum.get("styles"), _sum(by_subcat, "styles"), False),
        ("units", "product-analysis.summary.units == Σ by_subcategory.units",
         "xsurf_pa_subcat_units", pasum.get("units"), _sum(by_subcat, "units"), False),
        ("stock_units", "product-analysis.summary.stock_units == Σ by_subcategory.stock",
         "xsurf_pa_subcat_stock", pasum.get("stock_units"), _sum(by_subcat, "stock"), False),
        ("style_count", "product-analysis.summary.styles == Σ by_brand.styles",
         "xsurf_pa_brand_styles", pasum.get("styles"), _sum(by_brand, "styles"), False),
        ("units", "product-analysis.summary.units == Σ by_brand.units",
         "xsurf_pa_brand_units", pasum.get("units"), _sum(by_brand, "units"), False),
        ("stock_units", "product-analysis.summary.stock_units == Σ by_brand.stock",
         "xsurf_pa_brand_stock", pasum.get("stock_units"), _sum(by_brand, "stock"), False),
    ]
    for metric, identity, code, a, b, money in checks:
        exc = _cmp("products", metric, identity, code, a, b, money, period, {})
        if exc:
            out.append(exc)

    # Range Management page: the tier breakdown and the row list must both add up
    # to the active-styles total the page shows. (Internal to ONE response, so no
    # cross-call retry is needed.)
    rmsum = rm.get("summary") or {}
    tier_counts = rmsum.get("tier_counts") or {}
    active_total = rmsum.get("total_active_styles")
    rows = rm.get("rows") or []
    retired_rows = rm.get("retired_rows") or []
    rm_checks = [
        ("style_count", "range-mgmt.total_active_styles == Σ tier_counts",
         "xsurf_rm_tier_counts", active_total,
         sum(float(v or 0) for v in tier_counts.values()), False),
        ("style_count", "range-mgmt.total_active_styles == len(rows)",
         "xsurf_rm_active_rows", active_total, len(rows), False),
    ]
    for metric, identity, code, a, b, money in rm_checks:
        exc = _cmp("products", metric, identity, code, a, b, money, period, {})
        if exc:
            out.append(exc)

    # (xsurf_pa_vs_rm_total is evaluated in the cross-call block above, with the
    # same one-shot refetch as the slice-partition identities.)

    # inventory-style-counts internal invariant: active + retired == total.
    isc = _get(session, "/inventory-style-counts", {})
    exc = _cmp("products", "style_count",
               "inventory-style-counts.active+retired == total",
               "xsurf_isc_parts_sum",
               float(isc.get("active_styles") or 0) + float(isc.get("retired_styles") or 0),
               isc.get("total_styles"), False, period, {})
    if exc:
        out.append(exc)


def _ago(period: date, win: int) -> str:
    return str(period - timedelta(days=max(1, win) - 1))


def run_checks(period: date):
    """Run all cross-surface reconciliations. Returns ``(exceptions, skip_reason)``.

    Never raises: any unexpected error becomes a skip reason so the caller (the
    sync loop) is never destabilised by a flaky API or auth hiccup.
    """
    if not config.CROSS_SURFACE_ENABLED:
        return [], "disabled"
    if not config.CROSS_SURFACE_LOGIN_PASSWORD:
        return [], "no api credentials"

    global _TOKEN
    _TOKEN = None
    session = requests.Session()
    try:
        _TOKEN = _login(session)
    except _Skip as s:
        return [], str(s)
    except Exception as e:  # noqa: BLE001
        return [], f"login error: {e}"

    scenarios = []
    for win, label in ((30, "30d"), (7, "7d")):
        scenarios.append((f"{label}_all",
                          {"date_from": _ago(period, win), "date_to": str(period)},
                          True))
    for country in config.CROSS_SURFACE_COUNTRIES:
        scenarios.append((f"30d_{country.lower()}",
                          {"date_from": _ago(period, 30), "date_to": str(period),
                           "country": country},
                          False))

    exceptions, skips = [], []
    for name, params, inc_cs in scenarios:
        try:
            _check_sales_scenario(session, name, params, period, exceptions, inc_cs)
        except _Skip as s:
            skips.append(f"{name}: {s}")
        except Exception as e:  # noqa: BLE001
            skips.append(f"{name}: {e}")

    try:
        _check_inventory(session, period, exceptions)
    except _Skip as s:
        skips.append(f"inventory: {s}")
    except Exception as e:  # noqa: BLE001
        skips.append(f"inventory: {e}")

    try:
        _check_products(session, period, exceptions)
    except _Skip as s:
        skips.append(f"products: {s}")
    except Exception as e:  # noqa: BLE001
        skips.append(f"products: {e}")

    return exceptions, ("; ".join(skips) if skips else None)
