#!/usr/bin/env python3
"""
sync_production_tracker.py
--------------------------
Populates the production tracker from Odoo buying orders.

A "buying order" = a `vivo.buying.order` record (e.g. BO00334). Each BO has a
buyer, order date, style name, expected delivery date, production/lifecycle type,
a fabric/trims spec in notes, and one line per colour (`vivo.buying.order.line`)
with a total_qty. We load:
  - one production_orders row per BO (full header)
  - one production_order_lines row per colour line
  - an intake movement so the 'buying_order' stage holds the BO's total quantity,
    ready for the dashboard to move units through the stages.

Chain in Odoo: vivo.buying.order (BO) -> mrp.production.day (DPS) -> mrp.production (MO).
We anchor on the BO.

Idempotent: orders and lines are upserted; intake appends only the delta between
the BO quantity and what has already been taken in, so re-running never
double-counts and a BO whose quantity grows simply gets the extra units appended.

Run:
    python sync_production_tracker.py
"""

import os
import re
import logging
import xmlrpc.client
from collections import defaultdict

import psycopg2
from psycopg2.extras import execute_values

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sync_production_tracker")

ODOO_URL = os.environ["ODOO_URL"]
ODOO_DB = os.environ["ODOO_DB"]
ODOO_USER = os.environ["ODOO_USER"]
ODOO_PASSWORD = os.environ["ODOO_PASSWORD"]
DATABASE_URL = os.environ["DATABASE_URL"]

SKU_RE = re.compile(r"^\[([^\]]+)\]\s*(.*)$")
SIZE_RE = re.compile(r"\(([^)]*)\)\s*$")
COST_FIELD_CANDIDATES = (
    "cost_price_kes", "cost_price", "unit_cost", "price_unit",
    "unit_price", "purchase_price", "standard_cost",
)


# ----------------------------------------------------------------------
# Odoo
# ----------------------------------------------------------------------
def odoo_connect():
    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")
    log.info("Connected to Odoo as uid=%s", uid)
    return uid, models


def fetch_buying_orders(uid, models):
    base_fields = [
        "name",
        "buyer_id",
        "order_date",
        "x_studio_style_name",
        "x_studio_expected_delivery_date",
        "x_studio_production_type",
        "x_studio_product_lifecycle_type",
        "state",
        "notes",
        "line_ids",
    ]
    # Buying-order customisations differ between Odoo databases. Discover
    # whichever cost field exists instead of asking search_read for a field
    # that may not exist on this deployment.
    cost_fields = []
    try:
        field_info = models.execute_kw(
            ODOO_DB,
            uid,
            ODOO_PASSWORD,
            "vivo.buying.order",
            "fields_get",
            [],
            {"attributes": ["type"]},
        )
        cost_fields = [name for name in COST_FIELD_CANDIDATES if name in field_info]
    except Exception as exc:  # noqa: BLE001 — costing is optional enrichment
        log.warning("Could not discover buying-order cost fields: %s", exc)

    bos = models.execute_kw(
        ODOO_DB,
        uid,
        ODOO_PASSWORD,
        "vivo.buying.order",
        "search_read",
        [[]],
        {"fields": base_fields + cost_fields},
    )
    log.info("Fetched %s buying orders (cost fields: %s)",
             len(bos), ", ".join(cost_fields) or "none")
    return bos


def fetch_lines(uid, models, line_ids):
    if not line_ids:
        return []
    cost_fields = []
    try:
        field_info = models.execute_kw(
            ODOO_DB,
            uid,
            ODOO_PASSWORD,
            "vivo.buying.order.line",
            "fields_get",
            [],
            {"attributes": ["type"]},
        )
        cost_fields = [name for name in COST_FIELD_CANDIDATES if name in field_info]
    except Exception as exc:  # noqa: BLE001 — costing is optional enrichment
        log.warning("Could not discover buying-order-line cost fields: %s", exc)
    lines = models.execute_kw(
        ODOO_DB,
        uid,
        ODOO_PASSWORD,
        "vivo.buying.order.line",
        "read",
        [line_ids],
        {
            "fields": [
                "order_id",
                "product_tmpl_id",
                "total_qty",
                "planned_qty",
                "remaining_qty",
                "state",
                "variant_line_ids",
            ] + cost_fields
        },
    )
    log.info("Fetched %s buying order lines", len(lines))
    return lines


