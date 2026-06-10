import {
  ChartPieSlice,
  Briefcase,
  MapPin,
  Footprints,
  Users,
  Megaphone,
  Tag,
  Stack,
  Package,
  ArrowsClockwise,
  Truck,
  Target,
  Warning,
  DownloadSimple,
  ChatCircleDots,
  ShieldCheck,
  ClockClockwise,
} from "@phosphor-icons/react";

/**
 * Single source of truth for the app's navigation set.
 *
 * `PRIMARY_NAV` drives BOTH the top-nav tabs (components/Sidebar.jsx) and the
 * Home landing page tile grid (pages/Home.jsx). Each item carries a `group`
 * (used only by the Home grid) and a `desc` (shown on the Home tiles); the
 * top-nav ignores those extra fields.
 *
 * `ADMIN_NAV` is shown on Home only for admins; in the top bar these live in
 * the user menu instead.
 *
 * Page IDs must match `lib/permissions.js` / Sidebar tab ids so `canAccessPage`
 * gates both the nav and the Home tiles consistently.
 */
export const PRIMARY_NAV = [
  { to: "/overview", label: "Overview", icon: ChartPieSlice, id: "overview", group: "Performance", desc: "KPIs, sales trend and country, channel & brand mix" },
  { to: "/exec-summary", label: "Executive Summary", icon: Briefcase, id: "exec-summary", group: "Performance", desc: "One-screen executive snapshot of the business" },
  { to: "/locations", label: "Locations", icon: MapPin, id: "locations", group: "Performance", desc: "Net sales, orders and active selling points by market" },
  { to: "/footfall", label: "Footfall", icon: Footprints, id: "footfall", group: "Performance", desc: "Footfall, turn-in and conversion by store" },
  { to: "/customers", label: "Customers", icon: Users, id: "customers", group: "Customers & Marketing", desc: "New vs repeat customers, spend and churn" },
  { to: "/customer-details", label: "Customer Details", icon: Users, id: "customer-details", group: "Customers & Marketing", desc: "Look up a single customer's purchase history" },
  { to: "/marketing", label: "Marketing", icon: Megaphone, id: "marketing", group: "Customers & Marketing", desc: "Campaign and channel marketing performance" },
  { to: "/products", label: "Products", icon: Tag, id: "products", group: "Products & Range", desc: "Style and subcategory performance" },
  { to: "/range-mgmt", label: "Range Mgmt", icon: Stack, id: "range-mgmt", group: "Products & Range", desc: "Range classification and assortment planning" },
  { to: "/inventory", label: "Inventory", icon: Package, id: "inventory", group: "Inventory & Replenishment", desc: "Stock on hand, availability and cover by location" },
  { to: "/re-order", label: "Re-Order", icon: ArrowsClockwise, id: "re-order", group: "Inventory & Replenishment", desc: "Styles to re-order based on demand" },
  { to: "/ibt", label: "IBT", icon: Truck, id: "ibt", group: "Inventory & Replenishment", desc: "Inter-branch transfer recommendations" },
  { to: "/allocations", label: "Allocations", icon: Stack, id: "allocations", group: "Inventory & Replenishment", desc: "Allocate incoming stock across stores" },
  { to: "/replenishments", label: "Replenishments", icon: ArrowsClockwise, id: "replenishments", group: "Inventory & Replenishment", desc: "Replenishment suggestions with last-sold dates" },
  { to: "/targets", label: "Targets", icon: Target, id: "targets", group: "Planning & Quality", desc: "Track sales against targets" },
  { to: "/data-quality", label: "Data Quality", icon: Warning, id: "data-quality", group: "Planning & Quality", desc: "Data completeness and quality checks" },
  { to: "/exports", label: "Exports (Sales, Inventory)", icon: DownloadSimple, id: "exports", group: "Tools", desc: "Download sales and inventory data as CSV" },
  { to: "/feedback", label: "Feedback", icon: ChatCircleDots, id: "feedback", group: "Tools", desc: "Send feedback to the BI team" },
];

export const ADMIN_NAV = [
  { to: "/admin/users", label: "Users", icon: ShieldCheck, id: "admin-users", group: "Administration", desc: "Approve users and manage roles" },
  { to: "/admin/activity-logs", label: "Activity Logs", icon: ClockClockwise, id: "admin-activity-logs", group: "Administration", desc: "Audit authenticated API activity" },
  { to: "/admin/feedback", label: "Feedback Inbox", icon: ChatCircleDots, id: "admin-feedback", group: "Administration", desc: "Review submitted feedback" },
  { to: "/admin/store-clusters", label: "Store Clusters", icon: Stack, id: "admin-store-clusters", group: "Administration", desc: "Manage store clusters" },
];

// Group display order for the Home landing page.
export const HOME_GROUP_ORDER = [
  "Performance",
  "Customers & Marketing",
  "Products & Range",
  "Inventory & Replenishment",
  "Planning & Quality",
  "Tools",
  "Administration",
];
