import { useCallback, useEffect, useState } from "react";

// Per-user "pinned pages" preference. Stored in localStorage (same convention
// the app already uses for other UI prefs like IBT settings) keyed by user id
// so two people sharing a browser don't see each other's pins. Best-effort:
// private-browsing / quota errors are swallowed so the nav never crashes.
const keyFor = (userId) => `vivo_pinned_pages:${userId || "anon"}`;

const read = (userId) => {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const write = (userId, ids) => {
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(ids));
  } catch {
    /* private browsing / quota — ignore */
  }
};

export function usePinnedPages(userId) {
  const [pinned, setPinned] = useState(() => read(userId));

  // Reload when the signed-in user changes (login / account switch).
  useEffect(() => {
    setPinned(read(userId));
  }, [userId]);

  const toggle = useCallback(
    (id) => {
      if (!id) return;
      setPinned((cur) => {
        const next = cur.includes(id)
          ? cur.filter((x) => x !== id)
          : [...cur, id];
        write(userId, next);
        return next;
      });
    },
    [userId],
  );

  const isPinned = useCallback((id) => pinned.includes(id), [pinned]);

  return { pinned, toggle, isPinned };
}
