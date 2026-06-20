/**
 * Role → allowed page IDs mapping. The backend remains the source of truth —
 * when /auth/me returns an `allowed_pages` array we honour that; otherwise we
 * fall back to this static map.
 *
 * Roles are business-friendly DEPARTMENT GROUPS (plus Admin), not technical
 * tiers. The eight groups are:
 *   product_development · retail · warehouse · store_manager ·
 *   leadership · customer_service · marketing · admin
 *
 * Page IDs match the `id` field on `tabs` in `components/Sidebar.jsx` /
 * `navItems.jsx`. Admin-only pages use the `admin-` prefix.
 */

// Base analytical set shared by the broadest groups.
const VIEWER = ["overview", "exec-summary", "locations", "footfall", "trend-analysis", "product-analysis", "customers", "customer-details", "feedback", "catalogue", "fabric"];

const PRODUCT_DEVELOPMENT = ["overview", "products", "product-analysis", "range-mgmt", "markdown-clearance", "catalogue", "inventory", "size-health", "velocity", "data-quality", "fabric", "exports"];
const RETAIL = ["overview", "exec-summary", "locations", "footfall", "trend-analysis", "customers", "customer-details", "products", "product-analysis", "replenishments", "replenish-by-item", "ibt", "feedback", "exports"];
const WAREHOUSE = ["inventory", "replenishments", "replenish-by-item", "ibt", "re-order", "allocations", "data-quality", "exports", "feedback"];
const STORE_MANAGER = ["overview", "locations", "footfall", "customers", "replenishments", "replenish-by-item", "ibt", "feedback", "exports"];
const LEADERSHIP = [...new Set([...VIEWER, "exec-summary", "targets", "products", "product-analysis", "range-mgmt", "markdown-clearance", "margin", "rfm", "velocity", "size-health", "inventory", "marketing", "social", "crm", "data-quality", "exports", "hr"])];
const CUSTOMER_SERVICE = ["overview", "customers", "customer-details", "crm", "feedback", "footfall", "rfm"];
const MARKETING = ["overview", "marketing", "social", "crm", "customers", "customer-details", "products", "product-analysis", "footfall", "trend-analysis", "rfm"];
const ADMIN = [...new Set([...LEADERSHIP, "admin-users", "admin-activity-logs", "admin-feedback", "admin-store-clusters"])];

export const ROLE_PAGES = {
  product_development: PRODUCT_DEVELOPMENT,
  retail: RETAIL,
  warehouse: WAREHOUSE,
  store_manager: STORE_MANAGER,
  leadership: LEADERSHIP,
  customer_service: CUSTOMER_SERVICE,
  marketing: MARKETING,
  admin: ADMIN,
};

/**
 * The 8 selectable department groups, with human-readable labels + short
 * descriptions. Drives the approval / create-user dropdowns on the Users page.
 * `store_manager` is the lowest-access default a self-signup gets while pending.
 */
export const ROLE_OPTIONS = [
  { value: "product_development", label: "Product Development Team", desc: "Products, range, inventory & quality" },
  { value: "retail", label: "Retail Team", desc: "Sales, footfall, customers & replenishment" },
  { value: "warehouse", label: "Warehouse Team", desc: "Stock movement & inventory ops" },
  { value: "store_manager", label: "Store Managers", desc: "Store performance & replenishment" },
  { value: "leadership", label: "Senior Leadership", desc: "Full analytical & executive access" },
  { value: "customer_service", label: "Customer Service", desc: "Customers, CRM & feedback" },
  { value: "marketing", label: "Marketing", desc: "Marketing, social, CRM & customers" },
  { value: "admin", label: "Admin", desc: "Full access + user management" },
];

/** value → human-readable label lookup (falls back to the raw value). */
export const ROLE_LABELS = ROLE_OPTIONS.reduce((acc, o) => {
  acc[o.value] = o.label;
  return acc;
}, {});

export const roleLabel = (role) => ROLE_LABELS[(role || "").toLowerCase()] || role || "—";

// Lowest-access department — the default for fallback / new self-signups.
const DEFAULT_ROLE = "store_manager";

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
  const role = (user.role || DEFAULT_ROLE).toLowerCase();
  const pages = ROLE_PAGES[role] || ROLE_PAGES[DEFAULT_ROLE];
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
