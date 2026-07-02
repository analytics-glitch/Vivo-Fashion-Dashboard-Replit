"""
Sync Odoo accounting data to PostgreSQL for Finance Dashboard.
Tables: raw_account_moves, raw_account_move_lines, raw_accounts
"""
import os, logging, xmlrpc.client, psycopg2
from psycopg2.extras import execute_values
from datetime import datetime

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

ODOO_URL = os.environ['ODOO_URL']
ODOO_DB  = os.environ['ODOO_DB']
ODOO_USER = os.environ['ODOO_USER']
ODOO_PASSWORD = os.environ['ODOO_PASSWORD']
DATABASE_URL = os.environ['DATABASE_URL']

def connect_odoo():
    common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
    uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_PASSWORD, {})
    models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')
    log.info("Connected to Odoo uid=%s", uid)
    return uid, models

def create_tables(cur):
    cur.execute("""
        CREATE TABLE IF NOT EXISTS raw_accounts (
            id              BIGINT PRIMARY KEY,
            code            TEXT,
            name            TEXT,
            account_type    TEXT,
            _loaded_at      TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_account_journals (
            id              BIGINT PRIMARY KEY,
            name            TEXT,
            code            TEXT,
            journal_type    TEXT,
            _loaded_at      TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_account_moves (
            id              BIGINT PRIMARY KEY,
            name            TEXT,
            date            DATE,
            journal_id      BIGINT,
            journal_name    TEXT,
            move_type       TEXT,
            amount_total    NUMERIC,
            amount_untaxed  NUMERIC,
            state           TEXT,
            ref             TEXT,
            partner_name    TEXT,
            _loaded_at      TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_account_move_lines (
            id              BIGINT PRIMARY KEY,
            move_id         BIGINT,
            move_name       TEXT,
            date            DATE,
            account_id      BIGINT,
            account_code    TEXT,
            account_name    TEXT,
            journal_id      BIGINT,
            journal_name    TEXT,
            name            TEXT,
            debit           NUMERIC,
            credit          NUMERIC,
            balance         NUMERIC,
            partner_name    TEXT,
            _loaded_at      TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_aml_date ON raw_account_move_lines(date);
        CREATE INDEX IF NOT EXISTS idx_aml_account ON raw_account_move_lines(account_code);
        CREATE INDEX IF NOT EXISTS idx_aml_move ON raw_account_move_lines(move_id);

        -- Reconciliation-agent source tables ------------------------------
        CREATE TABLE IF NOT EXISTS raw_bank_statement_lines (
            id              BIGINT PRIMARY KEY,
            date            DATE,
            payment_ref     TEXT,
            amount          NUMERIC,
            journal_id      BIGINT,
            journal_name    TEXT,
            partner_name    TEXT,
            is_reconciled   BOOLEAN,
            move_id         BIGINT,
            _loaded_at      TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_bsl_date ON raw_bank_statement_lines(date);
        CREATE INDEX IF NOT EXISTS idx_bsl_journal ON raw_bank_statement_lines(journal_id);

        CREATE TABLE IF NOT EXISTS raw_pos_payment_methods (
            id              BIGINT PRIMARY KEY,
            name            TEXT,
            journal_id      BIGINT,
            journal_name    TEXT,
            _loaded_at      TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS raw_pos_payments (
            id                  BIGINT PRIMARY KEY,
            amount              NUMERIC,
            payment_method_id   BIGINT,
            payment_method_name TEXT,
            session_id          BIGINT,
            session_name        TEXT,
            pos_order_id        BIGINT,
            pos_order_name      TEXT,
            payment_date        TIMESTAMP,
            _loaded_at          TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_pp_date ON raw_pos_payments(payment_date);
        CREATE INDEX IF NOT EXISTS idx_pp_method ON raw_pos_payments(payment_method_id);

        CREATE TABLE IF NOT EXISTS raw_account_payments (
            id              BIGINT PRIMARY KEY,
            name            TEXT,
            date            DATE,
            amount          NUMERIC,
            payment_type    TEXT,
            partner_type    TEXT,
            partner_name    TEXT,
            journal_id      BIGINT,
            journal_name    TEXT,
            state           TEXT,
            ref             TEXT,
            move_id         BIGINT,
            _loaded_at      TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ap_date ON raw_account_payments(date);

        ALTER TABLE raw_account_moves ADD COLUMN IF NOT EXISTS payment_state TEXT;
        ALTER TABLE raw_account_moves ADD COLUMN IF NOT EXISTS amount_residual NUMERIC;
        ALTER TABLE raw_account_moves ADD COLUMN IF NOT EXISTS invoice_date_due DATE;
    """)
    log.info("Tables ready")

