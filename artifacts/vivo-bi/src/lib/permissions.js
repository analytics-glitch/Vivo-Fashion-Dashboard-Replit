/**
 * Role → allowed page IDs mapping. The backend remains the source of truth —
 * when /auth/me returns an `allowed_pages` array we honour that; otherwise we
 * fall back to this static map.
 *
 * Roles are business-friendly DEPARTMENT GROUPS (plus Admin), not technical
 * tiers. The nine groups are:
 *   product_development · retail · warehouse · store_manager ·
 *   leadership · customer_service · marketing · hr · admin
 *
 * Page IDs match the `id` field on `tabs` in `components/Sidebar.jsx` /
 * `navItems.jsx`. Admin-only pages use the `admin-` prefix.
 */

// Base analytical set shared by the broadest groups.
const VIEWER = ["overview", "exec-summary", "locations", "footfall", "trend-analysis", "product-analysis", "customers", "customer-details", "catalogue", "gallery", "fabric"];

const PRODUCT_DEVELOPMENT = ["products", "product-analysis", "range-mgmt", "markdown-clearance", "catalogue", "gallery", "inventory", "size-health", "velocity", "data-quality", "fabric", "exports", "production", "production-report"];
const RETAIL = ["overview", "exec-summary", "locations", "footfall", "trend-analysis", "customers", "products", "product-analysis", "gallery", "replenishments", "replenish-by-item", "warehouse-returns", "ibt", "exports"];
const WAREHOUSE = ["inventory", "replenishments", "replenish-by-item", "warehouse-returns", "ibt", "re-order", "allocations", "data-quality", "exports"];
const STORE_MANAGER = ["locations", "footfall", "replenishments", "replenish-by-item", "warehouse-returns", "ibt"];
// "finance" (the Finance Reports Suite) is a leadership + admin surface, so it
// lives in LEADERSHIP (ADMIN spreads LEADERSHIP). The server /api/finance gate
// independently restricts the underlying API to leadership + admin.
const LEADERSHIP = [...new Set([...VIEWER, "exec-summary", "targets", "quarter-scorecard", "products", "product-analysis", "range-mgmt", "markdown-clearance", "margin", "rfm", "velocity", "size-health", "inventory", "warehouse-returns", "marketing", "social", "crm", "data-quality", "custom-report", "exports", "hr", "production", "production-report", "finance"])];
const CUSTOMER_SERVICE = ["customers", "customer-details", "crm", "footfall", "rfm"];
const MARKETING = ["marketing", "social", "crm", "customers", "customer-details", "products", "product-analysis", "footfall", "trend-analysis", "rfm"];
const HR = ["hr"];
const ADMIN = [...new Set([...LEADERSHIP, "feedback", "admin-users", "admin-activity-logs", "admin-feedback", "admin-store-clusters", "admin-data-health", "admin-thumbnails", "admin-validation-audit"])];

export const ROLE_PAGES = {
  product_development: PRODUCT_DEVELOPMENT,
  retail: RETAIL,
  warehouse: WAREHOUSE,
  store_manager: STORE_MANAGER,
  leadership: LEADERSHIP,
  customer_service: CUSTOMER_SERVICE,
  marketing: MARKETING,
  hr: HR,
  admin: ADMIN,
};

/**
 * The 9 selectable department groups, with human-readable labels + short
 * descriptions. Drives the approval / create-user dropdowns on the Users page.
 * `store_manager` is the lowest-access default a self-signup gets while pending.
 */
export const ROLE_OPTIONS = [
  { value: "product_development", label: "Product Development Team", desc: "Products, range, inventory & quality" },
  { value: "retail", label: "Retail Team", desc: "Sales, footfall, customers & replenishment" },
  { value: "warehouse", label: "Warehouse Team", desc: "Stock movement & inventory ops" },
  { value: "store_manager", label: "Store Managers", desc: "Store performance & replenishment" },
  { value: "leadership", label: "Senior Leadership", desc: "Full analytical & executive access" },
  { value: "customer_service", label: "Customer Service", desc: "Customers, CRM & service" },
  { value: "marketing", label: "Marketing", desc: "Marketing, social, CRM & customers" },
  { value: "hr", label: "HR Team", desc: "HR & attendance only" },
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
// Pages restricted to admins regardless of any allowed_pages / role override
// (e.g. work-in-progress surfaces). Admins pass via the role check below; every
// other role is hard-blocked even if a stale group override happened to list it.
// (Currently empty — Finance is leadership + admin, gated via LEADERSHIP above.)
const ADMIN_ONLY_PAGES = new Set([]);

export const canAccessPage = (user, pageId) => {
  if (!user) return false;
  // Admin always sees every page — no per-page list to keep in sync (this is the
  // single source of truth, so a new page can never be accidentally hidden from
  // admins the way the explicit ADMIN list could drift).
  const role = (user.role || DEFAULT_ROLE).toLowerCase();
  if (role === "admin") return true;
  // Admin-only pages can never be reached by a non-admin, even via an
  // allowed_pages override (the backend mirror also refuses to grant them).
  if (ADMIN_ONLY_PAGES.has(pageId)) return false;
  // Globally hidden pages (admin-controlled, applies to everyone). Admin
  // management pages can never be hidden (enforced server-side too).
  const hidden = Array.isArray(user.hidden_pages) ? user.hidden_pages : [];
  if (hidden.includes(pageId)) return false;
  if (Array.isArray(user.allowed_pages)) return user.allowed_pages.includes(pageId);
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
