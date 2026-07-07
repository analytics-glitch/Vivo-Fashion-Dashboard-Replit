"""Pure comparison logic for the nightly cross-page reconciliation (WS9 T904).

Kept free of DB/FastAPI imports so it can be unit-tested with divergent
inputs (see test_dq_cross_compare.py). api_pg.py feeds it the outputs of the
three REAL production paths:
  * kpi          — dict from GET /api/kpis (get_kpis)
  * country_rows — list from GET /api/country-summary (get_country_summary)
  * trend_rows   — list of buckets from GET /api/analytics/trend-series
                   (get_trend_series), rolled up here.
A failure therefore means two live pages disagree on the same window.
"""


def cross_surface_compare(kpi, country_rows, trend_rows, window_label=""):
    """Return a list of {check_name, status, detail} asserting the WS1-2
    identities: Total/Net Sales and canonical GROSS units equal across the
    Overview KPIs, the Locations country summary and the Trend series."""
    country_rows = country_rows or []
    trend_rows = trend_rows or []

    k_total = float(kpi.get("total_sales") or 0)
    k_net = float(kpi.get("net_sales") or 0)
    k_units = int(kpi.get("total_units") or 0)

    c_total = sum(float(r.get("total_sales") or 0) for r in country_rows)
    c_units = sum(int(r.get("units_sold") or 0) for r in country_rows)

    t_total = sum(float(r.get("total_sales") or 0) for r in trend_rows)
    t_net = sum(float(r.get("net_sales") or 0) for r in trend_rows)
    t_units = sum(int(r.get("units_sold") or 0) for r in trend_rows)

    # Each surface ROUND()s per group (per country / per trend bucket), so the
    # rolled-up sums may differ from the single-group KPI figure by up to
    # ±0.5 KES per group. Units are integers — exact equality required.
    tol_country = max(1.0, 0.5 * max(1, len(country_rows)) + 0.5)
    tol_trend = max(1.0, 0.5 * max(1, len(trend_rows)) + 0.5)

    checks = []

    def add(name, ok, detail):
        checks.append({
            "check_name": name,
            "status": "ok" if ok else "fail",
            "detail": (window_label + ": " if window_label else "") + detail,
        })

    add("total_sales_overview_vs_locations",
        abs(k_total - c_total) <= tol_country,
        f"kpis={k_total:,.0f} vs country-summary sum={c_total:,.0f}"
        f" (tol {tol_country:,.1f})")
    add("total_sales_overview_vs_trend",
        abs(k_total - t_total) <= tol_trend,
        f"kpis={k_total:,.0f} vs trend-series sum={t_total:,.0f}"
        f" (tol {tol_trend:,.1f})")
    add("net_sales_overview_vs_trend",
        abs(k_net - t_net) <= tol_trend,
        f"kpis={k_net:,.0f} vs trend-series sum={t_net:,.0f}"
        f" (tol {tol_trend:,.1f})")
    add("units_overview_vs_locations",
        k_units == c_units,
        f"kpis={k_units:,} vs country-summary sum={c_units:,}"
        " (canonical GROSS units)")
    add("units_overview_vs_trend",
        k_units == t_units,
        f"kpis={k_units:,} vs trend-series sum={t_units:,}"
        " (canonical GROSS units)")
    return checks