def sync_accounts(uid, models, cur, now):
    log.info("Syncing chart of accounts...")
    records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'account.account', 'search_read',
        [[]], {'fields': ['code','name','account_type']})
    rows = [(r['id'], r['code'], r['name'], r.get('account_type'), now) for r in records]
    cur.execute("TRUNCATE raw_accounts")
    execute_values(cur, """
        INSERT INTO raw_accounts (id, code, name, account_type, _loaded_at)
        VALUES %s ON CONFLICT (id) DO UPDATE SET
            code=EXCLUDED.code, name=EXCLUDED.name, _loaded_at=EXCLUDED._loaded_at
    """, rows, page_size=500)
    log.info("✅ raw_accounts: %d rows", len(rows))

def sync_journals(uid, models, cur, now):
    log.info("Syncing journals...")
    records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'account.journal', 'search_read',
        [[]], {'fields': ['name','code','type']})
    rows = [(r['id'], r['name'], r.get('code'), r.get('type'), now) for r in records]
    cur.execute("TRUNCATE raw_account_journals")
    execute_values(cur, """
        INSERT INTO raw_account_journals (id, name, code, journal_type, _loaded_at)
        VALUES %s ON CONFLICT (id) DO UPDATE SET
            name=EXCLUDED.name, _loaded_at=EXCLUDED._loaded_at
    """, rows, page_size=500)
    log.info("✅ raw_account_journals: %d rows", len(rows))

def sync_moves(uid, models, cur, now):
    log.info("Syncing journal entries...")
    # Get last synced date for incremental. Clamp to today: a single future-dated
    # entry (e.g. 2027-03-02 misc op) would otherwise push MAX(date) past today and
    # freeze the incremental forever. 3-day overlap catches late postings.
    cur.execute("SELECT MAX(date) FROM raw_account_moves WHERE date <= CURRENT_DATE")
    last = cur.fetchone()[0]
    since = str(last - __import__('datetime').timedelta(days=3)) if last else '2026-01-01'
    log.info("Syncing moves since %s", since)

    batch_size = 500
    offset = 0
    total = 0
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'account.move', 'search_read',
            [[['state', '=', 'posted'], ['date', '>=', since]]],
            {'fields': ['name','date','journal_id','move_type','amount_total',
                       'amount_untaxed','state','ref','partner_id'],
             'limit': batch_size, 'offset': offset, 'order': 'date asc'})
        if not records:
            break
        rows = []
        for r in records:
            rows.append((
                r['id'], r['name'], r.get('date'),
                r['journal_id'][0] if r.get('journal_id') else None,
                r['journal_id'][1] if r.get('journal_id') else None,
                r.get('move_type'), r.get('amount_total', 0),
                r.get('amount_untaxed', 0), r.get('state'),
                r.get('ref'),
                r['partner_id'][1] if r.get('partner_id') else None,
                now
            ))
        execute_values(cur, """
            INSERT INTO raw_account_moves
            (id, name, date, journal_id, journal_name, move_type, amount_total,
             amount_untaxed, state, ref, partner_name, _loaded_at)
            VALUES %s ON CONFLICT (id) DO UPDATE SET
                date=EXCLUDED.date, amount_total=EXCLUDED.amount_total,
                state=EXCLUDED.state, _loaded_at=EXCLUDED._loaded_at
        """, rows, page_size=500)
        total += len(rows)
        offset += batch_size
        if len(records) < batch_size:
            break
    log.info("✅ raw_account_moves: %d rows synced", total)

