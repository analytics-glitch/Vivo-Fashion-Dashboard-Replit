import React, { useState, useMemo } from "react";
import { ArrowUpDown } from "lucide-react";

/**
 * useSort: { sortKey, sortDir, sorted, SortHead }
 * - dir: "asc" | "desc"
 * - call SortHead({ k, label, right }) to render a clickable th cell.
 */
export function useSort(rows, initial = { key: null, dir: "desc" }) {
  const [sort, setSort] = useState(initial);

  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const arr = [...rows];
    arr.sort((a, b) => {
      const av = a?.[sort.key];
      const bv = b?.[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return sort.dir === "asc" ? av - bv : bv - av;
      }
      const sa = String(av), sb = String(bv);
      return sort.dir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
    return arr;
  }, [rows, sort]);

  const toggle = (key) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }));

  const SortHead = ({ k, label, right = false, className = "" }) => (
    <th
      data-testid={`sort-${k}`}
      onClick={() => toggle(k)}
      className={`px-3 py-3 ${right ? "text-right" : "text-left"} font-semibold cursor-pointer select-none hover:text-brand-deep ${className}`}
    >
      <span className={`inline-flex items-center gap-1 ${right ? "flex-row-reverse" : ""}`}>
        {label}
        <ArrowUpDown className={`h-3 w-3 ${sort.key === k ? "text-brand" : "text-muted-foreground/40"}`} />
      </span>
    </th>
  );

  return { sortKey: sort.key, sortDir: sort.dir, sorted, SortHead, setSort };
}
