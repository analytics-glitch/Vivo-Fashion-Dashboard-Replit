import React, { useEffect, useMemo, useState } from "react";
import { Sheet, SheetContent } from "./ui/sheet";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  vivoClient,
  todayISO,
  formatHHMM,
  expandBranchName,
  rebrandHQRow,
  HQ_LABEL,
} from "../lib/api";
import { useNavigate } from "react-router-dom";
import {
  Building2,
  Wifi,
  WifiOff,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ArrowRight,
  FileDown,
  Loader2,
} from "lucide-react";
import { exportToExcel } from "../lib/exports";

const COUNTRY_NAMES = { KE: "Kenya", UG: "Uganda", RW: "Rwanda" };

function KpiTile({ label, value, sub, tone = "default", icon: Icon, testId }) {
  const tones = {
    default: { wrap: "border-border bg-white/70", icon: "bg-accent-soft text-accent-deep" },
    brand:   { wrap: "border-brand bg-white",     icon: "bg-brand text-background" },
    warning: { wrap: "border-border bg-white/70", icon: "bg-warning/15 text-accent-deep" },
    danger:  { wrap: "border-border bg-white/70", icon: "bg-danger/15 text-danger" },
  };
  const t = tones[tone] || tones.default;
  return (
    <div className={`rounded-2xl border p-3 ${t.wrap}`} data-testid={testId}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="eyebrow text-[9.5px]">{label}</div>
          <div className="mt-1 font-extrabold text-[22px] leading-none tabular-nums text-brand-deep">{value}</div>
          {sub && <div className="mt-1 text-[10px] text-muted-foreground">{sub}</div>}
        </div>
        {Icon && (
          <div className={`grid h-7 w-7 place-items-center rounded-full ${t.icon}`}>
            <Icon className="h-3.5 w-3.5" />
          </div>
        )}
      </div>
    </div>
  );
}

