import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtNum, fmtKES, fmtKESLong, fmtPct, buildParams } from "@/lib/api";
import { Loading, ErrorBox, SectionTitle } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { KPICard } from "@/components/KPICard";
import { UsersThree, Crown, Warning, Pulse } from "@phosphor-icons/react";

// Repeat-Purchase / RFM segments. Recency (days since last purchase, vs the
// period end), Frequency (orders) and Monetary (net spend) are each scored 1–5
// via quintiles on the server; segments follow the canonical RFM grid.

// Display order + accent for each segment. Colors stay within the editorial
// palette (safari-green good, amber watch, red risk, muted neutral).
const SEG_META = {
  "Champions":           { cls: "text-brand font-semibold", desc: "Recent, frequent, high spend" },
  "Loyal":               { cls: "text-brand font-semibold", desc: "Consistent repeat buyers" },
  "Potential Loyalist":  { cls: "text-[#1a5c38]", desc: "Recent buyers gaining momentum" },
  "New":                 { cls: "text-[#4b7bec] font-semibold", desc: "Recent first purchases" },
  "Promising":           { cls: "text-[#4b7bec]", desc: "Recent, low frequency so far" },
  "At Risk":             { cls: "text-amber-600 font-semibold", desc: "Were valuable, slipping away" },
  "Cant Lose Them":      { cls: "text-danger font-semibold", desc: "High value, gone quiet" },
  "Hibernating":         { cls: "text-amber-700", desc: "Low activity, low value" },
  "Lost":                { cls: "text-muted", desc: "No recent activity" },
};
const segCls = (s) => SEG_META[s]?.cls || "text-foreground";
const ORDER = Object.keys(SEG_META);

const RFM = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { dateFrom, dateTo, countries, channels, dataVersion } = applied;
  const filters = { dateFrom, dateTo, countries, channels };

  const [summary, setSummary] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get("/analytics/rfm", { params: buildParams(filters, { limit: 2000 }) })
      .then((r) => {
        if (cancelled) return;
        setSummary(r.data?.summary || []);
        setCustomers(r.data?.customers || []);
        touchLastUpdated();
      })
      .catch((e) => !cancelled && setError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [dateFrom, dateTo, JSON.stringify(countries), JSON.stringify(channels), dataVersion]);

  const k = useMemo(() => {
    const total = summary.reduce((s, r) => s + Number(r.customers || 0), 0);
    const monetary = summary.reduce((s, r) => s + Number(r.monetary || 0), 0);
    const champ = summary.find((r) => r.segment === "Champions")?.customers || 0;
    const risk = summary
      .filter((r) => ["At Risk", "Cant Lose Them"].includes(r.segment))
      .reduce((s, r) => s + Number(r.customers || 0), 0);
    return { total, monetary, champ, risk };
  }, [summary]);

  const segView = useMemo(() => {
    const idx = (s) => { const i = ORDER.indexOf(s); return i === -1 ? 999 : i; };
    return [...summary]
      .map((r) => ({ ...r, pct: k.total ? (Number(r.customers || 0) * 100) / k.total : 0 }))
      .sort((a, b) => idx(a.segment) - idx(b.segment));
  }, [summary, k.total]);

  const segColumns = [
    { key: "segment", label: "Segment", mobilePrimary: true,
      render: (r) => (
        <div>
          <span className={segCls(r.segment)}>{r.segment}</span>
          <div className="text-[11px] text-muted">{SEG_META[r.segment]?.desc || ""}</div>
        </div>
      ),
      csv: (r) => r.segment },
    { key: "customers", label: "Customers", numeric: true, render: (r) => fmtNum(r.customers) },
    { key: "pct", label: "% of Base", numeric: true, render: (r) => fmtPct(r.pct) },
    { key: "monetary", label: "Net Spend (KES)", numeric: true, render: (r) => fmtKESLong(r.monetary) },
    { key: "avg_monetary", label: "Avg Spend (KES)", numeric: true, render: (r) => fmtKESLong(r.avg_monetary) },
    { key: "avg_frequency", label: "Avg Orders", numeric: true, render: (r) => fmtNum(r.avg_frequency) },
    { key: "avg_recency_days", label: "Avg Recency (days)", numeric: true, render: (r) => fmtNum(r.avg_recency_days) },
  ];

  const custColumns = [
    { key: "customer_id", label: "Customer", mobilePrimary: true,
      render: (r) => <span className="font-medium">{r.customer_id || "—"}</span> },
    { key: "segment", label: "Segment", render: (r) => <span className={segCls(r.segment)}>{r.segment}</span> },
    { key: "recency_days", label: "Recency (days)", numeric: true, render: (r) => fmtNum(r.recency_days) },
    { key: "frequency", label: "Orders", numeric: true, render: (r) => fmtNum(r.frequency) },
    { key: "monetary", label: "Net Spend (KES)", numeric: true, render: (r) => fmtKESLong(r.monetary) },
    { key: "r_score", label: "R", numeric: true, render: (r) => fmtNum(r.r_score) },
    { key: "f_score", label: "F", numeric: true, render: (r) => fmtNum(r.f_score) },
    { key: "m_score", label: "M", numeric: true, render: (r) => fmtNum(r.m_score) },
  ];

  if (loading) return <Loading label="Segmenting customers…" />;
  if (error) return <ErrorBox message={error} />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard label="Customers" value={fmtNum(k.total)} icon={UsersThree} testId="kpi-rfm-total" showDelta={false} sub="Scored base: ≥1 order & net spend > 0 in period" />
        <KPICard label="Net Spend" value={fmtKES(k.monetary)} valueFull={fmtKESLong(k.monetary)} icon={Pulse} testId="kpi-rfm-spend" showDelta={false} sub="Net of returns" formula="Same net formula as the Overview ‘Net Sales’ KPI (after discounts, minus returns, VAT-exclusive) but counted only for identified customers — anonymous/walk-in orders and return-only customers are excluded — so it reads below the canonical Overview Net Sales." />
        <KPICard label="Champions" value={fmtNum(k.champ)} icon={Crown} testId="kpi-rfm-champ" showDelta={false} sub="Recent, frequent, high spend" />
        <KPICard label="At Risk / Can't Lose" value={fmtNum(k.risk)} icon={Warning} testId="kpi-rfm-risk" showDelta={false} sub="Win-back priority" />
      </div>

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title="RFM Segments"
          subtitle="Customers scored 1–5 on Recency, Frequency and Monetary value, then grouped into the canonical RFM segments."
          testId="rfm-summary-section"
        />
        <SortableTable
          columns={segColumns}
          rows={segView}
          exportName="rfm-segments.csv"
          testId="rfm-summary-table"
          mobileCards
          emptyLabel="No customers for the selected filters."
        />
      </div>

      <div className="card-white p-4 sm:p-5">
        <SectionTitle
          title="Top Customers by Value"
          subtitle="Highest net spend in the period with their R/F/M scores (1 = lowest, 5 = highest)."
          testId="rfm-customers-section"
        />
        <SortableTable
          columns={custColumns}
          rows={customers}
          initialSort={{ key: "monetary", dir: "desc" }}
          exportName="rfm-top-customers.csv"
          testId="rfm-customers-table"
          pageSize={50}
          mobileCards
          emptyLabel="No customers for the selected filters."
        />
      </div>
    </div>
  );
};

export default RFM;
