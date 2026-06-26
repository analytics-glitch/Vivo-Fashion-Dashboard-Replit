import React, { useMemo, useState } from "react";
import { CaretUp, CaretDown, CaretRight, Download, ArrowsHorizontal } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "@/lib/api";

/**
 * Convert any React element / value into a flat string (used as a fallback
 * when a column has no explicit `csv:` callback). Walks children recursively
 * and joins their text content. This is what lets a column rendered as
 * `<span className="pill-green">29.76%</span>` export as `29.76%` to CSV
 * without each callsite having to write a custom csv() callback.
 */
const _flattenToText = (node) => {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(_flattenToText).join("");
  if (typeof node === "object" && node.props) {
    return _flattenToText(node.props.children);
  }
  return "";
};

/** Download rows as CSV and show a success toast.
 *
 * Iter 86c — Hardened against React-element column labels. Several
 * tables (Products SOR, New Styles Performance, Exports) use a
 * component as the column's `label` (e.g. `<SORHeader />` carries the
 * tooltip "Sell-Through % since launch"). The legacy code called
 * `.replace()` directly on the label, which crashed with
 * `TypeError: (c.label || c.key).replace is not a function` and
 * silently broke the Export CSV button on those tables. The fix:
 * flatten labels through the existing `_flattenToText` helper before
 * doing any string ops. Any non-string `label` now degrades cleanly
 * to its visible text (`"SOR %"`) instead of throwing.
 */
// ─── Shared header / cell text resolution (used by both CSV and XLSX) ──────
// Label-source priority for an export header cell:
//   1. Explicit `c.csvLabel` — opt-in plain-text override.
//   2. `c.label` flattened through `_flattenToText` if it's a React element.
//   3. Fallback to `c.key`.
const _headerText = (c) => {
  if (c.csvLabel != null) return String(c.csvLabel);
  if (typeof c.label === "string" || typeof c.label === "number") return String(c.label);
  if (c.label != null) return _flattenToText(c.label) || String(c.key || "");
  return String(c.key || "");
};

// Auto-detect percentage columns by checking the rendered text of the first
// row. Any column whose render output ends with `%`, ` pp`, ` pts`, or ` pt`
// is treated as a percentage so the export normalises it to a `%` suffix.
const _pctColSet = (rows, columns) => {
  const sample = rows[0];
  const pctCols = new Set();
  if (sample) {
    columns.forEach((c, i) => {
      if (c.pct === false) return;
      if (c.pct === true) { pctCols.add(i); return; }
      if (typeof c.render !== "function") return;
      try {
        const txt = _flattenToText(c.render(sample, 0)).trim();
        if (/(%|\bpp|\bpts?)\s*$/i.test(txt)) pctCols.add(i);
      } catch (_e) { /* ignore */ }
    });
  }
  return pctCols;
};

// Resolve a single cell to its export text (CSV value / XLSX cell value),
// honouring an explicit `csv:` callback, then auto-deriving from `render`.
const _cellText = (c, r, idx, isPct) => {
  let v;
  if (typeof c.csv === "function") {
    v = c.csv(r, idx);
  } else if (typeof c.render === "function") {
    try { v = _flattenToText(c.render(r, idx)).trim(); }
    catch (_e) { v = r[c.key]; }
  } else {
    v = r[c.key];
  }
  if (v == null) return "";
  let s = String(v);
  if (isPct) {
    s = s.replace(/\s*(pp|pts?)\s*$/i, "%").trim();
    if (s && !/%\s*$/.test(s)) {
      const n = Number(s);
      if (!Number.isNaN(n)) s = `${n.toFixed(2)}%`;
    }
  }
  return s;
};

