import { useEffect, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, comparePeriod } from "@/lib/api";

/**
 * Single source of truth for headline KPI numbers.
 *
 * Every page that displays Total Sales / Net Sales / Orders / Units /
 * Avg Basket / Return Rate MUST read from this hook (or from `fetchKpis`)
 * so that numbers agree byte-for-byte across every screen.
 *
 * An in-memory cache keyed on (date_from, date_to, country, channel, dataVersion)
 * de-duplicates concurrent / back-to-back requests. The cache is cleared when
 * the user clicks Refresh (which also bumps `dataVersion`).
 */
const kpiCache = new Map(); // key -> { promise?, data?, ts? }
export const KPI_REQUEST_TIMEOUT_MS = 20_000;
// 60 s TTL — long enough to dedupe a burst of concurrent component
// mounts (Overview, AppHeader, KpiTrendChart all consume the same
// payload) but short enough that a fresh deploy / data-pipeline update
// upstream reaches users within ~1 minute even if they don't click
// Refresh. The hard cache-clear (`invalidateKpis()`) on Refresh button
// is still in place; this TTL is an additional self-healing safety net.
const KPI_CACHE_TTL_MS = 60_000;

const cacheKey = (p) =>
  [p.date_from, p.date_to, p.country || "", p.channel || "", p._v || 0].join("|");

const buildKpiParams = (applied) => {
  const country = applied.countries && applied.countries.length
    ? applied.countries.join(",")
    : undefined;
  const channel = applied.channels && applied.channels.length
    ? applied.channels.join(",")
    : undefined;
  return {
    date_from: applied.dateFrom,
    date_to: applied.dateTo,
    country,
    channel,
    _v: applied.dataVersion,
  };
};

export function fetchKpis(params) {
  const key = cacheKey(params);
  if (kpiCache.has(key)) {
    const entry = kpiCache.get(key);
    const fresh = entry.ts && (Date.now() - entry.ts) < KPI_CACHE_TTL_MS;
    if (entry.data && fresh) return Promise.resolve(entry.data);
    if (entry.promise && fresh) return entry.promise;
    // Stale entry — drop it so we re-fetch below.
    if (!fresh) kpiCache.delete(key);
  }
  const promise = api
    .get("/kpis", {
      timeout: KPI_REQUEST_TIMEOUT_MS,
      params: {
        date_from: params.date_from,
        date_to: params.date_to,
        country: params.country,
        channel: params.channel,
      },
    })
    .then((r) => {
      kpiCache.set(key, { data: r.data, ts: Date.now() });
      return r.data;
    })
    .catch((e) => {
      kpiCache.delete(key);
      throw e;
    });
  kpiCache.set(key, { promise, ts: Date.now() });
  return promise;
}

export function invalidateKpis() {
  kpiCache.clear();
}

// F29 — ONE comparison-period definition group-wide. This delegates to the
// shared comparePeriod() in lib/api.js (string-based, local-time, month-end
// clamped) so the headline KPI deltas use the EXACT same "previous period"
// window as every page's breakdown / lever fetches (Overview, Locations,
// Footfall, CEOReport all call comparePeriod for those). The previous inline
// implementation used JS Date.setMonth (which overflows, e.g. May 31 -> May 1)
// and toISOString (UTC -> off-by-one in EAT, UTC+3), producing a different
// prior base and a divergent Δ% between Overview and Locations for the same
// current value. Keep this a thin adapter so call sites stay unchanged.
function computePrevRange(dateFrom, dateTo, mode, customFrom, customTo) {
  const prev = comparePeriod(dateFrom, dateTo, mode, { date_from: customFrom, date_to: customTo });
  return prev ? { date_from: prev.date_from, date_to: prev.date_to } : null;
}

/**
 * Standard hook — returns { kpis, prevKpis, loading, error } for the current
 * filter state. Pass `{ compare: true }` to also fetch the previous period.
 */
