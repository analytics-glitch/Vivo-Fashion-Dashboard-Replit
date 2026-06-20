import { useState, useEffect } from "react";

/**
 * Persists filter state across page navigation in localStorage.
 * Uses a single shared store (key "vivo_filters_v1") for date range, country, location
 * so navigating between pages preserves the user's working context.
 *
 * Per-page-only filters (branch, employee query, etc.) should still use plain useState.
 */
const STORE_KEY = "vivo_filters_v1";

const readStore = () => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

const writeStore = (patch) => {
  try {
    const cur = readStore();
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch {
    /* ignore quota errors */
  }
};

/** [from, to, setFrom, setTo] — defaults to provided fallback (typically yesterday()). */
export function usePersistedDateRange(defaultFrom, defaultTo) {
  const stored = readStore();
  const [from, setFromState] = useState(stored.date_from || defaultFrom);
  const [to, setToState] = useState(stored.date_to || defaultTo);

  const setFrom = (v) => { setFromState(v); writeStore({ date_from: v }); };
  const setTo   = (v) => { setToState(v);   writeStore({ date_to: v }); };

  // keep stored copy in sync if a parent sets them indirectly (e.g., via DateRangePicker)
  useEffect(() => { writeStore({ date_from: from, date_to: to }); }, [from, to]);

  return [from, to, setFrom, setTo];
}

/** Single persisted scalar like "country" / "location". */
export function usePersistedFilter(key, defaultValue) {
  const stored = readStore();
  const [val, setValState] = useState(stored[key] != null ? stored[key] : defaultValue);
  const setVal = (v) => { setValState(v); writeStore({ [key]: v }); };
  return [val, setVal];
}
