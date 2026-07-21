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
}

module.exports = globalSetup;
