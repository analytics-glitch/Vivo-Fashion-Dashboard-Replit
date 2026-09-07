import assert from "node:assert/strict";
import test from "node:test";
import { orderAllowedByHistoryCutover } from "./order-history-cutover.js";

const cutover = "2026-03-02";

test("uses Central Tracker exclusively before the Odoo history start date", () => {
  assert.equal(orderAllowedByHistoryCutover({ orderDate: "2026-03-01", source: "central_tracker" }, cutover), true);
  assert.equal(orderAllowedByHistoryCutover({ orderDate: "2026-03-01", source: "odoo" }, cutover), false);
});

test("uses Odoo exclusively on and after the boundary date", () => {
  assert.equal(orderAllowedByHistoryCutover({ orderDate: cutover, source: "odoo" }, cutover), true);
  assert.equal(orderAllowedByHistoryCutover({ orderDate: cutover, source: "central_tracker" }, cutover), false);
  assert.equal(orderAllowedByHistoryCutover({ orderDate: "2026-03-03", source: "odoo" }, cutover), true);
});

test("fails closed for unknown sources and invalid dates", () => {
  assert.equal(orderAllowedByHistoryCutover({ orderDate: "2026-03-03", source: "unknown" }, cutover), false);
  assert.equal(orderAllowedByHistoryCutover({ orderDate: "", source: "odoo" }, cutover), false);
});