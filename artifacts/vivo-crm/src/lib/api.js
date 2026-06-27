import axios from "axios";

// This CRM is served behind the shared Replit proxy at /crm/, while the
// FastAPI backend (api_pg.py) is served at /api. The proxy routes /api/*
// to the API server regardless of this app's base path, so a relative
// baseURL of "/api" always reaches the backend.
export const API_BASE = "/api";

export const api = axios.create({ baseURL: API_BASE });

// --- Session token (custom Postgres auth) ----------------------------------
// The backend issues an opaque session token on login (also set as an httpOnly
// cookie). We persist it in localStorage and attach it as a Bearer header on
// every request so the app works even where third-party cookies are blocked.
const TOKEN_KEY = "vivo_token";

export const getStoredToken = () => {
  try {
    return typeof window !== "undefined"
      ? window.localStorage.getItem(TOKEN_KEY)
      : null;
  } catch {
    return null;
  }
};

export const setStoredToken = (t) => {
  try {
    if (typeof window === "undefined") return;
    if (t) window.localStorage.setItem(TOKEN_KEY, t);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked — Bearer falls back to the cookie */
  }
};

api.interceptors.request.use((config) => {
  const t = getStoredToken();
  if (t) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${t}`;
  }
  return config;
});

// On an expired/invalid session the backend returns 401. Clear the stale token
// and bounce to THIS app's login (base-path aware) so the user gets a clean
// re-auth instead of a cascade of failing requests. Skip the auth endpoints
// themselves so a bad login attempt shows its inline error rather than redirecting.
api.interceptors.response.use(
  (resp) => resp,
  (error) => {
    const status = error?.response?.status;
    const url = error?.config?.url || "";
    const isAuthCall = /\/auth\/(login|me|logout|google)/.test(url);
    if (status === 401 && !isAuthCall && typeof window !== "undefined") {
      setStoredToken(null);
      const loginPath = import.meta.env.BASE_URL + "login";
      if (!window.location.pathname.endsWith("/login")) {
        window.location.href = loginPath;
      }
    }
    return Promise.reject(error);
  }
);

// Convenience date helpers — all timezone-aware for Africa/Nairobi (UTC+3).
function nairobiNow() {
  // Returns a Date object whose UTC components reflect Nairobi local time.
  const offsetMs = 3 * 60 * 60 * 1000;
  return new Date(Date.now() + offsetMs);
}

export function today() {
  return nairobiNow().toISOString().slice(0, 10);
}
export function daysAgo(n) {
  const d = nairobiNow();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
export function mtdStart() {
  const d = nairobiNow();
  d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}
export function ytdStart() {
  const d = nairobiNow();
  return `${d.getUTCFullYear()}-01-01`;
}
export function prevMonthRange() {
  const d = nairobiNow();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();  // 0-indexed; previous month = m-1
  const firstPrev = new Date(Date.UTC(y, m - 1, 1));
  const lastPrev = new Date(Date.UTC(y, m, 0));  // day 0 = last day prev
  return { from: firstPrev.toISOString().slice(0, 10), to: lastPrev.toISOString().slice(0, 10) };
}

export function formatKES(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  // F50 — render the ISO code "KES" (not the en-KE locale's "Ksh" symbol) so
  // this CRM matches the currency label used everywhere else in the suite
  // (vivo-bi's fmtKES prefixes a literal "KES "). currencyDisplay:"code" keeps
  // Intl's thousands grouping while forcing "KES 31,480,256" instead of
  // "Ksh 31,480,256". Display-only; the underlying figure is unchanged.
  return new Intl.NumberFormat("en-KE", {
    style: "currency",
    currency: "KES",
    currencyDisplay: "code",
    maximumFractionDigits: 0,
  }).format(Number(n));
}

export function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return new Intl.NumberFormat("en-KE").format(Number(n));
}

export function formatDate(s) {
  if (!s) return "—";
  try {
    const d = new Date(s);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return s;
  }
}

export function timeAgo(s) {
  if (!s) return "";
  const ms = Date.now() - new Date(s).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export function normalisePhoneKenya(phone) {
  if (!phone) return phone;
  let p = String(phone).replace(/\s+/g, "");
  if (p.startsWith("+254")) return p;
  if (p.startsWith("254")) return "+" + p;
  if (p.startsWith("0")) return "+254" + p.slice(1);
  return p;
}
