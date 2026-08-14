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
  UsersThree,
  AddressBook,
  ChartBar,
  ChartLine,
  BookOpen,
  Eye,
  Factory,
  Coins,
  ImageSquare,
  CalendarBlank,
  Sparkle,
  RocketLaunch,
  Storefront,
  Kanban,
  Medal,
  ChatCenteredText,
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
  {
    to: "/product-analysis", label: "Product Development", icon: ChartBar, id: "product-analysis",
    anyOfPageIds: ["product-analysis", "production", "range-mgmt", "allocations", "re-order", "style-tracker", "gallery", "exports", "pd-flow"],
    group: "Products & Range", desc: "Product development hub — Style Cockpit, Range Management, Style Launch Planner, PD Flow, Catalog & SOR, SOR Report, Retired Stock, Allocations, Re-Order and Product Catalogue tabs",
    subReports: [
      { pageId: "product-analysis", label: "Style Cockpit & Catalog" },
      { pageId: "range-mgmt",       label: "Range Management" },
      { pageId: "style-tracker",    label: "Style Launch Planner" },
      { pageId: "pd-flow",          label: "PD Flow" },
      { pageId: "production",       label: "Production Overview" },
      { pageId: "allocations",      label: "Allocations" },
      { pageId: "re-order",         label: "Re-Order" },
      { pageId: "gallery",          label: "Product Catalogue" },
      { pageId: "exports",          label: "SOR Report" },
    ],
  },
  {
    to: "/inventory", label: "Inventory Management", icon: Package, id: "inventory",
    anyOfPageIds: ["inventory", "replenishments", "replenish-by-item", "size-health"],
    group: "Products & Range", desc: "Stock on hand, velocity & cover, stuck stock, replenishments and size health",
    subReports: [
      { pageId: "inventory",         label: "Stock, Velocity & Stuck Stock" },
      { pageId: "replenishments",    label: "Replenishments" },
      { pageId: "replenish-by-item", label: "Replenish by Style/SKU" },
      { pageId: "size-health",       label: "Size Health" },
    ],
  },
  {
    to: "/merchandising", label: "Merchandising", icon: Tag, id: "merchandising",
    anyOfPageIds: ["merch-overview", "merch-sales", "merch-inventory", "merch-lifecycle", "merch-deepdive", "merch-store"],
    group: "Products & Range", desc: "Merchandising hub — portfolio health & at-risk actions, sales & pricing, inventory & stock health, lifecycle & launches, plus style deep dive and store detail",
    subReports: [
      { pageId: "merch-overview",    label: "Overview" },
      { pageId: "merch-sales",       label: "Sales & Pricing" },
      { pageId: "merch-inventory",   label: "Inventory & Stock Health" },
      { pageId: "merch-lifecycle",   label: "Lifecycle & Launches" },
      { pageId: "merch-deepdive",    label: "Style Deep Dive" },
      { pageId: "merch-store",       label: "Store Detail" },
    ],
  },
  { to: "/fabric", label: "Fabric", icon: ChartBar, id: "fabric", external: true, group: "Products & Range", desc: "Standalone Fabric BI dashboard (opens full-page)" },

  // Retail pages
  {
    to: "/retail", label: "Retail", icon: MapPin, id: "retail",
    anyOfPageIds: ["locations", "store-profiling", "warehouse-returns", "excess-inventory", "ibt", "store-flow"],
    group: "Retail", desc: "Retail hub — Locations, Store Scorecard, Warehouse Returns, Excess Inventory, IBT and Stock Movement tabs",
    subReports: [
      { pageId: "locations",         label: "Locations" },
      { pageId: "store-profiling",   label: "Store Scorecard" },
      { pageId: "warehouse-returns", label: "Warehouse Returns" },
      { pageId: "excess-inventory",  label: "Excess Inventory" },
      { pageId: "ibt",               label: "IBT" },
      { pageId: "store-flow",        label: "Stock Movement" },
    ],
  },
  { to: "/footfall", label: "Footfall", icon: Footprints, id: "footfall", group: "Retail", desc: "Footfall, turn-in and conversion by store" },
  {
    to: "/targets", label: "Targets", icon: Target, id: "targets",
    anyOfPageIds: ["targets", "quarter-scorecard"],
    group: "Retail", desc: "Track sales against targets, plus the quarterly target scorecard",
    subReports: [
      { pageId: "targets",            label: "Targets" },
      { pageId: "quarter-scorecard",  label: "Quarterly Scorecard" },
    ],
  },

  // Customer pages & marketing
  {
    to: "/customers", label: "Customers", icon: Users, id: "customers",
    anyOfPageIds: ["customers", "customer-details", "crm"],
    group: "Customers & Marketing", desc: "Customers hub — analytics, single-customer lookup and the CRM",
    subReports: [
      { pageId: "customers",        label: "Customer Analytics" },
      { pageId: "customer-details", label: "Customer Details" },
      { pageId: "crm",              label: "CRM" },
    ],
  },
  { to: "/order-explorer", label: "Order Explorer", icon: AddressBook, id: "order-explorer", group: "Customers & Marketing", desc: "Drill between customers and products — start from a customer to see every order and product they bought, or start from a product to see every identified customer who bought it" },
  { to: "/marketing", label: "Marketing", icon: Megaphone, id: "marketing", group: "Customers & Marketing", desc: "Campaign and channel marketing performance" },
  { to: "/community-app", label: "Community App", icon: UsersThree, id: "community-app", group: "Customers & Marketing", desc: "Interactive preview of the Vivo member community app — feed, challenges, leaderboard, shop, rewards and member profile (prototype, mock data)" },

  // OPERATIONAL pages — actions that move, return or make stock.
  {
    to: "/production", label: "Production Pipeline", icon: Factory, id: "production",
    anyOfPageIds: ["production", "production-report", "style-tracker"],
    group: "Operations & Production", desc: "Kanban tracker of buying orders through the manufacturing stages, plus the detailed production report and Style Launch Planner",
    subReports: [
      { pageId: "production",        label: "Overview & Tracker" },
      { pageId: "production-report", label: "Production Report" },
      { pageId: "style-tracker",     label: "Style Launch Planner" },
    ],
  },
  { to: "/quality", label: "Quality", icon: Medal, id: "quality", group: "Operations & Production", desc: "Production quality dashboard — repairs, defect rates, complaints and washing trackers" },
  { to: "/central-tracker", label: "Order Tracker", icon: Table, id: "central-tracker", group: "Operations & Production", desc: "Buying order log from the Central Tracker sheet — Style No, Style Name, Order Qty and Order Date across all year tabs" },

  // Catalogues & others
  { to: "/ask", label: "Ask the Dashboard", icon: Sparkle, id: "ask", group: "Tools", desc: "Ask questions about today's sales, footfall, and performance — answered from live business data by AI" },
  { to: "/catalogue", label: "Report Catalogue", icon: BookOpen, id: "catalogue", group: "Tools", desc: "Every report, what page it lives on, and all the calculation & business rules — with an AI finder" },
  { to: "/custom-report", label: "Custom Report", icon: Table, id: "custom-report", group: "Tools", desc: "Build your own breakdown by dimensions & measures, export CSV" },
  { to: "/exports", label: "Exports (Sales, Inventory)", icon: DownloadSimple, id: "exports", group: "Tools", desc: "Download sales and inventory data as CSV" },
  { to: "/hr/", label: "HR & Attendance", icon: UsersThree, id: "hr", external: true, group: "Tools", desc: "Staff attendance, department performance and training (opens the HR dashboard)" },
  { to: "/sops", label: "SOPs", icon: BookOpen, id: "sops", group: "Tools", desc: "Standard Operating Procedures — browse and download department SOP documents" },
  { to: "/rota", label: "Staff Rota", icon: CalendarBlank, id: "rota", group: "Tools", desc: "Weekly staff scheduling — shift rota, leave management, coverage overview and hour reports" },
  { to: "/l10", label: "L10 Meeting", icon: CalendarBlank, id: "l10", group: "Tools", desc: "EOS Level 10 weekly meeting tracker — agenda, scorecard, rocks, headlines, to-dos, IDS and conclude" },
  { to: "/data-quality", label: "Data Quality", icon: Warning, id: "data-quality", group: "Tools", desc: "Data completeness and quality checks" },
  { to: "/feedback", label: "Feedback", icon: ChatCircleDots, id: "feedback", group: "Tools", desc: "Send feedback to the BI team" },
  { to: "/store-feedback", label: "Store Feedback", icon: ChatCenteredText, id: "store-feedback", group: "Tools", desc: "Log what customers tell store teams — product requests, quality issues, sizing — and track HQ's response" },

  // Growth Model — leadership + admin (server-gated via /api/growth)
  { to: "/growth", label: "Growth Model", icon: RocketLaunch, id: "growth", group: "Performance", desc: "KES 5 Billion north-star trajectory — revenue bridge, compound growth path, store contribution splits and editable levers" },
  // Retail Desk — leadership + admin (server-gated via /api/retail-desk)
  { to: "/retail-desk", label: "Retail Desk", icon: Storefront, id: "retail-desk", group: "Performance", desc: "Per-store growth path tracking, AI coaching notes, consecutive-weeks-behind alerts and issue register" },
  // Day in Review — leadership + admin (server-gated via /api/day-review)
  { to: "/day-review", label: "Day in Review", icon: CalendarBlank, id: "day-review", group: "Performance", desc: "Automatic decomposition of any trading day — headline vs weekday norm, store movers both directions, launches, online, customers, footfall, and what's not working" },
  // AI Desks — Phases 4-10, leadership + admin
  { to: "/product-desk", label: "Product Desk", icon: Tag, id: "product-desk", group: "AI Desks", desc: "Markdown risk board, WOC, velocity decline, dead stock value — daily AI coaching note" },
  { to: "/workforce-desk", label: "Workforce Desk", icon: UsersThree, id: "workforce-desk", group: "AI Desks", desc: "Branch attendance rates, avg hours, revenue per labour hour — daily AI coaching note" },
  { to: "/customer-desk", label: "Customer Desk", icon: Users, id: "customer-desk", group: "AI Desks", desc: "Cohort retention, CLV distribution, reactivation, loyalty health — daily AI coaching note" },
  { to: "/marketing-desk", label: "Marketing Desk", icon: Megaphone, id: "marketing-desk", group: "AI Desks", desc: "Social inbox health, loyalty programme summary, data gap register — daily AI coaching note" },
  { to: "/supply-chain-desk", label: "Supply Chain Desk", icon: Truck, id: "supply-chain-desk", group: "AI Desks", desc: "Fabric PO performance, supplier on-time, overdue orders — daily AI coaching note" },
  { to: "/production-desk", label: "Production Desk", icon: Factory, id: "production-desk", group: "AI Desks", desc: "Buying order pipeline, overdue orders, by-buyer accountability — daily AI coaching note" },
  { to: "/the-chair", label: "The Chair", icon: Target, id: "the-chair", group: "AI Desks", desc: "Weekly strategic synthesis across all AI Desks — open questions register for Stephen" },
  { to: "/partner-brands", label: "Partner Brands", icon: Storefront, id: "partner-brands", group: "Products & Range", desc: "Sales report for Soko, TIE and Ythera partner brands — by location, SKU, price, discount, returns and net sales" },
  // Finance Reports Suite — leadership + admin (server-gated via /api/finance)
  { to: "/finance", label: "Finance", icon: Coins, id: "finance", group: "Performance", desc: "Finance reports suite — P&L statement, revenue, cost of revenue, opex, payroll, vendor spend and P&L trend & KPIs (KES)" },
  { to: "/margin", label: "Margin Analysis", icon: ChartLine, id: "margin", group: "Performance", desc: "Gross margin, discount rate and cost coverage by category, subcategory, brand, store or month (KES)" },
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
  { to: "/admin/store-profiles", label: "Store Profiles", icon: Storefront, id: "admin-store-profiles", group: "Administration", desc: "Edit square footage and optimal stock targets per store" },
];

// Group display order for the Home landing page.
export const HOME_GROUP_ORDER = [
  "Performance",
  "AI Desks",
  "Products & Range",
  "Retail",
  "Customers & Marketing",
  "Operations & Production",
  "Tools",
  "Administration",
];
