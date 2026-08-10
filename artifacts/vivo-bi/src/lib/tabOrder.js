import { useCallback, useEffect, useRef, useState } from "react";
import { PRIMARY_NAV } from "@/lib/navItems";

// Per-user tab order preference. Stored in localStorage keyed by user id,
// matching the same convention as pinnedPages.js. Best-effort: private
// browsing / quota errors are swallowed so the nav never crashes.

const keyFor = (userId) => `vivo_tab_order:${userId || "anon"}`;

export const readTabOrder = (userId) => {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : null;
  } catch {
    return null;
  }
};

export const writeTabOrder = (userId, orderedIds) => {
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(orderedIds));
  } catch {
    /* private browsing / quota — ignore */
  }
};

export const resetTabOrder = (userId) => {
  try {
    window.localStorage.removeItem(keyFor(userId));
  } catch {
    /* ignore */
  }
};

/**
 * Sorts `visibleTabs` by the saved id sequence.
 * Tabs absent from the saved list append at the end in PRIMARY_NAV order,
 * so newly-granted tabs automatically appear at the back.
 */
const sortByOrder = (visibleTabs, savedOrder) => {
  if (!savedOrder || savedOrder.length === 0) return visibleTabs;
  const orderMap = new Map(savedOrder.map((id, i) => [id, i]));
  const defaultLen = savedOrder.length;
  return [...visibleTabs].sort((a, b) => {
    const ai = orderMap.has(a.id) ? orderMap.get(a.id) : defaultLen + PRIMARY_NAV.findIndex((t) => t.id === a.id);
    const bi = orderMap.has(b.id) ? orderMap.get(b.id) : defaultLen + PRIMARY_NAV.findIndex((t) => t.id === b.id);
    return ai - bi;
  });
};

/**
 * Hook that returns [orderedVisible, setOrder, reset, hasCustomOrder].
 *
 * - `orderedVisible`: visibleTabs sorted by the user's saved order.
 * - `setOrder(ids)`: persist a new order (array of tab ids).
 * - `reset()`: clear the saved order and revert to PRIMARY_NAV default.
 * - `hasCustomOrder`: true when the user has a non-default saved order.
 */
export function useTabOrder(user, visibleTabs) {
  const userId = user?.user_id;
  const [savedOrder, setSavedOrder] = useState(() => readTabOrder(userId));

  // Reload when signed-in user changes.
  useEffect(() => {
    setSavedOrder(readTabOrder(userId));
  }, [userId]);

  const setOrder = useCallback(
    (ids) => {
      writeTabOrder(userId, ids);
      setSavedOrder(ids);
    },
    [userId],
  );

  const reset = useCallback(() => {
    resetTabOrder(userId);
    setSavedOrder(null);
  }, [userId]);

  const orderedVisible = sortByOrder(visibleTabs, savedOrder);

  // hasCustomOrder: true when saved order differs from the default visible order
  const hasCustomOrder = (() => {
    if (!savedOrder || savedOrder.length === 0) return false;
    const defaultIds = visibleTabs.map((t) => t.id);
    const orderedIds = orderedVisible.map((t) => t.id);
    return orderedIds.some((id, i) => id !== defaultIds[i]);
  })();

  return [orderedVisible, setOrder, reset, hasCustomOrder];
}
