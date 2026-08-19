import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { ImageIcon, MoveRight, RefreshCw, Target, X } from 'lucide-react';

type AssortmentQuarter = 'Q3 2026' | 'Q4 2026';
type AssortmentTier = 'NOOS' | 'Core' | 'Recent' | 'New/Test';

type AssortmentStyle = {
  id: string;
  pdId: number | null;
  source: 'all_products_clean' | 'pd_styles';
  styleNumber: string;
  name: string;
  category: string;
  subCategory: string;
  stage: string;
  designer: string;
  season: string;
  tier: AssortmentTier;
  status: string;
  excluded: boolean;
  image: string | null;
};

type AssortmentSummary = {
  total: number;
  counts: { total: number; noos: number; core: number; recent: number; newTest: number };
};

type AssortmentResponse = {
  assortmentQuarter: AssortmentQuarter;
  assortmentStyles: AssortmentStyle[];
  carryOverStyles: AssortmentStyle[];
  newStyles: AssortmentStyle[];
  assortmentSummary: AssortmentSummary;
  quarterSummaries: Record<AssortmentQuarter, AssortmentSummary>;
};

const quarters: AssortmentQuarter[] = ['Q3 2026', 'Q4 2026'];

function numberFormat(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 }).format(Number(value));
}

function displayTier(tier: AssortmentTier) {
  return tier === 'New/Test' ? 'New' : tier;
}

async function getAssortmentPlan(quarter: AssortmentQuarter) {
  const response = await fetch(`/api/workspace/range-plan?quarter=${encodeURIComponent(quarter)}`, {
    credentials: 'include',
  });
  if (!response.ok) throw new Error(`Assortment Plan request failed (${response.status})`);
  return response.json() as Promise<AssortmentResponse>;
}

function TierBadge({ tier }: { tier: AssortmentTier }) {
  return <span className={`assortment-tier-badge tier-${tier.replace('/', '-')}`}>{displayTier(tier)}</span>;
}

function StyleCard({
  style,
  action,
}: {
  style: AssortmentStyle;
  action?: ReactNode;
}) {
  return (
    <article className="assortment-style-card">
      <div className="assortment-style-image">
        {style.image ? <img src={style.image} alt="" loading="lazy" /> : <ImageIcon size={22} />}
      </div>
      <div className="assortment-style-copy">
        <div className="assortment-style-topline">
          <TierBadge tier={style.tier} />
          <span className={`assortment-status ${style.status.toLowerCase()}`}>{style.status}</span>
        </div>
        <h3>{style.name || 'Unnamed style'}</h3>
        <span className="assortment-style-number">{style.styleNumber || 'Style number pending'}</span>
        <span className="assortment-style-category">{style.category}</span>
        {action ? <div className="assortment-card-action">{action}</div> : null}
      </div>
    </article>
  );
}

function SummaryBar({ summary }: { summary: AssortmentSummary }) {
  const tiles = [
    ['Total styles', summary.counts.total, 'total'],
    ['NOOS', summary.counts.noos, 'noos'],
    ['Core', summary.counts.core, 'core'],
    ['Recent', summary.counts.recent, 'recent'],
    ['New', summary.counts.newTest, 'new'],
  ] as const;
  return (
    <div className="assortment-summary-bar">
      <div className="assortment-summary-lead"><Target size={17} /><span>Styles on the floor</span><strong>{numberFormat(summary.counts.total)}</strong></div>
      {tiles.slice(1).map(([label, value, tone]) => <div className={`assortment-summary-item tone-${tone}`} key={label}><span>{label}</span><strong>{numberFormat(value)}</strong></div>)}
    </div>
  );
}

