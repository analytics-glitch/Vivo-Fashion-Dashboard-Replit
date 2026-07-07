"""Step 2 -- learned-range ("muscle memory") checks.

``metric_baselines`` stores per (entity, subcategory, metric, date) the validated
daily value plus its day-of-week and promo flag. Statistics (mean, std, median,
IQR, p1, p99) are derived at check time from the trailing window so they are
always fresh; they are also logged to ``validation_audit`` for traceability.

Bands are seasonality-aware: stats are computed within the matching (day-of-week,
promo) bucket when enough points exist, otherwise they fall back to the full
trailing window. A day's value is folded into the baseline ONLY after it passes
the Tier-1 consistency checks, so a bad day never poisons "normal".

To stay fast against a remote database, history is loaded once per run into an
in-memory index and inserts are batched with execute_values.
"""
import statistics
from datetime import date, timedelta

import psycopg2.extras

from . import config, db


def _promo_dates() -> set:
    out = set()
    for rng in config.PROMO_RANGES:
        try:
            a, b = rng.split(":")
            d0 = date.fromisoformat(a.strip())
            d1 = date.fromisoformat(b.strip())
            cur = d0
            while cur <= d1:
                out.add(cur)
                cur += timedelta(days=1)
        except Exception:
            continue
    return out


PROMO = _promo_dates()


def is_promo(d: date) -> bool:
    return d in PROMO


def count_points(conn) -> int:
    """Total rows in metric_baselines — used to detect an un-seeded (fresh) DB."""
    with db.cursor(conn) as cur:
        cur.execute("SELECT count(*) AS n FROM metric_baselines")
        return int(cur.fetchone()["n"])


