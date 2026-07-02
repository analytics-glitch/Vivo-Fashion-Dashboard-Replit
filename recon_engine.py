"""
Odoo Reconciliation Agent — matching engine + run orchestration + staging write-back.

Four reconciliation types, all computed in SQL against warehouse tables synced by
sync_accounting.py, with results persisted as suggestion items a finance user
approves/rejects on the BI dashboard (/reconciliation). Nothing is written to Odoo
without an approval, and the write target is the STAGING instance (ODOO_WRITE_*
secrets) until the user explicitly repoints it.

  sales_ledger : all_sales (POS/Shopify operational truth) vs Odoo POS payments
                 per store per EAT day — did every sale land in Odoo?
  collections  : POS takings split by method class (mpesa/kcb/coop/cash/boya) vs
                 the matching per-store journals — did the money hit the books?
  bank         : unreconciled bank statement lines vs candidate payments/entries —
                 auto-match by amount + date window + reference.
  payables     : vendor bills — aging, outstanding, duplicate candidates, and
                 payment-match suggestions.

Statuses: matched / variance / missing (aggregate rows), suggested / exception
(bank + payables item rows), approved / rejected / written (human lifecycle).
Re-runs NEVER clobber human decisions (approved/rejected/written are terminal for
the matcher; only the writer moves approved -> written).
"""
import os, re, json, logging, hashlib
from datetime import datetime, date, timedelta

import psycopg2
import psycopg2.extras

log = logging.getLogger("recon_engine")

DATABASE_URL = os.environ["DATABASE_URL"]

RECON_LOCK_KEY = 0x5EC0_11C3  # advisory lock for run exclusivity

# Matching tolerances (KES)
AGG_TOL_ABS = 100.0      # aggregate compare: absolute tolerance
AGG_TOL_PCT = 0.005      # ...or 0.5%
LINE_TOL_ABS = 1.0       # line-level amount equality tolerance
BANK_DATE_WINDOW = 5     # days each side for bank candidate matching
POS_ERA_START = "2026-03-01"   # Odoo POS + accounting era

# ---------------------------------------------------------------- store canon

_ALIASES = {
    "thikaroadmall": "trm",
    "mombasacitymall": "citymall",
    "mombasacbd": "msadigoroad",
    "kisumuunitedmall": "kisumu",
    "merugreenwood": "meru",
    "rundamall": "runda",
    "saritsafari": "safarisarit",
    "saritzoya": "zoyasarit",
    "eldoretrupa": "eldoret",
    "nakuruwestsidemall": "nakuru",
    "mamanginast": "mamangina",
    "hqoutlet": "hq",
    "hqwallet": "hq",
    "staffpurchases": "hq",   # 'Staff purchases' store sells through the HQ Wallet POS
}

# Odoo-side POS configs that must NOT reconcile against Kenya retail sales
_SALES_LEDGER_EXCLUDE = {"shopzetuonline"}
_PREFIXES = ("vivo ", "mpesa-", "mpesa ", "coop-", "coop ", "cash-", "cash ",
             "kcb-", "kcb ", "boya - ", "boya-", "boya ", "dtb-", "dtb ")
_SUFFIXES = (" manual",)


def canon_store(name):
    """Canonical store key shared by every reconciliation type.
    'Vivo T- Mall' == 'KCB-T-Mall' == 'Tmall/0963' prefix == 'tmall'."""
    if not name:
        return None
    s = str(name).strip().lower()
    for p in _PREFIXES:
        if s.startswith(p):
            s = s[len(p):]
            break
    for suf in _SUFFIXES:
        if s.endswith(suf):
            s = s[: -len(suf)]
    # Keep parenthetical text and collapse everything, then alias:
    # 'Mombasa (City Mall)' -> 'mombasacitymall' -> 'citymall' (matches 'Vivo City Mall')
    s = re.sub(r"[^a-z0-9]", "", s)        # collapse punctuation/space: 'T- Mall' -> 'tmall'
    return _ALIASES.get(s, s) or None


def method_class(method_or_journal_name):
    """mpesa / kcb / coop / cash / boya / dtb — from 'Mpesa-Sarit', 'KCB-Two Rivers'..."""
    if not method_or_journal_name:
        return None
    s = str(method_or_journal_name).strip().lower()
    for cls in ("mpesa", "kcb", "coop", "cash", "boya", "dtb"):
        if s.startswith(cls):
            return cls
    return None

