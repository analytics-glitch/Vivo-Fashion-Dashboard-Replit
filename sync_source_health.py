"""Per-source sales-feed staleness classification (pure logic, no DB).

Why this exists: on 13-Aug-2026 ~20:10 EAT the Odoo integration login lost POS
read access upstream. Every pull failed on the first fetch, the error was
swallowed as a console-only log line, and Kenya sales (the dominant market)
froze for 19+ hours while every topbar badge stayed green — "Sync · 4m ago"
measures loop heartbeat and "Upstream OK" measures API→Postgres health;
nothing watched per-source data freshness. This module is that missing watch.

What MAX(loaded_at) per store actually measures
-----------------------------------------------
Every successful pull REWRITES its whole anchor window with a fresh
loaded_at, independent of new orders:

* the ~60s sales worker rewrites orders written/updated in its 30-min sliding
  window (fresh every minute during active trading);
* the main cycle (~45-90 min, 24/7) re-pulls the wide self-healing anchor
  (MAX(sale_date) − LOOKBACK for Shopify, LEAST(loaded_at, sale_date) − 1d for
  Odoo) and rewrites all of it — verified: Rwanda's 12–14 Aug rows all carry
  one single fresh stamp, Kenya's whole 12-Aug day carries the stamp of the
  last successful cycle pass;
* the Shop Zetu ShopifyQL extract rewrites its full ~4-day window every ~5 min
  around the clock (observed stamps at 00:02 and 03:55 EAT).

So a frozen MAX(loaded_at) means PULLS ARE FAILING (or landing nothing), not
"business is quiet". That lets thresholds stay small even for low-volume
stores (Rwanda averages ~11 orders/day with 4-5h intra-day order gaps — but
its loaded_at still advances every main cycle while pulls succeed).

Why trading-hours gating is still required
------------------------------------------
Overnight the sync can legitimately slow down (heavy nightly jobs, recovery
backfills that suspend the supervised loop, long image crawls), and a source
that is merely closed must never page anyone. Staleness therefore accrues
ONLY inside each source's EAT trading window: a source frozen at 23:00 shows
up shortly after opening time, not at 03:00.

Thresholds (trading minutes, calibrated 2026-08-14)
---------------------------------------------------
* Kenya Odoo POS: worker keeps it minute-fresh during trading and volume is
  ~330 orders/day — 2h of trading silence is a real outage (task requirement:
  degrade within ~2h).
* Uganda/Rwanda Shopify: quiet stretches ride on the main cycle (45-90 min,
  occasionally longer), so 3h gives ×2 headroom over the slowest healthy
  cycle.
* Shop Zetu ShopifyQL: rewrites every ~5 min 24/7 — 1.5h frozen inside its
  wide online window means the extract is dead.
* Escalation: any stale source goes CRITICAL once the crit trading budget is
  burned OR the data is >12h old wall-clock (a 19h freeze must be red, not
  amber, the moment the morning window opens).

The retired `vivowoman` store (frozen mid-July 2026 by design, Kenya POS
moved to Odoo on 2026-03-20) is deliberately NOT in the registry: it must
never alarm, and new store_ids only participate once added here.
"""

from datetime import datetime, time as _time, timedelta, timezone

EAT = timezone(timedelta(hours=3))  # Africa/Nairobi — no DST

# Active sales sources. store_id == all_sales.store_id (and the `source` tag
# used by sync_incremental's failure trail in sync_health_log).
SOURCES = [
    {
        "store_id": "vivofashiongroup",
        "label": "Kenya POS (Odoo)",
        "short_label": "Kenya feed",
        "open_min": 9 * 60 + 30,   # 09:30 EAT
        "close_min": 20 * 60 + 30, # 20:30 EAT
        "warn_trading_min": 120,
        "crit_trading_min": 300,
    },
    {
        "store_id": "vivo-uganda",
        "label": "Uganda (Shopify)",
        "short_label": "Uganda feed",
        "open_min": 10 * 60,
        "close_min": 20 * 60,
        "warn_trading_min": 180,
        "crit_trading_min": 360,
    },
    {
        "store_id": "vivo-rwanda",
        "label": "Rwanda (Shopify)",
        "short_label": "Rwanda feed",
        "open_min": 10 * 60,
        "close_min": 20 * 60,
        "warn_trading_min": 180,
        "crit_trading_min": 360,
    },
    {
        "store_id": "shop-zetu",
        "label": "Shop Zetu (Online)",
        "short_label": "Shop Zetu feed",
        "open_min": 8 * 60,
        "close_min": 22 * 60,
        "warn_trading_min": 90,
        "crit_trading_min": 240,
    },
]

# A stale source escalates to critical on wall-clock age alone (only once it
# already burned its warn budget — so a closed overnight source can't hit it).
WALL_CRITICAL_MIN = 12 * 60

# Gap-scan cap: gaps wider than this are counted as full trading windows per
# day beyond the cap (keeps the day-walk O(cap) for absurd/ancient stamps).
_MAX_SCAN_DAYS = 62


