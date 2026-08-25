export type ReportRow = {
  readonly rowNumber: number;
  readonly cells: readonly string[];
};

export type ReportWorksheet = {
  readonly name: string;
  readonly maxColumn: number;
  readonly columns: readonly string[];
  readonly rows: readonly ReportRow[];
};

export type CustomerWorkbook = {
  readonly sourceFile: string;
  readonly worksheets: readonly ReportWorksheet[];
};

const columnName = (columnNumber: number) => {
  let number = columnNumber;
  let name = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
};

/** Always quote fields so blank positions and Excel text are unambiguous. */
export const csvEscape = (value: unknown) =>
  `"${String(value ?? "").replace(/"/g, '""')}"`;

/**
 * Combines the source worksheets without flattening their coordinates.
 * Every source row is retained, including completely blank rows.
 */
export const buildCombinedCsv = (workbook: CustomerWorkbook) => {
  const maxColumns = workbook.worksheets.reduce(
    (maximum, worksheet) => Math.max(maximum, worksheet.maxColumn),
    0,
  );
  const columns = Array.from({ length: maxColumns }, (_, index) =>
    columnName(index + 1),
  );
  const lines = [
    ["worksheet", "row_number", ...columns].map(csvEscape).join(","),
  ];

  for (const worksheet of workbook.worksheets) {
    for (const row of worksheet.rows) {
      const cells = Array.from(
        { length: maxColumns },
        (_, index) => row.cells[index] ?? "",
      );
      lines.push(
        [worksheet.name, row.rowNumber, ...cells].map(csvEscape).join(","),
      );
    }
  }

  // UTF-8 BOM makes the file open cleanly in Excel while CRLF is the
  // interoperable line ending for spreadsheet applications.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
};

export const reportFilename = (date = new Date()) => {
  const isoDate = date.toISOString().slice(0, 10);
  return `customer-report-combined-${isoDate}.csv`;
};
