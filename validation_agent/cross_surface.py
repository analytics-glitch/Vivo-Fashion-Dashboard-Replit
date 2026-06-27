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
# sums the stored per-row ``net_sales_kes`` column (a VAT / structurally-adjusted
# figure), which is NOT equal to gross_sales - discounts - returns derived from
# the breakdown endpoints' returned fields (empirically ~9% apart). Those
# endpoints do not expose net_sales at all, so net_sales is not derivable there
# and is reconciled ONLY against /analytics/total-sales-summary, which exposes it.
INTENTIONAL_SKIPS = [
    "net_sales vs Σ country-summary/sales-summary/daily-trend: skipped -- those "
    "endpoints do not expose net_sales and it is not derivable from their fields "
    "(gross-discounts-returns != stored net_sales_kes). net_sales is reconciled "
    "directly vs analytics/total-sales-summary.",
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


def _get(session: requests.Session, path: str, params: dict):
    """GET a JSON endpoint, re-logging in once on a 401. Raises _Skip on failure."""
    global _TOKEN
    for attempt in (1, 2):
        headers = {"Authorization": f"Bearer {_TOKEN}"} if _TOKEN else {}
        try:
            r = session.get(config.CROSS_SURFACE_API_BASE + path, params=params,
                            headers=headers, timeout=config.CROSS_SURFACE_TIMEOUT_SEC)
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

    return exceptions, ("; ".join(skips) if skips else None)
