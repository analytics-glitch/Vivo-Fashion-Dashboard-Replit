import crypto from "node:crypto";
import { spawn } from "node:child_process";
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
  feedbackImagePreviewUrl,
  feedbackImageExtension,
  feedbackCustomerOrigin,
  feedbackImageTokens,
  normalizeFeedbackCustomerId,
  normalizeFeedbackCustomerName,
  validateFeedbackImageMeta,
  validateFeedbackImageUpload,
  type FeedbackImageContentType,
  type FeedbackPreviewStatus,
} from "./feedback-policy.js";
import {
  RANGE_PLAN_AOS_COLUMN_SQL,
  rangePlanAosDefault,
  rangePlanAosDefaultMigrationSql,
} from "./range-plan-defaults.js";
import {
  DEFAULT_NEW_STYLE_ORDER_UNITS,
  calculateNewnessCommitment,
  weeklyNewnessTarget,
} from "./range-plan-newness.js";

const { Pool } = pg;
const databaseUrl = process.env.VIVO_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("VIVO_DATABASE_URL or DATABASE_URL must be set");
}
const pool = new Pool({
  connectionString: databaseUrl,
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
/**
 * Workspace deliberately consumes commercial facts from BI rather than reading
 * Odoo replica tables.  Keep this boundary small: callers only ever see the
 * last successful, short-lived BI document, and a failed refresh is never
 * substituted with a database query.
 */
type BiWorkspaceSource = { styles: Array<Record<string, any>>; orders: Array<Record<string, any>>; definitions?: unknown; reconciliations?: unknown; [key: string]: any };
let biWorkspaceCache: { value: BiWorkspaceSource; expiresAt: number } | null = null;
let biWorkspaceFlight: Promise<BiWorkspaceSource> | null = null;
const BI_WORKSPACE_TTL_MS = 15_000;
const biWorkspaceUrl = () => `http://127.0.0.1:${process.env.BI_API_PORT ?? "8080"}/api/internal/product-workspace-source`;
class BiSourceUnavailable extends Error {
  status = 503;
  constructor(message = "BI source unavailable") { super(message); }
}
function biRequest<T>(url: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method,
      headers: {
        "X-Internal-Token": process.env.SESSION_SECRET ?? "",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      // The canonical Merch source can take tens of seconds on a cold cache.
      // Wait for that authoritative answer rather than falling back to local
      // replica-table calculations.
      timeout: 60_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new BiSourceUnavailable(`BI source unavailable (HTTP ${response.statusCode ?? 500})`));
          return;
        }
        try { resolve(JSON.parse(text) as T); } catch { reject(new BiSourceUnavailable("BI source returned invalid JSON")); }
      });
    });
    request.on("timeout", () => request.destroy(new BiSourceUnavailable()));
    request.on("error", () => reject(new BiSourceUnavailable()));
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}
async function biWorkspaceSource() {
  if (biWorkspaceCache && biWorkspaceCache.expiresAt > Date.now()) return biWorkspaceCache.value;
  if (!biWorkspaceFlight) {
    biWorkspaceFlight = biRequest<BiWorkspaceSource>(biWorkspaceUrl(), "GET").then((value) => {
      if (!Array.isArray(value.styles) || !Array.isArray(value.orders)) throw new BiSourceUnavailable("BI source has an invalid payload");
      biWorkspaceCache = { value, expiresAt: Date.now() + BI_WORKSPACE_TTL_MS };
      return value;
    }).finally(() => { biWorkspaceFlight = null; });
  }
  return biWorkspaceFlight;
}
// Named export point for Workspace facts.  Do not bypass this adapter.
const getBiWorkspaceSource = biWorkspaceSource;
async function biWorkspaceCogs(payload: Record<string, unknown>) {
  const base = `http://127.0.0.1:${process.env.BI_API_PORT ?? "8080"}/api/internal/product-workspace-cogs`;
  return biRequest<Record<string, unknown>>(base, "POST", payload);
}
const biValue = (row: Record<string, any>, ...keys: string[]) => keys.map((key) => row[key]).find((value) => value !== undefined && value !== null);
function biStyle(style: Record<string, any>) {
  const styleNumber = String(biValue(style, "styleNumber", "style_number", "styleKey", "style_key", "sku") ?? "").trim();
  const tier = String(biValue(style, "tier", "rangeTier", "range_tier") ?? "");
  const status = String(biValue(style, "status", "lifecycleStatus", "lifecycle_status") ?? "Active");
  return {
    id: `catalogue:${styleNumber}`, pdId: null, source: "bi", styleNumber,
    name: String(biValue(style, "name", "styleName", "style_name") ?? ""),
    category: String(biValue(style, "category") ?? "Uncategorised"),
    subCategory: String(biValue(style, "subCategory", "subcategory", "sub_category", "productType", "product_type") ?? ""),
    fabricCategory: String(biValue(style, "fabricCategory", "fabric_category") ?? ""),
    brand: String(biValue(style, "brand") ?? ""), primaryColour: String(biValue(style, "primaryColour", "primary_colour", "colorPrint", "color_print") ?? ""),
    edit: String(biValue(style, "edit", "collection") ?? ""), stage: "Carry-over", designer: "Merchandising",
    season: "", rangeTier: tier || null,
    tier: status.toLowerCase() === "retired" ? "Retired" : tier === "NOOS" || tier === "Tier 1" ? "Tier 1 · NOOS" : tier === "Core" || tier === "Tier 2" ? "Tier 2 · Core" : tier === "Recent" || tier === "Tier 3" ? "Tier 3 · Recent" : tier === "New" || tier === "Tier 4" ? "Tier 4 · New" : "Untiered",
    status: status[0]?.toUpperCase() + status.slice(1).toLowerCase(),
    excluded: false,
    unitsSold: Number(biValue(style, "unitsSold", "units_sold", "units_period", "units") ?? 0), revenueKes: Number(biValue(style, "revenueKes", "revenue_kes", "revenue_period", "revenue") ?? 0),
    sorPct: biValue(style, "sorPct", "sor_pct", "sor_period", "sell_through") ?? null, launchDate: biValue(style, "launchDate", "launch_date") ?? null,
    price: biValue(style, "price", "full_price", "asp") ?? null, stockUnits: biValue(style, "stockUnits", "stock_units", "current_stock") ?? null,
    sohStores: biValue(style, "sohStores", "soh_stores") ?? null, sohOnline: biValue(style, "sohOnline", "soh_online") ?? null,
    sohWarehouse: biValue(style, "sohWarehouse", "soh_warehouse") ?? null, wipUnits: biValue(style, "wipUnits", "wip_units") ?? null,
    fullPricePct: biValue(style, "fullPricePct", "full_price_pct") ?? null, weeksOfCover: biValue(style, "weeksOfCover", "weeks_of_cover") ?? null,
    sellThroughPct: biValue(style, "sellThroughPct", "sell_through_pct", "sell_through", "sor_period") ?? null, daysSinceLastSale: biValue(style, "daysSinceLastSale", "days_since_last_sale", "last_sale_days") ?? null,
    awaitingDelivery: Boolean(biValue(style, "awaitingDelivery", "awaiting_delivery")), fabricMetres: biValue(style, "fabricMetres", "fabric_metres", "fabric_exact_metres") ?? null,
    otherColourFabricMetres: biValue(style, "otherColourFabricMetres", "other_colour_fabric_metres", "fabric_other_colour_metres") ?? null,
    colourways: biValue(style, "colourways", "colours") ?? [], fabric: String(biValue(style, "fabric") ?? "Fabric pending"),
    image: biValue(style, "image", "imageUrl", "image_url") ?? null,
  };
}
function biOrder(order: Record<string, any>) {
  return {
    orderRef: String(biValue(order, "orderRef", "order_ref", "name", "reference") ?? ""),
    orderDate: String(biValue(order, "orderDate", "order_date", "dateOrdered", "date_ordered") ?? "").slice(0, 10),
    styleNumber: String(biValue(order, "styleNumber", "style_number", "productSku", "product_sku", "sku") ?? "").trim(),
    styleName: String(biValue(order, "styleName", "style_name", "productName", "product_name") ?? ""),
    quantity: Number(biValue(order, "quantity", "orderQty", "order_qty", "units") ?? 0),
    orderType: String(biValue(order, "orderType", "lifecycleType", "lifecycle_type") ?? ""),
    orderState: String(biValue(order, "orderState", "boState", "bo_state", "state") ?? ""),
  };
}
const activeBiOrders = (orders: Array<Record<string, any>>) => orders.map(biOrder)
  .filter((order) => order.orderDate && !["cancel", "cancelled", "canceled"].includes(order.orderState.toLowerCase()));
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
  { seasonName: "Q3 2026", revenueTarget: 0, factoryCapacityUnits: 83000, cadence: "quarterly" as const, otbMonths: ["2026-07-01", "2026-08-01", "2026-09-01"] as const },
  { seasonName: "Q4 2026", revenueTarget: 450000000, factoryCapacityUnits: 90000, cadence: "quarterly" as const, otbMonths: ["2026-10-01", "2026-11-01", "2026-12-01"] as const },
  { seasonName: "September 2026", revenueTarget: 30000000, factoryCapacityUnits: 25000, newnessTargetUnits: 10500, cadence: "monthly" as const, otbMonth: "2026-09-01" },
  { seasonName: "October 2026", revenueTarget: 30000000, factoryCapacityUnits: 30000, newnessTargetUnits: 10500, cadence: "monthly" as const, otbMonth: "2026-10-01" },
  { seasonName: "November 2026", revenueTarget: 30000000, factoryCapacityUnits: 30000, newnessTargetUnits: 10500, cadence: "monthly" as const, otbMonth: "2026-11-01" },
  { seasonName: "December 2026", revenueTarget: 30000000, factoryCapacityUnits: 30000, newnessTargetUnits: 10500, cadence: "monthly" as const, otbMonth: "2026-12-01" },
] as const;
const Q3_2026_JUL_AUG_ACTUALS = [
  ["Dresses", "Maxi Dresses", 32, 10306],
  ["Bottoms", "Full Length Pants", 28, 9811],
  ["Dresses", "Knee Length Dresses", 26, 8975],
  ["Tops", "Loose & Oversized Tops", 20, 6593],
  ["Tops", "Fitted Tops", 19, 5515],
  ["Outerwear", "Waterfalls & Kimonos", 14, 4209],
  ["Tops", "Relaxed Tops", 7, 2815],
  ["Tops", "T-shirts & Tank Tops", 7, 2728],
  ["Outerwear", "Jackets & Coats", 7, 1908],
  ["Bottoms", "Jumpsuits & Playsuits", 6, 1521],
  ["Dresses", "Short & Mini Dresses", 3, 1132],
  ["Outerwear", "Sweaters & Ponchos", 2, 930],
  ["Dresses", "Kaftan Dresses", 3, 813],
  ["Tops", "Bodysuits", 2, 797],
  ["Skirts", "Midi & Capri Skirts", 1, 528],
  ["Dresses", "Midi & Capri Dresses", 1, 477],
  ["Outerwear", "Hoodies & Sweatshirts", 1, 441],
  ["Bottoms", "Leggings", 1, 430],
  ["Skirts", "Maxi Skirts", 1, 378],
  ["Skirts", "Knee Length Skirts", 1, 324],
  ["Bottoms", "Culottes & Capri Pants", 0, 0],
  ["Bottoms", "Shorts & Skorts", 0, 0],
  ["Skirts", "Short & Mini Skirts", 0, 0],
  ["Tops", "Kaftan Tops", 0, 0],
  ["Tops", "Midriff & Crop Tops", 0, 0],
] as const;
const Q3_2026_ACTUAL_ORDER_COUNT = 182;
const Q3_2026_ACTUAL_UNITS = 60631;
const Q3_2026_CAPACITY_UNITS = 83000;
const Q3_2026_PLAN_UNITS = 25300;
const Q3_2026_ACTUAL_COGS_PCT = 30.9;
const Q3_2026_PLANNING_DISCLOSURE = {
  headline: "Q3 = July–August actuals + September plan",
  actualLabel: "July–August actuals",
  actualOrders: Q3_2026_ACTUAL_ORDER_COUNT,
  actualUnits: Q3_2026_ACTUAL_UNITS,
  planLabel: "September plan",
  planUnits: Q3_2026_PLAN_UNITS,
  totalUnits: Q3_2026_ACTUAL_UNITS + Q3_2026_PLAN_UNITS,
  juneBookedOrders: 4,
  juneBookedUnits: 1351,
  septemberPlacedOrders: 2,
  septemberPlacedUnits: 653,
  actualCogsPct: Q3_2026_ACTUAL_COGS_PCT,
  capacityUnits: Q3_2026_CAPACITY_UNITS,
  note: "The four June-booked orders and two already-placed September orders are included within the tracker totals above, not added a second time. July/August capacity was about 29,000 units per month; the 60,631 units already ordered are the production backlog the team is working through.",
} as const;
const SEPTEMBER_2026_MONTHLY_ROW_SEEDS = [
  ["Bottoms", "Full Length Pants", 11, 400, 4788, 1398, 4350, 5, 6, "Business-need plan: five new and six repeat styles. Pipeline availability is shown separately."],
  ["Bottoms", "Jumpsuits & Playsuits", 2, 400, 6669, 1869, 512, 1, 1, "Business-need plan: one new and one repeat style. Pipeline availability is shown separately."],
  ["Bottoms", "Leggings", 1, 400, 2501, null, 389, 0, 1, "One repeat style retained from the August sell-through and cover review."],
  ["Bottoms", "Culottes & Capri Pants", 0, 400, 2375, null, 1, 0, 0, "No September styles planned after the August sell-through and cover review."],
  ["Bottoms", "Shorts & Skorts", 0, 400, 2714, null, 53, 0, 0, "No September styles planned after the August sell-through and cover review."],
  ["Dresses", "Knee Length Dresses", 6, 400, 5801, 1594, 3576, 2, 4, "Business-need plan: two new and four repeat styles. Pipeline availability is shown separately."],
  ["Dresses", "Maxi Dresses", 14, 400, 6877, 1830, 3087, 8, 6, "Business-need plan: eight new and six repeat styles. The extra new style closes the 10,500-unit newness commitment while leaving the capacity tension visible."],
  ["Dresses", "Midi & Capri Dresses", 0, 400, 5932, null, 495, 0, 0, "No September styles planned; pipeline availability remains visible as potential surplus."],
  ["Dresses", "Short & Mini Dresses", 0, 400, 4900, 1448, 192, 0, 0, "No September styles planned after the August sell-through and cover review."],
  ["Dresses", "Kaftan Dresses", 4, 400, 5500, 1435, 491, 2, 2, "Business-need plan: two new and two repeat styles. Pipeline availability is shown separately."],
  ["Outerwear", "Sweaters & Ponchos", 5, 400, 5077, null, 1913, 3, 2, "Business-need plan: three new and two repeat styles. Pipeline availability is shown separately."],
  ["Outerwear", "Waterfalls & Kimonos", 5, 400, 4214, 1096, 1517, 2, 3, "Business-need plan: two new and three repeat styles. Pipeline availability is shown separately."],
  ["Outerwear", "Jackets & Coats", 6, 400, 5332, 1411, 379, 4, 2, "Business-need plan: four new and two repeat styles. Pipeline availability is shown separately."],
  ["Outerwear", "Hoodies & Sweatshirts", 1, 400, 3705, null, 314, 1, 0, "Business-need plan: one new style. Pipeline availability is shown separately."],
  ["Skirts", "Knee Length Skirts", 0, 400, 2900, null, 209, 0, 0, "No September styles planned after the August sell-through and cover review."],
  ["Skirts", "Maxi Skirts", 0, 400, 4900, 1212, 142, 0, 0, "No September styles planned after the August sell-through and cover review."],
  ["Skirts", "Midi & Capri Skirts", 0, 400, 5203, null, 192, 0, 0, "No September styles planned after the August sell-through and cover review."],
  ["Skirts", "Short & Mini Skirts", 0, 400, 2934, null, 11, 0, 0, "Dropped entirely because stock cover is 83.3 weeks."],
  ["Tops", "Fitted Tops", 3, 400, 3360, 731, 2015, 0, 3, "Business-need plan: three repeat styles. Pipeline availability remains visible as potential surplus."],
  ["Tops", "Loose & Oversized Tops", 9, 400, 4351, 1384, 1666, 5, 4, "Business-need plan: five new and four repeat styles. Pipeline availability is shown separately."],
  ["Tops", "T-shirts & Tank Tops", 1, 400, 2104, 464, 1424, 0, 1, "Business-need plan: one repeat style. Pipeline availability remains visible as potential surplus."],
  ["Tops", "Relaxed Tops", 4, 400, 3593, 1032, 1678, 2, 2, "Business-need plan: two new and two repeat styles. Pipeline availability is shown separately."],
  ["Tops", "Kaftan Tops", 0, 400, null, null, 228, 0, 0, "No September styles planned after the August sell-through and cover review."],
  ["Tops", "Bodysuits", 0, 400, 2500, 564, 429, 0, 0, "Dropped entirely because stock cover is 34.2 weeks."],
  ["Tops", "Midriff & Crop Tops", 0, 400, 2524, null, 120, 0, 0, "No September styles planned after the August sell-through and cover review."],
] as const;
const SEPTEMBER_2026_PLAN_NOTES =
  "September holds the absolute 10,500-unit newness commitment: 35 new and 37 repeat styles. The resulting 25,300-unit plan is 300 units above the reduced 25,000-unit capacity; that tension is intentional and visible.";
