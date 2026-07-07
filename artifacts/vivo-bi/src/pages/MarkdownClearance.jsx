import React, { useEffect, useMemo, useState } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtKES, fmtNum, fmtPct } from "@/lib/api";
import { Loading, ErrorBox, Empty, SectionTitle } from "@/components/common";
import SortableTable from "@/components/SortableTable";
import { KPICard } from "@/components/KPICard";
import { TagChevron, Storefront, Coins, Package, Warning, CalendarBlank } from "@phosphor-icons/react";

// Markdown & Clearance — surfaces slow-moving, overstocked styles that warrant a
// price markdown, plus a store-level clearance schedule split by urgency.
// Data:
//   GET /api/analytics/markdown-candidates  (country only)
//   GET /api/analytics/clearance-plan       (country only)

const wocTag = (woc) => {
  const v = Number(woc);
  if (woc === null || woc === undefined || isNaN(v)) return { cls: "pill-neutral", label: "—" };
  if (v > 52) return { cls: "pill-red", label: `${v}w` };
  if (v > 26) return { cls: "pill-amber", label: `${v}w` };
  return { cls: "pill-neutral", label: `${v}w` };
};

const stTag = (st) => {
  const v = Number(st);
  if (st === null || st === undefined || isNaN(v)) return { cls: "text-muted", label: "—" };
  if (v < 10) return { cls: "text-danger font-semibold", label: fmtPct(v) };
  if (v < 20) return { cls: "text-amber-600 font-semibold", label: fmtPct(v) };
  return { cls: "text-foreground", label: fmtPct(v) };
};