# ------------------------------------------------------------------- schema

def ensure_recon_tables(conn):
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS recon_runs (
                id           BIGSERIAL PRIMARY KEY,
                run_trigger  TEXT NOT NULL,           -- nightly | manual
                triggered_by TEXT,
                started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                finished_at  TIMESTAMPTZ,
                status       TEXT NOT NULL DEFAULT 'running',  -- running|completed|failed
                stats        JSONB,
                error        TEXT
            );
            CREATE TABLE IF NOT EXISTS recon_items (
                item_key    TEXT PRIMARY KEY,
                recon_type  TEXT NOT NULL,   -- sales_ledger|collections|bank|payables
                store       TEXT,
                day         DATE,
                status      TEXT NOT NULL,
                confidence  NUMERIC,
                amount_a    NUMERIC,         -- operational / statement side
                amount_b    NUMERIC,         -- ledger / candidate side
                diff        NUMERIC,
                details     JSONB,
                run_id      BIGINT,
                first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                approved_by TEXT,
                approved_at TIMESTAMPTZ,
                rejected_by TEXT,
                rejected_at TIMESTAMPTZ,
                written_at  TIMESTAMPTZ,
                writeback_result JSONB
            );
            CREATE INDEX IF NOT EXISTS idx_recon_items_type_status
                ON recon_items(recon_type, status);
            CREATE INDEX IF NOT EXISTS idx_recon_items_day ON recon_items(day);
            CREATE TABLE IF NOT EXISTS recon_audit (
                id        BIGSERIAL PRIMARY KEY,
                item_key  TEXT,
                action    TEXT NOT NULL,
                actor     TEXT,
                at        TIMESTAMPTZ NOT NULL DEFAULT now(),
                payload   JSONB
            );
        """)
    conn.commit()


def audit(conn, item_key, action, actor, payload=None):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO recon_audit (item_key, action, actor, payload) VALUES (%s,%s,%s,%s)",
            (item_key, action, actor, json.dumps(payload) if payload is not None else None),
        )

# The matcher may freely (re)compute these; human decisions are terminal.
_MACHINE_STATES = ("matched", "variance", "missing", "suggested", "exception")


def _upsert_items(conn, rows, run_id):
    """rows: list of dicts with item_key, recon_type, store, day, status,
    confidence, amount_a, amount_b, diff, details."""
    if not rows:
        return 0
    vals = [(r["item_key"], r["recon_type"], r.get("store"), r.get("day"),
             r["status"], r.get("confidence"), r.get("amount_a"), r.get("amount_b"),
             r.get("diff"), json.dumps(r.get("details") or {}), run_id)
            for r in rows]
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(cur, """
            INSERT INTO recon_items
              (item_key, recon_type, store, day, status, confidence,
               amount_a, amount_b, diff, details, run_id)
            VALUES %s
            ON CONFLICT (item_key) DO UPDATE SET
              status     = EXCLUDED.status,
              confidence = EXCLUDED.confidence,
              amount_a   = EXCLUDED.amount_a,
              amount_b   = EXCLUDED.amount_b,
              diff       = EXCLUDED.diff,
              details    = EXCLUDED.details,
              run_id     = EXCLUDED.run_id,
              updated_at = now()
            WHERE recon_items.status IN
              ('matched','variance','missing','suggested','exception')
        """, vals, template="(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            page_size=500)
    return len(vals)

# ---------------------------------------------------------------- matchers

def _agg_status(a, b):
    a = float(a or 0); b = float(b or 0)
    diff = a - b
    if a == 0 and b == 0:
        return "matched", diff
    if a != 0 and b == 0:
        return "missing", diff
    if abs(diff) <= max(AGG_TOL_ABS, abs(a) * AGG_TOL_PCT):
        return "matched", diff
    return "variance", diff


def match_sales_ledger(conn, run_id, days=92):
    """all_sales (Kenya POS) vs Odoo POS payments, per canonical store per EAT day."""
    since = max(date.today() - timedelta(days=days), date.fromisoformat(POS_ERA_START))
    with conn.cursor() as cur:
        cur.execute("""
            SELECT pos_location_name, sale_date::date AS day, SUM(total_sales_kes)
            FROM all_sales
            WHERE country = 'Kenya' AND channel != 'Online'
              AND sale_date::date >= %s AND sale_date::date < CURRENT_DATE
            GROUP BY 1, 2
        """, (since,))
        sales = {}
        for name, day, amt in cur.fetchall():
            key = (canon_store(name), day)
            if key[0]:
                sales[key] = sales.get(key, 0.0) + float(amt or 0)
        cur.execute("""
            SELECT split_part(pos_order_name, '/', 1) AS store,
                   (payment_date + interval '3 hours')::date AS day,
                   SUM(amount)
            FROM raw_pos_payments
            WHERE payment_date IS NOT NULL
              AND (payment_date + interval '3 hours')::date >= %s
              AND (payment_date + interval '3 hours')::date < CURRENT_DATE
            GROUP BY 1, 2
        """, (since,))
        odoo = {}
        store_labels = {}
        for name, day, amt in cur.fetchall():
            ck = canon_store(name)
            if not ck or ck in _SALES_LEDGER_EXCLUDE:
                continue
            odoo[(ck, day)] = odoo.get((ck, day), 0.0) + float(amt or 0)
            store_labels.setdefault(ck, name)
    rows = []
    for (store, day) in sorted(set(sales) | set(odoo)):
        a = sales.get((store, day), 0.0)
        b = odoo.get((store, day), 0.0)
        status, diff = _agg_status(a, b)
        if a == 0 and b != 0:
            status = "variance"  # Odoo has takings the sales feed lacks
        rows.append({
            "item_key": f"sales|{store}|{day}",
            "recon_type": "sales_ledger", "store": store, "day": day,
            "status": status, "confidence": 1.0 if status == "matched" else None,
            "amount_a": round(a, 2), "amount_b": round(b, 2), "diff": round(diff, 2),
            "details": {"sales_kes": round(a, 2), "odoo_pos_kes": round(b, 2),
                        "store_label": store_labels.get(store, store)},
        })
    return _upsert_items(conn, rows, run_id)


def _week_start(d):
    return d - timedelta(days=d.weekday())


def match_collections(conn, run_id, days=92):
    """POS takings by method class vs the matching per-store journals, per EAT day."""
    since = max(date.today() - timedelta(days=days), date.fromisoformat(POS_ERA_START))
    with conn.cursor() as cur:
        cur.execute("""
            SELECT payment_method_name,
                   (payment_date + interval '3 hours')::date AS day,
                   SUM(amount)
            FROM raw_pos_payments
            WHERE payment_date IS NOT NULL
              AND (payment_date + interval '3 hours')::date >= %s
              AND (payment_date + interval '3 hours')::date < CURRENT_DATE
            GROUP BY 1, 2
        """, (since,))
        takings = {}
        for method, day, amt in cur.fetchall():
            cls, store = method_class(method), canon_store(method)
            if not cls or not store:
                continue
            # Cash is counted and booked in multi-day batches, so a per-day
            # compare is structurally noisy — bucket cash by ISO week instead.
            k = (cls, store, _week_start(day) if cls == "cash" else day)
            takings[k] = takings.get(k, 0.0) + float(amt or 0)
        # Non-cash classes: journal entries (mpesa/kcb/coop/boya post per payment
        # or per session close — amount_total sums cleanly per day).
        cur.execute("""
            SELECT m.journal_name, m.date, SUM(m.amount_total)
            FROM raw_account_moves m
            JOIN raw_account_journals j ON j.id = m.journal_id
            WHERE j.journal_type IN ('bank','cash') AND m.state = 'posted'
              AND m.date >= %s AND m.date < CURRENT_DATE
            GROUP BY 1, 2
        """, (since,))
        booked = {}
        for jname, day, amt in cur.fetchall():
            cls, store = method_class(jname), canon_store(jname)
            if not cls or not store or cls == "cash":
                continue
            booked[(cls, store, day)] = booked.get((cls, store, day), 0.0) + float(amt or 0)
        # Cash: journal entries double-count (receipt move + transfer-out move both
        # land in the cash journal, amount_total unsigned). Use the SIGNED cash
        # register statement lines instead, inflows only, weekly grain.
        cur.execute("""
            SELECT journal_name, date, SUM(amount)
            FROM raw_bank_statement_lines
            WHERE amount > 0 AND date >= %s AND date < CURRENT_DATE
            GROUP BY 1, 2
        """, (since,))
        for jname, day, amt in cur.fetchall():
            cls, store = method_class(jname), canon_store(jname)
            if cls != "cash" or not store:
                continue
            k = (cls, store, _week_start(day))
            booked[k] = booked.get(k, 0.0) + float(amt or 0)
    rows = []
    # Only reconcile where the POS side has activity for that class+store pairing
    # at least once (journals carry plenty of non-POS traffic, e.g. bank charges).
    active = {(c, s) for (c, s, _) in takings}
    keys = set(takings) | {k for k in booked if (k[0], k[1]) in active}
    for (cls, store, day) in sorted(keys):
        a = takings.get((cls, store, day), 0.0)
        b = booked.get((cls, store, day), 0.0)
        status, diff = _agg_status(a, b)
        rows.append({
            "item_key": f"coll|{cls}|{store}|{day}",
            "recon_type": "collections", "store": store, "day": day,
            "status": status, "confidence": 1.0 if status == "matched" else None,
            "amount_a": round(a, 2), "amount_b": round(b, 2), "diff": round(diff, 2),
            "details": {"method_class": cls, "pos_takings_kes": round(a, 2),
                        "journal_booked_kes": round(b, 2),
                        "grain": "week" if cls == "cash" else "day"},
        })
    return _upsert_items(conn, rows, run_id)


def match_bank(conn, run_id):
    """Unreconciled bank statement lines -> candidate account.payments / journal
    entries by amount + date window (+ reference similarity for ranking)."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, date, payment_ref, amount, journal_id, journal_name, partner_name
            FROM raw_bank_statement_lines
            WHERE is_reconciled = FALSE
            ORDER BY date DESC
            LIMIT 3000
        """)
        lines = cur.fetchall()
        cur.execute("""
            SELECT id, name, date, amount, payment_type, partner_name, journal_id, state, ref
            FROM raw_account_payments
            WHERE state IN ('paid','posted','in_process')
        """)
        payments = cur.fetchall()
    # index payments by rounded abs amount
    pay_by_amt = {}
    for p in payments:
        pay_by_amt.setdefault(round(abs(float(p[3] or 0)), 2), []).append(p)
    rows = []
    for (lid, lday, ref, amt, jid, jname, partner) in lines:
        amt_f = float(amt or 0)
        cands = []
        for p in pay_by_amt.get(round(abs(amt_f), 2), []):
            pid, pname, pday, pamt, ptype, ppartner, pjid, pstate, pref = p
            if lday and pday and abs((lday - pday).days) > BANK_DATE_WINDOW:
                continue
            # direction: negative statement line (outflow) ~ outbound payment
            if amt_f < 0 and ptype == "inbound":
                continue
            if amt_f > 0 and ptype == "outbound":
                continue
            score = 0.6
            if lday == pday:
                score += 0.2
            if pjid == jid:
                score += 0.1
            reftxt = f"{ref or ''}".lower()
            for token in filter(None, [str(pname or "").lower(), str(ppartner or "").lower()]):
                if token and token in reftxt:
                    score += 0.1
                    break
            cands.append({"payment_id": pid, "payment_name": pname,
                          "date": str(pday), "amount": float(pamt or 0),
                          "partner": ppartner, "score": round(min(score, 0.99), 2)})
        cands.sort(key=lambda c: -c["score"])
        cands = cands[:8]
        if not cands:
            status, conf = "exception", None
        else:
            status, conf = "suggested", cands[0]["score"]
        rows.append({
            "item_key": f"bank|{lid}",
            "recon_type": "bank", "store": canon_store(jname), "day": lday,
            "status": status, "confidence": conf,
            "amount_a": round(amt_f, 2),
            "amount_b": cands[0]["amount"] if cands else None,
            "diff": 0.0 if cands else None,
            "details": {"statement_line_id": lid, "payment_ref": ref,
                        "journal": jname, "partner": partner,
                        "candidates": cands},
        })
    return _upsert_items(conn, rows, run_id)


def match_payables(conn, run_id):
    """Vendor bills: aging for open bills, duplicate candidates, payment suggestions."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, date, partner_name, amount_total, amount_residual,
                   payment_state, invoice_date_due, ref
            FROM raw_account_moves
            WHERE move_type = 'in_invoice' AND state = 'posted'
        """)
        bills = cur.fetchall()
        cur.execute("""
            SELECT id, name, date, amount, partner_name
            FROM raw_account_payments
            WHERE payment_type = 'outbound' AND state IN ('paid','posted','in_process')
        """)
        pays = cur.fetchall()
    pay_by_partner = {}
    for p in pays:
        pay_by_partner.setdefault((p[4] or "").strip().lower(), []).append(p)
    rows = []
    today = date.today()
    # open-bill items with aging + payment-candidate suggestions
    for (bid, name, bday, partner, total, residual, pstate, due, ref) in bills:
        if pstate not in ("not_paid", "partial"):
            continue
        residual_f = float(residual or 0)
        overdue_days = (today - due).days if due else None
        cands = []
        for p in pay_by_partner.get((partner or "").strip().lower(), []):
            pid, pname, pday, pamt, _ = p
            if abs(float(pamt or 0) - residual_f) <= LINE_TOL_ABS and pday and bday and pday >= bday:
                cands.append({"payment_id": pid, "payment_name": pname,
                              "date": str(pday), "amount": float(pamt or 0)})
        cands = cands[:5]
        rows.append({
            "item_key": f"bill|{bid}",
            "recon_type": "payables", "store": None, "day": due or bday,
            "status": "suggested" if cands else ("exception" if (overdue_days or 0) > 0 else "matched"),
            "confidence": 0.7 if cands else None,
            "amount_a": round(float(total or 0), 2), "amount_b": round(residual_f, 2),
            "diff": round(residual_f, 2),
            "details": {"bill_id": bid, "bill_name": name, "partner": partner,
                        "bill_date": str(bday) if bday else None,
                        "due_date": str(due) if due else None,
                        "overdue_days": overdue_days, "payment_state": pstate,
                        "ref": ref, "kind": "open_bill", "candidates": cands},
        })
    # duplicate candidates: same partner + same total (±1 KES) + dates within 30d
    by_partner = {}
    for b in bills:
        by_partner.setdefault((b[3] or "").strip().lower(), []).append(b)
    for partner_key, blist in by_partner.items():
        if not partner_key or len(blist) < 2:
            continue
        blist = sorted(blist, key=lambda b: (b[2] or date.min))
        for i in range(len(blist)):
            for j in range(i + 1, len(blist)):
                b1, b2 = blist[i], blist[j]
                if b1[2] and b2[2] and (b2[2] - b1[2]).days > 30:
                    break
                if abs(float(b1[4] or 0) - float(b2[4] or 0)) <= LINE_TOL_ABS and float(b1[4] or 0) != 0:
                    pair = tuple(sorted((b1[0], b2[0])))
                    rows.append({
                        "item_key": f"dupbill|{pair[0]}|{pair[1]}",
                        "recon_type": "payables", "store": None, "day": b2[2],
                        "status": "suggested", "confidence": 0.6,
                        "amount_a": round(float(b1[4] or 0), 2),
                        "amount_b": round(float(b2[4] or 0), 2), "diff": 0.0,
                        "details": {"kind": "duplicate_candidate", "partner": b1[3],
                                    "bill_1": {"id": b1[0], "name": b1[1], "date": str(b1[2]), "ref": b1[8]},
                                    "bill_2": {"id": b2[0], "name": b2[1], "date": str(b2[2]), "ref": b2[8]}},
                    })
    return _upsert_items(conn, rows, run_id)

# ------------------------------------------------------------ LLM tie-break

def _llm_rank_ambiguous(conn, cap=15):
    """For bank items with several close candidates, ask the shared LLM to pick.
    Optional: silently skipped when the AI proxy isn't configured. Never raises."""
    base = os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL")
    key = os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY")
    if not base or not key:
        return 0
    try:
        import requests as _rq
        with conn.cursor() as cur:
            cur.execute("""
                SELECT item_key, details FROM recon_items
                WHERE recon_type = 'bank' AND status = 'suggested'
                  AND jsonb_array_length(details->'candidates') >= 2
                  AND (details->'candidates'->0->>'score')::numeric
                      - (details->'candidates'->1->>'score')::numeric < 0.15
                ORDER BY updated_at DESC LIMIT %s
            """, (cap,))
            items = cur.fetchall()
        n = 0
        for item_key, details in items:
            try:
                prompt = (
                    "You are reconciling a bank statement line to candidate payments.\n"
                    f"Statement line: ref={details.get('payment_ref')!r} journal={details.get('journal')!r} "
                    f"partner={details.get('partner')!r}\n"
                    f"Candidates: {json.dumps(details.get('candidates', []))}\n"
                    'Reply ONLY with JSON: {"payment_id": <id or null>, "reason": "<short>"}'
                )
                resp = _rq.post(base.rstrip("/") + "/chat/completions",
                                json={"model": "gpt-5", "messages": [{"role": "user", "content": prompt}],
                                      "max_completion_tokens": 2000},
                                headers={"Authorization": "Bearer " + key}, timeout=60)
                resp.raise_for_status()
                text = (resp.json()["choices"][0]["message"].get("content") or "").strip()
                start, end = text.find("{"), text.rfind("}")
                pick = json.loads(text[start:end + 1]) if start != -1 else None
                if pick and pick.get("payment_id"):
                    cands = details.get("candidates", [])
                    chosen = next((c for c in cands if c["payment_id"] == pick["payment_id"]), None)
                    if chosen:
                        cands.remove(chosen)
                        cands.insert(0, {**chosen, "llm_pick": True, "llm_reason": pick.get("reason")})
                        details["candidates"] = cands
                        with conn.cursor() as cur:
                            cur.execute("""
                                UPDATE recon_items SET details = %s, confidence = %s, updated_at = now()
                                WHERE item_key = %s AND status = 'suggested'
                            """, (json.dumps(details), min((chosen.get("score") or 0.6) + 0.1, 0.95), item_key))
                        conn.commit()
                        n += 1
            except Exception as e:
                log.warning("LLM tie-break failed for %s: %s", item_key, e)
        return n
    except Exception as e:
        log.warning("LLM tie-break skipped: %s", e)
        return 0

