import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { toast } from "sonner";
import { Loading, ErrorBox, Empty } from "@/components/common";
import {
  ArrowsClockwise, CaretDown, CaretRight, Truck, Check, CheckCircle,
  DownloadSimple,
} from "@phosphor-icons/react";

// The "All" view anchors the range well before any marked-done row can exist, so
// EVERY done item lands in the report by default (not just a recent window). The
// trailing-N-day presets just narrow the window when an operator wants a period.
const ALL_FROM = "2020-01-01";
const RANGE_PRESETS = [
  { label: "All", from: ALL_FROM },
  { label: "30d", days: 30 },
  { label: "60d", days: 60 },
  { label: "90d", days: 90 },
];

// Local (EAT-ish) YYYY-MM-DD — formatted in local time so the default range does
// not shift by a day around midnight in East Africa (UTC+3).
const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const todayYmd = () => ymd(new Date());
const daysAgoYmd = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
};

const fmtDoneAt = (s) => {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("en-GB", {
      timeZone: "Africa/Nairobi",
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return String(s).slice(0, 16).replace("T", " ");
  }
};

const fmtDay = (d) => {
  if (!d) return "—";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString("en-GB", {
      timeZone: "Africa/Nairobi",
      weekday: "short", day: "2-digit", month: "short", year: "numeric",
    });
  } catch {
    return d;
  }
};

const groupKey = (g) => `${g.pos_location}__${g.day}`;

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Transfer Tracking — Marked Done → Odoo.
 *
 * Rolls every DONE recommendation of `recType` (marked from the Replenishments
 * list / Replenish-by-style page, or the Warehouse Returns page) into one bucket
 * per (POS location, day) so an operator can record the single Odoo transfer
 * document number that physically moved that store's items that day, and later
 * reconcile "this transfer number had the following items" against Odoo.
 *
 * The window is a CUSTOM calendar range (from / to) with quick presets, and the
 * whole report can be exported to CSV (flattened item rows).
 *
 * Shared by Replenishments.jsx, ReplenishByItem.jsx and WarehouseReturns.jsx.
 */
