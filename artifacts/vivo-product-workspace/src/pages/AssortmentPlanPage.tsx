import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, ChevronDown, RefreshCw, Search, Target, X } from 'lucide-react';
import CatalogueSortControl, { type CatalogueSortKey } from '../components/CatalogueSortControl';
import MultiSelectFilter from '../components/MultiSelectFilter';
import GarmentImage from '../components/GarmentImage';
import { countAssortmentStyles, matchesAssortmentFilters, matchesStyleCatalogueSearch, sortAssortmentStyles, type AssortmentFilterState } from '../lib/assortmentPlanFilters';

type FilterKey = 'tier' | 'status' | 'category' | 'subCategory' | 'fabricCategory' | 'brand' | 'primaryColour' | 'edit';
type Destination = { type: 'range'; seasonId: number } | { type: 'week'; isoYear: number; isoWeek: number };
type Season = { id: number; seasonName: string; status: string };
type Week = { isoYear: number; isoWeek: number; label: string; status: string; isCurrent?: boolean };
type Style = Record<FilterKey, string | null> & {
  id: string; pdId: number | null; source: 'bi' | 'all_products_clean' | 'pd_styles'; styleNumber: string; name: string;
  designer: string | null;
  rangeTier: string | null; excluded: boolean; unitsSold: number | null; revenueKes: number | null; sorPct: number | null;
  launchDate: string | null; price: number | null; stockUnits: number | null; image: string | null;
  sohStores?: number | null; sohOnline?: number | null; sohWarehouse?: number | null; wipUnits?: number | null;
  fullPricePct?: number | null; weeksOfCover?: number | null; sellThroughPct?: number | null; daysSinceLastSale?: number | null;
  awaitingDelivery?: boolean; fabricMetres?: number | null; otherColourFabricMetres?: number | null; colourwayCount?: number | null; fabric?: string | null;
  firstSaleDate?: string | null; weeksSinceFirstSale?: number | null; weeklyAvg?: number | null;
  sourceStockUnits?: number | null; sellableStockUnits?: number | null; pipelineUnits?: number | null; stockPlusPipelineUnits?: number | null;
  sellableCoverWeeks?: number | null; planningCoverWeeks?: number | null; fabricConsumptionMetresPerUnit?: number | null;
  fabricByColour?: Array<{ colour: string | null; fabricName?: string | null; fabricBarcode?: string | null; exactMetres: number | null; otherColourMetres: number | null }>;
  reorderSignal?: { tone: 'green' | 'amber' | 'grey'; label: string; fabricChecked: boolean; fabricNote: string };
};
type Summary = { total: number; counts: { total: number; tier1: number; tier2: number; tier3: number; tier4: number; retired: number }; filterOptions?: Record<FilterKey, string[]> };
type Reconciliation = { status?: string; passed?: boolean; name?: string; metric?: string; label?: string; error?: string; message?: string; detail?: string };
type Payload = { assortmentStyles: Style[]; assortmentSummary: Summary; seasons?: Season[]; weeklyDestinations?: Week[]; assortmentFilterOptions?: Record<FilterKey, string[]>; sourceStatus?: unknown; reconciliations?: Reconciliation[] };

const filterDefinitions: Array<{ key: FilterKey; label: string }> = [{ key: 'tier', label: 'Tier' }, { key: 'status', label: 'Status' }, { key: 'category', label: 'Category' }, { key: 'subCategory', label: 'Sub-category' }, { key: 'fabricCategory', label: 'Fabric Category' }, { key: 'brand', label: 'Brand' }, { key: 'primaryColour', label: 'Primary Colour' }, { key: 'edit', label: 'Edit' }];
const emptyFilters: AssortmentFilterState = { tier: [], status: ['Active'], category: [], subCategory: [], fabricCategory: [], brand: [], primaryColour: [], edit: [] };
const emptyStyles: Style[] = [];
const n = (value: number | null | undefined, digits = 0) => value == null || !Number.isFinite(Number(value)) ? '—' : new Intl.NumberFormat('en-KE', { maximumFractionDigits: digits }).format(Number(value));
const pct = (value: number | null | undefined) => value == null ? '—' : `${n(value, 1)}%`;
const isBiStyle = (style: Style) => style.source === 'bi' || style.source === 'all_products_clean';
const reconciliationFailed = (item: Reconciliation) => item.passed === false || ['fail', 'failed', 'error', 'blocked', 'untrusted'].includes(String(item.status).toLowerCase());

