import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, MoveRight, Search, X } from 'lucide-react';
import { getListCatalogueProductsQueryKey, useListCatalogueProducts } from '@workspace/api-client-react';
import type { CatalogueStyle } from '@workspace/api-client-react';
import MultiSelectFilter from '../components/MultiSelectFilter';
import CatalogueSortControl, { type CatalogueSortKey } from '../components/CatalogueSortControl';

const fmtKES = (value?: number | null) =>
  value == null || Number.isNaN(Number(value)) ? null : `KES ${Math.round(Number(value)).toLocaleString('en-KE')}`;

const fmtMonthYear = (iso?: string | null) => {
  if (!iso) return null;
  const date = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
};

const styleInitials = (style: CatalogueStyle) =>
  (style.styleName || style.styleNumber || '?')
    .replace(/^(Vivo|Safari by Vivo|Safari|Zoya)\s+/i, '')
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

type CatalogueStyleDetailData = {
  styleNumber: string;
  styleName: string;
  brand: string;
  category: string;
  subcategory: string;
  status: string;
  rangeTier: 'NOOS' | 'Core' | 'Recent';
  stockUnits: number;
};

type FullCatalogueFilterKey = 'tier' | 'status' | 'category' | 'subCategory' | 'fabricCategory' | 'brand' | 'primaryColour' | 'edit';
type FullCatalogueFilters = Record<FullCatalogueFilterKey, string[]>;
const fullCatalogueFilters: Array<{ key: FullCatalogueFilterKey; label: string }> = [
  { key: 'tier', label: 'Tier' },
  { key: 'status', label: 'Status' },
  { key: 'category', label: 'Category' },
  { key: 'subCategory', label: 'Sub-category' },
  { key: 'fabricCategory', label: 'Fabric Category' },
  { key: 'brand', label: 'Brand' },
  { key: 'primaryColour', label: 'Primary Colour' },
  { key: 'edit', label: 'Edit' },
];
const emptyFullCatalogueFilters: FullCatalogueFilters = {
  tier: [], status: [], category: [], subCategory: [], fabricCategory: [], brand: [], primaryColour: [], edit: [],
};

function AddToAssortmentPanel({
  source,
  styleNumber,
  pdId,
  styleName,
  onClose,
}: {
  source: 'all_products_clean' | 'pd_styles';
  styleNumber: string;
  pdId?: number | null;
  styleName: string;
  onClose: () => void;
}) {
  const [season, setSeason] = useState<'Q3 2026' | 'Q4 2026'>('Q3 2026');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const add = async () => {
    setSaving(true);
    setNotice('');
    setError('');
    try {
      const response = await fetch('/api/workspace/assortment-plan/add-style', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season, source, styleNumber, pdId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body.error || 'Could not add style to the Assortment Plan'));
      setNotice(body.added ? `Added to ${season}` : `Already in ${season}`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not add style to the Assortment Plan');
    } finally {
      setSaving(false);
    }
  };
  return (
    <aside className="catalogue-assortment-panel" aria-label="Add to Assortment Plan">
      <div className="catalogue-assortment-panel-head">
        <div><span className="range-eyebrow">Planning action</span><h3>Add to Assortment Plan</h3><p>{styleName || styleNumber}</p></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close Assortment Plan panel"><X size={15} /></button>
      </div>
      <label>Planning quarter<select value={season} onChange={(event) => setSeason(event.target.value as typeof season)}><option>Q3 2026</option><option>Q4 2026</option></select></label>
      <button type="button" className="button button-gold" disabled={saving} onClick={add}><MoveRight size={14} />{saving ? 'Adding…' : 'Add style'}</button>
      {notice && <span className="style-save-notice"><Check size={14} /> {notice}</span>}
      {error && <span className="form-error">{error}</span>}
    </aside>
  );
}