export default function ReplenishmentTransferReport({
  recType = "replenish",
  title = "Transfer Tracking — Marked Done → Odoo",
  description = "Items you mark as done land here, grouped by store and day. Enter the one Odoo transfer number that physically moved that store's items that day — it applies to every item in the group so you can reconcile the marked-done items against the actual transfer.",
  noun = "replenishments",
  exportPrefix = "transfer-tracking",
} = {}) {
  const [from, setFrom] = useState(() => ALL_FROM);
  const [to, setTo] = useState(() => todayYmd());
  const [posFilter, setPosFilter] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [drafts, setDrafts] = useState({});
  const [savingKey, setSavingKey] = useState(null);

  const load = useCallback(async (forceFresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const { data: res } = await api.get("/analytics/replenishment-transfer-report", {
        params: { rec_type: recType, date_from: from, date_to: to },
        forceFresh,
      });
      setData(res);
      // Seed each group's editable transfer number from its stored value.
      setDrafts((prev) => {
        const next = { ...prev };
        for (const g of res.groups || []) {
          const k = groupKey(g);
          if (next[k] == null) next[k] = g.transfer_ref || "";
        }
        return next;
      });
    } catch (e) {
      setError(e?.response?.data?.detail || e.message || "Failed to load report");
    } finally {
      setLoading(false);
    }
  }, [recType, from, to]);

  useEffect(() => { load(); }, [load]);

  const toggle = (k) => setExpanded((p) => ({ ...p, [k]: !p[k] }));

  const applyPreset = (p) => {
    if (p.yesterday) {
      const y = daysAgoYmd(1);
      setFrom(y);
      setTo(y);
      return;
    }
    setFrom(p.from ? p.from : daysAgoYmd(p.days));
    setTo(todayYmd());
  };

  const saveTransfer = async (g) => {
    const k = groupKey(g);
    const ref = (drafts[k] ?? "").trim();
    setSavingKey(k);
    try {
      const { data: res } = await api.post(
        "/analytics/replenishment-transfer-report/assign",
        { pos_location: g.pos_location, day: g.day, transfer_ref: ref, rec_type: recType },
      );
      // Patch locally so the badge updates without a full refetch.
      setData((prev) => ({
        ...prev,
        groups: (prev?.groups || []).map((row) =>
          groupKey(row) === k
            ? {
                ...row,
                transfer_ref: ref,
                transfer_ref_mixed: false,
                transfer_refs: ref ? [ref] : [],
                items: (row.items || []).map((it) => ({ ...it, transfer_ref: ref })),
              }
            : row,
        ),
      }));
      toast.success(
        ref
          ? `Transfer ${ref} applied to ${res.updated} item${res.updated === 1 ? "" : "s"}.`
          : "Transfer number cleared.",
      );
    } catch (e) {
      toast.error("Couldn't save — " + (e?.response?.data?.detail || e.message));
    } finally {
      setSavingKey(null);
    }
  };

  const groups = data?.groups || [];

  // POS locations present in the loaded report, for the filter dropdown.
  const locations = useMemo(() => {
    const set = new Set();
    for (const g of groups) if (g.pos_location) set.add(g.pos_location);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [groups]);

  // If the active filter no longer matches anything (e.g. after a reload),
  // fall back to "all" so the operator never sees a permanently empty report.
  useEffect(() => {
    if (posFilter && !locations.includes(posFilter)) setPosFilter("");
  }, [locations, posFilter]);

  const visibleGroups = useMemo(
    () => (posFilter ? groups.filter((g) => g.pos_location === posFilter) : groups),
    [groups, posFilter],
  );

  const summary = useMemo(() => ({
    groupCount: visibleGroups.length,
    totalUnits: visibleGroups.reduce((s, g) => s + (g.total_units || 0), 0),
    assigned: visibleGroups.filter((g) => (g.transfer_ref || "").trim()).length,
  }), [visibleGroups]);

  const exportCsv = useCallback(() => {
    const header = [
      "Store", "Day", "Transfer #", "Product", "Size", "Colour",
      "SKU", "Barcode", "Units", "Done by", "Done at",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const g of visibleGroups) {
      for (const it of g.items || []) {
        lines.push([
          g.pos_location, g.day, it.transfer_ref || "",
          it.product_name || "", it.size || "", it.color_print || "",
          it.sku || "", it.barcode || "", it.actual_units ?? 0,
          it.completed_by || "", it.completed_at || "",
        ].map(csvCell).join(","));
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportPrefix}_${from}_to_${to}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [groups, from, to, exportPrefix]);

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Truck size={18} weight="duotone" className="text-primary" />
          <h2 className="font-sans font-bold text-[16px] tracking-tight text-foreground">
            {title}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border border-input" data-testid="transfer-range-presets">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p)}
                className="px-2 py-1 text-xs font-semibold text-foreground hover:bg-accent"
                data-testid={`button-transfer-preset-${p.yesterday ? "yesterday" : p.days || "all"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            data-testid="input-transfer-from"
            aria-label="From date"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            value={to}
            min={from}
            max={todayYmd()}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            data-testid="input-transfer-to"
            aria-label="To date"
          />
          <select
            value={posFilter}
            onChange={(e) => setPosFilter(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            data-testid="select-transfer-pos"
            aria-label="Filter by POS location"
          >
            <option value="">All locations</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>{loc}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={exportCsv}
            disabled={visibleGroups.length === 0}
            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-sm hover:bg-accent disabled:opacity-50"
            data-testid="button-export-transfer-report"
          >
            <DownloadSimple size={15} /> Export CSV
          </button>
          <button
            type="button"
            onClick={() => load(true)}
            className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-sm hover:bg-accent"
            data-testid="button-refresh-transfer-report"
          >
            <ArrowsClockwise size={15} /> Refresh
          </button>
        </div>
      </div>

      <p className="px-4 pt-3 text-xs text-muted-foreground">
        {description}
      </p>

      {loading ? (
        <div className="p-4"><Loading /></div>
      ) : error ? (
        <div className="p-4"><ErrorBox message={error} /></div>
      ) : visibleGroups.length === 0 ? (
        <div className="p-4">
          <Empty
            label={
              posFilter
                ? `No ${noun} have been marked done at ${posFilter} in this date range.`
                : `No ${noun} have been marked done in this date range yet.`
            }
          />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-4 px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              <span className="font-semibold text-foreground">{fmtNum(summary.groupCount)}</span> store-day groups
            </span>
            <span className="text-muted-foreground">
              <span className="font-semibold text-foreground">{fmtNum(summary.totalUnits)}</span> units
            </span>
            <span className="text-muted-foreground">
              <span className="font-semibold text-foreground">{fmtNum(summary.assigned)}</span> with a transfer number
            </span>
          </div>

          <div className="divide-y divide-border">
            {groups.map((g) => {
              const k = groupKey(g);
              const open = !!expanded[k];
              const draft = drafts[k] ?? "";
              const saving = savingKey === k;
              const stored = (g.transfer_ref || "").trim();
              const dirty = draft.trim() !== stored;
              return (
                <div key={k} data-testid={`transfer-group-${k}`}>
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggle(k)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      data-testid={`button-toggle-${k}`}
                    >
                      {open ? <CaretDown size={16} /> : <CaretRight size={16} />}
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{g.pos_location || "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {fmtDay(g.day)} · {fmtNum(g.item_count)} item{g.item_count === 1 ? "" : "s"} · {fmtNum(g.total_units)} units
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2">
                      {g.transfer_ref_mixed && (
                        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          mixed: {(g.transfer_refs || []).join(", ")}
                        </span>
                      )}
                      {!g.transfer_ref_mixed && stored && (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                          <CheckCircle size={13} weight="fill" /> {stored}
                        </span>
                      )}
                      <input
                        type="text"
                        value={draft}
                        onChange={(e) => setDrafts((p) => ({ ...p, [k]: e.target.value }))}
                        placeholder="Odoo transfer #"
                        className="w-36 rounded-md border border-input bg-background px-2 py-1 text-sm"
                        title="Enter the Odoo transfer document number for this store + day"
                        data-testid={`input-transfer-${k}`}
                      />
                      <button
                        type="button"
                        disabled={saving || !dirty}
                        onClick={() => saveTransfer(g)}
                        className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
                        data-testid={`button-save-transfer-${k}`}
                      >
                        <Check size={14} /> {saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>

                  {open && (
                    <div className="overflow-x-auto px-4 pb-4">
                      <table className="w-full min-w-[640px] text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                            <th className="py-2 pr-3">Product</th>
                            <th className="py-2 pr-3">Size</th>
                            <th className="py-2 pr-3">Colour</th>
                            <th className="py-2 pr-3">SKU</th>
                            <th className="py-2 pr-3">Barcode</th>
                            <th className="py-2 pr-3 text-right">Units</th>
                            <th className="py-2 pr-3">Done by</th>
                            <th className="py-2 pr-3">Done at</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(g.items || []).map((it, i) => (
                            <tr key={`${k}-${it.sku || it.barcode}-${i}`} className="border-b border-border/50">
                              <td className="py-2 pr-3">{it.product_name || "—"}</td>
                              <td className="py-2 pr-3">{it.size || "—"}</td>
                              <td className="py-2 pr-3">{it.color_print || "—"}</td>
                              <td className="py-2 pr-3 font-mono text-xs">{it.sku || "—"}</td>
                              <td className="py-2 pr-3 font-mono text-xs">{it.barcode || "—"}</td>
                              <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(it.actual_units)}</td>
                              <td className="py-2 pr-3">{it.completed_by || "—"}</td>
                              <td className="py-2 pr-3 whitespace-nowrap">{fmtDoneAt(it.completed_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
