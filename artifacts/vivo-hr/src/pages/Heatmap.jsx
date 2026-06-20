import React, { useEffect, useMemo, useState, useCallback } from "react";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import LocationFilter from "../components/LocationFilter";
import BranchDetailSheet from "../components/BranchDetailSheet";
import { vivoClient, todayISO, isHQSource, HQ_LABEL } from "../lib/api";
import { fetchAllBranches } from "../lib/branches";
import { yesterday } from "../lib/dates";
import { usePersistedFilter } from "../lib/persistedFilters";
import DateRangePicker from "../components/DateRangePicker";
import { exportToExcel } from "../lib/exports";
import { FileDown, Grid3x3 } from "lucide-react";

function addDays(iso, n) {
  const d = new Date(iso);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export default function Heatmap() {
  const yest = yesterday();
  const [dateFrom, setDateFrom] = useState(addDays(yest, -13));
  const [dateTo, setDateTo] = useState(yest);
  const [country, setCountry] = usePersistedFilter("country", "all");
  const [location, setLocation] = usePersistedFilter("location", "all");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [drillBranch, setDrillBranch] = useState(null);
  const [drillDate, setDrillDate] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [allBranches, setAllBranches] = useState([]);

  useEffect(() => {
    fetchAllBranches().then(setAllBranches).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const params = { date_from: dateFrom, date_to: dateTo };
      if (country !== "all") params.country = country;
      if (location !== "all") params.location = location;
      const { data } = await vivoClient.get("/heatmap", { params });
      const merged = (data || []).map((r) => isHQSource(r.branch_name) ? { ...r, branch_name: HQ_LABEL } : r);
      setRows(merged);
    } catch (e) { setErr(e?.message || "Failed to load"); }
    finally { setLoading(false); }
  }, [dateFrom, dateTo, country, location]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Build matrix: branches as rows, dates as columns, aggregating HQ devices into HQ
  const { dates, branches, matrix } = useMemo(() => {
    const dateSet = new Set();
    const branchAgg = new Map(); // branch -> { branch, location, country, cells: Map<date, {sum, count}> }
    rows.forEach((r) => {
      dateSet.add(r.attendance_date);
      const cur = branchAgg.get(r.branch_name) || { branch: r.branch_name, location: r.location, country: r.branch_country, cells: new Map() };
      const c = cur.cells.get(r.attendance_date) || { sum: 0, count: 0 };
      c.sum += r.attendance_rate || 0;
      c.count += 1;
      cur.cells.set(r.attendance_date, c);
      branchAgg.set(r.branch_name, cur);
    });
    const dates = Array.from(dateSet).sort();
    // Build per-branch avg-rate + sort by avg desc
    const branchArr = Array.from(branchAgg.values()).map((b) => {
      const ratesArr = dates.map((d) => {
        const c = b.cells.get(d);
        return c && c.count ? c.sum / c.count : null;
      });
      const valid = ratesArr.filter((v) => v != null);
      const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
      return { branch: b.branch, location: b.location, country: b.country, rates: ratesArr, avg };
    });
    branchArr.sort((a, b) => b.avg - a.avg);
    return { dates, branches: branchArr, matrix: branchArr };
  }, [rows]);

  const cellColor = (r) => {
    if (r == null) return "hsl(var(--muted))";
    if (r >= 90) return `hsl(142 65% ${56 - r * 0.1}%)`;
    if (r >= 80) return `hsl(142 60% ${65 - r * 0.05}%)`;
    if (r >= 60) return `hsl(35 92% ${60 - (r - 60) * 0.15}%)`;
    if (r >= 40) return `hsl(25 95% ${60 - (r - 40) * 0.3}%)`;
    return `hsl(0 72% ${60 - r * 0.2}%)`;
  };

  const xlsx = () => {
    const data = matrix.map((b) => {
      const o = { Branch: b.branch, Location: b.location, "Avg %": b.avg.toFixed(1) };
      dates.forEach((d, i) => { o[d] = b.rates[i] != null ? b.rates[i].toFixed(1) : ""; });
      return o;
    });
    exportToExcel(data, `heatmap-${dateFrom}-to-${dateTo}.xlsx`, "Heatmap");
  };

  return (
    <AppLayout onRefresh={load}>
      <PageHeader
        title="Attendance Heatmap"
        subtitle="Rows = branches · Columns = dates · green ≥80% · orange 50–79% · red <50%"
        testId="hm-header"
        actions={<Button variant="outline" size="sm" onClick={xlsx} className="rounded-full text-[11px] font-bold uppercase tracking-wider"><FileDown className="h-3.5 w-3.5 mr-1.5" />Excel</Button>}
      />

      <Card className="rounded-2xl border border-border bg-card p-4 mb-5 shadow-none">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div className="lg:col-span-2"><Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Date range</Label>
            <DateRangePicker
              value={{ from: dateFrom, to: dateTo }}
              onChange={({ from, to }) => { setDateFrom(from); setDateTo(to); }}
              testId="hm-daterange"
              className="w-full"
            /></div>
          <div><Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">Country</Label>
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger className="h-9 rounded-full border-border bg-panel/40" data-testid="hm-country"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="KE">Kenya</SelectItem><SelectItem value="UG">Uganda</SelectItem><SelectItem value="RW">Rwanda</SelectItem></SelectContent>
            </Select></div>
          <LocationFilter value={location} onChange={setLocation} testId="hm-location" />
          <Button onClick={load} className="rounded-full bg-brand hover:bg-brand-deep text-background text-[11px] font-bold uppercase tracking-wider" data-testid="hm-apply">Apply</Button>
        </div>
      </Card>

      {err && <ErrorState message={err} />}
      <Card className="rounded-2xl border border-border bg-card p-5 shadow-none">
        <div className="mb-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <Grid3x3 className="h-4 w-4 text-brand" />
            <div>
              <div className="eyebrow">Branch × date</div>
              <h3 className="font-serif text-xl font-bold text-brand-deep mt-0.5">Attendance rate heatmap</h3>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded" style={{ background: "hsl(142 65% 45%)" }} /> ≥90</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded" style={{ background: "hsl(142 60% 55%)" }} /> 80–89</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded" style={{ background: "hsl(35 92% 55%)" }} /> 60–79</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded" style={{ background: "hsl(25 95% 55%)" }} /> 40–59</span>
            <span className="flex items-center gap-1"><span className="h-3 w-3 rounded" style={{ background: "hsl(0 72% 55%)" }} /> &lt;40</span>
          </div>
        </div>

        {loading ? <LoadingState /> : (
          <div className="overflow-x-auto scrollbar-thin" data-testid="hm-grid">
            <table className="border-separate border-spacing-1 mx-auto">
              <thead>
                <tr>
                  <th className="px-2 text-left text-[11px] font-bold uppercase tracking-wider text-brand-deep sticky left-0 bg-card z-10">Branch</th>
                  <th className="px-2 text-center text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Avg</th>
                  {dates.map((d) => (
                    <th key={d} className="px-1 text-[9.5px] text-muted-foreground font-normal whitespace-nowrap">{d.slice(5)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.map((row) => (
                  <tr key={row.branch}>
                    <td className="pr-3 text-[12px] font-semibold whitespace-nowrap sticky left-0 bg-card z-10">
                      <div>{row.branch}</div>
                      <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground">{row.location}</div>
                    </td>
                    <td className="text-center">
                      <span className="inline-block rounded-md px-2 py-0.5 text-[11px] font-bold tabular-nums"
                        style={{ background: cellColor(row.avg), color: "#fff" }}>
                        {row.avg.toFixed(0)}
                      </span>
                    </td>
                    {row.rates.map((r, i) => {
                      const date = dates[i];
                      const hasData = r != null;
                      return (
                        <td key={i} title={`${date}: ${r != null ? r.toFixed(1) + "%" : "no data"}${hasData ? " — click for drill-down" : ""}`}
                          onClick={hasData ? () => {
                            setDrillBranch({
                              branch_name: row.branch,
                              branch_country: row.country || "",
                              device_status: "online",
                            });
                            setDrillDate(date);
                            setSheetOpen(true);
                          } : undefined}
                          className={`h-8 w-12 rounded text-[10.5px] font-bold text-white text-center align-middle font-mono tabular-nums ${hasData ? "cursor-pointer hover:ring-2 hover:ring-brand/60 transition-all" : ""}`}
                          style={{ background: cellColor(r) }}
                          data-testid={`hm-cell-${row.branch.replace(/\s/g, "-")}-${date}`}
                        >
                          {r != null ? Math.round(r) : ""}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {matrix.length === 0 && (
                  <tr><td colSpan={dates.length + 2} className="px-4 py-16 text-center text-sm text-muted-foreground">No data for the selected range</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <BranchDetailSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        branch={drillBranch}
        date={drillDate}
        allBranches={allBranches}
      />
    </AppLayout>
  );
}
