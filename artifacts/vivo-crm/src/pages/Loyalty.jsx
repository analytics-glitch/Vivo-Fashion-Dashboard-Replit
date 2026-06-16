import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoyaltyBadge } from "@/components/LoyaltyBadge";
import TierCustomersModal from "@/components/TierCustomersModal";
import VoucherCostPanel from "@/components/VoucherCostPanel";
import { toast } from "sonner";
import { Award, RefreshCcw, Gift, AlertTriangle, TrendingUp, Settings, Scroll } from "lucide-react";

const fmtKES = (n) => `KES ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function Loyalty() {
  const [distribution, setDistribution] = useState(null);
  const [approaching, setApproaching] = useState([]);
  const [anniversary, setAnniversary] = useState([]);
  const [vouchers, setVouchers] = useState([]);
  const [vouchersTotal, setVouchersTotal] = useState(0);
  const [vouchersOffset, setVouchersOffset] = useState(0);
  const [audit, setAudit] = useState([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditOffset, setAuditOffset] = useState(0);
  const PAGE = 25;
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [selectedTier, setSelectedTier] = useState(null);  // 'bronze' | 'silver' | 'gold' | null
  const [dateFrom, setDateFrom] = useState("");  // empty => lifetime
  const [dateTo, setDateTo] = useState("");
  const [windowLoading, setWindowLoading] = useState(false);
  const navigate = useNavigate();

  const loadAll = async () => {
    setLoading(true);
    try {
      const distParams = dateFrom && dateTo ? { date_from: dateFrom, date_to: dateTo } : {};
      const [d, a, n, v, l, c] = await Promise.all([
        api.get("/loyalty/distribution", { params: distParams }),
        api.get("/loyalty/approaching-upgrade", { params: { within_kes: 50000, limit: 30 } }),
        api.get("/loyalty/anniversary-queue", { params: { within_days: 30 } }),
        api.get("/loyalty/vouchers", { params: { limit: PAGE, offset: vouchersOffset } }),
        api.get("/loyalty/audit", { params: { limit: PAGE, offset: auditOffset } }),
        api.get("/loyalty/config"),
      ]);
      setDistribution(d.data);
      setApproaching(a.data || []);
      setAnniversary(n.data || []);
      setVouchers(v.data?.rows || []);
      setVouchersTotal(v.data?.total || 0);
      setAudit(l.data?.rows || []);
      setAuditTotal(l.data?.total || 0);
      setConfig(c.data);
    } catch (e) { toast.error("Failed to load loyalty data"); }
    setLoading(false);
  };
  useEffect(() => { loadAll(); }, [vouchersOffset, auditOffset]);

  // When the date range changes, re-fetch ONLY the distribution (not full reload)
  useEffect(() => {
    const run = async () => {
      setWindowLoading(true);
      try {
        const params = dateFrom && dateTo ? { date_from: dateFrom, date_to: dateTo } : {};
        const d = await api.get("/loyalty/distribution", { params });
        setDistribution(d.data);
      } catch { toast.error("Could not load window aggregates"); }
      finally { setWindowLoading(false); }
    };
    if (!loading) run();
    // eslint-disable-next-line
  }, [dateFrom, dateTo]);

  const recompute = async () => {
    setRecomputing(true);
    try {
      await api.post("/loyalty/recompute");
      toast.success("Recompute kicked off — refreshing in 30 s");
      setTimeout(loadAll, 30000);
    } catch { toast.error("Could not start recompute"); }
    setTimeout(() => setRecomputing(false), 30000);
  };

  return (
    <div className="max-w-[1400px] mx-auto px-4 md:px-6 py-8" data-testid="loyalty-page">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div>
          <div className="eyebrow inline-flex items-center gap-1.5"><Award className="h-3.5 w-3.5"/>Vivo Loyalty</div>
          <h1 className="font-display text-3xl md:text-4xl mt-1">Bronze · Silver · Gold</h1>
          <div className="text-sm text-[var(--vivo-muted)] mt-1">
            Tier qualification based on rolling 12-month net spend.
          </div>
        </div>
        <Button onClick={recompute} disabled={recomputing} className="bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy)]/90" data-testid="loyalty-recompute">
          <RefreshCcw className={`h-4 w-4 mr-2 ${recomputing ? "animate-spin" : ""}`}/>
          {recomputing ? "Refreshing…" : "Recompute tiers"}
        </Button>
        <Link to="/loyalty/app-preview" className="inline-flex items-center gap-2 h-10 px-4 rounded-md border border-[var(--vivo-gold)] bg-[var(--vivo-bg-soft)] text-sm font-semibold text-[var(--vivo-navy)] hover:bg-[var(--vivo-bg)] press-effect" data-testid="open-app-preview">
          📱 Preview member app
        </Link>
      </div>

      {loading || !distribution ? (
        <div className="text-sm text-[var(--vivo-muted)] py-12">Loading…</div>
      ) : (
        <Tabs defaultValue="overview" className="mt-6">
          <TabsList className="vivo-pill-tabs overflow-x-auto no-scrollbar">
            <TabsTrigger value="overview" data-testid="loyalty-tab-overview">Overview</TabsTrigger>
            <TabsTrigger value="approaching" data-testid="loyalty-tab-approaching">Approaching upgrade</TabsTrigger>
            <TabsTrigger value="anniversary" data-testid="loyalty-tab-anniversary">Anniversary queue</TabsTrigger>
            <TabsTrigger value="vouchers" data-testid="loyalty-tab-vouchers">Vouchers</TabsTrigger>
            <TabsTrigger value="push" data-testid="loyalty-tab-push">Push</TabsTrigger>
            <TabsTrigger value="settings" data-testid="loyalty-tab-settings">Settings</TabsTrigger>
            <TabsTrigger value="audit" data-testid="loyalty-tab-audit">Audit</TabsTrigger>
          </TabsList>

          {/* OVERVIEW */}
          <TabsContent value="overview" className="mt-6">
            {/* Date filter — controls Total Sales / AOV / Frequency on each tier card */}
            <Card className="vivo-card p-4 rounded-sm mb-4" data-testid="loyalty-date-filter">
              <div className="flex flex-wrap items-center gap-3">
                <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">
                  Sales window
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="h-8 w-36 rounded-sm border border-[var(--vivo-border)] text-xs"
                    data-testid="loyalty-date-from"
                  />
                  <span className="text-[var(--vivo-muted)]">→</span>
                  <Input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="h-8 w-36 rounded-sm border border-[var(--vivo-border)] text-xs"
                    data-testid="loyalty-date-to"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  {[
                    { label: "Last 30 days", fn: () => { const d = new Date(); const f = new Date(); f.setDate(f.getDate() - 30); setDateFrom(f.toISOString().slice(0,10)); setDateTo(d.toISOString().slice(0,10)); } },
                    { label: "Last 90 days", fn: () => { const d = new Date(); const f = new Date(); f.setDate(f.getDate() - 90); setDateFrom(f.toISOString().slice(0,10)); setDateTo(d.toISOString().slice(0,10)); } },
                    { label: "Last 12 mo",   fn: () => { const d = new Date(); const f = new Date(); f.setDate(f.getDate() - 365); setDateFrom(f.toISOString().slice(0,10)); setDateTo(d.toISOString().slice(0,10)); } },
                    { label: "YTD",          fn: () => { const d = new Date(); const f = new Date(d.getFullYear(), 0, 1); setDateFrom(f.toISOString().slice(0,10)); setDateTo(d.toISOString().slice(0,10)); } },
                    { label: "Lifetime",     fn: () => { setDateFrom(""); setDateTo(""); } },
                  ].map((p) => (
                    <button
                      key={p.label}
                      onClick={p.fn}
                      className="text-[10px] px-2.5 h-7 rounded-sm border border-[var(--vivo-border)] hover:bg-[var(--vivo-bg-soft)] uppercase tracking-wider press-effect"
                      data-testid={`loyalty-date-preset-${p.label.toLowerCase().replace(/ /g, "-")}`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="ml-auto text-xs text-[var(--vivo-muted)]">
                  {windowLoading && <RefreshCcw className="h-3 w-3 inline animate-spin mr-1"/>}
                  {distribution?.window_applied
                    ? <>Showing sales for <strong className="text-[var(--vivo-navy)]">{dateFrom} → {dateTo}</strong></>
                    : <>Showing <strong className="text-[var(--vivo-navy)]">lifetime</strong> totals</>}
                </div>
              </div>
            </Card>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6" data-testid="loyalty-distribution">
              {distribution.tiers.map((t) => {
                const tierColor =
                  t.tier === "gold" ? "#D4A93B" :
                  t.tier === "silver" ? "#9CA3AF" :
                  t.tier === "dormant" ? "#6B7280" : "#B07A47";
                const isDormant = t.tier === "dormant";
                return (
                  <Card
                    key={t.tier}
                    className="vivo-card p-5 rounded-sm cursor-pointer hover:shadow-lg hover:border-[var(--vivo-navy)] transition-all press-effect"
                    data-testid={`loyalty-tier-${t.tier}`}
                    onClick={() => setSelectedTier(t.tier)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedTier(t.tier); } }}
                    title={`Click to see all ${t.count.toLocaleString()} ${t.tier} members`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <LoyaltyBadge tier={t.tier} />
                      {!isDormant && (
                        <div className="text-[10px] uppercase tracking-wider text-[var(--vivo-muted)]">
                          Target: {t.target_percent}%
                        </div>
                      )}
                    </div>
                    <div className="font-display text-3xl text-[var(--vivo-navy)]">{t.count.toLocaleString()}</div>
                    <div className="text-sm text-[var(--vivo-muted)]">{t.percent}% of {distribution.total_members.toLocaleString()} members</div>
                    {!isDormant && (
                      <div className="mt-3 h-1.5 rounded-sm bg-[var(--vivo-bg)] overflow-hidden">
                        <div className="h-full" style={{ width: `${Math.min(100, (t.percent / Math.max(t.target_percent, 1)) * 100)}%`, backgroundColor: tierColor }} />
                      </div>
                    )}
                    {/* Per-tier business stats — stacked vertically so long KES values fit */}
                    <div className="mt-4 pt-3 border-t border-[var(--vivo-border)] space-y-2.5">
                      <Stat
                        label={distribution?.window_applied ? "Sales in window" : "Total sales (lifetime)"}
                        value={fmtKES(t.total_sales_kes)}
                        testid={`tier-${t.tier}-total-sales`}
                      />
                      {/* Rolling 12-mo net spend — always shown, independent of date filter */}
                      <Stat
                        label="Rolling 12-mo spend"
                        value={fmtKES(t.total_12mo_sales_kes)}
                        testid={`tier-${t.tier}-12mo-spend`}
                        small
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <Stat label="AOV" value={fmtKES(t.aov_kes)} testid={`tier-${t.tier}-aov`} small />
                        <Stat label="Frequency" value={`${(t.frequency || 0).toFixed(1)} ord`} testid={`tier-${t.tier}-frequency`} small />
                      </div>
                      {/* Discounts earned — only meaningful for tiers with a discount % */}
                      {(t.discount_pct || 0) > 0 && (
                        <div className="rounded-sm bg-[var(--vivo-bg-soft)] px-2.5 py-1.5 -mx-1">
                          <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--vivo-muted)]">
                            Discounts received <span className="opacity-70">({t.discount_pct}% off)</span>
                          </div>
                          <div
                            className="text-sm font-semibold text-[var(--vivo-navy)] font-mono-num mt-0.5"
                            data-testid={`tier-${t.tier}-discount-12mo`}
                            title="Estimated savings the tier has received via their member discount over the last 12 months"
                          >
                            {fmtKES(t.estimated_discount_kes_12mo)}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between mt-3 text-[10px]">
                      <span className="text-[var(--vivo-muted)]">
                        {isDormant
                          ? <>No purchase in 12 mo</>
                          : t.percent < t.target_percent
                            ? <>{(t.target_percent - t.percent).toFixed(1)}pp below target</>
                            : <span className="text-green-700">At or above target</span>}
                      </span>
                      <span className="text-[var(--vivo-navy)] font-medium uppercase tracking-wider">View list →</span>
                    </div>
                  </Card>
                );
              })}
            </div>

            {/* VOUCHER COST PROJECTION */}
            <VoucherCostPanel config={config} />

            <Card className="vivo-card p-5 rounded-sm mt-6">
              <div className="text-sm font-semibold mb-3">How members move between tiers</div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs text-[var(--vivo-muted)]">
                <div><strong className="text-[var(--vivo-navy)]">Dormant:</strong> No purchase in the last 12 months. Re-engagement campaign target.</div>
                <div><strong className="text-[var(--vivo-navy)]">Bronze:</strong> Any first purchase, under {fmtKES(config?.qualify?.silver)} in 12 mo. Retains with 1 purchase in any 12-mo period.</div>
                <div><strong className="text-[var(--vivo-navy)]">Silver:</strong> Over {fmtKES(config?.qualify?.silver)} in 12 mo. Retains at {fmtKES(config?.retain?.silver)}. 5% off full-price.</div>
                <div><strong className="text-[var(--vivo-navy)]">Gold:</strong> Over {fmtKES(config?.qualify?.gold)} in 12 mo. Retains at {fmtKES(config?.retain?.gold)}. 10% off full-price.</div>
              </div>
            </Card>
          </TabsContent>

          {/* APPROACHING UPGRADE */}
          <TabsContent value="approaching" className="mt-6">
            <Card className="vivo-card p-5 rounded-sm" data-testid="loyalty-approaching-card">
              <div className="text-sm font-semibold inline-flex items-center gap-2 mb-3"><TrendingUp className="h-4 w-4"/>Within striking distance of upgrade</div>
              {approaching.length === 0 ? (
                <div className="text-sm text-[var(--vivo-muted)]">No customers currently within KES 50,000 of an upgrade.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] border-b border-[var(--vivo-border)]">
                      <th className="py-2">Customer</th>
                      <th className="py-2">From</th>
                      <th className="py-2">To</th>
                      <th className="py-2 text-right">Needs</th>
                      <th className="py-2">Progress</th>
                      <th className="py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {approaching.map((r) => (
                      <tr key={r.customer_id} className="border-b border-[var(--vivo-border)] last:border-0" data-testid={`approaching-row-${r.customer_id}`}>
                        <td className="py-2">
                          <button onClick={() => navigate(`/customers/${r.customer_id}`)} className="text-[var(--vivo-navy)] hover:underline font-medium">
                            {r.customer_name || r.customer_id}
                          </button>
                          {r.city && <span className="text-[11px] text-[var(--vivo-muted)] ml-2">{r.city}</span>}
                        </td>
                        <td className="py-2"><LoyaltyBadge tier={r.loyalty_tier} size="sm"/></td>
                        <td className="py-2"><LoyaltyBadge tier={r.next_tier} size="sm"/></td>
                        <td className="py-2 text-right font-medium">{fmtKES(r.needed_kes)}</td>
                        <td className="py-2 w-40">
                          <div className="h-1.5 bg-[var(--vivo-bg)] rounded-sm overflow-hidden">
                            <div className="h-full" style={{ width: `${r.percent}%`, backgroundColor: r.next_tier === "gold" ? "#D4A93B" : "#9CA3AF" }}/>
                          </div>
                          <div className="text-[10px] text-[var(--vivo-muted)] mt-0.5">{r.percent}%</div>
                        </td>
                        <td className="py-2 text-right">
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => navigate(`/customers/${r.customer_id}`)}>Open</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </TabsContent>

          {/* ANNIVERSARY QUEUE */}
          <TabsContent value="anniversary" className="mt-6">
            <Card className="vivo-card p-5 rounded-sm" data-testid="loyalty-anniversary-card">
              <div className="text-sm font-semibold inline-flex items-center gap-2 mb-3"><AlertTriangle className="h-4 w-4"/>Anniversaries in the next 30 days (Silver + Gold)</div>
              {anniversary.length === 0 ? (
                <div className="text-sm text-[var(--vivo-muted)]">No Silver / Gold anniversaries in the next 30 days.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] border-b border-[var(--vivo-border)]">
                      <th className="py-2">Customer</th>
                      <th className="py-2">Tier</th>
                      <th className="py-2 text-right">12-mo spend</th>
                      <th className="py-2 text-right">Retention req.</th>
                      <th className="py-2 text-right">Days left</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {anniversary.map((r) => (
                      <tr key={r.customer_id} className="border-b border-[var(--vivo-border)] last:border-0" data-testid={`anniversary-row-${r.customer_id}`}>
                        <td className="py-2">
                          <button onClick={() => navigate(`/customers/${r.customer_id}`)} className="text-[var(--vivo-navy)] hover:underline font-medium">{r.customer_name || r.customer_id}</button>
                        </td>
                        <td className="py-2"><LoyaltyBadge tier={r.loyalty_tier} size="sm"/></td>
                        <td className="py-2 text-right">{fmtKES(r.spend_12mo_kes)}</td>
                        <td className="py-2 text-right">{fmtKES(r.retention.required_kes)}</td>
                        <td className="py-2 text-right">{r.days_to_anniversary}</td>
                        <td className="py-2">
                          {r.demotion_risk ? (
                            <span className="text-[11px] uppercase tracking-wider text-red-700 bg-red-50 border border-red-200 rounded-sm px-2 py-0.5">Demotion risk · short {fmtKES(r.retention.shortfall_kes)}</span>
                          ) : (
                            <span className="text-[11px] uppercase tracking-wider text-green-700 bg-green-50 border border-green-200 rounded-sm px-2 py-0.5">Retains</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </TabsContent>

          {/* VOUCHERS */}
          <TabsContent value="vouchers" className="mt-6">
            <Card className="vivo-card p-5 rounded-sm" data-testid="loyalty-vouchers-card">
              <div className="text-sm font-semibold inline-flex items-center gap-2 mb-3"><Gift className="h-4 w-4"/>Vouchers</div>
              {vouchers.length === 0 ? (
                <div className="text-sm text-[var(--vivo-muted)]">No vouchers issued yet. They will auto-issue at the start of each birthday month.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--vivo-muted)] border-b border-[var(--vivo-border)]">
                      <th className="py-2">Customer</th>
                      <th className="py-2">Tier at issue</th>
                      <th className="py-2 text-right">Amount</th>
                      <th className="py-2">Reason</th>
                      <th className="py-2">Status</th>
                      <th className="py-2">Issued</th>
                      <th className="py-2">Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vouchers.map((v) => (
                      <tr key={v.voucher_id} className="border-b border-[var(--vivo-border)] last:border-0" data-testid={`voucher-row-${v.voucher_id}`}>
                        <td className="py-2"><button onClick={() => navigate(`/customers/${v.customer_id}`)} className="text-[var(--vivo-navy)] hover:underline">{v.customer_id}</button></td>
                        <td className="py-2"><LoyaltyBadge tier={v.tier_at_issue} size="sm"/></td>
                        <td className="py-2 text-right font-medium">{fmtKES(v.amount_kes)}</td>
                        <td className="py-2 text-[var(--vivo-muted)]">{v.reason}</td>
                        <td className="py-2">
                          <span className={`text-[11px] uppercase tracking-wider rounded-sm px-2 py-0.5 ${
                            v.status === "redeemed" ? "bg-green-50 text-green-700 border border-green-200" :
                            v.status === "expired" ? "bg-gray-100 text-gray-600 border border-gray-200" :
                            "bg-[var(--vivo-bg)] text-[var(--vivo-navy)] border border-[var(--vivo-gold)]"
                          }`}>{v.status}</span>
                        </td>
                        <td className="py-2 text-[var(--vivo-muted)]">{v.issued_at?.slice(0, 10)}</td>
                        <td className="py-2 text-[var(--vivo-muted)]">{v.expires_at?.slice(0, 10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Pager total={vouchersTotal} offset={vouchersOffset} page={PAGE} onChange={setVouchersOffset} testid="vouchers-pager"/>
            </Card>
          </TabsContent>

          {/* PUSH NOTIFICATIONS — manager-only segmented push to the mobile loyalty app */}
          <TabsContent value="push" className="mt-6">
            <PushComposer/>
          </TabsContent>

          {/* SETTINGS */}
          <TabsContent value="settings" className="mt-6">
            <LoyaltyConfigEditor config={config} onSaved={loadAll}/>
          </TabsContent>

          {/* AUDIT */}
          <TabsContent value="audit" className="mt-6">
            <Card className="vivo-card p-5 rounded-sm" data-testid="loyalty-audit-card">
              <div className="text-sm font-semibold inline-flex items-center gap-2 mb-3"><Scroll className="h-4 w-4"/>Audit trail</div>
              {audit.length === 0 ? (
                <div className="text-sm text-[var(--vivo-muted)]">No loyalty events yet.</div>
              ) : (
                <ul className="space-y-1 text-xs">
                  {audit.map((a) => (
                    <li key={a.audit_id} className="flex items-start gap-3 border-b border-[var(--vivo-border)] py-1.5 last:border-0">
                      <span className="text-[var(--vivo-muted)] w-36 shrink-0">{a.at?.replace("T", " ").slice(0, 16)}</span>
                      <span className="font-semibold text-[var(--vivo-navy)] w-32 shrink-0">{a.action}</span>
                      <span className="text-[var(--vivo-muted)] w-32 shrink-0 truncate">{a.customer_id || "—"}</span>
                      <span className="text-[var(--vivo-muted)] truncate">{JSON.stringify(a.data)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <Pager total={auditTotal} offset={auditOffset} page={PAGE} onChange={setAuditOffset} testid="audit-pager"/>
            </Card>
          </TabsContent>
        </Tabs>
      )}
      {/* Tier drill-down modal — opens when a manager clicks a Bronze/Silver/Gold card */}
      <TierCustomersModal
        open={!!selectedTier}
        onClose={() => setSelectedTier(null)}
        tier={selectedTier || "bronze"}
        total={distribution?.tiers?.find((t) => t.tier === selectedTier)?.count || 0}
      />
    </div>
  );
}


function Stat({ label, value, testid, small }) {
  return (
    <div data-testid={testid}>
      <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--vivo-muted)]">{label}</div>
      <div className={`${small ? "text-sm" : "text-base"} font-semibold text-[var(--vivo-navy)] mt-0.5 font-mono-num truncate`} title={value}>
        {value}
      </div>
    </div>
  );
}


function LoyaltyConfigEditor({ config, onSaved }) {
  const [form, setForm] = useState(() => ({
    silverQ: config?.qualify?.silver,
    goldQ: config?.qualify?.gold,
    silverR: config?.retain?.silver,
    goldR: config?.retain?.gold,
    vBronze: config?.voucher_kes?.bronze,
    vSilver: config?.voucher_kes?.silver,
    vGold: config?.voucher_kes?.gold,
    validity: config?.voucher_validity_days,
    grace: config?.grace_period_days,
  }));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.put("/loyalty/config", {
        qualify: { silver: Number(form.silverQ), gold: Number(form.goldQ) },
        retain: { silver: Number(form.silverR), gold: Number(form.goldR) },
        voucher_kes: { bronze: Number(form.vBronze), silver: Number(form.vSilver), gold: Number(form.vGold) },
        voucher_validity_days: Number(form.validity),
        grace_period_days: Number(form.grace),
      });
      toast.success("Loyalty config saved");
      onSaved?.();
    } catch { toast.error("Could not save config"); }
    setSaving(false);
  };

  const F = ({ k, label, prefix = "KES" }) => (
    <label className="block text-xs">
      <div className="text-[var(--vivo-muted)] mb-1 uppercase tracking-wider">{label}</div>
      <div className="flex items-center gap-2">
        {prefix && <span className="text-[var(--vivo-muted)] text-[11px]">{prefix}</span>}
        <Input type="number" value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className="h-9 rounded-sm" data-testid={`loyalty-config-${k}`}/>
      </div>
    </label>
  );

  return (
    <Card className="vivo-card p-5 rounded-sm" data-testid="loyalty-settings-card">
      <div className="text-sm font-semibold inline-flex items-center gap-2 mb-4"><Settings className="h-4 w-4"/>Thresholds &amp; voucher amounts</div>
      <div className="space-y-5">
        <section>
          <div className="text-xs uppercase tracking-wider text-[var(--vivo-navy)] mb-2">Qualify (rolling 12 mo)</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <F k="silverQ" label="Silver entry threshold"/>
            <F k="goldQ" label="Gold entry threshold"/>
          </div>
        </section>
        <section>
          <div className="text-xs uppercase tracking-wider text-[var(--vivo-navy)] mb-2">Retain (annual)</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <F k="silverR" label="Silver retention floor"/>
            <F k="goldR" label="Gold retention floor"/>
          </div>
        </section>
        <section>
          <div className="text-xs uppercase tracking-wider text-[var(--vivo-navy)] mb-2">Birthday vouchers</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <F k="vBronze" label="Bronze voucher"/>
            <F k="vSilver" label="Silver voucher"/>
            <F k="vGold" label="Gold voucher"/>
          </div>
        </section>
        <section>
          <div className="text-xs uppercase tracking-wider text-[var(--vivo-navy)] mb-2">Timing</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <F k="validity" label="Voucher validity (days)" prefix=""/>
            <F k="grace" label="Grace period after anniversary (days)" prefix=""/>
          </div>
        </section>
        <Button onClick={save} disabled={saving} className="bg-[var(--vivo-navy)] text-white hover:bg-[var(--vivo-navy)]/90" data-testid="loyalty-config-save">
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </Card>
  );
}


function Pager({ total, offset, page, onChange, testid }) {
  if (total <= page) return null;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + page, total);
  const canPrev = offset > 0;
  const canNext = end < total;
  return (
    <div className="flex items-center justify-between mt-4 pt-3 border-t border-[var(--vivo-border)]" data-testid={testid}>
      <span className="text-[11px] text-[var(--vivo-muted)]">{start}–{end} of {total.toLocaleString()}</span>
      <div className="flex items-center gap-1">
        <button onClick={() => canPrev && onChange(Math.max(0, offset - page))} disabled={!canPrev} className="h-8 px-3 rounded-sm border border-[var(--vivo-border)] text-xs text-[var(--vivo-navy)] disabled:opacity-40 disabled:cursor-not-allowed press-effect" data-testid={`${testid}-prev`}>
          ← Prev
        </button>
        <button onClick={() => canNext && onChange(offset + page)} disabled={!canNext} className="h-8 px-3 rounded-sm border border-[var(--vivo-border)] text-xs text-[var(--vivo-navy)] disabled:opacity-40 disabled:cursor-not-allowed press-effect" data-testid={`${testid}-next`}>
          Next →
        </button>
      </div>
    </div>
  );
}


const TIER_OPTIONS = ["bronze", "silver", "gold"];
const CATEGORY_OPTIONS = ["offers", "tier", "events", "general"];

function PushComposer() {
  const [tiers, setTiers] = useState([]);
  const [category, setCategory] = useState("offers");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [deeplink, setDeeplink] = useState("");
  const [scheduleMode, setScheduleMode] = useState("now"); // 'now' | 'later'
  const [scheduledAt, setScheduledAt] = useState("");      // datetime-local value
  const [sending, setSending] = useState(false);
  const [outbox, setOutbox] = useState([]);
  const [outboxLoading, setOutboxLoading] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  const loadOutbox = async () => {
    setOutboxLoading(true);
    try {
      const r = await api.get("/loyalty/push/outbox", { params: { limit: 25 } });
      setOutbox(r.data || []);
    } catch { /* silent */ } finally { setOutboxLoading(false); }
  };
  useEffect(() => { loadOutbox(); }, []);

  const toggleTier = (t) => setTiers((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);

  const cancelAllScheduled = async () => {
    if (!window.confirm("Cancel all scheduled pushes that haven't dispatched yet?")) return;
    try {
      const r = await api.post("/loyalty/push/cancel-all-scheduled");
      toast.success(`Cancelled ${r.data.cancelled} scheduled push${r.data.cancelled === 1 ? "" : "es"}`);
      await loadOutbox();
    } catch {
      toast.error("Could not cancel");
    }
  };

  const send = async () => {
    if (!title.trim() || !body.trim()) {
      toast.error("Title and body are required");
      return;
    }
    let scheduled_at = null;
    if (scheduleMode === "later") {
      if (!scheduledAt) { toast.error("Pick a date & time to schedule"); return; }
      const dt = new Date(scheduledAt);
      if (isNaN(dt.getTime())) { toast.error("Invalid date"); return; }
      if (dt.getTime() < Date.now() - 60_000) { toast.error("Scheduled time must be in the future"); return; }
      scheduled_at = dt.toISOString();
    }
    setSending(true);
    try {
      const segment = { push_opted_in: true, ...(tiers.length ? { loyalty_tiers: tiers } : {}) };
      const r = await api.post("/loyalty/push/send", {
        title: title.trim(), body: body.trim(), deeplink: deeplink.trim() || null,
        category, segment, scheduled_at,
      });
      if (scheduled_at) {
        toast.success(`Scheduled to ${r.data.queued} member${r.data.queued === 1 ? "" : "s"} for ${new Date(scheduled_at).toLocaleString()}`);
      } else {
        toast.success(`Queued for ${r.data.queued} members`);
        try {
          const dispatch = await api.post("/loyalty/push/dispatch-now");
          setLastResult(dispatch.data);
        } catch { /* worker will pick it up next cycle */ }
      }
      setTitle(""); setBody(""); setDeeplink(""); setScheduledAt("");
      await loadOutbox();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not send push");
    } finally {
      setSending(false);
    }
  };

  // Build a default "later" value 24h from now in local datetime-local format
  const defaultLater = useMemo(() => {
    const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
    d.setSeconds(0, 0);
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
  }, []);

  return (
    <div className="space-y-6" data-testid="push-composer">
      <Card className="vivo-card p-5 rounded-sm">
        <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--vivo-muted)]">Compose push</div>
        <h3 className="font-display text-2xl mt-1">Send a notification to members</h3>
        <p className="text-sm text-[var(--vivo-muted)] mt-1">
          Reaches everyone in the selected tier(s) who is opted-in for push and has the loyalty app installed.
        </p>

        {/* Tier selector */}
        <div className="mt-5">
          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)] mb-2">Tiers</div>
          <div className="flex flex-wrap gap-2">
            {TIER_OPTIONS.map((t) => {
              const active = tiers.includes(t);
              return (
                <button
                  key={t}
                  onClick={() => toggleTier(t)}
                  className={`px-3 h-8 rounded-sm border text-xs uppercase tracking-wider press-effect ${active ? "bg-[var(--vivo-navy)] text-white border-[var(--vivo-navy)]" : "border-[var(--vivo-border)] text-[var(--vivo-navy)]"}`}
                  data-testid={`push-tier-${t}`}
                >
                  {t}
                </button>
              );
            })}
            <span className="text-[11px] text-[var(--vivo-muted)] self-center ml-1">{tiers.length === 0 ? "All tiers" : `${tiers.length} selected`}</span>
          </div>
        </div>

        {/* Category */}
        <div className="mt-5">
          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)] mb-2">Category</div>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_OPTIONS.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`px-3 h-8 rounded-sm border text-xs capitalize press-effect ${category === c ? "bg-[var(--vivo-gold,#C9A961)] text-[var(--vivo-navy)] border-[var(--vivo-gold,#C9A961)]" : "border-[var(--vivo-border)] text-[var(--vivo-navy)]"}`}
                data-testid={`push-cat-${c}`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">Title</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={48} placeholder="Weekend trunk show — Two Rivers" className="mt-1 rounded-sm" data-testid="push-title"/>
            <div className="text-[10px] text-[var(--vivo-muted)] mt-1">{title.length}/48</div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">Deep-link (optional)</label>
            <Input value={deeplink} onChange={(e) => setDeeplink(e.target.value)} placeholder="vivo://events/trunk-show" className="mt-1 rounded-sm font-mono text-xs" data-testid="push-deeplink"/>
          </div>
        </div>
        <div className="mt-4">
          <label className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)]">Body</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={160}
            placeholder="Gold members — your invite to Saturday's curated pop-up is live in the app."
            className="mt-1 w-full rounded-sm border border-[var(--vivo-border)] bg-white p-3 text-sm h-24 resize-none"
            data-testid="push-body"
          />
          <div className="text-[10px] text-[var(--vivo-muted)] mt-1">{body.length}/160</div>
        </div>

        {/* Preview */}
        <div className="mt-5 p-4 rounded-sm border border-[var(--vivo-border)] bg-[var(--vivo-bg-soft)]" data-testid="push-preview">
          <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--vivo-muted)] mb-2">Preview</div>
          <div className="max-w-sm mx-auto rounded-2xl bg-[var(--vivo-navy)] text-white p-4 shadow-lg">
            <div className="flex items-start gap-3">
              <div className="h-8 w-8 rounded-sm bg-[var(--vivo-gold,#C9A961)] flex items-center justify-center font-bold text-[var(--vivo-navy)]">V</div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wider opacity-70">Vivo Loyalty · now</div>
                <div className="font-semibold mt-1 truncate">{title || "Your title here"}</div>
                <div className="text-sm opacity-90 mt-0.5 line-clamp-2">{body || "Your message preview will appear here. Keep it warm, specific, and actionable."}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Schedule */}
        <div className="mt-5">
          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--vivo-muted)] mb-2">Schedule</div>
          <div className="flex flex-wrap gap-2 items-center">
            {[
              { v: "now", label: "Send now" },
              { v: "later", label: "Schedule for later" },
            ].map((opt) => (
              <button
                key={opt.v}
                onClick={() => setScheduleMode(opt.v)}
                className={`px-3 h-8 rounded-sm border text-xs press-effect ${scheduleMode === opt.v ? "bg-[var(--vivo-navy)] text-white border-[var(--vivo-navy)]" : "border-[var(--vivo-border)] text-[var(--vivo-navy)]"}`}
                data-testid={`push-schedule-mode-${opt.v}`}
              >
                {opt.label}
              </button>
            ))}
            {scheduleMode === "later" && (
              <Input
                type="datetime-local"
                value={scheduledAt || defaultLater}
                onChange={(e) => setScheduledAt(e.target.value)}
                min={defaultLater}
                className="rounded-sm h-8 text-xs w-[220px]"
                data-testid="push-scheduled-at"
              />
            )}
          </div>
          {scheduleMode === "later" && (
            <div className="text-[10px] text-[var(--vivo-muted)] mt-2">
              Members will receive this push at the chosen time (Africa/Nairobi). Cancel from the outbox below until the dispatcher picks it up.
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button onClick={send} disabled={sending || !title.trim() || !body.trim()} className="rounded-sm" data-testid="push-send-button">
            {sending ? "Sending…" : (scheduleMode === "later" ? "Schedule push" : "Send to members")}
          </Button>
        </div>
        {lastResult && (
          <div className="mt-3 text-xs text-[var(--vivo-muted)]" data-testid="push-last-result">
            Last dispatch tick: claimed {lastResult.claimed}, {lastResult.mock ? "mock-sent" : "sent"} {lastResult.sent}, failed {lastResult.failed}
          </div>
        )}
      </Card>

      {/* Outbox */}
      <Card className="vivo-card p-0 rounded-sm overflow-hidden" data-testid="push-outbox">
        <div className="px-5 py-3 border-b border-[var(--vivo-border)] bg-[var(--vivo-bg-soft)] flex items-center justify-between">
          <div className="font-display text-lg">Outbox</div>
          <div className="flex items-center gap-3">
            <button onClick={cancelAllScheduled} className="text-xs text-red-700 hover:underline" data-testid="push-cancel-all">Cancel all scheduled</button>
            <button onClick={loadOutbox} className="text-xs text-[var(--vivo-muted)] hover:underline">Refresh</button>
          </div>
        </div>
        {outboxLoading ? (
          <div className="p-5 text-sm text-[var(--vivo-muted)]">Loading…</div>
        ) : outbox.length === 0 ? (
          <div className="p-6 text-sm text-[var(--vivo-muted)]">No pushes sent yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-[var(--vivo-muted)] bg-[var(--vivo-bg-soft)]">
              <tr>
                <th className="text-left px-5 py-2">Title</th>
                <th className="text-left px-5 py-2">Status</th>
                <th className="text-left px-5 py-2">Scheduled / Queued</th>
                <th className="text-left px-5 py-2">Sent</th>
              </tr>
            </thead>
            <tbody>
              {outbox.map((r, i) => (
                <tr key={i} className="border-t border-[var(--vivo-border)]">
                  <td className="px-5 py-3 truncate max-w-xs">{r.title}</td>
                  <td className="px-5 py-3">
                    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm ${
                      r.status === "sent" ? "bg-emerald-100 text-emerald-800" :
                      r.status === "mock_sent" ? "bg-blue-50 text-blue-800" :
                      r.status === "failed" ? "bg-red-100 text-red-800" :
                      r.status === "sending" ? "bg-amber-100 text-amber-800" :
                      r.status === "scheduled" ? "bg-purple-100 text-purple-800" :
                      "bg-[var(--vivo-bg)] text-[var(--vivo-muted)]"
                    }`}>{r.status}</span>
                  </td>
                  <td className="px-5 py-3 text-xs text-[var(--vivo-muted)]">
                    {r.scheduled_at ? `⏱ ${r.scheduled_at.slice(0, 16).replace("T", " ")}` : (r.queued_at?.slice(0, 19).replace("T", " ") || "—")}
                  </td>
                  <td className="px-5 py-3 text-xs text-[var(--vivo-muted)]">{(r.sent_at || "—").slice(0, 19).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
