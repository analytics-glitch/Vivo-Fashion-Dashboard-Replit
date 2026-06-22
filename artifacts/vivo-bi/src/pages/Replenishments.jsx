import React, { useEffect, useMemo, useState, useCallback } from "react";
import { api, fmtNum } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useFilters } from "@/lib/filters";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import { useTableSort, SortableTh } from "@/lib/useTableSort";
import {
  Calendar as CalendarIcon, CheckCircle, FilePdf,
  Package, ArrowCounterClockwise, MagnifyingGlass,
  Warning, Info, CaretDown, CaretRight, ListBullets,
  CalendarBlank, DownloadSimple, X as XIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { jsPDF } from "jspdf";
import ReplenishmentRosterCard from "@/components/ReplenishmentRosterCard";

/**
 * Daily Replenishment Page — full workflow.
 *
 * Features:
 *  • Owner roster panel (admin/owner only): set how many people are
 *    available + their names. Persists to /api/admin/replenishment-config
 *    so the next run uses the new roster automatically.
 *  • Live replenishment list — one row per (POS × SKU) needing top-up.
 *    Columns: Owner / POS / Days lapsed / Product / Size / Barcode /
 *    Bin / Sold / SOH Store / SOH WH / Suggested / Actual Replenished /
 *    Action (Mark As Done).
 *  • Days-lapsed pill goes RED when > 2 days.
 *  • Mark As Done snapshots the current shop-floor stock for the SKU
 *    (server-side) so the Completed report shows post-replenishment SOH
 *    and a fulfilment %.
 *  • Per-owner PDF export — tap "PDF" next to an owner's pill to
 *    generate a `<Owner>_replenishments_<date>.pdf`.
 *  • Completed Replenishments table at the bottom — audit trail with
 *    fulfilment rate per row.
 */

const fmtDateInput = (d) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const _isAdminOrOwner = (user) => {
  if (!user) return false;
  const r = (user.role || "").toLowerCase();
  return r === "admin" || r === "owner";
};

// Colour only — show the colour name; the generic print/plain value is dropped.
const fmtColourPrint = (r) => (r?.color_print || "").trim();

const PRIO_RANK = { critical: 0, high: 1, medium: 2 };

const Replenishments = () => {
  const { user } = useAuth();
  const isAdmin = _isAdminOrOwner(user);

  // Global filters drive the country/channel-scoped panels (chronic
  // stockouts, predictive alerts, the forward calendar and the Operations
  // export). The pick-list itself keeps its own date pickers.
  const { applied } = useFilters();
  const filterCountry = applied.countries.length === 1 ? applied.countries[0] : undefined;
  const filterChannel = applied.channels.length ? applied.channels.join(",") : undefined;
  const filterKey = JSON.stringify([applied.countries, applied.channels, applied.dataVersion]);

  // ISS-002 — Pick list date defaults to TODAY in Africa/Nairobi (EAT),
  // not UTC's yesterday. The label reads "Today's pick list · <today>"
  // so on day-1-of-month (e.g. Jun 1) the team isn't looking at a
  // header that says May 31 while actually picking today's orders.
  // The backend's default window covers "yesterday → today" (2 days
  // inclusive) so live sell-through is baked in regardless of the
  // user-facing label.
  const todayEat = useMemo(() => {
    const d = new Date();
    // Convert to EAT (UTC+3): add 3 hours, then format as ISO date
    const eat = new Date(d.getTime() + 3 * 60 * 60 * 1000);
    return eat.toISOString().slice(0, 10);
  }, []);
  const yesterdayEat = useMemo(() => {
    const d = new Date();
    const eat = new Date(d.getTime() + 3 * 60 * 60 * 1000);
    eat.setUTCDate(eat.getUTCDate() - 1);
    return eat.toISOString().slice(0, 10);
  }, []);
  const [dateFrom, setDateFrom] = useState(yesterdayEat);
  const [dateTo, setDateTo] = useState(todayEat);

  // Owner config (persisted server-side). Roster state moved into
  // <ReplenishmentRosterCard> (iter 78); we still keep a "saved" tick
  // so the live list re-fetches after a successful save.
  const [ownerSavedTick, setOwnerSavedTick] = useState(0);

  // Live data.
  const [data, setData] = useState({ rows: [], summary: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Per-row local actuals input — empty string until typed; on Mark As Done
  // we send `actual_units_replenished` so the server snapshot can compute
  // a real fulfilment rate.
  const [actuals, setActuals] = useState({});
  // Per-row optional transfer reference (e.g. an IBT/transfer doc number)
  // logged alongside the mark so the completed report shows the paperwork.
  const [transferRefs, setTransferRefs] = useState({});
  const [savingKey, setSavingKey] = useState(null);
  // Search across all visible columns.
  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");

  // Completed report.
  const [completed, setCompleted] = useState({ rows: [], total: 0 });
  const [completedLoading, setCompletedLoading] = useState(false);
  const [completedRefresh, setCompletedRefresh] = useState(0);

  // Iter 89 — Per-table sort state (each table is independent).
  const liveSort = useTableSort();
  const fulfilmentSort = useTableSort();
  const completedSort = useTableSort();

  // B2 — list vs forward calendar.
  const [viewMode, setViewMode] = useState("list");
  // B2 — per-row expand (size breakdown) + bulk selection sets.
  const [expanded, setExpanded] = useState(() => new Set());
  const [selected, setSelected] = useState(() => new Set());
  const [bulkSaving, setBulkSaving] = useState(false);
  // B2 — Operations export in-flight flag.
  const [exporting, setExporting] = useState(false);

  // B2 — predictive stockout banner (dismissible) + chronic-stockouts panel.
  const [alerts, setAlerts] = useState(null);
  const [alertDismissed, setAlertDismissed] = useState(false);
  const [chronic, setChronic] = useState(null);
  const [chronicOpen, setChronicOpen] = useState(false);

  // B2 — forward replenishment calendar (only fetched in calendar view).
  const [calendar, setCalendar] = useState(null);
  const [calLoading, setCalLoading] = useState(false);
  const [calError, setCalError] = useState(null);

  // Bootstrap is now handled inside <ReplenishmentRosterCard>; this
  // page just listens for the save signal via the onSaved callback.

  // (Roster name/array resize lives inside the shared card component.)

  const handleRosterSaved = useCallback(async () => {
    // Bypass the 5-min response cache so the redistribution is visible
    // instantly (otherwise the admin sees the OLD owner pills until
    // the cache expires).
    await loadLive({ forceFresh: true });
    setOwnerSavedTick((t) => t + 1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch live replenishment list (re-runs when roster save tick changes
  // so admins see the new owner assignment immediately).
  const loadLive = useCallback(async (opts = {}) => {
    setLoading(true);
    setError(null);
    try {
      const { data: d } = await api.get("/analytics/replenishment-report", {
        params: { date_from: dateFrom, date_to: dateTo },
        timeout: 240000,
        // After Save & redistribute, bypass the 5-min response cache so
        // the new owner assignment is immediately visible.
        forceFresh: !!opts.forceFresh,
      });
      setData(d || { rows: [], summary: null });
      // Re-seed the actuals input with the suggested qty for any row not
      // already in the local state (so the input shows a sensible default).
      const seed = {};
      for (const r of d?.rows || []) {
        const k = `${r.pos_location}|${r.barcode}`;
        if (!(k in actuals)) {
          // If the server already has an actual snapshot, prefer that.
          seed[k] = r.actual_units_replenished != null
            ? String(r.actual_units_replenished)
            : "";
        }
      }
      setActuals((prev) => ({ ...seed, ...prev }));
    } catch (e) {
      setError(e?.response?.data?.detail || e.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, ownerSavedTick]);

  useEffect(() => { loadLive(); }, [loadLive]);

  // Completed report — admin/owner only since it's a chain-wide audit.
  useEffect(() => {
    if (!isAdmin) return;
    let cancel = false;
    setCompletedLoading(true);
    api.get("/analytics/replenishment-completed", { params: { days: 30 }, forceFresh: completedRefresh > 0 })
      .then(({ data: c }) => { if (!cancel) setCompleted(c || { rows: [], total: 0 }); })
      .catch(() => { if (!cancel) setCompleted({ rows: [], total: 0 }); })
      .finally(() => { if (!cancel) setCompletedLoading(false); });
    return () => { cancel = true; };
  }, [isAdmin, completedRefresh]);

  // B2 — predictive stockout alerts (styles dropping below 2 weeks of cover).
  useEffect(() => {
    let cancel = false;
    api.get("/replenishment/stockout-alerts", { params: { country: filterCountry, channel: filterChannel } })
      .then(({ data }) => { if (!cancel) { setAlerts(data || null); setAlertDismissed(false); } })
      .catch(() => { if (!cancel) setAlerts(null); });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // B2 — chronic stockouts (at risk 3+ consecutive snapshot weeks).
  useEffect(() => {
    let cancel = false;
    api.get("/replenishment/chronic-stockouts", { params: { min_weeks: 3 } })
      .then(({ data }) => { if (!cancel) setChronic(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancel) setChronic([]); });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied.dataVersion]);

  // B2 — forward replenishment calendar (only when the calendar view is on).
  useEffect(() => {
    if (viewMode !== "calendar") return;
    let cancel = false;
    setCalLoading(true);
    setCalError(null);
    api.get("/replenishment/calendar", { params: { country: filterCountry, weeks_ahead: 8 } })
      .then(({ data }) => { if (!cancel) setCalendar(data || null); })
      .catch((e) => { if (!cancel) setCalError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancel) setCalLoading(false); });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, filterKey]);

  // Visible rows = filter out already-completed rows AND apply free-text search.
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data.rows || [])
      .filter((r) => !r.replenished)
      .filter((r) => !ownerFilter || (r.owner || "") === ownerFilter)
      .filter((r) => {
        if (!q) return true;
        return (
          (r.owner || "").toLowerCase().includes(q)
          || (r.pos_location || "").toLowerCase().includes(q)
          || (r.product_name || "").toLowerCase().includes(q)
          || (r.size || "").toLowerCase().includes(q)
          || (r.barcode || "").toLowerCase().includes(q)
          || (r.sku || "").toLowerCase().includes(q)
          || (r.bin || "").toLowerCase().includes(q)
          || fmtColourPrint(r).toLowerCase().includes(q)
        );
      });
  }, [data.rows, search, ownerFilter]);

  // Distinct owners present in the open list — drives the owner filter dropdown.
  // Recomputes after a roster redistribution (data.rows is re-fetched), so the
  // options always reflect the current assignment.
  const ownerOptions = useMemo(() => {
    const set = new Set();
    for (const r of (data.rows || [])) {
      if (!r.replenished && r.owner) set.add(r.owner);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [data.rows]);

  // Drop a stale owner selection if that owner no longer has open lines
  // (e.g. after redistribution reassigns everything away from them).
  useEffect(() => {
    if (ownerFilter && !ownerOptions.includes(ownerFilter)) setOwnerFilter("");
  }, [ownerOptions, ownerFilter]);

  // Iter 89 — Sortable view of visibleRows. Default ordering is the
  // server-side picker assignment (owner / pos / bin) so the natural
  // grouping is preserved until the user clicks a header.
  const sortedVisibleRows = useMemo(() => {
    return liveSort.sortRows(visibleRows, {
      owner: (r) => r.owner || "",
      pos_location: (r) => r.pos_location || "",
      days_lapsed: (r) => r.days_lapsed == null ? null : Number(r.days_lapsed),
      product_name: (r) => r.product_name || "",
      size: (r) => r.size || "",
      barcode: (r) => r.barcode || "",
      bin: (r) => r.bin || "",
      colour_print: (r) => fmtColourPrint(r),
      units_sold: (r) => Number(r.units_sold ?? 0),
      soh_store: (r) => Number(r.soh_store ?? 0),
      soh_wh: (r) => Number(r.soh_wh ?? 0),
      replenish: (r) => Number(r.replenish ?? 0),
    });
  }, [liveSort, visibleRows]);

  const setActual = (k, v) => setActuals((prev) => ({ ...prev, [k]: v }));

  const markAsDone = async (row) => {
    const k = `${row.pos_location}|${row.barcode}`;
    const raw = actuals[k];
    const actual = raw === "" || raw == null ? row.replenish : Number(raw);
    if (Number.isNaN(actual) || actual < 0) {
      toast.error("Actual replenished must be ≥ 0");
      return;
    }
    const transferRef = (transferRefs[k] ?? "").trim();
    setSavingKey(k);
    try {
      await api.post("/analytics/replenishment-report/mark", {
        date_from: dateFrom,
        date_to: dateTo,
        pos_location: row.pos_location,
        barcode: row.barcode,
        replenished: true,
        actual_units_replenished: actual,
        transfer_ref: transferRef,
        owner: row.owner,
        product_name: row.product_name,
        size: row.size,
        sku: row.sku,
        country: row.country,
        units_to_replenish: row.replenish,
        soh_store: row.soh_store,
        soh_wh: row.soh_wh,
      });
      // Optimistic flip: stamp `replenished=true` locally so the row
      // disappears from the live list immediately.
      setData((prev) => ({
        ...prev,
        rows: (prev.rows || []).map((r) =>
          r.pos_location === row.pos_location && r.barcode === row.barcode
            ? { ...r, replenished: true, actual_units_replenished: actual, transfer_ref: transferRef }
            : r
        ),
      }));
      setCompletedRefresh((t) => t + 1);
      toast.success("Marked done.");
    } catch (e) {
      toast.error("Couldn't save — " + (e?.response?.data?.detail || e.message));
    } finally {
      setSavingKey(null);
    }
  };

  // B2 — sales velocity → weeks-of-cover, computed from the pick-list window.
  // The report only ships raw units sold + store SOH, so we normalise the
  // window to a weekly run-rate to expose "weeks of cover" (WoC). A 4-week
  // supplier lead time is the line in the sand: under it = AT RISK.
  const windowDays = useMemo(() => {
    try {
      const a = new Date(dateFrom);
      const b = new Date(dateTo);
      const d = Math.round((b - a) / 86400000) + 1;
      return d > 0 ? d : 1;
    } catch { return 1; }
  }, [dateFrom, dateTo]);

  const rowVelocity = useCallback((r) => {
    const sold = Number(r.units_sold || 0);
    const soh = Number(r.soh_store || 0);
    const weekly = windowDays > 0 ? (sold / windowDays) * 7 : sold * 7;
    const woc = weekly > 0 ? soh / weekly : (soh > 0 ? Infinity : 0);
    let status = null; // "risk" | "watch"
    if (weekly > 0) {
      if (woc < 4) status = "risk";
      else if (woc >= 5 && woc <= 7) status = "watch";
    }
    return { weekly, woc, status };
  }, [windowDays]);

  // B2 — expand / collapse the size-breakdown sub-row for a SKU.
  const toggleExpand = useCallback((k) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  // B2 — bulk selection helpers (keyed identically to markAsDone).
  const toggleSelect = useCallback((k) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  const allVisibleSelected = sortedVisibleRows.length > 0
    && sortedVisibleRows.every((r) => selected.has(`${r.pos_location}|${r.barcode}`));

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const keys = sortedVisibleRows.map((r) => `${r.pos_location}|${r.barcode}`);
      const everySelected = keys.length > 0 && keys.every((k) => prev.has(k));
      if (everySelected) {
        const next = new Set(prev);
        keys.forEach((k) => next.delete(k));
        return next;
      }
      return new Set([...prev, ...keys]);
    });
  }, [sortedVisibleRows]);

  // B2 — bulk approve via the recommendations engine. Each line is stamped
  // done under both its SKU and barcode keys so the audit ledger matches the
  // single-row mark path exactly.
  const bulkApprove = useCallback(async () => {
    const rows = sortedVisibleRows.filter((r) => selected.has(`${r.pos_location}|${r.barcode}`));
    if (!rows.length) return;
    const actions = [];
    for (const r of rows) {
      const k = `${r.pos_location}|${r.barcode}`;
      const raw = actuals[k];
      const actual = raw === "" || raw == null ? Number(r.replenish || 0) : Number(raw);
      const au = Number.isNaN(actual) || actual < 0 ? Number(r.replenish || 0) : actual;
      if (r.sku) {
        actions.push({ rec_type: "replenish", rec_key: `${r.pos_location}|sku|${r.sku}`, status: "done", actual_units: au });
      }
      if (r.barcode) {
        actions.push({ rec_type: "replenish", rec_key: `${r.pos_location}|barcode|${r.barcode}`, status: "done", actual_units: au });
      }
    }
    if (!actions.length) {
      toast.error("Selected lines have no SKU or barcode to approve.");
      return;
    }
    setBulkSaving(true);
    try {
      await api.post("/recommendations/bulk", { actions });
      const keys = new Set(rows.map((r) => `${r.pos_location}|${r.barcode}`));
      setData((prev) => ({
        ...prev,
        rows: (prev.rows || []).map((r) =>
          keys.has(`${r.pos_location}|${r.barcode}`) ? { ...r, replenished: true } : r
        ),
      }));
      setSelected(new Set());
      setCompletedRefresh((t) => t + 1);
      toast.success(`Approved ${rows.length} line${rows.length === 1 ? "" : "s"}.`);
    } catch (e) {
      toast.error("Bulk approve failed — " + (e?.response?.data?.detail || e.message));
    } finally {
      setBulkSaving(false);
    }
  }, [sortedVisibleRows, selected, actuals]);

  // B2 — Export to Operations (server-built XLSX). Cookie auth rides along
  // on the same axios client; forceFresh skips the response cache.
  const exportOperations = useCallback(async () => {
    setExporting(true);
    try {
      const resp = await api.get("/replenishment/export/operations", {
        params: { country: filterCountry, channel: filterChannel },
        responseType: "blob",
        forceFresh: true,
        timeout: 240000,
      });
      const blob = resp?.data instanceof Blob ? resp.data : new Blob([resp.data]);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Replenishment_Operations_${todayEat}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("Operations export downloaded.");
    } catch (e) {
      toast.error("Export failed — " + (e?.response?.data?.detail || e.message));
    } finally {
      setExporting(false);
    }
  }, [filterCountry, filterChannel]);

  // B2 — pivot the forward calendar into a subcategory × week matrix.
  const calMatrix = useMemo(() => {
    const buckets = calendar?.buckets || [];
    if (!buckets.length) return null;
    const map = {}; // subcat → weekStart → {count, critical, high, medium}
    const subcats = new Set();
    for (const b of buckets) {
      for (const s of (b.styles || [])) {
        const sc = s.subcategory || "Other";
        subcats.add(sc);
        map[sc] = map[sc] || {};
        const cell = (map[sc][b.week_start] = map[sc][b.week_start] || { count: 0, critical: 0, high: 0, medium: 0 });
        cell.count += 1;
        const p = (s.priority || "").toLowerCase();
        if (p === "critical") cell.critical += 1;
        else if (p === "high") cell.high += 1;
        else cell.medium += 1;
      }
    }
    return { buckets, subcats: [...subcats].sort(), map };
  }, [calendar]);

  // Per-user fulfilment summary — small focused widget. Aggregates
  // completed rows by owner/picker and computes their overall
  // fulfilment % = sum(actual) / sum(suggested) over the same window.
  const fulfilmentByUser = useMemo(() => {
    const acc = new Map(); // user → {target, actual, lines}
    for (const r of completed.rows || []) {
      const u = r.owner || r.completed_by_name || "—";
      const cur = acc.get(u) || { user: u, target: 0, actual: 0, lines: 0 };
      cur.target += Number(r.units_to_replenish || 0);
      cur.actual += Number(r.actual_units_replenished || 0);
      cur.lines += 1;
      acc.set(u, cur);
    }
    const out = [...acc.values()].map((x) => ({
      ...x,
      rate: x.target > 0 ? (x.actual / x.target * 100) : null,
    }));
    out.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
    return out;
  }, [completed.rows]);

  const exportOwnerPdf = (ownerName) => {
    const rows = (data.rows || []).filter(
      (r) => !r.replenished && r.owner === ownerName
    );
    if (rows.length === 0) {
      toast("Nothing to export — this person has no open lines.");
      return;
    }
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 28;

    // Header.
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text(`Replenishment Pick List — ${ownerName}`, margin, 36);
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    const rangeLbl = dateFrom === dateTo ? dateFrom : `${dateFrom} → ${dateTo}`;
    doc.text(`Window: ${rangeLbl}   ·   Generated: ${new Date().toLocaleString("en-KE")}`, margin, 52);
    const totUnits = rows.reduce((s, r) => s + (r.replenish || 0), 0);
    doc.text(`${rows.length} lines · ${totUnits} units`, margin, 66);

    // Hand-rolled table (avoids the jspdf-autotable runtime dep).
    const headers = ["POS", "Days", "Product", "Colour", "Size", "Barcode", "Bin", "Sold", "Store", "WH", "Need", "Actual"];
    const colWidths = [104, 30, 168, 86, 36, 66, 50, 34, 36, 34, 38, 46];
    const startX = margin;
    let y = 88;

    const drawRow = (cells, isHeader = false) => {
      let x = startX;
      doc.setFont("helvetica", isHeader ? "bold" : "normal");
      doc.setFontSize(isHeader ? 9 : 9);
      if (isHeader) {
        doc.setFillColor(15, 61, 36);
        doc.rect(startX, y - 11, colWidths.reduce((a, b) => a + b, 0), 16, "F");
        doc.setTextColor(255, 255, 255);
      } else {
        doc.setTextColor(0, 0, 0);
      }
      cells.forEach((c, i) => {
        const text = String(c == null ? "" : c);
        // Truncate long text to fit column.
        const maxW = colWidths[i] - 6;
        let t = text;
        while (doc.getTextWidth(t) > maxW && t.length > 1) t = t.slice(0, -1);
        if (t !== text) t = t.slice(0, -1) + "…";
        doc.text(t, x + 3, y);
        x += colWidths[i];
      });
      doc.setTextColor(0, 0, 0);
    };

    drawRow(headers, true);
    y += 12;
    doc.setDrawColor(220, 220, 220);
    for (const r of rows) {
      if (y > doc.internal.pageSize.getHeight() - 28) {
        doc.addPage();
        y = 36;
        drawRow(headers, true);
        y += 12;
      }
      drawRow([
        r.pos_location || "",
        r.days_lapsed != null ? `${r.days_lapsed}d` : "—",
        r.product_name || "",
        fmtColourPrint(r),
        r.size || "",
        r.barcode || "",
        r.bin || "",
        r.units_sold ?? "",
        r.soh_store ?? "",
        r.soh_wh ?? "",
        r.replenish ?? "",
        "",  // blank box for the picker to write the actual qty
      ]);
      doc.line(startX, y + 2, startX + colWidths.reduce((a, b) => a + b, 0), y + 2);
      y += 14;
    }

    // Footer signature block.
    if (y > doc.internal.pageSize.getHeight() - 60) doc.addPage();
    y += 20;
    doc.setFontSize(10);
    doc.text(`Signed by ${ownerName}: __________________________   Date: ____________`, margin, y);

    const safe = ownerName.replace(/[^a-z0-9_-]+/gi, "_");
    doc.save(`${safe}_replenishment_${dateFrom}.pdf`);
  };

  // ISS-002 — Header label always anchors on "today" (EAT). The
  // sub-line shows the actual window (yesterday → today) so the picker
  // knows what sell-through data is being considered, but the heading
  // never falls behind the calendar day.
  const dateLabel = todayEat;
  const windowLabel = dateFrom === dateTo ? dateFrom : `${dateFrom} → ${dateTo}`;
  const summary = data.summary;

  return (
    <div className="space-y-5" data-testid="replenishments-page">
      {/* B2 — predictive stockout banner. `total` is already pre-filtered to
          styles dropping under 2 weeks of cover on the server. */}
      {alerts && !alertDismissed && (alerts.total ?? 0) > 0 && (
        <div
          className="flex items-start gap-3 rounded-lg border border-rose-300 bg-rose-50 px-4 py-3"
          role="alert"
          data-testid="replen-stockout-banner"
        >
          <Warning size={18} weight="fill" className="text-rose-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0 text-[12.5px] text-rose-900">
            <b>{fmtNum(alerts.total)}</b> style{alerts.total === 1 ? "" : "s"} will stock out within 2 weeks.
            {(alerts.critical_count ?? 0) > 0 && (
              <> <span className="font-semibold">{fmtNum(alerts.critical_count)} critical</span>.</>
            )}
            {(alerts.warning_count ?? 0) > 0 && (
              <> {fmtNum(alerts.warning_count)} on watch.</>
            )}
          </div>
          <button
            type="button"
            onClick={() => setAlertDismissed(true)}
            className="text-rose-500 hover:text-rose-700 shrink-0"
            aria-label="Dismiss stockout alert"
            data-testid="replen-banner-dismiss"
          >
            <XIcon size={15} weight="bold" />
          </button>
        </div>
      )}

      {/* B2 — chronic stockouts (at risk 3+ consecutive snapshot weeks). */}
      {chronic && chronic.length > 0 && (
        <div className="card-white p-0 overflow-hidden" data-testid="replen-chronic-panel">
          <button
            type="button"
            onClick={() => setChronicOpen((o) => !o)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-panel/40"
            data-testid="replen-chronic-toggle"
          >
            <span className="inline-flex items-center gap-2 font-extrabold text-[13.5px] text-[#0f3d24]">
              <Warning size={15} weight="duotone" className="text-amber-600" />
              Chronic stockouts · {fmtNum(chronic.length)} style{chronic.length === 1 ? "" : "s"} at risk 3+ weeks
            </span>
            {chronicOpen ? <CaretDown size={15} weight="bold" /> : <CaretRight size={15} weight="bold" />}
          </button>
          {chronicOpen && (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full min-w-max text-[12px]">
                <thead className="bg-panel">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Style</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Country</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Brand</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Subcategory</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Weeks at risk</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Avg units/wk</th>
                    <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Avg WoC</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">First flagged</th>
                  </tr>
                </thead>
                <tbody>
                  {chronic.map((c, i) => (
                    <tr key={`${c.style_name}-${c.country}-${i}`} className={`border-t border-border/50 ${i % 2 === 0 ? "bg-white" : "bg-panel/30"}`} data-testid={`replen-chronic-row-${i}`}>
                      <td className="px-3 py-2 whitespace-nowrap font-semibold">{c.style_name || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{c.country || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{c.brand || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{c.subcategory || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className="inline-flex items-center bg-rose-100 text-rose-800 border border-rose-300 font-bold px-2 py-0.5 rounded-full">
                          {fmtNum(c.consecutive_at_risk_weeks)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(c.avg_weekly_units)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{c.avg_woc == null ? "—" : Number(c.avg_woc).toFixed(1)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted">{c.first_flagged_date || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div>
        <p className="text-[12.5px] text-muted mt-1 max-w-3xl">
          For each POS where shop-floor stock is below 2 units AND units sold &gt; 0 in
          the window we recommend a top-up to <b>2 units per SKU</b>, drawn from the
          warehouse. Includes Online (Shop Zetu); other online channels excluded.
          Lines distribute equally across your team, sorted by POS ascending.
        </p>
      </div>

      {/* Owner roster panel — admin/owner only. Extracted to a reusable
          component so the IBT Warehouse→Store page can mount the same
          card (iter 78). Saves to /admin/replenishment-config; on
          success we refresh the live list. */}
      <ReplenishmentRosterCard isAdmin={isAdmin} onSaved={handleRosterSaved} />

      {/* Live list. */}
      <div className="card-white p-5" data-testid="replen-live-card">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <h2 className="font-extrabold text-[14px] text-[#0f3d24] inline-flex items-center gap-2">
            <Package size={16} weight="duotone" /> Today's pick list · {dateLabel}
            <span className="text-[10.5px] font-medium text-muted normal-case ml-1.5">
              · window {windowLabel}
            </span>
          </h2>
          <label className="inline-flex items-center gap-2 text-[12px] font-semibold">
            <CalendarIcon size={14} weight="bold" className="text-brand" /> From
            <input type="date" value={dateFrom} max={dateTo}
              onChange={(e) => setDateFrom(e.target.value)}
              data-testid="replen-date-from"
              className="input-pill text-[12px] py-1.5 px-3" />
          </label>
          <label className="inline-flex items-center gap-2 text-[12px] font-semibold">
            To
            <input type="date" value={dateTo} min={dateFrom} max={fmtDateInput(new Date())}
              onChange={(e) => setDateTo(e.target.value)}
              data-testid="replen-date-to"
              className="input-pill text-[12px] py-1.5 px-3" />
          </label>

          {/* B2 — list vs forward calendar + Operations export. */}
          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex rounded-full border border-border overflow-hidden" role="group" data-testid="replen-view-toggle">
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold ${viewMode === "list" ? "bg-emerald-700 text-white" : "bg-white text-foreground hover:bg-panel"}`}
                data-testid="replen-view-list"
              >
                <ListBullets size={13} weight="bold" /> List
              </button>
              <button
                type="button"
                onClick={() => setViewMode("calendar")}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold ${viewMode === "calendar" ? "bg-emerald-700 text-white" : "bg-white text-foreground hover:bg-panel"}`}
                data-testid="replen-view-calendar"
              >
                <CalendarBlank size={13} weight="bold" /> Calendar
              </button>
            </div>
            <button
              type="button"
              onClick={exportOperations}
              disabled={exporting}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-white bg-[#0f3d24] hover:bg-[#0c3019] disabled:opacity-50 px-3 py-1.5 rounded-full"
              data-testid="replen-export-ops"
              title="Download the full replenishment plan as an Operations workbook"
            >
              <DownloadSimple size={13} weight="bold" /> {exporting ? "Exporting…" : "Export to Operations"}
            </button>
          </div>
        </div>

        {/* Summary pills with per-person PDF export. */}
        {summary && summary.by_owner && summary.by_owner.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3" data-testid="replen-summary">
            {summary.by_owner.map((o) => (
              <span
                key={o.owner}
                className="inline-flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 text-emerald-900 text-[11px] font-semibold pl-2 pr-1 py-1 rounded-full"
                data-testid={`replen-owner-${o.owner.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {o.owner}: <b>{fmtNum(o.lines)}</b> lines · {fmtNum(o.units)} units · {fmtNum(o.stores)} stores
                <button
                  type="button"
                  onClick={() => exportOwnerPdf(o.owner)}
                  className="ml-1 inline-flex items-center gap-0.5 bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold px-2 py-0.5 rounded-full"
                  title={`Download ${o.owner}'s pick list as PDF`}
                  data-testid={`replen-pdf-${o.owner.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  <FilePdf size={10} weight="bold" /> PDF
                </button>
              </span>
            ))}
            <span className="inline-flex items-center gap-1 bg-panel border border-border text-[11px] font-semibold px-2 py-1 rounded-full">
              Total: <b>{fmtNum(summary.total_units)}</b> units · {fmtNum(summary.total_rows)} rows
            </span>
            {(summary.completed ?? 0) > 0 && (
              <span className="inline-flex items-center gap-1 bg-emerald-100 border border-emerald-300 text-emerald-900 text-[11px] font-bold px-2 py-1 rounded-full">
                <CheckCircle size={11} weight="fill" /> {summary.completed} done
              </span>
            )}
          </div>
        )}

        {/* B2 — list view: search, bulk bar, and the SKU pick-list table. */}
        {viewMode === "list" && (<>
        {/* Search + owner filter */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="flex items-center gap-2 input-pill" style={{ maxWidth: 360, flex: "1 1 240px" }}>
            <MagnifyingGlass size={14} className="text-muted" />
            <input
              placeholder="Search owner / store / SKU / barcode…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="replen-search"
              className="bg-transparent outline-none text-[13px] w-full"
            />
          </div>
          {ownerOptions.length > 0 && (
            <select
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              data-testid="replen-owner-filter"
              title="Filter the pick-list by assigned owner"
              className="input-pill text-[13px] py-1.5 px-3"
            >
              <option value="">All owners</option>
              {ownerOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {ownerFilter && (
            <button
              type="button"
              onClick={() => setOwnerFilter("")}
              className="text-[11.5px] font-semibold text-muted hover:text-foreground"
            >
              Clear owner
            </button>
          )}
        </div>

        {/* B2 — bulk action bar (appears once lines are selected). */}
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 mb-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2" data-testid="replen-bulk-bar">
            <span className="text-[12px] font-semibold text-emerald-900">{selected.size} selected</span>
            <button
              type="button"
              onClick={bulkApprove}
              disabled={bulkSaving}
              className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 px-3 py-1.5 rounded-md"
              data-testid="replen-bulk-approve"
            >
              <CheckCircle size={13} weight="fill" /> {bulkSaving ? "Approving…" : "Approve selected"}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-[11.5px] font-semibold text-muted hover:text-foreground"
              data-testid="replen-bulk-clear"
            >
              Clear
            </button>
          </div>
        )}

        {loading && <Loading label="Computing replenishment list…" />}
        {error && <ErrorBox message={error} />}

        {!loading && !error && (
          visibleRows.length === 0 ? (
            <Empty label={
              (data.rows || []).length === 0
                ? "Nothing to replenish — no in-store SKU sold > 0 with stock < 2 in this window."
                : "All open lines have been actioned."
            } />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <p className="px-3 py-2 text-[11px] text-muted border-b border-border">
                Tip: click a column header to sort. <strong>Shift-click</strong> another header to sort by multiple columns (e.g. Owner, then POS Location).
              </p>
              <table className="w-full min-w-max text-[12.5px]" data-testid="replen-table">
                <thead className="bg-panel sticky top-0 z-10">
                  <tr className="text-left">
                    <th className="px-3 py-2.5 w-9">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAll}
                        aria-label="Select all lines"
                        data-testid="replen-select-all"
                        className="accent-emerald-700"
                      />
                    </th>
                    <SortableTh sortKey="owner" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Owner</SortableTh>
                    <SortableTh sortKey="pos_location" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">POS Location</SortableTh>
                    <SortableTh sortKey="days_lapsed" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap" title="Days since this SKU first appeared on the replenishment list. RED when > 2.">Days lapsed</SortableTh>
                    <SortableTh sortKey="product_name" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold sticky left-0 bg-panel z-20 min-w-[200px] max-w-[280px]">Product</SortableTh>
                    <SortableTh sortKey="size" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Size</SortableTh>
                    <SortableTh sortKey="barcode" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Barcode</SortableTh>
                    <SortableTh sortKey="bin" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Bin</SortableTh>
                    <SortableTh sortKey="colour_print" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Colour</SortableTh>
                    <SortableTh sortKey="units_sold" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Sold</SortableTh>
                    <SortableTh sortKey="soh_store" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">SOH Store</SortableTh>
                    <SortableTh sortKey="soh_wh" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">SOH WH</SortableTh>
                    <SortableTh sortKey="replenish" sort={liveSort.sort} sorts={liveSort.sorts} onSort={liveSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Suggested</SortableTh>
                    <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap">Actual replenished</th>
                    <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Transfer ref</th>
                    <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedVisibleRows.map((r, idx) => {
                    const k = `${r.pos_location}|${r.barcode}`;
                    const dl = r.days_lapsed;
                    const isSelected = selected.has(k);
                    const isOpen = expanded.has(k);
                    const hasBreakdown = r.size_breakdown_available
                      && Array.isArray(r.size_breakdown) && r.size_breakdown.length > 0;
                    const vel = rowVelocity(r);
                    const wocLabel = !isFinite(vel.woc)
                      ? "ample"
                      : `${vel.woc.toFixed(1)} wks`;
                    const whyText = `${r.pos_location}: ~${vel.weekly.toFixed(1)} units/wk sell-through, ${wocLabel} of store cover. Suggested top-up keeps this SKU ahead of the 4-week supplier lead time.`;
                    return (
                      <React.Fragment key={k}>
                      <tr className={`border-t border-border/50 ${idx % 2 === 0 ? "bg-white" : "bg-panel/30"} hover:bg-amber-50/40`}>
                        <td className="px-3 py-3 align-top">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(k)}
                            aria-label={`Select ${r.product_name || "line"}`}
                            data-testid={`replen-select-${idx}`}
                            className="accent-emerald-700"
                          />
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span className="inline-flex items-center bg-emerald-100 text-emerald-900 text-[11px] font-bold px-2 py-0.5 rounded-full">
                            {r.owner || "—"}
                          </span>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap font-semibold">{r.pos_location}</td>
                        <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap" data-testid={`replen-days-lapsed-${idx}`}>
                          {dl == null ? <span className="text-muted">—</span>
                            : dl > 2 ? <span className="inline-flex items-center bg-rose-100 text-rose-800 border border-rose-300 font-bold px-2 py-0.5 rounded-full">{dl}d</span>
                            : <span className="text-muted">{dl}d</span>}
                        </td>
                        <td className="px-3 py-3 sticky left-0 bg-inherit z-[5] min-w-[200px] max-w-[280px]">
                          <div className="flex items-start gap-1.5">
                            {hasBreakdown ? (
                              <button
                                type="button"
                                onClick={() => toggleExpand(k)}
                                className="mt-0.5 text-muted hover:text-foreground shrink-0"
                                aria-label="Toggle size breakdown"
                                aria-expanded={isOpen}
                                data-testid={`replen-expand-${idx}`}
                              >
                                {isOpen ? <CaretDown size={13} weight="bold" /> : <CaretRight size={13} weight="bold" />}
                              </button>
                            ) : (
                              <span className="w-[13px] shrink-0" aria-hidden="true" />
                            )}
                            <span className="break-words" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{r.product_name}</span>
                            <span
                              title={whyText}
                              className="text-muted hover:text-brand cursor-help shrink-0 mt-0.5"
                              data-testid={`replen-why-${idx}`}
                              aria-label="Why recommended?"
                            >
                              <Info size={13} weight="bold" />
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">{r.size || "—"}</td>
                        <td className="px-3 py-3 whitespace-nowrap font-mono text-[11px]">{r.barcode}</td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {r.bin
                            ? <span className="inline-flex items-center bg-amber-100 text-amber-900 text-[10.5px] font-bold px-1.5 py-0.5 rounded">{r.bin}</span>
                            : <span className="text-muted text-[11px]">—</span>}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {fmtColourPrint(r) || <span className="text-muted text-[11px]">—</span>}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{fmtNum(r.units_sold)}</td>
                        <td className={`px-3 py-3 text-right tabular-nums ${r.soh_store === 0 ? "text-rose-700 font-bold" : ""}`}>
                          {fmtNum(r.soh_store)}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{fmtNum(r.soh_wh)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">
                          <div className="inline-flex flex-col items-end gap-1">
                            <span className="inline-flex items-center bg-emerald-100 text-emerald-900 font-bold px-2 py-0.5 rounded-full">{fmtNum(r.replenish)}</span>
                            {vel.status === "risk" && (
                              <span className="inline-flex items-center gap-1 bg-rose-100 text-rose-800 border border-rose-300 text-[9.5px] font-bold px-1.5 py-0.5 rounded-full" data-testid={`replen-risk-${idx}`} title={whyText}>
                                <Warning size={9} weight="fill" /> AT RISK
                              </span>
                            )}
                            {vel.status === "watch" && (
                              <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-900 border border-amber-300 text-[9.5px] font-bold px-1.5 py-0.5 rounded-full" data-testid={`replen-watch-${idx}`} title={whyText}>
                                WATCH
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            min={0}
                            inputMode="numeric"
                            placeholder={String(r.replenish)}
                            value={actuals[k] ?? ""}
                            onChange={(e) => setActual(k, e.target.value)}
                            className="w-20 h-9 px-2 text-right tabular-nums border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-brand/40"
                            data-testid={`replen-actual-${idx}`}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            placeholder="Transfer ref"
                            value={transferRefs[k] ?? ""}
                            onChange={(e) => setTransferRefs((prev) => ({ ...prev, [k]: e.target.value }))}
                            className="w-28 h-9 px-2 border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-brand/40"
                            title="Optional — log an IBT / transfer document reference for this replenishment"
                            data-testid={`replen-transfer-ref-${idx}`}
                          />
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => markAsDone(r)}
                            disabled={savingKey === k}
                            className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 px-3 py-2 rounded-md whitespace-nowrap"
                            data-testid={`replen-mark-done-${idx}`}
                            title="Log the actual units replenished and remove this row from the open list"
                          >
                            <CheckCircle size={13} weight="fill" />
                            {savingKey === k ? "Saving…" : "Mark As Done"}
                          </button>
                        </td>
                      </tr>
                      {isOpen && hasBreakdown && (
                        <tr className="bg-emerald-50/40 border-t border-border/40" data-testid={`replen-size-row-${idx}`}>
                          <td colSpan={16} className="px-4 py-2.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[11px] font-semibold text-muted mr-1">Size mix:</span>
                              {r.size_breakdown.map((s, si) => (
                                <span key={si} className="inline-flex items-center gap-1 bg-white border border-emerald-200 text-emerald-900 text-[10.5px] font-semibold px-2 py-0.5 rounded-full">
                                  {s.size}: <b>{fmtNum(s.recommended_qty)}</b>
                                  <span className="text-muted font-normal">
                                    ({fmtNum(s.soh)} soh{s.size_share_pct != null ? ` · ${Number(s.size_share_pct).toFixed(0)}%` : ""})
                                  </span>
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
        </>)}

        {/* B2 — forward replenishment calendar: subcategory × week matrix. */}
        {viewMode === "calendar" && (
          <div data-testid="replen-calendar">
            {calLoading && <Loading label="Building the forward calendar…" />}
            {calError && <ErrorBox message={calError} />}
            {!calLoading && !calError && (
              !calMatrix ? (
                <Empty label="No upcoming replenishment needs in the next 8 weeks." />
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3 mb-3 text-[11px] text-muted">
                    <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-rose-500 inline-block" /> Critical</span>
                    <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-500 inline-block" /> High</span>
                    <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-300 inline-block" /> Medium</span>
                    <span className="ml-1">Cell shows the number of styles needing action that week.</span>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-border bg-white">
                    <table className="w-full min-w-max text-[12px]" data-testid="replen-calendar-table">
                      <thead className="bg-panel sticky top-0 z-10">
                        <tr className="text-left">
                          <th className="px-3 py-2.5 font-semibold sticky left-0 bg-panel z-20 whitespace-nowrap">Subcategory</th>
                          {calMatrix.buckets.map((b) => (
                            <th key={b.week_start} className="px-3 py-2.5 font-semibold text-center whitespace-nowrap">{b.week_label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {calMatrix.subcats.map((sc, ri) => (
                          <tr key={sc} className={`border-t border-border/50 ${ri % 2 === 0 ? "bg-white" : "bg-panel/30"}`}>
                            <td className="px-3 py-2.5 font-semibold sticky left-0 bg-inherit z-[5] whitespace-nowrap">{sc}</td>
                            {calMatrix.buckets.map((b) => {
                              const cell = calMatrix.map[sc]?.[b.week_start];
                              if (!cell || !cell.count) {
                                return <td key={b.week_start} className="px-3 py-2.5 text-center text-muted">·</td>;
                              }
                              const cls = cell.critical > 0
                                ? "bg-rose-500 text-white"
                                : cell.high > 0
                                  ? "bg-amber-500 text-white"
                                  : "bg-yellow-300 text-yellow-950";
                              const title = `${cell.count} style(s) · ${cell.critical} critical · ${cell.high} high · ${cell.medium} medium`;
                              return (
                                <td key={b.week_start} className="px-2 py-2 text-center">
                                  <span title={title} className={`inline-flex items-center justify-center min-w-[26px] font-bold px-2 py-0.5 rounded ${cls}`}>
                                    {cell.count}
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )
            )}
          </div>
        )}
      </div>

      {/* Per-user fulfilment rate — small focused summary. */}
      {isAdmin && fulfilmentByUser.length > 0 && (
        <div className="card-white p-4 sm:p-5" data-testid="replen-fulfilment-summary">
          <SectionTitle
            title={
              <span className="inline-flex items-center gap-2 text-[14px]">
                <CheckCircle size={16} weight="duotone" className="text-emerald-700" />
                Fulfilment rate by picker · last 30 days
              </span>
            }
            subtitle="Aggregate of every Mark As Done in the window — actual units replenished ÷ suggested. Use this to spot pickers who consistently under- or over-replenish."
          />
          <div className="overflow-x-auto rounded-lg border border-border bg-white max-w-2xl">
            <table className="w-full text-[12.5px]">
              <thead className="bg-panel">
                <tr className="text-left">
                  <SortableTh sortKey="user" sort={fulfilmentSort.sort} onSort={fulfilmentSort.toggleSort} className="px-3 py-2 font-semibold whitespace-nowrap">User</SortableTh>
                  <SortableTh sortKey="lines" sort={fulfilmentSort.sort} onSort={fulfilmentSort.toggleSort} numeric className="px-3 py-2 font-semibold whitespace-nowrap">Lines done</SortableTh>
                  <SortableTh sortKey="target" sort={fulfilmentSort.sort} onSort={fulfilmentSort.toggleSort} numeric className="px-3 py-2 font-semibold whitespace-nowrap">Suggested</SortableTh>
                  <SortableTh sortKey="actual" sort={fulfilmentSort.sort} onSort={fulfilmentSort.toggleSort} numeric className="px-3 py-2 font-semibold whitespace-nowrap">Replenished</SortableTh>
                  <SortableTh sortKey="rate" sort={fulfilmentSort.sort} onSort={fulfilmentSort.toggleSort} numeric className="px-3 py-2 font-semibold whitespace-nowrap">Fulfilment rate</SortableTh>
                </tr>
              </thead>
              <tbody>
                {fulfilmentSort.sortRows(fulfilmentByUser, {
                  user: (u) => u.user,
                  lines: (u) => Number(u.lines ?? 0),
                  target: (u) => Number(u.target ?? 0),
                  actual: (u) => Number(u.actual ?? 0),
                  rate: (u) => u.rate == null ? null : Number(u.rate),
                }).map((u, i) => (
                  <tr key={u.user} className={`border-t border-border/50 ${i % 2 === 0 ? "bg-white" : "bg-panel/30"}`} data-testid={`replen-fulfilment-row-${i}`}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="inline-flex items-center bg-emerald-100 text-emerald-900 text-[11px] font-bold px-2 py-0.5 rounded-full">
                        {u.user}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(u.lines)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(u.target)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">{fmtNum(u.actual)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {u.rate == null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <span className={`inline-flex items-center font-bold px-2 py-0.5 rounded-full ${
                          u.rate >= 100 ? "bg-emerald-100 text-emerald-900"
                            : u.rate >= 50 ? "bg-amber-100 text-amber-900"
                            : "bg-rose-100 text-rose-900"
                        }`}>
                          {u.rate.toFixed(1)}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Completed report (admin/owner). */}
      {isAdmin && (
        <div className="card-white p-5" data-testid="replen-completed-card">
          <SectionTitle
            title={
              <span className="inline-flex items-center gap-2">
                <CheckCircle size={16} weight="duotone" className="text-emerald-700" />
                Completed Replenishments · last 30 days
              </span>
            }
            subtitle="Audit trail of every line marked done — fulfilment % = actual replenished ÷ suggested. Stock after replenishment is sampled from the live store SOH at the moment Mark As Done was clicked."
            action={
              <button
                type="button"
                onClick={() => setCompletedRefresh((t) => t + 1)}
                className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand-deep border border-border hover:bg-panel px-2.5 py-1.5 rounded-md"
                data-testid="replen-completed-refresh"
              >
                <ArrowCounterClockwise size={12} weight="bold" /> Refresh
              </button>
            }
          />
          {completedLoading && <Loading label="Loading audit trail…" />}
          {!completedLoading && (completed.rows || []).length === 0 && (
            <Empty label="No completed replenishments in the last 30 days." />
          )}
          {!completedLoading && (completed.rows || []).length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table className="w-full min-w-max text-[12.5px]">
                <thead className="bg-panel sticky top-0">
                  <tr className="text-left">
                    <SortableTh sortKey="completed_at" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Completed at</SortableTh>
                    <SortableTh sortKey="completed_by" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">User</SortableTh>
                    <SortableTh sortKey="pos_location" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">POS Location</SortableTh>
                    <SortableTh sortKey="product_name" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold">Product</SortableTh>
                    <SortableTh sortKey="size" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Size</SortableTh>
                    <SortableTh sortKey="barcode" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Barcode</SortableTh>
                    <SortableTh sortKey="replenish" sort={completedSort.sort} onSort={completedSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Qty to replenish</SortableTh>
                    <SortableTh sortKey="actual" sort={completedSort.sort} onSort={completedSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Qty replenished</SortableTh>
                    <SortableTh sortKey="transfer_ref" sort={completedSort.sort} onSort={completedSort.toggleSort} className="px-3 py-2.5 font-semibold whitespace-nowrap">Transfer ref</SortableTh>
                    <SortableTh sortKey="fulfilment_pct" sort={completedSort.sort} onSort={completedSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Fulfilment %</SortableTh>
                    <SortableTh sortKey="soh_after" sort={completedSort.sort} onSort={completedSort.toggleSort} numeric className="px-3 py-2.5 font-semibold whitespace-nowrap">Qty after replenish</SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {completedSort.sortRows(completed.rows || [], {
                    completed_at: (r) => r.completed_at || "",
                    completed_by: (r) => r.owner || r.completed_by_name || "",
                    pos_location: (r) => r.pos_location || "",
                    product_name: (r) => r.product_name || "",
                    size: (r) => r.size || "",
                    barcode: (r) => r.barcode || "",
                    replenish: (r) => Number(r.replenish ?? 0),
                    actual: (r) => Number(r.actual_units_replenished ?? 0),
                    transfer_ref: (r) => r.transfer_ref || "",
                    fulfilment_pct: (r) => {
                      const t = Number(r.replenish ?? 0);
                      const a = Number(r.actual_units_replenished ?? 0);
                      return t > 0 ? (a / t) * 100 : null;
                    },
                    soh_after: (r) => r.soh_after == null ? null : Number(r.soh_after),
                  }).map((r) => (
                    <tr key={r.key} className="border-t border-border/50 hover:bg-panel/30">
                      <td className="px-3 py-2 text-[11px] tabular-nums">
                        {r.completed_at ? r.completed_at.replace("T", " ").slice(0, 16) : "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center bg-emerald-100 text-emerald-900 text-[11px] font-bold px-2 py-0.5 rounded-full">
                          {r.owner || r.completed_by_name || "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.pos_location}</td>
                      <td className="px-3 py-2 break-words" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{r.product_name}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.size || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-[11px]">{r.barcode}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.units_to_replenish)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">{fmtNum(r.actual_units_replenished)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.transfer_ref
                          ? <span className="inline-flex items-center bg-sky-100 text-sky-900 text-[11px] font-semibold px-2 py-0.5 rounded-full font-mono" data-testid={`completed-transfer-ref`}>{r.transfer_ref}</span>
                          : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.fulfilment_pct == null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <span className={`inline-flex items-center font-bold px-2 py-0.5 rounded-full ${
                            r.fulfilment_pct >= 100 ? "bg-emerald-100 text-emerald-900"
                              : r.fulfilment_pct >= 50 ? "bg-amber-100 text-amber-900"
                              : "bg-rose-100 text-rose-900"
                          }`}>{r.fulfilment_pct}%</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.soh_after == null ? <span className="text-muted">—</span> : fmtNum(r.soh_after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Replenishments;
