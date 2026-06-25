/**
 * useThumbnails — batch-resolves a list of style names to product photo URLs
 * via `POST /api/thumbnails/lookup` (one request per batch, never per-row).
 *
 * Results are memoised in a module-level cache so switching tabs / screens
 * doesn't re-hit the network. Styles with no stored image resolve to `null`
 * and the <ProductThumbnail /> component renders its coloured-initials
 * placeholder. Mirrors the web cockpit's `useThumbnails` hook.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { apiPost } from "@/lib/api";

// Map<style_name, string | null> — null means "confirmed no custom thumbnail".
const CACHE = new Map<string, string | null>();
const IN_FLIGHT = new Map<string, Promise<void>>();

export function useThumbnails(styles: (string | null | undefined)[] = []) {
  const keys = useMemo(() => {
    const out = new Set<string>();
    (styles || []).forEach((s) => {
      if (typeof s === "string" && s.trim()) out.add(s.trim());
    });
    return Array.from(out);
  }, [styles]);

  const [, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const missing = keys.filter((k) => !CACHE.has(k) && !IN_FLIGHT.has(k));
    if (missing.length === 0) return;
    // Chunk at 300 — matches the backend's defensive upper bound.
    for (let i = 0; i < missing.length; i += 300) {
      const chunk = missing.slice(i, i + 300);
      const p = apiPost<Record<string, string>>("/thumbnails/lookup", {
        styles: chunk,
      })
        .then((data) => {
          chunk.forEach((k) => CACHE.set(k, data?.[k] || null));
        })
        .catch(() => {
          // On failure, mark null so we stop retrying this session.
          chunk.forEach((k) => CACHE.set(k, null));
        })
        .finally(() => {
          chunk.forEach((k) => IN_FLIGHT.delete(k));
          if (mounted.current) setTick((t) => t + 1);
        });
      chunk.forEach((k) => IN_FLIGHT.set(k, p));
    }
  }, [keys]);

  const urlFor = (style: string | null | undefined): string | null =>
    style ? CACHE.get(style.trim()) || null : null;

  return { urlFor };
}
