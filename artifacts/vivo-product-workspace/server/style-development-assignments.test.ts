import assert from "node:assert/strict";
import test from "node:test";
import { STYLE_DEVELOPMENT_PATTERN_MAKER_ASSIGNMENTS } from "./style-development-assignments.js";

test("pattern maker assignment import matches the supplied 97-style distribution", () => {
  const expectedCounts: Record<string, number> = {
    Wanjohi: 26,
    Mercy: 20,
    Victoria: 19,
    Florence: 15,
    CAD: 11,
    "Ken Knit": 2,
    Abigail: 1,
  };
  const ownersByStyle = new Map<string, string>();

  for (const [owner, styleNumbers] of Object.entries(STYLE_DEVELOPMENT_PATTERN_MAKER_ASSIGNMENTS)) {
    assert.equal(new Set(styleNumbers).size, expectedCounts[owner], `${owner} assignment count`);
    for (const styleNumber of styleNumbers) {
      assert.equal(ownersByStyle.has(styleNumber), false, `${styleNumber} is assigned only once`);
      ownersByStyle.set(styleNumber, owner);
    }
  }

  assert.equal(ownersByStyle.size, 94);
  assert.equal(97 - ownersByStyle.size, 3);
});