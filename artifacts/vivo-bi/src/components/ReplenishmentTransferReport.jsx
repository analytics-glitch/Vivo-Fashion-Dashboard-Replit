import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { toast } from "sonner";
import { Loading, ErrorBox, Empty } from "@/components/common";
import {
  ArrowsClockwise, CaretDown, CaretRight, Truck, Check, CheckCircle,
} from "@phosphor-icons/react";

const DAY_OPTIONS = [
  { label: "30 days", value: 30 },
  { label: "60 days", value: 60 },
  { label: "90 days", value: 90 },
];

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

/**
 * Transfer Tracking — Marked Done → Odoo.
 *
 * Rolls every DONE replenishment (marked from the Replenishments list or the
 * Replenish-by-style page — both write the same store) into one bucket per
 * (POS location, day) so an operator can record the single Odoo transfer
 * document number that physically moved that store's items that day, and later
 * reconcile "this transfer number had the following items" against Odoo.
 *
 * Shared by Replenishments.jsx and ReplenishByItem.jsx.
 */
export default function ReplenishmentTransferReport() {
  const [days, setDays] = useState(60);
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
        params: { days },
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
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const toggle = (k) => setExpanded((p) => ({ ...p, [k]: !p[k] }));

  const saveTransfer = async (g) => {
    const k = groupKey(g);
    const ref = (drafts[k] ?? "").trim();
    setSavingKey(k);
    try {
      const { data: res } = await api.post(
        "/analytics/replenishment-transfer-report/assign",
        { pos_location: g.pos_location, day: g.day, transfer_ref: ref },
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

  const summary = useMemo(() => ({
    groupCount: data?.group_count || 0,
    totalUnits: data?.total_units || 0,
    assigned: groups.filter((g) => (g.transfer_ref || "").trim()).length,
  }), [data, groups]);

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Truck size={18} weight="duotone" className="text-primary" />
          <h2 className="font-sans font-bold text-[16px] tracking-tight text-foreground">
            Transfer Tracking — Marked Done → Odoo
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            data-testid="select-transfer-days"
          >
            {DAY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
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
        Items you mark as done land here, grouped by store and day. Enter the one
        Odoo transfer number that physically moved that store's items that day —
        it applies to every item in the group so you can reconcile the marked-done
        items against the actual transfer.
      </p>

      {loading ? (
        <div className="p-4"><Loading /></div>
      ) : error ? (
        <div className="p-4"><ErrorBox message={error} /></div>
      ) : groups.length === 0 ? (
        <div className="p-4">
          <Empty label="No replenishments have been marked done in this window yet." />
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
