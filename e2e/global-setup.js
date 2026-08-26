const { execFileSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

function runPython(script, env) {
  return execFileSync("python3", ["-c", script], {
    encoding: "utf8", env: { ...process.env, ...env },
  }).trim();
}

async function globalSetup() {
  const runId = crypto.randomUUID();
  // Playwright may be launched concurrently.  Teardown must receive only this
  // invocation's ownership record, never a shared run/token file.
  const runFile = path.join(__dirname, `.production-release-run-${runId}.json`);
  process.env.VIVO_E2E_RUN_FILE = runFile;
  const token = `e2e_production_${runId}`;
  const labels = [`e2e-${runId}-wk1`, `e2e-${runId}-wk2`];
  // Persist ownership before touching the database. Teardown can then clean up
  // a partial setup rather than leaking a session/seed after a retry.
  fs.writeFileSync(runFile, JSON.stringify({ runId, token, labels, seedIds: [] }), "utf8");
  process.env.VIVO_E2E_TOKEN = token;

  const createSession = `
import os, psycopg2, sys
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
cur.execute("SELECT user_id FROM app_users WHERE role='admin' AND status='active' LIMIT 1")
row = cur.fetchone()
if not row: raise RuntimeError("NO_ADMIN_USER")
cur.execute("INSERT INTO user_sessions (session_token, user_id, expires_at) VALUES (%s,%s,now()+interval '60 minutes')", (os.environ["E2E_TOKEN"], row[0]))
conn.commit()
`;
  runPython(createSession, { E2E_TOKEN: token });
  // Some shared BI browser coverage needs L10 data. Use run-owned labels so
  // concurrent/retried release proof runs neither share nor delete each other.
  const seed = `
import json, os, psycopg2
labels = json.loads(os.environ["E2E_LABELS"])
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
cur.execute("""CREATE TABLE IF NOT EXISTS l10_meetings (
  id SERIAL PRIMARY KEY, folder_id INT NOT NULL DEFAULT 1, week_label TEXT NOT NULL,
  meeting_date DATE NOT NULL, start_time TEXT NOT NULL DEFAULT '08:00',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS l10_meetings_folder_week_uidx ON l10_meetings(folder_id,week_label)")
cur.execute("""CREATE TABLE IF NOT EXISTS l10_ratings (
  id SERIAL PRIMARY KEY, meeting_id INT NOT NULL REFERENCES l10_meetings(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL, rating INT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(meeting_id,member_name))""")
ids = []
for label, day in zip(labels, ("2024-01-08", "2024-01-15")):
  cur.execute("INSERT INTO l10_meetings (folder_id,week_label,meeting_date) VALUES (2,%s,%s) RETURNING id", (label,day))
  mid = cur.fetchone()[0]
  ids.append(mid)
  cur.execute("INSERT INTO l10_ratings (meeting_id,member_name,rating) VALUES (%s,%s,8)", (mid, "e2e-"+os.environ["E2E_RUN_ID"]))
conn.commit()
print(json.dumps(ids))
`;
  const seedIds = JSON.parse(runPython(seed, {
    E2E_LABELS: JSON.stringify(labels), E2E_RUN_ID: runId,
  }));
  fs.writeFileSync(runFile, JSON.stringify({ runId, token, labels, seedIds }), "utf8");
}

module.exports = globalSetup;