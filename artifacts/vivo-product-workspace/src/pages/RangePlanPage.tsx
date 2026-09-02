import { Fragment, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, Plus, RefreshCw, Save, Target, TrendingDown, TrendingUp, X } from 'lucide-react';
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

type Tier = 'NOOS' | 'Core' | 'Recent' | 'New/Test';
type RangePlanSeason = {
  id: number;
  seasonName: string;
  seasonYear: number;
  revenueTargetKes: number;
  cogsBudgetPct: number;
  factoryCapacityUnits: number;
  status: string;
  cadence: 'quarterly' | 'monthly';
};
type RangePlanRow = {
  id: number;
  seasonId: number;
  subCategory: string;
  productCategory: string | null;
  tier: Tier;
  styleCountTarget: number;
  styleCountMin: number;
  styleCountMax: number;
  aosUnits: number;
  totalUnitsImplied: number;
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
};
type RangePlanResponse = {
  seasons: RangePlanSeason[];
  season: RangePlanSeason | null;
  rows: RangePlanRow[];
  otb: RangePlanOtb[];
  averageCostKes: number;
  potentialFpRevenue: number;
  health: RangePlanHealth;
};

const tierLabels: Record<Tier, string> = {
  NOOS: 'NOOS',
  Core: 'Core Performers',
  Recent: 'Recent Performers',
  'New/Test': 'New/Test',
};
const tierOrder: Tier[] = ['NOOS', 'Core', 'Recent', 'New/Test'];
const monthlyCategoryOrder = ['Bottoms', 'Dresses', 'Outerwear', 'Skirts', 'Tops'];
const tierDefaults: Record<Tier, [number, number]> = {
  NOOS: [30, 50],
  Core: [8, 18],
  Recent: [8, 18],
  'New/Test': [3, 8],
};
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
function displayTier(tier: string) {
  return tierLabels[tier as Tier] || tier;
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
  const [addingTier, setAddingTier] = useState<Tier | null>(null);
  const [newSubCategory, setNewSubCategory] = useState('');
  const rangePlan = useQuery({
    queryKey: ['workspace', 'range-plan', selectedSeasonId],
    queryFn: () => getRangePlan(selectedSeasonId),
    staleTime: 60_000,
  });
  const updateSeason = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: { revenueTargetKes?: number; cogsBudgetPct?: number; factoryCapacityUnits?: number } }) => {
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
  const createRow = useMutation({
    mutationFn: async ({ seasonId, tier, subCategory }: { seasonId: number; tier: Tier; subCategory: string }) => {
      const [styleCountMin, styleCountMax] = tierDefaults[tier];
      const response = await fetch(`/api/workspace/range-plan/seasons/${seasonId}/rows`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier,
          subCategory,
          styleCountMin,
          styleCountMax,
          styleCountTarget: Math.round((styleCountMin + styleCountMax) / 2),
          aosUnits: 350,
        }),
      });
      if (!response.ok) throw new Error(`Could not add range row (${response.status})`);
      return response.json();
    },
    onSuccess: () => {
      setAddingTier(null);
      setNewSubCategory('');
      queryClient.invalidateQueries({ queryKey: ['workspace', 'range-plan'] });
    },
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
  const quarterlyPlans = (payload?.seasons ?? []).filter((candidate) => candidate.cadence === 'quarterly');
  const monthlyPlans = (payload?.seasons ?? []).filter((candidate) => candidate.cadence === 'monthly');
  const totals = useMemo(() => {
    const totalStyles = rows.reduce((sum, row) => sum + row.styleCountTarget, 0);
    const totalUnits = rows.reduce((sum, row) => sum + row.totalUnitsImplied, 0);
    const monthly = season?.cadence === 'monthly';
    const costedRows = rows.filter((row) => row.expectedUnitCost !== null && row.sellingPrice !== null && row.sellingPrice > 0);
    const estimatedCogs = monthly
      ? costedRows.reduce((sum, row) => sum + row.totalUnitsImplied * Number(row.expectedUnitCost), 0)
      : totalUnits * (payload?.averageCostKes ?? 850);
    const potentialFpRevenue = rows
      .filter((row) => monthly || row.tier !== 'New/Test')
      .reduce((sum, row) => sum + row.potentialFpRevenue, 0);
    const costedNetRevenue = monthly
      ? costedRows.reduce((sum, row) => sum + row.totalUnitsImplied * (Number(row.sellingPrice) / 1.16), 0)
      : potentialFpRevenue / 1.16;
    const cogsPct = costedNetRevenue > 0 ? (estimatedCogs / costedNetRevenue) * 100 : 0;
    const capacityPct = season?.factoryCapacityUnits ? (totalUnits / season.factoryCapacityUnits) * 100 : 0;
    return { totalStyles, totalUnits, estimatedCogs, cogsPct, capacityPct, potentialFpRevenue, costedRowCount: costedRows.length };
  }, [payload?.averageCostKes, rows, season]);

  const saveRow = (row: RangePlanRow, field: 'styleCountTarget' | 'aosUnits' | 'openingStockUnits' | 'unitsSoldLastMonth' | 'expectedUnitCost' | 'sellingPrice' | 'notes', value: string) => {
    const optional = field === 'openingStockUnits' || field === 'unitsSoldLastMonth' || field === 'expectedUnitCost' || field === 'sellingPrice';
    const parsed = optional && value.trim() === '' ? null : Math.max(0, Number(value || 0));
    updateRow.mutate({ id: row.id, data: { [field]: field === 'notes' ? value : parsed } });
  };
  const saveSeason = (field: 'revenueTargetKes' | 'cogsBudgetPct' | 'factoryCapacityUnits', value: string) => {
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
     const monthly = season.cadence === 'monthly';
     const header = monthly
       ? ['Product Category', 'Sub-Category', 'Opening Stock Units', 'Units Sold Last Month', 'Weeks of Cover', 'Planned Styles', 'Average Order Size', 'Total Units', 'Share of Units', 'Expected Unit Cost', 'Average Selling Price', 'Gross Revenue Potential', 'Input COGS %', 'Unit Floor', 'Unit Ceiling']
       : ['Sub-Category', 'Tier', 'Style Target', 'Min', 'Max', 'AOS Units', 'Total Units', 'ASP', 'Potential FP Revenue', 'Notes'];
     const lines = rows.map((row) => {
        const weeksOfCover = row.openingStockUnits !== null && row.unitsSoldLastMonth !== null && row.unitsSoldLastMonth > 0
          ? row.openingStockUnits / (row.unitsSoldLastMonth / 4.33)
          : null;
       const inputCogs = row.expectedUnitCost !== null && row.sellingPrice ? row.expectedUnitCost / (row.sellingPrice / 1.16) * 100 : null;
       const values = monthly
         ? [row.productCategory, row.subCategory, row.openingStockUnits, row.unitsSoldLastMonth, weeksOfCover, row.styleCountTarget, row.aosUnits, row.totalUnitsImplied, totals.totalUnits ? row.totalUnitsImplied / totals.totalUnits : 0, row.expectedUnitCost, row.sellingPrice, row.potentialFpRevenue, inputCogs, row.totalUnitsImplied * 0.9, row.totalUnitsImplied * 1.1]
         : [row.subCategory, displayTier(row.tier), row.styleCountTarget, row.styleCountMin, row.styleCountMax, row.aosUnits, row.totalUnitsImplied, row.asp, row.potentialFpRevenue, row.notes];
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

  const tierRows = (tier: Tier) => rows.filter((row) => row.tier === tier);
  const capacityTone = totals.capacityPct <= 100 ? 'success' : totals.capacityPct <= 110 ? 'warning' : 'danger';
  const cogsTone = totals.cogsPct <= season.cogsBudgetPct ? 'success' : 'danger';
  const budgetCeiling = season.revenueTargetKes * (season.cogsBudgetPct / 100);

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
          <div className="range-stat-grid">
            <StatTile label="Total styles planned" value={numberFormat(totals.totalStyles)} detail={season.cadence === 'monthly' ? 'Across all product categories' : 'Across all tier groups'} icon={<Target size={16} />} />
            <StatTile label="Total units implied" value={numberFormat(totals.totalUnits)} detail={`${totals.capacityPct.toFixed(0)}% of ${numberFormat(season.factoryCapacityUnits)} factory capacity`} tone={capacityTone} icon={totals.capacityPct > 100 ? <TrendingUp size={16} /> : <TrendingDown size={16} />} />
            <StatTile label="Estimated COGS" value={kesMillions(totals.estimatedCogs)} detail={season.cadence === 'monthly' ? `${totals.costedRowCount} costed rows` : `${kes(payload.averageCostKes)} average cost per unit`} icon={<TrendingDown size={16} />} />
             <StatTile label={season.cadence === 'monthly' ? 'Gross revenue potential' : 'Potential FP Revenue'} value={kesMillions(totals.potentialFpRevenue)} detail={season.cadence === 'monthly' ? 'Total units × selling price' : 'Planned NOOS, Core and Recent styles'} tone="success" icon={<TrendingUp size={16} />} />
              <StatTile label="COGS vs budget" value={totals.costedRowCount || season.cadence === 'quarterly' ? `${totals.cogsPct.toFixed(1)}%` : '—'} detail={season.cadence === 'monthly' ? `Blended across ${totals.costedRowCount} costed rows · ${season.cogsBudgetPct}% ceiling` : `${season.cogsBudgetPct}% ceiling · cost ÷ VAT-exclusive selling price`} tone={cogsTone} icon={<Save size={16} />} />
          </div>
          <div className="range-section-toolbar">
            <div><span className="range-eyebrow">Mix matrix</span><h2>{season.cadence === 'monthly' ? 'Plan the month by product category' : 'Plan the shape of the season'}</h2><p>Click a gold value to edit. Changes save when you leave the cell.</p></div>
            <button type="button" className="button button-outline" onClick={exportCsv}><Download size={15} /> Export CSV</button>
          </div>
          <div className="range-matrix-card">
            <div className="range-table-scroll">
              {season.cadence === 'monthly' ? (
                <table className="range-table range-monthly-table">
                  <thead><tr><th>Sub-Category</th><th>Opening Stock</th><th>Sold Last Month</th><th>Weeks of Cover</th><th>Planned Styles</th><th>Average Order Size</th><th>Total Units</th><th>Share of Units</th><th>Expected Unit Cost</th><th>Average Selling Price</th><th>Gross Revenue Potential</th><th>Input COGS</th><th>Unit Floor</th><th>Unit Ceiling</th></tr></thead>
                  <tbody>
                    {monthlyCategoryOrder.map((category) => {
                      const categoryRows = rows.filter((row) => row.productCategory === category);
                      if (!categoryRows.length) return null;
                      const categoryStyles = categoryRows.reduce((sum, row) => sum + row.styleCountTarget, 0);
                      const categoryUnits = categoryRows.reduce((sum, row) => sum + row.totalUnitsImplied, 0);
                      return (
                        <Fragment key={category}>
                          <tr className="range-tier-heading range-category-heading"><td colSpan={14}><strong>{category}</strong><span>{categoryRows.length} sub-categories</span></td></tr>
                          {categoryRows.map((row) => {
                            const weeksOfCover = row.openingStockUnits !== null && row.unitsSoldLastMonth !== null && row.unitsSoldLastMonth > 0
                              ? row.openingStockUnits / (row.unitsSoldLastMonth / 4.33)
                              : null;
                            const shareOfUnits = totals.totalUnits ? row.totalUnitsImplied / totals.totalUnits * 100 : 0;
                            const inputCogs = row.expectedUnitCost !== null && row.sellingPrice ? row.expectedUnitCost / (row.sellingPrice / 1.16) * 100 : null;
                            return (
                              <tr key={row.id} className={inputCogs !== null && inputCogs > season.cogsBudgetPct ? 'range-cogs-over' : ''}>
                                <td><strong>{row.subCategory}</strong></td>
                                <td><InlineCell value={row.openingStockUnits} displayValue={row.openingStockUnits === null ? '' : numberFormat(row.openingStockUnits)} kind="number" ariaLabel={`${row.subCategory} opening stock units`} onSave={(value) => saveRow(row, 'openingStockUnits', value)} /></td>
                                <td><InlineCell value={row.unitsSoldLastMonth} kind="number" ariaLabel={`${row.subCategory} units sold last month`} onSave={(value) => saveRow(row, 'unitsSoldLastMonth', value)} /></td>
                                <td className="range-readonly">{weeksOfCover === null ? '—' : `${weeksOfCover.toFixed(1)} wks`}</td>
                                <td><InlineCell value={row.styleCountTarget} kind="number" ariaLabel={`${row.subCategory} planned styles`} onSave={(value) => saveRow(row, 'styleCountTarget', value)} /></td>
                                <td><InlineCell value={row.aosUnits} kind="number" ariaLabel={`${row.subCategory} average order size`} onSave={(value) => saveRow(row, 'aosUnits', value)} /></td>
                                <td className="range-total-cell">{numberFormat(row.totalUnitsImplied)}</td>
                                <td className="range-readonly">{shareOfUnits.toFixed(1)}%</td>
                                <td><InlineCell value={row.expectedUnitCost} displayValue={kes(row.expectedUnitCost)} kind="number" ariaLabel={`${row.subCategory} expected unit cost`} onSave={(value) => saveRow(row, 'expectedUnitCost', value)} /></td>
                                <td><InlineCell value={row.sellingPrice} displayValue={kes(row.sellingPrice)} kind="number" ariaLabel={`${row.subCategory} average selling price`} onSave={(value) => saveRow(row, 'sellingPrice', value)} /></td>
                                <td className="range-total-cell">{row.sellingPrice === null ? '—' : kes(row.potentialFpRevenue)}</td>
                                <td className={inputCogs !== null && inputCogs > season.cogsBudgetPct ? 'range-cogs-alert' : 'range-readonly'}>{inputCogs === null ? '—' : `${inputCogs.toFixed(1)}%`}</td>
                                <td className="range-readonly">{numberFormat(Math.round(row.totalUnitsImplied * 0.9))}</td>
                                <td className="range-readonly">{numberFormat(Math.round(row.totalUnitsImplied * 1.1))}</td>
                              </tr>
                            );
                          })}
                          <tr className="range-subtotal"><td>Subtotal · {category}</td><td colSpan={3} /><td>{numberFormat(categoryStyles)}</td><td /><td>{numberFormat(categoryUnits)}</td><td>{totals.totalUnits ? `${(categoryUnits / totals.totalUnits * 100).toFixed(1)}%` : '—'}</td><td colSpan={6} /></tr>
                        </Fragment>
                      );
                    })}
                    <tr className="range-grand-total"><td>Grand total</td><td colSpan={3} /><td>{numberFormat(totals.totalStyles)}</td><td /><td>{numberFormat(totals.totalUnits)}</td><td>100.0%</td><td colSpan={2} /><td>{kes(totals.potentialFpRevenue)}</td><td>{totals.costedRowCount ? `${totals.cogsPct.toFixed(1)}%` : '—'}</td><td colSpan={2} /></tr>
                  </tbody>
                </table>
              ) : (
                <table className="range-table">
                  <thead><tr><th>Sub-Category</th><th>Tier</th><th>Style Target</th><th>Min</th><th>Max</th><th>AOS (units)</th><th>Total Units</th><th>ASP</th><th>Potential FP Revenue</th><th>Notes</th></tr></thead>
                  <tbody>
                    {tierOrder.map((tier) => {
                      const groupRows = tierRows(tier);
                      const groupStyles = groupRows.reduce((sum, row) => sum + row.styleCountTarget, 0);
                      const groupUnits = groupRows.reduce((sum, row) => sum + row.totalUnitsImplied, 0);
                      return (
                        <Fragment key={tier}>
                          <tr className="range-tier-heading"><td colSpan={10}><span className={`range-tier-dot tier-${tier.replace('/', '-')}`} /><strong>{tierLabels[tier]}</strong><span>{groupRows.length} planning lines</span></td></tr>
                          {groupRows.map((row) => (
                            <tr key={row.id}>
                              <td><strong>{row.subCategory}</strong></td><td><span className={`range-tier-pill tier-${row.tier.replace('/', '-')}`}>{displayTier(row.tier)}</span></td>
                              <td><InlineCell value={row.styleCountTarget} kind="number" ariaLabel={`${row.subCategory} style target`} onSave={(value) => saveRow(row, 'styleCountTarget', value)} /></td>
                              <td className="range-readonly">{numberFormat(row.styleCountMin)}</td><td className="range-readonly">{numberFormat(row.styleCountMax)}</td>
                              <td><InlineCell value={row.aosUnits} kind="number" ariaLabel={`${row.subCategory} AOS`} onSave={(value) => saveRow(row, 'aosUnits', value)} /></td>
                              <td className="range-total-cell">{numberFormat(row.totalUnitsImplied)}</td><td className="range-readonly">{kes(row.asp)}</td>
                              <td className="range-total-cell">{row.tier === 'New/Test' ? '—' : kes(row.potentialFpRevenue)}</td>
                              <td><InlineCell value={row.notes} ariaLabel={`${row.subCategory} notes`} placeholder="Add note" onSave={(value) => saveRow(row, 'notes', value)} /></td>
                            </tr>
                          ))}
                          <tr className="range-subtotal"><td colSpan={2}>Subtotal · {tierLabels[tier]}</td><td>{numberFormat(groupStyles)}</td><td colSpan={3} /><td>{numberFormat(groupUnits)}</td><td /></tr>
                          {addingTier === tier ? <tr className="range-add-row"><td colSpan={10}><div className="range-add-form"><input autoFocus value={newSubCategory} onChange={(event) => setNewSubCategory(event.target.value)} placeholder="New sub-category name" onKeyDown={(event) => { if (event.key === 'Enter' && season) createRow.mutate({ seasonId: season.id, tier, subCategory: newSubCategory.trim() }); }} /><button type="button" className="button button-gold" disabled={!newSubCategory.trim() || createRow.isPending} onClick={() => createRow.mutate({ seasonId: season.id, tier, subCategory: newSubCategory.trim() })}><Plus size={14} /> Add</button><button type="button" className="icon-button" onClick={() => { setAddingTier(null); setNewSubCategory(''); }} aria-label="Cancel add row"><X size={15} /></button></div></td></tr> : <tr className="range-add-row"><td colSpan={10}><button type="button" className="range-add-button" onClick={() => { setAddingTier(tier); setNewSubCategory(''); }}><Plus size={14} /> Add row to {tierLabels[tier]}</button></td></tr>}
                        </Fragment>
                      );
                    })}
                    <tr className="range-grand-total"><td colSpan={2}>Grand total</td><td>{numberFormat(totals.totalStyles)}</td><td colSpan={3} /><td>{numberFormat(totals.totalUnits)}</td><td /><td>{kes(totals.potentialFpRevenue)}</td><td /></tr>
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {activeTab === 'otb' && (
        <>
          <div className="range-section-toolbar">
            <div><span className="range-eyebrow">Open to buy</span><h2>Turn the annual ambition into a monthly rhythm</h2><p>Revenue starts from the season target divided by 12. All gold cells are editable and save on blur.</p></div>
            <span className="range-otb-assumption">COGS budget {season.cogsBudgetPct}%</span>
          </div>
          <div className="range-otb-card">
            <div className="range-table-scroll">
              <table className="range-table range-otb-table">
                <thead><tr><th>Measure</th>{payload.otb.map((month) => <th key={month.monthYear}>{monthLabel(month.monthYear)}</th>)}</tr></thead>
                <tbody>
                  <tr><th>Revenue Target <small>KES</small></th>{payload.otb.map((month) => <td key={month.monthYear}><InlineCell value={month.revenueTarget ?? season.revenueTargetKes / 12} displayValue={kes(month.revenueTarget ?? season.revenueTargetKes / 12)} kind="number" ariaLabel={`${monthLabel(month.monthYear)} revenue target`} onSave={(value) => saveOtb(month, 'revenueTarget', value)} /></td>)}</tr>
                  <tr className="range-auto-row"><th>COGS Budget <small>KES</small></th>{payload.otb.map((month) => <td key={month.monthYear}>{kes((month.revenueTarget ?? season.revenueTargetKes / 12) * season.cogsBudgetPct / 100)}</td>)}</tr>
                  <tr><th>Planned Units</th>{payload.otb.map((month) => <td key={month.monthYear}><InlineCell value={month.plannedUnits} kind="number" ariaLabel={`${monthLabel(month.monthYear)} planned units`} onSave={(value) => saveOtb(month, 'plannedUnits', value)} /></td>)}</tr>
                  <tr><th>New Styles Launching</th>{payload.otb.map((month) => <td key={month.monthYear}><InlineCell value={month.newStylesCount} kind="number" ariaLabel={`${monthLabel(month.monthYear)} new styles`} onSave={(value) => saveOtb(month, 'newStylesCount', value)} /></td>)}</tr>
                  <tr className="range-auto-row"><th>Carry-over Styles</th>{payload.otb.map((month) => <td key={month.monthYear}>{numberFormat(payload.health.activeStyleCount)}</td>)}</tr>
                  <tr className={payload.otb.some((month) => month.id === null) ? 'range-otb-unset' : ''}><th>OTB Value <small>KES</small></th>{payload.otb.map((month) => <td key={month.monthYear}>{kes((month.revenueTarget ?? season.revenueTargetKes / 12) * season.cogsBudgetPct / 100)}{month.id === null && <span className="range-unset-label">Not saved</span>}</td>)}</tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="range-otb-note"><span className="range-gold-dot" /> OTB Value is the monthly COGS budget ceiling. Enter planned units and new style launches to make the buy cadence explicit.</div>
           <div className="range-otb-category-card">
             <div className="range-section-toolbar"><div><span className="range-eyebrow">Category intake budget</span><h2>Where the monthly buy goes</h2><p>Category allocations follow each line's share of the planned style count.</p></div></div>
             <div className="range-table-scroll">
               <table className="range-table range-otb-category-table">
                 <thead><tr><th>Sub-Category</th>{payload.otb.map((month) => <th key={month.monthYear}>{monthShort(month.monthYear)}</th>)}</tr></thead>
                 <tbody>
                   {rows.map((row) => (
                     <tr key={row.id}><td><strong>{row.subCategory}</strong><small>{displayTier(row.tier)} · {numberFormat(row.styleCountTarget)} styles</small></td>{payload.otb.map((month) => { const monthlyBudget = (month.revenueTarget ?? season.revenueTargetKes / 12) * season.cogsBudgetPct / 100; const share = totals.totalStyles ? row.styleCountTarget / totals.totalStyles : 0; return <td key={`${row.id}-${month.monthYear}`}>{kes(monthlyBudget * share)}</td>; })}</tr>
                   ))}
                   <tr className="range-grand-total"><td>Total category intake budget</td>{payload.otb.map((month) => <td key={month.monthYear}>{kes((month.revenueTarget ?? season.revenueTargetKes / 12) * season.cogsBudgetPct / 100)}</td>)}</tr>
                 </tbody>
               </table>
             </div>
           </div>
        </>
      )}

      {activeTab === 'health' && (
        <>
          <div className="range-section-toolbar">
            <div><span className="range-eyebrow">Live health check</span><h2>Is the range telling a coherent story?</h2><p>Indicators use the active style catalogue and the current mix matrix.</p></div>
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