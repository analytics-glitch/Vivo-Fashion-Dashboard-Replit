type PipelineStage =
  | "buying_order"
  | "cutting"
  | "waiting_sewing"
  | "sewing"
  | "washing"
  | "finishing"
  | "repairs"
  | "defects"
  | "warehouse"
  | string;

export type LedgerPipelineRow = {
  orderRef: string;
  styleKey: string;
  stage: PipelineStage;
  sku: string | null;
  qty: number;
  boState?: string | null;
};

export type LivePipelineRow = {
  sku: string;
  styleKey: string;
  stage: "waiting_sewing" | "sewing" | "finishing";
  sewingLine: string | null;
  qty: number;
};

export type ProductionVariantRow = {
  orderRef: string;
  styleKey: string;
  sku: string;
  qty: number;
  dateOrdered: string | null;
};

export type FinishingOffsetRow = {
  orderRef: string;
  sku: string | null;
  qty: number;
};

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

// Pipeline is deliberately a whitelist.  A balance can be present in the
// ledger before a newly introduced terminal stage is classified, and treating
// every unknown stage as WIP would make sellable stock look like supply.
const ACTIVE_LEDGER_STAGES = new Set(["buying_order", "cutting", "washing", "repairs"]);
const LIVE_STAGES = new Set(["waiting_sewing", "sewing", "finishing"]);
const TERMINAL_LEDGER_STAGES = new Set(["warehouse", "received"]);
const LIVE_STAGE_RANK: Record<LivePipelineRow["stage"], number> = {
  waiting_sewing: 1,
  sewing: 2,
  finishing: 3,
};

const numeric = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizedKey = (value: unknown) => String(value ?? "").trim().toLowerCase();

const orderSkuKey = (orderRef: string, sku: string) => `${orderRef}\u0000${sku}`;

type AllocatedLiveRow = {
  orderRef: string | null;
  styleKey: string;
  stage: LivePipelineRow["stage"];
  sku: string;
  sewingLine: string | null;
  qty: number;
};

/**
 * Reproduces the Production Tracker's current-stage source:
 * - ledger balances own Buying Order, Cutting, Washing and Repairs;
 * - live Odoo locations replace ledger Waiting Sewing, Sewing and Finishing;
 * - Warehouse, received stock, and every unclassified/terminal stage are
 *   never pipeline.
 */