# ------------------------------------------------------------------- runs

def run_reconciliation(trigger="manual", triggered_by=None, days=92, use_llm=True):
    """Full run of all four matchers. Returns the run row dict.
    Raises RuntimeError('run_in_progress') if another run holds the lock."""
    conn = psycopg2.connect(DATABASE_URL)
    try:
        ensure_recon_tables(conn)
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (RECON_LOCK_KEY,))
            if not cur.fetchone()[0]:
                raise RuntimeError("run_in_progress")
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO recon_runs (run_trigger, triggered_by) VALUES (%s,%s) RETURNING id",
                    (trigger, triggered_by))
                run_id = cur.fetchone()[0]
            conn.commit()
            stats = {}
            try:
                stats["sales_ledger"] = match_sales_ledger(conn, run_id, days=days)
                conn.commit()
                stats["collections"] = match_collections(conn, run_id, days=days)
                conn.commit()
                stats["bank"] = match_bank(conn, run_id)
                conn.commit()
                stats["payables"] = match_payables(conn, run_id)
                conn.commit()
                # Prune machine-state items the current run did not refresh
                # (renamed stores, newly reconciled bank lines, paid bills...).
                # Human decisions (approved/rejected/written) are never pruned.
                with conn.cursor() as cur:
                    cur.execute("""
                        DELETE FROM recon_items
                        WHERE status IN ('matched','variance','missing','suggested','exception')
                          AND run_id < %s
                    """, (run_id,))
                    stats["pruned"] = cur.rowcount
                conn.commit()
                if use_llm:
                    stats["llm_reranked"] = _llm_rank_ambiguous(conn)
                with conn.cursor() as cur:
                    cur.execute("""
                        UPDATE recon_runs SET finished_at = now(), status = 'completed',
                               stats = %s WHERE id = %s
                    """, (json.dumps(stats), run_id))
                conn.commit()
                log.info("Reconciliation run %s completed: %s", run_id, stats)
                return {"run_id": run_id, "status": "completed", "stats": stats}
            except Exception as e:
                conn.rollback()
                with conn.cursor() as cur:
                    cur.execute("""
                        UPDATE recon_runs SET finished_at = now(), status = 'failed',
                               error = %s WHERE id = %s
                    """, (str(e)[:2000], run_id))
                conn.commit()
                raise
        finally:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s)", (RECON_LOCK_KEY,))
            conn.commit()
    finally:
        conn.close()

