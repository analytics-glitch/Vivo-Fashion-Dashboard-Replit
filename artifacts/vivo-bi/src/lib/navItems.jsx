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
  Warehouse,
  TrendUp,
  ArrowsClockwise,
  Truck,
  Target,
  Warning,
  DownloadSimple,
  ChatCircleDots,
  ShieldCheck,
  ShieldWarning,
  ClockClockwise,
  Table,
  Gauge,
  Ruler,
  Percent,
  UsersThree,
  AddressBook,
  ChartBar,
  BookOpen,
  Eye,
  Factory,
  Coins,
  ImageSquare,
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
  // Overview
  { to: "/overview", label: "Overview", icon: ChartPieSlice, id: "overview", group: "Performance", desc: "KPIs, sales trend and country, channel & brand mix" },
  { to: "/exec-summary", label: "Executive Summary", icon: Briefcase, id: "exec-summary", group: "Performance", desc: "One-screen executive snapshot of the business" },
  { to: "/trend-analysis", label: "Trend Analysis", icon: TrendUp, id: "trend-analysis", group: "Performance", desc: "Trend any KPI over time with per-KPI granularity and AI insight" },

  // Product & inventory ANALYSIS pages — "what's selling, what's it worth,
  // how much stock and what's stuck". Operational action pages live in the
  // "Operations & Production" group below.
  { to: "/product-analysis", label: "Product Development", icon: ChartBar, id: "product-analysis", group: "Products & Range", desc: "Product development hub — Style Cockpit, Catalog & SOR, Range Management, Allocations, Re-Order, Weekly Style Tracker, Gallery and SOR Report tabs" },
  { to: "/inventory", label: "Inventory", icon: Package, id: "inventory", group: "Products & Range", desc: "Stock on hand, velocity & weeks of cover, and stuck & declining stock" },
  { to: "/margin", label: "Margin & Markdown", icon: Percent, id: "margin", group: "Products & Range", desc: "Discount impact on gross margin, COGS and margin %" },
  { to: "/markdown-clearance", label: "Markdown & Clearance", icon: Percent, id: "markdown-clearance", group: "Products & Range", desc: "Markdown candidates and clearance plan" },
  { to: "/size-health", label: "Size Health", icon: Ruler, id: "size-health", group: "Products & Range", desc: "Broken size-curve detection by style" },
  { to: "/fabric", label: "Fabric", icon: ChartBar, id: "fabric", external: true, group: "Products & Range", desc: "Standalone Fabric BI dashboard (opens full-page)" },

  // Retail pages
  { to: "/locations", label: "Locations", icon: MapPin, id: "locations", group: "Retail", desc: "Net sales, orders and active selling points by market" },
  { to: "/footfall", label: "Footfall", icon: Footprints, id: "footfall", group: "Retail", desc: "Footfall, turn-in and conversion by store" },
  { to: "/targets", label: "Targets", icon: Target, id: "targets", group: "Retail", desc: "Track sales against targets" },
  { to: "/quarter-scorecard", label: "Q3 Targets", icon: Target, id: "quarter-scorecard", group: "Retail", desc: "Quarterly target scorecard with per-store goals (leadership)" },

  // Customer pages & marketing
  { to: "/customers", label: "Customers", icon: Users, id: "customers", group: "Customers & Marketing", desc: "New vs repeat customers, spend and churn" },
  { to: "/customer-details", label: "Customer Details", icon: Users, id: "customer-details", group: "Customers & Marketing", desc: "Look up a single customer's purchase history" },
  { to: "/rfm", label: "RFM Segments", icon: UsersThree, id: "rfm", group: "Customers & Marketing", desc: "Recency / frequency / monetary customer segments" },
  { to: "/crm", label: "CRM", icon: AddressBook, id: "crm", group: "Customers & Marketing", desc: "Contacts, tasks, tickets, campaigns, loyalty and Facebook Page management" },
  { to: "/marketing", label: "Marketing", icon: Megaphone, id: "marketing", group: "Customers & Marketing", desc: "Campaign and channel marketing performance" },

  // OPERATIONAL pages — actions that move, return or make stock.
  { to: "/warehouse-returns", label: "Warehouse Returns", icon: Warehouse, id: "warehouse-returns", group: "Operations & Production", desc: "Pull aged / retired store stock back to the warehouse" },
  { to: "/excess-inventory", label: "Excess Inventory", icon: Package, id: "excess-inventory", group: "Operations & Production", desc: "Store stock above the per-brand size allowance — flagged for return" },
  { to: "/ibt", label: "IBT", icon: Truck, id: "ibt", group: "Operations & Production", desc: "Inter-branch transfer recommendations" },
  { to: "/store-flow", label: "Store Flow", icon: Truck, id: "store-flow", group: "Operations & Production", desc: "Per store over a period: units sold vs units transferred in, in-transit stock and current stock" },
  { to: "/replenishments", label: "Replenishments", icon: ArrowsClockwise, id: "replenishments", group: "Operations & Production", desc: "Replenishment suggestions with last-sold dates" },
  { to: "/replenish-by-item", label: "Replenish by Style/SKU", icon: Package, id: "replenish-by-item", group: "Operations & Production", desc: "Find understocked stores for a style/SKU, or a store's proven demand gaps" },
  { to: "/production", label: "Production Tracker", icon: Factory, id: "production", group: "Operations & Production", desc: "Kanban board tracking buying orders through the manufacturing stages" },
  { to: "/production-report", label: "Production Report", icon: Table, id: "production-report", group: "Operations & Production", desc: "Detailed buying-order report: colours, sizes, stage distribution and cross-order roll-ups by order & production type" },

  // Catalogues & others
  { to: "/catalogue", label: "Report Catalogue", icon: BookOpen, id: "catalogue", group: "Tools", desc: "Every report, what page it lives on, and all the calculation & business rules — with an AI finder" },
  { to: "/custom-report", label: "Custom Report", icon: Table, id: "custom-report", group: "Tools", desc: "Build your own breakdown by dimensions & measures, export CSV" },
  { to: "/exports", label: "Exports (Sales, Inventory)", icon: DownloadSimple, id: "exports", group: "Tools", desc: "Download sales and inventory data as CSV" },
  { to: "/hr/", label: "HR & Attendance", icon: UsersThree, id: "hr", external: true, group: "Tools", desc: "Staff attendance, department performance and training (opens the HR dashboard)" },
  { to: "/sops", label: "SOPs", icon: BookOpen, id: "sops", group: "Tools", desc: "Standard Operating Procedures — browse and download department SOP documents" },
  { to: "/data-quality", label: "Data Quality", icon: Warning, id: "data-quality", group: "Tools", desc: "Data completeness and quality checks" },
  { to: "/feedback", label: "Feedback", icon: ChatCircleDots, id: "feedback", group: "Tools", desc: "Send feedback to the BI team" },

  // Finance Reports Suite — leadership + admin (server-gated via /api/finance)
  { to: "/finance", label: "Finance", icon: Coins, id: "finance", group: "Performance", desc: "Finance reports suite — P&L statement, revenue, cost of revenue, opex, payroll, vendor spend and P&L trend & KPIs (KES)" },
];

