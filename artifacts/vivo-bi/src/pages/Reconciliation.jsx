import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Scales, ArrowsClockwise, CheckCircle, XCircle, ArrowCounterClockwise, CloudArrowUp } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { Loading, ErrorBox, Empty } from "@/components/common";

// Odoo Reconciliation Agent — leadership + admin (server-gated via /api/recon).
// Four automatic matchers run nightly (and on demand): sales vs ledgers per
// store/day, POS collections (M-Pesa/card/cash) vs journals, unreconciled
// statement lines vs ledger candidates, and vendor bills vs payments.
// Suggest-and-approve: nothing is written back to Odoo without an explicit
// human approval here, and write-back targets ONLY the Odoo STAGING instance.

const TYPES = [
  { key: "sales_ledger", label: "Sales vs Ledger", desc: "Dashboard net sales vs Odoo sales journals, per store per day" },
  { key: "collections", label: "Collections", desc: "POS takings (M-Pesa / card / cash) vs bank & cash journals; cash compares by week" },
  { key: "bank", label: "Bank Lines", desc: "Unreconciled statement lines with suggested ledger matches" },
  { key: "payables", label: "Payables", desc: "Vendor bills vs payments — unpaid aging, mismatches, possible duplicates" },
];

const STATUS_META = {
  matched: { label: "Matched", cls: "bg-emerald-500/10 text-emerald-600" },
  variance: { label: "Variance", cls: "bg-amber-500/10 text-amber-600" },
  missing: { label: "Missing", cls: "bg-rose-500/10 text-rose-600" },
  suggested: { label: "Suggested", cls: "bg-sky-500/10 text-sky-600" },
  exception: { label: "Exception", cls: "bg-rose-500/10 text-rose-600" },
  approved: { label: "Approved", cls: "bg-brand/10 text-brand" },
  rejected: { label: "Rejected", cls: "bg-slate-500/10 text-slate-500" },
  written: { label: "Written", cls: "bg-violet-500/10 text-violet-600" },
};

const fmtKes = (v) =>
  v == null ? "—" : Number(v).toLocaleString("en-KE", { maximumFractionDigits: 0 });

