import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert, Search } from 'lucide-react';
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

export default function FullCataloguePage() {
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [brand, setBrand] = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
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
          <div className="catalogue-head"><span data-testid="text-full-cat-total">{data?.total ?? 0} styles</span><span>Odoo mirror · read-only</span></div>
          {data?.items.length ? (
            <div className={`full-cat-grid ${catalogue.isFetching ? 'is-refreshing' : ''}`}>
              {data.items.map((style) => (
                <div className="full-cat-card" key={style.styleNumber} data-testid={`card-full-cat-${style.styleNumber}`}>
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
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state"><h3>No styles match</h3><p>Try a different search or clear your filters.</p><button className="button button-quiet" onClick={clear} data-testid="button-full-cat-empty-clear">Clear filters</button></div>
          )}
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
