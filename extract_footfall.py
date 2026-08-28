import os
import requests
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timedelta
import time
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DATABASE_URL         = os.environ["DATABASE_URL"]
FOOTFALLCAM_EMAIL    = os.environ["FOOTFALLCAM_EMAIL"]
FOOTFALLCAM_PASSWORD = os.environ["FOOTFALLCAM_PASSWORD"]
AUTH_URL             = "https://v9.footfallcam.com"
CUBE_URL             = "https://cube.footfallcam.com/API/v1"

# Map FootfallCam site names → Vivo POS location names.
SITE_LOCATION_MAP = {
    # Kenya
    "Sarit Centre":         "Vivo Sarit",
    "VFGJUNCTION":          "Vivo Junction",
    "Vivo Junction":        "Vivo Junction",
    "VIVO Mama Ngina":      "Vivo Mama Ngina St",
    "Yaya Centre":          "Vivo Yaya",
    "VivoVillageMKT":       "Vivo Village Market",
    "VIVO Capital":         "Vivo Capital Centre",
    "Vivo Imaara":          "Vivo Imaara",
    "VIVO Mombasa":         "Vivo City Mall",
    "VFGELDORET":           "Vivo Eldoret",
    "VIVO Galleria":        "Vivo Galleria",
    "VFGGALLERIAMALL":      "Vivo Galleria",
    "VIVO Gardencity":      "Vivo Garden City",
    "The Hub":              "Vivo Hub",
    "VFGTHEHUB":            "Vivo Hub",
    "VivoKisumu":           "Vivo Kisumu",
    "VIVO MERU":            "Vivo Meru",
    "Vivo MoiAV":           "Vivo Moi Avenue",
    "Shop Zetu_MoiAv":      "Vivo Moi Avenue",
    "Vivo_MSA_DigoRD":      "Vivo MSA Digo Road",
    "VIVO Westside":        "Vivo Nakuru",
    "Vivo Runda Mall":      "Vivo Runda",
    "VFGSIGNATURE":         "Vivo Signature Mall",
    "Vivo Greenspan":       "Vivo Greenspan",
    "Vivo TRM":             "Vivo TRM",
    "Two Rivers":           "Vivo Two Rivers",
    "VIVO T-Mall":          "Vivo T- Mall",
    "VFG T-MALL":           "Vivo T- Mall",
    "KILELESHWA":           "Vivo Kileleshwa",
    "Safari Sarit":         "Safari Sarit",
    "Zoya Sarit":           "Zoya Sarit",
    # Uganda
    " Oasis mall":          "The Oasis Mall",
    "Acacia Mall":          "Vivo Acacia",
    # Rwanda
    "Vivo Kigali ":         "Vivo Kigali Heights",
    " Kigali M-peace":      "Vivo M-peace Plaza",
}

def get_access_token():
    expiration = (datetime.utcnow() + timedelta(days=30)).strftime("%Y-%m-%d")
    resp = requests.post(
        f"{AUTH_URL}/account/GenerateAccessToken",
        json={"email": FOOTFALLCAM_EMAIL, "password": FOOTFALLCAM_PASSWORD, "expiration": expiration},
        timeout=30
    )
    resp.raise_for_status()
    token = resp.json().get("AToken")
    if not token:
        raise RuntimeError(f"Failed to get token: {resp.json()}")
    log.info("FootfallCam token generated")
    return token

def get_last_sync(conn):
    cur = conn.cursor()
    cur.execute("SELECT MAX(time) FROM footfall")
    result = cur.fetchone()[0]
    cur.close()
    if result:
        return result - timedelta(days=2)
    return datetime(2022, 1, 1).date()

def fetch_footfall(token, start_date, end_date):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}"
    }
    payload = {
        "query": {
            "measures": [
                "ffc_site_summary.A01", "ffc_site_summary.A02",
                "ffc_site_summary.A03", "ffc_site_summary.A04",
                "ffc_site_summary.A05", "ffc_site_summary.A15",
                "ffc_site_summary.B06", "ffc_site_summary.B01",
                "ffc_site_summary.A61", "ffc_site_summary.A20",
                "ffc_site_summary.A21", "ffc_site_summary.B21",
                "ffc_site_summary.B22", "ffc_site_summary.B13",
                "ffc_site_summary.B14", "ffc_site_summary.B15",
                "ffc_site_summary.B16", "ffc_site_summary.B17",
                "ffc_site_summary.B02",
            ],
            "dimensions": [
                "ffc_site_summary.CompanyName",
                "ffc_site_summary.SiteName",
                "ffc_site_summary.SiteId",
                "ffc_site_summary.SiteCode",
            ],
            "timeDimensions": [{
                "dimension": "ffc_site_summary.Time",
                "granularity": "day",
                "dateRange": [
                    start_date.strftime("%Y-%m-%d"),
                    end_date.strftime("%Y-%m-%d")
                ]
            }],
            "limit": 1000000
        }
    }
    for attempt in range(3):
        try:
            resp = requests.post(
                f"{CUBE_URL}/load",
                json=payload,
                headers=headers,
                timeout=180
            )
            resp.raise_for_status()
            return resp.json().get("data", [])
        except Exception as e:
            if attempt < 2:
                log.warning("Retry %d: %s", attempt + 1, e)
                time.sleep(5 * (attempt + 1))
            else:
                raise

