import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { LoyaltyBadge } from "@/components/LoyaltyBadge";
import { api, formatDate, formatKES } from "@/lib/api";
import { toast } from "sonner";
import { ChevronUp, ChevronDown, Download, ArrowRight, RefreshCw } from "lucide-react";

const PAGE = 25;
const COLS = [
  { key: "customer_name", label: "Customer", sortable: true, align: "left" },
  { key: "spend_12mo_kes", label: "12-mo spend", sortable: true, align: "right" },
  { key: "total_sales", label: "Lifetime", sortable: true, align: "right" },
  { key: "total_orders", label: "Orders", sortable: true, align: "right" },
  { key: "last_purchase_date", label: "Last seen", sortable: true, align: "left" },
  { key: "city", label: "City", sortable: true, align: "left" },
  { key: "customer_country", label: "Country", sortable: true, align: "left" },
];

/**
 * Tier customers drill-down modal. Opens when a manager clicks a tier card
 * on the Loyalty page. Lists everyone in that tier with sorting, pagination
 * and one-click CSV export. Data comes straight from /api/customers/grid —
 * the same source of truth as the Customer Database page, so numbers are
 * guaranteed consistent.
 */
export default function TierCustomersModal({ open, onClose, tier, total }) {
  const [rows, setRows] = useState([]);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState("spend_12mo_kes");
  const [order, setOrder] = useState("desc");
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const navigate = useNavigate();

  const filters = useMemo(() => ({ loyalty_tiers: [tier] }), [tier]);

  const load = async () => {
    if (!tier) return;
    setLoading(true);
    try {
      const r = await api.post("/customers/grid", {
        limit: PAGE, offset, sort, order, filters,
      });
      setRows(r.data.rows || []);
    } catch {
      toast.error("Could not load tier customers");
    } finally { setLoading(false); }
  };
  useEffect(() => {
    if (open) { setOffset(0); }
  }, [open, tier]);
  useEffect(() => { if (open) load(); /* eslint-disable-next-line */ }, [open, tier, offset, sort, order]);

  const toggleSort = (key) => {
    if (sort === key) setOrder(order === "desc" ? "asc" : "desc");
    else { setSort(key); setOrder("desc"); }
    setOffset(0);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await api.post(
        "/customers/grid/export",
        { limit: 200000, filters },
        { responseType: "blob" },
      );
      const url = URL.createObjectURL(new Blob([r.data], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `vivo-${tier}-members-${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${tier} member CSV`);
    } catch { toast.error("Export failed"); }
    finally { setExporting(false); }
  };

  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE, total);
  const canPrev = offset > 0;
  const canNext = end < total;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden flex flex-col" data-testid={`tier-modal-${tier}`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 font-display text-2xl">
            <LoyaltyBadge tier={tier} />
            <span className="capitalize">{tier} members</span>
            <span className="text-sm text-[var(--vivo-muted)] font-normal">· {total.toLocaleString()} customers</span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3 mt-1">
          <div className="text-xs text-[var(--vivo-muted)]">
            Sorted by <strong>{COLS.find(c => c.key === sort)?.label || sort}</strong> ({order === "desc" ? "high → low" : "low → high"}). Click a column to re-sort.
          </div>
          <Button
            onClick={exportCsv}
            disabled={exporting || total === 0}
            className="bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy)]/90 h-9"
            data-testid={`tier-modal-export-${tier}`}
          >
            <Download className={`h-4 w-4 mr-2 ${exporting ? "animate-pulse" : ""}`}/>
            {exporting ? "Exporting…" : "Download CSV"}
          </Button>
        </div>

        <div className="overflow-auto flex-1 mt-3 border border-[var(--vivo-border)] rounded-sm bg-white">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--vivo-bg-soft)] z-10">
              <tr className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] border-b border-[var(--vivo-border)]">
                {COLS.map((c) => (
                  <th
                    key={c.key}
                    className={`px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"} ${c.sortable ? "cursor-pointer select-none hover:text-[var(--vivo-navy)]" : ""}`}
                    onClick={c.sortable ? () => toggleSort(c.key) : undefined}
                    data-testid={`tier-col-${c.key}`}
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {c.label}
                      {sort === c.key && (order === "desc" ? <ChevronDown className="h-3 w-3"/> : <ChevronUp className="h-3 w-3"/>)}
                    </span>
                  </th>
                ))}
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={COLS.length + 1} className="px-3 py-12 text-center text-sm text-[var(--vivo-muted)]"><RefreshCw className="h-4 w-4 mr-2 animate-spin inline"/>Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={COLS.length + 1} className="px-3 py-12 text-center text-sm text-[var(--vivo-muted)]">No {tier} customers yet.</td></tr>
              )}
              {!loading && rows.map((r) => (
                <tr key={r.customer_id} className="border-b border-[var(--vivo-border)] last:border-0 hover:bg-[var(--vivo-bg)]" data-testid={`tier-modal-row-${r.customer_id}`}>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => { navigate(`/customers/${r.customer_id}`); onClose(); }}
                      className="text-[var(--vivo-navy)] font-medium hover:underline text-left"
                    >
                      {r.customer_name || r.customer_id}
                    </button>
                    <div className="text-[10px] text-[var(--vivo-muted)] font-mono">{r.customer_id}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">{formatKES(r.spend_12mo_kes)}</td>
                  <td className="px-3 py-2 text-right">{formatKES(r.total_sales)}</td>
                  <td className="px-3 py-2 text-right">{(r.total_orders || 0).toLocaleString()}</td>
                  <td className="px-3 py-2">{formatDate(r.last_purchase_date)}</td>
                  <td className="px-3 py-2 text-[var(--vivo-muted)]">{r.city || "—"}</td>
                  <td className="px-3 py-2 text-[var(--vivo-muted)]">{r.customer_country || "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => { navigate(`/customers/${r.customer_id}`); onClose(); }}
                      className="text-[var(--vivo-navy)] hover:text-[var(--vivo-navy)] p-1"
                      data-testid={`tier-modal-open-${r.customer_id}`}
                      aria-label="Open profile"
                    >
                      <ArrowRight className="h-4 w-4"/>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--vivo-border)]">
          <span className="text-xs text-[var(--vivo-muted)]">
            {start.toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => canPrev && setOffset(Math.max(0, offset - PAGE))}
              disabled={!canPrev}
              className="h-8 px-3 rounded-sm border border-[var(--vivo-border)] text-xs text-[var(--vivo-navy)] disabled:opacity-40 disabled:cursor-not-allowed press-effect"
              data-testid={`tier-modal-prev-${tier}`}
            >
              ← Prev
            </button>
            <button
              onClick={() => canNext && setOffset(offset + PAGE)}
              disabled={!canNext}
              className="h-8 px-3 rounded-sm border border-[var(--vivo-border)] text-xs text-[var(--vivo-navy)] disabled:opacity-40 disabled:cursor-not-allowed press-effect"
              data-testid={`tier-modal-next-${tier}`}
            >
              Next →
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