def _to_utc(dt):
    """Naive datetimes are treated as UTC (all_sales.loaded_at is naive-UTC)."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def trading_minutes_between(start, end, open_min, close_min):
    """Minutes of [start, end] that fall inside the daily EAT trading window.

    Overnight and pre-open time contributes nothing, so a source that stops
    landing rows at close accrues no staleness until the window reopens.
    """
    start, end = _to_utc(start), _to_utc(end)
    if start is None or end is None or end <= start:
        return 0.0
    s = start.astimezone(EAT)
    e = end.astimezone(EAT)
    window_len = float(close_min - open_min)
    total = 0.0
    day = s.date()
    last_day = e.date()
    span_days = (last_day - day).days
    if span_days > _MAX_SCAN_DAYS:
        # Count the skipped middle as full windows; walk only the tail.
        skipped = span_days - _MAX_SCAN_DAYS
        total += skipped * window_len
        day = day + timedelta(days=skipped)
    while day <= last_day:
        midnight = datetime.combine(day, _time(0, 0), tzinfo=EAT)
        w_open = midnight + timedelta(minutes=open_min)
        w_close = midnight + timedelta(minutes=close_min)
        lo = max(s, w_open)
        hi = min(e, w_close)
        if hi > lo:
            total += (hi - lo).total_seconds() / 60.0
        day += timedelta(days=1)
    return total


def fmt_age(minutes):
    """Compact human age: '42m', '17h', '3d'."""
    if minutes is None:
        return "—"
    m = max(0, int(round(minutes)))
    if m < 60:
        return f"{m}m"
    h = m / 60.0
    if h < 48:
        return f"{int(round(h))}h"
    return f"{int(h // 24)}d"


def classify_source(cfg, last_loaded, now):
    """Classify one active source.

    Returns a JSON-safe dict:
      status:   'ok' | 'stale' | 'no_data'
      severity: None | 'warning' | 'critical'   (set only when stale)
    'no_data' (store absent from all_sales entirely) is informational, NOT
    stale — it only occurs on a freshly rebuilt/bootstrapping database, where
    an alert storm would be noise; pull failures are trailed separately.
    """
    now_utc = _to_utc(now)
    out = {
        "store_id": cfg["store_id"],
        "label": cfg["label"],
        "short_label": cfg["short_label"],
        "warn_after_trading_min": cfg["warn_trading_min"],
        "last_loaded_at": None,
        "last_loaded_eat": None,
        "minutes_since": None,
        "trading_gap_minutes": None,
        "age_label": None,
        "open_now": None,
        "status": "no_data",
        "severity": None,
    }
    eat_now = now_utc.astimezone(EAT)
    now_min = eat_now.hour * 60 + eat_now.minute
    out["open_now"] = cfg["open_min"] <= now_min < cfg["close_min"]
    if last_loaded is None:
        return out

    last_utc = _to_utc(last_loaded)
    wall_min = max(0.0, (now_utc - last_utc).total_seconds() / 60.0)
    gap = trading_minutes_between(last_utc, now_utc, cfg["open_min"], cfg["close_min"])
    out["last_loaded_at"] = last_utc.isoformat()
    out["last_loaded_eat"] = last_utc.astimezone(EAT).strftime("%d %b %H:%M")
    out["minutes_since"] = round(wall_min, 1)
    out["trading_gap_minutes"] = round(gap, 1)
    out["age_label"] = fmt_age(wall_min)

    if gap >= cfg["warn_trading_min"]:
        out["status"] = "stale"
        out["severity"] = (
            "critical"
            if gap >= cfg["crit_trading_min"] or wall_min >= WALL_CRITICAL_MIN
            else "warning"
        )
    else:
        out["status"] = "ok"
    return out


def evaluate_sources(last_loaded_by_store, now):
    """Classify every registered source and build the overall verdict.

    `last_loaded_by_store` maps store_id -> MAX(loaded_at) (naive-UTC ok).
    Unregistered store_ids in the map (e.g. retired `vivowoman`) are ignored.
    """
    sources = [
        classify_source(cfg, last_loaded_by_store.get(cfg["store_id"]), now)
        for cfg in SOURCES
    ]
    stale = [s for s in sources if s["status"] == "stale"]
    if any(s["severity"] == "critical" for s in stale):
        health = "CRITICAL"
    elif stale:
        health = "WARNING"
    else:
        health = "OK"

    summary = None
    if stale:
        rank = {"critical": 2, "warning": 1}
        worst = max(
            stale,
            key=lambda s: (rank.get(s["severity"], 0), s["minutes_since"] or 0),
        )
        summary = f"{worst['short_label']} {worst['age_label']} stale"
        if len(stale) > 1:
            summary += f" +{len(stale) - 1} more"

    return {
        "sources": sources,
        "sources_stale": bool(stale),
        "sources_health": health,
        "stale_summary": summary,
    }
