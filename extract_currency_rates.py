import os
import requests
import psycopg2

DATABASE_URL = os.environ['DATABASE_URL']

def main():
    # Get latest rates from Frankfurter
    resp = requests.get(
        'https://api.frankfurter.app/latest',
        params={'from': 'KES', 'to': 'UGX,RWF'},
        timeout=10
    )
    resp.raise_for_status()
    data = resp.json()
    ugx_per_kes = round(data['rates']['UGX'], 6)
    rwf_per_kes = round(data['rates']['RWF'], 6)
    print(f"1 KES = {ugx_per_kes} UGX")
    print(f"1 KES = {rwf_per_kes} RWF")

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    # Truncate and insert single rate per country
    cur.execute("TRUNCATE currency_rates")
    cur.execute("INSERT INTO currency_rates (country, month, rate) VALUES ('Kenya', 'latest', 1.0)")
    cur.execute("INSERT INTO currency_rates (country, month, rate) VALUES ('Uganda', 'latest', %s)", (ugx_per_kes,))
    cur.execute("INSERT INTO currency_rates (country, month, rate) VALUES ('Rwanda', 'latest', %s)", (rwf_per_kes,))
    cur.execute("INSERT INTO currency_rates (country, month, rate) VALUES ('Online', 'latest', 1.0)")

    conn.commit()
    cur.execute("SELECT country, rate FROM currency_rates ORDER BY country")
    print("\nCurrent rates (local currency per 1 KES):")
    for row in cur.fetchall():
        print(f"  {row[0]}: {row[1]}")
    conn.close()
    print("\n✅ Currency rates updated")

if __name__ == '__main__':
    main()