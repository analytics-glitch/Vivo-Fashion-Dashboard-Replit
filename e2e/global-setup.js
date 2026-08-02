const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const TOKEN_FILE = path.join(__dirname, ".test-session-token");

async function globalSetup() {
  const token = "e2e_style_tracker_" + crypto.randomBytes(8).toString("hex");

  const py = `
import os, psycopg2, sys
db = os.environ.get("DATABASE_URL")
if not db:
    print("NO_DATABASE_URL", file=sys.stderr)
    sys.exit(1)
conn = psycopg2.connect(db)
cur = conn.cursor()
cur.execute(
    "SELECT user_id FROM app_users WHERE role='admin' AND status='active' LIMIT 1"
)
row = cur.fetchone()
if not row:
    print("NO_ADMIN_USER", file=sys.stderr)
    sys.exit(1)
user_id = row[0]
cur.execute(
    "INSERT INTO user_sessions (session_token, user_id, expires_at) "
    "VALUES (%s, %s, now() + interval '60 minutes')",
    ("\${TOKEN}", user_id),
)
conn.commit()
cur.close()
conn.close()
print("ok")
`.replace("\${TOKEN}", token);

  try {
    const result = execSync(`python3 -c '${py.replace(/'/g, "'\"'\"'")}'`, {
      encoding: "utf8",
      env: process.env,
    }).trim();
    if (result !== "ok") throw new Error("Session creation failed: " + result);
  } catch (err) {
    console.error("[e2e setup] Failed to create session token:", err.message);
    throw err;
  }

  fs.writeFileSync(TOKEN_FILE, token, "utf8");
  process.env.VIVO_E2E_TOKEN = token;

  // ── Seed L10 test data ────────────────────────────────────────────────────
  // Insert two meetings (folder_id=2, Supply Chain) with one rating each so
  // the 8-tab bar and Conclude sparkline branches always execute.
  const seedPy = `
import os, psycopg2, sys
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
# Ensure the L10 tables exist (no-op if already created by the app).
cur.execute("""
    CREATE TABLE IF NOT EXISTS l10_meetings (
        id           SERIAL PRIMARY KEY,
        folder_id    INT NOT NULL DEFAULT 1,
        week_label   TEXT NOT NULL,
        meeting_date DATE NOT NULL,
        start_time   TEXT NOT NULL DEFAULT '08:00',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
""")
cur.execute("""
    CREATE UNIQUE INDEX IF NOT EXISTS l10_meetings_folder_week_uidx
        ON l10_meetings(folder_id, week_label)
""")
cur.execute("""
    CREATE TABLE IF NOT EXISTS l10_ratings (
        id          SERIAL PRIMARY KEY,
        meeting_id  INT  NOT NULL REFERENCES l10_meetings(id) ON DELETE CASCADE,
        member_name TEXT NOT NULL,
        rating      INT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(meeting_id, member_name)
    )
""")
# Insert two meetings for folder_id=2 (Supply Chain).
cur.execute("""
    INSERT INTO l10_meetings (folder_id, week_label, meeting_date)
    VALUES (2, 'e2e-seed-wk1', '2024-01-08'),
           (2, 'e2e-seed-wk2', '2024-01-15')
    ON CONFLICT (folder_id, week_label) DO NOTHING
    RETURNING id, week_label
""")
rows = cur.fetchall()
# Look up the inserted (or pre-existing) meeting ids.
cur.execute(
    "SELECT id FROM l10_meetings WHERE folder_id=2 AND week_label IN ('e2e-seed-wk1','e2e-seed-wk2') ORDER BY week_label"
)
meeting_ids = [r[0] for r in cur.fetchall()]
if len(meeting_ids) < 2:
    print("SEED_MEETINGS_FAILED", file=sys.stderr)
    conn.rollback()
    conn.close()
    sys.exit(1)
# Insert one rating per meeting (idempotent).
for mid in meeting_ids:
    cur.execute("""
        INSERT INTO l10_ratings (meeting_id, member_name, rating)
        VALUES (%s, 'e2e-tester', 8)
        ON CONFLICT (meeting_id, member_name) DO NOTHING
    """, (mid,))
conn.commit()
cur.close()
conn.close()
print("ok")
`;

  try {
    const seedResult = execSync(
      `python3 -c '${seedPy.replace(/'/g, "'\"'\"'")}'`,
      { encoding: "utf8", env: process.env }
    ).trim();
    if (seedResult !== "ok")
      throw new Error("L10 seed failed: " + seedResult);
  } catch (err) {
    console.error("[e2e setup] Failed to seed L10 test data:", err.message);
    throw err;
  }
}

module.exports = globalSetup;
