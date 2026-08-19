import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { ImageIcon, MoveRight, RefreshCw, Target, X } from 'lucide-react';
import CatalogueSortControl, { type CatalogueSortKey } from '../components/CatalogueSortControl';
import MultiSelectFilter from '../components/MultiSelectFilter';
import {
  countAssortmentStyles,
  filteredAssortmentQuarterCounts,
  matchesAssortmentFilters,
  sortAssortmentStyles,
  type AssortmentFilterState,
} from '../lib/assortmentPlanFilters';

type AssortmentQuarter = 'Q3 2026' | 'Q4 2026';
type AssortmentRangeTier = 'Tier 1' | 'Tier 2' | 'Tier 3' | 'Tier 4';
type AssortmentTier = 'Tier 1 · NOOS' | 'Tier 2 · Core' | 'Tier 3 · Recent' | 'Tier 4 · New' | 'Retired';

type AssortmentStyle = {
  id: string;
  pdId: number | null;
  source: 'all_products_clean' | 'pd_styles';
  styleNumber: string;
  name: string;
  category: string;
  subCategory: string;
  fabricCategory: string;
  brand: string;
  primaryColour: string;
  edit: string;
  stage: string;
  designer: string;
  season: string;
  rangeTier: AssortmentRangeTier | null;
  tier: AssortmentTier | null;
  status: string;
  excluded: boolean;
  unitsSold: number | null;
  revenueKes: number | null;
  sorPct: number | null;
  launchDate: string | null;
  price: number | null;
  stockUnits: number | null;
  image: string | null;
};

type AssortmentSummary = {
  total: number;
  counts: {
    total: number;
    tier1: number;
    tier2: number;
    tier3: number;
    tier4: number;
    retired: number;
    noos?: number;
    core?: number;
    recent?: number;
    newTest?: number;
  };
  filterOptions?: AssortmentFilterOptions;
};

type AssortmentResponse = {
  assortmentQuarter: AssortmentQuarter;
  assortmentStyles: AssortmentStyle[];
  carryOverStyles: AssortmentStyle[];
  newStyles: AssortmentStyle[];
  assortmentSummary: AssortmentSummary;
  quarterSummaries: Record<AssortmentQuarter, AssortmentSummary>;
  quarterStyles?: Record<AssortmentQuarter, AssortmentStyle[]>;
  seasons?: RangePlanSeason[];
  assortmentFilterOptions?: AssortmentFilterOptions;
};

type RangePlanSeason = { id: number; seasonName: string; status: string };
type AssortmentFilterKey = 'tier' | 'status' | 'category' | 'subCategory' | 'fabricCategory' | 'brand' | 'primaryColour' | 'edit';
type AssortmentFilters = AssortmentFilterState;
type AssortmentFilterOptions = Record<AssortmentFilterKey, string[]>;

const quarters: AssortmentQuarter[] = ['Q3 2026', 'Q4 2026'];
const filterDefinitions: Array<{ key: AssortmentFilterKey; label: string }> = [
  { key: 'tier', label: 'Tier' },
  { key: 'status', label: 'Status' },
  { key: 'category', label: 'Category' },
  { key: 'subCategory', label: 'Sub-category' },
  { key: 'fabricCategory', label: 'Fabric Category' },
  { key: 'brand', label: 'Brand' },
  { key: 'primaryColour', label: 'Primary Colour' },
  { key: 'edit', label: 'Edit' },
];
const emptyFilters: AssortmentFilters = {
  tier: [], status: [], category: [], subCategory: [], fabricCategory: [], brand: [], primaryColour: [], edit: [],
};

function numberFormat(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 }).format(Number(value));
}

async function getAssortmentPlan(quarter: AssortmentQuarter) {
  const response = await fetch(`/api/workspace/range-plan?quarter=${encodeURIComponent(quarter)}`, {
    credentials: 'include',
  });
  if (!response.ok) throw new Error(`Assortment Plan request failed (${response.status})`);
  return response.json() as Promise<AssortmentResponse>;
}

function TierBadge({ tier }: { tier: AssortmentTier | null }) {
  const tone = tier?.startsWith('Tier 1') ? 'tier-1'
    : tier?.startsWith('Tier 2') ? 'tier-2'
      : tier?.startsWith('Tier 3') ? 'tier-3'
        : tier?.startsWith('Tier 4') ? 'tier-4'
          : tier === 'Retired' ? 'tier-retired'
            : 'tier-unclassified';
  return <span className={`assortment-tier-badge ${tone}`}>{tier ?? 'Unclassified'}</span>;
}

