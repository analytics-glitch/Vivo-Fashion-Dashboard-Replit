import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, List, CheckSquare, Clock, AlertTriangle, Ban, Image as ImageIcon, Search, X, CheckCircle, BarChart2, Users } from 'lucide-react';

type TrackerStyle = {
  id: number;
  styleNumber: string | null;
  originalStyleNumber: string | null;
  styleNumberStatus: 'needs_number' | 'malformed' | 'confirmed';
  styleName: string;
  type: 'NEW' | 'RR';
  tier: 'Tier 3' | 'Tier 4';
  status: string;
  category: string;
  subCategory: string;
  originalSubCategory: string;
  brand: string;
  fabric: string;
  patternMaker: string | null;
  adoptionDate: string | null;
  targetOrderWeek: string | null;
  targetLaunchWeek: string | null;
  sampleApprovalDate: string | null;
  dataQualityFlags: string[];
  blocked: boolean;
  blockerReason: string | null;
  stage: string | null;
  stageStartedAt: string | null;
  workingDaysAtStage: number;
  standardDays: number | null;
  overStandard: boolean;
  sampleRounds: number;
  setSampleRounds: number;
  sampleRejections: number;
  setSampleRejections: number;
  rejectedMoreThanOnce: boolean;
  waitingDecision: 'sample' | 'set_sample' | 'order' | null;
  historyCount: number;
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
  categoryMetresPerGarment?: number | null;
  adoptionReadiness?: { ready: boolean; missing: string[]; warnings: string[] };
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
  entryType: 'event' | 'note' | 'update';
  eventType: string | null;
  outcome: string | null;
  note: string | null;
  reason: string | null;
  oldValue: string | null;
  newValue: string | null;
  occurredAt: string;
  recordedAt: string;
  recordedBy: string;
};

type TrackerDetailPayload = TrackerStyle & { history: HistoryEntry[] };

type TrackerPayload = {
  items: TrackerStyle[];
  stages: string[];
  stageStandards: Record<string, number>;
  facets: {
    targetOrderWeek: string[];
    subCategory: string[];
    category: string[];
    brand: string[];
    type: string[];
    tier: string[];
    patternMaker: string[];
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
    makers: number;
    daysPerPattern: number;
    weeklyCapacity: number;
    monthlyCapacity: number;
    queueDepth: number;
    readyToStart: number;
    activePatternWork: number;
    weeksCover: number;
    patternsPerMaker: number;
    adoptedPerWeek: number;
    targetAdoptionsPerWeek: number;
    monthlyGap: number;
    byPatternMaker: { patternMaker: string; load: number }[];
  };
};

async function loadTracker(): Promise<TrackerPayload> {
  const response = await fetch('/api/workspace/style-development-tracker', { credentials: 'include' });
  if (!response.ok) throw new Error(`Could not load the Product Development Tracker (${response.status})`);
  return response.json();
}

function targetWeekNumber(value: string | null): number | null {
  const match = value?.match(/^WK\s*(\d+)$/i);
  return match ? Number(match[1]) : null;
}

