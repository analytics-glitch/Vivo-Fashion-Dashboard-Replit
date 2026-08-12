import React, { useEffect, useMemo, useState } from "react";
import { api, fmtKES, fmtNum, fmtDec } from "@/lib/api";
import { Empty } from "@/components/common";
import { toast } from "sonner";
import {
  CaretRight, CaretDown, ArrowRight, Lock, CheckCircle,
  XCircle, DownloadSimple, Stack,
} from "@phosphor-icons/react";

/**
 * Priority IBT suggestions — grouped-by-style accordion (B1).
 *
 * Adds the spec deltas on top of the flat SKU action table:
 *   • Score column, color-coded (>=80 red, 60-79 orange, 40-59 yellow, <40 grey),
 *     groups sorted by best score descending.
 *   • Cluster badges (A dark-green / B amber / C grey) next to store names.
 *   • Multi-pair accordion: each style expands to show every donor->needer pair,
 *     with a pair_count badge on the header.
 *   • Transfer impact: projected weeks-of-cover left at the SOURCE store after
 *     the move = (from_avail - units_to_move) / weekly_units. Computed from the
 *     lazily-loaded SKU breakdown (from_avail) + the 28-day source velocity.
 *   • Size-run protection: a Lock icon on any SKU the algorithm held back to
 *     keep the donor's size run intact (size_run_protected = true).
 *   • Bulk actions: per-pair checkboxes + a bulk bar (Mark Done / Dismiss /
 *     Export Selected) wired to POST /recommendations/bulk.
 *
 * Mark As Done (per SKU) still opens the existing modal via `onMarkDone`.
 */

const _skuCache = new Map();

const scoreClass = (s) => {
  const n = Number(s) || 0;
  if (n >= 80) return "bg-rose-100 text-rose-800 border border-rose-300";
  if (n >= 60) return "bg-orange-100 text-orange-800 border border-orange-300";
  if (n >= 40) return "bg-amber-100 text-amber-800 border border-amber-300";
  return "bg-slate-100 text-slate-600 border border-slate-300";
};

const clusterClass = (c) => {
  if (c === "A") return "bg-emerald-800 text-white border border-emerald-900";
  if (c === "B") return "bg-amber-500 text-white border border-amber-600";
  if (c === "C") return "bg-slate-300 text-slate-800 border border-slate-400";
  return "bg-slate-200 text-slate-600 border border-slate-300";
};

const ClusterBadge = ({ c, where }) =>
  c ? (
    <span
      className={`text-[9.5px] font-bold tracking-wide px-1.5 py-0.5 rounded ${clusterClass(c)}`}
      title={`${where} store cluster ${c} (A = top revenue tier, C = lowest)`}
    >
      {c}
    </span>
  ) : null;

const ScorePill = ({ score, testId }) => (
  <span
    className={`inline-flex items-center justify-center min-w-[34px] text-[11.5px] font-bold px-2 py-0.5 rounded-full ${scoreClass(score)}`}
    title="Transfer priority score (0-100). Higher = stronger donor surplus + destination demand."
    data-testid={testId}
  >
    {score == null ? "—" : Math.round(Number(score))}
  </span>
);

const pairKeyOf = (p) => `${p.style_name}||${p.from_store}||${p.to_store}`;

/** weeks-of-cover left at the source after the move. */
const transferImpact = (fromAvail, unitsToMove, qtySold28d) => {
  if (fromAvail == null) return null;
  const weekly = (Number(qtySold28d) || 0) / 4.0;
  const remaining = Math.max(Number(fromAvail) - Number(unitsToMove || 0), 0);
  if (weekly <= 0) return Infinity; // not selling at source -> effectively unlimited cover
  return remaining / weekly;
};

const ImpactBadge = ({ weeks }) => {
  if (weeks == null) return <span className="text-muted/60">—</span>;
  if (weeks === Infinity)
    return (
      <span className="text-[11px] text-slate-600" title="Source store has no recent sales — surplus cover remains high after the move">
        no sales
      </span>
    );
  const cls =
    weeks >= 8 ? "text-emerald-700" : weeks >= 4 ? "text-amber-700" : "text-rose-700";
  return (
    <span className={`text-[11.5px] font-semibold ${cls}`} title="Projected weeks of cover left at the source store after the transfer">
      {fmtDec(weeks, 1)} wks
    </span>
  );
};

