import { useEffect } from "react";
import { api } from "@/lib/api";

/**
 * useHeartbeat — Iter 89w-g
 *
 * Pings POST /api/auth/heartbeat every 2 minutes while at least one
 * tab of the app is open with an authenticated user, stamping this
 * session as active on the "vivo-bi" surface.
 *
 * The surface is a FIXED per-app value (not the route path) so the whole
 * cockpit is treated as one presence surface — the LiveViewers "who's
 * viewing now" row polls /api/auth/active-viewers?page=vivo-bi. Using a
 * stable surface here (and in LiveViewers) means the two heartbeat writers
 * for a session never fight over last_active_page. LiveViewers owns the
 * fast (15s) heartbeat that keeps a viewer inside the server's recency
 * window; this hook is the always-on fallback while the app is mounted.
 *
 * • Fires once immediately on mount so the user shows up without
 *   waiting 2 min after login.
 * • Silently swallows errors — presence is best-effort, never block
 *   the UI on it.
 */
const HEARTBEAT_MS = 2 * 60 * 1000;
const SURFACE = "vivo-bi";

export default function useHeartbeat(enabled) {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const ping = () => {
      if (cancelled) return;
      api.post("/auth/heartbeat", { page: SURFACE }).catch(() => {});
    };
    ping();                                  // immediate
    const id = setInterval(ping, HEARTBEAT_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);
}
