import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Download, RefreshCcw, BarChart3, Award, LifeBuoy } from "lucide-react";

const errOf = (e) =>
  e?.response?.data?.detail || e?.message || "Something went wrong";

const titleCase = (s) =>
  (s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const kes = (n) =>
  "KES " + Math.round(Number(n) || 0).toLocaleString("en-KE");
const num = (n) => (Number(n) || 0).toLocaleString("en-KE");

const inputCls =
  "h-9 w-full rounded-sm border border-[var(--vivo-border)] bg-white px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--vivo-navy)]";

function Section({ icon: Icon, title, subtitle, children, right }) {
  return (
    <Card className="vivo-card rounded-sm p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {Icon && (
            <span className="grid h-9 w-9 place-items-center rounded-sm bg-[var(--vivo-bg-soft)] text-[var(--vivo-navy)]">
              <Icon className="h-4.5 w-4.5" />
            </span>
          )}
          <div>
            <h2 className="font-display text-lg text-[var(--vivo-navy)]">{title}</h2>
            {subtitle && (
              <p className="text-[12.5px] text-[var(--vivo-muted)]">{subtitle}</p>
            )}
          </div>
        </div>
        {right}
      </div>
      {children}
    </Card>
  );
}

function Kpi({ label, value, accent }) {
  return (
    <div className="rounded-sm border border-[var(--vivo-border)] bg-white p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">
        {label}
      </div>
      <div
        className="mt-1 font-display text-xl"
        style={{ color: accent ? "var(--vivo-gold)" : "var(--vivo-navy)" }}
      >
        {value}
      </div>
    </div>
  );
}

