import axios from "axios";

// Same-origin API. Auth / notes / leaves live under /api; attendance
// analytics live under /api/hr. (The reference used external Cloud Run URLs +
// MongoDB; here both are served by this project's FastAPI backend.)
export const API = "/api";

// Backend client — used for auth, notes, leaves. Authentication rides on the
// httpOnly `session_token` cookie, attached automatically on these same-origin
// requests. The token is deliberately NOT kept in localStorage or sent as a
// Bearer header — a JS-readable copy would defeat the cookie's XSS protection.
export const apiClient = axios.create({
  baseURL: API,
});

// Legacy builds stored the session token under this key; clear stale copies.
export const clearLegacyToken = () => {
  try {
    localStorage.removeItem("vivo_token");
  } catch {
    /* storage blocked — nothing to clear */
  }
};

// Vivo Attendance analytics — this project's SQL endpoints over vivo_attendance.
// Gated by the same staff session cookie (sent automatically; no Bearer header).
export const VIVO_API = "/api/hr";

export const vivoClient = axios.create({ baseURL: VIVO_API });

export const todayISO = () => new Date().toISOString().slice(0, 10);
export const monthStartISO = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};

// The backend already returns Africa/Nairobi-local timestamps, so no offset.
export const TIME_OFFSET_HOURS = 0;

export const adjustedDate = (iso) => {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getTime() + TIME_OFFSET_HOURS * 60 * 60 * 1000);
  } catch {
    return null;
  }
};

export const formatHHMM = (iso) => {
  const d = adjustedDate(iso);
  if (!d) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
};

export const formatDate = (s) => {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
  } catch {
    return s;
  }
};


// ---------- HQ consolidation helpers ----------
const HQ_RE = /^HQ\s+Local\s+Device/i;
export const isHQSource = (name) => !!name && HQ_RE.test(name);
export const HQ_LABEL = "HQ";

/**
 * Collapse all "HQ Local Device N" branch summary rows into a single "HQ" row.
 * Aggregates totals; recomputes attendance_rate; device online if ANY device online.
 * Works with rows from /branches and /branch-rankings (same shape).
 */
export const consolidateHQBranches = (rows) => {
  if (!Array.isArray(rows)) return rows;
  const hq = rows.filter((r) => isHQSource(r.branch_name));
  const others = rows.filter((r) => !isHQSource(r.branch_name));
  if (hq.length === 0) return rows;
  const sum = (k) => hq.reduce((acc, r) => acc + (Number(r[k]) || 0), 0);
  const totalEmployees = sum("total_employees");
  const totalPresent = sum("total_present") || sum("present");
  const present = sum("present");
  const absent = sum("absent") + sum("total_absent");
  const rate = totalEmployees ? (present / totalEmployees) * 100 : 0;
  const anyOnline = hq.some((b) => (b.device_status || "").toLowerCase() === "online");
  const avgHours = (() => {
    const vals = hq.map((b) => Number(b.avg_hours || b.avg_hours_worked || 0)).filter((n) => n > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  })();
  const merged = {
    branch_name: HQ_LABEL,
    branch_country: hq[0].branch_country,
    device_status: anyOnline ? "Online" : "Offline",
    device_type: "multiple",
    total_employees: totalEmployees,
    present,
    missing_checkout: sum("missing_checkout"),
    absent: rows[0]?.total_absent !== undefined ? sum("total_absent") : sum("absent"),
    total_present: totalPresent,
    total_absent: sum("total_absent"),
    late_arrivals: sum("late_arrivals"),
    attendance_rate: rate,
    avg_hours: avgHours,
    status_color:
      !anyOnline ? "offline" : rate >= 80 ? "green" : rate >= 50 ? "orange" : "red",
    _hq_sources: hq.map((b) => b.branch_name),
  };
  return [merged, ...others];
};

/** Expand the chosen branch name into one or more real source names for API queries. */
export const expandBranchName = (name, allBranches = []) => {
  if (name === HQ_LABEL) {
    // Source-device split data exposes "HQ Local Device N" branches that collapse
    // into one HQ row. In THIS project's DB the branch is already pre-collapsed to
    // "HQ", so when no device sources exist we must query the literal "HQ" branch
    // (querying the hardcoded device names would return empty HQ detail pages).
    const sources = (allBranches || []).filter((b) => isHQSource(b.branch_name)).map((b) => b.branch_name);
    return sources.length ? sources : [HQ_LABEL];
  }
  return [name];
};

/** Rewrite a per-employee row so HQ source branches show as "HQ". */
export const rebrandHQRow = (row) => {
  if (row && isHQSource(row.branch_name)) {
    return { ...row, branch_name: HQ_LABEL, _hq_source: row.branch_name };
  }
  return row;
};
