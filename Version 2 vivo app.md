# Vivo Fashion Group BI Platform — Version 2

A full-stack Business Intelligence platform for Vivo Fashion Group — East Africa. Built on Replit, combining a real-time web dashboard, a Python/PostgreSQL API backend, and a React Native mobile app.

---

## What's New in Version 2

| Release | Version Code | Date | Notes |
|---|---|---|---|
| Release 3 | 1.0.0 | 23 Jun 2026 | Fix: Resolved a login issue that prevented some users from signing in |
| Release 2 | 1.0.0 | 19 Jun 2026 | Initial closed testing release |

---

## Project Structure

```
artifacts/
  api-server/       # FastAPI backend (Python + PostgreSQL)
  vivo-bi/          # Next.js web dashboard (main BI frontend)
  vivo-mobile/      # Expo React Native mobile app
  vivo-crm/         # CRM module
  vivo-hr/          # HR & Attendance module
  vivo-loyalty/     # Customer loyalty module
dashboard/          # Dashboard files
lib/                # Shared utilities
scripts/            # Data sync, extract, and transform scripts
```

---

## Stack

| Layer | Technology |
|---|---|
| Web Frontend | Next.js (React) |
| Mobile App | Expo (React Native) |
| Backend API | FastAPI (Python) |
| Database | PostgreSQL |
| Hosting | Replit (vivofashionbrands.com) |
| Mobile Builds | EAS Build (Expo Application Services) |
| Auth | Email/password + Google OAuth (session tokens) |

---

## Live URLs

- Web Dashboard: https://vivofashionbrands.com
- API Health: https://vivofashionbrands.com/api/
- Auth Endpoint: https://vivofashionbrands.com/api/auth/login

---

## Mobile App (Vivo BI Mobile)

Located in artifacts/vivo-mobile/.

### Build Profiles

| Profile | Output | Purpose |
|---|---|---|
| development | APK | Local dev with Expo dev client |
| preview | APK | Internal tester builds |
| production | AAB | Play Store submission |

All profiles use EXPO_PUBLIC_DOMAIN=vivofashionbrands.com.

### Current Build

- **Version:** 1.0.0 (Version Code 3)
- **Track:** Closed Testing — Alpha
- **Target SDK:** 36
- **Min API Level:** 24+
- **Status:** In review (submitted 23 Jun 2026)

### Building

```bash
cd artifacts/vivo-mobile

# Preview APK for testers
eas build --platform android --profile preview

# Production AAB for Play Store
eas build --platform android --profile production
```

### Distributing to Testers

Use Google Play Console → Closed Testing (Alpha):
1. Build with --profile production
2. Upload the .aab to Play Console → Alpha track
3. Testers update automatically via the Play Store — no re-download needed

---

## Authentication

- No static API keys bundled in the app
- Users log in with email/password or Google OAuth
- Session token stored on-device in AsyncStorage as vivo_token
- All API requests send Authorization: Bearer <token>
- A 401 response clears the session and returns to the login screen

---

## Data Sync Scripts

| Script | Purpose |
|---|---|
| sync_all.py | Full sync of all data sources |
| sync_incremental.py | Incremental updates only |
| extract_shopify_*.py | Shopify sales, products, customers, inventory |
| extract_odoo_*.py | Odoo orders, products, customers, inventory |
| extract_footfall.py | Store footfall sensor data |
| transform_all_*.py | Data transformation layer |
| sync_accounting.py | Accounting data sync |

> **Note:** Fabric and orders (production tracker) data now refresh every 1 minute instead of hourly as of Jun 2026.

---

## Environment & Secrets

Sensitive credentials (DB connection strings, third-party API keys) are stored as Replit Secrets — never committed to the repo.

Public build-time config lives in artifacts/vivo-mobile/eas.json under each profile's env key.

---

## Deployment

The backend runs on Replit at vivofashionbrands.com. Auto-restarts via watchdog.py.

```bash
# Restart API only
bash start_api.sh

# Start all services
bash start_all.sh
```

---

## Access

Restricted to approved email domains. Contact the administrator for access.

Powered by Vivo BI — East Africa
