import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, Download, ExternalLink, FileSpreadsheet, Pencil, RefreshCw, Save, Target, TrendingDown, TrendingUp } from 'lucide-react';
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
  newnessTargetUnits: number | null;
  newnessFloorPct: number;
  status: string;
  cadence: 'quarterly' | 'monthly';
  stockSalesReport: StockSalesReport | null;
};
type StockSalesReport = {
  id: number;
  reportMonth: string;
  pulledAt: string;
  reportUrl: string;
  informedPlanId: number | null;
  informedPlanName: string | null;
};
type RangePlanRow = {
  id: number;
  seasonId: number;
  subCategory: string;
  productCategory: string | null;
  tier: string;
  styleCountTarget: number;
  newStyleCount: number;
  pipelineNewStylesAvailable: number;
  newStylesGap: number;
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
  plannedPendingStyles: number;
  plannedPendingUnits: number;
  orderedStyles: number;
  orderedUnits: number;
  balanceStyles: number;
  balanceUnits: number;
  projectedUnits: number;
  ceilingUnits: number;
  ceilingBreached: boolean;
  openingStockUnits: number | null;
  unitsSoldLastMonth: number | null;
  expectedUnitCost: number | null;
  sellingPrice: number | null;
  asp: number | null;
  potentialFpRevenue: number;
  weeksOfCover: number | null;
  inputCogsPct: number | null;
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
  grossRevenuePotential: number | null;
  hasMonthlyPlan: boolean;
};
type PlanningDisclosure = {
  headline: string;
  actualLabel: string;
  actualOrders: number;
  actualUnits: number;
  planLabel: string;
  planUnits: number;
  totalUnits: number;
  juneBookedOrders: number;
  juneBookedUnits: number;
  septemberPlacedOrders: number;
  septemberPlacedUnits: number;
  actualCogsPct: number;
  capacityUnits: number;
  note: string;
};
type PipelineComparison = {
  plannedNewStyles: number;
  availableNewStyles: number;
  shortfall: number;
  surplus: number;
  targetOrderWeeks: string;
};
type OrderTracking = {
  periodLabel: 'Month' | 'Quarter';
  plannedStyles: number;
  plannedUnits: number;
  orderedStyles: number;
  orderedUnits: number;
  plannedPendingStyles: number;
  plannedPendingUnits: number;
  balanceStyles: number;
  balanceUnits: number;
  projectedUnits: number;
  projectedCapacityPct: number;
  ceilingUnits: number;
  ceilingBreached: boolean;
  significantlyUnderOrdered: boolean;
  elapsedPct: number;
  unmatchedStyles: number;
  unmatchedUnits: number;
  unmatched: Array<{ source: string; reference: string; style: string; units: number; date: string; reason: string }>;
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
  planningDisclosure: PlanningDisclosure | null;
  pipelineComparison: PipelineComparison | null;
  orderTracking: OrderTracking | null;
  blendedInputCogsPct?: number | null;
  reconciliations?: Array<{ status?: string; passed?: boolean; name?: string; metric?: string; label?: string; error?: string; message?: string; detail?: string }>;
  definitions?: Array<{ metric?: string; name?: string; formula?: string; source?: string }>;
  sourceStatus?: unknown;
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
function fullMonthLabel(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
function fullDateLabel(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
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
  disabled = false,
  onSave,
}: {
  value: string | number | null | undefined;
  displayValue?: string;
  ariaLabel: string;
  kind?: 'text' | 'number';
  placeholder?: string;
  disabled?: boolean;
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
  if (disabled) return <span className="range-inline-disabled">{rendered}</span>;
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
  const [activeTab, setActiveTab] = useState<'matrix' | 'quarter' | 'health'>('matrix');
  const [selectedSeasonId, setSelectedSeasonId] = useState<number | undefined>();
  const [tierFilter, setTierFilter] = useState('All tiers');
  const [snapshotEditorOpen, setSnapshotEditorOpen] = useState(false);
  const [snapshotDraft, setSnapshotDraft] = useState({ reportMonth: '', pulledAt: '', reportUrl: '' });
  const session = useQuery<{ user: { role?: string } | null }>({
    queryKey: ['workspace', 'session'],
    queryFn: async () => {
      const response = await fetch('/api/workspace/session', { credentials: 'include' });
      if (!response.ok) throw new Error('Session unavailable');
      return response.json();
    },
    staleTime: 60_000,
  });
  const rangePlan = useQuery({
    queryKey: ['workspace', 'range-plan', selectedSeasonId],
    queryFn: () => getRangePlan(selectedSeasonId),
    staleTime: 60_000,
  });
  const updateSeason = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: { revenueTargetKes?: number; cogsBudgetPct?: number; factoryCapacityUnits?: number; newnessTargetUnits?: number } }) => {
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
  const saveStockSalesReport = useMutation({
    mutationFn: async ({ seasonId, data }: { seasonId: number; data: { reportMonth: string; pulledAt: string; reportUrl: string } }) => {
      const response = await fetch(`/api/workspace/range-plan/seasons/${seasonId}/stock-sales-report`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(String(body.error || `Could not save report reference (${response.status})`));
      }
      return response.json() as Promise<StockSalesReport>;
    },
    onSuccess: () => {
      setSnapshotEditorOpen(false);
      queryClient.invalidateQueries({ queryKey: ['workspace', 'range-plan'] });
      queryClient.invalidateQueries({ queryKey: ['workspace', 'stock-sales-reports'] });
    },
  });

  const payload = rangePlan.data;
  const season = payload?.season;
  const rows = payload?.rows ?? [];
  const planningDisclosure = payload?.planningDisclosure ?? null;
  const pipelineComparison = payload?.pipelineComparison ?? null;
  const orderTracking = payload?.orderTracking ?? null;
  const isAdmin = session.data?.user?.role === 'Admin' || localStorage.getItem('workspace_user_role') === 'Admin';
  useEffect(() => {
    if (season?.cadence === 'monthly' && activeTab === 'quarter') setActiveTab('matrix');
  }, [activeTab, season?.cadence]);
  useEffect(() => {
    const report = season?.stockSalesReport;
    setSnapshotDraft({
      reportMonth: report?.reportMonth?.slice(0, 7) ?? '',
      pulledAt: report?.pulledAt?.slice(0, 10) ?? '',
      reportUrl: report?.reportUrl ?? '',
    });
    setSnapshotEditorOpen(false);
  }, [season?.id, season?.stockSalesReport?.id, season?.stockSalesReport?.reportMonth, season?.stockSalesReport?.pulledAt, season?.stockSalesReport?.reportUrl]);
  const isActualPlusPlan = planningDisclosure !== null;
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
     const costedRows = visibleRows.filter((row) => row.expectedUnitCost !== null);
     const estimatedCogs = costedRows.reduce((sum, row) => sum + row.totalUnitsImplied * Number(row.expectedUnitCost), 0);
    const potentialFpRevenue = visibleRows.reduce((sum, row) => sum + row.potentialFpRevenue, 0);
    const capacityPct = season?.factoryCapacityUnits ? (totalUnits / season.factoryCapacityUnits) * 100 : 0;
    const newnessPct = totalUnits > 0 ? newUnits / totalUnits * 100 : 0;
    const requiredNewUnits = season?.newnessTargetUnits ?? 0;
    const impliedNewStyles = effectiveNewAos > 0 ? Math.ceil(requiredNewUnits / effectiveNewAos) : 0;
    const newnessShortfallUnits = Math.max(0, requiredNewUnits - newUnits);
    const newnessShortfallStyles = effectiveNewAos > 0 ? Math.ceil(newnessShortfallUnits / effectiveNewAos) : 0;
    const targetPctOfCapacity = season?.factoryCapacityUnits ? requiredNewUnits / season.factoryCapacityUnits * 100 : 0;
     return { totalStyles, totalUnits, newStyles, newUnits, newnessPct, effectiveNewAos, requiredNewUnits, impliedNewStyles, newnessShortfallUnits, newnessShortfallStyles, targetPctOfCapacity, meetsNewnessTarget: newUnits >= requiredNewUnits, estimatedCogs, capacityPct, potentialFpRevenue, costedRowCount: costedRows.length };
  }, [visibleRows, rows, season]);

  const saveRow = (row: RangePlanRow, field: 'styleCountTarget' | 'newStyleCount' | 'reorderStyleCount' | 'replenishmentStyleCount' | 'newStyleAosUnits' | 'aosUnits' | 'openingStockUnits' | 'unitsSoldLastMonth' | 'expectedUnitCost' | 'sellingPrice' | 'notes', value: string) => {
    if (isActualPlusPlan) return;
    const optional = field === 'openingStockUnits' || field === 'unitsSoldLastMonth' || field === 'expectedUnitCost' || field === 'sellingPrice';
    const parsed = optional && value.trim() === '' ? null : Math.max(0, Number(value || 0));
    updateRow.mutate({ id: row.id, data: { [field]: field === 'notes' ? value : parsed } });
  };
  const saveSeason = (field: 'revenueTargetKes' | 'cogsBudgetPct' | 'factoryCapacityUnits' | 'newnessTargetUnits', value: string) => {
    if (!season) return;
    const numeric = Math.max(0, Number(value || 0));
    updateSeason.mutate({ id: season.id, data: { [field]: numeric } });
  };
  const exportCsv = () => {
    if (!season) return;
     const header = ['Product Category', 'Sub-Category', 'Opening Stock Units', 'Units Sold Last Month', 'Weeks of Cover', 'Planned Styles', 'New Styles Planned', 'Pipeline New Styles WK36-WK39', 'New Style Gap', 'Reorder Styles', 'Replenishment Styles', 'New Style AOS', 'Reorder / Replenishment AOS', 'New Units', 'Reorder Units', 'Replenishment Units', 'Total Units', 'Share of Units', 'Styles Ordered by Date', 'Styles Planned Not Raised', 'Style Balance to Ordered', 'Units Ordered by Date', 'Units Planned Not Raised', 'Unit Balance to Ordered', 'Projected Units', 'Ceiling Status', 'Expected Unit Cost', 'Average Selling Price', 'Gross Revenue Potential', 'Input COGS %'];
     const lines = visibleRows.map((row) => {
          const values = [row.productCategory, row.subCategory, row.openingStockUnits, row.unitsSoldLastMonth, row.weeksOfCover, row.styleCountTarget, row.newStyleCount, row.pipelineNewStylesAvailable, row.newStylesGap, row.reorderStyleCount, row.replenishmentStyleCount, row.newStyleAosUnits, row.aosUnits, row.newUnits, row.reorderUnits, row.replenishmentUnits, row.totalUnitsImplied, totals.totalUnits ? row.totalUnitsImplied / totals.totalUnits : 0, row.orderedStyles, row.plannedPendingStyles, row.balanceStyles, row.orderedUnits, row.plannedPendingUnits, row.balanceUnits, row.projectedUnits, row.ceilingBreached ? 'Ceiling breached' : 'Within ceiling', row.expectedUnitCost, row.sellingPrice, row.potentialFpRevenue, row.inputCogsPct];
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
   const reconciliationFailures = (payload.reconciliations ?? []).filter((item) => item.passed === false || ['fail', 'failed', 'error', 'blocked', 'untrusted'].includes(String(item.status).toLowerCase()));
   const biTrusted = reconciliationFailures.length === 0;
   const displayedCogsPct = payload.blendedInputCogsPct ?? planningDisclosure?.actualCogsPct ?? null;
  const cogsTone = displayedCogsPct !== null && displayedCogsPct <= season.cogsBudgetPct ? 'success' : 'danger';
  const budgetCeiling = season.revenueTargetKes * (season.cogsBudgetPct / 100);
  const quarterMonthlyUnits = payload.quarterMonthlyRollup.reduce((sum, month) => sum + month.plannedUnits, 0);
  const quarterMonthlyRevenue = payload.quarterMonthlyRollup.length === 3
    && payload.quarterMonthlyRollup.every((month) => month.hasMonthlyPlan && month.grossRevenuePotential !== null)
    ? payload.quarterMonthlyRollup.reduce((sum, month) => sum + Number(month.grossRevenuePotential), 0)
    : null;

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
              {season.cadence === 'monthly' && <label>Newness target <InlineCell value={season.newnessTargetUnits} displayValue={`${numberFormat(season.newnessTargetUnits)} units · ${totals.targetPctOfCapacity.toFixed(1)}% of capacity`} kind="number" ariaLabel="Newness target units" onSave={(value) => saveSeason('newnessTargetUnits', value)} /></label>}
          </div>
        </div>
      </div>
      {season.cadence === 'monthly' && (
        <aside className="range-snapshot-reference" aria-label="Stock to sales report reference">
          <div className="range-snapshot-icon"><FileSpreadsheet size={22} /></div>
          <div className="range-snapshot-copy">
            <span className="range-eyebrow">Planning evidence · point-in-time snapshot</span>
            <h2>Stock to sales report</h2>
            <p>This frozen report records the stock and sales position used when this plan was made. It is a reference, not a live view.</p>
          </div>
          {!snapshotEditorOpen && season.stockSalesReport && (
            <div className="range-snapshot-details">
              <strong>{fullMonthLabel(season.stockSalesReport.reportMonth)}</strong>
              <span><CalendarDays size={13} /> Pulled {fullDateLabel(season.stockSalesReport.pulledAt)}</span>
              <span>Informed {season.seasonName}</span>
            </div>
          )}
          {!snapshotEditorOpen && !season.stockSalesReport && (
            <div className="range-snapshot-empty"><strong>No snapshot attached</strong><span>Add the monthly report that informed this plan.</span></div>
          )}
          {!snapshotEditorOpen && (
            <div className="range-snapshot-actions">
              {season.stockSalesReport && <a className="button button-gold" href={season.stockSalesReport.reportUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open report</a>}
              {isAdmin && <button className="button button-quiet" type="button" onClick={() => setSnapshotEditorOpen(true)}><Pencil size={14} /> {season.stockSalesReport ? 'Edit reference' : 'Attach report'}</button>}
            </div>
          )}
          {snapshotEditorOpen && (
            <form className="range-snapshot-form" onSubmit={(event) => {
              event.preventDefault();
              saveStockSalesReport.mutate({ seasonId: season.id, data: snapshotDraft });
            }}>
              <label>Report month<input type="month" value={snapshotDraft.reportMonth} onChange={(event) => setSnapshotDraft((current) => ({ ...current, reportMonth: event.target.value }))} required /></label>
              <label>Date pulled<input type="date" value={snapshotDraft.pulledAt} onChange={(event) => setSnapshotDraft((current) => ({ ...current, pulledAt: event.target.value }))} required /></label>
              <label>Google Sheets link<input type="url" value={snapshotDraft.reportUrl} onChange={(event) => setSnapshotDraft((current) => ({ ...current, reportUrl: event.target.value }))} placeholder="https://docs.google.com/spreadsheets/…" required /></label>
              {saveStockSalesReport.isError && <p className="range-snapshot-error">{saveStockSalesReport.error instanceof Error ? saveStockSalesReport.error.message : 'Could not save the report reference.'}</p>}
              <div className="range-snapshot-form-actions"><button className="button button-quiet" type="button" onClick={() => setSnapshotEditorOpen(false)}>Cancel</button><button className="button button-dark" type="submit" disabled={saveStockSalesReport.isPending}>{saveStockSalesReport.isPending ? 'Saving…' : 'Save reference'}</button></div>
            </form>
          )}
        </aside>
      )}
      {!biTrusted && <div className="range-trust-blocked" role="alert" data-testid="status-range-plan-reconciliation-failure"><AlertTriangle size={19} /><div><strong>Not trusted — BI reconciliation failed</strong><span>{reconciliationFailures.map((item) => item.name ?? item.metric ?? item.label ?? item.error ?? item.message ?? 'Unspecified reconciliation').join(' · ')}</span></div></div>}
      <aside className="range-trust-panel" data-testid="panel-range-definitions">
        <div><span className="range-eyebrow">Definitions &amp; reconciliation</span><strong>{biTrusted ? 'BI-owned metrics verified' : 'BI-owned metrics blocked'}</strong><small>{biTrusted ? 'Shared metric definitions and formulae are governed by BI. Style Development remains the product-development exception.' : 'Do not use BI-owned headline figures until the failed reconciliation is resolved.'}</small></div>
        <div className="range-trust-definitions">{(payload.definitions ?? []).slice(0, 3).map((definition, index) => <span key={`${definition.metric ?? definition.name ?? 'definition'}-${index}`}><b>{definition.metric ?? definition.name ?? 'Shared metric'}</b>{definition.formula ? ` · ${definition.formula}` : ''}</span>)}</div>
      </aside>

      {planningDisclosure && (
        <div className="range-plan-disclosure" role="note">
          <div>
            <span className="range-eyebrow">Actual + plan reconciliation</span>
            <h2>{planningDisclosure.headline}</h2>
            <p>{planningDisclosure.note}</p>
          </div>
          <dl>
            <div><dt>{planningDisclosure.actualLabel}</dt><dd>{numberFormat(planningDisclosure.actualOrders)} styles · {numberFormat(planningDisclosure.actualUnits)} units</dd></div>
            <div><dt>{planningDisclosure.planLabel}</dt><dd>{numberFormat(totals.newStyles + rows.reduce((sum, row) => sum + row.reorderStyleCount + row.replenishmentStyleCount, 0))} styles · {numberFormat(planningDisclosure.planUnits)} units</dd></div>
            <div><dt>Quarter total</dt><dd>{numberFormat(totals.totalStyles)} styles · {numberFormat(totals.totalUnits)} units</dd></div>
            <div><dt>Tracker boundary</dt><dd>June-booked: {planningDisclosure.juneBookedOrders} / {numberFormat(planningDisclosure.juneBookedUnits)} units · September placed: {planningDisclosure.septemberPlacedOrders} / {numberFormat(planningDisclosure.septemberPlacedUnits)} units</dd></div>
          </dl>
        </div>
      )}

      <div className="range-plan-tabs" role="tablist" aria-label="Range Plan sections">
        {([
          ['matrix', 'Mix Matrix'],
          ...(season.cadence === 'quarterly' ? [['quarter', 'Quarter Roll-up'] as const] : []),
          ['health', 'Health Indicators'],
        ] as const).map(([tab, label]) => (
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
          {orderTracking && (
            <>
              <div className="range-order-stat-grid" aria-label="Monthly order tracking">
                <StatTile label={`${orderTracking.periodLabel} plan`} value={`${numberFormat(orderTracking.plannedStyles)} styles`} detail={`${numberFormat(orderTracking.plannedUnits)} planned units`} icon={<Target size={16} />} />
                <StatTile label="Ordered by date" value={`${numberFormat(orderTracking.orderedStyles)} styles`} detail={`${numberFormat(orderTracking.orderedUnits)} units from orders dated inside this ${orderTracking.periodLabel.toLowerCase()}`} tone="success" icon={<Save size={16} />} />
                <StatTile label="Planned, not raised" value={`${numberFormat(orderTracking.plannedPendingStyles)} styles`} detail={`${numberFormat(orderTracking.plannedPendingUnits)} estimated units in overlapping weekly targets`} tone="warning" icon={<RefreshCw size={16} />} />
                <StatTile label={`Projected ${orderTracking.periodLabel.toLowerCase()}`} value={numberFormat(orderTracking.projectedUnits)} detail="Dated orders + unraised weekly intent + remaining plan" tone={orderTracking.ceilingBreached ? 'danger' : 'default'} icon={<TrendingUp size={16} />} />
                <StatTile label="Projected capacity" value={`${orderTracking.projectedCapacityPct.toFixed(1)}%`} detail={`${numberFormat(orderTracking.balanceStyles)} styles · ${numberFormat(orderTracking.balanceUnits)} units left to order`} tone={orderTracking.ceilingBreached ? 'danger' : orderTracking.significantlyUnderOrdered ? 'warning' : 'success'} icon={orderTracking.significantlyUnderOrdered ? <TrendingDown size={16} /> : <Target size={16} />} />
              </div>
              {orderTracking.unmatchedStyles > 0 && (
                <div className="range-order-exceptions" role="alert">
                  <div className="range-order-exceptions-heading">
                    <AlertTriangle size={18} />
                    <div><strong>{numberFormat(orderTracking.unmatchedStyles)} ordered styles need classification</strong><span>{numberFormat(orderTracking.unmatchedUnits)} dated units are included in headline actuals but cannot be allocated to a category row until their product-master sub-category is matched.</span></div>
                  </div>
                  <div className="range-order-exception-list">
                    {orderTracking.unmatched.slice(0, 20).map((item, index) => (
                      <div key={`${item.source}-${item.reference}-${item.style}-${index}`}>
                        <span>{item.source} · {item.reference || 'No reference'}</span>
                        <strong>{item.style}</strong>
                        <span>{numberFormat(item.units)} units · {item.reason}</span>
                      </div>
                    ))}
                  </div>
                  {orderTracking.unmatched.length > 20 && <small>Showing 20 of {numberFormat(orderTracking.unmatched.length)} exceptions. Export CSV after classification to confirm the corrected totals.</small>}
                </div>
              )}
            </>
          )}
          <div className={`range-stat-grid ${pipelineComparison ? 'range-stat-grid-eight' : 'range-stat-grid-seven'}`}>
            <StatTile label={isActualPlusPlan ? 'Quarter styles' : 'Total styles planned'} value={numberFormat(totals.totalStyles)} detail={isActualPlusPlan ? 'July–August actuals + September plan' : 'Across all product categories'} icon={<Target size={16} />} />
            <StatTile label={isActualPlusPlan ? 'Quarter units' : 'Total units implied'} value={numberFormat(totals.totalUnits)} detail={`${totals.capacityPct.toFixed(0)}% of ${numberFormat(season.factoryCapacityUnits)} factory capacity`} tone={capacityTone} icon={totals.capacityPct > 100 ? <TrendingUp size={16} /> : <TrendingDown size={16} />} />
            <StatTile label="Estimated COGS" value={kesMillions(totals.estimatedCogs)} detail={`${totals.costedRowCount} costed rows`} icon={<TrendingDown size={16} />} />
            <StatTile label="Gross revenue potential" value={kesMillions(totals.potentialFpRevenue)} detail="Total units × selling price" tone="success" icon={<TrendingUp size={16} />} />
             <StatTile label="COGS vs budget" value={biTrusted && displayedCogsPct !== null ? `${displayedCogsPct.toFixed(1)}%` : 'Not trusted'} detail={biTrusted ? `Server-provided blended input COGS · ${season.cogsBudgetPct}% ceiling` : 'Reconciliation failed — resolve the data trust error'} tone={biTrusted ? cogsTone : 'danger'} icon={<Save size={16} />} />
             <StatTile label={isActualPlusPlan ? 'September new units' : 'New-unit commitment'} value={season.cadence === 'monthly' ? `${numberFormat(totals.newUnits)} / ${numberFormat(totals.requiredNewUnits)}` : numberFormat(totals.newUnits)} detail={season.cadence === 'monthly' ? `${numberFormat(totals.newStyles)} planned styles · ${numberFormat(totals.impliedNewStyles)} implied at ${numberFormat(totals.effectiveNewAos)} units each` : `${numberFormat(totals.newStyles)} Tier 4 styles × ${numberFormat(totals.effectiveNewAos)} average units`} tone={season.cadence === 'monthly' ? (totals.meetsNewnessTarget ? 'success' : 'danger') : 'default'} icon={<Target size={16} />} />
             <StatTile label={isActualPlusPlan ? 'September newness in Q3' : 'Newness outcome'} value={totals.totalUnits ? `${totals.newnessPct.toFixed(1)}%` : '—'} detail={season.cadence === 'monthly' ? `${numberFormat(totals.newUnits)} of ${numberFormat(totals.totalUnits)} planned units · target equals ${totals.targetPctOfCapacity.toFixed(1)}% of capacity` : 'New units as a share of planned volume'} tone={season.cadence === 'monthly' ? (totals.meetsNewnessTarget ? 'success' : 'danger') : 'default'} icon={<Target size={16} />} />
             {pipelineComparison && <StatTile label="Pipeline shortfall" value={`${numberFormat(pipelineComparison.shortfall)} styles`} detail={`${numberFormat(pipelineComparison.availableNewStyles)} available · ${numberFormat(pipelineComparison.surplus)} surplus elsewhere`} tone={pipelineComparison.shortfall ? 'danger' : 'success'} icon={<Target size={16} />} />}
          </div>
           {season.cadence === 'monthly' && !totals.meetsNewnessTarget && (
             <div className="range-order-exceptions" role="alert">
               <div className="range-order-exceptions-heading"><AlertTriangle size={18} /><div><strong>Newness commitment is short by {numberFormat(totals.newnessShortfallUnits)} units</strong><span>Add {numberFormat(totals.newnessShortfallStyles)} new style{totals.newnessShortfallStyles === 1 ? '' : 's'} at the current {numberFormat(totals.effectiveNewAos)}-unit order size to reach {numberFormat(totals.requiredNewUnits)} units.</span></div></div>
             </div>
           )}
           {season.cadence === 'monthly' && totals.capacityPct > 100 && (
             <div className="range-order-exceptions" role="status">
               <div className="range-order-exceptions-heading"><AlertTriangle size={18} /><div><strong>Plan is {numberFormat(totals.totalUnits - season.factoryCapacityUnits)} units over capacity</strong><span>The {numberFormat(totals.requiredNewUnits)}-unit newness commitment is being held steady. The resulting {numberFormat(totals.totalUnits)}-unit plan is shown against {numberFormat(season.factoryCapacityUnits)} units of capacity for the team to resolve.</span></div></div>
             </div>
           )}
          <div className="range-section-toolbar">
            <div><span className="range-eyebrow">Mix matrix</span><h2>{isActualPlusPlan ? 'Actuals plus plan by product category' : 'Plan by product category'}</h2><p>{pipelineComparison ? `Plan need is independent of the live ${pipelineComparison.targetOrderWeeks} NEW pipeline. Positive gaps need styles found or pulled forward; surpluses can be redirected.` : isActualPlusPlan ? 'July–August is locked actual history. Edit September from the September 2026 monthly plan.' : 'Click a gold value to edit. Changes save when you leave the cell.'}</p></div>
            <button type="button" className="button button-outline" onClick={exportCsv}><Download size={15} /> Export CSV</button>
          </div>
          <div className="range-matrix-card">
            <div className="range-table-scroll">
              <table className="range-table range-monthly-table">
                 <thead><tr><th>Sub-Category</th><th>Opening Stock</th><th>WOC</th><th>Planned Styles</th><th>New Styles <small>Plan need</small></th><th>Pipeline NEW <small>WK36–WK39</small></th><th>Pipeline Gap</th><th>Reorder Styles</th><th>Replen Styles</th><th>New AOS</th><th>Reorder / Replen AOS</th><th>Total Units</th><th>New Units</th><th>Reorder Units</th><th>Replen Units</th><th>Share</th><th>Styles Ordered <small>dated</small></th><th>Styles Planned <small>not raised</small></th><th>Style Balance <small>to ordered</small></th><th>Units Ordered <small>dated</small></th><th>Units Planned <small>not raised</small></th><th>Unit Balance <small>to ordered</small></th><th>Projected Units</th><th>Order Status</th><th>Unit Cost</th><th>Selling Price</th><th>Gross Revenue</th><th>Input COGS</th></tr></thead>
                <tbody>
                  {monthlyCategoryOrder.map((category) => {
                    const categoryRows = visibleRows.filter((row) => row.productCategory === category);
                    if (!categoryRows.length) return null;
                    const categoryStyles = categoryRows.reduce((sum, row) => sum + row.styleCountTarget, 0);
                    const categoryUnits = categoryRows.reduce((sum, row) => sum + row.totalUnitsImplied, 0);
                    const categoryPipelineAvailable = categoryRows.reduce((sum, row) => sum + row.pipelineNewStylesAvailable, 0);
                    const categoryPipelineGap = categoryRows.reduce((sum, row) => sum + row.newStylesGap, 0);
                    return (
                      <Fragment key={category}>
                        <tr className="range-tier-heading range-category-heading"><td colSpan={28}><strong>{category}</strong><span>{categoryRows.length} sub-categories</span></td></tr>
                        {categoryRows.map((row) => {
                           const weeksOfCover = row.weeksOfCover;
                          const shareOfUnits = totals.totalUnits ? row.totalUnitsImplied / totals.totalUnits * 100 : 0;
                           const inputCogs = row.inputCogsPct;
                           const pacingFloor = row.totalUnitsImplied * Math.max(0, (orderTracking?.elapsedPct ?? 0) / 100 - 0.15);
                            const significantlyUnderOrdered = row.orderedUnits < pacingFloor;
                           const orderStatus = row.ceilingBreached ? 'CEILING BREACH' : significantlyUnderOrdered ? 'UNDER ORDER' : 'On track';
                          return (
                             <tr key={row.id} className={`${inputCogs !== null && inputCogs > season.cogsBudgetPct ? 'range-cogs-over ' : ''}${row.ceilingBreached ? 'range-ceiling-breach ' : ''}${significantlyUnderOrdered ? 'range-under-order ' : ''}${row.newStylesGap > 0 ? 'range-pipeline-shortfall' : ''}`}>
                              <td><strong>{row.subCategory}</strong></td>
                              <td><InlineCell disabled={isActualPlusPlan} value={row.openingStockUnits} displayValue={row.openingStockUnits === null ? '—' : numberFormat(row.openingStockUnits)} kind="number" ariaLabel={`${row.subCategory} opening stock units`} onSave={(value) => saveRow(row, 'openingStockUnits', value)} /></td>
                              <td className="range-readonly">{weeksOfCover === null ? '—' : `${weeksOfCover.toFixed(1)} wks`}</td>
                              <td className="range-total-cell">{numberFormat(row.styleCountTarget)}</td>
                              <td><InlineCell disabled={isActualPlusPlan} value={row.newStyleCount} kind="number" ariaLabel={`${row.subCategory} new styles`} onSave={(value) => saveRow(row, 'newStyleCount', value)} /></td>
                               <td className="range-pipeline-available">{numberFormat(row.pipelineNewStylesAvailable)}</td>
                               <td className={row.newStylesGap > 0 ? 'range-pipeline-gap shortfall' : row.newStylesGap < 0 ? 'range-pipeline-gap surplus' : 'range-readonly'}>{row.newStylesGap > 0 ? `${numberFormat(row.newStylesGap)} short` : row.newStylesGap < 0 ? `${numberFormat(Math.abs(row.newStylesGap))} surplus` : '—'}</td>
                              <td><InlineCell disabled={isActualPlusPlan} value={row.reorderStyleCount} kind="number" ariaLabel={`${row.subCategory} reorder styles`} onSave={(value) => saveRow(row, 'reorderStyleCount', value)} /></td>
                              <td><InlineCell disabled={isActualPlusPlan} value={row.replenishmentStyleCount} kind="number" ariaLabel={`${row.subCategory} replenishment styles`} onSave={(value) => saveRow(row, 'replenishmentStyleCount', value)} /></td>
                              <td><InlineCell disabled={isActualPlusPlan} value={row.newStyleAosUnits} kind="number" ariaLabel={`${row.subCategory} new style average order size`} onSave={(value) => saveRow(row, 'newStyleAosUnits', value)} /></td>
                              <td><InlineCell disabled={isActualPlusPlan} value={row.aosUnits} kind="number" ariaLabel={`${row.subCategory} reorder and replenishment average order size`} onSave={(value) => saveRow(row, 'aosUnits', value)} /></td>
                              <td className="range-total-cell">{numberFormat(row.totalUnitsImplied)}</td>
                              <td className="range-readonly">{numberFormat(row.newUnits)}</td>
                              <td className="range-readonly">{numberFormat(row.reorderUnits)}</td>
                              <td className="range-readonly">{numberFormat(row.replenishmentUnits)}</td>
                              <td className="range-readonly">{shareOfUnits.toFixed(1)}%</td>
                               <td className="range-progress-cell">{numberFormat(row.orderedStyles)}</td>
                                <td className="range-commitment-cell">{numberFormat(row.plannedPendingStyles)}</td>
                               <td className="range-readonly">{numberFormat(row.balanceStyles)}</td>
                               <td className="range-progress-cell">{numberFormat(row.orderedUnits)}</td>
                                <td className="range-commitment-cell">{numberFormat(row.plannedPendingUnits)}</td>
                               <td className={row.balanceUnits < 0 ? 'range-negative-variance' : 'range-readonly'}>{numberFormat(row.balanceUnits)}</td>
                               <td className="range-total-cell">{numberFormat(row.projectedUnits)}</td>
                               <td className={row.ceilingBreached ? 'range-breach-alert' : significantlyUnderOrdered ? 'range-under-alert' : 'range-status-ok'}>{orderStatus}</td>
                              <td><InlineCell disabled={isActualPlusPlan} value={row.expectedUnitCost} displayValue={kes(row.expectedUnitCost)} kind="number" ariaLabel={`${row.subCategory} expected unit cost`} onSave={(value) => saveRow(row, 'expectedUnitCost', value)} /></td>
                              <td><InlineCell disabled={isActualPlusPlan} value={row.sellingPrice} displayValue={kes(row.sellingPrice)} kind="number" ariaLabel={`${row.subCategory} average selling price`} onSave={(value) => saveRow(row, 'sellingPrice', value)} /></td>
                              <td className="range-total-cell">{row.sellingPrice === null ? '—' : kes(row.potentialFpRevenue)}</td>
                              <td className={inputCogs !== null && inputCogs > season.cogsBudgetPct ? 'range-cogs-alert' : 'range-readonly'}>{inputCogs === null ? '—' : `${inputCogs.toFixed(1)}%`}</td>
                            </tr>
                          );
                        })}
                        <tr className="range-subtotal"><td>Subtotal · {category}</td><td colSpan={2} /><td>{numberFormat(categoryStyles)}</td><td /><td>{numberFormat(categoryPipelineAvailable)}</td><td className={categoryPipelineGap > 0 ? 'range-pipeline-gap shortfall' : categoryPipelineGap < 0 ? 'range-pipeline-gap surplus' : ''}>{categoryPipelineGap > 0 ? `${numberFormat(categoryPipelineGap)} short` : categoryPipelineGap < 0 ? `${numberFormat(Math.abs(categoryPipelineGap))} surplus` : '—'}</td><td colSpan={4} /><td>{numberFormat(categoryUnits)}</td><td colSpan={3} /><td>{totals.totalUnits ? `${(categoryUnits / totals.totalUnits * 100).toFixed(1)}%` : '—'}</td><td colSpan={12} /></tr>
                      </Fragment>
                    );
                  })}
                  <tr className="range-grand-total"><td>Grand total</td><td colSpan={2} /><td>{numberFormat(totals.totalStyles)}</td><td>{numberFormat(totals.newStyles)}</td><td>{numberFormat(pipelineComparison?.availableNewStyles ?? 0)}</td><td className={pipelineComparison?.shortfall ? 'range-pipeline-gap shortfall' : ''}>{pipelineComparison ? `${numberFormat(pipelineComparison.shortfall)} short` : '—'}</td><td colSpan={4} /><td>{numberFormat(totals.totalUnits)}</td><td>{numberFormat(totals.newUnits)}</td><td colSpan={2} /><td>{totals.totalUnits ? '100.0%' : '—'}</td><td>{numberFormat(orderTracking?.orderedStyles)}</td><td>{numberFormat(orderTracking?.plannedPendingStyles)}</td><td>{numberFormat(orderTracking?.balanceStyles)}</td><td>{numberFormat(orderTracking?.orderedUnits)}</td><td>{numberFormat(orderTracking?.plannedPendingUnits)}</td><td>{numberFormat(orderTracking?.balanceUnits)}</td><td>{numberFormat(orderTracking?.projectedUnits)}</td><td>{orderTracking?.ceilingBreached ? 'CEILING BREACH' : orderTracking?.significantlyUnderOrdered ? 'UNDER ORDER' : orderTracking ? 'On track' : '—'}</td><td colSpan={2} /><td>{kes(totals.potentialFpRevenue)}</td><td>{biTrusted && displayedCogsPct !== null ? `${displayedCogsPct.toFixed(1)}%` : 'Not trusted'}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {activeTab === 'quarter' && season.cadence === 'quarterly' && (
        <>
          <div className="range-section-toolbar">
            <div><span className="range-eyebrow">Quarter planning roll-up</span><h2>Monthly production and revenue plans, side by side</h2><p>Each month comes from its own mix matrix. The combined figures are compared with the quarter’s production plan and revenue target.</p></div>
          </div>
          <div className="range-otb-card">
            <div className="range-table-scroll">
              <table className="range-table range-otb-table range-otb-recon-table">
                <thead><tr><th>Measure</th>{payload.quarterMonthlyRollup.map((month) => <th key={month.monthYear}>{monthLabel(month.monthYear)}</th>)}<th>Combined</th><th>{season.seasonName} plan</th><th>Variance</th></tr></thead>
                <tbody>
                  <tr>
                    <th>Planned production units <small>from each monthly mix matrix</small></th>
                    {payload.quarterMonthlyRollup.map((month) => <td key={month.monthYear}>{month.hasMonthlyPlan ? numberFormat(month.plannedUnits) : <span className="range-unset-label">No monthly plan</span>}</td>)}
                    <td><strong>{numberFormat(quarterMonthlyUnits)}</strong></td>
                    <td>{numberFormat(totals.totalUnits)}</td>
                    <td className={quarterMonthlyUnits - totals.totalUnits < 0 ? 'range-negative-variance' : ''}>{numberFormat(quarterMonthlyUnits - totals.totalUnits)}</td>
                  </tr>
                  <tr>
                    <th>Gross revenue potential <small>from each monthly matrix’s selling-price inputs</small></th>
                    {payload.quarterMonthlyRollup.map((month) => <td key={month.monthYear}>{month.hasMonthlyPlan ? kes(month.grossRevenuePotential) : <span className="range-unset-label">No monthly plan</span>}</td>)}
                    <td><strong>{quarterMonthlyRevenue === null ? 'Incomplete' : kes(quarterMonthlyRevenue)}</strong></td>
                    <td>{kes(season.revenueTargetKes)}</td>
                    <td className={quarterMonthlyRevenue !== null && quarterMonthlyRevenue - season.revenueTargetKes < 0 ? 'range-negative-variance' : ''}>{quarterMonthlyRevenue === null ? '—' : kes(quarterMonthlyRevenue - season.revenueTargetKes)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="range-quarter-flow-note" role="note">
            <strong>Production and revenue move through different time periods.</strong>
            <p>Monthly production intake becomes stock that may sell in later months. Revenue targets describe sales ambition, not revenue earned directly by the units produced in the same month. This roll-up does not calculate an implied ASP or assume same-period intake-to-sales conversion.</p>
          </div>
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