function CatalogueTierDetail({ styleNumber, onClose }: { styleNumber: string; onClose: () => void }) {
  const [detail, setDetail] = useState<CatalogueStyleDetailData | null>(null);
  const [tier, setTier] = useState<CatalogueStyleDetailData['rangeTier']>('Recent');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [planOpen, setPlanOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/workspace/catalogue-products/detail?styleNumber=${encodeURIComponent(styleNumber)}`, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load style details');
        return response.json() as Promise<CatalogueStyleDetailData>;
      })
      .then((data) => { if (!cancelled) { setDetail(data); setTier(data.rangeTier); setError(''); } })
      .catch(() => { if (!cancelled) setError('Could not load style details.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [styleNumber]);
  const save = async () => {
    setSaving(true);
    setNotice('');
    setError('');
    try {
      const response = await fetch('/api/workspace/catalogue-products/range-tier', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ styleNumber, rangeTier: tier }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Could not save range tier');
      setNotice('Range tier saved');
      setDetail((current) => current ? { ...current, rangeTier: tier } : current);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save range tier');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="catalogue-detail-shell">
      <div className="catalogue-detail-toolbar"><button className="back-link" type="button" onClick={onClose}><X size={15} /> Close detail</button></div>
      {loading ? <div className="skeleton catalogue-detail-loading" /> : error ? <div className="empty-state error-state"><CircleAlert size={22} /><p>{error}</p></div> : detail ? (
        <div className="catalogue-detail-card">
          <div><span className="mono">{detail.styleNumber}</span><h2>{detail.styleName || 'Unnamed style'}</h2><p>{detail.brand || '—'} · {detail.category || detail.subcategory || 'Uncategorised'} · {detail.status}</p><div className="catalogue-detail-actions"><button type="button" className="button button-outline" onClick={() => setPlanOpen((current) => !current)}><MoveRight size={14} /> Add to Assortment Plan</button><a className="button button-quiet" href={`/merchandising?tab=merch-deepdive&style=${encodeURIComponent(detail.styleNumber)}`} target="_blank" rel="noreferrer">View in BI <ExternalLink size={13} /></a></div></div>
          <div className="catalogue-tier-editor">
            <div><span className="range-eyebrow">Assortment tier</span><strong>{detail.rangeTier}</strong><small>{detail.stockUnits.toLocaleString('en-KE')} units at style level</small></div>
            <label>Carry-over tier<select value={tier} onChange={(event) => setTier(event.target.value as CatalogueStyleDetailData['rangeTier'])}><option value="NOOS">NOOS · always included</option><option value="Core">Core · carry-over performer</option><option value="Recent">Recent · recent performer</option></select></label>
            <button type="button" className="button button-gold" disabled={saving || tier === 'NOOS' && detail.rangeTier === 'NOOS'} onClick={save}>{saving ? 'Saving…' : <><Check size={15} /> Save tier</>}</button>
            {notice && <span className="style-save-notice"><Check size={14} /> {notice}</span>}
            {error && <span className="form-error">{error}</span>}
          </div>
          {planOpen && <AddToAssortmentPanel source="all_products_clean" styleNumber={detail.styleNumber} styleName={detail.styleName} onClose={() => setPlanOpen(false)} />}
        </div>
      ) : null}
    </div>
  );
}

export default function FullCataloguePage() {
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [filters, setFilters] = useState<FullCatalogueFilters>(emptyFullCatalogueFilters);
  const [sort, setSort] = useState<CatalogueSortKey>('units_desc');
  const [page, setPage] = useState(1);
  const [selectedStyleNumber, setSelectedStyleNumber] = useState<string | null>(null);
  const params = useMemo(() => ({
    search: applied || undefined,
    tier: filters.tier.length ? filters.tier.join(',') : undefined,
    status: filters.status.length ? filters.status.map((value) => value.toLowerCase()).join(',') : undefined,
    category: filters.category.length ? filters.category.join(',') : undefined,
    subcategory: filters.subCategory.length ? filters.subCategory.join(',') : undefined,
    fabricCategory: filters.fabricCategory.length ? filters.fabricCategory.join(',') : undefined,
    brand: filters.brand.length ? filters.brand.join(',') : undefined,
    primaryColour: filters.primaryColour.length ? filters.primaryColour.join(',') : undefined,
    edit: filters.edit.length ? filters.edit.join(',') : undefined,
    sort,
    page,
  }), [applied, filters, page, sort]);
  const catalogue = useListCatalogueProducts(params, { query: { queryKey: getListCatalogueProductsQueryKey(params), placeholderData: (previous) => previous }, request: { credentials: 'include' } });
  const data = catalogue.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const resetPage = () => setPage(1);
  const clear = () => { setSearch(''); setApplied(''); setFilters(emptyFullCatalogueFilters); setPage(1); };
  const options = data?.filterOptions || {
    tier: [], status: ['Active', 'Retired'], category: [], subCategory: data?.subcategories || [],
    fabricCategory: [], brand: data?.brands || [], primaryColour: [], edit: [],
  };
  return (
    <>
      <div className="catalogue-tools full-cat-tools">
        <label className="search-field"><Search size={17} /><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setApplied(event.target.value); resetPage(); }} placeholder="Search by style name or number…" data-testid="input-full-cat-search" /></label>
        {fullCatalogueFilters.map(({ key, label }) => (
          <MultiSelectFilter
            key={key}
            label={label}
            options={options[key] || []}
            values={filters[key]}
            onChange={(next) => { setFilters((current) => ({ ...current, [key]: next })); resetPage(); }}
            testId={`select-full-cat-${key}`}
            alwaysShowCount
          />
        ))}
        <CatalogueSortControl value={sort} onChange={(next) => { setSort(next); resetPage(); }} testId="select-full-cat-sort" />
        <button className="button button-quiet" onClick={clear} data-testid="button-full-cat-clear">Clear filters</button>
      </div>
      {catalogue.isLoading ? (
        <div className="full-cat-grid">{Array.from({ length: 10 }).map((_, i) => <div className="skeleton full-cat-skeleton" key={i} />)}</div>
      ) : catalogue.isError ? (
        <div className="empty-state error-state"><CircleAlert size={22} /><h3>Could not load the catalogue</h3><p>The workspace service is unreachable.</p><button className="button button-dark" onClick={() => catalogue.refetch()} data-testid="button-full-cat-retry">Try again</button></div>
      ) : (
        <>
           <div className="catalogue-head"><span data-testid="text-full-cat-total">{data?.total ?? 0} styles</span><span>BI mirror · click a style to edit its assortment tier</span></div>
          {data?.items.length ? (
            <div className={`full-cat-grid ${catalogue.isFetching ? 'is-refreshing' : ''}`}>
              {data.items.map((style) => (
                 <button className="full-cat-card" type="button" onClick={() => setSelectedStyleNumber(style.styleNumber)} key={style.styleNumber} data-testid={`card-full-cat-${style.styleNumber}`}>
                  <div className="full-cat-thumb">
                    <span className={`full-cat-status-badge ${style.status === 'Active' ? 'is-active' : 'is-retired'}`}>{style.status}</span>
                    {style.image ? <img src={style.image} alt={style.styleName || style.styleNumber} loading="lazy" /> : <span className="full-cat-initials">{styleInitials(style)}</span>}
                  </div>
                  <div className="full-cat-body">
                    <strong className="full-cat-name" title={style.styleName || undefined}>{style.styleName || 'Unnamed style'}</strong>
                     <span className="full-cat-number">{style.styleNumber || style.internalReference || style.sku || 'Style number pending'}</span>
                    <span className="full-cat-colour" title={style.colourway || undefined}>{style.colourway || '\u00A0'}</span>
                    <div className="full-cat-meta-row">
                      <span className="full-cat-price">{fmtKES(style.price) || '—'}</span>
                      {style.launchDate ? <span className="full-cat-launch">{fmtMonthYear(style.launchDate)}</span> : null}
                    </div>
                     <span className="full-cat-sub">{[style.category, style.subcategory, style.fabricCategory].filter(Boolean).join(' · ') || '—'}</span>
                    <span className="full-cat-brand">{style.brand || '—'}</span>
                  </div>
                 </button>
              ))}
            </div>
          ) : (
            <div className="empty-state"><h3>No styles match</h3><p>Try a different search or clear your filters.</p><button className="button button-quiet" onClick={clear} data-testid="button-full-cat-empty-clear">Clear filters</button></div>
          )}
           {selectedStyleNumber && <CatalogueTierDetail styleNumber={selectedStyleNumber} onClose={() => setSelectedStyleNumber(null)} />}
          {totalPages > 1 && (
            <div className="full-cat-pager">
              <button className="button button-quiet" onClick={() => setPage(page - 1)} disabled={page <= 1} data-testid="button-full-cat-prev"><ChevronLeft size={15} /> Previous</button>
              <span data-testid="text-full-cat-page">Page {data?.page ?? page} of {totalPages}</span>
              <button className="button button-quiet" onClick={() => setPage(page + 1)} disabled={page >= totalPages} data-testid="button-full-cat-next">Next <ChevronRight size={15} /></button>
            </div>
          )}
        </>
      )}
    </>
  );
}
