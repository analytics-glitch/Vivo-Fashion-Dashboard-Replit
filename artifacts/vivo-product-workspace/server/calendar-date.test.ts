import assert from "node:assert/strict";
import test from "node:test";
import { calendarDate, legacyCalendarDate, styleDateInput } from "./calendar-date.js";

test("serializes a Date from its local calendar fields", () => {
  const value = new Date(2026, 8, 1, 0, 0, 0);
  assert.equal(calendarDate(value), "2026-09-01");
});

test("normalizes valid legacy sample approval dates", () => {
  assert.equal(legacyCalendarDate("27-Aug-2026"), "2026-08-27");
  assert.equal(legacyCalendarDate("4-Jul-2026"), "2026-07-04");
});

test("leaves corrupted and ambiguous values unreadable", () => {
  assert.equal(legacyCalendarDate("18--Aug-2026"), null);
  assert.equal(legacyCalendarDate("Tue Sep 01"), null);
});

test("rejects an invalid save with the field name", () => {
  assert.throws(
    () => styleDateInput("Tue Sep 01", "Adoption Date"),
    /Adoption Date must be a valid date in YYYY-MM-DD format/,
  );
  assert.equal(styleDateInput("18-Aug-2026", "Sample Approval Date"), "2026-08-18");
});