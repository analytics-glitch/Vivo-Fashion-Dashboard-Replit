import React, { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

// ── Central Tracker Orders Table ─────────────────────────────────────────────
// Shows Style No / Style Name / Order Qty / Order Date from the Central Tracker
// Google Sheet (4 year tabs). Data is fetched from /api/central-tracker and
// auto-refreshed every 30 minutes. Includes client-side search and year-filter
// chips that pass ?year= to the API so only rows for the selected tab are shown.

const REFRESH_MS = 30 * 60 * 1000; // 30 minutes

const YEAR_CHIPS = ["All", "2026", "2025", "2024", "PRE2024"];

const _MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtDate(s) {
  if (!s) return "—";
  // Strip any time component — handles "YYYY-MM-DD", "YYYY-MM-DDTHH:MM:SS",
  // and "YYYY-MM-DD HH:MM:SS" (space-separated) equally.
  const datePart = String(s).split("T")[0].split(" ")[0].trim();
  const parts = datePart.split("-");
  if (parts.length !== 3) return datePart;
  const [y, m, d] = parts;
  const month = _MONTHS[parseInt(m, 10) - 1] ?? m;
  return `${d} ${month} ${y}`;
}

function fmtQty(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}

function timeAgo(iso) {
  if (!iso) return null;
  const diff = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const SORT_COLS = {
  style_number: "Style No",
  style_name:   "Style Name",
  order_qty:    "Order Qty",
  order_date:   "Order Date",
};

export default function CentralTracker() {
  const [rows, setRows]       = useState([]);
  const [total, setTotal]     = useState(0);
  const [loadedAt, setLoadedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [year, setYear]       = useState("All");
  const [search, setSearch]   = useState("");
  const [sort, setSort]       = useState({ col: "order_date", dir: "desc" });
  const [tick, setTick]       = useState(Date.now());  // drives timeAgo re-render

  const fetchRef = useRef(null);

  const load = useCallback(async (selectedYear) => {
    try {
      const params = {};
      if (selectedYear && selectedYear !== "All") params.year = selectedYear;
      const { data } = await api.get("/central-tracker", { params, forceFresh: true });
      setRows(data.rows || []);
      setTotal(data.total ?? (data.rows || []).length);
      setLoadedAt(data.loaded_at || null);
      setError(null);
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + year-change refetch
  useEffect(() => {
    setLoading(true);
    load(year);
  }, [load, year]);

  // 30-minute auto-refresh
  useEffect(() => {
    const id = setInterval(() => load(year), REFRESH_MS);
    return () => clearInterval(id);
  }, [load, year]);

  // Tick every minute so "last refreshed" stays current
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Client-side search filter
  const q = search.trim().toLowerCase();
  let visible = q
    ? rows.filter(
        (r) =>
          (r.style_number || "").toLowerCase().includes(q) ||
          (r.style_name   || "").toLowerCase().includes(q)
      )
    : rows;

  // Client-side sort
  const { col, dir } = sort;
  visible = [...visible].sort((a, b) => {
    let va = a[col], vb = b[col];
    if (col === "order_qty") {
      va = va ?? -Infinity; vb = vb ?? -Infinity;
      return dir === "asc" ? va - vb : vb - va;
    }
    if (col === "order_date") {
      va = va || ""; vb = vb || "";
      return dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    va = (va || "").toLowerCase(); vb = (vb || "").toLowerCase();
    return dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
  });

  const toggleSort = (c) => {
    setSort((prev) =>
      prev.col === c
        ? { col: c, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { col: c, dir: c === "order_date" ? "desc" : "asc" }
    );
  };

  const ago = timeAgo(loadedAt);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Order Tracker</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Buying orders from the Central Tracker sheet — all four year tabs.
          </p>
        </div>
        {ago && (
          <span className="text-xs text-muted-foreground">
            Last refreshed: <span className="font-medium">{ago}</span>
            {" · "}
            <span className="tabular-nums">{total.toLocaleString()} rows total</span>
          </span>
        )}
      </div>

      {/* Controls: year chips + search */}
      <div className="flex flex-wrap items-center gap-2">
        {YEAR_CHIPS.map((y) => (
          <button
            key={y}
            onClick={() => setYear(y)}
            className={
              "px-3 py-1 rounded-full text-sm font-medium border transition-colors " +
              (year === y
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-foreground border-border hover:bg-muted")
            }
          >
            {y}
          </button>
        ))}
        <input
          type="search"
          placeholder="Search style no or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto w-56 rounded-md border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2 pt-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-8 rounded bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {String(error)}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && visible.length === 0 && (
        <div className="py-16 text-center text-muted-foreground text-sm">
          {q || year !== "All"
            ? "No orders match the current filter."
            : "No orders found. The sync may still be running — check back in a moment."}
        </div>
      )}

      {/* Table */}
      {!loading && !error && visible.length > 0 && (
        <div className="rounded-lg border border-border overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 sticky top-0 z-10">
              <tr>
                {Object.entries(SORT_COLS).map(([c, label]) => (
                  <th
                    key={c}
                    onClick={() => toggleSort(c)}
                    className="px-4 py-2.5 text-left font-semibold cursor-pointer select-none whitespace-nowrap hover:bg-muted/80 transition-colors"
                  >
                    {label}
                    {sort.col === c && (
                      <span className="ml-1 text-muted-foreground">
                        {sort.dir === "asc" ? "↑" : "↓"}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr
                  key={i}
                  className="border-t border-border hover:bg-muted/30 transition-colors"
                >
                  <td className="px-4 py-2 font-mono text-xs">{r.style_number || "—"}</td>
                  <td className="px-4 py-2 max-w-xs truncate" title={r.style_name || ""}>
                    {r.style_name || "—"}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-right">{fmtQty(r.order_qty)}</td>
                  <td className="px-4 py-2 tabular-nums whitespace-nowrap">{fmtDate(r.order_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {q || year !== "All" ? (
            <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
              Showing {visible.length.toLocaleString()} of {rows.length.toLocaleString()} rows
              {year !== "All" && ` (${year} tab)`}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