export default function StyleDevelopmentTrackerPage() {
  const tracker = useQuery({ queryKey: ['workspace', 'style-development-tracker'], queryFn: loadTracker });
  const [view, setView] = useState<'board' | 'list' | 'approvals' | 'standards' | 'capacity'>('board');
  const [search, setSearch] = useState('');

  const [filters, setFilters] = useState({
    stage: 'All',
    targetOrderWeek: 'All',
    category: 'All',
    subCategory: 'All',
    brand: 'All',
    type: 'All',
    tier: 'All',
    patternMaker: 'All',
    status: 'All',
    blocked: 'All',
  });

  const [groupBy, setGroupBy] = useState<'stage' | 'targetOrderWeek' | 'category' | 'subCategory' | 'brand' | 'type' | 'patternMaker' | 'status'>('stage');
  const [sortField, setSortField] = useState<keyof TrackerStyle>('targetOrderWeek');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const [detailId, setDetailId] = useState<number | null>(null);

  const items = tracker.data?.items ?? [];
  const stages = tracker.data?.stages ?? [];

  const facets = tracker.data?.facets ?? {
    targetOrderWeek: Array.from(new Set(items.map(s => s.targetOrderWeek).filter(Boolean))) as string[],
    subCategory: Array.from(new Set(items.map(s => s.subCategory).filter(Boolean))) as string[],
    category: Array.from(new Set(items.map(s => s.category).filter(Boolean))) as string[],
    brand: Array.from(new Set(items.map(s => s.brand).filter(Boolean))) as string[],
    type: Array.from(new Set(items.map(s => s.type).filter(Boolean))) as string[],
    tier: Array.from(new Set(items.map(s => s.tier).filter(Boolean))) as string[],
    patternMaker: Array.from(new Set(items.map(s => s.patternMaker).filter(Boolean))) as string[],
    status: Array.from(new Set(items.map(s => s.status).filter(Boolean))) as string[],
  };

  const filtered = useMemo(() => {
    return items.filter(style => {
      const searchStr = `${style.styleNumber || ''} ${style.styleName} ${style.fabric || ''} ${style.sampleFabricName || ''} ${style.sampleFabricColour || ''}`.toLowerCase();
      const matchSearch = search ? searchStr.includes(search.toLowerCase()) : true;
      const matchStage = filters.stage === 'All' || style.stage === filters.stage;
      const matchWeek = filters.targetOrderWeek === 'All' || style.targetOrderWeek === filters.targetOrderWeek;
      const matchCategory = filters.category === 'All' || style.category === filters.category;
      const matchSubCategory = filters.subCategory === 'All' || style.subCategory === filters.subCategory;
      const matchBrand = filters.brand === 'All' || style.brand === filters.brand;
      const matchType = filters.type === 'All' || style.type === filters.type;
      const matchTier = filters.tier === 'All' || style.tier === filters.tier;
      const matchPatternMaker = filters.patternMaker === 'All' || style.patternMaker === filters.patternMaker;
      const matchStatus = filters.status === 'All' || style.status === filters.status;
      const matchBlocked = filters.blocked === 'All' || (filters.blocked === 'Blocked' ? style.blocked : !style.blocked);

      return matchSearch && matchStage && matchWeek && matchCategory && matchSubCategory && matchBrand && matchType && matchTier && matchPatternMaker && matchStatus && matchBlocked;
    });
  }, [items, search, filters]);

  const grouped = useMemo(() => {
    const values = new Map<string, TrackerStyle[]>();
    for (const style of filtered) {
      const key = String((style as any)[groupBy] || (groupBy === 'stage' ? 'Unassigned' : 'Unknown'));
      values.set(key, [...(values.get(key) ?? []), style]);
    }
    const entries = Array.from(values.entries());

    if (groupBy === 'stage') {
       entries.sort(([a], [b]) => {
          const ia = stages.indexOf(a);
          const ib = stages.indexOf(b);
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
    } else {
       entries.sort(([a], [b]) => a.localeCompare(b));
    }
    return entries;
  }, [filtered, groupBy, stages]);

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
      type: 'All', tier: 'All', patternMaker: 'All', status: 'All', blocked: 'All',
    });
  };

  if (tracker.isLoading) return <section className="page tracker-page"><div className="tracker-empty-state">Loading workspace tracker...</div></section>;
  if (tracker.isError) return <section className="page tracker-page"><div className="tracker-empty-state"><AlertTriangle size={24} color="var(--coral)"/><h3>Style Development Unavailable</h3><p>{tracker.error instanceof Error ? tracker.error.message : 'Could not load data'}</p><button className="button button-dark" onClick={() => tracker.refetch()}>Retry</button></div></section>;

  const pendingApprovalsCount = items.filter(i => i.waitingDecision !== null).length;

  return (
    <section className="page tracker-page">
      <header className="tracker-header-row">
        <div className="tracker-header-left">
           <span className="tracker-kicker">Product Development Tracker / Q3 2026</span>
           <h1>Style development</h1>
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
              {facets.patternMaker?.map(f => <option key={f} value={f}>{f}</option>)}
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
            <label>Group By</label>
            <select value={groupBy} onChange={e => setGroupBy(e.target.value as any)}>
              <option value="stage">Stage</option>
              <option value="targetOrderWeek">Target Week</option>
              <option value="subCategory">Sub-category</option>
              <option value="category">Category</option>
              <option value="brand">Brand</option>
              <option value="type">Type</option>
              <option value="patternMaker">Pattern Maker</option>
              <option value="status">Status</option>
            </select>
          </div>
        </div>
      )}

      {view === 'board' && (
        <div className="tracker-board">
          {grouped.length === 0 && <div className="tracker-empty-state" style={{ width: '100%' }}>No styles match filters.</div>}
          {grouped.map(([label, styles]) => (
            <div key={label} className="tracker-col">
              <div className="tracker-col-header">
                <h3>{label}</h3>
                <span className="tracker-col-count">{styles.length}</span>
              </div>
              <div className="tracker-col-cards">
                {styles.map(s => (
                  <div key={s.id} className="tracker-card" onClick={() => setDetailId(s.id)}>
                    <div className="tracker-card-head">
                      <div className={`tracker-card-img ${!s.imageUrl ? 'placeholder' : ''}`}>
                         {s.imageUrl ? <img src={s.imageUrl} alt={s.styleName} /> : <ImageIcon size={20} />}
                      </div>
                      <div className="tracker-card-info">
                         <div className="tracker-card-title">{s.styleName}</div>
                         <div className="tracker-card-subtitle">{s.styleNumber || 'No number'} · {s.targetOrderWeek || 'No week'}</div>
                         <div className="tracker-card-badges">
                            {s.blocked && <span className="tracker-badge blocked"><Ban size={10}/> Blocked</span>}
                            {s.overStandard && <span className="tracker-badge warning"><Clock size={10}/> Over Std</span>}
                            {s.rejectedMoreThanOnce && <span className="tracker-badge warning"><AlertTriangle size={10}/> {s.sampleRejections + s.setSampleRejections} Rej</span>}
                            {s.waitingDecision && <span className="tracker-badge highlight"><CheckCircle size={10}/> Action Req</span>}
                         </div>
                      </div>
                    </div>
                    <div className="tracker-card-fabric" style={{ marginTop: 2 }}>
                       {s.sampleFabricName ? (
                          <div className="tracker-fabric-present">
                             <span>{s.sampleFabricName}</span>
                             <strong>{s.sampleFabricColour}</strong>
                             {(!s.sampleFabricMetres || s.sampleFabricMetres <= 0) && <span style={{color: 'var(--coral)', marginLeft: 'auto', fontWeight: 600, fontSize: 10}}>0m / no stock</span>}
                          </div>
                       ) : (
                          <div className="tracker-fabric-missing">Unassigned</div>
                       )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'list' && (
        <div className="tracker-table-scroll">
          {sortedForList.length === 0 && <div className="tracker-empty-state">No styles match filters.</div>}
          {sortedForList.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th onClick={() => handleSort('styleNumber')}>Style # {sortField === 'styleNumber' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('styleName')}>Style Name {sortField === 'styleName' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('sampleFabricName')}>Fabric {sortField === 'sampleFabricName' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('stage')}>Stage {sortField === 'stage' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('targetOrderWeek')}>Target Wk {sortField === 'targetOrderWeek' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('category')}>Category {sortField === 'category' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                  <th onClick={() => handleSort('status')}>Status {sortField === 'status' && (sortDir === 'asc' ? '↑' : '↓')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedForList.map(s => (
                  <tr key={s.id} onClick={() => setDetailId(s.id)}>
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
                    <td>{s.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {view === 'approvals' && (
        <TrackerApprovals items={items} onOpenDetail={setDetailId} />
      )}

      {view === 'standards' && (
        <TrackerStandards />
      )}

      {view === 'capacity' && (
        <TrackerCapacity />
      )}

      {detailId && <TrackerDetailDrawer id={detailId} onClose={() => setDetailId(null)} />}
    </section>
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

function TrackerCapacity() {
  const query = useQuery({
    queryKey: ['workspace', 'style-development-tracker', 'reporting'],
    queryFn: async () => {
      const res = await fetch('/api/workspace/style-development-tracker/reporting', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load reporting');
      return res.json() as Promise<ReportingPayload>;
    }
  });

  if (query.isLoading) return <div className="tracker-empty-state">Loading capacity...</div>;
  if (query.isError) return <div className="tracker-empty-state"><AlertTriangle size={24} color="var(--coral)"/><h3>Capacity Unavailable</h3><p>{query.error instanceof Error ? query.error.message : 'Could not load data'}</p></div>;

  const data = query.data?.capacity;
  if (!data) return null;

  return (
    <div className="tracker-capacity">
      <div className="cap-kpi-row">
         <div className="cap-kpi"><span>Pattern Makers</span><strong>{data.makers}</strong></div>
         <div className="cap-kpi"><span>Weekly Capacity</span><strong>{data.weeklyCapacity} styles</strong></div>
         <div className="cap-kpi"><span>Monthly Capacity</span><strong>{data.monthlyCapacity} styles</strong></div>
         <div className="cap-kpi"><span>Target Adoptions</span><strong>{data.targetAdoptionsPerWeek} / wk</strong></div>
      </div>
      <div className="cap-kpi-row alternate">
         <div className="cap-kpi"><span>Queue Depth</span><strong>{data.queueDepth} styles</strong></div>
         <div className="cap-kpi"><span>Weeks Cover</span><strong>{Number(data.weeksCover).toFixed(1)} wks</strong></div>
         <div className="cap-kpi"><span>Actual Adoptions</span><strong>{Number(data.adoptedPerWeek).toFixed(1)} / wk</strong></div>
         <div className="cap-kpi"><span>Monthly Gap</span><strong className={data.monthlyGap < 0 ? 'negative' : 'positive'}>{data.monthlyGap > 0 ? '+' : ''}{Number(data.monthlyGap).toFixed(1)} styles</strong></div>
      </div>

      <div className="tracker-rep-card" style={{ marginTop: 24 }}>
         <h3>Load by Pattern Maker</h3>
         <table className="tracker-rep-table">
           <thead><tr><th>Maker</th><th>Load</th><th>Utilization</th></tr></thead>
           <tbody>
              {data.byPatternMaker?.map((pm, i) => (
                <tr key={i}>
                  <td>{pm.patternMaker}</td>
                  <td>{pm.load}</td>
                  <td>
                    <div className="cap-util-bar">
                      <div className="cap-util-fill" style={{ width: `${Math.min(100, (pm.load / 5) * 100)}%`, background: (pm.load / 5) * 100 > 90 ? 'var(--coral)' : '#C9A96E' }} />
                      <span>{Math.round((pm.load / 5) * 100)}%</span>
                    </div>
                  </td>
                </tr>
              ))}
           </tbody>
         </table>
      </div>
    </div>
  );
}

function TrackerApprovals({ items, onOpenDetail }: { items: TrackerStyle[], onOpenDetail: (id: number) => void }) {
  const pending = items.filter(i => i.waitingDecision !== null)
    .sort((a, b) => new Date(a.stageStartedAt || 0).getTime() - new Date(b.stageStartedAt || 0).getTime());

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
               Pending: <strong>{item.waitingDecision?.replace('_', ' ').toUpperCase()}</strong> · Waiting {item.workingDaysAtStage} days
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

function TrackerDetailDrawer({ id, onClose }: { id: number, onClose: () => void }) {
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
           <button className="tracker-drawer-close" onClick={onClose}><X size={18}/></button>
         </div>
         <div className="tracker-drawer-content">
            {isLoading ? <div className="tracker-empty-state">Loading details...</div> : error ? <div className="tracker-empty-state">Failed to load details.</div> : data ? (
               <>
                 <div className="tracker-drawer-top-grid">
                    <div className="tracker-drawer-image">
                        {data.imageUrl ? <img src={data.imageUrl} alt={data.styleName} /> : <div className="placeholder"><ImageIcon size={40}/></div>}
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
                     <TrackerMasterForm item={data} />
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

  const requiresReason = eventType.includes('rejected');
  const isPatternStarted = eventType === 'pattern_started';
  const showOverride = isPatternStarted && item.adoptionReadiness && !item.adoptionReadiness.ready;

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
        {requiresReason && (
           <label className="tracker-input-wrap">
              <span>Reason</span>
              <input type="text" value={reason} onChange={e => setReason(e.target.value)} required />
           </label>
        )}
        {showOverride && (
           <div className="tracker-gate-warning">
             <AlertTriangle size={16} />
             <div style={{ flex: 1 }}>
               <strong>Adoption Gate: Not Ready</strong>
               {item.adoptionReadiness?.missing && item.adoptionReadiness.missing.length > 0 && <div className="gate-missing">Missing: {item.adoptionReadiness.missing.join(', ')}</div>}
               {item.adoptionReadiness?.warnings && item.adoptionReadiness.warnings.length > 0 && <div className="gate-warnings">Warnings: {item.adoptionReadiness.warnings.join(', ')}</div>}

               <label className="tracker-input-wrap" style={{ marginTop: 12 }}>
                 <span>Override Reason</span>
                 <input type="text" value={overrideReason} onChange={e => setOverrideReason(e.target.value)} required placeholder="Why bypass the adoption gate?" />
               </label>
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

function TrackerMasterForm({ item }: { item: TrackerDetailPayload }) {
  const queryClient = useQueryClient();
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
     category: item.category || '',
     subCategory: item.subCategory || '',
     season: item.season || '',
     intendedSellingPriceKes: item.intendedSellingPriceKes || '',
     exitStatus: item.exitStatus || '',
     exitReason: item.exitReason || '',
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({
       styleName: form.styleName,
       styleNumber: form.styleNumber,
       category: form.category,
       subCategory: form.subCategory,
       season: form.season,
       intendedSellingPriceKes: form.intendedSellingPriceKes ? Number(form.intendedSellingPriceKes) : null,
       exitStatus: form.exitStatus,
       exitReason: form.exitReason,
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
              <span>Category</span>
              <input type="text" value={form.category} onChange={e => setForm({...form, category: e.target.value})} required />
           </label>
           <label className="tracker-input-wrap">
              <span>Sub-Category</span>
              <input type="text" value={form.subCategory} onChange={e => setForm({...form, subCategory: e.target.value})} required />
           </label>
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
        </div>

        <div className="tracker-field-grid" style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #d8d0c2' }}>
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

        {mutation.isError && <div style={{color: 'var(--coral)', fontSize: 13, marginTop: 8}}>{mutation.error instanceof Error ? mutation.error.message : 'Update failed'}</div>}

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
                 {h.entryType === 'update' && <div>Updated <span className="tracker-history-change">{h.oldValue} → {h.newValue}</span></div>}
                 {h.reason && <div className="note-text">Reason: {h.reason}</div>}
                 {h.note && <div className="note-text">{h.note}</div>}
              </div>
           </div>
        ))}
     </div>
  );
}
