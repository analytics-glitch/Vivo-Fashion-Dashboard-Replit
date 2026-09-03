import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Image as ImageIcon, Plus, Search, Trash2, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

type SourceStyle = {
  sourceId: string; source: 'development' | 'catalogue'; styleNumber: string; styleName: string;
  styleType: string | null; tier: string | null; category: string | null; subCategory: string | null;
  brand: string | null; fabric: string | null; fabricProductId: number | null; targetOrderWeek: string | null;
  imageUrl: string | null; colourways: string[]; availableMetres: number;
};
type PlanLine = SourceStyle & {
  id: number; orderNumber: string; availableColourways: string[]; selectedColourways: string[];
  estimatedQuantity: number; orderType: string; orderStage: string;
  firstOrderDate: string | null; actualQuantity: number;
  actualOrders: { orderRef: string; orderDate: string; quantity: number }[];
};
type ActualOrder = {
  orderRef: string; orderDate: string; styleNumber: string; styleName: string; quantity: number;
  subCategory: string; category: string | null; brand: string | null; fabric: string | null;
  orderType: string | null; orderState: string | null; plannedLineId: number | null; unplanned: boolean;
};
type PlanPayload = {
  plan: { id: number; isoYear: number; isoWeek: number; status: 'draft' | 'confirmed'; confirmedAt: string | null } | null;
  week: { isoYear: number; isoWeek: number; startDate: string; endDate: string };
  lines: PlanLine[];
  actualOrders: ActualOrder[];
  summary: {
    units: number; styles: number; newUnits: number; newnessPct: number; newnessFloorPct: number;
    notRaisedStyles: number; notRaisedUnits: number; orderedStyles: number; orderedUnits: number;
    unplannedStyles: number; unplannedUnits: number;
  };
  fabricSummary: { fabric: string; units: number; styles: number; availableMetres: number }[];
  subcategories: {
    month: string; subCategory: string; plannedUnits: number; orderedUnits: number;
    orderedThisWeekUnits: number; plannedThisWeekUnits: number; remainingUnits: number; ceilingBreached: boolean;
  }[];
};
const stages = ['CAD Marker Making', 'Buying Requisition', 'Buying Production Order', 'Production Sample'];
const orderTypes = ['New', 'Re-order', 'Replenishment', 'Range Refreshed'];

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

const dateOnly = (value: string) => value.slice(0, 10);
const formatDate = (value: string, includeYear = false) => new Date(`${dateOnly(value)}T00:00:00`).toLocaleDateString('en-GB', {
  day: 'numeric', month: 'long', ...(includeYear ? { year: 'numeric' } : {}),
});
const formatWeekRange = (week: PlanPayload['week'] | undefined) => {
  if (!week) return '';
  const start = new Date(`${week.startDate}T00:00:00`);
  const end = new Date(`${week.endDate}T00:00:00`);
  const sameYear = start.getFullYear() === end.getFullYear();
  return `${formatDate(week.startDate, !sameYear)} to ${formatDate(week.endDate, true)}`;
};

function StyleImage({ style }: { style: Pick<SourceStyle, 'imageUrl' | 'styleName'> }) {
  return <div className="weekly-style-image">{style.imageUrl ? <img src={style.imageUrl} alt="" /> : <ImageIcon size={20} />}</div>;
}