/** Download rows as CSV and show a success toast. */
export const exportCSV = (rows, columns, filename = "export.csv") => {
  const header = columns
    .map((c) => `"${_headerText(c).replace(/"/g, '""')}"`)
    .join(",");
  const pctCols = _pctColSet(rows, columns);
  const lines = rows.map((r, idx) =>
    columns
      .map((c, ci) => `"${_cellText(c, r, idx, pctCols.has(ci)).replace(/"/g, '""')}"`)
      .join(",")
  );
  const csv = [header, ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  // Friendly confirmation — small acknowledgements matter (dopamine design).
  try {
    toast.success(`${rows.length} row${rows.length === 1 ? "" : "s"} exported`, {
      description: filename,
      duration: 2800,
    });
  } catch (_err) { /* silent */ }
};

// ─── Excel (.xlsx) export with embedded product photos ────────────────────
// A column opts in by declaring `image: (row, idx) => url`, returning a
// fetchable image URL (data:, /api/…, or absolute http[s]) or null. The
// exporter embeds exactly one image per row in that column's cell.
const _XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PHOTO_FETCH_CONCURRENCY = 8;   // parallel image fetches

const _blobToB64 = (blob) =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] || "");
    fr.onerror = () => rej(fr.error || new Error("read failed"));
    fr.readAsDataURL(blob);
  });

const _extFromType = (t) => {
  const s = String(t || "").toLowerCase();
  if (s.includes("png")) return "png";
  if (s.includes("gif")) return "gif";
  return "jpeg";
};

// Resolve any image URL to { base64, extension } for exceljs, or null when
// it can't be fetched (404, CORS, decode error) — a null leaves the cell blank.
const _imageData = async (rawUrl) => {
  if (!rawUrl) return null;
  const url = String(rawUrl);
  try {
    if (url.startsWith("data:")) {
      const m = /^data:image\/([\w.+-]+);base64,(.*)$/i.exec(url);
      if (!m) return null;
      return { base64: m[2], extension: _extFromType(m[1]) };
    }
    let blob;
    if (url.startsWith("/api/")) {
      // Go through the axios instance so the session Bearer/cookie is sent.
      const { data } = await api.get(url.replace(/^\/api/, ""), { responseType: "blob" });
      blob = data;
    } else {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) return null;
      blob = await resp.blob();
    }
    if (!blob || !blob.size) return null;
    return { base64: await _blobToB64(blob), extension: _extFromType(blob.type) };
  } catch (_e) {
    return null;
  }
};

const _runPool = async (items, limit, worker) => {
  let i = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) || 0 },
    async () => {
      while (i < items.length) {
        const idx = i++;
        await worker(items[idx], idx);
      }
    }
  );
  await Promise.all(runners);
};

/**
 * Export rows to .xlsx with the real product photo embedded (one image per
 * row) for every column that declares an `image` resolver. Non-photo columns
 * export their text exactly like the CSV path. Throws on a hard failure so the
 * dispatcher can fall back to CSV.
 */
