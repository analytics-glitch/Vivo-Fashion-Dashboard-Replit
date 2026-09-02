import { Fragment, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw, Save, Target, TrendingDown, TrendingUp } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Label,
  Pie,
  PieChart,
  RadialBar,
  RadialBarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type RangePlanSeason = {
  id: number;
  seasonName: string;
  seasonYear: number;
  revenueTargetKes: number;
  cogsBudgetPct: number;
  factoryCapacityUnits: number;
  newnessFloorPct: number;
  status: string;
  cadence: 'quarterly' | 'monthly';
};
type RangePlanRow = {
  id: number;
  seasonId: number;
  subCategory: string;
  productCategory: string | null;
  tier: string;
  styleCountTarget: number;
  newStyleCount: number;
  reorderStyleCount: number;
  replenishmentStyleCount: number;
  styleCountMin: number;
  styleCountMax: number;
  aosUnits: number;
  newStyleAosUnits: number;
  totalUnitsImplied: number;
  newUnits: number;
  reorderUnits: number;
  replenishmentUnits: number;
  committedStyles: number;
  committedUnits: number;
  openingStockUnits: number | null;
  unitsSoldLastMonth: number | null;
  expectedUnitCost: number | null;
  sellingPrice: number | null;
  asp: number | null;
  potentialFpRevenue: number;
  notes: string;
};
type RangePlanOtb = {
  id: number | null;
  monthYear: string;
  revenueTarget: number | null;
  plannedUnits: number | null;
  newStylesCount: number | null;
  notes: string;
};
type RangePlanHealth = {
  newRepeat: { newCount: number; repeatCount: number; total: number };
  subCategories: Array<{ name: string; count: number }>;
  activeStyleCount: number;
  tiers: Array<{ tier: string; label: string; minimum: number; maximum: number; count: number }>;
};
type QuarterMonthlyRollup = {
  seasonId: number;
  seasonName: string;
  monthYear: string;
  plannedUnits: number;
  grossRevenuePotential: number;
};
type RangePlanResponse = {
  seasons: RangePlanSeason[];
  season: RangePlanSeason | null;
  rows: RangePlanRow[];
  otb: RangePlanOtb[];
  averageCostKes: number;
  potentialFpRevenue: number;
  health: RangePlanHealth;
  quarterMonthlyRollup: QuarterMonthlyRollup[];
};

const monthlyCategoryOrder = ['Bottoms', 'Dresses', 'Outerwear', 'Skirts', 'Tops'];
const chartColors = ['#C9A96E', '#1A1A2E', '#8974A3', '#B86B58', '#557C7A', '#A8B18F'];

function numberFormat(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 }).format(Number(value));
}
function kes(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : `KES ${numberFormat(value)}`;
}
function kesMillions(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : `KES ${(Number(value) / 1_000_000).toFixed(1)}m`;
}
function monthLabel(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}
function monthShort(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB', { month: 'short' });
}
async function getRangePlan(seasonId?: number) {
  const params = new URLSearchParams();
  if (seasonId) params.set('seasonId', String(seasonId));
  const query = `?${params.toString()}`;
  const response = await fetch(`/api/workspace/range-plan${query}`, { credentials: 'include' });
  if (!response.ok) throw new Error(`Range Plan request failed (${response.status})`);
  return response.json() as Promise<RangePlanResponse>;
}

function InlineCell({
  value,
  displayValue,
  ariaLabel,
  kind = 'text',
  placeholder,
  onSave,
}: {
  value: string | number | null | undefined;
  displayValue?: string;
  ariaLabel: string;
  kind?: 'text' | 'number';
  placeholder?: string;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value === null || value === undefined ? '' : String(value));
  const rendered = displayValue ?? (value === null || value === undefined || value === '' ? '—' : String(value));
  const begin = () => {
    setDraft(value === null || value === undefined ? '' : String(value));
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    if (draft !== (value === null || value === undefined ? '' : String(value))) onSave(draft);
  };
  if (!editing) {
    return <button className={`range-inline-value ${!value && value !== 0 ? 'is-empty' : ''}`} onClick={begin} aria-label={`Edit ${ariaLabel}`} type="button">{rendered}</button>;
  }
  return (
    <input
      autoFocus
      className="range-inline-input"
      type={kind}
      min={kind === 'number' ? 0 : undefined}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') setEditing(false);
      }}
    />
  );
}

