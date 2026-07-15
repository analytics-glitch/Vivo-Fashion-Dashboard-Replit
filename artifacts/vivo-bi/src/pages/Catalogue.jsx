import React, { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { SectionTitle } from "@/components/common";
import {
  BookOpen, MagnifyingGlass, Sparkle, ArrowRight, Function as FunctionIcon,
  Lightning, Warning, CircleNotch,
} from "@phosphor-icons/react";

/**
 * Report Catalogue — a single, very detailed reference page that documents:
 *   1. WHICH report lives on WHICH page (grouped exactly like the nav).
 *   2. ALL the calculations and business rules behind the numbers (velocity,
 *      WOC, SOR, Pareto tiers, markdown/clearance, IBT, replenishment,
 *      re-order, footfall/conversion, projection, loyalty, data quality).
 *   3. An AI "report finder" box: ask a plain-English question and get pointed
 *      at the exact page + report (server-side LLM via POST /api/catalogue/ask,
 *      with an instant client-side keyword fallback that always works).
 *
 * PAGES is the single source of truth: it both renders the catalogue and is
 * posted to the AI finder so the model can only ever point at a real route.
 */

// ── Page → report catalogue, grouped to mirror the left nav ────────────────
const PAGES = [
  // Performance
  { group: "Performance", route: "/overview", label: "Overview",
    purpose: "High-level performance snapshot of the whole business.",
    reports: ["KPI row: Total & Net Sales, Transactions, Units, ASP", "Sales trend vs last year / prior period", "Sales by country (donut)", "Channel, brand & category mix", "Projected Today end-of-day forecast (when date = today)"] },
  { group: "Performance", route: "/exec-summary", label: "Executive Summary",
    purpose: "One-screen executive scorecard.", reports: ["YTD / MTD scorecards", "Pacing to target", "Regional revenue mix", "Stock mix summary"] },
  { group: "Performance", route: "/locations", label: "Locations",
    purpose: "Market and store performance.", reports: ["Net sales & orders by country", "Top markets & active selling points", "ASP by store/region", "Store quadrant (sales vs sell-through)"] },
  { group: "Performance", route: "/footfall", label: "Footfall",
    purpose: "Door traffic and conversion by store.", reports: ["Total footfall & outside traffic", "Turn-in % and conversion %", "Weekday pattern", "Top stores by conversion", "Sensor-gap day flags"] },
  { group: "Performance", route: "/trend-analysis", label: "Trend Analysis",
    purpose: "Trend any KPI over time.", reports: ["Per-KPI time-series with chosen granularity", "AI-generated trend insight"] },
  { group: "Performance", route: "/product-analysis", label: "Product Analysis",
    purpose: "Canonical style-level sales & stock cockpit.", reports: ["Style cockpit: units, revenue, stock, SOR, WOC, sell-through", "Lifecycle tier per style", "Drill-down: stock & sales by location"] },

  // Customers & Marketing
  { group: "Customers & Marketing", route: "/customers", label: "Customers",
    purpose: "New vs repeat customers, spend and churn.", reports: ["New vs returning trend", "Average spend / AOV", "Purchase frequency", "Churn rate & churned count", "Retention crosswalk"] },
  { group: "Customers & Marketing", route: "/customer-details", label: "Customer Details",
    purpose: "Look up one customer's history.", reports: ["Single-customer purchase history & profile"] },
  { group: "Customers & Marketing", route: "/marketing", label: "Marketing",
    purpose: "Campaign & channel marketing performance.", reports: ["Campaign performance", "Channel marketing breakdown"] },
  { group: "Customers & Marketing", route: "/crm", label: "CRM",
    purpose: "Contacts, tasks, tickets, campaigns, loyalty & Facebook Page.", reports: ["Customer 360", "Tasks & tickets (SLA)", "Campaigns", "Loyalty earn / redeem / report", "Member messages", "Facebook Page (Social tab)"] },

  // Products & Range
  { group: "Products & Range", route: "/product-analysis", label: "Product Analysis",
    purpose: "Canonical style-level cockpit — Style Cockpit + Catalog & SOR tabs.", reports: ["Style-level sales & stock (reconciled)", "Size / colour / POS drill-down", "Catalog & SOR tab: units sold & current stock, sell-through, top style, sales by subcategory, units-sold vs stock"] },
  { group: "Products & Range", route: "/range-mgmt", label: "Range Mgmt",
    purpose: "Range classification & assortment planning.", reports: ["Lifecycle tier (T1–T4) classification", "SOR-since-launch", "Retirement pipeline", "Store × tier stock mix", "Retired styles still holding stock"] },

  // Inventory & Replenishment
  { group: "Inventory & Replenishment", route: "/inventory", label: "Inventory Management",
    purpose: "Stock on hand, velocity & cover, stuck & declining stock, replenishments and store flow (tabbed).", reports: ["Available vs on-hand units", "SKUs & locations", "Stock value & freshness", "Stock-to-sales by subcategory", "Available stock by location", "Velocity & Cover tab: weekly velocity (recency-weighted), weeks of cover (WOC), sell-through rate of sale", "Stuck & Declining tab: declining styles, store overstock ranking"] },
  { group: "Inventory & Replenishment", route: "/size-health", label: "Size Health",
    purpose: "Broken size-curve detection by style.", reports: ["Stock on hand by size", "Broken size-curve flags", "Broken size %"] },
  { group: "Inventory & Replenishment", route: "/re-order", label: "Re-Order",
    purpose: "Styles to re-order, ranked by opportunity value.", reports: ["Opportunity-value ranking (forecast buy engine)", "Forecast buy quantities per style", "Priority buckets (High/Med/Low)"] },
  { group: "Inventory & Replenishment", route: "/ibt", label: "IBT",
    purpose: "Inter-branch transfer recommendations.", reports: ["Store-to-store transfer suggestions", "Warehouse-to-store suggestions", "Completed-transfer audit"] },
  { group: "Inventory & Replenishment", route: "/allocations", label: "Allocations",
    purpose: "Allocate incoming stock across stores.", reports: ["Allocation suggestions by store"] },
  { group: "Inventory & Replenishment", route: "/replenishments", label: "Replenishments",
    purpose: "Floor-gap replenishment suggestions.", reports: ["Suggested qty by barcode/SKU", "Last-sold dates", "Owner assignment"] },

  // Planning & Quality
  { group: "Planning & Quality", route: "/targets", label: "Targets",
    purpose: "Track sales against targets.", reports: ["MTD / YTD targets", "Projected landing", "Variance (KES)"] },
  { group: "Planning & Quality", route: "/data-quality", label: "Data Quality",
    purpose: "Data completeness & quality checks.", reports: ["SKU match rate", "Cost completeness", "Inventory freshness", "Sales sync lag"] },

  // Tools
  { group: "Tools", route: "/custom-report", label: "Custom Report",
    purpose: "Build your own breakdown.", reports: ["Pivot by dimensions & measures", "CSV export"] },
  { group: "Tools", route: "/exports", label: "Exports",
    purpose: "Download raw sales & inventory.", reports: ["Sales CSV (optional Current Stock column — SKU's available units at that line's POS location, live snapshot, not scoped to the date range; '—' = no inventory feed)", "Inventory CSV"] },
];

const GROUP_ORDER = [
  "Performance", "Customers & Marketing", "Products & Range",
  "Inventory & Replenishment", "Planning & Quality", "Tools",
];

// ── Calculations & business rules ──────────────────────────────────────────
const RULES = [
  { id: "velocity", title: "Weekly velocity (recency-weighted)", category: "Inventory",
    formula: "velocity = ((units_28d × 2) + GREATEST(units_56d − units_28d, 0)) ÷ 12",
    notes: ["Double-weights the most recent 4 weeks vs the prior 4 weeks, over a 12-week-equivalent denominator (a light EWMA).", "Shared by Weeks-of-Cover, replenish-by-colour and IBT."],
    used: ["/inventory", "/re-order", "/replenishments", "/ibt"] },
  { id: "woc", title: "Weeks of Cover (WOC)", category: "Inventory",
    formula: "WOC = current_stock ÷ weekly_velocity",
    notes: ["How many weeks current stock lasts at the recent rate of sale.", "Re-order point = weekly_velocity × REORDER_COVER_WEEKS.", "The Inventory stock-cover table's \"Weeks of Cover\" column uses the standard last-4-week velocity basis (current_stock ÷ (units sold in last 28 days ÷ 4)), independent of the table's selected date window."],
    thresholds: ["LEAD_TIME_WEEKS = 4.0", "SAFETY_WEEKS = 1.0", "REORDER_COVER_WEEKS = 5.0"],
    used: ["/inventory", "/re-order", "/replenishments"] },
  { id: "sor", title: "Sell-Out Rate (SOR) & SOR-since-launch", category: "Products",
    formula: "SOR % = units_sold × 100 ÷ (units_sold + current_stock)",
    notes: ["Share of total available units that have already sold.", "SOR-since-launch uses lifetime units sold.", "Warehouse locations are excluded from the stock denominator.", "The measurement window is intentionally different by tool — always read the window shown on each page: Marketing / Product Analysis / Range Mgmt report SOR over the style's lifetime (or since launch); Inventory & Markdown sell-through is measured over a trailing window (e.g. 8 weeks); IBT uses a ≤20%-of-style-average sale rule rather than a raw SOR; the Re-Order list ranks by launch-to-date (since-launch) SOR. Same formula, different period — not a discrepancy.", "\"Sell-through\" is an alias for this same metric — identical formula. SOR is the canonical name (machine field sor_percent); pages that read better in plain English (Products, Velocity) label it \"Sell-through\", while Product Analysis / Range Mgmt label it \"SOR\". See the Sell-through entry below."],
    used: ["/product-analysis", "/range-mgmt", "/inventory"] },
  { id: "sell-through", title: "Sell-through (alias of Sell-Out Rate / SOR)", category: "Products",
    formula: "sell-through % = units_sold ÷ (units_sold + stock_on_hand)  — identical to SOR % above",
    notes: ["Same metric as Sell-Out Rate (SOR) above: two names for one formula. SOR is the canonical name; \"Sell-through\" is the industry-standard alias surfaced on the Products and Velocity pages — there is no second calculation.", "Banding mirrored across pages: ≥60% Fast, 30–60% Steady, <30% Slow."],
    used: ["/product-analysis", "/inventory"] },
  { id: "replen-sor", title: "Replenishment SOR engine (canonical SOR + saleable SOR)", category: "Products",
    formula: "current SOR % = units_sold × 100 ÷ (units_sold + store stock)  — warehouse EXCLUDED, identical to SOR above. Saleable SOR is an ADDITIVE companion (below), never the headline.",
    notes: [
      "The Replenishments page reads SOR over a NAMED trailing demand window — default 4 weeks, switchable to 8 or 12 (the window is shown on the page). SOR is computed per pool (each store on its own stock, Online / Shop Zetu on its own pool) and rolled up unit-weighted across pools — a single SUM of units_sold over a single SUM of stock IS the unit-weighted roll-up. The base formula is unchanged.",
      "Saleable SOR (shown ALONGSIDE the headline, never replacing it) nets broken-curve orphan stock out of the denominator: stock of a (store, style) holding only a single in-stock size while the style's chain-wide curve has 3+ sizes is treated as unsaleable remnant. Saleable SOR ≥ current SOR by construction — it is the ceiling once orphans are cleared, not a different metric.",
      "Velocity classes drive the floor (presentation minimum): A = fast (≥1.0 units/wk, floor 3), B = core (0.25–1.0 u/wk, floor 2), C = slow (<0.25 u/wk, floor 1, pulled to 1 only on a sale). Target = max(class floor, ⌈velocity × cover weeks⌉) with cover = 2 weeks; suggested = max(0, target − shelf qty), then capped to the SKU's shared warehouse pool (top sellers first).",
      "Held-back panel: candidates deliberately NOT moved, each with a reason — Retired/EOL, Markdown/clearance, Overstock (weeks-of-cover > 16), Slow mover (gap between the last sale and the second-to-last sale at that store > 30 days — a single stale sale also counts), Cover OK (weeks of cover on a plain last-4-weeks-sales basis is already ≥ 4), or Broken-curve orphan. A merchant can force-release a held SKU back into the pick list (override persists).",
      "Deploy-from-warehouse-first: a SKU with warehouse units AND a proven-demand store/Online sitting at ZERO shelf stock is ranked at the very top ('deploy now') — the single highest-SOR action. The KPI strip surfaces deployable-warehouse-units, SOR-at-risk units, SOR-drag (overstock) units, and a conservative projected SOR uplift bounded by what is actually pickable (min(suggested, velocity × days-to-next-dispatch)).",
      "Every suggestion is snapshotted to an immutable, append-only fact table keyed by run_id = hash(business_date_EAT | store_scope | ruleset_version), so reloading the page never duplicates a run and a later 'did SOR actually rise after we moved this?' read is attributable.",
      "Live shelf stock (Phase 3): the engine reads near-live inventory — the Odoo / Shopify / Shop Zetu stock feed refreshes every few minutes (was once-nightly), so once a unit sells its store stock drops within minutes and the engine stops recommending a unit that has already gone. Sales sync every minute; inventory now keeps pace.",
      "Fair-share allocation under scarcity (Phase 3): when one warehouse pool can't cover every store's need, units are NOT handed out alphabetically. A two-tier pass runs per SKU — Tier 1 protects each store's presentation floor / next-dispatch gap first (stores only, never Online); if even the floors can't all be met they are fair-shared by Tier-1 weight (largest-remainder) and the gap is flagged as a shortfall to route to buying/IBT. Tier 2 then spreads any leftover across stores AND Online by weight = demand share × margin × sub_factor, capped at remaining need. Online can only ever draw in Tier 2, so it never pre-empts a physical store's floor.",
      "Corridor dispatch cadence (Phase 3): each row is tagged with its delivery corridor and the next scheduled dispatch day (EAT), so a suggestion is only actioned on a day that store actually ships. Defaults: Kenya metro twice a week (Mon + Thu), Kenya upcountry weekly (Mon), Uganda weekly (Tue), Rwanda weekly (Wed), Online daily. On non-dispatch days a row is held to accumulate into the next run.",
      "Minimum-transfer gate (Phase 3): a store line below the minimum transfer size (default 12 units; the optional KES floor is off by default) is held and accumulated rather than triggering an uneconomic small move. EXCEPTION: an A-class style at a genuine stockout ('deploy now') always expedites — it overrides both the cadence hold and the min-transfer gate so a fast seller is never left empty on a technicality.",
      "In-transit quarantine + store-receipt confirmation (Phase 3): stock that has been dispatched but not yet confirmed received (a 'done' line carrying a transfer reference, minus confirmed receipts) is netted OUT of the store-stock denominator (clamped ≥ 0). This stops the engine re-recommending units that are already on a truck. The Transfer Tracking report lets the receiving store confirm each item received; until it does, the picker is credited as 'in-transit' (held), not fully done.",
      "Did-SOR-rise reconciliation + self-calibration (Phase 3): for a past run old enough to have landed, the page compares the SOR it projected against the SOR actually realised for that scope, and stores the ratio as a rolling calibration factor (clamped 0.25–2.0). The engine multiplies its future projected uplift by this factor, so the forecast self-corrects toward what moving stock has really delivered. The canonical SOR formula is never changed — only the projection is calibrated.",
    ],
    thresholds: ["Demand window: 4w (default) / 8w / 12w", "Cover target = 2 weeks", "Class A ≥1.0 u/wk (floor 3) · B 0.25–1.0 (floor 2) · C <0.25 (floor 1)", "Overstock hold: WOC > 16 weeks", "Broken-curve orphan: 1 in-stock size while chain curve ≥ 3 sizes", "Inventory freshness: refreshed every ~5 min (was nightly)", "Fair-share Tier 2 weight = demand share × margin × sub_factor (sub_factor 1.0, Online 0.5)", "Cadence: Kenya metro Mon+Thu · upcountry Mon · Uganda Tue · Rwanda Wed · Online daily", "Min transfer: 12 units (KES gate off) · A-class stockout overrides", "Projection calibration clamp: 0.25–2.0 (rolling)", "Ruleset: phase1-v1"],
    used: ["/replenishments"] },
  { id: "range-tiers", title: "Range lifecycle tiers (T1–T4) — how a style is classified", category: "Products",
    formula: "2026 Range Strategy (SOP). Each active style is classified by running it through the steps below in order: (0) hard-retire overrides, then (1) catalogue age sets the lifecycle stage, then (2) performance gates inside that stage decide whether the style is promoted to its tier or sent to Retire.",
    notes: [
      "The inputs. Four signals drive the decision, all measured over the style's lifetime: catalogue age in weeks (since launch); lifetime Sell-Out Rate (SOR % = units sold ÷ (units sold + current stock), warehouses excluded); full-price realisation (FP % = average selling price ÷ original ticket price, so a low FP means it only sold on discount); weeks of cover (WOC = current stock ÷ recent weekly velocity); and an estimated reorder count (⌊ weeks since launch ÷ 12 ⌋, one cycle per quarter).",

      "Step 0 — Hard-retire (checked first, overrides every tier). A style is forced to 'Retire' regardless of performance if ANY of these is true: it is on the manual retirement list; it is a Zoya-brand style; it is aged-out (≥ 39 weeks old with zero units in the last 6 months and no sale in 270+ days); or it is flagged (≥ 39 weeks old with lifetime SOR < 40% while still holding stock). Merchandising can also pin a style to a specific tier with a manual override. If none of these apply, continue to Step 1.",

      "Step 1 — Age sets the stage. The style's age in weeks places it into one of four lifecycle windows: under 8 weeks; 8–12 weeks; 12–39 weeks (up to ~9 months); 39–104 weeks (~9–24 months); or 104 weeks and over (24+ months). The window decides which gate is applied in Step 2.",

      "The two performance gates used below. Week-8 read (the first real performance check): passes only if lifetime SOR > 60% AND full-price > 90% AND there has been a sale within the last 7 days AND WOC ≤ 8 weeks. Missing SOR or last-sale data fails the read (fail-closed). Week-12 backstop (a second chance for a style that missed the read): passes if lifetime SOR ≥ 80%.",

      "Step 2a — Under 8 weeks → Tier 4 (New / Test). Still inside the trial window before its first read, so it is parked in T4 with no gate applied yet.",
      "Step 2b — 8 to 12 weeks → Tier 3 if it passes the Week-8 read, otherwise it stays Tier 4. (It is not retired yet — it gets until the 12-week mark to prove itself.)",
      "Step 2c — 12 to 39 weeks → Tier 3 if it passes the Week-8 read OR the Week-12 backstop; otherwise → Retire. This is where an underperforming newer style is first cleared out.",
      "Step 2d — 39 to 104 weeks → Tier 2 (Core Performer) only if it has 3+ reorders AND lifetime SOR > 60% AND full-price > 90%; otherwise → Retire.",
      "Step 2e — 104 weeks and over → Tier 1 (Core Basics) only if it has 5+ reorders AND full-price > 90% AND lifetime SOR > 60%; otherwise → Retire. Tier 1 is the permanent core — keep it in stock and reorder whenever WOC drops to 8 weeks or below.",

      "Key point: the gates flag a style for retirement, they do not move it out. A still-trading style that reaches a gate (Step 2c/2d/2e) but does not clear it stays PART of the live Active range — it keeps a real tier (its catalogue-age band: T1 24+ months, T2 9–24 months, T3 8 weeks–9 months, T4 under 8 weeks) and is marked 'flagged for retirement' for the markdown rail. Only the Step 0 hard-retire rules actually move a style into the Retired bucket.",

      "What the tiers mean, in plain terms. T4 New / Test = on trial, target 60–100 styles. T3 Recent Performer = proven recently, under ~9 months, target 150–200. T2 Core Performer = a dependable seller 9–24 months old that has been reordered and holds full price, target 200–300. T1 Core Basics = long-running 24+ month staples, target 30–50. A healthy total range is 500–700 live styles.",
    ],
    thresholds: ["Step 0 hard-retire: manual list · Zoya brand · aged-out (≥39w, 0 units/6mo, no sale 270d+) · flagged (≥39w, SOR<40%, has stock)", "Week-8 read: SOR > 60% · FP > 90% · sold ≤ 7d · WOC ≤ 8w", "Week-12 backstop: SOR ≥ 80%", "Tier 2 (39–104w): 3+ reorders · SOR > 60% · FP > 90%", "Tier 1 (≥104w): 5+ reorders · SOR > 60% · FP > 90%", "Targets — T4 60–100 · T3 150–200 · T2 200–300 · T1 30–50 · total 500–700"],
    used: ["/range-mgmt", "/product-analysis"] },
  { id: "reorder-count", title: "No. of Reorders (estimated)", category: "Products",
    formula: "No. of Reorders = ⌊ weeks_since_launch ÷ 12 ⌋",
    notes: ["An estimate of how many reorder cycles a style has likely been through, derived purely from its catalogue age — one cycle per ~12 weeks (a quarter) since launch.", "It is a proxy, not a count of actual purchase orders: a style launched 30 weeks ago shows 2 reorders. New styles (< 12 weeks) show 0.", "Feeds the Range tier rule of thumb that Tier 2 Core Performers are 9+ months old with 3+ reorders."],
    used: ["/product-analysis"] },
  { id: "ibt", title: "IBT (inter-branch transfer) rules", category: "Inventory",
    formula: "Warehouse-deploy-first, then a global network solve moves each SKU from a Low Seller (donor) to a High Seller (receiver) of the same style — ranked by size-curve completion, then net cash-conversion-days × value — and consolidates every move into one bundle per from → to store pair. Each bundle is then dispatched through a two-sided scan-out → scan-in lifecycle. A move that does not pay forks to a markdown recommendation.",
    notes: [
      "Warehouse-deploy-first waterfall: before any store-to-store move, the central warehouse's on-hand is netted off each destination gap in demand-strength order. IBT therefore only fires on the residual demand the warehouse cannot cover, so it never double-ships against the Replenishment report.",
      "Global solve (not a cross-join): every viable SKU edge is scored once, then units are assigned best-first against a per-destination demand budget = max(0, 2 − to-store available) and a per-donor ledger = from-store available − 1, debiting both as it goes. A destination is never over-filled and a donor is never over-drained.",
      "Ranking: edges that complete a size curve (fill an empty destination size) are assigned first, then edges are ordered by net cash-conversion-days × value. This puts the moves that unlock the most trapped cash and rescue broken size runs at the top.",
      "Hub-through-warehouse routing (Phase 3): a cross-store move routes donor → central warehouse hub → destination BY DEFAULT (so consolidation, QC and customs clear through one node), and its net-CCC is charged the HONEST two-leg transit (donor→hub + hub→dest), not a single hop. The only exception is a named same-mall store pair (IBT_SAME_MALL_PAIRS), which ships direct. Each bundle carries a via_hub flag + a human route string. Ownership of in-transit stock sits with the HUB, so neither store's Sell-Off-Rate moves while a unit is on the road.",
      "Two-sided scan lifecycle (Phase 3) — replaces the old blind 'Mark as done': the dispatching store SCANS OUT a bundle (creating an immutable in_transit consignment in the ibt_transfer ledger with an at-calc snapshot — source on-hand, destination gap, net-CCC, value, curve-complete — frozen at commit time), then the receiving store SCANS IN against that consignment id, entering the units actually received. received_qty < dispatched flags the consignment 'discrepancy'; otherwise 'received'. The operator stamps the real Odoo transfer reference on the consignment, reconciled nightly.",
      "Action-time donor re-validation (Phase 3): the worklist reads near-live tables (refreshed every ~5 min), so between the solve and the scan a POS sale can take the unit. On scan-out the donor's live on-hand minus active soft-reservations is re-checked — if a sale took the stock the scan is BLOCKED (409) and the operator re-runs the suggestions. The SALE WINS. (A lookup failure is treated as unknown and allowed with a flag, never blocking a real move on an infra blip.)",
      "Shared soft-reservation ledger (Phase 3): a scan-out records a donor reservation (transfer_reservations) so the unit is netted out of the next solve's available stock — the coordination point between IBT and Replenishment. A stale soft hold that never converts to a scan-out is released by the nightly self-heal so it cannot suppress donor stock forever.",
      "Realisation feedback → PROJECTION calibration (Phase 3): once consignments land, received ÷ dispatched for the latest run is fed back as a rolling-median calibration factor (clamped 0.25–2.0) that scales the FORWARD-PROJECTED SOR uplift / CCC only. The proof strip shows projected-vs-realised side by side. This tempers the projection with reality — it NEVER alters the canonical Sell-Off-Rate formula.",
      "Freshness indicator (Phase 3): an 'as of HH:MM:SS EAT' pill reads the sales-sync heartbeat; when the sync is stale beyond the SLA the destructive scan buttons soft-lock so an operator cannot act on figures that may be behind the POS.",
      "Net cash-conversion-days (net-CCC) per unit = donor days-to-sell (capped) − destination days-to-sell − corridor in-transit days. Days-to-sell come from a per-(store, SKU) weekly velocity with category shrinkage: a SKU that held stock but did not sell is treated as genuinely slow, while a no-signal cell falls back to its category prior (not mistaken for dead). Transit days come from a corridor lead-time table (domestic ≈ 2d, cross-border ≈ 7d, refreshed nightly from observed completions).",
      "Value per unit = ASP − transport (domestic vs cross-border per-unit) − cross-border duty. A move must clear net-CCC > 0 to ship.",
      "Markdown fork: a donor (store, style) whose slow stock qualifies on stock-balance but does NOT pay to ship — freight/duty wipes the value, or the destination sells it no faster once transit is paid — is sent to the 'IBT markdown fork' list (gated to ≥ 4 on-hand) to be cleared locally rather than redeployed.",
      "Stores tiered A/B/C by revenue; with cluster-aware matching ON (default) transfers stay within the same or adjacent tier. The toggle turns it off for chain-wide matching.",
      "Low Seller (donor): style sells ≤ 20% of the group average at that store while holding at least the size-pack donor threshold. High Seller (receiver): sells ≥ 150% of average while at or below the size-pack receiver threshold — the demand budget then caps each SKU at the receiver's two-week gap.",
      "Size-pack thresholds (store's total units of the style): regular curves (S,M,L,1X,2X) — receiver ≤ 4, donor ≥ 6; Free size (F) — receiver ≤ 2, donor ≥ 4; two combined sizes (S/M, L/1X) — receiver ≤ 1, donor ≥ 3; three combined sizes (XS/S, M/L, 1X/2X) — receiver ≤ 2, donor ≥ 4. Unknown size structures use the regular thresholds.",
      "New styles (launched within the last 21 days — regular rules start at 22 days of age) can only DONATE, and only under the lower new-style donor threshold: regular ≥ 5, Free size ≥ 3, two combined ≥ 2, three combined ≥ 3 (retail carries no per-store received date, so the catalogue launch date is the proxy; styles with no launch date are treated as established).",
      "Dead stock is excluded, and the size-run integrity guard always leaves at least 1 unit of each size on the donor's shelf. Manually-retired styles are skipped.",
      "Minimum-range gate (viable mini-range) — a major reason the worklist looks short: a style is allocated to a receiving store ONLY if that store will hold ≥ 3 distinct SKUs (sizes/colours) of it AFTER the transfer — counting what the receiver already stocks (available ≥ 1) plus what the donor will send (donor available ≥ 2 AND receiver available ≤ 1, topped up to 2). A store that would end up with only 1–2 lonely sizes presents as a broken size run and doesn't merchandise, so that whole donor→receiver pair is suppressed. So a candidate must clear ALL of: proven demand at the receiver, the donor-low/receiver-high sell-rate band, the ≥ 3-SKU range, donor size-run protection, and the minimum-transfer volume — which is why only a curated, worth-the-labour set survives.",
      "Excluded sources/sinks: warehouses (as a donor/receiver — they are the deploy-first pool), the Online / Shop Zetu channel, and third-party (Zoya) brands — store-to-store only.",
      "Minimum-transfer gate: a bundle ships only if it clears domestic ≥ 4 units or cross-border ≥ 24 units, so trucks never run for trivial volume.",
      "Demand window is a single fixed trailing lookback of 28 days (not user-switchable) that does NOT touch the global filter bar.",
      "HONEST scope (real vs aspirational): what is REAL here is a near-live read (tables refreshed every ~5 min), action-time donor re-validation that catches event lag, a nightly self-heal that releases stale reservations + refreshes observed corridor times + records the realisation calibration, and a freshness pill from the sales-sync heartbeat. What is NOT done (not feasible in this environment): a full Odoo event-stream / incremental partition re-solve, and automated write-back into Odoo — the Odoo transfer reference is entered by the operator, not pushed by the agent.",
      "The canonical Sell-Off-Rate formula units_sold × 100 / (units_sold + store_stock) is never altered by this tool (warehouse excluded from the denominator). In-transit units are owned by the hub, so they sit in neither store's SOR while on the road.",
    ],
    thresholds: ["Warehouse on-hand deployed against destination gaps before IBT runs", "Routing: hub-through-warehouse by default (same-mall pairs ship direct)", "Ship gate: net-CCC days > 0 (donor − destination − two-leg corridor transit when via-hub)", "Corridor transit: domestic ≈ 2d · cross-border ≈ 7d (nightly observed refresh)", "Lifecycle: scan-out (in_transit) → scan-in (received | discrepancy); overdue > 7 days", "Donor re-validation at scan-out: live on-hand − active reservations ≥ qty (else 409, sale wins)", "Projection calibration: received ÷ dispatched, rolling median, clamp 0.25–2.0", "Freshness SLA: scan actions soft-lock when the sales sync is stale", "Donor: ≤ 20% of style avg sale · size-pack donor units (6/4/3/4) · keep ≥ 1 unit", "Receiver: ≥ 150% of style avg sale · size-pack receiver units (≤4/≤2/≤1/≤2) · capped at 2-week demand gap", "Markdown fork: non-paying donor (store, style) with ≥ 4 on-hand", "Newness: rules start at 22 days of age · ≤ 21-day styles donate only at the lower new-style threshold (5/3/2/3)", "Cluster: same or adjacent revenue tier (toggle)", "Min transfer: domestic ≥ 4 units · cross-border ≥ 24 units"],
    used: ["/ibt"] },
  { id: "reorder", title: "Re-order list (new-style sell-through)", category: "Inventory",
    formula: "SOR-since-launch % = units_sold_launch × 100 ÷ (units_sold_launch + current_store_stock)",
    notes: ["The Re-Order page lists recently launched styles (default last 90 days), ranked by launch date, with their launch-to-date sell-through (SOR) so buyers can spot fast movers to re-order and slow ones to leave.", "It ranks by sell-through, not by a velocity×cover buy quantity. The velocity×cover re-order point (weekly_velocity × REORDER_COVER_WEEKS, lead 4w + safety 1w) lives on the Velocity page — see Weeks of Cover.", "The page also embeds replenish-by-colour suggestions, an aged-stock report and a markdown flag."],
    used: ["/re-order"] },
  { id: "replenish", title: "Replenishment report", category: "Inventory",
    formula: "suggested replenish = MAX(0, units_sold_30d − store_SOH), then capped to available warehouse stock (top sellers first)",
    notes: ["Floor-gap model over a trailing 30-day window: a store's recent unit sales minus what it still has on hand, limited by the warehouse pool for that SKU; zero-need rows are dropped.", "The weeks-of-cover shown for triage is a simple trailing-window run-rate, not the recency-weighted Velocity formula.", "Surfaces last-sold dates and assigns each line to a picker by equal lines (frozen until 'Save & redistribute')."],
    used: ["/replenishments"] },
  { id: "footfall", title: "Footfall, turn-in & conversion", category: "Footfall",
    formula: "turn-in % = footfall_in × 100 ÷ outside_traffic;  conversion % = orders × 100 ÷ footfall_in",
    notes: ["Clean conversion excludes sensor-gap days (footfall = 0 but sales > 0) so a dead sensor doesn't inflate conversion."],
    used: ["/footfall"] },
  { id: "projection", title: "“Projected Today” / pacing forecast", category: "Performance",
    formula: "MTD pacing = (actual_sales_MTD ÷ days_elapsed) × days_in_month;  stretch target = prior-year actual × 1.15",
    notes: ["Overview's today view blends a non-linear intraday shape curve with a server-side AI estimate; the monthly target uses a 15% stretch over last year."],
    used: ["/overview", "/targets", "/exec-summary"] },
  { id: "loyalty", title: "Loyalty earn, tiers & expiry", category: "Loyalty",
    formula: "points = floor(spend_KES ÷ earn_rate_KES) × tier_multiplier",
    notes: ["Base earn: 1 point per KES 100.", "Tier multipliers: Bronze ×1, Silver ×2, Gold ×3.", "Redemption: 100 points = KES 1.", "Points expire after 12 months of no earn activity (lazy, no cron)."],
    thresholds: ["Silver from KES 50,000 (trailing 12m)", "Gold from KES 100,000", "VIP segment from KES 300,000"],
    used: ["/crm"] },
  { id: "dataquality", title: "Data quality checks", category: "Quality",
    formula: "Composite of freshness, sync lag, SKU match & cost completeness",
    notes: ["Inventory freshness: % of locations refreshed within 24h.", "Sales sync lag: amber if > 60 min.", "SKU match rate: % of 30-day sales lines matching the clean product master.", "Missing costs: % of active SKUs with cost ≤ 0 or NULL.", "The page shows several counts on DIFFERENT scopes — read each label: total physical locations (e.g. 32/32) is the device/feed count, while \"selling locations\" (e.g. 30) excludes warehouses and non-selling sites; a \"SKU lines\" count scoped to the trailing 30-day sales window (e.g. ~22,800) is a subset of the full catalogue SKU-line base (e.g. ~52,860). Same page, different denominators by design."],
    used: ["/data-quality"] },
  { id: "metric-dictionary", title: "Sales metric dictionary (canonical names & aliases)", category: "Performance",
    formula: "One set of figures, two label vocabularies — the Overview/exec pages and the Custom Report use different words for the SAME measures.",
    notes: [
      "Total Sales (Overview) = \"Revenue\" / \"Gross Revenue\" (Custom Report) — gross, VAT-inclusive sales value. The canonical headline figure.",
      "Net Sales (Overview) = \"Net Revenue\" (Custom Report / Margin / Product Analysis) = \"Net Sales\" (Sales Export summary) — the ONE canonical net figure: Net Sales = (Total Sales − Returns − Discounts) excluding VAT (16% Kenya & Online, 18% Uganda/Rwanda). Total Sales stays VAT-inclusive, so the Total → Net gap is mostly the VAT share (~14%) plus discounts. All four surfaces show the identical shilling for the same filters.",
      "Transactions (Overview) = \"Orders\" (Custom Report) — count of sales orders / receipts.",
      "ABV / Average Basket Value (Overview) = \"Average Order Value (AOV)\" (Custom Report) — sales ÷ transactions.",
      "These are alternate labels for one calculation, not different numbers. When two pages disagree on a value it is a period or scope difference (see the per-page period note), never a difference in how the metric is defined.",
    ],
    used: ["/overview", "/exec-summary", "/custom-report"] },
  { id: "category-taxonomy", title: "Category / subcategory taxonomy (why the set varies)", category: "Products",
    formula: "Categories come from the Odoo product master; subcategories are the merchandising sub-groups beneath them.",
    notes: [
      "Different pages show a different category set because each scopes to what is relevant to it — not because the taxonomy itself is inconsistent.",
      "\"Accessories\" is a merchandise category on sales/assortment pages but is excluded from some inventory/markdown views that focus on apparel.",
      "\"Two-Piece Sets\" appears on pages that scope co-ord sets as a single merchandise unit and is absent on pages scoped to the individual garments.",
      "\"Sample & Sale Items\" is a clearance / non-core bucket — present on sell-through and velocity views, excluded from core-range planning.",
      "Treat the category column as page-scoped; reconcile category totals across pages only within the same scope.",
    ],
    used: ["/overview", "/exec-summary", "/product-analysis", "/inventory", "/size-health", "/allocations"] },
  { id: "style-universe", title: "Style-universe size (why “number of styles” differs by page)", category: "Products",
    formula: "There is no single \"number of styles\" — each page counts the universe relevant to its job, so the figures are expected to differ.",
    notes: [
      "Range Mgmt: the full range universe of styles with current stock (the panel TOTAL); the smaller \"active\" figure is only the SOP-gated live tiers (T1–T4) within that total (see the Range tiers entry).",
      "Product Analysis: styles passing the page's current filter (brand / period), so it is a subset of the range total.",
      "Products: styles currently carrying stock.",
      "Velocity: styles with recent sales activity in the velocity window.",
      "Size Health: counted at a finer SKU / size-run grain (or a broader tracked set), so its number is much larger than a with-stock style count. Styles with zero stock at every selling location AND zero warehouse stock are tagged \"No size data\" and excluded from the Broken Curves / Fully Stocked / Avg Curve Health KPIs — a fully sold-out or retired style is not a broken curve.",
      "Inventory: styles / SKU-locations with inventory rows across stock locations.",
      "Within Velocity, the subcategory breakdown can list one style under more than one subcategory (a style mapped to multiple merchandising sub-groups), so the subcategory rows can sum above the distinct-style total — read each subcategory row on its own, not as additive to a style count.",
      "Units-per-style differs between Velocity and Size Health by design: Velocity reports net units (returns-netted, run-rate basis), while Size Health counts on a different grain/window — so the two pages give different per-style unit figures and should not be reconciled directly.",
      "Compare a style count only against another count on the same scope.",
    ],
    used: ["/range-mgmt", "/product-analysis", "/inventory", "/size-health"] },
  { id: "brand-dimension", title: "Brand dimension (why some brands appear on only some pages)", category: "Products",
    formula: "The brand attribute comes from the product master; pages differ in whether they include non-core brands.",
    notes: [
      "Range Mgmt and Product Analysis exclude third-party / Zoya brand rows at the SKU grain (before grouping to style) because those are not part of the owned-label range plan — so \"Third Party Brands\" and \"Zoya\" do not appear there.",
      "Sales, inventory and clearance pages that report everything sold or held DO include those brands.",
      "A brand showing on one page and not another is therefore an intentional scope difference, not a missing dimension.",
    ],
    used: ["/product-analysis", "/inventory", "/range-mgmt"] },
  { id: "segment-vocabulary", title: "Customer segment vocabularies (RFM vs CRM vs Loyalty)", category: "Loyalty",
    formula: "The suite runs several distinct customer-grouping systems; their labels are not interchangeable.",
    notes: [
      "RFM (analytics): behavioural segments from Recency / Frequency / Monetary scores — \"Champions\", \"Loyal\", \"At Risk\" (plural, descriptive).",
      "CRM segments: the clienteling tool's own outreach labels (e.g. CHAMPION, LOYAL) — same intent as RFM but a separate computation and casing.",
      "Customers page: a simple transactional split — New vs Returning (from stored customer_type), not an RFM segment.",
      "Loyalty tiers: spend-based membership tiers — Bronze / Silver / Gold / VIP (see the Loyalty earn entry).",
      "When comparing \"segments\" across pages, confirm you are looking at the same system first: one shopper can be an RFM \"Champion\", a Gold loyalty member and a \"Returning\" customer at the same time.",
    ],
    used: ["/crm", "/customers"] },
  { id: "period-scope", title: "Active period per page (why the global date filter doesn't drive everything)", category: "Performance",
    formula: "The global date filter bar drives the trading pages; several analytical pages intentionally use their OWN fixed window and ignore the bar.",
    notes: [
      "Driven by the global date filter: Overview, Locations, Footfall & Conversion, Customers, Margin, Velocity, Re-Order, Custom Report (its sales measures) and Targets (within the selected period).",
      "Fixed / own window regardless of the bar: Product Analysis uses a trailing 30-day run-rate; Range Mgmt and the \"Since Launch\" measures use a style's whole lifetime; Inventory / Size Health / Warehouse Returns are a current stock snapshot; Markdown & Clearance use their own trailing windows.",
      "So when two pages disagree on a number it is almost always a period difference — confirm each page's active window before treating it as an inconsistency.",
    ],
    used: ["/overview", "/product-analysis", "/inventory", "/range-mgmt", "/custom-report"] },
  { id: "store-naming", title: "Store / location names (why labels vary slightly across pages)", category: "Quality",
    formula: "Location names arrive from several source systems (POS, the footfall sensor feed, Odoo) and are canonicalised at the data-join layer, not relabelled per page.",
    notes: [
      "The same physical store can carry a slightly different label depending on the source feed (e.g. a sensor-feed rename vs the POS name).",
      "Joins across sales / footfall / inventory canonicalise these names so the figures line up; the visible label on a given page is whatever that page's source uses.",
      "Reconcile a store across pages by the physical location, not by an exact-string match on the label.",
    ],
    used: ["/locations", "/footfall", "/inventory"] },
  { id: "data-known-limitations", title: "Known data-layer limitations (source-side, tracked separately)", category: "Quality",
    formula: "A short register of known SOURCE-data issues that are not display bugs — figures are reported faithfully from the source and these are corrected upstream.",
    notes: [
      "Brand attribution: a small number of items can be mis-attributed to the wrong brand in the Odoo product master. This is a source-master correction, not a dashboard calculation — brand splits reflect whatever the master currently holds.",
      "Currency basis: all figures are reported in KES. The retail and Online channels are already KES at source, so no live FX conversion is applied in the dashboard; any future multi-currency source would need its conversion basis disclosed here.",
      "These items are flagged for upstream data correction and do not change how any metric is computed.",
    ],
    used: ["/data-quality"] },
];

const CATEGORY_ORDER = ["Performance", "Products", "Inventory", "Footfall", "Loyalty", "Quality"];

// ── small UI helpers ───────────────────────────────────────────────────────
const RouteChip = ({ to, children }) => (
  <Link to={to} className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
    {children} <ArrowRight size={11} weight="bold" />
  </Link>
);

const tokenize = (s) => (s || "").toLowerCase().match(/[a-z0-9%]+/g) || [];

const Catalogue = () => {
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [ai, setAi] = useState(null);
  const [aiNote, setAiNote] = useState(null);

  // Instant, always-available keyword fallback over pages + rules.
  const localMatches = useMemo(() => {
    const toks = tokenize(question);
    if (!toks.length) return [];
    const score = (text) => {
      const hay = (text || "").toLowerCase();
      return toks.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
    };
    return PAGES
      .map((p) => ({ p, s: score(`${p.label} ${p.purpose} ${p.reports.join(" ")} ${p.group}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 4)
      .map((x) => x.p);
  }, [question]);

  const ask = async () => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setAi(null);
    setAiNote(null);
    try {
      const { data } = await api.post("/catalogue/ask", {
        question: q,
        pages: PAGES.map((p) => ({ route: p.route, label: p.label, purpose: p.purpose, reports: p.reports })),
      });
      if (data && data.available && (data.route || data.answer)) {
        setAi(data);
      } else {
        const reason = data && data.reason;
        setAiNote(
          reason === "ai_not_configured"
            ? "The AI finder isn't configured here — showing keyword matches instead."
            : "Couldn't get an AI answer — showing keyword matches instead."
        );
      }
    } catch (e) {
      setAiNote("Couldn't reach the AI finder — showing keyword matches instead.");
    } finally {
      setAsking(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
  };

  const pagesByGroup = useMemo(() => {
    const m = {};
    PAGES.forEach((p) => { (m[p.group] = m[p.group] || []).push(p); });
    return m;
  }, []);

  const pageLabel = (route) => (PAGES.find((p) => p.route === route) || {}).label || route;

  return (
    <div className="space-y-6" data-testid="catalogue-page">
      <div className="flex items-center gap-2.5">
        <span className="grid place-items-center h-9 w-9 rounded-lg bg-brand/10 text-brand"><BookOpen size={20} /></span>
        <div>
          <div className="eyebrow">Reference</div>
          <h1 className="text-xl font-semibold tracking-tight">Report Catalogue &amp; Rules</h1>
        </div>
      </div>
      <p className="text-sm text-muted max-w-3xl -mt-2">
        Every report, the page it lives on, and the exact calculation behind each number — plus an AI finder.
        Not sure where something lives? Ask in plain English and we'll point you to the right report.
      </p>

      {/* ── AI report finder ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2 mb-2">
          <Sparkle size={16} className="text-brand" weight="fill" />
          <h2 className="text-sm font-semibold">Find the right report</h2>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <MagnifyingGlass size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              data-testid="catalogue-ai-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="e.g. Where do I see which styles to mark down? How is conversion calculated?"
              className="w-full pl-9 pr-3 h-10 rounded-lg border border-border bg-background text-sm outline-none focus:ring-2 focus:ring-brand/40"
            />
          </div>
          <button
            data-testid="catalogue-ai-ask"
            onClick={ask}
            disabled={asking || !question.trim()}
            className="h-10 px-4 rounded-lg bg-brand text-white text-sm font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {asking ? <CircleNotch size={15} className="animate-spin" /> : <Sparkle size={15} weight="fill" />}
            {asking ? "Finding…" : "Ask"}
          </button>
        </div>

        {/* AI answer */}
        {ai && (
          <div className="mt-3 rounded-lg border border-brand/30 bg-brand/5 p-3" data-testid="catalogue-ai-result">
            {ai.answer && <p className="text-sm text-foreground">{ai.answer}</p>}
            {ai.route && (
              <button
                onClick={() => navigate(ai.route)}
                className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:underline"
              >
                Open {ai.label || pageLabel(ai.route)} <ArrowRight size={13} weight="bold" />
              </button>
            )}
            {Array.isArray(ai.related) && ai.related.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>Related:</span>
                {ai.related.map((r) => (
                  <RouteChip key={r.route} to={r.route}>{r.label || pageLabel(r.route)}</RouteChip>
                ))}
              </div>
            )}
          </div>
        )}

        {aiNote && <p className="mt-2 text-xs text-muted">{aiNote}</p>}

        {/* Instant keyword matches */}
        {localMatches.length > 0 && (
          <div className="mt-3">
            <div className="eyebrow mb-1.5">Matching pages</div>
            <div className="flex flex-wrap gap-2">
              {localMatches.map((p) => (
                <button
                  key={p.route}
                  onClick={() => navigate(p.route)}
                  className="text-xs rounded-full border border-border px-3 py-1.5 hover:border-brand hover:text-brand transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Reports by page ──────────────────────────────────────────── */}
      <section>
        <SectionTitle title="Reports by page" subtitle="What each page in the dashboard gives you." />
        <div className="space-y-6 mt-3">
          {GROUP_ORDER.filter((g) => pagesByGroup[g]).map((group) => (
            <div key={group}>
              <div className="eyebrow mb-2">{group}</div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {pagesByGroup[group].map((p) => (
                  <div key={p.route} className="rounded-xl border border-border bg-card p-4 flex flex-col">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold">{p.label}</h3>
                      <RouteChip to={p.route}>Open</RouteChip>
                    </div>
                    <p className="text-xs text-muted mt-1">{p.purpose}</p>
                    <ul className="mt-2.5 space-y-1">
                      {p.reports.map((r, i) => (
                        <li key={i} className="text-xs text-foreground flex gap-1.5">
                          <span className="mt-1.5 h-1 w-1 rounded-full bg-brand/60 shrink-0" />
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Calculations & rules ─────────────────────────────────────── */}
      <section>
        <SectionTitle title="Calculations & business rules" subtitle="The exact formulas and thresholds behind every metric." />
        <div className="space-y-6 mt-3">
          {CATEGORY_ORDER.filter((c) => RULES.some((r) => r.category === c)).map((cat) => (
            <div key={cat}>
              <div className="eyebrow mb-2">{cat}</div>
              <div className="grid gap-3 lg:grid-cols-2">
                {RULES.filter((r) => r.category === cat).map((r) => (
                  <div key={r.id} className="rounded-xl border border-border bg-card p-4">
                    <div className="flex items-center gap-2">
                      <FunctionIcon size={15} className="text-brand shrink-0" />
                      <h3 className="text-sm font-semibold">{r.title}</h3>
                    </div>
                    <pre className="mt-2 text-[11.5px] leading-relaxed whitespace-pre-wrap rounded-lg bg-muted/10 border border-border px-3 py-2 font-mono text-foreground">{r.formula}</pre>
                    {r.notes && (
                      <ul className="mt-2 space-y-1">
                        {r.notes.map((n, i) => (
                          <li key={i} className="text-xs text-muted flex gap-1.5">
                            <span className="mt-1.5 h-1 w-1 rounded-full bg-muted shrink-0" />
                            <span>{n}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.thresholds && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {r.thresholds.map((t, i) => (
                          <span key={i} className="text-[11px] inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-700 px-2 py-0.5">
                            <Lightning size={10} weight="fill" /> {t}
                          </span>
                        ))}
                      </div>
                    )}
                    {r.used && (
                      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-[11px] text-muted">Seen on:</span>
                        {r.used.map((route) => (
                          <RouteChip key={route} to={route}>{pageLabel(route)}</RouteChip>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="rounded-xl border border-border bg-card p-4 flex items-start gap-2.5">
        <Warning size={16} className="text-muted mt-0.5 shrink-0" />
        <p className="text-xs text-muted">
          Formulas reflect the live backend logic. Warehouse locations are excluded from stock-on-hand
          denominators (SOR, sell-through, cover). All money is in Kenyan Shillings (KES).
        </p>
      </div>
    </div>
  );
};

export default Catalogue;
