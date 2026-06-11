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
  const res = await fetch(`${API_BASE}${path}${qs(params)}`);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return (await res.json()) as T;
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

export type PresetKey = "30d" | "90d" | "1y";

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "30d", label: "30D" },
  { key: "90d", label: "90D" },
  { key: "1y", label: "1Y" },
];

export const presetRange = (key: PresetKey): DateRange => {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const today = new Date(y, m, d);
  const minus = (days: number) => new Date(y, m, d - days);
  const to = toISO(today);
  if (key === "30d") return { date_from: toISO(minus(29)), date_to: to };
  if (key === "90d") return { date_from: toISO(minus(89)), date_to: to };
  return { date_from: toISO(minus(364)), date_to: to };
};
