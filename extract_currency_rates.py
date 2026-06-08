import os
import requests
import psycopg2

DATABASE_URL = os.environ['DATABASE_URL']

def main():
    # Frankfurter doesn't support KES as base — use EUR as bridge
    resp = requests.get(
        'https://api.frankfurter.app/latest',
        params={'from': 'EUR', 'to': 'KES,UGX,RWF'},
        timeout=10
    )
    resp.raise_for_status()
    data = resp.json()
    kes = float(data['rates']['KES'])
    ugx = float(data['rates']['UGX'])
    rwf = float(data['rates']['RWF'])

    # Rate = how many local currency per 1 KES
    ugx_per_kes = round(ugx / kes, 6)
    rwf_per_kes = round(rwf / kes, 6)
    print(f"1 KES = {ugx_per_kes} UGX")
    print(f"1 KES = {rwf_per_kes} RWF")

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

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