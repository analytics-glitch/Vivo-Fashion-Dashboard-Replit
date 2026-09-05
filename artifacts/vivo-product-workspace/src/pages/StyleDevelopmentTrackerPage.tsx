import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, List, CheckSquare, Clock, AlertTriangle, Ban, Image as ImageIcon, Search, X, CheckCircle, BarChart2, Users, ArrowLeft, SlidersHorizontal } from 'lucide-react';
import { groupStyleDevelopmentItems, type StyleDevelopmentGroupBy } from '../lib/styleDevelopmentBoard';

type TrackerStyle = {
  id: number;
  styleNumber: string | null;
  originalStyleNumber: string | null;
  styleNumberStatus: 'needs_number' | 'malformed' | 'confirmed';
  styleName: string;
  type: 'NEW' | 'RR';
  tier: 'Tier 3' | 'Tier 4';
  sourceStatus: string;
  status: string;
  category: string;
  subCategory: string;
  originalSubCategory: string;
  brand: string;
  fabric: string;
  designer: string | null;
  designerUserId: number | null;
  collection: string;
  theme: string;
  knitOrWoven: 'Knit' | 'Woven' | null;
  printOrSolid: 'Print' | 'Solid' | null;
  patternMaker: string | null;
  patternAssignmentKey: string;
  patternMakerUserId: number | null;
  patternRouteId: number | null;
  patternRouteKind: 'team' | 'supplier' | null;
  isLegacyCadPatternAssignment: boolean;
  adoptionDate: string | null;
  targetOrderWeek: string | null;
  targetLaunchWeek: string | null;
  launchMonth: string | null;
  sampleApprovalDate: string | null;
  sampleApprovalDateUnreadable: string | null;
  dataQualityFlags: string[];
  blocked: boolean;
  blockerReason: string | null;
  stage: string | null;
  stageStartedAt: string | null;
  workingDaysAtStage: number;
  statusStartedAt: string | null;
  workingDaysInStatus: number;
  standardDays: number | null;
  overStandard: boolean;
  sampleRounds: number;
  setSampleRounds: number;
  sampleRejections: number;
  setSampleRejections: number;
  rejectedMoreThanOnce: boolean;
  waitingDecision: 'sample' | 'set_sample' | 'order' | null;
  historyCount: number;
  reassignmentCount: number;
  styleRelatedReassignmentCount: number;
  passedAround: boolean;
  reassignmentReasonCode?: string;
  reassignmentNote?: string;
  imageUrl: string | null;

  sampleFabricProductId?: number | null;
  sampleFabricName?: string | null;
  sampleFabricColour?: string | null;
  sampleFabricMetres?: number | null;
  sampleFabricOtherColours?: { productId: number; colour: string; metres: number }[];
  season?: string | null;
  intendedSellingPriceKes?: number | null;
  indicativeCogsKes?: number | null;
  indicativeCogsPct?: number | null;
  patternEffortDays?: number | null;
  fabricConsumptionOverrideMetresPerUnit?: number | null;
  categoryMetresPerGarment?: number | null;
  adoptionReadiness?: { ready: boolean; missing: string[]; warnings: string[] };
  actionGatesEnabled?: boolean;
  exitStatus?: string | null;
  exitReason?: string | null;
  exitStage?: string | null;
  actualElapsedWorkingDays?: number;
  standardEndToEndDays?: number;
  targetWeeksLabel?: string;
  intervalMetrics?: any[];
};

type HistoryEntry = {
  id: number;
  entryType: 'event' | 'note' | 'update' | 'pattern_maker_changed';
  eventType: string | null;
  outcome: string | null;
  note: string | null;
  reason: string | null;
  oldValue: string | null;
  newValue: string | null;
  occurredAt: string;
  recordedAt: string;
  recordedBy: string;
  reassignmentBatchId?: string | null;
  reassignmentReasonCode?: string | null;
  reassignmentReasonLabel?: string | null;
  reassignmentReasonCategory?: 'operational' | 'style' | null;
};

type TrackerDetailPayload = TrackerStyle & { history: HistoryEntry[] };

type CardFieldKey = 'targetOrderWeek' | 'stageDays' | 'patternMaker' | 'designer' | 'collection' | 'knitOrWoven' | 'printOrSolid' | 'type' | 'tier' | 'status';
type CardFieldVisibility = Record<CardFieldKey, boolean>;
type GroupByKey = StyleDevelopmentGroupBy;
type AssignmentOption = {
  assignmentKey: string;
  name: string;
  kind: 'person' | 'team' | 'supplier' | 'unassigned';
};

const DEFAULT_CARD_FIELDS: CardFieldVisibility = {
  targetOrderWeek: true,
  stageDays: true,
  patternMaker: true,
  designer: true,
  collection: true,
  knitOrWoven: false,
  printOrSolid: false,
  type: true,
  tier: true,
  status: true,
};

const CARD_FIELD_OPTIONS: { key: CardFieldKey; label: string }[] = [
  { key: 'targetOrderWeek', label: 'Target order week' },
  { key: 'stageDays', label: 'Days at current stage' },
  { key: 'patternMaker', label: 'Pattern maker' },
  { key: 'designer', label: 'Designer' },
  { key: 'collection', label: 'Collection' },
  { key: 'knitOrWoven', label: 'Knit or woven' },
  { key: 'printOrSolid', label: 'Print or solid' },
  { key: 'type', label: 'Type' },
  { key: 'tier', label: 'Tier' },
  { key: 'status', label: 'Status' },
];

type PatternMakerOption = {
  id: number;
  name: string;
  kind: 'person' | 'team' | 'supplier';
  assignmentKey: string;
  workspaceUserId: number | null;
  role?: string | null;
  team?: string | null;
  effectiveCapacity: number | null;
  assignable: boolean;
  isLegacyCad: boolean;
  active: boolean;
  displayOrder: number;
  load: number;
  patternStageCount: number;
};

type DesignerOption = {
  id: number;
  name: string;
  role: string;
  team: string;
  assignable: boolean;
  unavailableNow: boolean;
};

type ReassignmentReason = {
  id: number;
  code: string;
  label: string;
  category: 'operational' | 'style';
  active: boolean;
  displayOrder: number;
};

type TrackerPayload = {
  items: TrackerStyle[];
  stages: string[];
  statuses: string[];
  stageStandards: Record<string, number>;
  patternMakers: PatternMakerOption[];
  designers: DesignerOption[];
  reassignmentReasons: ReassignmentReason[];
  facets: {
    targetOrderWeek: string[];
    subCategory: string[];
    category: string[];
    brand: string[];
    type: string[];
    tier: string[];
    patternMaker: string[];
    designer: string[];
    collection: string[];
    theme: string[];
    knitOrWoven: string[];
    printOrSolid: string[];
    launchMonth: string[];
    status: string[];
  };
};

type FabricOptionsResponse = {
  groups: {
    fabricBaseName: string;
    metres: number;
    variants: {
      productId: number;
      productName: string;
      colour: string;
      metres: number;
      costPerMetre: number;
    }[];
  }[];
};

type CapacityStyle = {
  id: number;
  styleName: string;
  styleNumber: string | null;
  stage: string;
  sourceStatus?: string;
  category: string;
  workingDaysWaiting: number;
  effortDays: number;
};

type CapacityAssignment = {
  assignmentKey: string;
  patternMaker: string;
  kind: 'person' | 'team' | 'supplier' | 'unassigned';
  isLegacyCad: boolean;
  assignable: boolean;
  effectiveCapacity: number | null;
  unavailableNow: boolean;
  totalStylesHeld: number;
  queueStyleCount: number;
  patternAwaitingCount: number;
  transferToCadCount: number;
  queueEffortDays: number;
  queueWeeks: number | null;
  oldestWaitingWorkingDays: number;
  oldestStyleName: string | null;
  categoryMix: { category: string; count: number; effortDays: number }[];
  styles: CapacityStyle[];
  queueStyles: CapacityStyle[];
};

type ReportingPayload = {
  intervals: {
    key: string;
    standard: number;
    count: number;
    workMedian: number | null;
    workP80: number | null;
    queueMedian: number | null;
    queueP80: number | null;
    totalMedian: number | null;
    totalP80: number | null;
    totalDaysConsumed: number;
  }[];
  whereTimeGoing: {
    key: string;
    totalDaysConsumed: number;
  }[];
  assumptionsWrong: {
    key: string;
    difference: number | null;
    workMedian: number | null;
  }[];
  cancellationsByReason: Record<string, number>;
  cancellationsByStage: Record<string, number>;
  capacity: {
    baseMakers: number;
    makers: number;
    daysPerPattern: number;
    weeklyCapacity: number;
    monthlyCapacity: number;
    queueDepth: number;
    readyToStart: number;
    activePatternWork: number;
    weeksCover: number | null;
    patternsPerMaker: number | null;
    adoptedPerWeek: number;
    targetAdoptionsPerWeek: number;
    monthlyGap: number;
    byPatternMaker: (CapacityAssignment & {
      isTeamLead: boolean;
      nextUnavailable: { id: number; unavailableFrom: string; unavailableTo: string | null; note: string } | null;
      balanceStatus: 'overloaded' | 'balanced' | 'light';
    })[];
    routedWork: CapacityAssignment[];
    legacyCad: CapacityAssignment | null;
    nonCapacityPeople: CapacityAssignment[];
    supplierWork: CapacityAssignment[];
    unassignedWork: CapacityAssignment | null;
    balance: {
      averageQueueWeeks: number;
      spreadWeeks: number;
      overloadedCount: number;
    };
    rebalanceSuggestions: {
      styleId: number;
      styleName: string;
      styleNumber: string | null;
      category: string;
      stage: string;
      effortDays: number;
      fromPatternMaker: string;
      toPatternMaker: string;
      fromAssignmentKey: string;
      toAssignmentKey: string;
      fromWeeksBefore: number;
      fromWeeksAfter: number;
      toWeeksBefore: number;
      toWeeksAfter: number;
    }[];
    availabilitySchedule: {
      id: number;
      patternMakerId: number;
      patternMaker: string;
      unavailableFrom: string;
      unavailableTo: string | null;
      note: string;
      recordedBy: string;
      makersDuring: number;
      weeklyCapacityDuring: number;
    }[];
    redistributions: {
      id: string;
      reasonCode: string;
      reasonLabel: string;
      note: string;
      changedCount: number;
      beforeLoads: Record<string, number>;
      afterLoads: Record<string, number>;
      beforePatternLoads: Record<string, number>;
      afterPatternLoads: Record<string, number>;
      recordedAt: string;
      recordedBy: string;
    }[];
  };
};

async function loadTracker(): Promise<TrackerPayload> {
  const response = await fetch('/api/workspace/style-development-tracker', { credentials: 'include' });
  if (!response.ok) throw new Error(`Could not load the Product Development Tracker (${response.status})`);
  return response.json();
}

function targetWeekNumber(value: string | null): number | null {
  const match = value?.match(/(?:^|-)W(?:K)?\s*(\d+)$/i);
  return match ? Number(match[1]) : null;
}