export function useKpis({ compare = false } = {}) {
  const { applied } = useFilters();
  const [kpis, setKpis] = useState(null);
  const [prevKpis, setPrevKpis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // A prior filter's delta must never be briefly calculated against the
    // newly-arrived current period. The comparison is optional enrichment, so
    // clear it while the matching request is in flight.
    setPrevKpis(null);
    const params = buildKpiParams(applied);
    // The current period is the page's usable state. Do not keep it behind
    // a slower comparison query: the delta can arrive later without making
    // staff stare at the Overview skeleton.
    fetchKpis(params)
      .then((data) => {
        if (cancelled) return;
        setKpis(data);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.code === "ECONNABORTED"
            ? "Headline figures took too long to load."
            : (err?.response?.data?.detail || err?.message || "Headline figures could not be loaded."));
        }
      })
      .finally(() => !cancelled && setLoading(false));

    const prev = compare
      ? computePrevRange(applied.dateFrom, applied.dateTo, applied.compareMode, applied.compareDateFrom, applied.compareDateTo)
      : null;
    if (!prev) {
      // No comparison selected; the effect-start reset above is sufficient.
    } else {
      fetchKpis({ ...params, ...prev })
        .then((data) => !cancelled && setPrevKpis(data || null))
        .catch((err) => {
          if (cancelled) return;
          setPrevKpis(null);
          // eslint-disable-next-line no-console
          console.warn("[useKpis] compare window failed (suppressed):", err?.message);
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    applied.dateFrom,
    applied.dateTo,
    JSON.stringify(applied.countries),
    JSON.stringify(applied.channels),
    applied.compareMode,
    applied.compareDateFrom,
    applied.compareDateTo,
    applied.dataVersion,
    compare,
    retryToken,
  ]);

  // Auto-retry when the fetch outright FAILED (hard 5xx — distinct from
  // the `stale=true` soft-fallback below). Without this the user has to
  // reload to recover when the upstream circuit-breaker opens. We re-try
  // every 20 s until it succeeds, then stop.
  useEffect(() => {
    if (!error || loading) return undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        invalidateKpis();
        const params = buildKpiParams(applied);
        const calls = [fetchKpis(params)];
        if (compare) {
          const prev = computePrevRange(applied.dateFrom, applied.dateTo, applied.compareMode, applied.compareDateFrom, applied.compareDateTo);
          calls.push(prev ? fetchKpis({ ...params, ...prev }) : Promise.resolve(null));
        }
        const settled = await Promise.allSettled(calls);
        const currR = settled[0];
        const prevR = settled[1];
        if (cancelled) return;
        if (currR?.status === "fulfilled" && currR.value) {
          setKpis(currR.value);
          setError(null);  // banner clears on next render
        }
        if (prevR?.status === "fulfilled") {
          setPrevKpis(prevR.value || null);
        }
      } catch {
        // Still down — silent retry on next tick.
      }
    };
    const id = setInterval(tick, 20_000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, loading, applied.dateFrom, applied.dateTo,
      JSON.stringify(applied.countries), JSON.stringify(applied.channels),
      applied.compareMode, compare]);

  // Auto-recovery poll — when the backend is currently serving stale
  // values (`stale === true` flag on the /kpis payload), we silently
  // re-fetch every 30 s in the background. The fresh fetch invalidates
  // the in-process kpiCache (via `_v`-bumped key) when upstream
  // recovers, so the staleness banner clears within ~30 s of upstream
  // coming back online — no user action / page refresh needed.
  // Stops as soon as `stale === false` so we don't pin upstream when
  // everything's healthy.
  useEffect(() => {
    if (!kpis || !kpis.stale) return undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        // Force a fresh upstream call by bumping the cache key — the
        // shared cache module exposes invalidateKpis() for this exact
        // purpose (clears the entire kpiCache).
        invalidateKpis();
        const params = buildKpiParams(applied);
        const fresh = await fetchKpis(params);
        if (!cancelled && fresh && !fresh.stale) {
          setKpis(fresh);
        }
      } catch {
        // Upstream still down — keep polling silently.
      }
    };
    const id = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kpis?.stale, applied.dateFrom, applied.dateTo,
      JSON.stringify(applied.countries), JSON.stringify(applied.channels)]);

  const retry = () => {
    invalidateKpis();
    setRetryToken((value) => value + 1);
  };

  return { kpis, prevKpis, loading, error, retry };
}

/**
 * CEO-report oriented hook — fetches current + last-month + last-year KPIs
 * in parallel using the shared cache, so numbers match Overview exactly.
 */
export function useKpisLMLY() {
  const { applied } = useFilters();
  const [kpis, setKpis] = useState(null);
  const [kpisLM, setKpisLM] = useState(null);
  const [kpisLY, setKpisLY] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = buildKpiParams(applied);
    const lm = computePrevRange(applied.dateFrom, applied.dateTo, "last_month");
    const ly = computePrevRange(applied.dateFrom, applied.dateTo, "last_year");
    Promise.all([
      fetchKpis(params),
      lm ? fetchKpis({ ...params, ...lm }) : Promise.resolve(null),
      ly ? fetchKpis({ ...params, ...ly }) : Promise.resolve(null),
    ])
      .then(([k, klm, kly]) => {
        if (cancelled) return;
        setKpis(k);
        setKpisLM(klm);
        setKpisLY(kly);
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    applied.dateFrom,
    applied.dateTo,
    JSON.stringify(applied.countries),
    JSON.stringify(applied.channels),
    applied.dataVersion,
  ]);

  return { kpis, kpisLM, kpisLY, loading, error };
}

export { invalidateKpis as invalidateSharedKpis };