export const ADMIN_NAV = [
  { to: "/admin/users", label: "Users", icon: ShieldCheck, id: "admin-users", group: "Administration", desc: "Approve users and manage roles" },
  { to: "/admin/activity-logs", label: "Activity Logs", icon: ClockClockwise, id: "admin-activity-logs", group: "Administration", desc: "Audit authenticated API activity" },
  { to: "/admin/feedback", label: "Feedback Inbox", icon: ChatCircleDots, id: "admin-feedback", group: "Administration", desc: "Review submitted feedback" },
  { to: "/admin/store-clusters", label: "Store Clusters", icon: Stack, id: "admin-store-clusters", group: "Administration", desc: "Manage store clusters" },
  { to: "/admin/page-visibility", label: "Page Visibility", icon: Eye, id: "admin-page-visibility", group: "Administration", desc: "Show or hide BI pages for all users" },
  { to: "/admin/group-access", label: "Group Access", icon: UsersThree, id: "admin-group-access", group: "Administration", desc: "Choose which pages each group can see" },
  { to: "/admin/data-health", label: "Data Health", icon: Gauge, id: "admin-data-health", group: "Administration", desc: "Row counts & freshness per table — check prod matches dev after publishing" },
  { to: "/admin/validation-audit", label: "Audit Findings", icon: ShieldWarning, id: "admin-validation-audit", group: "Administration", desc: "Findings raised by the data-validation agent — metric mismatches, anomalies and cross-page inconsistencies" },
  { to: "/admin/thumbnails", label: "Custom Style Photos", icon: ImageSquare, id: "admin-thumbnails", group: "Administration", desc: "Review, edit and remove manually-set product photos; spot broken links" },
];

// Group display order for the Home landing page.
export const HOME_GROUP_ORDER = [
  "Performance",
  "Products & Range",
  "Retail",
  "Customers & Marketing",
  "Operations & Production",
  "Tools",
  "Administration",
];
