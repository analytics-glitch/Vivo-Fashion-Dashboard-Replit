import React, { useEffect, useState, useCallback } from "react";
import { vivoClient, rebrandHQRow, isHQSource, HQ_LABEL } from "../lib/api";
import AppLayout from "../components/AppLayout";
import { PageHeader, LoadingState, ErrorState } from "../components/UIBits";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import LocationFilter from "../components/LocationFilter";
import { AlertTriangle, Clock, UserX, WifiOff, FileDown } from "lucide-react";
import { exportToExcel } from "../lib/exports";
import { useAuth } from "../lib/auth";

const COUNTRY_NAMES = { KE: "Kenya", UG: "Uganda", RW: "Rwanda" };

export default function Alerts() {
  const { user } = useAuth();
  const [country, setCountry] = useState("all");
  const [location, setLocation] = useState("all");
  const [data, setData] = useState({ missing_checkout_absent: [], consecutive_absences: [], offline_devices: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const params = {};
      if (country !== "all") params.country = country;
      if (location !== "all") params.location = location;
      const { data } = await vivoClient.get("/alerts", { params });
      const raw = data || {};
      // Rebrand any HQ Local Device rows -> HQ
      const rebrandList = (arr) => (arr || []).map(rebrandHQRow);
      let payload = {
        missing_checkout_absent: rebrandList(raw.missing_checkout_absent),
        consecutive_absences: rebrandList(raw.consecutive_absences),
        offline_devices: rebrandList(raw.offline_devices),
      };
      if (user?.role === "branch_manager" && user.branch_assignment) {
        const b = user.branch_assignment;
        payload = {
          missing_checkout_absent: payload.missing_checkout_absent.filter((r) => r.branch_name === b),
          consecutive_absences: payload.consecutive_absences.filter((r) => r.branch_name === b),
          offline_devices: payload.offline_devices.filter((r) => r.branch_name === b),
        };
      }
      setData(payload);
    } catch (e) {
      setErr("Live alerts feed is temporarily unavailable. Showing empty sections — please retry shortly.");
      setData({ missing_checkout_absent: [], consecutive_absences: [], offline_devices: [] });
    }
    finally { setLoading(false); }
  }, [country, location, user]);

  useEffect(() => { load(); }, [load]);

  const missingCheckin = (data.missing_checkout_absent || []).filter((r) => r.attendance_status === "Absent");
  const missingCheckout = (data.missing_checkout_absent || []).filter((r) => r.attendance_status === "Missing Check-Out");

  const exportAll = () => {
    const wb = [];
    missingCheckin.forEach((r) => wb.push({ Type: "Missing check-in", Employee: r.employee_name, Branch: r.branch_name, Country: COUNTRY_NAMES[r.branch_country] || r.branch_country, Date: r.attendance_date }));
    missingCheckout.forEach((r) => wb.push({ Type: "Missing check-out", Employee: r.employee_name, Branch: r.branch_name, Country: COUNTRY_NAMES[r.branch_country] || r.branch_country, Date: r.attendance_date, "Check In": r.check_in_time }));
    (data.consecutive_absences || []).forEach((r) => wb.push({ Type: `Absent ${r.consecutive_days}d consecutive`, Employee: r.employee_name, Branch: r.branch_name, Date: r.last_absent_date }));
    (data.offline_devices || []).forEach((r) => wb.push({ Type: "Offline device", Branch: r.branch_name, Country: COUNTRY_NAMES[r.branch_country] || r.branch_country, "Device Type": r.device_type, "Fail Count": r.fail_count, "Last Seen": r.last_seen }));
    exportToExcel(wb, `vivo-alerts-${new Date().toISOString().slice(0, 10)}.xlsx`, "Alerts");
  };

  const Section = ({ title, count, icon: Icon, color, children, testId }) => (
    <Card className="p-5" data-testid={testId}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`grid h-9 w-9 place-items-center rounded-lg bg-${color}-500/15 text-${color}-600`}>
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">{title}</h3>
            <div className="text-xs text-muted-foreground">{count} item{count !== 1 ? "s" : ""}</div>
          </div>
        </div>
        <Badge variant="secondary" className="text-xs">{count}</Badge>
      </div>
      <div className="max-h-[320px] overflow-y-auto scrollbar-thin space-y-2">{children}</div>
    </Card>
  );

  return (
    <AppLayout onRefresh={load}>
      <PageHeader
        title="Alerts & Issues" subtitle="Today's anomalies, absences, and offline devices" testId="alerts-header"
        actions={<>
          <Select value={country} onValueChange={setCountry}>
            <SelectTrigger className="w-[150px]" data-testid="alerts-country"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All countries</SelectItem>
              <SelectItem value="KE">Kenya</SelectItem>
              <SelectItem value="UG">Uganda</SelectItem>
              <SelectItem value="RW">Rwanda</SelectItem>
            </SelectContent>
          </Select>
          <LocationFilter value={location} onChange={setLocation} label={null} testId="alerts-location" />
          <Button variant="outline" size="sm" onClick={exportAll} data-testid="alerts-export"><FileDown className="h-4 w-4 mr-2" />Export Excel</Button>
        </>}
      />

      {err && <ErrorState message={err} />}
      {loading ? <LoadingState /> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Section title="Missing check-in (absent today)" count={missingCheckin.length} icon={UserX} color="rose" testId="alert-missing-checkin">
            {missingCheckin.length === 0 ? <div className="text-sm text-muted-foreground py-3">All clear</div> :
              missingCheckin.map((r, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border bg-rose-500/5 p-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.employee_name}</div>
                    <div className="text-xs text-muted-foreground">{r.branch_name} · {COUNTRY_NAMES[r.branch_country] || r.branch_country}</div>
                  </div>
                  <Badge variant="destructive" className="text-[10px]">Absent</Badge>
                </div>
              ))}
          </Section>

          <Section title="Missing check-out" count={missingCheckout.length} icon={Clock} color="amber" testId="alert-missing-checkout">
            {missingCheckout.length === 0 ? <div className="text-sm text-muted-foreground py-3">All clear</div> :
              missingCheckout.map((r, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border bg-amber-500/5 p-2.5 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.employee_name}</div>
                    <div className="text-xs text-muted-foreground">{r.branch_name} · checked in {r.check_in_time ? new Date(r.check_in_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</div>
                  </div>
                  <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 hover:bg-amber-500/20 text-[10px]">Open</Badge>
                </div>
              ))}
          </Section>

          <Section title="Absent 3+ consecutive days" count={(data.consecutive_absences || []).length} icon={AlertTriangle} color="rose" testId="alert-consecutive">
            {(data.consecutive_absences || []).length === 0 ? <div className="text-sm text-muted-foreground py-3">No long absences</div> :
              data.consecutive_absences.map((r, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border bg-rose-500/5 p-2.5 text-sm">
                  <div>
                    <div className="font-medium">{r.employee_name}</div>
                    <div className="text-xs text-muted-foreground">{r.branch_name} · last absent {r.last_absent_date}</div>
                  </div>
                  <Badge variant="destructive" className="text-[10px]">{r.consecutive_days} days</Badge>
                </div>
              ))}
          </Section>

          <Section title="Offline devices" count={(data.offline_devices || []).length} icon={WifiOff} color="slate" testId="alert-offline-devices">
            {(data.offline_devices || []).length === 0 ? <div className="text-sm text-muted-foreground py-3">All devices online</div> :
              data.offline_devices.map((r, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg border bg-slate-500/5 p-2.5 text-sm">
                  <div>
                    <div className="font-medium">{r.branch_name}</div>
                    <div className="text-xs text-muted-foreground">{COUNTRY_NAMES[r.branch_country] || r.branch_country} · {r.device_type} · fails: {r.fail_count}</div>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">Last seen {r.last_seen?.slice(0, 10) || "—"}</Badge>
                </div>
              ))}
          </Section>
        </div>
      )}
    </AppLayout>
  );
}
