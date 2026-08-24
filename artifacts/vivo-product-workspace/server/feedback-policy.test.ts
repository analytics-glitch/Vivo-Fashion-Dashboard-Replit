import assert from "node:assert/strict";
import test from "node:test";
import {
  FEEDBACK_IMAGE_MAX_BYTES,
  FEEDBACK_QUARTER_START_SQL,
  detectFeedbackImageContentType,
  feedbackImageTokens,
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