const ClearanceGroup = ({ title, intro, group, accent }) => {
  const byStore = group?.by_store || {};
  const stores = Object.keys(byStore).sort((a, b) => byStore[b].length - byStore[a].length);
  return (
    <div className="card-white p-4 sm:p-5" data-testid={`clearance-group-${accent}`}>
      <SectionTitle
        title={title}
        subtitle={intro}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span className={accent === "immediate" ? "pill-red" : "pill-amber"}>
              {fmtNum(group?.count || 0)} styles
            </span>
            <span className="pill-neutral">{fmtNum(group?.total_units || 0)} units</span>
            <span className="pill-neutral">{fmtKES(group?.estimated_recovery_kes || 0)} est. recovery</span>
          </div>
        }
      />
      {stores.length === 0 ? (
        <Empty label="No styles in this urgency band for the current filters." />
      ) : (
        <div className="space-y-4">
          {stores.map((store) => (
            <div key={store} className="rounded-lg border border-border bg-panel/40 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Storefront size={15} weight="duotone" className="text-muted" />
                <span className="font-semibold text-[13px] text-foreground break-words">{store}</span>
                <span className="pill-neutral ml-auto">{byStore[store].length} styles</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {byStore[store].map((c, i) => {
                  const t = wocTag(c.current_woc);
                  return (
                    <span
                      key={`${c.style_name}-${i}`}
                      className="inline-flex items-center gap-2 rounded-full border border-border bg-white px-2.5 py-1 text-[11.5px]"
                      title={`${c.style_name} — ${c.recommended_markdown_pct}% off · ${c.total_units} units · ${c.current_woc}w cover`}
                    >
                      <span className="font-medium text-foreground break-words max-w-[180px]">{c.style_name}</span>
                      <span className="font-bold text-brand-deep">-{c.recommended_markdown_pct}%</span>
                      <span className="text-muted">{fmtNum(c.total_units)}u</span>
                      <span className={t.cls}>{t.label}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const MarkdownClearance = () => {
  const { applied, touchLastUpdated } = useFilters();
  const { countries, dataVersion } = applied;

  const [tab, setTab] = useState("candidates");

  const [mk, setMk] = useState(null);
  const [mkLoading, setMkLoading] = useState(true);
  const [mkError, setMkError] = useState(null);

  const [cp, setCp] = useState(null);
  const [cpLoading, setCpLoading] = useState(true);
  const [cpError, setCpError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const country = countries.length === 1 ? countries[0] : undefined;

    setMkLoading(true);
    setMkError(null);
    api
      .get("/analytics/markdown-candidates", { params: { country } })
      .then(({ data }) => {
        if (cancelled) return;
        setMk(data || null);
        touchLastUpdated();
      })
      .catch((e) => !cancelled && setMkError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setMkLoading(false));

    setCpLoading(true);
    setCpError(null);
    api
      .get("/analytics/clearance-plan", { params: { country } })
      .then(({ data }) => {
        if (cancelled) return;
        setCp(data || null);
      })
      .catch((e) => !cancelled && setCpError(e?.response?.data?.detail || e.message))
      .finally(() => !cancelled && setCpLoading(false));

    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [JSON.stringify(countries), dataVersion]);

  const candidates = useMemo(() => mk?.candidates || [], [mk]);

  const columns = [
    { key: "style_name", label: "Style", mobilePrimary: true,
      render: (r) => <span className="font-medium break-words max-w-[260px] inline-block">{r.style_name || "—"}</span>,
      csv: (r) => r.style_name || "" },
    { key: "brand", label: "Brand", align: "left",
      render: (r) => <span className="pill-neutral">{r.brand || "—"}</span>, csv: (r) => r.brand || "" },
    { key: "subcategory", label: "Subcategory", align: "left", mobileHidden: true,
      render: (r) => <span className="text-muted">{r.subcategory || "—"}</span>, csv: (r) => r.subcategory || "" },
    { key: "total_units", label: "Units on Hand", numeric: true,
      render: (r) => fmtNum(r.total_units), csv: (r) => r.total_units },
    { key: "current_woc", label: "WoC", numeric: true,
      render: (r) => { const t = wocTag(r.current_woc); return <span className={t.cls}>{t.label}</span>; },
      sortValue: (r) => Number(r.current_woc || 0), csv: (r) => r.current_woc },
    { key: "sell_through_8wk", label: "Sell-Through (8wk)", numeric: true,
      render: (r) => { const t = stTag(r.sell_through_8wk); return <span className={t.cls}>{t.label}</span>; },
      sortValue: (r) => Number(r.sell_through_8wk || 0), csv: (r) => r.sell_through_8wk },
    { key: "recommended_markdown_pct", label: "Recommended Markdown", numeric: true,
      render: (r) => <span className="font-bold text-brand-deep">-{fmtNum(r.recommended_markdown_pct)}%</span>,
      sortValue: (r) => Number(r.recommended_markdown_pct || 0), csv: (r) => r.recommended_markdown_pct },
    { key: "estimated_markdown_revenue_kes", label: "Estimated Revenue", numeric: true,
      render: (r) => <span className="text-brand font-bold">{fmtKES(r.estimated_markdown_revenue_kes)}</span>,
      sortValue: (r) => Number(r.estimated_markdown_revenue_kes || 0), csv: (r) => r.estimated_markdown_revenue_kes },
    { key: "affected_stores", label: "Stores", align: "left", sortable: false, mobileHidden: true,
      render: (r) => <span className="text-[12px] text-muted break-words">{r.affected_stores || "—"}</span>,
      csv: (r) => r.affected_stores || "" },
  ];

  return (
    <div className="space-y-6" data-testid="markdown-clearance-page">
      <div>
        <p className="text-muted text-[13px] mt-1">
          Slow-moving, overstocked styles flagged for price markdown, with a
          store-level clearance schedule split by urgency. All money in KES.
        </p>
      </div>

      {/* tabs */}
      <div className="inline-flex rounded-lg border border-border overflow-hidden" role="tablist" data-testid="mc-tabs">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "candidates"}
          onClick={() => setTab("candidates")}
          className={`px-4 py-2 text-[12.5px] font-medium ${tab === "candidates" ? "bg-brand text-white" : "bg-white hover:bg-panel"}`}
          data-testid="mc-tab-candidates"
        >
          Clearance Candidates
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "clearance"}
          onClick={() => setTab("clearance")}
          className={`px-4 py-2 text-[12.5px] font-medium border-l border-border ${tab === "clearance" ? "bg-brand text-white" : "bg-white hover:bg-panel"}`}
          data-testid="mc-tab-clearance"
        >
          Clearance Plan
        </button>
      </div>

      {tab === "candidates" && (
        <>
          {mkLoading && <Loading label="Scanning for clearance candidates…" />}
          {!mkLoading && mkError && <ErrorBox message={mkError} />}
          {!mkLoading && !mkError && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KPICard testId="mc-kpi-count" accent label="Clearance Candidates"
                  value={fmtNum(mk?.total || 0)} icon={TagChevron} showDelta={false}
                  sub="Overstocked, slow-moving styles" />
                <KPICard testId="mc-kpi-units" label="Units to Clear"
                  value={fmtNum(mk?.total_units || 0)} icon={Package} showDelta={false} />
                <KPICard testId="mc-kpi-recovery" label="Est. Recovery"
                  value={fmtKES(mk?.estimated_recovery_kes || 0)}
                  valueFull={fmtNum(mk?.estimated_recovery_kes || 0)}
                  icon={Coins} showDelta={false} sub="At recommended markdown" />
                <KPICard testId="mc-kpi-avg-md" label="Avg Markdown"
                  value={candidates.length
                    ? fmtPct(candidates.reduce((s, c) => s + Number(c.recommended_markdown_pct || 0), 0) / candidates.length, 0)
                    : "—"}
                  icon={Warning} showDelta={false} />
              </div>

              <div className="card-white p-4 sm:p-5" data-testid="mc-candidates-card">
                <SectionTitle
                  title={`Clearance Candidates · ${candidates.length} styles`}
                  subtitle="Styles with high weeks-of-cover and weak 8-week sell-through. Recommended markdown scales with overstock depth."
                />
                {candidates.length === 0 ? (
                  <Empty label="No clearance candidates for the current filters." />
                ) : (
                  <SortableTable
                    columns={columns}
                    rows={candidates}
                    initialSort={{ key: "estimated_markdown_revenue_kes", dir: "desc" }}
                    exportName="markdown-candidates.csv"
                    testId="mc-candidates-table"
                    pageSize={50}
                    mobileCards
                  />
                )}
              </div>
            </>
          )}
        </>
      )}

      {tab === "clearance" && (
        <>
          {cpLoading && <Loading label="Building clearance schedule…" />}
          {!cpLoading && cpError && <ErrorBox message={cpError} />}
          {!cpLoading && !cpError && (
            <>
              {cp?.season_timing && (
                <div className="card-white p-4 bg-panel flex items-center gap-2" data-testid="mc-season">
                  <CalendarBlank size={16} weight="duotone" className="text-brand" />
                  <span className="text-[12.5px] text-muted">
                    <span className="font-semibold text-foreground">Season timing:</span>{" "}
                    {cp.season_timing}
                  </span>
                </div>
              )}
              {(!cp || ((cp.immediate?.count || 0) === 0 && (cp.planned?.count || 0) === 0)) ? (
                <Empty label="No clearance actions required for the current filters." />
              ) : (
                <>
                  <ClearanceGroup
                    title="Immediate"
                    intro="Critical overstock (over 26 weeks of cover) — mark down now to free cash and floor space."
                    group={cp.immediate}
                    accent="immediate"
                  />
                  <ClearanceGroup
                    title="Planned"
                    intro="Building overstock (16–26 weeks of cover) — schedule a markdown into the next clearance window."
                    group={cp.planned}
                    accent="planned"
                  />
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

export default MarkdownClearance;
