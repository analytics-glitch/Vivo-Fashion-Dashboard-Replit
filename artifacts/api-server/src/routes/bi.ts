import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import {
  GetKpiSummaryResponse,
  GetRevenueTrendResponse,
  GetSalesByBrandResponse,
  GetSalesByCategoryResponse,
  GetSalesByRegionResponse,
  GetSalesByChannelResponse,
  GetTopProductsResponse,
  GetStorePerformanceResponse,
  GetInventoryHealthResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

let cachedYears: { current: number; prior: number } | null = null;

async function getReportingYears(): Promise<{ current: number; prior: number }> {
  if (cachedYears) return cachedYears;
  const { rows } = await pool.query<{ max_year: string | null }>(
    `SELECT MAX(EXTRACT(YEAR FROM sale_date))::int AS max_year FROM sales_lines`,
  );
  const current = rows[0]?.max_year ? Number(rows[0].max_year) : new Date().getFullYear();
  cachedYears = { current, prior: current - 1 };
  return cachedYears;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const pctChange = (cur: number, prior: number): number =>
  prior === 0 ? 0 : ((cur - prior) / prior) * 100;
const round = (v: number, d = 2): number => {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
};

router.get("/bi/summary", async (req: Request, res: Response): Promise<void> => {
  const { current: CURRENT_YEAR, prior: PRIOR_YEAR } = await getReportingYears();
  const { rows } = await pool.query<{
    year: number;
    revenue: string;
    cost: string;
    units: string;
    returned: string;
    orders: string;
    online_revenue: string;
    stores: string;
  }>(
    `SELECT
       EXTRACT(YEAR FROM sale_date)::int AS year,
       SUM(revenue) AS revenue,
       SUM(cost) AS cost,
       SUM(units) AS units,
       SUM(returned_units) AS returned,
       COUNT(DISTINCT order_id) AS orders,
       SUM(revenue) FILTER (WHERE channel = 'Online') AS online_revenue,
       COUNT(DISTINCT store) AS stores
     FROM sales_lines
     WHERE EXTRACT(YEAR FROM sale_date) IN ($1, $2)
     GROUP BY 1`,
    [CURRENT_YEAR, PRIOR_YEAR],
  );

  const cur = rows.find((r) => r.year === CURRENT_YEAR);
  const prior = rows.find((r) => r.year === PRIOR_YEAR);

  const curRev = num(cur?.revenue);
  const priorRev = num(prior?.revenue);
  const curUnits = num(cur?.units);
  const priorUnits = num(prior?.units);
  const curOrders = num(cur?.orders);
  const priorOrders = num(prior?.orders);

  const curAov = curOrders === 0 ? 0 : curRev / curOrders;
  const priorAov = priorOrders === 0 ? 0 : priorRev / priorOrders;

  const curMargin = curRev === 0 ? 0 : ((curRev - num(cur?.cost)) / curRev) * 100;
  const priorMargin =
    priorRev === 0 ? 0 : ((priorRev - num(prior?.cost)) / priorRev) * 100;

  const curReturn = curUnits === 0 ? 0 : (num(cur?.returned) / curUnits) * 100;
  const priorReturn =
    priorUnits === 0 ? 0 : (num(prior?.returned) / priorUnits) * 100;

  const onlineShare = curRev === 0 ? 0 : (num(cur?.online_revenue) / curRev) * 100;

  const data = GetKpiSummaryResponse.parse({
    totalRevenue: round(curRev),
    revenueGrowthPct: round(pctChange(curRev, priorRev)),
    unitsSold: curUnits,
    unitsGrowthPct: round(pctChange(curUnits, priorUnits)),
    avgOrderValue: round(curAov),
    aovGrowthPct: round(pctChange(curAov, priorAov)),
    grossMarginPct: round(curMargin),
    marginChangePct: round(curMargin - priorMargin),
    returnRatePct: round(curReturn),
    returnRateChangePct: round(curReturn - priorReturn),
    onlineSharePct: round(onlineShare),
    activeStores: num(cur?.stores),
  });
  res.json(data);
});

router.get(
  "/bi/revenue-trend",
  async (req: Request, res: Response): Promise<void> => {
    const { current: CURRENT_YEAR, prior: PRIOR_YEAR } = await getReportingYears();
    const { rows } = await pool.query<{
      month: number;
      year: number;
      revenue: string;
    }>(
      `SELECT
         EXTRACT(MONTH FROM sale_date)::int AS month,
         EXTRACT(YEAR FROM sale_date)::int AS year,
         SUM(revenue) AS revenue
       FROM sales_lines
       WHERE EXTRACT(YEAR FROM sale_date) IN ($1, $2)
       GROUP BY 1, 2`,
      [CURRENT_YEAR, PRIOR_YEAR],
    );

    const labels = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const data = GetRevenueTrendResponse.parse(
      labels.map((label, idx) => {
        const m = idx + 1;
        const cur = rows.find((r) => r.month === m && r.year === CURRENT_YEAR);
        const prior = rows.find((r) => r.month === m && r.year === PRIOR_YEAR);
        return {
          month: label,
          currentYear: round(num(cur?.revenue)),
          priorYear: round(num(prior?.revenue)),
        };
      }),
    );
    res.json(data);
  },
);

router.get(
  "/bi/sales-by-brand",
  async (req: Request, res: Response): Promise<void> => {
    const { current: CURRENT_YEAR, prior: PRIOR_YEAR } = await getReportingYears();
    const { rows } = await pool.query<{
      brand: string;
      year: number;
      revenue: string;
      cost: string;
      units: string;
    }>(
      `SELECT brand,
         EXTRACT(YEAR FROM sale_date)::int AS year,
         SUM(revenue) AS revenue,
         SUM(cost) AS cost,
         SUM(units) AS units
       FROM sales_lines
       WHERE EXTRACT(YEAR FROM sale_date) IN ($1, $2)
       GROUP BY brand, year`,
      [CURRENT_YEAR, PRIOR_YEAR],
    );

    const brands = [...new Set(rows.map((r) => r.brand))];
    const data = GetSalesByBrandResponse.parse(
      brands
        .map((brand) => {
          const cur = rows.find((r) => r.brand === brand && r.year === CURRENT_YEAR);
          const prior = rows.find((r) => r.brand === brand && r.year === PRIOR_YEAR);
          const rev = num(cur?.revenue);
          const margin = rev === 0 ? 0 : ((rev - num(cur?.cost)) / rev) * 100;
          return {
            brand,
            revenue: round(rev),
            units: num(cur?.units),
            marginPct: round(margin),
            growthPct: round(pctChange(rev, num(prior?.revenue))),
          };
        })
        .sort((a, b) => b.revenue - a.revenue),
    );
    res.json(data);
  },
);

router.get(
  "/bi/sales-by-category",
  async (req: Request, res: Response): Promise<void> => {
    const { current: CURRENT_YEAR } = await getReportingYears();
    const { rows } = await pool.query<{
      category: string;
      revenue: string;
      cost: string;
      units: string;
    }>(
      `SELECT category,
         SUM(revenue) AS revenue,
         SUM(cost) AS cost,
         SUM(units) AS units
       FROM sales_lines
       WHERE EXTRACT(YEAR FROM sale_date) = $1
       GROUP BY category`,
      [CURRENT_YEAR],
    );
    const data = GetSalesByCategoryResponse.parse(
      rows
        .map((r) => {
          const rev = num(r.revenue);
          const margin = rev === 0 ? 0 : ((rev - num(r.cost)) / rev) * 100;
          return {
            category: r.category,
            revenue: round(rev),
            units: num(r.units),
            marginPct: round(margin),
          };
        })
        .sort((a, b) => b.revenue - a.revenue),
    );
    res.json(data);
  },
);

router.get(
  "/bi/sales-by-region",
  async (req: Request, res: Response): Promise<void> => {
    const { current: CURRENT_YEAR, prior: PRIOR_YEAR } = await getReportingYears();
    const { rows } = await pool.query<{
      region: string;
      year: number;
      revenue: string;
      units: string;
    }>(
      `SELECT region,
         EXTRACT(YEAR FROM sale_date)::int AS year,
         SUM(revenue) AS revenue,
         SUM(units) AS units
       FROM sales_lines
       WHERE EXTRACT(YEAR FROM sale_date) IN ($1, $2)
       GROUP BY region, year`,
      [CURRENT_YEAR, PRIOR_YEAR],
    );
    const regions = [...new Set(rows.map((r) => r.region))];
    const data = GetSalesByRegionResponse.parse(
      regions
        .map((region) => {
          const cur = rows.find((r) => r.region === region && r.year === CURRENT_YEAR);
          const prior = rows.find((r) => r.region === region && r.year === PRIOR_YEAR);
          const rev = num(cur?.revenue);
          return {
            region,
            revenue: round(rev),
            units: num(cur?.units),
            growthPct: round(pctChange(rev, num(prior?.revenue))),
          };
        })
        .sort((a, b) => b.revenue - a.revenue),
    );
    res.json(data);
  },
);

router.get(
  "/bi/sales-by-channel",
  async (req: Request, res: Response): Promise<void> => {
    const { current: CURRENT_YEAR } = await getReportingYears();
    const { rows } = await pool.query<{
      channel: string;
      revenue: string;
      units: string;
      orders: string;
    }>(
      `SELECT channel,
         SUM(revenue) AS revenue,
         SUM(units) AS units,
         COUNT(DISTINCT order_id) AS orders
       FROM sales_lines
       WHERE EXTRACT(YEAR FROM sale_date) = $1
       GROUP BY channel`,
      [CURRENT_YEAR],
    );
    const data = GetSalesByChannelResponse.parse(
      rows
        .map((r) => ({
          channel: r.channel,
          revenue: round(num(r.revenue)),
          units: num(r.units),
          orders: num(r.orders),
        }))
        .sort((a, b) => b.revenue - a.revenue),
    );
    res.json(data);
  },
);

router.get(
  "/bi/top-products",
  async (req: Request, res: Response): Promise<void> => {
    const { current: CURRENT_YEAR } = await getReportingYears();
    const { rows } = await pool.query<{
      sku: string;
      name: string;
      brand: string;
      category: string;
      revenue: string;
      cost: string;
      units: string;
    }>(
      `SELECT sku,
         product_name AS name,
         brand,
         category,
         SUM(revenue) AS revenue,
         SUM(cost) AS cost,
         SUM(units) AS units
       FROM sales_lines
       WHERE EXTRACT(YEAR FROM sale_date) = $1
       GROUP BY sku, product_name, brand, category
       ORDER BY SUM(revenue) DESC
       LIMIT 15`,
      [CURRENT_YEAR],
    );
    const data = GetTopProductsResponse.parse(
      rows.map((r) => {
        const rev = num(r.revenue);
        const margin = rev === 0 ? 0 : ((rev - num(r.cost)) / rev) * 100;
        return {
          sku: r.sku,
          name: r.name,
          brand: r.brand,
          category: r.category,
          revenue: round(rev),
          units: num(r.units),
          marginPct: round(margin),
        };
      }),
    );
    res.json(data);
  },
);

router.get(
  "/bi/store-performance",
  async (req: Request, res: Response): Promise<void> => {
    const { current: CURRENT_YEAR, prior: PRIOR_YEAR } = await getReportingYears();
    const { rows } = await pool.query<{
      store: string;
      year: number;
      revenue: string;
      units: string;
    }>(
      `SELECT store,
         EXTRACT(YEAR FROM sale_date)::int AS year,
         SUM(revenue) AS revenue,
         SUM(units) AS units
       FROM sales_lines
       WHERE EXTRACT(YEAR FROM sale_date) IN ($1, $2)
       GROUP BY store, year`,
      [CURRENT_YEAR, PRIOR_YEAR],
    );
    const targets = await pool.query<{ name: string; region: string; annual_target: string }>(
      `SELECT name, region, annual_target FROM stores`,
    );
    const targetMap = new Map(
      targets.rows.map((t) => [t.name, { region: t.region, target: num(t.annual_target) }]),
    );

    const stores = [...new Set(rows.map((r) => r.store))];
    const data = GetStorePerformanceResponse.parse(
      stores
        .map((store) => {
          const cur = rows.find((r) => r.store === store && r.year === CURRENT_YEAR);
          const prior = rows.find((r) => r.store === store && r.year === PRIOR_YEAR);
          const rev = num(cur?.revenue);
          const meta = targetMap.get(store);
          const targetPct = meta && meta.target > 0 ? (rev / meta.target) * 100 : 0;
          return {
            store,
            region: meta?.region ?? "—",
            revenue: round(rev),
            units: num(cur?.units),
            targetPct: round(targetPct),
            growthPct: round(pctChange(rev, num(prior?.revenue))),
          };
        })
        .sort((a, b) => b.revenue - a.revenue),
    );
    res.json(data);
  },
);

router.get(
  "/bi/inventory-health",
  async (req: Request, res: Response): Promise<void> => {
    const { rows } = await pool.query<{
      category: string;
      stock_units: number;
      stock_value: string;
      weeks_of_cover: string;
      sell_through_pct: string;
    }>(
      `SELECT category, stock_units, stock_value, weeks_of_cover, sell_through_pct
       FROM inventory
       ORDER BY stock_value DESC`,
    );
    const data = GetInventoryHealthResponse.parse(
      rows.map((r) => ({
        category: r.category,
        stockUnits: num(r.stock_units),
        stockValue: round(num(r.stock_value)),
        weeksOfCover: round(num(r.weeks_of_cover), 1),
        sellThroughPct: round(num(r.sell_through_pct), 1),
      })),
    );
    res.json(data);
  },
);

export default router;
