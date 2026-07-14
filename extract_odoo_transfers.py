#!/usr/bin/env python3
"""Pull incoming stock transfers from Odoo -> stock_transfers table.

Captures every stock.picking whose DESTINATION location is a known store's
Stock (reusing LOCATION_COUNTRY_MAP from extract_odoo_inventory.py so store
names stay consistent), across all in-flight states plus recently-done
(last 7 days). Each picking's move lines are exploded into per-SKU rows so
the store manager can see "what's coming and how many."

Transfer type is derived from the SOURCE location's short code:
  - Main warehouse code (WHFIN, WHREC) -> 'warehouse_to_store'
  - Another store's code               -> 'store_to_store'
  - A supplier partner location        -> 'supplier_to_store'
  - Anything else internal             -> 'other'

Runnable standalone or from sync_incremental. Load is history-preserving:
in-flight (non-done) rows are deleted + re-inserted each run, while done rows
are upserted on move_id so completed transfer history accumulates beyond the
7-day Odoo fetch window (never TRUNCATE this table).
"""
import os, sys, xmlrpc.client, psycopg2, logging
from psycopg2.extras import execute_values
from datetime import datetime, timezone, timedelta

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("transfers")

# Reuse the SAME store-code map as the inventory extractor so pos_location_name
# is identical across all_inventory and stock_transfers (store managers see the
# same "Vivo Sarit" label everywhere).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_odoo_inventory import LOCATION_COUNTRY_MAP

ODOO_URL=os.environ["ODOO_URL"]; ODOO_DB=os.environ["ODOO_DB"]
ODOO_USER=os.environ["ODOO_USER"]; ODOO_PW=os.environ["ODOO_PASSWORD"]
DB=os.environ["DATABASE_URL"]

RECENT_DONE_DAYS = 7
IN_FLIGHT_STATES = ("draft", "confirmed", "assigned", "waiting")
WAREHOUSE_CODES = {"WHFIN", "WHREC", "HWHFN"}  # warehouse-side codes


def _classify_source(src_code, src_usage):
    """Given the source location's short code and usage, return transfer_type."""
    if not src_code:
        return "other"
    if src_code in WAREHOUSE_CODES:
        return "warehouse_to_store"
    if src_code in LOCATION_COUNTRY_MAP:  # another store
        return "store_to_store"
    if src_usage == "supplier":
        return "supplier_to_store"
    return "other"


def ensure_table(conn):
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stock_transfers (
            picking_id           BIGINT      NOT NULL,
            picking_name         TEXT,
            state                TEXT        NOT NULL,
            transfer_type        TEXT        NOT NULL,
            from_location_code   TEXT,
            from_location_name   TEXT,
            to_store_code        TEXT        NOT NULL,
            to_store_name        TEXT        NOT NULL,
            to_country           TEXT,
            sku                  TEXT,
            product_name         TEXT,
            qty_planned          NUMERIC     NOT NULL DEFAULT 0,
            qty_done             NUMERIC     NOT NULL DEFAULT 0,
            move_id              BIGINT      NOT NULL,
            scheduled_date       TIMESTAMP,
            date_done            TIMESTAMP,
            origin               TEXT,
            _synced_at           TIMESTAMP   NOT NULL DEFAULT now(),
            PRIMARY KEY (move_id)
        )""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_stock_transfers_to_store ON stock_transfers(to_store_name)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_stock_transfers_state ON stock_transfers(state)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_stock_transfers_sku ON stock_transfers(sku)")
    conn.commit()


