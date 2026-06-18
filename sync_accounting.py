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
    # Get last synced date for incremental
    cur.execute("SELECT MAX(date) FROM raw_account_moves")
    last = cur.fetchone()[0]
    since = str(last) if last else '2019-01-01'
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
    cur.execute("SELECT MAX(date) FROM raw_account_move_lines")
    last = cur.fetchone()[0]
    since = str(last) if last else '2019-01-01'
    log.info("Syncing lines since %s", since)

    batch_size = 1000
    offset = 0
    total = 0
    while True:
        records = models.execute_kw(ODOO_DB, uid, ODOO_PASSWORD, 'account.move.line', 'search_read',
            [[['move_id.state', '=', 'posted'], ['date', '>=', since]]],
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
    # Summary
    for t in ['raw_accounts','raw_account_journals','raw_account_moves','raw_account_move_lines']:
        cur.execute(f"SELECT COUNT(*) FROM {t}")
        log.info("%s: %d rows", t, cur.fetchone()[0])
    conn.close()

if __name__ == '__main__':
    main()