export function productionPipelineByStyle(input: {
  ledger: LedgerPipelineRow[];
  live: LivePipelineRow[];
  variants: ProductionVariantRow[];
  offsets: FinishingOffsetRow[];
}) {
  const result = new Map<string, number>();
  const add = (styleKey: string, qty: number) => {
    const key = normalizedKey(styleKey);
    if (!key || qty <= 0) return;
    result.set(key, (result.get(key) ?? 0) + qty);
  };
  const terminalOrders = new Set(
    input.ledger
      .filter((row) => TERMINAL_LEDGER_STAGES.has(row.stage))
      .map((row) => row.orderRef),
  );

  const variantsBySku = new Map<string, ProductionVariantRow[]>();
  const caps = new Map<string, number>();
  const orderedQtyByOrder = new Map<string, number>();
  for (const row of input.variants) {
    if (!row.sku) continue;
    const rows = variantsBySku.get(row.sku) ?? [];
    rows.push(row);
    variantsBySku.set(row.sku, rows);
    const key = orderSkuKey(row.orderRef, row.sku);
    caps.set(key, (caps.get(key) ?? 0) + Math.max(row.qty, 0));
    orderedQtyByOrder.set(row.orderRef, (orderedQtyByOrder.get(row.orderRef) ?? 0) + Math.max(row.qty, 0));
  }
  for (const rows of variantsBySku.values()) {
    rows.sort((left, right) => {
      const dateOrder = String(right.dateOrdered ?? "").localeCompare(String(left.dateOrdered ?? ""));
      return dateOrder || right.orderRef.localeCompare(left.orderRef);
    });
  }

  const allocated: AllocatedLiveRow[] = [];
  for (const row of input.live) {
    if (!LIVE_STAGES.has(row.stage)) continue;
    let remaining = Math.max(row.qty, 0);
    if (remaining <= 0) continue;
    // An order can be partially received while a small physical balance is
    // still in manufacturing. Warehouse units themselves are excluded, but
    // their presence must not erase genuine live WIP for the same order.
    const candidates = variantsBySku.get(row.sku) ?? [];
    const seenOrders = new Set<string>();
    for (const candidate of candidates) {
      if (remaining <= 0 || seenOrders.has(candidate.orderRef)) continue;
      seenOrders.add(candidate.orderRef);
      const capKey = orderSkuKey(candidate.orderRef, row.sku);
      const take = Math.min(remaining, caps.get(capKey) ?? 0);
      if (take <= 0) continue;
      caps.set(capKey, (caps.get(capKey) ?? 0) - take);
      remaining -= take;
      allocated.push({
        orderRef: candidate.orderRef,
        styleKey: candidate.styleKey,
        stage: row.stage,
        sku: row.sku,
        sewingLine: row.sewingLine,
        qty: take,
      });
    }
    if (remaining > 0) {
      const newest = candidates[0];
      allocated.push({
        orderRef: newest?.orderRef ?? null,
        styleKey: newest?.styleKey || row.styleKey,
        stage: row.stage,
        sku: row.sku,
        sewingLine: row.sewingLine,
        qty: remaining,
      });
    }
  }

  const furthestLiveStageByOrder = new Map<string, number>();
  for (const row of allocated) {
    if (!row.orderRef || row.qty <= 0) continue;
    furthestLiveStageByOrder.set(
      row.orderRef,
      Math.max(furthestLiveStageByOrder.get(row.orderRef) ?? 0, LIVE_STAGE_RANK[row.stage]),
    );
  }
  const buyingOrderQtyByOrder = new Map<string, number>();
  for (const row of input.ledger) {
    if (row.stage !== "buying_order") continue;
    buyingOrderQtyByOrder.set(
      row.orderRef,
      (buyingOrderQtyByOrder.get(row.orderRef) ?? 0) + Math.max(row.qty, 0),
    );
  }
  for (const row of input.ledger) {
    const isEarlyLedgerStage = row.stage === "buying_order" || row.stage === "cutting";
    // Match the Production Tracker's canonical coexistence rule: a draft BO
    // can have a real residual Buying Order cohort alongside physical WIP.
    // Once the BO is no longer draft, its ledger Buying Order row is stale and
    // the live physical stage is authoritative.
    const orderedQty = orderedQtyByOrder.get(row.orderRef) ?? 0;
    const buyingOrderQty = buyingOrderQtyByOrder.get(row.orderRef) ?? 0;
    const isStaleBuyingOrder = row.stage === "buying_order"
      && normalizedKey(row.boState) !== "draft"
      && furthestLiveStageByOrder.has(row.orderRef)
      && orderedQty > 0
      && buyingOrderQty / orderedQty >= 0.9;
    if (!ACTIVE_LEDGER_STAGES.has(row.stage)
      || (terminalOrders.has(row.orderRef) && isEarlyLedgerStage)
      || isStaleBuyingOrder) continue;
    add(row.styleKey, Math.max(row.qty, 0));
  }

  // Washing and Repairs balances are current ledger-owned WIP. The same units
  // can remain visible in Finished Goods Production, so remove that overlap
  // from live Finishing before adding both sources.
  const offsets = new Map<string, number>();
  for (const row of input.offsets) {
    const key = orderSkuKey(row.orderRef, row.sku ?? "");
    offsets.set(key, (offsets.get(key) ?? 0) + Math.max(row.qty, 0));
  }
  allocated.sort((left, right) =>
    (left.orderRef ?? "").localeCompare(right.orderRef ?? "")
    || left.sku.localeCompare(right.sku)
    || (left.sewingLine ?? "").localeCompare(right.sewingLine ?? ""));
  for (const row of allocated) {
    // An order has one current stage. If the same order appears in multiple
    // live locations, retain only its furthest manufacturing stage instead of
    // counting earlier-stage representations as additional supply.
    if (row.orderRef && LIVE_STAGE_RANK[row.stage] !== furthestLiveStageByOrder.get(row.orderRef)) continue;
    if (row.stage === "finishing" && row.orderRef) {
      for (const sku of [row.sku, ""]) {
        const key = orderSkuKey(row.orderRef, sku);
        const remainingOffset = offsets.get(key) ?? 0;
        if (remainingOffset <= 0) continue;
        const removed = Math.min(remainingOffset, row.qty);
        row.qty -= removed;
        offsets.set(key, remainingOffset - removed);
      }
    }
    add(row.styleKey, row.qty);
  }

  for (const [styleKey, qty] of result) result.set(styleKey, Math.round(qty * 100) / 100);
  return result;
}

