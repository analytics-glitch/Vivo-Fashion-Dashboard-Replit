import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  LifeBuoy,
  Plus,
  RefreshCcw,
  AlertTriangle,
  ArrowUpRight,
  Clock,
  ShieldAlert,
} from "lucide-react";

const COMPLAINT_CATEGORIES = [
  "product_quality",
  "sizing",
  "delivery",
  "returns",
  "staff_conduct",
];
export const CHANNELS = ["whatsapp", "meta", "tiktok", "email", "in_store", "phone"];
export const ESCALATION_LADDER = ["associate", "team_lead", "head_of_cx"];

export const errOf = (e) =>
  e?.response?.data?.detail || e?.message || "Something went wrong";

export const titleCase = (s) =>
  (s || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

export const fmtDate = (s) => {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return s;
  }
};

export const PRIORITY_COLORS = {
  low: "#6B7280",
  normal: "#0F4D31",
  high: "#ED7C2A",
  critical: "#DC2626",
};
export const STATUS_COLORS = {
  open: "#ED7C2A",
  resolved: "#0F4D31",
  closed: "#6B7280",
};
export const ESC_COLORS = {
  associate: "#6B7280",
  team_lead: "#ED7C2A",
  head_of_cx: "#DC2626",
};

export function Pill({ color = "#6B7280", children }) {
  return (
    <span
      className="inline-flex items-center rounded-sm px-2 py-0.5 text-[11px] font-semibold capitalize"
      style={{ color, backgroundColor: `${color}1A` }}
    >
      {children}
    </span>
  );
}

// Remaining SLA budget rendered as a human countdown / breach badge.
export function SlaCell({ t }) {
  if (t.status === "resolved" || t.status === "closed") {
    return t.sla_breached ? (
      <Pill color="#DC2626">Breached</Pill>
    ) : (
      <Pill color="#0F4D31">Met</Pill>
    );
  }
  if (t.sla_overdue || t.sla_breached) return <Pill color="#DC2626">Overdue</Pill>;
  if (!t.sla_due_at) return <span className="text-[var(--vivo-muted)]">—</span>;
  const ms = new Date(t.sla_due_at).getTime() - Date.now();
  if (ms <= 0) return <Pill color="#DC2626">Overdue</Pill>;
  const mins = Math.round(ms / 60000);
  const label =
    mins >= 1440
      ? `${Math.round(mins / 1440)}d left`
      : mins >= 60
        ? `${Math.round(mins / 60)}h left`
        : `${mins}m left`;
  const color = mins <= 60 ? "#ED7C2A" : "#0F4D31";
  return (
    <span className="inline-flex items-center gap-1 text-[12px]" style={{ color }}>
      <Clock className="h-3 w-3" />
      {label}
    </span>
  );
}

const inputCls =
  "h-9 w-full rounded-sm border border-[var(--vivo-border)] bg-white px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--vivo-navy)]";

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">
        {label}
      </div>
      {children}
    </label>
  );
}