function MiniTable({ cols, rows, empty = "No data" }) {
  if (!rows || rows.length === 0)
    return <div className="py-6 text-center text-[12.5px] text-[var(--vivo-muted)]">{empty}</div>;
  return (
    <table className="min-w-full text-[13px]">
      <thead>
        <tr className="border-b border-[var(--vivo-border)] text-left text-[11px] uppercase tracking-wide text-[var(--vivo-muted)]">
          {cols.map((c) => (
            <th key={c.key} className={`px-3 py-2 font-semibold ${c.right ? "text-right" : ""}`}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-[var(--vivo-border)]/60">
            {cols.map((c) => (
              <td key={c.key} className={`px-3 py-2 text-[var(--vivo-text)] ${c.right ? "text-right tabular-nums" : ""}`}>
                {c.render ? c.render(r) : r[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const TIERS = ["", "bronze", "silver", "gold", "vip"];

export default function Reports() {
  const [seg, setSeg] = useState(null);
  const [loyalty, setLoyalty] = useState(null);
  const [service, setService] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);

  // service-metrics date filter
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // segmentation export builder
  const [exp, setExp] = useState({
    tier: "",
    min_orders: "",
    max_orders: "",
    channel: "",
    store_id: "",
    country: "",
    affinity: "",
  });
  const [downloading, setDownloading] = useState(false);

  const loadReports = () => {
    setLoading(true);
    setErr(null);
    Promise.all([
      api.get("/crm/reports/customers-by-segment"),
      api.get("/crm/reports/loyalty-engagement"),
    ])
      .then(([s, l]) => {
        setSeg(s.data);
        setLoyalty(l.data);
      })
      .catch((e) => setErr(errOf(e)))
      .finally(() => setLoading(false));
  };

  const loadService = () => {
    const params = {};
    if (from && to) {
      params.date_from = from;
      params.date_to = to;
    }
    api
      .get("/crm/reports/service-metrics", { params })
      .then((r) => setService(r.data))
      .catch((e) => setErr(errOf(e)));
  };

  useEffect(() => {
    loadReports();
    loadService();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setE = (k, v) => setExp((p) => ({ ...p, [k]: v }));

  const downloadExport = async () => {
    setDownloading(true);
    try {
      const params = {};
      Object.entries(exp).forEach(([k, v]) => {
        if (String(v).trim() !== "") params[k] = v;
      });
      const res = await api.get("/crm/segments/export", {
        params,
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = "vfg_segment_export.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast.success("Segment export downloaded");
    } catch (e) {
      toast.error(errOf(e));
    } finally {
      setDownloading(false);
    }
  };

  const ss = service?.summary || {};

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-[var(--vivo-navy)]">Reports & segmentation</h1>
          <p className="text-sm text-[var(--vivo-muted)]">
            Customer segments, loyalty engagement, service metrics, and CSV segment export.
          </p>
        </div>
        <Button
          variant="outline"
          className="press-effect h-9 gap-1.5"
          onClick={() => {
            loadReports();
            loadService();
          }}
          data-testid="button-refresh-reports"
        >
          <RefreshCcw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {err && (
        <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {err}
        </div>
      )}

      {/* Segmentation export builder */}
      <Section
        icon={Download}
        title="Segmentation export"
        subtitle="Combine filters (tier, frequency, channel, store, country, product affinity). Max 10,000 rows."
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="block">
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Tier</div>
            <select value={exp.tier} onChange={(e) => setE("tier", e.target.value)} className={inputCls} data-testid="export-tier">
              {TIERS.map((t) => (
                <option key={t} value={t}>{t ? titleCase(t) : "Any tier"}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Min orders</div>
            <Input type="number" min="0" value={exp.min_orders} onChange={(e) => setE("min_orders", e.target.value)} className={inputCls} data-testid="export-min-orders" />
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Max orders</div>
            <Input type="number" min="0" value={exp.max_orders} onChange={(e) => setE("max_orders", e.target.value)} className={inputCls} data-testid="export-max-orders" />
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Country</div>
            <Input value={exp.country} onChange={(e) => setE("country", e.target.value)} placeholder="e.g. Kenya" className={inputCls} data-testid="export-country" />
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Store ID</div>
            <Input value={exp.store_id} onChange={(e) => setE("store_id", e.target.value)} placeholder="e.g. vivowoman" className={inputCls} data-testid="export-store" />
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Dominant channel</div>
            <Input value={exp.channel} onChange={(e) => setE("channel", e.target.value)} placeholder="e.g. Online" className={inputCls} data-testid="export-channel" />
          </label>
          <label className="block">
            <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--vivo-muted)]">Product affinity</div>
            <Input value={exp.affinity} onChange={(e) => setE("affinity", e.target.value)} placeholder="e.g. Dresses" className={inputCls} data-testid="export-affinity" />
          </label>
          <div className="flex items-end">
            <Button
              className="press-effect h-9 w-full gap-1.5"
              onClick={downloadExport}
              disabled={downloading}
              data-testid="button-download-export"
            >
              <Download className="h-4 w-4" />
              {downloading ? "Preparing…" : "Download CSV"}
            </Button>
          </div>
        </div>
      </Section>

      {/* Customers by segment */}
      <Section icon={BarChart3} title="Customers by segment" subtitle="Counts and net spend per behavioural segment.">
        {loading ? (
          <div className="py-6 text-center text-[12.5px] text-[var(--vivo-muted)]">Loading…</div>
        ) : (
          <MiniTable
            cols={[
              { key: "label", label: "Segment" },
              { key: "count", label: "Customers", right: true, render: (r) => num(r.count) },
              { key: "spend_kes", label: "Net spend", right: true, render: (r) => kes(r.spend_kes) },
            ]}
            rows={seg?.segments || []}
          />
        )}
      </Section>

      {/* Loyalty engagement */}
      <Section icon={Award} title="Loyalty engagement" subtitle="Membership, tier distribution and points flow.">
        {loading ? (
          <div className="py-6 text-center text-[12.5px] text-[var(--vivo-muted)]">Loading…</div>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Kpi label="Members" value={num(loyalty?.summary?.members)} accent />
              <Kpi label="Active (90d)" value={num(loyalty?.summary?.active_members_90d)} />
              <Kpi label="Points balance" value={num(loyalty?.summary?.points_balance)} />
              <Kpi label="Avg balance" value={num(loyalty?.summary?.avg_balance)} />
              <Kpi label="Points earned" value={num(loyalty?.summary?.points_earned)} />
              <Kpi label="Points redeemed" value={num(loyalty?.summary?.points_redeemed)} />
              <Kpi label="Points expired" value={num(loyalty?.summary?.points_expired)} />
              <Kpi label="Lifetime points" value={num(loyalty?.summary?.points_lifetime)} />
            </div>
            <MiniTable
              cols={[
                { key: "tier", label: "Tier" },
                { key: "members", label: "Members", right: true, render: (r) => num(r.members) },
                { key: "points_balance", label: "Points balance", right: true, render: (r) => num(r.points_balance) },
              ]}
              rows={loyalty?.by_tier || []}
            />
          </>
        )}
      </Section>

      {/* Service metrics */}
      <Section
        icon={LifeBuoy}
        title="Service metrics"
        subtitle="Ticket volumes, SLA breach rate, resolution time and CSAT."
        right={
          <div className="flex items-end gap-2">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`${inputCls} w-[150px]`} data-testid="service-from" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={`${inputCls} w-[150px]`} data-testid="service-to" />
            <Button variant="outline" className="press-effect h-9" onClick={loadService} data-testid="button-apply-service-dates">
              Apply
            </Button>
          </div>
        }
      >
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Total tickets" value={num(ss.total)} accent />
          <Kpi label="Open" value={num(ss.open)} />
          <Kpi label="Closed" value={num(ss.closed)} />
          <Kpi label="SLA breach rate" value={`${ss.breach_rate ?? 0}%`} />
          <Kpi label="Avg resolution" value={`${ss.avg_resolution_hours ?? 0} h`} />
          <Kpi label="Avg CSAT" value={ss.avg_csat ?? 0} />
          <Kpi label="CSAT responses" value={num(ss.csat_responses)} />
          <Kpi label="Breached" value={num(ss.breached)} />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <div className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--vivo-muted)]">By channel</div>
            <MiniTable
              cols={[
                { key: "key", label: "Channel", render: (r) => titleCase(r.key) },
                { key: "count", label: "Tickets", right: true, render: (r) => num(r.count) },
              ]}
              rows={service?.by_channel || []}
            />
          </div>
          <div>
            <div className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--vivo-muted)]">By category</div>
            <MiniTable
              cols={[
                { key: "key", label: "Category", render: (r) => titleCase(r.key) },
                { key: "count", label: "Tickets", right: true, render: (r) => num(r.count) },
              ]}
              rows={service?.by_category || []}
            />
          </div>
          <div>
            <div className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--vivo-muted)]">By status</div>
            <MiniTable
              cols={[
                { key: "key", label: "Status", render: (r) => titleCase(r.key) },
                { key: "count", label: "Tickets", right: true, render: (r) => num(r.count) },
              ]}
              rows={service?.by_status || []}
            />
          </div>
          <div>
            <div className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--vivo-muted)]">By escalation level</div>
            <MiniTable
              cols={[
                { key: "key", label: "Level", render: (r) => titleCase(r.key) },
                { key: "count", label: "Tickets", right: true, render: (r) => num(r.count) },
              ]}
              rows={service?.by_escalation || []}
            />
          </div>
        </div>
      </Section>
    </div>
  );
}
