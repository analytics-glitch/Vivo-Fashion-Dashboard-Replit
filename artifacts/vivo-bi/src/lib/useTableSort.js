import React, { useMemo, useState } from "react";
import { CaretUp, CaretDown } from "@phosphor-icons/react";

/**
 * useTableSort — sort-state + sort-helper for plain HTML tables.
 *
 * Drop-in companion for the many bespoke tables across the dashboard that
 * weren't built on the shared `<SortableTable>` component. Gives us a
 * three-state click pattern (asc → desc → off) and a small accessor-based
 * comparator that respects numbers, strings, and null values.
 *
 * MULTI-COLUMN: hold Shift while clicking a header to ADD it as a lower-priority
 * sort level (e.g. sort by Owner, then Shift-click POS Location to keep the
 * Owner grouping but order each owner's block by location). A plain (non-shift)
 * click resets to a single sort on that column. Internally we keep an ordered
 * `sorts` array; `sort` is exposed as `sorts[0]` for backward compatibility with
 * callers that only read a single active column.
 *
 *   const { sort, sorts, toggleSort, sortRows } = useTableSort();
 *   const accessors = { units: r => r.units_sold, location: r => r.channel };
 *   const visible = sortRows(rows, accessors);
 *   <SortableTh sortKey="units" sort={sort} sorts={sorts} onSort={toggleSort} numeric>
 *     Units
 *   </SortableTh>
 */
export const useTableSort = (initialSort = null) => {
  const [sorts, setSorts] = useState(initialSort ? [initialSort] : []);

  const toggleSort = (key, opts = {}) => {
    const numeric = !!opts.numeric;
    const additive = !!opts.additive;
    setSorts((arr) => {
      const idx = arr.findIndex((s) => s.key === key);
      if (additive) {
        // Multi-level: cycle this column asc → desc → removed, keeping the
        // relative priority of the other active columns intact.
        if (idx === -1) return [...arr, { key, dir: numeric ? "desc" : "asc" }];
        const cur = arr[idx];
        const next = arr.slice();
        if (cur.dir === "asc") next[idx] = { key, dir: "desc" };
        else next.splice(idx, 1);
        return next;
      }
      // Plain click: collapse to a single sort on this column (asc → desc → off).
      if (idx === -1 || arr.length > 1) return [{ key, dir: numeric ? "desc" : "asc" }];
      const cur = arr[0];
      if (cur.dir === "asc") return [{ key, dir: "desc" }];
      return [];
    });
  };

  const sortRows = useMemo(() => (rows, accessors = {}) => {
    if (!sorts.length || !rows?.length) return rows || [];
    return [...rows].sort((a, b) => {
      for (const s of sorts) {
        const acc = accessors[s.key] || ((r) => r?.[s.key]);
        const dir = s.dir === "asc" ? 1 : -1;
        const av = acc(a);
        const bv = acc(b);
        if (av == null && bv == null) continue;
        if (av == null) return 1;   // nulls always last, regardless of direction
        if (bv == null) return -1;
        let cmp;
        if (typeof av === "number" && typeof bv === "number") {
          cmp = (av - bv) * dir;
        } else {
          cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * dir;
        }
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  }, [sorts]);

  return { sort: sorts[0] || null, sorts, toggleSort, sortRows };
};

/**
 * SortableTh — clickable <th> with a chevron indicator. Re-uses Tailwind
 * utilities already in the codebase (`text-right`, `cursor-pointer`,
 * `hover:text-brand`) so the visual treatment matches the shared
 * `<SortableTable>` exactly. Shift-click adds a multi-column sort level; when
 * more than one column is active a small priority number (1, 2, 3…) is shown.
 */
export const SortableTh = ({
  sortKey,
  sort,
  sorts,
  onSort,
  numeric = false,
  align,
  className = "",
  title,
  children,
  testId,
  ...rest
}) => {
  const list = (sorts && sorts.length) ? sorts : (sort ? [sort] : []);
  const idx = list.findIndex((s) => s.key === sortKey);
  const active = idx !== -1;
  const cur = active ? list[idx] : null;
  const showPriority = active && list.length > 1;
  const isRight = align === "right" || numeric;
  const justify = isRight ? "justify-end" : "";
  return (
    <th
      className={`${isRight ? "text-right" : "text-left"} cursor-pointer select-none hover:text-brand ${className}`}
      onClick={(e) => onSort(sortKey, { numeric, additive: e.shiftKey })}
      title={title || "Click to sort. Shift-click to sort by multiple columns."}
      data-testid={testId}
      {...rest}
    >
      <span className={`inline-flex items-center gap-1 ${justify}`}>
        {children}
        {active && (cur.dir === "asc" ? <CaretUp size={11} weight="bold" /> : <CaretDown size={11} weight="bold" />)}
        {showPriority && (
          <span className="ml-0.5 inline-flex items-center justify-center rounded-full bg-brand/15 text-brand text-[9px] font-bold leading-none h-3.5 min-w-[14px] px-1">
            {idx + 1}
          </span>
        )}
      </span>
    </th>
  );
};

export default useTableSort;
