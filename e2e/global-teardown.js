const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const CLEANUP_FILE = path.join(
  process.env.VIVO_E2E_OUTPUT_DIR
    || path.join(__dirname, "..", "artifacts", "vivo-bi", "test-results", "manual-run"),
  "production-release-cleanup.json",
);

function sanitizeEvidence(outputDir, secrets) {
  const sanitizer = `
import json, os, re, tempfile, zipfile
from pathlib import Path

root = Path(os.environ["E2E_EVIDENCE_DIR"])
secrets = [value.encode("utf-8") for value in json.loads(os.environ["E2E_REDACTIONS"]) if value]
patterns = (
    re.compile(rb"(?i)(?:authorization|proxy-authorization|cookie|set-cookie)\\s*[:=]\\s*[^\\r\\n\\\"']+"),
    re.compile(rb"(?i)\\bbearer\\s+[a-z0-9._~+\\/-]{12,}"),
    re.compile(rb"(?i)(?:access_token|id_token|session_token|token)=([^&\\s\\\"']+)"),
    re.compile(rb"https?://[^\\s\\\"']*googleusercontent\\.com/[^\\s\\\"']+"),
    re.compile(rb"(?i)\\b[a-z0-9._%+\\-]+@[a-z0-9.\\-]+\\.[a-z]{2,}\\b"),
)
structured_header_patterns = (
    re.compile(rb"(?is)(\\\"name\\\"\\s*:\\s*\\\"(?:cookie|set-cookie|authorization|proxy-authorization)\\\"\\s*,\\s*\\\"value\\\"\\s*:\\s*\\\")(?!\\[REDACTED\\])[^\\\"]*(\\\")"),
    re.compile(rb"(?is)(\\\"value\\\"\\s*:\\s*\\\")(?!\\[REDACTED\\])[^\\\"]*(\\\"\\s*,\\s*\\\"name\\\"\\s*:\\s*\\\"(?:cookie|set-cookie|authorization|proxy-authorization)\\\")"),
)

def redact(data):
    for secret in secrets:
        data = data.replace(secret, b"[REDACTED]")
    for pattern in patterns:
        data = pattern.sub(b"[REDACTED]", data)
    for pattern in structured_header_patterns:
        data = pattern.sub(rb"\\1[REDACTED]\\2", data)
    return data

def unsafe_count(data):
    return sum(len(pattern.findall(data)) for pattern in patterns + structured_header_patterns)

unsafe_matches = 0
for path in root.rglob("*"):
    if not path.is_file() or path.name == "production-release-cleanup.json":
        continue
    if path.suffix == ".zip":
        with zipfile.ZipFile(path, "r") as source:
            entries = [(info, redact(source.read(info))) for info in source.infolist()]
        fd, temp_name = tempfile.mkstemp(prefix=".sanitized-", dir=str(path.parent))
        os.close(fd)
        try:
            with zipfile.ZipFile(temp_name, "w") as target:
                for info, data in entries:
                    target.writestr(info, data)
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
    else:
        data = path.read_bytes()
        redacted = redact(data)
        if redacted != data:
            path.write_bytes(redacted)
for path in root.rglob("*"):
    if not path.is_file() or path.name == "production-release-cleanup.json":
        continue
    if path.suffix == ".zip":
        with zipfile.ZipFile(path, "r") as archive:
            unsafe_matches += sum(unsafe_count(archive.read(info)) for info in archive.infolist())
    else:
        unsafe_matches += unsafe_count(path.read_bytes())
if unsafe_matches:
    raise RuntimeError(f"unsafe retained evidence remained after sanitization: {unsafe_matches}")
print(json.dumps({"unsafe_matches": unsafe_matches}))
`;
  return JSON.parse(execFileSync("python3", ["-c", sanitizer], {
    encoding: "utf8",
    env: {
      ...process.env,
      E2E_EVIDENCE_DIR: outputDir,
      E2E_REDACTIONS: JSON.stringify(secrets),
    },
  }).trim());
}

