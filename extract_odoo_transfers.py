#!/usr/bin/env python3
"""Pull stock transfers from Odoo -> stock_transfers table.

For Stock Movement, most stores are attributed on the WHFIN/Stock -> named
Transit dispatch leg. Acacia, The Oasis Mall, and Kigali Heights are direct
WHFIN/Stock -> Store exceptions. The raw Odoo destination is retained while
to_store_* is normalized to the final POS location used by sales/inventory.

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
STORE_FLOW_DIRECT_EXCEPTIONS = {
    "vivo acacia", "the oasis mall", "vivo kigali heights",
}
STORE_FLOW_DIRECT_EXCEPTION_CODES = WAREHOUSE_CODES | {"FGPRD"}

# Finishing → Warehouse Finished Goods lane (IDs verified against Odoo 2026-08-04)
FGPRD_STOCK_ID = 1757   # FGPRD/Stock — Finished Goods Production
WHFIN_STOCK_ID = 8      # WHFIN/Stock — Warehouse Finished Goods

# Odoo's store-specific transit destinations (verified 2026-09-03). Values
# reference the final direct-store location ID below so canonical POS labels
# remain defined in one place. Generic inter-company/inter-warehouse transit,
# Vivo Popup, Warehouse Receiving Transit, and WHREC Transit are intentionally
# absent: none is a supported retail destination for Stock Movement.
TRANSIT_DEST_TO_STORE_DEST = {
    1955: 996,   # Mombasa City Mall Transit -> Vivo City Mall
    1956: 1004,  # Eldoret Transit
    1957: 1012,  # Galleria Transit
    1958: 1020,  # Garden City Transit
    1960: 988,   # Capital Centre Transit
    1961: 1028,  # Greenspan Transit
    1962: 1036,  # Hub Transit
    1963: 1044,  # Imaara Transit
    1964: 1052,  # Junction Transit
    1965: 1060,  # Kileleshwa Transit
    1966: 1068,  # Kisumu Transit
    1967: 1076,  # Mama Ngina Transit
    1968: 1084,  # Meru Transit
    1969: 1092,  # Moi Avenue Transit
    1970: 1100,  # Mombasa CBD Transit -> Vivo MSA Digo Road
    1971: 1108,  # Nakuru Transit
    1973: 1124,  # Runda Transit
    1974: 1140,  # Signature Mall Transit
    1975: 1132,  # Sarit Transit
    1976: 1148,  # T-Mall Transit
    1977: 1156,  # Two Rivers Transit
    1978: 1164,  # Village Market Transit
    1979: 1180,  # Yaya Transit
    1980: 1196,  # Safari Sarit Transit
    1981: 1204,  # Zoya Sarit Transit
    1982: 1386,  # Thika Road Mall Transit -> Vivo TRM
    1983: 1585,  # ShopZetu Online Transit
}


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


def _store_flow_route(destination_kind, to_store_name, src_location_id, src_code):
    """Return the Stock Movement dispatch-leg classification for one picking.

    Only WHFIN -> named Transit is reportable for normal stores. The three
    countries' direct-route exceptions remain reportable when warehouse-origin.
    Other direct routes are retained for other consumers but never counted by
    Stock Movement.
    """
    if destination_kind == "transit":
        return "warehouse_to_transit" if src_location_id == WHFIN_STOCK_ID else None
    if destination_kind == "store":
        if (
            (to_store_name or "").strip().lower() in STORE_FLOW_DIRECT_EXCEPTIONS
            and src_code in STORE_FLOW_DIRECT_EXCEPTION_CODES
        ):
            return "warehouse_to_store_exception"
        return "non_reportable_direct"
    return None


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
            to_location_id       BIGINT,
            to_location_name     TEXT,
            store_flow_route     TEXT,
            _synced_at           TIMESTAMP   NOT NULL DEFAULT now(),
            PRIMARY KEY (move_id)
        )""")
    cur.execute("ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS to_location_id BIGINT")
    cur.execute("ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS to_location_name TEXT")
    cur.execute("ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS store_flow_route TEXT")
    # Existing retained done rows only contain direct destinations. Preserve
    # the three valid historical exception routes, including the established
    # FGPRD origin, even if an earlier route migration tagged them otherwise.
    direct_exception_codes_sql = ",".join(
        "'%s'" % code for code in sorted(STORE_FLOW_DIRECT_EXCEPTION_CODES))
    cur.execute("""
        UPDATE stock_transfers
        SET store_flow_route = 'warehouse_to_store_exception'
        WHERE LOWER(BTRIM(to_store_name)) IN
              ('vivo acacia', 'the oasis mall', 'vivo kigali heights')
          AND from_location_code IN (""" + direct_exception_codes_sql + """)
    """)
    # Normal-store direct rows remain retained for other consumers but are not
    # complete Stock Movement history because the old extractor missed their
    # earlier WHFIN -> Transit dispatch legs.
    cur.execute("""
        UPDATE stock_transfers
        SET store_flow_route = 'non_reportable_direct'
        WHERE store_flow_route IS NULL
          AND transfer_type = 'warehouse_to_store'
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS stock_transfer_sync_meta (
            scope               TEXT PRIMARY KEY,
            route_coverage_from DATE NOT NULL,
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_stock_transfers_to_store ON stock_transfers(to_store_name)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_stock_transfers_state ON stock_transfers(state)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_stock_transfers_sku ON stock_transfers(sku)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_stock_transfers_store_flow_route ON stock_transfers(store_flow_route)")
    conn.commit()


def run():
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PW, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    conn = psycopg2.connect(DB)
    ensure_table(conn)
    cur = conn.cursor()

    # 1. Hardcoded location ID map — verified directly against Odoo on 2026-07-17.
    #    Key = Odoo location ID, Value = (short_code, store_name, country)
    #    This avoids the fragile "<CODE>/Stock" string-matching approach which
    #    missed HUB, TMALL, SARIT, ACHO, KIGAL, OASIS, SZONL.
    store_dest_ids = {
        # Kenya stores — IDs verified against Odoo 2026-07-17
        988:  ("CAPIT",  "Vivo Capital Centre",      "Kenya"),
        996:  ("CITYM",  "Vivo City Mall",            "Kenya"),
        1004: ("ELDOR",  "Vivo Eldoret",              "Kenya"),
        1012: ("GALLE",  "Vivo Galleria",             "Kenya"),
        1020: ("GCITY",  "Vivo Garden City",          "Kenya"),
        1028: ("GRENS",  "Vivo Greenspan",            "Kenya"),
        1036: ("HUB",    "Vivo Hub",                  "Kenya"),
        1044: ("IMAAR",  "Vivo Imaara",               "Kenya"),
        1052: ("JUNCT",  "Vivo Junction",             "Kenya"),
        1060: ("KILEL",  "Vivo Kileleshwa",           "Kenya"),
        1068: ("KISM",   "Vivo Kisumu",               "Kenya"),
        1076: ("MNS",    "Vivo Mama Ngina St",        "Kenya"),
        1084: ("MERU",   "Vivo Meru",                 "Kenya"),
        1092: ("MOIAV",  "Vivo Moi Avenue",           "Kenya"),
        1100: ("MSACB",  "Vivo MSA Digo Road",        "Kenya"),
        1108: ("NAKUR",  "Vivo Nakuru",               "Kenya"),
        1124: ("RUNDA",  "Vivo Runda",                "Kenya"),
        1132: ("SARIT",  "Vivo Sarit",                "Kenya"),
        1140: ("SIGNA",  "Vivo Signature Mall",       "Kenya"),
        1148: ("TMALL",  "Vivo T- Mall",              "Kenya"),
        1196: ("SAFAR",  "Safari Sarit",              "Kenya"),
        1204: ("ZOYA",   "Zoya Sarit",                "Kenya"),
        1156: ("TWORV",  "Vivo Two Rivers",           "Kenya"),
        1164: ("VMKT",   "Vivo Village Market",       "Kenya"),
        1180: ("YAYA",   "Vivo Yaya",                 "Kenya"),
        1386: ("TRM",    "Vivo TRM",                  "Kenya"),
        # Uganda stores
        1594: ("ACHO",   "Vivo Acacia",               "Uganda"),
        1610: ("OASIS",  "The Oasis Mall",            "Uganda"),
        # Rwanda stores
        1602: ("KIGAL",  "Vivo Kigali Heights",       "Rwanda"),
        # Online
        1585: ("SZONL",  "Online - Shop Zetu",        "Online"),
    }
    log.info("Using %d hardcoded store destination locations", len(store_dest_ids))
    if not store_dest_ids:
        log.warning("No store destinations found — aborting")
        return 0

    transit_dest_ids = {
        transit_id: store_dest_ids[store_id]
        for transit_id, store_id in TRANSIT_DEST_TO_STORE_DEST.items()
    }

    # 2. Fetch direct-store and named-transit destinations: in-flight OR
    # recent-done. TRANSFERS_DONE_DAYS supports an explicit deeper backfill;
    # retained done rows are never deleted after that backfill.
    done_days = int(os.environ.get("TRANSFERS_DONE_DAYS", RECENT_DONE_DAYS))
    cutoff_dt = datetime.now(timezone.utc) - timedelta(days=done_days)
    cutoff = cutoff_dt.strftime("%Y-%m-%d %H:%M:%S")
    domain = [
        ["location_dest_id", "in", list(store_dest_ids) + list(transit_dest_ids)],
        "|",
        ["state", "in", list(IN_FLIGHT_STATES)],
        "&", ["state", "=", "done"], ["date_done", ">=", cutoff],
    ]
    pickings = models.execute_kw(ODOO_DB, uid, ODOO_PW, "stock.picking", "search_read",
        [domain],
        {"fields": ["id", "name", "state", "origin", "location_id", "location_dest_id",
                    "scheduled_date", "date_done", "move_ids_without_package"]})
    log.info("Fetched %d direct/transit pickings (in-flight + last %dd done)", len(pickings), done_days)

    # 2b. Also fetch store→warehouse (returns to WHREC id=1356) from retail stores only
    store_src_ids = list(store_dest_ids.keys())
    domain_returns = [
        ["location_dest_id", "=", 1356],  # WHREC/Stock
        ["location_id", "in", store_src_ids],  # only from retail stores
        "|",
        ["state", "in", list(IN_FLIGHT_STATES)],
        "&", ["state", "=", "done"], ["date_done", ">=", cutoff],
    ]
    pickings_returns = models.execute_kw(ODOO_DB, uid, ODOO_PW, "stock.picking", "search_read",
        [domain_returns],
        {"fields": ["id", "name", "state", "origin", "location_id", "location_dest_id",
                    "scheduled_date", "date_done", "move_ids_without_package"]})
    log.info("Fetched %d store→warehouse pickings", len(pickings_returns))
    pickings = pickings + pickings_returns

    # 2c. Also fetch finishing→warehouse pickings (FGPRD/Stock → WHFIN/Stock) so
    #     the daily "finishing → warehouse finished goods" report can be built.
    #     FINISHING_DONE_DAYS env var allows a one-off deeper backfill run.
    fin_days = int(os.environ.get("FINISHING_DONE_DAYS", RECENT_DONE_DAYS))
    fin_cutoff = (datetime.now(timezone.utc) - timedelta(days=fin_days)).strftime("%Y-%m-%d %H:%M:%S")
    domain_finishing = [
        ["location_dest_id", "=", WHFIN_STOCK_ID],
        ["location_id", "=", FGPRD_STOCK_ID],
        "|",
        ["state", "in", list(IN_FLIGHT_STATES)],
        "&", ["state", "=", "done"], ["date_done", ">=", fin_cutoff],
    ]
    pickings_finishing = models.execute_kw(ODOO_DB, uid, ODOO_PW, "stock.picking", "search_read",
        [domain_finishing],
        {"fields": ["id", "name", "state", "origin", "location_id", "location_dest_id",
                    "scheduled_date", "date_done", "move_ids_without_package"]})
    log.info("Fetched %d finishing→warehouse pickings (last %dd done)", len(pickings_finishing), fin_days)
    pickings = pickings + pickings_finishing

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
    move_ids = list(dict.fromkeys(
        mid for p in pickings for mid in (p.get("move_ids_without_package") or [])))
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
        src = pk.get("location_id")
        src_code, src_usage = src_info.get(src[0], (None, None)) if src else (None, None)
        destination_kind = None
        store_flow_route = None
        # Finishing→warehouse: FGPRD/Stock → WHFIN/Stock
        if dst and dst[0] == WHFIN_STOCK_ID and src and src[0] == FGPRD_STOCK_ID:
            code, store_name, country = ("WHFIN", "Warehouse Finished Goods", "Kenya")
            transfer_type_override = "finishing_to_warehouse"
        # Store→warehouse: source is the store, dest is WHREC
        elif dst and dst[0] == 1356 and src and src[0] in store_dest_ids:
            code, store_name, country = store_dest_ids[src[0]]
            transfer_type_override = "store_to_warehouse"
        # Normal store dispatch: only the WHFIN -> named Transit leg is useful.
        # Store-to-store, retired, shopping-bag and other sources can share the
        # transit tree in Odoo, so reject them at extraction time.
        elif dst and dst[0] in transit_dest_ids:
            destination_kind = "transit"
            code, store_name, country = transit_dest_ids[dst[0]]
            store_flow_route = _store_flow_route(
                destination_kind, store_name, src[0] if src else None, src_code)
            if store_flow_route is None:
                continue
            transfer_type_override = "warehouse_to_store"
        elif dst and dst[0] in store_dest_ids:
            destination_kind = "store"
            code, store_name, country = store_dest_ids[dst[0]]
            transfer_type_override = None
            store_flow_route = _store_flow_route(
                destination_kind, store_name, src[0] if src else None, src_code)
        else:
            continue
        prod = m.get("product_id")
        sku, pname = prod_sku.get(prod[0], (None, None)) if prod else (None, None)
        rows.append((
            pk["id"], pk.get("name"), pk.get("state"),
            transfer_type_override or _classify_source(src_code, src_usage),
            src_code, (src[1] if src else None),
            code, store_name, country,
            sku, pname,
            float(m.get("product_uom_qty") or 0),
            float(m.get("quantity") or 0),
            m["id"],
            pk.get("scheduled_date") or None,
            pk.get("date_done") or None,
            pk.get("origin"),
            dst[0] if dst else None,
            dst[1] if dst else None,
            store_flow_route,
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
                move_id, scheduled_date, date_done, origin,
                to_location_id, to_location_name, store_flow_route)
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
              to_location_id = EXCLUDED.to_location_id,
              to_location_name = EXCLUDED.to_location_name,
              store_flow_route = EXCLUDED.store_flow_route,
              _synced_at = now()
        """, rows, page_size=1000)
    # The coverage boundary records what this route-aware extractor has actually
    # fetched. It only moves backwards when TRANSFERS_DONE_DAYS performs a deeper
    # backfill, never forward on later seven-day incremental runs.
    coverage_from = (cutoff_dt + timedelta(hours=3)).date()
    cur.execute("""
        INSERT INTO stock_transfer_sync_meta
            (scope, route_coverage_from, updated_at)
        VALUES ('store_flow_routes', %s, now())
        ON CONFLICT (scope) DO UPDATE SET
            route_coverage_from = LEAST(
                stock_transfer_sync_meta.route_coverage_from,
                EXCLUDED.route_coverage_from),
            updated_at = now()
    """, (coverage_from,))
    conn.commit()
    cur.execute("ANALYZE stock_transfers")
    conn.commit()
    log.info("✅ stock_transfers: %d rows (%d pickings, %d unique SKUs)",
             len(rows), len({r[0] for r in rows}), len({r[9] for r in rows if r[9]}))
    conn.close()
    return len(rows)


if __name__ == "__main__":
    run()