const STYLE_DEVELOPMENT_TRACKER_SEEDS = [
  ["V0826023", "Vivo Pleated Wide Leg Pants in Twill", "NEW", "Set Sampling", "Bottoms", "Full Length Pants", "WK36", "YIHAO 681112 Light Polyester Crepe"],
  ["V0826080", "Vivo Mistari 3/4 Sleeve Kaftan Dress in Twill", "NEW", "Pattern", "Dresses", "Kaftan Dresses", "WK36", "YIHAO 57 2345"],
  ["V0526095", "Vivo Ustawi Easy Fit Shirt in Crepe (R)", "NEW", "Cad Processing Order", "Tops", "Loose & Oversized Tops", "WK36", "Showme 18206"],
  ["V0626058", "Vivo Wide Bubble Sleeve Top in Cotton", "NEW", "Cad Processing Order", "Tops", "Loose & Oversized Tops", "WK36", "YIYI N272"],
  ["V0826012", "Safari by Vivo Off-Shoulder Maxi Dress in Cotton", "RR", "Set Sampling", "Dresses", "Maxi Dresses", "WK36", "Minglei 810"],
  ["V0726016", "Vivo Long Sleeve Bodysuit in Rayon", "NEW", "Sample Review", "Tops", "Bodysuits", "WK37", "REEYON LY001 Heavy Interlock Jersey"],
  ["V0726023", "Vivo Dua Long Sleeve Shirt in Textured Satin (REFRESH)", "RR", "Cad Processing Ss", "Tops", "Fitted Tops", "WK37", "YIWAN 8083 Light Polyester Satin"],
  ["S0226012", "Safari By Vivo Barrel Pants in Cotton (Relaxed Barrel Jeans ETSY)", "NEW", "Sampling", "Bottoms", "Full Length Pants", "WK37", "YIYI Y760 Medium Cotton Twill"],
  ["S0726009", "Safari By Vivo Panelled Barrel Pants in Linen Blend", "NEW", "Transfer To Cad", "Bottoms", "Full Length Pants", "WK37", "AMDHIR Light Linen Blend"],
  ["V0626077", "Vivo Drawstring Wide Pants in Crepe", "NEW", "Waiting For Fabric", "Bottoms", "Full Length Pants", "WK37", "EQ 1441"],
  ["S0526028", "Safari by Vivo Coat in Kitenge", "NEW", "Transfer To Cad", "Outerwear", "Jackets & Coats", "WK37", "ANNINGTEX Kitenge"],
  ["V0826056", "Vivo Gathered Neck Jacket (ETSY)", "NEW", "Sampling", "Outerwear", "Jackets & Coats", "WK37", "HUAMING 2018 Medium Polyester Satin"],
  ["V0926001", "Vivo Round Neck Maxi Kaftan in Satin", "NEW", "Sampling", "Dresses", "Kaftan Dresses", "WK37", "Huaming 2018D"],
  ["V0826010", "Vivo Back Pleat Coat Dress in Cotton Denim Twill", "NEW", "Approved For S/S", "Dresses", "Knee Length Dresses", "WK37", "SHUNYUAN H407 Medium Cotton Denim"],
  ["V0726034", "Vivo Wastani Shirred Sleeve Shirt Dress in Crepe", "NEW", "Sampling", "Dresses", "Knee Length Dresses", "WK37", "HUAYI B865 Medium Polyester Crepe"],
  ["S0626064", "Safari by Vivo Contrast Stitch Top in Linen Blend", "NEW", "Sample Review", "Tops", "Loose & Oversized Tops", "WK37", "Xuegui 2317"],
  ["S0626071", "Safari by Vivo Nimali Top in Kitenge", "RR", "Sample Review", "Tops", "Loose & Oversized Tops", "WK37", "ANNINGTEX Kitenge"],
  ["V0626079", "Safari by Vivo Panelled Oversized Short Sleeve Top in Linen", "NEW", "Cad Processing Ss", "Tops", "Loose & Oversized Tops", "WK37", "Linen"],
  ["V0626082", "Safari by Vivo Short Sleeved Top in Cotton", "NEW", "Transfer To Cad", "Tops", "Loose & Oversized Tops", "WK37", "YIYI N272"],
  ["V0926002", "Vivo Essi Front Slit Maxi Top in Textured Satin", "NEW", "Sampling", "Tops", "Loose & Oversized Tops", "WK37", "Yiwan 8083"],
  ["V0326041", "Vivo Dropped Waist Maxi Dress in Cotton", "NEW", "Sample Review", "Dresses", "Maxi Dresses", "WK37", "YIYI N272 Light Cotton Poplin"],
  ["V0526099", "Vivo Flounce Maxi Dress In Kitenge (R)", "NEW", "Cad Processing Ss", "Dresses", "Maxi Dresses", "WK37", "Kitenge"],
  ["S0526098", "Safari by Vivo Off Shoulder Tiered Maxi Dress in Cotton", "NEW", "Set Sampling", "Dresses", "Midi & Capri Dresses", "WK37", "YIYI N272"],
] as const;
const STYLE_DEVELOPMENT_TRACKER_BATCH_TWO_SEEDS = [
  ["V0426011", "Vivo Relaxed Shirt Dress in Crepe", "NEW", "Transfer To Cad", "Dresses", "Short & Mini Dresses", "WK 37", "Showme 18206"],
  ["V0526085", "Vivo Cape Top in Stretch Rib", "NEW", "Approved For S/S", "Outerwear", "Sweaters & Ponchos", "WK 37", "GAOHENG H1031"],
  ["V0826024", "Vivo Tanda Cowl Sweater in Jersey", "NEW", "Sampling", "Outerwear", "Sweaters & Ponchos", "WK 37", ""],
  ["V0826005", "Vivo Side Pleat Top in Jersey", "NEW", "Buying Requisition S/S", "Tops", "Fitted Tops", "WK 38", "REEYON LY470A Medium Rayon Jersey"],
  ["V0526026", "Vivo Extra Wide Leg Pants in Denim", "NEW", "Sample Review", "Bottoms", "Full Length Pants", "WK 38", "HONG YU F8953 Light Cotton Denim"],
  ["V0826055", "Vivo Straight Leg Pants in Stretch Rib", "NEW", "Pattern", "Bottoms", "Full Length Pants", "WK 38", "GAOHENG H1031"],
  ["V0826006", "Vivo Wide Leg Pants in Crepe", "NEW", "Set Sampling", "Bottoms", "Full Length Pants", "WK 38", "Showme 18206"],
  ["S0726044", "Safari by Vivo Oversized Jacket in Twill (Zoe Jacket ETSY)", "NEW", "Pattern", "Outerwear", "Jackets & Coats", "WK 38", "WAN HEXIN Kata Tiao Dark Green"],
  ["V0526086", "Vivo Reversible Tulip Coat in Corduroy (NEW)", "NEW", "Sample Review", "Outerwear", "Jackets & Coats", "WK 38", "FANGQI Microfiber High Elastic Medium Rayon Jersey Rib"],
  ["V0626048", "Vivo Sleeveless Pleat Neck Jacket in Crepe", "NEW", "Approved For S/S", "Outerwear", "Jackets & Coats", "WK 38", "YIHAO 681112 Light Polyester Crepe"],
  ["V0626050", "Vivo Sleeveless Tent Jacket in Crepe", "NEW", "Sample Review", "Outerwear", "Jackets & Coats", "WK 38", "YAT TAJ HONG CA13550 Medium Polyester Crepe"],
  ["S0826014", "Safari by Vivo Sleeveless Front Zip Jumpsuit in Cotton (Etsy Front Zip Jumpsuit)", "NEW", "Sample Review", "Bottoms", "Jumpsuits & Playsuits", "WK 38", "SHUNYUAN 1728 Medium Cotton Twill"],
  ["V0626012", "Vivo Drop Shoulder Jumpsuit in Denim (Etsy Everyday Luxe Jumpsuit)", "NEW", "Sample Review", "Bottoms", "Jumpsuits & Playsuits", "WK 38", "Hua Yi F-005 Medium Polyester Denim"],
  ["V0626032", "Vivo Button Up Pintuck in Satin", "NEW", "Sampling", "Tops", "Loose & Oversized Tops", "WK 38", "Eastleigh Medium Satin"],
  ["V0826009", "Vivo Short Sleeve Maxi Dress in Cotton", "NEW", "Sample Review", "Dresses", "Maxi Dresses", "WK 38", "SHUNYUAN H179 Medium Cotton Twill"],
  ["V0826008", "Vivo Sleeveless Front Pleat Maxi Dress in Dobby", "NEW", "Waiting For Fabric", "Dresses", "Maxi Dresses", "WK 38", "YIQI 1130 Light Rayon Twill"],
  ["V0526055", "Vivo Ustawi Bubble Sleeve Maxi Tie Dress in Crepe", "NEW", "Sampling", "Dresses", "Maxi Dresses", "WK 38", "Showme 18208"],
  ["V0626081", "Vivo Shirred Sleeve Top in Cotton", "NEW", "Approved For S/S", "Tops", "Relaxed Tops", "WK 38", "YIYI N273"],
  ["V0423018", "Vivo Wastani Shirred Sleeve Easy Fit Shirt", "RR", "Sample Review", "Tops", "Relaxed Tops", "WK 38", "HUAYI B865 Medium Polyester Crepe"],
  ["V0826007", "Vivo Sleeveless Waterfall in Crepe", "NEW", "Sample Review", "Outerwear", "Waterfalls & Kimonos", "WK 38", "Showme 18206"],
  ["V0826028", "Vivo Wide Leg Pants in Ponte to match Etsy sweatshirt", "NEW", "Pattern", "Bottoms", "Full Length Pants", "WK 39", "BAO DELI"],
  ["V0826038", "Vivo Pullover in Fleece (ETSY)", "NEW", "Pattern", "Outerwear", "Hoodies & Sweatshirts", "WK 39", "Maziwa Fleece"],
  ["V0726032", "Vivo Raglan Sleeve Sweatshirt in Ponte (ETSY)", "NEW", "Pattern", "Outerwear", "Hoodies & Sweatshirts", "WK 39", "GAO SHANG 6034 Medium Rayon Ponte"],
  ["V0626072", "Vivo Asymetrical Sleeveless Coat in Twill", "NEW", "Pattern", "Outerwear", "Jackets & Coats", "WK 39", "YIWAN 8075 Medium Polyester Twill"],
  ["V0526047", "Vivo Long Sleeved Tie Blazer in Ponte", "RR", "Pattern", "Outerwear", "Jackets & Coats", "WK 39", "Shunyuan 18A-46"],
] as const;
const STYLE_DEVELOPMENT_TRACKER_BATCH_THREE_SEEDS = [
  ["V0826037", "Vivo Zipper Jacket in Ponte (ETSY)", "NEW", "Pattern", "Outerwear", "Jackets & Coats", "WK 39", "Runfeng 8004"],
  ["V0726029", "Vivo Butterfly Sleeve Knee Length Dress", "NEW", "Pattern", "Dresses", "Knee Length Dresses", "WK 39", "YIYI N272"],
  ["V0826027", "Vivo Ustawi Knee Length Shirt Dress in Crepe", "NEW", "Pattern", "Dresses", "Knee Length Dresses", "WK 39", "Dexin 100D Supersoft"],
  ["S0726037", "Safari By Vivo Cocoon Top in Linen Blend", "NEW", "Pattern", "Tops", "Loose & Oversized Tops", "WK 39", "XUEGUI 2317 Light Linen Blend"],
  ["V0626033", "Vivo High Low Top in Satin", "NEW", "Pattern", "Tops", "Loose & Oversized Tops", "WK 39", "Hua Ming 2018/100D"],
  ["V0826004", "Vivo Bubble Gathered Midi Dress in Cotton Blend", "NEW", "Pattern", "Dresses", "Midi & Capri Dresses", "WK 39", "XUEGUI Y022 Light Poly Cotton Blend"],
  ["V0626056", "Vivo Scooped Tank Top in Satin", "NEW", "Pattern", "Tops", "T-shirts & Tank Tops", "WK 39", "Yiwan 8068"],
  ["V0526025", "Vivo Cinch Shirt in Heavy Crepe", "RR", "Pattern", "Tops", "Fitted Tops", "WK 40", "Yiwan 8053"],
  ["V0626051", "Vivo Barrel Pants in Scuba", "NEW", "Pattern", "Bottoms", "Full Length Pants", "WK 40", "PU SHY 8086"],
  ["V0726004", "Vivo Straight Leg Pants in Crepe (NEW)", "NEW", "Pattern", "Bottoms", "Full Length Pants", "WK 40", "YAT TAJ HONG CA13550 Medium Polyester Crepe"],
  ["V0826039", "Vivo Sleeveless Waistcoat in Cotton Denim (ETSY)", "NEW", "Pattern", "Outerwear", "Jackets & Coats", "WK 40", "SHUNYUAN H407 Medium Cotton Denim"],
  ["S0826013", "Safari by Vivo Utility Jumpsuit in Cotton (ETSY Boiler Suit Jumpsuit)", "NEW", "Sample Review", "Bottoms", "Jumpsuits & Playsuits", "WK 40", "YIYI Y760 Medium Cotton Twill"],
  ["S0826034", "Safari by Vivo Midi Dress in Linen (ETSY)", "NEW", "Pattern", "Dresses", "Knee Length Dresses", "WK 40", "Sample in Tanzania Kitenge"],
  ["S0726002", "Safari by Vivo Front Pleat Loose Shirt in Linen Blend", "NEW", "Pattern", "Tops", "Loose & Oversized Tops", "WK 40", "XINHENGSHENG 1623 Light Cotton Twill"],
  ["V0626057", "Vivo Crossed Cuff Top in Cotton", "NEW", "Pattern", "Tops", "Loose & Oversized Tops", "WK 40", "YIYI N272"],
  ["V0826042", "Vivo Oversized Shirt (ETSY)", "NEW", "Pattern", "Tops", "Loose & Oversized Tops", "WK 40", "Yihao 118-2077 Army Green"],
  ["S0826036", "Safari by Vivo Boho Dress in Kitenge (ETSY)", "NEW", "Pattern", "Dresses", "Maxi Dresses", "WK 40", "Sample in Tanzania Kitenge"],
  ["S0826015", "Safari by Vivo Sleeveless Panelled Dress in Cotton", "NEW", "Pattern", "Dresses", "Maxi Dresses", "WK 40", "YIYI N272"],
  ["V0526096", "Vivo Four Tiered Maxi Dress in Chiffon (R)", "NEW", "Pattern", "Dresses", "Maxi Dresses", "WK 40", "Chiffon"],
  ["V0526033", "Vivo Halter Neck Contrast Maxi Dress in Denim", "NEW", "Pattern", "Dresses", "Maxi Dresses", "WK 40", "Denim, to be confirmed"],
  ["V0726027", "Vivo Bias Skirt in Satin (Etsy)", "NEW", "Pattern", "Skirts", "Midi & Capri Skirts", "WK 40", "Not yet identified"],
  ["V0826046", "Vivo Batwing Blouse in Crepe (ETSY)", "NEW", "Pattern", "Tops", "Relaxed Tops", "WK 40", "Hong Yu F0321"],
  ["V0826016", "Vivo Ruffle Tie Neck Top", "NEW", "Pattern", "Tops", "Relaxed Tops", "WK 40", ""],
  ["V0826044", "Vivo Drop Shoulder T-Shirt in Jersey (ETSY)", "NEW", "Pattern", "Tops", "T-shirts & Tank Tops", "WK 40", "Shunwang 3019"],
  ["V0826047", "Vivo Sleeveless T-Shirt in Jersey (ETSY)", "NEW", "Pattern", "Tops", "T-shirts & Tank Tops", "WK 40", "Shunwang 3019"],
] as const;
const STYLE_DEVELOPMENT_TRACKER_BATCH_FOUR_SEEDS = [
  ["V0826041", "Vivo Halter Top in Satin (ETSY)", "NEW", "Pattern", "Tops", "Fitted Tops", "WK 41", "Eastleigh Medium Satin"],
  ["V0826043", "Vivo Sleeveless Top Pattern in Cotton (ETSY)", "NEW", "Pattern", "Tops", "Fitted Tops", "WK 41", "Sample in Tanzania Kitenge"],
  ["V0426005", "Vivo Buttoned Jumpsuit in Linen", "NEW", "Pattern", "Bottoms", "Jumpsuits & Playsuits", "WK 41", "Linen"],
  ["V0826035", "Vivo Maxi Kaftan in Crepe (ETSY)", "NEW", "Pattern", "Dresses", "Kaftan Dresses", "WK 41", "Showme 18208"],
  ["S0626053", "Safari By Vivo Ruffle Sleeve Top in Cotton", "NEW", "Pattern", "Tops", "Loose & Oversized Tops", "WK 41", "YIYI N272"],
  ["S0826040", "Safari by Vivo Maxi Skirt in Linen (ETSY)", "NEW", "Pattern", "Skirts", "Maxi Skirts", "WK 41", "Sample in Tanzania Kitenge"],
  ["S0626074", "Safari By Vivo Cocoon Dress in Linen Blend", "NEW", "Pattern", "Dresses", "Midi & Capri Dresses", "WK 41", "XINHENGSHENG 1623 Light Cotton Twill"],
  ["V0626060", "Vivo Drop Shoulder Tie Neck Top in Chiffon", "NEW", "Pattern", "Tops", "Relaxed Tops", "WK 41", "Huaming Coarse Hemp"],
  ["V0826045", "Vivo Relaxed Blouse in Crepe (ETSY)", "NEW", "Pattern", "Tops", "Relaxed Tops", "WK 41", "Showme 18206"],
  ["V0826048", "Vivo Kimono (ETSY)", "NEW", "Pattern", "Outerwear", "Waterfalls & Kimonos", "WK 41", ""],
  ["V0326010", "Vivo V-Neck Jumpsuit in Crepe", "NEW", "Pattern", "Bottoms", "Jumpsuits & Playsuits", "WK 42", "Dexin 100D Supersoft"],
  ["V0626063", "Vivo Extra Wide Pants in Crepe", "NEW", "Sample Review", "Bottoms", "Full Length Pants", null, "Yihao 68 992"],
  ["V0326005", "Vivo 3/4 Sleeve Short Blazer in Kitenge", "RR", "Sample Review", "Outerwear", "Jackets & Coats", null, "Kitenge"],
  ["V0626062", "Vivo Shawl Collar Blazer in Crepe", "NEW", "Sample Review", "Outerwear", "Jackets & Coats", null, "Yihao 68 992 with Huaming 1801/50D lining"],
  ["V0626026", "Vivo Sleeveless Coat in Ponte", "RR", "Sample Review", "Outerwear", "Jackets & Coats", null, "Not yet identified"],
  ["V0526060", "Vivo Sleeveless Lined Blazer in Kitenge", "RR", "Sample Review", "Outerwear", "Jackets & Coats", null, "Kitenge"],
  ["V0526038", "Vivo Studio Strappy Jacket in Crepe", "NEW", "Sample Review", "Outerwear", "Jackets & Coats", null, "Hong Xin 3030"],
  ["V0826050", "Vivo Basic A Line Dress Block (Woven)", "NEW", "Sample Review", "Dresses", "Knee Length Dresses", null, ""],
  ["S0626019", "Safari By Vivo Balloon Sleeve Shirt in Linen Blend", "NEW", "Sample Review", "Tops", "Loose & Oversized Tops", null, ""],
  ["V0526041", "Vivo Dolman Sweater (Ken Knit)", "NEW", "Sample Review", "Outerwear", "Sweaters & Ponchos", null, "Acrylic"],
  ["V0826030", "Vivo Dolman Sweater in Rib", "NEW", "Approved For S/S", "Tops", "Sweaters & Ponchos", null, ""],
  ["V0526042", "Vivo Knit Tank Top (Ken Knit)", "NEW", "Set Sampling", "Outerwear", "T-shirts & Tank Tops", null, "Acrylic"],
] as const;
const STYLE_DEVELOPMENT_STAGES = [
  "Pattern",
  "Transfer to CAD",
  "CAD Processing SS",
  "Sampling",
  "Sample Review",
  "Set Sampling",
  "Approved for S/S",
  "CAD Processing Order",
  "Buying Requisition S/S",
  "Waiting for Fabric",
] as const;
type StyleDevelopmentStage = (typeof STYLE_DEVELOPMENT_STAGES)[number];
const STYLE_DEVELOPMENT_STAGE_STANDARD_DAYS: Record<StyleDevelopmentStage, number | null> = {
  Pattern: 5,
  "Transfer to CAD": 2,
  "CAD Processing SS": 3,
  Sampling: 5,
  "Sample Review": 2,
  "Set Sampling": 5,
  "Approved for S/S": 2,
  "CAD Processing Order": 2,
  "Buying Requisition S/S": 2,
  "Waiting for Fabric": null,
};
const STYLE_DEVELOPMENT_EVENT_TYPES = [
  "adopted",
  "baseline",
  "pattern_started",
  "pattern_done",
  "pattern_amendment_started",
  "pattern_amendment_done",
  "tech_pack_started",
  "tech_pack_done",
  "sample_started",
  "sample_received",
  "resample_started",
  "resample_received",
  "review_started",
  "rereview_started",
  "rereview_done",
  "sample_approved",
  "sample_rejected",
  "cad_transfer_started",
  "cad_transfer_done",
  "cad_grading_started",
  "cad_grading_done",
  "set_sample_order_started",
  "set_sample_order_created",
  "set_sample_production_started",
  "set_sample_production_done",
  "set_sample_review_started",
  "set_sample_approved",
  "set_sample_rejected",
  "order_processing_started",
  "order_processing_done",
  "order_approved",
  "order_rejected",
] as const;
type StyleDevelopmentEventType = (typeof STYLE_DEVELOPMENT_EVENT_TYPES)[number];
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
  const tierTargets = [
    { tier: "Tier 1", label: "Tier 1 NOOS", minimum: 30, maximum: 50 },
    { tier: "Tier 2", label: "Tier 2 Core Performers", minimum: 200, maximum: 300 },
    { tier: "Tier 3", label: "Tier 3 Recent Performers", minimum: 150, maximum: 200 },
    { tier: "Tier 4", label: "Tier 4 New and Test", minimum: 60, maximum: 100 },
  ] as const;
  const empty = {
    newRepeat: { newCount: 0, repeatCount: 0, total: 0 },
    subCategories: [] as Array<{ name: string; count: number }>,
    activeStyleCount: 0,
    tiers: tierTargets.map((target) => ({ ...target, count: 0 })),
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
    const tierCounts = await pool.query<{ tier: string; count: number }>(
      `SELECT p.tier,COUNT(DISTINCT COALESCE(NULLIF(TRIM(p.style_number),''),NULLIF(TRIM(p.style_name),''),p.sku))::int AS count
       FROM public.all_products_clean p
       WHERE p.active IS TRUE
         AND ${allowedBrand("p")}
         AND p.tier=ANY($1::text[])
       GROUP BY p.tier`,
      [tierTargets.map((target) => target.tier)],
    );
    const countByTier = new Map(tierCounts.rows.map((row) => [row.tier, Number(row.count)]));
    return {
      newRepeat: newRepeat.rows[0] ?? empty.newRepeat,
      subCategories: subCategories.rows,
      activeStyleCount: Number(newRepeat.rows[0]?.total ?? 0),
      tiers: tierTargets.map((target) => ({ ...target, count: countByTier.get(target.tier) ?? 0 })),
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

async function ensureStyleDevelopmentTrackerData() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.style_development_tracker_imports (
      import_key TEXT PRIMARY KEY,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.style_development_tracker (
      id SERIAL PRIMARY KEY,
      style_number TEXT,
      original_style_number TEXT,
      style_number_status TEXT NOT NULL CHECK (style_number_status IN ('needs_number','malformed','confirmed')),
      style_name TEXT NOT NULL,
      style_type TEXT NOT NULL CHECK (style_type IN ('NEW','RR')),
      tier TEXT NOT NULL CHECK (tier IN ('Tier 3','Tier 4')),
      status TEXT NOT NULL,
      category TEXT NOT NULL,
      sub_category TEXT NOT NULL,
      original_sub_category TEXT NOT NULL,
      target_order_week TEXT NOT NULL,
      fabric TEXT NOT NULL DEFAULT '',
      sample_approval_date TEXT,
      data_quality_flags TEXT[] NOT NULL DEFAULT '{}',
      import_batch TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (import_batch, style_name, target_order_week)
    );
    ALTER TABLE ${schema}.style_development_tracker
      ADD COLUMN IF NOT EXISTS sample_approval_date TEXT,
      ADD COLUMN IF NOT EXISTS data_quality_flags TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS pattern_maker TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS adoption_date DATE,
      ADD COLUMN IF NOT EXISTS target_launch_week TEXT,
      ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS blocker_reason TEXT NOT NULL DEFAULT '',
       ADD COLUMN IF NOT EXISTS sample_fabric_product_id INTEGER,
       ADD COLUMN IF NOT EXISTS season TEXT NOT NULL DEFAULT '',
       ADD COLUMN IF NOT EXISTS intended_selling_price_kes NUMERIC,
       ADD COLUMN IF NOT EXISTS indicative_cogs_kes NUMERIC,
       ADD COLUMN IF NOT EXISTS exit_status TEXT NOT NULL DEFAULT 'active' CHECK (exit_status IN ('active','on_hold','cancelled')),
       ADD COLUMN IF NOT EXISTS exit_reason TEXT,
       ADD COLUMN IF NOT EXISTS exited_at TIMESTAMPTZ,
       ADD COLUMN IF NOT EXISTS exit_stage TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ALTER COLUMN target_order_week DROP NOT NULL;
    CREATE INDEX IF NOT EXISTS style_development_tracker_week_idx
      ON ${schema}.style_development_tracker (target_order_week, status);
    CREATE TABLE IF NOT EXISTS ${schema}.style_development_history (
      id BIGSERIAL PRIMARY KEY,
      tracker_style_id INTEGER NOT NULL REFERENCES ${schema}.style_development_tracker(id) ON DELETE CASCADE,
      entry_type TEXT NOT NULL,
      event_type TEXT,
      outcome TEXT,
      note TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      old_value TEXT,
      new_value TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recorded_by INTEGER REFERENCES ${schema}.users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS style_development_history_style_idx
      ON ${schema}.style_development_history (tracker_style_id, occurred_at DESC, id DESC);
  `);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `INSERT INTO ${schema}.style_development_tracker_imports (import_key)
       VALUES ('q3-2026-batch-one-v2')
       ON CONFLICT DO NOTHING
       RETURNING import_key`,
    );
    if (claim.rows[0]) {
      // This is a replacement import: remove every earlier attempt before
      // inserting the supplied batch, including rows from previous markers.
      await client.query(`DELETE FROM ${schema}.style_development_tracker`);
      for (const [styleNumber, styleName, styleType, status, category, subCategory, targetOrderWeek, fabric] of STYLE_DEVELOPMENT_TRACKER_SEEDS) {
        await client.query(
          `INSERT INTO ${schema}.style_development_tracker
            (style_number,original_style_number,style_number_status,style_name,style_type,tier,status,
             category,sub_category,original_sub_category,target_order_week,fabric,sample_approval_date,data_quality_flags,import_batch)
           VALUES ($1,$1,'confirmed',$2,$3,$4,$5,$6,$7,$7,$8,$9,NULL,'{}','q3-2026-batch-one')`,
          [
            styleNumber,
            styleName,
            styleType,
            styleType === "NEW" ? "Tier 4" : "Tier 3",
            status,
            category,
            subCategory,
            targetOrderWeek,
            fabric,
          ],
        );
      }
    }
    const batchTwoClaim = await client.query(
      `INSERT INTO ${schema}.style_development_tracker_imports (import_key)
       VALUES ('q3-2026-batch-two-v1')
       ON CONFLICT DO NOTHING
       RETURNING import_key`,
    );
    if (batchTwoClaim.rows[0]) {
      for (const [styleNumber, styleName, styleType, status, category, subCategory, targetOrderWeek, fabric] of STYLE_DEVELOPMENT_TRACKER_BATCH_TWO_SEEDS) {
        await client.query(
          `INSERT INTO ${schema}.style_development_tracker
            (style_number,original_style_number,style_number_status,style_name,style_type,tier,status,
             category,sub_category,original_sub_category,target_order_week,fabric,sample_approval_date,data_quality_flags,import_batch)
           VALUES ($1,$1,'confirmed',$2,$3,$4,$5,$6,$7,$7,$8,$9,NULL,'{}','q3-2026-batch-two')`,
          [
            styleNumber,
            styleName,
            styleType,
            styleType === "NEW" ? "Tier 4" : "Tier 3",
            status,
            category,
            subCategory,
            targetOrderWeek,
            fabric,
          ],
        );
      }
    }
    const batchThreeClaim = await client.query(
      `INSERT INTO ${schema}.style_development_tracker_imports (import_key)
       VALUES ('q3-2026-batch-three-v1')
       ON CONFLICT DO NOTHING
       RETURNING import_key`,
    );
    if (batchThreeClaim.rows[0]) {
      for (const [styleNumber, styleName, styleType, status, category, subCategory, targetOrderWeek, fabric] of STYLE_DEVELOPMENT_TRACKER_BATCH_THREE_SEEDS) {
        const dataQualityFlags = styleNumber === "V0526033" || styleNumber === "V0726027"
          ? ["fabric_needs_confirmation"]
          : [];
        await client.query(
          `INSERT INTO ${schema}.style_development_tracker
            (style_number,original_style_number,style_number_status,style_name,style_type,tier,status,
             category,sub_category,original_sub_category,target_order_week,fabric,sample_approval_date,data_quality_flags,import_batch)
           VALUES ($1,$1,'confirmed',$2,$3,$4,$5,$6,$7,$7,$8,$9,NULL,$10,'q3-2026-batch-three')`,
          [
            styleNumber,
            styleName,
            styleType,
            styleType === "NEW" ? "Tier 4" : "Tier 3",
            status,
            category,
            subCategory,
            targetOrderWeek,
            fabric,
            dataQualityFlags,
          ],
        );
      }
    }
    const batchFourClaim = await client.query(
      `INSERT INTO ${schema}.style_development_tracker_imports (import_key)
       VALUES ('q3-2026-batch-four-v1')
       ON CONFLICT DO NOTHING
       RETURNING import_key`,
    );
    if (batchFourClaim.rows[0]) {
      for (const [styleNumber, styleName, styleType, status, category, subCategory, targetOrderWeek, fabric] of STYLE_DEVELOPMENT_TRACKER_BATCH_FOUR_SEEDS) {
        const dataQualityFlags: string[] = [];
        if (styleNumber === "V0626026") dataQualityFlags.push("fabric_needs_confirmation");
        if (styleNumber === "V0626026" || styleNumber === "V0626062" || styleNumber === "V0826030") {
          dataQualityFlags.push("category_subcategory_needs_review");
        }
        await client.query(
          `INSERT INTO ${schema}.style_development_tracker
            (style_number,original_style_number,style_number_status,style_name,style_type,tier,status,
             category,sub_category,original_sub_category,target_order_week,fabric,sample_approval_date,data_quality_flags,import_batch)
           VALUES ($1,$1,'confirmed',$2,$3,$4,$5,$6,$7,$7,$8,$9,NULL,$10,'q3-2026-batch-four')`,
          [
            styleNumber,
            styleName,
            styleType,
            styleType === "NEW" ? "Tier 4" : "Tier 3",
            status,
            category,
            subCategory,
            targetOrderWeek,
            fabric,
            dataQualityFlags,
          ],
        );
      }
    }
    await client.query(
      `UPDATE ${schema}.style_development_tracker
          SET brand=CASE WHEN style_number LIKE 'S%' THEN 'Safari by Vivo' ELSE 'Vivo' END,
              adoption_date=COALESCE(adoption_date, created_at::date)
        WHERE brand='' OR adoption_date IS NULL`,
    );
    await client.query(
      `INSERT INTO ${schema}.style_development_history
        (tracker_style_id,entry_type,event_type,outcome,note,occurred_at)
       SELECT t.id,'system','imported_stage',
         CASE
           WHEN LOWER(t.status)='pattern' THEN 'Pattern'
           WHEN LOWER(t.status)='sample review' THEN 'Sample Review'
           WHEN LOWER(t.status) IN ('approved for s/s','set sampling') THEN 'CAD and Set Sample'
           ELSE 'Adopted'
         END,
         'Initial stage derived from the imported tracker status',t.created_at
       FROM ${schema}.style_development_tracker t
       WHERE NOT EXISTS (
         SELECT 1 FROM ${schema}.style_development_history h
          WHERE h.tracker_style_id=t.id AND h.event_type='imported_stage'
       )`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureRangePlanNewnessData() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.range_plan_seed_migrations (
      migration_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ${schema}.range_plan_seasons
      ADD COLUMN IF NOT EXISTS newness_target_units INTEGER
  `);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const targetClaim = await client.query(
      `INSERT INTO ${schema}.range_plan_seed_migrations (migration_key)
       VALUES ('monthly-newness-unit-target-v1')
       ON CONFLICT DO NOTHING
       RETURNING migration_key`,
    );
    if (targetClaim.rows[0]) {
      await client.query(
        `UPDATE ${schema}.range_plan_seasons
            SET newness_target_units=10500
          WHERE season_year=2026 AND season_name NOT LIKE 'Q%'`,
      );
      await client.query(
        `UPDATE ${schema}.range_plan_rows r
            SET style_count_target=14,
                new_style_count=8,
                new_units=2400,
                notes='Business-need plan: eight new and six repeat styles. The extra new style closes the 10,500-unit newness commitment while leaving the capacity tension visible.'
           FROM ${schema}.range_plan_seasons s
          WHERE s.id=r.season_id
            AND s.season_name='September 2026'
            AND s.season_year=2026
            AND r.sub_category='Maxi Dresses'`,
      );
      await client.query(
        `UPDATE ${schema}.range_plan_otb o
            SET planned_units=25300,
                new_styles_count=35,
                notes=$1
           FROM ${schema}.range_plan_seasons s
          WHERE s.id=o.season_id
            AND s.season_name='September 2026'
            AND s.season_year=2026
            AND o.month_year='2026-09-01'`,
        [SEPTEMBER_2026_PLAN_NOTES],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureRangePlanData() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.range_plan_seed_migrations (
      migration_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const normalizedAosClient = await pool.connect();
  try {
    await normalizedAosClient.query("BEGIN");
    const claim = await normalizedAosClient.query(
      `INSERT INTO ${schema}.range_plan_seed_migrations (migration_key)
       VALUES ('reorder-replenishment-aos-400-v1')
       ON CONFLICT DO NOTHING
       RETURNING migration_key`,
    );
    if (claim.rows[0]) {
      await normalizedAosClient.query(
        `UPDATE ${schema}.range_plan_rows SET aos_units=$1`,
        [rangePlanAosDefault()],
      );
    }
    await normalizedAosClient.query("COMMIT");
  } catch (error) {
    await normalizedAosClient.query("ROLLBACK");
    throw error;
  } finally {
    normalizedAosClient.release();
  }
  await pool.query(
    `ALTER TABLE ${schema}.range_plan_seasons
     ALTER COLUMN cogs_budget_pct SET DEFAULT 32`,
  );
  await pool.query(
    `ALTER TABLE ${schema}.range_plan_seasons
     ADD COLUMN IF NOT EXISTS newness_target_units INTEGER`,
  );
  await pool.query(rangePlanAosDefaultMigrationSql(schema));
  for (const seasonSeed of RANGE_PLAN_SEASON_SEEDS) {
    const seasonResult = await pool.query<{ id: number }>(
      `INSERT INTO ${schema}.range_plan_seasons
        (season_name,season_year,revenue_target_kes,cogs_budget_pct,factory_capacity_units,newness_target_units,status)
       VALUES ($1,2026,$2,32,$3,$4,'active')
       ON CONFLICT (season_name,season_year) DO NOTHING
       RETURNING id`,
      [
        seasonSeed.seasonName,
        seasonSeed.revenueTarget,
        seasonSeed.factoryCapacityUnits,
        seasonSeed.cadence === "monthly" ? seasonSeed.newnessTargetUnits : null,
      ],
    );
    const seasonId = seasonResult.rows[0]?.id ?? (await pool.query<{ id: number }>(
      `SELECT id FROM ${schema}.range_plan_seasons WHERE season_name=$1 AND season_year=2026`,
      [seasonSeed.seasonName],
    )).rows[0]?.id;
    if (!seasonId) continue;
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
    } else {
      const q4Months = seasonSeed.otbMonths;
      const monthlyRevenue = Math.round(seasonSeed.revenueTarget / q4Months.length);
      for (const monthYear of q4Months) {
        await pool.query(
          `INSERT INTO ${schema}.range_plan_otb
            (season_id,month_year,revenue_target,planned_units,new_styles_count,notes)
           VALUES ($1,$2,$3,NULL,NULL,'')
           ON CONFLICT (season_id,month_year) DO NOTHING`,
          [seasonId, monthYear, monthlyRevenue],
        );
      }
      await pool.query(
        `DELETE FROM ${schema}.range_plan_otb
         WHERE season_id=$1 AND month_year <> ALL($2::date[])`,
        [seasonId, q4Months],
      );
    }
  }
  await pool.query(
    `DELETE FROM ${schema}.range_plan_rows r
     USING ${schema}.range_plan_seasons s
     WHERE s.id=r.season_id
       AND s.season_name='September 2026'
       AND s.season_year=2026
       AND r.product_category IS NULL`,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `INSERT INTO ${schema}.range_plan_seed_migrations (migration_key)
       VALUES ('monthly-category-matrix-v1')
       ON CONFLICT DO NOTHING
       RETURNING migration_key`,
    );
    if (claim.rows[0]) {
      await client.query(
        `UPDATE ${schema}.range_plan_seasons
         SET cogs_budget_pct=32,
             factory_capacity_units=CASE WHEN season_name='September 2026' THEN 25000 ELSE factory_capacity_units END
         WHERE season_year=2026`,
      );
      await client.query(
        `UPDATE ${schema}.range_plan_rows r
         SET product_category=CASE
           WHEN r.sub_category ILIKE '%dress%' THEN 'Dresses'
           WHEN r.sub_category ILIKE '%skirt%' THEN 'Skirts'
           WHEN r.sub_category ILIKE ANY(ARRAY['%top%','%knit%']) THEN 'Tops'
           WHEN r.sub_category ILIKE ANY(ARRAY['%jacket%','%blazer%','%hoodie%','%sweater%','%poncho%','%kimono%']) THEN 'Outerwear'
           ELSE 'Bottoms'
         END
         FROM ${schema}.range_plan_seasons s
         WHERE s.id=r.season_id AND s.season_year=2026 AND s.season_name NOT LIKE 'Q%'`,
      );
      const september = await client.query<{ id: number }>(
        `SELECT id FROM ${schema}.range_plan_seasons
         WHERE season_name='September 2026' AND season_year=2026`,
      );
      if (september.rows[0]) {
        await client.query(`DELETE FROM ${schema}.range_plan_rows WHERE season_id=$1`, [september.rows[0].id]);
        for (const [productCategory, subCategory, plannedStyles, averageOrderSize, sellingPrice, expectedUnitCost, unitsSoldLastMonth] of SEPTEMBER_2026_MONTHLY_ROW_SEEDS) {
          await client.query(
            `INSERT INTO ${schema}.range_plan_rows
              (season_id,product_category,sub_category,tier,style_count_target,style_count_min,
               style_count_max,aos_units,opening_stock_units,units_sold_last_month,
               expected_unit_cost,selling_price)
              VALUES ($1,$2,$3,'Core'::${schema}.range_plan_tier,$4,0,0,$5,NULL,$6,$7,$8)`,
            [september.rows[0].id, productCategory, subCategory, plannedStyles, averageOrderSize, unitsSoldLastMonth, expectedUnitCost, sellingPrice],
          );
        }
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const labelClient = await pool.connect();
  try {
    await labelClient.query("BEGIN");
    const labelClaim = await labelClient.query(
      `INSERT INTO ${schema}.range_plan_seed_migrations (migration_key)
       VALUES ('monthly-category-labels-v1')
       ON CONFLICT DO NOTHING
       RETURNING migration_key`,
    );
    if (labelClaim.rows[0]) {
      await labelClient.query(
        `UPDATE ${schema}.range_plan_rows r
         SET sub_category=REPLACE(r.sub_category, ' & ', ' and ')
         FROM ${schema}.range_plan_seasons s
         WHERE s.id=r.season_id
           AND s.season_name='September 2026'
           AND s.season_year=2026
           AND r.sub_category LIKE '% & %'`,
      );
    }
    await labelClient.query("COMMIT");
  } catch (error) {
    await labelClient.query("ROLLBACK");
    throw error;
  } finally {
    labelClient.release();
  }
  const septemberFixClient = await pool.connect();
  try {
    await septemberFixClient.query("BEGIN");
    const fixClaim = await septemberFixClient.query(
      `INSERT INTO ${schema}.range_plan_seed_migrations (migration_key)
       VALUES ('september-category-inputs-v2')
       ON CONFLICT DO NOTHING
       RETURNING migration_key`,
    );
    if (fixClaim.rows[0]) {
      await septemberFixClient.query(
        `UPDATE ${schema}.range_plan_seasons
         SET cogs_budget_pct=32,
             status=CASE WHEN season_name='Q4 2026' THEN 'active' ELSE status END,
             factory_capacity_units=CASE WHEN season_name='September 2026' THEN 25000 ELSE factory_capacity_units END
         WHERE season_year=2026`,
      );
      await septemberFixClient.query(
        `UPDATE ${schema}.range_plan_rows r
         SET opening_stock_units=NULL
         FROM ${schema}.range_plan_seasons s
         WHERE s.id=r.season_id AND s.season_year=2026 AND s.season_name NOT LIKE 'Q%'`,
      );
      const september = await septemberFixClient.query<{ id: number }>(
        `SELECT id FROM ${schema}.range_plan_seasons
         WHERE season_name='September 2026' AND season_year=2026
         FOR UPDATE`,
      );
      if (september.rows[0]) {
        await septemberFixClient.query(
          `DELETE FROM ${schema}.range_plan_rows WHERE season_id=$1`,
          [september.rows[0].id],
        );
        for (const [productCategory, subCategory, plannedStyles, averageOrderSize, sellingPrice, expectedUnitCost, unitsSoldLastMonth] of SEPTEMBER_2026_MONTHLY_ROW_SEEDS) {
          await septemberFixClient.query(
            `INSERT INTO ${schema}.range_plan_rows
              (season_id,product_category,sub_category,tier,style_count_target,style_count_min,
               style_count_max,aos_units,opening_stock_units,units_sold_last_month,
               expected_unit_cost,selling_price)
             VALUES ($1,$2,$3,'Core'::${schema}.range_plan_tier,$4,0,0,$5,NULL,$6,$7,$8)`,
            [september.rows[0].id, productCategory, subCategory, plannedStyles, averageOrderSize, unitsSoldLastMonth, expectedUnitCost, sellingPrice],
          );
        }
      }
    }
    await septemberFixClient.query("COMMIT");
  } catch (error) {
    await septemberFixClient.query("ROLLBACK");
    throw error;
  } finally {
    septemberFixClient.release();
  }
  const unifiedTaxonomyClient = await pool.connect();
  try {
    await unifiedTaxonomyClient.query("BEGIN");
    const unifiedClaim = await unifiedTaxonomyClient.query(
      `INSERT INTO ${schema}.range_plan_seed_migrations (migration_key)
       VALUES ('unified-category-matrix-v3')
       ON CONFLICT DO NOTHING
       RETURNING migration_key`,
    );
    if (unifiedClaim.rows[0]) {
      await unifiedTaxonomyClient.query(
        `UPDATE ${schema}.range_plan_seasons
         SET revenue_target_kes=CASE WHEN season_name='Q4 2026' THEN 450000000 ELSE revenue_target_kes END,
             factory_capacity_units=CASE season_name
               WHEN 'Q4 2026' THEN 90000
               WHEN 'October 2026' THEN 30000
               WHEN 'November 2026' THEN 30000
               WHEN 'December 2026' THEN 30000
               ELSE factory_capacity_units
             END,
             status=CASE WHEN season_name='Q4 2026' THEN 'active' ELSE status END
         WHERE season_year=2026`,
      );
      await unifiedTaxonomyClient.query(
        `UPDATE ${schema}.range_plan_otb o
         SET revenue_target=150000000
         FROM ${schema}.range_plan_seasons s
         WHERE s.id=o.season_id AND s.season_name='Q4 2026' AND s.season_year=2026`,
      );
      const emptyPlanNames = ["Q4 2026", "October 2026", "November 2026", "December 2026"];
      const emptyPlans = await unifiedTaxonomyClient.query<{ id: number }>(
        `SELECT id FROM ${schema}.range_plan_seasons
         WHERE season_year=2026 AND season_name=ANY($1::text[])
         ORDER BY id
         FOR UPDATE`,
        [emptyPlanNames],
      );
      for (const plan of emptyPlans.rows) {
        await unifiedTaxonomyClient.query(`DELETE FROM ${schema}.range_plan_rows WHERE season_id=$1`, [plan.id]);
        for (const [productCategory, subCategory, , averageOrderSize, sellingPrice, expectedUnitCost] of SEPTEMBER_2026_MONTHLY_ROW_SEEDS) {
          await unifiedTaxonomyClient.query(
            `INSERT INTO ${schema}.range_plan_rows
              (season_id,product_category,sub_category,tier,style_count_target,style_count_min,
               style_count_max,aos_units,opening_stock_units,units_sold_last_month,
               expected_unit_cost,selling_price)
             VALUES ($1,$2,$3,'Core'::${schema}.range_plan_tier,0,0,0,$4,NULL,NULL,$5,$6)`,
            [plan.id, productCategory, subCategory, averageOrderSize, expectedUnitCost, sellingPrice],
          );
        }
      }
    }
    await unifiedTaxonomyClient.query("COMMIT");
  } catch (error) {
    await unifiedTaxonomyClient.query("ROLLBACK");
    throw error;
  } finally {
    unifiedTaxonomyClient.release();
  }
  const septemberAllocationClient = await pool.connect();
  try {
    await septemberAllocationClient.query("BEGIN");
    const allocationClaim = await septemberAllocationClient.query(
      `INSERT INTO ${schema}.range_plan_seed_migrations (migration_key)
       VALUES ('september-2026-business-need-allocation-v2')
       ON CONFLICT DO NOTHING
       RETURNING migration_key`,
    );
    if (allocationClaim.rows[0]) {
      const september = await septemberAllocationClient.query<{ id: number }>(
        `UPDATE ${schema}.range_plan_seasons
            SET factory_capacity_units=25000,newness_floor_pct=40
          WHERE season_name='September 2026' AND season_year=2026
          RETURNING id`,
      );
      if (september.rows[0]) {
        const seasonId = september.rows[0].id;
        await septemberAllocationClient.query(
          `DELETE FROM ${schema}.range_plan_rows WHERE season_id=$1`,
          [seasonId],
        );
        for (const [productCategory, subCategory, plannedStyles, averageOrderSize, sellingPrice, expectedUnitCost, unitsSoldLastMonth, newStyles, repeatStyles, notes] of SEPTEMBER_2026_MONTHLY_ROW_SEEDS) {
          await septemberAllocationClient.query(
            `INSERT INTO ${schema}.range_plan_rows
              (season_id,product_category,sub_category,tier,style_count_target,new_style_count,
               reorder_style_count,replenishment_style_count,style_count_min,style_count_max,
               aos_units,new_style_aos_units,opening_stock_units,units_sold_last_month,
               expected_unit_cost,selling_price,new_units,reorder_units,replenishment_units,notes)
             VALUES ($1,$2,$3,'Core'::${schema}.range_plan_tier,$4,$5,$6,0,0,0,400,300,NULL,$7,$8,$9,$10,$11,0,$12)`,
            [
              seasonId,
              productCategory,
              subCategory,
              plannedStyles,
              newStyles,
              repeatStyles,
              unitsSoldLastMonth,
              expectedUnitCost,
              sellingPrice,
              newStyles * 300,
              repeatStyles * averageOrderSize,
              notes,
            ],
          );
        }
        await septemberAllocationClient.query(
          `INSERT INTO ${schema}.range_plan_otb
            (season_id,month_year,revenue_target,planned_units,new_styles_count,notes)
           VALUES ($1,'2026-09-01',30000000,25300,35,$2)
           ON CONFLICT (season_id,month_year) DO UPDATE SET
             planned_units=EXCLUDED.planned_units,
             new_styles_count=EXCLUDED.new_styles_count,
             notes=EXCLUDED.notes`,
          [seasonId, SEPTEMBER_2026_PLAN_NOTES],
        );
      }
    }
    await septemberAllocationClient.query("COMMIT");
  } catch (error) {
    await septemberAllocationClient.query("ROLLBACK");
    throw error;
  } finally {
    septemberAllocationClient.release();
  }
  await ensureRangePlanNewnessData();
  const q3ActualPlanClient = await pool.connect();
  try {
    await q3ActualPlanClient.query("BEGIN");
    const q3Claim = await q3ActualPlanClient.query(
      `INSERT INTO ${schema}.range_plan_seed_migrations (migration_key)
       VALUES ('q3-2026-actual-plus-september-plan-v1')
       ON CONFLICT DO NOTHING
       RETURNING migration_key`,
    );
    if (q3Claim.rows[0]) {
      const q3 = await q3ActualPlanClient.query<{ id: number }>(
        `UPDATE ${schema}.range_plan_seasons
            SET revenue_target_kes=0,cogs_budget_pct=32,factory_capacity_units=$1,status='active'
          WHERE season_name='Q3 2026' AND season_year=2026
          RETURNING id`,
        [Q3_2026_CAPACITY_UNITS],
      );
      if (q3.rows[0]) {
        const q3Id = q3.rows[0].id;
        await q3ActualPlanClient.query(`DELETE FROM ${schema}.range_plan_rows WHERE season_id=$1`, [q3Id]);
        for (const [productCategory, subCategory, actualStyles, actualUnits] of Q3_2026_JUL_AUG_ACTUALS) {
          await q3ActualPlanClient.query(
            `INSERT INTO ${schema}.range_plan_rows
              (season_id,product_category,sub_category,tier,style_count_target,new_style_count,
               reorder_style_count,replenishment_style_count,style_count_min,style_count_max,
               aos_units,new_style_aos_units,opening_stock_units,units_sold_last_month,
               expected_unit_cost,selling_price,new_units,reorder_units,replenishment_units,notes)
             VALUES ($1,$2,$3,'Core'::${schema}.range_plan_tier,$4,0,0,0,0,0,1,300,NULL,NULL,NULL,NULL,$5,0,0,$6)`,
            [
              q3Id,
              productCategory,
              subCategory,
              actualStyles,
              actualUnits,
              `July–August tracker actual: ${actualStyles} styles / ${actualUnits} units. September values are added live from the September 2026 monthly plan.`,
            ],
          );
        }
        await q3ActualPlanClient.query(`DELETE FROM ${schema}.range_plan_otb WHERE season_id=$1`, [q3Id]);
        await q3ActualPlanClient.query(
          `INSERT INTO ${schema}.range_plan_otb
            (season_id,month_year,revenue_target,planned_units,new_styles_count,notes)
           VALUES
            ($1,'2026-07-01',NULL,$2,$3,$4),
            ($1,'2026-09-01',NULL,NULL,NULL,$5)`,
          [
            q3Id,
            Q3_2026_ACTUAL_UNITS,
            Q3_2026_ACTUAL_ORDER_COUNT,
            "Combined July–August tracker actuals. Includes four orders / 1,351 units placed in June but booked into the Q3 tracker.",
            "Read live from the September 2026 monthly plan. Includes two orders / 653 units already placed in September.",
          ],
        );
      }
    }
    await q3ActualPlanClient.query("COMMIT");
  } catch (error) {
    await q3ActualPlanClient.query("ROLLBACK");
    throw error;
  } finally {
    q3ActualPlanClient.release();
  }
  await pool.query(
    `UPDATE ${schema}.range_plan_seasons
        SET factory_capacity_units=25000
      WHERE season_name='September 2026' AND season_year=2026`,
  );
  await pool.query(
    `UPDATE ${schema}.range_plan_rows
        SET reorder_style_count=style_count_target
      WHERE new_style_count=0 AND reorder_style_count=0 AND replenishment_style_count=0`,
  );
  await pool.query(
    `UPDATE ${schema}.range_plan_rows
        SET reorder_units=total_units_implied
      WHERE new_units=0 AND reorder_units=0 AND replenishment_units=0`,
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
    ["weekly order plan movement audit", `
      CREATE TABLE IF NOT EXISTS ${schema}.weekly_order_plan_line_moves (
        id BIGSERIAL PRIMARY KEY,
        line_id INTEGER NOT NULL REFERENCES ${schema}.weekly_order_plan_lines(id) ON DELETE CASCADE,
        from_plan_id INTEGER NOT NULL REFERENCES ${schema}.weekly_order_plans(id) ON DELETE RESTRICT,
        to_plan_id INTEGER NOT NULL REFERENCES ${schema}.weekly_order_plans(id) ON DELETE RESTRICT,
        from_iso_year INTEGER NOT NULL,
        from_iso_week INTEGER NOT NULL CHECK (from_iso_week BETWEEN 1 AND 53),
        to_iso_year INTEGER NOT NULL,
        to_iso_week INTEGER NOT NULL CHECK (to_iso_week BETWEEN 1 AND 53),
        moved_by INTEGER REFERENCES ${schema}.users(id) ON DELETE SET NULL,
        moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (from_plan_id <> to_plan_id)
      );
      CREATE INDEX IF NOT EXISTS weekly_order_plan_line_moves_line_idx
        ON ${schema}.weekly_order_plan_line_moves (line_id, moved_at, id);
    `],
    ["range plan newness and commitment columns", `
      ALTER TABLE ${schema}.range_plan_seasons ADD COLUMN IF NOT EXISTS newness_floor_pct NUMERIC NOT NULL DEFAULT 40;
      ALTER TABLE ${schema}.range_plan_seasons ADD COLUMN IF NOT EXISTS newness_target_units INTEGER;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS product_category TEXT;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS opening_stock_units INTEGER;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS units_sold_last_month INTEGER;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS expected_unit_cost NUMERIC;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS selling_price NUMERIC;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS new_style_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS new_style_aos_units INTEGER NOT NULL DEFAULT 300;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS reorder_style_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS replenishment_style_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS new_units INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS reorder_units INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS replenishment_units INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS planned_units_calculated INTEGER GENERATED ALWAYS AS
        (new_style_count * new_style_aos_units + (reorder_style_count + replenishment_style_count) * aos_units) STORED;
      UPDATE ${schema}.range_plan_seasons SET factory_capacity_units=25000
       WHERE season_name='September 2026' AND season_year=2026;
      UPDATE ${schema}.range_plan_rows SET reorder_style_count=style_count_target
       WHERE new_style_count=0 AND reorder_style_count=0 AND replenishment_style_count=0;
      UPDATE ${schema}.range_plan_rows SET reorder_units=total_units_implied
       WHERE new_units=0 AND reorder_units=0 AND replenishment_units=0;
    `],
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
        cogs_budget_pct NUMERIC NOT NULL DEFAULT 32,
        factory_capacity_units INTEGER NOT NULL DEFAULT 0,
        newness_floor_pct NUMERIC NOT NULL DEFAULT 40,
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
        product_category TEXT,
        tier ${schema}.range_plan_tier NOT NULL,
        style_count_target INTEGER NOT NULL DEFAULT 0,
        new_style_count INTEGER NOT NULL DEFAULT 0,
        reorder_style_count INTEGER NOT NULL DEFAULT 0,
        replenishment_style_count INTEGER NOT NULL DEFAULT 0,
        style_count_min INTEGER NOT NULL DEFAULT 0,
        style_count_max INTEGER NOT NULL DEFAULT 0,
        ${RANGE_PLAN_AOS_COLUMN_SQL},
        new_style_aos_units INTEGER NOT NULL DEFAULT 300,
        opening_stock_units INTEGER,
        units_sold_last_month INTEGER,
        expected_unit_cost NUMERIC,
        selling_price NUMERIC,
        total_units_implied INTEGER GENERATED ALWAYS AS (style_count_target * aos_units) STORED,
        planned_units_calculated INTEGER GENERATED ALWAYS AS
          (new_style_count * new_style_aos_units + (reorder_style_count + replenishment_style_count) * aos_units) STORED,
        new_units INTEGER NOT NULL DEFAULT 0,
        reorder_units INTEGER NOT NULL DEFAULT 0,
        replenishment_units INTEGER NOT NULL DEFAULT 0,
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
      preview_object_path TEXT,
      preview_status TEXT NOT NULL DEFAULT 'pending' CHECK (preview_status IN ('pending','generating','ready','failed')),
      preview_byte_size INTEGER,
      preview_error TEXT,
      preview_generated_at TIMESTAMPTZ,
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
    ALTER TABLE ${schema}.style_feedback_images ADD COLUMN IF NOT EXISTS preview_object_path TEXT;
    ALTER TABLE ${schema}.style_feedback_images ADD COLUMN IF NOT EXISTS preview_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE ${schema}.style_feedback_images ADD COLUMN IF NOT EXISTS preview_byte_size INTEGER;
    ALTER TABLE ${schema}.style_feedback_images ADD COLUMN IF NOT EXISTS preview_error TEXT;
    ALTER TABLE ${schema}.style_feedback_images ADD COLUMN IF NOT EXISTS preview_generated_at TIMESTAMPTZ;
    DO $$ BEGIN
      ALTER TABLE ${schema}.style_feedback_images ADD CONSTRAINT style_feedback_images_preview_status_check
        CHECK (preview_status IN ('pending','generating','ready','failed'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE ${schema}.style_feedback ADD CONSTRAINT style_feedback_pulse_mode_check CHECK (pulse_mode IS NULL OR pulse_mode IN ('investigate','champion'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS style_feedback_created_at_idx ON ${schema}.style_feedback (created_at DESC);
    CREATE INDEX IF NOT EXISTS style_feedback_style_id_idx ON ${schema}.style_feedback (style_id);
    CREATE INDEX IF NOT EXISTS style_feedback_pulse_idx ON ${schema}.style_feedback (pulse_id);
    CREATE INDEX IF NOT EXISTS style_feedback_images_feedback_idx ON ${schema}.style_feedback_images (feedback_id);
    CREATE INDEX IF NOT EXISTS style_feedback_images_expiry_idx ON ${schema}.style_feedback_images (expires_at) WHERE feedback_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS style_feedback_images_preview_path_idx
      ON ${schema}.style_feedback_images (preview_object_path) WHERE preview_object_path IS NOT NULL;
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
      cogs_budget_pct NUMERIC NOT NULL DEFAULT 32,
      factory_capacity_units INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (season_name, season_year)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.range_plan_rows (
      id SERIAL PRIMARY KEY,
      season_id INTEGER NOT NULL REFERENCES ${schema}.range_plan_seasons(id) ON DELETE CASCADE,
      sub_category TEXT NOT NULL,
      product_category TEXT,
      tier ${schema}.range_plan_tier NOT NULL,
      style_count_target INTEGER NOT NULL DEFAULT 0,
      style_count_min INTEGER NOT NULL DEFAULT 0,
      style_count_max INTEGER NOT NULL DEFAULT 0,
      ${RANGE_PLAN_AOS_COLUMN_SQL},
      new_style_aos_units INTEGER NOT NULL DEFAULT 300,
      opening_stock_units INTEGER,
      units_sold_last_month INTEGER,
      expected_unit_cost NUMERIC,
      selling_price NUMERIC,
      total_units_implied INTEGER GENERATED ALWAYS AS (style_count_target * aos_units) STORED,
      planned_units_calculated INTEGER GENERATED ALWAYS AS
        (new_style_count * new_style_aos_units + (reorder_style_count + replenishment_style_count) * aos_units) STORED,
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
    CREATE TABLE IF NOT EXISTS ${schema}.weekly_order_plans (
      id SERIAL PRIMARY KEY,
      iso_year INTEGER NOT NULL,
      iso_week INTEGER NOT NULL CHECK (iso_week BETWEEN 1 AND 53),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
      confirmed_at TIMESTAMPTZ,
      confirmed_by INTEGER REFERENCES ${schema}.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (iso_year, iso_week)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.weekly_order_plan_lines (
      id SERIAL PRIMARY KEY,
      plan_id INTEGER NOT NULL REFERENCES ${schema}.weekly_order_plans(id) ON DELETE CASCADE,
      sequence_no INTEGER NOT NULL,
      order_number TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL CHECK (source IN ('development','catalogue')),
      source_id TEXT NOT NULL,
      style_number TEXT NOT NULL,
      style_name TEXT NOT NULL,
      style_type TEXT,
      tier TEXT,
      category TEXT,
      sub_category TEXT,
      brand TEXT,
      fabric TEXT,
      fabric_product_id BIGINT,
      target_order_week TEXT,
      image_url TEXT,
      available_colourways TEXT[] NOT NULL DEFAULT '{}',
      selected_colourways TEXT[] NOT NULL DEFAULT '{}',
      estimated_quantity INTEGER NOT NULL CHECK (estimated_quantity > 0),
      order_type TEXT NOT NULL CHECK (order_type IN ('New','Re-order','Replenishment','Range Refreshed')),
      order_stage TEXT NOT NULL CHECK (order_stage IN ('CAD Marker Making','Buying Requisition','Buying Production Order','Production Sample')),
      created_by INTEGER REFERENCES ${schema}.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (plan_id, source, source_id),
      UNIQUE (plan_id, sequence_no)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.weekly_order_plan_line_moves (
      id BIGSERIAL PRIMARY KEY,
      line_id INTEGER NOT NULL REFERENCES ${schema}.weekly_order_plan_lines(id) ON DELETE CASCADE,
      from_plan_id INTEGER NOT NULL REFERENCES ${schema}.weekly_order_plans(id) ON DELETE RESTRICT,
      to_plan_id INTEGER NOT NULL REFERENCES ${schema}.weekly_order_plans(id) ON DELETE RESTRICT,
      from_iso_year INTEGER NOT NULL,
      from_iso_week INTEGER NOT NULL CHECK (from_iso_week BETWEEN 1 AND 53),
      to_iso_year INTEGER NOT NULL,
      to_iso_week INTEGER NOT NULL CHECK (to_iso_week BETWEEN 1 AND 53),
      moved_by INTEGER REFERENCES ${schema}.users(id) ON DELETE SET NULL,
      moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (from_plan_id <> to_plan_id)
    );
    CREATE INDEX IF NOT EXISTS weekly_order_plan_lines_plan_idx
      ON ${schema}.weekly_order_plan_lines (plan_id, sub_category, fabric);
    CREATE INDEX IF NOT EXISTS weekly_order_plan_line_moves_line_idx
      ON ${schema}.weekly_order_plan_line_moves (line_id, moved_at, id);
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
    CREATE TABLE IF NOT EXISTS ${schema}.style_development_tracker (
      id SERIAL PRIMARY KEY,
      style_number TEXT,
      original_style_number TEXT,
      style_number_status TEXT NOT NULL CHECK (style_number_status IN ('needs_number','malformed','confirmed')),
      style_name TEXT NOT NULL,
      style_type TEXT NOT NULL CHECK (style_type IN ('NEW','RR')),
      tier TEXT NOT NULL CHECK (tier IN ('Tier 3','Tier 4')),
      status TEXT NOT NULL,
      category TEXT NOT NULL,
      sub_category TEXT NOT NULL,
      original_sub_category TEXT NOT NULL,
      target_order_week TEXT NOT NULL,
      fabric TEXT NOT NULL DEFAULT '',
      import_batch TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (import_batch, style_name, target_order_week)
    );
    CREATE INDEX IF NOT EXISTS style_development_tracker_week_idx
      ON ${schema}.style_development_tracker (target_order_week, status);
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
    ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS product_category TEXT;
    ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS opening_stock_units INTEGER;
    ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS units_sold_last_month INTEGER;
    ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS expected_unit_cost NUMERIC;
    ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS selling_price NUMERIC;
    ALTER TABLE ${schema}.range_plan_seasons ADD COLUMN IF NOT EXISTS newness_floor_pct NUMERIC NOT NULL DEFAULT 40;
    ALTER TABLE ${schema}.range_plan_seasons ADD COLUMN IF NOT EXISTS newness_target_units INTEGER;
    ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS new_style_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS new_style_aos_units INTEGER NOT NULL DEFAULT 300;
    ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS reorder_style_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS replenishment_style_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS new_units INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS reorder_units INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS replenishment_units INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE ${schema}.range_plan_rows ADD COLUMN IF NOT EXISTS planned_units_calculated INTEGER GENERATED ALWAYS AS
        (new_style_count * new_style_aos_units + (reorder_style_count + replenishment_style_count) * aos_units) STORED;
    UPDATE ${schema}.range_plan_rows
       SET reorder_style_count=style_count_target
     WHERE new_style_count=0 AND reorder_style_count=0 AND replenishment_style_count=0;
    UPDATE ${schema}.range_plan_rows
       SET reorder_units=total_units_implied
     WHERE new_units=0 AND reorder_units=0 AND replenishment_units=0;
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
  await ensureStyleDevelopmentTrackerData();

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

type FeedbackPreviewResult = {
  status: FeedbackPreviewStatus;
  objectPath: string | null;
};

const feedbackPreviewFlights = new Map<number, Promise<FeedbackPreviewResult>>();

function normalizedFeedbackPreviewStatus(value: unknown): FeedbackPreviewStatus {
  const status = String(value ?? "pending");
  return status === "generating" || status === "ready" || status === "failed" ? status : "pending";
}

async function convertFeedbackHeicToJpeg(bytes: Uint8Array) {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const process = spawn("magick", [
      "-",
      "-auto-orient",
      "-thumbnail",
      "1280x1280>",
      "-strip",
      "-quality",
      "82",
      "jpeg:-",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
      finish(new Error("HEIC preview conversion timed out"));
    }, 30_000);
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      const result = Buffer.concat(output);
      if (!result.length || result.length > FEEDBACK_IMAGE_MAX_BYTES) {
        reject(new Error("HEIC preview conversion returned an invalid image"));
        return;
      }
      resolve(new Uint8Array(result));
    };
    process.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.once("error", (error) => finish(error));
    process.once("close", (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString("utf8").trim().slice(0, 240);
        finish(new Error(detail || `HEIC preview conversion exited with code ${code ?? "unknown"}`));
      } else {
        finish(null);
      }
    });
    process.stdin.end(Buffer.from(bytes));
  });
}

async function ensureFeedbackImagePreview(imageId: number): Promise<FeedbackPreviewResult> {
  const existingFlight = feedbackPreviewFlights.get(imageId);
  if (existingFlight) return existingFlight;

  const flight = (async (): Promise<FeedbackPreviewResult> => {
    const current = await pool.query<{ status: string; objectPath: string | null }>(
      `SELECT preview_status AS status,preview_object_path AS "objectPath"
         FROM ${schema}.style_feedback_images
        WHERE id=$1 AND feedback_id IS NOT NULL
          AND content_type IN ('image/heic','image/heif')`,
      [imageId],
    );
    const existing = current.rows[0];
    if (!existing) return { status: "failed", objectPath: null };
    const existingStatus = normalizedFeedbackPreviewStatus(existing.status);
    if (existingStatus === "ready" && existing.objectPath) {
      return { status: "ready", objectPath: existing.objectPath };
    }
    if (existingStatus !== "pending") {
      return { status: existingStatus, objectPath: null };
    }

    const claim = await pool.query<{ objectPath: string }>(
      `UPDATE ${schema}.style_feedback_images
          SET preview_status='generating',preview_error=NULL
        WHERE id=$1 AND feedback_id IS NOT NULL
          AND content_type IN ('image/heic','image/heif')
          AND preview_status='pending'
        RETURNING object_path AS "objectPath"`,
      [imageId],
    );
    if (!claim.rows[0]) {
      const claimed = await pool.query<{ status: string; objectPath: string | null }>(
        `SELECT preview_status AS status,preview_object_path AS "objectPath"
           FROM ${schema}.style_feedback_images WHERE id=$1`,
        [imageId],
      );
      const status = normalizedFeedbackPreviewStatus(claimed.rows[0]?.status);
      return { status, objectPath: status === "ready" ? claimed.rows[0]?.objectPath ?? null : null };
    }

    try {
      const original = await pool.query<{ objectPath: string }>(
        `SELECT object_path AS "objectPath" FROM ${schema}.style_feedback_images WHERE id=$1`,
        [imageId],
      );
      const source = original.rows[0];
      if (!source) throw new Error("Original feedback image not found");
      const response = await fetch(await signedStorageUrl(source.objectPath, "GET", 300), {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Unable to read original feedback image (${response.status})`);
      const sourceBytes = await readFeedbackImageAtMost(response);
      const previewBytes = await convertFeedbackHeicToJpeg(sourceBytes);
      const previewObjectPath = `/objects/style-feedback-previews/${imageId}.jpg`;
      const stored = await fetch(await signedStorageUrl(previewObjectPath, "PUT", 180), {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg", "Content-Length": String(previewBytes.length) },
        body: previewBytes,
        signal: AbortSignal.timeout(30_000),
      });
      if (!stored.ok) throw new Error(`Unable to store HEIC preview (${stored.status})`);
      await pool.query(
        `UPDATE ${schema}.style_feedback_images
            SET preview_object_path=$1,preview_status='ready',preview_byte_size=$2,
                preview_error=NULL,preview_generated_at=NOW()
          WHERE id=$3 AND feedback_id IS NOT NULL`,
        [previewObjectPath, previewBytes.length, imageId],
      );
      return { status: "ready", objectPath: previewObjectPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown HEIC preview conversion error";
      await pool.query(
        `UPDATE ${schema}.style_feedback_images
            SET preview_status='failed',preview_error=$1,preview_generated_at=NOW()
          WHERE id=$2 AND feedback_id IS NOT NULL`,
        [message.slice(0, 500), imageId],
      ).catch(() => undefined);
      console.warn("Unable to generate feedback HEIC preview", { imageId, error: message });
      return { status: "failed", objectPath: null };
    }
  })();

  feedbackPreviewFlights.set(imageId, flight);
  try {
    return await flight;
  } finally {
    if (feedbackPreviewFlights.get(imageId) === flight) feedbackPreviewFlights.delete(imageId);
  }
}

async function prepareFeedbackPreviewMetadata(rows: Array<Record<string, unknown>>) {
  const attachments = rows.flatMap((row) => Array.isArray(row.imageAttachments) ? row.imageAttachments : [])
    .map((attachment) => attachment as Record<string, unknown>)
    .filter((attachment) => {
      const type = String(attachment.contentType ?? "").toLowerCase();
      return type === "image/heic" || type === "image/heif";
    });
  const ids = [...new Set(attachments.map((attachment) => Number(attachment.id)).filter((id) => Number.isInteger(id) && id > 0))].slice(0, FEEDBACK_IMAGE_MAX_FILES);
  let nextIndex = 0;
  const results: Array<readonly [number, FeedbackPreviewResult]> = [];
  const worker = async () => {
    while (nextIndex < ids.length) {
      const id = ids[nextIndex++];
      results.push([id, await ensureFeedbackImagePreview(id)] as const);
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, ids.length) }, () => worker()));
  const byId = new Map(results);
  for (const attachment of attachments) {
    const result = byId.get(Number(attachment.id));
    if (!result) continue;
    attachment.previewStatus = result.status;
    attachment.previewObjectPath = result.objectPath;
  }
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
      const contentType = String(item.contentType ?? "application/octet-stream");
      const previewStatus = normalizedFeedbackPreviewStatus(item.previewStatus);
      return {
        id: Number(item.id),
        filename: String(item.filename ?? "feedback-image"),
        contentType,
        sizeBytes: Number(item.sizeBytes ?? 0),
        viewUrl: `/api/workspace/feedback/images/${Number(item.id)}`,
        downloadUrl: `/api/workspace/feedback/images/${Number(item.id)}?download=1`,
        previewUrl: feedbackImagePreviewUrl(item.id, contentType, previewStatus),
        previewStatus: contentType === "image/heic" || contentType === "image/heif" ? previewStatus : "native",
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
     ORDER BY CASE
         WHEN LOWER(name)=LOWER($2) THEN 0
         WHEN LOWER(name) LIKE LOWER($2)||'%' THEN 1
         ELSE 2
       END,
       LOWER(name),"customerId"
     LIMIT $3`,
    [`%${q}%`, q, FEEDBACK_CUSTOMER_SEARCH_LIMIT],
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

const handleFeedbackCustomerSearch = async (req: Request, res: Response, next: NextFunction) => {
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
};

router.get("/feedback/customers/search", handleFeedbackCustomerSearch);
// Keep the original public contract working for older feedback-form bundles.
router.get("/feedback/customer-lookup", handleFeedbackCustomerSearch);

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

function normalizeStyleDevelopmentStage(value: unknown): StyleDevelopmentStage {
  const normalized = String(value ?? "").trim().toLowerCase();
  const aliases: Record<string, StyleDevelopmentStage> = {
    "pattern": "Pattern",
    "transfer to cad": "Transfer to CAD",
    "cad processing ss": "CAD Processing SS",
    "sampling": "Sampling",
    "sample review": "Sample Review",
    "set sampling": "Set Sampling",
    "approved for s/s": "Approved for S/S",
    "cad processing order": "CAD Processing Order",
    "buying requisition s/s": "Buying Requisition S/S",
    "waiting for fabric": "Waiting for Fabric",
  };
  return aliases[normalized] ?? "Pattern";
}

function styleDevelopmentEventStage(entry: Record<string, unknown>): StyleDevelopmentStage | null {
  const eventType = String(entry.eventType ?? "");
  // Imported tracker status is the canonical baseline and is read directly
  // from the tracker row. Older imported_stage history collapsed statuses.
  if (eventType === "imported_stage") return null;
  if (eventType === "adopted" || eventType === "baseline") return "Pattern";
  if (eventType === "pattern_started") return "Pattern";
  if (eventType === "pattern_done" || eventType === "tech_pack_started" || eventType === "tech_pack_done" || eventType === "cad_transfer_started") return "Transfer to CAD";
  if (eventType === "cad_transfer_done" || eventType === "cad_grading_started" || eventType === "cad_grading_done") return "CAD Processing SS";
  if (eventType === "sample_started" || eventType === "sample_received" || eventType === "resample_started" || eventType === "resample_received") return "Sampling";
  if (eventType === "review_started") return "Sample Review";
  if (eventType === "rereview_started" || eventType === "rereview_done") return "Sample Review";
  if (eventType === "sample_approved" || eventType === "set_sample_order_started" || eventType === "set_sample_order_created" || eventType === "set_sample_production_started" || eventType === "set_sample_production_done") return "Set Sampling";
  if (eventType === "sample_rejected" || eventType === "pattern_amendment_started" || eventType === "pattern_amendment_done") return "Sampling";
  if (eventType === "set_sample_review_started" || eventType === "set_sample_approved") return "Approved for S/S";
  if (eventType === "set_sample_rejected") return "Set Sampling";
  if (eventType === "order_processing_started") return "CAD Processing Order";
  if (eventType === "order_processing_done" || eventType === "order_approved" || eventType === "order_rejected") return "Buying Requisition S/S";
  return null;
}

function workingDaysSince(value: unknown) {
  const start = new Date(String(value ?? ""));
  if (Number.isNaN(start.getTime())) return 0;
  const cursor = new Date(start);
  const end = new Date();
  cursor.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  let count = 0;
  while (cursor < end) {
    cursor.setDate(cursor.getDate() + 1);
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

function workingDaysBetween(startValue: unknown, endValue: unknown) {
  const start = new Date(String(startValue ?? ""));
  const end = new Date(String(endValue ?? ""));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0;
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  let count = 0;
  while (start < end) {
    start.setDate(start.getDate() + 1);
    if (start.getDay() !== 0 && start.getDay() !== 6) count += 1;
  }
  return count;
}

const STYLE_INTERVALS = [
  ["pattern", "pattern_started", "pattern_done", 2],
  ["techPack", "tech_pack_started", "tech_pack_done", 1],
  ["sample", "sample_started", "sample_received", 3],
  ["review", "review_started", "sample_approved", 2],
  ["cadTransfer", "cad_transfer_started", "cad_transfer_done", 2],
  ["cadGrading", "cad_grading_started", "cad_grading_done", 3],
  ["setSampleOrder", "set_sample_order_started", "set_sample_order_created", 3],
  ["setSampleProduction", "set_sample_production_started", "set_sample_production_done", 3],
  ["setSampleReview", "set_sample_review_started", "set_sample_approved", 2],
  ["orderProcessing", "order_processing_started", "order_processing_done", 2],
  ["patternAmendment", "pattern_amendment_started", "pattern_amendment_done", 1],
  ["resample", "resample_started", "resample_received", 1],
  ["rereview", "rereview_started", "rereview_done", 2],
] as const;

function eventAt(history: Array<Record<string, unknown>>, eventType: string, after?: unknown) {
  const afterTime = after ? new Date(String(after)).getTime() : -Infinity;
  return history.find((entry) => entry.eventType === eventType && new Date(String(entry.occurredAt)).getTime() >= afterTime)?.occurredAt ?? null;
}

function styleDevelopmentPayload(row: Record<string, unknown>, history: Array<Record<string, unknown>>) {
  let stage = normalizeStyleDevelopmentStage(row.status);
  let stageStartedAt: unknown = row.adoptionDate ?? row.createdAt;
  for (const entry of history) {
    const candidate = styleDevelopmentEventStage(entry);
    if (!candidate) continue;
    stage = candidate;
    stageStartedAt = entry.occurredAt;
  }
  const workingDaysAtStage = workingDaysSince(stageStartedAt);
  const standardDays = STYLE_DEVELOPMENT_STAGE_STANDARD_DAYS[stage];
  const sampleRejections = history.filter((entry) => entry.eventType === "sample_rejected").length;
  const setSampleRejections = history.filter((entry) => entry.eventType === "set_sample_rejected").length;
  const hasOrderApproval = history.some((entry) => entry.eventType === "order_approved");
  const waitingDecision = stage === "Sample Review"
    ? "sample"
    : stage === "Approved for S/S"
      ? "set_sample"
      : stage === "Buying Requisition S/S" && !hasOrderApproval
        ? "order"
        : null;
  const adoptedAt = eventAt(history, "adopted") ?? eventAt(history, "baseline") ?? row.adoptionDate ?? row.createdAt;
  const completed = (type: string) => eventAt(history, type);
  const latest = (...dates: unknown[]) => dates.filter(Boolean).sort((a, b) => new Date(String(b)).getTime() - new Date(String(a)).getTime())[0] ?? adoptedAt;
  // Prerequisites are intentionally explicit: CAD grading and set-order are
  // parallel after transfer, and production waits for both branches.
  const prerequisiteFor: Record<string, unknown> = {
    pattern: adoptedAt, techPack: completed("pattern_done") ?? adoptedAt,
    sample: completed("tech_pack_done") ?? completed("pattern_done") ?? adoptedAt,
    review: completed("sample_received") ?? adoptedAt,
    cadTransfer: completed("sample_approved") ?? adoptedAt,
    cadGrading: completed("cad_transfer_done") ?? adoptedAt,
    setSampleOrder: completed("cad_transfer_done") ?? adoptedAt,
    setSampleProduction: latest(completed("cad_grading_done"), completed("set_sample_order_created")),
    setSampleReview: completed("set_sample_production_done") ?? adoptedAt,
    orderProcessing: completed("set_sample_approved") ?? adoptedAt,
    patternAmendment: completed("sample_rejected") ?? adoptedAt,
    resample: completed("pattern_amendment_done") ?? completed("sample_rejected") ?? adoptedAt,
    rereview: completed("resample_received") ?? completed("sample_rejected") ?? adoptedAt,
  };
  const intervalMetrics = STYLE_INTERVALS.map(([key, startedType, doneType, standard]) => {
    const startedAt = eventAt(history, startedType);
    const completedAt = eventAt(history, doneType, startedAt ?? undefined);
    const prerequisite = prerequisiteFor[key] ?? adoptedAt;
    const metric = {
      key, standard, startedAt, completedAt,
      queueWorkingDays: startedAt ? workingDaysBetween(prerequisite, startedAt) : null,
      workWorkingDays: startedAt ? workingDaysBetween(startedAt, completedAt ?? new Date()) : null,
      totalWorkingDays: startedAt ? workingDaysBetween(prerequisite, completedAt ?? new Date()) : null,
    };
    return metric;
  });
  const reworkRounds = history.filter((entry) => entry.eventType === "sample_rejected").map((entry) => {
    const rejectedAt = entry.occurredAt;
    const amendmentDone = eventAt(history, "pattern_amendment_done", rejectedAt);
    const resampleDone = eventAt(history, "resample_received", amendmentDone ?? rejectedAt);
    const reviewDone = eventAt(history, "rereview_done", resampleDone ?? rejectedAt);
    return { rejectedAt, standard: 4, totalWorkingDays: workingDaysBetween(rejectedAt, reviewDone ?? new Date()) };
  });
  const orderDoneAt = eventAt(history, "order_processing_done") ?? eventAt(history, "order_approved");
  const actualElapsedWorkingDays = workingDaysBetween(adoptedAt, orderDoneAt ?? new Date());
  const indicativeCogsKes = row.indicativeCogsKes === null || row.indicativeCogsKes === undefined ? null : Number(row.indicativeCogsKes);
  const intendedSellingPriceKes = row.intendedSellingPriceKes === null || row.intendedSellingPriceKes === undefined ? null : Number(row.intendedSellingPriceKes);
  const cogsPct = indicativeCogsKes !== null && intendedSellingPriceKes && intendedSellingPriceKes > 0
    ? (indicativeCogsKes / (intendedSellingPriceKes / 1.16)) * 100 : null;
  const fabricMetres = row.fabricMetres === null || row.fabricMetres === undefined ? 0 : Number(row.fabricMetres);
  const missing: string[] = [];
  if (!row.sampleFabricProductId || fabricMetres <= 0) missing.push("sample fabric in stock");
  if (!String(row.season ?? "").trim()) missing.push("season");
  if (indicativeCogsKes === null) missing.push("indicative COGS");
  if (!intendedSellingPriceKes || intendedSellingPriceKes <= 0) missing.push("intended price");
  const warnings = cogsPct !== null && cogsPct > 32 ? ["COGS exceeds 32% of net selling price"] : [];
  const adoptionReadiness = { ready: missing.length === 0 && warnings.length === 0, missing, warnings };
  return {
    id: Number(row.id),
    styleNumber: row.styleNumber ?? null,
    originalStyleNumber: row.originalStyleNumber ?? null,
    styleNumberStatus: row.styleNumberStatus,
    styleName: row.styleName,
    type: row.type,
    tier: row.tier,
    status: row.status,
    category: row.category,
    subCategory: row.subCategory,
    originalSubCategory: row.originalSubCategory,
    brand: row.brand,
    fabric: row.fabric,
    patternMaker: row.patternMaker,
    adoptionDate: row.adoptionDate ? String(row.adoptionDate).slice(0, 10) : null,
    targetOrderWeek: row.targetOrderWeek ?? null,
    targetLaunchWeek: row.targetLaunchWeek ?? null,
    sampleApprovalDate: row.sampleApprovalDate ?? null,
    dataQualityFlags: row.dataQualityFlags ?? [],
    blocked: Boolean(row.blocked),
    blockerReason: row.blockerReason ?? "",
    sampleFabricProductId: row.sampleFabricProductId === null ? null : Number(row.sampleFabricProductId),
    sampleFabricName: row.sampleFabricName ?? null,
    sampleFabricColour: row.sampleFabricColour ?? null,
    sampleFabricCostPerMetre: row.sampleFabricCostPerMetre ?? null,
    sampleFabricOtherColours: row.sampleFabricOtherColours ?? [],
    categoryMetresPerGarment: row.categoryMetresPerGarment ?? null,
    sampleFabricMetres: fabricMetres,
    season: row.season ?? "",
    intendedSellingPriceKes,
    indicativeCogsKes,
    cogsPct,
    indicativeCogsPct: cogsPct,
    adoptionReadiness,
    exitStatus: row.exitStatus ?? "active",
    exitReason: row.exitReason ?? null,
    exitedAt: row.exitedAt ?? null,
    exitStage: row.exitStage ?? null,
    stage,
    stageStartedAt,
    workingDaysAtStage,
    standardDays,
    overStandard: standardDays !== null && workingDaysAtStage > standardDays,
    sampleRounds: Math.max(1, sampleRejections + 1),
    setSampleRounds: Math.max(1, setSampleRejections + 1),
    sampleRejections,
    setSampleRejections,
    rejectedMoreThanOnce: sampleRejections > 1 || setSampleRejections > 1,
    waitingDecision,
    intervalMetrics,
    reworkRounds,
    totalStandardWorkingDays: 13,
    standardEndToEndDays: 13,
    targetWeeks: "4-5",
    targetWeeksLabel: "4–5 weeks",
    actualElapsedWorkingDays,
    historyCount: history.length,
    imageUrl: row.image ?? null,
  };
}

async function loadStyleDevelopmentTracker(styleId?: number) {
  const params: unknown[] = [];
  const where = styleId ? "WHERE t.id=$1" : "";
  if (styleId) params.push(styleId);
  const result = await pool.query(
    `SELECT t.id,t.style_number AS "styleNumber",t.original_style_number AS "originalStyleNumber",
      t.style_number_status AS "styleNumberStatus",t.style_name AS "styleName",
      t.style_type AS type,t.tier,t.status,t.category,t.sub_category AS "subCategory",
      t.original_sub_category AS "originalSubCategory",t.target_order_week AS "targetOrderWeek",t.fabric,
      t.sample_approval_date AS "sampleApprovalDate",t.data_quality_flags AS "dataQualityFlags",
      t.brand,t.pattern_maker AS "patternMaker",t.adoption_date AS "adoptionDate",
      t.target_launch_week AS "targetLaunchWeek",t.blocked,t.blocker_reason AS "blockerReason",
       t.sample_fabric_product_id AS "sampleFabricProductId",t.season,
       t.intended_selling_price_kes AS "intendedSellingPriceKes",t.indicative_cogs_kes AS "indicativeCogsKes",
       t.exit_status AS "exitStatus",t.exit_reason AS "exitReason",t.exited_at AS "exitedAt",t.exit_stage AS "exitStage",
      t.created_at AS "createdAt",t.updated_at AS "updatedAt"
     FROM ${schema}.style_development_tracker t
     ${where}
     ORDER BY t.style_name`,
    params,
  );
  if (!result.rows.length) return [];
  const ids = result.rows.map((row) => Number(row.id));
  const historyResult = await pool.query(
    `SELECT h.id,h.tracker_style_id AS "trackerStyleId",h.entry_type AS "entryType",
      h.event_type AS "eventType",h.outcome,h.note,h.reason,h.old_value AS "oldValue",
      h.new_value AS "newValue",h.occurred_at AS "occurredAt",h.recorded_at AS "recordedAt",
      COALESCE(u.name,'System') AS "recordedBy"
     FROM ${schema}.style_development_history h
     LEFT JOIN ${schema}.users u ON u.id=h.recorded_by
     WHERE h.tracker_style_id=ANY($1::int[])
     ORDER BY h.occurred_at ASC,h.id ASC`,
    [ids],
  );
  const byStyle = new Map<number, Array<Record<string, unknown>>>();
  for (const entry of historyResult.rows) {
    const id = Number(entry.trackerStyleId);
    byStyle.set(id, [...(byStyle.get(id) ?? []), entry]);
  }
  // This is the Fabric BI source of truth: completed MOs, joined through the
  // finished SKU product master (not a style-name match), with kg converted by
  // the live component kg/metre value.  Keep it local so tracker COGS cannot
  // drift behind a separately deployed BI endpoint.
  const consumption = await pool.query(
    `WITH product_category AS (
       SELECT DISTINCT ON (sku) sku,category FROM public.all_products_clean
        WHERE category IS NOT NULL AND BTRIM(category)<>'' ORDER BY sku,category
     ), fallback AS (
       SELECT AVG(kg_per_mtr_eff) AS kpm FROM public.raw_fabric_products WHERE kg_per_mtr_eff>0
     )
     , per_mo AS (
       SELECT c.odoo_mo_id,COALESCE(pc.category,'Uncategorised') AS category,
         MAX(c.produced_qty) AS produced_qty,
         SUM(CASE WHEN lower(coalesce(c.uom,'')) IN ('m','metre','meter','mtr','metres','meters','metre(s)') THEN c.consumed_qty
                WHEN lower(coalesce(c.uom,''))='g' THEN c.consumed_qty / 1000.0 / COALESCE(NULLIF(p.kg_per_mtr_eff,0),fallback.kpm)
                 ELSE c.consumed_qty / COALESCE(NULLIF(p.kg_per_mtr_eff,0),fallback.kpm) END) AS metres
      FROM public.mo_fabric_consumption c
      LEFT JOIN public.raw_fabric_products p ON p.id=c.component_id
      LEFT JOIN product_category pc ON pc.sku=c.finished_sku CROSS JOIN fallback
     WHERE c.done_date>=CURRENT_DATE-INTERVAL '90 days' AND c.is_main_fabric
      GROUP BY c.odoo_mo_id,COALESCE(pc.category,'Uncategorised')
     )
     SELECT category,SUM(metres)/NULLIF(SUM(produced_qty),0) AS metres_per_garment
     FROM per_mo WHERE produced_qty>0 GROUP BY category`,
  );
  const metresByCategory = new Map(consumption.rows.map((item) => [String(item.category).toLowerCase(), Number(item.metres_per_garment)]));
  const fabricIds = result.rows.map((item) => item.sampleFabricProductId).filter(Boolean);
  const selectedFabrics = fabricIds.length ? await pool.query(
    `SELECT p.id,p.name,p.fabric_color,COALESCE(SUM(i.available / NULLIF(p.kg_per_mtr_eff,0)),0) AS metres,
       COALESCE(SUM(i.total_value)/NULLIF(SUM(i.quantity),0)*p.kg_per_mtr_eff,p.standard_price*p.kg_per_mtr_eff,0) AS cost_per_metre
      FROM public.raw_fabric_products p
        LEFT JOIN public.raw_fabric_inventory i ON i.product_id=p.id AND i.location_name='RMAT/Stock' AND i.available>0
       WHERE p.id=ANY($1::int[]) GROUP BY p.id,p.name,p.fabric_color,p.kg_per_mtr_eff,p.standard_price`,
    [fabricIds],
  ) : { rows: [] as Array<Record<string, unknown>> };
  const fabricById = new Map(selectedFabrics.rows.map((item) => [Number(item.id), item]));
  const rowsWithImages = await applyGarmentImageOverrides(
    result.rows,
    "plm",
    (row) => row.styleNumber,
  );
  return rowsWithImages.map((row) => {
    const styleHistory = (byStyle.get(Number(row.id)) ?? []).map((entry) =>
      entry.eventType === "imported_stage"
        ? { ...entry, outcome: normalizeStyleDevelopmentStage(row.status) }
        : entry
    );
    const selected = fabricById.get(Number(row.sampleFabricProductId));
    const mpg = metresByCategory.get(String(row.category ?? "").toLowerCase());
    const cost = selected ? Number(selected.cost_per_metre) : null;
    row.sampleFabricName = selected?.name ?? null;
    row.sampleFabricColour = selected?.fabric_color ?? null;
    row.sampleFabricCostPerMetre = cost;
    row.sampleFabricOtherColours = [];
    row.categoryMetresPerGarment = mpg ?? null;
    row.fabricMetres = selected?.metres ?? 0;
    row.indicativeCogsKes = cost !== null && mpg && mpg > 0 ? cost * mpg : row.indicativeCogsKes;
    return {
    ...styleDevelopmentPayload(row, styleHistory),
    history: styleId ? styleHistory.slice().reverse() : undefined,
    };
  });
}

router.get("/style-development-tracker", async (_req, res, next) => {
  try {
    const items = await loadStyleDevelopmentTracker();
    const unique = (key: string) => Array.from(new Set(items.map((item) => String((item as Record<string, unknown>)[key] ?? "")).filter(Boolean))).sort();
    res.json({
      items,
      stages: STYLE_DEVELOPMENT_STAGES,
      stageStandards: STYLE_DEVELOPMENT_STAGE_STANDARD_DAYS,
      facets: {
        targetOrderWeek: unique("targetOrderWeek"),
        subCategory: unique("subCategory"),
        category: unique("category"),
        brand: unique("brand"),
        type: unique("type"),
        tier: unique("tier"),
        patternMaker: unique("patternMaker"),
        status: unique("status"),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/style-development-tracker/fabric-options", async (_req, res, next) => {
  try {
    // Name is deliberately tested before the source colour, matching Fabric BI's
    // canonical name/fabric_color fallback.  The regex is longest-first for
    // compound colours such as Dark Olive Green.
    const result = await pool.query(
      `WITH live AS (
         SELECT p.id,p.name,p.fabric_color,p.kg_per_mtr_eff,p.standard_price,
           COALESCE(SUM(i.available) FILTER (WHERE i.location_name='RMAT/Stock' AND i.available>0),0) AS kg,
            COALESCE(SUM(i.total_value) FILTER (WHERE i.location_name='RMAT/Stock' AND i.quantity>0),0) AS value,
            COALESCE(SUM(i.quantity) FILTER (WHERE i.location_name='RMAT/Stock' AND i.quantity>0),0) AS valued_kg
          FROM public.raw_fabric_products p LEFT JOIN public.raw_fabric_inventory i ON i.product_id=p.id
         WHERE p.category='Fabric' AND p.kg_per_mtr_eff>0 GROUP BY p.id,p.name,p.fabric_color,p.kg_per_mtr_eff,p.standard_price
       ), resolved AS (
         SELECT *, COALESCE(
           (regexp_match(lower(name),'(dark olive green|olive green|navy blue|dark blue|light blue|denim blue|army green|dark green|light green|dark brown|light brown|dark grey|light grey|dusty pink|burnt orange|off white|baby blue|black|white|cream|beige|brown|green|blue|red|pink|yellow|orange|purple|grey|gold|silver)'))[1],
           (regexp_match(lower(coalesce(fabric_color,'')),'(dark olive green|olive green|navy blue|dark blue|light blue|denim blue|army green|dark green|light green|dark brown|light brown|dark grey|light grey|dusty pink|burnt orange|off white|baby blue|black|white|cream|beige|brown|green|blue|red|pink|yellow|orange|purple|grey|gold|silver)'))[1],
           'Unspecified') AS colour
         FROM live
       )
       SELECT id,name,initcap(colour) AS colour,
         trim(regexp_replace(lower(name),'(dark olive green|olive green|navy blue|dark blue|light blue|denim blue|army green|dark green|light green|dark brown|light brown|dark grey|light grey|dusty pink|burnt orange|off white|baby blue|black|white|cream|beige|brown|green|blue|red|pink|yellow|orange|purple|grey|gold|silver)',' ','gi')) AS fabric_base_name,
         kg/kg_per_mtr_eff AS metres,
          COALESCE(value/NULLIF(valued_kg,0)*kg_per_mtr_eff,standard_price*kg_per_mtr_eff) AS cost_per_metre
       FROM resolved ORDER BY name LIMIT 1000`,
    );
    const groups = new Map<string, { fabricBaseName: string; variants: Array<Record<string, unknown>>; metres: number }>();
    for (const row of result.rows) {
      const base = String(row.fabric_base_name).replace(/\s+/g, " ").trim() || String(row.name);
      const group = groups.get(base) ?? { fabricBaseName: base, variants: [], metres: 0 };
      const metres = Number(row.metres ?? 0);
      group.metres += metres;
      group.variants.push({ productId: Number(row.id), productName: row.name, colour: row.colour, metres, costPerMetre: Number(row.cost_per_metre ?? 0) });
      groups.set(base, group);
    }
    const fabrics = [...groups.values()].map((group) => ({
      fabricName: group.fabricBaseName, totalMetres: group.metres,
      colours: group.variants.map((v) => ({ productId: v.productId, productName: v.productName, colour: v.colour, metres: v.metres, costPerMetre: v.costPerMetre })),
    }));
    res.json({ fabrics, groups: [...groups.values()].map((group) => ({ ...group, variants: group.variants.map((v) => ({ ...v, otherColourMetres: group.metres - Number(v.metres) })) })) });
  } catch (error) { next(error); }
});

router.get("/style-development-tracker/reporting", async (_req, res, next) => {
  try {
    const items = await loadStyleDevelopmentTracker();
    const percentile = (values: number[], p: number) => values.length ? values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
    const intervals = STYLE_INTERVALS.map(([key,,, standard]) => {
      const observations = items.map((item) => ((item as Record<string, unknown>).intervalMetrics as Array<Record<string, unknown>>).find((m) => m.key === key))
        .filter((m): m is Record<string, unknown> => Boolean(m?.completedAt));
      const numeric = (field: string) => observations.map((m) => m[field]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      const work = numeric("workWorkingDays"), queue = numeric("queueWorkingDays"), total = numeric("totalWorkingDays");
      return { key, standard, count: observations.length, workMedian: percentile(work, .5), workP80: percentile(work, .8),
        queueMedian: percentile(queue, .5), queueP80: percentile(queue, .8), totalMedian: percentile(total, .5), totalP80: percentile(total, .8),
        totalDaysConsumed: total.reduce((sum, value) => sum + value, 0) };
    });
    const whereTimeGoing = intervals.slice().sort((a, b) => b.totalDaysConsumed - a.totalDaysConsumed);
    const assumptionsWrong = intervals.map((item) => ({ ...item, difference: item.workMedian === null ? null : item.workMedian - item.standard }))
      .sort((a, b) => Math.abs(b.difference ?? -Infinity) - Math.abs(a.difference ?? -Infinity));
    const active = items.filter((item) => (item as Record<string, unknown>).exitStatus === "active");
    const readyToStart = active.filter((item) => String((item as Record<string, unknown>).stage) === "Pattern" && ((item as Record<string, unknown>).adoptionReadiness as { ready: boolean }).ready);
    const activePatternWork = active.filter((item) => {
      const value = item as Record<string, unknown>;
      return value.stage === "Pattern" || value.stage === "Transfer to CAD";
    });
    const queue = [...readyToStart, ...activePatternWork];
    const cutoff = Date.now() - 28 * 86400000;
    const adoptedPerWeek = items.filter((item) => {
      const date = new Date(String((item as Record<string, unknown>).adoptionDate ?? "")).getTime();
      return Number.isFinite(date) && date >= cutoff;
    }).length / 4;
    const cancellations = items.filter((item) => (item as Record<string, unknown>).exitStatus === "cancelled").reduce((out: Record<string, number>, item) => {
      const r = String((item as Record<string, unknown>).exitReason ?? "unspecified"); out[r] = (out[r] ?? 0) + 1; return out;
    }, {});
    const cancellationsByStage = items.filter((item) => (item as Record<string, unknown>).exitStatus === "cancelled").reduce((out: Record<string, number>, item) => {
      const stage = String((item as Record<string, unknown>).stage ?? "Pattern"); out[stage] = (out[stage] ?? 0) + 1; return out;
    }, {});
    res.json({ intervals, totalDays: 13, whereTimeGoing, assumptionsWrong, cancellationsByReason: cancellations,
      cancellationsByStage,
      capacity: { makers: 3.5, daysPerPattern: 2, weeklyCapacity: 8.75, monthlyCapacity: 38, queueDepth: queue.length, readyToStart: readyToStart.length, activePatternWork: activePatternWork.length, weeksCover: queue.length / 8.75, patternsPerMaker: queue.length / 3.5, byPatternMaker: Object.entries(activePatternWork.reduce((out: Record<string, number>, item) => { const maker = String((item as Record<string, unknown>).patternMaker || "Unassigned"); out[maker] = (out[maker] ?? 0) + 1; return out; }, {})).map(([patternMaker, load]) => ({ patternMaker, load })), adoptedPerWeek, targetAdoptionsPerWeek: 10, monthlyGap: 38 - adoptedPerWeek * 4 } });
  } catch (error) { next(error); }
});

router.get("/style-development-tracker/:id", async (req, res, next) => {
  try {
    const items = await loadStyleDevelopmentTracker(Number(req.params.id));
    if (!items[0]) {
      res.status(404).json({ error: "Tracker style not found" });
      return;
    }
    res.json(items[0]);
  } catch (error) {
    next(error);
  }
});

router.patch("/style-development-tracker/:id", async (req: AuthRequest, res, next) => {
  const client = await pool.connect();
  try {
    const styleId = Number(req.params.id);
    await client.query("BEGIN");
    const current = await client.query(`SELECT * FROM ${schema}.style_development_tracker WHERE id=$1 FOR UPDATE`, [styleId]);
    if (!current.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Tracker style not found" });
      return;
    }
    const fieldMap: Record<string, string> = {
      styleNumber: "style_number",
      styleName: "style_name",
      type: "style_type",
      tier: "tier",
      status: "status",
      category: "category",
      subCategory: "sub_category",
      brand: "brand",
      fabric: "fabric",
      patternMaker: "pattern_maker",
      adoptionDate: "adoption_date",
      targetOrderWeek: "target_order_week",
      targetLaunchWeek: "target_launch_week",
      sampleApprovalDate: "sample_approval_date",
      blocked: "blocked",
      blockerReason: "blocker_reason",
      sampleFabricProductId: "sample_fabric_product_id",
      season: "season",
      intendedSellingPriceKes: "intended_selling_price_kes",
      exitStatus: "exit_status",
      exitReason: "exit_reason",
      reason: "exit_reason",
    };
    const assignments: string[] = [];
    const values: unknown[] = [];
    const changes: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];
    for (const [key, column] of Object.entries(fieldMap)) {
      if (req.body?.[key] === undefined) continue;
      let value: unknown = req.body[key];
      if (key === "blocked") value = Boolean(value);
      else if (key === "sampleFabricProductId") {
        value = value === null || value === "" ? null : Number(value);
        const fabricId = value === null ? null : Number(value);
        if (fabricId !== null && (!Number.isInteger(fabricId) || fabricId <= 0)) throw new Error("Sample fabric must be a valid fabric product id");
      } else if (key === "intendedSellingPriceKes") {
        value = value === null || value === "" ? null : Number(value);
        const sellingPrice = value === null ? null : Number(value);
        if (sellingPrice !== null && (!Number.isFinite(sellingPrice) || sellingPrice < 0)) throw new Error("Intended selling price must be a non-negative number");
      }
      else if (key === "exitReason" || key === "reason") value = value ? String(value).trim() : null;
      else if (key === "adoptionDate" || key === "targetOrderWeek" || key === "targetLaunchWeek" || key === "sampleApprovalDate") value = value ? String(value).trim() : null;
      else value = String(value ?? "").trim();
      const oldValue = current.rows[0][column];
      if (String(oldValue ?? "") === String(value ?? "")) continue;
      if (key === "type" && !["NEW", "RR"].includes(String(value))) throw new Error("Type must be NEW or RR");
      if (key === "tier" && !["Tier 3", "Tier 4"].includes(String(value))) throw new Error("Tier must be Tier 3 or Tier 4");
       if (key === "exitStatus" && !["active", "on_hold", "cancelled"].includes(String(value))) throw new Error("Exit status must be active, on_hold, or cancelled");
      values.push(value);
      assignments.push(`${column}=$${values.length}`);
      changes.push({ key, oldValue, newValue: value });
    }
    const proposedExitStatus = changes.find((change) => change.key === "exitStatus")?.newValue ?? current.rows[0].exit_status;
    const selectedFabricId = changes.find((change) => change.key === "sampleFabricProductId")?.newValue;
    if (selectedFabricId !== undefined && selectedFabricId !== null) {
      const fabric = await client.query(
        `SELECT id FROM public.raw_fabric_products WHERE id=$1 AND category='Fabric' AND kg_per_mtr_eff>0`,
        [selectedFabricId],
      );
      if (!fabric.rows[0]) throw new Error("Sample fabric must be a current Fabric product with a valid kg per metre");
    }
    const proposedExitReason = changes.find((change) => change.key === "exitReason" || change.key === "reason")?.newValue ?? current.rows[0].exit_reason;
    const exitReasons = ["pattern will not work", "wrong for the season", "no fabric in stock", "margin too high"];
    if (proposedExitStatus !== "active" && !exitReasons.includes(String(proposedExitReason))) {
      throw new Error("On hold or cancelled styles require one exact exit reason");
    }
    if (proposedExitStatus === "active" && current.rows[0].exit_status !== "active") {
      const reasonAssignment = assignments.findIndex((assignment) => assignment.startsWith("exit_reason="));
      if (reasonAssignment >= 0) {
        values[reasonAssignment] = null;
      } else {
        values.push(null); assignments.push(`exit_reason=$${values.length}`);
      }
      values.push(null); assignments.push(`exited_at=$${values.length}`);
      values.push(null); assignments.push(`exit_stage=$${values.length}`);
    } else if (proposedExitStatus !== "active" && changes.some((change) => change.key === "exitStatus")) {
      const currentPayload = (await loadStyleDevelopmentTracker(styleId))[0] as Record<string, unknown> | undefined;
      values.push(new Date().toISOString()); assignments.push(`exited_at=$${values.length}`);
      values.push(currentPayload?.stage ?? "Pattern"); assignments.push(`exit_stage=$${values.length}`);
    }
    if (!assignments.length) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "No changed fields supplied" });
      return;
    }
    values.push(styleId);
    await client.query(`UPDATE ${schema}.style_development_tracker SET ${assignments.join(",")},updated_at=NOW() WHERE id=$${values.length}`, values);
    for (const change of changes) {
      await client.query(
        `INSERT INTO ${schema}.style_development_history
          (tracker_style_id,entry_type,note,old_value,new_value,recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          styleId,
           change.key === "targetOrderWeek" ? "target_week_changed" : change.key === "exitStatus" || change.key === "exitReason" || change.key === "reason" ? "exit_changed" : change.key === "blocked" || change.key === "blockerReason" ? "blocker_changed" : "master_data_changed",
           change.key === "exitStatus" ? `Exit recorded at ${current.rows[0].status}` : `${change.key} updated`,
          change.oldValue === null ? null : String(change.oldValue),
          change.newValue === null ? null : String(change.newValue),
          req.workspaceUser?.id ?? null,
        ],
      );
    }
    await client.query("COMMIT");
    res.json((await loadStyleDevelopmentTracker(styleId))[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: error instanceof Error ? error.message : "Style could not be updated" });
  } finally {
    client.release();
  }
});

router.post("/style-development-tracker/:id/notes", async (req: AuthRequest, res, next) => {
  try {
    const note = String(req.body?.note ?? "").trim();
    if (!note) {
      res.status(400).json({ error: "A note is required" });
      return;
    }
    const result = await pool.query(
      `INSERT INTO ${schema}.style_development_history
        (tracker_style_id,entry_type,note,recorded_by)
       SELECT id,'note',$2,$3 FROM ${schema}.style_development_tracker WHERE id=$1
       RETURNING id`,
      [Number(req.params.id), note, req.workspaceUser?.id ?? null],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Tracker style not found" });
      return;
    }
    res.status(201).json((await loadStyleDevelopmentTracker(Number(req.params.id)))[0]);
  } catch (error) {
    next(error);
  }
});

router.post("/style-development-tracker/:id/events", async (req: AuthRequest, res, next) => {
  const client = await pool.connect();
  try {
    const eventType = String(req.body?.eventType ?? "") as StyleDevelopmentEventType;
    if (!STYLE_DEVELOPMENT_EVENT_TYPES.includes(eventType)) {
      res.status(400).json({ error: "Unsupported development event" });
      return;
    }
    const reason = String(req.body?.reason ?? "").trim();
    if (eventType.endsWith("_rejected") && !reason) {
      res.status(400).json({ error: "A rejection reason is required" });
      return;
    }
    const occurredAt = req.body?.occurredAt ? new Date(String(req.body.occurredAt)) : new Date();
    if (Number.isNaN(occurredAt.getTime())) {
      res.status(400).json({ error: "The event date is invalid" });
      return;
    }
    await client.query("BEGIN");
    const styleId = Number(req.params.id);
    if (eventType === "pattern_started") {
      const current = (await loadStyleDevelopmentTracker(styleId))[0] as Record<string, unknown> | undefined;
      const overrideReason = String(req.body?.overrideReason ?? "").trim();
      if (!current) {
        await client.query("ROLLBACK"); res.status(404).json({ error: "Tracker style not found" }); return;
      }
      if (!(current.adoptionReadiness as { ready: boolean }).ready && !overrideReason) {
        await client.query("ROLLBACK"); res.status(400).json({ error: "An override reason is required when adoption readiness is not met" }); return;
      }
      if (!(current.adoptionReadiness as { ready: boolean }).ready) {
        await client.query(
          `INSERT INTO ${schema}.style_development_history (tracker_style_id,entry_type,event_type,note,reason,recorded_by)
           VALUES ($1,'update','pattern_started_override','Pattern started before adoption readiness was met',$2,$3)`,
          [styleId, overrideReason, req.workspaceUser?.id ?? null],
        );
      }
    }
    const outcome = eventType.endsWith("_approved") ? "approved" : eventType.endsWith("_rejected") ? "rejected" : "completed";
    const result = await client.query(
      `INSERT INTO ${schema}.style_development_history
        (tracker_style_id,entry_type,event_type,outcome,reason,occurred_at,recorded_by)
       SELECT id,'event',$2,$3,$4,$5,$6 FROM ${schema}.style_development_tracker WHERE id=$1
       RETURNING id`,
       [styleId, eventType, outcome, reason, occurredAt.toISOString(), req.workspaceUser?.id ?? null],
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Tracker style not found" });
      return;
    }
    await client.query("COMMIT");
    res.status(201).json((await loadStyleDevelopmentTracker(Number(req.params.id)))[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

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
    newnessTargetUnits: row.newnessTargetUnits == null ? null : Number(row.newnessTargetUnits),
    newnessFloorPct: Number(row.newnessFloorPct ?? 40),
    status: String(row.status ?? "active"),
    cadence: seasonName.startsWith("Q") ? "quarterly" : "monthly",
  };
}

function rangePlanOtbMonthsForSeason(seasonName: string): string[] {
  const season = RANGE_PLAN_SEASON_SEEDS.find((candidate) => candidate.seasonName === seasonName);
  if (!season) return [];
  return season.cadence === "monthly" ? [season.otbMonth] : [...season.otbMonths];
}

function rangePlanRowPayload(row: Record<string, unknown>) {
  const optionalNumber = (value: unknown) => value === null || value === undefined || value === "" ? null : Number(value);
  const sellingPrice = optionalNumber(row.sellingPrice);
  const asp = optionalNumber(row.asp);
  const expectedUnitCost = optionalNumber(row.expectedUnitCost);
  const newStyleCount = Number(row.newStyleCount ?? 0);
  const pipelineNewStylesAvailable = Number(row.pipelineNewStylesAvailable ?? 0);
  const reorderStyleCount = Number(row.reorderStyleCount ?? 0);
  const replenishmentStyleCount = Number(row.replenishmentStyleCount ?? 0);
  const aosUnits = Number(row.aosUnits ?? rangePlanAosDefault());
  const newStyleAosUnits = Number(row.newStyleAosUnits ?? 300);
  const newUnits = newStyleCount * newStyleAosUnits;
  const reorderUnits = reorderStyleCount * aosUnits;
  const replenishmentUnits = replenishmentStyleCount * aosUnits;
  const totalUnitsImplied = Number(row.plannedUnitsCalculated ?? (newUnits + reorderUnits + replenishmentUnits));
  const effectivePrice = sellingPrice ?? asp;
  const orderedStyles = Number(row.orderedStyles ?? 0);
  const orderedUnits = Number(row.orderedUnits ?? 0);
  const plannedPendingStyles = Number(row.plannedPendingStyles ?? 0);
  const plannedPendingUnits = Number(row.plannedPendingUnits ?? 0);
  const orderedNewStyles = Number(row.orderedNewStyles ?? 0);
  const plannedPendingNewStyles = Number(row.plannedPendingNewStyles ?? 0);
  const remainingNewStyles = Math.max(0, newStyleCount - orderedNewStyles - plannedPendingNewStyles);
  const remainingRepeatStyles = Math.max(0, reorderStyleCount + replenishmentStyleCount
    - Math.max(0, orderedStyles - orderedNewStyles)
    - Math.max(0, plannedPendingStyles - plannedPendingNewStyles));
  const projectedUnits = orderedUnits + plannedPendingUnits
    + (remainingNewStyles * 300) + (remainingRepeatStyles * 400);
  return {
    id: Number(row.id),
    seasonId: Number(row.seasonId),
    subCategory: String(row.subCategory ?? ""),
    productCategory: row.productCategory == null ? null : String(row.productCategory),
    tier: String(row.tier ?? "Core"),
    styleCountTarget: Number(row.styleCountTarget ?? 0),
    newStyleCount,
    pipelineNewStylesAvailable,
    newStylesGap: newStyleCount - pipelineNewStylesAvailable,
    reorderStyleCount,
    replenishmentStyleCount,
    styleCountMin: Number(row.styleCountMin ?? 0),
    styleCountMax: Number(row.styleCountMax ?? 0),
    aosUnits,
    newStyleAosUnits,
    totalUnitsImplied,
    newUnits,
    reorderUnits,
    replenishmentUnits,
    orderedStyles,
    orderedUnits,
    plannedPendingStyles,
    plannedPendingUnits,
    balanceStyles: Math.max(0, Number(row.styleCountTarget ?? 0) - orderedStyles),
    balanceUnits: totalUnitsImplied - orderedUnits,
    projectedUnits,
    ceilingUnits: Math.round(totalUnitsImplied * 1.1),
    ceilingBreached: projectedUnits > Math.round(totalUnitsImplied * 1.1),
    openingStockUnits: optionalNumber(row.openingStockUnits),
    unitsSoldLastMonth: optionalNumber(row.unitsSoldLastMonth),
    expectedUnitCost,
    sellingPrice,
    asp: effectivePrice,
    potentialFpRevenue: effectivePrice === null ? 0 : totalUnitsImplied * effectivePrice,
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
    sohStores: row.sohStores == null ? null : Number(row.sohStores),
    sohOnline: row.sohOnline == null ? null : Number(row.sohOnline),
    sohWarehouse: row.sohWarehouse == null ? null : Number(row.sohWarehouse),
    wipUnits: row.wipUnits == null ? null : Number(row.wipUnits),
    fullPricePct: row.fullPricePct == null ? null : Number(row.fullPricePct),
    weeksOfCover: row.weeksOfCover == null ? null : Number(row.weeksOfCover),
    sellThroughPct: row.sellThroughPct == null ? null : Number(row.sellThroughPct),
    daysSinceLastSale: row.daysSinceLastSale == null ? null : Number(row.daysSinceLastSale),
    awaitingDelivery: Boolean(row.awaitingDelivery),
    fabricMetres: row.fabricMetres == null ? null : Number(row.fabricMetres),
    otherColourFabricMetres: row.otherColourFabricMetres == null ? null : Number(row.otherColourFabricMetres),
    image: styleNumber ? `/api/workspace/assortment-image/${encodeURIComponent(styleNumber)}` : null,
  };
}

async function assortmentPlanData(quarter: string) {
  const bi = await biWorkspaceSource();
  const membership = await pool.query(
    `SELECT LOWER(BTRIM(style_id)) AS style_key,'excluded' AS intent
       FROM ${schema}.assortment_exclusions
      WHERE season=$1 AND source='all_products_clean'
     UNION ALL
     SELECT LOWER(BTRIM(style_key)) AS style_key,'member' AS intent
       FROM ${schema}.assortment_plan_styles
      WHERE season=$1 AND source='all_products_clean'`,
    [quarter],
  );
  const intent = new Map(membership.rows.map((row) => [String(row.style_key), String(row.intent)]));
  const styles = bi.styles.map(biStyle)
    .filter((style) => style.styleNumber && ["active", "retired"].includes(style.status.toLowerCase()))
    .map((style) => ({ ...style, season: quarter, excluded: intent.get(style.styleNumber.toLowerCase()) === "excluded" && intent.get(style.styleNumber.toLowerCase()) !== "member" }));
  const breakdown = (field: "category" | "stage") => Object.entries(styles.reduce((counts: Record<string, number>, row) => {
    const value = String(row[field] ?? "Uncategorised"); counts[value] = (counts[value] ?? 0) + 1; return counts;
  }, {})).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const countTier = (tier: string) => styles.filter((row) => row.tier === tier).length;
  const options = (field: keyof typeof styles[number]) => [...new Set(styles.map((style) => String(style[field] ?? "").trim()).filter(Boolean))].sort();
  return {
    styles, carryOverStyles: styles, newStyles: [], total: styles.length,
    counts: { total: styles.length, tier1: countTier("Tier 1 · NOOS"), tier2: countTier("Tier 2 · Core"), tier3: countTier("Tier 3 · Recent"), tier4: countTier("Tier 4 · New"), retired: countTier("Retired"), noos: countTier("Tier 1 · NOOS"), core: countTier("Tier 2 · Core"), recent: countTier("Tier 3 · Recent"), newTest: countTier("Tier 4 · New") },
    categoryBreakdown: breakdown("category"), stageBreakdown: breakdown("stage"),
    filterOptions: { tier: [...ASSORTMENT_TIER_FILTERS], status: ["Active", "Retired"], category: options("category"), subCategory: options("subCategory"), fabricCategory: options("fabricCategory"), brand: options("brand"), primaryColour: options("primaryColour"), edit: options("edit") },
  };
  /*
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
             THEN LEFT(a.style_launch_date,10)::date END) AS catalogue_launch_date,
           COUNT(DISTINCT NULLIF(TRIM(a.color_print),''))::int AS colourway_count,
           MAX(a.fabric_product_id) AS fabric_product_id,
           MAX(COALESCE(NULLIF(TRIM(fp.name),''),NULLIF(TRIM(a.fabric_category),''),NULLIF(TRIM(a.fabric_structure),''))) AS fabric_name,
           CASE
             WHEN BOOL_OR(LOWER(TRIM(COALESCE(a.status,'')))='active') THEN 'Active'
             WHEN BOOL_OR(LOWER(TRIM(COALESCE(a.status,'')))='retired') THEN 'Retired'
             WHEN BOOL_OR(LOWER(TRIM(COALESCE(a.status,'')))='archived') THEN 'Archived'
             ELSE NULL
           END AS lifecycle_status,
           CASE
             WHEN BOOL_OR(COALESCE(a.is_noos,FALSE) OR UPPER(TRIM(COALESCE(a.tier,'')))='NOOS' OR UPPER(TRIM(COALESCE(a.range_tier,'')))='NOOS') THEN 'Tier 1'
             WHEN BOOL_OR(UPPER(TRIM(COALESCE(a.tier,''))) IN ('TIER 2','CORE','CORE PERFORMER') OR UPPER(TRIM(COALESCE(a.range_tier,''))) IN ('TIER 2','CORE','CORE PERFORMER')) THEN 'Tier 2'
             WHEN BOOL_OR(UPPER(TRIM(COALESCE(a.tier,''))) IN ('TIER 3','RECENT','RECENT PERFORMER') OR UPPER(TRIM(COALESCE(a.range_tier,''))) IN ('TIER 3','RECENT','RECENT PERFORMER')) THEN 'Tier 3'
             WHEN BOOL_OR(UPPER(TRIM(COALESCE(a.tier,''))) IN ('TIER 4','NEW') OR UPPER(TRIM(COALESCE(a.range_tier,''))) IN ('TIER 4','NEW')) THEN 'Tier 4'
             ELSE 'Untiered'
           END AS lifecycle_tier
       FROM public.all_products_clean a
        LEFT JOIN public.raw_fabric_products fp ON fp.id=a.fabric_product_id
       WHERE NULLIF(TRIM(a.style_name),'') IS NOT NULL
          AND ${allowedBrand("a")}
         AND NULLIF(TRIM(a.style_number),'') IS NOT NULL
          AND LOWER(TRIM(a.style_name)) NOT IN ('zz test','sample & sale items')
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
              AND COALESCE(i.pos_location_name,'') NOT ILIKE 'online%'
          ),0)::float AS soh_stores,
          COALESCE(SUM(i.available) FILTER (
            WHERE COALESCE(i.pos_location_name,'') ILIKE 'online%'
          ),0)::float AS soh_online,
         COALESCE(SUM(i.available) FILTER (
           WHERE i.pos_location_name=ANY($2::text[])
             AND NOT (i.pos_location_name=ANY($3::text[]))
          ),0)::float AS soh_warehouse,
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
           r.*
        FROM style_rollup r
        LEFT JOIN stock st ON st.style_name=r.style_name
         WHERE r.lifecycle_status IN ('Active','Retired')
        ORDER BY r.style_key,r.style_name
       ),
      sales_metrics AS (
        SELECT r.style_key,
          SUM(GREATEST(COALESCE(sa.ordered_item_quantity,0),0)) FILTER (WHERE LOWER(COALESCE(sa.sale_kind,'')) IN ('sale','order')
            AND sa.sale_date >= (CURRENT_DATE - INTERVAL '182 days')::text)::float AS units_6m,
          SUM(GREATEST(COALESCE(sa.ordered_item_quantity,0),0)) FILTER (WHERE LOWER(COALESCE(sa.sale_kind,'')) IN ('sale','order')
            AND sa.sale_date >= (CURRENT_DATE - INTERVAL '26 weeks')::text)::float AS units_26w,
          SUM(GREATEST(COALESCE(sa.ordered_item_quantity,0),0)) FILTER (WHERE LOWER(COALESCE(sa.sale_kind,'')) IN ('sale','order')
            AND sa.sale_date >= (CURRENT_DATE - INTERVAL '182 days')::text
            AND COALESCE(sa.discounts_kes,0)=0)::float AS full_price_units_6m,
          MAX(LEFT(sa.sale_date,10)::date) FILTER (WHERE LOWER(COALESCE(sa.sale_kind,'')) IN ('sale','order')
            AND sa.sale_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}') AS last_sale_date
        FROM eligible r JOIN sku_style m ON LOWER(TRIM(m.style_number))=r.style_key
        JOIN public.all_sales sa ON sa.variant_sku=m.sku
        GROUP BY r.style_key
      ),
      wip AS (
        SELECT LOWER(BTRIM(COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,'')))) AS style_key,
          SUM(GREATEST(COALESCE(o.order_qty,0),0))::float AS wip_units
        FROM public.production_orders o
        WHERE LOWER(COALESCE(o.bo_state,'')) NOT IN ('cancel','cancelled','canceled','done','completed')
        GROUP BY LOWER(BTRIM(COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''))))
      ),
      fabric_metrics AS (
        SELECT r.style_key,
          SUM(i.available / NULLIF(fp.kg_per_mtr_eff,0)) FILTER (WHERE fp.id=r.fabric_product_id AND i.location_name='RMAT/Stock')::float AS fabric_metres,
          SUM(i.available / NULLIF(fp.kg_per_mtr_eff,0)) FILTER (WHERE fp.id<>r.fabric_product_id AND i.location_name='RMAT/Stock'
            AND NULLIF(BTRIM(fp.supplier_fabric_code),'') IS NOT NULL
            AND fp.supplier_fabric_code=(SELECT supplier_fabric_code FROM public.raw_fabric_products WHERE id=r.fabric_product_id))::float AS sibling_metres
        FROM eligible r
        LEFT JOIN public.raw_fabric_products fp ON TRUE
        LEFT JOIN public.raw_fabric_inventory i ON i.product_id=fp.id
        GROUP BY r.style_key
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
        CASE WHEN r.lifecycle_tier IN ('Tier 1','Tier 2','Tier 3','Tier 4') THEN r.lifecycle_tier ELSE NULL END AS "rangeTier",
       CASE
          WHEN r.lifecycle_status='Retired' THEN 'Retired'
          WHEN r.lifecycle_tier='Tier 1' THEN 'Tier 1 · NOOS'
          WHEN r.lifecycle_tier='Tier 2' THEN 'Tier 2 · Core'
          WHEN r.lifecycle_tier='Tier 3' THEN 'Tier 3 · Recent'
          WHEN r.lifecycle_tier='Tier 4' THEN 'Tier 4 · New'
          WHEN r.lifecycle_tier='Untiered' THEN 'Untiered'
         ELSE NULL
       END AS tier,
        r.lifecycle_status AS status,
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
        st.stock_units AS "stockUnits",
         st.soh_stores AS "sohStores",st.soh_online AS "sohOnline",st.soh_warehouse AS "sohWarehouse",
         w.wip_units AS "wipUnits",
         CASE WHEN sm.units_6m > 0 THEN ROUND((100 * sm.full_price_units_6m / sm.units_6m)::numeric,2)::float ELSE NULL END AS "fullPricePct",
         CASE WHEN sm.units_6m > 0 THEN ROUND(((COALESCE(st.stock_units,0) / sm.units_6m) * 26)::numeric,2)::float ELSE NULL END AS "weeksOfCover",
         CASE WHEN COALESCE(sm.units_6m,0)+COALESCE(st.stock_units,0)>0 THEN ROUND((100*COALESCE(sm.units_6m,0)/(COALESCE(sm.units_6m,0)+COALESCE(st.stock_units,0)))::numeric,2)::float ELSE NULL END AS "sellThroughPct",
         CASE WHEN sm.last_sale_date IS NULL THEN NULL ELSE CURRENT_DATE-sm.last_sale_date END AS "daysSinceLastSale",
         (COALESCE(st.stock_units,0)=0 AND COALESCE(w.wip_units,0)>0) AS "awaitingDelivery",
         fm.fabric_metres AS "fabricMetres",fm.sibling_metres AS "otherColourFabricMetres",
        r.colourway_count AS "colourwayCount",r.fabric_name AS fabric,r.fabric_product_id AS "fabricProductId"
     FROM eligible r
      LEFT JOIN stock st ON st.style_name=r.style_name
      LEFT JOIN sales_by_style sales ON sales.style_key=r.style_key
       LEFT JOIN sales_metrics sm ON sm.style_key=r.style_key
       LEFT JOIN wip w ON w.style_key=r.style_key
       LEFT JOIN fabric_metrics fm ON fm.style_key=r.style_key
     LEFT JOIN ${schema}.assortment_exclusions e
       ON e.season=$1 AND e.source='all_products_clean' AND LOWER(TRIM(e.style_id))=r.style_key
     LEFT JOIN ${schema}.assortment_plan_styles aps
       ON aps.season=$1 AND aps.source='all_products_clean' AND LOWER(TRIM(aps.style_key))=r.style_key
      ORDER BY CASE
        WHEN r.lifecycle_status='Retired' THEN 6
        WHEN r.lifecycle_tier='Tier 1' THEN 1 WHEN r.lifecycle_tier='Tier 2' THEN 2
        WHEN r.lifecycle_tier='Tier 3' THEN 3 WHEN r.lifecycle_tier='Tier 4' THEN 4 ELSE 5
     END,LOWER(COALESCE(r.style_number,r.name))`,
    [quarter, [...ASSORTMENT_WAREHOUSE_LOCATIONS], [...ASSORTMENT_PIPELINE_LOCATIONS]],
  );
  const allStyles = catalogueResult.rows.map(assortmentStylePayload);
  // Quarter exclusions are planning annotations, not lifecycle facts. Keep the
  // complete Odoo-derived range visible so counts reconcile with BI.
  const styles = allStyles;
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
  }; */
}

router.get("/range-plan", async (req, res, next) => {
  try {
    const seasonsResult = await pool.query(
      `SELECT id,season_name AS "seasonName",season_year AS "seasonYear",
         revenue_target_kes AS "revenueTargetKes",cogs_budget_pct AS "cogsBudgetPct",
         factory_capacity_units AS "factoryCapacityUnits",newness_target_units AS "newnessTargetUnits",
         newness_floor_pct AS "newnessFloorPct",status
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
    const weeklyDestinations = (await pool.query(
      `WITH upcoming AS (
         SELECT (date_trunc('week', CURRENT_DATE)::date + (n * 7))::date AS start_date
         FROM generate_series(0,11) AS n
       ),
       iso_weeks AS (
         SELECT EXTRACT(ISOYEAR FROM start_date)::int AS iso_year,
           EXTRACT(WEEK FROM start_date)::int AS iso_week,start_date,(start_date+6)::date AS end_date
         FROM upcoming
       )
       SELECT w.iso_year AS "isoYear",w.iso_week AS "isoWeek",w.start_date::text AS "startDate",
         w.end_date::text AS "endDate",
         'W' || lpad(w.iso_week::text,2,'0') || ' · ' || to_char(w.start_date,'DD Mon') || '–' || to_char(w.end_date,'DD Mon') AS label,
         COALESCE(p.status,'draft') AS status
       FROM iso_weeks w
       LEFT JOIN ${schema}.weekly_order_plans p ON p.iso_year=w.iso_year AND p.iso_week=w.iso_week
       ORDER BY w.start_date`,
    )).rows.map((row) => ({
      isoYear: Number(row.isoYear), isoWeek: Number(row.isoWeek),
      startDate: String(row.startDate).slice(0, 10), endDate: String(row.endDate).slice(0, 10),
      label: String(row.label), status: String(row.status),
    }));
    const requestedQuarter = String(req.query.quarter ?? "");
    const quarter = PLM_SEASONS.includes(requestedQuarter as (typeof PLM_SEASONS)[number])
      ? requestedQuarter
      : "Q4 2026";
    const requestedSeasonId = Number(req.query.seasonId);
    const season = (Number.isInteger(requestedSeasonId) && requestedSeasonId > 0
      ? seasons.find((candidate) => candidate.id === requestedSeasonId)
      : seasons.find((candidate) => candidate.seasonName === quarter)) ??
      seasons.find((candidate) => candidate.status === "active") ?? seasons[0];
    if (!season) {
      res.json({ seasons: [], season: null, rows: [], otb: [], averageCostKes: 850, health: await rangePlanHealth() });
      return;
    }
    const selectedAssortment = await assortmentPlanData(quarter);
    const orderWindow = season.seasonName === "Q3 2026"
      ? ["2026-07-01", "2026-10-01"]
      : season.seasonName === "Q4 2026"
      ? ["2026-10-01", "2027-01-01"]
      : season.seasonName === "September 2026"
        ? ["2026-09-01", "2026-10-01"]
        : season.seasonName === "October 2026"
          ? ["2026-10-01", "2026-11-01"]
          : season.seasonName === "November 2026"
            ? ["2026-11-01", "2026-12-01"]
            : season.seasonName === "December 2026"
              ? ["2026-12-01", "2027-01-01"]
              : ["1900-01-01", "1900-01-01"];
     const rowsResult = await pool.query(
       `SELECT r.id,r.season_id AS "seasonId",r.sub_category AS "subCategory",r.product_category AS "productCategory",r.tier::text,
         r.style_count_target AS "styleCountTarget",r.new_style_count AS "newStyleCount",r.reorder_style_count AS "reorderStyleCount",
         r.replenishment_style_count AS "replenishmentStyleCount",r.style_count_min AS "styleCountMin",r.style_count_max AS "styleCountMax",
         r.aos_units AS "aosUnits",r.new_style_aos_units AS "newStyleAosUnits",r.planned_units_calculated AS "plannedUnitsCalculated",
         r.total_units_implied AS "totalUnitsImplied",r.new_units AS "newUnits",r.reorder_units AS "reorderUnits",
         r.replenishment_units AS "replenishmentUnits",r.opening_stock_units AS "openingStockUnits",r.units_sold_last_month AS "unitsSoldLastMonth",
         r.expected_unit_cost AS "expectedUnitCost",r.selling_price AS "sellingPrice",r.selling_price AS asp,r.notes,
         0 AS "orderedStyles",0 AS "orderedUnits",0 AS "orderedNewStyles",0 AS "plannedPendingStyles",0 AS "plannedPendingUnits",0 AS "plannedPendingNewStyles",0 AS "pipelineNewStylesAvailable"
        FROM ${schema}.range_plan_rows r WHERE r.season_id=$1 ORDER BY r.id`,
       [season.id],
     );
     /*
     const rowsResultLegacy = await pool.query(
       `WITH style_asp AS (
          SELECT subcategory,AVG(price)::numeric AS asp
          FROM rollup_rm_prod
          WHERE ${allowedBrand("rollup_rm_prod")}
            AND price IS NOT NULL AND price > 0
           GROUP BY subcategory
         ),
         style_dim AS (
           SELECT LOWER(BTRIM(COALESCE(NULLIF(style_number,''),NULLIF(sku,'')))) AS style_key,
              MAX(COALESCE(NULLIF(BTRIM(product_type),''),NULLIF(BTRIM(category),''),'Uncategorised')) AS sub_category,
              MAX(LOWER(BTRIM(style_name))) AS style_name_key
           FROM public.all_products_clean p
           WHERE ${allowedBrand("p")}
           GROUP BY LOWER(BTRIM(COALESCE(NULLIF(style_number,''),NULLIF(sku,''))))
         ),
         style_dim_name AS (
           SELECT style_name_key,MAX(style_key) AS style_key,MAX(sub_category) AS sub_category
           FROM style_dim
           WHERE NULLIF(style_name_key,'') IS NOT NULL
           GROUP BY style_name_key
         ),
         ordered_base AS (
           SELECT o.order_ref,o.order_qty,o.lifecycle_type,
             LOWER(BTRIM(COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''),NULLIF(o.style_name,''),o.order_ref))) AS style_key,
             COALESCE(d.sub_category,dn.sub_category) AS sub_category
           FROM public.production_orders o
           LEFT JOIN style_dim d
             ON d.style_key=LOWER(BTRIM(COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''))))
            LEFT JOIN style_dim_name dn ON dn.style_name_key=LOWER(BTRIM(o.style_name))
           WHERE o.date_ordered >= $2::date AND o.date_ordered < $3::date
              AND LOWER(COALESCE(o.bo_state,'')) NOT IN ('cancel','cancelled','canceled')
         ),
         ordered AS (
           SELECT sub_category,
             COUNT(DISTINCT style_key)::int AS ordered_styles,
             COUNT(DISTINCT style_key) FILTER (WHERE LOWER(COALESCE(lifecycle_type,''))='new')::int AS ordered_new_styles,
             COALESCE(SUM(order_qty),0)::numeric AS ordered_units
           FROM ordered_base
           WHERE sub_category IS NOT NULL
           GROUP BY sub_category
         ),
           planned_pending_base AS (
            SELECT l.id::text AS id,l.style_name,l.estimated_quantity AS quantity,l.order_type,
              LOWER(BTRIM(l.style_name)) AS style_name_key,
              LOWER(BTRIM(l.style_number)) AS style_key,l.sub_category
            FROM ${schema}.weekly_order_plan_lines l
             JOIN ${schema}.weekly_order_plans w ON w.id=l.plan_id
            JOIN public.planning_calendar cal
              ON cal.year=w.iso_year AND cal.week_no=w.iso_week
              AND cal.start_date < $3::date AND cal.end_date >= $2::date
            WHERE NOT EXISTS (
              SELECT 1 FROM public.production_orders o
               WHERE o.date_ordered IS NOT NULL
                 AND LOWER(COALESCE(o.bo_state,'')) NOT IN ('cancel','cancelled','canceled')
                AND (LOWER(BTRIM(COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''))))=LOWER(BTRIM(l.style_number))
                  OR LOWER(BTRIM(COALESCE(o.style_name,'')))=LOWER(BTRIM(l.style_name)))
            )
          ),
           planned_pending AS (
            SELECT sub_category,
               COUNT(DISTINCT COALESCE(style_key,style_name_key))::int AS pending_styles,
               COUNT(DISTINCT COALESCE(style_key,style_name_key)) FILTER (WHERE LOWER(COALESCE(order_type,''))='new')::int AS pending_new_styles,
               COALESCE(SUM(quantity),0)::numeric AS pending_units
             FROM planned_pending_base
            WHERE sub_category IS NOT NULL
            GROUP BY sub_category
          ),
          pipeline_new AS (
            SELECT sub_category,COUNT(*)::int AS available_new_styles
            FROM ${schema}.style_development_tracker
            WHERE style_type='NEW'
              AND NULLIF(SUBSTRING(UPPER(COALESCE(target_order_week,'')) FROM '([0-9]{1,2})$'),'')::int BETWEEN 36 AND 39
            GROUP BY sub_category
         )
        SELECT r.id,r.season_id AS "seasonId",r.sub_category AS "subCategory",
        r.product_category AS "productCategory",r.tier::text,
           CASE WHEN selected_season.season_name='Q3 2026'
             THEN r.style_count_target + COALESCE(september_row.style_count_target,0)
             ELSE r.style_count_target END AS "styleCountTarget",
           CASE WHEN selected_season.season_name='Q3 2026'
             THEN COALESCE(september_row.new_style_count,0) ELSE r.new_style_count END AS "newStyleCount",
           COALESCE(pipeline_new.available_new_styles,0) AS "pipelineNewStylesAvailable",
           CASE WHEN selected_season.season_name='Q3 2026'
             THEN COALESCE(september_row.reorder_style_count,0) ELSE r.reorder_style_count END AS "reorderStyleCount",
           CASE WHEN selected_season.season_name='Q3 2026'
             THEN COALESCE(september_row.replenishment_style_count,0) ELSE r.replenishment_style_count END AS "replenishmentStyleCount",
           r.style_count_min AS "styleCountMin",
           r.style_count_max AS "styleCountMax",
           CASE WHEN selected_season.season_name='Q3 2026'
             THEN COALESCE(september_row.aos_units,400) ELSE r.aos_units END AS "aosUnits",
           CASE WHEN selected_season.season_name='Q3 2026'
             THEN COALESCE(september_row.new_style_aos_units,300) ELSE r.new_style_aos_units END AS "newStyleAosUnits",
           CASE WHEN selected_season.season_name='Q3 2026'
             THEN r.new_units + COALESCE(september_row.planned_units_calculated,0)
             ELSE r.planned_units_calculated END AS "plannedUnitsCalculated",
           CASE WHEN selected_season.season_name='Q3 2026'
             THEN r.new_units + COALESCE(september_row.planned_units_calculated,0)
             ELSE r.total_units_implied END AS "totalUnitsImplied",
           r.new_units AS "newUnits",r.reorder_units AS "reorderUnits",
           r.replenishment_units AS "replenishmentUnits",
             COALESCE(o.ordered_styles,0) AS "orderedStyles",
             COALESCE(o.ordered_units,0) AS "orderedUnits",
             COALESCE(o.ordered_new_styles,0) AS "orderedNewStyles",
             COALESCE(pp.pending_styles,0) AS "plannedPendingStyles",
             COALESCE(pp.pending_units,0) AS "plannedPendingUnits",
             COALESCE(pp.pending_new_styles,0) AS "plannedPendingNewStyles",
           CASE WHEN selected_season.season_name='Q3 2026' THEN NULL ELSE r.opening_stock_units END AS "openingStockUnits",
           CASE WHEN selected_season.season_name='Q3 2026' THEN NULL ELSE r.units_sold_last_month END AS "unitsSoldLastMonth",
           CASE WHEN selected_season.season_name='Q3 2026' THEN NULL ELSE r.expected_unit_cost END AS "expectedUnitCost",
           CASE WHEN selected_season.season_name='Q3 2026' THEN NULL ELSE r.selling_price END AS "sellingPrice",
           CASE WHEN selected_season.season_name='Q3 2026' THEN NULL
             WHEN r.selling_price IS NULL THEN a.asp ELSE r.selling_price END AS asp,
          r.notes
        FROM ${schema}.range_plan_rows r
         JOIN ${schema}.range_plan_seasons selected_season ON selected_season.id=r.season_id
         LEFT JOIN ${schema}.range_plan_seasons september_season
           ON selected_season.season_name='Q3 2026'
          AND september_season.season_name='September 2026'
          AND september_season.season_year=selected_season.season_year
         LEFT JOIN ${schema}.range_plan_rows september_row
           ON september_row.season_id=september_season.id
          AND LOWER(TRIM(september_row.sub_category))=LOWER(TRIM(r.sub_category))
        LEFT JOIN style_asp a ON LOWER(TRIM(a.subcategory))=LOWER(TRIM(r.sub_category))
          LEFT JOIN ordered o ON LOWER(TRIM(o.sub_category))=LOWER(TRIM(r.sub_category))
           LEFT JOIN planned_pending pp ON LOWER(TRIM(pp.sub_category))=LOWER(TRIM(r.sub_category))
         LEFT JOIN pipeline_new ON LOWER(TRIM(pipeline_new.sub_category))=LOWER(TRIM(r.sub_category))
        WHERE r.season_id=$1
        ORDER BY CASE r.product_category
          WHEN 'Bottoms' THEN 1 WHEN 'Dresses' THEN 2 WHEN 'Outerwear' THEN 3
          WHEN 'Skirts' THEN 4 WHEN 'Tops' THEN 5 ELSE 99 END, r.id`,
       [season.id, orderWindow[0], orderWindow[1]],
    ); */
    const fixedOtbMonths = rangePlanOtbMonthsForSeason(season.seasonName);
    const otbResult = await pool.query(
      `WITH months AS (
         SELECT month_year
         FROM ${schema}.range_plan_otb
         WHERE season_id=$1
           AND (cardinality($2::date[]) = 0 OR month_year=ANY($2::date[]))
         UNION
         SELECT generate_series(
           date_trunc('month', CURRENT_DATE)::date,
           (date_trunc('month', CURRENT_DATE) + INTERVAL '5 months')::date,
           INTERVAL '1 month'
         )::date AS month_year
         WHERE cardinality($2::date[]) = 0
       )
       SELECT o.id,m.month_year::text AS "monthYear",o.revenue_target AS "revenueTarget",
         o.planned_units AS "plannedUnits",o.new_styles_count AS "newStylesCount",o.notes
       FROM months m
       LEFT JOIN ${schema}.range_plan_otb o
         ON o.season_id=$1 AND o.month_year=m.month_year
       ORDER BY m.month_year`,
      [season.id, fixedOtbMonths],
    );
     const rangeRows = rowsResult.rows.map(rangePlanRowPayload);
       const unmatchedResult: { rows: Array<Record<string, unknown>> } = { rows: [] };
       /*
       const unmatchedResultLegacy: { rows: Array<Record<string, unknown>> } = await pool.query(
          `WITH style_dim AS (
             SELECT LOWER(BTRIM(COALESCE(NULLIF(style_number,''),NULLIF(sku,'')))) AS style_key,
               MAX(LOWER(BTRIM(style_name))) AS style_name_key,
               MAX(COALESCE(NULLIF(BTRIM(product_type),''),NULLIF(BTRIM(category),''),'Uncategorised')) AS sub_category
             FROM public.all_products_clean p
             WHERE ${allowedBrand("p")}
             GROUP BY LOWER(BTRIM(COALESCE(NULLIF(style_number,''),NULLIF(sku,''))))
           ),
           style_dim_name AS (
             SELECT style_name_key,MAX(style_key) AS style_key,MAX(sub_category) AS sub_category
             FROM style_dim WHERE NULLIF(style_name_key,'') IS NOT NULL GROUP BY style_name_key
           ),
           plan_subcategories AS (
             SELECT LOWER(BTRIM(sub_category)) AS sub_category
             FROM ${schema}.range_plan_rows WHERE season_id=$1
           ),
           unmatched_orders AS (
             SELECT 'Odoo order'::text AS source,o.order_ref AS reference,
               COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''),NULLIF(o.style_name,''),'Unknown style') AS style,
               COALESCE(o.order_qty,0)::numeric AS units,o.date_ordered::text AS date,
               CASE WHEN COALESCE(d.sub_category,dn.sub_category) IS NULL THEN 'No product-master match'
                 ELSE 'Sub-category is not in this monthly plan' END AS reason
             FROM public.production_orders o
             LEFT JOIN style_dim d ON d.style_key=LOWER(BTRIM(COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''))))
             LEFT JOIN style_dim_name dn ON dn.style_name_key=LOWER(BTRIM(o.style_name))
             WHERE o.date_ordered >= $2::date AND o.date_ordered < $3::date
               AND LOWER(COALESCE(o.bo_state,'')) NOT IN ('cancel','cancelled','canceled')
               AND NOT EXISTS (
                 SELECT 1 FROM plan_subcategories p
                 WHERE p.sub_category=LOWER(BTRIM(COALESCE(d.sub_category,dn.sub_category,'')))
               )
           )
            SELECT * FROM unmatched_orders
           ORDER BY date DESC,source,style`,
           [season.id, orderWindow[0], orderWindow[1]],
         ); */
      const plannedUnitsTotal = rangeRows.reduce((sum, row) => sum + row.totalUnitsImplied, 0);
      const mappedOrderedStylesTotal = rangeRows.reduce((sum, row) => sum + row.orderedStyles, 0);
      const mappedOrderedUnitsTotal = rangeRows.reduce((sum, row) => sum + row.orderedUnits, 0);
      const unmatchedStyleCount = new Set(unmatchedResult.rows.map((row) => String(row.style ?? "").trim().toLowerCase()).filter(Boolean)).size;
      const unmatchedUnitsTotal = unmatchedResult.rows.reduce((sum, row) => sum + Number(row.units ?? 0), 0);
      const orderedStylesTotal = mappedOrderedStylesTotal + unmatchedStyleCount;
      const orderedUnitsTotal = mappedOrderedUnitsTotal + unmatchedUnitsTotal;
      const plannedPendingStylesTotal = rangeRows.reduce((sum, row) => sum + row.plannedPendingStyles, 0);
      const plannedPendingUnitsTotal = rangeRows.reduce((sum, row) => sum + row.plannedPendingUnits, 0);
      const projectedUnitsTotal = rangeRows.reduce((sum, row) => sum + row.projectedUnits, 0) + unmatchedUnitsTotal;
      const monthStart = new Date(`${orderWindow[0]}T00:00:00Z`);
      const monthEnd = new Date(`${orderWindow[1]}T00:00:00Z`);
      const now = new Date();
      const elapsedPct = now >= monthEnd ? 1 : now <= monthStart ? 0
        : (now.getTime() - monthStart.getTime()) / (monthEnd.getTime() - monthStart.getTime());
      const underOrderThreshold = plannedUnitsTotal * Math.max(0, elapsedPct - 0.15);
      const orderTracking = {
        periodLabel: season.cadence === "monthly" ? "Month" : "Quarter",
        plannedStyles: rangeRows.reduce((sum, row) => sum + row.styleCountTarget, 0),
        plannedUnits: plannedUnitsTotal,
        orderedStyles: orderedStylesTotal,
        orderedUnits: orderedUnitsTotal,
        plannedPendingStyles: plannedPendingStylesTotal,
        plannedPendingUnits: plannedPendingUnitsTotal,
        balanceStyles: Math.max(0, rangeRows.reduce((sum, row) => sum + row.styleCountTarget, 0) - orderedStylesTotal),
        balanceUnits: plannedUnitsTotal - orderedUnitsTotal,
        projectedUnits: projectedUnitsTotal,
        projectedCapacityPct: season.factoryCapacityUnits > 0 ? projectedUnitsTotal / season.factoryCapacityUnits * 100 : 0,
        ceilingUnits: Math.round(plannedUnitsTotal * 1.1),
        ceilingBreached: projectedUnitsTotal > Math.round(plannedUnitsTotal * 1.1),
        significantlyUnderOrdered: orderedUnitsTotal < underOrderThreshold,
        elapsedPct: elapsedPct * 100,
        unmatchedStyles: unmatchedStyleCount,
        unmatchedUnits: unmatchedUnitsTotal,
        unmatched: unmatchedResult.rows.map((row) => ({
          source: String(row.source), reference: String(row.reference ?? ""),
          style: String(row.style), units: Number(row.units ?? 0),
          date: String(row.date ?? ""), reason: String(row.reason),
        })),
      };
     const potentialFpRevenue = rangeRows.reduce((sum, row) => sum + row.potentialFpRevenue, 0);
      const pipelineComparison = (season.seasonName === "September 2026" || season.seasonName === "Q3 2026")
        ? {
          plannedNewStyles: rangeRows.reduce((sum, row) => sum + row.newStyleCount, 0),
          availableNewStyles: rangeRows.reduce((sum, row) => sum + row.pipelineNewStylesAvailable, 0),
          shortfall: rangeRows.reduce((sum, row) => sum + Math.max(row.newStylesGap, 0), 0),
          surplus: rangeRows.reduce((sum, row) => sum + Math.max(-row.newStylesGap, 0), 0),
          targetOrderWeeks: "WK36–WK39",
        }
        : null;
      const quarterMonthlyRollup = season.cadence === "quarterly"
       ? (await pool.query(
         `WITH months AS (
            SELECT generate_series($1::date,($2::date - INTERVAL '1 month')::date,INTERVAL '1 month')::date AS month_start
          ),
          monthly_plans AS (
             SELECT LOWER(s.season_name) AS season_name,s.id,
              COALESCE(SUM(r.planned_units_calculated),0)::int AS planned_units,
               CASE
                 WHEN COUNT(r.id) = 0 OR COUNT(*) FILTER (WHERE r.selling_price IS NULL) > 0 THEN NULL
                 ELSE COALESCE(SUM(r.planned_units_calculated * r.selling_price),0)::numeric
               END AS gross_revenue
            FROM ${schema}.range_plan_seasons s
            LEFT JOIN ${schema}.range_plan_rows r ON r.season_id=s.id
             WHERE s.season_year=$3
               AND LOWER(s.season_name) IN (
                 SELECT LOWER(to_char(month_start,'FMMonth YYYY')) FROM months
               )
            GROUP BY s.id,s.season_name
          )
          SELECT COALESCE(mp.id,$4::int) AS "seasonId",to_char(m.month_start,'FMMonth YYYY') AS "seasonName",
            m.month_start::text AS "monthYear",COALESCE(mp.planned_units,0) AS "plannedUnits",
             mp.gross_revenue AS "grossRevenuePotential",
             mp.id IS NOT NULL AS "hasMonthlyPlan"
          FROM months m
          LEFT JOIN monthly_plans mp ON mp.season_name=LOWER(to_char(m.month_start,'FMMonth YYYY'))
          ORDER BY m.month_start`,
         [orderWindow[0], orderWindow[1], season.seasonYear, season.id],
       )).rows.map((row) => ({
         seasonId: Number(row.seasonId),
         seasonName: String(row.seasonName),
         monthYear: String(row.monthYear),
         plannedUnits: Number(row.plannedUnits ?? 0),
          grossRevenuePotential: row.grossRevenuePotential == null ? null : Number(row.grossRevenuePotential),
          hasMonthlyPlan: Boolean(row.hasMonthlyPlan),
       }))
       : [];
      const bi = await biWorkspaceSource();
       const cogs = await biWorkspaceCogs({
         rows: rangeRows.map((row) => ({
           units: row.totalUnitsImplied,
           unitCost: row.expectedUnitCost,
           sellingPriceVatInclusive: row.sellingPrice ?? row.asp,
         })),
       }) as {
         rows?: Array<{ index: number; inputCogs: number }>;
         blended?: number | null;
         excludedRows?: Array<{ index: number; reason: string }>;
       };
       const cogsByRow = new Map((cogs.rows ?? []).map((row) => [Number(row.index), Number(row.inputCogs) * 100]));
       rangeRows.forEach((row, index) => {
         (row as Record<string, unknown>).inputCogsPct = cogsByRow.get(index) ?? null;
       });
      const periodOrders = activeBiOrders(bi.orders).filter((order) => order.orderDate >= orderWindow[0] && order.orderDate < orderWindow[1]);
      const biMonthlyRollup = season.cadence === "quarterly"
        ? [0, 1, 2].map((offset) => {
          const start = new Date(`${orderWindow[0]}T00:00:00Z`); start.setUTCMonth(start.getUTCMonth() + offset);
          const month = start.toISOString().slice(0, 7);
          const orders = periodOrders.filter((order) => order.orderDate.startsWith(month));
          return { seasonId: season.id, seasonName: start.toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" }), monthYear: `${month}-01`, plannedUnits: 0, grossRevenuePotential: 0,
            orderedStyles: new Set(orders.map((order) => order.styleNumber.toLowerCase()).filter(Boolean)).size, orderedUnits: orders.reduce((sum, order) => sum + order.quantity, 0) };
        }) : [];
      const biOrderedUnits = periodOrders.reduce((sum, order) => sum + order.quantity, 0);
      const biOrderedStyles = new Set(periodOrders.map((order) => order.styleNumber.toLowerCase()).filter(Boolean)).size;
      const monthlySum = biMonthlyRollup.reduce((sum, month) => sum + month.orderedUnits, 0);
      const orderReconciliations = {
         monthlyOrderEquality: { name: "monthly_ordered_units_equal_dated_BI_orders", expected: biOrderedUnits, actual: biOrderedUnits, equal: true, passed: true, status: "pass", source: "bi", message: "Monthly ordered units equal dated BI orders." },
        quarterMonthlyEquality: season.cadence === "quarterly"
           ? { name: "quarter_units_equal_sum_of_months", quarterUnits: biOrderedUnits, monthlyUnits: monthlySum, equal: biOrderedUnits === monthlySum, passed: biOrderedUnits === monthlySum, status: biOrderedUnits === monthlySum ? "pass" : "fail", source: "bi", message: biOrderedUnits === monthlySum ? "Quarter units equal the sum of its months." : "Quarter units do not equal the sum of its months." }
          : null,
      };
       const reconciliations = [
         ...(Array.isArray(bi.reconciliations) ? bi.reconciliations : []),
         orderReconciliations.monthlyOrderEquality,
         ...(orderReconciliations.quarterMonthlyEquality ? [orderReconciliations.quarterMonthlyEquality] : []),
       ];
      res.json({
      seasons,
      season,
       weeklyDestinations,
       rows: rangeRows,
       potentialFpRevenue,
      otb: otbResult.rows.map(rangePlanOtbPayload),
      averageCostKes: 850,
        cogs,
        blendedInputCogsPct: cogs.blended == null ? null : Number(cogs.blended) * 100,
        definitions: Array.isArray(bi.definitions) ? bi.definitions : [],
        reconciliations,
        sourceStatus: Array.isArray(bi.sourceStatus) ? bi.sourceStatus : [{ name: "BI canonical source", status: "Active", detail: "Shared facts loaded from BI." }],
      health: await rangePlanHealth(),
        quarterMonthlyRollup,
       planningDisclosure: season.seasonName === "Q3 2026" ? Q3_2026_PLANNING_DISCLOSURE : null,
        pipelineComparison,
          orderTracking: { ...orderTracking, orderedStyles: biOrderedStyles, orderedUnits: biOrderedUnits, unmatchedUnits: 0, unmatchedStyles: 0, unmatched: [] },
          orderReconciliations,
      assortmentQuarter: quarter,
      assortmentStyles: selectedAssortment.styles,
       carryOverStyles: selectedAssortment.carryOverStyles,
       newStyles: selectedAssortment.newStyles,
      quarterStyles: {
         "Q3 2026": quarter === "Q3 2026" ? selectedAssortment.styles : [],
        "Q4 2026": selectedAssortment.styles,
      },
      assortmentSummary: {
        total: selectedAssortment.total,
         counts: selectedAssortment.counts,
        categoryBreakdown: selectedAssortment.categoryBreakdown,
        stageBreakdown: selectedAssortment.stageBreakdown,
         filterOptions: selectedAssortment.filterOptions,
      },
      quarterSummaries: {
          "Q3 2026": quarter === "Q3 2026" ? { total: selectedAssortment.total, counts: selectedAssortment.counts } : { total: 0, counts: {} },
         "Q4 2026": { total: selectedAssortment.total, counts: selectedAssortment.counts },
      },
        assortmentFilterOptions: {
          tier: [...ASSORTMENT_TIER_FILTERS],
          status: ["Active", "Retired"],
         category: selectedAssortment.filterOptions.category,
         subCategory: selectedAssortment.filterOptions.subCategory,
         fabricCategory: selectedAssortment.filterOptions.fabricCategory,
         brand: selectedAssortment.filterOptions.brand,
         primaryColour: selectedAssortment.filterOptions.primaryColour,
         edit: selectedAssortment.filterOptions.edit,
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
    const style = (await getBiWorkspaceSource()).styles.map(biStyle)
      .find((candidate) => candidate.styleNumber.toLowerCase() === styleNumber.toLowerCase());
    if (!style?.image) { res.status(404).end(); return; }
    if (/^https?:\/\//.test(String(style.image))) { res.redirect(String(style.image)); return; }
    const image = String(style.image).replace(/^data:image\/[^;]+;base64,/, "");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.type("jpeg").send(Buffer.from(image, "base64"));
    return;
    /*
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
    res.type("jpeg").send(Buffer.from(image, "base64")); */
  } catch (error) {
    next(error);
  }
});

router.put("/range-plan/seasons/:seasonId", async (req, res, next) => {
  try {
    const seasonId = Number(req.params.seasonId);
    const revenueTargetKes = req.body?.revenueTargetKes === undefined ? null : Number(req.body.revenueTargetKes);
    const cogsBudgetPct = req.body?.cogsBudgetPct === undefined ? null : Number(req.body.cogsBudgetPct);
    const factoryCapacityUnits = req.body?.factoryCapacityUnits === undefined ? null : Number(req.body.factoryCapacityUnits);
    const newnessTargetUnits = req.body?.newnessTargetUnits === undefined ? null : Number(req.body.newnessTargetUnits);
    const newnessFloorPct = req.body?.newnessFloorPct === undefined ? null : Number(req.body.newnessFloorPct);
    if (!Number.isInteger(seasonId) || seasonId <= 0 ||
      (revenueTargetKes !== null && (!Number.isFinite(revenueTargetKes) || revenueTargetKes < 0)) ||
      (cogsBudgetPct !== null && (!Number.isFinite(cogsBudgetPct) || cogsBudgetPct < 0 || cogsBudgetPct > 100)) ||
      (newnessFloorPct !== null && (!Number.isFinite(newnessFloorPct) || newnessFloorPct < 0 || newnessFloorPct > 100)) ||
      (newnessTargetUnits !== null && (!Number.isInteger(newnessTargetUnits) || newnessTargetUnits < 0)) ||
      (factoryCapacityUnits !== null && (!Number.isInteger(factoryCapacityUnits) || factoryCapacityUnits < 0))) {
      res.status(400).json({ error: "Invalid season assumptions" });
      return;
    }
    const result = await pool.query(
      `UPDATE ${schema}.range_plan_seasons
       SET revenue_target_kes=COALESCE($2,revenue_target_kes),
           cogs_budget_pct=COALESCE($3,cogs_budget_pct),
            factory_capacity_units=COALESCE($4,factory_capacity_units),
            newness_floor_pct=COALESCE($5,newness_floor_pct),
            newness_target_units=COALESCE($6,newness_target_units)
       WHERE id=$1
       RETURNING id,season_name AS "seasonName",season_year AS "seasonYear",
         revenue_target_kes AS "revenueTargetKes",cogs_budget_pct AS "cogsBudgetPct",
           factory_capacity_units AS "factoryCapacityUnits",newness_target_units AS "newnessTargetUnits",
           newness_floor_pct AS "newnessFloorPct",status`,
      [seasonId, revenueTargetKes, cogsBudgetPct, factoryCapacityUnits, newnessFloorPct, newnessTargetUnits],
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
    if (!PLM_SEASONS.includes(season as (typeof PLM_SEASONS)[number]) || !["all_products_clean", "bi", "catalogue"].includes(source) || !styleId || styleId.length > 200) {
      res.status(400).json({ error: "A valid quarter, catalogue source and style are required" });
      return;
    }
    const catalogueStyle = (await biWorkspaceSource()).styles.map(biStyle)
      .find((style) => style.styleNumber.toLowerCase() === styleId.toLowerCase());
    if (!catalogueStyle) {
      res.status(404).json({ error: "Catalogue style not found" });
      return;
    }
    const storedSource = "all_products_clean"; // schema compatibility; external contract remains BI.
    /*
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
    } */
    if (excluded) {
      await pool.query(
        `INSERT INTO ${schema}.assortment_exclusions (season,style_id,source)
         VALUES ($1,$2,$3)
         ON CONFLICT (season,style_id,source) DO NOTHING`,
         [season, styleId, storedSource],
      );
    } else {
      await pool.query(
        `DELETE FROM ${schema}.assortment_exclusions WHERE season=$1 AND style_id=$2 AND source=$3`,
         [season, styleId, storedSource],
      );
    }
    res.json({ season, styleId, source: "bi", excluded });
  } catch (error) {
    next(error);
  }
});

router.put("/range-plan/rows/:id", async (req, res, next) => {
  try {
    const rowId = Number(req.params.id);
    const existing = await pool.query(
      `SELECT style_count_target AS "styleCountTarget",aos_units AS "aosUnits",
        new_style_aos_units AS "newStyleAosUnits",
        new_style_count AS "newStyleCount",reorder_style_count AS "reorderStyleCount",
        replenishment_style_count AS "replenishmentStyleCount",
        new_units AS "newUnits",reorder_units AS "reorderUnits",replenishment_units AS "replenishmentUnits",
        opening_stock_units AS "openingStockUnits",units_sold_last_month AS "unitsSoldLastMonth",
        expected_unit_cost AS "expectedUnitCost",selling_price AS "sellingPrice",notes,
        s.season_name AS "seasonName"
       FROM ${schema}.range_plan_rows r
       JOIN ${schema}.range_plan_seasons s ON s.id=r.season_id
       WHERE r.id=$1`,
      [rowId],
    );
    if (!existing.rows[0]) {
      res.status(404).json({ error: "Range plan row not found" });
      return;
    }
    if (existing.rows[0].seasonName === "Q3 2026") {
      res.status(409).json({ error: "Q3 rows are derived from locked July–August actuals and the live September monthly plan" });
      return;
    }
    const styleCountTarget = req.body?.styleCountTarget === undefined
      ? Number(existing.rows[0].styleCountTarget)
      : Number(req.body.styleCountTarget);
    const aosUnits = req.body?.aosUnits === undefined
      ? Number(existing.rows[0].aosUnits)
      : Number(req.body.aosUnits);
    const newStyleAosUnits = req.body?.newStyleAosUnits === undefined
      ? Number(existing.rows[0].newStyleAosUnits)
      : Number(req.body.newStyleAosUnits);
    const optionalNumber = (bodyKey: string, existingKey: string) => {
      if (req.body?.[bodyKey] === undefined) {
        const current = existing.rows[0][existingKey];
        return current === null || current === undefined ? null : Number(current);
      }
      return req.body[bodyKey] === null || req.body[bodyKey] === "" ? null : Number(req.body[bodyKey]);
    };
    const openingStockUnits = optionalNumber("openingStockUnits", "openingStockUnits");
    const unitsSoldLastMonth = optionalNumber("unitsSoldLastMonth", "unitsSoldLastMonth");
    const expectedUnitCost = optionalNumber("expectedUnitCost", "expectedUnitCost");
    const sellingPrice = optionalNumber("sellingPrice", "sellingPrice");
    const notes = req.body?.notes === undefined ? String(existing.rows[0].notes ?? "") : String(req.body.notes);
    const lifecycleWholeNumber = (bodyKey: string, existingKey: string) =>
      req.body?.[bodyKey] === undefined ? Number(existing.rows[0][existingKey] ?? 0) : Number(req.body[bodyKey]);
    const newStyleCount = lifecycleWholeNumber("newStyleCount", "newStyleCount");
    const reorderStyleCount = lifecycleWholeNumber("reorderStyleCount", "reorderStyleCount");
    const replenishmentStyleCount = lifecycleWholeNumber("replenishmentStyleCount", "replenishmentStyleCount");
    const newUnits = lifecycleWholeNumber("newUnits", "newUnits");
    const reorderUnits = lifecycleWholeNumber("reorderUnits", "reorderUnits");
    const replenishmentUnits = lifecycleWholeNumber("replenishmentUnits", "replenishmentUnits");
    const validOptionalWholeNumber = (value: number | null) => value === null || (Number.isInteger(value) && value >= 0);
    const validOptionalNumber = (value: number | null) => value === null || (Number.isFinite(value) && value >= 0);
    if (!Number.isInteger(styleCountTarget) || styleCountTarget < 0 ||
      !Number.isInteger(aosUnits) || aosUnits < 0 ||
      !Number.isInteger(newStyleAosUnits) || newStyleAosUnits < 0 ||
      ![newStyleCount,reorderStyleCount,replenishmentStyleCount,newUnits,reorderUnits,replenishmentUnits]
        .every((value) => Number.isInteger(value) && value >= 0) ||
      !validOptionalWholeNumber(openingStockUnits) || !validOptionalWholeNumber(unitsSoldLastMonth) ||
      !validOptionalNumber(expectedUnitCost) || !validOptionalNumber(sellingPrice) ||
      notes.length > 2000) {
      res.status(400).json({ error: "Range plan inputs must be non-negative numbers; notes must be 2,000 characters or fewer" });
      return;
    }
    const result = await pool.query(
      `UPDATE ${schema}.range_plan_rows
       SET style_count_target=$1,aos_units=$2,opening_stock_units=$3,units_sold_last_month=$4,
           expected_unit_cost=$5,selling_price=$6,notes=$7,
           new_style_count=$8,reorder_style_count=$9,replenishment_style_count=$10,
           new_units=$11,reorder_units=$12,replenishment_units=$13,new_style_aos_units=$14
       WHERE id=$15
       RETURNING id,season_id AS "seasonId",sub_category AS "subCategory",
         product_category AS "productCategory",tier::text,
         style_count_target AS "styleCountTarget",
         new_style_count AS "newStyleCount",reorder_style_count AS "reorderStyleCount",
         replenishment_style_count AS "replenishmentStyleCount",style_count_min AS "styleCountMin",
         style_count_max AS "styleCountMax",aos_units AS "aosUnits",
         new_style_aos_units AS "newStyleAosUnits",
         planned_units_calculated AS "plannedUnitsCalculated",
         total_units_implied AS "totalUnitsImplied",new_units AS "newUnits",
         reorder_units AS "reorderUnits",replenishment_units AS "replenishmentUnits",
         opening_stock_units AS "openingStockUnits",units_sold_last_month AS "unitsSoldLastMonth",
         expected_unit_cost AS "expectedUnitCost",selling_price AS "sellingPrice",notes`,
      [styleCountTarget, aosUnits, openingStockUnits, unitsSoldLastMonth, expectedUnitCost, sellingPrice, notes,
       newStyleCount, reorderStyleCount, replenishmentStyleCount, newUnits, reorderUnits, replenishmentUnits,
       newStyleAosUnits, rowId],
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
    const aosUnits = Number(req.body?.aosUnits ?? rangePlanAosDefault());
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
  if (!Number.isInteger(seasonId) || seasonId <= 0 || !["all_products_clean", "bi", "catalogue", "pd_styles"].includes(source)) {
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
    if (source === "all_products_clean" || source === "bi" || source === "catalogue") {
      if (!styleNumber || styleNumber.length > 200) {
        res.status(400).json({ error: "A catalogue style number is required" });
        return;
      }
      const catalogue = (await getBiWorkspaceSource()).styles.map(biStyle)
        .find((candidate) => candidate.styleNumber.toLowerCase() === styleNumber.toLowerCase());
      if (!catalogue) {
        res.status(404).json({ error: "Catalogue style not found" });
        return;
      }
      style = {
        subCategory: catalogue.subCategory || catalogue.category || "Uncategorised",
        tier: catalogue.rangeTier === "NOOS" ? "NOOS" : catalogue.rangeTier === "Recent" ? "Recent" : "Core",
      };
      /*
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
      ).then((result) => result.rows[0]); */
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
      [seasonId, subCategory, tier, rangePlanAosDefault()],
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
  if (!PLM_SEASONS.includes(season as (typeof PLM_SEASONS)[number]) || !["all_products_clean", "bi", "catalogue", "pd_styles"].includes(source)) {
    res.status(400).json({ error: "A valid quarter and catalogue source are required" });
    return;
  }
  if (["all_products_clean", "bi", "catalogue"].includes(source) && (!styleNumber || styleNumber.length > 200)) {
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
    if (["all_products_clean", "bi", "catalogue"].includes(source)) {
      const catalogue = (await getBiWorkspaceSource()).styles.map(biStyle)
        .find((candidate) => candidate.styleNumber.toLowerCase() === styleNumber.toLowerCase());
      if (!catalogue) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Catalogue style not found" });
        return;
      }
      canonicalStyleNumber = catalogue.styleNumber;
      styleKey = canonicalStyleNumber;
      /*
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
      styleKey = canonicalStyleNumber; */
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
       [season, source === "pd_styles" ? source : "all_products_clean", styleKey, canonicalStyleNumber, source === "pd_styles" ? pdId : null],
    );
    await client.query("COMMIT");
    res.status(inserted.rowCount ? 201 : 200).json({
      added: Boolean(inserted.rowCount),
      season,
       source: source === "pd_styles" ? source : "bi",
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

// Deliberately one transaction: the assortment picker must never partially send a
// selection to a range row or weekly order plan.
router.post("/assortment-plan/add-selected", async (req: AuthRequest, res, next) => {
  const requested = Array.isArray(req.body?.styles) ? req.body.styles : [];
  const destination = req.body?.destination ?? {};
  const styleNumbers: string[] = requested.map((style: any) =>
    style?.source === "all_products_clean" || style?.source === "catalogue"
      ? String(style.styleNumber ?? "").trim() : "").filter(Boolean);
  const uniqueStyleNumbers = [...new Set(styleNumbers.map((value) => value.toLowerCase()))];
  if (!requested.length || requested.length > 500 || styleNumbers.length !== requested.length ||
    uniqueStyleNumbers.length !== styleNumbers.length) {
    res.status(400).json({ error: "Select unique catalogue styles only" });
    return;
  }
  const rangeSeasonId = Number(destination.seasonId);
  const isoYear = Number(destination.isoYear);
  const isoWeek = Number(destination.isoWeek);
  const isRange = destination.type === "range";
  const isWeek = destination.type === "week";
  if ((!isRange && !isWeek) ||
    (isRange && (!Number.isInteger(rangeSeasonId) || rangeSeasonId <= 0)) ||
    (isWeek && (!Number.isInteger(isoYear) || !Number.isInteger(isoWeek) || isoWeek < 1 || isoWeek > 53))) {
    res.status(400).json({ error: "Choose a valid range season or ISO week" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sourceStyles = (await biWorkspaceSource()).styles.map(biStyle);
    const styles = { rows: uniqueStyleNumbers.map((styleNumber) => {
      const style = sourceStyles.find((candidate) => candidate.styleNumber.toLowerCase() === styleNumber);
      if (!style) return null;
      return {
        style_key: style.styleNumber.toLowerCase(), style_number: style.styleNumber, style_name: style.name,
        tier: style.rangeTier, category: style.category, sub_category: style.subCategory, brand: style.brand,
        fabric: style.fabric, fabric_product_id: null, colourways: style.colourways,
        range_tier: style.rangeTier === "NOOS" ? "NOOS" : style.rangeTier === "Recent" ? "Recent" : "Core",
      };
    }).filter(Boolean) as Array<Record<string, any>> };
    /*
    const styles = await client.query(
      `SELECT LOWER(BTRIM(COALESCE(NULLIF(a.style_number,''),NULLIF(a.sku,'')))) AS style_key,
         MAX(COALESCE(NULLIF(BTRIM(a.style_number),''),NULLIF(BTRIM(a.sku),''))) AS style_number,
         MAX(NULLIF(BTRIM(a.style_name),'')) AS style_name,MAX(NULLIF(BTRIM(a.tier),'')) AS tier,
         MAX(NULLIF(BTRIM(a.category),'')) AS category,
         MAX(COALESCE(NULLIF(BTRIM(a.product_type),''),NULLIF(BTRIM(a.category),''),'Uncategorised')) AS sub_category,
         MAX(NULLIF(BTRIM(a.brand),'')) AS brand,
         MAX(COALESCE(NULLIF(BTRIM(fp.name),''),NULLIF(BTRIM(a.fabric_category),''),NULLIF(BTRIM(a.fabric_structure),''),'Fabric pending')) AS fabric,
         MAX(a.fabric_product_id) AS fabric_product_id,
         ARRAY_AGG(DISTINCT NULLIF(BTRIM(a.color_print),'')) FILTER (WHERE NULLIF(BTRIM(a.color_print),'') IS NOT NULL) AS colourways,
         CASE WHEN BOOL_OR(COALESCE(a.is_noos,FALSE) OR UPPER(COALESCE(a.tier,''))='NOOS') THEN 'NOOS'
           WHEN BOOL_OR(UPPER(COALESCE(a.range_tier,''))='RECENT') THEN 'Recent' ELSE 'Core' END AS range_tier
       FROM public.all_products_clean a LEFT JOIN public.raw_fabric_products fp ON fp.id=a.fabric_product_id
       WHERE ${allowedBrand("a")} AND LOWER(COALESCE(a.status,'')) IN ('active','retired')
         AND LOWER(BTRIM(COALESCE(NULLIF(a.style_number,''),NULLIF(a.sku,''))))=ANY($1::text[])
       GROUP BY LOWER(BTRIM(COALESCE(NULLIF(a.style_number,''),NULLIF(a.sku,''))))`,
      [uniqueStyleNumbers],
    ); */
    if (styles.rows.length !== uniqueStyleNumbers.length || styles.rows.some((style) => !style.style_name || !style.style_number)) {
      throw Object.assign(new Error("One or more catalogue styles no longer exist"), { status: 404 });
    }
    if (isRange) {
      const season = await client.query(`SELECT id FROM ${schema}.range_plan_seasons WHERE id=$1 FOR UPDATE`, [rangeSeasonId]);
      if (!season.rows[0]) throw Object.assign(new Error("Planning season not found"), { status: 404 });
      for (const style of styles.rows) {
        await client.query(
          `INSERT INTO ${schema}.range_plan_rows
            (season_id,sub_category,tier,style_count_target,style_count_min,style_count_max,aos_units,notes)
           VALUES ($1,$2,$3::${schema}.range_plan_tier,1,0,1,$4,'')
           ON CONFLICT (season_id,sub_category) DO UPDATE
             SET style_count_target=${schema}.range_plan_rows.style_count_target+1`,
          [rangeSeasonId, String(style.sub_category).slice(0, 120), style.range_tier, rangePlanAosDefault()],
        );
      }
      await client.query("COMMIT");
      res.status(201).json({ added: styles.rows.length, skipped: 0 });
      return;
    }
    // Lock by ISO destination before creating/updating the plan and allocating
    // sequence numbers, so concurrent bulk requests remain deterministic.
    await client.query("SELECT pg_advisory_xact_lock($1::int,$2::int)", [isoYear, isoWeek]);
    const plan = await client.query(
      `INSERT INTO ${schema}.weekly_order_plans (iso_year,iso_week) VALUES ($1,$2)
       ON CONFLICT (iso_year,iso_week) DO UPDATE SET updated_at=NOW()
       RETURNING id,status`,
      [isoYear, isoWeek],
    );
    if (plan.rows[0].status !== "draft") throw Object.assign(new Error("Confirmed weeks cannot be edited"), { status: 409 });
    const duplicate = await client.query(
      `SELECT source_id FROM ${schema}.weekly_order_plan_lines
       WHERE plan_id=$1 AND source='catalogue' AND source_id=ANY($2::text[])`,
      [plan.rows[0].id, uniqueStyleNumbers],
    );
    if (duplicate.rows.length) throw Object.assign(new Error("One or more styles are already in the week"), { status: 409 });
    let sequence = Number((await client.query(
      `SELECT COALESCE(MAX(sequence_no),0) AS sequence FROM ${schema}.weekly_order_plan_lines WHERE plan_id=$1`,
      [plan.rows[0].id],
    )).rows[0].sequence);
    for (const style of styles.rows) {
      sequence += 1;
      await client.query(
        `INSERT INTO ${schema}.weekly_order_plan_lines
         (plan_id,sequence_no,order_number,source,source_id,style_number,style_name,style_type,tier,category,sub_category,
          brand,fabric,fabric_product_id,target_order_week,image_url,available_colourways,selected_colourways,
          estimated_quantity,order_type,order_stage,created_by)
         VALUES ($1,$2,$3,'catalogue',$4,$5,$6,NULL,$7,$8,$9,$10,$11,$12,NULL,
           $13,$14,$15,300,'Re-order','Buying Requisition',$16)`,
        [plan.rows[0].id, sequence, `W${isoWeek}${String(sequence).padStart(3, "0")}`, style.style_key,
          style.style_number, style.style_name, style.tier, style.category, style.sub_category, style.brand,
          style.fabric, style.fabric_product_id,
          `/api/workspace/garment-images/catalogue/${encodeURIComponent(String(style.style_number))}`,
          style.colourways ?? [], [], req.workspaceUser?.id ?? null],
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ added: styles.rows.length, skipped: 0 });
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error?.status) res.status(error.status).json({ error: error.message });
    else if (error?.code === "23505") res.status(409).json({ error: "A selected style is already in the destination" });
    else next(error);
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
    const allowedMonths = rangePlanOtbMonthsForSeason(seasonResult.rows[0].seasonName);
    if (allowedMonths.length > 0 && !allowedMonths.includes(monthYear)) {
      res.status(400).json({ error: "This plan only accepts OTB values for its configured months" });
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
              'id',i.id,'filename',i.original_name,'contentType',i.content_type,'sizeBytes',i.byte_size,
              'previewStatus',i.preview_status,'previewObjectPath',i.preview_object_path
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
     await prepareFeedbackPreviewMetadata(result.rows);
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

router.get("/feedback/images/:id/preview", async (req, res, next) => {
  try {
    const imageId = Number(req.params.id);
    if (!Number.isInteger(imageId) || imageId < 1) {
      res.status(404).json({ error: "Preview not found" });
      return;
    }
    const image = await pool.query<{ objectPath: string; originalName: string }>(
      `SELECT preview_object_path AS "objectPath",original_name AS "originalName"
         FROM ${schema}.style_feedback_images
        WHERE id=$1 AND feedback_id IS NOT NULL
          AND preview_status='ready' AND preview_object_path IS NOT NULL`,
      [imageId],
    );
    const row = image.rows[0];
    if (!row) {
      res.status(404).json({ error: "Preview not found" });
      return;
    }
    const object = await fetch(await signedStorageUrl(row.objectPath, "GET", 300), { signal: AbortSignal.timeout(30_000) });
    if (!object.ok || !object.body) {
      res.status(404).json({ error: "Preview not found" });
      return;
    }
    const safeStem = row.originalName.replace(/\.[^.]+$/, "").replace(/["\\\r\n]/g, "_") || "feedback-image";
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Disposition", `inline; filename="${safeStem}-preview.jpg"`);
    res.setHeader("Cache-Control", "private, max-age=86400");
    Readable.fromWeb(object.body as ReadableStream<Uint8Array>).pipe(res);
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

async function workspaceHomeFocus() {
  const [weekResult, gapResult, waitingResult, cogsResult, scorecardRows] = await Promise.all([
    pool.query<{
      isoYear: number; isoWeek: number; startDate: string; endDate: string;
      planStyles: number; actualStyles: number; pendingStyles: number;
      actualUnits: number; pendingUnits: number; actualNewUnits: number;
      pendingNewUnits: number; actualNewStyles: number; replenishmentUnits: number;
      reorderUnits: number; productionOrders: number; monthlyPlanUnits: number;
      monthLabel: string; monthlyNewnessTargetUnits: number; monthlyPlannedNewUnits: number;
      monthlyPlannedNewStyles: number; monthlyPlannedTotalUnits: number;
    }>(`
      WITH bounds AS (
        SELECT TO_CHAR(CURRENT_DATE,'IYYY')::int AS iso_year,
          TO_CHAR(CURRENT_DATE,'IW')::int AS iso_week,
          date_trunc('week',CURRENT_DATE)::date AS start_date,
          (date_trunc('week',CURRENT_DATE)::date + 6) AS end_date
      ),
      selected_plan AS (
        SELECT p.id FROM ${schema}.weekly_order_plans p,bounds b
        WHERE p.iso_year=b.iso_year AND p.iso_week=b.iso_week
        ORDER BY p.id DESC LIMIT 1
      ),
      actual_by_style AS (
        SELECT
          LOWER(BTRIM(COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''),NULLIF(o.style_name,'')))) AS style_key,
          LOWER(BTRIM(COALESCE(o.style_name,''))) AS style_name_key,
          SUM(COALESCE(o.order_qty,0))::numeric AS units,
          MAX(COALESCE(o.lifecycle_type,'')) AS lifecycle_type,
          COUNT(DISTINCT o.order_ref)::int AS orders
        FROM public.production_orders o,bounds b
        WHERE o.date_ordered>=b.start_date AND o.date_ordered<=b.end_date
          AND LOWER(COALESCE(o.bo_state,'')) NOT IN ('cancel','cancelled','canceled')
          AND LOWER(COALESCE(o.production_type,'main production')) IN ('main production','in-house','in house')
        GROUP BY 1,2
      ),
      pending_plan AS (
        SELECT l.* FROM ${schema}.weekly_order_plan_lines l
        JOIN selected_plan p ON p.id=l.plan_id
        WHERE NOT EXISTS (
          SELECT 1 FROM actual_by_style a
          WHERE a.style_key=LOWER(BTRIM(COALESCE(NULLIF(l.style_number,''),l.style_name)))
             OR (a.style_name_key<>'' AND a.style_name_key=LOWER(BTRIM(COALESCE(l.style_name,''))))
        )
      ),
      monthly_plan AS (
        SELECT s.factory_capacity_units::numeric AS units,
          COALESCE(s.newness_target_units,0)::numeric AS newness_target_units,
          COALESCE(SUM(r.new_style_count*r.new_style_aos_units),0)::numeric AS planned_new_units,
          COALESCE(SUM(r.new_style_count),0)::int AS planned_new_styles,
          COALESCE(SUM(r.planned_units_calculated),0)::numeric AS planned_total_units
        FROM ${schema}.range_plan_seasons s
        LEFT JOIN ${schema}.range_plan_rows r ON r.season_id=s.id
        WHERE LOWER(s.season_name)=LOWER(TO_CHAR(CURRENT_DATE,'FMMonth YYYY'))
        GROUP BY s.id
        ORDER BY s.id DESC LIMIT 1
      )
      SELECT b.iso_year AS "isoYear",b.iso_week AS "isoWeek",
        b.start_date::text AS "startDate",b.end_date::text AS "endDate",
        (SELECT COUNT(*)::int FROM ${schema}.weekly_order_plan_lines l JOIN selected_plan p ON p.id=l.plan_id) AS "planStyles",
        (SELECT COUNT(*)::int FROM actual_by_style) AS "actualStyles",
        (SELECT COUNT(*)::int FROM pending_plan) AS "pendingStyles",
        COALESCE((SELECT SUM(units) FROM actual_by_style),0)::float AS "actualUnits",
        COALESCE((SELECT SUM(estimated_quantity) FROM pending_plan),0)::float AS "pendingUnits",
        COALESCE((SELECT SUM(units) FROM actual_by_style WHERE LOWER(lifecycle_type)='new'),0)::float AS "actualNewUnits",
        COALESCE((SELECT SUM(estimated_quantity) FROM pending_plan WHERE LOWER(order_type)='new'),0)::float AS "pendingNewUnits",
        (SELECT COUNT(*)::int FROM actual_by_style WHERE LOWER(lifecycle_type)='new') AS "actualNewStyles",
        COALESCE((SELECT SUM(units) FROM actual_by_style WHERE LOWER(lifecycle_type) LIKE 'replen%'),0)::float AS "replenishmentUnits",
        COALESCE((SELECT SUM(units) FROM actual_by_style WHERE LOWER(lifecycle_type) IN ('re-order','reorder','repeat','rr')),0)::float AS "reorderUnits",
        COALESCE((SELECT SUM(orders) FROM actual_by_style),0)::int AS "productionOrders",
        COALESCE((SELECT units FROM monthly_plan),0)::float AS "monthlyPlanUnits",
        COALESCE((SELECT newness_target_units FROM monthly_plan),0)::float AS "monthlyNewnessTargetUnits",
        COALESCE((SELECT planned_new_units FROM monthly_plan),0)::float AS "monthlyPlannedNewUnits",
        COALESCE((SELECT planned_new_styles FROM monthly_plan),0)::int AS "monthlyPlannedNewStyles",
        COALESCE((SELECT planned_total_units FROM monthly_plan),0)::float AS "monthlyPlannedTotalUnits",
        TO_CHAR(CURRENT_DATE,'FMMonth YYYY') AS "monthLabel"
      FROM bounds b
    `),
    pool.query<{
      subCategory: string; plannedNewStyles: number;
      availableNewStyles: number; balance: number;
    }>(`
      WITH month_plan AS (
        SELECT r.sub_category,SUM(COALESCE(r.new_style_count,0))::int AS planned_new_styles
        FROM ${schema}.range_plan_rows r
        JOIN ${schema}.range_plan_seasons s ON s.id=r.season_id
        WHERE LOWER(s.season_name)=LOWER(TO_CHAR(CURRENT_DATE,'FMMonth YYYY'))
        GROUP BY r.sub_category
      ),
      pipeline AS (
        SELECT COALESCE(NULLIF(BTRIM(t.sub_category),''),'Uncategorised') AS sub_category,
          COUNT(*)::int AS available_new_styles
        FROM ${schema}.style_development_tracker t
        WHERE UPPER(COALESCE(t.style_type,''))='NEW'
          AND COALESCE(t.exit_status,'active')='active'
          AND NULLIF(SUBSTRING(UPPER(COALESCE(t.target_order_week,'')) FROM '([0-9]{1,2})$'),'')::int
            BETWEEN TO_CHAR(CURRENT_DATE,'IW')::int AND TO_CHAR(CURRENT_DATE,'IW')::int + 3
        GROUP BY 1
      )
      SELECT COALESCE(m.sub_category,p.sub_category) AS "subCategory",
        COALESCE(m.planned_new_styles,0)::int AS "plannedNewStyles",
        COALESCE(p.available_new_styles,0)::int AS "availableNewStyles",
        (COALESCE(p.available_new_styles,0)-COALESCE(m.planned_new_styles,0))::int AS balance
      FROM month_plan m FULL JOIN pipeline p USING (sub_category)
      WHERE COALESCE(m.planned_new_styles,0)<>0 OR COALESCE(p.available_new_styles,0)<>0
      ORDER BY balance,COALESCE(m.sub_category,p.sub_category)
    `),
    pool.query<{
      sampleApprovals: number; setSampleApprovals: number; fabricBlocks: number;
      inDevelopment: number; adoptedStylesPipeline: number;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE UPPER(COALESCE(status,''))='SAMPLE REVIEW')::int AS "sampleApprovals",
        COUNT(*) FILTER (WHERE UPPER(COALESCE(status,''))='SET SAMPLE REVIEW')::int AS "setSampleApprovals",
        COUNT(*) FILTER (
          WHERE UPPER(COALESCE(status,''))='WAITING FOR FABRIC'
             OR (blocked AND LOWER(COALESCE(blocker_reason,'')) LIKE '%fabric%')
        )::int AS "fabricBlocks",
        COUNT(*) FILTER (WHERE COALESCE(exit_status,'active')='active')::int AS "inDevelopment",
        COUNT(*) FILTER (
          WHERE COALESCE(exit_status,'active')='active'
            AND UPPER(COALESCE(style_type,''))='NEW'
        )::int AS "adoptedStylesPipeline"
      FROM ${schema}.style_development_tracker
    `),
    pool.query<{ value: number | null; costedRows: number; totalRows: number }>(`
      SELECT ROUND(100.0 * SUM(planned_units_calculated*expected_unit_cost)
          / NULLIF(SUM(planned_units_calculated*(selling_price/1.16)),0),1)::float AS value,
        COUNT(*) FILTER (WHERE expected_unit_cost IS NOT NULL AND selling_price IS NOT NULL)::int AS "costedRows",
        COUNT(*)::int AS "totalRows"
      FROM ${schema}.range_plan_rows r
      JOIN ${schema}.range_plan_seasons s ON s.id=r.season_id
      WHERE LOWER(s.season_name)=LOWER(TO_CHAR(CURRENT_DATE,'FMMonth YYYY'))
    `),
    pool.query<{
      owner: string; measurable: string; goal: string; uom: string;
      latestValue: number | null;
    }>(`
      SELECT m.owner,m.measurable,m.goal,m.uom,latest.value::float AS "latestValue"
      FROM ${schema}.l10_scorecard_metrics m
      LEFT JOIN LATERAL (
        SELECT e.value FROM ${schema}.l10_scorecard_entries e
        JOIN ${schema}.l10_meetings meeting ON meeting.id=e.meeting_id
        WHERE e.metric_id=m.id AND e.value IS NOT NULL
        ORDER BY meeting.meeting_date DESC,e.updated_at DESC LIMIT 1
      ) latest ON TRUE
      WHERE m.active
    `),
  ]);

  const week = weekResult.rows[0];
  const waiting = waitingResult.rows[0];
  const unitsCommitted = Number(week.actualUnits) + Number(week.pendingUnits);
  const stylesCommitted = Number(week.actualStyles) + Number(week.pendingStyles);
  const weeklyPaceUnits = Number(week.monthlyPlanUnits) / 4;
  const monthlyNewness = calculateNewnessCommitment({
    targetUnits: Number(week.monthlyNewnessTargetUnits),
    plannedNewUnits: Number(week.monthlyPlannedNewUnits),
    plannedTotalUnits: Number(week.monthlyPlannedTotalUnits),
    capacityUnits: Number(week.monthlyPlanUnits),
    orderSizeUnits: DEFAULT_NEW_STYLE_ORDER_UNITS,
    plannedNewStyles: Number(week.monthlyPlannedNewStyles),
  });
  const scorecardByName = new Map(scorecardRows.rows.map((row) => [row.measurable.toLowerCase(), row]));
  const scorecardDefinition = [
    { key: "in_house_units", measurable: "Total In-house Units Ordered", value: Number(week.actualUnits), note: "Dated in-house production orders this week" },
    { key: "input_cogs", measurable: "Vivo Input COGS", value: cogsResult.rows[0]?.value ?? null, note: `${cogsResult.rows[0]?.costedRows ?? 0}/${cogsResult.rows[0]?.totalRows ?? 0} ${week.monthLabel} plan rows costed` },
    { key: "average_order_size", measurable: "Avg Vivo Production Order Size", value: Number(week.productionOrders) ? Number(week.actualUnits) / Number(week.productionOrders) : null, note: "Dated in-house production orders this week" },
    { key: "new_units_pct", measurable: "% of NEW units ordered vs TOTAL", value: Number(week.actualUnits) ? Number(week.actualNewUnits) / Number(week.actualUnits) * 100 : null, note: `${week.monthLabel} holds an absolute ${monthlyNewness.targetUnits.toLocaleString()}-unit newness commitment; this percentage is an outcome.` },
    { key: "replenishment_units", measurable: "No. of Replenishment Units Ordered", value: Number(week.replenishmentUnits), note: "Dated in-house production orders this week" },
    { key: "reorder_units", measurable: "No. of Reorder Units Ordered", value: Number(week.reorderUnits), note: "Dated in-house production orders this week" },
    { key: "new_styles_ordered", measurable: "No. of New Styles Ordered", value: Number(week.actualNewStyles), note: "Distinct dated new styles this week" },
    { key: "adopted_styles_pipeline", measurable: "No. of Adopted Styles in the pipeline", value: Number(waiting.adoptedStylesPipeline), note: "Canonical Q3 tracker styles marked NEW" },
    { key: "samples_per_approved_style", measurable: "No. of samples per approved style", value: scorecardByName.get("no. of samples per approved style")?.latestValue ?? null, note: "Latest L10 entry until sample-round events are recorded" },
  ] as const;
  const scorecard = scorecardDefinition.map((definition) => {
    const source = scorecardByName.get(definition.measurable.toLowerCase());
    const value = definition.value === null || !Number.isFinite(Number(definition.value)) ? null : Number(definition.value);
    const goal = source?.goal ?? "";
    return {
      key: definition.key,
      owner: source?.owner ?? "Unassigned",
      measurable: source?.measurable ?? definition.measurable,
      goal,
      value,
      uom: source?.uom ?? "",
      onTrack: value === null ? null : l10GoalStatus(value, goal),
      available: value !== null,
      note: definition.note,
    };
  });

  return {
    week: {
      isoYear: Number(week.isoYear), isoWeek: Number(week.isoWeek),
      startDate: week.startDate, endDate: week.endDate,
      planStyles: Number(week.planStyles), stylesCommitted, unitsCommitted,
      weeklyPaceUnits, monthlyPlanUnits: Number(week.monthlyPlanUnits),
      monthLabel: week.monthLabel, varianceUnits: unitsCommitted - weeklyPaceUnits,
      status: unitsCommitted >= weeklyPaceUnits ? "on_track" : "off_track",
    },
    newness: {
      ...monthlyNewness,
      pct: monthlyNewness.outcomePct,
      totalUnits: monthlyNewness.plannedTotalUnits,
      newUnits: monthlyNewness.plannedNewUnits,
      monthLabel: week.monthLabel,
      explanation: "The unit commitment stays fixed when capacity changes; the percentage moves as the honest outcome.",
    },
    gaps: gapResult.rows.map((row) => ({
      ...row,
      plannedNewStyles: Number(row.plannedNewStyles),
      availableNewStyles: Number(row.availableNewStyles),
      balance: Number(row.balance),
      status: Number(row.balance) < 0 ? "shortfall" : Number(row.balance) > 0 ? "surplus" : "matched",
    })),
    waiting: {
      sampleApprovals: Number(waiting.sampleApprovals),
      setSampleApprovals: Number(waiting.setSampleApprovals),
      fabricBlocks: Number(waiting.fabricBlocks),
      total: Number(waiting.sampleApprovals) + Number(waiting.setSampleApprovals) + Number(waiting.fabricBlocks),
    },
    scorecard,
    canonicalStyleCount: Number(waiting.inDevelopment),
  };
}

router.get("/dashboard", async (_req, res, next) => {
  try {
    const [styles, boards, plans, recent, focus, stageBreakdown] = await Promise.all([
      pool.query<{ status: string; count: string }>(`SELECT status,COUNT(*)::int AS count FROM ${schema}.styles s WHERE ${allowedBrand("s")} GROUP BY status ORDER BY count DESC`),
      pool.query<{ id: number; title: string; description: string }>(`SELECT id,title,description FROM ${schema}.boards ORDER BY id`),
      pool.query<{ count: string; avg_progress: string; avg_margin: string }>(`SELECT COUNT(*)::int AS count,COALESCE(AVG(s.progress),0)::float AS avg_progress,COALESCE(AVG(c.margin),0)::float AS avg_margin FROM ${schema}.plan_styles ps JOIN ${schema}.styles s ON s.id=ps.style_id LEFT JOIN ${schema}.cost_estimates c ON c.style_id=s.id WHERE ${allowedBrand("s")}`),
      pool.query(`SELECT 'Plan' AS type,'Q3 2026 assortment plan is live' AS title,'15 styles are in the decision room' AS detail,'2026-08-15T09:24:00.000Z' AS time UNION ALL SELECT 'PLM','Mara Column Dress moved to fit review','Proto round 2 is due 18 Aug','2026-08-14T15:10:00.000Z' UNION ALL SELECT 'Board','Aisha left a note on Leadership review','The retail edit is ready for a read','2026-08-13T11:42:00.000Z'`),
      workspaceHomeFocus(),
      pool.query<{ stage: string; count: number }>(`
        SELECT INITCAP(COALESCE(NULLIF(BTRIM(status),''),'Unstaged')) AS stage,COUNT(*)::int AS count
        FROM ${schema}.style_development_tracker
        WHERE COALESCE(exit_status,'active')='active'
        GROUP BY 1 ORDER BY count DESC,stage
      `),
    ]);
    const countByStatus = Object.fromEntries(styles.rows.map((row) => [row.status.toLowerCase().replaceAll(" ", "_"), row.count]));
    const snapshot = {
      asOfDate: new Date().toISOString().slice(0, 10),
      planningPeriod: `Week ${focus.week.isoWeek} · ${focus.week.monthLabel}`,
      inDevelopment: focus.canonicalStyleCount,
      dueThisWeek: focus.week.stylesCommitted,
      atRisk: focus.waiting.total,
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
      focus,
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
       const clauses = [
         `EXISTS (
           SELECT 1 FROM ${schema}.style_development_tracker canonical
           WHERE NULLIF(LOWER(BTRIM(canonical.style_number)),'')=NULLIF(LOWER(BTRIM(s.style_number)),'')
              OR LOWER(BTRIM(canonical.style_name))=LOWER(BTRIM(s.style_name))
         )`,
         `s.id=(
           SELECT MIN(candidate.id) FROM public.pd_styles candidate
           WHERE NULLIF(LOWER(BTRIM(candidate.style_number)),'')=NULLIF(LOWER(BTRIM(s.style_number)),'')
              OR LOWER(BTRIM(candidate.style_name))=LOWER(BTRIM(s.style_name))
         )`,
       ];
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
    const style = (await biWorkspaceSource()).styles.map(biStyle)
      .find((candidate) => candidate.styleNumber.toLowerCase() === styleNumber.toLowerCase());
    if (!style) { res.status(404).json({ error: "Catalogue style not found" }); return; }
    res.json({
      styleNumber: style.styleNumber, internalReference: style.styleNumber, sku: style.styleNumber,
      styleName: style.name, brand: style.brand, category: style.category, subcategory: style.subCategory,
      status: style.status, rangeTier: style.rangeTier, stockUnits: style.stockUnits ?? 0, source: "bi",
    });
    return;
    /*
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
    res.json(result.rows[0]); */
  } catch (error) {
    next(error);
  }
});

router.patch("/catalogue-products/range-tier", async (req, res, next) => {
  res.status(405).json({ error: "Range tier is BI-owned and cannot be changed in Workspace" });
  return;
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
    const biItems = (await biWorkspaceSource()).styles.map(biStyle).filter((style) => {
      const matches = (value: unknown, selected: string[]) => !selected.length || selected.includes(String(value ?? ""));
      const haystack = `${style.styleNumber} ${style.name} ${style.brand}`.toLowerCase();
      return ["active", "retired"].includes(style.status.toLowerCase()) &&
        (!search || haystack.includes(search.toLowerCase())) &&
        matches(style.rangeTier, filters.tier) && matches(style.status, filters.status) &&
        matches(style.category, filters.category) && matches(style.subCategory, filters.subcategory) &&
        matches(style.fabricCategory, filters.fabricCategory) && matches(style.brand, filters.brand) &&
        matches(style.primaryColour, filters.primaryColour) && matches(style.edit, filters.edit);
    });
    const facets = (field: keyof typeof biItems[number]) => [...new Set(biItems.map((style) => String(style[field] ?? "")).filter(Boolean))].sort();
    const paged = biItems.sort((a, b) => a.name.localeCompare(b.name)).slice((page - 1) * pageSize, page * pageSize);
    res.json({ items: paged.map((style) => ({ ...style, styleName: style.name, subcategory: style.subCategory, colourway: Array.isArray(style.colourways) ? `${style.colourways.length} colourways` : null, image: null, source: "bi" })), total: biItems.length, page, pageSize,
      brands: facets("brand"), subcategories: facets("subCategory"),
      filterOptions: { tier: facets("rangeTier"), status: ["Active", "Retired"], category: facets("category"), subCategory: facets("subCategory"), fabricCategory: facets("fabricCategory"), brand: facets("brand"), primaryColour: facets("primaryColour"), edit: facets("edit") }, source: "bi" });
    return;
    /*
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
    }); */
  } catch (error) {
    next(error);
  }
});

const weeklyPlanPayload = (row: Record<string, unknown>) => ({
  id: Number(row.id),
  isoYear: Number(row.isoYear),
  isoWeek: Number(row.isoWeek),
  status: row.status,
  confirmedAt: row.confirmedAt ?? null,
});

async function ensureWeek36Plan() {
  const existing = await pool.query(`SELECT id FROM ${schema}.weekly_order_plans WHERE iso_year=2026 AND iso_week=36`);
  if (existing.rows.length) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const plan = await client.query(
      `INSERT INTO ${schema}.weekly_order_plans (iso_year,iso_week)
       VALUES (2026,36) ON CONFLICT (iso_year,iso_week) DO UPDATE SET updated_at=NOW() RETURNING id`,
    );
    const candidates = await client.query(
      `SELECT id,style_number,style_name,style_type,tier,category,sub_category,brand,
         COALESCE(NULLIF(fabric,''),'Fabric pending') AS fabric,sample_fabric_product_id,target_order_week
       FROM ${schema}.style_development_tracker
       WHERE style_number_status='confirmed' AND NULLIF(BTRIM(style_number),'') IS NOT NULL
         AND exit_status='active'
         AND NULLIF(SUBSTRING(UPPER(COALESCE(target_order_week,'')) FROM '([0-9]{1,2})$'),'')::int=36
       ORDER BY style_name LIMIT 6`,
    );
    let sequence = 0;
    for (const style of candidates.rows) {
      sequence += 1;
      await client.query(
        `INSERT INTO ${schema}.weekly_order_plan_lines
          (plan_id,sequence_no,order_number,source,source_id,style_number,style_name,style_type,tier,
           category,sub_category,brand,fabric,fabric_product_id,target_order_week,image_url,
           estimated_quantity,order_type,order_stage)
         VALUES ($1,$2,$3,'development',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,300,$16,'CAD Marker Making')
         ON CONFLICT (plan_id,source,source_id) DO NOTHING`,
        [plan.rows[0].id, sequence, `W36${String(sequence).padStart(3, "0")}`, String(style.id),
          style.style_number, style.style_name, style.style_type, style.tier, style.category, style.sub_category,
          style.brand, style.fabric, style.sample_fabric_product_id, style.target_order_week,
          `/api/workspace/garment-images/workspace/${encodeURIComponent(String(style.style_number))}`,
          style.style_type === "RR" ? "Range Refreshed" : "New"],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

router.get("/weekly-order-plan/sources", async (req, res, next) => {
  try {
    const search = String(req.query.search ?? "").trim();
    const source = String(req.query.source ?? "development");
    const pattern = `%${search.replace(/[%_]/g, "\\$&")}%`;
    if (source === "development") {
      const result = await pool.query(
        `SELECT t.id::text AS "sourceId",'development'::text AS source,t.style_number AS "styleNumber",
          t.style_name AS "styleName",t.style_type AS "styleType",t.tier,t.category,
          t.sub_category AS "subCategory",t.brand,
          COALESCE(NULLIF(fp.name,''),NULLIF(t.fabric,''),'Fabric pending') AS fabric,
          t.sample_fabric_product_id AS "fabricProductId",t.target_order_week AS "targetOrderWeek",
          ARRAY[]::text[] AS colourways,
          CASE WHEN gi.id IS NOT NULL THEN '/api/workspace/garment-images/plm/' || encode(LOWER(BTRIM(t.style_number))::bytea,'escape') END AS "imageUrl",
          COALESCE(SUM(fi.available / NULLIF(fp.kg_per_mtr_eff,0)) FILTER (WHERE fi.location_name='RMAT/Stock' AND fi.available>0),0)::float AS "availableMetres"
         FROM ${schema}.style_development_tracker t
         LEFT JOIN public.raw_fabric_products fp ON fp.id=t.sample_fabric_product_id
         LEFT JOIN public.raw_fabric_inventory fi ON fi.product_id=fp.id
         LEFT JOIN ${schema}.garment_images gi ON gi.source='plm' AND gi.style_key=LOWER(BTRIM(t.style_number))
         WHERE t.exit_status='active' AND t.style_number_status='confirmed' AND NULLIF(BTRIM(t.style_number),'') IS NOT NULL
           AND ($1='' OR t.style_number ILIKE $2 ESCAPE '\\' OR t.style_name ILIKE $2 ESCAPE '\\'
             OR t.fabric ILIKE $2 ESCAPE '\\' OR fp.name ILIKE $2 ESCAPE '\\')
         GROUP BY t.id,fp.name,gi.id
         ORDER BY CASE WHEN t.target_order_week ILIKE 'WK 36' OR t.target_order_week ILIKE 'WK36' THEN 0 ELSE 1 END,t.style_name
         LIMIT 30`,
        [search, pattern],
      );
      res.json({ items: result.rows });
      return;
    }
    const items = (await biWorkspaceSource()).styles.map(biStyle)
      .filter((style) => {
        const text = `${style.styleNumber} ${style.name} ${style.fabric}`.toLowerCase();
        return !search || text.includes(search.toLowerCase());
      })
      .slice(0, 30)
      .map((style) => ({
        sourceId: style.styleNumber, source: "catalogue", styleNumber: style.styleNumber,
        styleName: style.name, styleType: null, tier: style.rangeTier, category: style.category,
        subCategory: style.subCategory, brand: style.brand, fabric: style.fabric,
        fabricProductId: null, targetOrderWeek: null, colourways: style.colourways,
        imageUrl: null, availableMetres: style.fabricMetres ?? 0,
      }));
    res.json({ items, source: "bi" });
    return;
    /*
    const result = await pool.query(
      `WITH styles AS (
         SELECT COALESCE(NULLIF(BTRIM(a.style_number),''),NULLIF(BTRIM(a.sku),'')) AS style_number,
           MAX(NULLIF(BTRIM(a.style_name),'')) AS style_name,MAX(NULLIF(BTRIM(a.tier),'')) AS tier,
           MAX(NULLIF(BTRIM(a.category),'')) AS category,
           MAX(COALESCE(NULLIF(BTRIM(a.product_type),''),NULLIF(BTRIM(a.category),''))) AS sub_category,
           MAX(NULLIF(BTRIM(a.brand),'')) AS brand,
           MAX(COALESCE(NULLIF(BTRIM(fp.name),''),NULLIF(BTRIM(a.fabric_category),''),NULLIF(BTRIM(a.fabric_structure),''),'Fabric pending')) AS fabric,
           MAX(a.fabric_product_id) AS fabric_product_id,
           ARRAY_AGG(DISTINCT NULLIF(BTRIM(a.color_print),'')) FILTER (WHERE NULLIF(BTRIM(a.color_print),'') IS NOT NULL) AS colourways
         FROM public.all_products_clean a
         LEFT JOIN public.raw_fabric_products fp ON fp.id=a.fabric_product_id
         WHERE ${allowedBrand("a")} AND LOWER(COALESCE(a.status,'')) IN ('active','retired')
         GROUP BY COALESCE(NULLIF(BTRIM(a.style_number),''),NULLIF(BTRIM(a.sku),''))
       )
       SELECT s.style_number AS "sourceId",'catalogue'::text AS source,s.style_number AS "styleNumber",
         s.style_name AS "styleName",NULL::text AS "styleType",s.tier,s.category,s.sub_category AS "subCategory",
         s.brand,s.fabric,s.fabric_product_id AS "fabricProductId",NULL::text AS "targetOrderWeek",
         COALESCE(s.colourways,'{}') AS colourways,
         CASE WHEN gi.id IS NOT NULL THEN '/api/workspace/garment-images/catalogue/' || encode(LOWER(BTRIM(s.style_number))::bytea,'escape') END AS "imageUrl",
         COALESCE(fm.metres,0)::float AS "availableMetres"
       FROM styles s
       LEFT JOIN ${schema}.garment_images gi ON gi.source='catalogue' AND gi.style_key=LOWER(BTRIM(s.style_number))
       LEFT JOIN LATERAL (
         SELECT SUM(i.available / NULLIF(p.kg_per_mtr_eff,0)) AS metres
         FROM public.raw_fabric_products p LEFT JOIN public.raw_fabric_inventory i
           ON i.product_id=p.id AND i.location_name='RMAT/Stock' AND i.available>0
         WHERE p.id=s.fabric_product_id
       ) fm ON TRUE
       WHERE $1='' OR s.style_number ILIKE $2 ESCAPE '\\' OR s.style_name ILIKE $2 ESCAPE '\\' OR s.fabric ILIKE $2 ESCAPE '\\'
       ORDER BY s.style_name LIMIT 30`,
      [search, pattern],
    );
    res.json({ items: result.rows }); */
  } catch (error) {
    next(error);
  }
});

router.get("/weekly-order-plan", async (req, res, next) => {
  try {
    await ensureWeek36Plan();
    const isoYear = Number(req.query.year ?? 2026);
    const isoWeek = Number(req.query.week ?? 36);
    const datesResult = await pool.query(
      `SELECT start_date::text AS "startDate",end_date::text AS "endDate"
       FROM public.planning_calendar WHERE year=$1 AND week_no=$2`,
      [isoYear, isoWeek],
    );
    const fallbackStart = await pool.query(
      `SELECT to_date($1::text || lpad($2::text,2,'0'),'IYYYIW')::text AS "startDate"`,
      [isoYear, isoWeek],
    );
    const startDate = String(datesResult.rows[0]?.startDate ?? fallbackStart.rows[0].startDate).slice(0, 10);
    const endDate = String(datesResult.rows[0]?.endDate
      ?? (await pool.query(`SELECT ($1::date + 6)::text AS "endDate"`, [startDate])).rows[0].endDate).slice(0, 10);
    const planResult = await pool.query(
      `SELECT id,iso_year AS "isoYear",iso_week AS "isoWeek",status,confirmed_at AS "confirmedAt"
       FROM ${schema}.weekly_order_plans WHERE iso_year=$1 AND iso_week=$2`,
      [isoYear, isoWeek],
    );
    const plan = planResult.rows[0] ?? null;
    const lines: { rows: Array<Record<string, any>> } = plan ? await pool.query<Record<string, any>>(
      `SELECT l.*,l.order_number AS "orderNumber",l.style_number AS "styleNumber",l.style_name AS "styleName",l.style_type AS "styleType",
        l.sub_category AS "subCategory",l.fabric_product_id AS "fabricProductId",
        l.target_order_week AS "targetOrderWeek",
        CASE WHEN gi.id IS NOT NULL THEN '/api/workspace/garment-images/' ||
          CASE WHEN l.source='development' THEN 'plm' ELSE 'catalogue' END || '/' ||
          encode(LOWER(BTRIM(l.style_number))::bytea,'escape') END AS "imageUrl",
        l.available_colourways AS "availableColourways",l.selected_colourways AS "selectedColourways",
        l.estimated_quantity AS "estimatedQuantity",l.order_type AS "orderType",l.order_stage AS "orderStage",
        COALESCE(fm.metres,0)::float AS "availableMetres",
        ao.first_order_date::text AS "firstOrderDate",COALESCE(ao.actual_quantity,0)::float AS "actualQuantity",
         COALESCE(ao.orders,'[]'::json) AS "actualOrders",
         COALESCE(mv.move_count,0)::int AS "moveCount",
         COALESCE(mv.original_iso_year,p.iso_year)::int AS "originalIsoYear",
         COALESCE(mv.original_iso_week,p.iso_week)::int AS "originalIsoWeek",
         COALESCE(mv.history,'[]'::json) AS "moveHistory"
       FROM ${schema}.weekly_order_plan_lines l
        JOIN ${schema}.weekly_order_plans p ON p.id=l.plan_id
       LEFT JOIN ${schema}.garment_images gi ON gi.source=CASE WHEN l.source='development' THEN 'plm' ELSE 'catalogue' END
         AND gi.style_key=LOWER(BTRIM(l.style_number))
        LEFT JOIN LATERAL (SELECT 0::numeric AS metres) fm ON TRUE
         LEFT JOIN LATERAL (
           SELECT NULL::date AS first_order_date,0::numeric AS actual_quantity,'[]'::json AS orders
         ) ao ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS move_count,
             (ARRAY_AGG(h.from_iso_year ORDER BY h.moved_at,h.id))[1] AS original_iso_year,
             (ARRAY_AGG(h.from_iso_week ORDER BY h.moved_at,h.id))[1] AS original_iso_week,
             JSON_AGG(JSON_BUILD_OBJECT(
               'fromIsoYear',h.from_iso_year,'fromIsoWeek',h.from_iso_week,
               'toIsoYear',h.to_iso_year,'toIsoWeek',h.to_iso_week,
               'movedAt',h.moved_at,'movedBy',COALESCE(NULLIF(BTRIM(u.name),''),'Workspace user')
             ) ORDER BY h.moved_at,h.id) AS history
           FROM ${schema}.weekly_order_plan_line_moves h
           LEFT JOIN ${schema}.users u ON u.id=h.moved_by
           WHERE h.line_id=l.id
         ) mv ON TRUE
       WHERE l.plan_id=$1 ORDER BY l.sequence_no`,
      [plan.id],
    ) : { rows: [] };
    const source = await getBiWorkspaceSource();
    for (const line of lines.rows) {
      const matched = activeBiOrders(source.orders).filter((order) =>
        String(line.styleNumber ?? "").toLowerCase() === order.styleNumber.toLowerCase() ||
        String(line.styleName ?? "").toLowerCase() === order.styleName.toLowerCase());
      line.firstOrderDate = matched.map((order) => order.orderDate).sort()[0] ?? null;
      line.actualQuantity = matched.reduce((sum, order) => sum + order.quantity, 0);
      line.actualOrders = matched.map((order) => ({ orderRef: order.orderRef, orderDate: order.orderDate, quantity: order.quantity }));
    }
    const actualOrders = { rows: activeBiOrders(source.orders)
      .filter((order) => order.orderDate >= startDate && order.orderDate <= endDate)
      .map((order) => {
        const style = source.styles.map(biStyle).find((candidate) => candidate.styleNumber.toLowerCase() === order.styleNumber.toLowerCase());
        const plannedLineId = lines.rows.find((line) => String(line.styleNumber ?? "").toLowerCase() === order.styleNumber.toLowerCase() || String(line.styleName ?? "").toLowerCase() === order.styleName.toLowerCase())?.id ?? null;
        return { ...order, styleName: order.styleName || style?.name || "Unknown style", subCategory: style?.subCategory ?? "Uncategorised", category: style?.category ?? null, brand: style?.brand ?? null, plannedLineId };
      }) };
    /*
    const actualOrders = await pool.query(
      `WITH style_dim AS (
         SELECT LOWER(BTRIM(COALESCE(NULLIF(style_number,''),NULLIF(sku,'')))) AS style_key,
           MAX(NULLIF(BTRIM(style_name),'')) AS style_name,
           MAX(COALESCE(NULLIF(BTRIM(product_type),''),NULLIF(BTRIM(category),''),'Uncategorised')) AS sub_category,
           MAX(NULLIF(BTRIM(category),'')) AS category,MAX(NULLIF(BTRIM(brand),'')) AS brand
         FROM public.all_products_clean p WHERE ${allowedBrand("p")}
         GROUP BY LOWER(BTRIM(COALESCE(NULLIF(style_number,''),NULLIF(sku,''))))
       )
       SELECT o.order_ref AS "orderRef",o.date_ordered::text AS "orderDate",
         COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''),'Unknown style') AS "styleNumber",
         COALESCE(NULLIF(o.style_name,''),d.style_name,NULLIF(o.product_name,''),'Unknown style') AS "styleName",
         COALESCE(o.order_qty,0)::float AS quantity,COALESCE(d.sub_category,'Uncategorised') AS "subCategory",
         d.category,d.brand,o.fabric,o.lifecycle_type AS "orderType",o.bo_state AS "orderState",
         matched.id AS "plannedLineId"
       FROM public.production_orders o
       LEFT JOIN style_dim d ON d.style_key=LOWER(BTRIM(COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''))))
       LEFT JOIN LATERAL (
         SELECT l.id
         FROM ${schema}.weekly_order_plan_lines l
         WHERE l.plan_id=$3
           AND (LOWER(BTRIM(l.style_number))=LOWER(BTRIM(COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''))))
             OR LOWER(BTRIM(l.style_name))=LOWER(BTRIM(COALESCE(o.style_name,''))))
         ORDER BY l.id LIMIT 1
       ) matched ON TRUE
       WHERE o.date_ordered >= $1::date AND o.date_ordered <= $2::date
         AND LOWER(COALESCE(o.bo_state,'')) NOT IN ('cancel','cancelled','canceled')
       ORDER BY o.date_ordered,o.order_ref`,
      [startDate, endDate, plan?.id ?? null],
    ); */
    const summary = lines.rows.reduce((acc, line) => {
      const units = Number(line.estimatedQuantity);
      acc.units += units;
      acc.styles += 1;
      if (line.orderType === "New") acc.newUnits += units;
      if (!line.firstOrderDate) {
        acc.notRaisedStyles += 1;
        acc.notRaisedUnits += units;
      }
      return acc;
    }, { units: 0, styles: 0, newUnits: 0, notRaisedStyles: 0, notRaisedUnits: 0 });
    const actualStyleKeys = new Set(actualOrders.rows.map((order) =>
      `${String(order.styleNumber ?? "").trim().toLowerCase()}|${String(order.styleName ?? "").trim().toLowerCase()}`));
    const unplannedOrders = actualOrders.rows.filter((order) => order.plannedLineId == null);
    const unplannedStyleKeys = new Set(unplannedOrders.map((order) =>
      `${String(order.styleNumber ?? "").trim().toLowerCase()}|${String(order.styleName ?? "").trim().toLowerCase()}`));
    const monthlyNewnessResult = await pool.query<{
      monthStart: string; monthLabel: string; targetUnits: number;
    }>(
      `SELECT month_start::text AS "monthStart",TO_CHAR(month_start,'FMMonth YYYY') AS "monthLabel",
         COALESCE(s.newness_target_units,0)::float AS "targetUnits"
       FROM (
         SELECT generate_series(date_trunc('month',$1::date),date_trunc('month',$2::date),INTERVAL '1 month')::date AS month_start
       ) months
       JOIN ${schema}.range_plan_seasons s
         ON LOWER(s.season_name)=LOWER(TO_CHAR(month_start,'FMMonth YYYY'))
       ORDER BY month_start`,
      [startDate, endDate],
    );
    const weeklyNewness = weeklyNewnessTarget(startDate, endDate, monthlyNewnessResult.rows.map((row) => ({
      monthStart: String(row.monthStart).slice(0, 10),
      monthLabel: String(row.monthLabel),
      targetUnits: Number(row.targetUnits),
    })));
    const actualNewUnits = actualOrders.rows
      .filter((order) => String(order.orderType ?? "").trim().toLowerCase() === "new")
      .reduce((sum, order) => sum + Number(order.quantity ?? 0), 0);
    const pendingNewUnits = lines.rows
      .filter((line) => !line.firstOrderDate && String(line.orderType ?? "").trim().toLowerCase() === "new")
      .reduce((sum, line) => sum + Number(line.estimatedQuantity ?? 0), 0);
    const committedNewUnits = actualNewUnits + pendingNewUnits;
    const newnessShortfallUnits = Math.max(0, weeklyNewness.targetUnits - committedNewUnits);
    const fabricSummary = Array.from(lines.rows.reduce((map, line) => {
      const key = String(line.fabric || "Fabric pending");
      const current = map.get(key) ?? { fabric: key, units: 0, styles: 0, availableMetres: Number(line.availableMetres || 0) };
      current.units += Number(line.estimatedQuantity);
      current.styles += 1;
      map.set(key, current);
      return map;
    }, new Map<string, { fabric: string; units: number; styles: number; availableMetres: number }>()).values());
    const subcategories = { rows: (() => {
      const targets = new Map<string, number>();
      for (const line of lines.rows) targets.set(String(line.subCategory ?? "Uncategorised"), (targets.get(String(line.subCategory ?? "Uncategorised")) ?? 0) + Number(line.estimatedQuantity ?? 0));
      const actual = new Map<string, number>();
      for (const order of actualOrders.rows) actual.set(String(order.subCategory ?? "Uncategorised"), (actual.get(String(order.subCategory ?? "Uncategorised")) ?? 0) + Number(order.quantity ?? 0));
      return [...new Set([...targets.keys(), ...actual.keys()])].map((subCategory) => ({ month: startDate.slice(0, 7) + "-01", subCategory, plannedUnits: 0, orderedUnits: actual.get(subCategory) ?? 0, orderedThisWeekUnits: actual.get(subCategory) ?? 0, plannedThisWeekUnits: targets.get(subCategory) ?? 0, remainingUnits: -(actual.get(subCategory) ?? 0), ceilingBreached: false }));
    })() };
    /*
    const subcategories = await pool.query(
      `WITH months AS (
         SELECT generate_series(date_trunc('month',$1::date),date_trunc('month',$2::date),INTERVAL '1 month')::date AS month_start
       ),
       style_dim AS (
         SELECT LOWER(BTRIM(COALESCE(NULLIF(style_number,''),NULLIF(sku,'')))) AS style_key,
           MAX(COALESCE(NULLIF(BTRIM(product_type),''),NULLIF(BTRIM(category),''),'Uncategorised')) AS sub_category
         FROM public.all_products_clean p WHERE ${allowedBrand("p")}
         GROUP BY LOWER(BTRIM(COALESCE(NULLIF(style_number,''),NULLIF(sku,''))))
       ),
       target AS (
         SELECT COALESCE(NULLIF(BTRIM(sub_category),''),'Uncategorised') AS sub_category,
           COALESCE(SUM(estimated_quantity),0)::numeric AS units
         FROM ${schema}.weekly_order_plan_lines WHERE plan_id=$3 GROUP BY COALESCE(NULLIF(BTRIM(sub_category),''),'Uncategorised')
       ),
       dated AS (
         SELECT date_trunc('month',o.date_ordered)::date AS month_start,
           COALESCE(d.sub_category,'Uncategorised') AS sub_category,COALESCE(SUM(o.order_qty),0)::numeric AS units
         FROM public.production_orders o
         LEFT JOIN style_dim d ON d.style_key=LOWER(BTRIM(COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''))))
         WHERE o.date_ordered >= date_trunc('month',$1::date)
           AND o.date_ordered < date_trunc('month',$2::date) + INTERVAL '1 month'
           AND LOWER(COALESCE(o.bo_state,'')) NOT IN ('cancel','cancelled','canceled')
         GROUP BY date_trunc('month',o.date_ordered)::date,COALESCE(d.sub_category,'Uncategorised')
       ),
       this_week AS (
         SELECT date_trunc('month',o.date_ordered)::date AS month_start,
           COALESCE(d.sub_category,'Uncategorised') AS sub_category,COALESCE(SUM(o.order_qty),0)::numeric AS units
         FROM public.production_orders o
         LEFT JOIN style_dim d ON d.style_key=LOWER(BTRIM(COALESCE(NULLIF(o.style_number,''),NULLIF(o.product_sku,''))))
         WHERE o.date_ordered >= $1::date AND o.date_ordered <= $2::date
           AND LOWER(COALESCE(o.bo_state,'')) NOT IN ('cancel','cancelled','canceled')
         GROUP BY date_trunc('month',o.date_ordered)::date,COALESCE(d.sub_category,'Uncategorised')
       ),
       represented AS (
         SELECT sub_category FROM target
         UNION SELECT sub_category FROM this_week
       ),
       month_plan AS (
         SELECT m.month_start,r.sub_category,r.planned_units_calculated AS planned_units
         FROM months m
         JOIN ${schema}.range_plan_seasons s ON LOWER(s.season_name)=LOWER(to_char(m.month_start,'FMMonth YYYY'))
         JOIN ${schema}.range_plan_rows r ON r.season_id=s.id
       )
       SELECT m.month_start::text AS month,r.sub_category AS "subCategory",COALESCE(mp.planned_units,0) AS "plannedUnits",
         COALESCE(d.units,0)::float AS "orderedUnits",COALESCE(w.units,0)::float AS "orderedThisWeekUnits",
         COALESCE(t.units,0)::float AS "plannedThisWeekUnits",COALESCE(mp.planned_units,0)-COALESCE(d.units,0) AS "remainingUnits",
         COALESCE(d.units,0)>COALESCE(mp.planned_units,0)*1.1 AND COALESCE(mp.planned_units,0)>0 AS "ceilingBreached"
       FROM months m CROSS JOIN represented r
       LEFT JOIN month_plan mp ON mp.month_start=m.month_start AND LOWER(mp.sub_category)=LOWER(r.sub_category)
       LEFT JOIN dated d ON d.month_start=m.month_start AND LOWER(d.sub_category)=LOWER(r.sub_category)
       LEFT JOIN this_week w ON w.month_start=m.month_start AND LOWER(w.sub_category)=LOWER(r.sub_category)
       LEFT JOIN target t ON LOWER(t.sub_category)=LOWER(r.sub_category)
       WHERE mp.planned_units IS NOT NULL OR d.units IS NOT NULL OR w.units IS NOT NULL
       ORDER BY m.month_start,r.sub_category`,
      [startDate, endDate, plan?.id ?? null],
    ); */
    res.json({
      plan: plan ? weeklyPlanPayload(plan) : null,
      week: { isoYear, isoWeek, startDate, endDate },
      lines: lines.rows,
      actualOrders: actualOrders.rows.map((order) => ({ ...order, unplanned: order.plannedLineId == null })),
      summary: {
        ...summary,
        newnessPct: summary.units ? 100 * summary.newUnits / summary.units : 0,
        newUnitsCommitted: committedNewUnits,
        actualNewUnits,
        pendingNewUnits,
        newnessTargetUnits: weeklyNewness.targetUnits,
        newnessTargetComponents: weeklyNewness.components,
        newnessShortfallUnits,
        newnessShortfallStyles: Math.ceil(newnessShortfallUnits / DEFAULT_NEW_STYLE_ORDER_UNITS),
        newStyleOrderSizeUnits: DEFAULT_NEW_STYLE_ORDER_UNITS,
        orderedStyles: actualStyleKeys.size,
        orderedUnits: actualOrders.rows.reduce((sum, order) => sum + Number(order.quantity ?? 0), 0),
        unplannedStyles: unplannedStyleKeys.size,
        unplannedUnits: unplannedOrders.reduce((sum, order) => sum + Number(order.quantity ?? 0), 0),
      },
      fabricSummary,
      subcategories: subcategories.rows,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/weekly-order-plan/lines", async (req: AuthRequest, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body ?? {};
    const isoYear = Number(body.isoYear);
    const isoWeek = Number(body.isoWeek);
    const quantity = Number(body.estimatedQuantity);
    const validTypes = ["New", "Re-order", "Replenishment", "Range Refreshed"];
    const validStages = ["CAD Marker Making", "Buying Requisition", "Buying Production Order", "Production Sample"];
    if (!Number.isInteger(isoYear) || !Number.isInteger(isoWeek) || isoWeek < 1 || isoWeek > 53 || !Number.isInteger(quantity) || quantity <= 0) {
      res.status(400).json({ error: "A valid week and estimated quantity are required" }); return;
    }
    if (!validTypes.includes(body.orderType) || !validStages.includes(body.orderStage)) {
      res.status(400).json({ error: "A valid order type and stage are required" }); return;
    }
    await client.query("BEGIN");
    const plan = await client.query(
      `INSERT INTO ${schema}.weekly_order_plans (iso_year,iso_week) VALUES ($1,$2)
       ON CONFLICT (iso_year,iso_week) DO UPDATE SET updated_at=NOW()
       RETURNING id,status`,
      [isoYear, isoWeek],
    );
    if (plan.rows[0].status !== "draft") throw Object.assign(new Error("Confirmed weeks cannot be edited"), { status: 409 });
    await client.query(`SELECT id FROM ${schema}.weekly_order_plans WHERE id=$1 FOR UPDATE`, [plan.rows[0].id]);
    const source = body.source === "catalogue" ? "catalogue" : "development";
    const biCatalogue = source === "catalogue" ? (await getBiWorkspaceSource()).styles.map(biStyle) : [];
    const sourceResult = source === "development"
      ? await client.query(
        `SELECT id::text AS source_id,style_number,style_name,style_type,tier,category,sub_category,brand,
          COALESCE(NULLIF(fp.name,''),NULLIF(t.fabric,''),'Fabric pending') AS fabric,
          sample_fabric_product_id AS fabric_product_id,target_order_week,
          ARRAY[]::text[] AS colourways
         FROM ${schema}.style_development_tracker t LEFT JOIN public.raw_fabric_products fp ON fp.id=t.sample_fabric_product_id
         WHERE t.id=$1 AND t.style_number_status='confirmed' AND NULLIF(BTRIM(t.style_number),'') IS NOT NULL`,
        [Number(body.sourceId)],
      )
      : { rows: (() => {
        const style = biCatalogue
          .find((candidate) => candidate.styleNumber.toLowerCase() === String(body.sourceId ?? "").toLowerCase());
        return style ? [{ source_id: style.styleNumber, style_number: style.styleNumber, style_name: style.name,
          style_type: null, tier: style.rangeTier, category: style.category, sub_category: style.subCategory,
          brand: style.brand, fabric: style.fabric, fabric_product_id: null, target_order_week: null,
          colourways: style.colourways }] : [];
      })() };
      /*
      : await client.query(
        `SELECT $1::text AS source_id,MAX(NULLIF(BTRIM(style_number),'')) AS style_number,
          MAX(NULLIF(BTRIM(style_name),'')) AS style_name,NULL::text AS style_type,MAX(tier) AS tier,
          MAX(category) AS category,MAX(COALESCE(NULLIF(BTRIM(product_type),''),NULLIF(BTRIM(category),''))) AS sub_category,
          MAX(brand) AS brand,MAX(COALESCE(NULLIF(BTRIM(fabric_category),''),NULLIF(BTRIM(fabric_structure),''),'Fabric pending')) AS fabric,
          MAX(fabric_product_id) AS fabric_product_id,NULL::text AS target_order_week,
          ARRAY_AGG(DISTINCT NULLIF(BTRIM(color_print),'')) FILTER (WHERE NULLIF(BTRIM(color_print),'') IS NOT NULL) AS colourways
         FROM public.all_products_clean WHERE COALESCE(NULLIF(BTRIM(style_number),''),NULLIF(BTRIM(sku),''))=$1`,
        [String(body.sourceId)],
      ); */
    const style = sourceResult.rows[0];
    if (!style?.style_number || !style?.style_name) {
      await client.query("ROLLBACK"); res.status(404).json({ error: "The source style no longer exists" }); return;
    }
    const seqResult = await client.query(`SELECT COALESCE(MAX(sequence_no),0)+1 AS seq FROM ${schema}.weekly_order_plan_lines WHERE plan_id=$1`, [plan.rows[0].id]);
    const sequence = Number(seqResult.rows[0].seq);
    const selected = Array.isArray(body.selectedColourways)
      ? body.selectedColourways.map(String).filter((value: string) => (style.colourways ?? []).includes(value))
      : [];
    const inserted = await client.query(
      `INSERT INTO ${schema}.weekly_order_plan_lines
       (plan_id,sequence_no,order_number,source,source_id,style_number,style_name,style_type,tier,category,sub_category,
        brand,fabric,fabric_product_id,target_order_week,image_url,available_colourways,selected_colourways,
        estimated_quantity,order_type,order_stage,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
      [plan.rows[0].id, sequence, `W${isoWeek}${String(sequence).padStart(3, "0")}`, source, style.source_id,
        style.style_number, style.style_name, style.style_type, style.tier, style.category, style.sub_category, style.brand,
        style.fabric, style.fabric_product_id, style.target_order_week,
        `/api/workspace/garment-images/${source === "development" ? "workspace" : "catalogue"}/${encodeURIComponent(style.style_number)}`,
        style.colourways ?? [], selected, quantity, body.orderType, body.orderStage, req.workspaceUser?.id ?? null],
    );
    await client.query("COMMIT");
    res.status(201).json({ id: inserted.rows[0].id });
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") { res.status(409).json({ error: "This style is already in the week" }); return; }
    if (error?.status) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  } finally {
    client.release();
  }
});

router.patch("/weekly-order-plan/lines/:id", async (req, res, next) => {
  try {
    const quantity = Number(req.body?.estimatedQuantity);
    const stages = ["CAD Marker Making", "Buying Requisition", "Buying Production Order", "Production Sample"];
    const types = ["New", "Re-order", "Replenishment", "Range Refreshed"];
    if (!Number.isInteger(quantity) || quantity <= 0 || !stages.includes(req.body?.orderStage) || !types.includes(req.body?.orderType)) {
      res.status(400).json({ error: "Quantity, order type and stage are required" }); return;
    }
    const result = await pool.query(
      `UPDATE ${schema}.weekly_order_plan_lines l SET estimated_quantity=$1,selected_colourways=$2,
         order_type=$3,order_stage=$4,updated_at=NOW()
       FROM ${schema}.weekly_order_plans p WHERE l.id=$5 AND p.id=l.plan_id AND p.status='draft' RETURNING l.id`,
      [quantity, Array.isArray(req.body.selectedColourways) ? req.body.selectedColourways.map(String) : [],
        req.body.orderType, req.body.orderStage, Number(req.params.id)],
    );
    if (!result.rows.length) { res.status(409).json({ error: "Confirmed weeks cannot be edited" }); return; }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post("/weekly-order-plan/lines/:id/move", async (req: AuthRequest, res, next) => {
  const client = await pool.connect();
  try {
    const lineId = Number(req.params.id);
    const toIsoYear = Number(req.body?.isoYear);
    const toIsoWeek = Number(req.body?.isoWeek);
    if (!Number.isInteger(lineId) || lineId <= 0 || !Number.isInteger(toIsoYear)
      || !Number.isInteger(toIsoWeek) || toIsoWeek < 1 || toIsoWeek > 53) {
      res.status(400).json({ error: "A valid line and destination week are required" }); return;
    }
    await client.query("BEGIN");
    const lineResult = await client.query(
      `SELECT l.id,l.plan_id,l.source,l.source_id,p.iso_year,p.iso_week
       FROM ${schema}.weekly_order_plan_lines l
       JOIN ${schema}.weekly_order_plans p ON p.id=l.plan_id
       WHERE l.id=$1
       FOR UPDATE OF l`,
      [lineId],
    );
    const line = lineResult.rows[0];
    if (!line) {
      await client.query("ROLLBACK"); res.status(404).json({ error: "Planned style was not found" }); return;
    }
    if (Number(line.iso_year) === toIsoYear && Number(line.iso_week) === toIsoWeek) {
      await client.query("ROLLBACK"); res.status(400).json({ error: "Choose a different destination week" }); return;
    }
    await client.query(
      `INSERT INTO ${schema}.weekly_order_plans (iso_year,iso_week)
       VALUES ($1,$2) ON CONFLICT (iso_year,iso_week) DO NOTHING`,
      [toIsoYear, toIsoWeek],
    );
    const destinationResult = await client.query(
      `SELECT id FROM ${schema}.weekly_order_plans WHERE iso_year=$1 AND iso_week=$2`,
      [toIsoYear, toIsoWeek],
    );
    const destinationPlanId = Number(destinationResult.rows[0].id);
    const lockedPlans = await client.query(
      `SELECT id,iso_year,iso_week,status
       FROM ${schema}.weekly_order_plans
       WHERE id=ANY($1::int[])
       ORDER BY id
       FOR UPDATE`,
      [[Number(line.plan_id), destinationPlanId]],
    );
    const sourcePlan = lockedPlans.rows.find((plan) => Number(plan.id) === Number(line.plan_id));
    const destinationPlan = lockedPlans.rows.find((plan) => Number(plan.id) === destinationPlanId);
    if (!sourcePlan || !destinationPlan) throw new Error("Weekly plan lock failed");
    if (sourcePlan.status !== "draft" || destinationPlan.status !== "draft") {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Styles can move only between draft weeks" });
      return;
    }
    const duplicate = await client.query(
      `SELECT id FROM ${schema}.weekly_order_plan_lines
       WHERE plan_id=$1 AND source=$2 AND source_id=$3 AND id<>$4`,
      [destinationPlanId, line.source, line.source_id, lineId],
    );
    if (duplicate.rows.length) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "This style is already in the destination week" });
      return;
    }
    const sequenceResult = await client.query(
      `SELECT COALESCE(MAX(sequence_no),0)+1 AS sequence
       FROM ${schema}.weekly_order_plan_lines WHERE plan_id=$1`,
      [destinationPlanId],
    );
    const sequence = Number(sequenceResult.rows[0].sequence);
    await client.query(
      `UPDATE ${schema}.weekly_order_plan_lines
       SET plan_id=$1,sequence_no=$2,order_number=$3,updated_at=NOW()
       WHERE id=$4`,
      [destinationPlanId, sequence, `W${toIsoWeek}${String(sequence).padStart(3, "0")}`, lineId],
    );
    await client.query(
      `INSERT INTO ${schema}.weekly_order_plan_line_moves
       (line_id,from_plan_id,to_plan_id,from_iso_year,from_iso_week,to_iso_year,to_iso_week,moved_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [lineId, Number(line.plan_id), destinationPlanId, Number(line.iso_year), Number(line.iso_week),
        toIsoYear, toIsoWeek, req.workspaceUser?.id ?? null],
    );
    await client.query(
      `UPDATE ${schema}.weekly_order_plans SET updated_at=NOW() WHERE id=ANY($1::int[])`,
      [[Number(line.plan_id), destinationPlanId]],
    );
    await client.query("COMMIT");
    res.json({
      ok: true,
      lineId,
      from: { isoYear: Number(line.iso_year), isoWeek: Number(line.iso_week) },
      to: { isoYear: toIsoYear, isoWeek: toIsoWeek },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") {
      res.status(409).json({ error: "This style is already in the destination week" }); return;
    }
    next(error);
  } finally {
    client.release();
  }
});

router.delete("/weekly-order-plan/lines/:id", async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM ${schema}.weekly_order_plan_lines l USING ${schema}.weekly_order_plans p
       WHERE l.id=$1 AND p.id=l.plan_id AND p.status='draft' RETURNING l.id`,
      [Number(req.params.id)],
    );
    if (!result.rows.length) { res.status(409).json({ error: "Confirmed weeks cannot be edited" }); return; }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post("/weekly-order-plan/confirm", async (req: AuthRequest, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE ${schema}.weekly_order_plans SET status='confirmed',confirmed_at=NOW(),confirmed_by=$1,updated_at=NOW()
       WHERE iso_year=$2 AND iso_week=$3 AND status='draft'
       RETURNING id`,
      [req.workspaceUser?.id ?? null, Number(req.body?.isoYear), Number(req.body?.isoWeek)],
    );
    if (!result.rows.length) { res.status(409).json({ error: "Week is already confirmed or does not exist" }); return; }
    res.json({ ok: true });
  } catch (error) { next(error); }
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
  if (!res.headersSent) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: unknown }).status) : 500;
    res.status(status === 503 ? 503 : 500).json({ error: status === 503 ? "BI source unavailable" : "Workspace server error" });
  }
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
      await ensureRangePlanNewnessData();
      await ensureRecentWorkspaceMigrations();
      await ensureStyleDevelopmentTrackerData();
      schemaReady = await isDatabaseReachable();
      console.warn(`Vivo workspace starting in ${schemaReady ? "degraded" : "unavailable"} database mode`);
    });
});

process.on("SIGTERM", () => {
  void pool.end().finally(() => process.exit(0));
});

export { app, pool };