def fetch_variants(uid, models, variant_ids):
    """The per-size 'variant breakdown' under each colour line. Each variant
    carries a product.product (label '[SKU] Style - Colour (SIZE)') and a qty."""
    if not variant_ids:
        return []
    variants = models.execute_kw(
        ODOO_DB,
        uid,
        ODOO_PASSWORD,
        "vivo.buying.order.line.variant",
        "read",
        [variant_ids],
        {"fields": ["line_id", "product_id", "qty"]},
    )
    log.info("Fetched %s buying order line variants", len(variants))
    return variants


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def parse_label(product_field):
    """[id, '[SKU] Name - Colour'] -> (sku, full_name, colour)"""
    if not product_field:
        return None, None, None
    label = (
        product_field[1]
        if isinstance(product_field, (list, tuple))
        else str(product_field)
    )
    label = label.strip()
    m = SKU_RE.match(label)
    sku = m.group(1).strip() if m else None
    name = m.group(2).strip() if m else label
    colour = name.split(" - ")[-1].strip() if " - " in name else None
    return sku, name, colour


def common_prefix(skus):
    skus = [s for s in skus if s]
    return (os.path.commonprefix(skus) or None) if skus else None


def as_date(v):
    return v[:10] if v else None


def positive_cost(value):
    """Return a positive numeric Odoo cost, or None for empty/zero values."""
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    return amount if amount > 0 else None


def record_cost(record):
    """Return the first positive cost field and its source label."""
    for field in COST_FIELD_CANDIDATES:
        amount = positive_cost(record.get(field))
        if amount is not None:
            return amount, field
    return None, None


def _valid_expected(expected, ordered):
    """WS4 T404 — drop impossible ETAs. Odoo's studio field was bulk-defaulted
    to a fixed date, so many orders carry an 'expected delivery' that predates
    the order itself. Those convey no information: return None so downstream
    surfaces render '—' and never count them as Overdue."""
    if not expected:
        return None
    if ordered and expected < ordered:
        return None
    return expected


# ----------------------------------------------------------------------
# Reshape
# ----------------------------------------------------------------------
def parse_variant(product_field):
    """[id, '[SKU] Style - Colour (SIZE)'] -> (sku, full_label, size)."""
    if not product_field:
        return None, None, None
    label = (
        product_field[1]
        if isinstance(product_field, (list, tuple))
        else str(product_field)
    )
    label = label.strip()
    m = SKU_RE.match(label)
    sku = m.group(1).strip() if m else None
    rest = m.group(2).strip() if m else label
    sz = SIZE_RE.search(rest)
    size = sz.group(1).strip() if sz else None
    return sku, label, size


