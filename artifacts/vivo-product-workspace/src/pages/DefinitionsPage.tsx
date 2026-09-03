import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Database, ShieldCheck, XCircle } from 'lucide-react';

type SourceStatus = { name?: string; label?: string; source?: string; owner?: string; status?: string; detail?: string; message?: string; isException?: boolean };
type Definition = { metric?: string; name?: string; label?: string; formula?: string; definition?: string; source?: string; biSource?: string; owner?: string };
type Reconciliation = { name?: string; metric?: string; label?: string; status?: string; passed?: boolean; detail?: string; message?: string; error?: string };
type TrustPayload = { definitions?: Definition[]; reconciliations?: Reconciliation[]; sourceStatus?: SourceStatus[] };

const text = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value : fallback;
const passes = (item: Reconciliation) => item.passed === true || ['pass', 'passed', 'ok', 'trusted', 'success'].includes(String(item.status).toLowerCase());
const fails = (item: Reconciliation) => item.passed === false || ['fail', 'failed', 'error', 'blocked', 'untrusted'].includes(String(item.status).toLowerCase());

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
  if (trust.isLoading) return <section className="page definitions-page"><div className="range-plan-loading">Loading definitions and data trust…</div></section>;
  if (trust.isError || !trust.data) return <section className="page definitions-page"><div className="definitions-blocked" role="alert"><AlertTriangle size={22} /><div><strong>Definitions unavailable — data trust is blocked</strong><p>The source-of-truth record could not be loaded. Do not use BI-owned figures until it is available.</p></div><button type="button" className="button button-dark" onClick={() => trust.refetch()} data-testid="button-retry-definitions">Try again</button></div></section>;

  const definitions = trust.data.definitions ?? [];
  const reconciliations = trust.data.reconciliations ?? [];
  const sources = trust.data.sourceStatus ?? [];
  const failed = reconciliations.filter(fails);
  return <section className="page definitions-page">
    <header className="definitions-hero">
      <div><span className="range-eyebrow">Data governance / Single source rule</span><h1>Definitions &amp; data trust</h1><p>Shared metrics are owned by BI. Style Development is the exception: it remains the operational source for product-development progress.</p></div>
      <div className="definitions-hero-icon"><ShieldCheck size={30} /></div>
    </header>
    {failed.length > 0 && <div className="definitions-blocked" role="alert" data-testid="status-definitions-reconciliation-failed"><AlertTriangle size={22} /><div><strong>{failed.length} reconciliation {failed.length === 1 ? 'has' : 'have'} failed — BI headline figures are not trusted</strong><p>Resolve the failures below before using BI-owned metrics in planning decisions.</p></div></div>}
    <section className="definitions-section">
      <div className="definitions-heading"><Database size={18} /><div><span className="range-eyebrow">Shared ownership</span><h2>Metrics, formulae &amp; BI sources</h2></div></div>
      {definitions.length ? <div className="definitions-grid">{definitions.map((item, index) => <article className="definition-card" key={`${text(item.metric ?? item.name ?? item.label, 'metric')}-${index}`} data-testid={`card-definition-${index}`}><span>{text(item.metric ?? item.name ?? item.label, 'Shared metric')}</span><strong>{text(item.formula ?? item.definition, 'Formula documented in BI semantic layer')}</strong><small><b>BI source:</b> {text(item.biSource ?? item.source ?? item.owner, 'BI semantic model')}</small></article>)}</div> : <div className="definitions-empty">No metric definitions were returned. This is a blocked trust state; BI figures must not be treated as verified.</div>}
    </section>
    <section className="definitions-section">
      <div className="definitions-heading"><Database size={18} /><div><span className="range-eyebrow">System ownership</span><h2>Source status</h2></div></div>
      <div className="source-status-list">
        <article className="source-status-card exception"><div><strong>Style Development</strong><span>Exception — operational product-development source</span></div><em>Exception</em></article>
        {sources.map((source, index) => <article className="source-status-card" key={`${text(source.name ?? source.label ?? source.source, 'source')}-${index}`}><div><strong>{text(source.name ?? source.label ?? source.source, 'BI source')}</strong><span>{text(source.detail ?? source.message ?? source.owner, 'BI-owned shared data')}</span></div><em>{text(source.status, 'Active')}</em></article>)}
      </div>
    </section>
    <section className="definitions-section">
      <div className="definitions-heading"><ShieldCheck size={18} /><div><span className="range-eyebrow">Verification gate</span><h2>Reconciliations</h2></div></div>
      {reconciliations.length ? <div className="reconciliation-grid">{reconciliations.map((item, index) => { const ok = passes(item); const failedItem = fails(item); return <article className={`reconciliation-card ${ok ? 'pass' : failedItem ? 'fail' : 'blocked'}`} key={`${text(item.name ?? item.metric ?? item.label, 'reconciliation')}-${index}`} data-testid={`card-reconciliation-${index}`}>{ok ? <CheckCircle2 size={20} /> : <XCircle size={20} />}<div><strong>{text(item.name ?? item.metric ?? item.label, 'Reconciliation')}</strong><span>{text(item.detail ?? item.message ?? item.error, failedItem ? 'Failed — BI-owned values are not trusted.' : 'Awaiting a verified result.')}</span></div><em>{ok ? 'Pass' : failedItem ? 'Fail' : 'Blocked'}</em></article>; })}</div> : <div className="definitions-empty">No reconciliation results were returned. BI-owned headline figures are not trusted.</div>}
    </section>
  </section>;
}