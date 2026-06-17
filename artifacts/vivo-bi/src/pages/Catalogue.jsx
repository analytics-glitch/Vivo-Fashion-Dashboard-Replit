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
  { group: "Customers & Marketing", route: "/rfm", label: "RFM Segments",
    purpose: "Recency / frequency / monetary segments.", reports: ["Champions, Loyal, At-Risk, Hibernating counts & spend"] },
  { group: "Customers & Marketing", route: "/crm", label: "CRM",
    purpose: "Contacts, tasks, tickets, campaigns, loyalty & Facebook Page.", reports: ["Customer 360", "Tasks & tickets (SLA)", "Campaigns", "Loyalty earn / redeem / report", "Member messages", "Facebook Page (Social tab)"] },

  // Products & Range
  { group: "Products & Range", route: "/products", label: "Products",
    purpose: "Style and subcategory performance.", reports: ["Units sold & current stock", "Sell-through", "Top style", "Sales by subcategory", "Units-sold vs stock"] },
  { group: "Products & Range", route: "/margin", label: "Margin & Markdown",
    purpose: "Discount impact on gross margin.", reports: ["Gross margin & margin %", "COGS", "Discount impact"] },
  { group: "Products & Range", route: "/range-mgmt", label: "Range Mgmt",
    purpose: "Range classification & assortment planning.", reports: ["Lifecycle tier (T1–T4) classification", "SOR-since-launch", "Retirement pipeline"] },
  { group: "Products & Range", route: "/markdown-clearance", label: "Markdown & Clearance",
    purpose: "Markdown candidates & clearance plan.", reports: ["Markdown candidates (WoC, sell-through, rec. markdown %, est. revenue)", "Clearance plan grouped IMMEDIATE vs PLANNED"] },

  // Inventory & Replenishment
  { group: "Inventory & Replenishment", route: "/inventory", label: "Inventory",
    purpose: "Stock on hand, availability & cover.", reports: ["Available vs on-hand units", "SKUs & locations", "Stock value & freshness", "Stock-to-sales by subcategory", "Available stock by location"] },
  { group: "Inventory & Replenishment", route: "/velocity", label: "Velocity",
    purpose: "Rate of sale & weeks of cover by style.", reports: ["Weekly velocity (recency-weighted)", "Weeks of cover (WOC)", "Sell-through rate of sale"] },
  { group: "Inventory & Replenishment", route: "/size-health", label: "Size Health",
    purpose: "Broken size-curve detection by style.", reports: ["Stock on hand by size", "Broken size-curve flags", "Broken size %"] },
  { group: "Inventory & Replenishment", route: "/re-order", label: "Re-Order",
    purpose: "Styles to re-order based on demand.", reports: ["Buy plan with priority (High/Med/Low)", "Total units needed"] },
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
    purpose: "Download raw sales & inventory.", reports: ["Sales CSV", "Inventory CSV"] },
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
    used: ["/velocity", "/re-order", "/replenishments", "/ibt"] },
  { id: "woc", title: "Weeks of Cover (WOC)", category: "Inventory",
    formula: "WOC = current_stock ÷ weekly_velocity",
    notes: ["How many weeks current stock lasts at the recent rate of sale.", "Re-order point = weekly_velocity × REORDER_COVER_WEEKS."],
    thresholds: ["LEAD_TIME_WEEKS = 4.0", "SAFETY_WEEKS = 1.0", "REORDER_COVER_WEEKS = 5.0"],
    used: ["/velocity", "/re-order", "/replenishments", "/markdown-clearance"] },
  { id: "sor", title: "Sell-Out Rate (SOR) & SOR-since-launch", category: "Products",
    formula: "SOR % = units_sold × 100 ÷ (units_sold + current_stock)",
    notes: ["Share of total available units that have already sold.", "SOR-since-launch uses lifetime units sold.", "Warehouse locations are excluded from the stock denominator."],
    used: ["/product-analysis", "/range-mgmt", "/velocity"] },
  { id: "sell-through", title: "Sell-through", category: "Products",
    formula: "sell-through % = units_sold ÷ (units_sold + stock_on_hand)",
    notes: ["Banding mirrored across pages: ≥60% Fast, 30–60% Steady, <30% Slow."],
    used: ["/products", "/velocity", "/product-analysis"] },
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

      "Key point: the gates themselves can retire a style. A style that reaches a gate (Step 2c/2d/2e) but does not clear it is classified 'Retire' on performance grounds — this is separate from, and in addition to, the Step 0 hard-retire rules.",

      "What the tiers mean, in plain terms. T4 New / Test = on trial, target 60–100 styles. T3 Recent Performer = proven recently, under ~9 months, target 150–200. T2 Core Performer = a dependable seller 9–24 months old that has been reordered and holds full price, target 200–300. T1 Core Basics = long-running 24+ month staples, target 30–50. A healthy total range is 500–700 live styles.",
    ],
    thresholds: ["Step 0 hard-retire: manual list · Zoya brand · aged-out (≥39w, 0 units/6mo, no sale 270d+) · flagged (≥39w, SOR<40%, has stock)", "Week-8 read: SOR > 60% · FP > 90% · sold ≤ 7d · WOC ≤ 8w", "Week-12 backstop: SOR ≥ 80%", "Tier 2 (39–104w): 3+ reorders · SOR > 60% · FP > 90%", "Tier 1 (≥104w): 5+ reorders · SOR > 60% · FP > 90%", "Targets — T4 60–100 · T3 150–200 · T2 200–300 · T1 30–50 · total 500–700"],
    used: ["/range-mgmt", "/product-analysis"] },
  { id: "reorder-count", title: "No. of Reorders (estimated)", category: "Products",
    formula: "No. of Reorders = ⌊ weeks_since_launch ÷ 12 ⌋",
    notes: ["An estimate of how many reorder cycles a style has likely been through, derived purely from its catalogue age — one cycle per ~12 weeks (a quarter) since launch.", "It is a proxy, not a count of actual purchase orders: a style launched 30 weeks ago shows 2 reorders. New styles (< 12 weeks) show 0.", "Feeds the Range tier rule of thumb that Tier 2 Core Performers are 9+ months old with 3+ reorders."],
    used: ["/product-analysis"] },
  { id: "markdown", title: "Markdown candidate & clearance urgency", category: "Products",
    formula: "Candidate when WOC > 16 AND 8-wk sell-through < 20% AND trend ∈ {DECLINING, DYING} AND age > 84 days",
    notes: ["Urgency tiers drive the recommended discount."],
    thresholds: ["IMMEDIATE: WOC > 26 → recommend 40–50% off", "PLANNED: 16 < WOC ≤ 26 → recommend 30% off"],
    used: ["/markdown-clearance"] },
  { id: "ibt", title: "IBT (inter-branch transfer) rules", category: "Inventory",
    formula: "Move a SKU from a Low Seller to a High Seller of the same style",
    notes: ["Stores tiered A/B/C by 90-day revenue (NTILE 3); transfers only between adjacent tiers (A↔B, B↔C — never A↔C).", "Low Seller: store sale ≤ 20% of the style average.", "High Seller: store sale ≥ 150% of the style average AND has < 2 weeks of cover."],
    used: ["/ibt"] },
  { id: "reorder", title: "Re-order suggestions", category: "Inventory",
    formula: "Re-order point = weekly_velocity × REORDER_COVER_WEEKS; buy to cover lead time + safety",
    notes: ["Priority High/Med/Low set from how far below the re-order point a style sits.", "Uses lead time 4w + safety 1w + cover 5w."],
    used: ["/re-order"] },
  { id: "replenish", title: "Replenishment report", category: "Inventory",
    formula: "Suggested qty fills the floor gap from velocity & current cover",
    notes: ["Surfaces last-sold dates and an owner; same velocity/WOC engine as Velocity."],
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
    notes: ["Inventory freshness: % of locations refreshed within 24h.", "Sales sync lag: amber if > 60 min.", "SKU match rate: % of 30-day sales lines matching the clean product master.", "Missing costs: % of active SKUs with cost ≤ 0 or NULL."],
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