function SourcePicker({ week, onClose }: { week: number; onClose: () => void }) {
  const client = useQueryClient();
  const [source, setSource] = useState<'development' | 'catalogue'>('development');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<SourceStyle | null>(null);
  const [quantity, setQuantity] = useState('300');
  const [orderType, setOrderType] = useState('New');
  const [orderStage, setOrderStage] = useState(stages[0]);
  const [colours, setColours] = useState<string[]>([]);
  const sources = useQuery<{ items: SourceStyle[] }>({
    queryKey: ['weekly-order-sources', source, search],
    queryFn: () => jsonFetch(`/api/workspace/weekly-order-plan/sources?source=${source}&search=${encodeURIComponent(search)}`),
  });
  useEffect(() => { setSelected(null); setColours([]); setOrderType(source === 'development' ? 'New' : 'Re-order'); }, [source]);
  const add = useMutation({
    mutationFn: () => jsonFetch('/api/workspace/weekly-order-plan/lines', {
      method: 'POST', body: JSON.stringify({
        isoYear: 2026, isoWeek: week, source: selected?.source, sourceId: selected?.sourceId,
        estimatedQuantity: Number(quantity), orderType, orderStage, selectedColourways: colours,
      }),
    }),
    onSuccess: () => { client.invalidateQueries({ queryKey: ['weekly-order-plan', week] }); onClose(); },
  });
  return <div className="weekly-modal-backdrop" onMouseDown={onClose}>
    <section className="weekly-picker" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="range-eyebrow">Add from a trusted source</span><h2>Select a style</h2><p>Style details are copied from the source record and cannot be edited here.</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header>
      <div className="weekly-source-tabs"><button className={source === 'development' ? 'active' : ''} onClick={() => setSource('development')}>Style Development</button><button className={source === 'catalogue' ? 'active' : ''} onClick={() => setSource('catalogue')}>Style Catalogue</button></div>
      <label className="weekly-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search style number, name or fabric…" autoFocus /></label>
      <div className="weekly-picker-body">
        <div className="weekly-results">
          {sources.isLoading ? <p>Searching source records…</p> : sources.data?.items.length ? sources.data.items.map((style) =>
            <button key={`${style.source}-${style.sourceId}`} className={selected?.sourceId === style.sourceId ? 'selected' : ''} onClick={() => {
              setSelected(style); setColours([]); setOrderType(style.source === 'development' ? (style.styleType === 'RR' ? 'Range Refreshed' : 'New') : 'Re-order');
            }}>
              <StyleImage style={style} /><span><strong>{style.styleName}</strong><b>{style.styleNumber}</b><small>{[style.brand, style.category, style.subCategory, style.tier].filter(Boolean).join(' · ')}</small><em>{style.fabric || 'Fabric pending'} · {Math.round(style.availableMetres || 0).toLocaleString()}m available</em></span>
            </button>
          ) : <div className="weekly-no-source"><strong>No matching source record</strong><p>Free-text entry is deliberately unavailable.</p><a href="/product-workspace/style-development">Create it in Style Development first →</a></div>}
        </div>
        <aside className="weekly-add-form">
          {selected ? <>
            <div className="weekly-selected"><StyleImage style={selected} /><div><strong>{selected.styleName}</strong><span>{selected.styleNumber}</span></div></div>
            <label>Estimated quantity<input type="number" min="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
            <label>Order type<select value={orderType} onChange={(event) => setOrderType(event.target.value)}>{orderTypes.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Order stage<select value={orderStage} onChange={(event) => setOrderStage(event.target.value)}>{stages.map((value) => <option key={value}>{value}</option>)}</select></label>
            {selected.colourways.length ? <fieldset><legend>Colourways this week</legend>{selected.colourways.map((colour) => <label key={colour} className="weekly-check"><input type="checkbox" checked={colours.includes(colour)} onChange={() => setColours((current) => current.includes(colour) ? current.filter((item) => item !== colour) : [...current, colour])} />{colour}</label>)}</fieldset> : <p className="weekly-source-note">No saved catalogue colourways. Correct the source record if colourways are missing.</p>}
            <button className="button button-gold" disabled={add.isPending || !Number(quantity)} onClick={() => add.mutate()}><Plus size={15} />{add.isPending ? 'Adding…' : 'Add to week'}</button>
            {add.error && <span className="form-error">{add.error.message}</span>}
          </> : <div className="weekly-empty-selection"><Search size={24} /><p>Pick a source record to enter this week’s decisions.</p></div>}
        </aside>
      </div>
    </section>
  </div>;
}

function EditableLine({ line, locked, week, startDate, endDate }: { line: PlanLine; locked: boolean; week: number; startDate: string; endDate: string }) {
  const client = useQueryClient();
  const [quantity, setQuantity] = useState(String(line.estimatedQuantity));
  const [orderType, setOrderType] = useState(line.orderType);
  const [orderStage, setOrderStage] = useState(line.orderStage);
  const save = useMutation({
    mutationFn: () => jsonFetch(`/api/workspace/weekly-order-plan/lines/${line.id}`, { method: 'PATCH', body: JSON.stringify({ estimatedQuantity: Number(quantity), orderType, orderStage, selectedColourways: line.selectedColourways }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['weekly-order-plan', week] }),
  });
  const remove = useMutation({
    mutationFn: () => jsonFetch(`/api/workspace/weekly-order-plan/lines/${line.id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['weekly-order-plan', week] }),
  });
  const raisedThisWeek = line.actualOrders.some((order) => dateOnly(order.orderDate) >= startDate && dateOnly(order.orderDate) <= endDate);
  const raisedAfterWeek = line.actualOrders.some((order) => dateOnly(order.orderDate) > endDate);
  const status = raisedThisWeek ? 'Raised this week' : raisedAfterWeek ? 'Raised later' : line.firstOrderDate ? 'Raised before' : 'Not raised';
  return <tr className={!line.firstOrderDate ? 'weekly-target-pending' : ''}>
    <td><span className="weekly-order-no">{line.orderNumber}</span></td>
    <td><div className="weekly-line-style"><StyleImage style={line} /><div><strong>{line.styleName}</strong><span>{line.styleNumber} · {line.brand || '—'}</span><small>{line.source === 'development' ? 'Style Development' : 'Style Catalogue'}</small></div></div></td>
    <td><strong>{line.subCategory || 'Uncategorised'}</strong><span>{line.category || '—'} · {line.tier || '—'}</span></td>
    <td><strong>{line.fabric || 'Pending'}</strong><span>{Math.round(line.availableMetres || 0).toLocaleString()}m available</span></td>
    <td><input className="weekly-qty" type="number" min="1" disabled={locked} value={quantity} onChange={(event) => setQuantity(event.target.value)} onBlur={() => Number(quantity) !== line.estimatedQuantity && save.mutate()} /></td>
    <td>{line.selectedColourways.length ? line.selectedColourways.join(', ') : <span>Not selected</span>}</td>
    <td><span className={`weekly-raised-status ${status === 'Not raised' ? 'pending' : status === 'Raised this week' ? 'raised' : 'shifted'}`}>{status}</span>{line.actualOrders.length > 0 && <small className="weekly-order-detail">{line.actualOrders.map((order) => `${order.orderRef} · ${formatDate(order.orderDate)} · ${Number(order.quantity).toLocaleString()}`).join(' | ')}</small>}</td>
    <td><select disabled={locked} value={orderType} onChange={(event) => setOrderType(event.target.value)} onBlur={() => orderType !== line.orderType && save.mutate()}>{orderTypes.map((value) => <option key={value}>{value}</option>)}</select></td>
    <td><select disabled={locked} value={orderStage} onChange={(event) => setOrderStage(event.target.value)} onBlur={() => orderStage !== line.orderStage && save.mutate()}>{stages.map((value) => <option key={value}>{value}</option>)}</select></td>
    <td>{!locked && <button className="icon-button" onClick={() => remove.mutate()}><Trash2 size={15} /></button>}</td>
  </tr>;
}

export default function WeeklyOrderPlanPage() {
  const client = useQueryClient();
  const [week, setWeek] = useState(36);
  const [pickerOpen, setPickerOpen] = useState(false);
  const plan = useQuery<PlanPayload>({
    queryKey: ['weekly-order-plan', week],
    queryFn: () => jsonFetch(`/api/workspace/weekly-order-plan?year=2026&week=${week}`),
    refetchInterval: 60_000,
  });
  const confirm = useMutation({
    mutationFn: () => jsonFetch('/api/workspace/weekly-order-plan/confirm', { method: 'POST', body: JSON.stringify({ isoYear: 2026, isoWeek: week }) }),
    onSuccess: () => { client.invalidateQueries({ queryKey: ['weekly-order-plan', week] }); client.invalidateQueries({ queryKey: ['workspace', 'range-plan'] }); },
  });
  const data = plan.data;
  const locked = data?.plan?.status === 'confirmed';
  const underNewness = Boolean(data?.summary?.units && (data.summary.newnessPct < data.summary.newnessFloorPct));
  return <section className="page weekly-order-page">
    <header className="weekly-header"><div><span className="range-eyebrow">Buying / 2026 order calendar</span><h1>Weekly Order Plan</h1><p>The weekly target guides daily buying orders. Dated orders are the actual record and roll up independently into their calendar month.</p>{data?.week && <div className="weekly-date-range"><CalendarDays size={16} /><strong>Week {week}, {formatWeekRange(data.week)}</strong></div>}</div><div className="weekly-week-control"><button className="icon-button" onClick={() => setWeek((value) => Math.max(1, value - 1))}><ChevronLeft /></button><div><span>Order week</span><strong>Week {week}</strong></div><button className="icon-button" onClick={() => setWeek((value) => Math.min(53, value + 1))}><ChevronRight /></button></div></header>
    {plan.isLoading ? <div className="tracker-empty-state">Loading weekly plan…</div> : plan.isError ? <div className="empty-state error-state"><AlertTriangle /><h3>Could not load the weekly plan</h3><p>{plan.error.message}</p></div> : <>
      <div className="weekly-summary-grid weekly-summary-grid-five">
        <article><span>Weekly target</span><strong>{data?.summary.styles || 0} styles</strong><small>{(data?.summary.units || 0).toLocaleString()} estimated units</small></article>
        <article className="good"><span>Orders raised</span><strong>{data?.summary.orderedStyles || 0} styles</strong><small>{(data?.summary.orderedUnits || 0).toLocaleString()} dated units this week</small></article>
        <article className={data?.summary.notRaisedStyles ? 'warning' : 'good'}><span>Still to raise</span><strong>{data?.summary.notRaisedStyles || 0} styles</strong><small>{(data?.summary.notRaisedUnits || 0).toLocaleString()} planned units without an order</small></article>
        <article className={data?.summary.unplannedStyles ? 'warning' : ''}><span>Unplanned orders</span><strong>{data?.summary.unplannedStyles || 0} styles</strong><small>{(data?.summary.unplannedUnits || 0).toLocaleString()} real units raised outside the target</small></article>
        <article className={underNewness ? 'warning' : 'good'}><span>Newness split</span><strong>{(data?.summary?.newnessPct || 0).toFixed(1)}%</strong><small>{underNewness ? 'Below the 40% monthly floor' : 'At or above the 40% floor'}</small></article>
      </div>
      {underNewness && <div className="weekly-alert warning"><AlertTriangle size={18} /><div><strong>Newness is below 40%</strong><span>Add new styles or rebalance quantities before confirming this week.</span></div></div>}
      <div className="weekly-actions"><div>{locked ? <span className="weekly-confirmed"><CheckCircle2 size={17} /> Weekly target confirmed and locked</span> : <span>Confirming locks the target. It never creates or dates an actual order.</span>}</div>{!locked && <><button className="button button-outline" onClick={() => setPickerOpen(true)}><Plus size={15} /> Add style</button><button className="button button-dark" disabled={!data?.lines.length || confirm.isPending} onClick={() => { if (window.confirm(`Confirm Week ${week}? Its target styles and estimates will be locked. Actual orders will still appear from their real dates.`)) confirm.mutate(); }}>{confirm.isPending ? 'Confirming…' : 'Confirm target'}</button></>}</div>
      <div className="weekly-section-heading"><div><span className="range-eyebrow">Target</span><h2>Styles intended for Week {week}</h2></div><p>Order status follows the first real dated order, even when it is raised in a later week.</p></div>
      <div className="weekly-table-wrap"><table className="weekly-table"><thead><tr><th>Plan #</th><th>Source style</th><th>Range</th><th>Fabric</th><th>Target units</th><th>Colourways</th><th>Raised status</th><th>Order type</th><th>Stage</th><th /></tr></thead><tbody>{data?.lines.map((line) => <EditableLine key={line.id} line={line} locked={locked} week={week} startDate={data.week.startDate} endDate={data.week.endDate} />)}{!data?.lines.length && <tr><td colSpan={10}><div className="weekly-no-lines"><strong>No target styles in Week {week}</strong><p>Real dated orders will still appear below, flagged as unplanned.</p>{!locked && <button className="button button-gold" onClick={() => setPickerOpen(true)}><Plus size={15} /> Add first style</button>}</div></td></tr>}</tbody></table></div>
      <div className="weekly-section-heading weekly-actual-heading"><div><span className="range-eyebrow">Actual record</span><h2>Orders raised from {formatWeekRange(data?.week)}</h2></div><p>Each row is assigned here by its order date, never by the target week.</p></div>
      <div className="weekly-table-wrap"><table className="weekly-table weekly-actual-table"><thead><tr><th>Order date</th><th>Odoo order</th><th>Style</th><th>Sub-category</th><th>Actual units</th><th>Weekly target</th></tr></thead><tbody>{data?.actualOrders.map((order) => <tr className={order.unplanned ? 'weekly-unplanned-order' : ''} key={`${order.orderRef}-${order.styleNumber}`}><td><strong>{formatDate(order.orderDate, true)}</strong></td><td><span className="weekly-order-no">{order.orderRef}</span><small>{order.orderState || '—'}</small></td><td><strong>{order.styleName}</strong><span>{order.styleNumber} · {order.brand || '—'}</span></td><td>{order.subCategory || 'Uncategorised'}</td><td><strong>{Number(order.quantity).toLocaleString()}</strong></td><td>{order.unplanned ? <span className="weekly-raised-status unplanned"><AlertTriangle size={12} /> Unplanned</span> : <span className="weekly-raised-status raised"><CheckCircle2 size={12} /> Planned</span>}</td></tr>)}{!data?.actualOrders.length && <tr><td colSpan={6}><div className="weekly-no-lines"><Clock3 size={20} /><strong>No orders raised in this date range yet</strong><p>The target remains visible above until dated orders arrive from Odoo.</p></div></td></tr>}</tbody></table></div>
      <div className="weekly-analysis-grid">
        <section className="weekly-panel"><header><div><span className="range-eyebrow">Calendar-month control</span><h2>Dated order allocation</h2></div></header><div className="weekly-balance-list">{data?.subcategories.length ? data.subcategories.map((row) => <article className={row.ceilingBreached ? 'breach' : ''} key={`${row.month}-${row.subCategory}`}><div><strong>{row.subCategory} · {new Date(`${row.month.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</strong>{row.ceilingBreached && <span><AlertTriangle size={12} /> Ceiling exceeded</span>}</div><div className="weekly-balance-values weekly-balance-values-five"><span><small>Monthly plan</small>{Number(row.plannedUnits).toLocaleString()}</span><span><small>Ordered in month</small>{Number(row.orderedUnits).toLocaleString()}</span><span><small>Raised this week</small>{Number(row.orderedThisWeekUnits).toLocaleString()}</span><span><small>Weekly target</small>{Number(row.plannedThisWeekUnits).toLocaleString()}</span><span><small>Month remaining</small>{Number(row.remainingUnits).toLocaleString()}</span></div></article>) : <p>No target or dated orders are mapped to a monthly sub-category.</p>}</div></section>
        <section className="weekly-panel"><header><div><span className="range-eyebrow">Target material load</span><h2>Planned fabric demand</h2></div></header><div className="weekly-fabric-list">{data?.fabricSummary.map((row) => <article key={row.fabric}><div><strong>{row.fabric}</strong><span>{row.styles} target style{row.styles === 1 ? '' : 's'}</span></div><div><b>{row.units.toLocaleString()} estimated units</b><small>{Math.round(row.availableMetres).toLocaleString()}m available</small></div></article>)}</div></section>
      </div>
    </>}
    {pickerOpen && <SourcePicker week={week} onClose={() => setPickerOpen(false)} />}
  </section>;
}