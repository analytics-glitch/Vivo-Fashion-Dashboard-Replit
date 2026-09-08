import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, Search } from 'lucide-react';
import './FabricStockMixPage.css';
import './FabricStockMixMenu.css';
import './FabricStockMixSort.css';

type MixNode = {
  group: string; category?: string; fabric_name?: string; id?: number; default_code?: string;
  status?: string; available_kg: number; available_metres: number; consumption_kg: number;
  consumption_metres: number; pct_available: number; pct_consumption: number; gap_pp: number;
  monthly_covers?: number | null; tied_up_kes: number; metres_incomplete?: boolean;
  detail?: Record<string, unknown>; subcategories?: MixNode[]; fabrics?: MixNode[]; products?: MixNode[];
};
type MixPayload = {
  rows: MixNode[]; days: number; date_from?: string; date_to?: string;
  total_available_kg: number; total_available_metres: number; total_consumption_kg: number;
  total_consumption_metres: number; total_tied_up_kes: number;
};
type FlatRow = { node: MixNode; depth: number; key: string; kind: 'category' | 'subcategory' | 'fabric' | 'product' };

const fmt = (n: unknown, digits = 1) => Number.isFinite(Number(n)) ? Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const children = (n: MixNode) => n.subcategories || n.fabrics || n.products || [];
const searchable = (n: MixNode) => [
  n.group, n.fabric_name, n.default_code, n.detail?.name, n.detail?.barcode, n.detail?.default_code,
  n.detail?.supplier, n.detail?.fabric_supplier_name, n.detail?.supplier_fabric_code,
  n.detail?.fabric_color_effective, n.detail?.fabric_subcategory,
].filter(Boolean).join(' ').toLowerCase();

