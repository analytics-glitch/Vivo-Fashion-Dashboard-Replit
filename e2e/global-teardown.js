const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const CLEANUP_FILE = path.join(__dirname, ".production-release-cleanup.json");

async function globalTeardown() {
  const runFile = process.env.VIVO_E2E_RUN_FILE;
  let state;
  try {
    if (!runFile) throw new Error("missing invocation state path");
    state = JSON.parse(fs.readFileSync(runFile, "utf8"));
  } catch {
    state = { token: "", labels: [] };
  }
  const cleanup = `
import json, os, psycopg2
token = os.environ.get("E2E_TOKEN", "")
labels = json.loads(os.environ.get("E2E_LABELS", "[]"))
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
cur.execute("DELETE FROM user_sessions WHERE session_token=%s", (token,))
sessions_deleted = cur.rowcount
if labels:
  cur.execute("DELETE FROM l10_meetings WHERE folder_id=2 AND week_label=ANY(%s)", (labels,))
  meetings_deleted = cur.rowcount
else:
  meetings_deleted = 0
conn.commit()
cur.execute("SELECT COUNT(*) FROM user_sessions WHERE session_token=%s", (token,))
sessions_remaining = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM l10_meetings WHERE folder_id=2 AND week_label=ANY(%s)", (labels,))
meetings_remaining = cur.fetchone()[0]
if sessions_remaining or meetings_remaining:
  raise RuntimeError("Disposable release-proof records remain after cleanup")
print(json.dumps({"sessions_deleted": sessions_deleted, "meetings_deleted": meetings_deleted,
                  "sessions_remaining": sessions_remaining, "meetings_remaining": meetings_remaining}))
`;
  try {
    const output = execFileSync("python3", ["-c", cleanup], {
      encoding: "utf8",
      env: { ...process.env, E2E_TOKEN: state.token || "", E2E_LABELS: JSON.stringify(state.labels || []) },
    }).trim();
    fs.writeFileSync(CLEANUP_FILE, JSON.stringify({ ok: true, ...JSON.parse(output) }), "utf8");
  } catch (error) {
    fs.writeFileSync(CLEANUP_FILE, JSON.stringify({ ok: false, error: error.message }), "utf8");
    throw error;
  } finally {
    if (runFile) {
      try { fs.unlinkSync(runFile); } catch {}
    }
  }
}

module.exports = globalTeardown;