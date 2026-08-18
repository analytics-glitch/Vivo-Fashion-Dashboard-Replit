import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, CircleAlert, Search, X } from 'lucide-react';
import { getListCatalogueProductsQueryKey, useListCatalogueProducts } from '@workspace/api-client-react';
import type { CatalogueStyle } from '@workspace/api-client-react';

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

function CatalogueTierDetail({ styleNumber, onClose }: { styleNumber: string; onClose: () => void }) {
  const [detail, setDetail] = useState<CatalogueStyleDetailData | null>(null);
  const [tier, setTier] = useState<CatalogueStyleDetailData['rangeTier']>('Recent');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
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
          <div><span className="mono">{detail.styleNumber}</span><h2>{detail.styleName || 'Unnamed style'}</h2><p>{detail.brand || '—'} · {detail.category || detail.subcategory || 'Uncategorised'} · {detail.status}</p></div>
          <div className="catalogue-tier-editor">
            <div><span className="range-eyebrow">Assortment tier</span><strong>{detail.rangeTier}</strong><small>{detail.stockUnits.toLocaleString('en-KE')} units at style level</small></div>
            <label>Carry-over tier<select value={tier} onChange={(event) => setTier(event.target.value as CatalogueStyleDetailData['rangeTier'])}><option value="NOOS">NOOS · always included</option><option value="Core">Core · carry-over performer</option><option value="Recent">Recent · recent performer</option></select></label>
            <button type="button" className="button button-gold" disabled={saving || tier === 'NOOS' && detail.rangeTier === 'NOOS'} onClick={save}>{saving ? 'Saving…' : <><Check size={15} /> Save tier</>}</button>
            {notice && <span className="style-save-notice"><Check size={14} /> {notice}</span>}
            {error && <span className="form-error">{error}</span>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function FullCataloguePage() {
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [brand, setBrand] = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selectedStyleNumber, setSelectedStyleNumber] = useState<string | null>(null);
  const params = useMemo(() => ({
    search: applied || undefined,
    brand: brand || undefined,
    subcategory: subcategory || undefined,
    status: (status || undefined) as 'active' | 'retired' | undefined,
    page,
  }), [applied, brand, subcategory, status, page]);
  const catalogue = useListCatalogueProducts(params, { query: { queryKey: getListCatalogueProductsQueryKey(params), placeholderData: (previous) => previous }, request: { credentials: 'include' } });
  const data = catalogue.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const resetPage = () => setPage(1);
  const clear = () => { setSearch(''); setApplied(''); setBrand(''); setSubcategory(''); setStatus(''); setPage(1); };
  return (
    <>
      <div className="catalogue-tools full-cat-tools">
        <label className="search-field"><Search size={17} /><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setApplied(event.target.value); resetPage(); }} placeholder="Search by style name or number…" data-testid="input-full-cat-search" /></label>
        <select value={brand} onChange={(event) => { setBrand(event.target.value); resetPage(); }} aria-label="Filter by brand" data-testid="select-full-cat-brand"><option value="">All brands</option>{(data?.brands || []).map((item) => <option key={item} value={item}>{item}</option>)}</select>
        <select value={subcategory} onChange={(event) => { setSubcategory(event.target.value); resetPage(); }} aria-label="Filter by subcategory" data-testid="select-full-cat-subcategory"><option value="">All subcategories</option>{(data?.subcategories || []).map((item) => <option key={item} value={item}>{item}</option>)}</select>
        <select value={status} onChange={(event) => { setStatus(event.target.value); resetPage(); }} aria-label="Filter by status" data-testid="select-full-cat-status"><option value="">All statuses</option><option value="active">Active</option><option value="retired">Retired</option></select>
        <button className="button button-quiet" onClick={clear} data-testid="button-full-cat-clear">Clear filters</button>
      </div>
      {catalogue.isLoading ? (
        <div className="full-cat-grid">{Array.from({ length: 10 }).map((_, i) => <div className="skeleton full-cat-skeleton" key={i} />)}</div>
      ) : catalogue.isError ? (
        <div className="empty-state error-state"><CircleAlert size={22} /><h3>Could not load the catalogue</h3><p>The workspace service is unreachable.</p><button className="button button-dark" onClick={() => catalogue.refetch()} data-testid="button-full-cat-retry">Try again</button></div>
      ) : (
        <>
           <div className="catalogue-head"><span data-testid="text-full-cat-total">{data?.total ?? 0} styles</span><span>Odoo mirror · click a style to edit its assortment tier</span></div>
          {data?.items.length ? (
            <div className={`full-cat-grid ${catalogue.isFetching ? 'is-refreshing' : ''}`}>
              {data.items.map((style) => (
                 <button className="full-cat-card" type="button" onClick={() => setSelectedStyleNumber(style.styleNumber)} key={style.styleNumber} data-testid={`card-full-cat-${style.styleNumber}`}>
                  <div className="full-cat-thumb">
                    {style.image ? <img src={style.image} alt={style.styleName || style.styleNumber} loading="lazy" /> : <span className="full-cat-initials">{styleInitials(style)}</span>}
                  </div>
                  <div className="full-cat-body">
                    <span className="mono full-cat-number">{style.styleNumber}</span>
                    <strong className="full-cat-name">{style.styleName || 'Unnamed style'}</strong>
                    <span className="full-cat-sub">{style.subcategory || '—'}</span>
                    <div className="full-cat-foot">
                      <span className="full-cat-brand">{style.brand || '—'}</span>
                      <span className={`full-cat-status ${style.status === 'Active' ? 'is-active' : 'is-retired'}`}>{style.status}</span>
                    </div>
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
