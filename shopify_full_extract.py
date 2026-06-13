"""
shopify_full_extract.py

Long-running driver that extracts the FULL Shopify history into the shopify_sales
table for all three Vivo stores, using shopify_sales_extractor.fetch_sales.

Targets:
  - vivowoman   : 2019-01-01 -> 2026-03-19 (capped, matches BigQuery comparison window)
  - vivo-uganda : 2019-01-01 -> today
  - vivo-rwanda : 2019-01-01 -> today

Designed to run as a background workflow. It is RESUMABLE across restarts:
progress is persisted per store to a JSON file after every window, and the
underlying fetch_sales is idempotent (delete-by-(store_id, order_id) + insert),
so re-running a partially-completed window is safe.

Progress is also written to shopify_full_extract_progress.json for monitoring,
and detailed per-batch logs ("Inserted N sales records") come from fetch_sales.
"""

import os
import sys
import json
import logging
from datetime import datetime, timedelta, date

import shopify_sales_extractor as ext

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("full_extract")

PROGRESS_FILE = ".local/state/shopify_full_extract_progress.json"

# Resume granularity (days). Progress is saved after each window; fetch_sales
# sub-batches and commits every SUBBATCH_DAYS within a window.
WINDOW_DAYS = 90
SUBBATCH_DAYS = 15

HISTORICAL_START = "2019-01-01"

# (store_id, start_date, end_date or None=today)
TARGETS = [
    ("vivowoman", HISTORICAL_START, "2026-03-19"),
    ("vivo-uganda", HISTORICAL_START, None),
    ("vivo-rwanda", HISTORICAL_START, None),
]


def load_progress():
    try:
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_progress(progress):
    os.makedirs(os.path.dirname(PROGRESS_FILE), exist_ok=True)
    tmp = PROGRESS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(progress, f, indent=2, sort_keys=True)
    os.replace(tmp, PROGRESS_FILE)


def _to_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def run_store(store_config, start_str, end_str, progress):
    store_id = store_config["id"]
    end_day = date.today() if end_str is None else _to_date(end_str)

    st = progress.get(store_id, {})
    if st.get("done"):
        log.info("[%s] already complete (through %s)", store_id, st.get("next_start"))
        return

    cur = _to_date(st.get("next_start", start_str))
    log.info(
        "[%s] ===== FULL EXTRACT %s -> %s (resuming from %s) =====",
        store_id, start_str, end_day, cur,
    )

    while cur <= end_day:
        win_end = min(cur + timedelta(days=WINDOW_DAYS - 1), end_day)
        log.info("[%s] --- window %s -> %s ---", store_id, cur, win_end)
        ext.fetch_sales(
            store_config,
            days_per_batch=SUBBATCH_DAYS,
            start_from=cur.strftime("%Y-%m-%d"),
            end_at=win_end.strftime("%Y-%m-%d"),
        )
        cur = win_end + timedelta(days=1)
        progress[store_id] = {
            "next_start": cur.strftime("%Y-%m-%d"),
            "done": cur > end_day,
            "target_end": end_day.strftime("%Y-%m-%d"),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
        save_progress(progress)

    progress[store_id] = {
        "next_start": end_day.strftime("%Y-%m-%d"),
        "done": True,
        "target_end": end_day.strftime("%Y-%m-%d"),
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    save_progress(progress)
    log.info("[%s] ===== COMPLETE =====", store_id)


def main():
    stores = {s["id"]: s for s in ext.build_stores()}
    progress = load_progress()
    log.info("Configured stores: %s", sorted(stores))

    for store_id, start_str, end_str in TARGETS:
        if store_id not in stores:
            log.warning("[%s] NOT configured (missing creds); skipping", store_id)
            continue
        run_store(stores[store_id], start_str, end_str, progress)

    log.info("ALL TARGETS COMPLETE: %s", json.dumps(progress, sort_keys=True))


if __name__ == "__main__":
    main()