def run():
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PW, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    conn = psycopg2.connect(DB)
    ensure_table(conn)
    cur = conn.cursor()

    # 1. Find every "<CODE>/Stock" internal location whose parent code is in our
    #    store map — these are the destinations we care about.
    store_dest_ids = {}  # loc_id -> (code, store_name, country)
    for code, (store_name, country) in LOCATION_COUNTRY_MAP.items():
        locs = models.execute_kw(ODOO_DB, uid, ODOO_PW, "stock.location", "search_read",
            [[["complete_name", "=", f"{code}/Stock"], ["usage", "=", "internal"]]],
            {"fields": ["id"]})
        for l in locs:
            store_dest_ids[l["id"]] = (code, store_name, country)
    log.info("Resolved %d store destination locations", len(store_dest_ids))
    if not store_dest_ids:
        log.warning("No store destinations found — aborting")
        return 0

    # 2. Fetch pickings destined for those locations: in-flight OR recent-done
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RECENT_DONE_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    domain = [
        ["location_dest_id", "in", list(store_dest_ids)],
        "|",
        ["state", "in", list(IN_FLIGHT_STATES)],
        "&", ["state", "=", "done"], ["date_done", ">=", cutoff],
    ]
    pickings = models.execute_kw(ODOO_DB, uid, ODOO_PW, "stock.picking", "search_read",
        [domain],
        {"fields": ["id", "name", "state", "origin", "location_id", "location_dest_id",
                    "scheduled_date", "date_done", "move_ids_without_package"]})
    log.info("Fetched %d pickings (in-flight + last %dd done)", len(pickings), RECENT_DONE_DAYS)

    # 3. Resolve source location codes/usage in bulk
    src_ids = list({p["location_id"][0] for p in pickings if p.get("location_id")})
    src_info = {}  # loc_id -> (short_code, usage)
    if src_ids:
        src_locs = models.execute_kw(ODOO_DB, uid, ODOO_PW, "stock.location", "read",
            [src_ids], {"fields": ["complete_name", "usage"]})
        for l in src_locs:
            cn = l.get("complete_name", "") or ""
            code = cn.split("/")[0] if cn else None
            src_info[l["id"]] = (code, l.get("usage"))

    # 4. Explode picking -> move lines (products + quantities)
    move_ids = [mid for p in pickings for mid in (p.get("move_ids_without_package") or [])]
    log.info("Reading %d move lines", len(move_ids))
    moves = []
    if move_ids:
        for i in range(0, len(move_ids), 500):
            moves.extend(models.execute_kw(ODOO_DB, uid, ODOO_PW, "stock.move", "read",
                [move_ids[i:i+500]],
                {"fields": ["id", "picking_id", "product_id", "product_uom_qty", "quantity"]}))

    # 5. Resolve product default_code (SKU) in bulk
    prod_ids = list({m["product_id"][0] for m in moves if m.get("product_id")})
    prod_sku = {}  # prod_id -> (default_code, name)
    for i in range(0, len(prod_ids), 500):
        recs = models.execute_kw(ODOO_DB, uid, ODOO_PW, "product.product", "read",
            [prod_ids[i:i+500]], {"fields": ["default_code", "name"]})
        for r in recs:
            prod_sku[r["id"]] = (r.get("default_code"), r.get("name"))

    # 6. Build rows
    pk_by_id = {p["id"]: p for p in pickings}
    rows = []
    for m in moves:
        pk_ref = m.get("picking_id")
        if not pk_ref: continue
        pk = pk_by_id.get(pk_ref[0])
        if not pk: continue
        dst = pk.get("location_dest_id")
        if not dst or dst[0] not in store_dest_ids: continue
        code, store_name, country = store_dest_ids[dst[0]]
        src = pk.get("location_id")
        src_code, src_usage = src_info.get(src[0], (None, None)) if src else (None, None)
        prod = m.get("product_id")
        sku, pname = prod_sku.get(prod[0], (None, None)) if prod else (None, None)
        rows.append((
            pk["id"], pk.get("name"), pk.get("state"),
            _classify_source(src_code, src_usage),
            src_code, (src[1] if src else None),
            code, store_name, country,
            sku, pname,
            float(m.get("product_uom_qty") or 0),
            float(m.get("quantity") or 0),
            m["id"],
            pk.get("scheduled_date") or None,
            pk.get("date_done") or None,
            pk.get("origin"),
        ))

    # 7. Refresh while PRESERVING done history. The Odoo fetch only covers
    #    in-flight pickings + done in the last 7 days, but the dashboard's
    #    "units transferred over a period" needs done rows to accumulate.
    #    So: drop all stored in-flight rows (the fetch re-supplies the current
    #    in-flight set, and cancelled pickings disappear), then upsert on
    #    move_id — an in-flight move that completed flips to done in place,
    #    and done rows older than the 7-day window are left untouched.
    cur.execute("DELETE FROM stock_transfers WHERE state != 'done'")
    if rows:
        execute_values(cur, """
            INSERT INTO stock_transfers
              (picking_id, picking_name, state, transfer_type,
               from_location_code, from_location_name,
               to_store_code, to_store_name, to_country,
               sku, product_name, qty_planned, qty_done,
               move_id, scheduled_date, date_done, origin)
            VALUES %s
            ON CONFLICT (move_id) DO UPDATE SET
              picking_name = EXCLUDED.picking_name,
              state = EXCLUDED.state,
              transfer_type = EXCLUDED.transfer_type,
              from_location_code = EXCLUDED.from_location_code,
              from_location_name = EXCLUDED.from_location_name,
              to_store_code = EXCLUDED.to_store_code,
              to_store_name = EXCLUDED.to_store_name,
              to_country = EXCLUDED.to_country,
              sku = EXCLUDED.sku,
              product_name = EXCLUDED.product_name,
              qty_planned = EXCLUDED.qty_planned,
              qty_done = EXCLUDED.qty_done,
              scheduled_date = EXCLUDED.scheduled_date,
              date_done = EXCLUDED.date_done,
              origin = EXCLUDED.origin,
              _synced_at = now()
        """, rows, page_size=1000)
    conn.commit()
    cur.execute("ANALYZE stock_transfers")
    conn.commit()
    log.info("✅ stock_transfers: %d rows (%d pickings, %d unique SKUs)",
             len(rows), len({r[0] for r in rows}), len({r[9] for r in rows if r[9]}))
    conn.close()
    return len(rows)


if __name__ == "__main__":
    run()
