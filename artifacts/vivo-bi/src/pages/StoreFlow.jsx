import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import * as XLSX from "xlsx";
import { api, fmtNum } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle, Empty } from "@/components/common";
import { ArrowsClockwise, DownloadSimple, Storefront, Basket, Truck, Package, CalendarCheck, X } from "@phosphor-icons/react";

const COUNTRIES = ["", "Kenya", "Uganda", "Rwanda", "Online"];

const WH_OWNERS = {
  "Safari Sarit": "Mathew",
  "Capital Centre": "Mathew",
  "Garden City": "Elvin",
  "Mama Ngina": "Mathew",
  "Two Rivers": "Mathew",
  "Village Market": "Teddy",
  "Digo Road": "Emmah",
  "Moi Avenue": "Emmah",
  "City Mall": "Teddy",
  "Hub": "Christabel",
  "Kileleshwa": "Christabel",
  "Greenspan": "Mathew",
  "Signature": "Emmah",
  "T Mall": "Benard",
  "TRM": "Benard",
  "Galleria": "Christabel",
  "Junction": "Emmah",
  "Acacia": "Elvin",
  "Eldoret": "Benard",
  "Nakuru": "Benard",
  "Kisumu": "Elvin",
  "Kigali": "Benard",
  "Oasis": "Christabel",
  "Runda": "Elvin",
  "Sarit": "Teddy",
  "Imaara": "Teddy",
  "Meru": "Teddy",
  "Yaya": "Emmah",
  "Shop Zetu": "Elvin",
};
const WH_OWNER_KEYS = Object.keys(WH_OWNERS).sort((a, b) => b.length - a.length);
function whOwner(posLocation) {
  if (!posLocation) return "—";
  const loc = posLocation.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ");
  for (const key of WH_OWNER_KEYS) {
    if (loc.includes(key.toLowerCase())) return WH_OWNERS[key];
  }
  return "—";
}

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // index 0=Mon(1)…6=Sun(7)

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const isoDaysAgo = (n) => {
  const d = new Date(); d.setDate(d.getDate() - n); return isoDate(d);
};
function getLastWeekRange() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 0=Mon
  const thisMonday = new Date(d); thisMonday.setDate(d.getDate() - dow);
  const lastMonday = new Date(thisMonday); lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(lastMonday); lastSunday.setDate(lastMonday.getDate() + 6);
  return { from: isoDate(lastMonday), to: isoDate(lastSunday) };
}
function getThisWeekRange() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7;
  const thisMonday = new Date(d); thisMonday.setDate(d.getDate() - dow);
  return { from: isoDate(thisMonday), to: isoDate(d) };
}

/**
 * Transfer pacing: compare NET transferred (transferred − returned) to
 * prev_week_sold ±10%. Returns { status: "on_track"|"over"|"under"|"none", pct }
 */
function transferPacing(netTransferred, prevWeekSold) {
  if (!prevWeekSold) return { status: "none", pct: null };
  const pct = prevWeekSold > 0 ? (netTransferred / prevWeekSold) * 100 : null;
  if (pct === null) return { status: "none", pct: null };
  if (netTransferred > prevWeekSold * 1.10) return { status: "over", pct };
  if (netTransferred < prevWeekSold * 0.90) return { status: "under", pct };
  return { status: "on_track", pct };
}
const netXfr = (r) => (r.units_transferred || 0) - (r.units_returned || 0);

function SortTh({ sk, cur, dir, onSort, className = "", title, children }) {
  const active = cur === sk;
  const arrow = active ? (dir === "asc" ? " ▲" : " ▼") : " ⇅";
  return (
    <th
      className={`${className} cursor-pointer select-none hover:text-slate-700`}
      title={title}
      onClick={() => onSort(sk)}
    >
      <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
        {children}
        <span className={`text-[9px] ${active ? "text-slate-700" : "text-slate-300"}`}>{arrow}</span>
      </span>
    </th>
  );
}

function WocDelta({ delta }) {
  if (delta == null) return <span className="text-slate-300">—</span>;
  const abs = Math.abs(delta).toFixed(1);
  if (delta > 0.2)
    return <span className="inline-flex items-center gap-0.5 text-[12px] font-medium text-amber-600" title="Cover increasing — slower sales or more stock">↑ {abs}w</span>;
  if (delta < -0.2)
    return <span className="inline-flex items-center gap-0.5 text-[12px] font-medium text-emerald-600" title="Cover decreasing — faster sales">↓ {abs}w</span>;
  return <span className="text-[12px] text-slate-400">→ stable</span>;
}

function PacingBadge({ netTransferred, prevWeekSold }) {
  const { status, pct } = transferPacing(netTransferred, prevWeekSold);
  if (status === "none") return <span className="text-slate-300">—</span>;
  const pctStr = pct != null ? `${pct.toFixed(0)}%` : "";
  if (status === "over")
    return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-100 text-red-700 ring-1 ring-inset ring-red-200 whitespace-nowrap">Over · {pctStr}</span>;
  if (status === "under")
    return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700 ring-1 ring-inset ring-amber-200 whitespace-nowrap">Under · {pctStr}</span>;
  return <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200 whitespace-nowrap">On track · {pctStr}</span>;
}