async function globalTeardown() {
  const runFile = process.env.VIVO_E2E_RUN_FILE;
  let state;
  try {
    if (!runFile) throw new Error("missing invocation state path");
    state = JSON.parse(fs.readFileSync(runFile, "utf8"));
  } catch (error) {
    fs.mkdirSync(path.dirname(CLEANUP_FILE), { recursive: true });
    fs.writeFileSync(CLEANUP_FILE, JSON.stringify({
      ok: false,
      error: `release-proof ownership state is unavailable: ${error.message}`,
    }, null, 2), "utf8");
    throw error;
  }
  const cleanup = `
import json, os, psycopg2

tokens = json.loads(os.environ.get("E2E_TOKENS", "[]"))
user_ids = json.loads(os.environ.get("E2E_USER_IDS", "[]"))
labels = json.loads(os.environ.get("E2E_LABELS", "[]"))
fixture = json.loads(os.environ.get("E2E_PRODUCTION_FIXTURE", "{}"))
ids = fixture.get("ids") or {}
conn = psycopg2.connect(os.environ["DATABASE_URL"])
cur = conn.cursor()
deleted = {}

def delete(sql, params, key):
    cur.execute(sql, params)
    deleted[key] = cur.rowcount

if tokens:
    delete("DELETE FROM user_sessions WHERE session_token=ANY(%s)", (tokens,), "sessions")
if user_ids:
    delete("DELETE FROM app_users WHERE user_id=ANY(%s)", (user_ids,), "role_users")

if labels:
    cur.execute("SELECT id FROM l10_meetings WHERE folder_id=2 AND week_label=ANY(%s)", (labels,))
    meeting_ids = [row[0] for row in cur.fetchall()]
    if meeting_ids:
        delete("DELETE FROM l10_ratings WHERE meeting_id=ANY(%s)", (meeting_ids,), "ratings")
        delete("DELETE FROM l10_meetings WHERE id=ANY(%s)", (meeting_ids,), "meetings")
    else:
        deleted["ratings"] = 0
        deleted["meetings"] = 0
else:
    meeting_ids = []
    deleted["ratings"] = 0
    deleted["meetings"] = 0

run_key = fixture.get("runKey")
if run_key:
    delete("DELETE FROM production_workspace_execution_output WHERE capture_key=%s", (run_key,), "execution_output")
    delete("DELETE FROM production_workspace_execution_events WHERE event_key=%s", (run_key,), "execution_events")

plan_id = ids.get("plan_id")
if plan_id:
    cur.execute("UPDATE production_workspace_plan_versions SET status='reopened' WHERE id=%s", (plan_id,))
    deleted["plans_reopened"] = cur.rowcount
    delete("DELETE FROM production_workspace_assignments WHERE id=%s", (ids["assignment_id"],), "assignments")
    delete("DELETE FROM production_workspace_operations WHERE id=%s", (ids["operation_id"],), "operations")
    delete("DELETE FROM production_workspace_plan_versions WHERE id=%s", (plan_id,), "plan_versions")
elif run_key:
    cur.execute("""UPDATE production_workspace_plan_versions SET status='reopened'
                   WHERE work_item_id IN (
                     SELECT id FROM production_workspace_work_items WHERE external_ref=%s)""", (run_key,))
    deleted["plans_reopened"] = cur.rowcount
    delete("""DELETE FROM production_workspace_assignments WHERE plan_version_id IN (
                SELECT p.id FROM production_workspace_plan_versions p
                JOIN production_workspace_work_items wi ON wi.id=p.work_item_id
                WHERE wi.external_ref=%s)""", (run_key,), "assignments")
    delete("""DELETE FROM production_workspace_operations WHERE plan_version_id IN (
                SELECT p.id FROM production_workspace_plan_versions p
                JOIN production_workspace_work_items wi ON wi.id=p.work_item_id
                WHERE wi.external_ref=%s)""", (run_key,), "operations")
    delete("""DELETE FROM production_workspace_plan_versions WHERE work_item_id IN (
                SELECT id FROM production_workspace_work_items WHERE external_ref=%s)""", (run_key,), "plan_versions")
else:
    deleted.update({"plans_reopened": 0, "assignments": 0, "operations": 0, "plan_versions": 0})

if run_key:
    delete("DELETE FROM production_workspace_work_items WHERE external_ref=%s", (run_key,), "work_items")
else:
    deleted["work_items"] = 0
if fixture.get("shiftCode"):
    delete("DELETE FROM production_workspace_shifts WHERE code=%s", (fixture["shiftCode"],), "shifts")
    delete("DELETE FROM production_workspace_lines WHERE code=%s", (fixture["lineCode"],), "lines")
    delete("DELETE FROM production_workspace_factories WHERE code=%s", (fixture["factoryCode"],), "factories")
    delete("DELETE FROM production_workspace_operators WHERE operator_code=%s", (fixture["operatorCode"],), "operators")
    delete("DELETE FROM vivo_attendance WHERE user_id=%s AND branch_name=%s",
           (fixture["attendanceUserId"], fixture["attendanceBranch"]), "attendance")
else:
    deleted.update({"shifts": 0, "lines": 0, "factories": 0, "operators": 0, "attendance": 0})

conn.commit()
remaining = {}
if tokens:
    cur.execute("SELECT COUNT(*) FROM user_sessions WHERE session_token=ANY(%s)", (tokens,))
    remaining["sessions"] = cur.fetchone()[0]
else:
    remaining["sessions"] = 0
if user_ids:
    cur.execute("SELECT COUNT(*) FROM app_users WHERE user_id=ANY(%s)", (user_ids,))
    remaining["role_users"] = cur.fetchone()[0]
else:
    remaining["role_users"] = 0
if labels:
    cur.execute("SELECT COUNT(*) FROM l10_meetings WHERE folder_id=2 AND week_label=ANY(%s)", (labels,))
    remaining["meetings"] = cur.fetchone()[0]
    cur.execute("""SELECT COUNT(*) FROM l10_ratings r
                   JOIN l10_meetings m ON m.id=r.meeting_id
                   WHERE m.folder_id=2 AND m.week_label=ANY(%s)""", (labels,))
    remaining["ratings"] = cur.fetchone()[0]
else:
    remaining["meetings"] = remaining["ratings"] = 0

if run_key:
    checks = {
      "execution_output": ("SELECT COUNT(*) FROM production_workspace_execution_output WHERE capture_key=%s", (run_key,)),
      "execution_events": ("SELECT COUNT(*) FROM production_workspace_execution_events WHERE event_key=%s", (run_key,)),
      "work_items": ("SELECT COUNT(*) FROM production_workspace_work_items WHERE external_ref=%s", (run_key,)),
    }
else:
    checks = {}
if ids.get("assignment_id"):
    checks["assignments"] = ("SELECT COUNT(*) FROM production_workspace_assignments WHERE id=%s", (ids["assignment_id"],))
if ids.get("operation_id"):
    checks["operations"] = ("SELECT COUNT(*) FROM production_workspace_operations WHERE id=%s", (ids["operation_id"],))
if ids.get("plan_id"):
    checks["plan_versions"] = ("SELECT COUNT(*) FROM production_workspace_plan_versions WHERE id=%s", (ids["plan_id"],))
if fixture.get("shiftCode"):
    checks.update({
      "shifts": ("SELECT COUNT(*) FROM production_workspace_shifts WHERE code=%s", (fixture["shiftCode"],)),
      "lines": ("SELECT COUNT(*) FROM production_workspace_lines WHERE code=%s", (fixture["lineCode"],)),
      "factories": ("SELECT COUNT(*) FROM production_workspace_factories WHERE code=%s", (fixture["factoryCode"],)),
      "operators": ("SELECT COUNT(*) FROM production_workspace_operators WHERE operator_code=%s", (fixture["operatorCode"],)),
      "attendance": ("SELECT COUNT(*) FROM vivo_attendance WHERE user_id=%s AND branch_name=%s",
                     (fixture["attendanceUserId"], fixture["attendanceBranch"])),
    })
for key, (sql, params) in checks.items():
    cur.execute(sql, params)
    remaining[key] = cur.fetchone()[0]

if any(remaining.values()):
    raise RuntimeError("Disposable release-proof records remain after cleanup: " + json.dumps(remaining, sort_keys=True))
print(json.dumps({"deleted": deleted, "remaining": remaining}, sort_keys=True))
`;
  try {
    const tokens = [state.token, ...Object.values(state.roleTokens || {})].filter(Boolean);
    const userIds = (state.roleUsers || []).map((user) => user.userId).filter(Boolean);
    const outputDir = process.env.VIVO_E2E_OUTPUT_DIR
      || path.join(__dirname, "..", "artifacts", "vivo-bi", "test-results", "manual-run");
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
    const sanitizationScan = sanitizeEvidence(outputDir, tokens);
    if (runFile) {
      fs.unlinkSync(runFile);
    }
    fs.mkdirSync(path.dirname(CLEANUP_FILE), { recursive: true });
    fs.writeFileSync(CLEANUP_FILE, JSON.stringify({
      ok: true,
      ...JSON.parse(output),
      suite_run_id: process.env.VIVO_E2E_RUN_ID || null,
      evidence_sanitized: sanitizationScan.unsafe_matches === 0,
      sanitization_scan: sanitizationScan,
      run_state_removed: !runFile || !fs.existsSync(runFile),
    }, null, 2), "utf8");
  } catch (error) {
    fs.mkdirSync(path.dirname(CLEANUP_FILE), { recursive: true });
    fs.writeFileSync(CLEANUP_FILE, JSON.stringify({ ok: false, error: error.message }), "utf8");
    throw error;
  }
}

module.exports = globalTeardown;