// --- New ticket modal -------------------------------------------------------
function CreateTicketModal({ open, onClose, team, onCreated }) {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open)
      setForm({ inbound_channel: "in_store", priority: "normal", brand_code: "vivo" });
  }, [open]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => {
    if (!form.subject?.trim()) {
      toast.error("Subject is required");
      return;
    }
    setSaving(true);
    api
      .post("/crm/tickets", form)
      .then((r) => {
        toast.success(`Ticket ${r.data?.ticket_number} created`);
        if (r.data?.repeat_complaint)
          toast.warning("Repeat complaint flagged on this customer");
        if (r.data?.escalation_level === "head_of_cx")
          toast.warning("Auto-escalated to Head of CX (Gold/VIP complaint)");
        onCreated();
      })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setSaving(false));
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl rounded-sm">
        <DialogHeader>
          <DialogTitle>New service ticket</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Subject">
            <Input
              className={inputCls}
              value={form.subject || ""}
              onChange={(e) => set("subject", e.target.value)}
            />
          </Field>
          <Field label="Description">
            <textarea
              className={`${inputCls} h-auto py-2`}
              rows={2}
              value={form.description || ""}
              onChange={(e) => set("description", e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Customer ID (optional)">
              <Input
                className={inputCls}
                value={form.customer_id || ""}
                onChange={(e) => set("customer_id", e.target.value)}
              />
            </Field>
            <Field label="Issue category">
              <select
                className={inputCls}
                value={form.issue_category || ""}
                onChange={(e) => set("issue_category", e.target.value)}
              >
                <option value="">General enquiry</option>
                <optgroup label="Complaints">
                  {COMPLAINT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {titleCase(c)}
                    </option>
                  ))}
                </optgroup>
                <option value="other">Other</option>
              </select>
            </Field>
            <Field label="Product SKU (optional)">
              <Input
                className={inputCls}
                value={form.product_sku || ""}
                onChange={(e) => set("product_sku", e.target.value)}
                placeholder="Link to product for merchandising"
              />
            </Field>
            <Field label="Inbound channel">
              <select
                className={inputCls}
                value={form.inbound_channel}
                onChange={(e) => set("inbound_channel", e.target.value)}
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {titleCase(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select
                className={inputCls}
                value={form.priority}
                onChange={(e) => set("priority", e.target.value)}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </Field>
            <Field label="Brand">
              <select
                className={inputCls}
                value={form.brand_code}
                onChange={(e) => set("brand_code", e.target.value)}
              >
                <option value="vivo">Vivo</option>
                <option value="sz">Shop Zetu</option>
              </select>
            </Field>
            <Field label="Assign to">
              <select
                className={inputCls}
                value={form.assigned_to || ""}
                onChange={(e) => set("assigned_to", e.target.value)}
              >
                <option value="">Unassigned</option>
                {team.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name || m.email}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy)]/90"
            onClick={submit}
            disabled={saving}
          >
            {saving ? "Saving…" : "Create ticket"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- Ticket detail / workspace ---------------------------------------------
export function TicketDetail({ ticketId, team, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .get(`/crm/tickets/${ticketId}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, [ticketId]);

  useEffect(() => {
    load();
  }, [load]);

  const t = data?.ticket;
  const isComplaint =
    t && COMPLAINT_CATEGORIES.includes((t.issue_category || "").toLowerCase());
  const atTopLevel = (t?.escalation_level || "associate") === "head_of_cx";
  const isClosed = t?.status === "resolved" || t?.status === "closed";

  const patch = (payload, okMsg) => {
    setBusy(true);
    api
      .patch(`/crm/tickets/${ticketId}`, payload)
      .then((r) => {
        if (okMsg) toast.success(okMsg);
        if (r.data?.notified?.channel)
          toast.success(`Customer notified via ${r.data.notified.channel}`);
        load();
        onChanged?.();
      })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setBusy(false));
  };

  const send = () => {
    if (!msg.trim()) return;
    setBusy(true);
    api
      .post(`/crm/tickets/${ticketId}/messages`, { body: msg, direction: "outbound" })
      .then(() => {
        setMsg("");
        load();
      })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setBusy(false));
  };

  const escalate = () => {
    const reason = window.prompt("Escalation reason (optional):") || undefined;
    setBusy(true);
    api
      .post(`/crm/tickets/${ticketId}/escalate`, reason ? { reason } : {})
      .then((r) => {
        toast.success(`Escalated to ${titleCase(r.data?.escalation_level)}`);
        load();
        onChanged?.();
      })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setBusy(false));
  };

  const captureCsat = (score) => {
    setBusy(true);
    api
      .post("/crm/csat/respond", { ticket_id: ticketId, score })
      .then(() => {
        toast.success(`CSAT ${score}/5 recorded`);
        load();
        onChanged?.();
      })
      .catch((e) => toast.error(errOf(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl rounded-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t ? (
              <>
                <span>{t.ticket_number}</span>
                <Pill color={STATUS_COLORS[t.status] || "#6B7280"}>{t.status}</Pill>
              </>
            ) : (
              "Ticket"
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-10 text-center text-sm text-[var(--vivo-muted)]">
            Loading ticket…
          </div>
        ) : error ? (
          <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        ) : t ? (
          <div className="space-y-3">
            <div className="text-[15px] font-semibold text-[var(--vivo-text)]">
              {t.subject}
            </div>
            <div className="text-[12px] text-[var(--vivo-muted)]">
              {titleCase(t.inbound_channel)} · created {fmtDate(t.created_at)} · SLA
              target {t.sla_target_minutes} min
              {t.sla_breached && (
                <span className="ml-2 font-semibold text-red-600">SLA breached</span>
              )}
              {t.product_sku && <span className="ml-2">· SKU {t.product_sku}</span>}
            </div>

            {(isComplaint ||
              (t.escalation_level && t.escalation_level !== "associate")) && (
              <div className="flex flex-wrap items-center gap-2 rounded-sm border border-[var(--vivo-border)] bg-[var(--vivo-bg-soft)] p-2 text-[12px]">
                {isComplaint && (
                  <span className="inline-flex items-center gap-1 font-semibold text-red-600">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    {titleCase(t.issue_category || "complaint")}
                  </span>
                )}
                <span className="text-[var(--vivo-muted)]">Escalation:</span>
                <Pill color={ESC_COLORS[t.escalation_level] || "#6B7280"}>
                  {titleCase(t.escalation_level || "associate")}
                </Pill>
                {t.escalation_reason && (
                  <span className="text-[11px] text-[var(--vivo-muted)]">
                    ({t.escalation_reason})
                  </span>
                )}
                {isComplaint && !atTopLevel && !isClosed && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7"
                    onClick={escalate}
                    disabled={busy}
                  >
                    <ArrowUpRight className="mr-1 h-3.5 w-3.5" />
                    Escalate
                  </Button>
                )}
              </div>
            )}

            {/* Thread */}
            <div className="max-h-[34vh] space-y-2 overflow-y-auto rounded-sm bg-[var(--vivo-bg-soft)] p-3">
              {data.messages?.length ? (
                data.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`rounded-sm p-2 text-[12.5px] ${
                      m.direction === "inbound"
                        ? "bg-white"
                        : m.direction === "internal"
                          ? "bg-amber-50"
                          : "bg-[var(--vivo-navy)]/10"
                    }`}
                  >
                    <div className="flex justify-between text-[11px] text-[var(--vivo-muted)]">
                      <span className="capitalize">
                        {m.direction} · {m.sender_name}
                      </span>
                      <span>{fmtDate(m.created_at)}</span>
                    </div>
                    <div className="mt-0.5 whitespace-pre-wrap">{m.body}</div>
                  </div>
                ))
              ) : (
                <div className="py-4 text-center text-[12px] text-[var(--vivo-muted)]">
                  No messages yet.
                </div>
              )}
            </div>

            {/* Reply */}
            <div className="flex gap-2">
              <Input
                className={inputCls}
                placeholder="Type a reply…"
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
              />
              <Button
                className="bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy)]/90"
                onClick={send}
                disabled={busy}
              >
                Send
              </Button>
            </div>

            {/* Workspace controls */}
            <div className="grid grid-cols-3 gap-3 border-t border-[var(--vivo-border)] pt-3">
              <Field label="Status">
                <select
                  className={inputCls}
                  value={t.status}
                  onChange={(e) =>
                    patch({ status: e.target.value }, "Status updated")
                  }
                  disabled={busy}
                >
                  <option value="open">Open</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </select>
              </Field>
              <Field label="Priority">
                <select
                  className={inputCls}
                  value={t.priority}
                  onChange={(e) =>
                    patch({ priority: e.target.value }, "Priority updated")
                  }
                  disabled={busy}
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </Field>
              <Field label="Assigned to">
                <select
                  className={inputCls}
                  value={t.assigned_to || ""}
                  onChange={(e) =>
                    patch({ assigned_to: e.target.value }, "Reassigned")
                  }
                  disabled={busy}
                >
                  <option value="">Unassigned</option>
                  {team.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.name || m.email}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {/* CSAT capture (after resolve/close) */}
            {isClosed && (
              <div className="flex flex-wrap items-center gap-2 rounded-sm border border-[var(--vivo-border)] bg-[var(--vivo-bg-soft)] p-3">
                <span className="text-[12px] font-semibold text-[var(--vivo-text)]">
                  {t.csat_score
                    ? `CSAT recorded: ${t.csat_score}/5`
                    : "Capture CSAT (1–5):"}
                </span>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    onClick={() => captureCsat(n)}
                    disabled={busy}
                    className={`h-8 w-8 rounded-sm border text-[13px] font-semibold press-effect ${
                      t.csat_score === n
                        ? "border-[var(--vivo-navy)] bg-[var(--vivo-navy)] text-white"
                        : "border-[var(--vivo-border)] bg-white text-[var(--vivo-text)] hover:bg-[var(--vivo-bg)]"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// --- Page -------------------------------------------------------------------
export default function Service() {
  const [status, setStatus] = useState("open");
  const [complaintsOnly, setComplaintsOnly] = useState(false);
  const [priority, setPriority] = useState("");
  const [rows, setRows] = useState([]);
  const [team, setTeam] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .get("/crm/tickets", {
        params: {
          status: status || undefined,
          complaints_only: complaintsOnly ? 1 : undefined,
        },
      })
      .then((r) => setRows(r.data?.tickets || []))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, [status, complaintsOnly]);

  useEffect(() => {
    load();
  }, [load]);

  // Priority is filtered client-side (the list endpoint has no priority param).
  const visibleRows = useMemo(
    () => (priority ? rows.filter((t) => t.priority === priority) : rows),
    [rows, priority],
  );

  useEffect(() => {
    api
      .get("/crm/team")
      .then((r) => setTeam(r.data?.team || []))
      .catch(() => setTeam([]));
  }, []);

  const breaches = useMemo(
    () =>
      rows.filter(
        (t) =>
          (t.sla_overdue || t.sla_breached) &&
          t.status !== "resolved" &&
          t.status !== "closed",
      ).length,
    [rows],
  );

  return (
    <div className="px-4 py-5 sm:px-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <LifeBuoy className="h-5 w-5 text-[var(--vivo-navy)]" />
          <h1 className="font-display text-2xl text-[var(--vivo-navy)]">
            Service desk
          </h1>
        </div>
        {breaches > 0 && (
          <span className="inline-flex items-center gap-1 rounded-sm bg-red-50 px-2 py-1 text-[12px] font-semibold text-red-600">
            <AlertTriangle className="h-3.5 w-3.5" />
            {breaches} SLA {breaches === 1 ? "breach" : "breaches"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" onClick={load} disabled={loading}>
            <RefreshCcw
              className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button
            className="bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy)]/90"
            onClick={() => setShowCreate(true)}
          >
            <Plus className="mr-2 h-4 w-4" />
            New ticket
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {[
          ["open", "Open"],
          ["resolved", "Resolved"],
          ["closed", "Closed"],
          ["", "All"],
        ].map(([s, label]) => (
          <button
            key={s || "all"}
            onClick={() => setStatus(s)}
            className={`rounded-sm px-3 py-1.5 text-[12.5px] font-semibold press-effect ${
              status === s
                ? "bg-[var(--vivo-navy)] text-white"
                : "border border-[var(--vivo-border)] bg-white text-[var(--vivo-muted)]"
            }`}
          >
            {label}
          </button>
        ))}
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="ml-2 h-8 rounded-sm border border-[var(--vivo-border)] bg-white px-2 text-[12.5px] text-[var(--vivo-text)]"
          aria-label="Filter by priority"
        >
          <option value="">All priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <label className="ml-2 inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-[var(--vivo-text)]">
          <input
            type="checkbox"
            checked={complaintsOnly}
            onChange={(e) => setComplaintsOnly(e.target.checked)}
          />
          Complaints only
        </label>
      </div>

      <Card className="vivo-card overflow-x-auto rounded-sm p-0">
        {loading ? (
          <div className="py-12 text-center text-sm text-[var(--vivo-muted)]">
            Loading tickets…
          </div>
        ) : error ? (
          <div className="m-4 rounded-sm border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="py-12 text-center text-sm text-[var(--vivo-muted)]">
            No tickets in this view.
          </div>
        ) : (
          <table className="min-w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--vivo-border)] text-left text-[11px] uppercase tracking-wide text-[var(--vivo-muted)]">
                <th className="px-3 py-2.5 font-semibold">Ticket</th>
                <th className="px-3 py-2.5 font-semibold">Channel</th>
                <th className="px-3 py-2.5 font-semibold">Priority</th>
                <th className="px-3 py-2.5 font-semibold">Escalation</th>
                <th className="px-3 py-2.5 font-semibold">Assigned</th>
                <th className="px-3 py-2.5 font-semibold">SLA</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                <th className="px-3 py-2.5 font-semibold">CSAT</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((t) => (
                <tr
                  key={t.id}
                  className="cursor-pointer border-b border-[var(--vivo-border)]/60 hover:bg-[var(--vivo-bg-soft)]"
                  onClick={() => setDetailId(t.id)}
                >
                  <td className="px-3 py-2.5">
                    <div className="font-semibold text-[var(--vivo-text)]">
                      {t.ticket_number}
                    </div>
                    <div className="text-[11.5px] text-[var(--vivo-muted)]">
                      {t.subject}
                    </div>
                    {t.customer_name && (
                      <div className="text-[11px] text-[var(--vivo-muted)]">
                        {t.customer_name}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 capitalize">
                    {titleCase(t.inbound_channel)}
                  </td>
                  <td className="px-3 py-2.5">
                    <Pill color={PRIORITY_COLORS[t.priority] || "#6B7280"}>
                      {t.priority}
                    </Pill>
                  </td>
                  <td className="px-3 py-2.5">
                    {t.is_complaint ||
                    (t.escalation_level && t.escalation_level !== "associate") ? (
                      <Pill color={ESC_COLORS[t.escalation_level] || "#6B7280"}>
                        {titleCase(t.escalation_level || "associate")}
                      </Pill>
                    ) : (
                      <span className="text-[var(--vivo-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {t.assigned_to_name || (
                      <span className="text-[var(--vivo-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <SlaCell t={t} />
                  </td>
                  <td className="px-3 py-2.5">
                    <Pill color={STATUS_COLORS[t.status] || "#6B7280"}>
                      {t.status}
                    </Pill>
                  </td>
                  <td className="px-3 py-2.5">
                    {t.csat_score ? (
                      <span className="font-semibold text-[var(--vivo-navy)]">
                        {t.csat_score}/5
                      </span>
                    ) : (
                      <span className="text-[var(--vivo-muted)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <CreateTicketModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        team={team}
        onCreated={() => {
          setShowCreate(false);
          load();
        }}
      />
      {detailId && (
        <TicketDetail
          ticketId={detailId}
          team={team}
          onClose={() => setDetailId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