def build(bos, lines, variants):
    lines_by_bo = defaultdict(list)
    for ln in lines:
        bo_id = ln["order_id"][0] if ln.get("order_id") else None
        if bo_id is not None:
            lines_by_bo[bo_id].append(ln)

    # Variants grouped by their parent BO line id.
    variants_by_line = defaultdict(list)
    for v in variants:
        line_id = v["line_id"][0] if v.get("line_id") else None
        if line_id is not None:
            variants_by_line[line_id].append(v)

    orders, order_lines, order_variants = [], [], []
    for b in bos:
        blines = lines_by_bo.get(b["id"], [])
        bo_cost, bo_cost_field = record_cost(b)
        if bo_cost is None:
            # Some Odoo installations keep unit cost on the colour line rather
            # than the buying-order header. Preserve that cost on the BO row.
            for ln in blines:
                bo_cost, bo_cost_field = record_cost(ln)
                if bo_cost is not None:
                    break
        skus, total = [], 0.0
        for ln in blines:
            sku, name, colour = parse_label(ln.get("product_tmpl_id"))
            # Per-size variant breakdown under this colour line.
            line_var_skus = []
            for v in variants_by_line.get(ln["id"], []):
                vsku, vlabel, vsize = parse_variant(v.get("product_id"))
                if vsku:
                    line_var_skus.append(vsku)
                order_variants.append(
                    {
                        "odoo_variant_id": v["id"],
                        "order_ref": b["name"],
                        "odoo_line_id": ln["id"],
                        "product_sku": vsku,
                        "variant_name": vlabel,
                        "colour": colour,
                        "size": vsize,
                        "qty": v.get("qty") or 0.0,
                    }
                )
            # Colour-line SKU: prefer the explicit template SKU, else the common
            # prefix of its size variants' SKUs (the style-colour code).
            line_sku = sku or common_prefix(line_var_skus)
            if line_sku:
                skus.append(line_sku)
            total += ln.get("total_qty") or 0.0
            order_lines.append(
                {
                    "order_ref": b["name"],
                    "odoo_line_id": ln["id"],
                    "product_sku": line_sku,
                    "product_name": name,
                    "colour": colour,
                    "total_qty": ln.get("total_qty") or 0.0,
                    "planned_qty": ln.get("planned_qty") or 0.0,
                    "remaining_qty": ln.get("remaining_qty") or 0.0,
                    "line_state": ln.get("state"),
                }
            )

        orders.append(
            {
                "order_ref": b["name"],
                "odoo_id": b["id"],
                "style_number": common_prefix(skus),
                "style_name": b.get("x_studio_style_name") or None,
                "product_name": b.get("x_studio_style_name") or None,
                "product_sku": skus[0] if skus else None,
                "order_qty": round(total, 2),
                "date_ordered": as_date(b.get("order_date")),
                "cost_price_kes": bo_cost,
                "cost_source": f"last reorder ({bo_cost_field})" if bo_cost_field else None,
                # WS4 T404: x_studio_expected_delivery_date is bulk-defaulted
                # in Odoo (2026-05-07 on ~200 orders regardless of when they
                # were placed). An "expected delivery" BEFORE the order date is
                # impossible — treat it as no date (NULL) so the dashboard
                # shows "—" and excludes it from Overdue, instead of reading
                # tens of thousands of units as overdue on a phantom ETA.
                "expected_delivery_date": _valid_expected(
                    as_date(b.get("x_studio_expected_delivery_date")),
                    as_date(b.get("order_date")),
                ),
                "buyer": b["buyer_id"][1] if b.get("buyer_id") else None,
                "production_type": b.get("x_studio_production_type") or None,
                "lifecycle_type": b.get("x_studio_product_lifecycle_type") or None,
                "bo_state": b.get("state"),
                "notes_html": b.get("notes") or None,
            }
        )

    log.info(
        "Built %s orders, %s order lines, %s variants",
        len(orders), len(order_lines), len(order_variants),
    )
    return orders, order_lines, order_variants


# ----------------------------------------------------------------------
# Postgres
# ----------------------------------------------------------------------
def ensure_schema(cur):
    """Idempotently create the production tracker schema (tables + stage seed +
    views) before writing. Lets this script run safely against a fresh prod DB
    (which ships code + schema but no data rows) and as a one-time backfill,
    without depending on the API's startup hook having run first."""
    schema_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "production_tracker_schema.sql")
    with open(schema_path, "r", encoding="utf-8") as fh:
        cur.execute(fh.read())
    log.info("Ensured production tracker schema")