def sync_move_lines(uid, models, cur, now):
    log.info("Syncing journal lines...")
    # Only P&L accounts matter for the finance dashboard (codes 5002*, 6*, 7*, 8*).
    # The 280+ store cash/bank/Mpesa journals post ~1M balance-sheet reconciliation
    # lines that are irrelevant here, so we filter to P&L accounts to keep the pull
    # lean (~157K vs 1.1M) and avoid OOM.
    pl_accs = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'account.account', 'search_read',
        [['|','|','|',['code','=like','6%'],['code','=like','7%'],
          ['code','=like','8%'],['code','=like','5002%']]],
        {'fields': ['id']})
    pl_ids = [a['id'] for a in pl_accs]
    log.info("P&L accounts in scope: %d", len(pl_ids))
    cur.execute("SELECT MAX(date) FROM raw_account_move_lines WHERE date <= CURRENT_DATE")
    last = cur.fetchone()[0]
    since = str(last - __import__('datetime').timedelta(days=3)) if last else '2026-01-01'
    log.info("Syncing P&L lines since %s", since)

    batch_size = 1000
    offset = 0
    total = 0
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'account.move.line', 'search_read',
            [[['move_id.state', '=', 'posted'], ['date', '>=', since], ['account_id', 'in', pl_ids]]],
            {'fields': ['move_id','date','account_id','journal_id','name',
                       'debit','credit','balance','partner_id'],
             'limit': batch_size, 'offset': offset, 'order': 'date asc'})
        if not records:
            break
        rows = []
        for r in records:
            acc = r.get('account_id', [None, ''])
            acc_code = acc[1].split(' ')[0] if acc and acc[1] else None
            acc_name = ' '.join(acc[1].split(' ')[1:]) if acc and acc[1] else None
            rows.append((
                r['id'],
                r['move_id'][0] if r.get('move_id') else None,
                r['move_id'][1] if r.get('move_id') else None,
                r.get('date'),
                acc[0] if acc else None,
                acc_code, acc_name,
                r['journal_id'][0] if r.get('journal_id') else None,
                r['journal_id'][1] if r.get('journal_id') else None,
                r.get('name'),
                r.get('debit', 0), r.get('credit', 0), r.get('balance', 0),
                r['partner_id'][1] if r.get('partner_id') else None,
                now
            ))
        execute_values(cur, """
            INSERT INTO raw_account_move_lines
            (id, move_id, move_name, date, account_id, account_code, account_name,
             journal_id, journal_name, name, debit, credit, balance, partner_name, _loaded_at)
            VALUES %s ON CONFLICT (id) DO UPDATE SET
                debit=EXCLUDED.debit, credit=EXCLUDED.credit,
                balance=EXCLUDED.balance, _loaded_at=EXCLUDED._loaded_at
        """, rows, page_size=500)
        total += len(rows)
        offset += batch_size
        log.info("Lines synced: %d so far...", total)
        if len(records) < batch_size:
            break
    log.info("✅ raw_account_move_lines: %d rows synced", total)

