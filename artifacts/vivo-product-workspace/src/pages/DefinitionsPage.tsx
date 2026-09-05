import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Database, Save, ShieldCheck, XCircle } from 'lucide-react';

type SourceStatus = { name?: string; label?: string; source?: string; owner?: string; status?: string; detail?: string; message?: string };
type Definition = { metric?: string; name?: string; label?: string; formula?: string; definition?: string; source?: string; biSource?: string; owner?: string };
type Reconciliation = { name?: string; metric?: string; label?: string; status?: string; passed?: boolean; detail?: string; message?: string; error?: string };
type TrustPayload = { definitions?: Definition[]; reconciliations?: Reconciliation[]; sourceStatus?: SourceStatus[] };
type FabricRate = {
  subcategory: string;
  expectedMetresPerUnit: number | null;
  confidence: 'high' | 'medium' | 'low' | 'estimate' | 'not_set' | 'business_confirmed';
  historicalOrderCount: number;
  isEstimate: boolean;
  businessConfirmed: boolean;
  updatedAt: string;
  updatedBy: string;
};

const text = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value : fallback;
const passes = (item: Reconciliation) => item.passed === true || ['pass', 'passed', 'ok', 'trusted', 'success'].includes(String(item.status).toLowerCase());
const fails = (item: Reconciliation) => item.passed === false || ['fail', 'failed', 'error', 'blocked', 'untrusted'].includes(String(item.status).toLowerCase());
const confidenceLabel = (value: FabricRate['confidence']) => ({
  high: 'High', medium: 'Medium', low: 'Low', estimate: 'Estimate', not_set: 'Not yet set',
  business_confirmed: 'Business confirmed',
}[value]);

function FabricRateRow({ item }: { item: FabricRate }) {
  const queryClient = useQueryClient();
  const [rate, setRate] = useState(item.expectedMetresPerUnit?.toFixed(2) ?? '');
  const [orders, setOrders] = useState(String(item.historicalOrderCount));
  const [isEstimate, setIsEstimate] = useState(item.isEstimate);
  const [businessConfirmed, setBusinessConfirmed] = useState(item.businessConfirmed);
  useEffect(() => {
    setRate(item.expectedMetresPerUnit?.toFixed(2) ?? '');
    setOrders(String(item.historicalOrderCount));
    setIsEstimate(item.isEstimate);
    setBusinessConfirmed(item.businessConfirmed);
  }, [item]);
  const update = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/workspace/fabric-consumption-rates/${encodeURIComponent(item.subcategory)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedMetresPerUnit: rate === '' ? null : Number(rate),
          historicalOrderCount: Number(orders),
          isEstimate,
          businessConfirmed,
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Rate could not be saved');
      return response.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspace', 'fabric-consumption-rates'] }),
  });
  const dirty = rate !== (item.expectedMetresPerUnit?.toFixed(2) ?? '')
    || orders !== String(item.historicalOrderCount) || isEstimate !== item.isEstimate
    || businessConfirmed !== item.businessConfirmed;
  return <tr>
    <td><strong>{item.subcategory}</strong></td>
    <td><input type="number" min="0.01" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)} aria-label={`${item.subcategory} expected metres per unit`} placeholder="Not set" /></td>
    <td><span className={`fabric-confidence ${item.confidence}`}>{confidenceLabel(item.confidence)}</span></td>
    <td><input type="number" min="0" step="1" value={orders} onChange={(event) => setOrders(event.target.value)} aria-label={`${item.subcategory} historical orders`} /></td>
    <td><select value={businessConfirmed ? 'business' : isEstimate ? 'estimate' : 'history'} onChange={(event) => {
      setBusinessConfirmed(event.target.value === 'business');
      setIsEstimate(event.target.value === 'estimate');
    }} aria-label={`${item.subcategory} value basis`}><option value="history">Order history</option><option value="business">Business confirmed</option><option value="estimate">Estimate</option></select></td>
    <td><span>{item.updatedBy}</span><small>{new Date(item.updatedAt).toLocaleString('en-GB')}</small></td>
    <td><button className="icon-button" type="button" disabled={!dirty || update.isPending} onClick={() => update.mutate()} aria-label={`Save ${item.subcategory}`}><Save size={16} /></button>{update.isError && <small className="fabric-rate-error">{update.error.message}</small>}</td>
  </tr>;
}

