import crypto from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pg from "pg";
import { Server as SocketServer } from "socket.io";
import { RESOURCE_SEEDS } from "./resource-seeds.js";
import {
  FEEDBACK_IMAGE_MAX_FILES,
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_IMAGE_UPLOAD_RATE_LIMIT,
  FEEDBACK_IMAGE_UPLOAD_RATE_WINDOW_MS,
  FEEDBACK_IMAGE_UPLOAD_TTL_SECONDS,
  FEEDBACK_CUSTOMER_SEARCH_LIMIT,
  FEEDBACK_CUSTOMER_SEARCH_MIN_LENGTH,
  FEEDBACK_CUSTOMER_SEARCH_RATE_LIMIT,
  FEEDBACK_CUSTOMER_SEARCH_RATE_WINDOW_MS,
  FEEDBACK_QUARTER_START_SQL,
  detectFeedbackImageContentType,
  feedbackImageExtension,
  feedbackCustomerOrigin,
  feedbackImageTokens,
  normalizeFeedbackCustomerId,
  normalizeFeedbackCustomerName,
  validateFeedbackImageMeta,
  validateFeedbackImageUpload,
  type FeedbackImageContentType,
} from "./feedback-policy.js";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});

const app = express();
const httpServer = http.createServer(app);
const io = new SocketServer(httpServer, {
  path: "/api/workspace/socket.io",
  cors: { origin: true, credentials: true },
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "20mb" }));
app.use(cookieParser());

const router = express.Router();
const schema = "product_workspace";
const sessionCookie = "vivo_workspace_session";
const sessionDays = 7;
let schemaReady = false;
let serviceReady = false;
let lastDbProbeAt = 0;
let lastDbProbeResult = false;
const PLM_STAGES = [
  "Concept",
  "Initial Design Tech Pack",
  "Pattern",
  "Initial Sample",
  "Fit Session",
  "Approved",
  "Grading",
  "Costing Sample",
  "In Development",
  "Production",
  "Launched",
] as const;
const PLM_SIDE_STAGES = ["On Hold", "Dropped"] as const;
const PLM_ALL_STAGES = [...PLM_STAGES, ...PLM_SIDE_STAGES] as const;
const PLM_LAUNCH_ROUTES = ["DTC", "Wholesale", "Marketplace", "Omnichannel"] as const;
const PLM_STYLE_CLASSIFICATIONS = ["Core", "Fashion", "Seasonal", "Test"] as const;
const PLM_RANGE_TIERS = ["Tier 1", "Tier 2", "Tier 3", "Tier 4"] as const;
const PLM_SEASONS = ["Q3 2026", "Q4 2026"] as const;
const RANGE_PLAN_SEASON_SEEDS = [
  { seasonName: "Q3 2026", revenueTarget: 360000000, factoryCapacityUnits: 96000, cadence: "quarterly" as const },
  { seasonName: "Q4 2026", revenueTarget: 362500000, factoryCapacityUnits: 96000, cadence: "quarterly" as const },
  { seasonName: "September 2026", revenueTarget: 30000000, factoryCapacityUnits: 32000, cadence: "monthly" as const, otbMonth: "2026-09-01" },
  { seasonName: "October 2026", revenueTarget: 30000000, factoryCapacityUnits: 32000, cadence: "monthly" as const, otbMonth: "2026-10-01" },
  { seasonName: "November 2026", revenueTarget: 30000000, factoryCapacityUnits: 32000, cadence: "monthly" as const, otbMonth: "2026-11-01" },
  { seasonName: "December 2026", revenueTarget: 30000000, factoryCapacityUnits: 32000, cadence: "monthly" as const, otbMonth: "2026-12-01" },
] as const;
const WORKSPACE_BRANDS = ["Vivo", "Safari by Vivo", "Zoya"] as const;
const ALLOWED_BRANDS_SQL = WORKSPACE_BRANDS.map((brand) => `'${brand}'`).join(",");
const allowedBrand = (alias: string) => `${alias}.brand IN (${ALLOWED_BRANDS_SQL})`;
const ASSORTMENT_TIER_FILTERS = [
  "Tier 1 · NOOS",
  "Tier 2 · Core",
  "Tier 3 · Recent",
  "Tier 4 · New",
  "Retired",
] as const;
const ASSORTMENT_WAREHOUSE_LOCATIONS = [
  "Warehouse Finished Goods", "Warehouse Receiving", "In Transit",
  "Holding Warehouse Finished Goods", "Finished Goods Production", "Production",
  "Buying & Merchandise", "Raw Materials", "Fabric Trimming", "Dead Stock Fabric",
  "Cutting - Spreading", "Washing", "Wandia", "Galleria Holding", "Studio Location",
  "Product Development", "Repairs", "Sampling Fabric", "Sampling", "Sale Stock",
  "Shopping Bags", "Recall Location", "Fabric Production", "Defects Location",
  "Staff purchases", "Sew/Stock/A", "Sew/Stock/B", "Sew/Stock/C", "Sew/Stock/D",
  "Sew/Stock/E",
] as const;
const ASSORTMENT_PIPELINE_LOCATIONS = [
  "Fabric Trimming", "Finished Goods Production", "Sew/Stock/A", "Sew/Stock/B",
  "Sew/Stock/C", "Sew/Stock/D", "Sew/Stock/E",
] as const;
const PD_STYLE_TEAM_DDL = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='style_designer')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='design_owner') THEN
    ALTER TABLE public.pd_styles RENAME COLUMN style_designer TO design_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='style_pattern_maker')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='pattern_owner') THEN
    ALTER TABLE public.pd_styles RENAME COLUMN style_pattern_maker TO pattern_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='pattern_maker')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='pattern_owner') THEN
    ALTER TABLE public.pd_styles RENAME COLUMN pattern_maker TO pattern_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='style_sample_maker')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='sample_owner') THEN
    ALTER TABLE public.pd_styles RENAME COLUMN style_sample_maker TO sample_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='style_buyer')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='buying_owner') THEN
    ALTER TABLE public.pd_styles RENAME COLUMN style_buyer TO buying_owner;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='cad')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pd_styles' AND column_name='cad_owner') THEN
    ALTER TABLE public.pd_styles RENAME COLUMN cad TO cad_owner;
  END IF;
END $$;
ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS design_owner TEXT;
ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS pattern_owner TEXT;
ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS cad_owner TEXT;
ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS sample_owner TEXT;
ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS buying_owner TEXT;
`;
type PlmStage = (typeof PLM_ALL_STAGES)[number];
const PD_STAGE_BY_PLM_STAGE: Partial<Record<PlmStage, string>> = {
  "Concept": "concept",
  "Initial Design Tech Pack": "review",
  "Pattern": "pattern",
  "Initial Sample": "sampling",
  "Fit Session": "fit",
  "Approved": "adopted",
  "Grading": "grading",
  "Costing Sample": "set_sample",
  "In Development": "development",
  "Production": "buying",
  "Launched": "launched",
  "On Hold": "on_hold",
  "Dropped": "dropped",
};

type UserRow = {
  id: number;
  name: string;
  email: string;
  role: string;
  initials: string;
  color: string;
};

type AuthRequest = Request & { workspaceUser?: UserRow };

const users = [
  { name: "Vivo Workspace", email: "workspace@vivo.local", role: "Admin", initials: "VW", color: "#C9A96E" },
];

const fabrics = [
  ["Linen Blend 145", "Linen / Viscose", "Nairobi", 145, "Natural, breathable handfeel for resort shirting"],
  ["Tencel Twill 190", "Tencel", "Dar es Salaam", 190, "Soft drape with clean surface"],
  ["Cotton Poplin 120", "Cotton", "Mombasa", 120, "Crisp everyday base cloth"],
  ["Silk Habotai 72", "Silk", "Nairobi", 72, "Lightweight sheen for evening capsules"],
  ["Recycled Poly Satin 98", "Recycled Polyester", "Kampala", 98, "Fluid shine with recycled content"],
  ["Ramie Slub 160", "Ramie", "Nairobi", 160, "Dry slub texture and structure"],
  ["Cotton Voile 85", "Cotton", "Kigali", 85, "Translucent soft summer layer"],
  ["Viscose Crepe 135", "Viscose", "Dar es Salaam", 135, "Fluid crepe with low crease"],
];

const styleSeeds = [
  ["VIVO-2601", "Mara Column Dress", "Vivo", "Dresses", "In review", "Product team", "2026-07-18", 78, 6900, "EA"],
  ["VIVO-2602", "Nairobi Pleat Trouser", "Vivo", "Trousers", "Proto", "Technical team", "2026-07-24", 62, 5200, "EA"],
  ["VIVO-2603", "Lamu Tie Shirt", "Vivo", "Shirts", "Approved", "Design team", "2026-07-12", 94, 4100, "EA"],
  ["VIVO-2604", "Kilimani Wrap Skirt", "Vivo", "Skirts", "In review", "Product team", "2026-08-02", 71, 4500, "EA"],
  ["VIVO-2605", "Amani Knit Polo", "Vivo", "Knitwear", "Proto", "Design team", "2026-08-08", 55, 3800, "EA"],
  ["VIVO-2606", "Tsavo Utility Jacket", "Vivo", "Outerwear", "Concept", "Merchandising team", "2026-08-15", 33, 8900, "EA"],
  ["VIVO-2607", "Karura Bias Cami", "Vivo", "Tops", "Approved", "Product team", "2026-07-09", 98, 2900, "EA"],
  ["VIVO-2608", "Rift Belted Jumpsuit", "Vivo", "Jumpsuits", "In review", "Technical team", "2026-08-04", 66, 7800, "EA"],
  ["VIVO-2609", "Sauti Linen Short", "Vivo", "Shorts", "Proto", "Design team", "2026-08-11", 49, 3200, "EA"],
  ["VIVO-2610", "Kora Pleat Blouse", "Vivo", "Blouses", "Approved", "Product team", "2026-07-22", 91, 4700, "EA"],
  ["SBF-2601", "Diani Resort Dress", "Safari by Vivo", "Dresses", "In review", "Merchandising team", "2026-07-28", 74, 6200, "EA"],
  ["SBF-2602", "Kisumu Camp Shirt", "Safari by Vivo", "Shirts", "Proto", "Design team", "2026-08-05", 58, 4300, "EA"],
  ["SBF-2603", "Samburu Cargo Pant", "Safari by Vivo", "Trousers", "Approved", "Technical team", "2026-07-19", 96, 5600, "EA"],
  ["SBF-2604", "Maji Slip Dress", "Safari by Vivo", "Dresses", "Concept", "Product team", "2026-08-18", 29, 5900, "EA"],
  ["SBF-2605", "Zanzibar Shirt Dress", "Safari by Vivo", "Dresses", "In review", "Merchandising team", "2026-08-09", 68, 6500, "EA"],
  ["SBF-2606", "Serengeti Overshirt", "Safari by Vivo", "Outerwear", "Proto", "Design team", "2026-08-14", 51, 7200, "EA"],
  ["SBF-2607", "Usambara Jersey Top", "Safari by Vivo", "Tops", "Approved", "Product team", "2026-07-14", 93, 2800, "EA"],
  ["SBF-2608", "Mombasa Drawstring Pant", "Safari by Vivo", "Trousers", "In review", "Technical team", "2026-08-07", 72, 4900, "EA"],
  ["SBF-2609", "Kagera Easy Short", "Safari by Vivo", "Shorts", "Concept", "Merchandising team", "2026-08-20", 36, 3100, "EA"],
  ["SBF-2610", "Nile Gathered Skirt", "Safari by Vivo", "Skirts", "Approved", "Product team", "2026-07-25", 89, 4400, "EA"],
] as const;

const boardSeeds = [
  ["Q3 assortment decisions", "A live room for the decisions that shape the next delivery window."],
  ["Fabric direction / high summer", "References, lab dips, and open questions for the fabric edit."],
  ["Leadership review", "A concise view of the work that needs a yes, no, or next step."],
];

const Q2_TREND_BOARD_TITLE = "Q2 2026 Trend Analysis";
const Q2_TREND_BOARD_DESCRIPTION = "Sourced from the design trend deck for the Buying Council and Scouting Circle.";
const Q2_TREND_SECTION_SEEDS = [
  ["COLOURS", [
    "A calm base of softened neutrals, sun-warmed accents, and confident blue-green notes for Q2 2026.",
    "Butter Yellow | #EBCB68 | A sunlit accent that brings warmth without overpowering the story.",
    "Dusty Rose | #C98D8E | A softened romantic note with a grown-up, grounded feel.",
    "Terracotta | #B8664C | Earth-warmed energy for confident separates and print grounds.",
    "Ocean Blue | #3E718A | A clear, assured blue that keeps the palette connected to water and sky.",
    "Olive Leaf | #7B8660 | A natural green that gives utility pieces a refined, modern calm.",
    "Cocoa Brown | #674A3D | A rich neutral for depth, polish, and easy tonal dressing.",
    "Sky Mist | #AFC8CC | A quiet blue-green lightness for airy layers and relaxed tailoring.",
    "Soft Airy White | #F7F3EA | An off-white cream base with a calm, modern-minimalist feel.",
  ].join("\n")],
  ["FABRICS", [
    "Base cloths that balance breathable ease, quiet texture, fluid movement, and a considered handfeel.",
    "Linen Blend",
    "Cotton Poplin",
    "Cotton Voile",
    "Tencel Twill",
    "Viscose Crepe",
    "Silk Habotai",
    "Recycled Satin",
    "Ramie Slub",
    "Lightweight Denim",
    "Fine Gauge Knit",
  ].join("\n")],
  ["PRINTS", [
    "Three pattern families to carry the season story from easy coordinates to expressive statement pieces.",
    "Polka Dots | Playful punctuation, scaled from delicate spots to confident graphic repeats.",
    "Gingham Sets | A familiar check made modern through coordinated separates and varied scale.",
    "Striped Sets | Directional lines that bring rhythm to relaxed tailoring and easy coordinates.",
  ].join("\n")],
  ["STYLE FEATURES", [
    "Construction directions that make familiar garments feel fresh, useful, and distinctly Vivo.",
    "Sculpted waist seam | Curved panel lines shape the torso without adding bulk.",
    "Soft utility pocket | Low-profile patch pockets add function to fluid dresses and skirts.",
    "Asymmetric wrap closure | Offset ties create adjustable movement across the body.",
    "Elongated cuff | Extended cuffs finish relaxed sleeves with a precise, rolled-up ease.",
    "Pleated volume | Controlled pleats add movement through trousers, skirts, and dresses.",
    "Cut-out neckline | Small considered openings bring lightness while keeping coverage.",
    "Statement shoulder | A gently built shoulder gives simple separates a confident line.",
    "Draped side panel | A floating panel creates movement at the hip and breaks clean columns.",
    "Adjustable drawcord | Fine drawcords let the wearer tune shape and comfort.",
    "Layered hem | A stepped or split hem gives everyday silhouettes a light, directional finish.",
    "Exposed topstitch | Tonal topstitching traces construction and elevates utility cloth.",
    "Convertible tie detail | A tie can be worn loose, wrapped, or knotted for styling flexibility.",
  ].join("\n")],
] as const;

const TEAM_DIRECTORY_SEEDS = [
  ["Leadership", "Head of Product", "Sets the product direction and keeps the range connected to the Vivo customer.", true, 0],
  ["Leadership", "Product Director", "Brings design, development, buying, and planning together around the season.", false, 1],
  ["Design Team", "Creative Director", "Shapes the creative point of view, collection stories, and visual language.", true, 0],
  ["Design Team", "Senior Designer", "Develops considered silhouettes and details from first sketch to final range.", false, 1],
  ["CAD Team", "CAD Manager", "Leads digital pattern development, grading, and technical accuracy across the range.", true, 0],
  ["CAD Team", "CAD Designer", "Translates design intent into precise, production-ready digital patterns.", false, 1],
  ["Sample Team", "Sample Room Manager", "Coordinates sample flow and makes sure every fitting moves the product forward.", true, 0],
  ["Sample Team", "Sample Maker", "Builds the physical expression of each style with care and technical craft.", false, 1],
  ["Buying & Planning", "Head of Buying", "Builds a commercially balanced assortment with a clear customer point of view.", true, 0],
  ["Buying & Planning", "Merchandise Planner", "Turns range ambition into a balanced plan across markets, stores, and channels.", false, 1],
] as const;

type L10MetricSeed = {
  owner: string;
  measurable: string;
  goal: string;
  uom: string;
  metricKey?: string;
  values: Array<number | null>;
};

const L10_WEEK_SEEDS = [
  ["Wk 27", "2026-07-06"],
  ["Wk 28", "2026-07-13"],
  ["Wk 29", "2026-07-20"],
  ["Wk 30", "2026-07-27"],
  ["Wk 31", "2026-08-03"],
  ["Wk 32", "2026-08-10"],
  ["Wk 33", "2026-08-17"],
] as const;

const L10_METRIC_SEEDS: L10MetricSeed[] = [
  { owner: "Bella", measurable: "Total In-house Units Ordered", goal: ">8000", uom: "No.", values: [5333, 4786, 10491, 8375, 7682, 8200, 6961] },
  { owner: "Bella", measurable: "Vivo Input COGS", goal: "<32%", uom: "%", values: [31, 34, 30, 28, 31, 31, 33] },
  { owner: "Bella", measurable: "Avg Vivo Production Order Size", goal: ">400", uom: "No.", values: [353, 338, 318, 427, 334, 388, 409] },
  { owner: "Mary", measurable: "% of NEW units ordered vs TOTAL", goal: ">35%", uom: "%", values: [22, 8, 32, 42, 33, 36, 29] },
  { owner: "Mary", measurable: "6-Week Sell Through Rate on New Styles", goal: ">60%", uom: "%", metricKey: "sell_through_rate", values: [52.6, 57, 56.5, 55.5, 50, 48.3, 48.1] },
  { owner: "Mary", measurable: "New Styles Launched in all Vivo A Stores", goal: ">5", uom: "No.", metricKey: "new_styles_launched", values: [5, 5, 5, 5, 5, 5, 5] },
  { owner: "Mary", measurable: "Stores that received >2 New Styles", goal: "100%", uom: "%", values: [100, 100, 100, 100, 100, 100, 100] },
  { owner: "Mary", measurable: "No. of New Styles Ordered", goal: ">6", uom: "No.", metricKey: "new_styles_ordered", values: [3, 2, 9, 9, 8, 8, 5] },
  { owner: "Jewel", measurable: "Metres of Fabric Ordered for Printing", goal: ">4000", uom: "Mtrs", values: [1100, 2608, 2242, 4000, 4000, 4000, 3954] },
  { owner: "Jewel", measurable: "% Print units ordered (2400-3200 units)", goal: "30-40%", uom: "%", values: [28, 18, 38, 34, 26, 24, 42] },
  { owner: "Marion", measurable: "No. of Adopted Styles in the pipeline", goal: ">30", uom: "No.", metricKey: "adopted_styles_pipeline", values: [69, 73, 86, 68, 32, 44, 30] },
  { owner: "Marion", measurable: "% of Dresses Ordered (2800 units)", goal: ">35%", uom: "%", values: [46, 41, 25, 34, 41, 31, 38] },
  { owner: "Chantal", measurable: "% of Knit Units Ordered", goal: ">35%", uom: "%", values: [36, 49, 41, 34, 28, 28, 8] },
  { owner: "Chantal", measurable: "No. of Replenishment Units Ordered", goal: ">3000", uom: "No.", values: [3152, 3510, 5261, 3917, 3923, 3665, 4039] },
  { owner: "Yvonne", measurable: "No. of Reorder Units Ordered", goal: ">1000", uom: "No.", values: [1004, 894, 2092, 971, 1199, 1595, 899] },
  { owner: "Florence", measurable: "Total New Styles Approved", goal: ">8", uom: "No.", metricKey: "new_styles_approved", values: [3, 8, 9, 6, 8, 5, 3] },
  { owner: "Florence", measurable: "New styles reviewed in fit sessions", goal: ">12", uom: "No.", metricKey: "fit_sessions_completed", values: [14, 17, 18, 10, 22, 17, 7] },
  { owner: "Florence", measurable: "No. of samples per approved style", goal: "<2.0", uom: "No.", values: [2.8, 2.2, 3, 2.4, 3, 1.8, 0.1] },
  { owner: "Re", measurable: "Marker Efficiency", goal: ">78%", uom: "%", values: [78, 79, 78, 79, 80, 79, 81] },
  { owner: "Re", measurable: "No. of Production Orders Processed", goal: ">20", uom: "No.", values: [18, 18, 33, 20, 21, 24, 17] },
  { owner: "Re", measurable: "CAD Styles Approved", goal: ">2", uom: "No.", metricKey: "cad_styles_approved", values: [0, 2, 6, 2, 5, 1, 0] },
  { owner: "Re", measurable: "Number of Regraded Styles", goal: ">5", uom: "No.", values: [4, 2, 1, 2, 1, 1, 1] },
  { owner: "Re", measurable: "No. of Set Sample Orders Processed", goal: ">10", uom: "No.", values: [3, 1, 14, 10, 8, 8, 8] },
  { owner: "Re", measurable: "New Set Samples Not Approved at 1st Try", goal: "<2", uom: "No.", values: [4, 2, 0, 1, 1, 2, 0] },
  { owner: "Felista", measurable: "Units given to marketing for content", goal: ">25", uom: "No.", values: [28, 28, 50, 27, 31, 46, 40] },
  { owner: "Felista", measurable: "Styles to Marketing for Content", goal: ">12", uom: "No.", values: [11, 13, 19, 12, 12, 17, 11] },
  { owner: "Beryle", measurable: "No. of Sample Units Produced", goal: ">42", uom: "No.", values: [30, 35, 30, 25, 26, 27, 33] },
  { owner: "William", measurable: "% Understocked Subcats Stock to Sales Ratio", goal: "<10%", uom: "%", metricKey: "understocked_subcategories", values: [9.5, 4.8, 9.5, 14, 4.8, 14, null] },
  { owner: "Emily", measurable: "Stores received >90% of TOTAL allocation", goal: "All 29", uom: "%", values: [93, 100, 100, 100, 100, 100, null] },
  { owner: "Maryann", measurable: "Stores received >90% of NEW allocation", goal: "All 29", uom: "%", values: [100, 100, 100, 100, 100, 100, 100] },
];

const RANGE_PLAN_ROW_SEEDS = [
  ["Basics/Essentials", "NOOS", 40, 30, 50],
  ["Dresses", "Core", 50, 40, 60],
  ["Tops", "Core", 40, 30, 50],
  ["Trousers", "Core", 28, 20, 35],
  ["Skirts", "Core", 20, 15, 25],
  ["Jumpsuits", "Core", 14, 10, 18],
  ["Blazers/Suits", "Core", 12, 8, 15],
  ["Knitwear", "Core", 10, 8, 12],
  ["Coords", "Core", 14, 10, 18],
  ["Denim", "Core", 7, 5, 10],
  ["Swimwear", "Core", 7, 5, 10],
  ["Kitenges", "Core", 15, 10, 20],
  ["Lounge/Casual", "Core", 12, 8, 15],
  ["Print Dresses", "Recent", 20, 15, 25],
  ["Shirt Dresses", "Recent", 14, 10, 18],
  ["Wrap Dresses", "Recent", 14, 10, 18],
  ["Co-ords Printed", "Recent", 12, 8, 15],
  ["Wide Leg Trousers", "Recent", 10, 8, 12],
  ["Experimental Silhouettes", "New/Test", 7, 5, 10],
  ["New Fabrications", "New/Test", 7, 5, 10],
  ["Collaborations", "New/Test", 5, 3, 8],
  ["Limited Editions", "New/Test", 5, 3, 8],
] as const;

const RANGE_PLAN_AOS_DEFAULTS: Record<string, number> = {
  NOOS: 450,
  Core: 450,
  Recent: 450,
  "New/Test": 350,
};
const rangePlanAosDefault = (tier: string) => RANGE_PLAN_AOS_DEFAULTS[tier] ?? RANGE_PLAN_AOS_DEFAULTS.Core;

const L10_AGENDA = [
  { key: "checkin", number: "①", label: "Check-In", durationMinutes: 5 },
  { key: "scorecard", number: "②", label: "Scorecard", durationMinutes: 5 },
  { key: "rocks", number: "③", label: "Rocks", durationMinutes: 5 },
  { key: "headlines", number: "④", label: "Customer / Employee Headlines", durationMinutes: 5 },
  { key: "todos", number: "⑤", label: "To-Do List Review", durationMinutes: 5 },
  { key: "ids", number: "⑥", label: "IDS — Identify, Discuss, Solve", durationMinutes: 60 },
  { key: "conclude", number: "⑦", label: "Conclude", durationMinutes: 5 },
] as const;

const L10_HEADLINE_SEEDS = [
  ["Bella is on sick leave today", "2026-08-17", "Bella", false],
  ["Queen's last week", "2026-08-10", "Queen", true],
] as const;

const L10_TODO_SEEDS = [
  ["Florence to follow up with Wandia concerning the metric on Number of Samples per approved Style", "2026-08-03", "Florence", "Not Done"],
  ["Team leads to update PD flow", "2026-07-27", "Team leads", "Not Done"],
  ["All team members to push knit styles on their desk", "2026-08-17", "Team leads", "Not Done"],
  ["Training on how to update the PD flow", "2026-08-10", "Mary", "Done"],
  ["CAD Team Lead to sit with buying to populate work for the week", "2026-08-10", "Re", "Done"],
  ["To ensure we have minimum 15 styles to review", "2026-08-10", "Florence", "Done"],
  ["Wandia to go through the product creation process with the Buying team", "2026-08-10", "Wandia", "Done"],
  ["To design a process for how prints are looked into and approved", "2026-08-10", "Mary", "Done"],
  ["Each Team Leader Creates Time for Orientation of New Members", "2026-08-10", "Team Leads", "Done"],
  ["Bella To Update the Team on the plan for the next week", "2026-08-10", "Bella", "Done"],
  ["Team Leads To Communicate With Members on Communication Gaps", "2026-08-10", "Team Leads", "Done"],
] as const;

const L10_ISSUE_SEEDS = [
  ["% of Knit Units Ordered", "Chantal", 1],
  ["Total New Styles Approved", "Florence", 2],
  ["Total new styles reviewed in fit sessions", "Florence", 3],
  ["CAD Styles Approved", "Re", 4],
] as const;

const L10_ROCK_FALLBACKS = [
  ["Abigail", "Abigail's product development rock", "On Track"],
  ["Bella", "Bella's product development rock", "On Track"],
  ["Beryle", "Beryle's product development rock", "On Track"],
  ["Chantal", "Chantal's product development rock", "On Track"],
  ["Emily", "Emily's product development rock", "On Track"],
  ["Felista", "Felista's product development rock", "Done"],
  ["Florence", "Florence's product development rock", "On Track"],
  ["Jewel", "Jewel's product development rock 1", "On Track"],
  ["Jewel", "Jewel's product development rock 2", "On Track"],
  ["Marion", "Marion's product development rock", "On Track"],
  ["Mary", "Mary's product development rock", "On Track"],
  ["Maryanne", "Maryanne's product development rock", "On Track"],
  ["Mercy", "Mercy's product development rock", "On Track"],
  ["Natasha", "Natasha's product development rock", "On Track"],
  ["Queen", "Queen's product development rock", "On Track"],
  ["Re", "Re's product development rock", "On Track"],
  ["Rose", "Rose's product development rock", "On Track"],
  ["Tony", "Tony's product development rock", "Done"],
  ["Victoria", "Victoria's product development rock", "On Track"],
  ["Wandia", "Wandia's product development rock", "On Track"],
  ["Wanjohi", "Wanjohi's product development rock", "On Track"],
  ["Yvonne", "Yvonne's product development rock", "On Track"],
] as const;

const L10_RATING_AVERAGES = [8.6, 9.2, 8.0, 7.8, 8.4, 8.0, 8.1] as const;

function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, encoded: string) {
  const [salt, stored] = encoded.split(":");
  if (!salt || !stored) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(derived, "hex"));
}

function sessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function publicUser(row: UserRow) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, initials: row.initials, color: row.color };
}

function l10Monday(date = new Date()) {
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - (monday.getDay() === 0 ? 6 : monday.getDay() - 1));
  return monday;
}

function l10WeekLabel(date: Date) {
  const anchor = new Date("2026-07-06T00:00:00");
  const weeks = Math.floor((l10Monday(date).getTime() - anchor.getTime()) / (7 * 86400000));
  return `Wk ${27 + Math.max(0, weeks)}`;
}

function l10GoalStatus(value: number | null, goal: string): boolean | null {
  if (value === null || !Number.isFinite(value)) return null;
  const normalizedGoal = goal.trim().replace(/%/g, "");
  const range = normalizedGoal.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/);
  if (range) return value >= Number(range[1]) && value <= Number(range[2]);
  if (/^all\s+\d+/i.test(goal)) return value >= 100;
  const operator = normalizedGoal.match(/^(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)/);
  if (!operator) return null;
  const target = Number(operator[2]);
  if (operator[1] === ">=") return value >= target;
  if (operator[1] === "<=") return value <= target;
  if (operator[1] === ">") return value > target;
  if (operator[1] === "<") return value < target;
  return value === target;
}

const LIVE_L10_METRIC_KEYS = [
  "new_styles_approved",
  "fit_sessions_completed",
  "adopted_styles_pipeline",
  "new_styles_launched",
  "new_styles_ordered",
  "cad_styles_approved",
  "sell_through_rate",
  "understocked_subcategories",
] as const;

type LiveL10MetricKey = (typeof LIVE_L10_METRIC_KEYS)[number];

async function publicTableColumns(tableName: string) {
  try {
    const result = await pool.query<{ columnName: string }>(
      `SELECT column_name AS "columnName"
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
      [tableName],
    );
    return new Set(result.rows.map((row) => row.columnName));
  } catch {
    return new Set<string>();
  }
}

async function computeLiveL10Values() {
  const values = new Map<LiveL10MetricKey, number | null>();
  const [styleColumns, movementColumns, productColumns] = await Promise.all([
    publicTableColumns("pd_styles"),
    publicTableColumns("pd_movements"),
    publicTableColumns("all_products_clean"),
  ]);

  const styleStageColumn = styleColumns.has("stage") ? "stage" : styleColumns.has("current_stage") ? "current_stage" : null;
  const styleUpdatedColumn = styleColumns.has("updated_at") ? "updated_at" : styleColumns.has("created_at") ? "created_at" : null;
  const styleRepeatColumn = styleColumns.has("new_repeat") ? "new_repeat" : styleColumns.has("lifecycle_type") ? "lifecycle_type" : null;
  const stageExpression = styleStageColumn
    ? `LOWER(REPLACE(COALESCE(NULLIF(TRIM(s.${styleStageColumn}),''),''),'_',' '))`
    : null;
  const updatedExpression = styleUpdatedColumn ? `s.${styleUpdatedColumn}` : null;

  if (styleStageColumn && styleUpdatedColumn) {
    const styleResult = await pool.query<Record<string, number>>(
      `SELECT
        COUNT(*) FILTER (WHERE ${stageExpression}='approved' AND ${updatedExpression} >= date_trunc('week',CURRENT_DATE))::int AS "newStylesApproved",
        COUNT(*) FILTER (WHERE ${stageExpression}='live' AND ${updatedExpression} >= date_trunc('month',CURRENT_DATE))::int AS "newStylesLaunched",
        COUNT(*) FILTER (WHERE ${stageExpression} IN ('production','ordered') AND ${updatedExpression} >= date_trunc('week',CURRENT_DATE))::int AS "newStylesOrdered",
        COUNT(*) FILTER (WHERE ${stageExpression}='cad approved' AND ${updatedExpression} >= date_trunc('week',CURRENT_DATE))::int AS "cadStylesApproved"
        FROM public.pd_styles s
        WHERE ${allowedBrand("s")}`,
    );
    const row = styleResult.rows[0];
    values.set("new_styles_approved", Number(row?.newStylesApproved ?? 0));
    values.set("new_styles_launched", Number(row?.newStylesLaunched ?? 0));
    values.set("new_styles_ordered", Number(row?.newStylesOrdered ?? 0));
    values.set("cad_styles_approved", Number(row?.cadStylesApproved ?? 0));
  } else {
    values.set("new_styles_approved", null);
    values.set("new_styles_launched", null);
    values.set("new_styles_ordered", null);
    values.set("cad_styles_approved", null);
  }

  if (styleStageColumn && styleRepeatColumn) {
    const pipelineResult = await pool.query<{ value: number }>(
      `SELECT COUNT(*)::int AS value
       FROM public.pd_styles s
       WHERE ${allowedBrand("s")}
         AND ${stageExpression} NOT IN ('dropped','archived')
         AND LOWER(TRIM(COALESCE(s.${styleRepeatColumn},'')))='new'`,
    );
    values.set("adopted_styles_pipeline", Number(pipelineResult.rows[0]?.value ?? 0));
  } else {
    values.set("adopted_styles_pipeline", null);
  }

  const movementToStageColumn = movementColumns.has("to_stage");
  const movementDateColumn = movementColumns.has("moved_at") ? "moved_at" : movementColumns.has("created_at") ? "created_at" : null;
  if (movementToStageColumn && movementDateColumn) {
    const fitResult = await pool.query<{ value: number }>(
      `SELECT COUNT(*)::int AS value
       FROM public.pd_movements m
       WHERE LOWER(REPLACE(COALESCE(m.to_stage,''),'_',' '))='fit sample'
         AND m.${movementDateColumn} >= date_trunc('week',CURRENT_DATE)`,
    );
    values.set("fit_sessions_completed", Number(fitResult.rows[0]?.value ?? 0));
  } else {
    values.set("fit_sessions_completed", null);
  }

  const statusColumn = productColumns.has("status");
  const subcategoryColumn = productColumns.has("sub_category");
  if (statusColumn && subcategoryColumn) {
    const productIdentityColumn = productColumns.has("style_number")
      ? "style_number"
      : productColumns.has("style_name")
        ? "style_name"
        : productColumns.has("sku")
          ? "sku"
          : null;
    if (productIdentityColumn) {
      const sellThroughResult = await pool.query<{ value: number | null }>(
        `WITH styles AS (
           SELECT DISTINCT COALESCE(NULLIF(TRIM(${productIdentityColumn}),''),'unknown') AS style_key,
             LOWER(TRIM(COALESCE(status,''))) AS status
           FROM public.all_products_clean p
           WHERE ${allowedBrand("p")}
             AND LOWER(TRIM(COALESCE(status,''))) IN ('active','retired')
         )
         SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE status='active') / NULLIF(COUNT(*),0),1)::float AS value
         FROM styles`,
      );
      values.set("sell_through_rate", sellThroughResult.rows[0]?.value == null ? null : Number(sellThroughResult.rows[0].value));
    } else {
      values.set("sell_through_rate", null);
    }
    const understockedResult = await pool.query<{ value: number }>(
      `SELECT COUNT(*)::int AS value
       FROM (
         SELECT sub_category
         FROM public.all_products_clean p
         WHERE ${allowedBrand("p")}
           AND LOWER(TRIM(COALESCE(p.status,'')))='active'
           AND NULLIF(TRIM(p.sub_category),'') IS NOT NULL
          GROUP BY p.sub_category
         HAVING COUNT(*) < 5
       ) subcategories`,
    );
    values.set("understocked_subcategories", Number(understockedResult.rows[0]?.value ?? 0));
  } else {
    values.set("sell_through_rate", null);
    values.set("understocked_subcategories", null);
  }
  return values;
}

async function rangePlanHealth() {
  const empty = {
    newRepeat: { newCount: 0, repeatCount: 0, total: 0 },
    subCategories: [] as Array<{ name: string; count: number }>,
    activeStyleCount: 0,
  };
  try {
    const columns = await publicTableColumns("pd_styles");
    const stageColumn = columns.has("stage") ? "stage" : columns.has("current_stage") ? "current_stage" : columns.has("status") ? "status" : null;
    const repeatColumn = columns.has("new_repeat") ? "new_repeat" : columns.has("lifecycle_type") ? "lifecycle_type" : columns.has("order_type") ? "order_type" : null;
    const subCategoryColumn = columns.has("sub_category") ? "sub_category" : columns.has("category") ? "category" : null;
    if (!stageColumn) return empty;
     const activeWhere = `${allowedBrand("s")} AND LOWER(REPLACE(COALESCE(NULLIF(TRIM(s.${stageColumn}),''),''),'_',' ')) NOT IN ('dropped','archived')`;
    const styleCountExpression = columns.has("id") ? "COUNT(DISTINCT s.id)" : "COUNT(*)";
    const repeatExpression = repeatColumn ? `LOWER(TRIM(COALESCE(s.${repeatColumn},'')))` : "''";
    const newRepeat = repeatColumn
      ? await pool.query<{ newCount: number; repeatCount: number; total: number }>(
        `SELECT
           COUNT(*) FILTER (WHERE ${repeatExpression}='new')::int AS "newCount",
           COUNT(*) FILTER (WHERE ${repeatExpression}<>'new')::int AS "repeatCount",
           COUNT(*)::int AS total
         FROM public.pd_styles s WHERE ${activeWhere}`,
      )
      : { rows: [{ newCount: 0, repeatCount: 0, total: 0 }] };
    const subCategories = subCategoryColumn
      ? await pool.query<{ name: string; count: number }>(
        `SELECT COALESCE(NULLIF(TRIM(s.${subCategoryColumn}),''),'Uncategorised') AS name,
           ${styleCountExpression}::int AS count
         FROM public.pd_styles s
         WHERE ${activeWhere}
         GROUP BY 1 ORDER BY count DESC, name LIMIT 15`,
      )
      : { rows: [] };
    return {
      newRepeat: newRepeat.rows[0] ?? empty.newRepeat,
      subCategories: subCategories.rows,
      activeStyleCount: Number(newRepeat.rows[0]?.total ?? 0),
    };
  } catch {
    return empty;
  }
}

const liveScorecardHandler = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const liveValues = await computeLiveL10Values();
    const metricRows = await pool.query<{
      id: number;
      metricKey: string | null;
      measurable: string;
      goal: string;
      uom: string;
    }>(
      `SELECT id,metric_key AS "metricKey",measurable,goal,uom
       FROM ${schema}.l10_scorecard_metrics
       WHERE active AND metric_key = ANY($1::text[])
       ORDER BY sort_order,id`,
      [LIVE_L10_METRIC_KEYS],
    );
    const metrics: Record<string, { value: number; uom: string; source: "live" }> = {};
    for (const metric of metricRows.rows) {
      if (!metric.metricKey) continue;
      const value = liveValues.get(metric.metricKey as LiveL10MetricKey);
      if (value == null || !Number.isFinite(value)) continue;
      metrics[metric.metricKey] = { value, uom: metric.uom, source: "live" };
    }

    const currentMeeting = await pool.query<{ id: number; concluded: boolean }>(
      `SELECT id,concluded FROM ${schema}.l10_meetings
       WHERE meeting_date = date_trunc('week',CURRENT_DATE)::date
       LIMIT 1`,
    );
    if (currentMeeting.rows[0] && !currentMeeting.rows[0].concluded) {
      for (const metric of metricRows.rows) {
        if (!metric.metricKey || metrics[metric.metricKey] == null) continue;
        const value = metrics[metric.metricKey].value;
        await pool.query(
          `INSERT INTO ${schema}.l10_scorecard_entries (meeting_id,metric_id,value,on_track,updated_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (meeting_id,metric_id) DO UPDATE
           SET value=EXCLUDED.value,on_track=EXCLUDED.on_track,updated_at=NOW()`,
          [currentMeeting.rows[0].id, metric.id, value, l10GoalStatus(value, metric.goal)],
        );
      }
    }

    res.json({
      weekStart: l10Monday().toISOString().slice(0, 10),
      metrics,
    });
  } catch (error) {
    next(error);
  }
};

async function ensureL10Data() {
  for (const [weekLabel, meetingDate] of L10_WEEK_SEEDS) {
    await pool.query(
      `INSERT INTO ${schema}.l10_meetings
        (week_label,meeting_date,start_time,end_time,location,duration_minutes)
       VALUES ($1,$2,'11:30','13:00','Design Board Room',90)
       ON CONFLICT (week_label) DO NOTHING`,
      [weekLabel, meetingDate],
    );
  }
  const currentMonday = l10Monday();
  await pool.query(
    `INSERT INTO ${schema}.l10_meetings
      (week_label,meeting_date,start_time,end_time,location,duration_minutes)
     VALUES ($1,$2,'11:30','13:00','Design Board Room',90)
     ON CONFLICT (week_label) DO NOTHING`,
    [l10WeekLabel(currentMonday), currentMonday.toISOString().slice(0, 10)],
  );

  const meetingRows = await pool.query<{ id: number; weekLabel: string }>(
    `SELECT id,week_label AS "weekLabel" FROM ${schema}.l10_meetings ORDER BY meeting_date ASC`,
  );
  const meetingByWeek = new Map(meetingRows.rows.map((row) => [row.weekLabel, row.id]));

  const teamRows = await pool.query<{ name: string }>(
    `SELECT COALESCE(NULLIF(TRIM(name),''),NULLIF(TRIM(role_title),''),'Team member') AS name
     FROM ${schema}.workspace_team_members
     ORDER BY team_section,display_order,id`,
  );
  for (const meeting of meetingRows.rows) {
    for (const member of teamRows.rows) {
      await pool.query(
        `INSERT INTO ${schema}.l10_checkins (meeting_id,member_name)
         VALUES ($1,$2) ON CONFLICT (meeting_id,member_name) DO NOTHING`,
        [meeting.id, member.name],
      );
    }
    await pool.query(
      `INSERT INTO ${schema}.l10_agenda_notes (meeting_id)
       VALUES ($1) ON CONFLICT (meeting_id) DO NOTHING`,
      [meeting.id],
    );
  }

  for (const [sortOrder, metric] of L10_METRIC_SEEDS.entries()) {
    const metricResult = await pool.query<{ id: number }>(
      `INSERT INTO ${schema}.l10_scorecard_metrics (owner,measurable,goal,uom,metric_key,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner,measurable) DO UPDATE
       SET goal=EXCLUDED.goal,uom=EXCLUDED.uom,metric_key=COALESCE(EXCLUDED.metric_key,${schema}.l10_scorecard_metrics.metric_key),sort_order=EXCLUDED.sort_order
       RETURNING id`,
      [metric.owner, metric.measurable, metric.goal, metric.uom, metric.metricKey ?? null, sortOrder],
    );
    const metricId = metricResult.rows[0]?.id;
    if (!metricId) continue;
    for (const [index, value] of metric.values.entries()) {
      const meetingId = meetingByWeek.get(L10_WEEK_SEEDS[index]?.[0]);
      if (!meetingId) continue;
      await pool.query(
        `INSERT INTO ${schema}.l10_scorecard_entries (meeting_id,metric_id,value,on_track)
         VALUES ($1,$2,$3,$4) ON CONFLICT (meeting_id,metric_id) DO NOTHING`,
        [meetingId, metricId, value, l10GoalStatus(value, metric.goal)],
      );
    }
  }

  const rockCount = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${schema}.l10_rocks`);
  if (!rockCount.rows[0]?.count) {
    try {
      const legacyRocks = await pool.query<{ description: string; owner: string | null; onTrack: boolean; done: boolean; sortOrder: number }>(
        `SELECT description,owner,on_track AS "onTrack",done,sort_order AS "sortOrder"
         FROM public.l10_rocks
         WHERE COALESCE(active,TRUE) AND (folder_id IS NULL OR folder_id=1)
         ORDER BY sort_order,id LIMIT 22`,
      );
      for (const rock of legacyRocks.rows) {
        await pool.query(
          `INSERT INTO ${schema}.l10_rocks (description,owner,status,sort_order,source)
           VALUES ($1,$2,$3,$4,'legacy-sheet') ON CONFLICT (description) DO NOTHING`,
          [rock.description, rock.owner ?? "", rock.done ? "Done" : rock.onTrack ? "On Track" : "Off Track", rock.sortOrder],
        );
      }
    } catch {
      // The legacy table is optional in development; an empty list is safer than
      // inventing meeting rocks when the source sheet is not available.
    }
  }

  const seededRockCount = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${schema}.l10_rocks`);
  if ((seededRockCount.rows[0]?.count ?? 0) < L10_ROCK_FALLBACKS.length) {
    for (const [sortOrder, [owner, description, status]] of L10_ROCK_FALLBACKS.entries()) {
      await pool.query(
        `INSERT INTO ${schema}.l10_rocks (description,owner,status,sort_order,source)
         VALUES ($1,$2,$3,$4,'workspace-seed') ON CONFLICT (description) DO NOTHING`,
        [description, owner, status, sortOrder],
      );
    }
  }

  const currentMeetingId = meetingByWeek.get(l10WeekLabel(currentMonday));
  if (!currentMeetingId) return;
  const currentHeadlineCount = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${schema}.l10_headlines WHERE meeting_id=$1`,
    [currentMeetingId],
  );
  if (!currentHeadlineCount.rows[0]?.count) {
    for (const [sortOrder, [headline, headlineDate, addedBy, needsDiscussion]] of L10_HEADLINE_SEEDS.entries()) {
      await pool.query(
        `INSERT INTO ${schema}.l10_headlines
          (meeting_id,headline,headline_date,added_by,needs_discussion,sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [currentMeetingId, headline, headlineDate, addedBy, needsDiscussion, sortOrder],
      );
    }
  }

  const currentTodoCount = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${schema}.l10_todos WHERE meeting_id=$1`,
    [currentMeetingId],
  );
  if (!currentTodoCount.rows[0]?.count) {
    for (const [description, openDate, owner, status] of L10_TODO_SEEDS) {
      await pool.query(
        `INSERT INTO ${schema}.l10_todos
          (meeting_id,description,open_date,owner,status)
         VALUES ($1,$2,$3,$4,$5)`,
        [currentMeetingId, description, openDate, owner, status],
      );
    }
  }

  const currentIssueCount = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${schema}.l10_issues WHERE meeting_id=$1`,
    [currentMeetingId],
  );
  if (!currentIssueCount.rows[0]?.count) {
    for (const [issue, raisedBy, priority] of L10_ISSUE_SEEDS) {
      await pool.query(
        `INSERT INTO ${schema}.l10_issues
          (meeting_id,issue,raised_by,priority,issue_type,sort_order)
         VALUES ($1,$2,$3,$4,'active',$4)`,
        [currentMeetingId, issue, raisedBy, priority],
      );
    }
  }

  for (const meeting of meetingRows.rows) {
    await pool.query(
      `INSERT INTO ${schema}.l10_cascading_messages (meeting_id)
       VALUES ($1) ON CONFLICT (meeting_id) DO NOTHING`,
      [meeting.id],
    );
  }

  const ratingMembers = teamRows.rows.map((row) => row.name).filter(Boolean).slice(0, 10);
  try {
    const legacyRatings: Array<{ weekLabel: string; memberName: string; rating: number }> = [];
    try {
      const legacy = await pool.query<{ meetingDate: string; memberName: string; rating: number }>(
        `SELECT lm.meeting_date::text AS "meetingDate",lr.member_name AS "memberName",lr.rating
         FROM public.l10_ratings lr
         JOIN public.l10_meetings lm ON lm.id=lr.meeting_id
         WHERE lm.meeting_date BETWEEN '2026-07-06'::date AND '2026-08-17'::date`,
      );
      for (const row of legacy.rows) {
        legacyRatings.push({ weekLabel: l10WeekLabel(new Date(`${row.meetingDate.slice(0, 10)}T12:00:00`)), memberName: row.memberName, rating: Number(row.rating) });
      }
    } catch {
      // Legacy ratings are optional; the exact weekly averages below remain the
      // deterministic fallback for a fresh Product Workspace database.
    }
    for (const row of legacyRatings) {
      const meetingId = meetingByWeek.get(row.weekLabel);
      if (!meetingId || !Number.isInteger(row.rating)) continue;
      await pool.query(
        `INSERT INTO ${schema}.l10_ratings (meeting_id,team_member_name,rating)
         VALUES ($1,$2,$3) ON CONFLICT (meeting_id,team_member_name) DO NOTHING`,
        [meetingId, row.memberName, row.rating],
      );
    }
    for (const [index, average] of L10_RATING_AVERAGES.entries()) {
      const meetingId = meetingByWeek.get(L10_WEEK_SEEDS[index]?.[0]);
      if (!meetingId || !ratingMembers.length) continue;
      const total = Math.round(average * ratingMembers.length);
      const base = Math.floor(total / ratingMembers.length);
      const remainder = total - base * ratingMembers.length;
      for (const [memberIndex, memberName] of ratingMembers.entries()) {
        await pool.query(
          `INSERT INTO ${schema}.l10_ratings (meeting_id,team_member_name,rating)
           VALUES ($1,$2,$3) ON CONFLICT (meeting_id,team_member_name) DO NOTHING`,
          [meetingId, memberName, base + (memberIndex < remainder ? 1 : 0)],
        );
      }
    }
  } catch (error) {
    console.warn(
      "Workspace L10 ratings seed skipped:",
      error instanceof Error ? error.message : error,
    );
  }
}

async function ensureWorkspaceResources() {
  await pool.query(
    `DELETE FROM ${schema}.workspace_resources
     WHERE title = ANY($1::text[])`,
    [[
      "Buying & Allocations: Weekly New Style Buy Volume (BA-SOP-001)",
      "Buying & Allocations: Weekly New Style Allocation (BA-SOP-002)",
      "Warehousing & Logistics: Daily Stock Replenishment (WL-SOP-001)",
      "Product Team SOP — 2026 Operating Model",
      "Points of Measure (POM) Specifications",
    ]],
  );
  for (const resource of RESOURCE_SEEDS) {
    await pool.query(
      `INSERT INTO ${schema}.workspace_resources
        (title,category,description,source_url,content_markdown)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (title) DO UPDATE
         SET category=EXCLUDED.category,
             description=EXCLUDED.description,
             source_url=EXCLUDED.source_url,
             updated_at=NOW()`,
      [resource.title, resource.category, resource.description, resource.sourceUrl, resource.contentMarkdown],
    );
  }
}

async function ensureRangePlanData() {
  for (const seasonSeed of RANGE_PLAN_SEASON_SEEDS) {
    const seasonResult = await pool.query<{ id: number }>(
      `INSERT INTO ${schema}.range_plan_seasons
        (season_name,season_year,revenue_target_kes,cogs_budget_pct,factory_capacity_units,status)
       VALUES ($1,2026,$2,42,$3,'active')
       ON CONFLICT (season_name,season_year) DO UPDATE
          SET season_name=EXCLUDED.season_name,
              factory_capacity_units=EXCLUDED.factory_capacity_units
       RETURNING id`,
      [seasonSeed.seasonName, seasonSeed.revenueTarget, seasonSeed.factoryCapacityUnits],
    );
    const seasonId = seasonResult.rows[0]?.id;
    if (!seasonId) continue;
    for (const [subCategory, tier, target, minimum, maximum] of RANGE_PLAN_ROW_SEEDS) {
      await pool.query(
        `INSERT INTO ${schema}.range_plan_rows
          (season_id,sub_category,tier,style_count_target,style_count_min,style_count_max,aos_units)
         VALUES ($1,$2,$3::${schema}.range_plan_tier,$4,$5,$6,$7)
         ON CONFLICT (season_id,sub_category) DO NOTHING`,
        [seasonId, subCategory, tier, target, minimum, maximum, rangePlanAosDefault(String(tier))],
      );
    }
    if (seasonSeed.cadence === "monthly") {
      await pool.query(
        `INSERT INTO ${schema}.range_plan_otb
          (season_id,month_year,revenue_target,planned_units,new_styles_count,notes)
         VALUES ($1,$2,$3,NULL,NULL,'')
         ON CONFLICT (season_id,month_year) DO NOTHING`,
        [seasonId, seasonSeed.otbMonth, seasonSeed.revenueTarget],
      );
      await pool.query(
        `DELETE FROM ${schema}.range_plan_otb
         WHERE season_id=$1 AND month_year<>$2`,
        [seasonId, seasonSeed.otbMonth],
      );
    }
  }
  await pool.query(
    `UPDATE ${schema}.range_plan_rows
     SET aos_units=450
     WHERE tier IN ('NOOS','Core','Recent')
       AND season_id IN (
         SELECT id FROM ${schema}.range_plan_seasons
         WHERE season_name IN ('Q3 2026','Q4 2026')
       )
       AND aos_units=350`,
  );
}

async function isDatabaseReachable() {
  const now = Date.now();
  if (now - lastDbProbeAt < 2000) return lastDbProbeResult;
  lastDbProbeAt = now;
  try {
    await withTimeout(pool.query("SELECT 1"), 2000, "database readiness probe");
    lastDbProbeResult = true;
  } catch (error) {
    lastDbProbeResult = false;
    console.warn("Workspace database readiness probe failed", error);
  }
  return lastDbProbeResult;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runBestEffortMigration(label: string, text: string) {
  try {
    await withTimeout(pool.query(text), 8000, `migration ${label}`);
    console.log(`Workspace migration ready: ${label}`);
  } catch (error) {
    console.warn(`Workspace optional migration skipped: ${label}`, error);
  }
}

async function ensureRecentWorkspaceMigrations() {
  const migrations: Array<[string, string]> = [
    ["workspace brand rename", `
      UPDATE public.all_products_clean
         SET brand='Safari by Vivo'
       WHERE BTRIM(COALESCE(brand,''))='Safari';
      UPDATE public.pd_styles
         SET brand='Safari by Vivo'
       WHERE BTRIM(COALESCE(brand,''))='Safari';
      UPDATE ${schema}.styles
         SET brand='Safari by Vivo'
       WHERE BTRIM(COALESCE(brand,''))='Safari';
    `],
    ["workspace_team_members birthday", `ALTER TABLE ${schema}.workspace_team_members ADD COLUMN IF NOT EXISTS birthday DATE`],
    ["workspace users team and date of birth", `
      ALTER TABLE ${schema}.workspace_users ADD COLUMN IF NOT EXISTS team TEXT NOT NULL DEFAULT '';
      ALTER TABLE ${schema}.workspace_users ADD COLUMN IF NOT EXISTS date_of_birth DATE;
    `],
    ["workspace styles classification columns", `
      ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS launch_route TEXT;
      ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS style_classification TEXT;
      ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS range_tier TEXT;
      ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS season TEXT NOT NULL DEFAULT 'Q3 2026';
      UPDATE ${schema}.styles SET season='Q3 2026' WHERE season IS NULL OR BTRIM(season)='';
    `],
    ["product development style classification columns", `
      ${PD_STYLE_TEAM_DDL}
      ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS launch_route TEXT;
      ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS style_classification TEXT;
      ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS range_tier TEXT;
      ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS season TEXT;
      UPDATE public.pd_styles SET season='Q3 2026' WHERE season IS NULL OR BTRIM(season)='';
    `],
    ["catalogue range tiers and assortment exclusions", `
      ALTER TABLE IF EXISTS public.all_products_clean ADD COLUMN IF NOT EXISTS range_tier TEXT;
      WITH style_stock AS (
        SELECT p.style_number,
          BOOL_OR(COALESCE(p.is_noos, FALSE) OR UPPER(COALESCE(p.tier, '')) = 'NOOS') AS is_noos,
          COALESCE(SUM(i.available), 0) AS stock_units
        FROM public.all_products_clean p
        LEFT JOIN public.all_inventory i ON i.sku=p.sku
         WHERE ${allowedBrand("p")}
           AND LOWER(COALESCE(p.status,'')) IN ('active','retired')
           AND p.style_number IS NOT NULL AND BTRIM(p.style_number) <> ''
        GROUP BY p.style_number
      )
      UPDATE public.all_products_clean p
      SET range_tier = CASE WHEN s.is_noos THEN 'NOOS' WHEN s.stock_units > 100 THEN 'Core' ELSE 'Recent' END
      FROM style_stock s
       WHERE ${allowedBrand("p")}
         AND LOWER(COALESCE(p.status,'')) IN ('active','retired')
         AND p.style_number=s.style_number AND (p.range_tier IS NULL OR BTRIM(p.range_tier)='');
      CREATE TABLE IF NOT EXISTS ${schema}.assortment_exclusions (
        season TEXT NOT NULL,
        style_id TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (season, style_id, source),
        CHECK (season IN ('Q3 2026','Q4 2026')),
        CHECK (source IN ('all_products_clean','pd_styles'))
      );
      CREATE INDEX IF NOT EXISTS assortment_exclusions_season_idx ON ${schema}.assortment_exclusions (season, source);
    `],
    ["workspace style season", `
      ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS season TEXT NOT NULL DEFAULT 'Q3 2026';
      UPDATE ${schema}.styles SET season='Q3 2026' WHERE season IS NULL OR BTRIM(season)='';
    `],
    ["range plan enum", `
      DO $$ BEGIN
        CREATE TYPE ${schema}.range_plan_tier AS ENUM ('NOOS','Core','Recent','New/Test');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `],
    ["range plan seasons", `
      CREATE TABLE IF NOT EXISTS ${schema}.range_plan_seasons (
        id SERIAL PRIMARY KEY,
        season_name TEXT NOT NULL,
        season_year INTEGER NOT NULL,
        revenue_target_kes NUMERIC NOT NULL DEFAULT 0,
        cogs_budget_pct NUMERIC NOT NULL DEFAULT 0,
        factory_capacity_units INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (season_name, season_year)
      )
    `],
    ["range plan rows", `
      CREATE TABLE IF NOT EXISTS ${schema}.range_plan_rows (
        id SERIAL PRIMARY KEY,
        season_id INTEGER NOT NULL REFERENCES ${schema}.range_plan_seasons(id) ON DELETE CASCADE,
        sub_category TEXT NOT NULL,
        tier ${schema}.range_plan_tier NOT NULL,
        style_count_target INTEGER NOT NULL DEFAULT 0,
        style_count_min INTEGER NOT NULL DEFAULT 0,
        style_count_max INTEGER NOT NULL DEFAULT 0,
        aos_units INTEGER NOT NULL DEFAULT 350,
        total_units_implied INTEGER GENERATED ALWAYS AS (style_count_target * aos_units) STORED,
        notes TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (season_id, sub_category)
      )
    `],
    ["range plan OTB", `
      CREATE TABLE IF NOT EXISTS ${schema}.range_plan_otb (
        id SERIAL PRIMARY KEY,
        season_id INTEGER NOT NULL REFERENCES ${schema}.range_plan_seasons(id) ON DELETE CASCADE,
        month_year DATE NOT NULL,
        revenue_target NUMERIC,
        planned_units INTEGER,
        new_styles_count INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        UNIQUE (season_id, month_year)
      )
    `],
    ["range plan indexes", `
      CREATE INDEX IF NOT EXISTS range_plan_rows_season_idx ON ${schema}.range_plan_rows (season_id, tier, id);
      CREATE INDEX IF NOT EXISTS range_plan_otb_season_month_idx ON ${schema}.range_plan_otb (season_id, month_year);
    `],
    ["assortment plan style membership", `
      CREATE TABLE IF NOT EXISTS ${schema}.assortment_plan_styles (
        season TEXT NOT NULL CHECK (season IN ('Q3 2026','Q4 2026')),
        source TEXT NOT NULL CHECK (source IN ('all_products_clean','pd_styles')),
        style_key TEXT NOT NULL,
        style_number TEXT,
        pd_style_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (season, source, style_key)
      );
      CREATE INDEX IF NOT EXISTS assortment_plan_styles_season_idx
        ON ${schema}.assortment_plan_styles (season, source);
    `],
  ];
  for (const [label, text] of migrations) {
    await runBestEffortMigration(label, text);
  }
}

async function ensureSchema() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS ${schema};
    CREATE TABLE IF NOT EXISTS ${schema}.users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      initials TEXT NOT NULL,
      color TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.fabrics (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      composition TEXT NOT NULL,
      mill TEXT NOT NULL,
      gsm INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ${schema}.styles (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      category TEXT NOT NULL,
      sub_category TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL DEFAULT '',
      order_type TEXT NOT NULL DEFAULT 'New',
      tier TEXT NOT NULL DEFAULT 'Core',
      status TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'Concept',
      stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      owner TEXT NOT NULL,
      designer TEXT NOT NULL DEFAULT '',
      pattern_maker TEXT NOT NULL DEFAULT '',
      fabric_type TEXT NOT NULL DEFAULT '',
      target_date DATE NOT NULL,
      image TEXT,
      progress NUMERIC NOT NULL DEFAULT 0,
      price NUMERIC NOT NULL DEFAULT 0,
      market TEXT NOT NULL DEFAULT 'EA',
      creative_description TEXT NOT NULL DEFAULT '',
      size_range TEXT NOT NULL DEFAULT '',
      trims_special_features JSONB NOT NULL DEFAULT '[]'::jsonb,
      predicted_cost NUMERIC,
      confirmed_cost NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
     ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS launch_route TEXT;
     ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS style_classification TEXT;
     ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS range_tier TEXT;
     ALTER TABLE ${schema}.styles DROP CONSTRAINT IF EXISTS styles_launch_route_check;
     ALTER TABLE ${schema}.styles ADD CONSTRAINT styles_launch_route_check
       CHECK (launch_route IS NULL OR launch_route IN ('DTC','Wholesale','Marketplace','Omnichannel'));
     ALTER TABLE ${schema}.styles DROP CONSTRAINT IF EXISTS styles_style_classification_check;
     ALTER TABLE ${schema}.styles ADD CONSTRAINT styles_style_classification_check
       CHECK (style_classification IS NULL OR style_classification IN ('Core','Fashion','Seasonal','Test'));
     ALTER TABLE ${schema}.styles DROP CONSTRAINT IF EXISTS styles_range_tier_check;
     ALTER TABLE ${schema}.styles ADD CONSTRAINT styles_range_tier_check
       CHECK (range_tier IS NULL OR range_tier IN ('Tier 1','Tier 2','Tier 3','Tier 4'));
     ${PD_STYLE_TEAM_DDL}
     ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS launch_route TEXT;
     ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS style_classification TEXT;
     ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS range_tier TEXT;
      ALTER TABLE IF EXISTS public.pd_styles ADD COLUMN IF NOT EXISTS season TEXT;
      UPDATE public.pd_styles SET season='Q3 2026' WHERE season IS NULL OR BTRIM(season)='';
     ALTER TABLE IF EXISTS public.pd_styles DROP CONSTRAINT IF EXISTS pd_styles_launch_route_check;
     ALTER TABLE IF EXISTS public.pd_styles ADD CONSTRAINT pd_styles_launch_route_check
       CHECK (launch_route IS NULL OR launch_route IN ('DTC','Wholesale','Marketplace','Omnichannel'));
     ALTER TABLE IF EXISTS public.pd_styles DROP CONSTRAINT IF EXISTS pd_styles_style_classification_check;
     ALTER TABLE IF EXISTS public.pd_styles ADD CONSTRAINT pd_styles_style_classification_check
       CHECK (style_classification IS NULL OR style_classification IN ('Core','Fashion','Seasonal','Test'));
     ALTER TABLE IF EXISTS public.pd_styles DROP CONSTRAINT IF EXISTS pd_styles_range_tier_check;
     ALTER TABLE IF EXISTS public.pd_styles ADD CONSTRAINT pd_styles_range_tier_check
       CHECK (range_tier IS NULL OR range_tier IN ('Tier 1','Tier 2','Tier 3','Tier 4'));
     ALTER TABLE IF EXISTS public.all_products_clean ADD COLUMN IF NOT EXISTS range_tier TEXT;
     WITH style_stock AS (
       SELECT p.style_number,
         BOOL_OR(COALESCE(p.is_noos, FALSE) OR UPPER(COALESCE(p.tier, '')) = 'NOOS') AS is_noos,
         COALESCE(SUM(i.available), 0) AS stock_units
       FROM public.all_products_clean p
       LEFT JOIN public.all_inventory i ON i.sku=p.sku
        WHERE ${allowedBrand("p")}
          AND LOWER(COALESCE(p.status,'')) IN ('active','retired')
          AND p.style_number IS NOT NULL AND BTRIM(p.style_number) <> ''
       GROUP BY p.style_number
     )
     UPDATE public.all_products_clean p
     SET range_tier = CASE WHEN s.is_noos THEN 'NOOS' WHEN s.stock_units > 100 THEN 'Core' ELSE 'Recent' END
     FROM style_stock s
      WHERE ${allowedBrand("p")}
        AND LOWER(COALESCE(p.status,'')) IN ('active','retired')
        AND p.style_number=s.style_number AND (p.range_tier IS NULL OR BTRIM(p.range_tier)='');
     CREATE TABLE IF NOT EXISTS ${schema}.assortment_exclusions (
       season TEXT NOT NULL,
       style_id TEXT NOT NULL,
       source TEXT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       PRIMARY KEY (season, style_id, source),
       CHECK (season IN ('Q3 2026','Q4 2026')),
       CHECK (source IN ('all_products_clean','pd_styles'))
     );
     CREATE INDEX IF NOT EXISTS assortment_exclusions_season_idx ON ${schema}.assortment_exclusions (season, source);
      CREATE TABLE IF NOT EXISTS ${schema}.assortment_plan_styles (
        season TEXT NOT NULL CHECK (season IN ('Q3 2026','Q4 2026')),
        source TEXT NOT NULL CHECK (source IN ('all_products_clean','pd_styles')),
        style_key TEXT NOT NULL,
        style_number TEXT,
        pd_style_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (season, source, style_key)
      );
      CREATE INDEX IF NOT EXISTS assortment_plan_styles_season_idx
        ON ${schema}.assortment_plan_styles (season, source);
    CREATE TABLE IF NOT EXISTS ${schema}.colorways (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      hex TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Proposed',
      UNIQUE (style_id, name)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.boards (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      columns JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by INTEGER REFERENCES ${schema}.users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.board_cards (
      id SERIAL PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES ${schema}.boards(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      column_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      style_id INTEGER REFERENCES ${schema}.styles(id) ON DELETE SET NULL,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      assignees JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by INTEGER REFERENCES ${schema}.users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (board_id, title)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.board_comments (
      id SERIAL PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES ${schema}.boards(id) ON DELETE CASCADE,
      card_id INTEGER REFERENCES ${schema}.board_cards(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES ${schema}.users(id),
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.tech_packs (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL UNIQUE REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      version TEXT NOT NULL,
      owner TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notes TEXT NOT NULL DEFAULT '',
      base_pattern_reference TEXT NOT NULL DEFAULT '',
      fabric_id INTEGER REFERENCES ${schema}.fabrics(id) ON DELETE SET NULL,
      trims_accessories TEXT NOT NULL DEFAULT '',
      construction_notes TEXT NOT NULL DEFAULT '',
      audaces_file_reference TEXT NOT NULL DEFAULT '',
      modified_from_style_number TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ${schema}.fit_sessions (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      session_date DATE NOT NULL,
      fit_type TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      sample TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL DEFAULT '',
      attendees TEXT NOT NULL DEFAULT '',
      UNIQUE (style_id, fit_type)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.gradings (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      size_range TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      cad_team_member TEXT NOT NULL DEFAULT '',
      UNIQUE (style_id, size_range)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.boms (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      fabric_id INTEGER REFERENCES ${schema}.fabrics(id) ON DELETE SET NULL,
      component TEXT NOT NULL,
      consumption NUMERIC NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'm',
      status TEXT NOT NULL DEFAULT 'Draft',
      UNIQUE (style_id, component)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.samples_rework (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      sample_type TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      due_date DATE,
      notes TEXT NOT NULL DEFAULT '',
      UNIQUE (style_id, sample_type, round)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.sample_development (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      pattern_maker TEXT NOT NULL DEFAULT '',
      sample_makers TEXT NOT NULL DEFAULT '',
      units_ordered INTEGER NOT NULL DEFAULT 0,
      date_cut DATE,
      date_finished DATE,
      status TEXT NOT NULL DEFAULT 'Planned',
      rework_notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.pom_qc (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      point TEXT,
      spec NUMERIC NOT NULL DEFAULT 0,
      actual NUMERIC NOT NULL DEFAULT 0,
      tolerance NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Header',
      inspector TEXT NOT NULL DEFAULT '',
      inspected_date DATE,
      stage TEXT NOT NULL DEFAULT '',
      UNIQUE (style_id, point)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.pom_qc_rows (
      id SERIAL PRIMARY KEY,
      pom_qc_id INTEGER NOT NULL REFERENCES ${schema}.pom_qc(id) ON DELETE CASCADE,
      point TEXT NOT NULL,
      target_spec NUMERIC NOT NULL DEFAULT 0,
      tolerance NUMERIC NOT NULL DEFAULT 0,
      actual NUMERIC NOT NULL DEFAULT 0,
      pass_fail TEXT NOT NULL DEFAULT 'Pending',
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ${schema}.cost_estimates (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL UNIQUE REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      fabric NUMERIC NOT NULL DEFAULT 0,
      trims NUMERIC NOT NULL DEFAULT 0,
      labor NUMERIC NOT NULL DEFAULT 0,
      overhead NUMERIC NOT NULL DEFAULT 0,
      total NUMERIC NOT NULL DEFAULT 0,
      margin NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'KES',
      avg_mat_kg NUMERIC NOT NULL DEFAULT 0,
      avg_metres_used NUMERIC NOT NULL DEFAULT 0,
      mins_per_pc NUMERIC NOT NULL DEFAULT 0,
      efficiency_pct NUMERIC NOT NULL DEFAULT 0,
      material_cost NUMERIC NOT NULL DEFAULT 0,
      labour_cost NUMERIC NOT NULL DEFAULT 0,
      retail_price NUMERIC NOT NULL DEFAULT 0,
      margin_pct NUMERIC NOT NULL DEFAULT 0,
      cogs_ratio NUMERIC NOT NULL DEFAULT 0,
      set_sample_cost NUMERIC NOT NULL DEFAULT 0,
      variance NUMERIC NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ${schema}.stage_history (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      user_id INTEGER REFERENCES ${schema}.users(id),
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.showcases (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      season TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.showcase_frames (
      id SERIAL PRIMARY KEY,
      showcase_id INTEGER NOT NULL REFERENCES ${schema}.showcases(id) ON DELETE CASCADE,
      style_id INTEGER REFERENCES ${schema}.styles(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      image TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'style'
    );
    CREATE TABLE IF NOT EXISTS ${schema}.quarterly_plans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      quarter TEXT NOT NULL,
      year INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.plan_styles (
      plan_id INTEGER NOT NULL REFERENCES ${schema}.quarterly_plans(id) ON DELETE CASCADE,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      decision TEXT NOT NULL DEFAULT 'On plan',
      PRIMARY KEY (plan_id, style_id)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.plan_history (
      id SERIAL PRIMARY KEY,
      plan_id INTEGER NOT NULL REFERENCES ${schema}.quarterly_plans(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES ${schema}.users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.workspace_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT '',
      team TEXT NOT NULL DEFAULT '',
      date_of_birth DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.workspace_team_members (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      role_title TEXT NOT NULL,
      team_section TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      birthday DATE,
      photo_url TEXT,
      is_lma BOOLEAN NOT NULL DEFAULT FALSE,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team_section, role_title)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.workspace_resources (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL CHECK (category IN ('Technical', 'Planning', 'Strategy', 'Buying')),
      description TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      content_markdown TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by INTEGER REFERENCES ${schema}.users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS ${schema}.style_feedback_pulses (
      id BIGSERIAL PRIMARY KEY,
      style_id INTEGER REFERENCES ${schema}.styles(id) ON DELETE SET NULL,
      style_number TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('investigate','champion')),
      colourway TEXT,
      share_path TEXT NOT NULL,
      created_by INTEGER REFERENCES ${schema}.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS style_feedback_pulses_style_idx ON ${schema}.style_feedback_pulses (style_number, mode, created_at DESC);
    CREATE TABLE IF NOT EXISTS ${schema}.style_feedback (
      id BIGSERIAL PRIMARY KEY,
      submitter_name TEXT NOT NULL,
      submitter_team TEXT NOT NULL,
      style_id INTEGER REFERENCES ${schema}.styles(id) ON DELETE SET NULL,
      style_number TEXT,
      colourway TEXT NOT NULL DEFAULT 'All colourways / General',
      style_name_freetext TEXT NOT NULL DEFAULT '',
      feedback_types TEXT[] NOT NULL DEFAULT '{}',
      sentiment TEXT NOT NULL CHECK (sentiment IN ('positive', 'mixed', 'negative')),
      urgency TEXT NOT NULL CHECK (urgency IN ('note', 'discuss', 'urgent')),
      comment_text TEXT NOT NULL,
      pulse_id BIGINT REFERENCES ${schema}.style_feedback_pulses(id) ON DELETE SET NULL,
      pulse_mode TEXT CHECK (pulse_mode IN ('investigate','champion')),
      customer_origin BOOLEAN NOT NULL DEFAULT FALSE,
      customer_id TEXT,
      customer_name TEXT,
      store_name TEXT,
      reviewed BOOLEAN NOT NULL DEFAULT FALSE,
      reviewed_by INTEGER REFERENCES ${schema}.users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.style_feedback_images (
      id BIGSERIAL PRIMARY KEY,
      feedback_id BIGINT REFERENCES ${schema}.style_feedback(id) ON DELETE CASCADE,
      upload_token TEXT UNIQUE,
      object_path TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/heic','image/heif')),
      byte_size INTEGER NOT NULL CHECK (byte_size > 0),
      uploaded_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${schema}.style_feedback ADD COLUMN IF NOT EXISTS style_number TEXT;
    ALTER TABLE ${schema}.style_feedback ADD COLUMN IF NOT EXISTS colourway TEXT NOT NULL DEFAULT 'All colourways / General';
    ALTER TABLE ${schema}.style_feedback ADD COLUMN IF NOT EXISTS pulse_id BIGINT REFERENCES ${schema}.style_feedback_pulses(id) ON DELETE SET NULL;
    ALTER TABLE ${schema}.style_feedback ADD COLUMN IF NOT EXISTS pulse_mode TEXT;
    ALTER TABLE ${schema}.style_feedback ADD COLUMN IF NOT EXISTS customer_origin BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE ${schema}.style_feedback ADD COLUMN IF NOT EXISTS customer_id TEXT;
    ALTER TABLE ${schema}.style_feedback ADD COLUMN IF NOT EXISTS customer_name TEXT;
    ALTER TABLE ${schema}.style_feedback ADD COLUMN IF NOT EXISTS store_name TEXT;
    ALTER TABLE ${schema}.style_feedback_images ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ;
    DO $$ BEGIN
      ALTER TABLE ${schema}.style_feedback ADD CONSTRAINT style_feedback_pulse_mode_check CHECK (pulse_mode IS NULL OR pulse_mode IN ('investigate','champion'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS style_feedback_created_at_idx ON ${schema}.style_feedback (created_at DESC);
    CREATE INDEX IF NOT EXISTS style_feedback_style_id_idx ON ${schema}.style_feedback (style_id);
    CREATE INDEX IF NOT EXISTS style_feedback_pulse_idx ON ${schema}.style_feedback (pulse_id);
    CREATE INDEX IF NOT EXISTS style_feedback_images_feedback_idx ON ${schema}.style_feedback_images (feedback_id);
    CREATE INDEX IF NOT EXISTS style_feedback_images_expiry_idx ON ${schema}.style_feedback_images (expires_at) WHERE feedback_id IS NULL;
    DO $$ BEGIN
      CREATE TYPE ${schema}.range_plan_tier AS ENUM ('NOOS','Core','Recent','New/Test');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
    CREATE TABLE IF NOT EXISTS ${schema}.range_plan_seasons (
      id SERIAL PRIMARY KEY,
      season_name TEXT NOT NULL,
      season_year INTEGER NOT NULL,
      revenue_target_kes NUMERIC NOT NULL DEFAULT 0,
      cogs_budget_pct NUMERIC NOT NULL DEFAULT 0,
      factory_capacity_units INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (season_name, season_year)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.range_plan_rows (
      id SERIAL PRIMARY KEY,
      season_id INTEGER NOT NULL REFERENCES ${schema}.range_plan_seasons(id) ON DELETE CASCADE,
      sub_category TEXT NOT NULL,
      tier ${schema}.range_plan_tier NOT NULL,
      style_count_target INTEGER NOT NULL DEFAULT 0,
      style_count_min INTEGER NOT NULL DEFAULT 0,
      style_count_max INTEGER NOT NULL DEFAULT 0,
      aos_units INTEGER NOT NULL DEFAULT 350,
      total_units_implied INTEGER GENERATED ALWAYS AS (style_count_target * aos_units) STORED,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (season_id, sub_category)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.range_plan_otb (
      id SERIAL PRIMARY KEY,
      season_id INTEGER NOT NULL REFERENCES ${schema}.range_plan_seasons(id) ON DELETE CASCADE,
      month_year DATE NOT NULL,
      revenue_target NUMERIC,
      planned_units INTEGER,
      new_styles_count INTEGER,
      notes TEXT NOT NULL DEFAULT '',
      UNIQUE (season_id, month_year)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.garment_images (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('catalogue','plm')),
      style_key TEXT NOT NULL,
      object_path TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
      byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 8388608),
      updated_by INTEGER REFERENCES ${schema}.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source, style_key)
    );
    CREATE INDEX IF NOT EXISTS garment_images_style_key_idx ON ${schema}.garment_images (style_key);
    CREATE INDEX IF NOT EXISTS range_plan_rows_season_idx ON ${schema}.range_plan_rows (season_id, tier, id);
    CREATE INDEX IF NOT EXISTS range_plan_otb_season_month_idx ON ${schema}.range_plan_otb (season_id, month_year);
    CREATE TABLE IF NOT EXISTS ${schema}.l10_meetings (
      id SERIAL PRIMARY KEY,
      week_label TEXT NOT NULL UNIQUE,
      meeting_date DATE NOT NULL UNIQUE,
      start_time TEXT NOT NULL DEFAULT '11:30',
      end_time TEXT NOT NULL DEFAULT '13:00',
      location TEXT NOT NULL DEFAULT 'Design Board Room',
      duration_minutes INTEGER NOT NULL DEFAULT 90,
      concluded BOOLEAN NOT NULL DEFAULT FALSE,
      concluded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${schema}.l10_meetings ADD COLUMN IF NOT EXISTS concluded BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE ${schema}.l10_meetings ADD COLUMN IF NOT EXISTS concluded_at TIMESTAMPTZ;
    ALTER TABLE ${schema}.workspace_team_members ADD COLUMN IF NOT EXISTS birthday DATE;
    ALTER TABLE ${schema}.workspace_resources ADD COLUMN IF NOT EXISTS source_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.workspace_resources DROP CONSTRAINT IF EXISTS workspace_resources_category_check;
    UPDATE ${schema}.workspace_resources
      SET category = CASE category
        WHEN 'SOPs' THEN 'Planning'
        WHEN 'Reference' THEN 'Strategy'
        ELSE category
      END
      WHERE category IN ('SOPs', 'Reference');
    ALTER TABLE ${schema}.workspace_resources
      ADD CONSTRAINT workspace_resources_category_check
      CHECK (category IN ('Technical', 'Planning', 'Strategy', 'Buying'));
    CREATE TABLE IF NOT EXISTS ${schema}.l10_checkins (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES ${schema}.l10_meetings(id) ON DELETE CASCADE,
      member_name TEXT NOT NULL,
      personal_good_news TEXT NOT NULL DEFAULT '',
      professional_good_news TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (meeting_id, member_name)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.l10_scorecard_metrics (
      id SERIAL PRIMARY KEY,
      owner TEXT NOT NULL,
      measurable TEXT NOT NULL,
      goal TEXT NOT NULL,
      uom TEXT NOT NULL,
      metric_key TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (owner, measurable)
    );
    ALTER TABLE ${schema}.l10_scorecard_metrics ADD COLUMN IF NOT EXISTS metric_key TEXT;
    CREATE TABLE IF NOT EXISTS ${schema}.l10_scorecard_entries (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES ${schema}.l10_meetings(id) ON DELETE CASCADE,
      metric_id INTEGER NOT NULL REFERENCES ${schema}.l10_scorecard_metrics(id) ON DELETE CASCADE,
      value NUMERIC,
      on_track BOOLEAN,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (meeting_id, metric_id)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.l10_rocks (
      id SERIAL PRIMARY KEY,
      description TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'On Track',
      sort_order INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'workspace',
      UNIQUE (description)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.l10_agenda_notes (
      meeting_id INTEGER PRIMARY KEY REFERENCES ${schema}.l10_meetings(id) ON DELETE CASCADE,
      headlines TEXT NOT NULL DEFAULT '',
      todos TEXT NOT NULL DEFAULT '',
      ids TEXT NOT NULL DEFAULT '',
      conclude TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.l10_headlines (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES ${schema}.l10_meetings(id) ON DELETE CASCADE,
      headline TEXT NOT NULL,
      headline_date DATE,
      added_by TEXT NOT NULL DEFAULT '',
      needs_discussion BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.l10_todos (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES ${schema}.l10_meetings(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      open_date DATE,
      owner TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Not Done',
      linked_issue_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.l10_issues (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES ${schema}.l10_meetings(id) ON DELETE CASCADE,
      issue TEXT NOT NULL,
      raised_by TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 1,
      issue_type TEXT NOT NULL DEFAULT 'active',
      resolution_notes TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      resolved_at TIMESTAMPTZ,
      linked_todo_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${schema}.l10_issues ADD COLUMN IF NOT EXISTS linked_todo_id INTEGER;
    CREATE TABLE IF NOT EXISTS ${schema}.l10_ratings (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES ${schema}.l10_meetings(id) ON DELETE CASCADE,
      team_member_name TEXT NOT NULL,
      rating INTEGER CHECK (rating BETWEEN 1 AND 10),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (meeting_id, team_member_name)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.l10_cascading_messages (
      meeting_id INTEGER PRIMARY KEY REFERENCES ${schema}.l10_meetings(id) ON DELETE CASCADE,
      message TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.production_orders (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL UNIQUE REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS ${schema}.showcase_boards (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'Other',
      description TEXT NOT NULL DEFAULT '',
      creator_user_id INTEGER,
      creator_name TEXT NOT NULL DEFAULT '',
      creator_role TEXT NOT NULL DEFAULT '',
      cover_image_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.showcase_sections (
      id SERIAL PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES ${schema}.showcase_boards(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.showcase_images (
      id SERIAL PRIMARY KEY,
      section_id INTEGER,
      image_data TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'upload',
      plm_style_id INTEGER REFERENCES ${schema}.styles(id) ON DELETE SET NULL,
      caption TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ${schema}.showcase_comments (
      id SERIAL PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES ${schema}.showcase_boards(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL,
      user_role TEXT NOT NULL DEFAULT '',
      comment_text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'Core';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS sub_category TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'New';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'Concept';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS designer TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS pattern_maker TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS fabric_type TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS designer_user_id INTEGER REFERENCES ${schema}.workspace_users(id) ON DELETE SET NULL;
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS pattern_maker_user_id INTEGER REFERENCES ${schema}.workspace_users(id) ON DELETE SET NULL;
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS sample_maker_user_id INTEGER REFERENCES ${schema}.workspace_users(id) ON DELETE SET NULL;
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS buyer_user_id INTEGER REFERENCES ${schema}.workspace_users(id) ON DELETE SET NULL;
    ALTER TABLE ${schema}.workspace_users ADD COLUMN IF NOT EXISTS team TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.workspace_users ADD COLUMN IF NOT EXISTS date_of_birth DATE;
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS creative_description TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS size_range TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS trims_special_features JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS predicted_cost NUMERIC;
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS confirmed_cost NUMERIC;
    ALTER TABLE ${schema}.colorways ADD COLUMN IF NOT EXISTS code TEXT NOT NULL DEFAULT '';
    UPDATE ${schema}.styles s
    SET designer_user_id = wu.id
    FROM ${schema}.workspace_users wu
    WHERE s.designer_user_id IS NULL
      AND NULLIF(TRIM(s.owner), '') IS NOT NULL
      AND LOWER(TRIM(s.owner)) = LOWER(TRIM(wu.name));
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS base_pattern_reference TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS fabric_id INTEGER REFERENCES ${schema}.fabrics(id) ON DELETE SET NULL;
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS trims_accessories TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS construction_notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS audaces_file_reference TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS modified_from_style_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.fit_sessions ADD COLUMN IF NOT EXISTS sample TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.fit_sessions ADD COLUMN IF NOT EXISTS model_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.fit_sessions ADD COLUMN IF NOT EXISTS attendees TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.gradings ADD COLUMN IF NOT EXISTS cad_team_member TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.pom_qc ADD COLUMN IF NOT EXISTS inspector TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.pom_qc ADD COLUMN IF NOT EXISTS inspected_date DATE;
    ALTER TABLE ${schema}.pom_qc ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS avg_mat_kg NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS avg_metres_used NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS mins_per_pc NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS efficiency_pct NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS material_cost NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS labour_cost NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS retail_price NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS margin_pct NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS cogs_ratio NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS set_sample_cost NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS variance NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.pom_qc ALTER COLUMN point DROP NOT NULL;
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS style_number TEXT;
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS launch_week TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.stage_history ADD COLUMN IF NOT EXISTS source_system TEXT;
    ALTER TABLE ${schema}.stage_history ADD COLUMN IF NOT EXISTS source_movement_id BIGINT;
    ALTER TABLE ${schema}.showcase_images ADD COLUMN IF NOT EXISTS section_id INTEGER;
    ALTER TABLE ${schema}.showcase_images
      DROP CONSTRAINT IF EXISTS showcase_images_section_id_fkey;
    ALTER TABLE ${schema}.showcase_images
      ADD CONSTRAINT showcase_images_section_id_fkey
        FOREIGN KEY (section_id) REFERENCES ${schema}.showcase_sections(id)
        ON DELETE CASCADE;
    UPDATE ${schema}.styles SET stage='Approved', stage_entered_at=COALESCE(stage_entered_at,NOW())
      WHERE status='Approved' AND stage='Concept';
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS styles_style_number_uq
      ON ${schema}.styles (style_number);
    CREATE UNIQUE INDEX IF NOT EXISTS stage_history_source_movement_uq
      ON ${schema}.stage_history (source_system, source_movement_id)
      WHERE (source_system IS NOT NULL AND source_movement_id IS NOT NULL);
  `);

  await pool.query(
    `INSERT INTO ${schema}.workspace_users (name,role,department)
     SELECT 'Wandia Gichuru','Admin','Leadership'
     WHERE NOT EXISTS (SELECT 1 FROM ${schema}.workspace_users WHERE name='Wandia Gichuru')`,
  );

  for (const [teamSection, roleTitle, description, isLma, displayOrder] of TEAM_DIRECTORY_SEEDS) {
    await pool.query(
      `INSERT INTO ${schema}.workspace_team_members
        (name,role_title,team_section,description,is_lma,display_order)
       VALUES ('',$1,$2,$3,$4,$5)
       ON CONFLICT (team_section,role_title) DO NOTHING`,
      [roleTitle, teamSection, description, isLma, displayOrder],
    );
  }

  for (const user of users) {
    await pool.query(
      `INSERT INTO ${schema}.users (name,email,role,initials,color,password_hash)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, initials=EXCLUDED.initials, color=EXCLUDED.color`,
      [user.name, user.email, user.role, user.initials, user.color, hashPassword("vivo2026", "workspace-seed")],
    );
  }

  await ensureL10Data();
  await ensureWorkspaceResources();
  await ensureRangePlanData();

  for (const fabric of fabrics) {
    await pool.query(
      `INSERT INTO ${schema}.fabrics (name,composition,mill,gsm,notes) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (name) DO NOTHING`,
      fabric,
    );
  }

  for (const style of styleSeeds) {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO ${schema}.styles (code,name,brand,category,status,owner,target_date,progress,price,market)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, owner=EXCLUDED.owner, target_date=EXCLUDED.target_date, progress=EXCLUDED.progress, price=EXCLUDED.price
       RETURNING id`,
      [...style],
    );
    const styleId = result.rows[0]?.id;
    if (!styleId) continue;
    await pool.query(
      `INSERT INTO ${schema}.tech_packs (style_id,status,version,owner,notes)
       VALUES ($1,'In progress','v0.8',$2,'Working technical pack for the Q3 decision room.')
       ON CONFLICT (style_id) DO NOTHING`,
      [styleId, style[5]],
    );
    await pool.query(
      `INSERT INTO ${schema}.colorways (style_id,name,hex,status)
       VALUES ($1,'Sandstone','#D9C4A6','Approved'),($1,'Night sky','#172536','Proposed'),($1,'Papaya','#CF6D4F','Proposed')
       ON CONFLICT DO NOTHING`,
      [styleId],
    );
    await pool.query(
      `INSERT INTO ${schema}.fit_sessions (style_id,session_date,fit_type,status,notes)
       VALUES ($1,'2026-07-09','First fit','Complete','Shoulder line approved; reduce hem sweep by 1.5cm.')
       ON CONFLICT DO NOTHING`,
      [styleId],
    );
    await pool.query(
      `INSERT INTO ${schema}.gradings (style_id,size_range,status,notes)
       VALUES ($1,'XS–XXL','Ready for review','Grade rule set v3 attached.')
       ON CONFLICT DO NOTHING`,
      [styleId],
    );
    await pool.query(
      `INSERT INTO ${schema}.samples_rework (style_id,sample_type,round,status,due_date,notes)
       VALUES ($1,'Proto',2,'In work','2026-08-18','Update sleeve pitch and confirm stitch detail.')
       ON CONFLICT DO NOTHING`,
      [styleId],
    );
    await pool.query(
      `INSERT INTO ${schema}.pom_qc (style_id,point,spec,actual,tolerance,status)
       VALUES ($1,'Bust',96,96.5,1,'Pass'),($1,'Length',124,125,1,'Review'),($1,'Hem sweep',108,108,1,'Pass')
       ON CONFLICT DO NOTHING`,
      [styleId],
    );
    await pool.query(
      `INSERT INTO ${schema}.production_orders (style_id,payload)
       VALUES ($1,$2::jsonb)
       ON CONFLICT (style_id) DO NOTHING`,
      [styleId, JSON.stringify({ status: "Not released", orderNumber: `PO-${style[0]}`, quantity: 180, deliveryWindow: "Q3 2026", markets: ["Kenya", "Uganda", "Rwanda"] })],
    );
  }

  const fabricsResult = await pool.query<{ id: number }>(`SELECT id FROM ${schema}.fabrics ORDER BY id LIMIT 8`);
  const styleResult = await pool.query<{ id: number }>(`SELECT id FROM ${schema}.styles ORDER BY id`);
  for (let i = 0; i < Math.min(10, styleResult.rows.length); i += 1) {
    const sid = styleResult.rows[i]?.id;
    const fid = fabricsResult.rows[i % fabricsResult.rows.length]?.id;
    if (!sid || !fid) continue;
    await pool.query(
      `INSERT INTO ${schema}.boms (style_id,fabric_id,component,consumption,unit,status)
       VALUES ($1,$2,'Main fabric',$3,'m','Approved')
       ON CONFLICT DO NOTHING`,
      [sid, fid, 1.25 + (i % 4) * 0.18],
    );
    await pool.query(
      `INSERT INTO ${schema}.cost_estimates (style_id,fabric,trims,labor,overhead,total,margin)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (style_id) DO NOTHING`,
      [sid, 1550 + i * 85, 420 + i * 22, 680 + i * 30, 260 + i * 12, 2910 + i * 149, 58 - i * 0.7],
    );
  }

  const firstUser = await pool.query<{ id: number }>(`SELECT id FROM ${schema}.users ORDER BY id LIMIT 1`);
  const userId = firstUser.rows[0]?.id ?? null;
  for (const board of boardSeeds) {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO ${schema}.boards (title,description,columns,created_by)
       SELECT $1,$2,$3::jsonb,$4
       WHERE NOT EXISTS (SELECT 1 FROM ${schema}.boards WHERE title=$1)
       RETURNING id`,
      [board[0], board[1], JSON.stringify([{ id: "brief", title: "Brief" }, { id: "deciding", title: "Deciding" }, { id: "ready", title: "Ready" }]), userId],
    );
    const boardId = result.rows[0]?.id;
    if (boardId) {
      await pool.query(
        `INSERT INTO ${schema}.board_cards (board_id,title,description,column_id,position,style_id,tags,assignees,created_by)
         VALUES ($1,'Confirm colour story','Three colourways are ready for commercial sign-off.','deciding',0,$2,'["colour","decision"]'::jsonb,'["Leadership team"]'::jsonb,$3),
                ($1,'Review proto notes','One open fit point remains before the next sample round.','brief',1,$4,'["fit","next"]'::jsonb,'["Technical team"]'::jsonb,$3)
         ON CONFLICT DO NOTHING`,
        [boardId, styleResult.rows[0]?.id ?? null, userId, styleResult.rows[1]?.id ?? null],
      );
    }
  }

  const trendBoardInsert = await pool.query<{ id: number }>(
    `INSERT INTO ${schema}.showcase_boards
       (title,purpose,description,creator_user_id,creator_name,creator_role)
     SELECT $1,'Trend Brief',$2,NULL,'Vivo Product Team','Buying Council · Scouting Circle'
     WHERE NOT EXISTS (SELECT 1 FROM ${schema}.showcase_boards WHERE title=$1)
     RETURNING id`,
    [Q2_TREND_BOARD_TITLE, Q2_TREND_BOARD_DESCRIPTION],
  );
  const trendBoardId = trendBoardInsert.rows[0]?.id;
  if (trendBoardId) {
    for (let position = 0; position < Q2_TREND_SECTION_SEEDS.length; position += 1) {
      const [title, body] = Q2_TREND_SECTION_SEEDS[position];
      await pool.query(
        `INSERT INTO ${schema}.showcase_sections (board_id,title,body,position)
         VALUES ($1,$2,$3,$4)`,
        [trendBoardId, title, body, position],
      );
    }
  }

  const plan = await pool.query<{ id: number }>(
    `INSERT INTO ${schema}.quarterly_plans (name,quarter,year)
     SELECT 'Q3 2026 Assortment Plan','Q3',2026
     WHERE NOT EXISTS (SELECT 1 FROM ${schema}.quarterly_plans WHERE quarter='Q3' AND year=2026)
     RETURNING id`,
  );
  for (const [name, quarter] of [["Q1 2026 Assortment Plan", "Q1"], ["Q2 2026 Assortment Plan", "Q2"], ["Q4 2026 Assortment Plan", "Q4"]] as const) {
    await pool.query(
      `INSERT INTO ${schema}.quarterly_plans (name,quarter,year)
       SELECT $1,$2,2026
       WHERE NOT EXISTS (SELECT 1 FROM ${schema}.quarterly_plans WHERE quarter=$2 AND year=2026)`,
      [name, quarter],
    );
  }
  const planId = plan.rows[0]?.id ?? (await pool.query<{ id: number }>(`SELECT id FROM ${schema}.quarterly_plans WHERE quarter='Q3' AND year=2026 LIMIT 1`)).rows[0]?.id;
  if (planId) {
    for (let i = 0; i < Math.min(15, styleResult.rows.length); i += 1) {
      await pool.query(
        `INSERT INTO ${schema}.plan_styles (plan_id,style_id,position,decision) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [planId, styleResult.rows[i]?.id, i, i < 10 ? "On plan" : "Watch"],
      );
    }
    await pool.query(
      `INSERT INTO ${schema}.plan_history (plan_id,action,detail,user_id)
       SELECT $1,'Plan created','Seeded Q3 assortment plan with 15 styles.',$2
       WHERE NOT EXISTS (SELECT 1 FROM ${schema}.plan_history WHERE plan_id=$1)`,
      [planId, userId],
    );
  }

  const showcase = await pool.query<{ id: number }>(
    `INSERT INTO ${schema}.showcases (title,season,status,description)
     SELECT 'The New East','High Summer 2026','In progress','A considered edit of movement, utility, and sun-washed colour for the next Vivo story.'
     WHERE NOT EXISTS (SELECT 1 FROM ${schema}.showcases WHERE title='The New East')
     RETURNING id`,
  );
  const showcaseId = showcase.rows[0]?.id ?? (await pool.query<{ id: number }>(`SELECT id FROM ${schema}.showcases WHERE title='The New East' LIMIT 1`)).rows[0]?.id;
  if (showcaseId) {
    for (let i = 0; i < 4; i += 1) {
      await pool.query(
        `INSERT INTO ${schema}.showcase_frames (showcase_id,style_id,title,caption,image,position,kind)
         SELECT $1,$2,$3,$4,NULL,$5,'style'
         WHERE NOT EXISTS (SELECT 1 FROM ${schema}.showcase_frames WHERE showcase_id=$1 AND position=$5)`,
        [showcaseId, styleResult.rows[i]?.id ?? null, ["Sun after rain", "Soft structure", "A new utility", "The easy hour"][i], ["Linen and light", "A measured silhouette", "For the in-between days", "Unfussy, made to move"][i], i],
      );
    }
  }
}

async function findUserBySession(token?: string) {
  if (!token) return null;
  const result = await pool.query<UserRow>(
    `SELECT u.id,u.name,u.email,u.role,u.initials,u.color
     FROM ${schema}.sessions s JOIN ${schema}.users u ON u.id=s.user_id
     WHERE s.token=$1 AND s.expires_at > NOW()`,
    [token],
  );
  return result.rows[0] ?? null;
}

function requestIsHttps(req: Request) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return req.secure || forwardedProto === "https" || process.env.NODE_ENV === "production";
}

async function createSession(userId: number, req: Request, res: Response) {
  const token = sessionToken();
  await pool.query(
    `INSERT INTO ${schema}.sessions (token,user_id,expires_at) VALUES ($1,$2,NOW()+$3::interval)`,
    [token, userId, `${sessionDays} days`],
  );
  const secure = requestIsHttps(req);
  res.cookie(sessionCookie, token, {
    httpOnly: true,
    sameSite: secure ? "none" : "lax",
    secure,
    maxAge: sessionDays * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

async function requireUser(req: AuthRequest, res: Response, next: NextFunction) {
  const user = await findUserBySession(req.cookies?.[sessionCookie]);
  if (!user) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  req.workspaceUser = user;
  next();
}

function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.workspaceUser?.role !== "Admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

function teamMemberPayload(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    roleTitle: String(row.roleTitle ?? ""),
    teamSection: String(row.teamSection ?? ""),
    description: String(row.description ?? ""),
    birthday: row.birthday ? String(row.birthday).slice(0, 10) : null,
    photoUrl: row.photoPath ? `/api/workspace/team-directory/${Number(row.id)}/photo` : null,
    isLma: Boolean(row.isLma),
    displayOrder: Number(row.displayOrder ?? 0),
    createdAt: row.createdAt ?? null,
  };
}

function normalizeTeamBirthday(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^(?:\d{4}-)?(\d{2})-(\d{2})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const candidate = new Date(Date.UTC(2000, month - 1, day));
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return `2000-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeWorkspaceDateOfBirth(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const candidate = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(candidate.getTime()) || candidate.toISOString().slice(0, 10) !== raw) return null;
  return raw;
}

function storageObjectParts(objectPath: string) {
  const privateDir = String(process.env.PRIVATE_OBJECT_DIR ?? "").replace(/^\/+|\/+$/g, "");
  const relative = objectPath.replace(/^\/objects\//, "").replace(/^\/+/, "");
  const fullPath = `${privateDir}/${relative}`;
  const parts = fullPath.split("/").filter(Boolean);
  const bucketName = parts.shift();
  if (!bucketName || !parts.length) throw new Error("Invalid object storage path");
  return { bucketName, objectName: parts.join("/") };
}

async function signedStorageUrl(objectPath: string, method: "GET" | "PUT" | "DELETE", ttlSec: number) {
  const { bucketName, objectName } = storageObjectParts(objectPath);
  const response = await fetch("http://127.0.0.1:1106/object-storage/signed-object-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method,
      expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Unable to sign object storage URL (${response.status})`);
  const body = await response.json() as { signed_url?: string };
  if (!body.signed_url) throw new Error("Object storage did not return a signed URL");
  return body.signed_url;
}

const feedbackUploadAttempts = new Map<string, number[]>();
const feedbackCustomerSearchAttempts = new Map<string, number[]>();

function feedbackUploadRateKey(req: Request) {
  const peer = req.socket.remoteAddress || "unknown";
  const trustedLocalProxy = peer === "::1" || peer === "127.0.0.1" || peer.startsWith("::ffff:127.");
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((part) => part.trim()).filter(Boolean).at(-1);
  return trustedLocalProxy && forwarded ? forwarded : peer;
}

function allowFeedbackUpload(req: Request, bucket: "handshake" | "transfer", limit: number) {
  const now = Date.now();
  const key = `${bucket}:${feedbackUploadRateKey(req)}`;
  const recent = (feedbackUploadAttempts.get(key) ?? []).filter((timestamp) => now - timestamp < FEEDBACK_IMAGE_UPLOAD_RATE_WINDOW_MS);
  if (recent.length >= limit) {
    feedbackUploadAttempts.set(key, recent);
    return false;
  }
  recent.push(now);
  feedbackUploadAttempts.set(key, recent);
  if (feedbackUploadAttempts.size > 1000) {
    for (const [candidate, timestamps] of feedbackUploadAttempts) {
      if (!timestamps.length || now - timestamps[timestamps.length - 1] > FEEDBACK_IMAGE_UPLOAD_RATE_WINDOW_MS) feedbackUploadAttempts.delete(candidate);
    }
  }
  return true;
}

function allowFeedbackUploadHandshake(req: Request) {
  return allowFeedbackUpload(req, "handshake", FEEDBACK_IMAGE_UPLOAD_RATE_LIMIT);
}

function allowFeedbackCustomerSearch(req: Request) {
  const now = Date.now();
  const key = feedbackUploadRateKey(req);
  const recent = (feedbackCustomerSearchAttempts.get(key) ?? [])
    .filter((timestamp) => now - timestamp < FEEDBACK_CUSTOMER_SEARCH_RATE_WINDOW_MS);
  if (recent.length >= FEEDBACK_CUSTOMER_SEARCH_RATE_LIMIT) {
    feedbackCustomerSearchAttempts.set(key, recent);
    return false;
  }
  recent.push(now);
  feedbackCustomerSearchAttempts.set(key, recent);
  if (feedbackCustomerSearchAttempts.size > 1000) {
    for (const [candidate, timestamps] of feedbackCustomerSearchAttempts) {
      if (!timestamps.length || now - timestamps[timestamps.length - 1] > FEEDBACK_CUSTOMER_SEARCH_RATE_WINDOW_MS) {
        feedbackCustomerSearchAttempts.delete(candidate);
      }
    }
  }
  return true;
}

async function deleteFeedbackObject(objectPath: string) {
  try {
    const response = await fetch(await signedStorageUrl(objectPath, "DELETE", 120), { method: "DELETE", signal: AbortSignal.timeout(30_000) });
    if (!response.ok && response.status !== 404) throw new Error(`Object storage returned ${response.status}`);
    return true;
  } catch (error) {
    console.warn("Unable to remove rejected feedback image", error);
    return false;
  }
}

async function cleanupExpiredFeedbackImageUploads() {
  const expired = await pool.query<{ id: number; objectPath: string }>(
    `SELECT id,object_path AS "objectPath"
       FROM ${schema}.style_feedback_images
      WHERE feedback_id IS NULL AND expires_at <= NOW()`,
  );
  for (const item of expired.rows) {
    if (await deleteFeedbackObject(item.objectPath)) {
      await pool.query(`DELETE FROM ${schema}.style_feedback_images WHERE id=$1 AND feedback_id IS NULL AND expires_at <= NOW()`, [item.id]);
    }
  }
}

async function discardPendingFeedbackImage(id: number) {
  const pending = await pool.query<{ objectPath: string }>(
    `SELECT object_path AS "objectPath"
       FROM ${schema}.style_feedback_images
      WHERE id=$1 AND feedback_id IS NULL`,
    [id],
  );
  const item = pending.rows[0];
  if (!item) return;
  if (await deleteFeedbackObject(item.objectPath)) {
    await pool.query(`DELETE FROM ${schema}.style_feedback_images WHERE id=$1 AND feedback_id IS NULL`, [id]);
  } else {
    await pool.query(`UPDATE ${schema}.style_feedback_images SET expires_at=NOW() WHERE id=$1 AND feedback_id IS NULL`, [id]);
  }
}

async function readFeedbackImageAtMost(response: globalThis.Response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > FEEDBACK_IMAGE_MAX_BYTES) throw new Error("Uploaded image exceeds the maximum size");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

const GARMENT_IMAGE_TYPES = {
  "image/jpeg": { extensions: ["jpg", "jpeg"], magic: (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  "image/png": { extensions: ["png"], magic: (bytes: Uint8Array) => bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) },
  "image/webp": { extensions: ["webp"], magic: (bytes: Uint8Array) => bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP" },
} as const;
type GarmentImageSource = "catalogue" | "plm";
const garmentImageSource = (value: unknown): GarmentImageSource | null =>
  value === "catalogue" || value === "plm" ? value : null;
const garmentImageKey = (value: unknown) => String(value ?? "").trim().toLowerCase();
const garmentImageUrl = (source: GarmentImageSource, styleKey: string) =>
  `/api/workspace/garment-images/${source}/${encodeURIComponent(styleKey)}`;

async function applyGarmentImageOverrides<T extends Record<string, unknown>>(
  rows: T[],
  source: GarmentImageSource,
  keyFor: (row: T) => unknown,
) {
  const keys = [...new Set(rows.map((row) => garmentImageKey(keyFor(row))).filter(Boolean))];
  if (!keys.length) return rows;
  const result = await pool.query<{ styleKey: string }>(
    `SELECT style_key AS "styleKey" FROM ${schema}.garment_images
     WHERE source=$1 AND style_key=ANY($2::text[])`,
    [source, keys],
  );
  const available = new Set(result.rows.map((row) => row.styleKey));
  return rows.map((row) => {
    const key = garmentImageKey(keyFor(row));
    return available.has(key) ? { ...row, image: garmentImageUrl(source, key) } : row;
  });
}

function validateGarmentImageMeta(name: unknown, size: unknown, contentType: unknown) {
  const originalName = String(name ?? "").trim();
  const byteSize = Number(size ?? 0);
  const type = String(contentType ?? "").trim().toLowerCase() as keyof typeof GARMENT_IMAGE_TYPES;
  if (!originalName || originalName.length > 255 || !Number.isFinite(byteSize) || byteSize < 1 || byteSize > 8 * 1024 * 1024) {
    return { error: "Image must be between 1 byte and 8 MB" } as const;
  }
  const config = GARMENT_IMAGE_TYPES[type];
  if (!config) return { error: "Use a JPEG, PNG, or WebP image" } as const;
  const extension = originalName.split(".").pop()?.toLowerCase();
  if (!extension || !config.extensions.includes(extension as never)) return { error: "The file extension does not match its image type" } as const;
  return { originalName, byteSize, contentType: type } as const;
}

async function deleteGarmentObject(objectPath: string | null | undefined) {
  if (!objectPath) return;
  try {
    await fetch(await signedStorageUrl(objectPath, "DELETE", 120), { method: "DELETE", signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    // A failed cleanup leaves an inaccessible orphan, never a stale primary record.
    console.warn("Unable to clean up replaced garment image", error);
  }
}

function isPlmStage(value: unknown): value is PlmStage {
  return typeof value === "string" && (PLM_ALL_STAGES as readonly string[]).includes(value);
}

function nextStage(stage: string) {
  const index = PLM_STAGES.indexOf(stage as (typeof PLM_STAGES)[number]);
  return index >= 0 && index < PLM_STAGES.length - 1 ? PLM_STAGES[index + 1] : null;
}

function previousStage(stage: string) {
  const index = PLM_STAGES.indexOf(stage as (typeof PLM_STAGES)[number]);
  return index > 0 ? PLM_STAGES[index - 1] : null;
}

function stageProgress(stage: string) {
  const index = PLM_STAGES.indexOf(stage as (typeof PLM_STAGES)[number]);
  return index < 0 ? 0 : Math.round((index / (PLM_STAGES.length - 1)) * 100);
}

async function getStyle(id: number) {
  const result = await pool.query(
    `SELECT s.id,s.code,s.name,s.brand,s.category,s.sub_category AS "subCategory",s.theme,s.order_type AS "orderType",
       s.tier,COALESCE(NULLIF(TRIM(pd.season),''),'Q3 2026') AS season,
       s.launch_route AS "launchRoute",s.style_classification AS "styleClassification",
       s.range_tier AS "rangeTier",s.status,s.stage,s.stage AS "currentStage",s.owner,s.designer,s.pattern_maker AS "patternMaker",
       s.fabric_type AS "fabricType",
       COALESCE(pdd.id,du.id) AS "designUserId",
       COALESCE(pdp.id,pm.id) AS "patternUserId",
       pdc.id AS "cadUserId",
       COALESCE(pds.id,sm.id) AS "sampleUserId",
       COALESCE(pdb.id,bu.id) AS "buyingUserId",
       s.creative_description AS "creativeDescription",s.size_range AS "sizeRange",
       s.trims_special_features AS "trimsSpecialFeatures",s.predicted_cost::float AS "predictedCost",
       s.confirmed_cost::float AS "confirmedCost",
       jsonb_build_object(
         'design', CASE WHEN COALESCE(pdd.id,du.id) IS NULL THEN NULL ELSE jsonb_build_object('id',COALESCE(pdd.id,du.id),'name',COALESCE(pdd.name,du.name),'role',COALESCE(pdd.role,du.role),'department',COALESCE(pdd.department,du.department)) END,
         'pattern', CASE WHEN COALESCE(pdp.id,pm.id) IS NULL THEN NULL ELSE jsonb_build_object('id',COALESCE(pdp.id,pm.id),'name',COALESCE(pdp.name,pm.name),'role',COALESCE(pdp.role,pm.role),'department',COALESCE(pdp.department,pm.department)) END,
         'cad', CASE WHEN pdc.id IS NULL THEN NULL ELSE jsonb_build_object('id',pdc.id,'name',pdc.name,'role',pdc.role,'department',pdc.department) END,
         'sample', CASE WHEN COALESCE(pds.id,sm.id) IS NULL THEN NULL ELSE jsonb_build_object('id',COALESCE(pds.id,sm.id),'name',COALESCE(pds.name,sm.name),'role',COALESCE(pds.role,sm.role),'department',COALESCE(pds.department,sm.department)) END,
         'buying', CASE WHEN COALESCE(pdb.id,bu.id) IS NULL THEN NULL ELSE jsonb_build_object('id',COALESCE(pdb.id,bu.id),'name',COALESCE(pdb.name,bu.name),'role',COALESCE(pdb.role,bu.role),'department',COALESCE(pdb.department,bu.department)) END
       ) AS "styleTeam",
        to_char(s.target_date,'YYYY-MM-DD') AS "targetDate",
        pd.target_order_week AS "targetOrderWeek",
        NULL::text AS "plannedLaunchWeek",
       to_char(s.stage_entered_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "stageEnteredAt",
       GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-s.stage_entered_at))/86400))::int AS "daysInStage",
       s.image,s.progress::float,s.price::float,s.market
     FROM ${schema}.styles s
      LEFT JOIN (
         SELECT style_number, MAX(NULLIF(TRIM(target_order_week), '')) AS target_order_week,
           MAX(NULLIF(TRIM(launch_route), '')) AS launch_route,
           MAX(NULLIF(TRIM(style_classification), '')) AS style_classification,
            MAX(NULLIF(TRIM(range_tier), '')) AS range_tier,
            MAX(NULLIF(TRIM(season), '')) AS season,
            MAX(NULLIF(TRIM(design_owner), '')) AS design_owner,
            MAX(NULLIF(TRIM(pattern_owner), '')) AS pattern_owner,
            MAX(NULLIF(TRIM(cad_owner), '')) AS cad_owner,
            MAX(NULLIF(TRIM(sample_owner), '')) AS sample_owner,
            MAX(NULLIF(TRIM(buying_owner), '')) AS buying_owner
         FROM public.pd_styles p
         WHERE ${allowedBrand("p")} AND p.style_number IS NOT NULL
        GROUP BY style_number
      ) pd ON pd.style_number = s.code
     LEFT JOIN ${schema}.workspace_users du ON du.id=s.designer_user_id
     LEFT JOIN ${schema}.workspace_users pm ON pm.id=s.pattern_maker_user_id
     LEFT JOIN ${schema}.workspace_users sm ON sm.id=s.sample_maker_user_id
     LEFT JOIN ${schema}.workspace_users bu ON bu.id=s.buyer_user_id
     LEFT JOIN ${schema}.workspace_users pdd ON LOWER(TRIM(pdd.name))=LOWER(TRIM(pd.design_owner))
     LEFT JOIN ${schema}.workspace_users pdp ON LOWER(TRIM(pdp.name))=LOWER(TRIM(pd.pattern_owner))
     LEFT JOIN ${schema}.workspace_users pdc ON LOWER(TRIM(pdc.name))=LOWER(TRIM(pd.cad_owner))
     LEFT JOIN ${schema}.workspace_users pds ON LOWER(TRIM(pds.name))=LOWER(TRIM(pd.sample_owner))
     LEFT JOIN ${schema}.workspace_users pdb ON LOWER(TRIM(pdb.name))=LOWER(TRIM(pd.buying_owner))
      WHERE s.id=$1 AND ${allowedBrand("s")}`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function styleDetail(id: number) {
  const style = await getStyle(id);
  if (!style) return null;
  const [colorways, styleFabrics, techPack, fitSessions, gradings, boms, samples, pomQcHeader, pomQcRows, legacyPomQc, costEstimate, productionOrder, stageHistory] = await Promise.all([
     pool.query(`SELECT id,name,hex,code,status FROM ${schema}.colorways WHERE style_id=$1 ORDER BY id`, [id]),
    pool.query(`SELECT f.id,f.name,f.composition,f.mill,f.gsm,f.notes FROM ${schema}.boms b JOIN ${schema}.fabrics f ON f.id=b.fabric_id WHERE b.style_id=$1 ORDER BY b.id`, [id]),
    pool.query(`SELECT id,status,version,owner,to_char(updated_at,'YYYY-MM-DD') AS "updatedAt",notes,
       base_pattern_reference AS "basePatternReference",fabric_id AS "fabricId",trims_accessories AS "trimsAccessories",
       construction_notes AS "constructionNotes",audaces_file_reference AS "audacesFileReference",
       modified_from_style_number AS "modifiedFromStyleNumber"
       FROM ${schema}.tech_packs WHERE style_id=$1`, [id]),
    pool.query(`SELECT id,to_char(session_date,'YYYY-MM-DD') AS "sessionDate",fit_type AS "fitType",sample,
       model_name AS "modelName",attendees,status AS outcome,notes AS comments
       FROM ${schema}.fit_sessions WHERE style_id=$1 ORDER BY session_date DESC`, [id]),
    pool.query(`SELECT id,size_range AS "sizeRange",status,cad_team_member AS "cadTeamMember",notes FROM ${schema}.gradings WHERE style_id=$1 ORDER BY id`, [id]),
    pool.query(`SELECT b.id,b.component,b.consumption::float,b.unit,b.status,f.name AS fabric FROM ${schema}.boms b LEFT JOIN ${schema}.fabrics f ON f.id=b.fabric_id WHERE b.style_id=$1 ORDER BY b.id`, [id]),
    pool.query(`SELECT id,purpose,pattern_maker AS "patternMaker",sample_makers AS "sampleMakers",units_ordered AS "unitsOrdered",
       to_char(date_cut,'YYYY-MM-DD') AS "dateCut",to_char(date_finished,'YYYY-MM-DD') AS "dateFinished",status,rework_notes AS "reworkNotes"
       FROM ${schema}.sample_development WHERE style_id=$1 ORDER BY id DESC`, [id]),
    pool.query(`SELECT id,inspector,to_char(inspected_date,'YYYY-MM-DD') AS "inspectedDate",stage
       FROM ${schema}.pom_qc WHERE style_id=$1 AND point IS NULL ORDER BY id DESC LIMIT 1`, [id]),
    pool.query(`SELECT r.id,r.point,r.target_spec::float AS "targetSpec",r.tolerance::float,r.actual::float,
       r.pass_fail AS "passFail",r.notes
       FROM ${schema}.pom_qc_rows r JOIN ${schema}.pom_qc q ON q.id=r.pom_qc_id
       WHERE q.style_id=$1 ORDER BY r.id`, [id]),
    pool.query(`SELECT id,point,spec::float,actual::float,tolerance::float,status FROM ${schema}.pom_qc WHERE style_id=$1 AND point IS NOT NULL ORDER BY id`, [id]),
     pool.query(`SELECT fabric::float,trims::float,labor::float,overhead::float,total::float AS "totalCost",total::float,margin::float,currency,
       avg_mat_kg::float AS "avgMatKg",avg_metres_used::float AS "avgMetresUsed",mins_per_pc::float AS "minsPerPc",
       efficiency_pct::float AS "efficiencyPct",material_cost::float AS "materialCost",labour_cost::float AS "labourCost",
       retail_price::float AS "retailPrice",margin_pct::float AS "marginPct",cogs_ratio::float AS "cogsRatio",
       set_sample_cost::float AS "setSampleCost",variance::float
       FROM ${schema}.cost_estimates WHERE style_id=$1`, [id]),
    pool.query(`SELECT payload FROM ${schema}.production_orders WHERE style_id=$1`, [id]),
    pool.query(`SELECT h.id,h.style_id AS "styleId",h.from_stage AS "fromStage",h.to_stage AS "toStage",
       h.user_id AS "userId",COALESCE(u.name,'System') AS "userName",h.note,
       to_char(h.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp
       FROM ${schema}.stage_history h LEFT JOIN ${schema}.users u ON u.id=h.user_id
       WHERE h.style_id=$1 ORDER BY h.created_at DESC,h.id DESC`, [id]),
  ]);
  const pomQc = pomQcRows.rows.length ? {
    ...(pomQcHeader.rows[0] ?? {}),
    rows: pomQcRows.rows,
  } : { ...(pomQcHeader.rows[0] ?? {}), rows: legacyPomQc.rows };
  return {
    ...style,
    colorways: colorways.rows,
    fabrics: styleFabrics.rows,
    techPack: techPack.rows[0] ?? {},
    fitSessions: fitSessions.rows,
    gradings: gradings.rows,
    boms: boms.rows,
    samples: samples.rows,
    pomQc,
    costEstimate: costEstimate.rows[0] ?? {},
    productionOrder: productionOrder.rows[0]?.payload ?? {},
    stageHistory: stageHistory.rows,
  };
}

async function planPayload(planId: number) {
  const plan = await pool.query(`SELECT id,name,quarter,year,status FROM ${schema}.quarterly_plans WHERE id=$1`, [planId]);
  const row = plan.rows[0];
  if (!row) return null;
  const styles = await pool.query(
    `SELECT s.id,s.code,s.name,s.brand,s.category,s.tier,s.status,s.owner,to_char(s.target_date,'YYYY-MM-DD') AS "targetDate",s.image,s.progress::float,s.price::float,s.market,ps.position,ps.decision
      FROM ${schema}.plan_styles ps JOIN ${schema}.styles s ON s.id=ps.style_id
      WHERE ps.plan_id=$1 AND ${allowedBrand("s")} ORDER BY ps.position,s.id`,
    [planId],
  );
  const summary = await pool.query(
    `SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE s.status='Approved')::int AS approved,
      COUNT(*) FILTER (WHERE s.status='In review')::int AS review,
      COUNT(*) FILTER (WHERE s.status='Proto')::int AS proto,
      'Balanced'::text AS "rangeShape",
      '58.2%'::text AS "targetMargin"
      FROM ${schema}.plan_styles ps JOIN ${schema}.styles s ON s.id=ps.style_id
      WHERE ps.plan_id=$1 AND ${allowedBrand("s")}`,
    [planId],
  );
  return { ...row, styles: styles.rows, summary: summary.rows[0] ?? {} };
}

router.get("/healthz", (_req, res) => res.json({ status: "ok" }));
router.get("/readyz", async (_req, res) => {
  if (serviceReady || schemaReady || await isDatabaseReachable()) {
    res.json({ status: "ok" });
    return;
  }
  res.status(503).json({ status: "starting" });
});

router.use(async (req, res, next) => {
  // The identity picker is intentionally usable during a database outage so
  // the shell can leave its first-visit loading state. Other routes continue
  // to fail closed until the database is reachable.
  if (req.path === "/team") {
    next();
    return;
  }
  if (schemaReady || await isDatabaseReachable()) {
    next();
    return;
  }
  res.status(503).json({ error: "Workspace service is starting" });
});

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const result = await pool.query<UserRow & { password_hash: string }>(
      `SELECT id,name,email,role,initials,color,password_hash FROM ${schema}.users WHERE lower(email)=lower($1)`,
      [email],
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: "Email or password not recognised" });
      return;
    }
    await createSession(user.id, req, res);
    res.json({ authenticated: true, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

router.get("/session", async (req, res, next) => {
  try {
    let user = await findUserBySession(req.cookies?.[sessionCookie]);
    if (!user) {
      const seeded = await pool.query<UserRow>(`SELECT id,name,email,role,initials,color FROM ${schema}.users ORDER BY id LIMIT 1`);
      user = seeded.rows[0] ?? null;
      if (user) await createSession(user.id, req, res);
    }
    res.json({ authenticated: Boolean(user), user: user ? publicUser(user) : null });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const token = req.cookies?.[sessionCookie];
    if (token) await pool.query(`DELETE FROM ${schema}.sessions WHERE token=$1`, [token]);
    res.clearCookie(sessionCookie, { path: "/" });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

type TeamPickerRow = {
  id: string;
  name: string;
  role: string;
  department: string;
  team: string;
  createdAt?: Date | string | null;
  dateOfBirth?: Date | string | null;
};

function mergeTeamPickerRows(rows: Array<Partial<TeamPickerRow>>) {
  const merged = new Map<string, TeamPickerRow>();
  for (const row of rows) {
    const name = String(row.name ?? "").trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (merged.has(key)) continue;
    merged.set(key, {
      id: String(row.id ?? ""),
      name,
      role: String(row.role ?? "").trim() || "Team member",
      department: String(row.department ?? "").trim(),
      team: String(row.team ?? "").trim(),
      createdAt: row.createdAt ?? null,
      dateOfBirth: row.dateOfBirth ?? null,
    });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

async function readTeamPickerRows() {
  // The UNION is the normal path and keeps the picker independent of a name
  // match between the two tables. These aliases reflect the current Workspace
  // schema (role_title/full_name were used by older deployments).
  try {
    const result = await withTimeout(
      pool.query<TeamPickerRow>(
        `SELECT name, id::text, role_title AS role, team_section AS department,
                ''::text AS team, created_at AS "createdAt", birthday AS "dateOfBirth"
           FROM ${schema}.workspace_team_members
          WHERE name IS NOT NULL AND name != ''
         UNION
         SELECT name, id::text, role, department, team,
                created_at AS "createdAt", date_of_birth AS "dateOfBirth"
           FROM ${schema}.workspace_users
          WHERE name IS NOT NULL AND name != ''
         ORDER BY name`,
      ),
      4000,
      "workspace team picker union",
    );
    return mergeTeamPickerRows(result.rows);
  } catch (error) {
    console.warn("Workspace team picker UNION unavailable; reading tables independently", error);
  }

  // Keep each table isolated: a missing table or a legacy column name must not
  // prevent the other table from supplying the login choices.
  const rows: Array<Partial<TeamPickerRow>> = [];
  try {
    const result = await withTimeout(
      pool.query<TeamPickerRow>(
        `SELECT name, id::text, role_title AS role, team_section AS department,
                ''::text AS team, created_at AS "createdAt", birthday AS "dateOfBirth"
           FROM ${schema}.workspace_team_members
          WHERE name IS NOT NULL AND name != ''`,
      ),
      4000,
      "workspace team members picker lookup",
    );
    rows.push(...result.rows);
  } catch (error) {
    console.warn("Workspace team members picker lookup failed", error);
    try {
      const result = await withTimeout(
        pool.query<TeamPickerRow>(
          `SELECT name, id::text, role
             FROM ${schema}.workspace_team_members
            WHERE name IS NOT NULL AND name != ''`,
        ),
        4000,
        "legacy workspace team members picker lookup",
      );
      rows.push(...result.rows);
    } catch (legacyError) {
      console.warn("Legacy workspace team members picker lookup failed", legacyError);
    }
  }
  try {
    const result = await withTimeout(
      pool.query<TeamPickerRow>(
        `SELECT full_name AS name, id::text, role
           FROM ${schema}.workspace_users
          WHERE full_name IS NOT NULL AND full_name != ''`,
      ),
      4000,
      "workspace users full name picker lookup",
    );
    rows.push(...result.rows);
  } catch (error) {
    console.warn("Workspace users full name picker lookup failed; trying name", error);
    try {
      const result = await withTimeout(
        pool.query<TeamPickerRow>(
          `SELECT name, id::text, role, department, team,
                  created_at AS "createdAt", date_of_birth AS "dateOfBirth"
             FROM ${schema}.workspace_users
            WHERE name IS NOT NULL AND name != ''`,
        ),
        4000,
        "workspace users picker lookup",
      );
      rows.push(...result.rows);
    } catch (legacyError) {
      console.warn("Workspace users picker lookup failed", legacyError);
    }
  }
  return mergeTeamPickerRows(rows);
}

async function readTeamMemberDebug() {
  const output = {
    workspace_team_members: { count: 0, names: [] as string[] },
    workspace_users: { count: 0, names: [] as string[] },
    errors: {} as Record<string, string>,
  };
  try {
    const result = await withTimeout(
      pool.query<{ name: string }>(
        `SELECT name FROM ${schema}.workspace_team_members
         WHERE name IS NOT NULL AND name != '' ORDER BY name`,
      ),
      4000,
      "workspace team members debug lookup",
    );
    output.workspace_team_members = { count: result.rows.length, names: result.rows.map((row) => row.name) };
  } catch (error) {
    output.errors.workspace_team_members = error instanceof Error ? error.message : String(error);
  }
  try {
    const result = await withTimeout(
      pool.query<{ name: string }>(
        `SELECT name FROM ${schema}.workspace_users
         WHERE name IS NOT NULL AND name != '' ORDER BY name`,
      ),
      4000,
      "workspace users debug lookup",
    );
    output.workspace_users = { count: result.rows.length, names: result.rows.map((row) => row.name) };
  } catch (error) {
    output.errors.workspace_users = error instanceof Error ? error.message : String(error);
  }
  return output;
}

// Team directory — read is intentionally public within the workspace app: the
// first-visit "Who are you?" selector needs the list before any identity or
// session exists. Mutations sit behind the session gate below.
router.get("/team", async (_req, res, next) => {
  try {
    res.json(await readTeamPickerRows());
  } catch (error) {
    next(error);
  }
});

const FEEDBACK_TEAM_OPTIONS = [
  "Vivo Sarit",
  "Vivo Junction",
  "Vivo Moi Avenue",
  "Vivo Mama Ngina St",
  "Vivo Yaya",
  "Vivo Village Market",
  "Vivo Garden City",
  "Vivo Kigali Heights",
  "Vivo Acacia",
  "Vivo Galleria",
  "Vivo Capital Centre",
  "Vivo Two Rivers",
  "Vivo Imaara",
  "Vivo Hub",
  "Vivo Runda",
  "Vivo TRM",
  "Vivo Nakuru",
  "Vivo City Mall",
  "Vivo Eldoret",
  "The Oasis Mall",
  "Vivo Kisumu",
  "Vivo Signature Mall",
  "Safari Sarit & Zoya",
  "Vivo MSA Digo Road",
  "Vivo Kileleshwa",
  "Vivo T-Mall",
  "Vivo Greenspan",
  "Vivo Meru",
  "Online Team",
  "Marketing Team",
  "Customer Service",
  "Other",
] as const;
const FEEDBACK_TYPE_OPTIONS = ["Sizing", "Fit", "Fabric Quality", "Stitching Quality", "Price", "Stock Availability", "Style Adjustments", "Colour & Print", "Other"] as const;
const PULSE_INVESTIGATE_OPTIONS = ["Fit doesn't work for our customer", "Fabric feels low quality", "Price feels too high", "Colour/print not right for this market", "Poor VM / hard to style on the floor", "Customers haven't noticed it", "Size availability issues", "Strong competition from another style", "Other"] as const;
const PULSE_CHAMPION_OPTIONS = ["The fit is excellent", "Fabric quality stands out", "Great value for money", "Colour/print is a hit", "Versatile — works for multiple occasions", "Customers are recommending it to others", "Strong repeat purchases", "VM / styling is working well", "Other"] as const;
const PULSE_MODES = ["investigate", "champion"] as const;
type PulseMode = (typeof PULSE_MODES)[number];
const FEEDBACK_SENTIMENTS = ["positive", "mixed", "negative"] as const;
const FEEDBACK_URGENCIES = ["note", "discuss", "urgent"] as const;
type FeedbackSentiment = (typeof FEEDBACK_SENTIMENTS)[number];
type FeedbackUrgency = (typeof FEEDBACK_URGENCIES)[number];

function feedbackPayload(row: Record<string, unknown>) {
  const rawAttachments = Array.isArray(row.imageAttachments) ? row.imageAttachments : [];
  return {
    id: Number(row.id),
    submitterName: String(row.submitterName ?? ""),
    submitterTeam: String(row.submitterTeam ?? ""),
    styleId: row.styleId == null ? null : Number(row.styleId),
    styleName: String(row.styleName ?? row.styleNameFreetext ?? ""),
    styleNumber: row.styleNumber == null ? null : String(row.styleNumber),
    colourway: String(row.colourway ?? "All colourways / General"),
    styleImage: row.styleImage == null ? null : String(row.styleImage),
    styleNameFreetext: String(row.styleNameFreetext ?? ""),
    pulseId: row.pulseId == null ? null : Number(row.pulseId),
    pulseMode: row.pulseMode == null ? null : String(row.pulseMode) as PulseMode,
    customerOrigin: Boolean(row.customerOrigin),
    customerId: row.customerId == null ? null : String(row.customerId),
    customerName: String(row.customerName ?? ""),
    storeName: row.storeName == null ? null : String(row.storeName),
    feedbackTypes: Array.isArray(row.feedbackTypes) ? row.feedbackTypes.map(String) : [],
    sentiment: String(row.sentiment ?? "mixed") as FeedbackSentiment,
    urgency: String(row.urgency ?? "note") as FeedbackUrgency,
    commentText: String(row.commentText ?? ""),
    reviewed: Boolean(row.reviewed),
    reviewedBy: row.reviewedBy == null ? null : Number(row.reviewedBy),
    reviewedAt: row.reviewedAt ?? null,
    createdAt: row.createdAt ?? null,
    imageAttachments: rawAttachments.map((attachment) => {
      const item = attachment as Record<string, unknown>;
      return {
        id: Number(item.id),
        filename: String(item.filename ?? "feedback-image"),
        contentType: String(item.contentType ?? "application/octet-stream"),
        sizeBytes: Number(item.sizeBytes ?? 0),
        viewUrl: `/api/workspace/feedback/images/${Number(item.id)}`,
        downloadUrl: `/api/workspace/feedback/images/${Number(item.id)}?download=1`,
      };
    }),
  };
}

router.post("/feedback/public/upload-url", async (req, res, next) => {
  try {
    if (!allowFeedbackUploadHandshake(req)) {
      res.setHeader("Retry-After", "600");
      res.status(429).json({ error: "Too many image upload attempts. Please try again in a few minutes." });
      return;
    }
    await cleanupExpiredFeedbackImageUploads();
    const validation = validateFeedbackImageMeta(req.body?.name, req.body?.size, req.body?.contentType);
    if ("error" in validation) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const uploadToken = sessionToken();
    const objectPath = `/objects/style-feedback/${crypto.randomUUID()}.${feedbackImageExtension(validation.originalName)}`;
    await pool.query(
      `INSERT INTO ${schema}.style_feedback_images
        (upload_token,object_path,original_name,content_type,byte_size,uploaded_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,NULL,NOW()+$6::interval)`,
      [uploadToken, objectPath, validation.originalName, validation.declaredType, validation.byteSize, `${FEEDBACK_IMAGE_UPLOAD_TTL_SECONDS} seconds`],
    );
    res.status(201).json({ uploadUrl: "/api/workspace/feedback/public/upload", uploadToken, expiresInSeconds: FEEDBACK_IMAGE_UPLOAD_TTL_SECONDS });
  } catch (error) {
    next(error);
  }
});

const feedbackImageUploadBody = express.raw({ type: () => true, limit: FEEDBACK_IMAGE_MAX_BYTES });
router.put("/feedback/public/upload", (req, res, next) => {
  if (!allowFeedbackUpload(req, "transfer", FEEDBACK_IMAGE_UPLOAD_RATE_LIMIT * 2)) {
    res.setHeader("Retry-After", "600");
    res.status(429).json({ error: "Too many image upload attempts. Please try again in a few minutes." });
    return;
  }
  feedbackImageUploadBody(req, res, (error) => {
    if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
      res.status(413).json({ error: `Images must be smaller than ${FEEDBACK_IMAGE_MAX_BYTES / (1024 * 1024)} MB` });
      return;
    }
    next(error);
  });
}, async (req, res, next) => {
  let imageId: number | null = null;
  try {
    const uploadToken = String(req.header("x-feedback-upload-token") ?? "");
    if (!/^[a-f0-9]{64}$/.test(uploadToken) || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Invalid feedback image upload" });
      return;
    }
    const pending = await pool.query<{ id: number; objectPath: string; contentType: FeedbackImageContentType; byteSize: number }>(
      `SELECT id,object_path AS "objectPath",content_type AS "contentType",byte_size AS "byteSize"
         FROM ${schema}.style_feedback_images
        WHERE upload_token=$1 AND feedback_id IS NULL AND uploaded_at IS NULL AND expires_at > NOW()
        FOR UPDATE`,
      [uploadToken],
    );
    const image = pending.rows[0];
    if (!image) {
      res.status(404).json({ error: "This image upload has expired. Please choose the file again." });
      return;
    }
    imageId = image.id;
    const requestType = String(req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const bytes = new Uint8Array(req.body);
    const validation = validateFeedbackImageUpload(bytes, image.byteSize, image.contentType, requestType);
    if ("error" in validation) {
      await discardPendingFeedbackImage(image.id);
      imageId = null;
      res.status(400).json({ error: `${validation.error}. Please choose it again.` });
      return;
    }
    const stored = await fetch(await signedStorageUrl(image.objectPath, "PUT", 180), {
      method: "PUT",
      headers: { "Content-Type": image.contentType, "Content-Length": String(bytes.length) },
      body: bytes,
      signal: AbortSignal.timeout(30_000),
    });
    if (!stored.ok) throw new Error(`Unable to store feedback image (${stored.status})`);
    await pool.query(
      `UPDATE ${schema}.style_feedback_images SET uploaded_at=NOW() WHERE id=$1 AND feedback_id IS NULL AND uploaded_at IS NULL`,
      [image.id],
    );
    imageId = null;
    res.status(204).end();
  } catch (error) {
    if (imageId != null) await discardPendingFeedbackImage(imageId).catch(() => undefined);
    next(error);
  }
});

function feedbackImagePayload(value: unknown) {
  if (value == null || value === "") return null;
  const image = String(value);
  if (/^(data:|https?:|blob:|\/(?!9j\/))/.test(image)) return image;
  return `data:image/jpeg;base64,${image}`;
}

async function feedbackStyleSearch(q: string) {
  const search = `%${q.trim()}%`;
  const result = await pool.query(
    `SELECT ws.id,
       COALESCE(NULLIF(TRIM(ws.name),''), MAX(apc.style_name), 'Unassigned style') AS name,
       COALESCE(NULLIF(TRIM(ws.code),''), MAX(apc.style_number)) AS code,
       COALESCE(ws.image, img.image) AS image,
       COALESCE(ws.status, MAX(apc.status)) AS status
     FROM public.all_products_clean apc
     LEFT JOIN LATERAL (
       SELECT s.id,s.name,s.code,s.status,s.image
       FROM ${schema}.styles s
       WHERE ${allowedBrand("s")}
         AND (LOWER(s.code)=LOWER(NULLIF(TRIM(apc.style_number),''))
          OR LOWER(s.name)=LOWER(NULLIF(TRIM(apc.style_name),''))
         )
       ORDER BY CASE WHEN LOWER(s.code)=LOWER(NULLIF(TRIM(apc.style_number),'')) THEN 0 ELSE 1 END, s.id
       LIMIT 1
     ) ws ON TRUE
      LEFT JOIN LATERAL (
        SELECT i.image_512 AS image
        FROM public.all_products_clean image_product
        JOIN public.product_image_map image_map ON image_map.sku = image_product.sku
        JOIN public.product_images i ON i.tmpl_id = image_map.tmpl_id
        WHERE ${allowedBrand("image_product")}
          AND LOWER(COALESCE(image_product.status,'')) IN ('active','retired')
          AND image_product.style_number = apc.style_number
          AND i.image_512 IS NOT NULL AND i.image_512 <> ''
        ORDER BY image_product.sku
        LIMIT 1
      ) img ON TRUE
     WHERE ${allowedBrand("apc")}
       AND LOWER(COALESCE(apc.status,'')) IN ('active','retired')
       AND (apc.style_name ILIKE $1 OR apc.style_number ILIKE $1)
      GROUP BY ws.id,ws.name,ws.code,ws.status,ws.image,img.image
     ORDER BY LOWER(COALESCE(ws.name,MAX(apc.style_name))), COALESCE(ws.code,MAX(apc.style_number))
     LIMIT 30`,
    [search],
  );
  return result.rows.map((row) => ({
    id: row.id == null ? null : Number(row.id),
    name: String(row.name ?? ""),
    code: String(row.code ?? ""),
    image: feedbackImagePayload(row.image),
    status: row.status == null ? null : String(row.status),
  }));
}

async function feedbackColourways(styleNumber: string) {
  const result = await pool.query(
    `SELECT DISTINCT NULLIF(BTRIM(apc.color_print), '') AS colourway
       FROM public.all_products_clean apc
      WHERE ${allowedBrand("apc")}
        AND LOWER(COALESCE(apc.status,'')) IN ('active','retired')
        AND LOWER(BTRIM(apc.style_number)) = LOWER(BTRIM($1))
        AND NULLIF(BTRIM(apc.color_print), '') IS NOT NULL
      ORDER BY colourway`,
    [styleNumber],
  );
  return result.rows.map((row) => String(row.colourway));
}

async function feedbackCustomerSearch(q: string) {
  const result = await pool.query<{ customerId: string; name: string }>(
    `WITH customer_names AS (
       SELECT customer_id::text AS "customerId",
         MAX(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)),'')) AS name,
         BOOL_OR(COALESCE(email,'') ~* '@(vivofashiongroup|vivoactivewear|fashiongroup|shopzetu|vivowoman)\\.|^anonymous-[0-9]+@example\\.com') AS pseudo_email
       FROM public.all_customers
       WHERE customer_id IS NOT NULL AND BTRIM(customer_id::text) <> ''
       GROUP BY customer_id
     )
     SELECT "customerId",name
     FROM customer_names
     WHERE name IS NOT NULL
       AND NOT pseudo_email
       AND name !~* '(walk[ -]?in|vivo|safari|zoya|anonymous customer|cbd digo)'
       AND name ILIKE $1
     ORDER BY LOWER(name),"customerId"
     LIMIT $2`,
    [`%${q}%`, FEEDBACK_CUSTOMER_SEARCH_LIMIT],
  );
  return result.rows.map((row) => ({ id: String(row.customerId), name: String(row.name) }));
}

async function feedbackCustomerById(customerId: string) {
  const result = await pool.query<{ customerId: string; name: string }>(
    `WITH customer_name AS (
       SELECT customer_id::text AS "customerId",
         MAX(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)),'')) AS name,
         BOOL_OR(COALESCE(email,'') ~* '@(vivofashiongroup|vivoactivewear|fashiongroup|shopzetu|vivowoman)\\.|^anonymous-[0-9]+@example\\.com') AS pseudo_email
       FROM public.all_customers
       WHERE customer_id::text=$1
       GROUP BY customer_id
     )
     SELECT "customerId",name
     FROM customer_name
     WHERE name IS NOT NULL
       AND NOT pseudo_email
       AND name !~* '(walk[ -]?in|vivo|safari|zoya|anonymous customer|cbd digo)'
     LIMIT 1`,
    [customerId],
  );
  const row = result.rows[0];
  return row ? { id: String(row.customerId), name: String(row.name) } : null;
}

async function feedbackPhysicalStores() {
  const result = await pool.query<{ store: string }>(
    `SELECT DISTINCT BTRIM(location_name) AS store
       FROM public.pos_locations
      WHERE active=TRUE
        AND NULLIF(BTRIM(location_name),'') IS NOT NULL
        AND location_name NOT ILIKE '%online%'
        AND location_name NOT ILIKE '%warehouse%'
        AND location_name NOT ILIKE '%holding%'
        AND location_name NOT ILIKE '%location%'
        AND location_name NOT ILIKE '%manual%'
        AND location_name NOT ILIKE '%mockup%'
        AND location_name NOT ILIKE '%purchase%'
        AND location_name NOT ILIKE '%bags%'
        AND location_name NOT ILIKE '%third%'
        AND location_name NOT ILIKE '%popup%'
        AND location_name NOT ILIKE '%defect%'
        AND location_name <> 'Buying and Merchandise'
      ORDER BY store`,
  );
  return result.rows.map((row) => String(row.store)).filter(Boolean);
}

router.get("/feedback/styles/search", async (req, res, next) => {
  try {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) {
      res.json([]);
      return;
    }
    res.json(await feedbackStyleSearch(q));
  } catch (error) {
    next(error);
  }
});

router.get("/feedback/customers/search", async (req, res, next) => {
  try {
    const q = normalizeFeedbackCustomerName(req.query.q).slice(0, 80);
    if (q.length < FEEDBACK_CUSTOMER_SEARCH_MIN_LENGTH) {
      res.json([]);
      return;
    }
    if (!allowFeedbackCustomerSearch(req)) {
      res.setHeader("Retry-After", String(Math.ceil(FEEDBACK_CUSTOMER_SEARCH_RATE_WINDOW_MS / 1000)));
      res.status(429).json({ error: "Too many customer searches. Please wait a few minutes and try again." });
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=60");
    res.json(await feedbackCustomerSearch(q));
  } catch (error) {
    next(error);
  }
});

router.get("/feedback/stores", async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(await feedbackPhysicalStores());
  } catch (error) {
    next(error);
  }
});

router.get("/feedback/styles/:styleNumber/colourways", async (req, res, next) => {
  try {
    const styleNumber = String(req.params.styleNumber ?? "").trim();
    if (!styleNumber) {
      res.json([]);
      return;
    }
    res.json(await feedbackColourways(styleNumber));
  } catch (error) {
    next(error);
  }
});

router.get("/feedback/pulses/resolve", async (req, res, next) => {
  try {
    const styleNumber = String(req.query.style ?? "").trim();
    const mode = String(req.query.mode ?? "").trim() as PulseMode;
    if (!styleNumber || !PULSE_MODES.includes(mode)) {
      res.json({ id: null });
      return;
    }
    const result = await pool.query(
      `SELECT id,style_number AS "styleNumber",mode,colourway,share_path AS "sharePath"
         FROM ${schema}.style_feedback_pulses
        WHERE LOWER(BTRIM(style_number))=LOWER(BTRIM($1))
          AND mode=$2
        ORDER BY created_at DESC,id DESC
        LIMIT 1`,
      [styleNumber, mode],
    );
    res.json(result.rows[0] || { id: null });
  } catch (error) {
    next(error);
  }
});

router.post("/feedback/public", async (req, res, next) => {
  let pendingObjects: Array<{ id: number; objectPath: string }> = [];
  try {
    const submitterName = String(req.body?.submitterName ?? "").trim();
    const submitterTeam = String(req.body?.submitterTeam ?? "").trim();
    const requestedStyleName = String(req.body?.styleName ?? "").trim();
    const requestedStyleNumber = String(req.body?.styleNumber ?? "").trim();
    const requestedColourway = String(req.body?.colourway ?? "").trim() || "All colourways / General";
    const customerOrigin = feedbackCustomerOrigin(req.body?.customerOrigin);
    let customerId = customerOrigin ? normalizeFeedbackCustomerId(req.body?.customerId) : "";
    let customerName = customerOrigin ? normalizeFeedbackCustomerName(req.body?.customerName) : "";
    let storeName = submitterTeam === "Retail" ? String(req.body?.storeName ?? "").trim().replace(/\s+/g, " ").slice(0, 200) : "";
    const pulseModeValue = String(req.body?.pulseMode ?? "").trim();
    const pulseMode = PULSE_MODES.includes(pulseModeValue as PulseMode) ? pulseModeValue as PulseMode : null;
    const pulseCampaignId = Number(req.body?.pulseCampaignId);
    const pulseOptions = pulseMode === "investigate" ? PULSE_INVESTIGATE_OPTIONS : pulseMode === "champion" ? PULSE_CHAMPION_OPTIONS : FEEDBACK_TYPE_OPTIONS;
    const feedbackTypes = Array.isArray(req.body?.feedbackTypes)
      ? req.body.feedbackTypes.map((value: unknown) => String(value)).filter((value: string) => pulseOptions.includes(value as never))
      : [];
    const sentiment = String(req.body?.sentiment ?? "mixed") as FeedbackSentiment;
    const urgency = String(req.body?.urgency ?? "note") as FeedbackUrgency;
    const commentText = String(req.body?.commentText ?? "").trim();
    const rawStyleId = Number(req.body?.styleId);
    const requestedImageTokenInput = feedbackImageTokens(req.body?.feedbackImageTokens);
    const requestedImageTokens = requestedImageTokenInput.tokens;
    if (!requestedImageTokenInput.valid) {
      res.status(400).json({ error: `You can attach up to ${FEEDBACK_IMAGE_MAX_FILES} valid images` });
      return;
    }
    if (!submitterName || !submitterTeam || !requestedStyleNumber || !feedbackTypes.length || !FEEDBACK_SENTIMENTS.includes(sentiment) || !FEEDBACK_URGENCIES.includes(urgency) || commentText.length < 8) {
      res.status(400).json({ error: "Name, team, style, at least one issue type and a useful comment are required" });
      return;
    }
    if (submitterTeam === "Retail") {
      if (!storeName) {
        res.status(400).json({ error: "Please select the store where you work" });
        return;
      }
      const stores = await feedbackPhysicalStores();
      const matchedStore = stores.find((store) => store.toLowerCase() === storeName.toLowerCase());
      if (!matchedStore) {
        res.status(400).json({ error: "Please select a physical store from the list" });
        return;
      }
      storeName = matchedStore;
    }
    if (customerId) {
      const customer = await feedbackCustomerById(customerId);
      if (customer) {
        customerId = customer.id;
        customerName = customer.name;
      } else {
        customerId = "";
      }
    }
    const catalogueStyle = await pool.query<{ styleName: string; styleNumber: string }>(
      `SELECT MAX(apc.style_name) AS "styleName", MAX(apc.style_number) AS "styleNumber"
         FROM public.all_products_clean apc
        WHERE ${allowedBrand("apc")}
          AND LOWER(COALESCE(apc.status,'')) IN ('active','retired')
          AND LOWER(BTRIM(apc.style_number)) = LOWER(BTRIM($1))
        HAVING COUNT(*) > 0`,
      [requestedStyleNumber],
    );
    if (!catalogueStyle.rows[0]?.styleNumber) {
      res.status(400).json({ error: "Please select a style from the catalogue" });
      return;
    }
    const styleName = String(catalogueStyle.rows[0].styleName || requestedStyleName || requestedStyleNumber).trim();
    const styleNumber = String(catalogueStyle.rows[0].styleNumber).trim();
    const colourwayValues = await feedbackColourways(styleNumber);
    if (requestedColourway !== "All colourways / General" && !colourwayValues.includes(requestedColourway)) {
      res.status(400).json({ error: "Please select a colourway from the catalogue" });
      return;
    }
    let styleId: number | null = null;
    if (Number.isInteger(rawStyleId) && rawStyleId > 0) {
      const style = await pool.query<{ id: number }>(
        `SELECT s.id
           FROM ${schema}.styles s
          WHERE s.id=$1 AND ${allowedBrand("s")}
            AND (LOWER(s.code)=LOWER($2) OR LOWER(s.name)=LOWER($3))`,
        [rawStyleId, styleNumber, styleName],
      );
      styleId = style.rows[0]?.id ?? null;
    }
    let resolvedPulseId: number | null = null;
    if (pulseMode) {
      const pulse = await pool.query<{ id: number }>(
        `SELECT id
           FROM ${schema}.style_feedback_pulses
          WHERE mode=$1
            AND LOWER(BTRIM(style_number))=LOWER(BTRIM($2))
            AND ($3::bigint IS NULL OR id=$3)
          ORDER BY created_at DESC,id DESC
          LIMIT 1`,
        [pulseMode, styleNumber, Number.isInteger(pulseCampaignId) && pulseCampaignId > 0 ? pulseCampaignId : null],
      );
      resolvedPulseId = pulse.rows[0]?.id ?? null;
    }
    if (requestedImageTokens.length) {
      const pending = await pool.query<{ id: number; objectPath: string; uploadToken: string; originalName: string; declaredType: FeedbackImageContentType; byteSize: number }>(
        `SELECT id,object_path AS "objectPath",upload_token AS "uploadToken",original_name AS "originalName",
            content_type AS "declaredType",byte_size AS "byteSize"
           FROM ${schema}.style_feedback_images
          WHERE upload_token=ANY($1::text[]) AND feedback_id IS NULL AND uploaded_at IS NOT NULL AND expires_at > NOW()
          ORDER BY id`,
        [requestedImageTokens],
      );
      if (pending.rows.length !== requestedImageTokens.length) {
        res.status(400).json({ error: "One or more image uploads have expired. Please choose them again." });
        return;
      }
      pendingObjects = pending.rows.map(({ id, objectPath }) => ({ id, objectPath }));
      for (const pendingImage of pending.rows) {
        const stored = await fetch(await signedStorageUrl(pendingImage.objectPath, "GET", 120), { signal: AbortSignal.timeout(30_000) });
        const storedBytes = stored.ok ? await readFeedbackImageAtMost(stored) : new Uint8Array();
        const detectedType = stored.ok && storedBytes.length === Number(pendingImage.byteSize)
          ? detectFeedbackImageContentType(storedBytes)
          : null;
        if (!stored.ok || !detectedType || detectedType !== pendingImage.declaredType) {
          await Promise.all(pendingObjects.map((item) => discardPendingFeedbackImage(item.id)));
          pendingObjects = [];
          res.status(400).json({ error: "One or more images did not match their declared format" });
          return;
        }
      }
    }
    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      result = await client.query(
      `INSERT INTO ${schema}.style_feedback
        (submitter_name,submitter_team,style_id,style_number,colourway,style_name_freetext,feedback_types,sentiment,urgency,comment_text,pulse_id,pulse_mode,customer_origin,customer_id,customer_name,store_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id,submitter_name AS "submitterName",submitter_team AS "submitterTeam",
        style_id AS "styleId",style_number AS "styleNumber",colourway,
        style_name_freetext AS "styleNameFreetext",feedback_types AS "feedbackTypes",
         sentiment,urgency,comment_text AS "commentText",pulse_id AS "pulseId",pulse_mode AS "pulseMode",
         customer_origin AS "customerOrigin",customer_id AS "customerId",customer_name AS "customerName",store_name AS "storeName",
         reviewed,reviewed_by AS "reviewedBy",
        reviewed_at AS "reviewedAt",created_at AS "createdAt"`,
        [submitterName, submitterTeam, styleId, styleNumber, requestedColourway, styleName, feedbackTypes, sentiment, urgency, commentText, resolvedPulseId, pulseMode, customerOrigin, customerId || null, customerName || null, storeName || null],
      );
      if (requestedImageTokens.length) {
        const attached = await client.query(
          `UPDATE ${schema}.style_feedback_images
              SET feedback_id=$1,upload_token=NULL,expires_at=NOW()
            WHERE upload_token=ANY($2::text[]) AND feedback_id IS NULL AND uploaded_at IS NOT NULL
            RETURNING id`,
          [result.rows[0].id, requestedImageTokens],
        );
        if (attached.rows.length !== requestedImageTokens.length) throw new Error("Feedback image association changed before submission completed");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.status(201).json(feedbackPayload(result.rows[0]));
  } catch (error) {
    if (pendingObjects.length) {
      await Promise.all(pendingObjects.map((item) => discardPendingFeedbackImage(item.id)));
    }
    next(error);
  }
});

router.use(requireUser);

router.post("/feedback/pulses", async (req: AuthRequest, res, next) => {
  try {
    const styleNumber = String(req.body?.styleNumber ?? "").trim();
    const rawStyleId = Number(req.body?.styleId);
    const mode = String(req.body?.mode ?? "").trim() as PulseMode;
    if (!styleNumber || !PULSE_MODES.includes(mode)) {
      res.status(400).json({ error: "A style number and pulse mode are required" });
      return;
    }
    const style = await pool.query<{ id: number; code: string; name: string; image: string | null }>(
      `SELECT s.id,s.code,s.name,s.image
         FROM ${schema}.styles s
        WHERE ${allowedBrand("s")}
          AND LOWER(BTRIM(s.code))=LOWER(BTRIM($1))
          AND ($2::int IS NULL OR s.id=$2)
        LIMIT 1`,
      [styleNumber, Number.isInteger(rawStyleId) && rawStyleId > 0 ? rawStyleId : null],
    );
    if (!style.rows[0]) {
      res.status(404).json({ error: "PLM style not found" });
      return;
    }
    const canonicalStyleNumber = String(style.rows[0].code || styleNumber).trim();
    const sharePath = `/product-workspace/feedback?style=${encodeURIComponent(canonicalStyleNumber)}&mode=${mode}`;
    const result = await pool.query(
      `INSERT INTO ${schema}.style_feedback_pulses
        (style_id,style_number,mode,share_path,created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id,style_id AS "styleId",style_number AS "styleNumber",mode,colourway,
        share_path AS "sharePath",created_at AS "createdAt"`,
      [style.rows[0].id, canonicalStyleNumber, mode, sharePath, req.workspaceUser?.id ?? null],
    );
    res.status(201).json({
      ...result.rows[0],
      styleName: style.rows[0].name,
      styleImage: feedbackImagePayload(style.rows[0].image),
      responseCount: 0,
    });
  } catch (error) {
    next(error);
  }
});

function rangePlanSeasonPayload(row: Record<string, unknown>) {
  const seasonName = String(row.seasonName ?? "");
  return {
    id: Number(row.id),
    seasonName,
    seasonYear: Number(row.seasonYear ?? 0),
    revenueTargetKes: Number(row.revenueTargetKes ?? 0),
    cogsBudgetPct: Number(row.cogsBudgetPct ?? 0),
    factoryCapacityUnits: Number(row.factoryCapacityUnits ?? 0),
    status: String(row.status ?? "active"),
    cadence: seasonName.startsWith("Q") ? "quarterly" : "monthly",
  };
}

function rangePlanMonthForSeason(seasonName: string): string | null {
  const season = RANGE_PLAN_SEASON_SEEDS.find((candidate) => candidate.seasonName === seasonName);
  return season?.cadence === "monthly" ? season.otbMonth : null;
}

function rangePlanRowPayload(row: Record<string, unknown>) {
  const asp = Number(row.asp ?? 0);
  const totalUnitsImplied = Number(row.totalUnitsImplied ?? 0);
  return {
    id: Number(row.id),
    seasonId: Number(row.seasonId),
    subCategory: String(row.subCategory ?? ""),
    tier: String(row.tier ?? "Core"),
    styleCountTarget: Number(row.styleCountTarget ?? 0),
    styleCountMin: Number(row.styleCountMin ?? 0),
    styleCountMax: Number(row.styleCountMax ?? 0),
    aosUnits: Number(row.aosUnits ?? 350),
    totalUnitsImplied,
    asp: Number.isFinite(asp) ? asp : 0,
    potentialFpRevenue: Number.isFinite(asp) ? totalUnitsImplied * asp : 0,
    notes: String(row.notes ?? ""),
  };
}

function rangePlanOtbPayload(row: Record<string, unknown>) {
  return {
    id: row.id == null ? null : Number(row.id),
    monthYear: String(row.monthYear ?? ""),
    revenueTarget: row.revenueTarget == null ? null : Number(row.revenueTarget),
    plannedUnits: row.plannedUnits == null ? null : Number(row.plannedUnits),
    newStylesCount: row.newStylesCount == null ? null : Number(row.newStylesCount),
    notes: String(row.notes ?? ""),
  };
}

function seasonClause(column: string, parameter: string) {
  return `(${column}=$${parameter} OR ${column} LIKE $${parameter} || ',%' OR ${column} LIKE '%,' || $${parameter} || ',%' OR ${column} LIKE '%,' || $${parameter})`;
}

function assortmentStylePayload(row: Record<string, unknown>) {
  const styleNumber = String(row.styleNumber ?? "").trim();
  const launchDate = row.launchDate;
  return {
    id: String(row.id ?? ""),
    pdId: row.pdId == null ? null : Number(row.pdId),
    source: String(row.source ?? ""),
    styleNumber,
    name: String(row.name ?? ""),
    category: String(row.category ?? "Uncategorised"),
    subCategory: String(row.subCategory ?? ""),
    fabricCategory: String(row.fabricCategory ?? ""),
    brand: String(row.brand ?? ""),
    primaryColour: String(row.primaryColour ?? ""),
    edit: String(row.edit ?? ""),
    stage: String(row.stage ?? "Concept"),
    designer: String(row.designer ?? "Unassigned"),
    season: String(row.season ?? ""),
    rangeTier: row.rangeTier == null ? null : String(row.rangeTier),
    tier: row.tier == null ? null : String(row.tier),
    status: String(row.status ?? "Active"),
    excluded: Boolean(row.excluded),
    unitsSold: row.unitsSold == null ? null : Number(row.unitsSold),
    revenueKes: row.revenueKes == null ? null : Number(row.revenueKes),
    sorPct: row.sorPct == null ? null : Number(row.sorPct),
    launchDate: launchDate == null ? null : launchDate instanceof Date ? launchDate.toISOString().slice(0, 10) : String(launchDate),
    price: row.price == null ? null : Number(row.price),
    stockUnits: row.stockUnits == null ? null : Number(row.stockUnits),
    image: styleNumber ? `/api/workspace/assortment-image/${encodeURIComponent(styleNumber)}` : null,
  };
}

async function assortmentPlanData(quarter: string) {
  const catalogueResult = await pool.query(
    `WITH sku_style AS (
       SELECT DISTINCT ON (sku) sku,style_name,style_number
       FROM public.all_products_clean
       WHERE sku IS NOT NULL
         AND NULLIF(TRIM(style_name),'') IS NOT NULL
         AND NULLIF(TRIM(style_number),'') IS NOT NULL
       ORDER BY sku,(active IS TRUE) DESC,style_number
     ),
     style_rollup AS (
       SELECT
         a.style_name,
         LOWER(TRIM(MODE() WITHIN GROUP (ORDER BY a.style_number))) AS style_key,
         MODE() WITHIN GROUP (ORDER BY NULLIF(TRIM(a.style_number),'')) AS style_number,
         a.style_name AS name,
         COALESCE(MAX(NULLIF(TRIM(a.category),'')),MAX(NULLIF(TRIM(a.product_type),'')),'Uncategorised') AS category,
         COALESCE(MAX(NULLIF(TRIM(a.product_type),'')),'') AS "subCategory",
         COALESCE(MAX(NULLIF(TRIM(a.fabric_category),'')),'') AS "fabricCategory",
         COALESCE(MAX(NULLIF(TRIM(a.brand),'')),'') AS brand,
         COALESCE(MAX(NULLIF(TRIM(a.color_print),'')),'') AS "primaryColour",
          COALESCE(MAX(NULLIF(TRIM(a.collection),'')),'') AS edit,
          (MODE() WITHIN GROUP (ORDER BY NULLIF(a.price,0))
            FILTER (WHERE a.price IS NOT NULL AND a.price > 0))::float AS price,
          MIN(CASE WHEN a.style_launch_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            THEN LEFT(a.style_launch_date,10)::date END) AS catalogue_launch_date
       FROM public.all_products_clean a
       WHERE NULLIF(TRIM(a.style_name),'') IS NOT NULL
          AND ${allowedBrand("a")}
         AND NULLIF(TRIM(a.style_number),'') IS NOT NULL
       GROUP BY a.style_name
       HAVING NOT BOOL_OR(
         COALESCE(a.category,'') ILIKE '%sample%'
         OR COALESCE(a.style_number,'') ILIKE '%sample%'
         OR COALESCE(a.style_name,'') ILIKE '%sample%'
       )
     ),
     stock AS (
       SELECT COALESCE(m.style_name,i.style_name) AS style_name,
         COALESCE(SUM(i.available) FILTER (
           WHERE NOT (i.pos_location_name=ANY($2::text[]))
         ),0) AS soh_stores,
         COALESCE(SUM(i.available) FILTER (
           WHERE i.pos_location_name=ANY($2::text[])
             AND NOT (i.pos_location_name=ANY($3::text[]))
          ),0) AS soh_warehouse,
          COALESCE(SUM(i.available) FILTER (
            WHERE COALESCE(i.pos_location_name,'') <> ALL($3::text[])
          ),0)::float AS stock_units
       FROM public.all_inventory i
       LEFT JOIN sku_style m ON m.sku=i.sku
       WHERE NULLIF(TRIM(COALESCE(m.style_name,i.style_name)),'') IS NOT NULL
       GROUP BY COALESCE(m.style_name,i.style_name)
     ),
     eligible AS (
       SELECT DISTINCT ON (r.style_key)
         r.*,o.status AS override_status,o.tier AS override_tier
       FROM style_rollup r
       JOIN public.style_tier_overrides o
         ON LOWER(TRIM(o.style_number))=r.style_key
       LEFT JOIN stock st ON st.style_name=r.style_name
       WHERE LOWER(TRIM(COALESCE(o.status,''))) IN ('active','retired')
         AND LOWER(COALESCE(o.status,'')) NOT LIKE '%archive%'
         AND (
           LOWER(TRIM(o.status))='active'
           OR COALESCE(st.soh_stores,0)>0
           OR COALESCE(st.soh_warehouse,0)>0
         )
       ORDER BY r.style_key,r.style_name
      ),
      rollup_sales AS (
        SELECT r.style_key,
          SUM(day.gross_units)::float AS units_sold,
          SUM(day.net_revenue)::float AS revenue_kes
        FROM eligible r
        JOIN public.rollup_merch_style_day day ON day.style_name=r.style_name
        GROUP BY r.style_key
      ),
      rollup_first_sale AS (
        SELECT r.style_key,MIN(first_sale.first_sale_date) AS first_sale_date
        FROM eligible r
        JOIN public.rollup_merch_first_sale first_sale ON first_sale.style_name=r.style_name
        GROUP BY r.style_key
      ),
      incremental_sales AS (
        SELECT r.style_key,
          SUM(CASE WHEN LOWER(COALESCE(sa.sale_kind,'')) IN ('sale','order')
            THEN GREATEST(COALESCE(sa.ordered_item_quantity,0)::numeric,0) ELSE 0 END)::float AS units_sold,
          SUM(CASE
            WHEN LOWER(COALESCE(sa.sale_kind,'')) IN ('sale','order')
              THEN (COALESCE(sa.total_sales_kes,0)::numeric - COALESCE(sa.discounts_kes,0)::numeric)
                / CASE WHEN sa.country IN ('Uganda','Rwanda') THEN 1.18 ELSE 1.16 END
            WHEN LOWER(COALESCE(sa.sale_kind,''))='return'
              THEN -COALESCE(sa.returns_kes,0)::numeric
                / CASE WHEN sa.country IN ('Uganda','Rwanda') THEN 1.18 ELSE 1.16 END
            ELSE 0
          END)::float AS revenue_kes,
          MIN(CASE WHEN sa.sale_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            THEN LEFT(sa.sale_date,10)::date END)
            FILTER (WHERE LOWER(COALESCE(sa.sale_kind,'')) IN ('sale','order')) AS first_sale_date
        FROM public.all_sales sa
        JOIN sku_style m ON m.sku=sa.variant_sku
        JOIN eligible r ON r.style_key=LOWER(TRIM(m.style_number))
        WHERE sa.loaded_at > (
          SELECT source_watermark FROM public.rollup_meta WHERE name='merch_style_day'
        )
          AND COALESCE(sa.pos_location_name,'') NOT IN (
            'Staff purchases','Manual Order','Online - vivo-uganda',
            'Online - vivowoman','Online Orders Location'
          )
          AND LOWER(COALESCE(sa.product_title,'')) NOT LIKE '%shopping bag%'
          AND LOWER(COALESCE(sa.product_title,'')) NOT LIKE '%gift card%'
          AND LOWER(COALESCE(sa.product_title,'')) NOT LIKE '%gift voucher%'
          AND LOWER(COALESCE(sa.product_title,'')) NOT LIKE '%voucher%'
          AND (
            LOWER(COALESCE(sa.product_title,'')) NOT LIKE '%on specific products%'
            OR (
              COALESCE(sa.total_sales_kes,0)::numeric=0
              AND COALESCE(sa.ordered_item_quantity,0)=0
              AND COALESCE(sa.discounts_kes,0)::numeric<>0
            )
          )
          AND LOWER(COALESCE(sa.variant_sku,'')) NOT LIKE '%vb00%'
        GROUP BY r.style_key
      ),
      sales_by_style AS (
        SELECT r.style_key,
          CASE WHEN rollup.style_key IS NULL AND incremental.style_key IS NULL THEN NULL
            ELSE COALESCE(rollup.units_sold,0) + COALESCE(incremental.units_sold,0) END AS units_sold,
          CASE WHEN rollup.style_key IS NULL AND incremental.style_key IS NULL THEN NULL
            ELSE COALESCE(rollup.revenue_kes,0) + COALESCE(incremental.revenue_kes,0) END AS revenue_kes,
          COALESCE(first_sale.first_sale_date,incremental.first_sale_date) AS first_sale_date
        FROM eligible r
        LEFT JOIN rollup_sales rollup ON rollup.style_key=r.style_key
        LEFT JOIN rollup_first_sale first_sale ON first_sale.style_key=r.style_key
        LEFT JOIN incremental_sales incremental ON incremental.style_key=r.style_key
     )
     SELECT
       'catalogue:' || r.style_number AS id,
       NULL::bigint AS "pdId",
       'all_products_clean' AS source,
       r.style_number AS "styleNumber",
       r.name,r.category,r."subCategory",r."fabricCategory",r.brand,r."primaryColour",r.edit,
       'Carry-over' AS stage,'Merchandising' AS designer,$1 AS season,
       CASE WHEN r.override_tier IN ('Tier 1','Tier 2','Tier 3','Tier 4') THEN r.override_tier ELSE NULL END AS "rangeTier",
       CASE
         WHEN LOWER(TRIM(r.override_status))='retired' THEN 'Retired'
         WHEN r.override_tier='Tier 1' THEN 'Tier 1 · NOOS'
         WHEN r.override_tier='Tier 2' THEN 'Tier 2 · Core'
         WHEN r.override_tier='Tier 3' THEN 'Tier 3 · Recent'
         WHEN r.override_tier='Tier 4' THEN 'Tier 4 · New'
         ELSE NULL
       END AS tier,
       INITCAP(LOWER(TRIM(r.override_status))) AS status,
        (e.style_id IS NOT NULL AND aps.style_key IS NULL) AS excluded,
        sales.units_sold AS "unitsSold",
        sales.revenue_kes AS "revenueKes",
        CASE
          WHEN COALESCE(sales.units_sold,0) + COALESCE(st.stock_units,0) > 0
          THEN ROUND((100.0 * COALESCE(sales.units_sold,0)
            / (COALESCE(sales.units_sold,0) + COALESCE(st.stock_units,0)))::numeric,2)::float
          ELSE NULL
        END AS "sorPct",
        COALESCE(r.catalogue_launch_date,sales.first_sale_date) AS "launchDate",
        r.price,
        st.stock_units AS "stockUnits"
     FROM eligible r
      LEFT JOIN stock st ON st.style_name=r.style_name
      LEFT JOIN sales_by_style sales ON sales.style_key=r.style_key
     LEFT JOIN ${schema}.assortment_exclusions e
       ON e.season=$1 AND e.source='all_products_clean' AND LOWER(TRIM(e.style_id))=r.style_key
     LEFT JOIN ${schema}.assortment_plan_styles aps
       ON aps.season=$1 AND aps.source='all_products_clean' AND LOWER(TRIM(aps.style_key))=r.style_key
     ORDER BY CASE
       WHEN LOWER(TRIM(r.override_status))='retired' THEN 5
       WHEN r.override_tier='Tier 1' THEN 1 WHEN r.override_tier='Tier 2' THEN 2
       WHEN r.override_tier='Tier 3' THEN 3 WHEN r.override_tier='Tier 4' THEN 4 ELSE 6
     END,LOWER(COALESCE(r.style_number,r.name))`,
    [quarter, [...ASSORTMENT_WAREHOUSE_LOCATIONS], [...ASSORTMENT_PIPELINE_LOCATIONS]],
  );
  const allStyles = catalogueResult.rows.map(assortmentStylePayload);
  const styles = allStyles.filter((style) => !style.excluded);
  const breakdown = (field: "category" | "stage") => {
    const counts: Record<string, number> = {};
    for (const row of styles) {
      const value = String(row[field] ?? "Uncategorised");
      counts[value] = (counts[value] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  };
  const countTier = (tier: string) => styles.filter((row) => String(row.tier) === tier).length;
  const filterOptions = (field: "tier" | "status" | "category" | "subCategory" | "fabricCategory" | "brand" | "primaryColour" | "edit") =>
    [...new Set(styles.map((row) => String(row[field] ?? "").trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
  return {
    styles,
    carryOverStyles: styles,
    newStyles: [],
    total: styles.length,
    counts: {
      total: styles.length,
      tier1: countTier("Tier 1 · NOOS"),
      tier2: countTier("Tier 2 · Core"),
      tier3: countTier("Tier 3 · Recent"),
      tier4: countTier("Tier 4 · New"),
      retired: countTier("Retired"),
      noos: countTier("Tier 1 · NOOS"),
      core: countTier("Tier 2 · Core"),
      recent: countTier("Tier 3 · Recent"),
      newTest: countTier("Tier 4 · New"),
    },
    categoryBreakdown: breakdown("category"),
    stageBreakdown: breakdown("stage"),
    filterOptions: {
      tier: [...ASSORTMENT_TIER_FILTERS],
      status: ["Active", "Retired"],
      category: filterOptions("category"),
      subCategory: filterOptions("subCategory"),
      fabricCategory: filterOptions("fabricCategory"),
      brand: filterOptions("brand"),
      primaryColour: filterOptions("primaryColour"),
      edit: filterOptions("edit"),
    },
  };
}

router.get("/range-plan", async (req, res, next) => {
  try {
    const seasonsResult = await pool.query(
      `SELECT id,season_name AS "seasonName",season_year AS "seasonYear",
         revenue_target_kes AS "revenueTargetKes",cogs_budget_pct AS "cogsBudgetPct",
         factory_capacity_units AS "factoryCapacityUnits",status
       FROM ${schema}.range_plan_seasons
       ORDER BY CASE season_name
          WHEN 'Q3 2026' THEN 1
          WHEN 'Q4 2026' THEN 2
          WHEN 'September 2026' THEN 3
          WHEN 'October 2026' THEN 4
          WHEN 'November 2026' THEN 5
          WHEN 'December 2026' THEN 6
          ELSE 99
        END,
        CASE WHEN status='active' THEN 0 ELSE 1 END,
        season_year DESC, id DESC`,
    );
    const seasons = seasonsResult.rows.map(rangePlanSeasonPayload);
    const quarter = PLM_SEASONS.includes(String(req.query.quarter ?? "") as (typeof PLM_SEASONS)[number])
      ? String(req.query.quarter)
      : "Q3 2026";
    const requestedSeasonId = Number(req.query.seasonId);
    const season = (Number.isInteger(requestedSeasonId) && requestedSeasonId > 0
      ? seasons.find((candidate) => candidate.id === requestedSeasonId)
      : seasons.find((candidate) => candidate.seasonName === quarter)) ??
      seasons.find((candidate) => candidate.status === "active") ?? seasons[0];
    if (!season) {
      res.json({ seasons: [], season: null, rows: [], otb: [], averageCostKes: 850, health: await rangePlanHealth() });
      return;
    }
    const [q3Assortment, q4Assortment] = await Promise.all([
      assortmentPlanData("Q3 2026"),
      assortmentPlanData("Q4 2026"),
    ]);
    const selectedAssortment = quarter === "Q4 2026" ? q4Assortment : q3Assortment;
     const rowsResult = await pool.query(
       `WITH style_asp AS (
          SELECT subcategory,AVG(price)::numeric AS asp
          FROM rollup_rm_prod
          WHERE ${allowedBrand("rollup_rm_prod")}
            AND price IS NOT NULL AND price > 0
          GROUP BY subcategory
        )
        SELECT r.id,r.season_id AS "seasonId",r.sub_category AS "subCategory",r.tier::text,
         style_count_target AS "styleCountTarget",style_count_min AS "styleCountMin",
          style_count_max AS "styleCountMax",r.aos_units AS "aosUnits",
          r.total_units_implied AS "totalUnitsImplied",COALESCE(a.asp,0) AS asp,r.notes
        FROM ${schema}.range_plan_rows r
        LEFT JOIN style_asp a ON LOWER(TRIM(a.subcategory))=LOWER(TRIM(r.sub_category))
        WHERE r.season_id=$1
        ORDER BY CASE r.tier::text WHEN 'NOOS' THEN 1 WHEN 'Core' THEN 2 WHEN 'Recent' THEN 3 ELSE 4 END, r.id`,
      [season.id],
    );
    const planMonth = rangePlanMonthForSeason(season.seasonName);
    const otbResult = await pool.query(
      `WITH months AS (
         SELECT month_year
         FROM ${schema}.range_plan_otb
         WHERE season_id=$1
           AND ($2::boolean IS FALSE OR month_year=$3::date)
         UNION
         SELECT generate_series(
           date_trunc('month', CURRENT_DATE)::date,
           (date_trunc('month', CURRENT_DATE) + INTERVAL '5 months')::date,
           INTERVAL '1 month'
         )::date AS month_year
         WHERE $2::boolean IS FALSE
       )
       SELECT o.id,m.month_year::text AS "monthYear",o.revenue_target AS "revenueTarget",
         o.planned_units AS "plannedUnits",o.new_styles_count AS "newStylesCount",o.notes
       FROM months m
       LEFT JOIN ${schema}.range_plan_otb o
         ON o.season_id=$1 AND o.month_year=m.month_year
       ORDER BY m.month_year`,
      [season.id, planMonth !== null, planMonth],
    );
     const rangeRows = rowsResult.rows.map(rangePlanRowPayload);
     const potentialFpRevenue = rangeRows
       .filter((row) => ["NOOS", "Core", "Recent"].includes(row.tier))
       .reduce((sum, row) => sum + row.potentialFpRevenue, 0);
     res.json({
      seasons,
      season,
       rows: rangeRows,
       potentialFpRevenue,
      otb: otbResult.rows.map(rangePlanOtbPayload),
      averageCostKes: 850,
      health: await rangePlanHealth(),
      assortmentQuarter: quarter,
      assortmentStyles: selectedAssortment.styles,
       carryOverStyles: selectedAssortment.carryOverStyles,
       newStyles: selectedAssortment.newStyles,
      quarterStyles: {
        "Q3 2026": q3Assortment.styles,
        "Q4 2026": q4Assortment.styles,
      },
      assortmentSummary: {
        total: selectedAssortment.total,
         counts: selectedAssortment.counts,
        categoryBreakdown: selectedAssortment.categoryBreakdown,
        stageBreakdown: selectedAssortment.stageBreakdown,
         filterOptions: selectedAssortment.filterOptions,
      },
      quarterSummaries: {
         "Q3 2026": { total: q3Assortment.total, counts: q3Assortment.counts },
         "Q4 2026": { total: q4Assortment.total, counts: q4Assortment.counts },
      },
        assortmentFilterOptions: {
          tier: [...ASSORTMENT_TIER_FILTERS],
          status: ["Active", "Retired"],
         category: [...new Set([...q3Assortment.filterOptions.category, ...q4Assortment.filterOptions.category])].sort(),
         subCategory: [...new Set([...q3Assortment.filterOptions.subCategory, ...q4Assortment.filterOptions.subCategory])].sort(),
         fabricCategory: [...new Set([...q3Assortment.filterOptions.fabricCategory, ...q4Assortment.filterOptions.fabricCategory])].sort(),
         brand: [...new Set([...q3Assortment.filterOptions.brand, ...q4Assortment.filterOptions.brand])].sort(),
         primaryColour: [...new Set([...q3Assortment.filterOptions.primaryColour, ...q4Assortment.filterOptions.primaryColour])].sort(),
         edit: [...new Set([...q3Assortment.filterOptions.edit, ...q4Assortment.filterOptions.edit])].sort(),
       },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/assortment-image/:styleNumber", requireUser, async (req, res, next) => {
  try {
    const styleNumber = decodeURIComponent(String(req.params.styleNumber ?? "")).trim();
    if (!styleNumber) {
      res.status(404).end();
      return;
    }
    const result = await pool.query(
      `SELECT i.image_512 AS image
       FROM public.all_products_clean p
       JOIN public.product_image_map m ON m.sku=p.sku
       JOIN public.product_images i ON i.tmpl_id=m.tmpl_id
       WHERE ${allowedBrand("p")}
         AND LOWER(COALESCE(p.status,'')) IN ('active','retired')
          AND COALESCE(NULLIF(TRIM(p.style_number),''),NULLIF(TRIM(p.sku),''))=$1
         AND i.image_512 IS NOT NULL AND i.image_512 <> ''
       ORDER BY p.sku
       LIMIT 1`,
      [styleNumber],
    );
    const raw = result.rows[0]?.image;
    if (!raw) {
      res.status(404).end();
      return;
    }
    const image = String(raw).replace(/^data:image\/[^;]+;base64,/, "");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.type("jpeg").send(Buffer.from(image, "base64"));
  } catch (error) {
    next(error);
  }
});

router.put("/range-plan/seasons/:seasonId", async (req, res, next) => {
  try {
    const seasonId = Number(req.params.seasonId);
    const revenueTargetKes = req.body?.revenueTargetKes === undefined ? null : Number(req.body.revenueTargetKes);
    const cogsBudgetPct = req.body?.cogsBudgetPct === undefined ? null : Number(req.body.cogsBudgetPct);
    if (!Number.isInteger(seasonId) || seasonId <= 0 || (revenueTargetKes !== null && (!Number.isFinite(revenueTargetKes) || revenueTargetKes < 0)) || (cogsBudgetPct !== null && (!Number.isFinite(cogsBudgetPct) || cogsBudgetPct < 0 || cogsBudgetPct > 100))) {
      res.status(400).json({ error: "Invalid season assumptions" });
      return;
    }
    const result = await pool.query(
      `UPDATE ${schema}.range_plan_seasons
       SET revenue_target_kes=COALESCE($2,revenue_target_kes),
           cogs_budget_pct=COALESCE($3,cogs_budget_pct)
       WHERE id=$1
       RETURNING id,season_name AS "seasonName",season_year AS "seasonYear",
         revenue_target_kes AS "revenueTargetKes",cogs_budget_pct AS "cogsBudgetPct",
         factory_capacity_units AS "factoryCapacityUnits",status`,
      [seasonId, revenueTargetKes, cogsBudgetPct],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Planning season not found" });
      return;
    }
    res.json(rangePlanSeasonPayload(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

router.patch("/range-plan/styles/:id/season", async (req: AuthRequest, res, next) => {
  try {
    const styleId = Number(req.params.id);
    const season = String(req.body?.season ?? "").trim();
    if (!Number.isInteger(styleId) || !PLM_SEASONS.includes(season as (typeof PLM_SEASONS)[number])) {
      res.status(400).json({ error: "A valid style and quarter are required" });
      return;
    }
    const result = await pool.query(
      `UPDATE public.pd_styles SET season=$1 WHERE id=$2
       RETURNING id,style_number AS "styleNumber",style_name AS name,season`,
      [season, styleId],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "PD style not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.post("/range-plan/styles/bulk-season", async (req: AuthRequest, res, next) => {
  try {
    const styleIds = Array.isArray(req.body?.styleIds)
      ? req.body.styleIds.map((id: unknown) => Number(id)).filter((id: number) => Number.isInteger(id) && id > 0)
      : [];
    const season = String(req.body?.season ?? "").trim();
    if (!styleIds.length || styleIds.length > 500 || !PLM_SEASONS.includes(season as (typeof PLM_SEASONS)[number])) {
      res.status(400).json({ error: "Select at least one style and a valid quarter" });
      return;
    }
    const result = await pool.query(
      `UPDATE public.pd_styles SET season=$1 WHERE id=ANY($2::bigint[]) RETURNING id`,
      [season, styleIds],
    );
    res.json({ updated: result.rowCount ?? 0 });
  } catch (error) {
    next(error);
  }
});

router.put("/range-plan/exclusions", async (req: AuthRequest, res, next) => {
  try {
    const season = String(req.body?.season ?? "").trim();
    const source = String(req.body?.source ?? "").trim();
    const styleId = String(req.body?.styleId ?? "").trim();
    const excluded = req.body?.excluded !== false;
    if (!PLM_SEASONS.includes(season as (typeof PLM_SEASONS)[number]) || source !== "all_products_clean" || !styleId || styleId.length > 200) {
      res.status(400).json({ error: "A valid quarter, catalogue source and style are required" });
      return;
    }
    const exists = await pool.query(
      `SELECT 1 FROM public.all_products_clean a
       WHERE ${allowedBrand("a")}
         AND COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))=$1
         AND LOWER(COALESCE(a.status,'')) IN ('active','retired') LIMIT 1`,
      [styleId],
    );
    if (!exists.rows[0]) {
      res.status(404).json({ error: "Catalogue style not found" });
      return;
    }
    if (excluded) {
      await pool.query(
        `INSERT INTO ${schema}.assortment_exclusions (season,style_id,source)
         VALUES ($1,$2,$3)
         ON CONFLICT (season,style_id,source) DO NOTHING`,
        [season, styleId, source],
      );
    } else {
      await pool.query(
        `DELETE FROM ${schema}.assortment_exclusions WHERE season=$1 AND style_id=$2 AND source=$3`,
        [season, styleId, source],
      );
    }
    res.json({ season, styleId, source, excluded });
  } catch (error) {
    next(error);
  }
});

router.put("/range-plan/rows/:id", async (req, res, next) => {
  try {
    const rowId = Number(req.params.id);
    const existing = await pool.query(
      `SELECT style_count_target AS "styleCountTarget",aos_units AS "aosUnits",notes
       FROM ${schema}.range_plan_rows WHERE id=$1`,
      [rowId],
    );
    if (!existing.rows[0]) {
      res.status(404).json({ error: "Range plan row not found" });
      return;
    }
    const styleCountTarget = req.body?.styleCountTarget === undefined
      ? Number(existing.rows[0].styleCountTarget)
      : Number(req.body.styleCountTarget);
    const aosUnits = req.body?.aosUnits === undefined
      ? Number(existing.rows[0].aosUnits)
      : Number(req.body.aosUnits);
    const notes = req.body?.notes === undefined ? String(existing.rows[0].notes ?? "") : String(req.body.notes);
    if (!Number.isInteger(styleCountTarget) || styleCountTarget < 0 || !Number.isInteger(aosUnits) || aosUnits < 0 || notes.length > 2000) {
      res.status(400).json({ error: "Style target and AOS must be non-negative whole numbers; notes must be 2,000 characters or fewer" });
      return;
    }
    const result = await pool.query(
      `UPDATE ${schema}.range_plan_rows
       SET style_count_target=$1,aos_units=$2,notes=$3
       WHERE id=$4
       RETURNING id,season_id AS "seasonId",sub_category AS "subCategory",tier::text,
         style_count_target AS "styleCountTarget",style_count_min AS "styleCountMin",
         style_count_max AS "styleCountMax",aos_units AS "aosUnits",
         total_units_implied AS "totalUnitsImplied",notes`,
      [styleCountTarget, aosUnits, notes, rowId],
    );
    res.json(rangePlanRowPayload(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

router.post("/range-plan/seasons/:seasonId/rows", async (req, res, next) => {
  try {
    const seasonId = Number(req.params.seasonId);
    const subCategory = String(req.body?.subCategory ?? "").trim();
    const tier = String(req.body?.tier ?? "Core");
    const styleCountTarget = Number(req.body?.styleCountTarget ?? 0);
    const styleCountMin = Number(req.body?.styleCountMin ?? 0);
    const styleCountMax = Number(req.body?.styleCountMax ?? 0);
    const aosUnits = Number(req.body?.aosUnits ?? rangePlanAosDefault(tier));
    if (!subCategory || subCategory.length > 120 || !["NOOS", "Core", "Recent", "New/Test"].includes(tier) ||
      ![styleCountTarget, styleCountMin, styleCountMax, aosUnits].every((value) => Number.isInteger(value) && value >= 0)) {
      res.status(400).json({ error: "A sub-category, valid tier and non-negative whole-number targets are required" });
      return;
    }
    if (!Number.isInteger(seasonId) || seasonId <= 0) {
      res.status(404).json({ error: "Planning season not found" });
      return;
    }
    const seasonExists = await pool.query(`SELECT 1 FROM ${schema}.range_plan_seasons WHERE id=$1`, [seasonId]);
    if (!seasonExists.rows[0]) {
      res.status(404).json({ error: "Planning season not found" });
      return;
    }
    const result = await pool.query(
      `INSERT INTO ${schema}.range_plan_rows
        (season_id,sub_category,tier,style_count_target,style_count_min,style_count_max,aos_units,notes)
       VALUES ($1,$2,$3::${schema}.range_plan_tier,$4,$5,$6,$7,$8)
       RETURNING id,season_id AS "seasonId",sub_category AS "subCategory",tier::text,
         style_count_target AS "styleCountTarget",style_count_min AS "styleCountMin",
         style_count_max AS "styleCountMax",aos_units AS "aosUnits",
         total_units_implied AS "totalUnitsImplied",notes`,
      [seasonId, subCategory, tier, styleCountTarget, styleCountMin, styleCountMax, aosUnits, String(req.body?.notes ?? "")],
    );
    res.status(201).json(rangePlanRowPayload(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

router.post("/range-plan/add-style", async (req: AuthRequest, res, next) => {
  const seasonId = Number(req.body?.seasonId);
  const source = String(req.body?.source ?? "").trim();
  const styleNumber = String(req.body?.styleNumber ?? "").trim();
  const pdId = Number(req.body?.pdId);
  if (!Number.isInteger(seasonId) || seasonId <= 0 || !["all_products_clean", "pd_styles"].includes(source)) {
    res.status(400).json({ error: "A valid range plan season and style source are required" });
    return;
  }
  const client = await pool.connect();
  try {
    const seasonExists = await client.query(`SELECT 1 FROM ${schema}.range_plan_seasons WHERE id=$1`, [seasonId]);
    if (!seasonExists.rows[0]) {
      res.status(404).json({ error: "Planning season not found" });
      return;
    }
    let style: { subCategory: string; tier: string } | undefined;
    if (source === "all_products_clean") {
      if (!styleNumber || styleNumber.length > 200) {
        res.status(400).json({ error: "A catalogue style number is required" });
        return;
      }
      style = await client.query<{ subCategory: string; tier: string }>(
        `SELECT
           COALESCE(MAX(NULLIF(TRIM(a.product_type),'')),MAX(NULLIF(TRIM(a.category),'')),'Uncategorised') AS "subCategory",
           CASE
             WHEN BOOL_OR(COALESCE(a.is_noos,FALSE) OR UPPER(COALESCE(a.tier,''))='NOOS' OR UPPER(COALESCE(a.range_tier,''))='NOOS') THEN 'NOOS'
             WHEN BOOL_OR(UPPER(COALESCE(a.range_tier,''))='CORE') THEN 'Core'
             WHEN BOOL_OR(UPPER(COALESCE(a.range_tier,''))='RECENT') THEN 'Recent'
             WHEN COALESCE(SUM(COALESCE(i.available,0)),0)>100 THEN 'Core'
             ELSE 'Recent'
           END AS tier
          FROM public.all_products_clean a
          LEFT JOIN public.all_inventory i ON i.sku=a.sku
          WHERE LOWER(BTRIM(COALESCE(a.brand,''))) = ANY(ARRAY['vivo','safari by vivo','zoya'])
            AND LOWER(BTRIM(COALESCE(a.status,''))) IN ('active','retired')
            AND LOWER(BTRIM(COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))))=LOWER(BTRIM($1))
          GROUP BY COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))`,
        [styleNumber],
      ).then((result) => result.rows[0]);
    } else {
      if (!Number.isInteger(pdId) || pdId <= 0) {
        res.status(400).json({ error: "A Product Development style is required" });
        return;
      }
      const result = await client.query<{ subCategory: string; tier: string }>(
        `SELECT COALESCE(NULLIF(TRIM(s.sub_category),''),NULLIF(TRIM(s.category),''),'Uncategorised') AS "subCategory",
                'New/Test' AS tier
         FROM public.pd_styles s
         WHERE ${allowedBrand("s")} AND s.id=$1`,
        [pdId],
      );
      style = result.rows[0];
    }
    if (!style) {
      res.status(404).json({ error: "Assortment style not found" });
      return;
    }
    const subCategory = String(style.subCategory || "Uncategorised").trim().slice(0, 120);
    const tier = ["NOOS", "Core", "Recent", "New/Test"].includes(style.tier) ? style.tier : "Core";
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO ${schema}.range_plan_rows
         (season_id,sub_category,tier,style_count_target,style_count_min,style_count_max,aos_units,notes)
       VALUES ($1,$2,$3::${schema}.range_plan_tier,1,0,1,$4,'')
       ON CONFLICT (season_id,sub_category) DO UPDATE
         SET style_count_target=${schema}.range_plan_rows.style_count_target+1
       RETURNING id,season_id AS "seasonId",sub_category AS "subCategory",tier::text,
         style_count_target AS "styleCountTarget",style_count_min AS "styleCountMin",
         style_count_max AS "styleCountMax",aos_units AS "aosUnits",
         total_units_implied AS "totalUnitsImplied",notes`,
      [seasonId, subCategory, tier, rangePlanAosDefault(tier)],
    );
    await client.query("COMMIT");
    res.status(201).json({ row: rangePlanRowPayload(result.rows[0]), subCategory, tier });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

router.post("/assortment-plan/add-style", async (req: AuthRequest, res, next) => {
  const season = String(req.body?.season ?? "").trim();
  const source = String(req.body?.source ?? "").trim();
  const styleNumber = String(req.body?.styleNumber ?? "").trim();
  const pdId = Number(req.body?.pdId);
  if (!PLM_SEASONS.includes(season as (typeof PLM_SEASONS)[number]) || !["all_products_clean", "pd_styles"].includes(source)) {
    res.status(400).json({ error: "A valid quarter and catalogue source are required" });
    return;
  }
  if (source === "all_products_clean" && (!styleNumber || styleNumber.length > 200)) {
    res.status(400).json({ error: "A catalogue style number is required" });
    return;
  }
  if (source === "pd_styles" && (!Number.isInteger(pdId) || pdId <= 0)) {
    res.status(400).json({ error: "A Product Development style is required" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let styleKey = styleNumber;
    let canonicalStyleNumber: string | null = styleNumber || null;
    if (source === "all_products_clean") {
      const result = await client.query<{ styleNumber: string }>(
        `SELECT MAX(COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))) AS "styleNumber"
           FROM public.all_products_clean a
          WHERE ${allowedBrand("a")}
            AND LOWER(COALESCE(a.status,'')) IN ('active','retired')
            AND COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))=$1
            AND LOWER(COALESCE(a.style_number,'')) NOT LIKE '%sample%'
            AND LOWER(COALESCE(a.category,'')) NOT LIKE '%sample%'
            AND LOWER(COALESCE(a.category,'')) NOT LIKE '%sale item%'
            AND LOWER(COALESCE(a.style_name,'')) NOT LIKE '%sample%'
          HAVING COUNT(*) > 0`,
        [styleNumber],
      );
      if (!result.rows[0]?.styleNumber) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Catalogue style not found" });
        return;
      }
      canonicalStyleNumber = result.rows[0].styleNumber;
      styleKey = canonicalStyleNumber;
    } else {
      const result = await client.query<{ styleNumber: string | null }>(
        `SELECT style_number AS "styleNumber"
           FROM public.pd_styles
          WHERE ${allowedBrand("s")} AND s.id=$1`,
        [pdId],
      );
      if (!result.rows[0]) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Product Development style not found" });
        return;
      }
      canonicalStyleNumber = result.rows[0].styleNumber;
      styleKey = String(pdId);
      await client.query(
        `UPDATE public.pd_styles
            SET season=CASE
              WHEN season IS NULL OR BTRIM(season)='' THEN $1
              WHEN POSITION($1 IN season) > 0 THEN season
              ELSE season || ',' || $1
            END
          WHERE id=$2`,
        [season, pdId],
      );
    }
    const inserted = await client.query(
      `INSERT INTO ${schema}.assortment_plan_styles
        (season,source,style_key,style_number,pd_style_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (season,source,style_key) DO NOTHING
       RETURNING season`,
      [season, source, styleKey, canonicalStyleNumber, source === "pd_styles" ? pdId : null],
    );
    await client.query("COMMIT");
    res.status(inserted.rowCount ? 201 : 200).json({
      added: Boolean(inserted.rowCount),
      season,
      source,
      styleNumber: canonicalStyleNumber,
      pdId: source === "pd_styles" ? pdId : null,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

router.put("/range-plan/seasons/:seasonId/otb", async (req, res, next) => {
  try {
    const seasonId = Number(req.params.seasonId);
    const monthYear = String(req.body?.monthYear ?? "");
    const revenueTarget = req.body?.revenueTarget == null || req.body?.revenueTarget === "" ? null : Number(req.body.revenueTarget);
    const plannedUnits = req.body?.plannedUnits == null || req.body?.plannedUnits === "" ? null : Number(req.body.plannedUnits);
    const newStylesCount = req.body?.newStylesCount == null || req.body?.newStylesCount === "" ? null : Number(req.body.newStylesCount);
    if (!/^\d{4}-\d{2}-01$/.test(monthYear) ||
      (revenueTarget !== null && (!Number.isFinite(revenueTarget) || revenueTarget < 0)) ||
      (plannedUnits !== null && (!Number.isInteger(plannedUnits) || plannedUnits < 0)) ||
      (newStylesCount !== null && (!Number.isInteger(newStylesCount) || newStylesCount < 0))) {
      res.status(400).json({ error: "Month and OTB values are invalid" });
      return;
    }
    if (!Number.isInteger(seasonId) || seasonId <= 0) {
      res.status(404).json({ error: "Planning season not found" });
      return;
    }
    const seasonResult = await pool.query<{ seasonName: string }>(
      `SELECT season_name AS "seasonName" FROM ${schema}.range_plan_seasons WHERE id=$1`,
      [seasonId],
    );
    if (!seasonResult.rows[0]) {
      res.status(404).json({ error: "Planning season not found" });
      return;
    }
    const allowedMonth = rangePlanMonthForSeason(seasonResult.rows[0].seasonName);
    if (allowedMonth !== null && monthYear !== allowedMonth) {
      res.status(400).json({ error: "Monthly plans only accept their configured OTB month" });
      return;
    }
    const result = await pool.query(
      `INSERT INTO ${schema}.range_plan_otb
        (season_id,month_year,revenue_target,planned_units,new_styles_count,notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (season_id,month_year) DO UPDATE SET
         revenue_target=EXCLUDED.revenue_target,
         planned_units=EXCLUDED.planned_units,
         new_styles_count=EXCLUDED.new_styles_count,
         notes=EXCLUDED.notes
       RETURNING id,month_year::text AS "monthYear",revenue_target AS "revenueTarget",
         planned_units AS "plannedUnits",new_styles_count AS "newStylesCount",notes`,
      [seasonId, monthYear, revenueTarget, plannedUnits, newStylesCount, String(req.body?.notes ?? "")],
    );
    res.json(rangePlanOtbPayload(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

const RESOURCE_CATEGORIES = ["Technical", "Planning", "Strategy", "Buying"] as const;
type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

function resourcePayload(row: Record<string, unknown>, includeContent = false) {
  return {
    id: Number(row.id),
    title: String(row.title ?? ""),
    category: String(row.category ?? "Planning") as ResourceCategory,
    description: String(row.description ?? ""),
    sourceUrl: String(row.sourceUrl ?? ""),
    ...(includeContent ? { contentMarkdown: String(row.contentMarkdown ?? "") } : {}),
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    createdBy: row.createdBy == null ? null : Number(row.createdBy),
  };
}

router.get("/resources", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id,title,category,description,
        source_url AS "sourceUrl",
        created_at AS "createdAt",updated_at AS "updatedAt",created_by AS "createdBy"
       FROM ${schema}.workspace_resources
       ORDER BY CASE category
         WHEN 'Technical' THEN 0
         WHEN 'Planning' THEN 1
         WHEN 'Strategy' THEN 2
         WHEN 'Buying' THEN 3
         ELSE 4
       END, title`,
    );
    res.json(result.rows.map((row) => resourcePayload(row)));
  } catch (error) {
    next(error);
  }
});

router.get("/resources/:id", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id,title,category,description,source_url AS "sourceUrl",content_markdown AS "contentMarkdown",
        created_at AS "createdAt",updated_at AS "updatedAt",created_by AS "createdBy"
       FROM ${schema}.workspace_resources WHERE id=$1`,
      [Number(req.params.id)],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    res.json(resourcePayload(result.rows[0], true));
  } catch (error) {
    next(error);
  }
});

router.post("/resources", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const title = String(req.body?.title ?? "").trim();
    const category = String(req.body?.category ?? "Planning").trim();
    const description = String(req.body?.description ?? "").trim();
    const sourceUrl = String(req.body?.sourceUrl ?? "").trim();
    const contentMarkdown = String(req.body?.contentMarkdown ?? "");
    if (!title || !description || !sourceUrl || !contentMarkdown.trim() || !RESOURCE_CATEGORIES.includes(category as ResourceCategory)) {
      res.status(400).json({ error: "Title, category, description, source URL and markdown content are required" });
      return;
    }
    const result = await pool.query(
      `INSERT INTO ${schema}.workspace_resources
        (title,category,description,source_url,content_markdown,created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,title,category,description,source_url AS "sourceUrl",content_markdown AS "contentMarkdown",
        created_at AS "createdAt",updated_at AS "updatedAt",created_by AS "createdBy"`,
      [title, category, description, sourceUrl, contentMarkdown, req.workspaceUser?.id ?? null],
    );
    res.status(201).json(resourcePayload(result.rows[0], true));
  } catch (error) {
    next(error);
  }
});

router.put("/resources/:id", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const title = String(req.body?.title ?? "").trim();
    const category = String(req.body?.category ?? "Planning").trim();
    const description = String(req.body?.description ?? "").trim();
    const sourceUrl = String(req.body?.sourceUrl ?? "").trim();
    const contentMarkdown = String(req.body?.contentMarkdown ?? "");
    if (!title || !description || !sourceUrl || !contentMarkdown.trim() || !RESOURCE_CATEGORIES.includes(category as ResourceCategory)) {
      res.status(400).json({ error: "Title, category, description, source URL and markdown content are required" });
      return;
    }
    const result = await pool.query(
      `UPDATE ${schema}.workspace_resources
       SET title=$1,category=$2,description=$3,source_url=$4,content_markdown=$5,updated_at=NOW()
       WHERE id=$6
       RETURNING id,title,category,description,source_url AS "sourceUrl",content_markdown AS "contentMarkdown",
        created_at AS "createdAt",updated_at AS "updatedAt",created_by AS "createdBy"`,
      [title, category, description, sourceUrl, contentMarkdown, Number(req.params.id)],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    res.json(resourcePayload(result.rows[0], true));
  } catch (error) {
    next(error);
  }
});

router.delete("/resources/:id", requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM ${schema}.workspace_resources WHERE id=$1 RETURNING id`,
      [Number(req.params.id)],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get("/feedback", async (req: AuthRequest, res, next) => {
  try {
    const values: unknown[] = [];
    const clauses = [`1=1`, `(f.style_id IS NULL OR s.id IS NOT NULL)`];
    const add = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const styleId = Number(req.query.styleId);
    if (Number.isInteger(styleId) && styleId > 0) clauses.push(`f.style_id=${add(styleId)}`);
    const from = String(req.query.from ?? "").trim();
    const to = String(req.query.to ?? "").trim();
    const team = String(req.query.team ?? "").trim();
    const feedbackType = String(req.query.feedbackType ?? "").trim();
    const sentiment = String(req.query.sentiment ?? "").trim();
    const styleSearch = String(req.query.styleSearch ?? "").trim();
    if (from) clauses.push(`f.created_at >= ${add(from)}::date`);
    if (to) clauses.push(`f.created_at < (${add(to)}::date + INTERVAL '1 day')`);
    if (team) clauses.push(`f.submitter_team=${add(team)}`);
    if (feedbackType) clauses.push(`${add(feedbackType)} = ANY(f.feedback_types)`);
    if (FEEDBACK_SENTIMENTS.includes(sentiment as FeedbackSentiment)) clauses.push(`f.sentiment=${add(sentiment)}`);
    if (styleSearch) {
      const needle = add(`%${styleSearch}%`);
      clauses.push(`(COALESCE(s.name,'') ILIKE ${needle} OR COALESCE(s.code,f.style_number,'') ILIKE ${needle} OR f.style_name_freetext ILIKE ${needle})`);
    }
    const result = await pool.query(
       `SELECT f.id,f.submitter_name AS "submitterName",f.submitter_team AS "submitterTeam",
         f.style_id AS "styleId",COALESCE(NULLIF(TRIM(s.name),''),NULLIF(TRIM(f.style_name_freetext),''),'Unassigned style') AS "styleName",
         COALESCE(s.code,f.style_number) AS "styleNumber",s.image AS "styleImage",f.colourway,
         f.style_name_freetext AS "styleNameFreetext",
          f.customer_origin AS "customerOrigin",f.customer_id AS "customerId",
          f.customer_name AS "customerName",f.store_name AS "storeName",
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id',i.id,'filename',i.original_name,'contentType',i.content_type,'sizeBytes',i.byte_size
           ) ORDER BY i.id),'[]'::jsonb)
            FROM ${schema}.style_feedback_images i WHERE i.feedback_id=f.id) AS "imageAttachments",
        f.feedback_types AS "feedbackTypes",f.sentiment,f.urgency,f.comment_text AS "commentText",
        f.reviewed,f.reviewed_by AS "reviewedBy",f.reviewed_at AS "reviewedAt",f.created_at AS "createdAt"
       FROM ${schema}.style_feedback f
        LEFT JOIN ${schema}.styles s ON s.id=f.style_id AND ${allowedBrand("s")}
       WHERE ${clauses.join(" AND ")}
       ORDER BY f.created_at DESC,f.id DESC
       LIMIT 1000`,
      values,
    );
    const quarterly = await pool.query(
      `WITH base AS (
        SELECT f.*,COALESCE(NULLIF(TRIM(s.name),''),NULLIF(TRIM(f.style_name_freetext),''),'Unassigned style') AS style_name
         FROM ${schema}.style_feedback f LEFT JOIN ${schema}.styles s ON s.id=f.style_id AND ${allowedBrand("s")}
         WHERE f.created_at >= ${FEEDBACK_QUARTER_START_SQL}
           AND (f.style_id IS NULL OR s.id IS NOT NULL)
      )
      SELECT COUNT(*)::int AS "totalSubmissionsThisQuarter",
        (SELECT style_name FROM base WHERE style_name <> 'Unassigned style'
         GROUP BY style_name ORDER BY COUNT(*) DESC,style_name LIMIT 1) AS "mostFlaggedStyleThisQuarter",
        (SELECT type FROM base,UNNEST(feedback_types) AS type
         GROUP BY type ORDER BY COUNT(*) DESC,type LIMIT 1) AS "mostCommonFeedbackTypeThisQuarter",
        COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE sentiment='negative') / NULLIF(COUNT(*),0),1),0)::float AS "negativePercentThisQuarter"
       FROM base`,
    );
    const pulses = await pool.query(
      `SELECT p.id,p.style_id AS "styleId",p.style_number AS "styleNumber",
          COALESCE(NULLIF(TRIM(s.name),''),p.style_number) AS "styleName",
          s.image AS "styleImage",p.mode,p.colourway,
          p.share_path AS "sharePath",p.created_at AS "createdAt",
          COUNT(f.id)::int AS "responseCount"
       FROM ${schema}.style_feedback_pulses p
       LEFT JOIN ${schema}.styles s ON s.id=p.style_id AND ${allowedBrand("s")}
       LEFT JOIN ${schema}.style_feedback f ON f.pulse_id=p.id
       GROUP BY p.id,p.style_id,p.style_number,s.name,s.image,p.mode,p.colourway,p.share_path,p.created_at
       ORDER BY p.created_at DESC,p.id DESC
       LIMIT 500`,
    );
    res.json({
      viewer: { role: req.workspaceUser?.role ?? null },
      stats: quarterly.rows[0] ?? {
        totalSubmissionsThisQuarter: 0,
        mostFlaggedStyleThisQuarter: null,
        mostCommonFeedbackTypeThisQuarter: null,
        negativePercentThisQuarter: 0,
      },
      submissions: result.rows.map((row) => feedbackPayload(row)),
      stylePulses: pulses.rows.map((row) => ({
        id: Number(row.id),
        styleId: row.styleId == null ? null : Number(row.styleId),
        styleNumber: String(row.styleNumber ?? ""),
        styleName: String(row.styleName ?? row.styleNumber ?? ""),
        styleImage: feedbackImagePayload(row.styleImage),
        mode: String(row.mode) as PulseMode,
        colourway: row.colourway == null ? null : String(row.colourway),
        sharePath: String(row.sharePath ?? ""),
        createdAt: row.createdAt ?? null,
        responseCount: Number(row.responseCount ?? 0),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/feedback/images/:id", async (req, res, next) => {
  try {
    const imageId = Number(req.params.id);
    if (!Number.isInteger(imageId) || imageId < 1) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
    const image = await pool.query<{ objectPath: string; originalName: string; contentType: string }>(
      `SELECT object_path AS "objectPath",original_name AS "originalName",content_type AS "contentType"
         FROM ${schema}.style_feedback_images
        WHERE id=$1 AND feedback_id IS NOT NULL`,
      [imageId],
    );
    const row = image.rows[0];
    if (!row) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
    const object = await fetch(await signedStorageUrl(row.objectPath, "GET", 300), { signal: AbortSignal.timeout(30_000) });
    if (!object.ok || !object.body) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
    const safeFilename = row.originalName.replace(/["\\\r\n]/g, "_") || "feedback-image";
    const download = String(req.query.download ?? "") === "1";
    res.setHeader("Content-Type", row.contentType);
    res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${safeFilename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    Readable.fromWeb(object.body as ReadableStream<Uint8Array>).pipe(res);
  } catch (error) {
    next(error);
  }
});

router.patch("/feedback/:id/review", requireAdmin, async (req: AuthRequest, res, next) => {
  try {
    const reviewed = req.body?.reviewed !== false;
    const result = await pool.query(
       `UPDATE ${schema}.style_feedback
       SET reviewed=$1,reviewed_by=$2,reviewed_at=CASE WHEN $1 THEN NOW() ELSE NULL END
       WHERE id=$3
       RETURNING id,submitter_name AS "submitterName",submitter_team AS "submitterTeam",
         style_id AS "styleId",style_number AS "styleNumber",colourway,
         style_name_freetext AS "styleNameFreetext",feedback_types AS "feedbackTypes",
         sentiment,urgency,comment_text AS "commentText",
         customer_origin AS "customerOrigin",customer_id AS "customerId",customer_name AS "customerName",store_name AS "storeName",
         reviewed,reviewed_by AS "reviewedBy",
        reviewed_at AS "reviewedAt",created_at AS "createdAt"`,
      [reviewed, reviewed ? req.workspaceUser?.id ?? null : null, Number(req.params.id)],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Feedback submission not found" });
      return;
    }
    res.json(feedbackPayload(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

const TEAM_ROLES = ["Admin", "Design", "Buying", "Retail", "Finance"] as const;

router.get("/l10/meetings", async (_req, res, next) => {
  try {
    const monday = l10Monday().toISOString().slice(0, 10);
    const result = await pool.query(
      `SELECT id,week_label AS "weekLabel",meeting_date::text AS "meetingDate",
        start_time AS "startTime",end_time AS "endTime",location,
         duration_minutes AS "durationMinutes",concluded,concluded_at AS "concludedAt",created_at AS "createdAt",
        meeting_date >= $1::date AS "isCurrent"
       FROM ${schema}.l10_meetings ORDER BY meeting_date DESC`,
      [monday],
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.get("/l10/meetings/:meetingId", async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    const monday = l10Monday().toISOString().slice(0, 10);
    const meetingResult = await pool.query(
      `SELECT id,week_label AS "weekLabel",meeting_date::text AS "meetingDate",
        start_time AS "startTime",end_time AS "endTime",location,
         duration_minutes AS "durationMinutes",concluded,concluded_at AS "concludedAt",created_at AS "createdAt",
        meeting_date >= $2::date AS "isCurrent"
       FROM ${schema}.l10_meetings WHERE id=$1`,
      [meetingId, monday],
    );
    const meeting = meetingResult.rows[0];
    if (!meeting) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    const meetings = await pool.query(
      `SELECT id,week_label AS "weekLabel",meeting_date::text AS "meetingDate",
        start_time AS "startTime",end_time AS "endTime",location,
         duration_minutes AS "durationMinutes",concluded,concluded_at AS "concludedAt",created_at AS "createdAt",
        meeting_date >= $1::date AS "isCurrent"
       FROM ${schema}.l10_meetings ORDER BY meeting_date DESC LIMIT 7`,
      [monday],
    );
    const historyMeetings = [...meetings.rows].reverse();
    const historyIds = historyMeetings.map((row) => row.id);
    const checkins = await pool.query(
      `SELECT id,member_name AS "memberName",personal_good_news AS "personalGoodNews",
        professional_good_news AS "professionalGoodNews"
       FROM ${schema}.l10_checkins WHERE meeting_id=$1 ORDER BY id`,
      [meetingId],
    );
    const metrics = await pool.query(
      `SELECT m.id,m.owner,m.measurable,m.goal,m.uom,
        m.metric_key AS "metricKey",
        e.value::float AS "thisWeek",e.on_track AS "onTrack",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'weekLabel',hm.week_label,'meetingDate',hm.meeting_date::text,
            'value',he.value::float,'onTrack',he.on_track
          ) ORDER BY hm.meeting_date)
          FROM ${schema}.l10_scorecard_entries he
          JOIN ${schema}.l10_meetings hm ON hm.id=he.meeting_id
          WHERE he.metric_id=m.id AND he.meeting_id = ANY($1::int[])
        ), '[]'::jsonb) AS history
       FROM ${schema}.l10_scorecard_metrics m
       LEFT JOIN ${schema}.l10_scorecard_entries e
         ON e.metric_id=m.id AND e.meeting_id=$2
       WHERE m.active ORDER BY m.sort_order,m.id`,
      [historyIds, meetingId],
    );
    const rocks = await pool.query(
      `SELECT id,description,owner,status,sort_order AS "sortOrder"
       FROM ${schema}.l10_rocks ORDER BY sort_order,id`,
    );
    const notes = await pool.query(
      `SELECT headlines,todos,ids,conclude FROM ${schema}.l10_agenda_notes WHERE meeting_id=$1`,
      [meetingId],
    );
    const headlines = await pool.query(
      `SELECT id,headline,headline_date::text AS "headlineDate",added_by AS "addedBy",
         needs_discussion AS "needsDiscussion",sort_order AS "sortOrder"
       FROM ${schema}.l10_headlines WHERE meeting_id=$1 ORDER BY sort_order,id`,
      [meetingId],
    );
    const todos = await pool.query(
      `SELECT id,description,open_date::text AS "openDate",owner,status,
         linked_issue_id AS "linkedIssueId"
       FROM ${schema}.l10_todos WHERE meeting_id=$1
       ORDER BY CASE WHEN status='Done' THEN 1 ELSE 0 END,open_date NULLS LAST,id`,
      [meetingId],
    );
    const todoStats = await pool.query(
      `SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status='Done')::int AS "completedOnTime"
       FROM ${schema}.l10_todos
       WHERE open_date >= ($2::date - INTERVAL '7 days') AND open_date < $2::date`,
      [meetingId, meeting.meetingDate],
    );
    const issues = await pool.query(
      `SELECT id,issue,raised_by AS "raisedBy",priority,issue_type AS "issueType",
         resolution_notes AS "resolutionNotes",sort_order AS "sortOrder",
         resolved_at AS "resolvedAt",linked_todo_id AS "linkedTodoId"
       FROM ${schema}.l10_issues WHERE meeting_id=$1
       ORDER BY CASE issue_type WHEN 'active' THEN 0 WHEN 'parking' THEN 1 ELSE 2 END,sort_order,id`,
      [meetingId],
    );
    const ratings = await pool.query(
      `SELECT id,team_member_name AS "teamMemberName",rating
       FROM ${schema}.l10_ratings WHERE meeting_id=$1 ORDER BY team_member_name`,
      [meetingId],
    );
    const ratingHistory = await pool.query(
      `SELECT hm.week_label AS "weekLabel",ROUND(AVG(lr.rating)::numeric,1)::float AS average,
         COALESCE(jsonb_agg(jsonb_build_object(
           'id',lr.id,'teamMemberName',lr.team_member_name,'rating',lr.rating
         ) ORDER BY lr.team_member_name),'[]'::jsonb) AS ratings
       FROM ${schema}.l10_meetings hm
       LEFT JOIN ${schema}.l10_ratings lr ON lr.meeting_id=hm.id
       WHERE hm.id=ANY($1::int[])
       GROUP BY hm.id,hm.week_label,hm.meeting_date
       ORDER BY hm.meeting_date`,
      [historyIds],
    );
    const cascadingMessage = await pool.query(
      `SELECT message FROM ${schema}.l10_cascading_messages WHERE meeting_id=$1`,
      [meetingId],
    );
    const teamMembers = await pool.query(
      `SELECT DISTINCT COALESCE(NULLIF(TRIM(name),''),NULLIF(TRIM(role_title),'')) AS name
       FROM ${schema}.workspace_team_members
       WHERE COALESCE(NULLIF(TRIM(name),''),NULLIF(TRIM(role_title),'')) IS NOT NULL
       ORDER BY name`,
    );
    res.json({
      meeting,
      agenda: L10_AGENDA,
      historyMeetings,
      checkins: checkins.rows,
      metrics: metrics.rows,
      rocks: rocks.rows,
      notes: notes.rows[0] ?? { headlines: "", todos: "", ids: "", conclude: "" },
      headlines: headlines.rows,
      todos: todos.rows,
      todosStat: todoStats.rows[0] ?? { total: 0, completedOnTime: 0 },
      issues: issues.rows,
      ratings: ratings.rows,
      ratingHistory: ratingHistory.rows,
      cascadingMessage: cascadingMessage.rows[0]?.message ?? notes.rows[0]?.conclude ?? "",
      teamMembers: teamMembers.rows.map((row) => row.name),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/l10/scorecard/live", liveScorecardHandler);

router.put("/l10/meetings/:meetingId/checkins", async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    for (const row of rows) {
      const memberName = String(row.memberName ?? "").trim();
      if (!memberName) continue;
      await pool.query(
        `INSERT INTO ${schema}.l10_checkins
          (meeting_id,member_name,personal_good_news,professional_good_news,updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (meeting_id,member_name) DO UPDATE
         SET personal_good_news=EXCLUDED.personal_good_news,
             professional_good_news=EXCLUDED.professional_good_news,updated_at=NOW()`,
        [meetingId, memberName, String(row.personalGoodNews ?? ""), String(row.professionalGoodNews ?? "")],
      );
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put("/l10/meetings/:meetingId/scorecard/:metricId", async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    const metricId = Number(req.params.metricId);
    const metricResult = await pool.query<{ goal: string }>(
      `SELECT goal FROM ${schema}.l10_scorecard_metrics WHERE id=$1`,
      [metricId],
    );
    if (!metricResult.rows[0]) {
      res.status(404).json({ error: "Metric not found" });
      return;
    }
    const rawValue = req.body?.value;
    const value = rawValue === null || rawValue === "" || rawValue === undefined ? null : Number(rawValue);
    if (value !== null && !Number.isFinite(value)) {
      res.status(400).json({ error: "Scorecard value must be numeric" });
      return;
    }
    const onTrack = typeof req.body?.onTrack === "boolean"
      ? req.body.onTrack
      : l10GoalStatus(value, metricResult.rows[0].goal);
    const result = await pool.query(
      `INSERT INTO ${schema}.l10_scorecard_entries (meeting_id,metric_id,value,on_track,updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (meeting_id,metric_id) DO UPDATE
       SET value=EXCLUDED.value,on_track=EXCLUDED.on_track,updated_at=NOW()
       RETURNING id,value::float AS value,on_track AS "onTrack"`,
      [meetingId, metricId, value, onTrack],
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.put("/l10/rocks/:rockId", async (req, res, next) => {
  try {
    const status = String(req.body?.status ?? "").trim();
    if (!["On Track", "Off Track", "Done"].includes(status)) {
      res.status(400).json({ error: "Rock status must be On Track, Off Track, or Done" });
      return;
    }
    const result = await pool.query(
      `UPDATE ${schema}.l10_rocks SET status=$1 WHERE id=$2
       RETURNING id,description,owner,status,sort_order AS "sortOrder"`,
      [status, Number(req.params.rockId)],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Rock not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.put("/l10/meetings/:meetingId/notes", async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    const fields = ["headlines", "todos", "ids", "conclude"] as const;
    const values = fields.map((field) => String(req.body?.[field] ?? ""));
    const result = await pool.query(
      `INSERT INTO ${schema}.l10_agenda_notes (meeting_id,headlines,todos,ids,conclude,updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (meeting_id) DO UPDATE
       SET headlines=EXCLUDED.headlines,todos=EXCLUDED.todos,ids=EXCLUDED.ids,
           conclude=EXCLUDED.conclude,updated_at=NOW()
       RETURNING headlines,todos,ids,conclude`,
      [meetingId, ...values],
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

async function assertL10MeetingOpen(meetingId: number, res: Response) {
  const result = await pool.query<{ concluded: boolean }>(
    `SELECT concluded FROM ${schema}.l10_meetings WHERE id=$1`,
    [meetingId],
  );
  if (!result.rows[0]) {
    res.status(404).json({ error: "Meeting not found" });
    return false;
  }
  if (result.rows[0].concluded) {
    res.status(409).json({ error: "This meeting has concluded and is read-only" });
    return false;
  }
  return true;
}

router.put("/l10/meetings/:meetingId/headlines", async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    if (!(await assertL10MeetingOpen(meetingId, res))) return;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const ids = rows.map((row: any) => Number(row.id)).filter((id: number) => Number.isInteger(id) && id > 0);
    if (ids.length) {
      await pool.query(`DELETE FROM ${schema}.l10_headlines WHERE meeting_id=$1 AND NOT (id=ANY($2::int[]))`, [meetingId, ids]);
    } else {
      await pool.query(`DELETE FROM ${schema}.l10_headlines WHERE meeting_id=$1`, [meetingId]);
    }
    for (const [sortOrder, row] of rows.entries()) {
      const headline = String(row.headline ?? "").trim();
      if (!headline) continue;
      const values = [
        headline,
        row.headlineDate || null,
        String(row.addedBy ?? "").trim(),
        Boolean(row.needsDiscussion),
        sortOrder,
      ];
      if (Number.isInteger(Number(row.id)) && Number(row.id) > 0) {
        await pool.query(
          `UPDATE ${schema}.l10_headlines
           SET headline=$1,headline_date=$2,added_by=$3,needs_discussion=$4,sort_order=$5
           WHERE id=$6 AND meeting_id=$7`,
          [...values, Number(row.id), meetingId],
        );
      } else {
        await pool.query(
          `INSERT INTO ${schema}.l10_headlines
            (meeting_id,headline,headline_date,added_by,needs_discussion,sort_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [meetingId, ...values],
        );
      }
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put("/l10/meetings/:meetingId/todos", async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    if (!(await assertL10MeetingOpen(meetingId, res))) return;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const ids = rows.map((row: any) => Number(row.id)).filter((id: number) => Number.isInteger(id) && id > 0);
    if (ids.length) {
      await pool.query(`DELETE FROM ${schema}.l10_todos WHERE meeting_id=$1 AND NOT (id=ANY($2::int[]))`, [meetingId, ids]);
    } else {
      await pool.query(`DELETE FROM ${schema}.l10_todos WHERE meeting_id=$1`, [meetingId]);
    }
    for (const row of rows) {
      const description = String(row.description ?? "").trim();
      if (!description) continue;
      const status = row.status === "Done" ? "Done" : "Not Done";
      const values = [description, row.openDate || null, String(row.owner ?? "").trim(), status, row.linkedIssueId || null];
      if (Number.isInteger(Number(row.id)) && Number(row.id) > 0) {
        await pool.query(
          `UPDATE ${schema}.l10_todos
           SET description=$1,open_date=$2,owner=$3,status=$4,linked_issue_id=$5,updated_at=NOW()
           WHERE id=$6 AND meeting_id=$7`,
          [...values, Number(row.id), meetingId],
        );
      } else {
        await pool.query(
          `INSERT INTO ${schema}.l10_todos
            (meeting_id,description,open_date,owner,status,linked_issue_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [meetingId, ...values],
        );
      }
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put("/l10/meetings/:meetingId/issues/reorder", async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    if (!(await assertL10MeetingOpen(meetingId, res))) return;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    for (const [sortOrder, row] of rows.entries()) {
      if (!Number.isInteger(Number(row.id))) continue;
      await pool.query(
        `UPDATE ${schema}.l10_issues SET sort_order=$1 WHERE id=$2 AND meeting_id=$3 AND issue_type='active'`,
        [sortOrder, Number(row.id), meetingId],
      );
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post("/l10/meetings/:meetingId/issues", async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    if (!(await assertL10MeetingOpen(meetingId, res))) return;
    const issue = String(req.body?.issue ?? "").trim();
    if (!issue) {
      res.status(400).json({ error: "Issue is required" });
      return;
    }
    const result = await pool.query(
      `INSERT INTO ${schema}.l10_issues
        (meeting_id,issue,raised_by,priority,issue_type,sort_order)
       SELECT $1,$2,$3,COALESCE(MAX(priority),0)+1,'active',COALESCE(MAX(sort_order),-1)+1
       FROM ${schema}.l10_issues WHERE meeting_id=$1 AND issue_type='active'
       RETURNING id,issue,raised_by AS "raisedBy",priority,issue_type AS "issueType",
         resolution_notes AS "resolutionNotes",sort_order AS "sortOrder"`,
      [meetingId, issue, String(req.body?.raisedBy ?? "Team").trim()],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.put("/l10/issues/:issueId", async (req, res, next) => {
  try {
    const issueId = Number(req.params.issueId);
    const issueResult = await pool.query<{ meetingId: number; issueType: string }>(
      `SELECT meeting_id AS "meetingId",issue_type AS "issueType" FROM ${schema}.l10_issues WHERE id=$1`,
      [issueId],
    );
    const issue = issueResult.rows[0];
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertL10MeetingOpen(issue.meetingId, res))) return;
    const action = String(req.body?.action ?? "");
    if (action === "resolve") {
      const result = await pool.query(
        `UPDATE ${schema}.l10_issues
         SET issue_type='resolved',resolution_notes=$1,resolved_at=NOW()
         WHERE id=$2 RETURNING id,issue,raised_by AS "raisedBy",priority,issue_type AS "issueType",
         resolution_notes AS "resolutionNotes",sort_order AS "sortOrder"`,
        [String(req.body?.resolutionNotes ?? "").trim(), issueId],
      );
      res.json(result.rows[0]);
      return;
    }
    if (action === "parking") {
      const result = await pool.query(
        `UPDATE ${schema}.l10_issues SET issue_type='parking' WHERE id=$1
         RETURNING id,issue,raised_by AS "raisedBy",priority,issue_type AS "issueType",
         resolution_notes AS "resolutionNotes",sort_order AS "sortOrder"`,
        [issueId],
      );
      res.json(result.rows[0]);
      return;
    }
    res.status(400).json({ error: "Unsupported issue action" });
  } catch (error) {
    next(error);
  }
});

router.post("/l10/issues/:issueId/todo", async (req, res, next) => {
  try {
    const issueId = Number(req.params.issueId);
    const issueResult = await pool.query<{ meetingId: number; issue: string; raisedBy: string }>(
      `SELECT meeting_id AS "meetingId",issue,raised_by AS "raisedBy"
       FROM ${schema}.l10_issues WHERE id=$1`,
      [issueId],
    );
    const issue = issueResult.rows[0];
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertL10MeetingOpen(issue.meetingId, res))) return;
    const result = await pool.query(
      `INSERT INTO ${schema}.l10_todos
        (meeting_id,description,open_date,owner,status,linked_issue_id)
       VALUES ($1,$2,CURRENT_DATE,$3,'Not Done',$4)
       RETURNING id,description,open_date::text AS "openDate",owner,status,linked_issue_id AS "linkedIssueId"`,
      [issue.meetingId, `Follow up: ${issue.issue}`, issue.raisedBy, issueId],
    );
    await pool.query(`UPDATE ${schema}.l10_issues SET linked_todo_id=$1 WHERE id=$2`, [result.rows[0].id, issueId]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.put("/l10/meetings/:meetingId/ratings", async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    if (!(await assertL10MeetingOpen(meetingId, res))) return;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    for (const row of rows) {
      const name = String(row.teamMemberName ?? "").trim();
      if (!name) continue;
      const rating = row.rating === null || row.rating === "" ? null : Number(row.rating);
      if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 10)) {
        res.status(400).json({ error: "Ratings must be whole numbers from 1 to 10" });
        return;
      }
      await pool.query(
        `INSERT INTO ${schema}.l10_ratings (meeting_id,team_member_name,rating)
         VALUES ($1,$2,$3)
         ON CONFLICT (meeting_id,team_member_name) DO UPDATE
         SET rating=EXCLUDED.rating,updated_at=NOW()`,
        [meetingId, name, rating],
      );
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.put("/l10/meetings/:meetingId/cascading-message", async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    if (!(await assertL10MeetingOpen(meetingId, res))) return;
    const message = String(req.body?.message ?? "");
    const result = await pool.query(
      `INSERT INTO ${schema}.l10_cascading_messages (meeting_id,message,updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (meeting_id) DO UPDATE SET message=EXCLUDED.message,updated_at=NOW()
       RETURNING message`,
      [meetingId, message],
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.post("/l10/meetings/:meetingId/end", async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    const result = await pool.query(
      `UPDATE ${schema}.l10_meetings
       SET concluded=TRUE,concluded_at=COALESCE(concluded_at,NOW())
       WHERE id=$1
       RETURNING id,week_label AS "weekLabel",meeting_date::text AS "meetingDate",
         start_time AS "startTime",end_time AS "endTime",location,duration_minutes AS "durationMinutes",
         concluded,concluded_at AS "concludedAt",created_at AS "createdAt"`,
      [meetingId],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Meeting not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get("/team-directory", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id,name,role_title AS "roleTitle",team_section AS "teamSection",
        description,birthday::text AS birthday,photo_url AS "photoPath",is_lma AS "isLma",
        display_order AS "displayOrder",created_at AS "createdAt"
       FROM ${schema}.workspace_team_members
       ORDER BY team_section,display_order,id`,
    );
    res.json(result.rows.map((row) => teamMemberPayload(row)));
  } catch (error) {
    next(error);
  }
});

router.post("/team-directory/upload-url", requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const size = Number(req.body?.size ?? 0);
    const contentType = String(req.body?.contentType ?? "").trim().toLowerCase();
    if (!name || !Number.isFinite(size) || size <= 0 || size > 8 * 1024 * 1024) {
      res.status(400).json({ error: "Photo must be between 1 byte and 8 MB" });
      return;
    }
    if (!["image/jpeg", "image/png"].includes(contentType)) {
      res.status(400).json({ error: "Only JPG and PNG photos are supported" });
      return;
    }
    const objectPath = `/objects/team-directory/uploads/${sessionToken()}`;
    const uploadUrl = await signedStorageUrl(objectPath, "PUT", 900);
    res.json({ uploadUrl, objectPath });
  } catch (error) {
    next(error);
  }
});

router.get("/team-directory/:id/photo", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await pool.query<{ photoPath: string | null }>(
      `SELECT photo_url AS "photoPath" FROM ${schema}.workspace_team_members WHERE id=$1`,
      [id],
    );
    const objectPath = result.rows[0]?.photoPath;
    if (!objectPath) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    const photo = await fetch(await signedStorageUrl(objectPath, "GET", 300));
    if (!photo.ok || !photo.body) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    res.status(photo.status);
    const contentType = photo.headers.get("content-type");
    const contentLength = photo.headers.get("content-length");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    res.setHeader("Cache-Control", "private, max-age=300");
    Readable.fromWeb(photo.body as ReadableStream<Uint8Array>).pipe(res);
  } catch (error) {
    next(error);
  }
});

router.post("/garment-images/upload-url", requireUser, async (req: AuthRequest, res, next) => {
  try {
    const source = garmentImageSource(req.body?.source);
    const styleKey = garmentImageKey(req.body?.styleKey);
    const validation = validateGarmentImageMeta(req.body?.name, req.body?.size, req.body?.contentType);
    if (!source || !styleKey || styleKey.length > 200) {
      res.status(400).json({ error: "A valid garment image source and style identifier are required" });
      return;
    }
    if ("error" in validation) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const objectPath = `/objects/garment-images/${source}/${crypto.randomUUID()}.${validation.originalName.split(".").pop()!.toLowerCase()}`;
    const uploadUrl = await signedStorageUrl(objectPath, "PUT", 900);
    res.json({ uploadUrl, objectPath, expiresInSeconds: 900 });
  } catch (error) {
    next(error);
  }
});

router.post("/garment-images/finalize", requireUser, async (req: AuthRequest, res, next) => {
  let newObjectPath = "";
  try {
    const source = garmentImageSource(req.body?.source);
    const styleKey = garmentImageKey(req.body?.styleKey);
    const validation = validateGarmentImageMeta(req.body?.name, req.body?.size, req.body?.contentType);
    newObjectPath = String(req.body?.objectPath ?? "");
    const expectedPrefix = source ? `/objects/garment-images/${source}/` : "";
    if (!source || !styleKey || styleKey.length > 200 || !newObjectPath.startsWith(expectedPrefix) || newObjectPath.includes("..")) {
      res.status(400).json({ error: "Invalid garment image upload" });
      return;
    }
    if ("error" in validation) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const stored = await fetch(await signedStorageUrl(newObjectPath, "GET", 120), { signal: AbortSignal.timeout(30_000) });
    const storedBytes = new Uint8Array(await stored.arrayBuffer());
    const config = GARMENT_IMAGE_TYPES[validation.contentType];
    if (!stored.ok || storedBytes.length !== validation.byteSize || !config.magic(storedBytes)) {
      await deleteGarmentObject(newObjectPath);
      res.status(400).json({ error: "The uploaded file does not match the selected image type" });
      return;
    }
    const client = await pool.connect();
    let replacedPath: string | null = null;
    try {
      await client.query("BEGIN");
      const prior = await client.query<{ objectPath: string }>(
        `SELECT object_path AS "objectPath" FROM ${schema}.garment_images WHERE source=$1 AND style_key=$2 FOR UPDATE`,
        [source, styleKey],
      );
      replacedPath = prior.rows[0]?.objectPath ?? null;
      await client.query(
        `INSERT INTO ${schema}.garment_images
          (source,style_key,object_path,original_name,content_type,byte_size,updated_by,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (source,style_key) DO UPDATE SET
           object_path=EXCLUDED.object_path,original_name=EXCLUDED.original_name,
           content_type=EXCLUDED.content_type,byte_size=EXCLUDED.byte_size,
           updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
        [source, styleKey, newObjectPath, validation.originalName, validation.contentType, validation.byteSize, req.workspaceUser?.id ?? null],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (replacedPath && replacedPath !== newObjectPath) void deleteGarmentObject(replacedPath);
    res.json({ source, styleKey, imageUrl: garmentImageUrl(source, styleKey) });
  } catch (error) {
    if (newObjectPath) void deleteGarmentObject(newObjectPath);
    next(error);
  }
});

router.get("/garment-images/:source/:styleKey", requireUser, async (req, res, next) => {
  try {
    const source = garmentImageSource(req.params.source);
    const styleKey = garmentImageKey(req.params.styleKey);
    if (!source || !styleKey) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
    const image = await pool.query<{ objectPath: string; contentType: string }>(
      `SELECT object_path AS "objectPath",content_type AS "contentType"
       FROM ${schema}.garment_images WHERE source=$1 AND style_key=$2`,
      [source, styleKey],
    );
    const row = image.rows[0];
    if (!row) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
    const object = await fetch(await signedStorageUrl(row.objectPath, "GET", 300));
    if (!object.ok || !object.body) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
    res.setHeader("Content-Type", row.contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    Readable.fromWeb(object.body as ReadableStream<Uint8Array>).pipe(res);
  } catch (error) {
    next(error);
  }
});

router.post("/team-directory", requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const roleTitle = String(req.body?.roleTitle ?? "").trim();
    const teamSection = String(req.body?.teamSection ?? "").trim();
    const description = String(req.body?.description ?? "").trim();
    const birthday = normalizeTeamBirthday(req.body?.birthday);
    const isLma = Boolean(req.body?.isLma);
    if (!roleTitle || !teamSection) {
      res.status(400).json({ error: "Role title and team section are required" });
      return;
    }
    if (req.body?.birthday && !birthday) {
      res.status(400).json({ error: "Birthday must be a valid month and day" });
      return;
    }
    const orderResult = await pool.query<{ nextOrder: number }>(
      `SELECT COALESCE(MAX(display_order),-1)+1 AS "nextOrder"
       FROM ${schema}.workspace_team_members WHERE team_section=$1`,
      [teamSection],
    );
    const result = await pool.query(
      `INSERT INTO ${schema}.workspace_team_members
        (name,role_title,team_section,description,birthday,is_lma,display_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,name,role_title AS "roleTitle",team_section AS "teamSection",
         description,birthday::text AS birthday,photo_url AS "photoPath",is_lma AS "isLma",
         display_order AS "displayOrder",created_at AS "createdAt"`,
      [name, roleTitle, teamSection, description, birthday, isLma, orderResult.rows[0]?.nextOrder ?? 0],
    );
    res.status(201).json(teamMemberPayload(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

router.patch("/team-directory/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const current = await pool.query(
      `SELECT id,name,role_title AS "roleTitle",team_section AS "teamSection",
        description,birthday::text AS birthday,photo_url AS "photoPath",is_lma AS "isLma",
        display_order AS "displayOrder",created_at AS "createdAt"
       FROM ${schema}.workspace_team_members WHERE id=$1`,
      [id],
    );
    if (!current.rows[0]) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    const row = current.rows[0] as Record<string, unknown>;
    const name = req.body?.name === undefined ? String(row.name ?? "") : String(req.body.name).trim();
    const roleTitle = req.body?.roleTitle === undefined ? String(row.roleTitle ?? "") : String(req.body.roleTitle).trim();
    const teamSection = req.body?.teamSection === undefined ? String(row.teamSection ?? "") : String(req.body.teamSection).trim();
    const description = req.body?.description === undefined ? String(row.description ?? "") : String(req.body.description).trim();
    const birthday = req.body?.birthday === undefined ? (row.birthday ?? null) : normalizeTeamBirthday(req.body.birthday);
    const isLma = req.body?.isLma === undefined ? Boolean(row.isLma) : Boolean(req.body.isLma);
    const photoPath = req.body?.photoPath === undefined ? (row.photoPath ?? null) : (req.body.photoPath || null);
    if (!roleTitle || !teamSection) {
      res.status(400).json({ error: "Role title and team section are required" });
      return;
    }
    if (req.body?.birthday && !birthday) {
      res.status(400).json({ error: "Birthday must be a valid month and day" });
      return;
    }
    const result = await pool.query(
      `UPDATE ${schema}.workspace_team_members
       SET name=$1,role_title=$2,team_section=$3,description=$4,birthday=$5,is_lma=$6,photo_url=$7
       WHERE id=$8
       RETURNING id,name,role_title AS "roleTitle",team_section AS "teamSection",
         description,birthday::text AS birthday,photo_url AS "photoPath",is_lma AS "isLma",
         display_order AS "displayOrder",created_at AS "createdAt"`,
      [name, roleTitle, teamSection, description, birthday, isLma, photoPath, id],
    );
    res.json(teamMemberPayload(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

router.put("/team-directory/reorder", requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length || items.some((item: unknown) => !item || !Number.isInteger(Number((item as { id?: unknown }).id)))) {
      res.status(400).json({ error: "A list of member ids is required" });
      return;
    }
    await client.query("BEGIN");
    for (const item of items as Array<{ id: number; displayOrder: number }>) {
      await client.query(
        `UPDATE ${schema}.workspace_team_members SET display_order=$1 WHERE id=$2`,
        [Number(item.displayOrder), Number(item.id)],
      );
    }
    await client.query("COMMIT");
    res.status(204).end();
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/team", requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const role = String(req.body?.role ?? "").trim();
    const department = String(req.body?.department ?? "").trim();
    const team = String(req.body?.team ?? "").trim();
    const dateOfBirth = normalizeWorkspaceDateOfBirth(req.body?.dateOfBirth);
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }
    if (req.body?.dateOfBirth && !dateOfBirth) {
      res.status(400).json({ error: "Date of birth must be a valid date" });
      return;
    }
    const result = await pool.query(
      `INSERT INTO ${schema}.workspace_users (name,role,department,team,date_of_birth)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id,name,role,department,team,date_of_birth::text AS "dateOfBirth",created_at AS "createdAt"`,
      [name, role, department, team, dateOfBirth],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.put("/team/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body?.name ?? "").trim();
    const role = String(req.body?.role ?? "").trim();
    const department = String(req.body?.department ?? "").trim();
    const team = String(req.body?.team ?? "").trim();
    const dateOfBirth = normalizeWorkspaceDateOfBirth(req.body?.dateOfBirth);
    if (!name) {
      res.status(400).json({ error: "Name is required" });
      return;
    }
    if (req.body?.dateOfBirth && !dateOfBirth) {
      res.status(400).json({ error: "Date of birth must be a valid date" });
      return;
    }
    const result = await pool.query(
      `UPDATE ${schema}.workspace_users SET name=$1,role=$2,department=$3,team=$4,date_of_birth=$5
       WHERE id=$6
       RETURNING id,name,role,department,team,date_of_birth::text AS "dateOfBirth",created_at AS "createdAt"`,
      [name, role, department, team, dateOfBirth, id],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.delete("/team/:id", requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(`DELETE FROM ${schema}.workspace_users WHERE id=$1`, [Number(req.params.id)]);
    if (!result.rowCount) {
      res.status(404).json({ error: "Team member not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

async function transitionStyle(id: number, toStage: string, note: string, userId: number | null) {
  if (!isPlmStage(toStage)) throw new Error("Unknown PLM stage");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ stage: string }>(
      `SELECT stage FROM ${schema}.styles s WHERE s.id=$1 AND ${allowedBrand("s")} FOR UPDATE`,
      [id],
    );
    const fromStage = current.rows[0]?.stage;
    if (!fromStage) throw new Error("Style not found");
    if (fromStage === toStage) throw new Error("Style is already in that stage");
    const fromIndex = PLM_STAGES.indexOf(fromStage as (typeof PLM_STAGES)[number]);
    const toIndex = PLM_STAGES.indexOf(toStage as (typeof PLM_STAGES)[number]);
    const isSideMove = toStage === "On Hold" || toStage === "Dropped" || fromStage === "On Hold" || fromStage === "Dropped";
    if (!isSideMove && fromIndex >= 0 && toIndex >= 0 && Math.abs(fromIndex - toIndex) !== 1) {
      throw new Error("Styles must move one stage at a time");
    }
    await client.query(
      `UPDATE ${schema}.styles
       SET stage=$1,status=$1,stage_entered_at=NOW(),progress=$2,updated_at=NOW()
       WHERE id=$3`,
      [toStage, stageProgress(toStage), id],
    );
    await client.query(
      `UPDATE public.pd_styles p
       SET current_stage=$1
       WHERE ${allowedBrand("p")}
         AND p.style_number=(SELECT code FROM ${schema}.styles WHERE id=$2)`,
      [PD_STAGE_BY_PLM_STAGE[toStage] ?? toStage.toLowerCase().replaceAll(" ", "_"), id],
    );
    await client.query(
      `INSERT INTO ${schema}.stage_history (style_id,from_stage,to_stage,user_id,note)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, fromStage, toStage, userId, note],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return styleDetail(id);
}

router.get("/plm/meta", async (_req, res, next) => {
  try {
    const [userResult, fabricResult, categoryResult] = await Promise.all([
      pool.query(`SELECT id,name,email,role,initials,color FROM ${schema}.users ORDER BY name`),
      pool.query(`SELECT id,name,composition,mill,gsm,notes FROM ${schema}.fabrics ORDER BY name`),
      pool.query<{ category: string }>(`SELECT DISTINCT category FROM ${schema}.styles s WHERE ${allowedBrand("s")} AND category<>'' ORDER BY category`),
    ]);
    res.json({
      users: userResult.rows,
      fabrics: fabricResult.rows,
      categories: categoryResult.rows.map((row) => row.category),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/dashboard", async (_req, res, next) => {
  try {
    const [styles, boards, plans, recent, snapshotStats, stageBreakdown] = await Promise.all([
      pool.query<{ status: string; count: string }>(`SELECT status,COUNT(*)::int AS count FROM ${schema}.styles s WHERE ${allowedBrand("s")} GROUP BY status ORDER BY count DESC`),
      pool.query<{ id: number; title: string; description: string }>(`SELECT id,title,description FROM ${schema}.boards ORDER BY id`),
      pool.query<{ count: string; avg_progress: string; avg_margin: string }>(`SELECT COUNT(*)::int AS count,COALESCE(AVG(s.progress),0)::float AS avg_progress,COALESCE(AVG(c.margin),0)::float AS avg_margin FROM ${schema}.plan_styles ps JOIN ${schema}.styles s ON s.id=ps.style_id LEFT JOIN ${schema}.cost_estimates c ON c.style_id=s.id WHERE ${allowedBrand("s")}`),
      pool.query(`SELECT 'Plan' AS type,'Q3 2026 assortment plan is live' AS title,'15 styles are in the decision room' AS detail,'2026-08-15T09:24:00.000Z' AS time UNION ALL SELECT 'PLM','Mara Column Dress moved to fit review','Proto round 2 is due 18 Aug','2026-08-14T15:10:00.000Z' UNION ALL SELECT 'Board','Aisha left a note on Leadership review','The retail edit is ready for a read','2026-08-13T11:42:00.000Z'`),
      pool.query<{
        asOfDate: string;
        planningPeriod: string;
        inDevelopment: number;
        dueThisWeek: number;
        atRisk: number;
      }>(`
        WITH source AS (
          SELECT
            s.*,
            NULLIF(SUBSTRING(UPPER(COALESCE(s.target_order_week, '')) FROM '([0-9]{1,2})$'), '')::int AS target_week_num
          FROM public.pd_styles s
          WHERE ${allowedBrand("s")}
        )
        SELECT
          TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS "asOfDate",
          'Q' || EXTRACT(QUARTER FROM CURRENT_DATE)::int || ' ' || EXTRACT(YEAR FROM CURRENT_DATE)::int || ' Planning' AS "planningPeriod",
          COUNT(*) FILTER (
            WHERE LOWER(COALESCE(s.status, 'active')) <> 'completed'
              AND LOWER(COALESCE(s.current_stage, '')) NOT IN ('launched', 'dropped', 'on hold', 'on_hold')
          )::int AS "inDevelopment",
          COUNT(*) FILTER (
            WHERE s.target_week_num = EXTRACT(WEEK FROM CURRENT_DATE)::int
          )::int AS "dueThisWeek",
          COUNT(*) FILTER (
            WHERE s.target_week_num < EXTRACT(WEEK FROM CURRENT_DATE)::int
              AND LOWER(COALESCE(s.status, 'active')) <> 'completed'
          )::int AS "atRisk"
        FROM source s
      `),
      pool.query<{ stage: string; count: number }>(`
        SELECT COALESCE(p.stage_name, INITCAP(REPLACE(s.current_stage, '_', ' ')), 'Unstaged') AS stage, COUNT(*)::int AS count
        FROM public.pd_styles s
        LEFT JOIN public.pd_stages p ON p.stage_key = s.current_stage
        WHERE ${allowedBrand("s")}
          AND LOWER(COALESCE(s.status, 'active')) <> 'completed'
          AND LOWER(COALESCE(s.current_stage, '')) NOT IN ('launched', 'dropped', 'on hold', 'on_hold')
        GROUP BY COALESCE(p.stage_name, INITCAP(REPLACE(s.current_stage, '_', ' ')), 'Unstaged')
        ORDER BY count DESC, stage ASC
      `),
    ]);
    const countByStatus = Object.fromEntries(styles.rows.map((row) => [row.status.toLowerCase().replaceAll(" ", "_"), row.count]));
    const snapshot = snapshotStats.rows[0] ?? {
      asOfDate: new Date().toISOString().slice(0, 10),
      planningPeriod: "Current planning period",
      inDevelopment: 0,
      dueThisWeek: 0,
      atRisk: 0,
    };
    res.json({
      snapshot: {
        ...snapshot,
        budgetUsedPercent: null,
        budgetUsedKes: null,
        budgetKesMillions: null,
        stages: stageBreakdown.rows,
      },
      kpis: [
        { label: "On the Q3 plan", value: Number(plans.rows[0]?.count ?? 0), suffix: "styles", tone: "gold" },
        { label: "Average development", value: Number(plans.rows[0]?.avg_progress ?? 0), suffix: "%", tone: "teal" },
        { label: "Decisions this week", value: 8, suffix: "items", tone: "ink" },
        { label: "Average margin", value: Number(plans.rows[0]?.avg_margin ?? 0), suffix: "%", tone: "coral" },
      ],
      activity: recent.rows,
      pipeline: Object.entries(countByStatus).map(([status, count]) => ({ status, count })),
      upcoming: [
        { day: "18", month: "AUG", title: "Proto round 2 · Mara Column Dress", detail: "Design team · Fit" },
        { day: "21", month: "AUG", title: "Q3 leadership read", detail: "Leadership team · Review" },
        { day: "26", month: "AUG", title: "High Summer fabric lock", detail: "Merchandising team · Material" },
      ],
      boards: boards.rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/styles", async (req, res, next) => {
  try {
    if (String(req.query.source ?? "") === "pd") {
      const values: string[] = [];
       const clauses = [allowedBrand("s"), `LOWER(s.status) = 'active'`];
      const brand = String(req.query.brand ?? "").trim();
      const status = String(req.query.status ?? "").trim();
      const search = String(req.query.search ?? "").trim();
       const season = String(req.query.season ?? "").trim();
      if (brand) {
        values.push(brand);
        clauses.push(`s.brand=$${values.length}`);
      }
      if (status) {
        values.push(status);
        clauses.push(`s.status=$${values.length}`);
      }
      if (search) {
        values.push(`%${search}%`);
        clauses.push(`(
          s.style_name ILIKE $${values.length}
          OR s.style_number ILIKE $${values.length}
          OR s.assignee_name ILIKE $${values.length}
        )`);
      }
       if (season && PLM_SEASONS.includes(season as (typeof PLM_SEASONS)[number])) {
         values.push(season);
         clauses.push(`s.season=$${values.length}`);
       }
      const result = await pool.query(
        `SELECT COALESCE(ws.id,s.id) AS id,
         COALESCE(NULLIF(TRIM(s.style_number),''),'PD-' || s.id::text) AS code,
         COALESCE(NULLIF(TRIM(s.style_name),''),'Unnamed style') AS name,
         COALESCE(NULLIF(TRIM(s.brand),''),'Vivo') AS brand,
         COALESCE(NULLIF(TRIM(s.category),''),'Uncategorised') AS category,
         COALESCE(NULLIF(TRIM(s.sub_category),''),'') AS "subCategory",
          COALESCE(NULLIF(TRIM(s.theme),''),NULLIF(TRIM(ws.theme),''),'') AS theme,
         COALESCE(NULLIF(TRIM(ws.order_type),''),'New') AS "orderType",
         COALESCE(NULLIF(TRIM(ws.tier),''),'—') AS tier,
          s.season,
         NULLIF(TRIM(s.launch_route),'') AS "launchRoute",
         NULLIF(TRIM(s.style_classification),'') AS "styleClassification",
         NULLIF(TRIM(s.range_tier),'') AS "rangeTier",
         s.status,
         COALESCE(NULLIF(TRIM(p.stage_name),''),INITCAP(REPLACE(COALESCE(NULLIF(TRIM(s.current_stage),''),'concept'),'_',' ')),'Concept') AS stage,
         COALESCE(NULLIF(TRIM(p.stage_name),''),INITCAP(REPLACE(COALESCE(NULLIF(TRIM(s.current_stage),''),'concept'),'_',' ')),'Concept') AS "currentStage",
         COALESCE(NULLIF(TRIM(s.assignee_name),''),NULLIF(TRIM(ws.owner),''),'Unassigned') AS owner,
          COALESCE(NULLIF(TRIM(s.design_owner),''),NULLIF(TRIM(s.assignee_name),''),NULLIF(TRIM(ws.designer),''),NULLIF(TRIM(ws.owner),''),'Unassigned') AS designer,
         COALESCE(NULLIF(TRIM(ws.pattern_maker),''),'') AS "patternMaker",
         ws.designer_user_id AS "designUserId",
         ws.pattern_maker_user_id AS "patternUserId",
         NULL::integer AS "cadUserId",
         ws.sample_maker_user_id AS "sampleUserId",
         ws.buyer_user_id AS "buyingUserId",
         jsonb_build_object(
           'design', CASE WHEN du.id IS NULL THEN NULL ELSE jsonb_build_object('id',du.id,'name',du.name,'role',du.role,'department',du.department) END,
           'pattern', CASE WHEN pm.id IS NULL THEN NULL ELSE jsonb_build_object('id',pm.id,'name',pm.name,'role',pm.role,'department',pm.department) END,
           'cad', NULL,
           'sample', CASE WHEN sm.id IS NULL THEN NULL ELSE jsonb_build_object('id',sm.id,'name',sm.name,'role',sm.role,'department',sm.department) END,
           'buying', CASE WHEN bu.id IS NULL THEN NULL ELSE jsonb_build_object('id',bu.id,'name',bu.name,'role',bu.role,'department',bu.department) END
         ) AS "styleTeam",
         to_char(ws.target_date,'YYYY-MM-DD') AS "targetDate",
         s.target_order_week AS "targetOrderWeek",
         NULL::text AS "plannedLaunchWeek",
         to_char(COALESCE(s.stage_entered_at,ws.stage_entered_at),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "stageEnteredAt",
         GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-COALESCE(s.stage_entered_at,ws.stage_entered_at)))/86400))::int AS "daysInStage",
         CASE
           WHEN i.image_data IS NULL OR i.image_data = '' THEN ws.image
           WHEN i.image_data LIKE 'data:%' THEN i.image_data
           ELSE 'data:' || COALESCE(NULLIF(i.content_type,''),'image/jpeg') || ';base64,' || i.image_data
         END AS image,
         COALESCE(ws.progress,0)::float AS progress,
         COALESCE(ws.price,0)::float AS price,
         COALESCE(NULLIF(TRIM(ws.market),''),'EA') AS market
        FROM public.pd_styles s
        LEFT JOIN public.pd_stages p ON p.stage_key=s.current_stage
        LEFT JOIN ${schema}.styles ws ON ws.code=s.style_number
        LEFT JOIN LATERAL (
          SELECT image_data,content_type
          FROM public.pd_style_images
          WHERE style_id=s.id
          LIMIT 1
        ) i ON TRUE
        LEFT JOIN ${schema}.workspace_users du ON du.id=ws.designer_user_id
        LEFT JOIN ${schema}.workspace_users pm ON pm.id=ws.pattern_maker_user_id
        LEFT JOIN ${schema}.workspace_users sm ON sm.id=ws.sample_maker_user_id
        LEFT JOIN ${schema}.workspace_users bu ON bu.id=ws.buyer_user_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY COALESCE(NULLIF(TRIM(p.stage_name),''),s.current_stage),LOWER(s.style_name),s.id`,
        values,
      );
      res.json(result.rows);
      return;
    }
    const values: string[] = [];
     const clauses: string[] = [allowedBrand("s")];
    if (req.query.brand) {
      values.push(String(req.query.brand));
      clauses.push(`s.brand=$${values.length}`);
    }
    if (req.query.status) {
      values.push(String(req.query.status));
      clauses.push(`s.status=$${values.length}`);
    }
    const filters: Record<string, string> = {
      category: "s.category",
      designer: "s.designer",
      tier: "s.tier",
      orderType: "s.order_type",
      stage: "s.stage",
    };
    for (const [queryKey, column] of Object.entries(filters)) {
      if (!req.query[queryKey]) continue;
      values.push(String(req.query[queryKey]));
      clauses.push(`${column}=$${values.length}`);
    }
    if (req.query.search) {
      values.push(`%${String(req.query.search)}%`);
      clauses.push(`(s.name ILIKE $${values.length} OR s.code ILIKE $${values.length} OR s.owner ILIKE $${values.length} OR s.designer ILIKE $${values.length})`);
    }
    const result = await pool.query(
      `SELECT s.id,s.code,s.name,s.brand,s.category,s.sub_category AS "subCategory",s.theme,s.order_type AS "orderType",
        s.tier,
        COALESCE(NULLIF(TRIM(pd.season),''),'Q3 2026') AS season,
       COALESCE(NULLIF(TRIM(s.launch_route),''),NULLIF(TRIM(pd.launch_route),'')) AS "launchRoute",
       COALESCE(NULLIF(TRIM(s.style_classification),''),NULLIF(TRIM(pd.style_classification),'')) AS "styleClassification",
       COALESCE(NULLIF(TRIM(s.range_tier),''),NULLIF(TRIM(pd.range_tier),'')) AS "rangeTier",
       s.status,s.stage,s.stage AS "currentStage",
       COALESCE(NULLIF(TRIM(s.owner),''),'Unassigned') AS owner,
       COALESCE(NULLIF(TRIM(s.designer),''),NULLIF(TRIM(s.owner),''),'Unassigned') AS designer,
       s.pattern_maker AS "patternMaker",s.fabric_type AS "fabricType",
       s.designer_user_id AS "designUserId",s.pattern_maker_user_id AS "patternUserId",
       NULL::integer AS "cadUserId",
       s.sample_maker_user_id AS "sampleUserId",s.buyer_user_id AS "buyingUserId",
       jsonb_build_object(
         'design', CASE WHEN du.id IS NULL THEN NULL ELSE jsonb_build_object('id',du.id,'name',du.name,'role',du.role,'department',du.department) END,
         'pattern', CASE WHEN pm.id IS NULL THEN NULL ELSE jsonb_build_object('id',pm.id,'name',pm.name,'role',pm.role,'department',pm.department) END,
         'cad', NULL,
         'sample', CASE WHEN sm.id IS NULL THEN NULL ELSE jsonb_build_object('id',sm.id,'name',sm.name,'role',sm.role,'department',sm.department) END,
         'buying', CASE WHEN bu.id IS NULL THEN NULL ELSE jsonb_build_object('id',bu.id,'name',bu.name,'role',bu.role,'department',bu.department) END
       ) AS "styleTeam",
        to_char(s.target_date,'YYYY-MM-DD') AS "targetDate",
        pd.target_order_week AS "targetOrderWeek",
        NULL::text AS "plannedLaunchWeek",
       to_char(s.stage_entered_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "stageEnteredAt",
       GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-s.stage_entered_at))/86400))::int AS "daysInStage",
       s.image,s.progress::float,s.price::float,s.market
       FROM ${schema}.styles s
        LEFT JOIN (
           SELECT style_number, MAX(NULLIF(TRIM(target_order_week), '')) AS target_order_week,
             MAX(NULLIF(TRIM(launch_route), '')) AS launch_route,
             MAX(NULLIF(TRIM(style_classification), '')) AS style_classification,
              MAX(NULLIF(TRIM(range_tier), '')) AS range_tier,
              MAX(NULLIF(TRIM(season), '')) AS season
           FROM public.pd_styles p
           WHERE ${allowedBrand("p")} AND p.style_number IS NOT NULL
           GROUP BY p.style_number
        ) pd ON pd.style_number = s.code
       LEFT JOIN ${schema}.workspace_users du ON du.id=s.designer_user_id
       LEFT JOIN ${schema}.workspace_users pm ON pm.id=s.pattern_maker_user_id
       LEFT JOIN ${schema}.workspace_users sm ON sm.id=s.sample_maker_user_id
       LEFT JOIN ${schema}.workspace_users bu ON bu.id=s.buyer_user_id
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY s.target_date ASC, s.id ASC`,
      values,
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

// The catalogue's PLM tab is backed by the established Product Development
// tables, not the newer workspace.styles table.  Keep this route separate from
// /styles because the latter also powers the workspace's editable style detail
// flow and has a different data model.
const CATALOGUE_SORT_KEYS = [
  "units_desc",
  "revenue_desc",
  "sor_desc",
  "newest",
  "oldest",
  "price_desc",
  "price_asc",
  "stock_desc",
  "name_asc",
  "name_desc",
] as const;
type CatalogueSortKey = (typeof CATALOGUE_SORT_KEYS)[number];
const CATALOGUE_SORT_KEY_SET = new Set<string>(CATALOGUE_SORT_KEYS);
const catalogueSortKey = (raw: unknown): CatalogueSortKey => {
  const value = String(raw ?? "").trim();
  return CATALOGUE_SORT_KEY_SET.has(value) ? value as CatalogueSortKey : "units_desc";
};
const catalogueOrderBy = (sort: CatalogueSortKey, alias: string) => {
  const primary: Record<CatalogueSortKey, string> = {
    units_desc: `${alias}."unitsSold" DESC NULLS LAST`,
    revenue_desc: `${alias}."revenueKes" DESC NULLS LAST`,
    sor_desc: `${alias}."sorPct" DESC NULLS LAST`,
    newest: `${alias}."launchDate" DESC NULLS LAST`,
    oldest: `${alias}."launchDate" ASC NULLS LAST`,
    price_desc: `${alias}.price DESC NULLS LAST`,
    price_asc: `${alias}.price ASC NULLS LAST`,
    stock_desc: `${alias}."stockUnits" DESC NULLS LAST`,
    name_asc: `LOWER(${alias}."styleName") ASC NULLS LAST`,
    name_desc: `LOWER(${alias}."styleName") DESC NULLS LAST`,
  };
  return `${primary[sort]}, LOWER(${alias}."styleName") ASC NULLS LAST, ${alias}."styleNumber" ASC`;
};

router.get("/plm-catalogue", async (req, res, next) => {
  try {
    const values: unknown[] = [];
    const csv = (raw: unknown) => String(raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const stageExpr = `COALESCE(NULLIF(TRIM(ps.stage_name),''), INITCAP(REPLACE(COALESCE(s.current_stage,'concept'),'_',' ')))`;
    const tierExpr = `CASE
      WHEN LOWER(COALESCE(s.range_tier,'')) IN ('1','tier 1','tier 1 · noos','noos') THEN 'Tier 1 · NOOS'
      WHEN LOWER(COALESCE(s.range_tier,'')) IN ('2','tier 2','tier 2 · core','core') THEN 'Tier 2 · Core'
      WHEN LOWER(COALESCE(s.range_tier,'')) IN ('3','tier 3','tier 3 · recent','recent') THEN 'Tier 3 · Recent'
      WHEN LOWER(COALESCE(s.range_tier,'')) IN ('4','tier 4','tier 4 · new','new') THEN 'Tier 4 · New'
      ELSE NULLIF(TRIM(s.range_tier),'')
    END`;
    const clauses = [allowedBrand("s"), `LOWER(s.status) = 'active'`];
    const search = String(req.query.search ?? "").trim();
    const filters = {
      tier: csv(req.query.tier),
      status: csv(req.query.status ?? req.query.stage),
      category: csv(req.query.category),
      subCategory: csv(req.query.subcategory ?? req.query.subCategory),
      fabricCategory: csv(req.query.fabricCategory ?? req.query.fabric_category),
      brand: csv(req.query.brand),
      primaryColour: csv(req.query.primaryColour ?? req.query.primary_colour),
      edit: csv(req.query.edit),
    };
    const sort = catalogueSortKey(req.query.sort);
    if (search) {
      values.push(`%${search}%`);
      clauses.push(`(
        s.style_name ILIKE $${values.length}
        OR s.style_number ILIKE $${values.length}
        OR s.assignee_name ILIKE $${values.length}
        OR s.theme ILIKE $${values.length}
      )`);
    }
    const addAny = (expression: string, valuesForFilter: string[]) => {
      if (!valuesForFilter.length) return;
      values.push(valuesForFilter);
      clauses.push(`${expression} = ANY($${values.length})`);
    };
    addAny(tierExpr, filters.tier);
    addAny(stageExpr, filters.status);
    addAny(`NULLIF(TRIM(s.category),'')`, filters.category);
    addAny(`COALESCE(NULLIF(TRIM(s.sub_category),''),NULLIF(TRIM(s.category),''))`, filters.subCategory);
    addAny(`COALESCE(NULLIF(TRIM(s.fabric_type),''),NULLIF(TRIM(s.fabric_name),''))`, filters.fabricCategory);
    addAny(`s.brand`, filters.brand);
    addAny(`NULLIF(TRIM(s.sample_colour),'')`, filters.primaryColour);
    addAny(`NULLIF(TRIM(s.theme),'')`, filters.edit);
    const result = await pool.query(
      `WITH filtered_styles AS (
         SELECT s.id,
           COALESCE(NULLIF(TRIM(s.style_number),''), 'PD-' || s.id::text) AS code,
           COALESCE(NULLIF(TRIM(s.style_number),''), 'PD-' || s.id::text) AS "styleNumber",
           s.style_name AS name,
           s.style_name AS "styleName",
           s.brand,
           s.category,
           s.sub_category AS "subCategory",
           s.status,
           ${stageExpr} AS stage,
           ${stageExpr} AS "currentStage",
           ${tierExpr} AS tier,
           COALESCE(NULLIF(TRIM(s.fabric_type),''),NULLIF(TRIM(s.fabric_name),'')) AS "fabricCategory",
           s.sample_colour AS "primaryColour",
           s.theme AS edit,
           COALESCE(NULLIF(TRIM(s.assignee_name),''),'Unassigned') AS owner,
           COALESCE(NULLIF(TRIM(s.assignee_name),''),'Unassigned') AS designer,
           to_char(s.stage_entered_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "stageEnteredAt",
           CASE
             WHEN i.image_data IS NULL OR i.image_data = '' THEN NULL
             WHEN i.image_data LIKE 'data:%' THEN i.image_data
             ELSE 'data:' || COALESCE(NULLIF(i.content_type,''),'image/jpeg') || ';base64,' || i.image_data
           END AS image
         FROM public.pd_styles s
         LEFT JOIN public.pd_style_images i ON i.style_id = s.id
         LEFT JOIN public.pd_stages ps ON ps.stage_key=s.current_stage
         WHERE ${clauses.join(" AND ")}
       ),
       product_map AS (
         SELECT a.sku,
           MIN(COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))) AS style_key
         FROM public.all_products_clean a
         JOIN filtered_styles f
           ON LOWER(f.code)=LOWER(COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),'')))
         WHERE ${allowedBrand("a")} AND NULLIF(TRIM(a.sku),'') IS NOT NULL
         GROUP BY a.sku
       ),
       catalogue_attributes AS (
         SELECT COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),'')) AS style_key,
           (MODE() WITHIN GROUP (ORDER BY NULLIF(a.price,0))
             FILTER (WHERE a.price IS NOT NULL AND a.price > 0))::float AS price,
           MAX(NULLIF(TRIM(COALESCE(a.style_launch_date,'')),'')) AS catalogue_launch_date
         FROM public.all_products_clean a
         JOIN filtered_styles f
           ON LOWER(f.code)=LOWER(COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),'')))
         WHERE ${allowedBrand("a")}
         GROUP BY COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))
       ),
       inventory_by_sku AS (
         SELECT sku,SUM(COALESCE(available,0))::float AS stock_units
         FROM public.all_inventory
         GROUP BY sku
       ),
       inventory_by_style AS (
         SELECT pm.style_key,SUM(COALESCE(inv.stock_units,0))::float AS stock_units
         FROM product_map pm
         LEFT JOIN inventory_by_sku inv ON inv.sku=pm.sku
         GROUP BY pm.style_key
       ),
       sales_by_style AS (
         SELECT pm.style_key,
           SUM(CASE WHEN LOWER(COALESCE(sa.sale_kind,'')) IN ('sale','order')
             THEN GREATEST(COALESCE(sa.ordered_item_quantity,0)::numeric,0) ELSE 0 END)::float AS units_sold,
           SUM(COALESCE(sa.total_sales_kes,0)::numeric
             - COALESCE(sa.discounts_kes,0)::numeric
             - COALESCE(sa.returns_kes,0)::numeric)::float AS revenue_kes,
           MIN(CASE WHEN sa.sale_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
             THEN LEFT(sa.sale_date,10)::date END)
             FILTER (WHERE LOWER(COALESCE(sa.sale_kind,'')) IN ('sale','order')) AS first_sale_date
         FROM public.all_sales sa
         JOIN product_map pm ON pm.sku=sa.variant_sku
         GROUP BY pm.style_key
       ),
       enriched AS (
         SELECT f.*,
           ca.price,
           COALESCE(
             CASE WHEN ca.catalogue_launch_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
               THEN LEFT(ca.catalogue_launch_date,10)::date END,
             sb.first_sale_date
           ) AS "launchDate",
           sb.units_sold AS "unitsSold",
           sb.revenue_kes AS "revenueKes",
           CASE
             WHEN COALESCE(sb.units_sold,0) + COALESCE(ib.stock_units,0) > 0
             THEN ROUND((100.0 * COALESCE(sb.units_sold,0)
               / (COALESCE(sb.units_sold,0) + COALESCE(ib.stock_units,0)))::numeric,2)::float
             ELSE NULL
           END AS "sorPct",
           ib.stock_units AS "stockUnits"
         FROM filtered_styles f
         LEFT JOIN catalogue_attributes ca ON LOWER(ca.style_key)=LOWER(f.code)
         LEFT JOIN inventory_by_style ib ON LOWER(ib.style_key)=LOWER(f.code)
         LEFT JOIN sales_by_style sb ON LOWER(sb.style_key)=LOWER(f.code)
       )
       SELECT * FROM enriched e
       ORDER BY ${catalogueOrderBy(sort, "e")}`,
      values,
    );
    const facets = await pool.query(
      `SELECT s.brand,s.category,s.sub_category AS "subCategory",
          COALESCE(NULLIF(TRIM(s.fabric_type),''),NULLIF(TRIM(s.fabric_name),'')) AS "fabricCategory",
          s.sample_colour AS "primaryColour",s.theme AS edit,
          ${stageExpr} AS stage,${tierExpr} AS tier
       FROM public.pd_styles s
       LEFT JOIN public.pd_stages ps ON ps.stage_key=s.current_stage
       WHERE ${allowedBrand("s")} AND LOWER(s.status)='active'`,
    );
    const options = (key: string) => [...new Set(facets.rows.map((row) => String(row[key] ?? "").trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
    res.json({
      items: result.rows,
      brands: [...WORKSPACE_BRANDS],
      filterOptions: {
        tier: options("tier"),
        status: options("stage"),
        category: options("category"),
        subCategory: options("subCategory"),
        fabricCategory: options("fabricCategory"),
        brand: options("brand"),
        primaryColour: options("primaryColour"),
        edit: options("edit"),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/styles", async (req: AuthRequest, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body ?? {};
    const name = String(body.name ?? "").trim();
    const brand = body.brand === "Safari by Vivo" ? "Safari by Vivo" : "Vivo";
    const category = String(body.category ?? "").trim();
    const targetDate = String(body.targetDate ?? "").trim();
    if (!name || !category || !targetDate) {
      res.status(400).json({ error: "Style name, category, and target launch date are required" });
      return;
    }
    const prefix = brand === "Safari by Vivo" ? "S-" : "V-";
    let code = String(body.styleNumber ?? "").trim();
    if (!code) {
      const count = await client.query<{ next: number }>(
        `SELECT (COUNT(*)::int + 1) AS next FROM ${schema}.styles WHERE code LIKE $1`,
        [`${prefix}%`],
      );
      code = `${prefix}${new Date().getFullYear().toString().slice(-2)}${String(count.rows[0]?.next ?? 1).padStart(3, "0")}`;
    }
    const designer = String(body.designer ?? "").trim();
    const patternMaker = String(body.patternMaker ?? "").trim();
    const tier = ["1", "2", "3", "4"].includes(String(body.tier)) ? String(body.tier) : "1";
    const launchRoute = body.launchRoute === "" || body.launchRoute == null ? null : String(body.launchRoute);
    const styleClassification = body.styleClassification === "" || body.styleClassification == null ? null : String(body.styleClassification);
    const rangeTier = body.rangeTier === "" || body.rangeTier == null ? null : String(body.rangeTier);
    if ((launchRoute && !PLM_LAUNCH_ROUTES.includes(launchRoute as (typeof PLM_LAUNCH_ROUTES)[number]))
      || (styleClassification && !PLM_STYLE_CLASSIFICATIONS.includes(styleClassification as (typeof PLM_STYLE_CLASSIFICATIONS)[number]))
      || (rangeTier && !PLM_RANGE_TIERS.includes(rangeTier as (typeof PLM_RANGE_TIERS)[number]))) {
      res.status(400).json({ error: "One or more classification values are unsupported" });
      return;
    }
    await client.query("BEGIN");
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO ${schema}.styles
       (code,name,brand,category,sub_category,theme,order_type,tier,season,launch_route,style_classification,range_tier,status,stage,stage_entered_at,owner,designer,pattern_maker,target_date,progress,price,market)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Q3 2026',$9,$10,$11,'Concept','Concept',NOW(),$12,$12,$13,$14,0,0,'EA')
       RETURNING id`,
      [
        code,
        name,
        brand,
        category,
        String(body.subCategory ?? ""),
        String(body.theme ?? ""),
        body.orderType === "Repeat" ? "Repeat" : "New",
        tier,
         launchRoute,
         styleClassification,
         rangeTier,
        designer || "Unassigned",
        patternMaker,
        targetDate,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("Style could not be created");
    await client.query(
      `INSERT INTO ${schema}.stage_history (style_id,from_stage,to_stage,user_id,note)
       VALUES ($1,NULL,'Concept',$2,'Style created in PLM')`,
      [id, req.workspaceUser?.id ?? null],
    );
    await client.query(
      `INSERT INTO public.pd_styles
        (style_name,brand,category,status,current_stage,style_number,sub_category,lifecycle_type,
         assignee_name,pattern_maker,season)
       VALUES ($1,$2,$3,'active','concept',$4,$5,$6,$7,$8,'Q3 2026')`,
      [name, brand, category, code, String(body.subCategory ?? ""), body.orderType === "Repeat" ? "repeat" : "new", designer || "Unassigned", patternMaker],
    );
    await client.query("COMMIT");
    res.status(201).json(await styleDetail(id));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") {
      res.status(409).json({ error: "That style number already exists" });
      return;
    }
    next(error);
  } finally {
    client.release();
  }
});

router.get("/styles/:id", async (req, res, next) => {
  try {
    const result = await styleDetail(Number(req.params.id));
    if (!result) {
      res.status(404).json({ error: "Style not found" });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/styles/:id/plm", async (req, res, next) => {
  try {
    const result = await styleDetail(Number(req.params.id));
    if (!result) {
      res.status(404).json({ error: "Style not found" });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.patch("/styles/:id", async (req: AuthRequest, res, next) => {
  try {
    if (!await getStyle(Number(req.params.id))) {
      res.status(404).json({ error: "Style not found" });
      return;
    }
    const allowed = ["status", "stage", "name", "owner", "designer", "patternMaker", "subCategory", "theme", "orderType", "targetDate", "progress", "price", "market", "tier", "season", "launchRoute", "styleClassification", "rangeTier", "creativeDescription", "sizeRange", "trimsSpecialFeatures", "predictedCost", "confirmedCost"] as const;
    const numericFields = new Set(["progress", "price", "predictedCost", "confirmedCost"]);
    const teamFieldMap = {
      designUserId: { workspace: "designer_user_id", public: "design_owner" },
      patternUserId: { workspace: "pattern_maker_user_id", public: "pattern_owner" },
      cadUserId: { workspace: null, public: "cad_owner" },
      sampleUserId: { workspace: "sample_maker_user_id", public: "sample_owner" },
      buyingUserId: { workspace: "buyer_user_id", public: "buying_owner" },
    } as const;
    const teamUpdates = (Object.keys(teamFieldMap) as Array<keyof typeof teamFieldMap>)
      .filter((key) => req.body?.[key] !== undefined);
    const classificationFields: Record<string, readonly string[]> = {
      launchRoute: PLM_LAUNCH_ROUTES,
      styleClassification: PLM_STYLE_CLASSIFICATIONS,
      rangeTier: PLM_RANGE_TIERS,
    };
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed) {
      if (req.body?.[key] === undefined) continue;
      const rawValue = req.body[key];
      if (classificationFields[key] && rawValue !== null && rawValue !== "" && !classificationFields[key].includes(String(rawValue))) {
        res.status(400).json({ error: `${key} has an unsupported value` });
        return;
      }
      if (key === "season" && rawValue !== null && rawValue !== "" && !PLM_SEASONS.includes(String(rawValue) as (typeof PLM_SEASONS)[number])) {
        res.status(400).json({ error: "season has an unsupported value" });
        return;
      }
      values.push(key === "trimsSpecialFeatures"
        ? JSON.stringify(Array.isArray(rawValue) ? rawValue.map((item) => String(item).trim()).filter(Boolean) : [])
        : numericFields.has(key)
          ? (rawValue === null || rawValue === "" ? null : Number(rawValue))
          : (classificationFields[key] || key === "season") && (rawValue === null || rawValue === "") ? null
          : rawValue);
      const column = key === "targetDate" ? "target_date" : key === "patternMaker" ? "pattern_maker" : key === "subCategory" ? "sub_category" : key === "launchRoute" ? "launch_route" : key === "styleClassification" ? "style_classification" : key === "rangeTier" ? "range_tier" : key === "creativeDescription" ? "creative_description" : key === "sizeRange" ? "size_range" : key === "trimsSpecialFeatures" ? "trims_special_features" : key === "predictedCost" ? "predicted_cost" : key === "confirmedCost" ? "confirmed_cost" : key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      assignments.push(`${column}=$${values.length}`);
      if (key === "stage") assignments.push(`status=$${values.length}`);
    }
    if (!assignments.length && !teamUpdates.length) {
      res.status(400).json({ error: "No editable fields supplied" });
      return;
    }
    if (assignments.length) {
      values.push(req.params.id);
      await pool.query(`UPDATE ${schema}.styles SET ${assignments.join(",")},updated_at=NOW() WHERE id=$${values.length}`, values);
    }
    if (teamUpdates.length) {
      const teamValues: Array<number | null> = [];
      for (const key of teamUpdates) {
        const rawValue = req.body[key];
        const value = rawValue === null || rawValue === "" ? null : Number(rawValue);
        if (value !== null && (!Number.isInteger(value) || value < 1)) {
          res.status(400).json({ error: `${key} must be a valid workspace user` });
          return;
        }
        teamValues.push(value);
      }
      const userIds = teamValues.filter((value): value is number => value !== null);
      const memberResult = userIds.length
        ? await pool.query<{ id: number; name: string }>(`SELECT id,name FROM ${schema}.workspace_users WHERE id=ANY($1::int[])`, [userIds])
        : { rows: [] };
      const membersById = new Map(memberResult.rows.map((member) => [member.id, member.name]));
      if (userIds.some((userId) => !membersById.has(userId))) {
        res.status(400).json({ error: "Every Style Team assignment must use a workspace user" });
        return;
      }
      const workspaceAssignments: string[] = [];
      const workspaceValues: Array<number | null> = [];
      const publicAssignments: string[] = [];
      const publicValues: Array<string | null> = [];
      for (let index = 0; index < teamUpdates.length; index += 1) {
        const key = teamUpdates[index];
        const field = teamFieldMap[key];
        const value = teamValues[index];
        publicValues.push(value === null ? null : membersById.get(value) ?? null);
        publicAssignments.push(`${field.public}=$${publicValues.length}`);
        if (field.workspace) {
          workspaceValues.push(value);
          workspaceAssignments.push(`${field.workspace}=$${workspaceValues.length}`);
        }
      }
      if (workspaceAssignments.length) {
        workspaceValues.push(Number(req.params.id));
        await pool.query(`UPDATE ${schema}.styles SET ${workspaceAssignments.join(",")},updated_at=NOW() WHERE id=$${workspaceValues.length}`, workspaceValues);
      }
      const workspaceStyle = await pool.query<{ code: string }>(`SELECT code FROM ${schema}.styles WHERE id=$1`, [req.params.id]);
      if (workspaceStyle.rows[0]?.code) {
        publicValues.push(workspaceStyle.rows[0].code);
        await pool.query(`UPDATE public.pd_styles SET ${publicAssignments.join(",")} WHERE style_number=$${publicValues.length}`, publicValues);
      }
    }
    const classificationUpdates = (["launchRoute", "styleClassification", "rangeTier"] as const)
      .filter((key) => req.body?.[key] !== undefined);
    const seasonWasUpdated = req.body?.season !== undefined;
    if (classificationUpdates.length) {
      const workspaceStyle = await pool.query<{ code: string }>(`SELECT code FROM ${schema}.styles WHERE id=$1`, [req.params.id]);
      const code = workspaceStyle.rows[0]?.code;
      if (code) {
        const publicAssignments = classificationUpdates.map((key, index) => {
          const column = key === "launchRoute" ? "launch_route" : key === "styleClassification" ? "style_classification" : "range_tier";
          return `${column}=$${index + 1}`;
        });
        const publicValues = classificationUpdates.map((key) => req.body[key] === "" ? null : req.body[key]);
        if (seasonWasUpdated) {
          publicAssignments.push(`season=$${publicValues.length + 1}`);
          publicValues.push(req.body.season === "" ? null : req.body.season);
        }
        publicValues.push(code);
        await pool.query(`UPDATE public.pd_styles SET ${publicAssignments.join(",")} WHERE style_number=$${publicValues.length}`, publicValues);
      }
    } else if (seasonWasUpdated) {
      const workspaceStyle = await pool.query<{ code: string }>(`SELECT code FROM ${schema}.styles WHERE id=$1`, [req.params.id]);
      if (workspaceStyle.rows[0]?.code) {
        await pool.query(`UPDATE public.pd_styles SET season=$1 WHERE style_number=$2`, [req.body.season === "" ? null : req.body.season, workspaceStyle.rows[0].code]);
      }
    }
    const result = await styleDetail(Number(req.params.id));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/styles/:id/colorways", async (req: AuthRequest, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const hex = String(req.body?.hex ?? "#C9A96E").trim();
    const code = String(req.body?.code ?? "").trim();
    const status = String(req.body?.status ?? "Proposed").trim();
    if (!name) {
      res.status(400).json({ error: "Colourway name is required" });
      return;
    }
    await pool.query(
      `INSERT INTO ${schema}.colorways (style_id,name,hex,code,status) VALUES ($1,$2,$3,$4,$5)`,
      [Number(req.params.id), name, hex, code, status],
    );
    res.status(201).json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.patch("/styles/:id/colorways/:colorwayId", async (req: AuthRequest, res, next) => {
  try {
    const fields: Array<[string, unknown]> = [];
    if (req.body?.name !== undefined) fields.push(["name", String(req.body.name).trim()]);
    if (req.body?.hex !== undefined) fields.push(["hex", String(req.body.hex).trim()]);
    if (req.body?.code !== undefined) fields.push(["code", String(req.body.code).trim()]);
    if (req.body?.status !== undefined) fields.push(["status", String(req.body.status).trim()]);
    if (!fields.length) {
      res.status(400).json({ error: "No editable colourway fields supplied" });
      return;
    }
    const values = fields.map(([, value]) => value);
    values.push(Number(req.params.id), Number(req.params.colorwayId));
    const assignments = fields.map(([column], index) => `${column}=$${index + 1}`);
    const result = await pool.query(
      `UPDATE ${schema}.colorways SET ${assignments.join(",")} WHERE style_id=$${fields.length + 1} AND id=$${fields.length + 2}`,
      values,
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "Colourway not found" });
      return;
    }
    res.json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.post("/styles/:id/transition", async (req: AuthRequest, res, next) => {
  try {
    const result = await transitionStyle(
      Number(req.params.id),
      String(req.body?.toStage ?? ""),
      String(req.body?.note ?? ""),
      req.workspaceUser?.id ?? null,
    );
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Style could not be transitioned";
    if (message === "Style not found") {
      res.status(404).json({ error: message });
      return;
    }
    res.status(400).json({ error: message });
  }
});

router.put("/styles/:id/tech-pack", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    await pool.query(
      `INSERT INTO ${schema}.tech_packs
       (style_id,status,version,owner,notes,base_pattern_reference,fabric_id,trims_accessories,construction_notes,audaces_file_reference,modified_from_style_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (style_id) DO UPDATE SET status=EXCLUDED.status,version=EXCLUDED.version,owner=EXCLUDED.owner,
       notes=EXCLUDED.notes,base_pattern_reference=EXCLUDED.base_pattern_reference,fabric_id=EXCLUDED.fabric_id,
       trims_accessories=EXCLUDED.trims_accessories,construction_notes=EXCLUDED.construction_notes,
       audaces_file_reference=EXCLUDED.audaces_file_reference,modified_from_style_number=EXCLUDED.modified_from_style_number,
       updated_at=NOW()`,
      [
        Number(req.params.id),
        String(body.status ?? "In progress"),
        String(body.version ?? "v1"),
        String(body.owner ?? ""),
        String(body.notes ?? ""),
        String(body.basePatternReference ?? ""),
        body.fabricId ? Number(body.fabricId) : null,
        String(body.trimsAccessories ?? ""),
        String(body.constructionNotes ?? ""),
        String(body.audacesFileReference ?? ""),
        String(body.modifiedFromStyleNumber ?? ""),
      ],
    );
    res.json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.post("/styles/:id/fit-sessions", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const sessionDate = String(body.sessionDate ?? "");
    const sample = String(body.sample ?? "Fit sample");
    await pool.query(
      `INSERT INTO ${schema}.fit_sessions
       (style_id,session_date,fit_type,status,notes,sample,model_name,attendees)
       VALUES ($1,$2,$3,$4,$5,$3,$6,$7)`,
      [
        Number(req.params.id),
        sessionDate,
        `${sample} · ${sessionDate} · ${Date.now()}`,
        String(body.outcome ?? "Needs Revision"),
        String(body.comments ?? ""),
        String(body.modelName ?? ""),
        String(body.attendees ?? ""),
      ],
    );
    res.status(201).json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.put("/styles/:id/grading", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    await pool.query(`DELETE FROM ${schema}.gradings WHERE style_id=$1`, [Number(req.params.id)]);
    await pool.query(
      `INSERT INTO ${schema}.gradings (style_id,size_range,status,notes,cad_team_member)
       VALUES ($1,$2,$3,'',$4)`,
      [
        Number(req.params.id),
        String(body.sizeRange ?? "Combined"),
        String(body.status ?? "Pending"),
        String(body.cadTeamMember ?? ""),
      ],
    );
    res.json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.post("/styles/:id/samples", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    await pool.query(
      `INSERT INTO ${schema}.sample_development
       (style_id,purpose,pattern_maker,sample_makers,units_ordered,date_cut,date_finished,status,rework_notes)
       VALUES ($1,$2,$3,$4,$5,NULLIF($6,'')::date,NULLIF($7,'')::date,$8,$9)`,
      [
        Number(req.params.id),
        String(body.purpose ?? "Proto"),
        String(body.patternMaker ?? ""),
        String(body.sampleMakers ?? ""),
        Number(body.unitsOrdered ?? 0),
        String(body.dateCut ?? ""),
        String(body.dateFinished ?? ""),
        String(body.status ?? "Planned"),
        String(body.reworkNotes ?? ""),
      ],
    );
    res.status(201).json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.put("/styles/:id/cost-estimate", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const avgMatKg = Number(body.avgMatKg ?? 0);
    const avgMetresUsed = Number(body.avgMetresUsed ?? 0);
    const minsPerPc = Number(body.minsPerPc ?? 0);
    const efficiencyPct = Number(body.efficiencyPct ?? 0);
    const retailPrice = Number(body.retailPrice ?? 0);
    const materialCost = body.materialCost === undefined ? avgMatKg * avgMetresUsed : Number(body.materialCost);
    const labourCost = body.labourCost === undefined
      ? minsPerPc * (efficiencyPct > 0 ? 1 / (efficiencyPct / 100) : 1)
      : Number(body.labourCost);
    const totalCost = body.totalCost === undefined ? materialCost + labourCost : Number(body.totalCost);
    const marginPct = body.marginPct === undefined && retailPrice > 0 ? ((retailPrice - totalCost) / retailPrice) * 100 : Number(body.marginPct ?? 0);
    const cogsRatio = body.cogsRatio === undefined && retailPrice > 0 ? (totalCost / retailPrice) * 100 : Number(body.cogsRatio ?? 0);
    const setSampleCost = Number(body.setSampleCost ?? 0);
    const variance = body.variance === undefined ? setSampleCost - totalCost : Number(body.variance);
    await pool.query(
      `INSERT INTO ${schema}.cost_estimates
       (style_id,fabric,trims,labor,overhead,total,margin,currency,avg_mat_kg,avg_metres_used,mins_per_pc,efficiency_pct,material_cost,labour_cost,retail_price,margin_pct,cogs_ratio,set_sample_cost,variance)
       VALUES ($1,$2,0,$3,0,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (style_id) DO UPDATE SET fabric=EXCLUDED.fabric,labor=EXCLUDED.labor,total=EXCLUDED.total,margin=EXCLUDED.margin,
       currency=EXCLUDED.currency,avg_mat_kg=EXCLUDED.avg_mat_kg,avg_metres_used=EXCLUDED.avg_metres_used,
       mins_per_pc=EXCLUDED.mins_per_pc,efficiency_pct=EXCLUDED.efficiency_pct,material_cost=EXCLUDED.material_cost,
       labour_cost=EXCLUDED.labour_cost,retail_price=EXCLUDED.retail_price,margin_pct=EXCLUDED.margin_pct,
       cogs_ratio=EXCLUDED.cogs_ratio,set_sample_cost=EXCLUDED.set_sample_cost,variance=EXCLUDED.variance`,
      [
        Number(req.params.id),
        materialCost,
        labourCost,
        totalCost,
        marginPct,
        String(body.currency ?? "KES"),
        avgMatKg,
        avgMetresUsed,
        minsPerPc,
        efficiencyPct,
        materialCost,
        labourCost,
        retailPrice,
        marginPct,
        cogsRatio,
        setSampleCost,
        variance,
      ],
    );
    res.json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.put("/styles/:id/pom-qc", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body ?? {};
    await client.query("BEGIN");
    const header = await client.query<{ id: number }>(
      `SELECT id FROM ${schema}.pom_qc WHERE style_id=$1 AND point IS NULL ORDER BY id DESC LIMIT 1`,
      [Number(req.params.id)],
    );
    let headerId = header.rows[0]?.id;
    if (headerId) {
      await client.query(
        `UPDATE ${schema}.pom_qc SET inspector=$1,inspected_date=NULLIF($2,'')::date,stage=$3,status='Header' WHERE id=$4`,
        [String(body.inspector ?? ""), String(body.inspectedDate ?? ""), String(body.stage ?? ""), headerId],
      );
    } else {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO ${schema}.pom_qc (style_id,point,spec,actual,tolerance,status,inspector,inspected_date,stage)
         VALUES ($1,NULL,0,0,0,'Header',$2,NULLIF($3,'')::date,$4) RETURNING id`,
        [Number(req.params.id), String(body.inspector ?? ""), String(body.inspectedDate ?? ""), String(body.stage ?? "")],
      );
      headerId = inserted.rows[0]?.id;
    }
    if (!headerId) throw new Error("POM QC header could not be created");
    await client.query(`DELETE FROM ${schema}.pom_qc_rows WHERE pom_qc_id=$1`, [headerId]);
    for (const row of Array.isArray(body.rows) ? body.rows : []) {
      const targetSpec = Number(row.targetSpec ?? 0);
      const actual = Number(row.actual ?? 0);
      const tolerance = Number(row.tolerance ?? 0);
      const passFail = String(row.passFail ?? (Math.abs(actual - targetSpec) <= tolerance ? "Pass" : "Fail"));
      await client.query(
        `INSERT INTO ${schema}.pom_qc_rows (pom_qc_id,point,target_spec,tolerance,actual,pass_fail,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [headerId, String(row.point ?? ""), targetSpec, tolerance, actual, passFail, String(row.notes ?? "")],
      );
    }
    await client.query("COMMIT");
    res.json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

router.get("/plan", async (req, res, next) => {
  try {
    const quarter = /^Q[1-4]$/.test(String(req.query.quarter ?? "")) ? String(req.query.quarter) : "Q3";
    const parsedYear = Number(req.query.year);
    const year = Number.isInteger(parsedYear) && parsedYear >= 2020 && parsedYear <= 2100 ? parsedYear : 2026;
    const plan = await pool.query(`SELECT id FROM ${schema}.quarterly_plans WHERE quarter=$1 AND year=$2 LIMIT 1`, [quarter, year]);
    const row = plan.rows[0];
    if (!row) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    const payload = await planPayload(row.id);
    if (!payload) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.get("/plans", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.id,p.name,p.quarter,p.year,p.status,COUNT(ps.style_id)::int AS "styleCount"
       FROM ${schema}.quarterly_plans p
       LEFT JOIN ${schema}.plan_styles ps ON ps.plan_id=p.id
       GROUP BY p.id
       ORDER BY p.year DESC,p.quarter ASC`,
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post("/plan", async (req: AuthRequest, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const quarter = String(req.body?.quarter ?? "");
    const year = Number(req.body?.year);
    if (!name || !/^Q[1-4]$/.test(quarter) || !Number.isInteger(year) || year < 2020 || year > 2100) {
      res.status(400).json({ error: "Name, quarter, and year are required" });
      return;
    }
    const existing = await pool.query(`SELECT id FROM ${schema}.quarterly_plans WHERE quarter=$1 AND year=$2 LIMIT 1`, [quarter, year]);
    if (existing.rows[0]) {
      res.status(409).json({ error: "A plan already exists for that quarter" });
      return;
    }
    const created = await pool.query<{ id: number }>(
      `INSERT INTO ${schema}.quarterly_plans (name,quarter,year) VALUES ($1,$2,$3) RETURNING id`,
      [name, quarter, year],
    );
    const planId = created.rows[0]?.id;
    if (!planId) {
      res.status(500).json({ error: "Plan could not be created" });
      return;
    }
    await pool.query(
      `INSERT INTO ${schema}.plan_history (plan_id,action,detail,user_id) VALUES ($1,'Plan created',$2,$3)`,
      [planId, `${name} created.`, req.workspaceUser?.id ?? null],
    );
    res.status(201).json(await planPayload(planId));
  } catch (error) {
    next(error);
  }
});

router.post("/plan/styles", async (req: AuthRequest, res, next) => {
  const client = await pool.connect();
  try {
    const planId = Number(req.body?.planId);
    const styleId = req.body?.styleId === undefined ? null : Number(req.body.styleId);
    const category = String(req.body?.category ?? "").trim();
    const tier = String(req.body?.tier ?? "").trim();
    if (!Number.isInteger(planId) || planId < 1) {
      res.status(400).json({ error: "A plan is required" });
      return;
    }
    await client.query("BEGIN");
    const plan = await client.query<{ id: number; quarter: string; year: number }>(
      `SELECT id,quarter,year FROM ${schema}.quarterly_plans WHERE id=$1 FOR UPDATE`,
      [planId],
    );
    if (!plan.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    let resolvedStyleId = styleId;
    if (styleId !== null) {
      const existingStyle = await client.query(`SELECT id FROM ${schema}.styles s WHERE s.id=$1 AND ${allowedBrand("s")}`, [styleId]);
      if (!existingStyle.rows[0]) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Style not found" });
        return;
      }
    } else {
      if (!category || !tier) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Category and tier are required for a placeholder" });
        return;
      }
      const code = `PLACEHOLDER-${plan.rows[0].year}-${plan.rows[0].quarter}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      const placeholder = await client.query<{ id: number }>(
        `INSERT INTO ${schema}.styles (code,name,brand,category,tier,status,owner,target_date,progress,price,market)
         VALUES ($1,$2,'Vivo',$3,$4,'Draft','Unassigned',CURRENT_DATE,0,0,'EA') RETURNING id`,
        [code, `${category} placeholder`, category, tier],
      );
      resolvedStyleId = placeholder.rows[0]?.id ?? null;
    }
    if (!resolvedStyleId) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: "Style could not be prepared" });
      return;
    }
    const position = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position) + 1, 0)::int AS next FROM ${schema}.plan_styles WHERE plan_id=$1`,
      [planId],
    );
    const inserted = await client.query(
      `INSERT INTO ${schema}.plan_styles (plan_id,style_id,position,decision) VALUES ($1,$2,$3,'On plan') ON CONFLICT DO NOTHING RETURNING style_id`,
      [planId, resolvedStyleId, position.rows[0]?.next ?? 0],
    );
    if (!inserted.rows[0]) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "That style is already on this plan" });
      return;
    }
    await client.query(
      `INSERT INTO ${schema}.plan_history (plan_id,action,detail,user_id) VALUES ($1,'Style added',$2,$3)`,
      [planId, `Style added to ${plan.rows[0].quarter} ${plan.rows[0].year}.`, req.workspaceUser?.id ?? null],
    );
    await client.query("COMMIT");
    res.status(201).json(await planPayload(planId));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

router.patch("/plan", async (req: AuthRequest, res, next) => {
  try {
    const requestedId = Number(req.body?.planId);
    const plan = Number.isInteger(requestedId) && requestedId > 0
      ? await pool.query<{ id: number }>(`SELECT id FROM ${schema}.quarterly_plans WHERE id=$1`, [requestedId])
      : await pool.query<{ id: number }>(`SELECT id FROM ${schema}.quarterly_plans WHERE quarter='Q3' AND year=2026 LIMIT 1`);
    const planId = plan.rows[0]?.id;
    if (!planId) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    const name = req.body?.name ? String(req.body.name) : undefined;
    const quarter = req.body?.quarter ? String(req.body.quarter) : undefined;
    const year = req.body?.year ? Number(req.body.year) : undefined;
    await pool.query(`UPDATE ${schema}.quarterly_plans SET name=COALESCE($1,name),quarter=COALESCE($2,quarter),year=COALESCE($3,year),updated_at=NOW() WHERE id=$4`, [name, quarter, year, planId]);
    await pool.query(`INSERT INTO ${schema}.plan_history (plan_id,action,detail,user_id) VALUES ($1,'Plan updated',$2,$3)`, [planId, name ? `Plan renamed to ${name}` : "Plan metadata updated", req.workspaceUser?.id ?? null]);
    const refreshed = await pool.query(`SELECT id,name,quarter,year FROM ${schema}.quarterly_plans WHERE id=$1`, [planId]);
    const styles = await pool.query(`SELECT s.id,s.code,s.name,s.brand,s.category,s.status,s.owner,to_char(s.target_date,'YYYY-MM-DD') AS "targetDate",s.image,s.progress::float,s.price,s.market,ps.position,ps.decision FROM ${schema}.plan_styles ps JOIN ${schema}.styles s ON s.id=ps.style_id WHERE ps.plan_id=$1 AND ${allowedBrand("s")} ORDER BY ps.position`, [planId]);
    res.json({ ...(await planPayload(planId)), ...refreshed.rows[0], styles: styles.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/plan/history", async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT h.id,h.plan_id AS "planId",h.action,h.detail,u.name AS actor,h.created_at AS "createdAt" FROM ${schema}.plan_history h LEFT JOIN ${schema}.users u ON u.id=h.user_id ORDER BY h.created_at DESC`);
    res.json(result.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
  } catch (error) {
    next(error);
  }
});

async function boardPayload(boardId: number) {
  const board = await pool.query(`SELECT id,title,description,columns FROM ${schema}.boards WHERE id=$1`, [boardId]);
  if (!board.rows[0]) return null;
  const [cards, comments, collaborators] = await Promise.all([
    pool.query(`SELECT id,board_id AS "boardId",title,description,column_id AS "columnId",position,style_id AS "styleId",tags,assignees FROM ${schema}.board_cards WHERE board_id=$1 ORDER BY position,id`, [boardId]),
    pool.query(`SELECT c.id,c.board_id AS "boardId",c.card_id AS "cardId",c.body,c.created_at AS "createdAt",json_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role,'initials',u.initials,'color',u.color) AS author FROM ${schema}.board_comments c JOIN ${schema}.users u ON u.id=c.user_id WHERE c.board_id=$1 ORDER BY c.created_at`, [boardId]),
    pool.query(`SELECT DISTINCT u.id,u.name,u.email,u.role,u.initials,u.color FROM ${schema}.users u JOIN ${schema}.board_cards c ON c.created_by=u.id WHERE c.board_id=$1`, [boardId]),
  ]);
  return { ...board.rows[0], cards: cards.rows, comments: comments.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })), collaborators: collaborators.rows };
}

router.get("/boards", async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT b.id,b.title,b.description,b.columns,COUNT(c.id)::int AS "cardCount" FROM ${schema}.boards b LEFT JOIN ${schema}.board_cards c ON c.board_id=b.id GROUP BY b.id ORDER BY b.id`);
    const payloads = await Promise.all(result.rows.map((row) => boardPayload(row.id)));
    res.json(payloads.filter(Boolean));
  } catch (error) {
    next(error);
  }
});

router.post("/boards", async (req: AuthRequest, res, next) => {
  try {
    const result = await pool.query<{ id: number }>(`INSERT INTO ${schema}.boards (title,description,columns,created_by) VALUES ($1,$2,$3::jsonb,$4) RETURNING id`, [String(req.body?.title ?? "Untitled board"), String(req.body?.description ?? ""), JSON.stringify([{ id: "brief", title: "Brief" }, { id: "deciding", title: "Deciding" }, { id: "ready", title: "Ready" }]), req.workspaceUser?.id ?? null]);
    const created = await boardPayload(result.rows[0].id);
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

router.get("/boards/:id", async (req, res, next) => {
  try {
    const result = await boardPayload(Number(req.params.id));
    if (!result) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/boards/:id/cards", async (req: AuthRequest, res, next) => {
  try {
    const boardId = Number(req.params.id);
    const positionResult = await pool.query<{ max: number | null }>(`SELECT MAX(position)::int AS max FROM ${schema}.board_cards WHERE board_id=$1 AND column_id=$2`, [boardId, String(req.body?.columnId ?? "brief")]);
    const result = await pool.query(`INSERT INTO ${schema}.board_cards (board_id,title,description,column_id,position,style_id,tags,assignees,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING id,board_id AS "boardId",title,description,column_id AS "columnId",position,style_id AS "styleId",tags,assignees`, [boardId, String(req.body?.title ?? "New decision"), String(req.body?.description ?? ""), String(req.body?.columnId ?? "brief"), (positionResult.rows[0]?.max ?? -1) + 1, req.body?.styleId ? Number(req.body.styleId) : null, JSON.stringify(req.body?.tags ?? []), JSON.stringify(req.body?.assignees ?? []), req.workspaceUser?.id ?? null]);
    const card = result.rows[0];
    io.to(`board:${boardId}`).emit("board:card-created", card);
    res.status(201).json(card);
  } catch (error) {
    next(error);
  }
});

router.post("/boards/:id/comments", async (req: AuthRequest, res, next) => {
  try {
    const boardId = Number(req.params.id);
    const result = await pool.query(`INSERT INTO ${schema}.board_comments (board_id,card_id,user_id,body) VALUES ($1,$2,$3,$4) RETURNING id,board_id AS "boardId",card_id AS "cardId",body,created_at AS "createdAt"`, [boardId, req.body?.cardId ? Number(req.body.cardId) : null, req.workspaceUser?.id, String(req.body?.body ?? "")]);
    const comment = { ...result.rows[0], createdAt: iso(result.rows[0].createdAt), author: publicUser(req.workspaceUser!) };
    io.to(`board:${boardId}`).emit("board:comment-created", comment);
    res.status(201).json(comment);
  } catch (error) {
    next(error);
  }
});

router.patch("/boards/:id/cards/:cardId", async (req, res, next) => {
  try {
    const boardId = Number(req.params.id);
    const cardId = Number(req.params.cardId);
    const allowed = ["title", "description", "columnId", "position", "tags"] as const;
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed) {
      if (req.body?.[key] === undefined) continue;
      const column = key === "columnId" ? "column_id" : key;
      const value = key === "tags" ? JSON.stringify(req.body[key]) : req.body[key];
      values.push(value);
      assignments.push(`${column}${key === "tags" ? "::jsonb" : ""}=$${values.length}`);
    }
    if (!assignments.length) {
      res.status(400).json({ error: "No card fields supplied" });
      return;
    }
    values.push(cardId, boardId);
    const result = await pool.query(
      `UPDATE ${schema}.board_cards SET ${assignments.join(",")},updated_at=NOW()
       WHERE id=$${values.length - 1} AND board_id=$${values.length}
       RETURNING id,board_id AS "boardId",title,description,column_id AS "columnId",position,style_id AS "styleId",tags,assignees`,
      values,
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Card not found" });
      return;
    }
    io.to(`board:${boardId}`).emit("board:card-moved", result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get("/showcases", async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT id,title,season,status,description FROM ${schema}.showcases ORDER BY id`);
    const frames = await pool.query(`SELECT id,showcase_id AS "showcaseId",style_id AS "styleId",title,caption,image,position,kind FROM ${schema}.showcase_frames ORDER BY position`);
    res.json(result.rows.map((showcase) => ({ ...showcase, frames: frames.rows.filter((frame) => frame.showcaseId === showcase.id) })));
  } catch (error) {
    next(error);
  }
});

router.get("/showcases/:id", async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT id,title,season,status,description FROM ${schema}.showcases WHERE id=$1`, [Number(req.params.id)]);
    if (!result.rows[0]) {
      res.status(404).json({ error: "Showcase not found" });
      return;
    }
    const frames = await pool.query(`SELECT id,showcase_id AS "showcaseId",style_id AS "styleId",title,caption,image,position,kind FROM ${schema}.showcase_frames WHERE showcase_id=$1 ORDER BY position`, [Number(req.params.id)]);
    res.json({ ...result.rows[0], frames: frames.rows });
  } catch (error) {
    next(error);
  }
});

const SHOWCASE_PURPOSES = ["Trend Brief", "Drop Preview", "Range Review", "Line Sheet", "Moodboard", "Other"] as const;

router.get("/showcase-boards", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT b.id,b.title,b.purpose,b.description,
        b.creator_user_id AS "creatorUserId",b.creator_name AS "creatorName",b.creator_role AS "creatorRole",
        COALESCE(b.cover_image_url,(
          SELECT i.image_data FROM ${schema}.showcase_images i
          JOIN ${schema}.showcase_sections s ON s.id=i.section_id
          WHERE s.board_id=b.id ORDER BY s.position,i.position,i.id LIMIT 1
        )) AS "coverImage",
        to_char(b.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
        (SELECT COUNT(*)::int FROM ${schema}.showcase_comments c WHERE c.board_id=b.id) AS "commentCount"
       FROM ${schema}.showcase_boards b ORDER BY b.created_at DESC,b.id DESC`,
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post("/showcase-boards", async (req, res, next) => {
  try {
    const title = String(req.body?.title ?? "").trim();
    const purpose = String(req.body?.purpose ?? "Other");
    const description = String(req.body?.description ?? "").trim();
    const creatorUserId = Number(req.body?.creatorUserId) || null;
    const creatorName = String(req.body?.creatorName ?? "").trim();
    const creatorRole = String(req.body?.creatorRole ?? "").trim();
    if (!title) {
      res.status(400).json({ error: "Title is required" });
      return;
    }
    if (!(SHOWCASE_PURPOSES as readonly string[]).includes(purpose)) {
      res.status(400).json({ error: "Unknown purpose" });
      return;
    }
    const result = await pool.query(
      `INSERT INTO ${schema}.showcase_boards (title,purpose,description,creator_user_id,creator_name,creator_role)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,title,purpose,description,creator_user_id AS "creatorUserId",creator_name AS "creatorName",creator_role AS "creatorRole",
         to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`,
      [title, purpose, description, creatorUserId, creatorName, creatorRole],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

async function showcaseBoardPayload(id: number) {
  const board = await pool.query(
    `SELECT id,title,purpose,description,creator_user_id AS "creatorUserId",creator_name AS "creatorName",creator_role AS "creatorRole",
       cover_image_url AS "coverImageUrl",
       to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
       to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
     FROM ${schema}.showcase_boards WHERE id=$1`,
    [id],
  );
  if (!board.rows[0]) return null;
  const [sections, images, comments] = await Promise.all([
    pool.query(`SELECT id,title,body,position FROM ${schema}.showcase_sections WHERE board_id=$1 ORDER BY position,id`, [id]),
    pool.query(
      `SELECT i.id,i.section_id AS "sectionId",i.image_data AS "imageData",i.source_type AS "sourceType",
         i.plm_style_id AS "plmStyleId",i.caption,i.position
       FROM ${schema}.showcase_images i JOIN ${schema}.showcase_sections s ON s.id=i.section_id
       WHERE s.board_id=$1 ORDER BY i.position,i.id`,
      [id],
    ),
    pool.query(
      `SELECT id,user_name AS "userName",user_role AS "userRole",comment_text AS "commentText",
         to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
       FROM ${schema}.showcase_comments WHERE board_id=$1 ORDER BY created_at,id`,
      [id],
    ),
  ]);
  return {
    ...board.rows[0],
    sections: sections.rows.map((section) => ({ ...section, images: images.rows.filter((image) => image.sectionId === section.id) })),
    comments: comments.rows,
  };
}

router.get("/showcase-boards/:id", async (req, res, next) => {
  try {
    const payload = await showcaseBoardPayload(Number(req.params.id));
    if (!payload) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.put("/showcase-boards/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const purpose = req.body?.purpose === undefined ? undefined : String(req.body.purpose);
    if (purpose !== undefined && !(SHOWCASE_PURPOSES as readonly string[]).includes(purpose)) {
      res.status(400).json({ error: "Unknown purpose" });
      return;
    }
    const result = await pool.query(
      `UPDATE ${schema}.showcase_boards SET
         title=COALESCE($2,title),
         purpose=COALESCE($3,purpose),
         description=COALESCE($4,description),
         cover_image_url=COALESCE($5,cover_image_url),
         updated_at=NOW()
       WHERE id=$1 RETURNING id`,
      [
        id,
        req.body?.title === undefined ? null : String(req.body.title).trim(),
        purpose ?? null,
        req.body?.description === undefined ? null : String(req.body.description),
        req.body?.coverImageUrl === undefined ? null : String(req.body.coverImageUrl),
      ],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    res.json(await showcaseBoardPayload(id));
  } catch (error) {
    next(error);
  }
});

router.delete("/showcase-boards/:id", async (req, res, next) => {
  try {
    const result = await pool.query(`DELETE FROM ${schema}.showcase_boards WHERE id=$1 RETURNING id`, [Number(req.params.id)]);
    if (!result.rows[0]) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post("/showcase-boards/:id/sections", async (req, res, next) => {
  try {
    const boardId = Number(req.params.id);
    const board = await pool.query(`SELECT id FROM ${schema}.showcase_boards WHERE id=$1`, [boardId]);
    if (!board.rows[0]) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    const result = await pool.query(
      `INSERT INTO ${schema}.showcase_sections (board_id,title,body,position)
       VALUES ($1,$2,$3,COALESCE((SELECT MAX(position)+1 FROM ${schema}.showcase_sections WHERE board_id=$1),0))
       RETURNING id,title,body,position`,
      [boardId, String(req.body?.title ?? "").trim() || "New section", String(req.body?.body ?? "")],
    );
    await pool.query(`UPDATE ${schema}.showcase_boards SET updated_at=NOW() WHERE id=$1`, [boardId]);
    res.status(201).json({ ...result.rows[0], images: [] });
  } catch (error) {
    next(error);
  }
});

router.put("/showcase-sections/:id", async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE ${schema}.showcase_sections SET
         title=COALESCE($2,title), body=COALESCE($3,body), position=COALESCE($4,position)
       WHERE id=$1 RETURNING id,board_id AS "boardId",title,body,position`,
      [
        Number(req.params.id),
        req.body?.title === undefined ? null : String(req.body.title),
        req.body?.body === undefined ? null : String(req.body.body),
        req.body?.position === undefined ? null : Number(req.body.position),
      ],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Section not found" });
      return;
    }
    await pool.query(`UPDATE ${schema}.showcase_boards SET updated_at=NOW() WHERE id=$1`, [result.rows[0].boardId]);
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.delete("/showcase-sections/:id", async (req, res, next) => {
  try {
    const result = await pool.query(`DELETE FROM ${schema}.showcase_sections WHERE id=$1 RETURNING id`, [Number(req.params.id)]);
    if (!result.rows[0]) {
      res.status(404).json({ error: "Section not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post("/showcase-sections/:id/images", async (req, res, next) => {
  try {
    const sectionId = Number(req.params.id);
    const section = await pool.query(`SELECT id,board_id AS "boardId" FROM ${schema}.showcase_sections WHERE id=$1`, [sectionId]);
    if (!section.rows[0]) {
      res.status(404).json({ error: "Section not found" });
      return;
    }
    const rawImages = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!rawImages.length) {
      res.status(400).json({ error: "No images provided" });
      return;
    }
    if (rawImages.length > 12) {
      res.status(400).json({ error: "At most 12 images per request" });
      return;
    }
    const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
    const validUploadImage = (dataUri: string): boolean => {
      const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUri);
      if (!match) return false;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(match[2], "base64");
      } catch {
        return false;
      }
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return false;
      const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const isWebp = bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
      return isPng || isJpeg || isWebp;
    };
    const plmPlaceholder = (styleId: number) =>
      `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 560"><rect width="480" height="560" fill="${styleId % 2 ? "#d8d0c4" : "#d6dde0"}"/><path d="M134 118 195 80h90l61 38 54 91-55 36-33-57v254H168V188l-33 57-55-36z" fill="${styleId % 2 ? "#ede8df" : "#f4f0e8"}" stroke="#1A1A2E" stroke-width="4"/><path d="M195 81c4 45 86 45 90 0M167 264h146" fill="none" stroke="#C9A96E" stroke-width="4"/><text x="24" y="522" fill="#1A1A2E" font-family="sans-serif" font-size="18" letter-spacing="4">VIVO PLM</text></svg>`)}`;
    const inserted = [];
    for (const raw of rawImages) {
      const sourceType = raw?.sourceType === "plm" ? "plm" : "upload";
      let imageData = "";
      let plmStyleId: number | null = null;
      if (sourceType === "plm") {
        plmStyleId = Number(raw?.plmStyleId) || null;
        if (!plmStyleId) continue;
        const style = await pool.query(`SELECT image FROM ${schema}.styles WHERE id=$1`, [plmStyleId]);
        if (!style.rows[0]) continue;
        imageData = String(style.rows[0].image ?? "") || plmPlaceholder(plmStyleId);
      } else {
        imageData = String(raw?.imageData ?? "");
        if (!validUploadImage(imageData)) {
          res.status(400).json({ error: "Uploads must be jpg, png or webp images under 4MB" });
          return;
        }
      }
      if (!imageData) continue;
      const row = await pool.query(
        `INSERT INTO ${schema}.showcase_images (section_id,image_data,source_type,plm_style_id,caption,position)
         VALUES ($1,$2,$3,$4,$5,COALESCE((SELECT MAX(position)+1 FROM ${schema}.showcase_images WHERE section_id=$1),0))
         RETURNING id,section_id AS "sectionId",image_data AS "imageData",source_type AS "sourceType",plm_style_id AS "plmStyleId",caption,position`,
        [sectionId, imageData, sourceType, plmStyleId, String(raw?.caption ?? "")],
      );
      inserted.push(row.rows[0]);
    }
    if (!inserted.length) {
      res.status(400).json({ error: "No valid images provided" });
      return;
    }
    await pool.query(`UPDATE ${schema}.showcase_boards SET updated_at=NOW() WHERE id=$1`, [section.rows[0].boardId]);
    res.status(201).json(inserted);
  } catch (error) {
    next(error);
  }
});

router.delete("/showcase-images/:id", async (req, res, next) => {
  try {
    const result = await pool.query(`DELETE FROM ${schema}.showcase_images WHERE id=$1 RETURNING id`, [Number(req.params.id)]);
    if (!result.rows[0]) {
      res.status(404).json({ error: "Image not found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post("/showcase-boards/:id/comments", async (req, res, next) => {
  try {
    const boardId = Number(req.params.id);
    const board = await pool.query(`SELECT id FROM ${schema}.showcase_boards WHERE id=$1`, [boardId]);
    if (!board.rows[0]) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    const userName = String(req.body?.userName ?? "").trim();
    const commentText = String(req.body?.commentText ?? "").trim();
    if (!userName || !commentText) {
      res.status(400).json({ error: "Name and comment are required" });
      return;
    }
    const result = await pool.query(
      `INSERT INTO ${schema}.showcase_comments (board_id,user_name,user_role,comment_text)
       VALUES ($1,$2,$3,$4)
       RETURNING id,user_name AS "userName",user_role AS "userRole",comment_text AS "commentText",
         to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"`,
      [boardId, userName, String(req.body?.userRole ?? "").trim(), commentText],
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get("/catalogue-products/detail", async (req, res, next) => {
  try {
    const styleNumber = String(req.query.styleNumber ?? "").trim();
    if (!styleNumber || styleNumber.length > 200) {
      res.status(400).json({ error: "A style number is required" });
      return;
    }
    const result = await pool.query(
      `WITH style_rows AS (
         SELECT a.*,COALESCE(inv.stock_units,0) AS inventory_units,
           COALESCE(NULLIF(TRIM(a.range_tier),''), CASE
             WHEN BOOL_OR(COALESCE(a.is_noos,FALSE) OR UPPER(COALESCE(a.tier,''))='NOOS')
                  OVER (PARTITION BY COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))) THEN 'NOOS'
             WHEN SUM(COALESCE(inv.stock_units,0))
                  OVER (PARTITION BY COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))) > 100 THEN 'Core'
             ELSE 'Recent'
           END) AS effective_range_tier
         FROM public.all_products_clean a
         LEFT JOIN (
           SELECT sku,SUM(available) AS stock_units
           FROM public.all_inventory GROUP BY sku
         ) inv ON inv.sku=a.sku
         WHERE ${allowedBrand("a")}
           AND COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))=$1
           AND LOWER(COALESCE(a.status,'')) IN ('active','retired')
       )
       SELECT COALESCE(NULLIF(TRIM(style_number),''),NULLIF(TRIM(sku),'')) AS "styleNumber",
         MAX(NULLIF(TRIM(style_number),'')) AS "internalReference",
         MAX(NULLIF(TRIM(sku),'')) AS sku,
         MAX(style_name) AS "styleName",
         MAX(brand) AS brand,MAX(category) AS category,MAX(product_type) AS subcategory,
         CASE WHEN BOOL_OR(LOWER(status)='active') THEN 'Active' ELSE 'Retired' END AS status,
         MAX(effective_range_tier) AS "rangeTier",
         COALESCE(SUM(inventory_units),0)::numeric AS "stockUnits"
       FROM style_rows
       GROUP BY COALESCE(NULLIF(TRIM(style_number),''),NULLIF(TRIM(sku),''))`,
      [styleNumber],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Catalogue style not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.patch("/catalogue-products/range-tier", async (req, res, next) => {
  try {
    const styleNumber = String(req.body?.styleNumber ?? "").trim();
    const rangeTier = String(req.body?.rangeTier ?? "").trim();
    if (!styleNumber || styleNumber.length > 200 || !["NOOS", "Core", "Recent"].includes(rangeTier)) {
      res.status(400).json({ error: "Style number and a valid range tier are required" });
      return;
    }
    const noos = await pool.query(
      `SELECT BOOL_OR(COALESCE(a.is_noos,FALSE) OR UPPER(COALESCE(a.tier,''))='NOOS' OR UPPER(COALESCE(a.range_tier,''))='NOOS') AS is_noos
       FROM public.all_products_clean a
       WHERE ${allowedBrand("a")}
         AND COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))=$1`,
      [styleNumber],
    );
    if (rangeTier !== "NOOS" && noos.rows[0]?.is_noos) {
      res.status(409).json({ error: "NOOS styles must keep the NOOS tier" });
      return;
    }
    const result = await pool.query(
      `UPDATE public.all_products_clean
       SET range_tier=$1
       WHERE COALESCE(NULLIF(TRIM(style_number),''),NULLIF(TRIM(sku),''))=$2
         AND LOWER(COALESCE(status,'')) IN ('active','retired')
         AND brand IN (${ALLOWED_BRANDS_SQL})
       RETURNING style_number AS "styleNumber"`,
      [rangeTier, styleNumber],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Catalogue style not found" });
      return;
    }
    res.json({ styleNumber, rangeTier });
  } catch (error) {
    next(error);
  }
});

router.get("/catalogue-products", async (req, res, next) => {
  try {
    const search = String(req.query.search ?? "").trim();
    const csv = (raw: unknown) =>
      String(raw ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    const filters = {
      tier: csv(req.query.tier),
      status: csv(req.query.status),
      category: csv(req.query.category),
      subcategory: csv(req.query.subcategory),
      fabricCategory: csv(req.query.fabricCategory ?? req.query.fabric_category),
      brand: csv(req.query.brand),
      primaryColour: csv(req.query.primaryColour ?? req.query.primary_colour),
      edit: csv(req.query.edit),
    };
    const statusFilter = String(req.query.status ?? "").trim().toLowerCase();
    const sort = catalogueSortKey(req.query.sort);
    const rawPage = Number(req.query.page);
    const page = Number.isInteger(rawPage) && rawPage >= 1 ? Math.min(rawPage, 10000) : 1;
    const pageSize = 50;
    const styleKeyExpr = `COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))`;
    const sampleSaleExclusion = `LOWER(COALESCE(a.style_number,'')) NOT LIKE '%sample%'
      AND LOWER(COALESCE(a.category,'')) NOT LIKE '%sample%'
      AND LOWER(COALESCE(a.category,'')) NOT LIKE '%sale item%'
      AND LOWER(COALESCE(a.style_name,'')) NOT LIKE '%sample%'
      AND LOWER(COALESCE(a.sku,'')) NOT LIKE '%sample%'`;
    const where: string[] = [
      allowedBrand("a"),
      "LOWER(a.status) IN ('active','retired')",
      `${styleKeyExpr} IS NOT NULL`,
      sampleSaleExclusion,
    ];
    const values: unknown[] = [];
    const tierExpr = `CASE
      WHEN BOOL_OR(COALESCE(a.is_noos,FALSE) OR UPPER(COALESCE(a.tier,''))='NOOS' OR UPPER(COALESCE(a.range_tier,''))='NOOS') THEN 'NOOS'
      WHEN BOOL_OR(UPPER(COALESCE(a.range_tier,''))='CORE') THEN 'Core'
      WHEN BOOL_OR(UPPER(COALESCE(a.range_tier,''))='RECENT') THEN 'Recent'
      WHEN COALESCE(SUM(COALESCE(inv.stock_units,0)),0)>100 THEN 'Core'
      ELSE 'Recent'
    END`;
    if (search) {
      values.push(`%${search}%`);
      where.push(`(a.style_name ILIKE $${values.length} OR a.style_number ILIKE $${values.length} OR a.sku ILIKE $${values.length})`);
    }
    if (filters.brand.length) {
      values.push(filters.brand);
      where.push(`a.brand = ANY($${values.length})`);
    }
    const having: string[] = [];
    if (filters.tier.length) {
      values.push(filters.tier);
      having.push(`${tierExpr} = ANY($${values.length})`);
    }
    if (statusFilter === "active" || statusFilter === "retired") {
      values.push(statusFilter === "active");
      having.push(`BOOL_OR(LOWER(a.status)='active') = $${values.length}`);
    }
    const addHavingAny = (expression: string, selected: string[]) => {
      if (!selected.length) return;
      values.push(selected);
      having.push(`BOOL_OR(${expression} = ANY($${values.length}))`);
    };
    addHavingAny(`NULLIF(TRIM(a.category),'')`, filters.category);
    addHavingAny(`NULLIF(TRIM(a.product_type),'')`, filters.subcategory);
    addHavingAny(`NULLIF(TRIM(a.fabric_category),'')`, filters.fabricCategory);
    addHavingAny(`NULLIF(TRIM(a.color_print),'')`, filters.primaryColour);
    addHavingAny(`NULLIF(TRIM(a.collection),'')`, filters.edit);
    // Status and tier are aggregate style attributes, so they belong in HAVING.
    // The other seven facets are also OR-composed at style grain: a style remains
    // selectable when any SKU carries the selected facet value.
    const plainWhere = where;
    const baseQuery = `
      FROM public.all_products_clean a
      LEFT JOIN (
        SELECT sku,SUM(available) AS stock_units
        FROM public.all_inventory GROUP BY sku
      ) inv ON inv.sku=a.sku
      WHERE ${plainWhere.join(" AND ")}
      GROUP BY ${styleKeyExpr}
      ${having.length ? `HAVING ${having.join(" AND ")}` : ""}
    `;
    const facetWhere = [
      allowedBrand("a"),
      "LOWER(a.status) IN ('active','retired')",
      `${styleKeyExpr} IS NOT NULL`,
      sampleSaleExclusion,
    ].join(" AND ");
    const facetTierExpr = tierExpr;
    const facetsQuery = `
      WITH facet_styles AS (
        SELECT ${styleKeyExpr} AS style_key,${facetTierExpr} AS tier
        FROM public.all_products_clean a
        LEFT JOIN (
          SELECT sku,SUM(available) AS stock_units
          FROM public.all_inventory GROUP BY sku
        ) inv ON inv.sku=a.sku
        WHERE ${facetWhere}
        GROUP BY ${styleKeyExpr}
      )
      SELECT
        ARRAY(SELECT DISTINCT a.brand FROM public.all_products_clean a WHERE ${facetWhere} AND a.brand IS NOT NULL AND TRIM(a.brand) <> '' ORDER BY a.brand) AS brands,
        ARRAY(SELECT DISTINCT a.product_type FROM public.all_products_clean a WHERE ${facetWhere} AND a.product_type IS NOT NULL AND TRIM(a.product_type) <> '' ORDER BY a.product_type) AS subcategories,
        ARRAY(SELECT DISTINCT a.category FROM public.all_products_clean a WHERE ${facetWhere} AND a.category IS NOT NULL AND TRIM(a.category) <> '' ORDER BY a.category) AS categories,
        ARRAY(SELECT DISTINCT a.fabric_category FROM public.all_products_clean a WHERE ${facetWhere} AND a.fabric_category IS NOT NULL AND TRIM(a.fabric_category) <> '' ORDER BY a.fabric_category) AS "fabricCategories",
        ARRAY(SELECT DISTINCT a.color_print FROM public.all_products_clean a WHERE ${facetWhere} AND a.color_print IS NOT NULL AND TRIM(a.color_print) <> '' ORDER BY a.color_print) AS "primaryColours",
        ARRAY(SELECT DISTINCT a.collection FROM public.all_products_clean a WHERE ${facetWhere} AND a.collection IS NOT NULL AND TRIM(a.collection) <> '' ORDER BY a.collection) AS edits,
        ARRAY(SELECT DISTINCT tier FROM facet_styles WHERE tier IS NOT NULL ORDER BY tier) AS tiers
    `;
    const offset = (page - 1) * pageSize;
    const [rows, count, facets] = await Promise.all([
      pool.query(
        `WITH style_rows AS (
           SELECT ${styleKeyExpr} AS "styleNumber",
             MAX(NULLIF(TRIM(a.style_number),'')) AS "internalReference",
             MAX(NULLIF(TRIM(a.sku),'')) AS sku,
             MAX(a.style_name) AS "styleName",
             MAX(a.brand) AS brand,
             MAX(a.product_type) AS subcategory,
             MAX(NULLIF(TRIM(COALESCE(a.category,'')),'')) AS category,
             MAX(NULLIF(TRIM(COALESCE(a.fabric_category,'')),'')) AS "fabricCategory",
             MAX(NULLIF(TRIM(COALESCE(a.color_print,'')),'')) AS "primaryColour",
             MAX(NULLIF(TRIM(COALESCE(a.collection,'')),'')) AS edit,
             (MODE() WITHIN GROUP (ORDER BY NULLIF(a.price,0))
               FILTER (WHERE a.price IS NOT NULL AND a.price > 0))::float AS price,
             MAX(NULLIF(TRIM(COALESCE(a.style_launch_date,'')),'')) AS catalogue_launch_date,
             COALESCE(SUM(COALESCE(inv.stock_units,0)),0)::float AS "stockUnits",
             COUNT(DISTINCT NULLIF(TRIM(COALESCE(a.color_print,'')),'')) AS colour_count,
             MIN(NULLIF(TRIM(COALESCE(a.color_print,'')),'')) AS any_colour,
             CASE WHEN BOOL_OR(LOWER(a.status)='active') THEN 'Active' ELSE 'Retired' END AS status,
             ${tierExpr} AS "rangeTier",
             (ARRAY_AGG(a.sku))[1] AS any_sku
           ${baseQuery}
         ),
         product_map AS (
           SELECT a.sku,
             MIN(COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))) AS style_key
           FROM public.all_products_clean a
           JOIN style_rows f
             ON f."styleNumber"=COALESCE(NULLIF(TRIM(a.style_number),''),NULLIF(TRIM(a.sku),''))
           WHERE ${allowedBrand("a")}
             AND ${sampleSaleExclusion}
             AND NULLIF(TRIM(a.sku),'') IS NOT NULL
           GROUP BY a.sku
         ),
         sales_by_style AS (
           SELECT pm.style_key,
             SUM(CASE WHEN LOWER(COALESCE(sa.sale_kind,'')) IN ('sale','order')
               THEN GREATEST(COALESCE(sa.ordered_item_quantity,0)::numeric,0) ELSE 0 END)::float AS units_sold,
             SUM(COALESCE(sa.total_sales_kes,0)::numeric
               - COALESCE(sa.discounts_kes,0)::numeric
               - COALESCE(sa.returns_kes,0)::numeric)::float AS revenue_kes,
             MIN(CASE WHEN sa.sale_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
               THEN LEFT(sa.sale_date,10)::date END)
               FILTER (WHERE LOWER(COALESCE(sa.sale_kind,'')) IN ('sale','order')) AS first_sale_date
           FROM public.all_sales sa
           JOIN product_map pm ON pm.sku=sa.variant_sku
           GROUP BY pm.style_key
         ),
         enriched AS (
           SELECT sr.*,
             COALESCE(
               CASE WHEN sr.catalogue_launch_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                 THEN LEFT(sr.catalogue_launch_date,10)::date END,
               sb.first_sale_date
             ) AS "launchDate",
             sb.units_sold AS "unitsSold",
             sb.revenue_kes AS "revenueKes",
             CASE
               WHEN COALESCE(sb.units_sold,0) + COALESCE(sr."stockUnits",0) > 0
               THEN ROUND((100.0 * COALESCE(sb.units_sold,0)
                 / (COALESCE(sb.units_sold,0) + COALESCE(sr."stockUnits",0)))::numeric,2)::float
               ELSE NULL
             END AS "sorPct"
           FROM style_rows sr
           LEFT JOIN sales_by_style sb ON sb.style_key=sr."styleNumber"
         )
         SELECT s.*, img.image FROM (
           SELECT * FROM enriched e
           ORDER BY ${catalogueOrderBy(sort, "e")}
           LIMIT ${pageSize} OFFSET ${offset}
         ) s
         LEFT JOIN LATERAL (
           SELECT i.image_512 AS image
           FROM public.all_products_clean b
           JOIN public.product_image_map m ON m.sku = b.sku
           JOIN public.product_images i ON i.tmpl_id = m.tmpl_id
            WHERE ${allowedBrand("b")}
              AND LOWER(COALESCE(b.status,'')) IN ('active','retired')
               AND COALESCE(NULLIF(TRIM(b.style_number),''),NULLIF(TRIM(b.sku),'')) = s."styleNumber" AND i.image_512 IS NOT NULL AND i.image_512 <> ''
           LIMIT 1
         ) img ON TRUE`,
        values,
      ),
       pool.query(`SELECT COUNT(*)::int AS total FROM (SELECT ${styleKeyExpr} ${baseQuery}) t`, values),
      pool.query(facetsQuery),
    ]);
    res.json({
      items: rows.rows.map(({ any_sku: _drop, colour_count, any_colour, catalogue_launch_date: _dropLaunch, image, ...row }) => ({
        ...row,
        colourway:
          Number(colour_count) > 1
            ? `${Number(colour_count)} colourways`
            : (any_colour ?? null),
        image: image ? (String(image).startsWith("data:") ? String(image) : `data:image/jpeg;base64,${image}`) : null,
      })),
      total: count.rows[0].total,
      page,
      pageSize,
      brands: facets.rows[0].brands || [...WORKSPACE_BRANDS],
      subcategories: facets.rows[0].subcategories || [],
      filterOptions: {
        tier: facets.rows[0].tiers || [],
        status: ["Active", "Retired"],
        category: facets.rows[0].categories || [],
        subCategory: facets.rows[0].subcategories || [],
        fabricCategory: facets.rows[0].fabricCategories || [],
        brand: facets.rows[0].brands || [...WORKSPACE_BRANDS],
        primaryColour: facets.rows[0].primaryColours || [],
        edit: facets.rows[0].edits || [],
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/l10/scorecard/live", requireUser, liveScorecardHandler);
app.get("/api/team/birthdays/today", requireUser, async (_req, res, next) => {
  try {
    const result = await pool.query<{ name: string; role: string }>(
      `SELECT name,role
       FROM (
         SELECT NULLIF(TRIM(name),'') AS name,role
         FROM ${schema}.workspace_users
         WHERE date_of_birth IS NOT NULL
           AND EXTRACT(MONTH FROM date_of_birth) = EXTRACT(MONTH FROM CURRENT_DATE)
           AND EXTRACT(DAY FROM date_of_birth) = EXTRACT(DAY FROM CURRENT_DATE)
         UNION
         SELECT COALESCE(NULLIF(TRIM(name),''),NULLIF(TRIM(role_title),'')) AS name,
                role_title AS role
         FROM ${schema}.workspace_team_members
         WHERE birthday IS NOT NULL
           AND EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM CURRENT_DATE)
           AND EXTRACT(DAY FROM birthday) = EXTRACT(DAY FROM CURRENT_DATE)
       ) birthdays
       WHERE name IS NOT NULL
       ORDER BY name`,
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});
app.patch("/api/styles/:id", requireUser, async (req, res, next) => {
  try {
    if (!schemaReady) {
      res.status(503).json({ error: "Workspace service is starting" });
      return;
    }
    const fields = [
      ["launch_route", "launchRoute", PLM_LAUNCH_ROUTES],
      ["style_classification", "styleClassification", PLM_STYLE_CLASSIFICATIONS],
      ["range_tier", "rangeTier", PLM_RANGE_TIERS],
    ] as const;
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [column, key, allowedValues] of fields) {
      if (req.body?.[key] === undefined) continue;
      const rawValue = req.body[key];
      if (rawValue !== null && rawValue !== "" && !allowedValues.includes(String(rawValue) as never)) {
        res.status(400).json({ error: `${key} has an unsupported value` });
        return;
      }
      values.push(rawValue === "" ? null : rawValue);
      assignments.push(`${column}=$${values.length}`);
    }
    if (!assignments.length) {
      res.status(400).json({ error: "At least one classification field is required" });
      return;
    }
    values.push(Number(req.params.id));
    const result = await pool.query(
      `UPDATE public.pd_styles SET ${assignments.join(",")} WHERE id=$${values.length}
       RETURNING id,launch_route AS "launchRoute",style_classification AS "styleClassification",range_tier AS "rangeTier"`,
      values,
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "Style not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});
app.get("/api/debug/team-members", async (_req, res, next) => {
  try {
    res.json(await readTeamMemberDebug());
  } catch (error) {
    next(error);
  }
});
app.use("/api/workspace", router);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  if (!res.headersSent) res.status(500).json({ error: "Workspace server error" });
});

const boardPresence = new Map<string, Set<string>>();
io.on("connection", (socket) => {
  socket.on("join-board", (boardId: number | string) => {
    const room = `board:${Number(boardId)}`;
    socket.join(room);
    const set = boardPresence.get(room) ?? new Set<string>();
    set.add(socket.id);
    boardPresence.set(room, set);
    io.to(room).emit("board:presence", { count: set.size });
    socket.on("disconnect", () => {
      set.delete(socket.id);
      io.to(room).emit("board:presence", { count: set.size });
    });
  });
  socket.on("board:card-moved", (payload: { boardId: number; cardId: number; columnId: string; position: number }) => {
    socket.to(`board:${payload.boardId}`).emit("board:card-moved", payload);
  });
});

const port = Number(process.env.PORT ?? 23661);

httpServer.listen(port, "0.0.0.0", () => {
  serviceReady = true;
  console.log(`Vivo workspace API listening on ${port}`);
  void withTimeout(ensureSchema(), 15000, "workspace schema initialisation")
    .then(() => {
      schemaReady = true;
      lastDbProbeResult = true;
      console.log("Vivo workspace database ready");
      void cleanupExpiredFeedbackImageUploads().catch((error) => console.warn("Unable to clean expired feedback images", error));
      setInterval(() => {
        void cleanupExpiredFeedbackImageUploads().catch((error) => console.warn("Unable to clean expired feedback images", error));
      }, 5 * 60 * 1000).unref();
    })
    .catch(async (error) => {
      console.error("Unable to initialise workspace database", error);
      await ensureRecentWorkspaceMigrations();
      schemaReady = await isDatabaseReachable();
      console.warn(`Vivo workspace starting in ${schemaReady ? "degraded" : "unavailable"} database mode`);
    });
});

process.on("SIGTERM", () => {
  void pool.end().finally(() => process.exit(0));
});

export { app, pool };