function downloadCsv(rows: MixNode[], kind: string, unit: 'metres' | 'kg') {
  const all: Array<{ category: string; subcategory: string; fabric: string; product: MixNode }> = [];
  rows.forEach(c => (c.subcategories || []).forEach(s => (s.fabrics || []).forEach(f =>
    (f.products || []).forEach(p => all.push({ category: c.group, subcategory: s.group, fabric: f.group, product: p })))));
  let exportRows = all;
  if (kind === 'category') exportRows = rows.map(c => ({ category: c.group, subcategory: '', fabric: '', product: c }));
  if (kind === 'subcategory') exportRows = rows.flatMap(c => (c.subcategories || []).map(s => ({ category: c.group, subcategory: s.group, fabric: '', product: s })));
  if (kind === 'actions') exportRows = all.filter(({ product: p }) => ['Short', 'Overstock', 'Idle'].includes(String(p.status)));
  const headers = ['Category','Sub-category','Level 3 Fabric','Product','Barcode / SKU','Supplier','Supplier code',
    `Available ${unit}`,`Consumption ${unit}`,'% Available','% Consumption','Gap pp','Monthly covers','Stock value KES','Status'];
  const lines = [headers, ...exportRows.map(({ category, subcategory, fabric, product: p }) => {
    const d = p.detail || {}; return [category, subcategory, fabric, p.group, d.barcode || d.default_code || p.default_code,
      d.supplier || d.fabric_supplier_name, d.supplier_fabric_code,
      unit === 'kg' ? p.available_kg : p.available_metres, unit === 'kg' ? p.consumption_kg : p.consumption_metres,
      p.pct_available, p.pct_consumption, p.gap_pp, p.monthly_covers, p.tied_up_kes, p.status];
  })].map(row => row.map(v => JSON.stringify(v ?? '')).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines], { type: 'text/csv' }));
  a.download = `fabric-stock-mix-${kind}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

export default function FabricStockMixPage() {
  const [search, setSearch] = useState('');
  const [supplier, setSupplier] = useState('');
  const [groupBy, setGroupBy] = useState<'category' | 'subcategory'>('category');
  const [unit, setUnit] = useState<'metres' | 'kg'>('metres');
  const [cover, setCover] = useState<'weeks' | 'months'>('weeks');
  const [days, setDays] = useState(30);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: 'group' | 'available' | 'consumption' | 'pctAvailable' | 'pctConsumption' | 'gap' | 'cover' | 'value' | 'status'; dir: 1 | -1 }>({ key: 'available', dir: -1 });
  const query = useQuery<MixPayload>({
    queryKey: ['workspace', 'fabric-stock-mix', groupBy, days, dateFrom, dateTo],
    queryFn: async () => {
      const p = new URLSearchParams({ group_by: groupBy, days: String(days) });
      if (dateFrom && dateTo) { p.set('date_from', dateFrom); p.set('date_to', dateTo); }
      const r = await fetch(`/api/workspace/fabric-stock-mix?${p}`, { credentials: 'include' });
      if (!r.ok) throw new Error('Could not load Fabric Stock Mix');
      return r.json();
    },
    staleTime: 60_000,
  });
  const suppliers = useMemo(() => {
    const s = new Set<string>();
    const walk = (nodes: MixNode[]) => nodes.forEach(n => { const v = String(n.detail?.supplier || n.detail?.fabric_supplier_name || '').trim(); if (v) s.add(v); walk(children(n)); });
    walk(query.data?.rows || []); return [...s].sort();
  }, [query.data]);
  const flat = useMemo(() => {
    const out: FlatRow[] = [], needle = search.trim().toLowerCase();
    const sorted = (nodes: MixNode[]) => [...nodes].sort((a, b) => {
      const values = (n: MixNode) => ({
        group: n.group.toLowerCase(), available: unit === 'kg' ? n.available_kg : n.available_metres,
        consumption: unit === 'kg' ? n.consumption_kg : n.consumption_metres,
        pctAvailable: n.pct_available, pctConsumption: n.pct_consumption, gap: n.gap_pp,
        cover: n.monthly_covers ?? -1, value: n.tied_up_kes, status: String(n.status || '').toLowerCase(),
      });
      const av = values(a)[sort.key], bv = values(b)[sort.key];
      return (typeof av === 'string' ? av.localeCompare(String(bv)) : Number(av) - Number(bv)) * sort.dir;
    });
    const visit = (n: MixNode, depth: number, key: string, kind: FlatRow['kind']): boolean => {
      const kids = sorted(children(n)), own = !needle || searchable(n).includes(needle);
      const supplierHit = !supplier || searchable(n).includes(supplier.toLowerCase());
      const acceptedKids: Array<{ n: MixNode; key: string; kind: FlatRow['kind'] }> = [];
      kids.forEach((k, i) => {
        const nextKind: FlatRow['kind'] = kind === 'category' ? 'subcategory' : kind === 'subcategory' ? 'fabric' : 'product';
        const nextKey = `${key}/${i}:${k.group}`;
        if (visitProbe(k, needle, supplier)) acceptedKids.push({ n: k, key: nextKey, kind: nextKind });
      });
      if (!(own && supplierHit) && !acceptedKids.length) return false;
      out.push({ node: n, depth, key, kind });
      if (needle || supplier || open.has(key)) acceptedKids.forEach(k => visit(k.n, depth + 1, k.key, k.kind));
      return true;
    };
    sorted(query.data?.rows || []).forEach((n, i) => visit(n, 0, `${i}:${n.group}`, groupBy === 'category' ? 'category' : 'subcategory'));
    return out;
  }, [query.data, search, supplier, open, groupBy, sort, unit]);
  const d = query.data;
  const totalAvailable = unit === 'kg' ? d?.total_available_kg : d?.total_available_metres;
  const totalUsed = unit === 'kg' ? d?.total_consumption_kg : d?.total_consumption_metres;
  const toggle = (key: string) => setOpen(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const sortBy = (key: typeof sort.key) => setSort(current => current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: key === 'group' || key === 'status' ? 1 : -1 });
  const heading = (label: string, key: typeof sort.key) => <button className="fsm-sort" onClick={() => sortBy(key)}>{label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button>;
  const setPreset = (n: number) => { const t = new Date(), f = new Date(t); f.setDate(t.getDate() - n + 1); setDays(n); setDateFrom(iso(f)); setDateTo(iso(t)); };
  return <section className="page fsm-page">
    <header className="fsm-heading"><div><p>ASSORTMENT PLAN · LIVE FABRIC BI</p><h1>Fabric Stock Mix</h1><span>Available stock versus consumption, with the same source and calculations as the main BI dashboard.</span></div></header>
    <div className="fsm-kpis">
      <article><span>Available stock</span><strong>{fmt(totalAvailable)} {unit === 'kg' ? 'kg' : 'm'}</strong></article>
      <article><span>Used in period</span><strong>{fmt(totalUsed)} {unit === 'kg' ? 'kg' : 'm'}</strong></article>
      <article><span>Stock value</span><strong>KES {fmt(d?.total_tied_up_kes, 0)}</strong></article>
      <article><span>Consumption window</span><strong>{d?.days || days} days</strong></article>
    </div>
    <div className="fsm-toolbar">
      <label className="fsm-search"><Search size={15}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Find product or barcode…"/></label>
      <select value={supplier} onChange={e=>setSupplier(e.target.value)}><option value="">All suppliers</option>{suppliers.map(s=><option key={s}>{s}</option>)}</select>
      <div className="fsm-seg"><button className={groupBy==='category'?'active':''} onClick={()=>setGroupBy('category')}>By Category</button><button className={groupBy==='subcategory'?'active':''} onClick={()=>setGroupBy('subcategory')}>By Sub-Category</button></div>
      <div className="fsm-seg"><button className={unit==='metres'?'active':''} onClick={()=>setUnit('metres')}>Metres</button><button className={unit==='kg'?'active':''} onClick={()=>setUnit('kg')}>Kg</button></div>
      <div className="fsm-seg"><button className={cover==='weeks'?'active':''} onClick={()=>setCover('weeks')}>Weeks</button><button className={cover==='months'?'active':''} onClick={()=>setCover('months')}>Months</button></div>
      <select value={days} onChange={e=>setPreset(Number(e.target.value))}><option value={30}>30 days</option><option value={90}>90 days</option><option value={180}>180 days</option><option value={365}>365 days</option></select>
      <input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/><span>→</span><input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/>
      <details className="fsm-export-menu"><summary className="fsm-export"><Download size={15}/> Export CSV</summary><div>
        <button onClick={()=>d&&downloadCsv(d.rows,'category',unit)}>Category summary</button>
        <button onClick={()=>d&&downloadCsv(d.rows,'subcategory',unit)}>Sub-category summary</button>
        <button onClick={()=>d&&downloadCsv(d.rows,'products',unit)}>All products — full stock mix</button>
        <button onClick={()=>d&&downloadCsv(d.rows,'actions',unit)}>Action items only</button>
      </div></details>
    </div>
    {query.isLoading ? <div className="fsm-state">Loading live fabric data…</div> : query.isError ? <div className="fsm-state error">{(query.error as Error).message}</div> :
    <div className="fsm-table-wrap"><table className="fsm-table"><thead><tr><th>{heading('Fabric hierarchy','group')}</th><th>{heading('Available','available')}</th><th>{heading('Consumption','consumption')}</th><th>{heading('% Available','pctAvailable')}</th><th>{heading('% Consumption','pctConsumption')}</th><th>{heading('Gap','gap')}</th><th>{heading(cover==='weeks'?'Weeks of Cover':'Monthly covers','cover')}</th><th>{heading('Stock value','value')}</th><th>{heading('Status','status')}</th><th>Barcode / SKU</th><th>Supplier code</th></tr></thead>
      <tbody>{flat.map(({node:n,depth,key,kind})=>{const kids=children(n), expanded=search||supplier||open.has(key), detail=n.detail||{}; const available=unit==='kg'?n.available_kg:n.available_metres, used=unit==='kg'?n.consumption_kg:n.consumption_metres; const covers=n.monthly_covers==null?null:(cover==='weeks'?n.monthly_covers*4.28:n.monthly_covers); return <tr key={key} className={`fsm-${kind}`}>
        <td><div style={{paddingLeft:depth*20}}>{kids.length?<button className="fsm-chevron" onClick={()=>toggle(key)}>{expanded?<ChevronDown size={15}/>:<ChevronRight size={15}/>}</button>:<span className="fsm-leaf"/>}<span>{n.group}</span>{n.metres_incomplete&&unit==='metres'?<small title="Some stock has no kg-per-metre conversion">conversion incomplete</small>:null}</div></td>
        <td>{fmt(available)} {unit==='kg'?'kg':'m'}</td><td>{fmt(used)} {unit==='kg'?'kg':'m'}</td><td>{fmt(n.pct_available)}%</td><td>{fmt(n.pct_consumption)}%</td>
        <td className={n.gap_pp>10?'over':n.gap_pp<-10?'short':''}>{n.gap_pp>0?'+':''}{fmt(n.gap_pp)} pp</td><td>{covers==null?'—':fmt(covers,1)}</td><td>KES {fmt(n.tied_up_kes,0)}</td>
        <td><span className={`fsm-status ${String(n.status||'').toLowerCase()}`}>{n.status||'—'}</span></td><td>{String(detail.barcode||detail.default_code||n.default_code||'—')}</td><td>{String(detail.supplier_fabric_code||'—')}</td>
      </tr>})}{!flat.length?<tr><td colSpan={11} className="fsm-empty">No fabric matches the current search and supplier filters.</td></tr>:null}</tbody>
      <tfoot><tr><td>Total</td><td>{fmt(totalAvailable)} {unit==='kg'?'kg':'m'}</td><td>{fmt(totalUsed)} {unit==='kg'?'kg':'m'}</td><td>100.0%</td><td>100.0%</td><td>—</td><td>—</td><td>KES {fmt(d?.total_tied_up_kes,0)}</td><td colSpan={3}/></tr></tfoot>
    </table></div>}
  </section>;
}

function visitProbe(n: MixNode, needle: string, supplier: string): boolean {
  const text = searchable(n);
  const own = (!needle || text.includes(needle)) && (!supplier || text.includes(supplier.toLowerCase()));
  return own || children(n).some(k => visitProbe(k, needle, supplier));
}