def upsert_orders(cur, orders):
    rows = [
        (
            o["order_ref"],
            o["odoo_id"],
            o["style_number"],
            o["style_name"],
            o["product_name"],
            o["product_sku"],
            o["order_qty"],
            o["date_ordered"],
            o["cost_price_kes"],
            o["date_ordered"] if o["cost_price_kes"] is not None else None,
            o["cost_source"],
            o["expected_delivery_date"],
            o["buyer"],
            o["production_type"],
            o["lifecycle_type"],
            o["bo_state"],
            o["notes_html"],
            "odoo",
        )
        for o in orders
    ]
    execute_values(
        cur,
        """
        INSERT INTO production_orders
            (order_ref, odoo_id, style_number, style_name, product_name, product_sku,
             order_qty, date_ordered, cost_price_kes, cost_date, cost_source,
             expected_delivery_date, buyer, production_type, lifecycle_type, bo_state,
             notes_html, source, updated_at)
        VALUES %s
        ON CONFLICT (order_ref) DO UPDATE SET
            odoo_id                = EXCLUDED.odoo_id,
            style_number           = COALESCE(EXCLUDED.style_number, production_orders.style_number),
            style_name             = EXCLUDED.style_name,
            product_name           = EXCLUDED.product_name,
            product_sku            = COALESCE(EXCLUDED.product_sku, production_orders.product_sku),
            order_qty              = EXCLUDED.order_qty,
            date_ordered           = EXCLUDED.date_ordered,
            cost_price_kes         = COALESCE(EXCLUDED.cost_price_kes, production_orders.cost_price_kes),
            cost_date              = COALESCE(EXCLUDED.cost_date, production_orders.cost_date),
            cost_source            = COALESCE(EXCLUDED.cost_source, production_orders.cost_source),
            expected_delivery_date = EXCLUDED.expected_delivery_date,
            buyer                  = EXCLUDED.buyer,
            production_type        = EXCLUDED.production_type,
            lifecycle_type         = EXCLUDED.lifecycle_type,
            bo_state               = EXCLUDED.bo_state,
            notes_html             = EXCLUDED.notes_html,
            updated_at             = now()
    """,
        rows,
        # Keep this in lockstep with the 18 values in each row above.  The
        # explicit template is required because updated_at is server-owned.
        template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())",
    )
    log.info("Upserted %s production_orders", len(rows))


def upsert_lines(cur, order_lines):
    if not order_lines:
        return
    rows = [
        (
            l["order_ref"],
            l["odoo_line_id"],
            l["product_sku"],
            l["product_name"],
            l["colour"],
            l["total_qty"],
            l["planned_qty"],
            l["remaining_qty"],
            l["line_state"],
        )
        for l in order_lines
    ]
    execute_values(
        cur,
        """
        INSERT INTO production_order_lines
            (order_ref, odoo_line_id, product_sku, product_name, colour,
             total_qty, planned_qty, remaining_qty, line_state)
        VALUES %s
        ON CONFLICT (order_ref, odoo_line_id) DO UPDATE SET
            product_sku   = EXCLUDED.product_sku,
            product_name  = EXCLUDED.product_name,
            colour        = EXCLUDED.colour,
            total_qty     = EXCLUDED.total_qty,
            planned_qty   = EXCLUDED.planned_qty,
            remaining_qty = EXCLUDED.remaining_qty,
            line_state    = EXCLUDED.line_state
    """,
        rows,
    )
    log.info("Upserted %s production_order_lines", len(rows))


def upsert_variants(cur, order_variants):
    if not order_variants:
        return
    rows = [
        (
            v["odoo_variant_id"],
            v["order_ref"],
            v["odoo_line_id"],
            v["product_sku"],
            v["variant_name"],
            v["colour"],
            v["size"],
            v["qty"],
        )
        for v in order_variants
    ]
    execute_values(
        cur,
        """
        INSERT INTO production_order_variants
            (odoo_variant_id, order_ref, odoo_line_id, product_sku,
             variant_name, colour, size, qty)
        VALUES %s
        ON CONFLICT (odoo_variant_id) DO UPDATE SET
            order_ref    = EXCLUDED.order_ref,
            odoo_line_id = EXCLUDED.odoo_line_id,
            product_sku  = EXCLUDED.product_sku,
            variant_name = EXCLUDED.variant_name,
            colour       = EXCLUDED.colour,
            size         = EXCLUDED.size,
            qty          = EXCLUDED.qty
    """,
        rows,
    )
    log.info("Upserted %s production_order_variants", len(rows))


def prune_lines(cur, keep_line_ids):
    """Remove colour lines that no longer exist in Odoo. Guarded: only prune
    when we actually fetched lines, so a degenerate empty fetch can't wipe the
    table (the surrounding transaction also rolls back on any error)."""
    if not keep_line_ids:
        return
    cur.execute(
        "DELETE FROM production_order_lines WHERE NOT (odoo_line_id = ANY(%s))",
        (list(keep_line_ids),),
    )
    if cur.rowcount:
        log.info("Pruned %s stale production_order_lines", cur.rowcount)


def prune_variants(cur, keep_variant_ids):
    """Remove size variants that no longer exist in Odoo (same guard as above)."""
    if not keep_variant_ids:
        return
    cur.execute(
        "DELETE FROM production_order_variants WHERE NOT (odoo_variant_id = ANY(%s))",
        (list(keep_variant_ids),),
    )
    if cur.rowcount:
        log.info("Pruned %s stale production_order_variants", cur.rowcount)


