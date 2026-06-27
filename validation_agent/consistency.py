"""Step 1 -- hard arithmetic consistency checks (Tier-1 / structural).

Each check recomputes an identity from the base measures and asserts it holds
within tolerance. A break beyond tolerance is a Tier-1 exception.

Two of the spec's identities are resolved against this database's actual columns
(the spec told us to infer ambiguous definitions and report them):

* ``conversion_rate`` is scoped as transactions / footfall (the footfall feed's
  own conversion column is empty). The structural assertion is conversion <= 1 --
  you cannot have more transactions than visitors.
* ``total_sales - net_sales`` is NOT returns + discounts in this schema: returns
  and discounts are already removed from ``net_sales``, and ``total_sales`` is
  VAT-inclusive. So the tax identity is checked as
  ``total_sales ~= net_sales * (1 + VAT_RATE)`` and the net composition is checked
  separately as ``net_sales ~= gross_sales - discounts - returns``.
"""
from . import config


def _rel(a, b):
    a = float(a or 0)
    b = float(b or 0)
    denom = max(abs(a), abs(b))
    if denom == 0:
        return 0.0
    return abs(a - b) / denom


def _exc(code, identity, observed, exp_lo, exp_hi, materiality=0.0):
    return {
        "tier": 1,
        "check_code": code,
        "broken_identity": identity,
        "observed": observed,
        "expected_low": exp_lo,
        "expected_high": exp_hi,
        "materiality_kes": float(materiality or 0.0),
    }


def check_row(m: dict) -> list[dict]:
    """Return a list of failed checks for one metric row (empty == all passed)."""
    fails = []
    tol = config.CONSISTENCY_TOL
    mtol = config.MONEY_TOL
    total = float(m["total_sales"] or 0)
    net = float(m["net_sales"] or 0)
    gross = float(m["gross_sales"] or 0)
    disc = float(m["discounts"] or 0)
    ret = float(m["return_amount"] or 0)
    units = int(m["units_sold"] or 0)
    txn = int(m["transactions"] or 0)
    ff = m["footfall"]

    has_sales = total >= config.MIN_SALES_KES and txn >= config.MIN_TXN

    if has_sales and m["msi"] is not None:
        recon = txn * float(m["msi"])
        if _rel(units, recon) > tol:
            fails.append(_exc("units_eq_txn_x_msi",
                              "units_sold = transactions * msi", units, recon * (1 - tol),
                              recon * (1 + tol)))
    if has_sales and m["abv"] is not None:
        recon = txn * float(m["abv"])
        if _rel(total, recon) > tol:
            fails.append(_exc("total_eq_abv_x_txn",
                              "total_sales = abv * transactions", total,
                              recon * (1 - tol), recon * (1 + tol),
                              abs(total - recon)))
    if has_sales and units > 0 and m["asp"] is not None:
        recon = units * float(m["asp"])
        if _rel(total, recon) > tol:
            fails.append(_exc("total_eq_asp_x_units",
                              "total_sales = asp * units_sold", total,
                              recon * (1 - tol), recon * (1 + tol),
                              abs(total - recon)))

    if net > total * (1 + tol) and total > 0:
        fails.append(_exc("net_le_total", "net_sales <= total_sales", net,
                          None, total, abs(net - total)))

    if total > config.MIN_SALES_KES:
        expected_total = net * (1 + config.VAT_RATE)
        if _rel(total, expected_total) > mtol:
            fails.append(_exc("vat_reconciliation",
                              f"total_sales = net_sales * (1 + {config.VAT_RATE})",
                              total, expected_total * (1 - mtol),
                              expected_total * (1 + mtol),
                              abs(total - expected_total)))
        # net_sales must reconcile with the (gross - discounts - returns)
        # composition. all_sales carries TWO VAT conventions that no column cleanly
        # keys (some rows record gross VAT-EXCLUSIVE, others VAT-INCLUSIVE), so the
        # naive "net = gross - disc - returns" is off by the VAT rate (~13.5%) for
        # roughly half the stores EVERY day while over-correcting the other half if
        # we blindly divide by (1+VAT). The expected composition is therefore built
        # per-row on each row's own VAT basis and summed in SQL (see
        # metrics.compute / expected_net_comp), which reconciles to ~2% group-wide
        # and per-store while a genuine break still blows past NET_COMP_TOL (6%).
        expected_net = float(m.get("expected_net_comp") or 0.0)
        if _rel(net, expected_net) > config.NET_COMP_TOL:
            fails.append(_exc("net_composition",
                              "net_sales = sum_rows((gross - discounts - returns) on row VAT basis)",
                              net, expected_net * (1 - mtol),
                              expected_net * (1 + mtol),
                              abs(net - expected_net)))

    if ff and ff >= config.MIN_FOOTFALL and m["conversion_rate"] is not None:
        conv = float(m["conversion_rate"])
        if conv > 1 + tol:
            fails.append(_exc("conversion_le_one",
                              "conversion_rate = transactions/footfall <= 1",
                              conv, 0.0, 1.0))

    if has_sales and m["return_rate"] is not None:
        recon = _safe_div(ret, total)
        if recon is not None and _rel(m["return_rate"], recon) > tol:
            fails.append(_exc("return_rate_identity",
                              "return_rate = return_amount/total_sales",
                              float(m["return_rate"]), recon * (1 - tol),
                              recon * (1 + tol)))
    return fails


def _safe_div(a, b):
    a = float(a or 0)
    b = float(b or 0)
    return a / b if b else None
