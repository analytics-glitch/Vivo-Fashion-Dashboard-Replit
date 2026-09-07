import { useEffect, useRef, useState } from 'react';
import './WeeklyOrderPlanPage.css';
import { AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3, History, Image as ImageIcon, Plus, Search, Trash2, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adjacentIsoWeek, currentNairobiIsoWeek } from '../lib/weeklyOrderWeek';

type SourceStyle = {
  sourceId: string; source: 'development' | 'catalogue'; styleNumber: string; styleName: string;
  styleType: string | null; tier: string | null; category: string | null; subCategory: string | null;
  brand: string | null; fabric: string | null; fabricProductId: number | null; targetOrderWeek: string | null;
  imageUrl: string | null; colourways: string[]; availableMetres: number;
};
type PlanLine = SourceStyle & {
  id: number; orderNumber: string; availableColourways: string[]; selectedColourways: string[];
  estimatedQuantity: number; orderType: string; orderStage: string;
  dataQualityFlags: string[];
  firstOrderDate: string | null; actualQuantity: number;
  actualOrders: { orderRef: string; orderDate: string; quantity: number }[];
  originalIsoYear: number; originalIsoWeek: number; moveCount: number;
  moveHistory: Array<{
    fromIsoYear: number; fromIsoWeek: number; toIsoYear: number; toIsoWeek: number;
    movedAt: string; movedBy: string;
  }>;
};
type ActualOrder = {
  orderRef: string; orderDate: string; styleNumber: string; styleName: string; quantity: number;
  subCategory: string; category: string | null; brand: string | null; fabric: string | null;
  orderType: string | null; orderState: string | null; plannedLineId: number | null; unplanned: boolean;
};
type PlanPayload = {
  plan: {
    id: number; isoYear: number; isoWeek: number; status: 'draft' | 'confirmed'; confirmedAt: string | null;
    confirmedBy: string | null; lockedTargetUnits: number | null; lockedTargetStyles: number | null;
    lockedPlannedUnits: number | null; lockedPlannedStyles: number | null;
    lastUnlockedAt: string | null; lastUnlockedBy: string | null;
  } | null;
  week: { isoYear: number; isoWeek: number; startDate: string; endDate: string };
  weeklyTarget: {
    targetUnits: number; source: 'derived' | 'entered'; derivedTargetUnits: number; updatedAt: string | null;
  };
  kpis: Array<{
    metricKey: string; actual: number | null; target: number; variance: number | null;
    unit: 'units' | 'percent' | 'count'; available: boolean;
  }>;
  kpiTargets: Array<{ metricKey: string; label: string; targetValue: number; unit: string }>;
  viewer: { canUnlockTarget: boolean };
  lines: PlanLine[];
  actualOrders: ActualOrder[];
  summary: {
    units: number; styles: number; newUnits: number; newnessPct: number;
    newUnitsCommitted: number; actualNewUnits: number; pendingNewUnits: number;
    newnessTargetUnits: number; newnessShortfallUnits: number; newnessShortfallStyles: number;
    newStyleOrderSizeUnits: number;
    newnessTargetComponents: Array<{ monthLabel: string; monthlyTargetUnits: number; sharePct: number; targetUnits: number }>;
    notRaisedStyles: number; notRaisedUnits: number; orderedStyles: number; orderedUnits: number;
    unplannedStyles: number; unplannedUnits: number;
  };
  fabricSummary: { fabric: string; units: number; styles: number; availableMetres: number }[];
  subcategories: {
    month: string; subCategory: string; plannedUnits: number; orderedUnits: number;
    orderedThisWeekUnits: number; plannedThisWeekUnits: number; remainingUnits: number; ceilingBreached: boolean;
  }[];
};
const stages = ['CAD Marker Making', 'Buying Requisition', 'Buying Production Order', 'Production Sample', 'Set Sampling', 'Set Sample Fitting', 'Approved for Production'];
const orderTypes = ['New', 'Range Refreshed', 'Repeat'];