const StatusPill = ({ status }) => {
  const m = STATUS_META[status] || { label: status, cls: "bg-slate-500/10 text-slate-500" };
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold ${m.cls}`}>{m.label}</span>;
};

function DetailsCell({ item }) {
  const d = item.details || {};
  const bits = [];
  if (d.review_note) bits.push(`Note: ${d.review_note}`);
  if (item.recon_type === "sales_ledger") {
    bits.push(`Dashboard ${fmtKes(item.amount_a)} vs ledger ${fmtKes(item.amount_b)}`);
  } else if (item.recon_type === "collections") {
    bits.push(`${d.method_class || ""} takings ${fmtKes(item.amount_a)} vs booked ${fmtKes(item.amount_b)}${d.grain === "week" ? " (week)" : ""}`);
  } else if (item.recon_type === "bank") {
    if (d.payment_ref) bits.push(d.payment_ref);
    if (d.candidate_label) bits.push(`→ ${d.candidate_label}`);
    if (d.llm_note) bits.push(`AI: ${d.llm_note}`);
  } else if (item.recon_type === "payables") {
    if (d.vendor) bits.push(d.vendor);
    if (d.bill_ref) bits.push(d.bill_ref);
    if (d.kind) bits.push(d.kind);
    if (d.payment_ref) bits.push(`→ ${d.payment_ref}`);
  }
  return <span className="text-[12px] text-muted">{bits.filter(Boolean).join(" · ") || "—"}</span>;
}

export default function Reconciliation() {
  const [summary, setSummary] = useState(null);
  const [sumError, setSumError] = useState(null);
  const [type, setType] = useState("collections");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [itemsError, setItemsError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [runBusy, setRunBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  const loadSummary = useCallback(() => {
    api.get("/recon/summary")
      .then((r) => { setSummary(r.data); setSumError(null); })
      .catch((e) => setSumError(e?.response?.data?.detail || e?.message || "Failed to load"));
  }, []);

  const loadItems = useCallback(() => {
    setItems(null);
    setItemsError(null);
    const params = { recon_type: type, limit: 300 };
    if (status) params.status = status;
    api.get("/recon/items", { params })
      .then((r) => { setItems(r.data.items); setTotal(r.data.total); })
      .catch((e) => setItemsError(e?.response?.data?.detail || e?.message || "Failed to load items"));
  }, [type, status]);

  useEffect(() => { loadSummary(); }, [loadSummary]);
  useEffect(() => { loadItems(); }, [loadItems]);

  const runNow = () => {
    setRunBusy(true);
    api.post("/recon/run")
      .then(() => flash("Reconciliation run started — refresh in a minute."))
      .catch((e) => flash(e?.response?.data?.detail || "Failed to start run"))
      .finally(() => setRunBusy(false));
  };

  const decide = (item, action) => {
    let note = null;
    if (action === "reject") {
      note = window.prompt("Optional note for this rejection:") ?? null;
      if (note === null) return; // cancelled
      note = note.trim() || null;
    }
    setBusyKey(item.item_key);
    api.post("/recon/decide", { item_key: item.item_key, action, note })
      .then(() => { loadItems(); loadSummary(); })
      .catch((e) => flash(e?.response?.data?.detail || `Failed to ${action}`))
      .finally(() => setBusyKey(null));
  };

  const writeback = (item) => {
    if (!window.confirm("Write this reconciliation to the Odoo STAGING instance?")) return;
    setBusyKey(item.item_key);
    api.post("/recon/writeback", { item_key: item.item_key })
      .then(() => { flash("Written to Odoo staging."); loadItems(); loadSummary(); })
      .catch((e) => flash(e?.response?.data?.detail || "Write-back failed"))
      .finally(() => setBusyKey(null));
  };

  const lastRun = summary?.last_run;
  const writebackReady = !!summary?.writeback_configured;
  const typeSummary = summary?.summary?.[type] || {};
  const statusKeys = useMemo(() => {
    const order = ["exception", "suggested", "variance", "missing", "approved", "matched", "written", "rejected"];
    return order.filter((s) => typeSummary[s]);
  }, [typeSummary]);

  const canWriteback = (it) =>
    it.status === "approved" && (it.item_key.startsWith("bank|") || it.item_key.startsWith("bill|"));

  return (
    <div className="space-y-5" data-testid="recon-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight flex items-center gap-2">
            <Scales size={22} weight="duotone" className="text-brand" />
            Odoo Reconciliation
          </h1>
          <p className="text-[13px] text-muted mt-1">
            Automatic matching of sales, collections, bank lines and payables against Odoo.
            Nothing is written back without your approval; write-back targets the Odoo <span className="font-semibold">staging</span> instance only.
          </p>
          {lastRun && (
            <p className="text-[12px] text-muted mt-1">
              Last run: {lastRun.finished_at ? new Date(lastRun.finished_at).toLocaleString() : "running…"} · {lastRun.trigger}
              {lastRun.status === "failed" && <span className="text-rose-500 font-medium"> · failed</span>}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!writebackReady && (
            <span className="px-2 py-1 rounded-md text-[11px] font-medium bg-amber-500/10 text-amber-600"
              title="ODOO_WRITE_* secrets not set — approvals still work; write-back is disabled until the staging target is configured.">
              Write-back not configured
            </span>
          )}
          <button
            onClick={runNow}
            disabled={runBusy || summary?.run_in_progress}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand text-white text-[13px] font-semibold disabled:opacity-50"
            data-testid="recon-run-now"
          >
            <ArrowsClockwise size={15} weight="bold" className={summary?.run_in_progress ? "animate-spin" : ""} />
            {summary?.run_in_progress ? "Running…" : "Run now"}
          </button>
        </div>
      </div>

      {toast && (
        <div className="px-3 py-2 rounded-lg bg-brand/10 text-brand text-[13px] font-medium" data-testid="recon-toast">{toast}</div>
      )}
      {sumError && <ErrorBox message={sumError} />}

      <div className="flex flex-wrap gap-2">
        {TYPES.map((t) => {
          const s = summary?.summary?.[t.key] || {};
          const attention = ["exception", "suggested", "variance", "missing"].reduce((n, k) => n + (s[k]?.count || 0), 0);
          return (
            <button
              key={t.key}
              onClick={() => { setType(t.key); setStatus(""); }}
              title={t.desc}
              className={`px-3 py-2 rounded-xl border text-left transition ${type === t.key ? "border-brand bg-brand/5" : "border-border bg-card hover:border-brand/40"}`}
              data-testid={`recon-tab-${t.key}`}
            >
              <div className="text-[13px] font-semibold">{t.label}</div>
              <div className="text-[11px] text-muted">
                {attention > 0 ? `${attention.toLocaleString()} to review` : summary ? "all clear" : "…"}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setStatus("")}
          className={`px-2.5 py-1 rounded-full text-[12px] font-medium border ${status === "" ? "border-brand text-brand bg-brand/5" : "border-border text-muted"}`}
        >
          All ({Object.values(typeSummary).reduce((n, v) => n + v.count, 0).toLocaleString()})
        </button>
        {statusKeys.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`px-2.5 py-1 rounded-full text-[12px] font-medium border ${status === s ? "border-brand text-brand bg-brand/5" : "border-border text-muted"}`}
            data-testid={`recon-status-${s}`}
          >
            {(STATUS_META[s]?.label || s)} ({typeSummary[s].count.toLocaleString()})
          </button>
        ))}
      </div>

      {itemsError ? (
        <ErrorBox message={itemsError} />
      ) : items === null ? (
        <Loading label="Loading reconciliation items…" />
      ) : items.length === 0 ? (
        <Empty label="No items for this filter." />
      ) : (
        <div className="rounded-xl border border-border overflow-x-auto bg-card">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted border-b border-border">
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Store / Ref</th>
                <th className="px-3 py-2">Day</th>
                <th className="px-3 py-2 text-right">Side A (KES)</th>
                <th className="px-3 py-2 text-right">Side B (KES)</th>
                <th className="px-3 py-2 text-right">Diff (KES)</th>
                <th className="px-3 py-2">Detail</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.item_key} className="border-b border-border/60 last:border-0 align-top">
                  <td className="px-3 py-2"><StatusPill status={it.status} /></td>
                  <td className="px-3 py-2 font-medium">{it.store || (it.details?.vendor ?? "—")}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{it.day ? it.day.slice(0, 10) : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtKes(it.amount_a)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtKes(it.amount_b)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${Math.abs(it.diff || 0) > 1 ? "text-rose-500" : ""}`}>{fmtKes(it.diff)}</td>
                  <td className="px-3 py-2 max-w-[340px]"><DetailsCell item={it} /></td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {it.status === "suggested" && (
                      <button
                        onClick={() => decide(it, "approve")}
                        disabled={busyKey === it.item_key}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-semibold text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50"
                        data-testid={`recon-approve-${it.item_key}`}
                      >
                        <CheckCircle size={14} weight="bold" /> Approve
                      </button>
                    )}
                    {["suggested", "variance", "missing", "exception"].includes(it.status) && (
                      <button
                        onClick={() => decide(it, "reject")}
                        disabled={busyKey === it.item_key}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-semibold text-slate-500 hover:bg-slate-500/10 disabled:opacity-50"
                      >
                        <XCircle size={14} weight="bold" /> Dismiss
                      </button>
                    )}
                    {["approved", "rejected"].includes(it.status) && (
                      <button
                        onClick={() => decide(it, "reopen")}
                        disabled={busyKey === it.item_key}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-semibold text-muted hover:bg-slate-500/10 disabled:opacity-50"
                      >
                        <ArrowCounterClockwise size={14} weight="bold" /> Reopen
                      </button>
                    )}
                    {canWriteback(it) && (
                      <button
                        onClick={() => writeback(it)}
                        disabled={busyKey === it.item_key || !writebackReady}
                        title={writebackReady ? "Write to Odoo staging" : "Write-back not configured (ODOO_WRITE_* secrets)"}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-semibold text-violet-600 hover:bg-violet-500/10 disabled:opacity-50"
                        data-testid={`recon-writeback-${it.item_key}`}
                      >
                        <CloudArrowUp size={14} weight="bold" /> Write to staging
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > items.length && (
            <div className="px-3 py-2 text-[12px] text-muted border-t border-border">
              Showing {items.length.toLocaleString()} of {total.toLocaleString()} — narrow with a status filter.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
