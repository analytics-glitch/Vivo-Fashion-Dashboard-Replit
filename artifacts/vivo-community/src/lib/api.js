// Thin client for the public Vivo Community API (/api/community/*).
// The API server is a sibling artifact mounted at /api — root-relative on
// purpose (same pattern as the other Vivo apps in this workspace).
const BASE = "/api/community";
const TOKEN_KEY = "vivo_community_token";

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode */ }
}

async function req(path, { method = "GET", body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const t = getToken();
    if (t) headers["Authorization"] = "Bearer " + t;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && auth) {
    setToken("");
    if (onUnauthorized) onUnauthorized();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof data.detail === "string" ? data.detail : "Something went wrong — please try again";
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  requestCode: (phone) => req("/auth/request-code", { method: "POST", body: { phone } }),
  verify: (phone, code) => req("/auth/verify", { method: "POST", body: { phone, code } }),
  signup: (payload) => req("/auth/signup", { method: "POST", body: payload }),
  me: () => req("/me", { auth: true }),
  logout: () => req("/auth/logout", { method: "POST", auth: true }),
  products: ({ category = "", limit = 24, offset = 0 } = {}) => {
    const q = new URLSearchParams();
    if (category) q.set("category", category);
    q.set("limit", String(limit));
    q.set("offset", String(offset));
    return req("/products?" + q.toString());
  },
};
