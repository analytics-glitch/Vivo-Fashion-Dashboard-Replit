const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const TOKEN_FILE = path.join(__dirname, ".test-session-token");

async function globalTeardown() {
  let token;
  try {
    token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return;
  }

  const py = `
import os, psycopg2
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
cur.execute("DELETE FROM user_sessions WHERE session_token = %s", ("\${TOKEN}",))
conn.commit()
cur.close()
conn.close()
`.replace("${TOKEN}", token);

  try {
    execSync(`python3 -c '${py.replace(/'/g, "'\"'\"'")}'`, {
      encoding: "utf8",
      env: process.env,
    });
  } catch (err) {
    console.warn("[e2e teardown] Failed to delete session token:", err.message);
  }

  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {}
}

module.exports = globalTeardown;