def sync_intake(cur, orders, order_variants):
    """Seed the 'buying_order' intake movements. Orders that have size variants
    get one intake row PER (sku, size) so the ledger tracks production at the
    variant grain; variant-less orders fall back to a single whole-order intake
    (legacy shape, sku NULL).

    Idempotent + prod-safe: each variant's intake is the delta vs what is already
    recorded for that (order, sku, size). The FIRST time an order gains variants
    we also delete its legacy whole-order intake row (from_stage IS NULL AND
    sku IS NULL) so the two shapes never double-count; on later runs that delete
    matches nothing.

    Stale-SKU prune (WS4 T406): Odoo sometimes RENAMES an order's variant SKUs
    between syncs (e.g. BO00336 V0526052* -> V0526032*). The per-(sku,size)
    delta then sees the new SKUs as brand-new and appends a FULL second intake,
    doubling the order's buying_order balance (429 ordered / 858 staged). So
    before the delta pass we delete intake rows whose (sku,size) no longer
    exists in the order's current variant set, and shrink any intake bucket
    recorded above its current variant qty."""
    from collections import defaultdict

    variants_by_order = defaultdict(list)
    for v in order_variants:
        variants_by_order[v["order_ref"]].append(v)

    inserted = 0
    migrated = 0
    pruned = 0
    for o in orders:
        ref = o["order_ref"]
        variants = variants_by_order.get(ref)
        if variants:
            # Drop any legacy whole-order intake now that per-variant intake exists.
            cur.execute(
                "DELETE FROM stage_movements "
                "WHERE order_ref = %s AND from_stage IS NULL AND sku IS NULL",
                (ref,),
            )
            migrated += cur.rowcount or 0
            # Prune intake rows for (sku, size) pairs no longer on the order
            # (Odoo SKU renames / removed variants) so they can't double-count.
            current = {(v.get("product_sku"), v.get("size")) for v in variants
                       if float(v.get("qty") or 0) > 0}
            cur.execute(
                "SELECT DISTINCT sku, size FROM stage_movements "
                "WHERE order_ref = %s AND from_stage IS NULL AND sku IS NOT NULL",
                (ref,),
            )
            for old_sku, old_size in cur.fetchall():
                if (old_sku, old_size) not in current:
                    cur.execute(
                        "DELETE FROM stage_movements "
                        "WHERE order_ref = %s AND from_stage IS NULL "
                        "AND sku = %s AND size IS NOT DISTINCT FROM %s",
                        (ref, old_sku, old_size),
                    )
                    pruned += cur.rowcount or 0
            for v in variants:
                qty = float(v.get("qty") or 0)
                if qty <= 0:
                    continue
                sku = v.get("product_sku")
                size = v.get("size")
                cur.execute(
                    "SELECT COALESCE(SUM(qty), 0) FROM stage_movements "
                    "WHERE order_ref = %s AND from_stage IS NULL "
                    "AND sku IS NOT DISTINCT FROM %s AND size IS NOT DISTINCT FROM %s",
                    (ref, sku, size),
                )
                existing = float(cur.fetchone()[0] or 0)
                delta = round(qty - existing, 2)
                if delta > 0:
                    cur.execute(
                        "INSERT INTO stage_movements "
                        "(order_ref, from_stage, to_stage, qty, moved_by, note, sku, size) "
                        "VALUES (%s, NULL, 'buying_order', %s, 'odoo_sync', "
                        "'Intake from Odoo', %s, %s)",
                        (ref, delta, sku, size),
                    )
                    inserted += 1
                elif delta < 0:
                    # Variant qty shrank on the order — rewrite this bucket's
                    # intake to the current qty so it can't over-count.
                    cur.execute(
                        "DELETE FROM stage_movements "
                        "WHERE order_ref = %s AND from_stage IS NULL "
                        "AND sku IS NOT DISTINCT FROM %s AND size IS NOT DISTINCT FROM %s",
                        (ref, sku, size),
                    )
                    pruned += cur.rowcount or 0
                    cur.execute(
                        "INSERT INTO stage_movements "
                        "(order_ref, from_stage, to_stage, qty, moved_by, note, sku, size) "
                        "VALUES (%s, NULL, 'buying_order', %s, 'odoo_sync', "
                        "'Intake from Odoo (reconciled)', %s, %s)",
                        (ref, qty, sku, size),
                    )
                    inserted += 1
        else:
            # Count ALL existing intake for the order (any sku bucket), not only
            # the sku-NULL row, so an order that previously had per-variant intake
            # but now appears variant-less can't double-count: its per-sku intake
            # already covers the qty, so delta <= 0 and nothing is re-inserted.
            cur.execute(
                "SELECT COALESCE(SUM(qty), 0) FROM stage_movements "
                "WHERE order_ref = %s AND from_stage IS NULL",
                (ref,),
            )
            existing = float(cur.fetchone()[0] or 0)
            delta = round(float(o["order_qty"]) - existing, 2)
            if delta > 0:
                cur.execute(
                    "INSERT INTO stage_movements "
                    "(order_ref, from_stage, to_stage, qty, moved_by, note) "
                    "VALUES (%s, NULL, 'buying_order', %s, 'odoo_sync', 'Intake from Odoo')",
                    (ref, delta),
                )
                inserted += 1
            elif delta < 0:
                log.warning(
                    "BO %s quantity shrank (was %.1f, now %.1f) - left as-is",
                    ref,
                    existing,
                    o["order_qty"],
                )
    log.info(
        "Intake: inserted %s movements; migrated %s legacy whole-order rows; "
        "pruned %s stale-variant intake rows",
        inserted,
        migrated,
        pruned,
    )


