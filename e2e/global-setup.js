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
  const token = `e2e_production_admin_${runId}`;
  const roleTokens = {
    production: `e2e_production_operator_${runId}`,
    quality: `e2e_production_quality_${runId}`,
  };
  const roleUsers = [
    {
      userId: `e2e-production-${runId}`,
      email: `e2e-production-${runId}@example.invalid`,
      name: "E2E Production Operator",
      role: "production",
      token: roleTokens.production,
    },
    {
      userId: `e2e-quality-${runId}`,
      email: `e2e-quality-${runId}@example.invalid`,
      name: "E2E Quality Reviewer",
      role: "quality",
      token: roleTokens.quality,
    },
  ];
  const labels = [`e2e-${runId}-wk1`, `e2e-${runId}-wk2`];
  const productionFixture = {
    runKey: `e2e-production-proof-${runId}`,
    factoryCode: `e2e-factory-${runId}`,
    lineCode: `e2e-line-${runId}`,
    shiftCode: `e2e-shift-${runId}`,
    operatorCode: `e2e-operator-${runId}`,
    operatorName: `E2E Private Operator ${runId}`,
    attendanceBranch: `E2E Release Proof ${runId}`,
    attendanceUserId: 900000000 + (parseInt(runId.slice(0, 7), 16) % 99999999),
    ids: {},
  };
  // Persist ownership before touching the database. Teardown can then clean up
  // a partial setup rather than leaking a session/seed after a retry.
  fs.writeFileSync(runFile, JSON.stringify({
    runId, token, roleTokens, roleUsers, labels, productionFixture, seedIds: [],
  }), "utf8");
  process.env.VIVO_E2E_TOKEN = token;
  process.env.VIVO_E2E_PRODUCTION_TOKEN = roleTokens.production;
  process.env.VIVO_E2E_QUALITY_TOKEN = roleTokens.quality;

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
  const createRoleFixtures = `
import json, os, psycopg2
fixtures = json.loads(os.environ["E2E_ROLE_USERS"])
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
for fixture in fixtures:
    cur.execute(
        """INSERT INTO app_users
           (user_id,email,name,role,status,auth_method,approved_at,approved_by)
           VALUES (%s,%s,%s,%s,'active','e2e',now(),'e2e-release-proof')""",
        (fixture["userId"], fixture["email"], fixture["name"], fixture["role"]),
    )
    cur.execute(
        "INSERT INTO user_sessions (session_token,user_id,expires_at) VALUES (%s,%s,now()+interval '60 minutes')",
        (fixture["token"], fixture["userId"]),
    )
conn.commit()
`;
  runPython(createRoleFixtures, { E2E_ROLE_USERS: JSON.stringify(roleUsers) });
  const createProductionFixture = `
import json, os, psycopg2
fixture = json.loads(os.environ["E2E_PRODUCTION_FIXTURE"])
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
cur.execute("INSERT INTO production_workspace_factories(code,name) VALUES (%s,%s) RETURNING id",
            (fixture["factoryCode"], "E2E Release Factory"))
factory_id = cur.fetchone()[0]
cur.execute("INSERT INTO production_workspace_lines(factory_id,code,name) VALUES (%s,%s,%s) RETURNING id",
            (factory_id, fixture["lineCode"], "E2E Release Line"))
line_id = cur.fetchone()[0]
cur.execute("INSERT INTO production_workspace_shifts(factory_id,code,name,start_time,end_time) VALUES (%s,%s,%s,%s,%s) RETURNING id",
            (factory_id, fixture["shiftCode"], "E2E Release Shift", "08:00", "17:00"))
shift_id = cur.fetchone()[0]
cur.execute("""INSERT INTO production_workspace_work_items
               (external_ref,style_number,description,planned_qty,stage_key)
               VALUES (%s,%s,%s,%s,%s) RETURNING id""",
            (fixture["runKey"], "E2E-REDaction", "Release proof only", 10, "sewing"))
work_item_id = cur.fetchone()[0]
cur.execute("""INSERT INTO production_workspace_plan_versions
               (work_item_id,version_no,status,factory_id,line_id,shift_id,planned_start,planned_end,planned_qty,approved_by,approved_at)
               VALUES (%s,1,'draft',%s,%s,%s,CURRENT_DATE,CURRENT_DATE,%s,NULL,NULL) RETURNING id""",
            (work_item_id, factory_id, line_id, shift_id, 10))
plan_id = cur.fetchone()[0]
cur.execute("""INSERT INTO production_workspace_operators(operator_code,display_name)
               VALUES (%s,%s) RETURNING id""",
            (fixture["operatorCode"], fixture["operatorName"]))
operator_id = cur.fetchone()[0]
cur.execute("""INSERT INTO production_workspace_operations
               (work_item_id,plan_version_id,operation_code,name,sequence_no,sam_minutes,line_id)
               VALUES (%s,%s,%s,%s,1,5,%s) RETURNING id""",
            (work_item_id, plan_id, fixture["runKey"], "E2E Release Operation", line_id))
operation_id = cur.fetchone()[0]
cur.execute("""INSERT INTO production_workspace_assignments
               (plan_version_id,operation_id,operator_id,line_id,planned_minutes,created_by)
               VALUES (%s,%s,%s,%s,50,'e2e-release-proof') RETURNING id""",
            (plan_id, operation_id, operator_id, line_id))
assignment_id = cur.fetchone()[0]
cur.execute("""UPDATE production_workspace_plan_versions
               SET status='approved', approved_by='e2e-release-proof', approved_at=now()
               WHERE id=%s""", (plan_id,))
cur.execute("""INSERT INTO production_workspace_execution_output
               (plan_version_id,assignment_id,work_item_id,factory_id,line_id,shift_id,operation_id,
                capture_kind,capture_date,capture_key,planned_qty,good_qty,reject_qty,rework_qty,created_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s,'hourly',CURRENT_DATE,%s,10,8,1,1,'e2e-release-proof')""",
            (plan_id, assignment_id, work_item_id, factory_id, line_id, shift_id, operation_id, fixture["runKey"]))
cur.execute("""INSERT INTO vivo_attendance
               (user_id,employee_name,branch_name,attendance_date,hours_worked,is_complete,synced_at,pushed_at)
               VALUES (%s,%s,%s,CURRENT_DATE,8,true,now(),now())""",
            (fixture["attendanceUserId"], fixture["operatorName"], fixture["attendanceBranch"]))
conn.commit()
print(json.dumps({
  "factory_id": factory_id,
  "line_id": line_id,
  "shift_id": shift_id,
  "work_item_id": work_item_id,
  "plan_id": plan_id,
  "operator_id": operator_id,
  "operation_id": operation_id,
  "assignment_id": assignment_id,
}))
`;
  const createdFixture = JSON.parse(runPython(createProductionFixture, {
    E2E_PRODUCTION_FIXTURE: JSON.stringify(productionFixture),
  }));
  productionFixture.ids = createdFixture;
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
  fs.writeFileSync(runFile, JSON.stringify({
    runId, token, roleTokens, roleUsers, labels, productionFixture, seedIds,
  }), "utf8");
}

module.exports = globalSetup;