# --------------------------------------------------------------- write-back

def _write_target():
    """Staging Odoo connection from ODOO_WRITE_* secrets. The PRODUCTION Odoo
    creds (ODOO_URL/...) are deliberately NOT used as a fallback for writes."""
    url = os.environ.get("ODOO_WRITE_URL")
    db = os.environ.get("ODOO_WRITE_DB")
    user = os.environ.get("ODOO_WRITE_USER")
    pwd = os.environ.get("ODOO_WRITE_PASSWORD")
    if not all([url, db, user, pwd]):
        return None
    return {"url": url.rstrip("/"), "db": db, "user": user, "pwd": pwd}


def writeback_configured():
    return _write_target() is not None


def _odoo_write_conn():
    import xmlrpc.client
    t = _write_target()
    if not t:
        raise RuntimeError("writeback_not_configured")
    common = xmlrpc.client.ServerProxy(f"{t['url']}/xmlrpc/2/common")
    uid = common.authenticate(t["db"], t["user"], t["pwd"], {})
    if not uid:
        raise RuntimeError("writeback_auth_failed")
    models = xmlrpc.client.ServerProxy(f"{t['url']}/xmlrpc/2/object")
    def call(model, method, args, kw=None):
        return models.execute_kw(t["db"], uid, t["pwd"], model, method, args, kw or {})
    return call, t["url"]