const StoreFlow = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dateFrom, setDateFrom] = useState(() => getThisWeekRange().from);
  const [dateTo, setDateTo] = useState(() => getThisWeekRange().to);
  const [country, setCountry] = useState("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("pos_location");
  const [sortDir, setSortDir] = useState("asc");

  const handleSort = (key) => {
    setSortKey(key);
    setSortDir((d) => (sortKey === key ? (d === "asc" ? "desc" : "asc") : "desc"));
  };

  const load = (forceFresh = false) => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = { date_from: dateFrom, date_to: dateTo };
    if (country) params.country = country;
    api
      .get("/analytics/store-flow", { params, timeout: 240000, forceFresh })
      .then(({ data }) => { if (!cancelled) setData(data); })
      .catch((e) => {
        if (!cancelled) setError(e?.response?.data?.detail || e.message || "Failed to load store flow");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  };

  useEffect(() => {
    const cancel = load();
    return cancel;
    // eslint-disable-next-line
  }, [dateFrom, dateTo, country]);

  const rows = data?.rows || [];
  const totals = data?.totals || {};
  const prevWeekLabel = data?.prev_week_label;
  const historyFrom = data?.transfer_history_from;
  const historyGap = historyFrom && dateFrom < historyFrom;

  const EXCLUDED_LOCATIONS = new Set(["MarKT/Stock", "Retired Stock"]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = rows
      .filter((r) => !EXCLUDED_LOCATIONS.has(r.pos_location))
      .filter((r) => !q || (r.pos_location || "").toLowerCase().includes(q));
    return [...base].sort((a, b) => {
      let av, bv;
      if (sortKey === "pos_location") { av = a.pos_location || ""; bv = b.pos_location || ""; }
      else if (sortKey === "avg_4w")  { av = Math.round((a.units_4w || 0) / 4); bv = Math.round((b.units_4w || 0) / 4); }
      else if (sortKey === "prev_week_sold") { av = a.prev_week_sold || 0; bv = b.prev_week_sold || 0; }
      else if (sortKey === "units_transferred") { av = a.units_transferred || 0; bv = b.units_transferred || 0; }
      else if (sortKey === "units_returned")   { av = a.units_returned || 0; bv = b.units_returned || 0; }
      else if (sortKey === "pacing_pct") {
        av = a.prev_week_sold > 0 ? netXfr(a) / a.prev_week_sold : -1;
        bv = b.prev_week_sold > 0 ? netXfr(b) / b.prev_week_sold : -1;
      }
      else if (sortKey === "woc") { av = a.woc ?? -1; bv = b.woc ?? -1; }
      else if (sortKey === "current_stock") { av = a.current_stock || 0; bv = b.current_stock || 0; }
      else { av = 0; bv = 0; }
      if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [rows, search, sortKey, sortDir]);

  const [wocSortKey, setWocSortKey] = useState("current_stock");
  const [wocSortDir, setWocSortDir] = useState("desc");
  const handleWocSort = (key) => {
    setWocSortKey(key);
    setWocSortDir((d) => (wocSortKey === key ? (d === "asc" ? "desc" : "asc") : "desc"));
  };

  const WOC_TARGET = 8, WOC_LO = 7, WOC_HI = 9;

  // WOC rows — sortable
  const wocRows = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av, bv;
      if (wocSortKey === "pos_location")   { av = a.pos_location || ""; bv = b.pos_location || ""; }
      else if (wocSortKey === "current_stock") { av = a.current_stock || 0; bv = b.current_stock || 0; }
      else if (wocSortKey === "units_4w")  { av = a.units_4w || 0; bv = b.units_4w || 0; }
      else if (wocSortKey === "weekly_rate") { av = a.units_4w ? a.units_4w / 4 : 0; bv = b.units_4w ? b.units_4w / 4 : 0; }
      else if (wocSortKey === "woc")       { av = a.woc ?? -1; bv = b.woc ?? -1; }
      else if (wocSortKey === "woc_4w_ago") { av = a.woc_4w_ago ?? -1; bv = b.woc_4w_ago ?? -1; }
      else if (wocSortKey === "woc_delta") {
        av = (a.woc != null && a.woc_4w_ago != null) ? a.woc - a.woc_4w_ago : -999;
        bv = (b.woc != null && b.woc_4w_ago != null) ? b.woc - b.woc_4w_ago : -999;
      }
      else { av = 0; bv = 0; }
      if (typeof av === "string") return wocSortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return wocSortDir === "asc" ? av - bv : bv - av;
    });
  }, [filtered, wocSortKey, wocSortDir]);
  const wocBand = (w) => w == null ? "none" : w < WOC_LO ? "under" : w > WOC_HI ? "over" : "ok";
  const wocColor = (w) => {
    const b = wocBand(w);
    if (b === "under") return "text-red-600 font-semibold";
    if (b === "over")  return "text-amber-600 font-semibold";
    if (b === "ok")    return "text-emerald-700 font-semibold";
    return "text-slate-400";
  };
  const wocCta = (w) => {
    const b = wocBand(w);
    if (b === "under") return { label: "Replenish", cls: "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-100 text-red-700 ring-1 ring-inset ring-red-200" };
    if (b === "over")  return { label: "Reduce stock", cls: "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-100 text-amber-700 ring-1 ring-inset ring-amber-200" };
    if (b === "ok")    return { label: "On target", cls: "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200" };
    return null;
  };
  const wocSummary = useMemo(() => {
    const counts = { under: 0, ok: 0, over: 0, none: 0 };
    for (const r of wocRows) counts[wocBand(r.woc)]++;
    return counts;
    // eslint-disable-next-line
  }, [wocRows]);
  const totalWoc = useMemo(() => {
    const soh = wocRows.reduce((a, r) => a + r.current_stock, 0);
    const weekly = wocRows.reduce((a, r) => a + (r.units_4w || 0), 0) / 4;
    return weekly > 0 ? Math.round((soh / weekly) * 10) / 10 : null;
  }, [wocRows]);

  // Quick date presets
  const PRESETS = [
    { label: "This week", apply: () => { const r = getThisWeekRange(); setDateFrom(r.from); setDateTo(r.to); } },
    { label: "Last week", apply: () => { const r = getLastWeekRange(); setDateFrom(r.from); setDateTo(r.to); } },
    { label: "30d", apply: () => { setDateFrom(isoDaysAgo(30)); setDateTo(isoDaysAgo(0)); } },
    { label: "90d", apply: () => { setDateFrom(isoDaysAgo(90)); setDateTo(isoDaysAgo(0)); } },
  ];

  const _buildReportRows = () =>
    filtered.map((r) => {
      const dt = r.daily_transfers || {};
      const pctVal = r.prev_week_sold > 0 ? +((netXfr(r) / r.prev_week_sold) * 100).toFixed(1) : null;
      return {
        "POS Location": r.pos_location,
        "WH Owner": whOwner(r.pos_location),
        "Avg Weekly (4W)": Math.round((r.units_4w || 0) / 4),
        "Prev Week Sales": r.prev_week_sold,
        "Mon": dt[1] || 0,
        "Tue": dt[2] || 0,
        "Wed": dt[3] || 0,
        "Thu": dt[4] || 0,
        "Fri": dt[5] || 0,
        "Sat": dt[6] || 0,
        "Sun": dt[7] || 0,
        "Total Transferred": r.units_transferred,
        "Total Returned": r.units_returned || 0,
        "Net Transferred": netXfr(r),
        "vs Prev Week % (net)": pctVal != null ? pctVal / 100 : null,
        "Status": pctVal == null ? "—" : pctVal > 110 ? "Over" : pctVal < 90 ? "Under" : "On track",
        "WOC (weeks)": r.woc != null ? +r.woc.toFixed(1) : null,
        "Current Stock": r.current_stock,
      };
    });

  const exportCsv = () => {
    const rows = _buildReportRows();
    if (!rows.length) return;
    const header = Object.keys(rows[0]);
    const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h])).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `store-flow-${dateFrom}-to-${dateTo}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const _buildWocRows = () =>
    wocRows.map((r) => {
      const delta = r.woc != null && r.woc_4w_ago != null ? +(r.woc - r.woc_4w_ago).toFixed(1) : null;
      return {
        "POS Location": r.pos_location,
        "WH Owner": whOwner(r.pos_location),
        "SOH": r.current_stock,
        "Units Sold (4W)": r.units_4w || 0,
        "Weekly Rate": r.units_4w ? Math.round(r.units_4w / 4) : null,
        "WOC Now (weeks)": r.woc != null ? +r.woc.toFixed(1) : null,
        "WOC 4W Ago (weeks)": r.woc_4w_ago != null ? +r.woc_4w_ago.toFixed(1) : null,
        "Trend (Δ weeks)": delta,
        "Action": r.woc == null ? "—" : r.woc < WOC_LO ? "Replenish" : r.woc > WOC_HI ? "Reduce stock" : "On target",
      };
    });

  const exportWocCsv = () => {
    const rows = _buildWocRows();
    if (!rows.length) return;
    const header = Object.keys(rows[0]);
    const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h])).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `store-flow-woc-${dateFrom}-to-${dateTo}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const exportExcel = () => {
    const rows = _buildReportRows();
    if (!rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    // Format "vs Prev Week %" column as percentage
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
    const pctColIdx = Object.keys(rows[0]).indexOf("vs Prev Week % (net)");
    for (let rowIdx = range.s.r + 1; rowIdx <= range.e.r; rowIdx++) {
      const cell = ws[XLSX.utils.encode_cell({ r: rowIdx, c: pctColIdx })];
      if (cell && cell.v != null) cell.z = "0.0%";
    }
    ws["!cols"] = [
      { wch: 28 }, { wch: 16 }, { wch: 16 },
      { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 },
      { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 14 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Stock Movement");
    // WOC sheet
    const wocWs = XLSX.utils.json_to_sheet(_buildWocRows());
    wocWs["!cols"] = [{ wch: 28 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wocWs, "Stock Cover (WOC)");
    // Summary sheet
    const meta = [
      { Field: "Period (transfers)", Value: `${dateFrom} → ${dateTo}` },
      { Field: "Prev Week Sales", Value: prevWeekLabel || "" },
      { Field: "Stores", Value: filtered.length },
      { Field: "Total Prev Week Sales", Value: filtered.reduce((a, r) => a + (r.prev_week_sold || 0), 0) },
      { Field: "Total Avg Weekly (4W)", Value: Math.round(filtered.reduce((a, r) => a + (r.units_4w || 0), 0) / 4) },
      { Field: "Total Transferred", Value: filtered.reduce((a, r) => a + r.units_transferred, 0) },
      { Field: "Total Returned", Value: filtered.reduce((a, r) => a + (r.units_returned || 0), 0) },
      { Field: "Total Current Stock", Value: filtered.reduce((a, r) => a + r.current_stock, 0) },
      { Field: "WOC — Stores under target", Value: wocSummary.under },
      { Field: "WOC — Stores on target", Value: wocSummary.ok },
      { Field: "WOC — Stores over target", Value: wocSummary.over },
      { Field: "Network WOC", Value: totalWoc != null ? +totalWoc.toFixed(1) : null },
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(meta), "Summary");
    XLSX.writeFile(wb, `store-flow-${dateFrom}-to-${dateTo}.xlsx`);
  };

  // ── Daily transfer drill-down ──
  const [drill, setDrill] = useState(null); // { dow, posLocation, cellQty }
  const [drillData, setDrillData] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState(null);

  const openDrill = (dow, posLocation, cellQty) => {
    setDrill({ dow, posLocation, cellQty });
    setDrillData(null);
    setDrillError(null);
    setDrillLoading(true);
    const params = { date_from: dateFrom, date_to: dateTo, dow };
    if (posLocation) params.pos_location = posLocation;
    if (country) params.country = country;
    api
      .get("/analytics/store-flow/day-transfers", { params, timeout: 120000 })
      .then(({ data }) => setDrillData(data))
      .catch((e) => setDrillError(e?.response?.data?.detail || e.message || "Failed to load transfer details"))
      .finally(() => setDrillLoading(false));
  };
  const closeDrill = () => { setDrill(null); setDrillData(null); setDrillError(null); };

  useEffect(() => {
    if (!drill) return;
    const onKey = (e) => { if (e.key === "Escape") closeDrill(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drill]);

  const exportDrillCsv = () => {
    const items = drillData?.items || [];
    if (!items.length) return;
    const rows = items.map((it) => ({
      "Product Name": it.product_name,
      "Barcode": it.barcode,
      "SKU": it.sku,
      "Size": it.size,
      "Category": it.category,
      "Sub-category": it.sub_category,
      "Store": it.pos_location,
      "Date": it.transfer_date,
      "Quantity": it.quantity,
    }));
    const header = Object.keys(rows[0]);
    const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h])).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const locSlug = drill?.posLocation ? drill.posLocation.replace(/[^a-z0-9]+/gi, "-").toLowerCase() : "all-stores";
    a.href = url; a.download = `transfers-${locSlug}-${DOW_LABELS[(drill?.dow || 1) - 1]}-${dateFrom}-to-${dateTo}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // Totals for the daily footer
  const dailyTotals = useMemo(() => {
    const t = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
    for (const r of filtered) {
      const dt = r.daily_transfers || {};
      for (let d = 1; d <= 7; d++) t[d] += dt[d] || 0;
    }
    return t;
  }, [filtered]);

  return (
    <div className="space-y-5" data-testid="store-flow">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <SectionTitle
          title="Stock Movement"
          subtitle="Per store: previous week sales vs daily transfers. Target: net transferred (transferred − returned) within ±10% of the previous week's sales. Click a daily number to see the products transferred."
        />
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => load(true)}
            data-testid="button-refresh"
          >
            <ArrowsClockwise size={15} /> Refresh
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            onClick={exportCsv}
            disabled={!filtered.length}
            data-testid="button-export-csv"
          >
            <DownloadSimple size={15} /> Export CSV
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-[#1a5c38] bg-[#1a5c38] text-white px-3 py-1.5 text-sm font-medium hover:bg-[#0f3d24] disabled:opacity-40"
            onClick={exportExcel}
            disabled={!filtered.length}
            data-testid="button-export-excel"
          >
            <DownloadSimple size={15} /> Export Excel
          </button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="card-white p-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-600">
          From{" "}
          <input type="date" className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} data-testid="input-date-from" />
        </label>
        <label className="text-sm text-slate-600">
          To{" "}
          <input type="date" className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} data-testid="input-date-to" />
        </label>
        <div className="flex items-center gap-1">
          {PRESETS.map(({ label, apply }) => (
            <button key={label} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50" onClick={apply}>
              {label}
            </button>
          ))}
        </div>
        <label className="text-sm text-slate-600">
          Country{" "}
          <select className="ml-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={country} onChange={(e) => setCountry(e.target.value)} data-testid="select-country">
            {COUNTRIES.map((c) => <option key={c || "all"} value={c}>{c || "All countries"}</option>)}
          </select>
        </label>
        <input
          className="flex-1 min-w-[180px] rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          placeholder="Search store…" value={search} onChange={(e) => setSearch(e.target.value)}
          data-testid="input-search"
        />
      </div>

      {historyGap && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800" data-testid="banner-history-gap">
          Transfer tracking started on <strong>{historyFrom}</strong> — transfers before that date are not captured.
        </div>
      )}

      {loading ? (
        <Loading label="Computing store flow…" />
      ) : error ? (
        <ErrorBox message={error} />
      ) : (
        <>
          {/* ── Summary cards ── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide">
                <CalendarCheck size={14} /> Prev Week Sales
              </div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-prev-week-sold">
                {fmtNum(totals.prev_week_sold || 0)}
              </div>
              {prevWeekLabel && <div className="mt-0.5 text-[11px] text-slate-400">{prevWeekLabel}</div>}
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide">
                <Basket size={14} /> Avg Weekly Sales (4W)
              </div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-avg-weekly">
                {fmtNum(Math.round(filtered.reduce((a, r) => a + (r.units_4w || 0), 0) / 4))}
              </div>
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide">
                <Truck size={14} /> Units Transferred
              </div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-units-transferred">
                {fmtNum(totals.units_transferred || 0)}
              </div>
            </div>
            <div className="card-white p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide">
                <Package size={14} /> Current Stock
              </div>
              <div className="mt-1 text-2xl font-semibold text-slate-800" data-testid="text-current-stock">
                {fmtNum(totals.current_stock || 0)}
              </div>
            </div>
          </div>

          {/* ── By POS Location table ── */}
          <div className="card-white p-5">
            <SectionTitle
              title="By POS Location"
              subtitle={`${fmtNum(filtered.length)} stores · transfers ${dateFrom} → ${dateTo}${prevWeekLabel ? ` · prev week sales ${prevWeekLabel}` : ""}`}
            />
            {!filtered.length ? (
              <Empty label="No stores match the selected filters." />
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                      <SortTh sk="pos_location" cur={sortKey} dir={sortDir} onSort={handleSort}
                        className="py-2 pr-3 sticky left-0 bg-white z-10">
                        <span className="inline-flex items-center gap-1"><Storefront size={13} /> POS Location</span>
                      </SortTh>
                      <th className="py-2 pr-3 whitespace-nowrap">WH Owner</th>
                      {/* Benchmark columns — Avg 4W first */}
                      <SortTh sk="avg_4w" cur={sortKey} dir={sortDir} onSort={handleSort}
                        className="py-2 pr-3 text-right text-indigo-600 whitespace-nowrap"
                        title="Average weekly units sold over the last 4 weeks">
                        Avg 4W ⓘ
                      </SortTh>
                      <SortTh sk="prev_week_sold" cur={sortKey} dir={sortDir} onSort={handleSort}
                        className="py-2 pr-3 text-right text-indigo-600 whitespace-nowrap"
                        title={prevWeekLabel ? `Sales ${prevWeekLabel}` : "Previous Mon–Sun sales"}>
                        Prev Week Sales ⓘ
                      </SortTh>
                      {/* Daily transfer columns Mon–Sun (not individually sortable) */}
                      {DOW_LABELS.map((d) => (
                        <th key={d} className="py-2 pr-2 text-right text-slate-400 font-medium text-[11px]">{d}</th>
                      ))}
                      {/* Totals + pacing */}
                      <SortTh sk="units_transferred" cur={sortKey} dir={sortDir} onSort={handleSort}
                        className="py-2 pr-3 text-right font-semibold">
                        Total Transferred
                      </SortTh>
                      <SortTh sk="units_returned" cur={sortKey} dir={sortDir} onSort={handleSort}
                        className="py-2 pr-3 text-right font-semibold whitespace-nowrap"
                        title="Units returned from this store to the warehouse (WHREC) in the selected period">
                        Total Returned
                      </SortTh>
                      <SortTh sk="pacing_pct" cur={sortKey} dir={sortDir} onSort={handleSort}
                        className="py-2 pr-3 text-right whitespace-nowrap"
                        title="Net transferred (transferred − returned) vs previous week sales. On track = ±10%. Over = >10% above. Under = >10% below.">
                        vs Prev Week ⓘ
                      </SortTh>
                      <SortTh sk="woc" cur={sortKey} dir={sortDir} onSort={handleSort}
                        className="py-2 pr-3 text-right whitespace-nowrap"
                        title={`Weeks of cover: current stock ÷ 4-week weekly rate. Target ${WOC_TARGET}w ±1. Red <${WOC_LO}w, Green ${WOC_LO}–${WOC_HI}w, Amber >${WOC_HI}w.`}>
                        WOC ⓘ
                      </SortTh>
                      <SortTh sk="current_stock" cur={sortKey} dir={sortDir} onSort={handleSort}
                        className="py-2 pr-3 text-right">
                        Current Stock
                      </SortTh>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => {
                      const dt = r.daily_transfers || {};
                      return (
                        <tr key={r.pos_location} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`row-store-${r.pos_location}`}>
                          <td className="py-1.5 pr-3 font-medium text-slate-700 whitespace-nowrap sticky left-0 bg-white">{r.pos_location}</td>
                          <td className="py-1.5 pr-3 text-slate-600 whitespace-nowrap">{whOwner(r.pos_location)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-indigo-500">{r.units_4w ? fmtNum(Math.round(r.units_4w / 4)) : "—"}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums text-indigo-700 font-medium">{fmtNum(r.prev_week_sold)}</td>
                          {[1, 2, 3, 4, 5, 6, 7].map((dow) => (
                            <td key={dow} className="py-1.5 pr-2 text-right tabular-nums text-[12px]">
                              {dt[dow] ? (
                                <button
                                  className="text-slate-700 underline decoration-dotted decoration-slate-300 underline-offset-2 hover:text-[#1a5c38] hover:decoration-[#1a5c38]"
                                  title={`View products transferred to ${r.pos_location} on ${DOW_LABELS[dow - 1]}`}
                                  onClick={() => openDrill(dow, r.pos_location, dt[dow])}
                                  data-testid={`cell-daily-${r.pos_location}-${dow}`}
                                >
                                  {fmtNum(dt[dow])}
                                </button>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                          ))}
                          <td className="py-1.5 pr-3 text-right tabular-nums font-medium">{fmtNum(r.units_transferred)}</td>
                          <td className="py-1.5 pr-3 text-right tabular-nums font-medium text-rose-600">
                            {r.units_returned ? fmtNum(r.units_returned) : "—"}
                          </td>
                          <td className="py-1.5 pr-3 text-right">
                            <PacingBadge netTransferred={netXfr(r)} prevWeekSold={r.prev_week_sold} />
                          </td>
                          <td className={"py-1.5 pr-3 text-right tabular-nums " + wocColor(r.woc)}>
                            {r.woc == null ? "—" : r.woc.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums">{fmtNum(r.current_stock)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-300 font-semibold text-slate-800">
                      <td className="py-2 pr-3 sticky left-0 bg-white">Total</td>
                      <td className="py-2 pr-3" />
                      <td className="py-2 pr-3 text-right tabular-nums text-indigo-500">
                        {fmtNum(Math.round(filtered.reduce((a, r) => a + (r.units_4w || 0), 0) / 4))}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-indigo-700">
                        {fmtNum(filtered.reduce((a, r) => a + (r.prev_week_sold || 0), 0))}
                      </td>
                      {[1, 2, 3, 4, 5, 6, 7].map((dow) => (
                        <td key={dow} className="py-2 pr-2 text-right tabular-nums text-[12px]">
                          {dailyTotals[dow] ? (
                            <button
                              className="text-slate-700 underline decoration-dotted decoration-slate-300 underline-offset-2 hover:text-[#1a5c38] hover:decoration-[#1a5c38] font-semibold"
                              title={`View all products transferred on ${DOW_LABELS[dow - 1]}`}
                              onClick={() => openDrill(dow, null, dailyTotals[dow])}
                              data-testid={`cell-daily-total-${dow}`}
                            >
                              {fmtNum(dailyTotals[dow])}
                            </button>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                      ))}
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {fmtNum(filtered.reduce((a, r) => a + r.units_transferred, 0))}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-rose-600">
                        {fmtNum(filtered.reduce((a, r) => a + (r.units_returned || 0), 0)) || "—"}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <PacingBadge
                          netTransferred={filtered.reduce((a, r) => a + netXfr(r), 0)}
                          prevWeekSold={filtered.reduce((a, r) => a + (r.prev_week_sold || 0), 0)}
                        />
                      </td>
                      <td className="py-2 pr-3" />
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {fmtNum(filtered.reduce((a, r) => a + r.current_stock, 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* ── Stock Cover (WOC) table ── */}
          <div className="card-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <SectionTitle
                title="Stock Cover (WOC)"
                subtitle={`Per store: stock on hand vs weeks of cover, using average weekly sales over the last 4 weeks. Target = ${WOC_TARGET}w ±1 (${WOC_LO}–${WOC_HI}w). Below ${WOC_LO}w = under-stocked → replenish. Above ${WOC_HI}w = over-stocked → redistribute or return.`}
              />
              <div className="flex items-center gap-2 shrink-0">
                <button
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                  onClick={exportWocCsv}
                  disabled={!wocRows.length}
                  data-testid="button-export-woc-csv"
                >
                  <DownloadSimple size={15} /> Export CSV
                </button>
                <button
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#1a5c38] bg-[#1a5c38] text-white px-3 py-1.5 text-sm font-medium hover:bg-[#0f3d24] disabled:opacity-40"
                  onClick={exportExcel}
                  disabled={!wocRows.length}
                  data-testid="button-export-woc-excel"
                >
                  <DownloadSimple size={15} /> Export Excel
                </button>
              </div>
            </div>
            {!filtered.length ? (
              <Empty label="No stores match the selected filters." />
            ) : (
              <>
                <div className="mt-3 flex flex-wrap gap-2" data-testid="woc-summary-strip">
                  {wocSummary.under > 0 && (
                    <div className="flex items-center gap-1.5 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                      <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                      <span className="text-[12px] font-semibold text-red-700">{wocSummary.under} store{wocSummary.under !== 1 ? "s" : ""} under {WOC_LO}w</span>
                      <span className="text-[11px] text-red-500 ml-1">— replenish</span>
                    </div>
                  )}
                  {wocSummary.ok > 0 && (
                    <div className="flex items-center gap-1.5 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                      <span className="text-[12px] font-semibold text-emerald-700">{wocSummary.ok} store{wocSummary.ok !== 1 ? "s" : ""} on target</span>
                      <span className="text-[11px] text-emerald-500 ml-1">({WOC_LO}–{WOC_HI}w)</span>
                    </div>
                  )}
                  {wocSummary.over > 0 && (
                    <div className="flex items-center gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                      <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                      <span className="text-[12px] font-semibold text-amber-700">{wocSummary.over} store{wocSummary.over !== 1 ? "s" : ""} over {WOC_HI}w</span>
                      <span className="text-[11px] text-amber-500 ml-1">— reduce stock</span>
                    </div>
                  )}
                </div>
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                        <SortTh sk="pos_location" cur={wocSortKey} dir={wocSortDir} onSort={handleWocSort}
                          className="py-2 pr-4">
                          <span className="inline-flex items-center gap-1"><Storefront size={13} /> POS Location</span>
                        </SortTh>
                        <th className="py-2 pr-4 whitespace-nowrap">WH Owner</th>
                        <SortTh sk="current_stock" cur={wocSortKey} dir={wocSortDir} onSort={handleWocSort}
                          className="py-2 pr-4 text-right">SOH</SortTh>
                        <SortTh sk="units_4w" cur={wocSortKey} dir={wocSortDir} onSort={handleWocSort}
                          className="py-2 pr-4 text-right">Units Sold (4W)</SortTh>
                        <SortTh sk="weekly_rate" cur={wocSortKey} dir={wocSortDir} onSort={handleWocSort}
                          className="py-2 pr-4 text-right">Weekly Rate</SortTh>
                        <SortTh sk="woc" cur={wocSortKey} dir={wocSortDir} onSort={handleWocSort}
                          className="py-2 pr-4 text-right"
                          title={`Current WOC. Target ${WOC_TARGET}w ±1. Red <${WOC_LO}w, Green ${WOC_LO}–${WOC_HI}w, Amber >${WOC_HI}w.`}>
                          WOC Now ⓘ
                        </SortTh>
                        <SortTh sk="woc_4w_ago" cur={wocSortKey} dir={wocSortDir} onSort={handleWocSort}
                          className="py-2 pr-4 text-right"
                          title="Estimated WOC 4 weeks ago, based on SOH + units sold since then, at the prior 4-week sell rate.">
                          WOC 4W Ago ⓘ
                        </SortTh>
                        <SortTh sk="woc_delta" cur={wocSortKey} dir={wocSortDir} onSort={handleWocSort}
                          className="py-2 pr-4 text-right"
                          title="Change in weeks of cover vs 4 weeks ago. Positive = cover increased (slower sales or more stock). Negative = cover decreased (faster sales or less stock).">
                          Trend ⓘ
                        </SortTh>
                        <th className="py-2 pr-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {wocRows.map((r) => {
                        const cta = wocCta(r.woc);
                        const delta = r.woc != null && r.woc_4w_ago != null ? +(r.woc - r.woc_4w_ago).toFixed(1) : null;
                        return (
                          <tr key={r.pos_location} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`row-woc-${r.pos_location}`}>
                            <td className="py-1.5 pr-4 font-medium text-slate-700 whitespace-nowrap">{r.pos_location}</td>
                            <td className="py-1.5 pr-4 text-slate-600 whitespace-nowrap">{whOwner(r.pos_location)}</td>
                            <td className="py-1.5 pr-4 text-right tabular-nums">{fmtNum(r.current_stock)}</td>
                            <td className="py-1.5 pr-4 text-right tabular-nums">{fmtNum(r.units_4w || 0)}</td>
                            <td className="py-1.5 pr-4 text-right tabular-nums">{r.units_4w ? fmtNum(Math.round(r.units_4w / 4)) : "—"}</td>
                            <td className={"py-1.5 pr-4 text-right tabular-nums font-semibold " + wocColor(r.woc)}>
                              {r.woc == null ? "—" : r.woc.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                            </td>
                            <td className={"py-1.5 pr-4 text-right tabular-nums " + wocColor(r.woc_4w_ago)}>
                              {r.woc_4w_ago == null ? "—" : r.woc_4w_ago.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                            </td>
                            <td className="py-1.5 pr-4 text-right tabular-nums">
                              <WocDelta delta={delta} />
                            </td>
                            <td className="py-1.5 pr-4 text-right">
                              {cta ? <span className={cta.cls}>{cta.label}</span> : <span className="text-slate-300">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-300 font-semibold text-slate-800">
                        <td className="py-2 pr-4">Total</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{fmtNum(wocRows.reduce((a, r) => a + r.current_stock, 0))}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{fmtNum(wocRows.reduce((a, r) => a + (r.units_4w || 0), 0))}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{fmtNum(Math.round(wocRows.reduce((a, r) => a + (r.units_4w || 0), 0) / 4))}</td>
                        <td className={"py-2 pr-4 text-right tabular-nums " + wocColor(totalWoc)}>
                          {totalWoc == null ? "—" : totalWoc.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                        </td>
                        <td className="py-2 pr-4" />
                        <td className="py-2 pr-4" />
                        <td className="py-2 pr-4 text-right">
                          {(() => { const cta = wocCta(totalWoc); return cta ? <span className={cta.cls}>{cta.label}</span> : null; })()}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* ── Daily transfer drill-down modal (portaled to body) ── */}
      {drill && createPortal(
        <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4" data-testid="modal-day-transfers">
          <div className="absolute inset-0 bg-slate-900/50" onClick={closeDrill} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div>
                <div className="text-base font-semibold text-slate-800">
                  Transfers · {DOW_LABELS[drill.dow - 1]} · {drill.posLocation || "All stores"}
                </div>
                <div className="text-[12px] text-slate-500 mt-0.5">
                  {DOW_LABELS[drill.dow - 1]}s within {dateFrom} → {dateTo}
                  {drillData != null && <> · <span className="font-medium text-slate-700">{fmtNum(drillData.total_quantity || 0)} units</span></>}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                  onClick={exportDrillCsv}
                  disabled={!drillData?.items?.length}
                  data-testid="button-export-drill-csv"
                >
                  <DownloadSimple size={15} /> Export CSV
                </button>
                <button
                  className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
                  onClick={closeDrill}
                  data-testid="button-close-drill"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="overflow-auto px-5 py-4">
              {drillLoading ? (
                <Loading label="Loading transfer details…" />
              ) : drillError ? (
                <ErrorBox message={drillError} />
              ) : !drillData?.items?.length ? (
                <Empty label="No transfer line items found for this day." />
              ) : (
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
                      <th className="py-2 pr-3">Product Name</th>
                      <th className="py-2 pr-3 whitespace-nowrap">Barcode</th>
                      <th className="py-2 pr-3 whitespace-nowrap">SKU</th>
                      <th className="py-2 pr-3">Size</th>
                      <th className="py-2 pr-3">Category</th>
                      <th className="py-2 pr-3">Sub-category</th>
                      {!drill.posLocation && <th className="py-2 pr-3 whitespace-nowrap">Store</th>}
                      <th className="py-2 pr-3 whitespace-nowrap">Date</th>
                      <th className="py-2 pr-0 text-right">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillData.items.map((it, i) => (
                      <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="py-1.5 pr-3 text-slate-700">{it.product_name || "—"}</td>
                        <td className="py-1.5 pr-3 text-slate-600 tabular-nums whitespace-nowrap">{it.barcode || "—"}</td>
                        <td className="py-1.5 pr-3 text-slate-600 whitespace-nowrap">{it.sku || "—"}</td>
                        <td className="py-1.5 pr-3 text-slate-600">{it.size || "—"}</td>
                        <td className="py-1.5 pr-3 text-slate-600">{it.category || "—"}</td>
                        <td className="py-1.5 pr-3 text-slate-600">{it.sub_category || "—"}</td>
                        {!drill.posLocation && <td className="py-1.5 pr-3 text-slate-600 whitespace-nowrap">{it.pos_location}</td>}
                        <td className="py-1.5 pr-3 text-slate-600 whitespace-nowrap">{it.transfer_date}</td>
                        <td className="py-1.5 pr-0 text-right tabular-nums font-medium">{fmtNum(it.quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-300 font-semibold text-slate-800">
                      <td className="py-2 pr-3" colSpan={drill.posLocation ? 7 : 8}>Total</td>
                      <td className="py-2 pr-0 text-right tabular-nums" data-testid="text-drill-total">
                        {fmtNum(drillData.total_quantity || 0)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default StoreFlow;
