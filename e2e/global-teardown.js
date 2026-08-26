const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const CLEANUP_FILE = path.join(
  process.env.VIVO_E2E_OUTPUT_DIR
    || path.join(__dirname, "..", "artifacts", "vivo-bi", "test-results", "manual-run"),
  "production-release-cleanup.json",
);

async function globalTeardown() {
  const runFile = process.env.VIVO_E2E_RUN_FILE;
  let state;
  try {
    if (!runFile) throw new Error("missing invocation state path");
    state = JSON.parse(fs.readFileSync(runFile, "utf8"));
  } catch {
    state = { token: "", roleTokens: {}, roleUsers: [], labels: [], productionFixture: {} };
  }
  const cleanup = `
import json, os, psycopg2
tokens = json.loads(os.environ.get("E2E_TOKENS", "[]"))
user_ids = json.loads(os.environ.get("E2E_USER_IDS", "[]"))
labels = json.loads(os.environ.get("E2E_LABELS", "[]"))
fixture = json.loads(os.environ.get("E2E_PRODUCTION_FIXTURE", "{}"))
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
cur.execute("DELETE FROM user_sessions WHERE session_token=ANY(%s)", (tokens,))
sessions_deleted = cur.rowcount
if user_ids:
    cur.execute("DELETE FROM app_users WHERE user_id=ANY(%s)", (user_ids,))
    users_deleted = cur.rowcount
else:
    users_deleted = 0
if labels:
  cur.execute("DELETE FROM l10_meetings WHERE folder_id=2 AND week_label=ANY(%s)", (labels,))
  meetings_deleted = cur.rowcount
else:
  meetings_deleted = 0
if fixture:
  run_key = fixture["runKey"]
  cur.execute("DELETE FROM production_workspace_execution_output WHERE capture_key=%s", (run_key,))
  fixture_outputs_deleted = cur.rowcount
  cur.execute("DELETE FROM production_workspace_execution_events WHERE event_key=%s", (run_key,))
  # Submitted plans lock their inputs by design. These records are run-owned
  # test data, so reopen before removing assignments and operations.
  cur.execute("""UPDATE production_workspace_plan_versions SET status='reopened'
                 WHERE work_item_id IN (
                   SELECT id FROM production_workspace_work_items WHERE external_ref=%s)""", (run_key,))
  cur.execute("""DELETE FROM production_workspace_assignments WHERE plan_version_id IN (
                   SELECT p.id FROM production_workspace_plan_versions p
                   JOIN production_workspace_work_items wi ON wi.id=p.work_item_id
                   WHERE wi.external_ref=%s)""", (run_key,))
  cur.execute("""DELETE FROM production_workspace_operations WHERE plan_version_id IN (
                   SELECT p.id FROM production_workspace_plan_versions p
                   JOIN production_workspace_work_items wi ON wi.id=p.work_item_id
                   WHERE wi.external_ref=%s)""", (run_key,))
  cur.execute("""DELETE FROM production_workspace_plan_versions WHERE work_item_id IN (
                   SELECT id FROM production_workspace_work_items WHERE external_ref=%s)""", (run_key,))
  cur.execute("DELETE FROM production_workspace_work_items WHERE external_ref=%s", (run_key,))
  cur.execute("DELETE FROM production_workspace_shifts WHERE code=%s", (fixture["shiftCode"],))
  cur.execute("DELETE FROM production_workspace_lines WHERE code=%s", (fixture["lineCode"],))
  cur.execute("DELETE FROM production_workspace_factories WHERE code=%s", (fixture["factoryCode"],))
  cur.execute("DELETE FROM production_workspace_operators WHERE operator_code=%s", (fixture["operatorCode"],))
  cur.execute("DELETE FROM vivo_attendance WHERE user_id=%s AND branch_name=%s",
              (fixture["attendanceUserId"], fixture["attendanceBranch"]))
else:
  fixture_outputs_deleted = 0
conn.commit()
cur.execute("SELECT COUNT(*) FROM user_sessions WHERE session_token=ANY(%s)", (tokens,))
sessions_remaining = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM app_users WHERE user_id=ANY(%s)", (user_ids,))
users_remaining = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM l10_meetings WHERE folder_id=2 AND week_label=ANY(%s)", (labels,))
meetings_remaining = cur.fetchone()[0]
if fixture:
  run_key = fixture["runKey"]
  cur.execute("SELECT COUNT(*) FROM production_workspace_execution_output WHERE capture_key=%s", (run_key,))
  fixture_outputs_remaining = cur.fetchone()[0]
  cur.execute("SELECT COUNT(*) FROM production_workspace_work_items WHERE external_ref=%s", (run_key,))
  fixture_work_items_remaining = cur.fetchone()[0]
  cur.execute("SELECT COUNT(*) FROM production_workspace_operators WHERE operator_code=%s", (fixture["operatorCode"],))
  fixture_operators_remaining = cur.fetchone()[0]
  cur.execute("SELECT COUNT(*) FROM vivo_attendance WHERE user_id=%s AND branch_name=%s",
              (fixture["attendanceUserId"], fixture["attendanceBranch"]))
  fixture_attendance_remaining = cur.fetchone()[0]
else:
  fixture_outputs_remaining = fixture_work_items_remaining = fixture_operators_remaining = fixture_attendance_remaining = 0
if sessions_remaining or users_remaining or meetings_remaining or fixture_outputs_remaining or fixture_work_items_remaining or fixture_operators_remaining or fixture_attendance_remaining:
  raise RuntimeError("Disposable release-proof records remain after cleanup")
print(json.dumps({"sessions_deleted": sessions_deleted, "users_deleted": users_deleted,
                   "meetings_deleted": meetings_deleted, "sessions_remaining": sessions_remaining,
                   "users_remaining": users_remaining, "meetings_remaining": meetings_remaining,
                   "fixture_outputs_deleted": fixture_outputs_deleted,
                   "fixture_outputs_remaining": fixture_outputs_remaining,
                   "fixture_work_items_remaining": fixture_work_items_remaining,
                   "fixture_operators_remaining": fixture_operators_remaining,
                   "fixture_attendance_remaining": fixture_attendance_remaining}))
`;
  try {
    const tokens = [state.token, ...Object.values(state.roleTokens || {})].filter(Boolean);
    const userIds = (state.roleUsers || []).map((user) => user.userId).filter(Boolean);
    const output = execFileSync("python3", ["-c", cleanup], {
      encoding: "utf8",
      env: {
        ...process.env,
        E2E_TOKENS: JSON.stringify(tokens),
        E2E_USER_IDS: JSON.stringify(userIds),
        E2E_LABELS: JSON.stringify(state.labels || []),
        E2E_PRODUCTION_FIXTURE: JSON.stringify(state.productionFixture || {}),
      },
    }).trim();
    if (runFile) {
      fs.unlinkSync(runFile);
    }
    fs.mkdirSync(path.dirname(CLEANUP_FILE), { recursive: true });
    fs.writeFileSync(CLEANUP_FILE, JSON.stringify({
      ok: true,
      ...JSON.parse(output),
      run_state_removed: !runFile || !fs.existsSync(runFile),
    }, null, 2), "utf8");
  } catch (error) {
    fs.mkdirSync(path.dirname(CLEANUP_FILE), { recursive: true });
    fs.writeFileSync(CLEANUP_FILE, JSON.stringify({ ok: false, error: error.message }), "utf8");
    throw error;
  }
}

module.exports = globalTeardown;