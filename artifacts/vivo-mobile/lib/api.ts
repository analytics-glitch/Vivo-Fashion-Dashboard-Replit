/**
 * Data layer for the Vivo BI mobile app.
 *
 * Talks directly to the shared FastAPI backend (api_pg.py) served under
 * `/api/*` — the same live Postgres-backed endpoints the web cockpit uses.
 * Expo bundles run outside the web proxy, so we build absolute URLs from
 * EXPO_PUBLIC_DOMAIN (falls back to a relative base on web).
 */

const DOMAIN = process.env.EXPO_PUBLIC_DOMAIN;
export const API_BASE = DOMAIN ? `https://${DOMAIN}/api` : "/api";

// --- Auth token: set by AuthProvider, attached to every request ---
// Every /api endpoint is gated by the backend session middleware, so requests
// without a valid Bearer token return 401. The AuthProvider keeps this in sync
// with the persisted token and registers an unauthorized handler so an expired
// session bounces the user back to the login screen.
let authToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

type Params = Record<string, string | number | undefined | null>;

const qs = (params?: Params): string => {
  if (!params) return "";
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (!entries.length) return "";
  return (
    "?" +
    entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&")
  );
};

export async function apiGet<T>(path: string, params?: Params): Promise<T> {
  const res = await fetch(`${API_BASE}${path}${qs(params)}`, {
    headers: { ...authHeaders() },
  });
  if (res.status === 401) {
    onUnauthorized?.();
    throw new Error("Unauthorized (401)");
  }
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) onUnauthorized?.();
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { detail?: unknown };
      if (j && typeof j.detail === "string") detail = j.detail;
    } catch {
      // non-JSON error body; keep the generic message
    }
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

// --- Auth ---

export interface AuthUser {
  user_id: string;
  email: string;
  name?: string | null;
  role?: string | null;
  status?: string | null;
  picture?: string | null;
}

export async function loginRequest(
  email: string,
  password: string,
): Promise<{ token: string; user: AuthUser }> {
  return apiPost<{ token: string; user: AuthUser }>("/auth/login", {
    email,
    password,
  });
}

export async function fetchMe(): Promise<AuthUser> {
  return apiGet<AuthUser>("/auth/me");
}

export async function logoutRequest(): Promise<void> {
  try {
    await apiPost("/auth/logout");
  } catch {
    // best-effort; local token is cleared regardless
  }
}

// --- Response types (subset of fields the mobile app uses) ---

export interface Kpis {
  total_sales: number;
  gross_sales: number;
  total_discounts: number;
  total_returns: number;
  net_sales: number;
  total_orders: number;
  total_units: number;
  avg_basket_size: number;
  avg_selling_price: number;
  return_rate: number;
}

export interface CountryRow {
  country: string;
  orders: number;
  units_sold: number;
  total_sales: number;
  gross_sales: number;
  discounts: number;
  returns: number;
  avg_basket_size: number;
}

export interface TopSku {
  style_name: string | null;
  collection: string | null;
  brand: string | null;
  product_type: string | null;
  units_sold: number;
  total_sales: number;
  gross_sales: number;
  avg_price: number;
}

export interface FootfallRow {
  location: string;
  total_footfall: number;
  outside_traffic: number;
  turn_in_rate: number | null;
  orders: number;
  total_sales: number;
  avg_basket: number;
  conversion_rate: number;
}

// --- Date range presets (local time, EAT-safe like the web cockpit) ---

const pad = (n: number) => String(n).padStart(2, "0");
const toISO = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export type DateRange = {
  date_from: string;
  date_to: string;
};

export type PresetKey = "today" | "7d" | "30d" | "90d" | "1y";

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "90d", label: "90D" },
  { key: "1y", label: "1Y" },
];

/** Longer, human labels for the Overview date-range chip menu. */
export const PRESET_MENU_LABEL: Record<PresetKey, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "1y": "Last 12 months",
};

export const presetRange = (key: PresetKey): DateRange => {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const today = new Date(y, m, d);
  const minus = (days: number) => new Date(y, m, d - days);
  const to = toISO(today);
  if (key === "today") return { date_from: to, date_to: to };
  if (key === "7d") return { date_from: toISO(minus(6)), date_to: to };
  if (key === "30d") return { date_from: toISO(minus(29)), date_to: to };
  if (key === "90d") return { date_from: toISO(minus(89)), date_to: to };
  return { date_from: toISO(minus(364)), date_to: to };
};

// --- Comparison period (period-over-period deltas, like the web cockpit) ---

export type CompareKey = "yesterday" | "last_month" | "last_year";

export const COMPARES: { key: CompareKey; chip: string; vs: string }[] = [
  { key: "yesterday", chip: "Previous day", vs: "vs Yesterday" },
  { key: "last_month", chip: "Previous month", vs: "vs Last Month" },
  { key: "last_year", chip: "Previous year", vs: "vs Last Year" },
];

const shiftISO = (iso: string, key: CompareKey): string => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (key === "yesterday") dt.setDate(dt.getDate() - 1);
  else if (key === "last_month") dt.setMonth(dt.getMonth() - 1);
  else dt.setFullYear(dt.getFullYear() - 1);
  return toISO(dt);
};

/** Shift a range back by one day / month / year for the "vs" comparison. */
export const compareRange = (r: DateRange, key: CompareKey): DateRange => ({
  date_from: shiftISO(r.date_from, key),
  date_to: shiftISO(r.date_to, key),
});

/** A stockout alert row — the Overview only needs the array length. */
export interface StockoutAlert {
  style: string | null;
  weeks_of_cover: number | null;
}
