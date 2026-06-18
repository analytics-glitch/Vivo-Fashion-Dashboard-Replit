/**
 * Role → allowed page IDs mapping. Mirrors `auth.py::ROLE_PAGES` so the
 * frontend can hide nav items and gate routes without a round-trip on every
 * navigation. The backend remains the source of truth — when /auth/me
 * returns an `allowed_pages` array we honour that; otherwise we fall back
 * to this static map.
 *
 * Page IDs match the `id` field on `tabs` in `components/Sidebar.jsx`. Admin-
 * only pages use the `admin-` prefix.
 */

const VIEWER = ["overview", "exec-summary", "locations", "footfall", "trend-analysis", "product-analysis", "customers", "customer-details", "feedback", "catalogue", "fabric"];
// Store managers see ONLY: Locations (retail), Exports (inventory only),
// IBT, Feedback. Per-page filters enforced inside the page components.
const STORE_MANAGER = ["locations", "ibt", "exports", "feedback", "replenishments", "replenish-by-item"];
// Warehouse staff: stock-movement operational pages + Inventory export.
// Mirror of `_WAREHOUSE` in /app/backend/auth.py.
const WAREHOUSE = ["inventory", "replenishments", "replenish-by-item", "ibt", "re-order", "allocations", "exports", "feedback"];
const ANALYST = [...VIEWER, "inventory", "re-order", "ibt", "products", "data-quality", "allocations", "replenishments", "replenish-by-item", "marketing", "range-mgmt", "markdown-clearance", "custom-report", "velocity", "size-health", "margin", "rfm", "crm", "social"];
const EXEC = [...ANALYST, "targets", "exports", "exec-summary"];
const ADMIN = [...EXEC, "admin-users", "admin-activity-logs", "admin-feedback", "admin-store-clusters"];

export const ROLE_PAGES = {
  viewer: VIEWER,
  store_manager: STORE_MANAGER,
  warehouse: WAREHOUSE,
  analyst: ANALYST,
  exec: EXEC,
  admin: ADMIN,
};

/**
 * Returns true when the given role / user is allowed to see `pageId`. The
 * `user` arg is the object returned by /auth/me; if it carries an
 * `allowed_pages` array we honour that override.
 */
export const canAccessPage = (user, pageId) => {
  if (!user) return false;
  // Globally hidden pages (admin-controlled, applies to everyone). Admin
  // management pages can never be hidden (enforced server-side too).
  const hidden = Array.isArray(user.hidden_pages) ? user.hidden_pages : [];
  if (hidden.includes(pageId)) return false;
  if (Array.isArray(user.allowed_pages)) return user.allowed_pages.includes(pageId);
  const role = (user.role || "viewer").toLowerCase();
  const pages = ROLE_PAGES[role] || ROLE_PAGES.viewer;
  return pages.includes(pageId);
};

/**
 * The first page a freshly-redirected user can land on. Always picked from
 * their allowed set so we never bounce them straight back to "no access".
 */
export const homePageFor = (user) => {
  if (!user) return "/login";
  // Everyone lands on the Home landing page (route "/"), which renders only the
  // tiles the user can actually access — so this is always a safe redirect target.
  return "/";
};
