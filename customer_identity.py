"""Canonical, conservative customer identity publisher.

The identity contract is deliberately small: a real record can only be linked
by the same normalised phone.  Email and names are descriptive fields, never
matching keys.  A source record is always ``system:store:customer_id``.
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import execute_values

PSEUDO = re.compile(r"walk.?in|dormant|newsletter|subscriber|jumia|wholesale|\binfo\b|sample|test|demo|staff|anonymous|\bguest\b|collection|counter|reception", re.I)
DEFAULT_EXPECTED_SOURCES = (
    "odoo:vivofashiongroup",
    "shopify:vivowoman",
    "shopify:vivo-uganda",
    "shopify:vivo-rwanda",
    "shopify:shop-zetu",
)


def _column_exists(cur, table, column):
    cur.execute("""SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=%s AND column_name=%s
    )""", (table, column))
    return bool(cur.fetchone()[0])


def _constraint_exists(cur, table, constraint):
    cur.execute("""SELECT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname='public' AND t.relname=%s AND c.conname=%s
    )""", (table, constraint))
    return bool(cur.fetchone()[0])


def _index_exists(cur, index):
    cur.execute("SELECT to_regclass(%s) IS NOT NULL", ("public." + index,))
    return bool(cur.fetchone()[0])


def source_system(store):
    return "odoo" if store == "vivofashiongroup" else "shopify"


def source_key(system, store, customer_id):
    """Source qualified key; store is mandatory for Shopify ID namespaces."""
    return "%s:%s:%s" % (system, store or "", str(customer_id))


def normal_name(value):
    return re.sub(r"\s+", " ", (value or "").strip()).lower() or None


def pseudo(name, email):
    return bool((name and PSEUDO.search(name)) or
                (email and (email.lower().endswith("@vivofashiongroup.com") or
                            email.lower().endswith("@vivoactivewear.com"))))


def ensure_schema(cur):
    # Kept here too so the CLI is deployable before the additive SQL migration.
    # Never let an idempotent migration wait indefinitely behind BI readers.
    # On an already-current schema the guards below avoid requesting DDL locks
    # at all; on a genuinely old schema this bounds the maintenance attempt.
    cur.execute("SET LOCAL lock_timeout = '5s'")
    cur.execute("""CREATE TABLE IF NOT EXISTS customer_person_registry (
        person_id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS customer_identity_registry (
        source_key TEXT PRIMARY KEY, person_id BIGINT NOT NULL REFERENCES customer_person_registry(person_id),
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS customer_identity_publish_lock (
        lock_name TEXT PRIMARY KEY, touched_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS customer_identity_publish (
        singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
        published_at TIMESTAMPTZ, source_rows INTEGER, source_fingerprint TEXT,
        status TEXT NOT NULL DEFAULT 'never', error TEXT)""")
    if not _column_exists(cur, "customer_identity_publish", "last_error"):
        cur.execute("ALTER TABLE customer_identity_publish ADD COLUMN last_error TEXT")
    cur.execute("""CREATE TABLE IF NOT EXISTS customer_identity_publish_source (
       source_system TEXT NOT NULL, store_id TEXT NOT NULL, source_rows INTEGER NOT NULL,
       published_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(source_system,store_id))""")
    cur.execute("""CREATE TABLE IF NOT EXISTS customer_identity (
        person_id BIGINT NOT NULL, source_key TEXT, source_system TEXT NOT NULL, source_customer_id TEXT NOT NULL,
        store_id TEXT, display_name TEXT, email_n TEXT, phone9 TEXT, name_n TEXT, match_method TEXT,
        built_at TIMESTAMPTZ DEFAULT now())""")
    cur.execute("""CREATE TABLE IF NOT EXISTS customer_people (
        person_id BIGINT PRIMARY KEY,name TEXT,email TEXT,phone TEXT,source_records INTEGER,systems TEXT,
        is_pseudo BOOLEAN,total_orders BIGINT,total_spend_kes NUMERIC,first_purchase DATE,last_purchase DATE,
        customer_type TEXT,built_at TIMESTAMPTZ)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS customer_identity_override (
        source_system TEXT NOT NULL, source_customer_id TEXT NOT NULL, store_id TEXT,
        source_key TEXT, force_person_id BIGINT NOT NULL, reason TEXT, created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS customer_identity_review (
        review_id BIGSERIAL PRIMARY KEY, source_key TEXT, match_key TEXT, key_type TEXT,
        source_ids TEXT[], names TEXT[], status TEXT NOT NULL DEFAULT 'pending',
        resolved_by TEXT, resolved_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(source_key, match_key, key_type))""")
    cur.execute("""CREATE TABLE IF NOT EXISTS customer_identity_override_audit (
        audit_id BIGSERIAL PRIMARY KEY, source_key TEXT NOT NULL, force_person_id BIGINT NOT NULL,
        reason TEXT, created_by TEXT, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
    # Legacy schemas key overrides without store; retain them but qualify lookup
    # only when a matching source key is supplied in the newer source_key column.
    if not _column_exists(cur, "customer_identity_override", "store_id"):
        cur.execute("ALTER TABLE customer_identity_override ADD COLUMN store_id TEXT")
    if not _column_exists(cur, "customer_identity_override", "source_key"):
        cur.execute("ALTER TABLE customer_identity_override ADD COLUMN source_key TEXT")
    if not _column_exists(cur, "customer_identity_override", "updated_at"):
        cur.execute("ALTER TABLE customer_identity_override ADD COLUMN updated_at TIMESTAMPTZ")
    cur.execute("""UPDATE customer_identity_override
                   SET source_key=source_system || ':' ||
                     CASE WHEN source_system='odoo' THEN 'vivofashiongroup'
                          ELSE store_id END || ':' || source_customer_id
                   WHERE source_key IS NULL
                     AND (store_id IS NOT NULL OR source_system='odoo')""")
    # The legacy (system,bare ID) key collides across Shopify stores. Keep
    # unmigrated store-less rows inert for audit/history, while all actionable
    # overrides are uniquely keyed by their fully qualified source key.
    if _constraint_exists(cur, "customer_identity_override", "customer_identity_override_pkey"):
        cur.execute("ALTER TABLE customer_identity_override DROP CONSTRAINT customer_identity_override_pkey")
    if not _index_exists(cur, "customer_identity_override_source_key_uq"):
        cur.execute("""CREATE UNIQUE INDEX customer_identity_override_source_key_uq
                       ON customer_identity_override(source_key) WHERE source_key IS NOT NULL""")
    if not _column_exists(cur, "customer_identity_review", "source_key"):
        cur.execute("ALTER TABLE customer_identity_review ADD COLUMN source_key TEXT")
    if not _index_exists(cur, "customer_identity_review_source_phone_uq"):
        cur.execute("CREATE UNIQUE INDEX customer_identity_review_source_phone_uq ON customer_identity_review(source_key,match_key,key_type)")
    if not _column_exists(cur, "customer_identity", "source_key"):
        cur.execute("ALTER TABLE customer_identity ADD COLUMN source_key TEXT")
    if not _column_exists(cur, "customer_identity", "built_at"):
        cur.execute(
            "ALTER TABLE customer_identity "
            "ADD COLUMN built_at TIMESTAMPTZ DEFAULT now()"
        )
    cur.execute("""UPDATE customer_identity SET source_key=source_system || ':' || COALESCE(store_id,'') || ':' || source_customer_id
                   WHERE source_key IS NULL""")
    # The former (system, bare ID) primary key cannot represent Shopify's
    # per-store namespaces. A unique source_key is the durable compatibility
    # constraint (we intentionally do not DROP tables, grants or review data).
    if _constraint_exists(cur, "customer_identity", "customer_identity_pkey"):
        cur.execute("ALTER TABLE customer_identity DROP CONSTRAINT customer_identity_pkey")
    if not _index_exists(cur, "customer_identity_source_key_uq"):
        cur.execute("CREATE UNIQUE INDEX customer_identity_source_key_uq ON customer_identity(source_key)")
    # Every reader resolves a ledger customer through this *store-qualified*
    # pair.  A bare Shopify id is not a customer key, and a sequential scan here
    # makes the otherwise small identity map an expensive part of BI queries.
    if not _index_exists(cur, "customer_identity_store_customer_uq"):
        cur.execute("""CREATE UNIQUE INDEX customer_identity_store_customer_uq
                       ON customer_identity(store_id, source_customer_id)""")
    if not _index_exists(cur, "customer_identity_person_idx"):
        cur.execute("""CREATE INDEX customer_identity_person_idx
                       ON customer_identity(person_id)""")
    # Seed registry for legacy persons before adding the FK.  Old IDs can then
    # remain valid instead of being renumbered during the additive migration.
    cur.execute("""INSERT INTO customer_person_registry(person_id)
      SELECT DISTINCT person_id FROM customer_identity WHERE person_id IS NOT NULL
      ON CONFLICT DO NOTHING""")
    cur.execute("""SELECT setval(pg_get_serial_sequence('customer_person_registry','person_id'),
                   COALESCE((SELECT max(person_id) FROM customer_person_registry),1), true)""")
    if not _constraint_exists(cur, "customer_identity", "customer_identity_person_fk"):
        cur.execute("""ALTER TABLE customer_identity ADD CONSTRAINT customer_identity_person_fk
                       FOREIGN KEY(person_id) REFERENCES customer_person_registry(person_id) NOT VALID""")
    if not _column_exists(cur, "customer_people", "built_at"):
        cur.execute("ALTER TABLE customer_people ADD COLUMN built_at TIMESTAMPTZ")


def _new_person(cur):
    cur.execute("INSERT INTO customer_person_registry DEFAULT VALUES RETURNING person_id")
    return cur.fetchone()[0]


def read_nodes(cur):
    cur.execute("""SELECT customer_id, store_id, first_name, last_name, email, phone
                   FROM all_customers WHERE customer_id IS NOT NULL AND store_id IS NOT NULL""")
    nodes = []
    for cid, store, first, last, email, phone in cur.fetchall():
        system = source_system(store)
        display = ("%s %s" % (first or "", last or "")).strip()
        nodes.append(dict(key=source_key(system, store, cid), system=system, store=store,
                          customer_id=str(cid), display=display, email=email, phone=phone,
                          name=normal_name(display), pseudo=pseudo(display, email)))
    return nodes


def resolve(cur, nodes):
    cur.execute("SELECT source_key, person_id FROM customer_identity_registry")
    known = dict(cur.fetchall())
    # A legacy bare-ID override is intentionally inert until migrated with an
    # explicit source_key: applying it to every Shopify store would be unsafe.
    cur.execute("""SELECT source_key, force_person_id, reason, created_by
                   FROM customer_identity_override WHERE source_key IS NOT NULL""")
    overrides = {r[0]: r[1:] for r in cur.fetchall()}
    phone_groups = defaultdict(list)
    for n in nodes:
        if not n["pseudo"] and n["phone"]:
            phone_groups[n["phone"]].append(n)
    ambiguous = set()
    review_rows = []
    for phone, group in phone_groups.items():
        # Different non-empty names are a shared contact, not evidence to merge.
        if len({n["name"] for n in group if n["name"]}) > 1:
            ambiguous.update(n["key"] for n in group)
            for n in group:
                review_rows.append((
                    n["key"], phone, [x["key"] for x in group],
                    sorted({x["display"] for x in group if x["display"]}),
                ))
    if review_rows:
        execute_values(cur, """INSERT INTO customer_identity_review(
            source_key,match_key,key_type,source_ids,names)
            VALUES %s ON CONFLICT (source_key,match_key,key_type)
            DO UPDATE SET source_ids=EXCLUDED.source_ids,names=EXCLUDED.names""",
            review_rows, template="(%s,%s,'phone_ambiguous',%s,%s)",
            page_size=1000)
    # Establish a registry ID for every source before merges. Allocate missing
    # IDs in deterministic batches: one round trip per source made a cold
    # production publication take many minutes and increased its failure risk.
    missing_keys = sorted(n["key"] for n in nodes if n["key"] not in known)
    for start in range(0, len(missing_keys), 1000):
        batch = missing_keys[start:start + 1000]
        cur.execute("SELECT coalesce(max(person_id),0) FROM customer_person_registry")
        base_person_id = cur.fetchone()[0]
        inserted = execute_values(cur, """
          WITH numbered_keys(source_key,person_id) AS (VALUES %s),
          allocated AS (
            INSERT INTO customer_person_registry(person_id,created_at)
            SELECT person_id,now() FROM numbered_keys
            RETURNING person_id
          )
          INSERT INTO customer_identity_registry(source_key,person_id)
          SELECT k.source_key,k.person_id FROM numbered_keys k
          JOIN allocated i USING(person_id)
          RETURNING source_key,person_id
        """, [(key, base_person_id + offset + 1)
              for offset, key in enumerate(batch)],
            page_size=1000, fetch=True)
        known.update(inserted)
        cur.execute("""SELECT setval(
          pg_get_serial_sequence('customer_person_registry','person_id'),
          (SELECT max(person_id) FROM customer_person_registry),true)""")
    registry_merges = []
    for phone, group in phone_groups.items():
        eligible = [n for n in group if n["key"] not in ambiguous and n["key"] not in overrides]
        if len(eligible) > 1:
            winner = min(known[n["key"]] for n in eligible)
            for n in eligible:
                known[n["key"]] = winner
                registry_merges.append((winner, n["key"]))
    if registry_merges:
        execute_values(cur, """UPDATE customer_identity_registry r SET
            person_id=v.person_id,last_seen_at=now()
            FROM (VALUES %s) v(person_id,source_key)
            WHERE r.source_key=v.source_key""", registry_merges, page_size=1000)
    out = []
    for n in nodes:
        method = "pseudo" if n["pseudo"] else ("ambiguous_phone" if n["key"] in ambiguous else "phone")
        pid = known[n["key"]]
        if n["key"] in overrides:
            pid, reason, actor = overrides[n["key"]]
            method = "override"
            cur.execute("""INSERT INTO customer_identity_override_audit(source_key,force_person_id,reason,created_by)
              SELECT %s,%s,%s,%s WHERE NOT EXISTS (
                SELECT 1 FROM customer_identity_override_audit
                WHERE source_key=%s AND force_person_id=%s AND reason IS NOT DISTINCT FROM %s
                  AND created_by IS NOT DISTINCT FROM %s)""",
                        (n["key"], pid, reason, actor, n["key"], pid, reason, actor))
        out.append((pid, n["key"], n["system"], n["customer_id"], n["store"], n["display"], n["email"], n["phone"], n["name"], method))
    cur.execute(
        "UPDATE customer_identity_registry SET last_seen_at=now() "
        "WHERE source_key=ANY(%s)",
        ([n["key"] for n in nodes],),
    )
    return out


def expected_sources(value=None):
    raw = os.getenv("IDENTITY_EXPECTED_SOURCES") if value is None else value
    if raw is None:
        return set(DEFAULT_EXPECTED_SOURCES)
    if isinstance(raw, str):
        return {item.strip() for item in raw.split(",") if item.strip()}
    return set(raw)


def _readiness_failed(report, threshold, ready_stores):
    if ready_stores:
        stores = set(ready_stores)
        unmatched = sum(
            item["unmatched_sales"]
            for item in report["markets"]
            if item["store"] in stores
        )
        ambiguous = sum(
            item["ambiguous_sales"]
            for item in report["markets"]
            if item["store"] in stores
        )
        source_ready = all(
            any(item["store"] == store for item in report["markets"])
            for store in stores
        )
        return unmatched > threshold or ambiguous > 0 or not source_ready
    return (
        report["blocking_unmatched_sales_lines"] > threshold
        or not report["ready"]
    )


def _publish(
    conn,
    minimum_rows=1,
    regression_tolerance=None,
    required_sources=None,
    ready_stores=None,
):
    cur = conn.cursor()
    ensure_schema(cur)
    cur.execute("INSERT INTO customer_identity_publish_lock(lock_name) VALUES ('canonical') ON CONFLICT DO NOTHING")
    cur.execute("SELECT lock_name FROM customer_identity_publish_lock WHERE lock_name='canonical' FOR UPDATE")
    nodes = read_nodes(cur)
    if len(nodes) < minimum_rows:
        raise ValueError("refusing incomplete customer snapshot: %d rows (< %d)" % (len(nodes), minimum_rows))
    tolerance = float(os.getenv("IDENTITY_SOURCE_REGRESSION_TOLERANCE", "0.20") if regression_tolerance is None else regression_tolerance)
    current_sources = defaultdict(int)
    for n in nodes: current_sources[(n["system"], n["store"])] += 1
    current_source_names = {"%s:%s" % key for key in current_sources}
    missing_sources = expected_sources(required_sources) - current_source_names
    if missing_sources:
        raise ValueError(
            "refusing incomplete customer snapshot; missing required sources: %s"
            % ",".join(sorted(missing_sources))
        )
    # Avoid locking and rebuilding the 500k-row canonical snapshot when the
    # resolution-relevant source fields are unchanged.
    import hashlib as _hashlib

    _src_sig = "\n".join(
        sorted(
            "%s\x1f%s\x1f%s\x1f%s\x1f%d"
            % (
                n["key"],
                (n["email"] or ""),
                (n["phone"] or ""),
                (n["name"] or ""),
                1 if n["pseudo"] else 0,
            )
            for n in nodes
        )
    )
    cur.execute("""SELECT md5(coalesce(string_agg(sig, E'\\n' ORDER BY sig),''))
      FROM (
        SELECT concat_ws(E'\\x1f',coalesce(store_id,''),coalesce(customer_id::text,''),
          coalesce(order_id::text,''),coalesce(sale_date::text,''),
          coalesce(total_sales_kes::text,''),coalesce(sale_kind,'')) sig
        FROM all_sales WHERE sale_kind IN ('sale','order')
      ) attributed_sales""")
    _sales_sig = cur.fetchone()[0]
    cur.execute("""SELECT count(*),max(coalesce(updated_at,created_at)),
                          coalesce(sum(force_person_id),0)
                   FROM customer_identity_override
                   WHERE source_key IS NOT NULL""")
    _override_sig = cur.fetchone()
    _src_sig += "\nSALES\x1f%s" % _sales_sig
    _src_sig += "\nOVERRIDES\x1f%s" % (
        "\x1f".join(str(v) for v in _override_sig),
    )
    _src_fp = _hashlib.md5(_src_sig.encode()).hexdigest()
    cur.execute(
        "SELECT source_fingerprint FROM customer_identity_publish "
        "WHERE singleton AND status='ready'"
    )
    _prev = cur.fetchone()
    if _prev and _prev[0] == _src_fp and not os.getenv("IDENTITY_FORCE_PUBLISH"):
        report = reconciliation(cur)
        threshold = float(os.getenv("IDENTITY_UNMATCHED_SALES_THRESHOLD", "0"))
        if _readiness_failed(report, threshold, ready_stores):
            raise ValueError(
                "identity readiness failed: %s"
                % json.dumps(report, sort_keys=True)
            )
        cur.execute(
            "UPDATE customer_identity_publish SET published_at=now() "
            "WHERE singleton AND status='ready'"
        )
        conn.commit()
        report.update({
            "skipped": "source unchanged",
            "nodes": len(nodes),
            "fingerprint": _src_fp,
        })
        return report
    cur.execute("SELECT source_system,store_id,source_rows FROM customer_identity_publish_source")
    for system, store, prior in cur.fetchall():
        actual = current_sources.get((system, store), 0)
        if prior and actual < prior * (1 - tolerance):
            raise ValueError("refusing incomplete source snapshot %s/%s: %s < %s (tolerance %.2f)" %
                             (system, store, actual, prior, tolerance))
    rows = resolve(cur, nodes)
    # Upsert/delete live tables in this one transaction. No DROP/rename means
    # grants, constraints and audit/review state survive and readers see old/new.
    execute_values(cur, """INSERT INTO customer_identity
      (person_id,source_key,source_system,source_customer_id,store_id,display_name,email_n,phone9,name_n,match_method)
      VALUES %s ON CONFLICT (source_key) DO UPDATE SET person_id=EXCLUDED.person_id,display_name=EXCLUDED.display_name,
      email_n=EXCLUDED.email_n,phone9=EXCLUDED.phone9,name_n=EXCLUDED.name_n,match_method=EXCLUDED.match_method,built_at=now()""", rows)
    cur.execute("DELETE FROM customer_identity WHERE source_key IS NOT NULL AND NOT (source_key = ANY(%s))", ([r[1] for r in rows],))
    build_people(cur)
    execute_values(cur, """INSERT INTO customer_identity_publish_source(source_system,store_id,source_rows,published_at)
      VALUES %s ON CONFLICT(source_system,store_id) DO UPDATE SET source_rows=EXCLUDED.source_rows,published_at=EXCLUDED.published_at""",
      [(a, b, c, datetime.now(timezone.utc)) for (a,b),c in current_sources.items()])
    cur.execute("""INSERT INTO customer_identity_publish(singleton,published_at,source_rows,source_fingerprint,status,error)
      VALUES(true,now(),%s,%s,'ready',NULL) ON CONFLICT(singleton) DO UPDATE SET
      published_at=EXCLUDED.published_at,source_rows=EXCLUDED.source_rows,source_fingerprint=EXCLUDED.source_fingerprint,status='ready',error=NULL,last_error=NULL""",
      (len(rows), _src_fp))
    report = reconciliation(cur)
    threshold = float(os.getenv("IDENTITY_UNMATCHED_SALES_THRESHOLD", "0"))
    if _readiness_failed(report, threshold, ready_stores):
        raise ValueError("identity readiness failed: %s" % json.dumps(report, sort_keys=True))
    # Reconciliation is part of the publication transaction.  Committing before
    # this gate would expose an unready identity/people snapshot even though the
    # caller receives a failure.
    conn.commit()
    return report


def publish(
    conn,
    minimum_rows=1,
    regression_tolerance=None,
    required_sources=None,
    ready_stores=None,
):
    """Publish or retain live state and persist a failure diagnostic."""
    try:
        return _publish(
            conn,
            minimum_rows,
            regression_tolerance,
            required_sources,
            ready_stores,
        )
    except Exception as exc:
        conn.rollback()
        try:
            cur = conn.cursor()
            ensure_schema(cur)
            cur.execute("""INSERT INTO customer_identity_publish(singleton,status,last_error)
              VALUES(true,'never',%s) ON CONFLICT(singleton)
              DO UPDATE SET last_error=EXCLUDED.last_error""", (str(exc),))
            conn.commit()
        except Exception:
            conn.rollback()
        raise


def build_people(cur):
    # Sales resolution only joins source-qualified store + system; a ledger row
    # lacking a safely derivable system is deliberately counted as unmatched.
    cur.execute("""CREATE TABLE IF NOT EXISTS customer_people (
      person_id BIGINT PRIMARY KEY,name TEXT,email TEXT,phone TEXT,source_records INTEGER,systems TEXT,
      is_pseudo BOOLEAN,total_orders BIGINT,total_spend_kes NUMERIC,first_purchase DATE,last_purchase DATE,
      customer_type TEXT,built_at TIMESTAMPTZ)""")
    cur.execute("DROP TABLE IF EXISTS _cp")
    cur.execute("""CREATE TEMP TABLE _cp AS
      WITH attrs AS (SELECT person_id, max(display_name) FILTER (WHERE display_name<>'') name,
        max(email_n) email,max(phone9) phone,count(*) source_records,string_agg(DISTINCT source_system,'+' ORDER BY source_system) systems,
        bool_or(match_method='pseudo') is_pseudo FROM customer_identity GROUP BY person_id),
      sales AS (SELECT ci.person_id,
        count(DISTINCT (s.store_id,s.order_id)) orders,
        sum(s.total_sales_kes) spend,min(s.sale_date::date) first_purchase,max(s.sale_date::date) last_purchase
        FROM all_sales s JOIN customer_identity ci
          ON ci.source_customer_id=s.customer_id::text AND ci.store_id=s.store_id
        WHERE s.sale_kind IN ('sale','order')
          AND ci.match_method <> 'pseudo'
        GROUP BY ci.person_id)
      SELECT a.*,coalesce(s.orders,0) total_orders,coalesce(s.spend,0) total_spend_kes,s.first_purchase,s.last_purchase,
       CASE WHEN coalesce(s.orders,0)>1 THEN 'Returning' WHEN coalesce(s.orders,0)=1 THEN 'New' ELSE 'No purchase' END customer_type,now() built_at
      FROM attrs a LEFT JOIN sales s USING(person_id)""")
    # This is a derived snapshot and publication is one transaction. Legacy
    # production tables may not have a person_id unique constraint, so avoid an
    # ON CONFLICT dependency while preserving the table object and its grants.
    cur.execute("DELETE FROM customer_people")
    cur.execute("INSERT INTO customer_people SELECT * FROM _cp")


def reconciliation(cur):
    cur.execute("""SELECT source_system,store_id,count(*),count(DISTINCT person_id),
      count(*) FILTER (WHERE match_method='pseudo'),count(*) FILTER (WHERE match_method='ambiguous_phone')
      FROM customer_identity GROUP BY source_system,store_id ORDER BY 1,2""")
    data = [dict(system=a, store=b, source_records=c, people=d, pseudo=e, ambiguous=f) for a,b,c,d,e,f in cur.fetchall()]
    # A left join to a source-qualified identity is intentionally the only
    # resolution path. Rows that cannot be attributed are reported, never
    # guessed from bare customer_id (which collides across Shopify stores).
    cur.execute("""SELECT CASE WHEN s.store_id='vivofashiongroup' THEN 'odoo' ELSE 'shopify' END,
       s.store_id, count(DISTINCT s.order_id), coalesce(sum(s.total_sales_kes),0),
       count(*) FILTER (WHERE s.customer_id IS NOT NULL AND ci.person_id IS NULL),
       count(*) FILTER (WHERE ci.match_method='ambiguous_phone')
      FROM all_sales s LEFT JOIN customer_identity ci
        ON ci.source_customer_id=s.customer_id::text AND ci.store_id=s.store_id
      WHERE s.sale_kind IN ('sale','order') GROUP BY 1,2""")
    sales = {(a,b): dict(sales_orders=c, sales_spend=float(d), unmatched_sales=e,
                         ambiguous_sales=f) for a,b,c,d,e,f in cur.fetchall()}
    for (system, store), values in sales.items():
        if not any(x["system"] == system and x["store"] == store for x in data):
            data.append(dict(system=system, store=store, source_records=0, people=0,
                             pseudo=0, ambiguous=0, **values))
    for item in data:
        item.update(sales.get((item["system"], item["store"]),
                              dict(sales_orders=0, sales_spend=0, unmatched_sales=0, ambiguous_sales=0)))
    totals = dict(sales_orders=sum(x["sales_orders"] for x in data),
                  sales_spend=sum(x["sales_spend"] for x in data),
                  unmatched_sales_lines=sum(x["unmatched_sales"] for x in data),
                  ambiguous_sales_lines=sum(x["ambiguous_sales"] for x in data),
                  people=sum(x["people"] for x in data), pseudo=sum(x["pseudo"] for x in data))
    cur.execute("SELECT to_regclass('shopify_customer_missing_retry')")
    retried_unmatched = 0
    if cur.fetchone()[0] is not None:
        cur.execute("""SELECT count(*)
          FROM all_sales s
          JOIN shopify_customer_missing_retry q
            ON q.store_id=s.store_id AND q.customer_id=s.customer_id::text
          LEFT JOIN customer_identity ci
            ON ci.store_id=s.store_id AND ci.source_customer_id=s.customer_id::text
          WHERE s.sale_kind IN ('sale','order') AND ci.person_id IS NULL""")
        retried_unmatched = cur.fetchone()[0]
    totals["retry_queued_unmatched_sales_lines"] = retried_unmatched
    return {"generated_at": datetime.now(timezone.utc).isoformat(), "markets": data, "totals": totals,
            "unmatched_sales_lines": totals["unmatched_sales_lines"],
            "blocking_unmatched_sales_lines": totals["unmatched_sales_lines"],
            "ready": bool(data) and not any(x["ambiguous_sales"] for x in data)}


def diagnostics(cur):
    """Return publication freshness and reconciliation in one stable contract.

    This intentionally does not attempt a new match or mutate state.  Operators
    can distinguish an old known-good snapshot from a missing/failed publisher,
    while BI readers retain the last atomically published customer_people view.
    """
    cur.execute("SELECT to_regclass('customer_identity_publish')")
    if cur.fetchone()[0] is not None:
        cur.execute("""SELECT status, published_at, source_rows,
                              source_fingerprint, last_error
                       FROM customer_identity_publish WHERE singleton=true""")
        row = cur.fetchone()
        publish = dict(
            status=row[0] if row else "never",
            published_at=row[1].isoformat() if row and row[1] else None,
            source_rows=row[2] if row else 0,
            source_fingerprint=row[3] if row else None,
            last_error=row[4] if row else None,
        )
    else:
        publish = dict(
            status="compatibility_snapshot",
            published_at=None,
            source_rows=0,
            source_fingerprint=None,
            last_error="customer_identity_publish metadata is not installed",
        )
    cur.execute("""SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema()
          AND table_name='customer_people' AND column_name='built_at')""")
    has_built_at = cur.fetchone()[0]
    cur.execute(
        "SELECT max(built_at), count(*) FROM customer_people"
        if has_built_at else
        "SELECT NULL::timestamptz, count(*) FROM customer_people"
    )
    people_built_at, people_count = cur.fetchone()
    report = reconciliation(cur)
    cur.execute("SELECT to_regclass('shopify_customer_source_sync')")
    source_freshness = []
    has_source_status = cur.fetchone()[0] is not None
    if has_source_status:
        cur.execute("""
            WITH raw_fresh AS (
              SELECT store_id,max(_loaded_at) raw_loaded_at
              FROM raw_shopify_customers GROUP BY store_id
            ), unresolved AS (
              SELECT s.store_id,count(DISTINCT s.customer_id) unresolved
              FROM all_sales s
              WHERE s.sale_kind IN ('sale','order')
                AND s.sale_date::date >= (now()-interval '7 days')::date
                AND s.customer_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM all_customers ac
                  WHERE ac.store_id=s.store_id
                    AND ac.customer_id=s.customer_id::text
                )
              GROUP BY s.store_id
            )
            SELECT q.store_id,q.status,q.attempted_at,q.succeeded_at,
                   q.source_updated_at,q.rows_fetched,q.error,
                   r.raw_loaded_at,coalesce(u.unresolved,0)
            FROM shopify_customer_source_sync q
            LEFT JOIN raw_fresh r USING(store_id)
            LEFT JOIN unresolved u USING(store_id)
            ORDER BY q.store_id
        """)
        for row in cur.fetchall():
            source_freshness.append({
                "store": row[0],
                "status": row[1],
                "attempted_at": row[2].isoformat() if row[2] else None,
                "succeeded_at": row[3].isoformat() if row[3] else None,
                "source_updated_at": row[4].isoformat() if row[4] else None,
                "rows_fetched": row[5],
                "error": row[6],
                "raw_loaded_at": row[7].isoformat() if row[7] else None,
                "unresolved_recent_customers": row[8],
            })
    required_shopify_stores = {
        item.split(":", 1)[1]
        for item in expected_sources()
        if item.startswith("shopify:")
    }
    required_sources_ready = not has_source_status or all(
        any(
            item["store"] == store and item["status"] == "ready"
            for item in source_freshness
        )
        for store in required_shopify_stores
    )
    publish.update({
        "people_built_at": people_built_at.isoformat() if people_built_at else None,
        "people_count": people_count,
        "reconciliation": report,
        "shopify_sources": source_freshness,
        "fresh": publish["status"] == "ready"
                 and publish["published_at"] is not None
                 and people_built_at is not None
                  and report["ready"]
                  and required_sources_ready,
    })
    return publish


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--reconcile", action="store_true")
    ap.add_argument("--minimum-rows", type=int, default=int(os.getenv("IDENTITY_MIN_ROWS", "1")))
    ap.add_argument(
        "--expected-sources",
        default=os.getenv("IDENTITY_EXPECTED_SOURCES"),
        help="comma-separated system:store sources; defaults to all production customer sources",
    )
    args = ap.parse_args(argv)
    conn = psycopg2.connect(os.getenv("VIVO_DATABASE_URL") or os.environ["DATABASE_URL"])
    try:
        if args.reconcile:
            cur = conn.cursor(); ensure_schema(cur); conn.commit()
            report = reconciliation(cur); print(json.dumps(report, sort_keys=True))
            return 0 if report["ready"] else 2
        print(
            json.dumps(
                publish(
                    conn,
                    args.minimum_rows,
                    required_sources=args.expected_sources,
                ),
                sort_keys=True,
            )
        )
        return 0
    except Exception as exc:
        conn.rollback()
        # Failure metadata is deliberately a separate short transaction, so
        # last-known-good identity/people rows are never replaced.
        try:
            cur = conn.cursor(); ensure_schema(cur)
            cur.execute("""INSERT INTO customer_identity_publish(singleton,status,last_error)
              VALUES(true,'never',%s) ON CONFLICT(singleton) DO UPDATE SET last_error=EXCLUDED.last_error""", (str(exc),))
            conn.commit()
        except Exception:
            conn.rollback()
        print("identity publish failed: %s" % exc, file=sys.stderr); return 1
    finally: conn.close()

if __name__ == "__main__":
    sys.exit(main())