def sync_bank_statement_lines(uid, models, cur, now):
    """Full refresh (upsert) — is_reconciled flips over time on old rows, and the
    whole model is small (~9k rows), so re-pull everything each run."""
    log.info("Syncing bank statement lines...")
    batch_size = 1000
    offset = 0
    total = 0
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD,
            'account.bank.statement.line', 'search_read',
            [[]],
            {'fields': ['date','payment_ref','amount','journal_id','partner_id',
                        'is_reconciled','move_id'],
             'limit': batch_size, 'offset': offset, 'order': 'id asc'})
        if not records:
            break
        rows = []
        for r in records:
            rows.append((
                r['id'], r.get('date'), r.get('payment_ref'), r.get('amount', 0),
                r['journal_id'][0] if r.get('journal_id') else None,
                r['journal_id'][1] if r.get('journal_id') else None,
                r['partner_id'][1] if r.get('partner_id') else None,
                bool(r.get('is_reconciled')),
                r['move_id'][0] if r.get('move_id') else None,
                now
            ))
        execute_values(cur, """
            INSERT INTO raw_bank_statement_lines
            (id, date, payment_ref, amount, journal_id, journal_name, partner_name,
             is_reconciled, move_id, _loaded_at)
            VALUES %s ON CONFLICT (id) DO UPDATE SET
                date=EXCLUDED.date, payment_ref=EXCLUDED.payment_ref,
                amount=EXCLUDED.amount, is_reconciled=EXCLUDED.is_reconciled,
                move_id=EXCLUDED.move_id, _loaded_at=EXCLUDED._loaded_at
        """, rows, page_size=500)
        total += len(rows)
        offset += batch_size
        if len(records) < batch_size:
            break
    log.info("✅ raw_bank_statement_lines: %d rows synced", total)

def sync_pos_payments(uid, models, cur, now):
    log.info("Syncing POS payment methods...")
    records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'pos.payment.method', 'search_read',
        [[]], {'fields': ['name','journal_id']})
    rows = [(r['id'], r['name'],
             r['journal_id'][0] if r.get('journal_id') else None,
             r['journal_id'][1] if r.get('journal_id') else None,
             now) for r in records]
    execute_values(cur, """
        INSERT INTO raw_pos_payment_methods (id, name, journal_id, journal_name, _loaded_at)
        VALUES %s ON CONFLICT (id) DO UPDATE SET
            name=EXCLUDED.name, journal_id=EXCLUDED.journal_id,
            journal_name=EXCLUDED.journal_name, _loaded_at=EXCLUDED._loaded_at
    """, rows, page_size=500)
    log.info("✅ raw_pos_payment_methods: %d rows", len(rows))

    # POS payments — incremental with a 7-day overlap re-pull (late edits/refunds).
    cur.execute("SELECT MAX(payment_date) FROM raw_pos_payments")
    last = cur.fetchone()[0]
    if last:
        since = str((last - __import__('datetime').timedelta(days=7)).date())
    else:
        since = '2026-01-01'
    log.info("Syncing POS payments since %s", since)
    batch_size = 1000
    offset = 0
    total = 0
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'pos.payment', 'search_read',
            [[['payment_date', '>=', since]]],
            {'fields': ['amount','payment_method_id','session_id','pos_order_id','payment_date'],
             'limit': batch_size, 'offset': offset, 'order': 'id asc'})
        if not records:
            break
        rows = []
        for r in records:
            rows.append((
                r['id'], r.get('amount', 0),
                r['payment_method_id'][0] if r.get('payment_method_id') else None,
                r['payment_method_id'][1] if r.get('payment_method_id') else None,
                r['session_id'][0] if r.get('session_id') else None,
                r['session_id'][1] if r.get('session_id') else None,
                r['pos_order_id'][0] if r.get('pos_order_id') else None,
                r['pos_order_id'][1] if r.get('pos_order_id') else None,
                r.get('payment_date'), now
            ))
        execute_values(cur, """
            INSERT INTO raw_pos_payments
            (id, amount, payment_method_id, payment_method_name, session_id, session_name,
             pos_order_id, pos_order_name, payment_date, _loaded_at)
            VALUES %s ON CONFLICT (id) DO UPDATE SET
                amount=EXCLUDED.amount, payment_method_id=EXCLUDED.payment_method_id,
                payment_method_name=EXCLUDED.payment_method_name,
                payment_date=EXCLUDED.payment_date, _loaded_at=EXCLUDED._loaded_at
        """, rows, page_size=500)
        total += len(rows)
        offset += batch_size
        if len(records) < batch_size:
            break
    log.info("✅ raw_pos_payments: %d rows synced", total)

