import assert from "node:assert/strict";
import test from "node:test";
import { productionPipelineByStyle } from "./production-pipeline.js";

test("uses current tracker stages instead of the raised order quantity", () => {
  const totals = productionPipelineByStyle({
    ledger: [
      { orderRef: "BO00437", styleKey: "v0526103", stage: "buying_order", sku: null, qty: 17 },
      // The tracker replaces this stale ledger stage with live Odoo stock.
      { orderRef: "BO00437", styleKey: "v0526103", stage: "waiting_sewing", sku: "SKU-D", qty: 440 },
    ],
    live: [
      { sku: "SKU-D", styleKey: "v0526103", stage: "sewing", sewingLine: "D", qty: 1 },
    ],
    variants: [
      { orderRef: "BO00437", styleKey: "v0526103", sku: "SKU-D", qty: 50, dateOrdered: "2026-07-31" },
    ],
    offsets: [],
  });
  assert.equal(totals.get("v0526103"), 18);
});

test("counts Buying Order as pipeline but excludes Warehouse", () => {
  const totals = productionPipelineByStyle({
    ledger: [
      { orderRef: "BO1", styleKey: "style-1", stage: "buying_order", sku: null, qty: 9 },
      { orderRef: "BO1", styleKey: "style-1", stage: "warehouse", sku: null, qty: 91 },
    ],
    live: [],
    variants: [],
    offsets: [],
  });
  assert.equal(totals.get("style-1"), 9);
});

test("attributes live stock newest-order-first with per-order caps", () => {
  const totals = productionPipelineByStyle({
    ledger: [],
    live: [{ sku: "SHARED", styleKey: "fallback", stage: "sewing", sewingLine: "B", qty: 12 }],
    variants: [
      { orderRef: "OLD", styleKey: "old-style", sku: "SHARED", qty: 7, dateOrdered: "2026-01-01" },
      { orderRef: "NEW", styleKey: "new-style", sku: "SHARED", qty: 5, dateOrdered: "2026-08-01" },
    ],
    offsets: [],
  });
  assert.equal(totals.get("new-style"), 5);
  assert.equal(totals.get("old-style"), 7);
});

test("removes Washing, Repairs and Defects overlap from live Finishing", () => {
  const totals = productionPipelineByStyle({
    ledger: [
      { orderRef: "BO1", styleKey: "style-1", stage: "repairs", sku: "SKU", qty: 3 },
    ],
    live: [
      { sku: "SKU", styleKey: "style-1", stage: "finishing", sewingLine: null, qty: 10 },
    ],
    variants: [
      { orderRef: "BO1", styleKey: "style-1", sku: "SKU", qty: 10, dateOrdered: "2026-08-01" },
    ],
    offsets: [{ orderRef: "BO1", sku: "SKU", qty: 3 }],
  });
  // Three units remain pipeline in Repairs; only the non-overlapping seven
  // remain in Finishing.
  assert.equal(totals.get("style-1"), 10);
});