export default function StyleDevelopmentTrackerPage() {
  const queryClient = useQueryClient();
  const tracker = useQuery({ queryKey: ['workspace', 'style-development-tracker'], queryFn: loadTracker });
  const requestedView = new URLSearchParams(window.location.search).get('view');
  const initialView = ['board', 'list', 'approvals', 'standards', 'capacity'].includes(requestedView || '')
    ? requestedView as 'board' | 'list' | 'approvals' | 'standards' | 'capacity'
    : 'board';
  const focusedPatternMaker = new URLSearchParams(window.location.search).get('patternMaker') || '';
  const [view, setView] = useState<'board' | 'list' | 'approvals' | 'standards' | 'capacity'>(initialView);
  const [search, setSearch] = useState('');
  const [cardFields, setCardFields] = useState<CardFieldVisibility>(() => {
    try {
      const stored = window.localStorage.getItem('vivo-style-development-card-fields');
      return stored ? { ...DEFAULT_CARD_FIELDS, ...JSON.parse(stored) } : DEFAULT_CARD_FIELDS;
    } catch {
      return DEFAULT_CARD_FIELDS;
    }
  });
  const [customizeCardsOpen, setCustomizeCardsOpen] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem('vivo-style-development-card-fields', JSON.stringify(cardFields));
    } catch {
      // Preferences are optional; the board remains usable when storage is unavailable.
    }
  }, [cardFields]);

  const [filters, setFilters] = useState({
    stage: 'All',
    targetOrderWeek: 'All',
    category: 'All',
    subCategory: 'All',
    brand: 'All',
    type: 'All',
    tier: 'All',
    patternMaker: 'All',
    designer: 'All',
    collection: 'All',
    theme: 'All',
    knitOrWoven: 'All',
    printOrSolid: 'All',
    status: 'All',
    blocked: 'All',
  });

  const [groupBy, setGroupBy] = useState<GroupByKey>('stage');
  const [sortField, setSortField] = useState<keyof TrackerStyle>('targetOrderWeek');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const [detailId, setDetailId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkPatternMaker, setBulkPatternMaker] = useState('');
  const [pendingReassignment, setPendingReassignment] = useState<{ styleIds: number[]; assignmentKey: string; displayName: string } | null>(null);

  const items = tracker.data?.items ?? [];
  const stages = tracker.data?.stages ?? [];
  const statuses = tracker.data?.statuses ?? [];
  const patternMakers = tracker.data?.patternMakers ?? [];
  const designers = tracker.data?.designers ?? [];
  const reassignmentReasons = tracker.data?.reassignmentReasons ?? [];
  const assignmentLoads = useMemo(() => {
    const loads = new Map<string, number>([['', 0]]);
    for (const option of patternMakers) loads.set(option.assignmentKey, 0);
    for (const style of items) {
      const key = style.patternAssignmentKey || '';
      loads.set(key, (loads.get(key) ?? 0) + 1);
    }
    return loads;
  }, [items, patternMakers]);
  const reassignMutation = useMutation({
    mutationFn: async ({ styleIds, assignmentKey, reasonCode, note }: { styleIds: number[]; assignmentKey: string; displayName: string; reasonCode: string; note: string }) => {
      const res = await fetch('/api/workspace/style-development-tracker/bulk-pattern-maker', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ styleIds, assignmentKey, reasonCode, note }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || 'Could not reassign styles');
      }
      return res.json() as Promise<{ updated: number }>;
    },
    onSuccess: (_result, variables) => {
      queryClient.setQueryData<TrackerPayload>(['workspace', 'style-development-tracker'], current => current ? ({
        ...current,
        items: current.items.map(item => variables.styleIds.includes(item.id)
          ? {
              ...item,
              patternMaker: variables.displayName === 'Unassigned' ? null : variables.displayName,
              patternAssignmentKey: variables.assignmentKey,
            }
          : item),
      }) : current);
      queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', 'reporting'] });
      for (const id of variables.styleIds) {
        queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', id] });
      }
      setSelectedIds([]);
      setPendingReassignment(null);
    },
  });
  const assignmentOptions: AssignmentOption[] = [
    { assignmentKey: '', name: 'Unassigned', kind: 'unassigned' as const },
    ...patternMakers
      .filter(option => option.assignable)
      .map(option => ({ assignmentKey: option.assignmentKey, name: option.name, kind: option.kind })),
  ];
  const projectedLabel = (assignmentKey: string, display: string, styles: TrackerStyle[]) => {
    const currentLoad = assignmentLoads.get(assignmentKey) ?? 0;
    const incoming = styles.filter(style => style.patternAssignmentKey !== assignmentKey).length;
    return `${display} · ${currentLoad}${incoming ? ` → ${currentLoad + incoming}` : ''}`;
  };

  const facets = tracker.data?.facets ?? {
    targetOrderWeek: Array.from(new Set(items.map(s => s.targetOrderWeek).filter(Boolean))) as string[],
    subCategory: Array.from(new Set(items.map(s => s.subCategory).filter(Boolean))) as string[],
    category: Array.from(new Set(items.map(s => s.category).filter(Boolean))) as string[],
    brand: Array.from(new Set(items.map(s => s.brand).filter(Boolean))) as string[],
    type: Array.from(new Set(items.map(s => s.type).filter(Boolean))) as string[],
    tier: Array.from(new Set(items.map(s => s.tier).filter(Boolean))) as string[],
    patternMaker: Array.from(new Set(items.map(s => s.patternMaker).filter(Boolean))) as string[],
    designer: Array.from(new Set(items.map(s => s.designer).filter(Boolean))) as string[],
    collection: Array.from(new Set(items.map(s => s.collection).filter(Boolean))) as string[],
    theme: Array.from(new Set(items.map(s => s.theme).filter(Boolean))) as string[],
    knitOrWoven: Array.from(new Set(items.map(s => s.knitOrWoven).filter(Boolean))) as string[],
    printOrSolid: Array.from(new Set(items.map(s => s.printOrSolid).filter(Boolean))) as string[],
    launchMonth: Array.from(new Set(items.map(s => s.launchMonth).filter(Boolean))) as string[],
    status: Array.from(new Set(items.map(s => s.status).filter(Boolean))) as string[],
  };

  const filtered = useMemo(() => {
    return items.filter(style => {
      const searchStr = `${style.styleNumber || ''} ${style.styleName} ${style.fabric || ''} ${style.sampleFabricName || ''} ${style.sampleFabricColour || ''} ${style.designer || ''} ${style.collection || ''} ${style.theme || ''}`.toLowerCase();
      const matchSearch = search ? searchStr.includes(search.toLowerCase()) : true;
      const matchStage = filters.stage === 'All' || style.stage === filters.stage;
      const matchWeek = filters.targetOrderWeek === 'All' || style.targetOrderWeek === filters.targetOrderWeek;
      const matchCategory = filters.category === 'All' || style.category === filters.category;
      const matchSubCategory = filters.subCategory === 'All' || style.subCategory === filters.subCategory;
      const matchBrand = filters.brand === 'All' || style.brand === filters.brand;
      const matchType = filters.type === 'All' || style.type === filters.type;
      const matchTier = filters.tier === 'All' || style.tier === filters.tier;
      const matchPatternMaker = filters.patternMaker === 'All'
        || (filters.patternMaker === 'Unassigned' ? !style.patternMaker : style.patternMaker === filters.patternMaker);
      const matchDesigner = filters.designer === 'All'
        || (filters.designer === 'Unassigned' ? !style.designer : style.designer === filters.designer);
      const matchCollection = filters.collection === 'All'
        || (filters.collection === 'Unassigned' ? !style.collection : style.collection === filters.collection);
      const matchTheme = filters.theme === 'All'
        || (filters.theme === 'Unassigned' ? !style.theme : style.theme === filters.theme);
      const matchKnitOrWoven = filters.knitOrWoven === 'All'
        || (filters.knitOrWoven === 'Unassigned' ? !style.knitOrWoven : style.knitOrWoven === filters.knitOrWoven);
      const matchPrintOrSolid = filters.printOrSolid === 'All'
        || (filters.printOrSolid === 'Unassigned' ? !style.printOrSolid : style.printOrSolid === filters.printOrSolid);
      const matchStatus = filters.status === 'All' || style.status === filters.status;
      const matchBlocked = filters.blocked === 'All' || (filters.blocked === 'Blocked' ? style.blocked : !style.blocked);

      return matchSearch && matchStage && matchWeek && matchCategory && matchSubCategory && matchBrand && matchType && matchTier && matchPatternMaker && matchDesigner && matchCollection && matchTheme && matchKnitOrWoven && matchPrintOrSolid && matchStatus && matchBlocked;
    });
  }, [items, search, filters]);

  const grouped = useMemo(() => {
    const values = new Map<string, TrackerStyle[]>();

    if (groupBy === 'stage' || groupBy === 'status') {
      const orderedValues = groupBy === 'stage' ? stages : statuses;
      for (const value of orderedValues) values.set(value, []);
    }

    for (const [key, styles] of groupStyleDevelopmentItems(filtered, groupBy)) {
      values.set(key, [...(values.get(key) ?? []), ...styles]);
    }
    const entries = Array.from(values.entries());

    if (groupBy === 'stage' || groupBy === 'status') {
       const orderedValues = groupBy === 'stage' ? stages : statuses;
       entries.sort(([a], [b]) => {
          const ia = orderedValues.indexOf(a);
          const ib = orderedValues.indexOf(b);
          if (ia !== -1 && ib !== -1) return ia - ib;
          if (ia !== -1) return -1;
          if (ib !== -1) return 1;
          return a.localeCompare(b);
       });
    } else if (groupBy === 'targetOrderWeek') {
       entries.sort(([a], [b]) => {
          const na = targetWeekNumber(a);
          const nb = targetWeekNumber(b);
          if (na !== null && nb !== null) return na - nb;
          return a.localeCompare(b);
       });
    } else if (groupBy === 'blocked') {
       entries.sort(([a], [b]) => (a === 'Blocked' ? -1 : b === 'Blocked' ? 1 : a.localeCompare(b)));
    } else {
       entries.sort(([a], [b]) => a.localeCompare(b));
    }
    return entries;
  }, [filtered, groupBy, stages, statuses]);

  const sortedForList = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let aVal = (a as any)[sortField];
      let bVal = (b as any)[sortField];
      if (aVal === null || aVal === undefined) aVal = '';
      if (bVal === null || bVal === undefined) bVal = '';

      let res = 0;
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        res = aVal.localeCompare(bVal, undefined, { numeric: true });
      } else if (typeof aVal === 'number' && typeof bVal === 'number') {
        res = aVal - bVal;
      }

      if (sortField === 'targetOrderWeek') {
        const aN = targetWeekNumber(a.targetOrderWeek);
        const bN = targetWeekNumber(b.targetOrderWeek);
        if (aN !== null && bN !== null) res = aN - bN;
        else if (aN !== null) res = -1;
        else if (bN !== null) res = 1;
      }

      return sortDir === 'asc' ? res : -res;
    });
  }, [filtered, sortField, sortDir]);

  const handleSort = (field: keyof TrackerStyle) => {
    if (sortField === field) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDir('asc'); }
  };

  const clearFilters = () => {
    setSearch('');
    setFilters({
      stage: 'All', targetOrderWeek: 'All', category: 'All', subCategory: 'All', brand: 'All',
      type: 'All', tier: 'All', patternMaker: 'All', designer: 'All', collection: 'All',
      theme: 'All', knitOrWoven: 'All', printOrSolid: 'All', status: 'All', blocked: 'All',
    });
  };

  if (tracker.isLoading) return <section className="page tracker-page"><div className="tracker-empty-state">Loading workspace tracker...</div></section>;
  if (tracker.isError) return <section className="page tracker-page"><div className="tracker-empty-state"><AlertTriangle size={24} color="var(--coral)"/><h3>Style Development Unavailable</h3><p>{tracker.error instanceof Error ? tracker.error.message : 'Could not load data'}</p><button className="button button-dark" onClick={() => tracker.refetch()}>Retry</button></div></section>;

  const pendingApprovalsCount = items.filter(i => i.waitingDecision !== null).length;
  const unassignedPmCount = items.filter(i => !i.patternMaker).length;

  return (
    <section className="page tracker-page">
      <header className="tracker-header-row">
        <div className="tracker-header-left">
           <span className="tracker-kicker">Product Development Tracker / Q3 2026</span>
           <div className="tracker-header-title-row">
              <h1>Style development</h1>
              {unassignedPmCount > 0 && (
                <button className="tracker-header-metric" onClick={() => {
                  setView('board');
                  setFilters(current => ({ ...current, patternMaker: 'Unassigned' }));
                }}>
                   <strong>{unassignedPmCount}</strong> Unassigned Pattern Maker
                </button>
              )}
           </div>
        </div>
        <div className="tracker-view-toggle">
           <button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><LayoutGrid size={16}/> Board</button>
           <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={16}/> List</button>
           <button className={view === 'approvals' ? 'active' : ''} onClick={() => setView('approvals')}>
             <CheckSquare size={16}/> Approvals
             {pendingApprovalsCount > 0 && <span className="badge-count">{pendingApprovalsCount}</span>}
           </button>
           <div className="view-toggle-divider" />
           <button className={view === 'standards' ? 'active' : ''} onClick={() => setView('standards')}><BarChart2 size={16}/> Standards</button>
           <button className={view === 'capacity' ? 'active' : ''} onClick={() => setView('capacity')}><Users size={16}/> Capacity</button>
        </div>
      </header>

      {(view === 'board' || view === 'list') && (
        <div className="tracker-filters-bar">
          <div className="tracker-search">
            <Search size={16} color="#8c8375" />
            <input type="text" placeholder="Search numbers, styles, fabric..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="tracker-filter-select">
            <label>Stage</label>
            <select value={filters.stage} onChange={e => setFilters({...filters, stage: e.target.value})}>
              <option value="All">All</option>
              {stages.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Week</label>
            <select value={filters.targetOrderWeek} onChange={e => setFilters({...filters, targetOrderWeek: e.target.value})}>
              <option value="All">All</option>
              {facets.targetOrderWeek?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Category</label>
            <select value={filters.category} onChange={e => setFilters({...filters, category: e.target.value})}>
              <option value="All">All</option>
              {facets.category?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Sub-cat</label>
            <select value={filters.subCategory} onChange={e => setFilters({...filters, subCategory: e.target.value})}>
              <option value="All">All</option>
              {facets.subCategory?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Brand</label>
            <select value={filters.brand} onChange={e => setFilters({...filters, brand: e.target.value})}>
              <option value="All">All</option>
              {facets.brand?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Type</label>
            <select value={filters.type} onChange={e => setFilters({...filters, type: e.target.value})}>
              <option value="All">All</option>
              {facets.type?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Tier</label>
            <select value={filters.tier} onChange={e => setFilters({...filters, tier: e.target.value})}>
              <option value="All">All</option>
              {facets.tier?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Pattern Maker</label>
            <select value={filters.patternMaker} onChange={e => setFilters({...filters, patternMaker: e.target.value})}>
              <option value="All">All</option>
              <option value="Unassigned">Unassigned</option>
              {facets.patternMaker?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Designer</label>
            <select value={filters.designer} onChange={e => setFilters({...filters, designer: e.target.value})}>
              <option value="All">All</option>
              <option value="Unassigned">Unassigned</option>
              {facets.designer?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Collection</label>
            <select value={filters.collection} onChange={e => setFilters({...filters, collection: e.target.value})}>
              <option value="All">All</option>
              <option value="Unassigned">Unassigned</option>
              {facets.collection?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Theme</label>
            <select value={filters.theme} onChange={e => setFilters({...filters, theme: e.target.value})}>
              <option value="All">All</option>
              <option value="Unassigned">Unassigned</option>
              {facets.theme?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Knit / Woven</label>
            <select value={filters.knitOrWoven} onChange={e => setFilters({...filters, knitOrWoven: e.target.value})}>
              <option value="All">All</option>
              <option value="Unassigned">Unassigned</option>
              {facets.knitOrWoven?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Print / Solid</label>
            <select value={filters.printOrSolid} onChange={e => setFilters({...filters, printOrSolid: e.target.value})}>
              <option value="All">All</option>
              <option value="Unassigned">Unassigned</option>
              {facets.printOrSolid?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Status</label>
            <select value={filters.status} onChange={e => setFilters({...filters, status: e.target.value})}>
              <option value="All">All</option>
              {facets.status?.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div className="tracker-filter-select">
            <label>Blocked</label>
            <select value={filters.blocked} onChange={e => setFilters({...filters, blocked: e.target.value})}>
              <option value="All">All</option>
              <option value="Blocked">Blocked</option>
              <option value="Not Blocked">Not Blocked</option>
            </select>
          </div>
          <button className="tracker-filter-clear" onClick={clearFilters}>Clear</button>

          <div className="tracker-filter-select" style={{ marginLeft: 'auto' }}>
            <label>Choose a stacking field</label>
            <select value={groupBy} onChange={e => setGroupBy(e.target.value as GroupByKey)}>
              <option value="stage">Stage</option>
              <option value="status">Status</option>
              <option value="targetOrderWeek">Target Week</option>
              <option value="category">Category</option>
              <option value="subCategory">Sub-category</option>
              <option value="type">Type</option>
              <option value="tier">Tier</option>
              <option value="brand">Brand</option>
              <option value="patternMaker">Pattern Maker</option>
              <option value="designer">Designer</option>
              <option value="collection">Collection</option>
              <option value="theme">Theme</option>
              <option value="knitOrWoven">Knit or woven</option>
              <option value="printOrSolid">Print or solid</option>
              <option value="launchMonth">Launch month</option>
              <option value="blocked">Blocked</option>
            </select>
          </div>
        </div>
      )}

      {view === 'board' && (
        <div className="tracker-board-toolbar">
          <span className="tracker-board-toolbar-note">Design view · larger cards keep the garment visible</span>
          <div className="tracker-card-customize">
            <button
              type="button"
              className="tracker-customize-button"
              aria-expanded={customizeCardsOpen}
              aria-controls="style-card-fields"
              onClick={() => setCustomizeCardsOpen(open => !open)}
            >
              <SlidersHorizontal size={15} /> Customize cards
            </button>
            {customizeCardsOpen && (
              <div className="tracker-card-customize-popover" id="style-card-fields">
                <div className="tracker-card-customize-heading">
                  <strong>Card fields</strong>
                  <button type="button" onClick={() => setCardFields(DEFAULT_CARD_FIELDS)}>Reset</button>
                </div>
                <p>Choose the supporting details shown below each style.</p>
                {CARD_FIELD_OPTIONS.map(option => (
                  <label key={option.key}>
                    <input
                      type="checkbox"
                      checked={cardFields[option.key]}
                      onChange={event => setCardFields(current => ({ ...current, [option.key]: event.target.checked }))}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {view === 'board' && (
        <div className={`tracker-board ${groupBy === 'stage' ? 'is-stage-board' : ''}`}>
          {grouped.length === 0 && <div className="tracker-empty-state" style={{ width: '100%' }}>No styles match filters.</div>}
          {grouped.map(([label, styles]) => (
            <div key={label} className={`tracker-col ${groupBy === 'status' && label === 'Blocked' ? 'is-waiting-fabric' : ''}`}>
              <div className="tracker-col-header">
                <h3>{label}</h3>
                <span className="tracker-col-count">{styles.length}</span>
              </div>
              <div className="tracker-col-cards">
                {styles.map(s => (
                  <StyleDevelopmentBoardCard
                    key={s.id}
                    item={s}
                    cardFields={cardFields}
                    assignmentOptions={assignmentOptions}
                    reassignPending={reassignMutation.isPending}
                    onOpen={() => setDetailId(s.id)}
                    onAssignmentChange={(assignmentKey, displayName) => {
                      if (s.patternAssignmentKey !== assignmentKey) {
                        setPendingReassignment({ styleIds: [s.id], assignmentKey, displayName });
                      }
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'list' && (
        <div className="tracker-list-view">
          {selectedIds.length > 0 && (
            <div className="tracker-bulk-bar">
              <strong>{selectedIds.length} selected</strong>
              <select value={bulkPatternMaker} onChange={event => setBulkPatternMaker(event.target.value)}>
                {assignmentOptions.map(option => {
                  const selected = items.filter(item => selectedIds.includes(item.id));
                   return <option key={option.assignmentKey || 'unassigned'} value={option.assignmentKey}>{projectedLabel(option.assignmentKey, option.name, selected)}</option>;
                })}
              </select>
               <button className="button button-dark" disabled={reassignMutation.isPending} onClick={() => {
                 const option = assignmentOptions.find(value => value.assignmentKey === bulkPatternMaker) ?? assignmentOptions[0];
                 setPendingReassignment({ styleIds: selectedIds, assignmentKey: option.assignmentKey, displayName: option.name });
               }}>
                Reassign {selectedIds.length} styles
              </button>
              <button className="text-button" onClick={() => setSelectedIds([])}>Clear</button>
            </div>
          )}
         <div className="tracker-table-scroll">
          {sortedForList.length === 0 && <div className="tracker-empty-state">No styles match filters.</div>}
          {sortedForList.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th className="tracker-select-cell" onClick={event => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label="Select all visible styles"
                      checked={sortedForList.length > 0 && sortedForList.every(style => selectedIds.includes(style.id))}
                      onChange={event => setSelectedIds(event.target.checked ? sortedForList.map(style => style.id) : [])}
                    />
                  </th>
                  <th onClick={() => handleSort('styleNumber')}>Style # {sortField === 'styleNumber' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('styleName')}>Style Name {sortField === 'styleName' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('sampleFabricName')}>Fabric {sortField === 'sampleFabricName' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('stage')}>Stage {sortField === 'stage' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('targetOrderWeek')}>Target Wk {sortField === 'targetOrderWeek' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('category')}>Category {sortField === 'category' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('status')}>Status {sortField === 'status' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('patternMaker')}>Pattern Maker {sortField === 'patternMaker' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedForList.map(s => (
                  <tr key={s.id} onClick={() => setDetailId(s.id)}>
                    <td className="tracker-select-cell" onClick={event => event.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${s.styleName}`} checked={selectedIds.includes(s.id)} onChange={event => setSelectedIds(current => event.target.checked ? [...current, s.id] : current.filter(id => id !== s.id))} />
                    </td>
                    <td>{s.styleNumber || <em style={{color: '#999'}}>Pending</em>}</td>
                    <td>
                      <div className="tracker-table-title">
                        {s.styleName}
                        {s.blocked && <Ban size={12} color="var(--coral)"/>}
                        {s.overStandard && <Clock size={12} color="var(--coral)"/>}
                      </div>
                    </td>
                    <td>
                      {s.sampleFabricName ? (
                         <div className="tracker-fabric-present">
                            <span>{s.sampleFabricName}</span> <strong>{s.sampleFabricColour}</strong>
                            {(!s.sampleFabricMetres || s.sampleFabricMetres <= 0) && <span style={{color: 'var(--coral)', marginLeft: 8, fontWeight: 600, fontSize: 10}}>0m / no stock</span>}
                         </div>
                      ) : (
                         <span className="tracker-fabric-missing">Unassigned</span>
                      )}
                    </td>
                    <td>{s.stage || 'Not started'}</td>
                    <td>{s.targetOrderWeek || 'Unscheduled'}</td>
                    <td>{s.category}</td>
                    <td><span className={`compact-badge status ${s.status.toLowerCase().replaceAll(' ', '-')}`}>{s.status} · {s.workingDaysInStatus}d</span></td>
                    <td>{s.patternMaker || <span className="tracker-fabric-missing">Unassigned</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
         </div>
         {reassignMutation.isError && <div className="tracker-assignment-error">{reassignMutation.error instanceof Error ? reassignMutation.error.message : 'Reassignment failed'}</div>}
        </div>
      )}

      {view === 'approvals' && (
        <TrackerApprovals items={items} onOpenDetail={setDetailId} />
      )}

      {view === 'standards' && (
        <TrackerStandards />
      )}

      {view === 'capacity' && (
        <TrackerCapacity reassignmentReasons={reassignmentReasons} focusedPatternMaker={focusedPatternMaker} />
      )}

      {detailId && <TrackerDetailDrawer id={detailId} patternMakers={patternMakers} designers={designers} reassignmentReasons={reassignmentReasons} onClose={() => setDetailId(null)} />}
      {pendingReassignment && (
        <ReassignmentDialog
          count={pendingReassignment.styleIds.length}
           destination={pendingReassignment.displayName}
          reasons={reassignmentReasons}
          pending={reassignMutation.isPending}
          error={reassignMutation.error instanceof Error ? reassignMutation.error.message : null}
          onCancel={() => setPendingReassignment(null)}
          onSubmit={(reasonCode, note) => reassignMutation.mutate({ ...pendingReassignment, reasonCode, note })}
        />
      )}
    </section>
  );
}

function TrackerCardImage({ imageUrl }: { imageUrl: string | null }) {
  const [imageFailed, setImageFailed] = useState(!imageUrl);

  useEffect(() => {
    setImageFailed(!imageUrl);
  }, [imageUrl]);

  return (
    <div className={`tracker-card-image ${imageFailed ? 'is-empty' : ''}`} aria-hidden="true">
      {imageUrl && !imageFailed && (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      )}
      {imageFailed && (
        <span className="tracker-card-image-empty">
          <ImageIcon size={14} />
          No garment image
        </span>
      )}
    </div>
  );
}

function StyleDevelopmentBoardCard({
  item,
  cardFields,
  assignmentOptions,
  reassignPending,
  onOpen,
  onAssignmentChange,
}: {
  item: TrackerStyle;
  cardFields: CardFieldVisibility;
  assignmentOptions: AssignmentOption[];
  reassignPending: boolean;
  onOpen: () => void;
  onAssignmentChange: (assignmentKey: string, displayName: string) => void;
}) {
  const markerLabels = [
    item.overStandard ? `Over standard: ${item.workingDaysAtStage} days at ${item.stage}` : '',
    item.blocked ? `Blocked${item.blockerReason ? `: ${item.blockerReason}` : ''}` : '',
  ].filter(Boolean);

  return (
    <article className="tracker-card">
      <button className="tracker-card-open" onClick={onOpen} aria-label={`Open ${item.styleName}`}>
        <TrackerCardImage imageUrl={item.imageUrl} />
        <div className="tracker-card-content">
          <div className="tracker-board-card-title" title={item.styleName}>{item.styleName}</div>
          <div className="tracker-card-number">
            <span>Style No.</span>
            <strong>{item.styleNumber || 'Number pending'}</strong>
          </div>
          {(cardFields.targetOrderWeek || cardFields.stageDays) && (
            <div className="tracker-card-meta-line">
              {cardFields.targetOrderWeek && <span><b>Target</b> {item.targetOrderWeek || '—'}</span>}
              {cardFields.stageDays && <span><b>Stage</b> {item.workingDaysAtStage}d</span>}
            </div>
          )}
        </div>
      </button>
      <div className="tracker-card-supporting">
        <div className="tracker-card-fields">
          {cardFields.patternMaker && (
            <select
              className="tracker-card-chip tracker-card-chip-pm"
              aria-label={`Pattern maker for ${item.styleName}`}
              title={item.patternMaker || 'Unassigned'}
              value={item.patternAssignmentKey || ''}
              disabled={reassignPending}
              onChange={event => {
                const option = assignmentOptions.find(value => value.assignmentKey === event.target.value);
                if (option) onAssignmentChange(option.assignmentKey, option.name);
              }}
            >
              {assignmentOptions.map(option => (
                <option key={option.assignmentKey || 'unassigned'} value={option.assignmentKey}>{option.name}</option>
              ))}
            </select>
          )}
          {cardFields.designer && <span className="tracker-card-chip tracker-card-chip-designer" title={item.designer || 'Unassigned designer'}>{item.designer || 'Designer unassigned'}</span>}
          {cardFields.collection && <span className="tracker-card-chip tracker-card-chip-collection" title={item.collection || 'Unassigned collection'}>{item.collection || 'Collection unassigned'}</span>}
          {cardFields.knitOrWoven && <span className="tracker-card-chip">{item.knitOrWoven || 'Knit / woven unassigned'}</span>}
          {cardFields.printOrSolid && <span className="tracker-card-chip">{item.printOrSolid || 'Print / solid unassigned'}</span>}
          {cardFields.type && <span className="tracker-card-chip tracker-card-chip-type">{item.type}</span>}
          {cardFields.tier && <span className="tracker-card-chip tracker-card-chip-tier">{item.tier}</span>}
        </div>
        {(cardFields.status || markerLabels.length > 0) && (
          <div className="tracker-card-status-row">
            {cardFields.status && (
              <span
                className={`tracker-card-status ${item.status.toLowerCase().replaceAll(' ', '-')}`}
                title={`${item.status} for ${item.workingDaysInStatus} working days`}
              >
                {item.status}
              </span>
            )}
            {markerLabels.length > 0 && (
              <span
                className="tracker-card-status-markers"
                title={markerLabels.join(' · ')}
                aria-label={markerLabels.join(', ')}
              >
                {item.overStandard && <AlertTriangle className="card-status-icon over" size={14} aria-hidden="true" />}
                {item.blocked && <Ban className="card-status-icon blocked" size={14} aria-hidden="true" />}
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function TrackerStandards() {
  const query = useQuery({
    queryKey: ['workspace', 'style-development-tracker', 'reporting'],
    queryFn: async () => {
      const res = await fetch('/api/workspace/style-development-tracker/reporting', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load reporting');
      return res.json() as Promise<ReportingPayload>;
    }
  });

  if (query.isLoading) return <div className="tracker-empty-state">Loading standards...</div>;
  if (query.isError) return <div className="tracker-empty-state"><AlertTriangle size={24} color="var(--coral)"/><h3>Standards Unavailable</h3><p>{query.error instanceof Error ? query.error.message : 'Could not load data'}</p></div>;

  const data = query.data;
  if (!data) return null;

  return (
    <div className="tracker-reporting">
       <div className="tracker-rep-grid">
          <div className="tracker-rep-card" style={{ gridColumn: '1 / -1' }}>
             <h3>Interval Standards (Median / p80)</h3>
             <table className="tracker-rep-table">
               <thead><tr><th>Stage/Interval</th><th>Standard</th><th>Work (Med/p80)</th><th>Queue (Med/p80)</th><th>Total (Med/p80)</th><th>Count</th></tr></thead>
               <tbody>
                  {data.intervals?.map((int, i) => (
                    <tr key={i}>
                      <td>{int.key}</td>
                      <td>{int.standard} days</td>
                      <td>{int.workMedian ?? '-'}/{int.workP80 ?? '-'}</td>
                      <td>{int.queueMedian ?? '-'}/{int.queueP80 ?? '-'}</td>
                      <td>{int.totalMedian ?? '-'}/{int.totalP80 ?? '-'}</td>
                      <td>{int.count}</td>
                    </tr>
                  ))}
               </tbody>
             </table>
          </div>
          <div className="tracker-rep-card">
             <h3>Where is the time going?</h3>
             <ul className="tracker-rep-list">
               {data.whereTimeGoing?.map((wt, i) => (
                 <li key={i}>
                   <div className="rep-list-bar" style={{ width: `${Math.min(100, (wt.totalDaysConsumed / 50) * 100)}%` }}/>
                   <span>{wt.key}</span>
                   <strong>{wt.totalDaysConsumed} days</strong>
                 </li>
               ))}
             </ul>
          </div>
          <div className="tracker-rep-card">
             <h3>Assumption Errors (Time consumed vs Plan)</h3>
             <ul className="tracker-rep-list">
               {data.assumptionsWrong?.map((aw, i) => (
                 <li key={i}>
                   <div className="rep-list-bar warning" style={{ width: `${Math.min(100, ((aw.difference ?? 0) / 10) * 100)}%` }}/>
                   <span>{aw.key}</span>
                   <strong>+{aw.difference ?? 0} days</strong>
                 </li>
               ))}
             </ul>
          </div>
          <div className="tracker-rep-card">
             <h3>Cancellations & Exits</h3>
             <div className="rep-split">
                <div>
                  <h4>By Reason</h4>
                  {Object.entries(data.cancellationsByReason || {}).map(([reason, count], i) => <div key={i} className="rep-stat-row"><span>{reason}</span><strong>{count as React.ReactNode}</strong></div>)}
                </div>
                <div>
                  <h4>By Stage</h4>
                  {Object.entries(data.cancellationsByStage || {}).map(([stage, count], i) => <div key={i} className="rep-stat-row"><span>{stage}</span><strong>{count as React.ReactNode}</strong></div>)}
                </div>
             </div>
          </div>
       </div>
    </div>
  );
}

function ReassignmentDialog({ count, destination, reasons, pending, error, defaultReasonCode, onCancel, onSubmit }: {
  count: number;
  destination: string;
  reasons: ReassignmentReason[];
  pending: boolean;
  error: string | null;
  defaultReasonCode?: string;
  onCancel: () => void;
  onSubmit: (reasonCode: string, note: string) => void;
}) {
  const [reasonCode, setReasonCode] = useState(
    reasons.find(reason => reason.code === defaultReasonCode)?.code ?? reasons[0]?.code ?? '',
  );
  const [note, setNote] = useState('');
  const chosen = reasons.find(reason => reason.code === reasonCode);
  return (
    <div className="reassignment-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form className="reassignment-modal" onMouseDown={event => event.stopPropagation()} onSubmit={event => {
        event.preventDefault();
        if (reasonCode) onSubmit(reasonCode, note);
      }}>
        <span className="tracker-kicker">Assignment context</span>
        <h2>Reassign {count} {count === 1 ? 'style' : 'styles'} to {destination || 'Unassigned'}</h2>
        <p>The reason determines whether this is a resourcing event or a style-related handoff.</p>
        <label className="tracker-input-wrap">
          <span>Reason</span>
          <select value={reasonCode} onChange={event => setReasonCode(event.target.value)} required>
            <optgroup label="Resourcing reasons">
              {reasons.filter(reason => reason.category === 'operational').map(reason => <option key={reason.id} value={reason.code}>{reason.label}</option>)}
            </optgroup>
            <optgroup label="Style-related reasons">
              {reasons.filter(reason => reason.category === 'style').map(reason => <option key={reason.id} value={reason.code}>{reason.label}</option>)}
            </optgroup>
          </select>
        </label>
        {chosen && <div className={`reassignment-classification ${chosen.category}`}>
          {chosen.category === 'operational'
            ? 'Resourcing signal — Capacity will show the impact, but the styles will not be flagged.'
            : 'Style signal — the affected styles will show a style handoff flag.'}
        </div>}
        <label className="tracker-input-wrap">
          <span>Note (optional)</span>
          <textarea value={note} onChange={event => setNote(event.target.value)} maxLength={500} placeholder="Add useful context for the team…" />
        </label>
        {error && <div className="tracker-assignment-error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="button button-dark" disabled={!reasonCode || pending}>{pending ? 'Reassigning…' : 'Confirm reassignment'}</button>
        </div>
      </form>
    </div>
  );
}

function TrackerCapacity({ reassignmentReasons, focusedPatternMaker }: { reassignmentReasons: ReassignmentReason[]; focusedPatternMaker: string }) {
  const queryClient = useQueryClient();
  const [pendingSuggestion, setPendingSuggestion] = useState<ReportingPayload['capacity']['rebalanceSuggestions'][number] | null>(null);
  const [selectedLegacyCadIds, setSelectedLegacyCadIds] = useState<number[]>([]);
  const [legacyCadDestination, setLegacyCadDestination] = useState('');
  const [legacyCadReviewOpen, setLegacyCadReviewOpen] = useState(false);
  const query = useQuery({
    queryKey: ['workspace', 'style-development-tracker', 'reporting'],
    queryFn: async () => {
      const res = await fetch('/api/workspace/style-development-tracker/reporting', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load reporting');
      return res.json() as Promise<ReportingPayload>;
    }
  });
  useEffect(() => {
    if (!focusedPatternMaker || query.isLoading) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`capacity-person-${focusedPatternMaker.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [focusedPatternMaker, query.isLoading]);

  const reassignMutation = useMutation({
    mutationFn: async ({ styleIds, assignmentKey, reasonCode, note }: { styleIds: number[]; assignmentKey: string; reasonCode: string; note: string }) => {
      const res = await fetch('/api/workspace/style-development-tracker/bulk-pattern-maker', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ styleIds, assignmentKey, reasonCode, note }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || 'Could not reassign styles');
      }
      return res.json() as Promise<{ updated: number }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker'] });
      queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', 'reporting'] });
      setPendingSuggestion(null);
      setLegacyCadReviewOpen(false);
    },
  });
  const legacyCadIdKey = (query.data?.capacity.legacyCad?.styles ?? []).map(style => style.id).join(',');
  useEffect(() => {
    const legacyStyles = query.data?.capacity.legacyCad?.styles;
    setSelectedLegacyCadIds(legacyStyles?.map(style => style.id) ?? []);
  }, [legacyCadIdKey]);
  useEffect(() => {
    const makers = query.data?.capacity.byPatternMaker ?? [];
    if (!makers.length || makers.some(maker => maker.assignmentKey === legacyCadDestination)) return;
    const lightest = [...makers].sort((a, b) => Number(a.queueWeeks ?? 0) - Number(b.queueWeeks ?? 0))[0];
    setLegacyCadDestination(lightest?.assignmentKey ?? '');
  }, [query.data?.capacity.byPatternMaker, legacyCadDestination]);

  if (query.isLoading) return <div className="tracker-empty-state">Loading capacity...</div>;
  if (query.isError) return <div className="tracker-empty-state"><AlertTriangle size={24} color="var(--coral)"/><h3>Capacity Unavailable</h3><p>{query.error instanceof Error ? query.error.message : 'Could not load data'}</p></div>;

  const data = query.data?.capacity;
  if (!data) return null;
  const legacyCad = data.legacyCad;
  const selectedLegacyCadStyles = legacyCad?.styles.filter(style => selectedLegacyCadIds.includes(style.id)) ?? [];
  const selectedLegacyCadEffort = selectedLegacyCadStyles.reduce((sum, style) => sum + style.effortDays, 0);
  const legacyDestination = data.byPatternMaker.find(maker => maker.assignmentKey === legacyCadDestination);
  const legacyImpact = data.byPatternMaker.map(maker => {
    const receives = maker.assignmentKey === legacyCadDestination;
    return {
      ...maker,
      projectedTotal: maker.totalStylesHeld + (receives ? selectedLegacyCadStyles.length : 0),
      projectedWeeks: maker.queueWeeks === null ? null : maker.queueWeeks
        + (receives ? selectedLegacyCadEffort / (5 * Number(maker.effectiveCapacity || 1)) : 0),
    };
  });

  return (
    <div className="tracker-capacity">
      <div className="cap-kpi-row">
         <div className="cap-kpi"><span>Available Now</span><strong>{Number(data.makers).toFixed(1)} <small>/ {Number(data.baseMakers).toFixed(1)}</small></strong></div>
         <div className="cap-kpi"><span>Average Queue</span><strong>{Number(data.balance.averageQueueWeeks).toFixed(1)} wks</strong></div>
         <div className="cap-kpi"><span>Queue Spread</span><strong>{Number(data.balance.spreadWeeks).toFixed(1)} wks</strong></div>
         <div className="cap-kpi"><span>Overloaded Makers</span><strong className={data.balance.overloadedCount > 0 ? "negative" : "positive"}>{data.balance.overloadedCount}</strong></div>
      </div>

      {legacyCad && (
        <div className="tracker-rep-card" style={{ marginTop: 24, padding: 0, overflow: 'hidden', borderColor: '#c77b30' }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid #e0c39f', background: '#fff8ed', display: 'flex', justifyContent: 'space-between', gap: 20 }}>
            <div>
              <span className="tracker-kicker" style={{ color: '#9a5b1b' }}>Team route · separate capacity</span>
              <h3 style={{ margin: '4px 0 6px', fontSize: 17 }}>CAD pattern work</h3>
              <p className="tracker-capacity-note" style={{ margin: 0 }}>CAD remains available as a selectable team route while the phase-out progresses gradually. This workload is tracked separately from individual pattern-maker capacity.</p>
            </div>
            <div style={{ textAlign: 'right', minWidth: 120 }}>
              <strong style={{ display: 'block', fontSize: 28 }}>{legacyCad.totalStylesHeld}</strong>
              <span className="capacity-work-days">active styles currently assigned</span>
            </div>
          </div>
          <div className="legacy-cad-capacity-grid">
            <div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, fontSize: 13, fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={selectedLegacyCadIds.length === legacyCad.styles.length}
                  onChange={event => setSelectedLegacyCadIds(event.target.checked ? legacyCad.styles.map(style => style.id) : [])}
                />
                Select all {legacyCad.styles.length} CAD styles
              </label>
              <div style={{ maxHeight: 330, overflowY: 'auto', border: '1px solid #e2d8c9', borderRadius: 8 }}>
                {legacyCad.styles.map(style => (
                  <label key={style.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderBottom: '1px solid #eee5d8', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selectedLegacyCadIds.includes(style.id)}
                      onChange={event => setSelectedLegacyCadIds(current => event.target.checked
                        ? [...current, style.id]
                        : current.filter(id => id !== style.id))}
                    />
                    <span>
                      <strong style={{ display: 'block', fontSize: 12 }}>{style.styleNumber || 'Number pending'}</strong>
                      <span className="capacity-work-days">{style.styleName} · {style.stage}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="tracker-input-wrap">
                <span>Reassign selected styles to</span>
                <select value={legacyCadDestination} onChange={event => setLegacyCadDestination(event.target.value)}>
                  {data.byPatternMaker.map(maker => <option key={maker.assignmentKey} value={maker.assignmentKey}>{maker.patternMaker}</option>)}
                </select>
              </label>
              <p className="tracker-capacity-note" style={{ margin: '10px 0' }}>
                Impact preview includes all {Number(data.baseMakers).toFixed(1)} effective makers. Queue weeks assume the selected CAD work still needs pattern completion.
              </p>
              <table className="tracker-rep-table balance-table">
                <thead><tr><th>Pattern maker</th><th>All assigned</th><th>Queue weeks</th></tr></thead>
                <tbody>
                  {legacyImpact.map(maker => (
                    <tr key={maker.assignmentKey} style={maker.assignmentKey === legacyCadDestination ? { background: '#fff1de' } : undefined}>
                      <td><strong>{maker.patternMaker}</strong><div className="capacity-work-days">{Number(maker.effectiveCapacity).toFixed(1)} capacity</div></td>
                      <td>{maker.totalStylesHeld} → <strong>{maker.projectedTotal}</strong></td>
                      <td>{maker.queueWeeks === null ? '—' : `${maker.queueWeeks.toFixed(1)} → ${maker.projectedWeeks?.toFixed(1)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                type="button"
                className="button button-dark"
                style={{ marginTop: 14, width: '100%' }}
                disabled={!selectedLegacyCadStyles.length || !legacyDestination}
                onClick={() => setLegacyCadReviewOpen(true)}
              >
                Review reassignment of {selectedLegacyCadStyles.length} CAD style{selectedLegacyCadStyles.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="tracker-rep-card capacity-balancing" style={{ marginTop: 24, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid #d8d0c2', background: '#fbfaf8' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>Personal Workloads</h3>
          <p className="tracker-capacity-note" style={{ marginTop: 6 }}>Queue in weeks relative to each maker's effective capacity (Florence at 0.5).</p>
        </div>
        <table className="tracker-rep-table balance-table">
          <thead>
            <tr>
              <th>Pattern Maker</th>
              <th>Status</th>
              <th>Queue Time</th>
              <th>Total Backlog</th>
              <th>Category Mix</th>
              <th>Oldest Waiting</th>
            </tr>
          </thead>
          <tbody>
            {data.byPatternMaker?.filter(pm => pm.kind === 'person').map((pm, i) => (
              <tr
                key={i}
                id={`capacity-person-${pm.patternMaker.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                className={`${pm.isTeamLead ? 'capacity-team-lead' : ''} ${pm.patternMaker.toLowerCase() === focusedPatternMaker.toLowerCase() ? 'capacity-person-focus' : ''}`.trim()}
              >
                <td>
                  <strong>{pm.patternMaker}</strong>
                  {pm.isTeamLead && <span className="capacity-route-badge lead">Team lead</span>}
                  {pm.unavailableNow && <span className="capacity-route-badge unavailable">Unavailable</span>}
                  {pm.nextUnavailable && (
                    <div style={{ fontSize: 10, color: '#8c8375', marginTop: 4, fontFamily: 'var(--app-font-mono)' }}>
                      Away from {new Date(`${pm.nextUnavailable.unavailableFrom}T00:00:00`).toLocaleDateString('en-GB')}
                    </div>
                  )}
                </td>
                <td>
                  <span className={`balance-status-badge ${pm.balanceStatus}`}>
                    {pm.balanceStatus === 'overloaded' ? 'Overloaded' : pm.balanceStatus === 'light' ? 'Light' : 'Balanced'}
                  </span>
                </td>
                <td>
                  <strong className={pm.balanceStatus === 'overloaded' ? 'cap-negative' : ''}>{Number(pm.queueWeeks).toFixed(1)} wks</strong>
                  <div className="capacity-work-days">{pm.queueEffortDays} days effort</div>
                </td>
                <td>
                  <strong>{pm.queueStyleCount} styles</strong>
                  <div className="capacity-work-days">of {pm.totalStylesHeld} total held</div>
                  <div className="capacity-work-days">{pm.patternAwaitingCount} Pattern · {pm.transferToCadCount} Transfer</div>
                </td>
                <td>
                  <div className="category-mix-mini">
                    {pm.categoryMix?.slice(0, 3).map((mix, j) => (
                      <span key={j} title={`${mix.effortDays} days effort`}>{mix.category}: {mix.count}</span>
                    ))}
                    {(pm.categoryMix?.length ?? 0) > 3 && <span>+{(pm.categoryMix?.length ?? 0) - 3}</span>}
                  </div>
                </td>
                <td>
                  {pm.oldestStyleName ? (
                    <>
                      <strong className={pm.oldestWaitingWorkingDays > 10 ? 'cap-negative' : ''}>{pm.oldestWaitingWorkingDays} days</strong>
                      <div className="capacity-work-days truncate" style={{ maxWidth: 140 }} title={pm.oldestStyleName}>{pm.oldestStyleName}</div>
                    </>
                  ) : (
                    <span className="capacity-work-days">None waiting</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.rebalanceSuggestions && data.rebalanceSuggestions.length > 0 && (
        <div className="tracker-rep-card capacity-suggestions" style={{ marginTop: 24, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid #d8d0c2', background: '#fffaf0' }}>
            <h3 style={{ margin: 0, fontSize: 16, color: '#8a6d38' }}>Advisory Style Moves</h3>
            <p className="tracker-capacity-note" style={{ marginTop: 6, color: '#7a6336' }}>Suggested reassignments to balance queues across the team.</p>
          </div>
          <table className="tracker-rep-table balance-table">
            <thead>
              <tr>
                <th>Style</th>
                <th>Category</th>
                <th>From</th>
                <th>To</th>
                <th>Impact</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.rebalanceSuggestions.map((sug, i) => (
                <tr key={i}>
                  <td>
                    <strong>{sug.styleNumber || 'No #'}</strong>
                    <div className="capacity-work-days truncate" style={{ maxWidth: 160 }} title={sug.styleName}>{sug.styleName}</div>
                  </td>
                  <td>{sug.category} <div className="capacity-work-days">{sug.effortDays}d effort</div></td>
                  <td>
                    <div className="move-participant">
                      <span>{sug.fromPatternMaker}</span>
                      <small>{Number(sug.fromWeeksBefore).toFixed(1)}w → <strong>{Number(sug.fromWeeksAfter).toFixed(1)}w</strong></small>
                    </div>
                  </td>
                  <td>
                    <div className="move-participant">
                      <span>{sug.toPatternMaker}</span>
                      <small>{Number(sug.toWeeksBefore).toFixed(1)}w → <strong>{Number(sug.toWeeksAfter).toFixed(1)}w</strong></small>
                    </div>
                  </td>
                  <td>
                    <div className="move-impact-badge">
                      Spread -{Number(Math.abs((sug.fromWeeksBefore - sug.toWeeksBefore) - (sug.fromWeeksAfter - sug.toWeeksAfter))).toFixed(1)}w
                    </div>
                  </td>
                  <td>
                    <button
                      className="button button-dark button-sm"
                      disabled={reassignMutation.isPending}
                      onClick={() => setPendingSuggestion(sug)}
                    >
                      Review move
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.routedWork && data.routedWork.length > 0 && (
        <div className="tracker-rep-card capacity-balancing" style={{ marginTop: 24, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid #d8d0c2' }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Ken Knit & Unassigned Work</h3>
            <p className="tracker-capacity-note" style={{ marginTop: 6 }}>External supplier and unassigned styles remain separate from personal capacity and the legacy CAD phase-out.</p>
          </div>
          <table className="tracker-rep-table balance-table">
            <thead>
              <tr>
                <th>Route</th>
                <th>Type</th>
                <th>Total Backlog</th>
                <th>Queue</th>
                <th>Category Mix</th>
              </tr>
            </thead>
            <tbody>
              {data.routedWork.map((rw, i) => (
                <tr key={i}>
                  <td><strong>{rw.patternMaker || 'Unassigned'}</strong></td>
                  <td><span className="capacity-route-badge">{rw.kind}</span></td>
                  <td>{rw.totalStylesHeld} styles</td>
                  <td>{rw.queueStyleCount} styles</td>
                  <td>
                    <div className="category-mix-mini">
                      {rw.categoryMix?.slice(0, 4).map((mix, j) => (
                        <span key={j}>{mix.category}: {mix.count}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.nonCapacityPeople && data.nonCapacityPeople.length > 0 && (
        <div className="tracker-rep-card capacity-balancing" style={{ marginTop: 24, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid #d8d0c2' }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Assigned Outside Capacity</h3>
            <p className="tracker-capacity-note" style={{ marginTop: 6 }}>People can hold assigned work without contributing to the 3.5 effective pattern-maker capacity.</p>
          </div>
          <table className="tracker-rep-table balance-table">
            <thead><tr><th>Person</th><th>Styles held</th><th>Pattern queue</th><th>Capacity contribution</th></tr></thead>
            <tbody>
              {data.nonCapacityPeople.map(person => (
                <tr key={person.assignmentKey}>
                  <td><strong>{person.patternMaker}</strong></td>
                  <td>{person.totalStylesHeld}</td>
                  <td>{person.queueStyleCount}</td>
                  <td>0.0</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.availabilitySchedule && data.availabilitySchedule.length > 0 && (
        <div className="tracker-rep-card capacity-availability" style={{ marginTop: 24 }}>
          <h3>Planned Availability</h3>
          <p className="tracker-capacity-note">Forecast capacity reflects dated leave or sickness. Overlapping absences are combined.</p>
          <div className="capacity-event-grid">
            {data.availabilitySchedule.map(period => (
              <article key={period.id}>
                <div><strong>{period.patternMaker}</strong><span>{new Date(`${period.unavailableFrom}T00:00:00`).toLocaleDateString('en-GB')} – {period.unavailableTo ? new Date(`${period.unavailableTo}T00:00:00`).toLocaleDateString('en-GB') : 'Until further notice'}</span></div>
                <div className="capacity-impact-number"><strong>{Number(period.weeklyCapacityDuring).toFixed(2)}</strong><span>patterns / week</span></div>
                <p>{Number(period.makersDuring).toFixed(1)} effective makers during this period{period.note ? ` · ${period.note}` : ''}</p>
              </article>
            ))}
          </div>
        </div>
      )}

      {data.redistributions && data.redistributions.length > 0 && (
        <div className="tracker-rep-card capacity-redistributions" style={{ marginTop: 24 }}>
          <h3>Queue Redistributions</h3>
          <p className="tracker-capacity-note">Operational moves explain changes in waiting time without flagging the styles as troubled.</p>
          <div className="redistribution-list">
            {data.redistributions.map(event => {
              const names = Array.from(new Set([...Object.keys(event.beforeLoads || {}), ...Object.keys(event.afterLoads || {})]));
              const deltas = names.map(name => ({ name, delta: (event.afterLoads[name] ?? 0) - (event.beforeLoads[name] ?? 0) })).filter(item => item.delta !== 0);
              const patternNames = Array.from(new Set([...Object.keys(event.beforePatternLoads || {}), ...Object.keys(event.afterPatternLoads || {})]));
              const patternDeltas = patternNames.map(name => ({ name, delta: (event.afterPatternLoads[name] ?? 0) - (event.beforePatternLoads[name] ?? 0) })).filter(item => item.delta !== 0);
              return (
                <article key={event.id}>
                  <header><div><strong>{event.reasonLabel}</strong><span>{event.changedCount} {event.changedCount === 1 ? 'style' : 'styles'} · {new Date(event.recordedAt).toLocaleDateString('en-GB')} · {event.recordedBy}</span></div></header>
                  <div className="redistribution-deltas">
                    {deltas.map(item => <span key={item.name} className={item.delta > 0 ? 'increase' : 'decrease'}>{item.name} {item.delta > 0 ? '+' : ''}{item.delta}</span>)}
                  </div>
                  <div className="redistribution-pattern-impact">
                    <strong>Pattern-stage queue:</strong>{' '}
                    {patternDeltas.length
                      ? patternDeltas.map(item => `${item.name} ${item.delta > 0 ? '+' : ''}${item.delta}`).join(' · ')
                      : 'No immediate change — moved styles are outside Pattern stage.'}
                  </div>
                  {event.note && <p>{event.note}</p>}
                </article>
              );
            })}
          </div>
        </div>
      )}

      {pendingSuggestion && (
        <ReassignmentDialog
          count={1}
          destination={pendingSuggestion.toPatternMaker}
          reasons={reassignmentReasons}
          defaultReasonCode="rebalancing"
          pending={reassignMutation.isPending}
          error={reassignMutation.error instanceof Error ? reassignMutation.error.message : null}
          onCancel={() => setPendingSuggestion(null)}
          onSubmit={(reasonCode, note) => reassignMutation.mutate({
            styleIds: [pendingSuggestion.styleId],
             assignmentKey: pendingSuggestion.toAssignmentKey,
            reasonCode,
            note,
          })}
        />
      )}
      {legacyCadReviewOpen && legacyCad && legacyDestination && (
        <ReassignmentDialog
          count={selectedLegacyCadStyles.length}
          destination={`${legacyDestination.patternMaker} (${legacyDestination.totalStylesHeld} → ${legacyDestination.totalStylesHeld + selectedLegacyCadStyles.length} assigned; ${legacyDestination.queueWeeks?.toFixed(1) ?? '—'} → ${legacyImpact.find(row => row.assignmentKey === legacyDestination.assignmentKey)?.projectedWeeks?.toFixed(1) ?? '—'} queue weeks)`}
          reasons={reassignmentReasons}
          defaultReasonCode="rebalancing"
          pending={reassignMutation.isPending}
          error={reassignMutation.error instanceof Error ? reassignMutation.error.message : null}
          onCancel={() => setLegacyCadReviewOpen(false)}
          onSubmit={(reasonCode, note) => reassignMutation.mutate({
            styleIds: selectedLegacyCadStyles.map(style => style.id),
            assignmentKey: legacyDestination.assignmentKey,
            reasonCode,
            note,
          })}
        />
      )}
      <PatternMakerDirectory />
      <ReassignmentReasonDirectory />
    </div>
  );
}

function PatternMakerDirectory() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'team' | 'supplier'>('team');
  const [unavailableMakerId, setUnavailableMakerId] = useState('');
  const [unavailableFrom, setUnavailableFrom] = useState('');
  const [unavailableTo, setUnavailableTo] = useState('');
  const [unavailableNote, setUnavailableNote] = useState('');
  const query = useQuery({
    queryKey: ['workspace', 'style-development-tracker', 'pattern-makers'],
    queryFn: async () => {
      const res = await fetch('/api/workspace/style-development-tracker/pattern-makers', { credentials: 'include' });
      if (!res.ok) throw new Error('Could not load assignment options');
      return res.json() as Promise<{
        items: PatternMakerOption[];
        unavailability: { id: number; patternMakerId: number; patternMaker: string; unavailableFrom: string; unavailableTo: string | null; note: string; recordedBy: string }[];
      }>;
    },
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker'] });
    queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', 'pattern-makers'] });
  };
  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/workspace/style-development-tracker/pattern-makers', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, kind }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || 'Could not add assignment option');
      }
    },
    onSuccess: () => { setName(''); refresh(); },
  });
  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) => {
      const res = await fetch(`/api/workspace/style-development-tracker/pattern-makers/${id}`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) throw new Error('Could not update assignment option');
    },
    onSuccess: refresh,
  });
  const availabilityMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/workspace/style-development-tracker/pattern-makers/${unavailableMakerId}/unavailability`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unavailableFrom, unavailableTo, note: unavailableNote }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || 'Could not save unavailable period');
      }
    },
    onSuccess: () => {
      setUnavailableFrom(''); setUnavailableTo(''); setUnavailableNote('');
      queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', 'reporting'] });
      refresh();
    },
  });
  const removeAvailabilityMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/workspace/style-development-tracker/pattern-maker-unavailability/${id}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) throw new Error('Could not remove unavailable period');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', 'reporting'] });
      refresh();
    },
  });
  return (
    <div className="tracker-rep-card pattern-maker-directory" style={{ marginTop: 24 }}>
      <div>
        <h3>Assignment options</h3>
        <p className="tracker-capacity-note">People come from Settings automatically. Add only controlled internal-team or external-supplier routes here.</p>
      </div>
      <form className="pattern-maker-add" onSubmit={event => { event.preventDefault(); if (name.trim()) addMutation.mutate(); }}>
        <input value={name} onChange={event => setName(event.target.value)} placeholder="Routing team or supplier" />
        <select value={kind} onChange={event => setKind(event.target.value as 'team' | 'supplier')}>
          <option value="team">Internal team</option>
          <option value="supplier">External supplier</option>
        </select>
        <button className="button button-dark" disabled={!name.trim() || addMutation.isPending}>Add option</button>
      </form>
      <div className="pattern-maker-option-list">
        {query.data?.items.map(option => (
          <div key={option.id} className={!option.active ? 'inactive' : ''}>
            <span><strong>{option.name}</strong><small>{option.kind === 'person' ? `${option.team || 'Settings team member'} · ${option.role || 'Team member'}` : option.kind} · {option.load} assigned</small></span>
            {option.kind === 'person'
              ? <span className="capacity-work-days">Managed in Settings</span>
              : <button className="text-button" disabled={toggleMutation.isPending} onClick={() => toggleMutation.mutate({ id: option.id, active: !option.active })}>
                  {option.active ? 'Remove from choices' : 'Restore'}
                </button>}
          </div>
        ))}
      </div>
      <div className="pattern-maker-availability-editor">
        <h4>Mark unavailable</h4>
        <form className="availability-form" onSubmit={event => { event.preventDefault(); availabilityMutation.mutate(); }}>
          <select value={unavailableMakerId} onChange={event => setUnavailableMakerId(event.target.value)} required>
            <option value="">Pattern maker…</option>
            {query.data?.items.filter(option => option.active && option.kind === 'person').map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
          <label><span>From</span><input type="date" value={unavailableFrom} onChange={event => setUnavailableFrom(event.target.value)} required /></label>
          <label><span>To (optional)</span><input type="date" min={unavailableFrom} value={unavailableTo} onChange={event => setUnavailableTo(event.target.value)} /></label>
          <input value={unavailableNote} onChange={event => setUnavailableNote(event.target.value)} maxLength={500} placeholder="Leave, sickness, or other context…" />
          <button className="button button-dark" disabled={availabilityMutation.isPending}>Save period</button>
        </form>
        {query.data?.unavailability && query.data.unavailability.length > 0 && (
          <div className="availability-list">
            {query.data.unavailability.map(period => (
              <div key={period.id}>
                <span><strong>{period.patternMaker}</strong><small>{String(period.unavailableFrom).slice(0, 10)} → {period.unavailableTo ? String(period.unavailableTo).slice(0, 10) : 'Until further notice'}{period.note ? ` · ${period.note}` : ''}</small></span>
                <button className="text-button" onClick={() => removeAvailabilityMutation.mutate(period.id)}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
      {(query.isError || addMutation.isError || toggleMutation.isError || availabilityMutation.isError || removeAvailabilityMutation.isError) && <div className="tracker-assignment-error">Pattern-maker settings could not be updated.</div>}
    </div>
  );
}

function ReassignmentReasonDirectory() {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<ReassignmentReason['category']>('operational');
  const query = useQuery({
    queryKey: ['workspace', 'style-development-tracker', 'reassignment-reasons'],
    queryFn: async () => {
      const res = await fetch('/api/workspace/style-development-tracker/reassignment-reasons', { credentials: 'include' });
      if (!res.ok) throw new Error('Could not load reassignment reasons');
      return res.json() as Promise<{ items: ReassignmentReason[] }>;
    },
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker'] });
    queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', 'reassignment-reasons'] });
  };
  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/workspace/style-development-tracker/reassignment-reasons', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, category }),
      });
      if (!res.ok) throw new Error('Could not add reassignment reason');
    },
    onSuccess: () => { setLabel(''); refresh(); },
  });
  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) => {
      const res = await fetch(`/api/workspace/style-development-tracker/reassignment-reasons/${id}`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) throw new Error('Could not update reassignment reason');
    },
    onSuccess: refresh,
  });
  return (
    <div className="tracker-rep-card pattern-maker-directory" style={{ marginTop: 24 }}>
      <div><h3>Reassignment reasons</h3><p className="tracker-capacity-note">Operational reasons affect resourcing reports. Style-related reasons flag the style for attention.</p></div>
      <form className="pattern-maker-add" onSubmit={event => { event.preventDefault(); if (label.trim()) addMutation.mutate(); }}>
        <input value={label} onChange={event => setLabel(event.target.value)} placeholder="Reason label" />
        <select value={category} onChange={event => setCategory(event.target.value as ReassignmentReason['category'])}>
          <option value="operational">Resourcing reason</option>
          <option value="style">Style-related reason</option>
        </select>
        <button className="button button-dark" disabled={!label.trim() || addMutation.isPending}>Add reason</button>
      </form>
      <div className="pattern-maker-option-list">
        {query.data?.items.map(reason => (
          <div key={reason.id} className={!reason.active ? 'inactive' : ''}>
            <span><strong>{reason.label}</strong><small>{reason.category === 'operational' ? 'Resourcing signal' : 'Style signal'}</small></span>
            <button className="text-button" disabled={toggleMutation.isPending} onClick={() => toggleMutation.mutate({ id: reason.id, active: !reason.active })}>{reason.active ? 'Remove from choices' : 'Restore'}</button>
          </div>
        ))}
      </div>
      {(query.isError || addMutation.isError || toggleMutation.isError) && <div className="tracker-assignment-error">Reassignment reasons could not be updated.</div>}
    </div>
  );
}

function TrackerApprovals({ items, onOpenDetail }: { items: TrackerStyle[], onOpenDetail: (id: number) => void }) {
  const pending = items.filter(i => i.waitingDecision !== null)
    .sort((a, b) => new Date(a.statusStartedAt || 0).getTime() - new Date(b.statusStartedAt || 0).getTime());

  if (pending.length === 0) return (
     <div className="tracker-empty-state">
        <CheckCircle size={40} strokeWidth={1.5} color="var(--gold)" />
        <h3>All caught up</h3>
        <p>There are no pending decisions right now.</p>
     </div>
  );

  return (
     <div className="tracker-approvals">
        {pending.map(item => <ApprovalRow key={item.id} item={item} onOpenDetail={onOpenDetail} />)}
     </div>
  );
}

function ApprovalRow({ item, onOpenDetail }: { item: TrackerStyle, onOpenDetail: (id: number) => void }) {
  const queryClient = useQueryClient();
  const eventMutation = useMutation({
     mutationFn: async ({ eventType, reason }: { eventType: string, reason?: string }) => {
        const res = await fetch(`/api/workspace/style-development-tracker/${item.id}/events`, {
           method: 'POST',
           credentials: 'include',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ eventType, reason, occurredAt: new Date().toISOString() })
        });
        if (!res.ok) {
           const err = await res.json().catch(()=>({}));
           throw new Error(err.error || 'Failed to record decision');
        }
        return res.json();
     },
     onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker'] });
     }
  });

  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const onApprove = () => {
    const et = item.waitingDecision === 'sample' ? 'sample_approved' : item.waitingDecision === 'set_sample' ? 'set_sample_approved' : 'order_approved';
    eventMutation.mutate({ eventType: et });
  };

  const onRejectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    const et = item.waitingDecision === 'sample' ? 'sample_rejected' : item.waitingDecision === 'set_sample' ? 'set_sample_rejected' : 'order_rejected';
    eventMutation.mutate({ eventType: et, reason });
  };

  return (
     <div className="tracker-approval-row">
        <div className={`tracker-card-img ${!item.imageUrl ? 'placeholder' : ''}`} style={{ width: 64, height: 86, flexShrink: 0, cursor: 'pointer' }} onClick={() => onOpenDetail(item.id)}>
             {item.imageUrl ? <img src={item.imageUrl} alt={item.styleName} style={{width:'100%', height:'100%', objectFit:'cover', borderRadius:4}} /> : <ImageIcon size={24} />}
        </div>
        <div className="tracker-approval-info" onClick={() => onOpenDetail(item.id)}>
            <div className="tracker-card-subtitle">{item.styleNumber || 'No number'} · {item.targetOrderWeek || 'No week'}</div>
            <div className="tracker-card-title" style={{ fontSize: 16 }}>{item.styleName}</div>
            <div className="tracker-approval-meta">
               Pending: <strong>{item.waitingDecision?.replace('_', ' ').toUpperCase()}</strong> · Waiting {item.workingDaysInStatus} days
            </div>
        </div>
        <div className="tracker-approval-actions">
            {!rejecting ? (
               <>
                  <button className="button" onClick={() => setRejecting(true)} disabled={eventMutation.isPending}>Reject</button>
                  <button className="button button-gold" onClick={onApprove} disabled={eventMutation.isPending}>Approve</button>
               </>
            ) : (
               <form className="tracker-reject-form" onSubmit={onRejectSubmit}>
                  <input type="text" value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for rejection..." required autoFocus />
                  <button type="button" className="button" onClick={() => setRejecting(false)}>Cancel</button>
                  <button type="submit" className="button button-dark" disabled={!reason.trim() || eventMutation.isPending}>Submit Reject</button>
               </form>
            )}
        </div>
        {eventMutation.isError && <div style={{width: '100%', flexBasis: '100%', color: 'var(--coral)', fontSize: 13, marginTop: 4}}>{eventMutation.error instanceof Error ? eventMutation.error.message : 'Error'}</div>}
     </div>
  );
}

function TrackerFabricSelection({ item }: { item: TrackerDetailPayload }) {
  const query = useQuery({
    queryKey: ['workspace', 'style-development-tracker', 'fabric-options'],
    queryFn: async () => {
      const res = await fetch('/api/workspace/style-development-tracker/fabric-options', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load fabrics');
      return res.json() as Promise<FabricOptionsResponse>;
    }
  });

  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (payload: Partial<TrackerDetailPayload>) => {
      const res = await fetch(`/api/workspace/style-development-tracker/${item.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
         const err = await res.json().catch(()=>({}));
         throw new Error(err.error || 'Failed to update details');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', item.id] });
      queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker'] });
         queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', 'reporting'] });
    }
  });

  const [search, setSearch] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  const fabrics = query.data?.groups || [];

  const filteredFabrics = search ? fabrics.map(f => ({
     ...f,
     variants: f.variants.filter(c =>
       f.fabricBaseName.toLowerCase().includes(search.toLowerCase()) ||
       c.productName.toLowerCase().includes(search.toLowerCase()) ||
       c.colour.toLowerCase().includes(search.toLowerCase())
     )
  })).filter(f => f.variants.length > 0) : fabrics;

  const selectColour = (productId: number) => {
    mutation.mutate({ sampleFabricProductId: productId });
    setIsEditing(false);
  };

  return (
    <div className="tracker-fabric-section">
      <div className="tracker-fabric-header">
         <h3>Fabric Allocation</h3>
         {!isEditing && <button className="text-button" onClick={() => setIsEditing(true)}>Change Fabric</button>}
      </div>

      {item.sampleFabricName && !isEditing ? (
         <div className="tracker-fabric-current">
            <div className="fabric-main">
               <div className="fabric-name">{item.sampleFabricName}</div>
               <div className="fabric-col">{item.sampleFabricColour}</div>
               <div className="fabric-metres">{Math.round(item.sampleFabricMetres ?? 0)}m available</div>
            </div>
            <div className="fabric-stats">
               <div className="fabric-stat"><span>Req/Garment</span><strong>{item.categoryMetresPerGarment ?? '-'}m</strong></div>
               <div className="fabric-stat"><span>Yield</span><strong>{item.categoryMetresPerGarment && item.sampleFabricMetres ? Math.floor(item.sampleFabricMetres / item.categoryMetresPerGarment) : '-'} units</strong></div>
               <div className="fabric-stat"><span>Est COGS</span><strong>KES {Math.round(item.indicativeCogsKes ?? 0) || '-'}</strong></div>
               <div className="fabric-stat"><span>COGS %</span><strong>{item.indicativeCogsPct ? `${Math.round(item.indicativeCogsPct)}%` : '-'}</strong></div>
            </div>
            {item.sampleFabricOtherColours && item.sampleFabricOtherColours.length > 0 && (
               <div className="fabric-alts">
                  <span>Other Colours in Stock:</span>
                  <div className="fabric-alts-list">
                     {item.sampleFabricOtherColours.map(oc => (
                        <div key={oc.productId} className="fabric-alt-tag">{oc.colour} ({Math.round(oc.metres)}m)</div>
                     ))}
                  </div>
               </div>
            )}
         </div>
      ) : isEditing ? (
         <div className="tracker-fabric-picker">
            <input type="text" placeholder="Search fabrics or colours..." value={search} onChange={e => setSearch(e.target.value)} autoFocus />
            {query.isLoading ? <div className="picker-msg">Loading fabrics...</div> : (
              <div className="picker-list">
                 {filteredFabrics.map(f => (
                    <div key={f.fabricBaseName} className="picker-group">
                       <div className="picker-group-name">{f.fabricBaseName} <span>{Math.round(f.metres)}m total</span></div>
                       {f.variants.map(c => (
                          <div key={c.productId} className="picker-item" onClick={() => selectColour(c.productId)}>
                             <div className="picker-item-colour">{c.colour}</div>
                             <div className="picker-item-metres">{Math.round(c.metres)}m</div>
                             <div className="picker-item-cost">KES {Math.round(c.costPerMetre)}/m</div>
                          </div>
                       ))}
                    </div>
                 ))}
                 {filteredFabrics.length === 0 && <div className="picker-msg">No fabrics found</div>}
              </div>
            )}
            <button className="button" style={{ marginTop: 8 }} onClick={() => setIsEditing(false)}>Cancel</button>
         </div>
      ) : (
         <div className="tracker-fabric-missing-large">
            <AlertTriangle size={18} />
            <div>
               <strong>No Fabric Allocated</strong>
               <p>Cannot adopt this style without assigning sample fabric.</p>
            </div>
         </div>
      )}
      {mutation.isError && <div style={{color: 'var(--coral)', fontSize: 13, marginTop: 8}}>{mutation.error instanceof Error ? mutation.error.message : 'Update failed'}</div>}
    </div>
  );
}

function TrackerDetailDrawer({ id, patternMakers, designers, reassignmentReasons, onClose }: {
  id: number;
  patternMakers: PatternMakerOption[];
  designers: DesignerOption[];
  reassignmentReasons: ReassignmentReason[];
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['workspace', 'style-development-tracker', id],
    queryFn: async () => {
      const res = await fetch(`/api/workspace/style-development-tracker/${id}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load detail');
      return res.json() as Promise<TrackerDetailPayload>;
    }
  });

  return (
    <div className="tracker-drawer-overlay" onClick={onClose}>
      <div className="tracker-drawer" onClick={e => e.stopPropagation()}>
         <div className="tracker-drawer-header">
           {isLoading ? <h2>Loading...</h2> : (
             <div className="tracker-drawer-header-info">
               <h2>{data?.styleName || 'Style'}</h2>
               <div className="tracker-drawer-header-meta">
                 <span>{data?.styleNumber || 'No number'}</span>
                 <span>·</span>
                 <span>{data?.targetWeeksLabel || data?.targetOrderWeek || 'Unscheduled'}</span>
               </div>
             </div>
           )}
           <button className="tracker-drawer-close" onClick={onClose} aria-label="Back to board">
             <ArrowLeft size={16}/> <span>Back to board</span>
           </button>
         </div>
         <div className="tracker-drawer-content">
            {isLoading ? <div className="tracker-empty-state">Loading details...</div> : error ? <div className="tracker-empty-state">Failed to load details.</div> : data ? (
               <>
                 <div className="tracker-drawer-top-grid">
                    <div className="tracker-drawer-image placeholder">
                        <ImageIcon size={40}/>
                        {data.imageUrl && (
                          <img
                            src={data.imageUrl}
                            alt=""
                            onError={(e) => {
                              e.currentTarget.style.display = 'none';
                            }}
                          />
                        )}
                    </div>
                    <div className="tracker-drawer-facts">
                        <div className="fact-box">
                           <div className="fact-label">Current Stage</div>
                           <div className="fact-val">{data.stage || 'Not started'}</div>
                           {data.stageStartedAt && <div className="fact-sub">Since {new Date(data.stageStartedAt).toLocaleDateString('en-GB')}</div>}
                        </div>
                        <div className="fact-box">
                           <div className="fact-label">Time at Stage</div>
                           <div className={`fact-val ${data.overStandard ? 'warning' : ''}`}>{data.workingDaysAtStage} days</div>
                           {data.standardDays !== null && <div className="fact-sub">Standard: {data.standardDays} days</div>}
                        </div>
                        <div className="fact-box">
                           <div className="fact-label">Current Status</div>
                           <div className="fact-val">{data.status}</div>
                           <div className="fact-sub">{data.workingDaysInStatus} working days{data.statusStartedAt ? ` · since ${new Date(data.statusStartedAt).toLocaleDateString('en-GB')}` : ''}</div>
                        </div>
                        <div className="fact-box">
                           <div className="fact-label">End to End Time</div>
                           <div className="fact-val">{data.actualElapsedWorkingDays ?? 0} days</div>
                           <div className="fact-sub">Standard: {data.standardEndToEndDays ?? 13} days</div>
                           <div className="fact-sub">Target: {data.targetWeeksLabel || '4–5 weeks'}</div>
                        </div>
                        <div className="fact-box">
                           <div className="fact-label">Sample Rounds</div>
                           <div className="fact-val">{data.sampleRounds} <span style={{fontSize: 14, fontWeight: 500}}>(Rej: {data.sampleRejections})</span></div>
                           <div className="fact-sub">Set rounds: {data.setSampleRounds} (Rej: {data.setSampleRejections})</div>
                        </div>
                    </div>
                 </div>

                 {data.intervalMetrics && data.intervalMetrics.length > 0 && (
                    <div className="tracker-drawer-section">
                       <h3>Style Intervals</h3>
                       <table className="tracker-rep-table">
                         <thead><tr><th>Interval</th><th>Standard</th><th>Work</th><th>Queue</th><th>Total</th></tr></thead>
                         <tbody>
                            {data.intervalMetrics.map((int, i) => (
                               <tr key={i}>
                                  <td>{int.key}</td>
                                  <td>{int.standard} days</td>
                                  <td>{int.workWorkingDays ?? '-'}</td>
                                  <td>{int.queueWorkingDays ?? '-'}</td>
                                  <td>{int.totalWorkingDays ?? '-'}</td>
                               </tr>
                            ))}
                         </tbody>
                       </table>
                    </div>
                 )}

                 <div className="tracker-drawer-section">
                     <TrackerFabricSelection item={data} />
                 </div>

                 <div className="tracker-drawer-section">
                     <h3>Log Action</h3>
                     <TrackerEventForm item={data} />
                 </div>

                 <div className="tracker-drawer-section">
                     <h3>Master Details</h3>
                     <TrackerMasterForm item={data} patternMakers={patternMakers} designers={designers} reassignmentReasons={reassignmentReasons} />
                 </div>

                 <div className="tracker-drawer-section">
                     <h3>Add Note</h3>
                     <TrackerNoteForm item={data} />
                 </div>

                 <div className="tracker-drawer-section">
                     <h3>History Timeline</h3>
                     <TrackerHistory history={data.history} />
                 </div>
               </>
            ) : null}
         </div>
      </div>
    </div>
  );
}

function TrackerEventForm({ item }: { item: TrackerDetailPayload }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
     mutationFn: async ({ eventType, reason, occurredAt, overrideReason }: { eventType: string, reason: string, occurredAt: string, overrideReason?: string }) => {
        const res = await fetch(`/api/workspace/style-development-tracker/${item.id}/events`, {
           method: 'POST',
           credentials: 'include',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ eventType, reason, occurredAt, overrideReason })
        });
        if (!res.ok) {
           const err = await res.json().catch(()=>({}));
           throw new Error(err.error || 'Failed to post event');
        }
        return res.json();
     },
     onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', item.id] });
        queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker'] });
     }
  });

  const [eventType, setEventType] = useState('pattern_started');
  const [reason, setReason] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [occurredAt, setOccurredAt] = useState(() => {
     const now = new Date();
     now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
     return now.toISOString().slice(0, 16);
  });

  const isRejected = eventType.includes('rejected');
  const isPatternStarted = eventType === 'pattern_started';
  const adoptionNotReady = Boolean(item.adoptionReadiness && !item.adoptionReadiness.ready);
  const gateActive = Boolean(item.actionGatesEnabled && isPatternStarted && adoptionNotReady);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({ eventType, reason, occurredAt, overrideReason }, {
      onSuccess: () => { setReason(''); setOverrideReason(''); setEventType('pattern_started'); }
    });
  };

  return (
     <form onSubmit={submit} className="tracker-inline-form">
        <div className="tracker-field-grid">
           <label className="tracker-input-wrap">
              <span>Action</span>
              <select value={eventType} onChange={e => setEventType(e.target.value)}>
                 <option value="adopted">Adopted</option>
                 <option value="baseline">Baseline</option>
                 <option value="pattern_started">Pattern Started</option>
                 <option value="pattern_done">Pattern Done</option>
                 <option value="pattern_amendment_started">Pattern Amendment Started</option>
                 <option value="pattern_amendment_done">Pattern Amendment Done</option>
                 <option value="tech_pack_started">Tech Pack Started</option>
                 <option value="tech_pack_done">Tech Pack Done</option>
                 <option value="sample_started">Sample Started</option>
                 <option value="sample_received">Sample Received</option>
                 <option value="resample_started">Resample Started</option>
                 <option value="resample_received">Resample Received</option>
                 <option value="review_started">Review Started</option>
                 <option value="rereview_started">Re-review Started</option>
                 <option value="rereview_done">Re-review Done</option>
                 <option value="sample_approved">Sample Approved</option>
                 <option value="sample_rejected">Sample Rejected</option>
                 <option value="cad_transfer_started">CAD Transfer Started</option>
                 <option value="cad_transfer_done">CAD Transfer Done</option>
                 <option value="cad_grading_started">CAD Grading Started</option>
                 <option value="cad_grading_done">CAD Grading Done</option>
                 <option value="set_sample_order_started">Set Sample Order Started</option>
                 <option value="set_sample_order_created">Set Sample Order Created</option>
                 <option value="set_sample_production_started">Set Sample Production Started</option>
                 <option value="set_sample_production_done">Set Sample Production Done</option>
                 <option value="set_sample_review_started">Set Sample Review Started</option>
                 <option value="set_sample_approved">Set Sample Approved</option>
                 <option value="set_sample_rejected">Set Sample Rejected</option>
                 <option value="order_processing_started">Order Processing Started</option>
                 <option value="order_processing_done">Order Processing Done</option>
                 <option value="order_approved">Order Approved</option>
                 <option value="order_rejected">Order Rejected</option>
              </select>
           </label>
           <label className="tracker-input-wrap">
              <span>When</span>
              <input type="datetime-local" value={occurredAt} onChange={e => setOccurredAt(e.target.value)} required />
           </label>
        </div>
        {isRejected && (
           <label className="tracker-input-wrap">
              <span>Reason{item.actionGatesEnabled ? '' : ' (optional)'}</span>
              <input type="text" value={reason} onChange={e => setReason(e.target.value)} required={Boolean(item.actionGatesEnabled)} />
           </label>
        )}
         {adoptionNotReady && (
            <div className={gateActive ? 'tracker-gate-warning' : 'tracker-readiness-context'}>
              {gateActive && <AlertTriangle size={16} />}
             <div style={{ flex: 1 }}>
                <strong>{gateActive ? 'Adoption Gate: Not Ready' : 'Adoption readiness'}</strong>
                {item.adoptionReadiness?.missing && item.adoptionReadiness.missing.length > 0 && <div className="gate-missing">Still missing: {item.adoptionReadiness.missing.join(', ')}</div>}
                {item.adoptionReadiness?.warnings && item.adoptionReadiness.warnings.length > 0 && <div className="gate-warnings">{gateActive ? 'Warnings' : 'For review'}: {item.adoptionReadiness.warnings.join(', ')}</div>}
                {gateActive && (
                  <label className="tracker-input-wrap" style={{ marginTop: 12 }}>
                    <span>Override Reason</span>
                    <input type="text" value={overrideReason} onChange={e => setOverrideReason(e.target.value)} required placeholder="Why bypass the adoption gate?" />
                  </label>
                )}
             </div>
           </div>
        )}
        {mutation.isError && <div style={{color: 'var(--coral)', fontSize: 13, marginTop: 8}}>{mutation.error instanceof Error ? mutation.error.message : 'Action failed'}</div>}
        <div className="form-actions">
           <button type="submit" className="button button-dark" disabled={mutation.isPending}>Log Action</button>
        </div>
     </form>
  );
}

function TrackerMasterForm({ item, patternMakers, designers, reassignmentReasons }: {
  item: TrackerDetailPayload;
  patternMakers: PatternMakerOption[];
  designers: DesignerOption[];
  reassignmentReasons: ReassignmentReason[];
}) {
  const queryClient = useQueryClient();
  const assignmentChoices = patternMakers.filter(option =>
    option.assignable || (item.isLegacyCadPatternAssignment && option.assignmentKey === item.patternAssignmentKey)
  );
  const mutation = useMutation({
     mutationFn: async (data: Partial<TrackerDetailPayload>) => {
        const res = await fetch(`/api/workspace/style-development-tracker/${item.id}`, {
           method: 'PATCH',
           credentials: 'include',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify(data)
        });
        if (!res.ok) {
           const err = await res.json().catch(()=>({}));
           throw new Error(err.error || 'Failed to update details');
        }
        return res.json();
     },
     onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', item.id] });
        queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker'] });
     }
  });

  const [form, setForm] = useState({
     styleName: item.styleName || '',
     styleNumber: item.styleNumber || '',
      type: item.type || 'NEW',
      tier: item.tier || 'Tier 3',
     category: item.category || '',
     subCategory: item.subCategory || '',
      brand: item.brand || '',
      fabric: item.fabric || '',
       designerUserId: item.designerUserId ? String(item.designerUserId) : '',
       collection: item.collection || '',
       theme: item.theme || '',
       knitOrWoven: (item.knitOrWoven || '') as '' | 'Knit' | 'Woven',
       printOrSolid: (item.printOrSolid || '') as '' | 'Print' | 'Solid',
      patternAssignmentKey: item.patternAssignmentKey || '',
      adoptionDate: item.adoptionDate || '',
      targetOrderWeek: item.targetOrderWeek || '',
      targetLaunchWeek: item.targetLaunchWeek || '',
      sampleApprovalDate: item.sampleApprovalDate || '',
      blocked: item.blocked,
      blockerReason: item.blockerReason || '',
     season: item.season || '',
     intendedSellingPriceKes: item.intendedSellingPriceKes || '',
      patternEffortDays: item.patternEffortDays ?? '',
     exitStatus: item.exitStatus || '',
     exitReason: item.exitReason || '',
     reassignmentReasonCode: reassignmentReasons[0]?.code || '',
     reassignmentNote: '',
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({
       styleName: form.styleName,
       styleNumber: form.styleNumber,
        type: form.type,
        tier: form.tier,
       category: form.category,
       subCategory: form.subCategory,
        brand: form.brand,
        fabric: form.fabric,
        designerUserId: form.designerUserId ? Number(form.designerUserId) : null,
        collection: form.collection,
        theme: form.theme,
        knitOrWoven: form.knitOrWoven || null,
        printOrSolid: form.printOrSolid || null,
        patternAssignmentKey: form.patternAssignmentKey,
        adoptionDate: form.adoptionDate || null,
        targetOrderWeek: form.targetOrderWeek || null,
        targetLaunchWeek: form.targetLaunchWeek || null,
        ...(!item.sampleApprovalDateUnreadable || form.sampleApprovalDate
          ? { sampleApprovalDate: form.sampleApprovalDate || null }
          : {}),
        blocked: form.blocked,
        blockerReason: form.blocked ? form.blockerReason : '',
       season: form.season,
       intendedSellingPriceKes: form.intendedSellingPriceKes ? Number(form.intendedSellingPriceKes) : null,
        patternEffortDays: form.patternEffortDays ? Number(form.patternEffortDays) : null,
       exitStatus: form.exitStatus,
       exitReason: form.exitReason,
       reassignmentReasonCode: form.reassignmentReasonCode,
       reassignmentNote: form.reassignmentNote,
    });
  };

  return (
     <form onSubmit={submit} className="tracker-inline-form">
        <div className="tracker-field-grid">
           <label className="tracker-input-wrap">
              <span>Style Name</span>
              <input type="text" value={form.styleName} onChange={e => setForm({...form, styleName: e.target.value})} required />
           </label>
           <label className="tracker-input-wrap">
              <span>Style Number</span>
              <input type="text" value={form.styleNumber} onChange={e => setForm({...form, styleNumber: e.target.value})} />
           </label>
            <label className="tracker-input-wrap">
               <span>Type</span>
               <select value={form.type} onChange={e => setForm({...form, type: e.target.value as TrackerStyle['type']})}>
                  <option value="NEW">NEW</option>
                  <option value="RR">RR</option>
               </select>
            </label>
            <label className="tracker-input-wrap">
               <span>Tier</span>
               <select value={form.tier} onChange={e => setForm({...form, tier: e.target.value as TrackerStyle['tier']})}>
                  <option value="Tier 3">Tier 3</option>
                  <option value="Tier 4">Tier 4</option>
               </select>
            </label>
           <label className="tracker-input-wrap">
              <span>Category</span>
              <input type="text" value={form.category} onChange={e => setForm({...form, category: e.target.value})} required />
           </label>
           <label className="tracker-input-wrap">
              <span>Sub-Category</span>
              <input type="text" value={form.subCategory} onChange={e => setForm({...form, subCategory: e.target.value})} required />
           </label>
            <label className="tracker-input-wrap">
               <span>Brand</span>
               <select value={form.brand} onChange={e => setForm({...form, brand: e.target.value})}>
                  <option value="">Select...</option>
                  <option value="Vivo">Vivo</option>
                  <option value="Safari by Vivo">Safari by Vivo</option>
                  <option value="Zoya">Zoya</option>
               </select>
            </label>
            <label className="tracker-input-wrap">
               <span>Fabric Description</span>
               <input type="text" value={form.fabric} onChange={e => setForm({...form, fabric: e.target.value})} />
            </label>
             <label className="tracker-input-wrap">
                <span>Designer</span>
                <select value={form.designerUserId} onChange={e => setForm({...form, designerUserId: e.target.value})}>
                  <option value="">Unassigned</option>
                  {designers.map(designer => (
                    <option key={designer.id} value={designer.id} disabled={!designer.assignable && designer.id !== item.designerUserId}>
                      {designer.name}{!designer.assignable ? ' · former team member' : designer.unavailableNow ? ' · unavailable' : ''}
                    </option>
                  ))}
                </select>
             </label>
             <label className="tracker-input-wrap">
                <span>Collection</span>
                <input type="text" value={form.collection} onChange={e => setForm({...form, collection: e.target.value})} placeholder="e.g. Weekend in Lamu" />
             </label>
             <label className="tracker-input-wrap">
                <span>Theme</span>
                <input type="text" value={form.theme} onChange={e => setForm({...form, theme: e.target.value})} placeholder="Story, occasion or capsule" />
             </label>
             <label className="tracker-input-wrap">
                <span>Knit or woven</span>
                <select value={form.knitOrWoven} onChange={e => setForm({...form, knitOrWoven: e.target.value as '' | 'Knit' | 'Woven'})}>
                  <option value="">Unassigned</option><option value="Knit">Knit</option><option value="Woven">Woven</option>
                </select>
             </label>
             <label className="tracker-input-wrap">
                <span>Print or solid</span>
                <select value={form.printOrSolid} onChange={e => setForm({...form, printOrSolid: e.target.value as '' | 'Print' | 'Solid'})}>
                  <option value="">Unassigned</option><option value="Print">Print</option><option value="Solid">Solid</option>
                </select>
             </label>
            <label className="tracker-input-wrap">
               <span>Pattern Maker</span>
                <select value={form.patternAssignmentKey} onChange={e => setForm({...form, patternAssignmentKey: e.target.value})}>
                  <option value="">Unassigned</option>
                  {assignmentChoices.map(option => <option key={option.assignmentKey} value={option.assignmentKey}>{option.name} · {option.load}{option.assignmentKey !== form.patternAssignmentKey ? ` → ${option.load + 1}` : ''}</option>)}
                </select>
            </label>
             <label className="tracker-input-wrap">
                <span>Estimated Pattern Effort (days)</span>
                <input
                  type="number"
                  min="0.5"
                  max="20"
                  step="0.5"
                  value={form.patternEffortDays}
                  onChange={e => setForm({...form, patternEffortDays: e.target.value})}
                  placeholder="2 day standard"
                />
             </label>
            {form.patternAssignmentKey !== (item.patternAssignmentKey || '') && (
              <>
                <label className="tracker-input-wrap">
                  <span>Reassignment Reason</span>
                  <select value={form.reassignmentReasonCode} onChange={e => setForm({...form, reassignmentReasonCode: e.target.value})} required>
                    <optgroup label="Resourcing reasons">
                      {reassignmentReasons.filter(reason => reason.category === 'operational').map(reason => <option key={reason.id} value={reason.code}>{reason.label}</option>)}
                    </optgroup>
                    <optgroup label="Style-related reasons">
                      {reassignmentReasons.filter(reason => reason.category === 'style').map(reason => <option key={reason.id} value={reason.code}>{reason.label}</option>)}
                    </optgroup>
                  </select>
                </label>
                <label className="tracker-input-wrap tracker-field-wide">
                  <span>Reassignment Note (optional)</span>
                  <input value={form.reassignmentNote} onChange={e => setForm({...form, reassignmentNote: e.target.value})} maxLength={500} placeholder="Add context for this handoff…" />
                </label>
              </>
            )}
           <label className="tracker-input-wrap">
              <span>Season</span>
              <select value={form.season} onChange={e => setForm({...form, season: e.target.value})}>
                 <option value="">Select...</option>
                 <option value="High Summer">High Summer</option>
                 <option value="Pre-Fall">Pre-Fall</option>
                 <option value="Autumn Winter">Autumn Winter</option>
                 <option value="Holiday">Holiday</option>
              </select>
           </label>
           <label className="tracker-input-wrap">
              <span>Intended Price (KES)</span>
              <input type="number" value={form.intendedSellingPriceKes} onChange={e => setForm({...form, intendedSellingPriceKes: e.target.value})} />
           </label>
            <label className="tracker-input-wrap">
               <span>Adoption Date</span>
               <input type="date" value={form.adoptionDate} onChange={e => setForm({...form, adoptionDate: e.target.value})} />
            </label>
            <label className="tracker-input-wrap">
               <span>Target Order Week</span>
               <input type="text" value={form.targetOrderWeek} onChange={e => setForm({...form, targetOrderWeek: e.target.value})} placeholder="e.g. 2026-W36" />
            </label>
            <label className="tracker-input-wrap">
               <span>Target Launch Week</span>
               <input type="text" value={form.targetLaunchWeek} onChange={e => setForm({...form, targetLaunchWeek: e.target.value})} placeholder="e.g. 2026-W40" />
            </label>
             <label className="tracker-input-wrap">
                <span>Launch Month</span>
                <input type="text" value={item.launchMonth || 'Derived from target launch week'} readOnly />
             </label>
            <label className="tracker-input-wrap">
               <span>Sample Approval Date</span>
               <input type="date" value={form.sampleApprovalDate} onChange={e => setForm({...form, sampleApprovalDate: e.target.value})} />
                {item.sampleApprovalDateUnreadable && !form.sampleApprovalDate && (
                  <small className="tracker-date-warning">
                    Saved value “{item.sampleApprovalDateUnreadable}” is unreadable. Choose a valid date to replace it.
                  </small>
                )}
            </label>
        </div>

        <div className="tracker-field-grid" style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #d8d0c2' }}>
            <label className="tracker-input-wrap">
               <span>Blocker</span>
               <select value={form.blocked ? 'yes' : 'no'} onChange={e => setForm({...form, blocked: e.target.value === 'yes'})}>
                  <option value="no">Not blocked</option>
                  <option value="yes">Blocked</option>
               </select>
            </label>
            <label className="tracker-input-wrap">
               <span>Blocker Reason</span>
               <input type="text" value={form.blockerReason} onChange={e => setForm({...form, blockerReason: e.target.value})} disabled={!form.blocked} required={form.blocked} />
            </label>
           <label className="tracker-input-wrap">
              <span>Exit Status</span>
              <select value={form.exitStatus} onChange={e => setForm({...form, exitStatus: e.target.value})}>
                 <option value="active">Active</option>
                 <option value="cancelled">Cancelled</option>
                 <option value="on_hold">On Hold</option>
              </select>
           </label>
           <label className="tracker-input-wrap">
              <span>Exit Reason</span>
              <select value={form.exitReason} onChange={e => setForm({...form, exitReason: e.target.value})} disabled={!form.exitStatus || form.exitStatus === 'active'}>
                 <option value="">None</option>
                 <option value="pattern will not work">Pattern will not work</option>
                 <option value="wrong for the season">Wrong for the season</option>
                 <option value="no fabric in stock">No fabric in stock</option>
                 <option value="margin too high">Margin too high</option>
              </select>
           </label>
        </div>

        {mutation.isError && <div className="tracker-assignment-error" style={{ marginTop: 8 }} role="alert">{mutation.error instanceof Error ? mutation.error.message : 'Master Details could not be saved. Your edits are still here.'}</div>}

        <div className="form-actions">
           <button type="submit" className="button button-dark" disabled={mutation.isPending}>Save Master Details</button>
        </div>
     </form>
  );
}

function TrackerNoteForm({ item }: { item: TrackerDetailPayload }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
     mutationFn: async (note: string) => {
        const res = await fetch(`/api/workspace/style-development-tracker/${item.id}/notes`, {
           method: 'POST',
           credentials: 'include',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ note })
        });
        if (!res.ok) {
           const err = await res.json().catch(()=>({}));
           throw new Error(err.error || 'Failed to post note');
        }
        return res.json();
     },
     onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['workspace', 'style-development-tracker', item.id] });
     }
  });

  const [note, setNote] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    mutation.mutate(note, { onSuccess: () => setNote('') });
  };

  return (
     <form onSubmit={submit} className="tracker-note-form">
        <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Type a note..." rows={3} required />
        {mutation.isError && <div style={{color: 'var(--coral)', fontSize: 13, width: '100%', textAlign: 'left'}}>{mutation.error instanceof Error ? mutation.error.message : 'Note failed'}</div>}
        <button type="submit" className="button" disabled={mutation.isPending || !note.trim()}>Add Note</button>
     </form>
  );
}

function TrackerHistory({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) return <div className="tracker-empty-state">No history yet.</div>;
  return (
     <div className="tracker-history">
        {history.map(h => (
           <div key={h.id} className="tracker-history-item">
              <div className="tracker-history-meta">
                 <strong>{h.recordedBy}</strong> on {new Date(h.occurredAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
              </div>
              <div className="tracker-history-body">
                 {h.entryType === 'event' && <div>Recorded <strong>{h.eventType?.replace('_', ' ').toUpperCase()}</strong></div>}
                  {h.entryType === 'event' && h.outcome && <div className="note-text">Stage: {h.outcome}</div>}
                  {h.entryType === 'update' && <div>Updated <span className="tracker-history-change">{h.oldValue} → {h.newValue}</span></div>}
                  {h.entryType === 'pattern_maker_changed' && (
                    <div>
                      Reassigned pattern maker <span className="tracker-history-change">{h.oldValue || 'Unassigned'} → {h.newValue || 'Unassigned'}</span>
                      {h.reassignmentReasonLabel && <span className={`history-reassignment-reason ${h.reassignmentReasonCategory || ''}`}>{h.reassignmentReasonLabel}</span>}
                    </div>
                  )}
                 {h.reason && <div className="note-text">Reason: {h.reason}</div>}
                 {h.note && <div className="note-text">{h.note}</div>}
              </div>
           </div>
        ))}
     </div>
  );
}