function AssortmentPlanPage() {
  const queryClient = useQueryClient();
  const [quarter, setQuarter] = useState<AssortmentQuarter>('Q3 2026');
  const assortment = useQuery({
    queryKey: ['workspace', 'assortment-plan', quarter],
    queryFn: () => getAssortmentPlan(quarter),
    staleTime: 60_000,
  });
  const moveStyle = useMutation({
    mutationFn: async ({ id, season }: { id: number; season: AssortmentQuarter }) => {
      const response = await fetch(`/api/workspace/range-plan/styles/${id}/season`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season }),
      });
      if (!response.ok) throw new Error(`Could not move style (${response.status})`);
      return response.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspace', 'assortment-plan'] }),
  });
  const toggleExclusion = useMutation({
    mutationFn: async ({ styleId, excluded }: { styleId: string; excluded: boolean }) => {
      const response = await fetch('/api/workspace/range-plan/exclusions', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season: quarter, source: 'all_products_clean', styleId, excluded }),
      });
      if (!response.ok) throw new Error(`Could not update assortment exclusion (${response.status})`);
      return response.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspace', 'assortment-plan'] }),
  });

  if (assortment.isLoading) {
    return <section className="page"><div className="range-plan-loading"><RefreshCw size={20} /><span>Loading assortment plan…</span></div></section>;
  }
  if (assortment.isError || !assortment.data) {
    return <section className="page"><div className="range-plan-error"><Target size={22} /><h2>Assortment Plan is unavailable</h2><p>We could not reach the assortment data. Your saved range is safe.</p><button className="button button-dark" onClick={() => assortment.refetch()}><RefreshCw size={15} /> Try again</button></div></section>;
  }

  const payload = assortment.data;
  const carryOverStyles = payload.carryOverStyles ?? payload.assortmentStyles.filter((style) => style.source === 'all_products_clean');
  const newStyles = payload.newStyles ?? payload.assortmentStyles.filter((style) => style.source === 'pd_styles');
  const summary = payload.assortmentSummary ?? payload.quarterSummaries[quarter];

  return (
    <section className="page assortment-plan-page">
      <header className="assortment-plan-hero">
        <div>
          <span className="range-eyebrow">Merchandising / Store edit</span>
          <h1>Assortment Plan</h1>
          <p>The full range on the floor — every style available in stores by quarter</p>
        </div>
        <div className="assortment-plan-hero-mark">V</div>
      </header>

      <div className="assortment-quarter-tabs" role="tablist" aria-label="Assortment quarters">
        {quarters.map((candidate) => {
          const candidateSummary = payload.quarterSummaries?.[candidate];
          return (
            <button key={candidate} type="button" role="tab" aria-selected={quarter === candidate} className={quarter === candidate ? 'active' : ''} onClick={() => setQuarter(candidate)}>
              <span>{candidate}</span>
              <strong>{numberFormat(candidateSummary?.total ?? 0)}</strong>
              <small>styles in range</small>
            </button>
          );
        })}
      </div>

      <SummaryBar summary={summary} />

      <section className="assortment-style-section" aria-labelledby="carry-over-heading">
        <div className="assortment-section-heading">
          <div><span className="range-eyebrow">Always-on foundation</span><h2 id="carry-over-heading">Carry-over Range</h2><p>Active and retired NOOS, Core, and Recent styles continuing on the floor.</p></div>
          <span className="assortment-section-count">{numberFormat(carryOverStyles.length)} styles</span>
        </div>
        {carryOverStyles.length ? (
          <div className="assortment-card-grid">
            {carryOverStyles.map((style) => (
              <StyleCard
                key={style.id}
                style={style}
                action={style.tier === 'NOOS'
                  ? <span className="assortment-always-on">Always included</span>
                  : <button type="button" className="assortment-card-button" disabled={toggleExclusion.isPending} onClick={() => toggleExclusion.mutate({ styleId: style.styleNumber, excluded: true })}>Exclude from quarter <X size={13} /></button>}
              />
            ))}
          </div>
        ) : <div className="assortment-empty">No carry-over styles are available for this quarter.</div>}
      </section>

      <section className="assortment-style-section" aria-labelledby="new-quarter-heading">
        <div className="assortment-section-heading">
          <div><span className="range-eyebrow">Product development pipeline</span><h2 id="new-quarter-heading">New This Quarter</h2><p>Styles from Product Development whose season includes {quarter}.</p></div>
          <span className="assortment-section-count">{numberFormat(newStyles.length)} styles</span>
        </div>
        {newStyles.length ? (
          <div className="assortment-card-grid">
            {newStyles.map((style) => (
              <StyleCard
                key={style.id}
                style={style}
                action={quarter === 'Q3 2026' && style.pdId !== null
                  ? <button type="button" className="assortment-card-button" disabled={moveStyle.isPending} onClick={() => moveStyle.mutate({ id: style.pdId as number, season: 'Q4 2026' })}>Move to Q4 <MoveRight size={13} /></button>
                  : <span className="assortment-assigned">Assigned to {quarter.replace(' 2026', '')}</span>}
              />
            ))}
          </div>
        ) : <div className="assortment-empty">No new styles are assigned to this quarter yet.</div>}
      </section>
      {moveStyle.isError || toggleExclusion.isError ? <div className="form-error">That assortment change could not be saved. Try again.</div> : null}
    </section>
  );
}

export default AssortmentPlanPage;