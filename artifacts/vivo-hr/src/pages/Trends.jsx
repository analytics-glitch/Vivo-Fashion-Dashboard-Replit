import React, { useEffect, useMemo, useState, useCallback } from "react";
import { vivoClient, monthStartISO, todayISO, consolidateHQBranches } from "../lib/api";
import { yesterday, previousPeriod } from "../lib/dates";
import { usePersistedDateRange, usePersistedFilter } from "../lib/persistedFilters";
import DateRangePicker from "../components/DateRangePicker";
import DeltaChip from "../components/DeltaChip";
import { Switch } from "../components/ui/switch";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import LocationFilter from "../components/LocationFilter";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend, Area, AreaChart,
  BarChart, Bar, Cell, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
} from "recharts";
import { Trophy, TrendingUp, Calendar as CalIcon } from "lucide-react";
import { useAuth } from "../lib/auth";

const COUNTRY_NAMES = { KE: "Kenya", UG: "Uganda", RW: "Rwanda" };
const DOW_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Trends() {
  const { user } = useAuth();
  const [country, setCountry] = usePersistedFilter("country", "all");
  const [location, setLocation] = usePersistedFilter("location", "all");
  const [dateFrom, dateTo, setDateFrom, setDateTo] = usePersistedDateRange(yesterday(), yesterday());
  const [trends, setTrends] = useState([]);
  const [prevTrends, setPrevTrends] = useState([]);
  const [compare, setCompare] = useState(false);
  const [rankings, setRankings] = useState([]);
  const [dow, setDow] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const params = { date_from: dateFrom, date_to: dateTo };
      if (country !== "all") params.country = country;
      if (location !== "all") params.location = location;
      const reqs = [
        vivoClient.get("/trends", { params }),
        vivoClient.get("/branch-rankings", { params }),
        vivoClient.get("/dow-analysis", { params }),
      ];
      if (compare) {
        const pp = previousPeriod(dateFrom, dateTo);
        reqs.push(vivoClient.get("/trends", { params: { ...params, date_from: pp.from, date_to: pp.to } }));
      }
      const [t, r, d, pt] = await Promise.all(reqs);
      setTrends(t.data || []);
      setPrevTrends(compare && pt ? (pt.data || []) : []);
      let rk = consolidateHQBranches(r.data || []);
      if (user?.role === "branch_manager" && user.branch_assignment) {
        rk = rk.filter((x) => x.branch_name === user.branch_assignment);
      }
      setRankings(rk);
      setDow(d.data || []);
    } catch (e) { setErr(e?.message || "Failed to load"); }
    finally { setLoading(false); }
  }, [country, location, dateFrom, dateTo, compare, user]);

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Aggregate trends across countries by day
  const buildAgg = (raw) => {
    const map = new Map();
    raw.forEach((t) => {
      const cur = map.get(t.attendance_date) || { attendance_date: t.attendance_date, present: 0, absent: 0, late_arrivals: 0, total_employees: 0, sum_rate: 0, count_rate: 0 };
      cur.present += t.present || 0;
      cur.absent += t.absent || 0;
      cur.late_arrivals += t.late_arrivals || 0;
      cur.total_employees += t.total_employees || 0;
      if (t.attendance_rate != null) { cur.sum_rate += t.attendance_rate; cur.count_rate += 1; }
      map.set(t.attendance_date, cur);
    });
    return Array.from(map.values())
      .map((c) => ({ ...c, attendance_rate: c.count_rate ? +(c.sum_rate / c.count_rate).toFixed(1) : 0 }))
      .sort((a, b) => a.attendance_date.localeCompare(b.attendance_date));
  };

  const aggTrends = useMemo(() => buildAgg(trends), [trends]);
  const aggPrevTrends = useMemo(() => buildAgg(prevTrends), [prevTrends]);

  // Merge by relative day-offset so prior period overlays current X-axis
  const overlay = useMemo(() => {
    if (!compare || aggPrevTrends.length === 0) return aggTrends;
    return aggTrends.map((c, i) => ({
      ...c,
      prev_attendance_rate: aggPrevTrends[i]?.attendance_rate ?? null,
      prev_date: aggPrevTrends[i]?.attendance_date ?? null,
    }));
  }, [aggTrends, aggPrevTrends, compare]);

  // Period totals for delta chips
  const currTotals = useMemo(() => {
    const present = aggTrends.reduce((a, c) => a + c.present, 0);
    const absent = aggTrends.reduce((a, c) => a + c.absent, 0);
    const late = aggTrends.reduce((a, c) => a + c.late_arrivals, 0);
    const avgRate = aggTrends.length ? aggTrends.reduce((a, c) => a + c.attendance_rate, 0) / aggTrends.length : 0;
    return { present, absent, late, avgRate };
  }, [aggTrends]);
  const prevTotals = useMemo(() => {
    const present = aggPrevTrends.reduce((a, c) => a + c.present, 0);
    const absent = aggPrevTrends.reduce((a, c) => a + c.absent, 0);
    const late = aggPrevTrends.reduce((a, c) => a + c.late_arrivals, 0);
    const avgRate = aggPrevTrends.length ? aggPrevTrends.reduce((a, c) => a + c.attendance_rate, 0) / aggPrevTrends.length : 0;
    return { present, absent, late, avgRate };
  }, [aggPrevTrends]);

  // Best & worst
  const sortedRanks = useMemo(() => [...rankings].sort((a, b) => (b.attendance_rate || 0) - (a.attendance_rate || 0)), [rankings]);
  const top5 = sortedRanks.slice(0, 5);
  const bottom5 = [...sortedRanks].reverse().slice(0, 5);

  // Heatmap of branch x last 14 days
  const heatmap = useMemo(() => {
    const days = Array.from(new Set(trends.map((t) => t.attendance_date))).sort().slice(-14);
    const branchSet = new Set(trends.map((t) => t.branch_country));
    // Build by country since /trends groups by country in this API
    const matrix = Array.from(branchSet).map((c) => {
      const cells = days.map((d) => {
        const m = trends.find((t) => t.attendance_date === d && t.branch_country === c);
        return { day: d, rate: m?.attendance_rate ?? null };
      });
      return { row: COUNTRY_NAMES[c] || c, cells };
    });
    return { days, matrix };
  }, [trends]);

  const dowChart = useMemo(() => {
    return DOW_ORDER.map((label, idx) => {
      const found = dow.find((d) => d.day_of_week?.toLowerCase().startsWith(label.toLowerCase()) || d.dow_num === idx + 1);
      return { day: label, attendance_rate: found?.attendance_rate ?? 0, avg_hours: found?.avg_hours ?? 0 };
    });
  }, [dow]);

  return (
    <AppLayout onRefresh={load}>
      <PageHeader title="Trends & Analytics" subtitle="Daily attendance, ranking and day-of-week performance" testId="trends-header" />

      <Card className="p-4 mb-5">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <div>
            <Label className="text-xs">Country</Label>
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger data-testid="trends-country"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All countries</SelectItem>
                <SelectItem value="KE">Kenya</SelectItem>
                <SelectItem value="UG">Uganda</SelectItem>
                <SelectItem value="RW">Rwanda</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <LocationFilter value={location} onChange={setLocation} testId="trends-location" />
          <div>
            <Label className="text-xs">Date range</Label>
            <DateRangePicker
              value={{ from: dateFrom, to: dateTo }}
              onChange={({ from, to }) => { setDateFrom(from); setDateTo(to); }}
              testId="trends-daterange"
              className="w-full"
            />
          </div>
          <Button onClick={load} data-testid="trends-apply">Apply</Button>
        </div>
        <div className="mt-3 flex items-center gap-2 border-t pt-3">
          <Switch id="tr-compare" checked={compare} onCheckedChange={setCompare} data-testid="trends-compare-toggle" />
          <label htmlFor="tr-compare" className="text-[12px] font-semibold cursor-pointer">Compare to previous period</label>
          {compare && (() => { const p = previousPeriod(dateFrom, dateTo); return (
            <span className="text-[11px] text-muted-foreground">({p.from} → {p.to})</span>
          ); })()}
        </div>
      </Card>

      {err && <ErrorState message={err} />}
      {loading ? <LoadingState /> : (
        <div className="space-y-6">
          {/* Period summary strip */}
          {compare && (
            <Card className="rounded-2xl border border-border bg-card p-4 shadow-none">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="trends-delta-strip">
                <div>
                  <div className="eyebrow">Avg attendance rate</div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="font-extrabold text-2xl tabular-nums text-brand-deep">{currTotals.avgRate.toFixed(1)}%</div>
                    <DeltaChip current={currTotals.avgRate} previous={prevTotals.avgRate} />
                  </div>
                </div>
                <div>
                  <div className="eyebrow">Present (total)</div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="font-extrabold text-2xl tabular-nums">{currTotals.present.toLocaleString()}</div>
                    <DeltaChip current={currTotals.present} previous={prevTotals.present} />
                  </div>
                </div>
                <div>
                  <div className="eyebrow">Absent (total)</div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="font-extrabold text-2xl tabular-nums">{currTotals.absent.toLocaleString()}</div>
                    <DeltaChip current={currTotals.absent} previous={prevTotals.absent} invert />
                  </div>
                </div>
                <div>
                  <div className="eyebrow">Late arrivals</div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="font-extrabold text-2xl tabular-nums">{currTotals.late.toLocaleString()}</div>
                    <DeltaChip current={currTotals.late} previous={prevTotals.late} invert />
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* Daily trend line */}
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="h-4 w-4 text-primary" />
              <h3 className="font-semibold text-base">Daily attendance trend</h3>
              {compare && <span className="text-[10px] uppercase tracking-wider text-muted-foreground ml-2">— solid = current · dashed = previous</span>}
            </div>
            <div className="h-[320px]" data-testid="daily-trend-chart">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={overlay}>
                  <defs>
                    <linearGradient id="gradPresent" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.6} />
                      <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} vertical={false} />
                  <XAxis dataKey="attendance_date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false}
                    tickFormatter={(v) => v?.slice(5)} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                  <Area type="monotone" dataKey="attendance_rate" name="Attendance %" stroke="hsl(var(--chart-1))" fill="url(#gradPresent)" strokeWidth={2} />
                  {compare && <Line type="monotone" dataKey="prev_attendance_rate" name="Previous period" stroke="hsl(var(--accent-mid))" strokeDasharray="6 4" strokeWidth={2} dot={false} />}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Day of Week */}
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <CalIcon className="h-4 w-4 text-primary" />
                <h3 className="font-semibold text-base">Attendance by day of week</h3>
              </div>
              <div className="h-[300px]" data-testid="dow-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={dowChart}>
                    <PolarGrid strokeOpacity={0.2} />
                    <PolarAngleAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <PolarRadiusAxis angle={30} tick={{ fontSize: 10 }} />
                    <Radar name="Rate %" dataKey="attendance_rate" stroke="hsl(var(--chart-1))" fill="hsl(var(--chart-1))" fillOpacity={0.4} />
                    <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            {/* Avg hours per branch (top 10) */}
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="h-4 w-4 text-primary" />
                <h3 className="font-semibold text-base">Avg hours worked — top branches</h3>
              </div>
              <div className="h-[300px]" data-testid="avg-hours-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={[...rankings].sort((a, b) => (b.avg_hours || 0) - (a.avg_hours || 0)).slice(0, 10)} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="branch_name" tick={{ fontSize: 10 }} width={110} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="avg_hours" fill="hsl(var(--chart-2))" radius={[0, 6, 6, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          {/* Heatmap */}
          <Card className="p-5">
            <h3 className="font-semibold text-base mb-3">Country × day attendance heatmap (last 14 days)</h3>
            <div className="overflow-x-auto scrollbar-thin" data-testid="heatmap">
              <table className="border-separate border-spacing-1">
                <thead>
                  <tr>
                    <th></th>
                    {heatmap.days.map((d) => (
                      <th key={d} className="px-1 text-[10px] text-muted-foreground font-normal">{d.slice(5)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {heatmap.matrix.map((row) => (
                    <tr key={row.row}>
                      <td className="pr-2 text-xs font-semibold whitespace-nowrap">{row.row}</td>
                      {row.cells.map((cell, i) => {
                        const r = cell.rate;
                        const bg = r == null ? "hsl(var(--muted))" :
                          r >= 80 ? `hsl(142 65% ${65 - r * 0.15}%)` :
                            r >= 50 ? "hsl(32 95% 60%)" : "hsl(0 75% 60%)";
                        return (
                          <td key={i} title={`${cell.day}: ${r ?? "—"}%`}
                            className="h-7 w-9 rounded text-[10px] text-white text-center align-middle font-mono"
                            style={{ background: bg }}>
                            {r != null ? Math.round(r) : ""}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Rankings */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <Trophy className="h-4 w-4 text-emerald-500" />
                <h3 className="font-semibold text-base">Top 5 branches</h3>
              </div>
              <div className="space-y-2" data-testid="top-branches">
                {top5.map((b, i) => (
                  <div key={b.branch_name} className="flex items-center justify-between rounded-lg border bg-emerald-500/5 p-3">
                    <div className="flex items-center gap-3">
                      <div className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-500 text-white text-sm font-bold">{i + 1}</div>
                      <div>
                        <div className="font-semibold text-sm">{b.branch_name}</div>
                        <div className="text-[11px] text-muted-foreground">{COUNTRY_NAMES[b.branch_country]} · {b.total_employees} employees</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold text-emerald-600">{(b.attendance_rate || 0).toFixed(1)}%</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{(b.avg_hours || 0).toFixed(1)}h avg</div>
                    </div>
                  </div>
                ))}
                {top5.length === 0 && <div className="py-4 text-center text-sm text-muted-foreground">No data</div>}
              </div>
            </Card>

            <Card className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="h-4 w-4 text-rose-500 rotate-180" />
                <h3 className="font-semibold text-base">Needs attention</h3>
              </div>
              <div className="space-y-2" data-testid="bottom-branches">
                {bottom5.map((b, i) => (
                  <div key={b.branch_name} className="flex items-center justify-between rounded-lg border bg-rose-500/5 p-3">
                    <div className="flex items-center gap-3">
                      <div className="grid h-8 w-8 place-items-center rounded-lg bg-rose-500 text-white text-sm font-bold">{i + 1}</div>
                      <div>
                        <div className="font-semibold text-sm">{b.branch_name}</div>
                        <div className="text-[11px] text-muted-foreground">{COUNTRY_NAMES[b.branch_country]} · {b.total_absent} absences</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold text-rose-600">{(b.attendance_rate || 0).toFixed(1)}%</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{b.late_arrivals || 0} late</div>
                    </div>
                  </div>
                ))}
                {bottom5.length === 0 && <div className="py-4 text-center text-sm text-muted-foreground">No data</div>}
              </div>
            </Card>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
