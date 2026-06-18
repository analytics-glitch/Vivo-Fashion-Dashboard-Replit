import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCcw, AlertTriangle, ShieldAlert, Users } from "lucide-react";
import {
  TicketDetail,
  Pill,
  SlaCell,
  errOf,
  titleCase,
  fmtDate,
  PRIORITY_COLORS,
  STATUS_COLORS,
  ESC_COLORS,
  ESCALATION_LADDER,
} from "@/pages/Service";

const selCls =
  "h-8 rounded-sm border border-[var(--vivo-border)] bg-white px-1.5 text-[12px] text-[var(--vivo-text)] focus:outline-none focus:ring-1 focus:ring-[var(--vivo-navy)]";
const PRIORITIES = ["low", "normal", "high", "critical"];
const STATUSES = ["open", "resolved", "closed"];

export default function TeamQueue() {
  const [status, setStatus] = useState("open");
  const [escalation, setEscalation] = useState("");
  const [brand, setBrand] = useState("");
  const [assignee, setAssignee] = useState("");
  const [breachedOnly, setBreachedOnly] = useState(false);
  const [rows, setRows] = useState([]);
  const [team, setTeam] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detailId, setDetailId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .get("/crm/tickets", {
        params: {
          status: status || undefined,
          escalation_level: escalation || undefined,
          brand: brand || undefined,
          assigned_to: assignee || undefined,
        },
      })
      .then((r) => setRows(r.data?.tickets || []))
      .catch((e) => setError(errOf(e)))
      .finally(() => setLoading(false));
  }, [status, escalation, brand, assignee]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api
      .get("/crm/team")
      .then((r) => setTeam(r.data?.team || []))
      .catch(() => setTeam([]));
  }, []);

  const isBreached = (t) =>
    t.sla_overdue || (t.sla_breached && !["resolved", "closed"].includes(t.status));

  const visibleRows = useMemo(
    () => (breachedOnly ? rows.filter(isBreached) : rows),
    [rows, breachedOnly],
  );
  const breachCount = useMemo(() => rows.filter(isBreached).length, [rows]);

  const patch = (id, body) =>
    api
      .patch(`/crm/tickets/${id}`, body)
      .then(() => load())
      .catch((e) => {
        setError(errOf(e));
        load();
      });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-[var(--vivo-navy)]">Team Lead queue</h1>
          <p className="text-sm text-[var(--vivo-muted)]">
            All-brand triage — reassign, reprioritise and close. Breaches are highlighted.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {breachCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-sm bg-[#DC26261A] px-2.5 py-1 text-[12.5px] font-semibold text-[#DC2626]">
              <ShieldAlert className="h-3.5 w-3.5" />
              {breachCount} breaching SLA
            </span>
          )}
          <Button
            variant="outline"
            className="press-effect h-9 gap-1.5"
            onClick={load}
            data-testid="button-refresh-queue"
          >
            <RefreshCcw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="vivo-pill-tabs flex rounded-sm border border-[var(--vivo-border)] bg-[var(--vivo-bg-soft)] p-0.5">
          {[
            ["open", "Open"],
            ["resolved", "Resolved"],
            ["closed", "Closed"],
            ["", "All"],
          ].map(([val, label]) => (
            <button
              key={val || "all"}
              onClick={() => setStatus(val)}
              className={`rounded-sm px-3 py-1.5 text-[12.5px] font-semibold transition ${
                status === val
                  ? "bg-white text-[var(--vivo-navy)] shadow-sm"
                  : "text-[var(--vivo-muted)]"
              }`}
              data-testid={`tab-status-${val || "all"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          value={escalation}
          onChange={(e) => setEscalation(e.target.value)}
          className={`${selCls} h-8 ml-1`}
          aria-label="Filter by escalation"
        >
          <option value="">All escalation levels</option>
          {ESCALATION_LADDER.map((e) => (
            <option key={e} value={e}>
              {titleCase(e)}
            </option>
          ))}
        </select>
        <select
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          className={`${selCls} h-8`}
          aria-label="Filter by brand"
        >
          <option value="">All brands</option>
          <option value="vivo">Vivo</option>
          <option value="sz">Shop Zetu</option>
        </select>
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className={`${selCls} h-8`}
          aria-label="Filter by assignee"
        >
          <option value="">All assignees</option>
          {team.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.name || m.email}
            </option>
          ))}
        </select>
        <label className="ml-1 inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-[var(--vivo-text)]">
          <input
            type="checkbox"
            checked={breachedOnly}
            onChange={(e) => setBreachedOnly(e.target.checked)}
          />
          Breaches only
        </label>
      </div>

      <Card className="vivo-card overflow-x-auto rounded-sm p-0">
        {loading ? (
          <div className="py-12 text-center text-sm text-[var(--vivo-muted)]">Loading queue…</div>
        ) : error ? (
          <div className="m-4 rounded-sm border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-sm text-[var(--vivo-muted)]">
            <Users className="h-5 w-5" />
            No tickets in this view.
          </div>
        ) : (
          <table className="min-w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--vivo-border)] text-left text-[11px] uppercase tracking-wide text-[var(--vivo-muted)]">
                <th className="px-3 py-2.5 font-semibold">Ticket</th>
                <th className="px-3 py-2.5 font-semibold">Customer</th>
                <th className="px-3 py-2.5 font-semibold">Channel</th>
                <th className="px-3 py-2.5 font-semibold">SLA</th>
                <th className="px-3 py-2.5 font-semibold">Escalation</th>
                <th className="px-3 py-2.5 font-semibold">Assignee</th>
                <th className="px-3 py-2.5 font-semibold">Priority</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((t) => (
                <tr
                  key={t.id}
                  className={`cursor-pointer border-b border-[var(--vivo-border)]/60 hover:bg-[var(--vivo-bg-soft)] ${
                    isBreached(t) ? "bg-[#DC26260D]" : ""
                  }`}
                  onClick={() => setDetailId(t.id)}
                  data-testid={`row-ticket-${t.id}`}
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5 font-medium text-[var(--vivo-navy)]">
                      {isBreached(t) && <AlertTriangle className="h-3.5 w-3.5 text-[#DC2626]" />}
                      {t.ticket_number}
                    </div>
                    <div className="text-[11px] text-[var(--vivo-muted)]">
                      {t.subject}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[var(--vivo-text)]">
                    {t.customer_name || "—"}
                    {t.is_complaint && (
                      <Pill color="#DC2626">{titleCase(t.issue_category)}</Pill>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-[var(--vivo-text)]">
                    {titleCase(t.inbound_channel)}
                  </td>
                  <td className="px-3 py-2.5">
                    <SlaCell t={t} />
                  </td>
                  <td className="px-3 py-2.5">
                    <Pill color={ESC_COLORS[t.escalation_level] || "#6B7280"}>
                      {titleCase(t.escalation_level || "associate")}
                    </Pill>
                  </td>
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={t.assigned_to || ""}
                      onChange={(e) => patch(t.id, { assigned_to: e.target.value || null })}
                      className={selCls}
                      data-testid={`select-assignee-${t.id}`}
                    >
                      <option value="">Unassigned</option>
                      {team.map((m) => (
                        <option key={m.user_id} value={m.user_id}>
                          {m.name || m.email}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={t.priority || "normal"}
                      onChange={(e) => patch(t.id, { priority: e.target.value })}
                      className={selCls}
                      style={{ color: PRIORITY_COLORS[t.priority] || undefined }}
                      data-testid={`select-priority-${t.id}`}
                    >
                      {PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {titleCase(p)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={t.status || "open"}
                      onChange={(e) => patch(t.id, { status: e.target.value })}
                      className={selCls}
                      style={{ color: STATUS_COLORS[t.status] || undefined }}
                      data-testid={`select-status-${t.id}`}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {titleCase(s)}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {detailId != null && (
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