export default function BranchDetailSheet({ open, onOpenChange, branch, allBranches = [], date = null }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const navigate = useNavigate();
  const targetDate = date || todayISO();
  const isHistorical = !!date && date !== todayISO();

  useEffect(() => {
    if (!open || !branch) return;
    setLoading(true); setErr(""); setRows([]);
    const sources = expandBranchName(branch.branch_name, allBranches);
    Promise.all(
      sources.map((s) =>
        vivoClient
          .get("/branch-detail", { params: { branch: s, date_from: targetDate, date_to: targetDate } })
          .then((r) => r.data || [])
          .catch(() => [])
      )
    )
      .then((batches) => {
        const merged = batches.flat().map(rebrandHQRow);
        // sort by check_in_time ASC; missing-check-in (null) at the bottom
        merged.sort((a, b) => {
          const av = a.check_in_time ? new Date(a.check_in_time).getTime() : Infinity;
          const bv = b.check_in_time ? new Date(b.check_in_time).getTime() : Infinity;
          return av - bv;
        });
        setRows(merged);
      })
      .catch((e) => setErr(e?.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [open, branch, allBranches, targetDate]);

  const stats = useMemo(() => {
    const present = rows.filter((r) => r.attendance_status === "Present").length;
    const missingCheckout = rows.filter((r) => r.attendance_status === "Missing Check-Out").length;
    const absent = rows.filter((r) => r.attendance_status === "Absent").length;
    const late = rows.filter((r) => r.is_late).length;
    const completed = rows.filter((r) => r.is_complete);
    const avgHours = completed.length ? completed.reduce((a, r) => a + (r.hours_worked || 0), 0) / completed.length : 0;
    const total = rows.length || (branch?.total_employees || 0);
    return { present, missingCheckout, absent, late, avgHours, total };
  }, [rows, branch]);

  const exportXLS = () => {
    exportToExcel(
      rows.map((r) => ({
        Time: formatHHMM(r.check_in_time),
        Employee: r.employee_name,
        Branch: r.branch_name,
        "Check-Out": formatHHMM(r.check_out_time),
        "Hours Worked": r.hours_worked ?? "",
        Status: r.attendance_status,
        Late: r.is_late ? "Yes" : "",
      })),
      `${(branch?.branch_name || "branch").replace(/\s+/g, "-")}-checkins-${targetDate}.xlsx`,
      "Today"
    );
  };

  const goDeepDive = () => {
    onOpenChange(false);
    navigate("/branches");
  };

  if (!branch) return null;
  const online = (branch.device_status || "").toLowerCase() === "online";
  const isHQ = branch.branch_name === HQ_LABEL;
  const countryName = COUNTRY_NAMES[branch.branch_country] || branch.branch_country;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl p-0 overflow-y-auto scrollbar-thin"
        style={{ background: "hsl(var(--accent-soft))" }}
        data-testid="branch-detail-sheet"
      >
        <VisuallyHidden.Root>
          <DialogPrimitive.Title>{branch.branch_name} — branch deep-dive</DialogPrimitive.Title>
          <DialogPrimitive.Description>Detail panel for {branch.branch_name} on {targetDate}</DialogPrimitive.Description>
        </VisuallyHidden.Root>
        {/* Header */}
        <div className="sticky top-0 z-10 border-b border-border px-5 py-4" style={{ background: "hsl(var(--accent-soft))" }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="pill">{branch.branch_country} · {countryName}</span>
            <span className="pill pill-brand">Branch deep-dive</span>
            {online ? (
              <span className="pill pill-success inline-flex items-center gap-1"><Wifi className="h-2.5 w-2.5" />Online</span>
            ) : (
              <span className="pill pill-danger inline-flex items-center gap-1"><WifiOff className="h-2.5 w-2.5" />Offline</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-brand text-background">
              <Building2 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-serif font-bold text-3xl tracking-tight text-brand-deep truncate" data-testid="branch-sheet-name">
                {branch.branch_name}
              </h2>
              {isHQ && (
                <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground mt-0.5">
                  Combined view · {(branch._hq_sources || []).length || 4} devices
                </div>
              )}
            </div>
          </div>
        </div>

        {/* KPI tiles */}
        <div className="px-5 py-4">
          <div className="grid grid-cols-2 gap-2.5" data-testid="branch-sheet-kpis">
            <KpiTile
              testId="sheet-kpi-present"
              label="Present today" tone="brand" icon={CheckCircle2}
              value={stats.present}
              sub={`of ${stats.total} on roster`}
            />
            <KpiTile
              testId="sheet-kpi-missing"
              label="Missing check-out" icon={Clock}
              value={stats.missingCheckout}
              sub="open shifts"
            />
            <KpiTile
              testId="sheet-kpi-late"
              label="Late arrivals" tone="warning" icon={AlertTriangle}
              value={stats.late}
              sub="check-in after 08:00"
            />
            <KpiTile
              testId="sheet-kpi-absent"
              label="Absent" tone="danger" icon={XCircle}
              value={stats.absent}
              sub="no check-in today"
            />
          </div>
        </div>

        {/* Check-in timeline */}
        <div className="px-5 pb-4">
          <div className="rounded-2xl bg-white border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="eyebrow flex items-center gap-1.5"><Clock className="h-3 w-3" />Check-in timeline</div>
                <h3 className="font-serif font-bold text-lg text-brand-deep mt-0.5" data-testid="sheet-title">{isHistorical ? `On ${targetDate}, earliest first` : "Today, earliest first"}</h3>
                <p className="text-[11px] text-muted-foreground" data-testid="sheet-date">{targetDate} · {rows.length} record{rows.length !== 1 ? "s" : ""}</p>
              </div>
              <Button
                variant="ghost" size="sm"
                onClick={exportXLS}
                disabled={rows.length === 0}
                className="h-7 rounded-full text-[10.5px] font-bold uppercase tracking-wider hover:bg-accent-soft"
                data-testid="sheet-export-btn"
              >
                <FileDown className="h-3 w-3 mr-1.5" />Excel
              </Button>
            </div>

            {loading && (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />Loading check-ins…
              </div>
            )}
            {err && <div className="text-sm text-danger py-3">{err}</div>}
            {!loading && !err && rows.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">No check-ins recorded {isHistorical ? `on ${targetDate}` : "today"}.</div>
            )}

            {!loading && rows.length > 0 && (
              <div className="space-y-1 max-h-[460px] overflow-y-auto scrollbar-thin" data-testid="sheet-timeline">
                {rows.map((r, i) => {
                  const time = r.check_in_time ? formatHHMM(r.check_in_time) : "—";
                  const isFirst = i === 0;
                  const flags = [];
                  if (r.is_late) flags.push({ label: "Late", cls: "pill pill-warning" });
                  if (r.is_early_departure) flags.push({ label: "Early left", cls: "pill pill-danger" });
                  if (r.is_overtime) flags.push({ label: "OT", cls: "pill pill-brand" });
                  if (r.is_undertime) flags.push({ label: "UT", cls: "pill pill-warning" });
                  return (
                    <div key={i} className={`flex items-center gap-3 rounded-xl px-2 py-2 ${isFirst ? "bg-brand/[0.06]" : "hover:bg-panel/60"}`}
                      data-testid={`sheet-row-${i}`}>
                      <div className="w-[58px] shrink-0 text-right">
                        <div className="font-mono font-bold text-[13px] tabular-nums text-brand-deep">{time}</div>
                        {r.check_out_time && (
                          <div className="font-mono text-[10px] text-muted-foreground">→ {formatHHMM(r.check_out_time)}</div>
                        )}
                      </div>
                      <div className="grid h-7 w-7 place-items-center rounded-full bg-panel text-[10px] font-bold text-brand-deep shrink-0">
                        {(r.employee_name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("")}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold truncate">{r.employee_name}</div>
                        <div className="flex flex-wrap items-center gap-1 mt-0.5">
                          {r._hq_source && <span className="text-[10px] text-muted-foreground">{r._hq_source}</span>}
                          {r.hours_worked != null && <span className="text-[10px] text-muted-foreground">· {r.hours_worked.toFixed(1)}h</span>}
                        </div>
                      </div>
                      <div className="flex flex-wrap justify-end gap-1 shrink-0">
                        {r.attendance_status === "Missing Check-Out" && <span className="pill pill-warning">Open</span>}
                        {r.attendance_status === "Absent" && <span className="pill pill-danger">Absent</span>}
                        {flags.map((f, j) => <span key={j} className={f.cls}>{f.label}</span>)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Go deeper */}
        <div className="px-5 pb-6">
          <div className="rounded-2xl bg-white border border-border p-4">
            <div className="eyebrow mb-3">Go deeper on {branch.branch_name}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-11 justify-between rounded-2xl border-border bg-panel/40 hover:bg-panel font-semibold"
                onClick={goDeepDive}
                data-testid="sheet-link-deepdive"
              >
                Full attendance history
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                className="h-11 justify-between rounded-2xl border-border bg-panel/40 hover:bg-panel font-semibold"
                onClick={() => { onOpenChange(false); navigate("/alerts"); }}
                data-testid="sheet-link-alerts"
              >
                Branch alerts
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                className="h-11 justify-between rounded-2xl border-border bg-panel/40 hover:bg-panel font-semibold"
                onClick={() => { onOpenChange(false); navigate("/reports"); }}
                data-testid="sheet-link-report"
              >
                Monthly HR report
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                className="h-11 justify-between rounded-2xl border-border bg-panel/40 hover:bg-panel font-semibold"
                onClick={exportXLS}
                disabled={rows.length === 0}
                data-testid="sheet-link-export"
              >
                Export today's data
                <FileDown className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
