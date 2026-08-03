#!/usr/bin/env python3
"""Refresh warehouse_bins table from the Google Sheet.

Usage:
    python3 refresh_bins.py

Reads the WAREHOUSE_BINS_SHEET_ID Google Sheet and mirrors barcode->bin
mappings into the warehouse_bins Postgres table. Safe to run any time.
"""
import psycopg2, os, sys
sys.path.insert(0, '/home/runner/workspace')
import warehouse_bins


def main():
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    print("Refreshing warehouse bins from Google Sheet...")
    warehouse_bins.refresh(conn, force=True)
    conn.commit()

    cur = conn.cursor()
    cur.execute("SELECT COUNT(*), MAX(updated_at) FROM warehouse_bins")
    cnt, last = cur.fetchone()
    conn.close()
    print(f"Done: {cnt} bins, last updated: {last}")


if __name__ == "__main__":
    main()