export async function loadProductionPipelineByStyle(db: Queryable) {
  const apparelWhere = (alias: string) => `(
    LEFT(UPPER(BTRIM(COALESCE(${alias}.style_number,''))),1) IN ('S','V','Z')
    OR LEFT(UPPER(BTRIM(COALESCE(${alias}.style_name,''))),4)='VIVO'
    OR LEFT(UPPER(BTRIM(COALESCE(${alias}.style_name,''))),6)='SAFARI'
    OR LEFT(UPPER(BTRIM(COALESCE(${alias}.style_name,''))),4)='ZOYA'
  )`;
  const styleKey = (alias: string) =>
    `LOWER(BTRIM(COALESCE(NULLIF(${alias}.style_number,''),NULLIF(${alias}.product_sku,''))))`;

  const [ledgerResult, liveResult, variantResult, offsetResult] = await Promise.all([
    db.query(`
      SELECT b.order_ref AS "orderRef",${styleKey("po")} AS "styleKey",
        po.style_name AS "styleName",
        po.bo_state AS "boState",b.stage,b.sku,SUM(b.qty_here)::float AS qty
      FROM public.v_stage_sku_balances b
      JOIN public.production_orders po ON po.order_ref=b.order_ref
      WHERE ${apparelWhere("po")}
        AND b.stage IN ('buying_order','cutting','washing','repairs','warehouse','received')
      GROUP BY b.order_ref,${styleKey("po")},po.style_name,po.bo_state,b.stage,b.sku`),
    db.query(`
      SELECT i.sku,MAX(NULLIF(BTRIM(i.style_name),'')) AS "styleName",
        CASE WHEN i.pos_location_name='Fabric Trimming' THEN 'waiting_sewing'
             WHEN i.pos_location_name IN ('Sew/Stock/A','Sew/Stock/B','Sew/Stock/C','Sew/Stock/D','Sew/Stock/E') THEN 'sewing'
             ELSE 'finishing' END AS stage,
        CASE WHEN i.pos_location_name IN ('Sew/Stock/A','Sew/Stock/B','Sew/Stock/C','Sew/Stock/D','Sew/Stock/E')
             THEN UPPER(RIGHT(i.pos_location_name,1)) END AS "sewingLine",
        SUM(GREATEST(COALESCE(i.available,0),0))::float AS qty
      FROM public.all_inventory i
      WHERE i.pos_location_name IN (
        'Fabric Trimming','Sew/Stock/A','Sew/Stock/B','Sew/Stock/C',
         'Sew/Stock/D','Sew/Stock/E','Finished Goods Production'
      )
        AND (
          LEFT(UPPER(BTRIM(COALESCE(i.sku,''))),1) IN ('S','V','Z')
          OR LEFT(UPPER(BTRIM(COALESCE(i.style_name,''))),4)='VIVO'
          OR LEFT(UPPER(BTRIM(COALESCE(i.style_name,''))),6)='SAFARI'
          OR LEFT(UPPER(BTRIM(COALESCE(i.style_name,''))),4)='ZOYA'
        )
      GROUP BY i.sku,3,4
      HAVING SUM(GREATEST(COALESCE(i.available,0),0))>0`),
    db.query(`
      SELECT v.order_ref AS "orderRef",${styleKey("po")} AS "styleKey",
        po.style_name AS "styleName",
        v.product_sku AS sku,COALESCE(v.qty,0)::float AS qty,
        po.date_ordered::text AS "dateOrdered"
      FROM public.production_order_variants v
      JOIN public.production_orders po ON po.order_ref=v.order_ref
      WHERE v.product_sku IS NOT NULL AND v.product_sku<>'' AND ${apparelWhere("po")}`),
    db.query(`
      SELECT b.order_ref AS "orderRef",b.sku,SUM(b.qty_here)::float AS qty
      FROM public.v_stage_sku_balances b
      JOIN public.production_orders po ON po.order_ref=b.order_ref
      WHERE b.stage IN ('washing','repairs') AND ${apparelWhere("po")}
      GROUP BY b.order_ref,b.sku`),
  ]);

  const variantStyleBySku = new Map<string, string>();
  for (const row of variantResult.rows) {
    const sku = String(row.sku);
    if (!variantStyleBySku.has(sku)) variantStyleBySku.set(sku, String(row.styleKey ?? ""));
  }
  const totals = productionPipelineByStyle({
    ledger: ledgerResult.rows.map((row) => ({
      orderRef: String(row.orderRef),
      styleKey: String(row.styleKey ?? ""),
      stage: String(row.stage),
      sku: row.sku == null ? null : String(row.sku),
      qty: numeric(row.qty),
      boState: row.boState == null ? null : String(row.boState),
    })),
    live: liveResult.rows.map((row) => ({
      sku: String(row.sku),
      styleKey: variantStyleBySku.get(String(row.sku))
        ?? (row.styleName ? `name:${normalizedKey(row.styleName)}` : ""),
      stage: String(row.stage) as LivePipelineRow["stage"],
      sewingLine: row.sewingLine == null ? null : String(row.sewingLine),
      qty: numeric(row.qty),
    })),
    variants: variantResult.rows.map((row) => ({
      orderRef: String(row.orderRef),
      styleKey: String(row.styleKey ?? ""),
      sku: String(row.sku),
      qty: numeric(row.qty),
      dateOrdered: row.dateOrdered == null ? null : String(row.dateOrdered),
    })),
    offsets: offsetResult.rows.map((row) => ({
      orderRef: String(row.orderRef),
      sku: row.sku == null ? null : String(row.sku),
      qty: numeric(row.qty),
    })),
  });
  // Production order style numbers can carry order-only suffixes (for example
  // V0426025PR while the catalogue style is V0426025). Keep the order's exact
  // style-name as a fallback alias without changing the response contract.
  const nameAliases = new Map<string, Set<string>>();
  for (const row of [...ledgerResult.rows, ...variantResult.rows]) {
    const key = normalizedKey(row.styleKey);
    const name = normalizedKey(row.styleName);
    if (!key || !name) continue;
    const aliases = nameAliases.get(name) ?? new Set<string>();
    aliases.add(key);
    nameAliases.set(name, aliases);
  }
  for (const [name, aliases] of nameAliases) {
    const aliasKey = `name:${name}`;
    const aliasQty = [...aliases].reduce((sum, key) => sum + (totals.get(key) ?? 0), totals.get(aliasKey) ?? 0);
    if (aliasQty > 0) totals.set(aliasKey, Math.round(aliasQty * 100) / 100);
  }
  return totals;
}