function DestinationPicker({ seasons, weeks, disabled, onPick }: { seasons: Season[]; weeks: Week[]; disabled: boolean; onPick: (d: Destination) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const currentWeekRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    window.requestAnimationFrame(() => currentWeekRef.current?.scrollIntoView({ block: 'center' }));
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);
  return <div className="assortment-destination-picker" ref={rootRef}>
    <button type="button" className="assortment-card-button" disabled={disabled || (!seasons.length && !weeks.length)} onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open} data-testid="button-choose-plan-destination">Add to plan <ChevronDown size={13} /></button>
    {open && <div className="assortment-season-menu" role="menu">
      <div className="assortment-season-menu-head"><span>Choose a plan</span><button type="button" className="assortment-season-close" onClick={() => setOpen(false)} aria-label="Close plan options"><X size={15} /> Close</button></div>
      <div className="assortment-season-menu-scroll">
        {weeks.length > 0 && <><span>Weekly order plans</span>{weeks.map((week) => <button type="button" ref={week.isCurrent ? currentWeekRef : undefined} className={week.isCurrent ? 'current' : undefined} key={`${week.isoYear}-${week.isoWeek}`} onClick={() => { setOpen(false); onPick({ type: 'week', isoYear: week.isoYear, isoWeek: week.isoWeek }); }} data-testid={`button-destination-week-${week.isoYear}-${week.isoWeek}`}>{week.label}{week.isCurrent && <small>Current</small>}</button>)}</>}
        {seasons.length > 0 && <><span>Monthly plans</span>{seasons.map((season) => <button type="button" key={season.id} onClick={() => { setOpen(false); onPick({ type: 'range', seasonId: season.id }); }} data-testid={`button-destination-season-${season.id}`}>{season.seasonName}</button>)}</>}
      </div>
    </div>}
  </div>;
}

function StyleCard({ style, selected, onSelect, action, expanded, onToggle }: { style: Style; selected: boolean; onSelect: () => void; action: React.ReactNode; expanded: boolean; onToggle: () => void }) {
  const signal = style.reorderSignal ?? { tone: 'grey' as const, label: 'Not a candidate', fabricChecked: false, fabricNote: 'Fabric could not be checked' };
  const fabricRows = (style.fabricByColour ?? []).filter((row) => Number(row.exactMetres ?? 0) > 0 || Number(row.otherColourMetres ?? 0) > 0 || row.fabricBarcode);
  const fabricNames = [...new Set(fabricRows.map((row) => row.fabricName?.trim()).filter(Boolean) as string[])];
  const fabricName = fabricNames.length === 1 ? fabricNames[0] : fabricNames.length > 1 ? `${fabricNames[0]} + ${fabricNames.length - 1} more` : style.fabric && style.fabric !== 'Fabric pending' ? style.fabric : 'Fabric name not assigned';
  const fabricTotalMetres = fabricRows.reduce((highest, row) => Math.max(highest, Number(row.exactMetres ?? 0) + Number(row.otherColourMetres ?? 0)), 0);
  const producibleUnits = fabricTotalMetres > 0 && Number(style.fabricConsumptionMetresPerUnit ?? 0) > 0
    ? Math.round(fabricTotalMetres / Number(style.fabricConsumptionMetresPerUnit))
    : null;
  return <article className={`assortment-style-card consolidated ${selected ? 'selected' : ''}`}>
    <label className="assortment-select-card"><input type="checkbox" checked={selected} onChange={onSelect} disabled={!isBiStyle(style)} aria-label={`Select ${style.name}`} data-testid={`checkbox-select-style-${style.id}`} /></label>
    <GarmentImage className="assortment-style-image" source="catalogue" styleKey={style.styleNumber} image={style.image} alt={style.name} />
    <div className="assortment-style-copy">
      <div className="assortment-style-topline"><span className="assortment-tier-badge">{style.tier ?? 'Unclassified'}</span><span className={`assortment-reorder-signal ${signal.tone}`}><i />{signal.label}{!signal.fabricChecked && <small>Fabric not checked</small>}</span></div>
      <h3>{style.name || 'Unnamed style'}</h3><span className="assortment-style-number">{style.styleNumber}</span>
      <div className="assortment-stock-total"><span>SOH + Pipeline</span><strong>{n(style.stockPlusPipelineUnits)}</strong><small>{n(style.sellableStockUnits)} sellable + {n(style.pipelineUnits)} pipeline</small></div>
      <button type="button" className="assortment-details-toggle" onClick={onToggle} aria-expanded={expanded} data-testid={`button-style-details-${style.id}`}>{expanded ? 'Hide detail' : 'View detail'}</button>
      {expanded && <div className="assortment-card-details">
        <div className="assortment-detail-metrics">
          <span><small>Sell-through</small><strong>{pct(style.sellThroughPct)}</strong></span>
          <span><small>Cover (SOH + Pipeline)</small><strong>{n(style.planningCoverWeeks, 1)}</strong></span>
          <span><small>Full price</small><strong>{pct(style.fullPricePct)}</strong></span>
          <span><small>Days since last sale</small><strong>{n(style.daysSinceLastSale)}</strong></span>
          {String(style.tier ?? '').startsWith('Tier 4') && <span><small>Weeks since first sale</small><strong>{n(style.weeksSinceFirstSale)}</strong></span>}
        </div>
        <div><b>Stock split</b><span>Stores {n(style.sohStores)} · Online {n(style.sohOnline)} · Warehouse {n(style.sohWarehouse)} · Pipeline {n(style.pipelineUnits)} {style.awaitingDelivery ? '· Awaiting delivery' : ''}</span></div>
        <div><b>Product</b><span>KES {n(style.price)} · {n(style.colourwayCount)} colourways · {style.category || 'Uncategorised'} / {style.subCategory || 'Uncategorised'}</span></div>
        <div><b>Fabric availability by colourway</b>{fabricRows.length ? <><div className="assortment-fabric-summary"><strong>{fabricName}</strong><span>{n(fabricTotalMetres)}m total available{producibleUnits != null ? ` · approx ${n(producibleUnits)} units at ${n(style.fabricConsumptionMetresPerUnit, 2)}m` : ''}</span></div><ul className="assortment-fabric-list">{fabricRows.map((row, index) => <li key={`${row.colour}-${index}`}><span>{row.colour || 'Colour pending'}</span><small>{row.fabricBarcode || 'No fabric barcode assigned'}</small><strong>{n(row.exactMetres)}m</strong></li>)}</ul></> : <span>{signal.fabricNote}</span>}</div>
      </div>}
      <div className="assortment-card-action">{action}</div>
    </div>
  </article>;
}

