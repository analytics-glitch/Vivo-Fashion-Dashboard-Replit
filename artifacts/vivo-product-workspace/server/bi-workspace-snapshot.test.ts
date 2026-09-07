import assert from "node:assert/strict";
import test from "node:test";
import { attachKnownGarmentImageUrls, buildOrderCountIndex, validateWorkspaceBiSource } from "./bi-workspace-snapshot.js";

test("snapshot validation preserves the complete source contract", () => {
  const source = { styles: [{ styleNumber: "A1", custom: 7 }], orders: [], definitions: [{ name: "x" }], stockMix: { total: 2 } };
  assert.equal(validateWorkspaceBiSource(source), source);
  assert.throws(() => validateWorkspaceBiSource({ styles: [], orders: [] }), /no styles/);
  assert.throws(() => validateWorkspaceBiSource({ styles: [{ name: "missing" }], orders: [] }), /identifiers/);
});

test("order index deduplicates order refs and joins by number or name", () => {
  const count = buildOrderCountIndex([
    { orderRef: "BO1", styleNumber: "A1", styleName: "Alpha", quantity: 10 },
    { orderRef: "BO1", styleNumber: "A1", styleName: "Alpha", quantity: 10 },
    { orderRef: "BO2", styleNumber: "", styleName: "Alpha", quantity: 5 },
    { orderRef: "DRAFT", styleNumber: "A1", styleName: "Alpha", quantity: 0 },
  ]);
  assert.equal(count("a1", "Alpha"), 2);
  assert.equal(count("none", "alpha"), 2);
});

test("saved catalogue images receive authoritative URLs without probing unknown styles", () => {
  const rows = attachKnownGarmentImageUrls(
    [{ styleNumber: "A 1", image: null }, { styleNumber: "B2", image: null }],
    ["a 1"],
    "catalogue",
    (row) => row.styleNumber,
  );
  assert.equal(rows[0]?.image, "/api/workspace/garment-images/catalogue/a%201");
  assert.equal(rows[1]?.image, null);
});