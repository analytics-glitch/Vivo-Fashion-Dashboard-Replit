import os
import requests
import psycopg2
from datetime import datetime, timedelta
from calendar import monthrange

DATABASE_URL = os.environ['DATABASE_URL']

def get_previous_month_dates():
    today = datetime.today()
    first_of_this_month = today.replace(day=1)
    last_of_prev_month = first_of_this_month - timedelta(days=1)
    first_of_prev_month = last_of_prev_month.replace(day=1)
    return first_of_prev_month.strftime('%Y-%m-%d'), last_of_prev_month.strftime('%Y-%m-%d')

def get_monthly_average_rate(base, target, date_from, date_to):
    """Fetch daily rates for date range and return average."""
    url = "https://api.currencybeacon.com/v1/timeseries"
    # Use free tier of currencyapi.com
    url = f"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/{base.lower()}.json"

    # Use fawazahmed0 free currency API — no key needed
    rates = []
    current = datetime.strptime(date_from, '%Y-%m-%d')
    end = datetime.strptime(date_to, '%Y-%m-%d')

    while current <= end:
        date_str = current.strftime('%Y-%m-%d')
        try:
            resp = requests.get(
                f"https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@{date_str}/v1/currencies/{base.lower()}.json",
                timeout=10
            )
            if resp.status_code == 200:
                data = resp.json()
                rate = data.get(base.lower(), {}).get(target.lower())
                if rate:
                    rates.append(rate)
        except Exception as e:
            print(f"  Skipping {date_str}: {e}")
        current += timedelta(days=1)

    if not rates:
        return None
    return round(sum(rates) / len(rates), 6)

def main():
    date_from, date_to = get_previous_month_dates()
    prev_month = datetime.strptime(date_from, '%Y-%m-%d').strftime('%Y-%m')
    print(f"Fetching daily rates for {prev_month} ({date_from} to {date_to})...")

    print("Fetching UGX rates...")
    ugx_per_kes = get_monthly_average_rate('KES', 'UGX', date_from, date_to)
    print(f"  Average 1 KES = {ugx_per_kes} UGX")

    print("Fetching RWF rates...")
    rwf_per_kes = get_monthly_average_rate('KES', 'RWF', date_from, date_to)
    print(f"  Average 1 KES = {rwf_per_kes} RWF")

    if not ugx_per_kes or not rwf_per_kes:
        print("❌ Failed to fetch rates")
        return

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()
    cur.execute("TRUNCATE currency_rates")
    cur.execute("INSERT INTO currency_rates (country, month, rate) VALUES ('Kenya', %s, 1.0)", (prev_month,))
    cur.execute("INSERT INTO currency_rates (country, month, rate) VALUES ('Uganda', %s, %s)", (prev_month, ugx_per_kes))
    cur.execute("INSERT INTO currency_rates (country, month, rate) VALUES ('Rwanda', %s, %s)", (prev_month, rwf_per_kes))
    cur.execute("INSERT INTO currency_rates (country, month, rate) VALUES ('Online', %s, 1.0)", (prev_month,))
    conn.commit()

    cur.execute("SELECT country, month, rate FROM currency_rates ORDER BY country")
    print("\nRates saved (local currency per 1 KES):")
    for row in cur.fetchall():
        print(f"  {row[0]} ({row[1]}): {row[2]}")
    conn.close()
    print(f"\n✅ Currency rates updated — {prev_month} monthly average")

if __name__ == '__main__':
    main()