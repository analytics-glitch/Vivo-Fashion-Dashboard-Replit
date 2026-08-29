import assert from "node:assert/strict";
import test from "node:test";
import {
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_CUSTOMER_SEARCH_LIMIT,
  FEEDBACK_CUSTOMER_SEARCH_MIN_LENGTH,
  FEEDBACK_QUARTER_START_SQL,
  detectFeedbackImageContentType,
  feedbackCustomerOrigin,
  feedbackImageTokens,
  normalizeFeedbackCustomerId,
  normalizeFeedbackCustomerName,
  validateFeedbackImageMeta,
  validateFeedbackImageUpload,
} from "./feedback-policy.js";

test("quarter-to-date feedback metrics start at the current calendar quarter", () => {
  assert.equal(FEEDBACK_QUARTER_START_SQL, "date_trunc('quarter', CURRENT_DATE)");
});

test("feedback image uploads accept only matching approved metadata", () => {
  assert.deepEqual(validateFeedbackImageMeta("floor-note.HEIC", 1024, "image/heic"), {
    originalName: "floor-note.HEIC",
    byteSize: 1024,
    declaredType: "image/heic",
  });
  assert.ok("error" in validateFeedbackImageMeta("floor-note.png", 1024, "image/heic"));
  assert.ok("error" in validateFeedbackImageMeta("too-big.jpg", FEEDBACK_IMAGE_MAX_BYTES + 1, "image/jpeg"));
});

test("feedback image signatures and association tokens reject mismatches", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  assert.equal(detectFeedbackImageContentType(jpeg), "image/jpeg");
  assert.deepEqual(validateFeedbackImageUpload(jpeg, jpeg.length, "image/jpeg", "image/jpeg"), { valid: true });
  assert.ok("error" in validateFeedbackImageUpload(jpeg, jpeg.length, "image/png", "image/png"));
  assert.ok("error" in validateFeedbackImageUpload(new Uint8Array(FEEDBACK_IMAGE_MAX_BYTES + 1), FEEDBACK_IMAGE_MAX_BYTES + 1, "image/jpeg", "image/jpeg"));
  assert.equal(detectFeedbackImageContentType(new TextEncoder().encode("not an image")), null);
  const token = "a".repeat(64);
  assert.deepEqual(feedbackImageTokens([token]), { tokens: [token], valid: true });
  assert.equal(feedbackImageTokens([token, token]).valid, false);
  assert.equal(feedbackImageTokens(["not-a-token"]).valid, false);
});

test("customer feedback metadata is normalized without exposing broader CRM fields", () => {
  assert.equal(FEEDBACK_CUSTOMER_SEARCH_MIN_LENGTH, 2);
  assert.equal(FEEDBACK_CUSTOMER_SEARCH_LIMIT, 8);
  assert.equal(feedbackCustomerOrigin(true), true);
  assert.equal(feedbackCustomerOrigin("TRUE"), true);
  assert.equal(feedbackCustomerOrigin("false"), false);
  assert.equal(normalizeFeedbackCustomerName("  Amina   Njeri  "), "Amina Njeri");
  assert.equal(normalizeFeedbackCustomerId(` ${"a".repeat(130)} `).length, 120);
});