# ----------------------------------------------------------------------
def stamp_sync_heartbeat(cur, status, orders_synced):
    """Record that a production-tracker sync just ran successfully.

    Single-row table (id=1) holding the last successful run time, status, and
    how many buying orders were synced. Written inside the same transaction as
    the upserts so the stamp only lands when the data actually committed —
    giving staff a trustworthy "last updated from Odoo" indicator on the board.
    """
    cur.execute("""
        CREATE TABLE IF NOT EXISTS production_sync_heartbeat (
            id            INT PRIMARY KEY DEFAULT 1,
            last_run_at   TIMESTAMPTZ,
            last_status   TEXT,
            orders_synced INT,
            CONSTRAINT production_sync_heartbeat_single CHECK (id = 1)
        )
    """)
    cur.execute("""
        INSERT INTO production_sync_heartbeat (id, last_run_at, last_status, orders_synced)
        VALUES (1, now(), %s, %s)
        ON CONFLICT (id) DO UPDATE
            SET last_run_at   = now(),
                last_status   = EXCLUDED.last_status,
                orders_synced = EXCLUDED.orders_synced
    """, (status, orders_synced))


def main():
    uid, models = odoo_connect()
    bos = fetch_buying_orders(uid, models)
    all_line_ids = [lid for b in bos for lid in b.get("line_ids", [])]
    lines = fetch_lines(uid, models, all_line_ids)
    all_variant_ids = [
        vid for ln in lines for vid in (ln.get("variant_line_ids") or [])
    ]
    variants = fetch_variants(uid, models, all_variant_ids)
    orders, order_lines, order_variants = build(bos, lines, variants)

    # Only orders with a quantity get an intake movement.
    orders_with_qty = [o for o in orders if o["order_qty"] > 0]

    # The fetch is a FULL refresh of every BO, so any colour line / size variant
    # not in these sets has been removed upstream in Odoo and must be pruned, or
    # the report's colour/size counts drift above Odoo truth over time.
    line_keep = {l["odoo_line_id"] for l in order_lines}
    variant_keep = {v["odoo_variant_id"] for v in order_variants}

    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn:
            with conn.cursor() as cur:
                ensure_schema(cur)
                upsert_orders(cur, orders)
                upsert_lines(cur, order_lines)
                prune_lines(cur, line_keep)
                upsert_variants(cur, order_variants)
                prune_variants(cur, variant_keep)
                sync_intake(cur, orders_with_qty, order_variants)
                stamp_sync_heartbeat(cur, "ok", len(orders))
        log.info("Done: %s buying orders synced", len(orders))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