def main():
    conn = psycopg2.connect(DATABASE_URL)
    token = get_access_token()
    start = get_last_sync(conn)
    end   = datetime.utcnow().date()
    log.info("Syncing footfall from %s to %s", start, end)

    chunk_start = datetime.combine(start, datetime.min.time())
    chunk_end_limit = datetime.combine(end, datetime.min.time())
    now = datetime.utcnow()
    total = 0

    while chunk_start < chunk_end_limit:
        chunk_end = min(chunk_start + timedelta(days=30), chunk_end_limit)
        log.info("Fetching %s to %s", chunk_start.date(), chunk_end.date())

        try:
            data = fetch_footfall(token, chunk_start, chunk_end)
        except Exception as e:
            log.error("Failed chunk: %s", e)
            chunk_start = chunk_end
            continue

        if not data:
            log.info("No data for this chunk")
            chunk_start = chunk_end
            continue

        rows = []
        for r in data:
            time_str = r.get("ffc_site_summary.Time") or r.get("ffc_site_summary.Time.day")
            if not time_str:
                continue
            site_name = r.get("ffc_site_summary.SiteName", "")
            pos_location = SITE_LOCATION_MAP.get(site_name, site_name)

            rows.append((
                r.get("ffc_site_summary.SiteId"),
                site_name,
                r.get("ffc_site_summary.SiteCode"),
                time_str[:10],
                r.get("ffc_site_summary.CompanyName"),
                pos_location,
                int(r.get("ffc_site_summary.A01") or 0),
                int(r.get("ffc_site_summary.A02") or 0),
                int(r.get("ffc_site_summary.A03") or 0),
                r.get("ffc_site_summary.A04"),
                int(r.get("ffc_site_summary.A05") or 0),
                int(r.get("ffc_site_summary.A15") or 0),
                r.get("ffc_site_summary.B06"),
                r.get("ffc_site_summary.B01"),
                int(r.get("ffc_site_summary.A61") or 0),
                int(r.get("ffc_site_summary.A20") or 0),
                int(r.get("ffc_site_summary.A21") or 0),
                int(r.get("ffc_site_summary.B21") or 0),
                int(r.get("ffc_site_summary.B22") or 0),
                int(r.get("ffc_site_summary.B13") or 0),
                int(r.get("ffc_site_summary.B14") or 0),
                int(r.get("ffc_site_summary.B15") or 0),
                int(r.get("ffc_site_summary.B16") or 0),
                int(r.get("ffc_site_summary.B17") or 0),
                r.get("ffc_site_summary.B02"),
                now,
            ))

        if rows:
            cur = conn.cursor()
            cur.execute(
                "DELETE FROM footfall WHERE time >= %s AND time <= %s",
                (chunk_start.date(), chunk_end.date())
            )
            execute_values(cur, """
                INSERT INTO footfall (
                    site_id, site_name, site_code, time, company,
                    pos_location_name,
                    a01_footfall_in, a02_footfall_out, a03_occupancy,
                    a04_avg_visit_duration, a05_outside_traffic,
                    a15_total_transaction_count, b06_sales_conversion,
                    b01_turn_in_rate, a61_outside_traffic_all_hours,
                    a20_number_of_engaged_customer, a21_number_of_passerby,
                    b21_male, b22_female, b13_children, b14_teenagers,
                    b15_young_adults, b16_middle_age_adults, b17_elderly,
                    b02_returning_rate, last_synced
                ) VALUES %s
                ON CONFLICT (site_id, time) DO UPDATE SET
                    a01_footfall_in = EXCLUDED.a01_footfall_in,
                    last_synced = EXCLUDED.last_synced
            """, rows, page_size=500)
            conn.commit()
            cur.close()
            total += len(rows)
            log.info("Inserted %d rows (total: %d)", len(rows), total)

        chunk_start = chunk_end

    conn.close()
    log.info("✅ Footfall sync complete — %d rows", total)

if __name__ == "__main__":
    main()