def sync_account_payments(uid, models, cur, now):
    """Incremental with 14-day overlap (state changes on recent payments)."""
    cur.execute("SELECT MAX(date) FROM raw_account_payments")
    last = cur.fetchone()[0]
    if last:
        since = str(last - __import__('datetime').timedelta(days=14))
    else:
        since = '2026-01-01'
    log.info("Syncing account payments since %s", since)
    batch_size = 1000
    offset = 0
    total = 0
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'account.payment', 'search_read',
            [[['date', '>=', since]]],
            {'fields': ['name','date','amount','payment_type','partner_type',
                        'partner_id','journal_id','state','memo','move_id'],
             'limit': batch_size, 'offset': offset, 'order': 'id asc'})
        if not records:
            break
        rows = []
        for r in records:
            rows.append((
                r['id'], r.get('name') or None, r.get('date'), r.get('amount', 0),
                r.get('payment_type'), r.get('partner_type'),
                r['partner_id'][1] if r.get('partner_id') else None,
                r['journal_id'][0] if r.get('journal_id') else None,
                r['journal_id'][1] if r.get('journal_id') else None,
                r.get('state'), r.get('memo') or None,
                r['move_id'][0] if r.get('move_id') else None,
                now
            ))
        execute_values(cur, """
            INSERT INTO raw_account_payments
            (id, name, date, amount, payment_type, partner_type, partner_name,
             journal_id, journal_name, state, ref, move_id, _loaded_at)
            VALUES %s ON CONFLICT (id) DO UPDATE SET
                amount=EXCLUDED.amount, state=EXCLUDED.state,
                partner_name=EXCLUDED.partner_name, _loaded_at=EXCLUDED._loaded_at
        """, rows, page_size=500)
        total += len(rows)
        offset += batch_size
        if len(records) < batch_size:
            break
    log.info("✅ raw_account_payments: %d rows synced", total)

def sync_vendor_bill_status(uid, models, cur, now):
    """Full refresh of payment_state / amount_residual / due date for vendor bills
    (small model slice; payment_state flips on OLD bills so incremental-by-date misses it)."""
    log.info("Refreshing vendor bill payment status...")
    batch_size = 1000
    offset = 0
    total = 0
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'account.move', 'search_read',
            [[['move_type', 'in', ['in_invoice', 'in_refund']], ['state', '=', 'posted']]],
            {'fields': ['payment_state','amount_residual','invoice_date_due'],
             'limit': batch_size, 'offset': offset, 'order': 'id asc'})
        if not records:
            break
        rows = [(r['id'], r.get('payment_state') or None,
                 r.get('amount_residual') or 0,
                 r.get('invoice_date_due') or None) for r in records]
        execute_values(cur, """
            UPDATE raw_account_moves AS m SET
                payment_state = v.payment_state,
                amount_residual = v.amount_residual::numeric,
                invoice_date_due = v.invoice_date_due::date
            FROM (VALUES %s) AS v(id, payment_state, amount_residual, invoice_date_due)
            WHERE m.id = v.id
        """, rows, page_size=500)
        total += len(rows)
        offset += batch_size
        if len(records) < batch_size:
            break
    log.info("✅ vendor bill payment status refreshed: %d bills", total)

def main():
    uid, models = connect_odoo()
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    now = datetime.utcnow()
    create_tables(cur)
    conn.commit()
    sync_accounts(uid, models, cur, now)
    sync_journals(uid, models, cur, now)
    sync_moves(uid, models, cur, now)
    sync_move_lines(uid, models, cur, now)
    conn.commit()
    sync_bank_statement_lines(uid, models, cur, now)
    conn.commit()
    sync_pos_payments(uid, models, cur, now)
    conn.commit()
    sync_account_payments(uid, models, cur, now)
    conn.commit()
    sync_vendor_bill_status(uid, models, cur, now)
    conn.commit()
    # Summary
    for t in ['raw_accounts','raw_account_journals','raw_account_moves','raw_account_move_lines',
              'raw_bank_statement_lines','raw_pos_payment_methods','raw_pos_payments',
              'raw_account_payments']:
        cur.execute(f"SELECT COUNT(*) FROM {t}")
        log.info("%s: %d rows", t, cur.fetchone()[0])
    conn.close()

if __name__ == '__main__':
    main()
