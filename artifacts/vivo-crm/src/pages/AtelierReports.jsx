import React, { useEffect, useState } from "react";
import { api, formatKES } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { FileBarChart, Activity, Users, Award, ShieldCheck } from "lucide-react";
import { DateRangePicker } from "@/components/DateRangePicker";
import { useDateRange } from "@/contexts/DateRangeContext";

export default function AtelierReports() {
  const [report, setReport] = useState(null);
  const [financials, setFinancials] = useState(null);
  const [loading, setLoading] = useState(true);
  const { range, setRange } = useDateRange();

  useEffect(() => {
    const fetchStats = async () => {
      setLoading(true);
      try {
        const r = await api.get('/atelier/reports/operations', {
          params: { start: range.from, end: range.to }
        });
        setReport(r.data);

        // Fetch financials if authorized (API will 403 if not admin, which we catch and ignore)
        try {
          const fr = await api.get('/atelier/admin/financial-report', {
            params: { start: range.from, end: range.to }
          });
          setFinancials(fr.data);
        } catch {
          // not authorized, fine
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, [range]);

  const totals = (financials?.locations || []).reduce(
    (acc, loc) => {
      acc.charges += loc.charges;
      acc.paid += loc.paid;
      acc.balance += loc.balance;
      return acc;
    },
    { charges: 0, paid: 0, balance: 0 }
  );

  return (
    <div className="p-6 md:p-10 max-w-[1200px] mx-auto min-h-screen">
      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="font-display text-3xl text-[var(--vivo-navy)] flex items-center gap-3">
            <FileBarChart className="h-8 w-8" /> Atelier Reports
          </h1>
          <p className="text-sm text-[var(--vivo-muted)] mt-1">Operational metrics and turnaround</p>
        </div>
        <div>
          <DateRangePicker value={range} onChange={setRange} align="end" buttonClassName="h-10 rounded-sm bg-white" />
        </div>
      </div>

      {loading ? (
        <div className="p-20 text-center text-[var(--vivo-muted)]">Loading metrics...</div>
      ) : !report ? (
        <div className="p-20 text-center text-[var(--vivo-muted)]">Failed to load reports.</div>
      ) : (
        <div className="space-y-6">
          {/* Operations Volume & SLA */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="vivo-card p-6 rounded-sm border-t-4 border-t-[var(--vivo-navy)]">
              <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] mb-1">Total Jobs</div>
              <div className="font-display text-3xl font-mono-num text-[var(--vivo-navy)]">{report.volume?.jobs || 0}</div>
            </Card>
            <Card className="vivo-card p-6 rounded-sm">
              <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] mb-1">Backlog</div>
              <div className="font-display text-3xl font-mono-num">{report.backlog?.jobs || 0}</div>
            </Card>
            <Card className="vivo-card p-6 rounded-sm">
              <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] mb-1">Overdue</div>
              <div className="font-display text-3xl font-mono-num text-red-600">{report.sla?.overdue || 0}</div>
            </Card>
            <Card className="vivo-card p-6 rounded-sm">
              <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] mb-1">On Time Collection</div>
              <div className="font-display text-3xl font-mono-num text-emerald-600">
                {report.sla?.on_time_rate !== null ? `${(report.sla.on_time_rate * 100).toFixed(0)}%` : '—'}
              </div>
            </Card>
          </div>

          {/* Financials (Admin Only) */}
          {financials && (
            <Card className="vivo-card p-6 rounded-sm border-l-4 border-l-[var(--vivo-gold)] bg-[var(--vivo-bg-soft)]">
              <h3 className="font-display text-lg mb-4 text-[var(--vivo-navy)] flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-[var(--vivo-gold)]" /> Financial Overview (Admin)
              </h3>
              <div className="grid grid-cols-3 gap-6">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] mb-1">Total Charges</div>
                  <div className="font-display text-2xl font-mono-num">{totals.charges > 0 ? formatKES(totals.charges) : '—'}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] mb-1">Total Paid</div>
                  <div className="font-display text-2xl font-mono-num">{totals.paid > 0 ? formatKES(totals.paid) : '—'}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] mb-1">Outstanding</div>
                  <div className="font-display text-2xl font-mono-num text-red-600">{totals.balance > 0 ? formatKES(totals.balance) : '—'}</div>
                </div>
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="vivo-card p-6 rounded-sm">
              <h3 className="font-display text-lg mb-4 text-[var(--vivo-navy)] flex items-center gap-2">
                <Activity className="h-5 w-5" /> Pipeline Status
              </h3>
              <div className="divide-y divide-[var(--vivo-border)]">
                {(report.backlog?.by_status || []).map((s, i) => (
                  <div key={i} className="flex justify-between items-center py-3">
                    <div className="font-medium text-sm">{s.status.replace("_", " ")}</div>
                    <div className="font-mono-num text-sm text-[var(--vivo-muted)]">{s.jobs} jobs</div>
                  </div>
                ))}
                {(report.backlog?.by_status || []).length === 0 && (
                  <div className="py-4 text-sm text-[var(--vivo-muted)]">No data available.</div>
                )}
              </div>
            </Card>

            <Card className="vivo-card p-6 rounded-sm">
              <h3 className="font-display text-lg mb-4 text-[var(--vivo-navy)] flex items-center gap-2">
                <Users className="h-5 w-5" /> Staff Performance
              </h3>
              <div className="divide-y divide-[var(--vivo-border)]">
                {(report.staff || []).map((s, i) => (
                  <div key={i} className="flex justify-between items-center py-3">
                    <div>
                      <div className="font-medium text-sm">{s.name || 'Unassigned'}</div>
                      <div className="text-xs text-[var(--vivo-muted)]">Backlog: {s.backlog}</div>
                    </div>
                    <div className="font-mono-num text-sm text-[var(--vivo-muted)]">{s.jobs} total</div>
                  </div>
                ))}
                {(report.staff || []).length === 0 && (
                  <div className="py-4 text-sm text-[var(--vivo-muted)]">No staff data.</div>
                )}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="vivo-card p-6 rounded-sm">
              <h3 className="font-display text-lg mb-4 text-[var(--vivo-navy)] flex items-center gap-2">
                <Award className="h-5 w-5" /> Quality & Customer
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] mb-1">Quality Checks</div>
                  <div className="font-display text-2xl font-mono-num">{report.quality?.quality_checks || 0}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] mb-1">Reworks</div>
                  <div className="font-display text-2xl font-mono-num text-red-600">{report.quality?.jobs_reworked || 0}</div>
                </div>
                <div className="col-span-2 pt-4 border-t border-[var(--vivo-border)]">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] mb-1">Unique Customers</div>
                  <div className="font-display text-2xl font-mono-num">{report.customer?.customers || 0} <span className="text-sm font-sans font-normal text-[var(--vivo-muted)]">({report.customer?.repeat_customers || 0} repeats)</span></div>
                </div>
              </div>
            </Card>

            <Card className="vivo-card p-6 rounded-sm">
              <h3 className="font-display text-lg mb-4 text-[var(--vivo-navy)]">Data Health</h3>
              <div className="space-y-4">
                <div className="flex justify-between items-center bg-[var(--vivo-bg-soft)] p-3 rounded-sm">
                  <span className="text-sm">Unassigned Jobs</span>
                  <span className={`font-mono-num font-bold ${report.data_health?.unassigned > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{report.data_health?.unassigned || 0}</span>
                </div>
                <div className="flex justify-between items-center bg-[var(--vivo-bg-soft)] p-3 rounded-sm">
                  <span className="text-sm">Missing Promise Date</span>
                  <span className={`font-mono-num font-bold ${report.data_health?.missing_promise > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{report.data_health?.missing_promise || 0}</span>
                </div>
              </div>
            </Card>
          </div>

        </div>
      )}
    </div>
  );
}
