"""Canonical Net Sales consistency test.

Asserts that every surface labelled "Net Sales" / "Net Revenue" shows the SAME
figure for one fixed window — and that the Catalogue formula
(Net = (Total − Returns − Discounts) excluding VAT; Total already nets returns)
brackets it from the /api/kpis components: since the per-country VAT mix (16%
Kenya & Online, 18% Uganda/Rwanda) is not in the payload, the bridge is a band
[(total − discounts)/1.18 .. (total − discounts)/1.16] rather than an equality.
custom-report rounds each dimension row before the Σ, so it gets a small
per-row rounding tolerance; all other surfaces must match to the shilling.

Surfaces compared (all via the live API, same filters):
  1. /api/kpis                       net_sales            (Overview tile)
  2. /api/orders-summary             net                  (Sales Export summary)
  3. /api/analytics/product-analysis summary.net_revenue_canonical
  4. /api/custom-report              Σ net_revenue        (Custom Report; also the
                                                           Margin card reads /api/kpis)

Units Sold surfaces compared (canonical = gross ordered_item_quantity over
sale/order rows under BASE_FILTERS, i.e. the _UNITS measure):
  A. /api/kpis                            total_units          (Overview tile)
  B. /api/analytics/canonical-units-sold  units_sold           (canonical endpoint)
  C. /api/analytics/kpi-trend             Σ units_sold          (Trend page KPIs)
  D. /api/analytics/trend-series          Σ units_sold          (Trend page chart)
  E. /api/analytics/product-analysis      summary.units_canonical

Run:  python test_net_sales_consistency.py
Requires the api-server workflow running and SEED_ADMIN_PASSWORD in the env.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

BASE = os.environ.get("NET_TEST_BASE", "http://localhost:80/api")
DATE_FROM = os.environ.get("NET_TEST_FROM", "2026-06-01")
DATE_TO = os.environ.get("NET_TEST_TO", "2026-06-30")


def _req(path, token=None, method="GET", body=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read().decode())


def main():
    pw = os.environ.get("SEED_ADMIN_PASSWORD")
    email = os.environ.get("SEED_ADMIN_EMAIL", "admin@vivofashiongroup.com")
    if not pw:
        print("SKIP: SEED_ADMIN_PASSWORD not set")
        return 0
    token = _req("/auth/login", method="POST", body={"email": email, "password": pw})["token"]
    q = f"?date_from={DATE_FROM}&date_to={DATE_TO}"

    kpis = _req("/kpis" + q, token)
    osum = _req("/orders-summary" + q, token)
    pa = _req("/analytics/product-analysis" + q, token)
    rep = _req("/custom-report" + q + "&dims=country&measures=net_revenue", token)

    net_kpis = round(float(kpis["net_sales"]))
    net_export = round(float(osum["net"]))
    net_pa = round(float(pa["summary"]["net_revenue_canonical"]))
    net_report = round(sum(float(r["net_revenue"] or 0) for r in rep["rows"]))

    # Catalogue formula: Net = (Total (already net of returns) − Discounts)
    # ex-VAT. The exact figure depends on the per-country VAT mix (16% Kenya &
    # Online, 18% Uganda/Rwanda), so bound it between the two extremes instead
    # of asserting equality.
    bridge_base = float(kpis["total_sales"]) - float(kpis["total_discounts"])
    bridge_lo = round(bridge_base / 1.18)
    bridge_hi = round(bridge_base / 1.16)

    # Narrowed-PA contract: when the style universe is filtered (e.g. a brand),
    # summary.net_revenue_canonical must be omitted (None) — equality with the
    # window canonical is NOT expected there and the UI falls back to the
    # styles-scope sum labelled "(styles scope)".
    pa_rows = pa.get("rows") or []
    brands = sorted({(r.get("brand") or "") for r in pa_rows if r.get("brand")})
    pa_narrow_note = "no brand available to test narrowed PA"
    pa_narrow_fail = None
    if brands:
        pa_n = _req("/analytics/product-analysis" + q +
                    "&brand=" + urllib.parse.quote(brands[0]), token)
        s_n = pa_n.get("summary", {})
        pa_narrow_note = (f"narrowed PA (brand={brands[0]!r}): canonical="
                          f"{s_n.get('net_revenue_canonical')} styles-scope net="
                          f"{s_n.get('net_revenue')}")
        if s_n.get("net_revenue_canonical") is not None:
            pa_narrow_fail = ("narrowed PA returned net_revenue_canonical — "
                              "contract is None when the style universe is filtered")
        elif s_n.get("net_revenue") is None:
            pa_narrow_fail = "narrowed PA missing styles-scope net_revenue fallback"
        elif s_n.get("units_canonical") is not None:
            pa_narrow_fail = ("narrowed PA returned units_canonical — "
                              "contract is None when the style universe is filtered")

    # ---- Units Sold (canonical gross units) ------------------------------
    canon = _req("/analytics/canonical-units-sold" + q, token)
    trend = _req("/analytics/kpi-trend" + q + "&bucket=month", token)
    series = _req("/analytics/trend-series" + q + "&bucket=month", token)
    # Cache-immutability regression: a second call within the cache TTL must
    # return the SAME payload. The handlers once mutated cached row dicts
    # in-place (r.pop("bucket_date")), so the 2nd call 500'd / lost fields.
    trend2 = _req("/analytics/kpi-trend" + q + "&bucket=month", token)
    series2 = _req("/analytics/trend-series" + q + "&bucket=month", token)
    cache_fail = None
    if trend2 != trend:
        cache_fail = "kpi-trend second call within cache TTL differs (cached rows mutated)"
    elif series2 != series:
        cache_fail = "trend-series second call within cache TTL differs (cached rows mutated)"

    units_kpis = int(kpis["total_units"])
    units_canon = int(canon["units_sold"])
    units_trend = sum(int(r.get("units_sold") or 0) for r in trend)
    units_series = sum(int(r.get("units_sold") or 0) for r in series)
    units_pa = pa["summary"].get("units_canonical")

    unit_failures = []
    for name, val in [("canonical-units-sold", units_canon),
                      ("kpi-trend Σ units_sold", units_trend),
                      ("trend-series Σ units_sold", units_series),
                      ("PA summary units_canonical",
                       int(units_pa) if units_pa is not None else None)]:
        if val is None:
            unit_failures.append(f"{name} missing (expected {units_kpis:,})")
        elif val != units_kpis:
            unit_failures.append(f"{name} = {val:,} != kpis total_units {units_kpis:,}")

    failures = []
    failures.extend(unit_failures)
    if cache_fail:
        failures.append(cache_fail)
    if pa_narrow_fail:
        failures.append(pa_narrow_fail)
    for name, val in [("orders-summary net", net_export),
                      ("product-analysis canonical", net_pa)]:
        if val != net_kpis:
            failures.append(f"{name} = {val:,} != kpis net_sales {net_kpis:,}")
    # custom-report rounds each dimension row before the Σ, so the ex-VAT
    # division allows ±0.5/row of rounding drift vs round-of-total.
    report_tol = max(2, -(-len(rep["rows"]) // 2) + 1)
    if abs(net_report - net_kpis) > report_tol:
        failures.append(f"custom-report Σ net_revenue = {net_report:,} != "
                        f"kpis net_sales {net_kpis:,} (tol {report_tol})")
    if not (bridge_lo - 2 <= net_kpis <= bridge_hi + 2):
        failures.append(
            f"catalogue bridge: net {net_kpis:,} outside ex-VAT band "
            f"[{bridge_lo:,} .. {bridge_hi:,}] of (total − discounts)")

    print(f"Window {DATE_FROM}..{DATE_TO}: kpis net_sales = {net_kpis:,}")
    print(f"  orders-summary: {net_export:,} | PA canonical: {net_pa:,} | "
          f"custom-report: {net_report:,} | bridge band: {bridge_lo:,}..{bridge_hi:,}")
    print(f"  {pa_narrow_note}")
    print(f"Units: kpis total_units = {units_kpis:,} | canonical: {units_canon:,} | "
          f"kpi-trend: {units_trend:,} | trend-series: {units_series:,} | "
          f"PA canonical: {units_pa if units_pa is None else format(int(units_pa), ',')}")
    if failures:
        print("FAIL:\n  " + "\n  ".join(failures))
        return 1
    print("PASS: all Net Sales + Units Sold surfaces identical.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