def writeback_bank_item(conn, item_key, actor):
    """Write an APPROVED bank match into the staging Odoo: reconcile the statement
    line's suspense move line with the chosen payment's outstanding line.
    Re-validates against current Odoo state first; on drift the item goes back to
    'suggested' with a drift note and the caller should surface a conflict."""
    with conn.cursor() as cur:
        cur.execute("SELECT status, details FROM recon_items WHERE item_key = %s FOR UPDATE",
                    (item_key,))
        row = cur.fetchone()
        if not row:
            raise LookupError("item_not_found")
        status, details = row
        if status != "approved":
            raise PermissionError(f"item_not_approved:{status}")
    call, target_url = _odoo_write_conn()
    lid = details["statement_line_id"]
    cand = (details.get("candidates") or [{}])[0]
    pay_id = cand.get("payment_id")
    if not pay_id:
        raise ValueError("no_candidate_payment")
    # --- re-validate against CURRENT Odoo state (staging may have drifted) ---
    line = call("account.bank.statement.line", "read", [[lid]],
                {"fields": ["is_reconciled", "amount", "move_id"]})
    if not line:
        _drift(conn, item_key, actor, "statement_line_missing_on_target")
        raise RuntimeError("drift:statement_line_missing")
    line = line[0]
    if line.get("is_reconciled"):
        _drift(conn, item_key, actor, "already_reconciled_on_target")
        raise RuntimeError("drift:already_reconciled")
    pay = call("account.payment", "read", [[pay_id]],
               {"fields": ["state", "amount", "move_id"]})
    if not pay:
        _drift(conn, item_key, actor, "payment_missing_on_target")
        raise RuntimeError("drift:payment_missing")
    pay = pay[0]
    # --- find the two reconcilable move lines (suspense side + outstanding side) ---
    stmt_move_id = line["move_id"][0] if line.get("move_id") else None
    pay_move_id = pay["move_id"][0] if pay.get("move_id") else None
    if not stmt_move_id or not pay_move_id:
        _drift(conn, item_key, actor, "moves_missing_on_target")
        raise RuntimeError("drift:moves_missing")
    mls = call("account.move.line", "search_read",
               [[["move_id", "in", [stmt_move_id, pay_move_id]],
                 ["account_id.reconcile", "=", True],
                 ["reconciled", "=", False]]],
               {"fields": ["id", "move_id", "account_id", "balance"]})
    stmt_lines = [l for l in mls if l["move_id"][0] == stmt_move_id]
    pay_lines = [l for l in mls if l["move_id"][0] == pay_move_id]
    if not stmt_lines or not pay_lines:
        _drift(conn, item_key, actor, "no_open_reconcilable_lines")
        raise RuntimeError("drift:no_open_lines")
    ids = [stmt_lines[0]["id"], pay_lines[0]["id"]]
    call("account.move.line", "reconcile", [ids])
    result = {"target": target_url, "reconciled_line_ids": ids,
              "payment_id": pay_id, "statement_line_id": lid}
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE recon_items SET status = 'written', written_at = now(),
                   writeback_result = %s, updated_at = now()
            WHERE item_key = %s AND status = 'approved'
        """, (json.dumps(result), item_key))
    audit(conn, item_key, "writeback", actor, result)
    conn.commit()
    return result


def writeback_bill_payment_item(conn, item_key, actor):
    """Write an APPROVED bill<->payment match: reconcile the bill's open payable
    line with the payment's payable line on the staging Odoo."""
    with conn.cursor() as cur:
        cur.execute("SELECT status, details FROM recon_items WHERE item_key = %s FOR UPDATE",
                    (item_key,))
        row = cur.fetchone()
        if not row:
            raise LookupError("item_not_found")
        status, details = row
        if status != "approved":
            raise PermissionError(f"item_not_approved:{status}")
        if details.get("kind") != "open_bill":
            raise ValueError("not_a_bill_payment_item")
    call, target_url = _odoo_write_conn()
    bill_id = details["bill_id"]
    cand = (details.get("candidates") or [{}])[0]
    pay_id = cand.get("payment_id")
    if not pay_id:
        raise ValueError("no_candidate_payment")
    bill = call("account.move", "read", [[bill_id]],
                {"fields": ["payment_state", "state", "amount_residual"]})
    if not bill:
        _drift(conn, item_key, actor, "bill_missing_on_target")
        raise RuntimeError("drift:bill_missing")
    bill = bill[0]
    if bill.get("payment_state") in ("paid", "in_payment", "reversed"):
        _drift(conn, item_key, actor, f"bill_already_{bill.get('payment_state')}")
        raise RuntimeError("drift:bill_already_paid")
    pay = call("account.payment", "read", [[pay_id]], {"fields": ["state", "move_id", "amount"]})
    if not pay:
        _drift(conn, item_key, actor, "payment_missing_on_target")
        raise RuntimeError("drift:payment_missing")
    pay = pay[0]
    pay_move_id = pay["move_id"][0] if pay.get("move_id") else None
    if not pay_move_id:
        _drift(conn, item_key, actor, "payment_move_missing_on_target")
        raise RuntimeError("drift:payment_move_missing")
    mls = call("account.move.line", "search_read",
               [[["move_id", "in", [bill_id, pay_move_id]],
                 ["account_id.account_type", "=", "liability_payable"],
                 ["reconciled", "=", False]]],
               {"fields": ["id", "move_id", "balance"]})
    bill_lines = [l for l in mls if l["move_id"][0] == bill_id]
    pay_lines = [l for l in mls if l["move_id"][0] == pay_move_id]
    if not bill_lines or not pay_lines:
        _drift(conn, item_key, actor, "no_open_payable_lines")
        raise RuntimeError("drift:no_open_lines")
    ids = [bill_lines[0]["id"], pay_lines[0]["id"]]
    call("account.move.line", "reconcile", [ids])
    result = {"target": target_url, "reconciled_line_ids": ids,
              "payment_id": pay_id, "bill_id": bill_id}
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE recon_items SET status = 'written', written_at = now(),
                   writeback_result = %s, updated_at = now()
            WHERE item_key = %s AND status = 'approved'
        """, (json.dumps(result), item_key))
    audit(conn, item_key, "writeback", actor, result)
    conn.commit()
    return result


def _drift(conn, item_key, actor, reason):
    """Target Odoo no longer matches the suggestion — re-queue as 'suggested'."""
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE recon_items
            SET status = 'suggested',
                details = details || jsonb_build_object('drift', %s),
                approved_by = NULL, approved_at = NULL, updated_at = now()
            WHERE item_key = %s
        """, (json.dumps(reason), item_key))
    audit(conn, item_key, "drift_requeued", actor, {"reason": reason})
    conn.commit()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    import sys
    trigger = sys.argv[1] if len(sys.argv) > 1 else "manual"
    out = run_reconciliation(trigger=trigger, triggered_by="cli")
    print(json.dumps(out, default=str))