export const exportXLSX = async (rows, columns, filename = "export.xlsx") => {
  const _mod = await import("exceljs");
  const ExcelJS = _mod.default || _mod;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Export");
  const imgColIdx = columns
    .map((c, i) => (typeof c.image === "function" ? i : -1))
    .filter((i) => i >= 0);
  const pctCols = _pctColSet(rows, columns);

  // Header
  const headerRow = ws.addRow(columns.map((c) => _headerText(c)));
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };

  // Column widths — wider for photo columns so a thumbnail fits.
  columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = imgColIdx.includes(i) ? 12 : 18;
  });

  // Text cells (photo cells left blank — the image floats over them).
  rows.forEach((r, ri) => {
    const row = ws.addRow(
      columns.map((c, ci) =>
        imgColIdx.includes(ci) ? "" : _cellText(c, r, ri, pctCols.has(ci))
      )
    );
    if (imgColIdx.length) row.height = 50; // ~66px — room for the image
    row.alignment = { vertical: "middle" };
  });

  // Embed images for every row (concurrency-limited).
  const tasks = [];
  for (let ri = 0; ri < rows.length; ri++) {
    for (const ci of imgColIdx) {
      let url = null;
      try { url = columns[ci].image(rows[ri], ri); } catch (_e) { url = null; }
      if (url) tasks.push({ ri, ci, url });
    }
  }
  await _runPool(tasks, PHOTO_FETCH_CONCURRENCY, async (t) => {
    const img = await _imageData(t.url);
    if (!img) return;
    let id;
    try { id = wb.addImage({ base64: img.base64, extension: img.extension }); }
    catch (_e) { return; }
    // Header is anchor row 0; data row ri → excel row ri+2 → zero-based ri+1.
    ws.addImage(id, {
      tl: { col: t.ci + 0.12, row: t.ri + 1 + 0.12 },
      ext: { width: 60, height: 60 },
      editAs: "oneCell",
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: _XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  try {
    toast.success(`${rows.length} row${rows.length === 1 ? "" : "s"} exported`, {
      description: filename,
      duration: 3200,
    });
  } catch (_err) { /* silent */ }
};

/**
 * Smart dispatcher: when any column declares an `image` resolver AND
 * `includePhotos` is true (the default), export an .xlsx with one embedded
 * photo per row; otherwise the plain (fast) CSV. Pass `includePhotos=false`
 * to skip the photo embedding even on photo-capable tables. Safe to call from
 * a button onClick (fire-and-forget). A photo export NEVER silently downgrades
 * to CSV — on failure it surfaces an error toast and rethrows, so a
 * partial/photoless file is never passed off as the requested photo export.
 */
export const exportTable = async (rows, columns, filename = "export.csv", includePhotos = true) => {
  const hasPhotos =
    includePhotos &&
    Array.isArray(columns) && columns.some((c) => typeof c.image === "function");
  if (hasPhotos && rows && rows.length) {
    const xlsxName = filename.replace(/\.csv$/i, "") + ".xlsx";
    let tid;
    try { tid = toast.loading("Preparing photo export…"); } catch (_e) { /* silent */ }
    try {
      await exportXLSX(rows, columns, xlsxName);
    } catch (e) {
      try {
        toast.error("Photo export failed", {
          description: "Could not build the Excel file with embedded photos. Please try again.",
          duration: 4000,
        });
      } catch (_e2) { /* silent */ }
      throw e;
    } finally {
      try { if (tid != null) toast.dismiss(tid); } catch (_e3) { /* silent */ }
    }
    return;
  }
  exportCSV(rows, columns, filename);
};

/**
 * Reusable sortable table with CSV export.
 * columns = [{ key, label, align, sortable = true, render, csv, width, numeric, mobilePrimary, mobileHidden }]
 *
 * When `mobileCards` is true, screens < 768px render a stacked card list
 * instead of a horizontally-scrollable table. Set `mobilePrimary: true`
 * on the column you want to use as each card's headline, and
 * `mobileHidden: true` on columns that should be omitted on mobile.
 */
export const SortableTable = ({
  columns,
  rows,
  initialSort,
  exportName,
  testId,
  pageSize,
  emptyLabel = "No data",
  onRowClick,
  mobileCards = false,
  /** Freezes the LEFT-most column horizontally (always visible during
   * horizontal scroll). Defaults to true. The header row is always sticky
   * vertically against the page scroll. */
  stickyFirstCol = true,
  /** Optional max-height for the scroll container (e.g. "60vh" or 480).
   * Defaults to "70vh" so very long tables become inner-scrollable with a
   * sticky thead + frozen first column. Short tables don't reach the cap
   * and render naturally. Pass `maxHeight={null}` to disable. */
  maxHeight = "70vh",
  /** Optional <td> array rendered as a sticky bottom row (e.g. column
   * totals). Only shown on the desktop table view. Pass an array of
   * <td>…</td> nodes whose count matches `columns.length`. */
  footerRow = null,
  /** When provided, each row gets a chevron column and clicking it (or
   * the row itself) toggles an inline expanded panel that renders
   * `renderExpanded(row)` spanning all columns. */
  renderExpanded = null,
  /** Stable key getter for expanded-state tracking. Defaults to row index. */
  rowKey = null,
  /** Optional `(row) => string` returning extra Tailwind classes to apply
   * to a specific row's `<tr>`. Used by master/detail tables (e.g. SOR
   * Report) to highlight the row selected in a side panel. */
  rowClassName = null,
  /** Optional tiebreaker sort applied after the primary `sort`. Useful for
   * grouped views like "sort by Category, then Units Sold desc within each
   * category" — set `secondarySort={{ key: 'units_sold', dir: 'desc' }}` and
   * the Category click does the rest. Resolved against `columns` like the
   * primary sort, so `sortValue` callbacks are honoured. */
  secondarySort = null,
}) => {
  const [sort, setSort] = useState(initialSort || null); // { key, dir }
  const [expanded, setExpanded] = useState(() => new Set());
  // Per-column "expand" set — each key in here releases that column's width
  // cap / ellipsis so the full cell content wraps into view (see `col-expanded`
  // in index.css). Toggled from the small arrows icon in each column header.
  const [expandedCols, setExpandedCols] = useState(() => new Set());
  const [limit, setLimit] = useState(pageSize || null);
  // When the table has product-photo columns, the export embeds one image per
  // row (slow). This checkbox lets the user opt out for a fast photoless CSV.
  const hasImageCol = columns.some((c) => typeof c.image === "function");
  const [includePhotos, setIncludePhotos] = useState(true);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    const getVal = (r) => (col.sortValue ? col.sortValue(r) : r[sort.key]);
    // Tiebreaker — only applied when (a) caller provided `secondarySort`,
    // (b) it points at a real column, and (c) it's not the same key as the
    // primary sort (otherwise the primary already orders those rows).
    const sec = secondarySort && secondarySort.key !== sort.key
      ? columns.find((c) => c.key === secondarySort.key)
      : null;
    const secDir = sec && secondarySort?.dir === "asc" ? 1 : -1;
    const getSec = sec
      ? (r) => (sec.sortValue ? sec.sortValue(r) : r[secondarySort.key])
      : null;
    const cmp = (av, bv, d) => {
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * d;
      return String(av).localeCompare(String(bv)) * d;
    };
    return [...rows].sort((a, b) => {
      const primary = cmp(getVal(a), getVal(b), dir);
      if (primary !== 0 || !getSec) return primary;
      return cmp(getSec(a), getSec(b), secDir);
    });
  }, [rows, sort, columns, secondarySort]);

  const visible = limit ? sorted.slice(0, limit) : sorted;

  const toggleColExpand = (key) => {
    setExpandedCols((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const toggleSort = (key) => {
    const col = columns.find((c) => c.key === key);
    if (!col || col.sortable === false) return;
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: col.numeric ? "desc" : "asc" };
      if (s.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  };

  return (
    <div data-testid={testId}>
      <div className="flex justify-end mb-2 gap-2">
        {pageSize && sorted.length > pageSize && (
          <button
            type="button"
            className="text-[11.5px] text-muted hover:text-brand underline"
            onClick={() => setLimit((l) => (l ? null : pageSize))}
          >
            {limit ? `Show all (${sorted.length})` : `Show first ${pageSize}`}
          </button>
        )}
        {renderExpanded && sorted.length > 0 && (
          <button
            type="button"
            onClick={() => {
              // Toggle: if every row is already open, collapse all;
              // else expand every currently-sorted row. Uses the
              // existing `rowKey` resolver so it honours the same
              // stable keys used for single-row toggles.
              const allKeys = sorted.map((r, i) => (rowKey ? rowKey(r, i) : i));
              const allOpen = allKeys.every((k) => expanded.has(k));
              setExpanded(allOpen ? new Set() : new Set(allKeys));
            }}
            className="inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-brand px-2 py-1 rounded border border-border hover:border-brand"
            data-testid={testId ? `${testId}-expand-all` : undefined}
          >
            {sorted.every((r, i) => expanded.has(rowKey ? rowKey(r, i) : i))
              ? "Collapse all"
              : "Expand all"}
          </button>
        )}
        {exportName && hasImageCol && (
          <label
            className="inline-flex items-center gap-1.5 text-[11.5px] text-muted cursor-pointer select-none px-1"
            title="Include product photos in the export (slower). Uncheck for a fast CSV without images."
            data-testid={testId ? `${testId}-include-photos` : undefined}
          >
            <input
              type="checkbox"
              checked={includePhotos}
              onChange={(e) => setIncludePhotos(e.target.checked)}
              className="accent-[var(--brand,#1a5c38)] cursor-pointer"
            />
            Photos
          </label>
        )}
        {exportName && (
          <button
            type="button"
            onClick={() => exportTable(sorted, columns, exportName, includePhotos)}
            className="inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-brand px-2 py-1 rounded border border-border hover:border-brand"
            data-testid={testId ? `${testId}-export` : undefined}
          >
            <Download size={13} weight="bold" />{" "}
            {hasImageCol && includePhotos ? "Export Excel" : "Export CSV"}
          </button>
        )}
      </div>
      <div
        className={`overflow-auto ${mobileCards ? "hidden md:block" : ""}`}
        style={maxHeight ? { maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight } : undefined}
      >
        <table className={`w-full data ${stickyFirstCol ? "sticky-first-col" : ""}`}>
          <thead
            className="sticky top-0 z-20 bg-white shadow-[0_1px_0_rgba(0,0,0,0.06)]"
          >
            <tr>
              {renderExpanded && <th className="w-7" />}
              {columns.map((c, ci) => {
                const isFirst = ci === 0 && stickyFirstCol && !renderExpanded;
                return (
                  <th
                    key={c.key}
                    className={`group ${c.align === "right" || c.numeric ? "text-right" : "text-left"} ${c.sortable === false ? "" : "cursor-pointer hover:text-brand"} select-none ${isFirst ? "sticky left-0 z-30 bg-white" : ""}`}
                    onClick={() => toggleSort(c.key)}
                    style={c.width ? { width: c.width } : undefined}
                    title={c.headerTitle || undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      {sort && sort.key === c.key && (sort.dir === "asc" ? <CaretUp size={11} /> : <CaretDown size={11} />)}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleColExpand(c.key); }}
                        className={`inline-flex items-center align-middle transition-opacity ${expandedCols.has(c.key) ? "opacity-100 text-brand" : "opacity-0 group-hover:opacity-50 hover:!opacity-100"}`}
                        title={expandedCols.has(c.key) ? "Collapse column" : "Expand column to show full content"}
                        aria-label="Toggle column width"
                      >
                        <ArrowsHorizontal size={11} weight="bold" />
                      </button>
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={columns.length + (renderExpanded ? 1 : 0)} className="text-center text-muted py-8">
                  {emptyLabel}
                </td>
              </tr>
            )}
            {visible.map((r, i) => {
              const key = rowKey ? rowKey(r) : i;
              const isOpen = expanded.has(key);
              const customRowCls = typeof rowClassName === "function" ? rowClassName(r) : "";
              return (
                <React.Fragment key={key}>
                  <tr
                    className={`${onRowClick || renderExpanded ? "cursor-pointer hover:bg-panel" : ""} ${isOpen ? "bg-panel/60" : ""} ${customRowCls}`}
                    onClick={
                      renderExpanded
                        ? () => {
                            // Both: toggle the SKU expansion AND fire
                            // onRowClick (used by the SOR Report to mark
                            // the selected row for the location pane).
                            setExpanded((s) => {
                              const n = new Set(s);
                              if (n.has(key)) n.delete(key); else n.add(key);
                              return n;
                            });
                            if (onRowClick) onRowClick(r);
                          }
                        : (onRowClick ? () => onRowClick(r) : undefined)
                    }
                  >
                    {renderExpanded && (
                      <td className="text-center text-muted">
                        {isOpen ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
                      </td>
                    )}
                    {columns.map((c, ci) => {
                      const isFirst = ci === 0 && stickyFirstCol && !renderExpanded;
                      return (
                        <td
                          key={c.key}
                          className={`${c.align === "right" || c.numeric ? "text-right num" : "text-left"} ${c.className || ""} ${expandedCols.has(c.key) ? "col-expanded" : ""} ${isFirst ? "sticky left-0 z-10 bg-white" : ""}`}
                        >
                          {c.render ? c.render(r, i) : r[c.key]}
                        </td>
                      );
                    })}
                  </tr>
                  {renderExpanded && isOpen && (
                    <tr className="bg-panel/40">
                      <td colSpan={columns.length + 1} className="p-0">
                        <div className="px-4 py-3 border-y border-brand/30">
                          {renderExpanded(r)}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
          {footerRow && (
            <tfoot className="sticky bottom-0 z-20 bg-panel border-t-2 border-brand/40">
              <tr className="font-semibold">
                {footerRow}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {mobileCards && (
        <MobileCardList
          visible={visible}
          columns={columns}
          emptyLabel={emptyLabel}
          onRowClick={onRowClick}
          sort={sort}
          setSort={setSort}
        />
      )}
    </div>
  );
};

export default SortableTable;

/** Mobile card list — renders each row as a stacked card with the
 * `mobilePrimary` column as headline and remaining (non-hidden) columns
 * as label/value pairs. Only shown on screens < md (768px). Sort is
 * controlled via a compact select so users can still pivot on the go. */
const MobileCardList = ({ visible, columns, emptyLabel, onRowClick, sort, setSort }) => {
  const cardCols = columns.filter((c) => !c.mobileHidden);
  const primaryCol = cardCols.find((c) => c.mobilePrimary) || cardCols[0];
  const detailCols = cardCols.filter((c) => c !== primaryCol);
  const sortableCols = columns.filter((c) => c.sortable !== false && c.label);

  return (
    <div className="md:hidden" data-testid="mobile-card-list">
      {sortableCols.length > 0 && (
        <div className="flex items-center gap-2 mb-2 text-[11.5px]">
          <span className="text-muted">Sort:</span>
          <select
            value={sort ? `${sort.key}|${sort.dir}` : ""}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) { setSort(null); return; }
              const [key, dir] = v.split("|");
              setSort({ key, dir });
            }}
            className="border border-border rounded px-2 py-1 text-[12px] bg-white"
            data-testid="mobile-sort-select"
          >
            <option value="">Default</option>
            {sortableCols.map((c) => (
              <React.Fragment key={c.key}>
                <option value={`${c.key}|desc`}>{typeof c.label === "string" ? c.label : c.key} · high → low</option>
                <option value={`${c.key}|asc`}>{typeof c.label === "string" ? c.label : c.key} · low → high</option>
              </React.Fragment>
            ))}
          </select>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="text-center text-muted py-8 text-[13px]">{emptyLabel}</div>
      ) : (
        <div className="space-y-2">
          {visible.map((r, i) => (
            <div
              key={i}
              className={`card-white p-3 ${onRowClick ? "cursor-pointer active:bg-panel" : ""}`}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              data-testid="mobile-card"
            >
              <div className="font-semibold text-[13.5px] mb-1.5 break-words">
                {primaryCol.render ? primaryCol.render(r, i) : r[primaryCol.key]}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                {detailCols.map((c) => {
                  const val = c.render ? c.render(r, i) : r[c.key];
                  if (val == null || val === "" || val === false) return null;
                  return (
                    <React.Fragment key={c.key}>
                      <dt className="text-muted uppercase tracking-wider text-[10.5px] self-center">
                        {typeof c.label === "string" ? c.label : c.key}
                      </dt>
                      <dd className={`${c.numeric ? "text-right num" : "text-left"} self-center`}>{val}</dd>
                    </React.Fragment>
                  );
                })}
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