type WorkspaceApiError = Error & { code?: string; canUnlock?: boolean };

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`) as WorkspaceApiError;
    error.code = body.code;
    error.canUnlock = body.canUnlock;
    throw error;
  }
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

function SourcePicker({ year, week, onClose }: { year: number; week: number; onClose: () => void }) {
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
  useEffect(() => { setSelected(null); setColours([]); setOrderType(source === 'development' ? 'New' : 'Repeat'); }, [source]);
  const add = useMutation({
    mutationFn: () => jsonFetch('/api/workspace/weekly-order-plan/lines', {
      method: 'POST', body: JSON.stringify({
        isoYear: year, isoWeek: week, source: selected?.source, sourceId: selected?.sourceId,
        estimatedQuantity: Number(quantity), orderType, orderStage, selectedColourways: colours,
      }),
    }),
    onSuccess: () => { client.invalidateQueries({ queryKey: ['weekly-order-plan', year, week] }); onClose(); },
  });
  const unlock = useMutation({
    mutationFn: () => jsonFetch('/api/workspace/weekly-order-plan/unlock', {
      method: 'POST', body: JSON.stringify({ isoYear: year, isoWeek: week }),
    }),
    onSuccess: () => {
      add.reset();
      client.invalidateQueries({ queryKey: ['weekly-order-plan', year, week] });
    },
  });
  const addError = add.error as WorkspaceApiError | null;
  return <div className="weekly-modal-backdrop" onMouseDown={onClose}>
    <section className="weekly-picker" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="range-eyebrow">Add from a trusted source</span><h2>Select a style</h2><p>Style details are copied from the source record and cannot be edited here.</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header>
      <div className="weekly-source-tabs"><button className={source === 'development' ? 'active' : ''} onClick={() => setSource('development')}>Style Development</button><button className={source === 'catalogue' ? 'active' : ''} onClick={() => setSource('catalogue')}>Style Catalogue</button></div>
      <label className="weekly-search"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search style number, name or fabric…" autoFocus /></label>
      <div className="weekly-picker-body">
        <div className="weekly-results">
          {sources.isLoading ? <p>Searching source records…</p> : sources.data?.items.length ? sources.data.items.map((style) =>
            <button key={`${style.source}-${style.sourceId}`} className={selected?.sourceId === style.sourceId ? 'selected' : ''} onClick={() => {
              setSelected(style); setColours([]); setOrderType(style.source === 'development' ? (style.styleType === 'RR' ? 'Range Refreshed' : 'New') : 'Repeat');
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
            {addError && <div className="weekly-add-error"><span className="form-error">{addError.message}</span>
              {addError.code === 'TARGET_LOCKED' && (addError.canUnlock
                ? <button className="button button-outline" disabled={unlock.isPending} onClick={() => unlock.mutate()}>{unlock.isPending ? 'Unlocking…' : 'Unlock target and continue'}</button>
                : <small>Ask the CEO or a Workspace admin to unlock this target.</small>)}
              {unlock.isError && <span className="form-error">{unlock.error.message}</span>}
            </div>}
          </> : <div className="weekly-empty-selection"><Search size={24} /><p>Pick a source record to enter this week’s decisions.</p></div>}
        </aside>
      </div>
    </section>
  </div>;
}

function EditableLine({ line, locked, year, week, startDate, endDate }: { line: PlanLine; locked: boolean; year: number; week: number; startDate: string; endDate: string }) {
  const client = useQueryClient();
  const [quantity, setQuantity] = useState(String(line.estimatedQuantity));
  const [orderType, setOrderType] = useState(line.orderType);
  const [orderStage, setOrderStage] = useState(line.orderStage);
  const [moveOpen, setMoveOpen] = useState(false);
  const [destinationWeek, setDestinationWeek] = useState(week < 53 ? week + 1 : week - 1);
  const save = useMutation({
    mutationFn: () => jsonFetch(`/api/workspace/weekly-order-plan/lines/${line.id}`, { method: 'PATCH', body: JSON.stringify({ estimatedQuantity: Number(quantity), orderType, orderStage, selectedColourways: line.selectedColourways }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['weekly-order-plan', year, week] }),
  });
  const remove = useMutation({
    mutationFn: () => jsonFetch(`/api/workspace/weekly-order-plan/lines/${line.id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['weekly-order-plan', year, week] }),
  });
  const move = useMutation({
    mutationFn: () => jsonFetch<{ to: { isoYear: number; isoWeek: number } }>(
      `/api/workspace/weekly-order-plan/lines/${line.id}/move`,
      { method: 'POST', body: JSON.stringify({ isoYear: year, isoWeek: destinationWeek }) },
    ),
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ['weekly-order-plan', year, week] });
      client.invalidateQueries({ queryKey: ['weekly-order-plan', result.to.isoYear, result.to.isoWeek] });
      client.invalidateQueries({ queryKey: ['workspace', 'range-plan'] });
      setMoveOpen(false);
    },
  });
  const raisedThisWeek = line.actualOrders.some((order) => dateOnly(order.orderDate) >= startDate && dateOnly(order.orderDate) <= endDate);
  const raisedAfterWeek = line.actualOrders.some((order) => dateOnly(order.orderDate) > endDate);
  const status = raisedThisWeek ? 'Raised this week' : raisedAfterWeek ? 'Raised later' : line.firstOrderDate ? 'Raised before' : 'Not raised';
  return <tr className={!line.firstOrderDate ? 'weekly-target-pending' : ''}>
    <td><span className="weekly-order-no">{line.orderNumber}</span></td>
    <td><div className="weekly-line-style"><StyleImage style={line} /><div><strong>{line.styleName}</strong><span>{line.styleNumber || 'Needs style number'} · {line.brand || '—'}</span><small>{line.source === 'development' ? 'Style Development' : 'Style Catalogue'}</small>{line.dataQualityFlags?.map((flag) => <small className="weekly-data-quality-flag" key={flag}><AlertTriangle size={11} /> {flag}</small>)}</div></div></td>
    <td><strong>{line.subCategory || 'Uncategorised'}</strong><span>{line.category || '—'} · {line.tier || '—'}</span></td>
    <td><strong>{line.fabric || 'Pending'}</strong><span>{Math.round(line.availableMetres || 0).toLocaleString()}m available</span></td>
    <td><input className="weekly-qty" type="number" min="1" disabled={locked} value={quantity} onChange={(event) => setQuantity(event.target.value)} onBlur={() => Number(quantity) !== line.estimatedQuantity && save.mutate()} /></td>
    <td>{line.selectedColourways.length ? line.selectedColourways.join(', ') : <span>Not selected</span>}</td>
    <td><span className={`weekly-raised-status ${status === 'Not raised' ? 'pending' : status === 'Raised this week' ? 'raised' : 'shifted'}`}>{status}</span>{line.actualOrders.length > 0 && <small className="weekly-order-detail">{line.actualOrders.map((order) => `${order.orderRef} · ${formatDate(order.orderDate)} · ${Number(order.quantity).toLocaleString()}`).join(' | ')}</small>}</td>
    <td><select disabled={locked} value={orderType} onChange={(event) => setOrderType(event.target.value)} onBlur={() => orderType !== line.orderType && save.mutate()}>{orderTypes.map((value) => <option key={value}>{value}</option>)}</select></td>
    <td><select disabled={locked} value={orderStage} onChange={(event) => setOrderStage(event.target.value)} onBlur={() => orderStage !== line.orderStage && save.mutate()}>{stages.map((value) => <option key={value}>{value}</option>)}</select></td>
    <td>
      <div className="weekly-line-controls">
        {line.moveCount > 0 && <details className="weekly-move-history">
          <summary><History size={13} /> W{line.originalIsoWeek} · {line.moveCount} move{line.moveCount === 1 ? '' : 's'}</summary>
          <ol>{line.moveHistory.map((item, index) => <li key={`${item.movedAt}-${index}`}>
            <strong>W{item.fromIsoWeek} <ArrowRight size={11} /> W{item.toIsoWeek}</strong>
            <span>{new Date(item.movedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · {item.movedBy}</span>
          </li>)}</ol>
        </details>}
        {!locked && (moveOpen ? <div className="weekly-move-control">
          <label>Move to
            <select value={destinationWeek} onChange={(event) => setDestinationWeek(Number(event.target.value))}>
              {Array.from({ length: 53 }, (_, index) => index + 1).filter((value) => value !== week)
                .map((value) => <option key={value} value={value}>Week {value}</option>)}
            </select>
          </label>
          <button className="button button-gold" disabled={move.isPending} onClick={() => move.mutate()}>{move.isPending ? 'Moving…' : 'Move'}</button>
          <button className="icon-button" onClick={() => setMoveOpen(false)} aria-label="Cancel move"><X size={14} /></button>
          {move.error && <span className="form-error">{move.error.message}</span>}
        </div> : <button className="weekly-move-button" onClick={() => setMoveOpen(true)}><ArrowRight size={13} /> Move week</button>)}
        {!locked && <button className="icon-button" onClick={() => remove.mutate()} aria-label={`Delete ${line.styleName}`}><Trash2 size={15} /></button>}
      </div>
    </td>
  </tr>;
}

export default function WeeklyOrderPlanPage() {
  const client = useQueryClient();
  const [selectedWeek, setSelectedWeek] = useState(currentNairobiIsoWeek);
  const { isoYear: year, isoWeek: week } = selectedWeek;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [targetUnits, setTargetUnits] = useState('');
  const [targetPrompt, setTargetPrompt] = useState('');
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const targetInputRef = useRef<HTMLInputElement>(null);
  const plan = useQuery<PlanPayload>({
    queryKey: ['weekly-order-plan', year, week],
    queryFn: () => jsonFetch(`/api/workspace/weekly-order-plan?year=${year}&week=${week}`),
    refetchInterval: 60_000,
  });
  const confirm = useMutation({
    mutationFn: () => jsonFetch('/api/workspace/weekly-order-plan/confirm', {
      method: 'POST',
      body: JSON.stringify({
        isoYear: year, isoWeek: week,
        targetUnits: data?.weeklyTarget.targetUnits,
        targetStyles: data?.kpis.find((item) => item.metricKey === 'new_styles')?.target,
        plannedUnits: data?.summary.units,
        plannedStyles: data?.summary.styles,
      }),
    }),
    onSuccess: () => {
      setConfirmationOpen(false);
      client.invalidateQueries({ queryKey: ['weekly-order-plan', year, week] });
      client.invalidateQueries({ queryKey: ['workspace', 'range-plan'] });
    },
  });
  const unlock = useMutation({
    mutationFn: () => jsonFetch('/api/workspace/weekly-order-plan/unlock', {
      method: 'POST', body: JSON.stringify({ isoYear: year, isoWeek: week }),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['weekly-order-plan', year, week] }),
  });
  const saveTarget = useMutation({
    mutationFn: () => jsonFetch('/api/workspace/weekly-order-plan/target', {
      method: 'PUT',
      body: JSON.stringify({ isoYear: year, isoWeek: week, targetUnits: Number(targetUnits) }),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['weekly-order-plan', year, week] }),
  });
  const data = plan.data;
  const locked = data?.plan?.status === 'confirmed';
  useEffect(() => {
    if (data?.weeklyTarget) {
      setTargetUnits(String(data.weeklyTarget.targetUnits));
      setTargetPrompt('');
    }
  }, [data?.weeklyTarget, year, week]);
  const underNewness = Boolean(data?.summary && data.summary.newnessShortfallUnits > 0);
  const newnessTargetDetail = data?.summary?.newnessTargetComponents
    ?.map((component) => `${component.sharePct.toFixed(0)}% share of ${component.monthLabel}'s ${component.monthlyTargetUnits.toLocaleString()} units`)
    .join(' + ') || (data?.weeklyTarget.source === 'entered'
      ? `${data.kpis.find((item) => item.metricKey === 'new_pct')?.target.toFixed(0) ?? 35}% of the entered weekly unit target`
      : '');
  const kpiLabel = (metricKey: string) =>
    data?.kpiTargets.find((item) => item.metricKey === metricKey)?.label ?? metricKey;
  const formatKpi = (value: number, unit: string) => unit === 'percent'
    ? `${value.toFixed(1)}%`
    : Math.round(value).toLocaleString();
  const formatVariance = (value: number, unit: string) => {
    const prefix = value > 0 ? '+' : '';
    return unit === 'percent'
      ? `${prefix}${value.toFixed(1)} pp`
      : `${prefix}${Math.round(value).toLocaleString()} ${unit === 'count' ? 'styles' : 'units'}`;
  };
  const targetStyleCount = Math.round(data?.kpis.find((item) => item.metricKey === 'new_styles')?.target ?? 0);
  const requestConfirmation = () => {
    if (data?.weeklyTarget.source !== 'entered' || Number(targetUnits) !== data.weeklyTarget.targetUnits) {
      setTargetPrompt(data?.weeklyTarget.source === 'entered'
        ? 'Save the weekly unit target change before confirming.'
        : 'Enter the weekly unit target, then select Save target before confirming.');
      targetInputRef.current?.focus();
      targetInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setConfirmationOpen(true);
  };
  return <section className="page weekly-order-page">
    <header className="weekly-header"><div><span className="range-eyebrow">Buying / {year} order calendar</span><h1>Weekly Order Plan</h1>{data?.week && <div className="weekly-date-range"><CalendarDays size={16} /><strong>Week {week}, {formatWeekRange(data.week)}</strong></div>}</div><div className="weekly-week-control"><button className="icon-button" onClick={() => setSelectedWeek((value) => adjacentIsoWeek(value, -1))}><ChevronLeft /></button><div><span>Order week</span><strong>Week {week}</strong></div><button className="icon-button" onClick={() => setSelectedWeek((value) => adjacentIsoWeek(value, 1))}><ChevronRight /></button></div></header>
    {plan.isLoading ? <div className="tracker-empty-state">Loading weekly plan…</div> : plan.isError ? <div className="empty-state error-state"><AlertTriangle /><h3>Could not load the weekly plan</h3><p>{plan.error.message}</p></div> : <>
      <div className="weekly-unit-target">
        <div><span className="range-eyebrow">Weekly planning input</span><label htmlFor="weekly-target-units">Target units for the week</label><small>{data?.weeklyTarget.source === 'entered' ? 'Saved specifically for this order week.' : `Seeded from the current monthly commitment share (${data?.weeklyTarget.derivedTargetUnits.toLocaleString()} units). Save to override it for this week.`}</small></div>
        <div className="weekly-unit-target-control"><input ref={targetInputRef} id="weekly-target-units" type="number" min="0" step="1" disabled={locked} value={targetUnits} onChange={(event) => { setTargetUnits(event.target.value); setTargetPrompt(''); }} /><button className="button button-dark" disabled={locked || saveTarget.isPending || !Number.isInteger(Number(targetUnits)) || Number(targetUnits) < 0 || (data?.weeklyTarget.source === 'entered' && Number(targetUnits) === data?.weeklyTarget.targetUnits)} onClick={() => saveTarget.mutate()}>{saveTarget.isPending ? 'Saving…' : 'Save target'}</button></div>
        {saveTarget.isError && <span className="form-error">{saveTarget.error.message}</span>}
        {targetPrompt && <span className="form-error weekly-target-prompt">{targetPrompt}</span>}
      </div>
      <div className="weekly-kpi-grid">
        {data?.kpis.map((item) => <article key={item.metricKey} className={!item.available ? 'unavailable' : (item.variance ?? 0) >= 0 ? 'positive' : 'shortfall'}>
          <span>{kpiLabel(item.metricKey)}</span>
          {item.available && item.actual != null ? <>
            <strong>{formatKpi(item.actual, item.unit)}</strong>
            <small>Target {formatKpi(item.target, item.unit)}</small>
            <em>{formatVariance(item.variance ?? 0, item.unit)} vs target</em>
          </> : <>
            <strong>Attribute not available</strong>
            <small>Target {formatKpi(item.target, item.unit)}</small>
            <em>No actual or variance shown</em>
          </>}
        </article>)}
      </div>
      {underNewness && <div className="weekly-alert warning"><AlertTriangle size={18} /><div><strong>Weekly newness is short by {(data?.summary?.newnessShortfallUnits || 0).toLocaleString()} units</strong><span>Add {(data?.summary?.newnessShortfallStyles || 0).toLocaleString()} new style{data?.summary?.newnessShortfallStyles === 1 ? '' : 's'} at the default {(data?.summary?.newStyleOrderSizeUnits || 300).toLocaleString()}-unit order size to meet this week’s share of the monthly commitment.</span></div></div>}
      <div className={`weekly-actions ${locked ? 'is-locked' : ''}`}><div>{locked ? <div className="weekly-locked-summary"><span className="weekly-confirmed"><CheckCircle2 size={17} /> Weekly target confirmed and locked</span><strong>{Number(data?.plan?.lockedTargetUnits ?? 0).toLocaleString()} target units · {Number(data?.plan?.lockedTargetStyles ?? 0).toLocaleString()} target styles</strong><small>Confirmed by {data?.plan?.confirmedBy || 'Workspace user'} on {data?.plan?.confirmedAt ? new Date(data.plan.confirmedAt).toLocaleString('en-GB') : '—'} · Planned when locked: {Number(data?.plan?.lockedPlannedUnits ?? 0).toLocaleString()} units across {Number(data?.plan?.lockedPlannedStyles ?? 0).toLocaleString()} styles</small></div> : <span>Confirming locks the target. It never creates or dates an actual order.</span>}</div>{locked ? data?.viewer.canUnlockTarget && <button className="button button-outline" disabled={unlock.isPending} onClick={() => { if (window.confirm(`Unlock Week ${week} target for editing? Existing style lines will not be changed.`)) unlock.mutate(); }}>{unlock.isPending ? 'Unlocking…' : 'Unlock target'}</button> : <><button className="button button-outline" onClick={() => setPickerOpen(true)}><Plus size={15} /> Add style</button><button className="button button-dark" disabled={!data?.lines.length || confirm.isPending} onClick={requestConfirmation}>{confirm.isPending ? 'Confirming…' : 'Confirm target'}</button></>}</div>
      {unlock.isError && <span className="form-error">{unlock.error.message}</span>}
      <div className="weekly-section-heading"><div><span className="range-eyebrow">Target</span><h2>Styles intended for Week {week}</h2></div><p>Order status follows the first real dated order, even when it is raised in a later week.</p></div>
       <div className="weekly-table-wrap"><table className="weekly-table"><thead><tr><th>Plan #</th><th>Source style</th><th>Range</th><th>Fabric</th><th>Target units</th><th>Colourways</th><th>Raised status</th><th>Order type</th><th>Stage</th><th>Move / history</th></tr></thead><tbody>{data?.lines.map((line) => <EditableLine key={line.id} line={line} locked={locked} year={year} week={week} startDate={data.week.startDate} endDate={data.week.endDate} />)}{!data?.lines.length && <tr><td colSpan={10}><div className="weekly-no-lines"><strong>No target styles in Week {week}</strong><p>Real dated orders will still appear below, flagged as unplanned.</p>{!locked && <button className="button button-gold" onClick={() => setPickerOpen(true)}><Plus size={15} /> Add first style</button>}</div></td></tr>}</tbody></table></div>
      <div className="weekly-section-heading weekly-actual-heading"><div><span className="range-eyebrow">Actual record</span><h2>Orders raised from {formatWeekRange(data?.week)}</h2></div><p>Each row is assigned here by its order date, never by the target week.</p></div>
      <div className="weekly-table-wrap"><table className="weekly-table weekly-actual-table"><thead><tr><th>Order date</th><th>Odoo order</th><th>Style</th><th>Sub-category</th><th>Actual units</th><th>Weekly target</th></tr></thead><tbody>{data?.actualOrders.map((order) => <tr className={order.unplanned ? 'weekly-unplanned-order' : ''} key={`${order.orderRef}-${order.styleNumber}`}><td><strong>{formatDate(order.orderDate, true)}</strong></td><td><span className="weekly-order-no">{order.orderRef}</span><small>{order.orderState || '—'}</small></td><td><strong>{order.styleName}</strong><span>{order.styleNumber} · {order.brand || '—'}</span></td><td>{order.subCategory || 'Uncategorised'}</td><td><strong>{Number(order.quantity).toLocaleString()}</strong></td><td>{order.unplanned ? <span className="weekly-raised-status unplanned"><AlertTriangle size={12} /> Unplanned</span> : <span className="weekly-raised-status raised"><CheckCircle2 size={12} /> Planned</span>}</td></tr>)}{!data?.actualOrders.length && <tr><td colSpan={6}><div className="weekly-no-lines"><Clock3 size={20} /><strong>No orders raised in this date range yet</strong><p>The target remains visible above until dated orders arrive from Odoo.</p></div></td></tr>}</tbody></table></div>
      <div className="weekly-analysis-grid">
        <section className="weekly-panel"><header><div><span className="range-eyebrow">Calendar-month control</span><h2>Dated order allocation</h2></div></header><div className="weekly-balance-list">{data?.subcategories.length ? data.subcategories.map((row) => <article className={row.ceilingBreached ? 'breach' : ''} key={`${row.month}-${row.subCategory}`}><div><strong>{row.subCategory} · {new Date(`${row.month.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</strong>{row.ceilingBreached && <span><AlertTriangle size={12} /> Ceiling exceeded</span>}</div><div className="weekly-balance-values weekly-balance-values-five"><span><small>Monthly plan</small>{Number(row.plannedUnits).toLocaleString()}</span><span><small>Ordered in month</small>{Number(row.orderedUnits).toLocaleString()}</span><span><small>Raised this week</small>{Number(row.orderedThisWeekUnits).toLocaleString()}</span><span><small>Weekly target</small>{Number(row.plannedThisWeekUnits).toLocaleString()}</span><span><small>Month remaining</small>{Number(row.remainingUnits).toLocaleString()}</span></div></article>) : <p>No target or dated orders are mapped to a monthly sub-category.</p>}</div></section>
        <section className="weekly-panel"><header><div><span className="range-eyebrow">Target material load</span><h2>Planned fabric demand</h2></div></header><div className="weekly-fabric-list">{data?.fabricSummary.map((row) => <article key={row.fabric}><div><strong>{row.fabric}</strong><span>{row.styles} target style{row.styles === 1 ? '' : 's'}</span></div><div><b>{row.units.toLocaleString()} estimated units</b><small>{Math.round(row.availableMetres).toLocaleString()}m available</small></div></article>)}</div></section>
      </div>
    </>}
    {pickerOpen && <SourcePicker year={year} week={week} onClose={() => setPickerOpen(false)} />}
    {confirmationOpen && data && <div className="weekly-modal-backdrop" onMouseDown={() => setConfirmationOpen(false)}>
      <section className="weekly-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="weekly-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span className="range-eyebrow">Final review</span><h2 id="weekly-confirm-title">Confirm Week {week} target?</h2></div><button className="icon-button" onClick={() => setConfirmationOpen(false)}><X size={18} /></button></header>
        <p>These exact figures will be locked. This does not create or date an actual order.</p>
        <dl>
          <div><dt>Weekly target</dt><dd>{data.weeklyTarget.targetUnits.toLocaleString()} units</dd></div>
          <div><dt>Target styles</dt><dd>{targetStyleCount.toLocaleString()} styles</dd></div>
          <div><dt>Currently planned</dt><dd>{data.summary.units.toLocaleString()} units across {data.summary.styles.toLocaleString()} styles</dd></div>
        </dl>
        {confirm.isError && <span className="form-error">{confirm.error.message}</span>}
        <footer><button className="button button-outline" onClick={() => setConfirmationOpen(false)}>Keep editing</button><button className="button button-dark" disabled={confirm.isPending} onClick={() => confirm.mutate()}>{confirm.isPending ? 'Confirming…' : `Confirm and lock ${data.weeklyTarget.targetUnits.toLocaleString()} units`}</button></footer>
      </section>
    </div>}
  </section>;
}