def fold(conn, rows: list[dict], blocked: set) -> int:
    """Upsert validated metric values into metric_baselines (batched).

    ``blocked`` is the set of (entity_type, entity, subcategory, period_date) that
    failed a Tier-1 check and must NOT be folded.
    """
    payload = []
    for m in rows:
        key = (m["entity_type"], m["entity"], m["subcategory"], m["period_date"])
        if key in blocked:
            continue
        d = m["period_date"]
        dow = d.weekday()
        promo = is_promo(d)
        for metric in config.METRICS:
            val = m.get(metric)
            if val is None:
                continue
            payload.append((m["entity_type"], m["entity"], m["subcategory"],
                            metric, d, float(val), dow, promo))
    if not payload:
        return 0
    with db.cursor(conn) as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO metric_baselines
                (entity_type, entity, subcategory, metric, period_date, value, dow, is_promo)
            VALUES %s
            ON CONFLICT (entity_type, entity, subcategory, metric, period_date)
            DO UPDATE SET value = EXCLUDED.value, dow = EXCLUDED.dow,
                          is_promo = EXCLUDED.is_promo, folded_at = now()
            """,
            payload, page_size=1000,
        )
    return len(payload)


def load_index(conn, upto: date) -> dict:
    """Load all baseline points in the trailing window into memory.

    Returns {(entity_type, entity, subcategory, metric): [ (date, value), ... ]}
    keyed for fast per-day stat computation. Bucketed lookups slice this list.
    """
    win_start = upto - timedelta(days=config.BASELINE_WINDOW_DAYS)
    idx: dict = {}
    with db.cursor(conn) as cur:
        cur.execute(
            """
            SELECT entity_type, entity, subcategory, metric, period_date,
                   value, dow, is_promo
            FROM metric_baselines
            WHERE period_date >= %s AND period_date <= %s
            ORDER BY period_date
            """,
            [win_start, upto],
        )
        for r in cur.fetchall():
            key = (r["entity_type"], r["entity"], r["subcategory"], r["metric"])
            idx.setdefault(key, []).append(
                (r["period_date"], float(r["value"]) if r["value"] is not None else None,
                 r["dow"], r["is_promo"]))
    return idx


def _stats(values: list[float]) -> dict | None:
    vals = [v for v in values if v is not None]
    if len(vals) < config.MIN_HISTORY_POINTS:
        return None
    vals_sorted = sorted(vals)
    n = len(vals_sorted)

    def pct(p):
        if n == 1:
            return vals_sorted[0]
        i = (p / 100.0) * (n - 1)
        lo = int(i)
        hi = min(lo + 1, n - 1)
        frac = i - lo
        return vals_sorted[lo] * (1 - frac) + vals_sorted[hi] * frac

    q1, q3 = pct(25), pct(75)
    return {
        "n": n,
        "mean": statistics.fmean(vals_sorted),
        "std": statistics.pstdev(vals_sorted) if n > 1 else 0.0,
        "median": statistics.median(vals_sorted),
        "q1": q1, "q3": q3, "iqr": q3 - q1,
        "p1": pct(config.PCT_LOW), "p99": pct(config.PCT_HIGH),
    }


def check_row(m: dict, index: dict) -> list[dict]:
    """Learned-range checks for one metric row using the in-memory index."""
    fails = []
    d = m["period_date"]
    dow = d.weekday()
    promo = is_promo(d)
    win_start = d - timedelta(days=config.BASELINE_WINDOW_DAYS)
    for metric in config.METRICS:
        val = m.get(metric)
        if val is None:
            continue
        val = float(val)
        # net_comp_residual is already built on each row's own VAT basis (see
        # metrics.expected_net_comp), so within the reconciliation tolerance it is
        # definitional noise oscillating around zero. Range-checking a ~0 series
        # turns every tiny wiggle into a huge z (and a PERFECT 0 reconciliation into
        # a "-100% drop"), so only surface a residual that actually exceeds the same
        # tolerance the Tier-1 net_composition identity uses.
        if metric == "net_comp_residual" and abs(val) <= config.NET_COMP_TOL:
            continue
        series = index.get((m["entity_type"], m["entity"], m["subcategory"], metric))
        if not series:
            continue
        prior = [(pd, v) for (pd, v, _dw, _pr) in series
                 if pd < d and pd >= win_start and v is not None]
        if not prior:
            continue
        bucket = [v for (pd, v, dw, pr) in series
                  if pd < d and pd >= win_start and v is not None
                  and dw == dow and pr == promo]
        st = _stats(bucket)
        if st is None:
            st = _stats([v for (_pd, v) in prior])
        if st is None:
            continue

        # Minimum-volume gate for ratio/average metrics: on a very thin day
        # (a couple of transactions) abv/asp/msi/return_rate are mathematically
        # correct but statistically meaningless — one bulk basket or one refund
        # swings them far outside any learned band. Report the day ONCE as an
        # informational low-volume note instead of a range anomaly per metric.
        txn = float(m.get("transactions") or 0)
        if metric in config.RATIO_METRICS and txn < config.RATIO_MIN_TXN:
            if not any(f.get("check_code") == "low_volume" for f in fails):
                fails.append({
                    "tier": 2, "metric": metric, "check_code": "low_volume",
                    "broken_identity": (
                        f"only {txn:.0f} transaction(s) — ratio metrics skipped "
                        f"(min {config.RATIO_MIN_TXN})"),
                    "observed": val, "expected_low": st["p1"],
                    "expected_high": st["p99"], "materiality_kes": 0.0,
                    "informational": True,
                })
            continue

        reasons = []
        # Independent signal FAMILIES (not raw signals) that agree on this point.
        z = (val - st["mean"]) / st["std"] if st["std"] > 0 else 0.0
        z_hit = st["std"] > 0 and abs(z) > config.Z_THRESHOLD
        if z_hit:
            reasons.append(f"z={z:.1f}")

        # Non-parametric band. A finding REQUIRES an actual p1-p99 band breach —
        # PoP, z or the Tukey fence alone must never raise one (findings once
        # fired "outside IQR fence + PoP" while the value sat INSIDE the learned
        # band). The band edges carry a materiality margin (BAND_MARGIN, default
        # 5% of the edge magnitude) so a value a few percent above a record p99
        # is tolerated as a strong-but-real day. The Tukey fence is recorded as
        # corroborating context only, never as an independent trigger.
        pad_lo = abs(st["p1"]) * config.BAND_MARGIN
        pad_hi = abs(st["p99"]) * config.BAND_MARGIN
        band_hit = val < st["p1"] - pad_lo or val > st["p99"] + pad_hi
        if band_hit:
            reasons.append("outside p1-p99 (with margin)")
            lo = st["q1"] - config.IQR_K * st["iqr"]
            hi = st["q3"] + config.IQR_K * st["iqr"]
            if st["iqr"] > 0 and (val < lo or val > hi):
                reasons.append("outside IQR fence")
        np_hit = band_hit

        # Seasonal period-over-period: compare to the most recent prior value in the
        # SAME (day-of-week, promo) bucket — NOT literally yesterday. Retail swings
        # hugely across the week (a Friday after a quiet Thursday is a routine +130%),
        # so a calendar-adjacent PoP fired on nearly every store every day. PoP is
        # corroboration only: it can confirm a distribution anomaly, never raise one
        # alone. (`bucket` is the same-weekday history, ascending by date.)
        pop = None
        pop_hit = False
        # Require enough same-weekday history before PoP may corroborate — a 1-point
        # seasonal slice (possible when stats fell back to the full window) is too
        # noisy to confirm an anomaly.
        base = bucket[-1] if len(bucket) >= config.MIN_BUCKET_POINTS else None
        if base is not None and abs(base) > 0:
            pop = (val - base) / abs(base)
            if abs(pop) > config.POP_CAP:
                pop_hit = True
                reasons.append(f"PoP {pop*100:.0f}% vs same weekday")

        # Fire only on agreement: one EXTREME parametric outlier, or >= 2 independent
        # families confirming each other. A clean row-doubling trips z + band + PoP
        # together (and leaves the abv/asp/msi ratios intact, so Tier-1 can't see it),
        # while a record-but-consistent trading day only nudges the band and stays
        # quiet. Legacy "any single signal" behaviour is available via config.
        families = int(z_hit) + int(np_hit) + int(pop_hit)
        severe = st["std"] > 0 and abs(z) >= config.Z_SEVERE
        if config.REQUIRE_CONSENSUS:
            # The band breach is MANDATORY: an extreme z or z+PoP agreement with
            # the observed value still inside the learned p1-p99 band is a
            # distribution quirk, not an anomaly (a tight low-variance history
            # makes small moves look like huge z-scores).
            fire = band_hit and (severe or families >= 2)
        else:
            fire = bool(reasons)

        if fire and reasons:
            materiality = abs(val - st["mean"]) if metric in config.MONEY_METRICS else 0.0
            fails.append({
                "tier": 2, "metric": metric, "check_code": "learned_range",
                "broken_identity": "; ".join(reasons), "observed": val,
                "expected_low": st["p1"], "expected_high": st["p99"],
                "materiality_kes": float(materiality), "stats": st, "z": z, "pop": pop,
            })
    return fails
