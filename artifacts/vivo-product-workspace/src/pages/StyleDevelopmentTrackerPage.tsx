import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarRange, Filter, Search, Sparkles } from 'lucide-react';

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
  targetOrderWeek: string | null;
  fabric: string;
  sampleApprovalDate: string | null;
  dataQualityFlags: string[];
};

type TrackerPayload = {
  items: TrackerStyle[];
  summaries: Array<{ targetOrderWeek: string | null; styleCount: number; newCount: number }>;
  weeks: string[];
  statuses: string[];
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
  const [week, setWeek] = useState('All weeks');
  const [status, setStatus] = useState('All statuses');
  const [subCategory, setSubCategory] = useState('All sub-categories');
  const [type, setType] = useState('All types');
  const [groupBy, setGroupBy] = useState<'week' | 'status' | 'subCategory' | 'type'>('week');
  const [search, setSearch] = useState('');
  const items = tracker.data?.items ?? [];
  const subCategories = Array.from(new Set(items.map((style) => style.subCategory))).sort();
  const types = Array.from(new Set(items.map((style) => style.type))).sort();
  const hasUnscheduled = items.some((style) => !style.targetOrderWeek);
  const loadedWeekNumbers = new Set(items.map((style) => targetWeekNumber(style.targetOrderWeek)).filter((value): value is number => value !== null));
  const filtered = useMemo(() => items.filter((style) => {
    const needle = search.trim().toLowerCase();
    return (week === 'All weeks'
      || (week === 'Unscheduled' && !style.targetOrderWeek)
      || style.targetOrderWeek === week)
      && (status === 'All statuses' || style.status === status)
      && (subCategory === 'All sub-categories' || style.subCategory === subCategory)
      && (type === 'All types' || style.type === type)
      && (!needle || `${style.styleNumber ?? ''} ${style.styleName} ${style.category} ${style.subCategory} ${style.fabric}`.toLowerCase().includes(needle));
  }), [items, search, status, subCategory, type, week]);
  const grouped = useMemo(() => {
    const values = new Map<string, TrackerStyle[]>();
    for (const style of filtered) {
      const key = groupBy === 'week'
        ? (style.targetOrderWeek ?? 'Unscheduled')
        : groupBy === 'status' ? style.status
          : groupBy === 'subCategory' ? style.subCategory
            : style.type;
      values.set(key, [...(values.get(key) ?? []), style]);
    }
    return Array.from(values.entries()).sort(([left], [right]) => {
      if (groupBy !== 'week') return left.localeCompare(right, undefined, { numeric: true });
      if (left === 'Unscheduled') return 1;
      if (right === 'Unscheduled') return -1;
      return (targetWeekNumber(left) ?? Number.MAX_SAFE_INTEGER) - (targetWeekNumber(right) ?? Number.MAX_SAFE_INTEGER)
        || left.localeCompare(right);
    });
  }, [filtered, groupBy]);

  if (tracker.isLoading) return <section className="page tracker-page"><div className="tracker-loading">Loading the current Q3 tracker…</div></section>;
  if (tracker.isError) return <section className="page tracker-page"><div className="tracker-error"><AlertTriangle size={20} /><h2>Style Development is unavailable</h2><p>{tracker.error instanceof Error ? tracker.error.message : 'The tracker could not be loaded.'}</p><button onClick={() => tracker.refetch()}>Try again</button></div></section>;

  return <section className="page tracker-page">
    <header className="tracker-hero">
      <div><span className="tracker-kicker">Product Development Tracker / Q3 2026</span><h1>Style development</h1><p>Current Q3 2026 development pipeline before styles are ordered. Unscheduled styles are shown explicitly.</p></div>
      <div className="tracker-hero-count"><strong>{items.length}</strong><span>styles loaded</span><small>{items.filter((item) => item.type === 'NEW').length} NEW · {items.filter((item) => item.type === 'RR').length} RR</small></div>
    </header>

    <section className="tracker-week-summary" aria-label="Target order week summary">
      {(tracker.data?.summaries ?? []).map((summary) => {
        const summaryWeek = summary.targetOrderWeek ?? 'Unscheduled';
        return <button key={summaryWeek} className={week === summaryWeek ? 'active' : ''} onClick={() => setWeek(week === summaryWeek ? 'All weeks' : summaryWeek)}>
        <span><CalendarRange size={14} /> {summaryWeek}</span>
        <strong>{summary.styleCount} styles</strong>
        <small>{summary.newCount} NEW · {summary.styleCount - summary.newCount} RR</small>
      </button>;
      })}
      {[36, 37, 38, 39, 40, 41, 42].filter((number) => !loadedWeekNumbers.has(number)).map((number) => <div className="pending" key={number}><span>WK{number}</span><strong>Pending</strong><small>Next import batch</small></div>)}
    </section>

    <div className="tracker-toolbar">
      <label className="tracker-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search number, style, category or fabric" /></label>
      <label><Filter size={14} /><span>Week</span><select value={week} onChange={(event) => setWeek(event.target.value)}><option>All weeks</option>{tracker.data?.weeks.map((value) => <option key={value}>{value}</option>)}{hasUnscheduled && <option value="Unscheduled">Unscheduled</option>}</select></label>
      <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option>All statuses</option>{tracker.data?.statuses.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label><span>Sub-category</span><select value={subCategory} onChange={(event) => setSubCategory(event.target.value)}><option>All sub-categories</option>{subCategories.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label><span>Type</span><select value={type} onChange={(event) => setType(event.target.value)}><option>All types</option>{types.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label><span>Group by</span><select value={groupBy} onChange={(event) => setGroupBy(event.target.value as 'week' | 'status' | 'subCategory' | 'type')}><option value="week">Target order week</option><option value="status">Status</option><option value="subCategory">Sub-category</option><option value="type">Type</option></select></label>
      {(week !== 'All weeks' || status !== 'All statuses' || subCategory !== 'All sub-categories' || type !== 'All types' || search) && <button className="tracker-clear" onClick={() => { setWeek('All weeks'); setStatus('All statuses'); setSubCategory('All sub-categories'); setType('All types'); setSearch(''); }}>Clear filters</button>}
    </div>

    <div className="tracker-results"><span>{filtered.length} styles in view</span><small>Type determines tier: NEW → Tier 4 · RR → Tier 3</small></div>
    {grouped.map(([label, styles]) => <section className="tracker-group" key={label}>
      <header><div><span>{groupBy === 'week' ? 'Target order week' : groupBy === 'status' ? 'Development status' : groupBy === 'subCategory' ? 'Sub-category' : 'Type'}</span><h2>{label}</h2></div><strong>{styles.length} styles · {styles.filter((style) => style.type === 'NEW').length} NEW</strong></header>
      <div className="tracker-table-scroll"><table><thead><tr><th>Style number</th><th>Style name</th><th>Type</th><th>Tier</th><th>Status</th><th>Category</th><th>Sub-category</th><th>Target week</th><th>Fabric</th><th>Sample approval</th></tr></thead>
        <tbody>{styles.map((style) => <tr key={style.id}>
          <td><div className="tracker-number"><b>{style.styleNumber ?? 'Number pending'}</b>{style.styleNumberStatus === 'needs_number' && <span className="flag pending"><AlertTriangle size={11} /> Needs number</span>}{style.styleNumberStatus === 'malformed' && <span className="flag malformed"><AlertTriangle size={11} /> Confirm format</span>}{style.styleNumberStatus === 'malformed' && <small>Source: {style.originalStyleNumber}</small>}</div></td>
          <td className="tracker-name">{style.styleName}</td>
          <td><span className={`tracker-type ${style.type.toLowerCase()}`}>{style.type === 'NEW' && <Sparkles size={11} />}{style.type}</span></td>
          <td><span className={`tracker-tier ${style.tier === 'Tier 4' ? 'new' : ''}`}>{style.tier}</span></td>
          <td><span className="tracker-status">{style.status}</span></td>
          <td>{style.category}</td>
           <td><div className="tracker-taxonomy"><b>{style.subCategory}</b>{style.originalSubCategory !== style.subCategory && <small>Source: {style.originalSubCategory}</small>}{style.dataQualityFlags.includes('category_subcategory_needs_review') && <span className="flag malformed"><AlertTriangle size={11} /> Review category</span>}</div></td>
           <td><b>{style.targetOrderWeek ?? 'Unscheduled'}</b></td>
            <td>{style.fabric || <span className="tracker-empty">Not supplied</span>}{style.dataQualityFlags.includes('fabric_needs_confirmation') && <span className="flag malformed"><AlertTriangle size={11} /> Needs fabric</span>}</td>
          <td>{style.sampleApprovalDate ? <div className="tracker-date-quality"><b>8 Nov 2026</b>{style.dataQualityFlags.includes('sample_approval_date_needs_check') && <span className="flag malformed"><AlertTriangle size={11} /> Date needs checking</span>}<small>After target order week</small></div> : <span className="tracker-empty">Not supplied</span>}</td>
        </tr>)}</tbody>
      </table></div>
    </section>)}
    {!filtered.length && <div className="tracker-empty-state">No styles match the selected filters.</div>}
  </section>;
}