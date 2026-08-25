import assert from "node:assert/strict";
import { buildCombinedCsv, csvEscape } from "../src/lib/csv.ts";
import { customerWorkbook } from "../src/data/customerWorkbook.ts";

const worksheets = customerWorkbook.worksheets;

assert.deepEqual(
  worksheets.map((worksheet) => worksheet.name),
  ["New & Returning Customers", "New Customers Review", "First Time Buy"],
  "worksheet order must match the supplied workbook",
);
assert.deepEqual(
  worksheets.map((worksheet) => [worksheet.rows.length, worksheet.maxColumn]),
  [
    [997, 79],
    [44, 7],
    [61, 26],
  ],
  "complete source ranges must be retained",
);

const allValues = worksheets.flatMap((worksheet) =>
  worksheet.rows.flatMap((row) => row.cells),
);
for (const expectedValue of [
  "Date - Month",
  "customer_type",
  "Online - shop-zetu",
  "Vivo Junction",
  "All-Time Total",
  "Key Takeaways",
  "Vivo Basic Sienna Waterfall",
]) {
  assert.ok(
    allValues.includes(expectedValue),
    `expected workbook content is missing: ${expectedValue}`,
  );
}

const combinedCsv = buildCombinedCsv(customerWorkbook);
assert.ok(combinedCsv.startsWith("\uFEFF"), "CSV must include an Excel UTF-8 BOM");
assert.ok(
  combinedCsv.startsWith('\uFEFF"worksheet","row_number","A","B"'),
  "CSV must identify worksheet, source row number, and original columns",
);
assert.match(combinedCsv, /"CA"\r\n/, "CSV header must retain the A:CA union");
assert.match(
  combinedCsv,
  /"New & Returning Customers","1","Date - Month"/,
  "CSV must preserve first-sheet row coordinates",
);
assert.match(
  combinedCsv,
  /"New Customers Review","2","","Store"/,
  "CSV must preserve source blank A cells and review-sheet columns",
);
assert.match(
  combinedCsv,
  /"First Time Buy","2","Vivo Junction","1","Vivo Basic Sienna Waterfall"/,
  "CSV must preserve first-time-buy product rows",
);
assert.ok(
  combinedCsv.indexOf('"New & Returning Customers"') <
    combinedCsv.indexOf('"New Customers Review"') &&
    combinedCsv.indexOf('"New Customers Review"') <
      combinedCsv.indexOf('"First Time Buy"'),
  "CSV must emit source worksheets in workbook order",
);
assert.equal(
  csvEscape('comma, "quote"\nand newline'),
  '"comma, ""quote""\nand newline"',
  "CSV escaping must retain commas, quotes, and multiline text",
);

console.log("Customer workbook and combined CSV contract checks passed.");