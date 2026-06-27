import React, { useEffect, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { Loading, Empty, ErrorBox, SectionTitle } from "@/components/common";
import { Package, ArrowRight, Warning, Lock } from "@phosphor-icons/react";

/**
 * In-transit / awaiting-receive worklist — Phase 3 (Flow & Proof).
 *
 * Lists every consignment that's been scanned OUT of the donor but not yet
 * scanned IN at the destination (status=in_transit). Each row offers a Scan-in
 * action (the hard receiving gate). Overdue consignments (in transit beyond the
 * SLA) are flagged. Scan buttons soft-lock when the sales sync is stale so a
 * destructive receive isn't actioned against figures that haven't refreshed.
 */
export default function IBTInTransit({ refreshKey, onScanIn, stale = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const config = refreshKey > 0
      ? { timeout: 30000, forceFresh: true, params: { status: "in_transit" } }
      : { timeout: 30000, params: { status: "in_transit" } };
    api.get("/ibt/transfers", config)
      .then((r) => { if (!cancelled) setRows(r.data || []); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  return (
    <div className="card-white p-4 sm:p-5 scroll-mt-24" id="ibt-sec-in-transit" data-testid="ibt-in-transit">
      <SectionTitle
        title={
          <span className="inline-flex items-center gap-2">
            <Package size={16} weight="duotone" className="text-[#1a5c38]" />
            In transit · awaiting receive
            {rows.length > 0 && (
              <span className="text-[11px] font-bold bg-brand/10 text-brand-deep px-2 py-0.5 rounded-full">
                {fmtNum(rows.length)}
              </span>
            )}
          </span>
        }
        subtitle="Consignments scanned out of the donor and owned by the hub in flight (neither store's SOR moves). Scan each one in at the destination to close the loop."
      />
      {loading && <Loading label="Loading consignments in transit…" />}
      {error && <ErrorBox message={error} />}
      {!loading && !error && rows.length === 0 && (
        <Empty label="Nothing in transit — scan a transfer out to start a consignment." />
      )}
      {!loading && !error && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full min-w-max text-[12.5px]" data-testid="ibt-in-transit-table">
            <thead className="bg-panel">
              <tr className="text-left">
                <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Consignment</th>
                <th className="px-3 py-2.5 font-semibold whitespace-nowrap">From</th>
                <th className="px-2 py-2.5"></th>
                <th className="px-3 py-2.5 font-semibold whitespace-nowrap">To</th>
                <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Route</th>
                <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Style / SKU</th>
                <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap">Qty</th>
                <th className="px-3 py-2.5 font-semibold text-right whitespace-nowrap">In transit</th>
                <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr
                  key={r.consignment_id}
                  className={`border-t border-border/50 ${r.overdue ? "bg-rose-50/40" : idx % 2 === 0 ? "bg-white" : "bg-panel/30"}`}
                  data-testid={`ibt-in-transit-row-${idx}`}
                >
                  <td className="px-3 py-2.5 whitespace-nowrap font-mono text-[11px] font-semibold text-brand-deep">
                    {r.consignment_id}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{r.from_store}</td>
                  <td className="px-2 py-2.5 text-brand"><ArrowRight size={13} weight="bold" /></td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-brand font-semibold">{r.to_store}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        r.via_hub
                          ? "bg-sky-50 text-sky-800 border border-sky-200"
                          : "bg-slate-100 text-slate-700 border border-slate-300"
                      }`}
                      title={r.route || (r.via_hub ? "Routed via hub warehouse" : "Same-mall direct")}
                    >
                      {r.via_hub ? "via hub" : "same-mall"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <div className="font-semibold">{r.style_name}</div>
                    <div className="text-[10.5px] text-muted font-mono">
                      {[r.color, r.size, r.sku].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{fmtNum(r.qty)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {r.overdue ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-rose-700" title={`Overdue — in transit ${r.days_in_transit} days`}>
                        <Warning size={12} weight="fill" />
                        {fmtNum(r.days_in_transit)}d
                      </span>
                    ) : (
                      <span className="text-foreground/70">{fmtNum(r.days_in_transit)}d</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => !stale && onScanIn?.(r)}
                      disabled={stale}
                      title={stale ? "Sales sync is stale — receiving is locked until figures refresh" : "Scan this consignment in at the destination"}
                      className={`inline-flex items-center gap-1 text-[11.5px] font-semibold px-2.5 py-1.5 rounded-md ${
                        stale
                          ? "bg-gray-100 text-muted cursor-not-allowed"
                          : "text-white bg-emerald-600 hover:bg-emerald-700"
                      }`}
                      data-testid={`ibt-scan-in-btn-${idx}`}
                    >
                      {stale ? <Lock size={13} weight="bold" /> : <Package size={13} weight="bold" />}
                      Scan in
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
