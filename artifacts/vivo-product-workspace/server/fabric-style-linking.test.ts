import assert from "node:assert/strict";
import test from "node:test";
import { canonicalFabricStyle, certainFabricStyleMatch, fabricStyleBase, normalizeFabricStyle } from "./fabric-style-linking.js";

test("Level 3 base stops at the Fabric BI colour separator", () => {
  assert.equal(fabricStyleBase("  Linen / Rayon - Dark Blue "), "Linen / Rayon");
  assert.equal(normalizeFabricStyle("Linen---Rayon (Premium)"), "linen rayon premium");
});

test("authoritative Fabric BI fabric_name wins over the Level 4 product-name base", () => {
  assert.equal(canonicalFabricStyle("AMDHIR Light Linen Blend", "AMDHIR Cotton Linen Blend - Black"), "AMDHIR Light Linen Blend");
  assert.equal(canonicalFabricStyle("", "YIYI N272 - Navy"), "YIYI N272");
});

test("noisy duplicate Level 3 labels collapse to one certain exact match", () => {
  const result = certainFabricStyleMatch("  LINEN / RAYON  ", [
    { fabricStyleKey: "linen-rayon", fabricStyle: "Linen Rayon" },
    { fabricStyleKey: "linen-rayon", fabricStyle: "LINEN---RAYON" },
  ]);
  assert.equal(result.status, "resolved");
  assert.equal(result.fabricStyleKey, "linen-rayon");
});

test("only category or subcategory suffix permits prefix auto-linking", () => {
  const candidates = [{ fabricStyleKey: "linen", fabricStyle: "Linen", category: "Dresses", subcategory: "Maxi Dresses" }];
  assert.equal(certainFabricStyleMatch("Linen - Dresses", candidates).status, "resolved");
  assert.equal(certainFabricStyleMatch("Linen Dress", candidates).status, "unresolved");
});

test("a unique stray letter after a numeric supplier code resolves without fuzzy matching", () => {
  const candidates = [
    { fabricStyleKey: "huaming 2018 medium polyester satin", fabricStyle: "HUAMING 2018" },
    { fabricStyleKey: "huaming 1801 50d", fabricStyle: "HUAMING 1801/50D" },
  ];
  assert.equal(certainFabricStyleMatch("Huaming 2018D", candidates).fabricStyleKey, "huaming 2018 medium polyester satin");
  assert.equal(certainFabricStyleMatch("Huaming 2019D", candidates).status, "unresolved");
});

test("multiple possible Level 3 prefixes are never auto-linked", () => {
  assert.equal(certainFabricStyleMatch("Linen Dresses", [
    { fabricStyleKey: "a", fabricStyle: "Linen", category: "Dresses" },
    { fabricStyleKey: "b", fabricStyle: "Linen", subcategory: "Dresses" },
  ]).status, "ambiguous");
});