export default function AssortmentPlanPage() {
  const client = useQueryClient();
  const [filters, setFilters] = useState<AssortmentFilterState>(emptyFilters);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<CatalogueSortKey>('units_desc');
  const [selected, setSelected] = useState<string[]>([]);
  const [expandedStyleId, setExpandedStyleId] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const assortment = useQuery({ queryKey: ['workspace', 'assortment-plan'], queryFn: async () => { const r = await fetch('/api/workspace/assortment-plan', { credentials: 'include' }); if (!r.ok) throw new Error(`Assortment Plan request failed (${r.status})`); return r.json() as Promise<Payload>; }, staleTime: 60_000 });
  const exclude = useMutation({ mutationFn: async ({ styleId, excluded }: { styleId: string; excluded: boolean }) => { const r = await fetch('/api/workspace/range-plan/exclusions', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'bi', styleId, excluded }) }); if (!r.ok) throw new Error('Could not update assortment exclusion'); }, onSuccess: () => client.invalidateQueries({ queryKey: ['workspace', 'assortment-plan'] }) });
  const add = useMutation({ mutationFn: async ({ styles, destination }: { styles: Style[]; destination: Destination }) => { const r = await fetch('/api/workspace/assortment-plan/add-selected', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ styles: styles.map((s) => ({ source: 'bi', styleNumber: s.styleNumber })), destination }) }); const body = await r.json().catch(() => ({})); if (!r.ok) throw new Error(body.error || 'Could not add selected styles'); return body; }, onSuccess: (_data, variables) => { setSelected([]); setToast(`${variables.styles.length} style${variables.styles.length === 1 ? '' : 's'} added to plan.`); client.invalidateQueries({ queryKey: ['workspace'] }); } });
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4000); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (sessionStorage.getItem('workspace_focus_assortment_search') !== '1') return;
    sessionStorage.removeItem('workspace_focus_assortment_search');
    window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-assortment-search]')?.focus());
  }, []);
  const assortmentStyles = assortment.data?.assortmentStyles ?? emptyStyles;
  const styles = useMemo(
    () => sortAssortmentStyles(
      assortmentStyles.filter((style) => matchesAssortmentFilters(style, filters) && matchesStyleCatalogueSearch(style, search)),
      sort,
    ),
    [assortmentStyles, filters, search, sort],
  );
  useEffect(() => {
    if (expandedStyleId && !styles.some((style) => style.id === expandedStyleId)) setExpandedStyleId(null);
  }, [expandedStyleId, styles]);
  const selectedStyles = useMemo(
    () => styles.filter((style) => isBiStyle(style) && selected.includes(style.id)),
    [selected, styles],
  );
  const activeCount = useMemo(
    () => Object.values(filters).flat().length + (search.trim() ? 1 : 0),
    [filters, search],
  );
  const assortmentCounts = useMemo(() => countAssortmentStyles(styles), [styles]);
  if (assortment.isLoading) return <section className="page"><div className="range-plan-loading"><RefreshCw size={20} />Loading assortment plan…</div></section>;
  if (assortment.isError || !assortment.data) return <section className="page"><div className="range-plan-error"><Target size={22} /><h2>Assortment Plan is unavailable</h2><button className="button button-dark" onClick={() => assortment.refetch()} data-testid="button-retry-assortment">Try again</button></div></section>;
  const data = assortment.data; const options = data.assortmentFilterOptions ?? data.assortmentSummary.filterOptions ?? ({} as Record<FilterKey, string[]>);
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const cardAction = (style: Style) => <div className="assortment-card-actions">{isBiStyle(style) && <><button type="button" className="assortment-card-button" disabled={exclude.isPending} onClick={() => exclude.mutate({ styleId: style.styleNumber, excluded: !style.excluded })} data-testid={`button-exclude-style-${style.id}`}>{style.excluded ? 'Include in assortment' : 'Exclude from assortment'} <X size={13} /></button><DestinationPicker seasons={data.seasons ?? []} weeks={data.weeklyDestinations ?? []} disabled={add.isPending} onPick={(destination) => add.mutate({ styles: [style], destination })} /></>}</div>;
  return <section className="page assortment-plan-page">
    <header className="assortment-plan-hero"><div><span className="range-eyebrow">Merchandising / Store edit</span><h1>Assortment Plan <span className="assortment-bi-badge hero">BI source</span></h1><p>Make range decisions with trading, stock and product context in one working view.</p></div><div className="assortment-plan-hero-mark">V</div></header>
    {(data.reconciliations ?? []).filter(reconciliationFailed).length > 0 && <div className="assortment-reconciliation-failure" role="alert" data-testid="status-assortment-reconciliation-failure"><Target size={18} /><div><strong>BI reconciliation failed — headline assortment figures are not trusted</strong><span>{(data.reconciliations ?? []).filter(reconciliationFailed).map((item) => item.name ?? item.metric ?? item.label ?? item.error ?? item.message).join(' · ')}</span></div></div>}
    <div className="assortment-current-count" data-testid="text-assortment-filtered-count"><strong>{n(styles.length)}</strong><span>styles matching filters</span></div>
    <div className="assortment-filter-toolbar"><div className="assortment-filter-intro"><span>Filter assortment</span>{activeCount ? <strong>{activeCount} active</strong> : <small>All styles</small>}</div><label className="assortment-search-field"><Search size={16} aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search style, number or designer…" data-assortment-search data-testid="input-assortment-search" /></label>{filterDefinitions.map(({ key, label }) => <MultiSelectFilter key={key} label={label} options={[...new Set((options[key] ?? []).map(String))]} values={filters[key]} onChange={(values) => setFilters((current) => ({ ...current, [key]: values }))} testId={`assortment-filter-${key}`} variant="catalogue" alwaysShowCount />)}<CatalogueSortControl value={sort} onChange={setSort} testId="select-assortment-sort" /><button type="button" className="assortment-clear-filters" onClick={() => { setSearch(''); setFilters(emptyFilters); }} disabled={!activeCount} data-testid="button-clear-assortment-filters"><X size={13} /> Clear all</button></div>
    <div className="assortment-summary-bar"><div className="assortment-summary-lead"><Target size={17} /><span>Styles shown</span><strong>{n(styles.length)}</strong></div>{Object.entries(assortmentCounts).slice(1).map(([key, value]) => <div className="assortment-summary-item" key={key}><span>{key}</span><strong>{n(value)}</strong></div>)}</div>
    <section className="assortment-style-section">{styles.length ? <><div className="assortment-selection-tools"><button type="button" onClick={() => setSelected(styles.filter(isBiStyle).map((s) => s.id))} data-testid="button-select-visible">Select visible</button><button type="button" onClick={() => setSelected([])} disabled={!selected.length} data-testid="button-clear-selection">Clear selection</button></div><div className="assortment-card-grid">{styles.map((style) => <StyleCard key={style.id} style={style} selected={selected.includes(style.id)} onSelect={() => toggle(style.id)} action={cardAction(style)} expanded={expandedStyleId === style.id} onToggle={() => setExpandedStyleId((current) => current === style.id ? null : style.id)} />)}</div></> : <div className="assortment-empty">No styles match the selected filters.</div>}</section>
    {selectedStyles.length > 0 && <aside className="assortment-bulk-bar"><CheckSquare size={18} /><strong>{selectedStyles.length} selected</strong><DestinationPicker seasons={data.seasons ?? []} weeks={data.weeklyDestinations ?? []} disabled={add.isPending} onPick={(destination) => add.mutate({ styles: selectedStyles, destination })} /><button type="button" onClick={() => setSelected([])} data-testid="button-clear-bulk-selection">Clear</button></aside>}
    {toast && <div className="assortment-toast" role="status" data-testid="status-assortment-add">{toast}</div>}{(exclude.isError || add.isError) && <div className="form-error">{add.error instanceof Error ? add.error.message : 'That assortment change could not be saved.'}</div>}
  </section>;
}