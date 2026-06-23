#!/usr/bin/env python3
"""
reconciliation_audit.py
Daily self-audit: re-runs the KPI reconciliations proven by hand and writes a
dated PASS/FAIL report to logs/reconciliation/YYYY-MM-DD.json.
Imports api_pg directly (no auth) so it tests the real query functions.
"""
import os, json, datetime, traceback
import api_pg

OUT_DIR = "logs/reconciliation"
TOL = 2  # shillings/units rounding tolerance

def rows_of(x):
    if isinstance(x, str):
        try: x = json.loads(x)
        except: return []
    if isinstance(x, dict): return [x]
    return x or []

def col_sum(x, k):
    return round(sum(float(r.get(k) or 0) for r in rows_of(x) if isinstance(r, dict)), 0)

def windows(today):
    y = today - datetime.timedelta(days=1)
    d7 = today - datetime.timedelta(days=7)
    mtd = today.replace(day=1)
    f = lambda d: d.isoformat()
    return {
        "yesterday": (f(y), f(y)),
        "last_7d":   (f(d7), f(today)),
        "mtd":       (f(mtd), f(today)),
    }

def near(a, b): return abs((a or 0) - (b or 0)) <= TOL

def run_window(name, frm, to):
    checks = []
    def add(check, ok, detail): checks.append({"check": check, "pass": bool(ok), "detail": detail})

    # canonical KPI block
    k = rows_of(api_pg.get_kpis(frm, to, None, None))
    k = k[0] if k else {}
    ts  = float(k.get("total_sales") or 0)
    tu  = float(k.get("total_units") or 0)
    to_ = float(k.get("total_orders") or 0)

    cs = api_pg.get_country_summary(frm, to)
    ss = api_pg.get_sales_summary(frm, to, None, None)

    # 1. Total Sales agreement
    dt = col_sum(api_pg.get_daily_trend(frm, to, None), "total_sales")
    tss = rows_of(api_pg.analytics_total_sales_summary(frm, to, None, None))
    tss = float(tss[0].get("total_sales") or 0) if tss else 0
    add("total_sales: kpis == country-summary", near(ts, col_sum(cs, "total_sales")), {"kpis": ts, "country": col_sum(cs, "total_sales")})
    add("total_sales: kpis == sales-summary",   near(ts, col_sum(ss, "total_sales")), {"kpis": ts, "sales": col_sum(ss, "total_sales")})
    add("total_sales: kpis == daily-trend",     near(ts, dt), {"kpis": ts, "trend": dt})
    add("total_sales: kpis == total-sales-summary", near(ts, tss), {"kpis": ts, "tss": tss})

    # 2. Units agreement
    add("units: kpis == country-summary", near(tu, col_sum(cs, "units_sold")), {"kpis": tu, "country": col_sum(cs, "units_sold")})
    add("units: kpis == sales-summary",   near(tu, col_sum(ss, "units_sold")), {"kpis": tu, "sales": col_sum(ss, "units_sold")})

    # 3. Orders agreement
    add("orders: kpis == country-summary", near(to_, col_sum(cs, "orders")), {"kpis": to_, "country": col_sum(cs, "orders")})
    add("orders: kpis == sales-summary",   near(to_, col_sum(ss, "orders")), {"kpis": to_, "sales": col_sum(ss, "orders")})

    # 4. Customers: new + returning == total
    c = rows_of(api_pg.get_customers(frm, to, None, None))
    c = c[0] if c else {}
    cn, cr, ct = float(c.get("new_customers") or 0), float(c.get("returning_customers") or 0), float(c.get("total_customers") or 0)
    add("customers: new + returning == total", near(cn + cr, ct), {"new": cn, "returning": cr, "total": ct})

    return checks

def global_checks():
    """Window-independent checks (product master integrity)."""
    checks = []
    def q(sql):
        r = api_pg.run_query(sql)
        r = rows_of(r)
        return int(r[0].get("n") or 0) if r else 0
    # Merchandise only — exclude Accessories / Sample & Sale (fabrics, masks, trims
    # legitimately share a style_name across many style_numbers). Mirrors the
    # MERCH_SUBCATEGORIES universe the KPIs report on.
    merch = api_pg.MERCH_SUBCATEGORIES_SQL
    for col in ("collection", "brand", "style_number"):
        n = q("SELECT COUNT(*) AS n FROM (SELECT p.style_name FROM all_products_clean p "
              "WHERE p.style_name IS NOT NULL AND p.product_type IN (" + merch + ") "
              "GROUP BY p.style_name HAVING COUNT(DISTINCT p.%s) > 1) x" % col)
        checks.append({"check": "product master (merch): one %s per style" % col, "pass": n == 0, "detail": {"split_styles": n}})
    return checks

def main():
    today = datetime.date.today()
    report = {"generated_at": datetime.datetime.utcnow().isoformat() + "Z",
              "date": today.isoformat(), "windows": {}, "global": [], "summary": {}}
    try:
        for name, (frm, to) in windows(today).items():
            report["windows"][name] = {"range": [frm, to], "checks": run_window(name, frm, to)}
        report["global"] = global_checks()
    except Exception as e:
        report["error"] = str(e) + "\n" + traceback.format_exc()

    all_checks = [c for w in report["windows"].values() for c in w["checks"]] + report["global"]
    passed = sum(1 for c in all_checks if c["pass"])
    report["summary"] = {"total": len(all_checks), "passed": passed,
                         "failed": len(all_checks) - passed,
                         "status": "PASS" if passed == len(all_checks) and "error" not in report else "FAIL"}

    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, today.isoformat() + ".json")
    with open(path, "w") as f: json.dump(report, f, indent=2, default=str)
    # also write latest.json for the endpoint
    with open(os.path.join(OUT_DIR, "latest.json"), "w") as f: json.dump(report, f, indent=2, default=str)
    print("%s  %s/%s passed -> %s" % (report["summary"]["status"], passed, len(all_checks), path))

if __name__ == "__main__":
    main()