const useSkuBreakdown = (pair, enabled) => {
  const [skus, setSkus] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !pair) return undefined;
    const key = `${pair.style_name}||${pair.from_store}||${pair.to_store}||${pair.units_to_move}`;
    if (_skuCache.has(key)) {
      setSkus(_skuCache.get(key));
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    api
      .get("/analytics/ibt-sku-breakdown", {
        params: {
          style_name: pair.style_name,
          from_store: pair.from_store,
          to_store: pair.to_store,
          units_to_move: pair.units_to_move,
        },
        timeout: 60000,
      })
      .then(({ data }) => {
        if (cancelled) return;
        const s = data?.skus || [];
        _skuCache.set(key, s);
        setSkus(s);
      })
      .catch(() => {
        if (cancelled) return;
        _skuCache.set(key, []);
        setSkus([]);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [pair, enabled]);

  return { skus, loading };
};

const PairRow = ({ pair, idx, enabled, selected, onToggleSelect, onMarkDone, actionState }) => {
  const [open, setOpen] = useState(false);
  const { skus, loading } = useSkuBreakdown(pair, enabled);
  const [actuals, setActuals] = useState({});

  const fromAvail = useMemo(() => {
    if (!skus) return null;
    return skus.reduce((a, s) => a + (Number(s.from_available) || 0), 0);
  }, [skus]);

  const weeks = transferImpact(fromAvail, pair.units_to_move, pair.from_qty_sold_28d);
  const actioned = actionState?.status;

  const handleMarkDone = (sk) => {
    const actual = actuals[sk.sku];
    onMarkDone?.({
      ...pair,
      style_name: pair.style_name,
      brand: pair.brand,
      subcategory: pair.subcategory,
      from_store: pair.from_store,
      to_store: pair.to_store,
      suggested_qty: sk.suggested_qty,
      units_to_move: sk.suggested_qty,
      actual_units_moved:
        actual !== undefined && actual !== "" ? Number(actual) : sk.suggested_qty,
      sku: sk.sku,
      color: sk.color,
      size: sk.size,
      barcode: sk.barcode,
      flow: "store_to_store",
    });
  };

  return (
    <>
      <tr
        className={`border-t border-border/50 ${actioned ? "opacity-50" : "hover:bg-amber-50/40"}`}
        data-testid={`ibt-pair-${idx}`}
      >
        <td className="px-2 py-2.5 align-middle">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(pairKeyOf(pair))}
            aria-label="Select transfer for bulk action"
            data-testid={`ibt-pair-select-${idx}`}
            className="w-4 h-4 accent-[var(--brand,#e85b1b)]"
          />
        </td>
        <td className="px-2 py-2.5 align-middle">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-muted hover:text-brand"
            aria-label={open ? "Collapse SKUs" : "Expand SKUs"}
            data-testid={`ibt-pair-toggle-${idx}`}
          >
            {open ? <CaretDown size={13} weight="bold" /> : <CaretRight size={13} weight="bold" />}
          </button>
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap font-medium">
          <span className="inline-flex items-center gap-1.5">
            {pair.from_store}
            <ClusterBadge c={pair.from_cluster} where="Source" />
          </span>
        </td>
        <td className="px-2 py-2.5 text-brand"><ArrowRight size={14} weight="bold" /></td>
        <td className="px-3 py-2.5 whitespace-nowrap font-semibold text-brand">
          <span className="inline-flex items-center gap-1.5">
            {pair.to_store}
            <ClusterBadge c={pair.to_cluster} where="Destination" />
          </span>
        </td>
        <td className="px-3 py-2.5 text-center"><ScorePill score={pair.score} testId={`ibt-pair-score-${idx}`} /></td>
        <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{fmtNum(pair.units_to_move)}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">{fmtKES(pair.estimated_uplift)}</td>
        <td className="px-3 py-2.5 text-right whitespace-nowrap" data-testid={`ibt-pair-impact-${idx}`}>
          {enabled ? <ImpactBadge weeks={weeks} /> : <span className="text-muted/60">—</span>}
        </td>
        <td className="px-3 py-2.5 text-right whitespace-nowrap">
          {actioned ? (
            <span className="text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
              {actioned}
            </span>
          ) : (
            <span className="text-[10.5px] text-muted">open</span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-panel/40">
          <td colSpan={10} className="px-4 py-3">
            {loading && <div className="text-[12px] text-muted">Loading SKU breakdown…</div>}
            {!loading && skus && skus.length === 0 && (
              <div className="text-[12px] text-muted">No SKU-level inventory found for this pair.</div>
            )}
            {!loading && skus && skus.length > 0 && (
              <div className="overflow-x-auto rounded border border-border bg-white">
                <table className="w-full min-w-max text-[12px]">
                  <thead className="bg-panel">
                    <tr className="text-left">
                      <th className="px-3 py-2 font-semibold">Color</th>
                      <th className="px-3 py-2 font-semibold">Size</th>
                      <th className="px-3 py-2 font-semibold">SKU</th>
                      <th className="px-3 py-2 font-semibold text-right">Inv FROM</th>
                      <th className="px-3 py-2 font-semibold text-right">Inv TO</th>
                      <th className="px-3 py-2 font-semibold text-right">Suggested</th>
                      <th className="px-3 py-2 font-semibold text-right">Actual</th>
                      <th className="px-3 py-2 font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skus.map((sk, j) => {
                      const protectedRun = sk.size_run_protected;
                      const recentlyReceived = sk.recently_received;
                      const rowHeld = protectedRun || recentlyReceived;
                      return (
                        <tr key={sk.sku || j} className="border-t border-border/50">
                          <td className="px-3 py-2 whitespace-nowrap">{sk.color || "—"}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5">
                              {sk.size || "—"}
                              {protectedRun && (
                                <Lock
                                  size={13}
                                  weight="fill"
                                  className="text-slate-500"
                                  data-testid={`ibt-size-run-protected-${idx}-${j}`}
                                />
                              )}
                              {recentlyReceived && (
                                <span
                                  className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9.5px] font-bold uppercase tracking-wide"
                                  title="This store received this SKU within the last 3 weeks — not eligible to send out yet"
                                  data-testid={`ibt-recently-received-${idx}-${j}`}
                                >
                                  just in
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap font-mono text-[11px]">{sk.sku || "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtNum(sk.from_available ?? 0)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtNum(sk.to_available ?? 0)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {recentlyReceived ? (
                              <span className="text-[10.5px] text-amber-700" title="Received at this store less than 3 weeks ago">just in</span>
                            ) : protectedRun ? (
                              <span className="text-[10.5px] text-slate-500" title="Size run protected">held</span>
                            ) : (
                              <span className="pill-green font-bold">{fmtNum(sk.suggested_qty || 0)}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              min={0}
                              inputMode="numeric"
                              placeholder={String(sk.suggested_qty || 0)}
                              value={actuals[sk.sku] ?? ""}
                              onChange={(e) => setActuals((p) => ({ ...p, [sk.sku]: e.target.value }))}
                              disabled={rowHeld}
                              className="w-16 h-8 px-2 text-right tabular-nums border border-border rounded bg-white disabled:bg-panel disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand/40"
                              aria-label={`Actual transferred for ${sk.sku}`}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => handleMarkDone(sk)}
                              disabled={rowHeld || !(sk.suggested_qty > 0)}
                              className="inline-flex items-center gap-1 text-[11px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed px-2.5 py-1.5 rounded"
                              title={recentlyReceived ? "Received at this store less than 3 weeks ago — not eligible to send out yet" : protectedRun ? "Size run protected — not transferable" : "Mark this SKU's transfer as completed"}
                              data-testid={`ibt-pair-markdone-${idx}-${j}`}
                            >
                              <CheckCircle size={12} weight="fill" /> Done
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {!enabled && (
              <div className="text-[11px] text-muted mt-1">
                Transfer impact appears once the style is expanded.
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
};

const StyleGroup = ({ group, idx, selected, onToggleSelect, onToggleSelectGroup, onMarkDone, stateByKey }) => {
  const [open, setOpen] = useState(false);
  const pairKeys = group.pairs.map(pairKeyOf);
  const allSelected = pairKeys.length > 0 && pairKeys.every((k) => selected.has(k));

  return (
    <div className="rounded-lg border border-border bg-white overflow-hidden" data-testid={`ibt-style-group-${idx}`}>
      <div className="flex items-center gap-3 px-3 py-2.5 bg-panel/50">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => onToggleSelectGroup(pairKeys, !allSelected)}
          aria-label="Select all pairs for this style"
          className="w-4 h-4 accent-[var(--brand,#e85b1b)]"
          data-testid={`ibt-style-select-${idx}`}
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          data-testid={`ibt-style-toggle-${idx}`}
        >
          {open ? <CaretDown size={14} weight="bold" className="text-muted" /> : <CaretRight size={14} weight="bold" className="text-muted" />}
          <span className="min-w-0">
            <span className="font-semibold text-[13px] break-words">{group.style_name}</span>
            <span className="text-[10.5px] text-muted ml-2">{group.brand} · {group.subcategory}</span>
          </span>
        </button>
        <span
          className="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-brand/10 text-brand-deep border border-brand/30"
          title={`${group.pairCount} donor → needer pair${group.pairCount === 1 ? "" : "s"} for this style`}
          data-testid={`ibt-style-paircount-${idx}`}
        >
          <Stack size={11} weight="bold" /> {group.pairCount} pair{group.pairCount === 1 ? "" : "s"}
        </span>
        <ScorePill score={group.maxScore} testId={`ibt-style-score-${idx}`} />
        <span className="hidden sm:inline text-[11px] text-muted whitespace-nowrap">
          {fmtNum(group.totalUnits)} units · {fmtKES(group.totalUplift)}
        </span>
      </div>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-[12.5px]">
            <thead className="bg-white">
              <tr className="text-left text-[11px] text-muted">
                <th className="px-2 py-2"></th>
                <th className="px-2 py-2"></th>
                <th className="px-3 py-2 font-semibold">From</th>
                <th className="px-2 py-2"></th>
                <th className="px-3 py-2 font-semibold">To</th>
                <th className="px-3 py-2 font-semibold text-center">Score</th>
                <th className="px-3 py-2 font-semibold text-right">Units</th>
                <th className="px-3 py-2 font-semibold text-right">Est. uplift</th>
                <th className="px-3 py-2 font-semibold text-right" title="Projected weeks of cover left at the source store after the transfer">Transfer impact</th>
                <th className="px-3 py-2 font-semibold text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {group.pairs.map((p, j) => (
                <PairRow
                  key={pairKeyOf(p)}
                  pair={p}
                  idx={`${idx}-${j}`}
                  enabled={open}
                  selected={selected.has(pairKeyOf(p))}
                  onToggleSelect={onToggleSelect}
                  onMarkDone={onMarkDone}
                  actionState={stateByKey.get(pairKeyOf(p))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default function IBTSuggestionsTable({ suggestions, onMarkDone, recState, emptyLabel }) {
  const { stateByKey, refresh } = recState;
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => {
    const m = new Map();
    for (const s of suggestions || []) {
      const k = s.style_name || "—";
      if (!m.has(k)) {
        m.set(k, { style_name: s.style_name, brand: s.brand, subcategory: s.subcategory, pairs: [] });
      }
      m.get(k).pairs.push(s);
    }
    const arr = [...m.values()].map((g) => {
      const maxScore = g.pairs.reduce((a, p) => Math.max(a, Number(p.score) || 0), 0);
      const totalUnits = g.pairs.reduce((a, p) => a + (Number(p.units_to_move) || 0), 0);
      const totalUplift = g.pairs.reduce((a, p) => a + (Number(p.estimated_uplift) || 0), 0);
      const pairCount = g.pairs[0]?.pair_count ?? g.pairs.length;
      return { ...g, maxScore, totalUnits, totalUplift, pairCount };
    });
    arr.sort((a, b) => b.maxScore - a.maxScore);
    return arr;
  }, [suggestions]);

  const toggleSelect = (key) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });

  const toggleSelectGroup = (keys, on) =>
    setSelected((prev) => {
      const n = new Set(prev);
      keys.forEach((k) => (on ? n.add(k) : n.delete(k)));
      return n;
    });

  const runBulk = async (status) => {
    const actions = [...selected].map((key) => ({ item_type: "ibt", item_key: key, status }));
    if (!actions.length) return;
    setBusy(true);
    try {
      await api.post("/recommendations/bulk", { actions });
      await refresh?.();
      setSelected(new Set());
      toast.success(
        `${actions.length} transfer${actions.length === 1 ? "" : "s"} ${status === "done" ? "marked done" : "dismissed"}`
      );
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Bulk action failed — try again");
    } finally {
      setBusy(false);
    }
  };

  const exportSelected = () => {
    const byKey = new Map();
    for (const s of suggestions || []) byKey.set(pairKeyOf(s), s);
    const rows = [...selected].map((k) => byKey.get(k)).filter(Boolean);
    if (!rows.length) return;
    const header = ["Style", "Brand", "Subcategory", "From Store", "From Cluster",
      "To Store", "To Cluster", "Score", "Units To Move", "Est. Uplift (KES)"];
    const out = [header];
    for (const r of rows) {
      out.push([
        r.style_name, r.brand || "", r.subcategory || "",
        r.from_store, r.from_cluster || "", r.to_store, r.to_cluster || "",
        r.score ?? "", r.units_to_move ?? "", Math.round(r.estimated_uplift || 0),
      ]);
    }
    const csv = out
      .map((row) =>
        row
          .map((cell) => {
            const v = cell == null ? "" : String(cell);
            return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
          })
          .join(",")
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ibt-selected-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    toast.success(`${rows.length} row${rows.length === 1 ? "" : "s"} exported`);
  };

  if (!suggestions || suggestions.length === 0) {
    return <Empty label={emptyLabel || "No transfer opportunities for the current window."} />;
  }

  return (
    <div className="space-y-2" data-testid="ibt-suggestions-table">
      {selected.size > 0 && (
        <div
          className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-brand/40 bg-brand/5 px-3 py-2"
          data-testid="ibt-bulk-bar"
        >
          <span className="text-[12px] font-semibold text-brand-deep">
            {selected.size} selected
          </span>
          <div className="flex-1" />
          <button
            type="button"
            disabled={busy}
            onClick={() => runBulk("done")}
            className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 px-3 py-1.5 rounded"
            data-testid="ibt-bulk-done"
          >
            <CheckCircle size={13} weight="fill" /> Mark Done
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runBulk("dismissed")}
            className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-slate-700 bg-slate-200 hover:bg-slate-300 disabled:opacity-50 px-3 py-1.5 rounded"
            data-testid="ibt-bulk-dismiss"
          >
            <XCircle size={13} weight="fill" /> Dismiss
          </button>
          <button
            type="button"
            onClick={exportSelected}
            className="inline-flex items-center gap-1.5 text-[11.5px] font-bold text-brand-deep bg-white border border-brand/40 hover:bg-brand/10 px-3 py-1.5 rounded"
            data-testid="ibt-bulk-export"
          >
            <DownloadSimple size={13} weight="bold" /> Export Selected
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-[11px] text-muted underline hover:text-brand"
          >
            clear
          </button>
        </div>
      )}
      {groups.map((g, i) => (
        <StyleGroup
          key={g.style_name || i}
          group={g}
          idx={i}
          selected={selected}
          onToggleSelect={toggleSelect}
          onToggleSelectGroup={toggleSelectGroup}
          onMarkDone={onMarkDone}
          stateByKey={stateByKey}
        />
      ))}
    </div>
  );
}