export default function DefinitionsPage() {
  const trust = useQuery({
    queryKey: ['workspace', 'range-plan', 'definitions'],
    queryFn: async () => {
      const response = await fetch('/api/workspace/range-plan', { credentials: 'include' });
      if (!response.ok) throw new Error(`Definitions request failed (${response.status})`);
      return response.json() as Promise<TrustPayload>;
    },
    staleTime: 60_000,
  });
  const rates = useQuery({
    queryKey: ['workspace', 'fabric-consumption-rates'],
    queryFn: async () => {
      const response = await fetch('/api/workspace/fabric-consumption-rates', { credentials: 'include' });
      if (!response.ok) throw new Error(`Fabric rates request failed (${response.status})`);
      return response.json() as Promise<{ items: FabricRate[] }>;
    },
  });
  const definitions = trust.data?.definitions ?? [];
  const reconciliations = trust.data?.reconciliations ?? [];
  const sources = trust.data?.sourceStatus ?? [];
  const failed = reconciliations.filter(fails);
  return <section className="page definitions-page">
    <header className="definitions-hero"><div><span className="range-eyebrow">Data governance / Single source rule</span><h1>Definitions &amp; data trust</h1><p>Shared metrics are owned by BI. Workspace planning references and Style Development remain operational exceptions.</p></div><div className="definitions-hero-icon"><ShieldCheck size={30} /></div></header>
    {failed.length > 0 && <div className="definitions-blocked" role="alert"><AlertTriangle size={22} /><div><strong>{failed.length} reconciliation {failed.length === 1 ? 'has' : 'have'} failed — BI headline figures are not trusted</strong><p>Resolve the failures below before using BI-owned metrics in planning decisions.</p></div></div>}
    <section className="definitions-section">
      <div className="definitions-heading"><Database size={18} /><div><span className="range-eyebrow">Planning reference / Workspace-owned</span><h2>Expected fabric consumption by subcategory</h2><p>Maintained reference metres per finished unit. These values are not yet used in calculations or validation.</p></div></div>
      {rates.isLoading ? <div className="definitions-empty">Loading fabric references…</div> : rates.isError ? <div className="definitions-empty">Fabric references could not be loaded. <button className="button" onClick={() => rates.refetch()}>Try again</button></div> :
        <div className="fabric-rate-table-wrap"><table className="fabric-rate-table"><thead><tr><th>Subcategory</th><th>Metres / unit</th><th>Confidence</th><th>Orders</th><th>Basis</th><th>Last changed</th><th /></tr></thead><tbody>{rates.data?.items.map((item) => <FabricRateRow key={item.subcategory} item={item} />)}</tbody></table></div>}
    </section>
    {trust.isLoading && <div className="range-plan-loading">Loading BI-owned definitions and data trust…</div>}
    {trust.isError && <div className="definitions-blocked" role="alert"><AlertTriangle size={22} /><div><strong>BI-owned definitions unavailable — data trust is blocked</strong><p>The Workspace-owned fabric references above remain available, but do not use BI-owned figures until their source-of-truth record is available.</p></div><button type="button" className="button button-dark" onClick={() => trust.refetch()}>Try again</button></div>}
    <section className="definitions-section"><div className="definitions-heading"><Database size={18} /><div><span className="range-eyebrow">Shared ownership</span><h2>Metrics, formulae &amp; BI sources</h2></div></div>{definitions.length ? <div className="definitions-grid">{definitions.map((item, index) => <article className="definition-card" key={index}><span>{text(item.metric ?? item.name ?? item.label, 'Shared metric')}</span><strong>{text(item.formula ?? item.definition, 'Formula documented in BI semantic layer')}</strong><small><b>BI source:</b> {text(item.biSource ?? item.source ?? item.owner, 'BI semantic model')}</small></article>)}</div> : <div className="definitions-empty">No metric definitions were returned.</div>}</section>
    <section className="definitions-section"><div className="definitions-heading"><Database size={18} /><div><span className="range-eyebrow">System ownership</span><h2>Source status</h2></div></div><div className="source-status-list"><article className="source-status-card exception"><div><strong>Style Development</strong><span>Exception — operational product-development source</span></div><em>Exception</em></article>{sources.map((source, index) => <article className="source-status-card" key={index}><div><strong>{text(source.name ?? source.label ?? source.source, 'BI source')}</strong><span>{text(source.detail ?? source.message ?? source.owner, 'BI-owned shared data')}</span></div><em>{text(source.status, 'Active')}</em></article>)}</div></section>
    <section className="definitions-section"><div className="definitions-heading"><ShieldCheck size={18} /><div><span className="range-eyebrow">Verification gate</span><h2>Reconciliations</h2></div></div>{reconciliations.length ? <div className="reconciliation-grid">{reconciliations.map((item, index) => { const ok = passes(item); const failedItem = fails(item); return <article className={`reconciliation-card ${ok ? 'pass' : failedItem ? 'fail' : 'blocked'}`} key={index}>{ok ? <CheckCircle2 size={20} /> : <XCircle size={20} />}<div><strong>{text(item.name ?? item.metric ?? item.label, 'Reconciliation')}</strong><span>{text(item.detail ?? item.message ?? item.error, failedItem ? 'Failed — BI-owned values are not trusted.' : 'Awaiting a verified result.')}</span></div><em>{ok ? 'Pass' : failedItem ? 'Fail' : 'Blocked'}</em></article>; })}</div> : <div className="definitions-empty">No reconciliation results were returned.</div>}</section>
  </section>;
}