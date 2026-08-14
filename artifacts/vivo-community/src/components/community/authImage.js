// Member-gated images (try-on photos & looks) can't be plain <img src> —
// the Bearer token lives in localStorage, so a native image load would
// arrive at the API with no credentials and 401. This hook fetches the
// bytes WITH the Authorization header and hands back a blob URL.
//
// Two caching modes:
// - cache:true (default) — module-level, session-lived. For the member's OWN
//   photos and looks (counts are small, re-fetching every mount would make
//   the lookbook feel sluggish). Delete flows must call dropAuthImage().
// - cache:false — for OTHER members' shared looks. Sharing is revocable, so
//   the image must not outlive the card that proved it was still shared:
//   nothing is kept in the module cache and the blob URL is revoked on
//   unmount. When the owner unshares, the next strip render drops the card
//   and the pixels go with it.
import { useEffect, useState } from "react";
import { getToken } from "@/lib/api";

const cache = new Map(); // api path -> object URL

export function dropAuthImage(path) {
  const u = cache.get(path);
  if (u) {
    cache.delete(path);
    try { URL.revokeObjectURL(u); } catch { /* already gone */ }
  }
}

export function useAuthImage(path, { cache: useCache = true } = {}) {
  const [url, setUrl] = useState(() => (path && useCache && cache.get(path)) || "");
  useEffect(() => {
    if (!path) { setUrl(""); return undefined; }
    if (useCache && cache.has(path)) { setUrl(cache.get(path)); return undefined; }
    let alive = true;
    let local = ""; // uncached blob URL owned by this mount
    fetch("/api/community" + path, {
      headers: { Authorization: "Bearer " + getToken() },
    })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("unavailable"))))
      .then((b) => {
        const u = URL.createObjectURL(b);
        if (useCache) {
          // Another mount may have raced us — keep the first URL.
          if (!cache.has(path)) cache.set(path, u);
          else URL.revokeObjectURL(u);
          if (alive) setUrl(cache.get(path));
        } else if (alive) {
          local = u;
          setUrl(u);
        } else {
          URL.revokeObjectURL(u);
        }
      })
      .catch(() => { if (alive) setUrl(""); });
    return () => {
      alive = false;
      if (local) {
        try { URL.revokeObjectURL(local); } catch { /* already gone */ }
      }
    };
  }, [path, useCache]);
  return url;
}
