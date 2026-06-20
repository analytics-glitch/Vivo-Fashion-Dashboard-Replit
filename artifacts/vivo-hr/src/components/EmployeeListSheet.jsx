import React, { useMemo, useState } from "react";
import { Sheet, SheetContent } from "./ui/sheet";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { formatHHMM, adjustedDate } from "../lib/api";
import { FileDown, Search } from "lucide-react";
import { exportToExcel } from "../lib/exports";

const COUNTRY_NAMES = { KE: "Kenya", UG: "Uganda", RW: "Rwanda" };

function flagPills(r) {
  const items = [];
  if (r.is_late) items.push({ label: "Late", cls: "pill pill-warning" });
  if (r.is_early_departure) items.push({ label: "Early left", cls: "pill pill-danger" });
  if (r.is_overtime) items.push({ label: "OT", cls: "pill pill-brand" });
  if (r.is_undertime) items.push({ label: "UT", cls: "pill pill-warning" });
  if (r.attendance_status === "Missing Check-Out") items.push({ label: "Open", cls: "pill pill-warning" });
  if (r.attendance_status === "Absent") items.push({ label: "Absent", cls: "pill pill-danger" });
  return items;
}

/**
 * Reusable side sheet for showing a list of employee records.
 * sortMode: "time-asc" | "time-desc" | "lateness-desc"
 */
export default function EmployeeListSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  eyebrow = "Drill-down",
  rows = [],
  sortMode = "time-asc",
  filename = "vivo-list.xlsx",
  emptyMessage = "Nothing to show",
}) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    let list = rows;
    if (q.trim()) {
      const lq = q.toLowerCase();
      list = list.filter(
        (r) =>
          (r.employee_name || "").toLowerCase().includes(lq) ||
          (r.branch_name || "").toLowerCase().includes(lq)
      );
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sortMode === "time-desc") {
        const av = a.check_in_time ? new Date(a.check_in_time).getTime() : -Infinity;
        const bv = b.check_in_time ? new Date(b.check_in_time).getTime() : -Infinity;
        return bv - av;
      }
      if (sortMode === "lateness-desc") {
        // Compare check-in time of day: latest minutes-after-08:00 first
        const minutes = (iso) => {
          if (!iso) return -1;
          const d = adjustedDate(iso);
          return d ? d.getHours() * 60 + d.getMinutes() : -1;
        };
        return minutes(b.check_in_time) - minutes(a.check_in_time);
      }
      // default: time-asc
      const av = a.check_in_time ? new Date(a.check_in_time).getTime() : Infinity;
      const bv = b.check_in_time ? new Date(b.check_in_time).getTime() : Infinity;
      return av - bv;
    });
    return sorted;
  }, [rows, q, sortMode]);

  const exportXLS = () => {
    exportToExcel(
      filtered.map((r) => ({
        Date: r.attendance_date,
        Time: formatHHMM(r.check_in_time),
        "Check-Out": formatHHMM(r.check_out_time),
        Employee: r.employee_name,
        Branch: r.branch_name,
        Country: COUNTRY_NAMES[r.branch_country] || r.branch_country,
        Status: r.attendance_status,
        "Hours Worked": r.hours_worked ?? "",
      })),
      filename,
      "Drill-down"
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl p-0 overflow-y-auto scrollbar-thin"
        style={{ background: "hsl(var(--accent-soft))" }}
        data-testid="employee-list-sheet"
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 border-b border-border px-5 py-4"
          style={{ background: "hsl(var(--accent-soft))" }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="pill pill-brand">{eyebrow}</span>
            <span className="pill">{filtered.length} of {rows.length}</span>
          </div>
          <h2 className="font-serif font-bold text-3xl tracking-tight text-brand-deep" data-testid="list-sheet-title">
            {title}
          </h2>
          {subtitle && <p className="mt-1 text-[12px] text-muted-foreground">{subtitle}</p>}

          <div className="mt-3 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search employee or branch…"
                className="h-9 rounded-full border-border bg-white pl-9"
                data-testid="list-sheet-search"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={exportXLS}
              disabled={filtered.length === 0}
              className="h-9 rounded-full text-[11px] font-bold uppercase tracking-wider hover:bg-white"
              data-testid="list-sheet-export"
            >
              <FileDown className="h-3.5 w-3.5 mr-1.5" />Excel
            </Button>
          </div>
        </div>

        <div className="px-5 py-4">
          <div className="rounded-2xl bg-white border border-border p-3">
            {filtered.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">{emptyMessage}</div>
            ) : (
              <div className="space-y-1" data-testid="list-sheet-rows">
                {filtered.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-panel/60"
                    data-testid={`list-row-${i}`}
                  >
                    <div className="w-[58px] shrink-0 text-right">
                      <div className="font-mono font-bold text-[13px] tabular-nums text-brand-deep">
                        {formatHHMM(r.check_in_time)}
                      </div>
                      {r.check_out_time && (
                        <div className="font-mono text-[10px] text-muted-foreground">
                          → {formatHHMM(r.check_out_time)}
                        </div>
                      )}
                    </div>
                    <div className="grid h-7 w-7 place-items-center rounded-full bg-panel text-[10px] font-bold text-brand-deep shrink-0">
                      {(r.employee_name || "?")
                        .split(" ")
                        .map((w) => w[0])
                        .slice(0, 2)
                        .join("")}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold truncate">{r.employee_name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {r.branch_name} · {COUNTRY_NAMES[r.branch_country] || r.branch_country}
                        {r.hours_worked != null && <> · {r.hours_worked.toFixed(1)}h</>}
                      </div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1 shrink-0">
                      {flagPills(r).map((f, j) => (
                        <span key={j} className={f.cls}>{f.label}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
