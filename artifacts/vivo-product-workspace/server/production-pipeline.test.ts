import assert from "node:assert/strict";
import test from "node:test";
import { productionPipelineByStyle } from "./production-pipeline.js";

test("adds a residual Buying Order balance to physical Sewing WIP", () => {
  const totals = productionPipelineByStyle({
    ledger: [
      { orderRef: "BO00437", styleKey: "v0526103", stage: "buying_order", sku: null, qty: 17, boState: "draft" },
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

test("counts only active manufacturing ledger stages", () => {
  const totals = productionPipelineByStyle({
    ledger: [
      { orderRef: "BO1", styleKey: "style-1", stage: "buying_order", sku: null, qty: 9 },
      { orderRef: "BO1", styleKey: "style-1", stage: "cutting", sku: null, qty: 8 },
      { orderRef: "BO1", styleKey: "style-1", stage: "washing", sku: null, qty: 70 },
      { orderRef: "BO1", styleKey: "style-1", stage: "repairs", sku: null, qty: 80 },
      { orderRef: "BO1", styleKey: "style-1", stage: "defects", sku: null, qty: 90 },
      { orderRef: "COMPLETE", styleKey: "style-1", stage: "warehouse", sku: null, qty: 91 },
      { orderRef: "COMPLETE", styleKey: "style-1", stage: "received", sku: null, qty: 92 },
    ],
    live: [],
    variants: [],
    offsets: [],
  });
  assert.equal(totals.get("style-1"), 167);
});

test("counts live finishing while excluding terminal ledger stages", () => {
  const totals = productionPipelineByStyle({
    ledger: [],
    live: [
      { sku: "CUT", styleKey: "style-1", stage: "waiting_sewing", sewingLine: null, qty: 4 },
      { sku: "SEW", styleKey: "style-1", stage: "sewing", sewingLine: "A", qty: 6 },
      // Cast preserves coverage for terminal rows received from a source
      // before its location filter is applied.
      { sku: "FG", styleKey: "style-1", stage: "finishing" as never, sewingLine: null, qty: 100 },
    ],
    variants: [],
    offsets: [],
  });
  assert.equal(totals.get("style-1"), 110);
});

test("removes a non-draft Buying Order echo once physical manufacturing appears", () => {
  const totals = productionPipelineByStyle({
    ledger: [
      { orderRef: "BO1", styleKey: "style-1", stage: "buying_order", sku: "SKU-A", qty: 431, boState: "confirmed" },
      { orderRef: "BO2", styleKey: "style-2", stage: "buying_order", sku: "SKU-B", qty: 20, boState: "draft" },
    ],
    live: [{ sku: "SKU-A", styleKey: "style-1", stage: "finishing", sewingLine: null, qty: 4 }],
    variants: [
      { orderRef: "BO1", styleKey: "style-1", sku: "SKU-A", qty: 444, dateOrdered: "2026-07-15" },
      { orderRef: "BO2", styleKey: "style-2", sku: "SKU-B", qty: 20, dateOrdered: "2026-07-16" },
    ],
    offsets: [],
  });
  assert.equal(totals.get("style-1"), 4);
  assert.equal(totals.get("style-2"), 20);
});

test("uses the furthest live stage once when an order appears in multiple stages", () => {
  const totals = productionPipelineByStyle({
    ledger: [{ orderRef: "BO1", styleKey: "style-1", stage: "buying_order", sku: "SKU", qty: 40, boState: "confirmed" }],
    live: [
      { sku: "SKU", styleKey: "style-1", stage: "sewing", sewingLine: "B", qty: 1 },
      { sku: "SKU", styleKey: "style-1", stage: "finishing", sewingLine: null, qty: 4 },
    ],
    variants: [{ orderRef: "BO1", styleKey: "style-1", sku: "SKU", qty: 40, dateOrdered: "2026-07-15" }],
    offsets: [],
  });
  assert.equal(totals.get("style-1"), 4);
});

test("Warehouse suppresses stale Buying Order units without erasing physical WIP", () => {
  const totals = productionPipelineByStyle({
    ledger: [
      { orderRef: "COMPLETE", styleKey: "style-1", stage: "buying_order", sku: "SKU", qty: 50 },
      { orderRef: "COMPLETE", styleKey: "style-1", stage: "warehouse", sku: "SKU", qty: 50 },
      { orderRef: "OPEN", styleKey: "style-1", stage: "buying_order", sku: "SKU", qty: 10, boState: "draft" },
    ],
    live: [{ sku: "SKU", styleKey: "style-1", stage: "sewing", sewingLine: "A", qty: 5 }],
    variants: [
      { orderRef: "COMPLETE", styleKey: "style-1", sku: "SKU", qty: 50, dateOrdered: "2026-08-01" },
      { orderRef: "OPEN", styleKey: "style-1", sku: "SKU", qty: 10, dateOrdered: "2026-07-01" },
    ],
    offsets: [],
  });
  assert.equal(totals.get("style-1"), 15);
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

test("counts Repairs once when Finished Goods Production has the same units", () => {
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
  assert.equal(totals.get("style-1"), 10);
});