function StatTile({ label, value, detail, tone = 'default', icon }: { label: string; value: string; detail?: string; tone?: 'default' | 'success' | 'warning' | 'danger'; icon?: ReactNode }) {
  return (
    <div className={`range-stat-tile tone-${tone}`}>
      <div className="range-stat-top"><span>{label}</span>{icon}</div>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function ChartCard({ eyebrow, title, children, className = '' }: { eyebrow: string; title: string; children: ReactNode; className?: string }) {
  return <article className={`range-health-card ${className}`}><div className="range-card-heading"><span className="range-eyebrow">{eyebrow}</span><h3>{title}</h3></div>{children}</article>;
}

function RangePlanPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'matrix' | 'otb' | 'health'>('matrix');
  const [selectedSeasonId, setSelectedSeasonId] = useState<number | undefined>();
  const [tierFilter, setTierFilter] = useState('All tiers');
  const rangePlan = useQuery({
    queryKey: ['workspace', 'range-plan', selectedSeasonId],
    queryFn: () => getRangePlan(selectedSeasonId),
    staleTime: 60_000,
  });
  const updateSeason = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: { revenueTargetKes?: number; cogsBudgetPct?: number; factoryCapacityUnits?: number; newnessFloorPct?: number } }) => {
      const response = await fetch(`/api/workspace/range-plan/seasons/${id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error(`Could not save season assumptions (${response.status})`);
      return response.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspace', 'range-plan'] }),
  });
  const updateRow = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<RangePlanRow> }) => {
      const response = await fetch(`/api/workspace/range-plan/rows/${id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error(`Could not save range row (${response.status})`);
      return response.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspace', 'range-plan'] }),
  });
  const updateOtb = useMutation({
    mutationFn: async ({ seasonId, data }: { seasonId: number; data: Partial<RangePlanOtb> & { monthYear: string } }) => {
      const response = await fetch(`/api/workspace/range-plan/seasons/${seasonId}/otb`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error(`Could not save OTB month (${response.status})`);
      return response.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspace', 'range-plan'] }),
  });

  const payload = rangePlan.data;
  const season = payload?.season;
  const rows = payload?.rows ?? [];
  const visibleRows = useMemo(() => rows.map((row) => {
    if (tierFilter === 'All tiers') return { ...row, styleCountTarget: row.newStyleCount + row.reorderStyleCount + row.replenishmentStyleCount };
    if (tierFilter === 'New/Test') {
      return { ...row, styleCountTarget: row.newStyleCount, totalUnitsImplied: row.newUnits, potentialFpRevenue: row.newUnits * Number(row.sellingPrice ?? 0) };
    }
    if (row.tier !== tierFilter) return { ...row, styleCountTarget: 0, totalUnitsImplied: 0, potentialFpRevenue: 0 };
    const carryStyleCount = row.reorderStyleCount + row.replenishmentStyleCount;
    const carryUnits = row.reorderUnits + row.replenishmentUnits;
    return { ...row, newStyleCount: 0, styleCountTarget: carryStyleCount, totalUnitsImplied: carryUnits, potentialFpRevenue: carryUnits * Number(row.sellingPrice ?? 0) };
  }).filter((row) => tierFilter === 'All tiers' || row.styleCountTarget > 0 || row.totalUnitsImplied > 0), [rows, tierFilter]);
  const quarterlyPlans = (payload?.seasons ?? []).filter((candidate) => candidate.cadence === 'quarterly');
  const monthlyPlans = (payload?.seasons ?? []).filter((candidate) => candidate.cadence === 'monthly');
  const totals = useMemo(() => {
    const totalStyles = visibleRows.reduce((sum, row) => sum + row.styleCountTarget, 0);
    const totalUnits = visibleRows.reduce((sum, row) => sum + row.totalUnitsImplied, 0);
    const newStyles = visibleRows.reduce((sum, row) => sum + row.newStyleCount, 0);
    const newUnits = visibleRows.reduce((sum, row) => sum + row.newUnits, 0);
    const allNewStyles = rows.reduce((sum, row) => sum + row.newStyleCount, 0);
    const effectiveNewAos = allNewStyles > 0
      ? rows.reduce((sum, row) => sum + row.newStyleCount * row.newStyleAosUnits, 0) / allNewStyles
      : rows.length ? rows.reduce((sum, row) => sum + row.newStyleAosUnits, 0) / rows.length : 300;
    const costedRows = visibleRows.filter((row) => row.expectedUnitCost !== null && row.sellingPrice !== null && row.sellingPrice > 0);
    const estimatedCogs = costedRows.reduce((sum, row) => sum + row.totalUnitsImplied * Number(row.expectedUnitCost), 0);
    const potentialFpRevenue = visibleRows.reduce((sum, row) => sum + row.potentialFpRevenue, 0);
    const costedNetRevenue = costedRows.reduce((sum, row) => sum + row.totalUnitsImplied * (Number(row.sellingPrice) / 1.16), 0);
    const cogsPct = costedNetRevenue > 0 ? (estimatedCogs / costedNetRevenue) * 100 : 0;
    const capacityPct = season?.factoryCapacityUnits ? (totalUnits / season.factoryCapacityUnits) * 100 : 0;
    const newnessPct = totalUnits > 0 ? newUnits / totalUnits * 100 : 0;
    const requiredNewUnits = (season?.factoryCapacityUnits ?? 0) * ((season?.newnessFloorPct ?? 0) / 100);
    const impliedNewStyles = effectiveNewAos > 0 ? Math.round(requiredNewUnits / effectiveNewAos) : 0;
    return { totalStyles, totalUnits, newStyles, newUnits, newnessPct, effectiveNewAos, requiredNewUnits, impliedNewStyles, estimatedCogs, cogsPct, capacityPct, potentialFpRevenue, costedRowCount: costedRows.length };
  }, [visibleRows, rows, season]);

  const saveRow = (row: RangePlanRow, field: 'styleCountTarget' | 'newStyleCount' | 'reorderStyleCount' | 'replenishmentStyleCount' | 'newStyleAosUnits' | 'aosUnits' | 'openingStockUnits' | 'unitsSoldLastMonth' | 'expectedUnitCost' | 'sellingPrice' | 'notes', value: string) => {
    const optional = field === 'openingStockUnits' || field === 'unitsSoldLastMonth' || field === 'expectedUnitCost' || field === 'sellingPrice';
    const parsed = optional && value.trim() === '' ? null : Math.max(0, Number(value || 0));
    updateRow.mutate({ id: row.id, data: { [field]: field === 'notes' ? value : parsed } });
  };
  const saveSeason = (field: 'revenueTargetKes' | 'cogsBudgetPct' | 'factoryCapacityUnits' | 'newnessFloorPct', value: string) => {
    if (!season) return;
    const numeric = Math.max(0, Number(value || 0));
    updateSeason.mutate({ id: season.id, data: { [field]: numeric } });
  };
  const saveOtb = (month: RangePlanOtb, field: 'revenueTarget' | 'plannedUnits' | 'newStylesCount', value: string) => {
    if (!season) return;
    const numeric = value.trim() === '' ? null : Number.parseInt(value, 10);
    updateOtb.mutate({
      seasonId: season.id,
      data: {
        monthYear: month.monthYear.slice(0, 10),
        revenueTarget: field === 'revenueTarget' ? (value.trim() === '' ? null : Number(value)) : month.revenueTarget,
        plannedUnits: field === 'plannedUnits' ? numeric : month.plannedUnits,
        newStylesCount: field === 'newStylesCount' ? numeric : month.newStylesCount,
      },
    });
  };
  const exportCsv = () => {
    if (!season) return;
     const header = ['Product Category', 'Sub-Category', 'Opening Stock Units', 'Units Sold Last Month', 'Weeks of Cover', 'Planned Styles', 'New Styles', 'Reorder Styles', 'Replenishment Styles', 'New Style AOS', 'Reorder / Replenishment AOS', 'New Units', 'Reorder Units', 'Replenishment Units', 'Total Units', 'Share of Units', 'Expected Unit Cost', 'Average Selling Price', 'Gross Revenue Potential', 'Input COGS %'];
     const lines = visibleRows.map((row) => {
        const weeksOfCover = row.openingStockUnits !== null && row.unitsSoldLastMonth !== null && row.unitsSoldLastMonth > 0
          ? row.openingStockUnits / (row.unitsSoldLastMonth / 4.33)
          : null;
       const inputCogs = row.expectedUnitCost !== null && row.sellingPrice ? row.expectedUnitCost / (row.sellingPrice / 1.16) * 100 : null;
         const values = [row.productCategory, row.subCategory, row.openingStockUnits, row.unitsSoldLastMonth, weeksOfCover, row.styleCountTarget, row.newStyleCount, row.reorderStyleCount, row.replenishmentStyleCount, row.newStyleAosUnits, row.aosUnits, row.newUnits, row.reorderUnits, row.replenishmentUnits, row.totalUnitsImplied, totals.totalUnits ? row.totalUnitsImplied / totals.totalUnits : 0, row.expectedUnitCost, row.sellingPrice, row.potentialFpRevenue, inputCogs];
       return values.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',');
     });
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${season.seasonName.replaceAll(' ', '-').toLowerCase()}-range-plan.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (rangePlan.isLoading) return <section className="page"><div className="range-plan-loading"><RefreshCw size={20} /><span>Loading range plan…</span></div></section>;
  if (rangePlan.isError || !payload || !season) return <section className="page"><div className="range-plan-error"><Target size={22} /><h2>Range Plan is unavailable</h2><p>We could not reach the planning data. Your saved plan is safe.</p><button className="button button-dark" onClick={() => rangePlan.refetch()}><RefreshCw size={15} /> Try again</button></div></section>;

  const capacityTone = totals.capacityPct <= 100 ? 'success' : totals.capacityPct <= 110 ? 'warning' : 'danger';
  const cogsTone = totals.cogsPct <= season.cogsBudgetPct ? 'success' : 'danger';
  const budgetCeiling = season.revenueTargetKes * (season.cogsBudgetPct / 100);
  const quarterMonthlyUnits = payload.quarterMonthlyRollup.reduce((sum, month) => sum + month.plannedUnits, 0);
  const quarterMonthlyRevenue = payload.quarterMonthlyRollup.reduce((sum, month) => sum + month.grossRevenuePotential, 0);
  const quarterTargetAsp = season.factoryCapacityUnits > 0 ? season.revenueTargetKes / season.factoryCapacityUnits : 0;
  const augustAchievedAsp = 3897;

  return (
    <section className="page range-plan-page">
      <div className="range-plan-hero">
        <div>
          <span className="range-eyebrow">Merchandising / Planning room</span>
          <h1>Range Plan</h1>
          <p>How many styles, at what volume and cost?</p>
        </div>
        <div className="range-plan-season-tools">
          <label htmlFor="range-season">Planning plan</label>
          <select id="range-season" value={season.id} onChange={(event) => setSelectedSeasonId(Number(event.target.value))} data-testid="select-range-plan-season">
            <optgroup label="Quarterly plans">
              {quarterlyPlans.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.seasonName} · {candidate.status}</option>)}
            </optgroup>
            <optgroup label="Monthly plans">
              {monthlyPlans.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.seasonName} · {candidate.status}</option>)}
            </optgroup>
          </select>
          <div className="range-plan-season-meta">
            <strong>{season.seasonName} <span className={`range-plan-cadence ${season.cadence}`}>{season.cadence === 'monthly' ? 'Monthly' : 'Quarterly'}</span></strong>
            <label>Revenue target <InlineCell value={season.revenueTargetKes} displayValue={kesMillions(season.revenueTargetKes)} kind="number" ariaLabel="Revenue target" onSave={(value) => saveSeason('revenueTargetKes', value)} /></label>
            <label>COGS ceiling <InlineCell value={season.cogsBudgetPct} displayValue={`${season.cogsBudgetPct}%`} kind="number" ariaLabel="COGS ceiling percentage" onSave={(value) => saveSeason('cogsBudgetPct', value)} /></label>
             <label>Factory capacity <InlineCell value={season.factoryCapacityUnits} displayValue={`${numberFormat(season.factoryCapacityUnits)} units`} kind="number" ariaLabel="Factory capacity units" onSave={(value) => saveSeason('factoryCapacityUnits', value)} /></label>
             <label>Newness floor <InlineCell value={season.newnessFloorPct} displayValue={`${season.newnessFloorPct}%`} kind="number" ariaLabel="Newness floor percentage" onSave={(value) => saveSeason('newnessFloorPct', value)} /></label>
          </div>
        </div>
      </div>

      <div className="range-plan-tabs" role="tablist" aria-label="Range Plan sections">
        {([['matrix', 'Mix Matrix'], ['otb', 'Monthly OTB'], ['health', 'Health Indicators']] as const).map(([tab, label]) => (
          <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? 'active' : ''} onClick={() => setActiveTab(tab)}>{label}</button>
        ))}
      </div>

      {activeTab === 'matrix' && (
        <>
          <div className="range-filter-bar">
            <label htmlFor="range-tier-filter">Tier view</label>
            <select id="range-tier-filter" value={tierFilter} onChange={(event) => setTierFilter(event.target.value)}>
              <option>All tiers</option><option value="NOOS">Tier 1 · NOOS</option><option value="Core">Tier 2 · Core Performers</option><option value="Recent">Tier 3 · Recent Performers</option><option value="New/Test">Tier 4 · New and Test</option>
            </select>
            <span>All headline figures and matrix shares recalculate for this view.</span>
          </div>
          <div className="range-stat-grid range-stat-grid-seven">
            <StatTile label="Total styles planned" value={numberFormat(totals.totalStyles)} detail="Across all product categories" icon={<Target size={16} />} />
            <StatTile label="Total units implied" value={numberFormat(totals.totalUnits)} detail={`${totals.capacityPct.toFixed(0)}% of ${numberFormat(season.factoryCapacityUnits)} factory capacity`} tone={capacityTone} icon={totals.capacityPct > 100 ? <TrendingUp size={16} /> : <TrendingDown size={16} />} />
            <StatTile label="Estimated COGS" value={kesMillions(totals.estimatedCogs)} detail={`${totals.costedRowCount} costed rows`} icon={<TrendingDown size={16} />} />
            <StatTile label="Gross revenue potential" value={kesMillions(totals.potentialFpRevenue)} detail="Total units × selling price" tone="success" icon={<TrendingUp size={16} />} />
            <StatTile label="COGS vs budget" value={totals.costedRowCount ? `${totals.cogsPct.toFixed(1)}%` : '—'} detail={`Blended across ${totals.costedRowCount} costed rows · ${season.cogsBudgetPct}% ceiling`} tone={cogsTone} icon={<Save size={16} />} />
            <StatTile label="New units" value={numberFormat(totals.newUnits)} detail={`${numberFormat(totals.newStyles)} Tier 4 styles × ${numberFormat(totals.effectiveNewAos)} average units`} icon={<Target size={16} />} />
            <StatTile label="Newness" value={totals.totalUnits ? `${totals.newnessPct.toFixed(1)}%` : '—'} detail={`${numberFormat(totals.requiredNewUnits)} units floor · ≈${numberFormat(totals.impliedNewStyles)} new styles required`} tone={totals.newnessPct >= season.newnessFloorPct ? 'success' : 'danger'} icon={<Target size={16} />} />
          </div>
          <div className="range-section-toolbar">
            <div><span className="range-eyebrow">Mix matrix</span><h2>Plan by product category</h2><p>Click a gold value to edit. Changes save when you leave the cell.</p></div>
            <button type="button" className="button button-outline" onClick={exportCsv}><Download size={15} /> Export CSV</button>
          </div>
          <div className="range-matrix-card">
            <div className="range-table-scroll">
              <table className="range-table range-monthly-table">
                <thead><tr><th>Sub-Category</th><th>Opening Stock</th><th>WOC</th><th>Planned Styles</th><th>New Styles <small>Tier 4</small></th><th>Reorder Styles</th><th>Replen Styles</th><th>New AOS</th><th>Reorder / Replen AOS</th><th>Total Units</th><th>New Units</th><th>Reorder Units</th><th>Replen Units</th><th>Share</th><th>Styles Ordered</th><th>Style Variance</th><th>Units Ordered</th><th>Balance to Order</th><th>Ceiling</th><th>Unit Cost</th><th>Selling Price</th><th>Gross Revenue</th><th>Input COGS</th></tr></thead>
                <tbody>
                  {monthlyCategoryOrder.map((category) => {
                    const categoryRows = visibleRows.filter((row) => row.productCategory === category);
                    if (!categoryRows.length) return null;
                    const categoryStyles = categoryRows.reduce((sum, row) => sum + row.styleCountTarget, 0);
                    const categoryUnits = categoryRows.reduce((sum, row) => sum + row.totalUnitsImplied, 0);
                    return (
                      <Fragment key={category}>
                        <tr className="range-tier-heading range-category-heading"><td colSpan={23}><strong>{category}</strong><span>{categoryRows.length} sub-categories</span></td></tr>
                        {categoryRows.map((row) => {
                          const weeksOfCover = row.openingStockUnits !== null && row.unitsSoldLastMonth !== null && row.unitsSoldLastMonth > 0
                            ? row.openingStockUnits / (row.unitsSoldLastMonth / 4.33)
                            : null;
                          const shareOfUnits = totals.totalUnits ? row.totalUnitsImplied / totals.totalUnits * 100 : 0;
                          const inputCogs = row.expectedUnitCost !== null && row.sellingPrice ? row.expectedUnitCost / (row.sellingPrice / 1.16) * 100 : null;
                          const styleVariance = row.committedStyles - row.styleCountTarget;
                          const unitBalance = row.totalUnitsImplied - row.committedUnits;
                          const unitCeiling = Math.round(row.totalUnitsImplied * 1.1);
                          const ceilingBreached = row.committedUnits > unitCeiling;
                          return (
                            <tr key={row.id} className={`${inputCogs !== null && inputCogs > season.cogsBudgetPct ? 'range-cogs-over ' : ''}${ceilingBreached ? 'range-ceiling-breach' : ''}`}>
                              <td><strong>{row.subCategory}</strong></td>
                              <td><InlineCell value={row.openingStockUnits} displayValue={row.openingStockUnits === null ? '' : numberFormat(row.openingStockUnits)} kind="number" ariaLabel={`${row.subCategory} opening stock units`} onSave={(value) => saveRow(row, 'openingStockUnits', value)} /></td>
                              <td className="range-readonly">{weeksOfCover === null ? '—' : `${weeksOfCover.toFixed(1)} wks`}</td>
                              <td className="range-total-cell">{numberFormat(row.styleCountTarget)}</td>
                              <td><InlineCell value={row.newStyleCount} kind="number" ariaLabel={`${row.subCategory} new styles`} onSave={(value) => saveRow(row, 'newStyleCount', value)} /></td>
                              <td><InlineCell value={row.reorderStyleCount} kind="number" ariaLabel={`${row.subCategory} reorder styles`} onSave={(value) => saveRow(row, 'reorderStyleCount', value)} /></td>
                              <td><InlineCell value={row.replenishmentStyleCount} kind="number" ariaLabel={`${row.subCategory} replenishment styles`} onSave={(value) => saveRow(row, 'replenishmentStyleCount', value)} /></td>
                              <td><InlineCell value={row.newStyleAosUnits} kind="number" ariaLabel={`${row.subCategory} new style average order size`} onSave={(value) => saveRow(row, 'newStyleAosUnits', value)} /></td>
                              <td><InlineCell value={row.aosUnits} kind="number" ariaLabel={`${row.subCategory} reorder and replenishment average order size`} onSave={(value) => saveRow(row, 'aosUnits', value)} /></td>
                              <td className="range-total-cell">{numberFormat(row.totalUnitsImplied)}</td>
                              <td className="range-readonly">{numberFormat(row.newUnits)}</td>
                              <td className="range-readonly">{numberFormat(row.reorderUnits)}</td>
                              <td className="range-readonly">{numberFormat(row.replenishmentUnits)}</td>
                              <td className="range-readonly">{shareOfUnits.toFixed(1)}%</td>
                              <td className="range-progress-cell">{numberFormat(row.committedStyles)}</td>
                              <td className={styleVariance > 0 ? 'range-negative-variance' : 'range-readonly'}>{styleVariance > 0 ? '+' : ''}{numberFormat(styleVariance)}</td>
                              <td className="range-progress-cell">{numberFormat(row.committedUnits)}</td>
                              <td className={unitBalance < 0 ? 'range-negative-variance' : 'range-readonly'}>{numberFormat(unitBalance)}</td>
                              <td className={ceilingBreached ? 'range-breach-alert' : 'range-readonly'}>{ceilingBreached ? `BREACH +${numberFormat(row.committedUnits - unitCeiling)}` : numberFormat(unitCeiling)}</td>
                              <td><InlineCell value={row.expectedUnitCost} displayValue={kes(row.expectedUnitCost)} kind="number" ariaLabel={`${row.subCategory} expected unit cost`} onSave={(value) => saveRow(row, 'expectedUnitCost', value)} /></td>
                              <td><InlineCell value={row.sellingPrice} displayValue={kes(row.sellingPrice)} kind="number" ariaLabel={`${row.subCategory} average selling price`} onSave={(value) => saveRow(row, 'sellingPrice', value)} /></td>
                              <td className="range-total-cell">{row.sellingPrice === null ? '—' : kes(row.potentialFpRevenue)}</td>
                              <td className={inputCogs !== null && inputCogs > season.cogsBudgetPct ? 'range-cogs-alert' : 'range-readonly'}>{inputCogs === null ? '—' : `${inputCogs.toFixed(1)}%`}</td>
                            </tr>
                          );
                        })}
                        <tr className="range-subtotal"><td>Subtotal · {category}</td><td colSpan={2} /><td>{numberFormat(categoryStyles)}</td><td colSpan={5} /><td>{numberFormat(categoryUnits)}</td><td colSpan={3} /><td>{totals.totalUnits ? `${(categoryUnits / totals.totalUnits * 100).toFixed(1)}%` : '—'}</td><td colSpan={10} /></tr>
                      </Fragment>
                    );
                  })}
                  <tr className="range-grand-total"><td>Grand total</td><td colSpan={2} /><td>{numberFormat(totals.totalStyles)}</td><td>{numberFormat(totals.newStyles)}</td><td colSpan={4} /><td>{numberFormat(totals.totalUnits)}</td><td>{numberFormat(totals.newUnits)}</td><td colSpan={2} /><td>{totals.totalUnits ? '100.0%' : '—'}</td><td colSpan={7} /><td>{kes(totals.potentialFpRevenue)}</td><td>{totals.costedRowCount && totals.totalUnits ? `${totals.cogsPct.toFixed(1)}%` : '—'}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {activeTab === 'otb' && (
        <>
          <div className="range-section-toolbar">
            <div><span className="range-eyebrow">Open to buy</span><h2>{season.cadence === 'quarterly' ? 'Do the monthly plans add up to the quarter?' : 'Turn the plan into a monthly rhythm'}</h2><p>{season.cadence === 'quarterly' ? 'October, November and December are calculated directly from their category plans.' : 'All gold cells are editable and save on blur.'}</p></div>
            <span className="range-otb-assumption">COGS budget {season.cogsBudgetPct}%</span>
          </div>
          {season.cadence === 'quarterly' ? (
            <>
              <div className="range-otb-card">
                <div className="range-table-scroll">
                  <table className="range-table range-otb-table range-otb-recon-table">
                    <thead><tr><th>Measure</th>{payload.quarterMonthlyRollup.map((month) => <th key={month.monthYear}>{monthLabel(month.monthYear)}</th>)}<th>Combined</th><th>Q4 benchmark</th><th>Variance</th></tr></thead>
                    <tbody>
                      <tr>
                        <th>Planned Units <small>from monthly mix matrices</small></th>
                        {payload.quarterMonthlyRollup.map((month) => <td key={month.monthYear}>{numberFormat(month.plannedUnits)}</td>)}
                        <td><strong>{numberFormat(quarterMonthlyUnits)}</strong></td>
                        <td>{numberFormat(totals.totalUnits)}</td>
                        <td className={quarterMonthlyUnits - totals.totalUnits < 0 ? 'range-negative-variance' : ''}>{numberFormat(quarterMonthlyUnits - totals.totalUnits)}</td>
                      </tr>
                      <tr>
                        <th>Gross Revenue Potential <small>units × selling price</small></th>
                        {payload.quarterMonthlyRollup.map((month) => <td key={month.monthYear}>{kes(month.grossRevenuePotential)}</td>)}
                        <td><strong>{kes(quarterMonthlyRevenue)}</strong></td>
                        <td>{kes(season.revenueTargetKes)}</td>
                        <td className={quarterMonthlyRevenue - season.revenueTargetKes < 0 ? 'range-negative-variance' : ''}>{kes(quarterMonthlyRevenue - season.revenueTargetKes)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="range-quarter-price-gap">
                <div><span>Q4 target revenue</span><strong>{kesMillions(season.revenueTargetKes)}</strong></div>
                <div><span>Q4 capacity</span><strong>{numberFormat(season.factoryCapacityUnits)} units</strong></div>
                <div><span>Implied blended selling price</span><strong>{kes(quarterTargetAsp)}</strong></div>
                <div><span>August achieved selling price</span><strong>{kes(augustAchievedAsp)}</strong></div>
                <p>The Q4 target requires {kes(quarterTargetAsp - augustAchievedAsp)} more per unit than August. The planned November discount mix and December premium mix remain visible in the monthly totals above.</p>
              </div>
            </>
          ) : (
            <>
              <div className="range-otb-card">
                <div className="range-table-scroll">
                  <table className="range-table range-otb-table">
                    <thead><tr><th>Measure</th>{payload.otb.map((month) => <th key={month.monthYear}>{monthLabel(month.monthYear)}</th>)}</tr></thead>
                    <tbody>
                      <tr><th>Revenue Target <small>KES</small></th>{payload.otb.map((month) => <td key={month.monthYear}><InlineCell value={month.revenueTarget ?? season.revenueTargetKes} displayValue={kes(month.revenueTarget ?? season.revenueTargetKes)} kind="number" ariaLabel={`${monthLabel(month.monthYear)} revenue target`} onSave={(value) => saveOtb(month, 'revenueTarget', value)} /></td>)}</tr>
                      <tr className="range-auto-row"><th>COGS Budget <small>KES</small></th>{payload.otb.map((month) => <td key={month.monthYear}>{kes((month.revenueTarget ?? season.revenueTargetKes) * season.cogsBudgetPct / 100)}</td>)}</tr>
                      <tr className="range-auto-row"><th>Planned Units <small>from mix matrix</small></th>{payload.otb.map((month) => <td key={month.monthYear}>{numberFormat(totals.totalUnits)}</td>)}</tr>
                      <tr><th>New Styles Launching</th>{payload.otb.map((month) => <td key={month.monthYear}><InlineCell value={month.newStylesCount} kind="number" ariaLabel={`${monthLabel(month.monthYear)} new styles`} onSave={(value) => saveOtb(month, 'newStylesCount', value)} /></td>)}</tr>
                      <tr className="range-auto-row"><th>Gross Revenue Potential</th>{payload.otb.map((month) => <td key={month.monthYear}>{kes(totals.potentialFpRevenue)}</td>)}</tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="range-otb-note"><span className="range-gold-dot" /> Planned units and gross revenue come directly from this plan’s category matrix.</div>
              <div className="range-otb-category-card">
                <div className="range-section-toolbar"><div><span className="range-eyebrow">Category intake budget</span><h2>Where the monthly buy goes</h2><p>Category allocations follow each line's share of the planned style count.</p></div></div>
                <div className="range-table-scroll">
                  <table className="range-table range-otb-category-table">
                    <thead><tr><th>Sub-Category</th>{payload.otb.map((month) => <th key={month.monthYear}>{monthShort(month.monthYear)}</th>)}</tr></thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id}><td><strong>{row.subCategory}</strong><small>{row.productCategory} · {numberFormat(row.styleCountTarget)} styles</small></td>{payload.otb.map((month) => { const monthlyBudget = (month.revenueTarget ?? season.revenueTargetKes) * season.cogsBudgetPct / 100; const share = totals.totalStyles ? row.styleCountTarget / totals.totalStyles : 0; return <td key={`${row.id}-${month.monthYear}`}>{kes(monthlyBudget * share)}</td>; })}</tr>
                      ))}
                      <tr className="range-grand-total"><td>Total category intake budget</td>{payload.otb.map((month) => <td key={month.monthYear}>{kes((month.revenueTarget ?? season.revenueTargetKes) * season.cogsBudgetPct / 100)}</td>)}</tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {activeTab === 'health' && (
        <>
          <div className="range-section-toolbar">
            <div><span className="range-eyebrow">Live health check</span><h2>Is the range telling a coherent story?</h2><p>Tier counts come directly from the active range and never contribute to planned units or revenue.</p></div>
          </div>
          <div className="range-tier-health-card">
            <div className="range-card-heading"><span className="range-eyebrow">Range architecture</span><h3>Style Count by Tier</h3></div>
            <div className="range-table-scroll">
              <table className="range-table range-tier-health-table">
                <thead><tr><th>Tier</th><th>Current styles</th><th>Minimum target</th><th>Maximum target</th><th>Health</th></tr></thead>
                <tbody>
                  {payload.health.tiers.map((tier) => {
                    const status = tier.count < tier.minimum ? 'Below target' : tier.count > tier.maximum ? 'Above target' : 'Within target';
                    const tone = tier.count < tier.minimum ? 'below' : tier.count > tier.maximum ? 'above' : 'within';
                    return <tr key={tier.tier}><td><strong>{tier.label}</strong></td><td>{numberFormat(tier.count)}</td><td>{numberFormat(tier.minimum)}</td><td>{numberFormat(tier.maximum)}</td><td><span className={`range-tier-health-status ${tone}`}>{status}</span></td></tr>;
                  })}
                </tbody>
              </table>
            </div>
            <p className="range-tier-health-note">Style counts only. Average order size is not applied.</p>
          </div>
          <div className="range-health-grid">
            <ChartCard eyebrow="Pipeline composition" title="New vs Repeat Split">
              <div className="range-chart-with-legend">
                <div className="range-donut"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={[{ name: 'New', value: payload.health.newRepeat.newCount }, { name: 'Repeat', value: payload.health.newRepeat.repeatCount }]} dataKey="value" innerRadius="62%" outerRadius="88%" paddingAngle={3} stroke="none"><Cell fill="#C9A96E" /><Cell fill="#1A1A2E" /></Pie><Tooltip formatter={(value) => numberFormat(Number(value))} /></PieChart></ResponsiveContainer><div className="range-donut-center"><strong>{numberFormat(payload.health.newRepeat.total)}</strong><span>active styles</span></div></div>
                <div className="range-chart-legend"><div><i style={{ background: '#C9A96E' }} /> New <strong>{payload.health.newRepeat.total ? `${Math.round(payload.health.newRepeat.newCount / payload.health.newRepeat.total * 100)}%` : '—'}</strong></div><div><i style={{ background: '#1A1A2E' }} /> Repeat <strong>{payload.health.newRepeat.total ? `${Math.round(payload.health.newRepeat.repeatCount / payload.health.newRepeat.total * 100)}%` : '—'}</strong></div></div>
              </div>
            </ChartCard>
            <ChartCard eyebrow="Live catalogue" title="Style Count by Sub-Category" className="range-bar-card">
              <div className="range-chart"><ResponsiveContainer width="100%" height={250}><BarChart data={payload.health.subCategories} layout="vertical" margin={{ top: 0, right: 20, left: 10, bottom: 0 }}><CartesianGrid horizontal={false} stroke="#E8E4DE" /><XAxis type="number" allowDecimals={false} axisLine={false} tickLine={false} /><YAxis dataKey="name" type="category" width={112} axisLine={false} tickLine={false} tick={{ fill: '#6D6A64', fontSize: 11 }} /><Tooltip cursor={{ fill: '#FAFAF8' }} /><Bar dataKey="count" fill="#C9A96E" radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer></div>
            </ChartCard>
            <ChartCard eyebrow="Factory constraint" title="Units vs Capacity">
              <div className="range-gauge"><ResponsiveContainer width="100%" height={230}><RadialBarChart cx="50%" cy="76%" innerRadius="58%" outerRadius="92%" barSize={20} startAngle={180} endAngle={0} data={[{ value: Math.min(totals.capacityPct, 120), fill: totals.capacityPct <= 100 ? '#557C7A' : totals.capacityPct <= 110 ? '#C9A96E' : '#B86B58' }]}><RadialBar background={{ fill: '#EEEAE3' }} dataKey="value" cornerRadius={4} /><text x="50%" y="67%" textAnchor="middle" dominantBaseline="middle" className="range-gauge-value">{totals.capacityPct.toFixed(0)}%</text><text x="50%" y="80%" textAnchor="middle" className="range-gauge-label">of capacity</text></RadialBarChart></ResponsiveContainer><div className="range-gauge-footer"><span>{numberFormat(totals.totalUnits)} implied</span><b>{numberFormat(season.factoryCapacityUnits)} units available</b></div></div>
            </ChartCard>
            <ChartCard eyebrow="Cost discipline" title="COGS vs Budget">
              <div className="range-chart range-cogs-chart"><ResponsiveContainer width="100%" height={250}><BarChart data={[{ name: 'COGS', estimated: totals.estimatedCogs, budget: budgetCeiling }]} margin={{ top: 12, right: 12, left: 10, bottom: 5 }}><CartesianGrid vertical={false} stroke="#E8E4DE" /><XAxis dataKey="name" axisLine={false} tickLine={false} /><YAxis tickFormatter={(value) => `${(Number(value) / 1_000_000).toFixed(0)}m`} axisLine={false} tickLine={false} /><Tooltip formatter={(value) => kes(Number(value))} /><Bar dataKey="estimated" name="Estimated COGS" fill="#B86B58" radius={[3, 3, 0, 0]} /><Bar dataKey="budget" name="Budget ceiling" fill="#C9A96E" radius={[3, 3, 0, 0]} /><ReferenceLine y={budgetCeiling} stroke="#1A1A2E" strokeDasharray="4 4" /><Label value={`Budget ${kesMillions(budgetCeiling)}`} position="insideTopRight" /></BarChart></ResponsiveContainer></div>
            </ChartCard>
          </div>
        </>
      )}
    </section>
  );
}

export default RangePlanPage;