function AddToRangePlan({
  style,
  seasons,
  pending,
  onAdd,
}: {
  style: AssortmentStyle;
  seasons: RangePlanSeason[];
  pending: boolean;
  onAdd: (seasonId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="assortment-range-action">
      <button
        type="button"
        className="assortment-card-button"
        disabled={pending || seasons.length === 0}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        + Range Plan <MoveRight size={13} />
      </button>
      {open && seasons.length > 0 ? (
        <div className="assortment-season-menu" role="menu">
          <span>Choose season</span>
          {seasons.map((season) => (
            <button
              key={season.id}
              type="button"
              role="menuitem"
              disabled={pending}
              onClick={() => { setOpen(false); onAdd(season.id); }}
            >
              {season.seasonName}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
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
        {action ? <div className="assortment-card-action">{action}</div> : null}
      </div>
    </article>
  );
}

function SummaryBar({ summary }: { summary: AssortmentSummary }) {
  const tiles = [
    ['Total styles', summary.counts.total, 'total'],
    ['Tier 1 · NOOS', summary.counts.tier1, 'noos'],
    ['Tier 2 · Core', summary.counts.tier2, 'core'],
    ['Tier 3 · Recent', summary.counts.tier3, 'recent'],
    ['Tier 4 · New', summary.counts.tier4, 'new'],
    ['Retired', summary.counts.retired, 'retired'],
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
  const [filters, setFilters] = useState<AssortmentFilters>(emptyFilters);
  const [sort, setSort] = useState<CatalogueSortKey>('units_desc');
  const [toast, setToast] = useState('');
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
  const addToRangePlan = useMutation({
    mutationFn: async ({ style, seasonId }: { style: AssortmentStyle; seasonId: number }) => {
      const response = await fetch('/api/workspace/range-plan/add-style', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seasonId,
          source: style.source,
          styleNumber: style.styleNumber,
          pdId: style.pdId,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || `Could not add style to range plan (${response.status})`);
      }
      return response.json();
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['workspace', 'range-plan'] });
      setToast(`${variables.style.name || variables.style.styleNumber} added to the range plan.`);
    },
  });
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (assortment.isLoading) {
    return <section className="page"><div className="range-plan-loading"><RefreshCw size={20} /><span>Loading assortment plan…</span></div></section>;
  }
  if (assortment.isError || !assortment.data) {
    return <section className="page"><div className="range-plan-error"><Target size={22} /><h2>Assortment Plan is unavailable</h2><p>We could not reach the assortment data. Your saved range is safe.</p><button className="button button-dark" onClick={() => assortment.refetch()}><RefreshCw size={15} /> Try again</button></div></section>;
  }

  const payload = assortment.data;
  const options = payload.assortmentFilterOptions ?? payload.assortmentSummary?.filterOptions ?? emptyFilters;
  const quarterStyles = payload.quarterStyles ?? {
    'Q3 2026': quarter === 'Q3 2026' ? payload.assortmentStyles : [],
    'Q4 2026': quarter === 'Q4 2026' ? payload.assortmentStyles : [],
  };
  const filteredStyles = sortAssortmentStyles(
    (quarterStyles[quarter] ?? payload.assortmentStyles)
      .filter((style) => matchesAssortmentFilters(style, filters)),
    sort,
  );
  const filteredCounts = countAssortmentStyles(filteredStyles);
  const summary = { total: filteredStyles.length, counts: filteredCounts };
  const filteredQuarterTotals = filteredAssortmentQuarterCounts(quarterStyles, filters);
  const activeFilterCount = Object.values(filters).reduce((total, values) => total + values.length, 0);
  const seasons = payload.seasons ?? [];
  const setFilter = (key: AssortmentFilterKey, values: string[]) => setFilters((current) => ({ ...current, [key]: values }));
  const renderStyleAction = (style: AssortmentStyle) => (
    <div className="assortment-card-actions">
      {style.source === 'all_products_clean'
        ? <button type="button" className="assortment-card-button" disabled={toggleExclusion.isPending} onClick={() => toggleExclusion.mutate({ styleId: style.styleNumber, excluded: !style.excluded })}>
            {style.excluded ? 'Include in quarter' : 'Exclude from quarter'} <X size={13} />
          </button>
        : quarter === 'Q3 2026' && style.pdId !== null
          ? <button type="button" className="assortment-card-button" disabled={moveStyle.isPending} onClick={() => moveStyle.mutate({ id: style.pdId as number, season: 'Q4 2026' })}>Move to Q4 <MoveRight size={13} /></button>
          : <span className="assortment-assigned">Assigned to {quarter.replace(' 2026', '')}</span>}
      <AddToRangePlan style={style} seasons={seasons} pending={addToRangePlan.isPending} onAdd={(seasonId) => addToRangePlan.mutate({ style, seasonId })} />
    </div>
  );

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
          const filteredTotal = filteredQuarterTotals[candidate];
          return (
            <button key={candidate} type="button" role="tab" aria-selected={quarter === candidate} className={quarter === candidate ? 'active' : ''} onClick={() => setQuarter(candidate)}>
              <span>{candidate}</span>
              <strong>{numberFormat(Number.isFinite(filteredTotal) ? filteredTotal : candidateSummary?.total ?? 0)}</strong>
              <small>styles in range</small>
            </button>
          );
        })}
      </div>

      <div className="assortment-filter-toolbar" aria-label="Assortment filters">
        <div className="assortment-filter-intro"><span>Filter range</span>{activeFilterCount ? <strong>{activeFilterCount} active</strong> : <small>All styles</small>}</div>
        {filterDefinitions.map(({ key, label }) => (
          <MultiSelectFilter
            key={key}
            label={label}
            options={[...new Set((options[key] ?? []).map(String))]}
            values={filters[key]}
            onChange={(values) => setFilter(key, values)}
            testId={`assortment-filter-${key}`}
            variant="catalogue"
            alwaysShowCount
          />
        ))}
        <CatalogueSortControl value={sort} onChange={setSort} testId="select-assortment-sort" />
        <button type="button" className="assortment-clear-filters" onClick={() => setFilters(emptyFilters)} disabled={!activeFilterCount}><X size={13} /> Clear all</button>
      </div>

      <SummaryBar summary={summary} />

      <section className="assortment-style-section" aria-label="Assortment styles">
        {filteredStyles.length ? (
          <div className="assortment-card-grid">
            {filteredStyles.map((style) => <StyleCard key={style.id} style={style} action={renderStyleAction(style)} />)}
          </div>
        ) : <div className="assortment-empty">No styles match the selected filters.</div>}
      </section>
      {toast ? <div className="assortment-toast" role="status">{toast}</div> : null}
      {moveStyle.isError || toggleExclusion.isError || addToRangePlan.isError ? <div className="form-error">{addToRangePlan.error instanceof Error ? addToRangePlan.error.message : 'That assortment change could not be saved. Try again.'}</div> : null}
    </section>
  );
}

export default AssortmentPlanPage;