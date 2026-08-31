import React, { useEffect, useState } from "react";
import { api, fmtKESLong } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { FileBarChart, Activity, Users, Award, ShieldCheck, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth";

const STATUS_LABELS = {
  intake: "Received",
  fitting: "Fitting",
  in_progress: "In Progress",
  quality_check: "Quality Check",
  ready: "Ready for Pickup",
  collected: "Collected",
  cancelled: "Cancelled",
};

const statusLabel = (status) => STATUS_LABELS[status] || String(status || "").replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase());

export default function AtelierReports() {
  const { user } = useAuth();
  
  // Default range: past 30 days
  const today = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(today.getDate() - 30);
  
  const [dateFrom, setDateFrom] = useState(thirtyDaysAgo.toISOString().split('T')[0]);
  const [dateTo, setDateTo] = useState(today.toISOString().split('T')[0]);

  const [locations, setLocations] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState("all");
  const [report, setReport] = useState(null);
  const [financials, setFinancials] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [financialsError, setFinancialsError] = useState(null);

  const fetchStats = async () => {
    setLoading(true);
    setError(null);
    setFinancialsError(null);
    try {
      let locs = locations;
      if (locs.length === 0) {
        const cr = await api.get('/atelier/config');
        locs = cr.data.locations || [];
        setLocations(locs);
      }

      const params = { start: dateFrom, end: dateTo };
      if (selectedBranch !== "all") params.location_code = selectedBranch;

      const r = await api.get('/atelier/reports/operations', { params });
      setReport(r.data);

      if (user?.role === "admin") {
        try {
          const fr = await api.get('/atelier/admin/financial-report', {
            params: { start: dateFrom, end: dateTo }
          });
          setFinancials(fr.data);
        } catch (e) {
          setFinancialsError(e?.response?.data?.detail || e?.message || "Failed to load financial data");
        }
      }
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || "Failed to load reports");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, [dateFrom, dateTo, selectedBranch, user?.role]);

  const filteredLocs = financials?.locations?.filter(l => selectedBranch === "all" || l.code === selectedBranch) || [];
  const totals = filteredLocs.reduce(
    (acc, loc) => {
      acc.charges += loc.charges;
      acc.paid += loc.paid;
      acc.balance += loc.balance;
      return acc;
    },
    { charges: 0, paid: 0, balance: 0 }
  );
  
  const pricingInactive = financials && !financialsError && totals.charges === 0 && totals.paid === 0 && totals.balance === 0;

  return (
    <div className="space-y-6 fade-in">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-[var(--text)] flex items-center gap-2">
            <FileBarChart className="h-5 w-5 text-[var(--accent)]" /> Operations Overview
          </h2>
          <p className="text-sm text-[var(--muted)]">Volume and SLA metrics for the selected period</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-3">
          <Select value={selectedBranch} onValueChange={setSelectedBranch}>
            <SelectTrigger className="input-pill h-9 w-40" data-testid="select-report-branch">
              <SelectValue placeholder="All Branches" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Branches</SelectItem>
              {locations.map(l => (
                <SelectItem key={l.code} value={l.code}>{l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2 bg-[var(--panel)] p-1 rounded-xl border border-[var(--border)]">
            <input 
              type="date" 
              value={dateFrom} 
              onChange={e => setDateFrom(e.target.value)} 
              className="input-pill h-9 border-none shadow-none bg-transparent"
              data-testid="input-date-from"
            />
            <span className="text-[var(--muted)] text-sm font-medium">to</span>
            <input 
              type="date" 
              value={dateTo} 
              onChange={e => setDateTo(e.target.value)} 
              className="input-pill h-9 border-none shadow-none bg-transparent"
              data-testid="input-date-to"
            />
          </div>
        </div>
      </div>

      {error ? (
        <Card className="card p-6 flex flex-col items-center justify-center min-h-[300px] text-center" data-testid="error-report-load">
          <AlertCircle className="h-10 w-10 text-[var(--danger)] mb-4" />
          <p className="text-[var(--text)] font-semibold mb-2">Error loading reports</p>
          <p className="text-[var(--muted)] text-sm mb-6">{error}</p>
          <Button onClick={fetchStats} className="btn-primary" data-testid="button-retry-report">
            Retry
          </Button>
        </Card>
      ) : loading ? (
        <div className="p-20 text-center text-[var(--muted)]">Loading metrics...</div>
      ) : !report ? (
        <div className="p-20 text-center text-[var(--muted)] border border-dashed border-[var(--border)] rounded-xl">Failed to load reports.</div>
      ) : (
        <div className="space-y-6">
          {/* Operations Volume & SLA */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="card p-5 rounded-xl border-t-4 border-t-[var(--accent)] flex flex-col justify-center">
              <div className="eyebrow mb-2">Total Jobs</div>
              <div className="text-3xl tabular-nums font-bold text-[var(--text)]"><span data-testid="kpi-total-jobs">{report.volume?.jobs || 0}</span></div>
            </Card>
            <Card className="card p-5 rounded-xl flex flex-col justify-center">
              <div className="eyebrow mb-2">Backlog</div>
              <div className="text-3xl tabular-nums font-bold text-[var(--text)]"><span data-testid="kpi-backlog">{report.backlog?.jobs || 0}</span></div>
            </Card>
            <Card className="card p-5 rounded-xl flex flex-col justify-center border-t-4 border-t-[var(--danger)]">
              <div className="eyebrow mb-2">Overdue</div>
              <div className="text-3xl tabular-nums font-bold text-[var(--danger)]"><span data-testid="kpi-overdue">{report.sla?.overdue || 0}</span></div>
            </Card>
            <Card className="card p-5 rounded-xl flex flex-col justify-center border-t-4 border-t-[var(--accent-strong)]">
              <div className="eyebrow mb-2">On Time Collection</div>
              <div className="text-3xl tabular-nums font-bold text-[var(--accent-strong)]">
                <span data-testid="kpi-on-time">{report.sla?.on_time_rate !== null ? `${(report.sla.on_time_rate * 100).toFixed(0)}%` : '—'}</span>
              </div>
            </Card>
          </div>

          {/* Financials (Admin Only) */}
          {financials && (
            <Card className="card p-6 rounded-xl border-l-4 border-l-[var(--accent)] bg-[var(--panel)]">
              <h3 className="text-lg font-bold mb-4 text-[var(--text)] flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-[var(--accent)]" /> Financial Overview (Admin)
              </h3>
              <div className="grid grid-cols-3 gap-6">
                <div>
                  <div className="eyebrow mb-2">Total Charges</div>
                  <div className="text-2xl tabular-nums font-bold text-[var(--text)]">{totals.charges > 0 ? fmtKESLong(totals.charges) : '—'}</div>
                </div>
                <div>
                  <div className="eyebrow mb-2">Total Paid</div>
                  <div className="text-2xl tabular-nums font-bold text-[var(--text)]">{totals.paid > 0 ? fmtKESLong(totals.paid) : '—'}</div>
                </div>
                <div>
                  <div className="eyebrow mb-2">Outstanding</div>
                  <div className="text-2xl tabular-nums font-bold text-[var(--danger)]">{totals.balance > 0 ? fmtKESLong(totals.balance) : '—'}</div>
                </div>
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="card p-6 rounded-xl">
              <h3 className="text-lg font-bold mb-4 text-[var(--text)] flex items-center gap-2">
                <Activity className="h-5 w-5 text-[var(--accent)]" /> Pipeline Status
              </h3>
              <div className="divide-y divide-[var(--border)]">
                {(report.backlog?.by_status || []).map((s, i) => (
                  <div key={i} className="flex justify-between items-center py-3">
                    <div className="font-semibold text-sm text-[var(--text)]">{statusLabel(s.status)}</div>
                    <div className="tabular-nums text-sm text-[var(--muted)] font-medium">{s.jobs} jobs</div>
                  </div>
                ))}
                {(report.backlog?.by_status || []).length === 0 && (
                  <div className="py-4 text-sm text-[var(--muted)] text-center italic">No active pipeline data available.</div>
                )}
              </div>
            </Card>

            <Card className="card p-6 rounded-xl">
              <h3 className="text-lg font-bold mb-4 text-[var(--text)] flex items-center gap-2">
                <Users className="h-5 w-5 text-[var(--accent)]" /> Staff Performance
              </h3>
              <div className="divide-y divide-[var(--border)]">
                {(report.staff || []).map((s, i) => (
                  <div key={i} className="flex justify-between items-center py-3">
                    <div>
                      <div className="font-semibold text-sm text-[var(--text)]">{s.name || 'Unassigned'}</div>
                      <div className="text-xs text-[var(--muted)]">Backlog: {s.backlog}</div>
                    </div>
                    <div className="tabular-nums text-sm text-[var(--muted)] font-medium">{s.jobs} total</div>
                  </div>
                ))}
                {(report.staff || []).length === 0 && (
                  <div className="py-4 text-sm text-[var(--muted)] text-center italic">No staff data available.</div>
                )}
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card className="card p-6 rounded-xl">
              <h3 className="text-lg font-bold mb-5 text-[var(--text)] flex items-center gap-2">
                <Award className="h-5 w-5 text-[var(--accent)]" /> Quality & Customer
              </h3>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <div className="eyebrow mb-2">Quality Checks</div>
                  <div className="text-3xl tabular-nums font-bold text-[var(--text)]">{report.quality?.quality_checks || 0}</div>
                </div>
                <div>
                  <div className="eyebrow mb-2 text-[var(--danger)]">Reworks</div>
                  <div className="text-3xl tabular-nums font-bold text-[var(--danger)]">{report.quality?.jobs_reworked || 0}</div>
                </div>
                <div className="col-span-2 pt-5 border-t border-[var(--border)]">
                  <div className="eyebrow mb-2">Unique Customers</div>
                  <div className="text-3xl tabular-nums font-bold text-[var(--text)] flex items-baseline gap-2">
                    {report.customer?.customers || 0}
                    <span className="text-sm font-sans font-medium text-[var(--muted)]">({report.customer?.repeat_customers || 0} repeats)</span>
                  </div>
                </div>
              </div>
            </Card>

            <Card className="card p-6 rounded-xl">
              <h3 className="text-lg font-bold mb-5 text-[var(--text)]">Data Health</h3>
              <div className="space-y-4">
                <div className="flex justify-between items-center bg-[var(--bg)] border border-[var(--border)] p-4 rounded-xl shadow-sm">
                  <span className="text-sm font-semibold">Unassigned Jobs</span>
                  <span className={`tabular-nums font-bold text-lg ${report.data_health?.unassigned > 0 ? 'text-[var(--danger)]' : 'text-[var(--accent-strong)]'}`}>
                    {report.data_health?.unassigned || 0}
                  </span>
                </div>
                <div className="flex justify-between items-center bg-[var(--bg)] border border-[var(--border)] p-4 rounded-xl shadow-sm">
                  <span className="text-sm font-semibold">Missing Promise Date</span>
                  <span className={`tabular-nums font-bold text-lg ${report.data_health?.missing_promise > 0 ? 'text-[var(--amber)]' : 'text-[var(--accent-strong)]'}`}>
                    {report.data_health?.missing_promise || 0}
                  </span>
                </div>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}