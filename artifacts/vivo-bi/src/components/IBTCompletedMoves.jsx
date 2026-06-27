import React, { useEffect, useState } from "react";
import { api, fmtNum } from "@/lib/api";
import { Loading, Empty, ErrorBox, SectionTitle } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { Archive, ArrowRight, Warning, CheckCircle } from "@phosphor-icons/react";

/**
 * Received log — Phase 3 (Flow & Proof). Admin/leadership audit of every
 * consignment that's been scanned IN at the destination (status received OR
 * discrepancy). Generated from /api/ibt/transfers. Shows days-lapsed
 * (received − dispatch) and flags shortfalls/overages as discrepancies.
 *
 * Replaces the old blind Mark-As-Done report. The scan-in path mirrors into
 * ibt_completions for late-count / outcomes / roi, but this log reads the
 * lifecycle ledger directly so it can surface dispatched-vs-received + the
 * discrepancy branch the completions table doesn't carry.
 */
export default function IBTCompletedMoves({ refreshKey }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Force a real network fetch (not the 5-min api.js response cache) whenever
    // the parent bumps refreshKey, e.g. after a scan-in completes — otherwise the
    // newly-received row wouldn't appear here for up to 5 minutes.
    const config = refreshKey > 0
      ? { timeout: 30000, forceFresh: true, params: { days: 90 } }
      : { timeout: 30000, params: { days: 90 } };
    api.get("/ibt/transfers", config)
      .then((r) => {
        if (cancelled) return;
        const received = (r.data || []).filter(
          (t) => t.status === "received" || t.status === "discrepancy",
        );
        setRows(received);
      })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  return (
    <div className="card-white p-5" data-testid="ibt-completed-report">
      <SectionTitle
        title={
          <span className="inline-flex items-center gap-2">
            <Archive size={16} weight="duotone" className="text-[#1a5c38]" />
            Received log
            <span className="text-[10.5px] font-bold uppercase tracking-wide bg-amber-100 text-amber-900 px-1.5 py-0.5 rounded">
              admin
            </span>
          </span>
        }
        subtitle="Audit of every consignment scanned in at the destination. Days lapsed = dispatch → receive. Discrepancies (short/over) are flagged and excluded from realised SOR/CCC."
      />
      {loading && <Loading label="Loading received consignments…" />}
      {error && <ErrorBox message={error} />}
      {!loading && !error && rows.length === 0 && (
        <Empty label="No received consignments yet — scan a transfer in to populate this log." />
      )}
      {!loading && !error && rows.length > 0 && (
        <SortableTable
          testId="ibt-completed-table"
          exportName="ibt-received-log.csv"
          pageSize={50}
          mobileCards
          initialSort={{ key: "received_ts", dir: "desc" }}
          rows={rows}
          columns={[
            {
              key: "consignment_id", label: "Consignment", align: "left", mobilePrimary: true,
              render: (r) => (
                <span className="font-mono text-[11px] bg-gray-100 px-1.5 py-0.5 rounded">{r.consignment_id}</span>
              ),
              csv: (r) => r.consignment_id,
            },
            {
              key: "style_name", label: "Style", align: "left",
              render: (r) => (
                <div className="max-w-[240px]">
                  <div className="font-medium break-words" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                    {r.style_name}
                  </div>
                  <div className="text-[10.5px] text-muted font-mono">
                    {[r.color, r.size, r.sku].filter(Boolean).join(" · ")}
                  </div>
                </div>
              ),
              csv: (r) => r.style_name,
            },
            {
              key: "from_store", label: "From", align: "left",
              render: (r) => <span className="text-[12px]">{r.from_store}</span>,
              csv: (r) => r.from_store,
            },
            {
              key: "__arrow", label: "", sortable: false, align: "left",
              render: () => <ArrowRight size={12} className="text-brand" weight="bold" />,
            },
            {
              key: "to_store", label: "To", align: "left",
              render: (r) => <span className="font-semibold text-[12px] text-brand">{r.to_store}</span>,
              csv: (r) => r.to_store,
            },
            {
              key: "received_qty", label: "Received", numeric: true,
              render: (r) => (
                <span className="num font-bold">
                  {fmtNum(r.received_qty)}
                  {r.received_qty !== r.qty && (
                    <span className="text-[10px] text-muted ml-1">/ {fmtNum(r.qty)} sent</span>
                  )}
                </span>
              ),
              csv: (r) => r.received_qty,
            },
            {
              key: "status", label: "Outcome", align: "left",
              render: (r) =>
                r.discrepancy ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                    <Warning size={11} weight="fill" /> Discrepancy
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                    <CheckCircle size={11} weight="fill" /> Received
                  </span>
                ),
              csv: (r) => (r.discrepancy ? "discrepancy" : "received"),
              sortValue: (r) => (r.discrepancy ? 1 : 0),
            },
            {
              key: "dispatch_ts", label: "Dispatched", numeric: false, align: "left",
              render: (r) => (
                <span className="text-[11.5px] text-muted">{(r.dispatch_ts || "").slice(0, 10)}</span>
              ),
              csv: (r) => (r.dispatch_ts || "").slice(0, 10),
              sortValue: (r) => r.dispatch_ts,
            },
            {
              key: "received_ts", label: "Received on", numeric: false, align: "left",
              render: (r) => (
                <span className="text-[11.5px] font-semibold">{(r.received_ts || "").slice(0, 10)}</span>
              ),
              csv: (r) => (r.received_ts || "").slice(0, 10),
              sortValue: (r) => r.received_ts,
            },
            {
              key: "days_lapsed", label: "Days lapsed", numeric: true,
              render: (r) => {
                const days = r.days_lapsed;
                if (days == null) return <span className="text-muted">—</span>;
                const cls = days <= 1 ? "pill-green" : days <= 3 ? "pill-amber" : "pill-red";
                return <span className={cls}>{fmtNum(days)} d</span>;
              },
              csv: (r) => r.days_lapsed,
            },
            {
              key: "odoo_transfer_id", label: "Odoo ref", align: "left",
              render: (r) =>
                r.odoo_transfer_id
                  ? <span className="font-mono text-[11px] bg-gray-100 px-1.5 py-0.5 rounded">{r.odoo_transfer_id}</span>
                  : <span className="text-muted text-[11px]">—</span>,
              csv: (r) => r.odoo_transfer_id || "",
            },
            {
              key: "received_by", label: "Received by", align: "left",
              render: (r) => <span className="text-[11.5px]">{r.received_by || "—"}</span>,
              csv: (r) => r.received_by || "",
            },
          ]}
        />
      )}
    </div>
  );
}
