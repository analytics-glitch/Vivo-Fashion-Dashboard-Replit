import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import MultiSelectFilter from '../components/MultiSelectFilter';
import {
  Archive,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Columns3,
  Copy,
  FileText,
  Filter,
  Layers3,
  MoreHorizontal,
  MessageCircle,
  PackageCheck,
  Plus,
  Ruler,
  Save,
  Share2,
  Search,
  Shirt,
  SlidersHorizontal,
  Tag,
  X,
} from 'lucide-react';
import {
  getGetWorkspacePlmMetaQueryKey,
  getGetWorkspaceStylePlmQueryKey,
  getGetWorkspaceStyleQueryKey,
  getListWorkspaceTeamQueryKey,
  getListWorkspaceStylesQueryKey,
  useCreateWorkspaceFitSession,
  useCreateWorkspaceSample,
  useCreateWorkspaceStyle,
  useGetWorkspacePlmMeta,
  useGetWorkspaceStylePlm,
  useListWorkspaceTeam,
  useListWorkspaceStyles,
  useTransitionWorkspaceStyle,
  useUpdateWorkspaceCostEstimate,
  useUpdateWorkspacePomQc,
  useUpdateWorkspaceStyleGrading,
  useUpdateWorkspaceStyleTechPack,
  useUpdateWorkspaceStyle,
} from '@workspace/api-client-react';
import type { StyleCreate, WorkspaceStyle, WorkspaceTeamMember } from '@workspace/api-client-react';
import { StyleFeedbackPanel, useStyleFeedback } from '@/pages/FeedbackPage';

const MAIN_STAGES = [
  'Concept',
  'Initial Design Tech Pack',
  'Pattern',
  'Initial Sample',
  'Fit Session',
  'Approved',
  'Grading',
  'Costing Sample',
  'In Development',
  'Production',
  'Launched',
] as const;
const SIDE_STAGES = ['On Hold', 'Dropped'] as const;
const ALL_STAGES = [...MAIN_STAGES, ...SIDE_STAGES];
const LAUNCH_ROUTES = ['DTC', 'Wholesale', 'Marketplace', 'Omnichannel'] as const;
const STYLE_CLASSIFICATIONS = ['Core', 'Fashion', 'Seasonal', 'Test'] as const;
const RANGE_TIERS = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4'] as const;
const SEASONS = ['Q3 2026', 'Q4 2026'] as const;
type PlmStage = typeof ALL_STAGES[number];
type GroupBy = 'stage' | 'subCategory' | 'brand' | 'orderType' | 'theme' | 'patternMaker' | 'fabricType';
type StyleWithFabric = WorkspaceStyle & { fabricType?: string };
type StyleTeam = NonNullable<WorkspaceStyle['styleTeam']>;
type StyleRole = 'design' | 'pattern' | 'cad' | 'sample' | 'buying';
const STYLE_TEAM_ROLES: Array<{ key: StyleRole; label: string; shortLabel: string; idKey: 'designUserId' | 'patternUserId' | 'cadUserId' | 'sampleUserId' | 'buyingUserId' }> = [
  { key: 'design', label: 'Design', shortLabel: 'Design', idKey: 'designUserId' },
  { key: 'pattern', label: 'Pattern', shortLabel: 'Pattern', idKey: 'patternUserId' },
  { key: 'cad', label: 'CAD', shortLabel: 'CAD', idKey: 'cadUserId' },
  { key: 'sample', label: 'Sample', shortLabel: 'Sample', idKey: 'sampleUserId' },
  { key: 'buying', label: 'Buying', shortLabel: 'Buying', idKey: 'buyingUserId' },
];
const GROUP_BY_OPTIONS: Array<{ value: GroupBy; label: string }> = [
  { value: 'stage', label: 'PLM Stage' },
  { value: 'subCategory', label: 'Sub-Category' },
  { value: 'brand', label: 'Brand' },
  { value: 'orderType', label: 'New / Repeat' },
  { value: 'theme', label: 'Theme' },
  { value: 'patternMaker', label: 'Pattern Maker' },
  { value: 'fabricType', label: 'Fabric Type' },
];
const GROUP_BY_STORAGE_KEY = 'vivo-plm-group-by';
const TABS = ['Overview', 'Tech Pack', 'Pattern', 'Fit Session', 'Grading', 'Samples', 'Cost Estimate', 'POM QC', 'Production', 'Feedback'] as const;
type Tab = typeof TABS[number];
type LooseRecord = Record<string, unknown>;
type PulseMode = 'investigate' | 'champion';
type PulseCampaign = {
  id: number;
  styleNumber: string;
  styleName: string;
  styleImage?: string | null;
  mode: PulseMode;
  sharePath: string;
  responseCount: number;
};

const text = (value: unknown, fallback = '—') => value === null || value === undefined || value === '' ? fallback : String(value);
const record = (value: unknown): LooseRecord => (value && typeof value === 'object' ? value as LooseRecord : {});
const pick = (value: unknown, keys: string[], fallback = '—') => {
  const item = record(value);
  const found = keys.map((key) => item[key]).find((entry) => entry !== null && entry !== undefined && entry !== '');
  return text(found, fallback);
};
const dateLabel = (value: unknown) => {
  if (!value) return 'No date';
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const initials = (name: string) => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const PLM_STAGE_ALIASES: Record<string, PlmStage> = {
  brief: 'Concept',
  concept: 'Concept',
  idea: 'Concept',
  review: 'Initial Design Tech Pack',
  initial_design_tech_pack: 'Initial Design Tech Pack',
  pattern: 'Pattern',
  sampling: 'Initial Sample',
  sample: 'Initial Sample',
  initial_sample: 'Initial Sample',
  sample_review: 'Fit Session',
  fit: 'Fit Session',
  fit_session: 'Fit Session',
  approved: 'Approved',
  adopted: 'Approved',
  grading: 'Grading',
  set_sample: 'Costing Sample',
  costing_sample: 'Costing Sample',
  development: 'In Development',
  in_development: 'In Development',
  in_progress: 'In Development',
  buying: 'Production',
  production: 'Production',
  launched: 'Launched',
  live: 'Launched',
  on_hold: 'On Hold',
  hold: 'On Hold',
  dropped: 'Dropped',
  archived: 'Dropped',
  cancelled: 'Dropped',
};
const stageFor = (style: WorkspaceStyle) => {
  const candidate = text(style.currentStage || style.stage || style.status, 'Concept');
  const normalized = candidate.trim().toLowerCase().replace(/[-\s]+/g, '_');
  return PLM_STAGE_ALIASES[normalized] || ALL_STAGES.find((stage) => stage.toLowerCase() === candidate.toLowerCase()) || (candidate.match(/hold/i) ? 'On Hold' : candidate.match(/drop|cancel|archiv/i) ? 'Dropped' : 'Concept');
};
const stageIndex = (stage: string) => MAIN_STAGES.indexOf(stage as typeof MAIN_STAGES[number]);
const isoWeekNumber = (value: Date) => {
  const date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
};
const isDueThisWeek = (value: unknown, weekStart: Date, weekEnd: Date, currentWeek: number) => {
  if (!value) return false;
  const raw = String(value).trim();
  const weekLabel = raw.match(/(?:^|\D)(\d{1,2})\s*$/);
  if (weekLabel) return Number(weekLabel[1]) === currentWeek;
  const parsed = new Date(raw);
  return !Number.isNaN(parsed.getTime()) && parsed >= weekStart && parsed < weekEnd;
};
const daysInStage = (style: WorkspaceStyle) => {
  if (typeof style.daysInStage === 'number') return style.daysInStage;
  if (!style.stageEnteredAt) return 0;
  const days = Math.floor((Date.now() - new Date(style.stageEnteredAt).getTime()) / 86400000);
  return Number.isFinite(days) && days > 0 ? days : 0;
};
const imageFor = (style: WorkspaceStyle) => style.image || `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 560"><rect width="480" height="560" fill="${style.id % 2 ? '#d8d0c4' : '#d6dde0'}"/><path d="M134 118 195 80h90l61 38 54 91-55 36-33-57v254H168V188l-33 57-55-36z" fill="${style.id % 2 ? '#ede8df' : '#f4f0e8'}" stroke="#1A1A2E" stroke-width="4"/><path d="M195 81c4 45 86 45 90 0M167 264h146" fill="none" stroke="#C9A96E" stroke-width="4"/><text x="24" y="522" fill="#1A1A2E" font-family="sans-serif" font-size="18" letter-spacing="4">VIVO PLM</text></svg>`)}`;
const groupLabel = (groupBy: GroupBy) => GROUP_BY_OPTIONS.find((option) => option.value === groupBy)?.label || 'PLM Stage';
const groupSlug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'uncategorised';
const groupValueFor = (style: WorkspaceStyle, groupBy: GroupBy): string => {
  if (groupBy === 'stage') return stageFor(style);
  if (groupBy === 'orderType') return /repeat|rr/i.test(text(style.orderType, 'New')) ? 'Repeat (RR)' : 'New';
  if (groupBy === 'patternMaker') return text(style.styleTeam?.pattern?.name || style.patternMaker, 'Unassigned');
  const value = groupBy === 'fabricType' ? (style as StyleWithFabric).fabricType : style[groupBy];
  return text(value, groupBy === 'theme' ? 'No theme' : 'Unassigned');
};
const groupKeysFor = (styles: WorkspaceStyle[], groupBy: GroupBy) => {
  if (groupBy === 'stage') return [...ALL_STAGES];
  if (groupBy === 'brand') return ['Vivo', 'Safari by Vivo', 'Zoya'];
  if (groupBy === 'orderType') return ['New', 'Repeat (RR)'];
  return Array.from(new Set(styles.map((style) => groupValueFor(style, groupBy)))).sort((a, b) => a.localeCompare(b));
};

async function createPulseRequest(style: WorkspaceStyle, mode: PulseMode): Promise<PulseCampaign> {
  const response = await fetch('/api/workspace/feedback/pulses', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ styleId: style.id, styleNumber: style.code, mode }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body.error || 'Could not create Style Pulse'));
  return body as PulseCampaign;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="plm-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function EmptyPlm({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="plm-empty"><div className="plm-empty-mark"><Layers3 size={17} /></div><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

function TeamMemberPicker({ role, value, members, onChange }: { role: StyleRole; value: number | null; members: WorkspaceTeamMember[]; onChange: (value: number | null) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = members.find((member) => member.id === value);
  const filtered = members.filter((member) => `${member.name} ${member.role} ${member.department}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="plm-team-picker" onClick={(event) => event.stopPropagation()}>
    <button type="button" className={`plm-team-picker-trigger ${open ? 'open' : ''}`} onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open} data-testid={`button-style-team-${role}`}>
      <span>{selected ? selected.name : 'Unassigned'}{selected && <small>{selected.role}</small>}</span><ChevronDown size={14} />
    </button>
    {open && <div className="plm-team-picker-menu" role="listbox">
      <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search team members…" aria-label={`Search ${role} team members`} />
      <button type="button" className={!selected ? 'active' : ''} onClick={() => { onChange(null); setQuery(''); setOpen(false); }} role="option" aria-selected={!selected}>Unassigned</button>
      {filtered.map((member) => <button type="button" className={member.id === value ? 'active' : ''} key={member.id} onClick={() => { onChange(member.id); setQuery(''); setOpen(false); }} role="option" aria-selected={member.id === value}><span>{member.name}<small>{member.role}</small></span><span className="plm-team-option-initials">{initials(member.name)}</span></button>)}
      {!filtered.length && <p className="plm-team-picker-empty">No team members found.</p>}
    </div>}
  </div>;
}

function StyleTeamSection({ members, values, legacyOwner, onChange, onSave, pending, notice }: { members: WorkspaceTeamMember[]; values: Record<'designUserId' | 'patternUserId' | 'cadUserId' | 'sampleUserId' | 'buyingUserId', number | null>; legacyOwner?: string; onChange: (key: keyof typeof values, value: number | null) => void; onSave: () => void; pending: boolean; notice: string }) {
  return <section className="plm-detail-section plm-style-team"><div className="plm-section-title"><div><span className="plm-kicker">Working group</span><h4>Style Team</h4></div><span>{STYLE_TEAM_ROLES.filter((role) => values[role.idKey]).length}/5 assigned</span></div><div className="plm-team-rows">{STYLE_TEAM_ROLES.map((role) => <div className="plm-team-row" key={role.key}><div className="plm-team-role"><span className="plm-role-badge">{role.shortLabel}</span><b>{role.label}</b></div><TeamMemberPicker role={role.key} value={values[role.idKey]} members={members} onChange={(value) => onChange(role.idKey, value)} /></div>)}</div>{legacyOwner && !values.designUserId && <p className="plm-legacy-owner">Legacy owner retained: <b>{legacyOwner}</b>. Assign Design to replace it.</p>}{notice && <FormNotice message={notice} />}<div className="plm-team-actions"><button type="button" className="plm-button primary" onClick={onSave} disabled={pending} data-testid="button-save-style-team"><Save size={14} />{pending ? 'Saving…' : 'Save Style Team'}</button></div></section>;
}

function PlmCard({ style, stage, onOpen, onTransition, onMenu, menuOpen }: { style: WorkspaceStyle; stage: string; onOpen: () => void; onTransition: (toStage: string) => void; onMenu: () => void; menuOpen: boolean }) {
  const index = stageIndex(stage);
  const canAdvance = index >= 0 && index < MAIN_STAGES.length - 1;
  const canMoveBack = index > 0;
  const team = STYLE_TEAM_ROLES.map((role) => ({ ...role, member: style.styleTeam?.[role.key] })).filter((entry) => entry.member);
  const teamTooltip = team.map((entry) => `${entry.shortLabel}: ${entry.member?.name}`).join(' · ');
  return <article className="plm-card" data-testid={`card-plm-style-${style.id}`}>
    <button className="plm-card-open" onClick={onOpen} data-testid={`button-open-plm-style-${style.id}`}>
      <div className="plm-card-visual"><img src={imageFor(style)} alt="" /><span className="plm-days">{daysInStage(style)}d</span></div>
      <div className="plm-card-body">
        <div className="plm-card-title">
          <div className="plm-card-name">
            <span className="plm-style-number">{text(style.code, `ST-${style.id}`)}</span>
            <h3 title={text(style.name, 'Unnamed style')}>{text(style.name, 'Unnamed style')}</h3>
          </div>
          <span className={`plm-brand ${text(style.brand).toLowerCase().includes('safari') ? 'safari' : ''}`}>{text(style.brand, 'Unknown')}</span>
        </div>
        <div className="plm-card-meta">
          <span className="plm-subcategory-badge">{text(style.subCategory || style.category, 'Uncategorised')}</span>
          <span>{text(style.designer || style.owner, 'Unassigned')}</span>
        </div>
         <div className="plm-card-foot"><div className="plm-card-classification"><span className="plm-classification-chip route">Route {text(style.launchRoute, '—')}</span><span className="plm-classification-chip tier">Tier {text(style.rangeTier || style.tier, '—')}</span></div><span className="plm-card-date">{dateLabel(style.targetDate)}</span></div>
        {team.length > 0 && <div className="plm-card-team" title={teamTooltip} aria-label={teamTooltip}>{team.slice(0, 4).map((entry) => <span key={entry.key} className="plm-card-avatar" title={`${entry.label}: ${entry.member?.name}`} aria-label={`${entry.label}: ${entry.member?.name}`}>{initials(entry.member?.name || '')}</span>)}</div>}
      </div>
    </button>
    <div className="plm-card-actions"><button className="plm-card-action" disabled={!canMoveBack} onClick={() => onTransition(MAIN_STAGES[index - 1])} data-testid={`button-move-back-${style.id}`}><ChevronLeft size={13} /> Back</button><button className="plm-card-action advance" disabled={!canAdvance} onClick={() => onTransition(MAIN_STAGES[index + 1])} data-testid={`button-advance-style-${style.id}`}>Advance <ChevronRight size={13} /></button><div className="plm-menu-wrap"><button className="plm-menu-button" onClick={onMenu} aria-label={`More actions for ${style.name}`} data-testid={`button-menu-style-${style.id}`}><MoreHorizontal size={15} /></button>{menuOpen && <div className="plm-card-menu"><button onClick={() => onTransition('On Hold')} data-testid={`button-hold-style-${style.id}`}><Clock3 size={14} /> Put on hold</button><button onClick={() => onTransition('Dropped')} data-testid={`button-drop-style-${style.id}`}><Archive size={14} /> Drop style</button></div>}</div></div>
  </article>;
}

function StageColumn({ stage, index, styles, selected, onOpen, onTransition, onMenu }: { stage: string; index: number; styles: WorkspaceStyle[]; selected: number | null; onOpen: (id: number) => void; onTransition: (id: number, stage: string) => void; onMenu: (id: number) => void }) {
  return <section className={`plm-column ${selected && styles.some((style) => style.id === selected) ? 'has-selection' : ''}`} data-testid={`column-plm-${groupSlug(stage)}`}><header className="plm-column-head"><div><span className="plm-column-index">{String(index + 1).padStart(2, '0')}</span><h2 title={stage}>{stage}</h2></div><span className="plm-column-count">{styles.length}</span></header><div className="plm-column-rule"><span style={{ width: `${Math.min(100, Math.max(10, styles.length * 18))}%` }} /></div><div className="plm-column-cards">{styles.length ? styles.map((style) => <PlmCard key={style.id} style={style} stage={stageFor(style)} onOpen={() => onOpen(style.id)} onTransition={(toStage) => onTransition(style.id, toStage)} onMenu={() => onMenu(style.id)} menuOpen={selected === style.id} />) : <div className="plm-column-empty">No styles here</div>}</div></section>;
}

function NewStyleModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const meta = useGetWorkspacePlmMeta({ query: { queryKey: getGetWorkspacePlmMetaQueryKey() } });
  const create = useCreateWorkspaceStyle();
  const [form, setForm] = useState({ styleNumber: '', name: '', brand: 'Vivo', category: '', subCategory: '', theme: '', orderType: 'New', tier: '2', launchRoute: '', styleClassification: '', rangeTier: '', designer: '', patternMaker: '', targetDate: '' });
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const users = (meta.data?.users || []).map((user) => pick(user, ['name', 'fullName'], '')).filter(Boolean);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.category.trim() || !form.targetDate) return;
    create.mutate({ data: { ...form, name: form.name.trim(), category: form.category.trim(), brand: form.brand as StyleCreate['brand'], orderType: form.orderType as StyleCreate['orderType'], tier: form.tier as StyleCreate['tier'], launchRoute: (form.launchRoute || null) as StyleCreate['launchRoute'], styleClassification: (form.styleClassification || null) as StyleCreate['styleClassification'], rangeTier: (form.rangeTier || null) as StyleCreate['rangeTier'], targetDate: form.targetDate } }, { onSuccess: (created) => onCreated(created.id) });
  };
  return <div className="plm-modal-backdrop" onClick={onClose}><div className="plm-modal" onClick={(event) => event.stopPropagation()}><header className="plm-modal-head"><div><span className="plm-kicker">PLM / New record</span><h2>Start a style</h2><p>Capture the brief before the first handoff.</p></div><button className="plm-close" onClick={onClose} aria-label="Close new style modal" data-testid="button-close-new-style"><X size={18} /></button></header><form onSubmit={submit}><div className="plm-form-grid"><Field label="Style number" hint="Optional internal reference"><input value={form.styleNumber} onChange={(event) => update('styleNumber', event.target.value)} placeholder="e.g. V26-041" data-testid="input-new-style-number" /></Field><Field label="Style name"><input required value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="e.g. Sanaa wrap shirt" data-testid="input-new-style-name" /></Field><Field label="Brand"><select value={form.brand} onChange={(event) => update('brand', event.target.value)} data-testid="select-new-style-brand"><option>Vivo</option><option>Safari by Vivo</option></select></Field><Field label="Category"><select required value={form.category} onChange={(event) => update('category', event.target.value)} data-testid="select-new-style-category"><option value="">Select category</option>{(meta.data?.categories || []).map((category) => <option key={category}>{category}</option>)}<option value="Other">Other</option></select></Field><Field label="Sub-category"><input value={form.subCategory} onChange={(event) => update('subCategory', event.target.value)} placeholder="Optional" data-testid="input-new-style-subcategory" /></Field><Field label="Theme"><input value={form.theme} onChange={(event) => update('theme', event.target.value)} placeholder="e.g. Quiet utility" data-testid="input-new-style-theme" /></Field><Field label="Launch route"><select value={form.launchRoute} onChange={(event) => update('launchRoute', event.target.value)} data-testid="select-new-style-launch-route"><option value="">Not set</option>{LAUNCH_ROUTES.map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Style classification"><select value={form.styleClassification} onChange={(event) => update('styleClassification', event.target.value)} data-testid="select-new-style-classification"><option value="">Not set</option>{STYLE_CLASSIFICATIONS.map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Range tier"><select value={form.rangeTier} onChange={(event) => update('rangeTier', event.target.value)} data-testid="select-new-style-range-tier"><option value="">Not set</option>{RANGE_TIERS.map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Designer"><select value={form.designer} onChange={(event) => update('designer', event.target.value)} data-testid="select-new-style-designer"><option value="">Unassigned</option>{users.map((user) => <option key={user}>{user}</option>)}</select></Field><Field label="Pattern maker"><select value={form.patternMaker} onChange={(event) => update('patternMaker', event.target.value)} data-testid="select-new-style-pattern-maker"><option value="">Unassigned</option>{users.map((user) => <option key={user}>{user}</option>)}</select></Field><Field label="Order type"><select value={form.orderType} onChange={(event) => update('orderType', event.target.value)} data-testid="select-new-style-order-type"><option>New</option><option>Repeat</option></select></Field><Field label="Tier"><select value={form.tier} onChange={(event) => update('tier', event.target.value)} data-testid="select-new-style-tier"><option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option><option value="4">Tier 4</option></select></Field><Field label="Target date"><input required type="date" value={form.targetDate} onChange={(event) => update('targetDate', event.target.value)} data-testid="input-new-style-target-date" /></Field></div>{create.isError && <div className="plm-form-error"><CircleAlert size={15} /> This style could not be created. Check the fields and try again.</div>}<footer className="plm-modal-actions"><button type="button" className="plm-button quiet" onClick={onClose} data-testid="button-cancel-new-style">Cancel</button><button type="submit" className="plm-button primary" disabled={create.isPending} data-testid="button-create-new-style"><Plus size={15} />{create.isPending ? 'Creating…' : 'Create style'}</button></footer></form></div></div>;
}

function StylePulseModal({ style, onClose }: { style: WorkspaceStyle; onClose: () => void }) {
  const [campaign, setCampaign] = useState<PulseCampaign | null>(null);
  const [pendingMode, setPendingMode] = useState<PulseMode | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const selectMode = async (mode: PulseMode) => {
    setPendingMode(mode);
    setError('');
    try {
      setCampaign(await createPulseRequest(style, mode));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not create Style Pulse');
    } finally {
      setPendingMode(null);
    }
  };
  const link = campaign ? `${window.location.origin}${campaign.sharePath}` : '';
  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return <div className="plm-modal-backdrop" onClick={onClose}><div className="plm-modal plm-pulse-modal" onClick={(event) => event.stopPropagation()}>
    <header className="plm-modal-head"><div><span className="plm-kicker">Style Pulse / {text(style.code, `ST-${style.id}`)}</span><h2>Request focused feedback</h2><p>{style.name}</p></div><button className="plm-close" onClick={onClose} aria-label="Close Style Pulse modal" data-testid="button-close-style-pulse"><X size={18} /></button></header>
    <div className="plm-pulse-style"><img src={imageFor(style)} alt="" /><div><span>Selected style</span><strong>{style.name}</strong><small>{text(style.code, `ST-${style.id}`)}</small></div></div>
    {!campaign ? <div className="plm-pulse-options"><p>What kind of input do you want from the floor?</p><button type="button" className="plm-pulse-option investigate" onClick={() => selectMode('investigate')} disabled={Boolean(pendingMode)} data-testid="button-request-feedback-investigate"><span><b>Investigate</b><small>Style not performing</small></span><ArrowRight size={16} /></button><button type="button" className="plm-pulse-option champion" onClick={() => selectMode('champion')} disabled={Boolean(pendingMode)} data-testid="button-request-feedback-champion"><span><b>Champion</b><small>Style doing well</small></span><ArrowRight size={16} /></button>{pendingMode && <p className="plm-pulse-pending">Generating your shareable link…</p>}</div> : <div className="plm-pulse-generated"><span className={`plm-pulse-mode ${campaign.mode}`}>{campaign.mode === 'investigate' ? 'Investigate' : 'Champion'} pulse ready</span><h3>Share this focused question.</h3><label><span>Shareable link</span><input readOnly value={link} onFocus={(event) => event.currentTarget.select()} /></label><div className="plm-pulse-generated-actions"><button type="button" className="plm-button primary" onClick={copyLink} data-testid="button-copy-style-pulse-link"><Copy size={14} />{copied ? 'Copied' : 'Copy link'}</button><a className="plm-button quiet" href={`https://wa.me/?text=${encodeURIComponent(`Style Pulse · ${style.name}\n${link}`)}`} target="_blank" rel="noreferrer" data-testid="button-share-style-pulse-whatsapp"><Share2 size={14} /> Share via WhatsApp</a></div><p className="plm-pulse-generated-note">Responses will appear in the Style Pulses tab in Feedback.</p></div>}
    {error && <div className="plm-form-error"><CircleAlert size={15} /> {error}</div>}
    <footer className="plm-modal-actions"><button type="button" className="plm-button quiet" onClick={onClose} data-testid="button-cancel-style-pulse">{campaign ? 'Done' : 'Cancel'}</button></footer>
  </div></div>;
}

function DetailDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const detail = useGetWorkspaceStylePlm(id, { query: { queryKey: getGetWorkspaceStylePlmQueryKey(id), enabled: !!id } });
  const feedback = useStyleFeedback(id);
  const meta = useGetWorkspacePlmMeta({ query: { queryKey: getGetWorkspacePlmMetaQueryKey() } });
  const teamDirectory = useListWorkspaceTeam({ query: { queryKey: getListWorkspaceTeamQueryKey() } });
  const updateStyle = useUpdateWorkspaceStyle();
  const techPack = useUpdateWorkspaceStyleTechPack();
  const fitSession = useCreateWorkspaceFitSession();
  const grading = useUpdateWorkspaceStyleGrading();
  const sample = useCreateWorkspaceSample();
  const costEstimate = useUpdateWorkspaceCostEstimate();
  const pomQc = useUpdateWorkspacePomQc();
  const [tab, setTab] = useState<Tab>('Overview');
  const [notice, setNotice] = useState('');
  const [techForm, setTechForm] = useState({ basePatternReference: '', fabricId: '', trimsAccessories: '', constructionNotes: '', audacesFileReference: '', modifiedFromStyleNumber: '', status: 'Draft', version: '1.0', owner: '' });
  const [fitForm, setFitForm] = useState({ sessionDate: '', sample: 'First sample', modelName: '', attendees: '', outcome: 'Needs Revision', comments: '' });
  const [gradingForm, setGradingForm] = useState({ sizeRange: '', cadTeamMember: '', status: 'Pending' });
  const [sampleForm, setSampleForm] = useState({ purpose: 'Development', patternMaker: '', sampleMakers: '', unitsOrdered: '1', dateCut: '', dateFinished: '', status: 'Planned', reworkNotes: '' });
  const [costForm, setCostForm] = useState({ avgMatKg: '', avgMetresUsed: '', minsPerPc: '', efficiencyPct: '', materialCost: '', labourCost: '', totalCost: '', retailPrice: '', marginPct: '', cogsRatio: '', setSampleCost: '', variance: '', currency: 'KES' });
  const [qcForm, setQcForm] = useState({ inspector: '', inspectedDate: '', stage: 'Fit Session', point: '', targetSpec: '', tolerance: '', actual: '', passFail: 'Pending', notes: '' });
  const [teamForm, setTeamForm] = useState({ designUserId: null as number | null, patternUserId: null as number | null, cadUserId: null as number | null, sampleUserId: null as number | null, buyingUserId: null as number | null });
  const [pulseOpen, setPulseOpen] = useState(false);
  const style = detail.data;
  const detailRecord = record(style);
  useEffect(() => {
    if (!style) return;
    setTeamForm({
      designUserId: style.designUserId ?? null,
      patternUserId: style.patternUserId ?? null,
      cadUserId: style.cadUserId ?? null,
      sampleUserId: style.sampleUserId ?? null,
      buyingUserId: style.buyingUserId ?? null,
    });
  }, [style?.id, style?.designUserId, style?.patternUserId, style?.cadUserId, style?.sampleUserId, style?.buyingUserId]);
  const patch = (setter: (value: (current: any) => any) => void, key: string, value: string) => setter((current) => ({ ...current, [key]: value }));
  const invalidate = () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceStylePlmQueryKey(id) }); queryClient.invalidateQueries({ queryKey: getGetWorkspaceStyleQueryKey(id) }); queryClient.invalidateQueries({ queryKey: getListWorkspaceStylesQueryKey() }); queryClient.invalidateQueries({ queryKey: ['workspace', 'range-plan'] }); };
  const save = (mutation: { mutate: (variables: any, options: any) => void; isPending: boolean }, data: unknown, label: string) => mutation.mutate({ id, data }, { onSuccess: () => { setNotice(label); invalidate(); } });
  const saveTeam = () => updateStyle.mutate({ id, data: teamForm }, { onSuccess: () => { setNotice('Style Team saved'); invalidate(); } });
  const saveClassification = (field: 'launchRoute' | 'styleClassification' | 'rangeTier' | 'season', value: string) => updateStyle.mutate({ id, data: { [field]: value || null } }, { onSuccess: () => { setNotice(field === 'season' ? 'Season saved' : 'Classification saved'); invalidate(); } });
  const hydrateTech = () => { const tech = record(style?.techPack); setTechForm({ basePatternReference: pick(tech, ['basePatternReference'], ''), fabricId: pick(tech, ['fabricId'], ''), trimsAccessories: pick(tech, ['trimsAccessories'], ''), constructionNotes: pick(tech, ['constructionNotes'], ''), audacesFileReference: pick(tech, ['audacesFileReference'], ''), modifiedFromStyleNumber: pick(tech, ['modifiedFromStyleNumber'], ''), status: pick(tech, ['status'], 'Draft'), version: pick(tech, ['version'], '1.0'), owner: pick(tech, ['owner'], '') }); };
  const hydrateCost = () => { const cost = record(style?.costEstimate); setCostForm(Object.fromEntries(Object.keys(costForm).map((key) => [key, pick(cost, [key], key === 'currency' ? 'KES' : '')])) as typeof costForm); };
  const detailTabs = <nav className="plm-drawer-tabs" aria-label="Style detail sections">{TABS.map((item) => <button className={tab === item ? 'active' : ''} key={item} onClick={() => { setTab(item); setNotice(''); if (item === 'Tech Pack') hydrateTech(); if (item === 'Cost Estimate') hydrateCost(); }} data-testid={`button-plm-tab-${item.toLowerCase().replaceAll(' ', '-')}`}>{item}{item === 'Feedback' && <span className="plm-tab-count">{feedback.data?.length ?? 0}</span>}</button>)}</nav>;
  const formInput = (value: string, setter: (value: string) => void, props?: Record<string, string>) => <input value={value} onChange={(event) => setter(event.target.value)} {...props} />;
   const detailContent = () => {
    if (!style) return null;
     if (tab === 'Feedback') return <StyleFeedbackPanel styleId={id} />;
    if (tab === 'Overview') {
      const history = (detailRecord.stageHistory as unknown[] | undefined) || [];
      const checklist = [{ label: 'Brief and concept', complete: stageIndex(stageFor(style)) >= 0 }, { label: 'Tech pack', complete: !!Object.keys(record(style.techPack)).length }, { label: 'Fit approved', complete: stageIndex(stageFor(style)) >= 5 }, { label: 'Grading complete', complete: stageIndex(stageFor(style)) >= 6 }, { label: 'Cost estimate', complete: !!Object.keys(record(style.costEstimate)).length }, { label: 'POM / QC', complete: !!(Array.isArray(style.pomQc) ? style.pomQc.length : Object.keys(record(style.pomQc)).length) }, { label: 'Production order', complete: !!Object.keys(record(style.productionOrder)).length }];
       return <div className="plm-overview-detail"><div className="plm-detail-summary"><div className="plm-detail-image" style={{ backgroundImage: `url(${imageFor(style)})` }} /><div><span className="plm-kicker">{text(style.code, `ST-${style.id}`)}</span><h3>{style.name}</h3><p>{style.brand} · {style.category} · {text(style.designer || style.owner, 'Unassigned')}</p><div className="plm-detail-facts"><span><b>Stage</b>{stageFor(style)}</span><span><b>Target</b>{dateLabel(style.targetDate)}</span><span><b>Days here</b>{daysInStage(style)} days</span></div><div className="plm-classification-chips" aria-label="Style classification"><span className="plm-classification-chip route">Route {text(style.launchRoute, '—')}</span><span className="plm-classification-chip classification">{text(style.styleClassification, '—')}</span><span className="plm-classification-chip tier">Tier {text(style.rangeTier || style.tier, '—')}</span></div><div className="plm-classification-editor"><div className="plm-editor-label">Edit classification <small>auto-saves</small></div><div className="plm-classification-fields"><label><span>Launch route</span><select value={style.launchRoute || ''} onChange={(event) => saveClassification('launchRoute', event.target.value)} disabled={updateStyle.isPending}><option value="">Not set</option>{LAUNCH_ROUTES.map((value) => <option key={value}>{value}</option>)}</select></label><label><span>Style classification</span><select value={style.styleClassification || ''} onChange={(event) => saveClassification('styleClassification', event.target.value)} disabled={updateStyle.isPending}><option value="">Not set</option>{STYLE_CLASSIFICATIONS.map((value) => <option key={value}>{value}</option>)}</select></label><label><span>Range tier</span><select value={style.rangeTier || ''} onChange={(event) => saveClassification('rangeTier', event.target.value)} disabled={updateStyle.isPending}><option value="">Not set</option>{RANGE_TIERS.map((value) => <option key={value}>{value}</option>)}</select></label></div></div></div></div><StyleTeamSection members={teamDirectory.data || []} values={teamForm} legacyOwner={style.owner} onChange={(key, value) => setTeamForm((current) => ({ ...current, [key]: value }))} onSave={saveTeam} pending={updateStyle.isPending} notice={notice} />{updateStyle.isError && <FormError />}<section className="plm-detail-section"><div className="plm-section-title"><h4>Development checklist</h4><span>{checklist.filter((item) => item.complete).length}/{checklist.length} complete</span></div>{checklist.map((item) => <div className="plm-check-row" key={item.label}><span className={item.complete ? 'checked' : ''}>{item.complete && <Check size={12} />}</span><b>{item.label}</b><small>{item.complete ? 'Complete' : 'Open'}</small></div>)}</section><section className="plm-detail-section"><div className="plm-section-title"><h4>Stage history</h4><Clock3 size={15} /></div>{history.length ? history.map((event, index) => <div className="plm-history-row" key={pick(event, ['id'], String(index))}><span className="history-line" /><div><b>{pick(event, ['toStage'], 'Stage updated')}</b><p>{pick(event, ['note'], 'No handoff note recorded.')}</p><small>{pick(event, ['userName'], 'Workspace member')} · {dateLabel(pick(event, ['timestamp', 'createdAt']))}</small></div></div>) : <p className="plm-muted-copy">Stage decisions will be recorded here as the style moves through the room.</p>}</section></div>;
    }
     if (tab === 'Tech Pack' || tab === 'Pattern') return <form className="plm-detail-form" onSubmit={(event) => { event.preventDefault(); save(techPack, { ...techForm, fabricId: techForm.fabricId ? Number(techForm.fabricId) : undefined }, 'Tech pack saved'); }}><div className="plm-form-heading"><div><span className="plm-kicker">{tab === 'Pattern' ? 'Pattern reference' : 'Production brief'}</span><h3>{tab === 'Pattern' ? 'Anchor the pattern work.' : 'Keep the handoff explicit.'}</h3></div><PackageCheck size={19} /></div><div className="plm-form-grid"><Field label="Base pattern reference">{formInput(techForm.basePatternReference, (value) => patch(setTechForm, 'basePatternReference', value), { placeholder: 'e.g. BP-26-018' })}</Field><Field label="Fabric"><select value={techForm.fabricId} onChange={(event) => patch(setTechForm, 'fabricId', event.target.value)}><option value="">Select fabric</option>{(meta.data?.fabrics || []).map((fabric, index) => <option key={index} value={pick(fabric, ['id'], '')}>{pick(fabric, ['name', 'code'], `Fabric ${index + 1}`)}</option>)}</select></Field><Field label="Trims and accessories"><textarea value={techForm.trimsAccessories} onChange={(event) => patch(setTechForm, 'trimsAccessories', event.target.value)} placeholder="Buttons, labels, closures…" /></Field><Field label="Construction notes"><textarea value={techForm.constructionNotes} onChange={(event) => patch(setTechForm, 'constructionNotes', event.target.value)} placeholder="Construction decisions for the factory…" /></Field><Field label="Audaces file reference">{formInput(techForm.audacesFileReference, (value) => patch(setTechForm, 'audacesFileReference', value), { placeholder: 'File path or reference' })}</Field><Field label="Modified from style">{formInput(techForm.modifiedFromStyleNumber, (value) => patch(setTechForm, 'modifiedFromStyleNumber', value), { placeholder: 'Optional style number' })}</Field><Field label="Version">{formInput(techForm.version, (value) => patch(setTechForm, 'version', value), { placeholder: '1.0' })}</Field></div>{notice && <FormNotice message={notice} />}{techPack.isError && <FormError />}{formActions(techPack.isPending, 'Save tech pack')}</form>;
    if (tab === 'Fit Session') return <div className="plm-detail-form"><div className="plm-form-heading"><div><span className="plm-kicker">Fit room</span><h3>Log a fit session.</h3></div><Ruler size={19} /></div><form onSubmit={(event) => { event.preventDefault(); save(fitSession, { ...fitForm }, 'Fit session added'); }}><div className="plm-form-grid"><Field label="Session date"><input required type="date" value={fitForm.sessionDate} onChange={(event) => patch(setFitForm, 'sessionDate', event.target.value)} /></Field><Field label="Sample"><input required value={fitForm.sample} onChange={(event) => patch(setFitForm, 'sample', event.target.value)} /></Field><Field label="Model name"><input required value={fitForm.modelName} onChange={(event) => patch(setFitForm, 'modelName', event.target.value)} /></Field><Field label="Attendees"><input value={fitForm.attendees} onChange={(event) => patch(setFitForm, 'attendees', event.target.value)} placeholder="Names separated by commas" /></Field><Field label="Outcome"><select value={fitForm.outcome} onChange={(event) => patch(setFitForm, 'outcome', event.target.value)}><option>Needs Revision</option><option>Approved</option></select></Field><Field label="Comments"><textarea value={fitForm.comments} onChange={(event) => patch(setFitForm, 'comments', event.target.value)} placeholder="Record the decision and next action…" /></Field></div>{fitSession.isError && <FormError />}{notice && <FormNotice message={notice} />}{formActions(fitSession.isPending, 'Add fit session')}</form><RecordList title="Previous fit sessions" items={(style.fitSessions || []) as unknown[]} /></div>;
    if (tab === 'Grading') return <div className="plm-detail-form"><div className="plm-form-heading"><div><span className="plm-kicker">Size architecture</span><h3>Set grading ownership.</h3></div><Shirt size={19} /></div><form onSubmit={(event) => { event.preventDefault(); save(grading, { ...gradingForm }, 'Grading updated'); }}><div className="plm-form-grid"><Field label="Size range"><input required value={gradingForm.sizeRange} onChange={(event) => patch(setGradingForm, 'sizeRange', event.target.value)} placeholder="e.g. 6–18" /></Field><Field label="CAD team member"><input value={gradingForm.cadTeamMember} onChange={(event) => patch(setGradingForm, 'cadTeamMember', event.target.value)} placeholder="Name" /></Field><Field label="Status"><select value={gradingForm.status} onChange={(event) => patch(setGradingForm, 'status', event.target.value)}><option>Pending</option><option>In Progress</option><option>Complete</option></select></Field></div>{grading.isError && <FormError />}{notice && <FormNotice message={notice} />}{formActions(grading.isPending, 'Save grading')}</form><RecordList title="Grading records" items={(style.gradings || []) as unknown[]} /></div>;
    if (tab === 'Samples') return <div className="plm-detail-form"><div className="plm-form-heading"><div><span className="plm-kicker">Sample room</span><h3>Register the next sample.</h3></div><Tag size={19} /></div><form onSubmit={(event) => { event.preventDefault(); save(sample, { ...sampleForm, unitsOrdered: Number(sampleForm.unitsOrdered) }, 'Sample added'); }}><div className="plm-form-grid"><Field label="Purpose"><input required value={sampleForm.purpose} onChange={(event) => patch(setSampleForm, 'purpose', event.target.value)} /></Field><Field label="Pattern maker"><input required value={sampleForm.patternMaker} onChange={(event) => patch(setSampleForm, 'patternMaker', event.target.value)} /></Field><Field label="Sample makers"><input value={sampleForm.sampleMakers} onChange={(event) => patch(setSampleForm, 'sampleMakers', event.target.value)} /></Field><Field label="Units ordered"><input required type="number" min="1" value={sampleForm.unitsOrdered} onChange={(event) => patch(setSampleForm, 'unitsOrdered', event.target.value)} /></Field><Field label="Date cut"><input type="date" value={sampleForm.dateCut} onChange={(event) => patch(setSampleForm, 'dateCut', event.target.value)} /></Field><Field label="Date finished"><input type="date" value={sampleForm.dateFinished} onChange={(event) => patch(setSampleForm, 'dateFinished', event.target.value)} /></Field><Field label="Status"><select value={sampleForm.status} onChange={(event) => patch(setSampleForm, 'status', event.target.value)}><option>Planned</option><option>In Progress</option><option>Complete</option><option>Rework</option></select></Field><Field label="Rework notes"><textarea value={sampleForm.reworkNotes} onChange={(event) => patch(setSampleForm, 'reworkNotes', event.target.value)} /></Field></div>{sample.isError && <FormError />}{notice && <FormNotice message={notice} />}{formActions(sample.isPending, 'Add sample')}</form><RecordList title="Sample development" items={(style.samples || []) as unknown[]} /></div>;
    if (tab === 'Cost Estimate') return <form className="plm-detail-form" onSubmit={(event) => { event.preventDefault(); const numeric = Object.fromEntries(Object.entries(costForm).map(([key, value]) => [key, key === 'currency' ? value : value === '' ? undefined : Number(value)])); save(costEstimate, numeric, 'Cost estimate saved'); }}><div className="plm-form-heading"><div><span className="plm-kicker">Commercial gate</span><h3>Make the cost visible.</h3></div><SlidersHorizontal size={19} /></div><div className="plm-form-grid">{[['avgMatKg', 'Average material kg'], ['avgMetresUsed', 'Average metres used'], ['minsPerPc', 'Minutes per piece'], ['efficiencyPct', 'Efficiency %'], ['materialCost', 'Material cost'], ['labourCost', 'Labour cost'], ['totalCost', 'Total cost'], ['retailPrice', 'Retail price'], ['marginPct', 'Margin %'], ['cogsRatio', 'COGS ratio'], ['setSampleCost', 'Set sample cost'], ['variance', 'Variance']].map(([key, label]) => <Field key={key} label={label}><input type="number" step="0.01" value={costForm[key as keyof typeof costForm]} onChange={(event) => patch(setCostForm, key, event.target.value)} /></Field>)}<Field label="Currency"><input value={costForm.currency} onChange={(event) => patch(setCostForm, 'currency', event.target.value)} /></Field></div>{costEstimate.isError && <FormError />}{notice && <FormNotice message={notice} />}{formActions(costEstimate.isPending, 'Save estimate')}</form>;
    if (tab === 'POM QC') return <div className="plm-detail-form"><div className="plm-form-heading"><div><span className="plm-kicker">Quality gate</span><h3>Record a point of measure.</h3></div><Ruler size={19} /></div><form onSubmit={(event) => { event.preventDefault(); const existing = Array.isArray(style.pomQc) ? style.pomQc : []; save(pomQc, { inspector: qcForm.inspector, inspectedDate: qcForm.inspectedDate, stage: qcForm.stage, rows: [...existing, { point: qcForm.point, targetSpec: Number(qcForm.targetSpec), tolerance: Number(qcForm.tolerance), actual: Number(qcForm.actual), passFail: qcForm.passFail, notes: qcForm.notes }] }, 'POM QC saved'); }}><div className="plm-form-grid"><Field label="Inspector"><input value={qcForm.inspector} onChange={(event) => patch(setQcForm, 'inspector', event.target.value)} /></Field><Field label="Inspected date"><input type="date" value={qcForm.inspectedDate} onChange={(event) => patch(setQcForm, 'inspectedDate', event.target.value)} /></Field><Field label="Stage"><select value={qcForm.stage} onChange={(event) => patch(setQcForm, 'stage', event.target.value)}>{MAIN_STAGES.map((stage) => <option key={stage}>{stage}</option>)}</select></Field><Field label="Point"><input required value={qcForm.point} onChange={(event) => patch(setQcForm, 'point', event.target.value)} placeholder="e.g. Chest width" /></Field><Field label="Target spec"><input required type="number" step="0.1" value={qcForm.targetSpec} onChange={(event) => patch(setQcForm, 'targetSpec', event.target.value)} /></Field><Field label="Tolerance"><input required type="number" step="0.1" value={qcForm.tolerance} onChange={(event) => patch(setQcForm, 'tolerance', event.target.value)} /></Field><Field label="Actual"><input required type="number" step="0.1" value={qcForm.actual} onChange={(event) => patch(setQcForm, 'actual', event.target.value)} /></Field><Field label="Result"><select value={qcForm.passFail} onChange={(event) => patch(setQcForm, 'passFail', event.target.value)}><option>Pending</option><option>Pass</option><option>Fail</option></select></Field><Field label="Notes"><textarea value={qcForm.notes} onChange={(event) => patch(setQcForm, 'notes', event.target.value)} /></Field></div>{pomQc.isError && <FormError />}{notice && <FormNotice message={notice} />}{formActions(pomQc.isPending, 'Save QC point')}</form><RecordList title="Logged POM checks" items={(Array.isArray(style.pomQc) ? style.pomQc : (record(style.pomQc).rows as unknown[] || [])) as unknown[]} /></div>;
    return <div className="plm-production-tab"><div className="plm-form-heading"><div><span className="plm-kicker">Factory handoff</span><h3>Production order</h3></div><Archive size={19} /></div><div className="plm-production-grid">{[['Order number', pick(style.productionOrder, ['orderNumber', 'number'])], ['Supplier', pick(style.productionOrder, ['supplier', 'factory'])], ['Quantity', pick(style.productionOrder, ['quantity', 'units'])], ['Status', pick(style.productionOrder, ['status'], 'Not opened')], ['Planned ex-factory', dateLabel(pick(style.productionOrder, ['plannedExFactoryDate', 'exFactoryDate'], ''))], ['Markets', pick(style.productionOrder, ['markets', 'market'], 'East Africa')]].map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div><div className="plm-production-note"><PackageCheck size={17} /><p>Production becomes actionable after the style clears costing, POM QC, and the approval gate.</p></div></div>;
  };
  if (detail.isLoading) return <div className="plm-drawer-backdrop" onClick={onClose}><aside className="plm-drawer" onClick={(event) => event.stopPropagation()}><div className="plm-drawer-loading"><div /><div /><div /><div /></div></aside></div>;
  if (detail.isError || !style) return <div className="plm-drawer-backdrop" onClick={onClose}><aside className="plm-drawer" onClick={(event) => event.stopPropagation()}><div className="plm-drawer-error"><CircleAlert size={20} /><h3>Style record unavailable</h3><p>We couldn't load the PLM detail. Your board is still available.</p><button className="plm-button quiet" onClick={() => detail.refetch()} data-testid="button-retry-plm-detail">Try again</button></div></aside></div>;
    return <><div className="plm-drawer-backdrop" onClick={onClose}><aside className="plm-drawer" onClick={(event) => event.stopPropagation()}><header className="plm-drawer-head"><div className="plm-drawer-head-copy"><span className="plm-kicker">Style record / {text(style.code, `ST-${style.id}`)}</span><h2>{style.name}</h2><p>{style.brand} · {style.category}</p><button type="button" className="plm-request-feedback-button" onClick={() => setPulseOpen(true)} data-testid="button-request-style-feedback"><MessageCircle size={13} /> Request Feedback</button></div><button className="plm-close" onClick={onClose} aria-label="Close style detail" data-testid="button-close-plm-detail"><X size={18} /></button></header>{detailTabs}<div className="plm-drawer-body">{detailContent()}<SeasonEditor value={(style as WorkspaceStyle & { season?: string }).season} onSave={(value) => saveClassification('season', value)} pending={updateStyle.isPending} /></div></aside></div>{pulseOpen && <StylePulseModal style={style} onClose={() => setPulseOpen(false)} />}</>;
}

function SeasonEditor({ value, onSave, pending }: { value: string | null | undefined; onSave: (value: string) => void; pending: boolean }) {
  return <section className="plm-detail-section plm-season-editor"><div className="plm-section-title"><div><span className="plm-kicker">Assortment plan</span><h4>Season</h4></div><span className="season-chip">{value || 'Q3 2026'}</span></div><label className="plm-season-field"><span>Move this style between quarter edits</span><select value={value || 'Q3 2026'} onChange={(event) => onSave(event.target.value)} disabled={pending}>{SEASONS.map((season) => <option key={season}>{season}</option>)}</select></label></section>;
}
function FormError() { return <div className="plm-form-error"><CircleAlert size={15} /> We couldn't save this record. Check the fields and try again.</div>; }
function FormNotice({ message }: { message: string }) { return <div className="plm-form-notice"><Check size={15} /> {message}</div>; }
function formActions(pending: boolean, label: string) { return <div className="plm-form-actions"><button className="plm-button primary" type="submit" disabled={pending} data-testid={`button-save-plm-${label.toLowerCase().replaceAll(' ', '-')}`}><Save size={14} />{pending ? 'Saving…' : label}</button></div>; }
function RecordList({ title, items }: { title: string; items: unknown[] }) { return <section className="plm-record-list"><div className="plm-section-title"><h4>{title}</h4><span>{items.length}</span></div>{items.length ? items.slice().reverse().slice(0, 4).map((item, index) => <div className="plm-record" key={index}><b>{pick(item, ['purpose', 'sample', 'point', 'status'], `Record ${index + 1}`)}</b><span>{pick(item, ['outcome', 'actual', 'comments', 'notes'], 'Saved to style record')}</span></div>) : <p className="plm-muted-copy">No records have been added yet.</p>}</section>; }

export default function PlmPage() {
  const queryClient = useQueryClient();
  const [location, setLocation] = useLocation();
  const plmSource = { source: 'pd' as const };
  const stylesQuery = useListWorkspaceStyles(plmSource, { query: { queryKey: getListWorkspaceStylesQueryKey(plmSource) } });
  const transition = useTransitionWorkspaceStyle();
  const [view, setView] = useState<'kanban' | 'list'>('kanban');
  const [selected, setSelected] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState<number | null>(null);
  const [newStyle, setNewStyle] = useState(false);
  const [search, setSearch] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    if (typeof window === 'undefined') return 'stage';
    const saved = window.localStorage.getItem(GROUP_BY_STORAGE_KEY);
    return GROUP_BY_OPTIONS.some((option) => option.value === saved) ? saved as GroupBy : 'stage';
  });
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  // brand / category / stage are multi-select (empty array = All); the rest stay single-value
  const [filters, setFilters] = useState<{ brand: string[]; category: string[]; stage: string[]; designer: string; tier: string; orderType: string; launchRoute: string; rangeTier: string; season: string }>({ brand: [], category: [], stage: [], designer: 'All', tier: 'All', orderType: 'All', launchRoute: 'All', rangeTier: 'All', season: 'All' });
  const [snapshotFilter, setSnapshotFilter] = useState<'due' | 'at-risk' | null>(null);
  const styles = stylesQuery.data || [];
  useEffect(() => {
    const focus = new URLSearchParams(location.split('?')[1] || '').get('focus');
    if (focus === 'due' || focus === 'at-risk') setSnapshotFilter(focus);
    else setSnapshotFilter(null);
  }, [location]);
  const choices = useMemo(() => ({ brand: ['All', ...Array.from(new Set(styles.map((style) => style.brand)))], category: ['All', ...Array.from(new Set(styles.map((style) => style.category)))], designer: ['All', ...Array.from(new Set(styles.map((style) => text(style.designer || style.owner, 'Unassigned'))))], tier: ['All', ...Array.from(new Set(styles.map((style) => text(style.tier, '—'))))], orderType: ['All', ...Array.from(new Set(styles.map((style) => text(style.orderType, '—'))))], stage: ['All', ...ALL_STAGES], launchRoute: ['All', ...Array.from(new Set(styles.map((style) => text(style.launchRoute, '—'))))], rangeTier: ['All', ...Array.from(new Set(styles.map((style) => text(style.rangeTier, '—'))))], season: ['All', 'Q3 2026', 'Q4 2026', 'Q3+Q4'] }), [styles]);
  const filtered = useMemo(() => styles.filter((style) => {
    const query = search.trim().toLowerCase();
    const now = new Date();
    const weekStart = new Date();
    const day = weekStart.getDay();
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - (day === 0 ? 6 : day - 1));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const dueThisWeek = [style.targetOrderWeek, style.plannedLaunchWeek, style.targetDate]
      .some((value) => isDueThisWeek(value, weekStart, weekEnd, isoWeekNumber(now)));
    const target = style.targetDate ? new Date(style.targetDate) : null;
    const atRisk = !!target && target < new Date(new Date().setHours(0, 0, 0, 0)) && stageFor(style) !== 'Launched';
    return (!query || `${style.code} ${style.name} ${style.category}`.toLowerCase().includes(query))
      && (filters.brand.length === 0 || filters.brand.includes(style.brand))
      && (filters.category.length === 0 || filters.category.includes(style.category))
      && (filters.designer === 'All' || text(style.designer || style.owner, 'Unassigned') === filters.designer)
      && (filters.tier === 'All' || text(style.tier, '—') === filters.tier)
      && (filters.orderType === 'All' || text(style.orderType, '—') === filters.orderType)
      && (filters.stage.length === 0 || filters.stage.includes(stageFor(style)))
       && (filters.launchRoute === 'All' || text(style.launchRoute, '—') === filters.launchRoute)
       && (filters.rangeTier === 'All' || text(style.rangeTier, '—') === filters.rangeTier)
       && (filters.season === 'All' || (filters.season === 'Q3+Q4' ? String((style as WorkspaceStyle & { season?: string }).season || '').includes(',') : String((style as WorkspaceStyle & { season?: string }).season || '').includes(filters.season)))
      && (!snapshotFilter || (snapshotFilter === 'due' ? dueThisWeek : atRisk));
  }), [styles, filters, search, snapshotFilter]);
  const stageGrouped = useMemo(() => Object.fromEntries(ALL_STAGES.map((stage) => [stage, filtered.filter((style) => stageFor(style) === stage)])) as Record<string, WorkspaceStyle[]>, [filtered]);
  const boardColumns = useMemo(() => {
    const keys = groupKeysFor(styles, groupBy);
    return keys.map((key) => ({ key, styles: filtered.filter((style) => groupValueFor(style, groupBy) === key) }));
  }, [styles, filtered, groupBy]);
  const transitionStyle = (id: number, toStage: string) => { setMenuOpen(null); transition.mutate({ id, data: { toStage } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListWorkspaceStylesQueryKey() }); if (selected === id) { queryClient.invalidateQueries({ queryKey: getGetWorkspaceStylePlmQueryKey(id) }); queryClient.invalidateQueries({ queryKey: getGetWorkspaceStyleQueryKey(id) }); } } }); };
  const clearFilters = () => { setSearch(''); setFilters({ brand: [], category: [], stage: [], designer: 'All', tier: 'All', orderType: 'All', launchRoute: 'All', rangeTier: 'All', season: 'All' }); setSnapshotFilter(null); if (location.includes('?')) setLocation('/product-workspace/plm'); };
  const filtersActive = filters.brand.length > 0 || filters.category.length > 0 || filters.stage.length > 0 || ([filters.designer, filters.tier, filters.orderType, filters.launchRoute, filters.rangeTier, filters.season] as string[]).some((value) => value !== 'All');
  const selectGroupBy = (value: GroupBy) => { setGroupBy(value); window.localStorage.setItem(GROUP_BY_STORAGE_KEY, value); setGroupMenuOpen(false); };
  if (stylesQuery.isLoading) return <section className="page plm-page"><div className="plm-loading-heading"><div /><div /><div /></div><div className="plm-loading-board">{MAIN_STAGES.slice(0, 5).map((stage) => <div key={stage} />)}</div></section>;
  if (stylesQuery.isError) return <section className="page plm-page"><div className="plm-error-state"><CircleAlert size={22} /><h2>Style development is unavailable</h2><p>The workspace service did not return the pipeline. Your work is safe.</p><button className="plm-button primary" onClick={() => stylesQuery.refetch()} data-testid="button-retry-plm-board">Try again</button></div></section>;
  return <section className="page plm-page" onClick={() => { setMenuOpen(null); setGroupMenuOpen(false); }}>
    <header className="plm-page-heading"><div><span className="plm-kicker">Product lifecycle management / Q3 2026</span><h1>Style development</h1><p>Move each style from first thought to production-ready with the decision trail intact.</p></div><div className="plm-heading-actions"><div className="plm-view-switch" role="group" aria-label="View mode"><button className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')} data-testid="button-plm-kanban-view"><Columns3 size={15} /> Kanban</button><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} data-testid="button-plm-list-view"><FileText size={15} /> List</button></div><button className="plm-button primary" onClick={() => setNewStyle(true)} data-testid="button-new-style"><Plus size={15} /> New style</button></div></header>
      <div className="plm-pulse"><div><span className="plm-kicker">Pipeline pulse</span><strong>{filtered.length} <small>styles in view</small></strong></div><div className="plm-pulse-stats"><span><b>{filtered.filter((style) => stageFor(style) === 'On Hold').length}</b> on hold</span><span><b>{filtered.filter((style) => stageFor(style) === 'Dropped').length}</b> dropped</span><span><b>{filtered.filter((style) => stageIndex(stageFor(style)) >= 8).length}</b> near launch</span></div><div className="plm-pulse-track">{MAIN_STAGES.map((stage) => <span key={stage} style={{ height: `${Math.max(8, Math.min(100, (stageGrouped[stage]?.length || 0) * 20))}%` }} title={`${stage}: ${stageGrouped[stage]?.length || 0}`} />)}</div></div>
     {snapshotFilter && <div className="plm-snapshot-filter" data-testid="plm-snapshot-filter"><span>Dashboard view: <b>{snapshotFilter === 'due' ? 'Due this week' : 'At risk'}</b></span><button onClick={clearFilters} data-testid="button-clear-snapshot-filter">Clear filter <X size={13} /></button></div>}
    <div className="plm-toolbar">
      <label className="plm-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search style number, name or category" aria-label="Search styles" data-testid="input-search-plm-styles" /></label>
      <div className="plm-group-by">
        <button className="plm-group-button" onClick={(event) => { event.stopPropagation(); setGroupMenuOpen((open) => !open); }} aria-haspopup="menu" aria-expanded={groupMenuOpen} data-testid="button-plm-group-by">Group by: <strong>{groupLabel(groupBy)}</strong><ChevronDown size={13} /></button>
        {groupMenuOpen && <div className="plm-group-menu" role="menu" onClick={(event) => event.stopPropagation()}>{GROUP_BY_OPTIONS.map((option) => <button className={groupBy === option.value ? 'active' : ''} key={option.value} role="menuitemradio" aria-checked={groupBy === option.value} onClick={() => selectGroupBy(option.value)} data-testid={`option-plm-group-by-${option.value}`}>{option.label}{groupBy === option.value && <Check size={14} />}</button>)}</div>}
      </div>
      <div className="plm-filter-label"><Filter size={14} /> Filter by</div>
        {(['brand', 'category', 'stage'] as const).map((key) => <MultiSelectFilter key={key} variant="plm" label={key === 'category' ? 'Category' : key === 'stage' ? 'Stage' : 'Brand'} options={choices[key].filter((choice) => choice !== 'All')} values={filters[key]} onChange={(next) => setFilters((current) => ({ ...current, [key]: next }))} testId={`select-plm-filter-${key}`} />)}
        {(['designer', 'tier', 'orderType', 'launchRoute', 'rangeTier', 'season'] as const).map((key) => <label className="plm-filter" key={key}><span>{key === 'orderType' ? 'Order type' : key === 'launchRoute' ? 'Route' : key === 'rangeTier' ? 'Range tier' : key === 'season' ? 'Season' : key[0].toUpperCase() + key.slice(1)}</span><select value={filters[key]} onChange={(event) => setFilters((current) => ({ ...current, [key]: event.target.value }))} data-testid={`select-plm-filter-${key}`}><option>All</option>{choices[key].filter((choice) => choice !== 'All').map((choice) => <option key={choice}>{choice}</option>)}</select><ChevronDown size={13} /></label>)}
      {(search || filtersActive) && <button className="plm-clear-filter" onClick={clearFilters} data-testid="button-clear-plm-filters">Clear <X size={13} /></button>}
    </div>
    {transition.isError && <div className="plm-form-error plm-board-error"><CircleAlert size={15} /> That stage transition could not be saved. Try again.</div>}
     {view === 'kanban' ? <div className="plm-board-wrap"><div className="plm-board" style={{ gridTemplateColumns: `repeat(${Math.max(boardColumns.length, 1)}, 250px)` }}>{boardColumns.map(({ key, styles: columnStyles }, index) => <StageColumn key={key} stage={key} index={index} styles={columnStyles} selected={selected} onOpen={setSelected} onTransition={transitionStyle} onMenu={(id) => setMenuOpen(menuOpen === id ? null : id)} />)}</div></div> : <div className="plm-list-view">{filtered.length ? <table><thead><tr><th>Style</th><th>Brand</th><th>Stage</th><th>Designer</th><th>Route</th><th>Classification</th><th>Range tier</th><th>Days</th><th>Target</th><th /></tr></thead><tbody>{filtered.map((style) => <tr key={style.id} data-testid={`row-plm-style-${style.id}`}><td><button onClick={() => setSelected(style.id)} className="plm-list-style" data-testid={`button-open-plm-list-${style.id}`}><span className="plm-list-thumb" style={{ backgroundImage: `url(${imageFor(style)})` }} /><span><b>{style.name}</b><small>{text(style.code, `ST-${style.id}`)} · {style.category}</small></span></button></td><td><span className={`plm-brand ${style.brand.toLowerCase().includes('safari') ? 'safari' : ''}`}>{style.brand}</span></td><td><span className="plm-stage-chip">{stageFor(style)}</span></td><td>{text(style.designer || style.owner, 'Unassigned')}</td><td><span className="plm-classification-chip route">{text(style.launchRoute, '—')}</span></td><td><span className="plm-classification-chip classification">{text(style.styleClassification, '—')}</span></td><td><span className="plm-classification-chip tier">{text(style.rangeTier || style.tier, '—')}</span></td><td>{daysInStage(style)}d</td><td>{dateLabel(style.targetDate)}</td><td><button className="plm-table-action" onClick={() => transitionStyle(style.id, MAIN_STAGES[Math.min(MAIN_STAGES.length - 1, stageIndex(stageFor(style)) + 1)] || 'Launched')} disabled={stageFor(style) === 'Launched'} data-testid={`button-advance-list-style-${style.id}`}>Advance <ArrowRight size={13} /></button></td></tr>)}</tbody></table> : <EmptyPlm title="No styles match" detail="Adjust the search or filters to see more of the pipeline." action={<button className="plm-button quiet" onClick={clearFilters} data-testid="button-empty-clear-plm-filters">Clear filters</button>} />}</div>}
    {(stageGrouped['On Hold']?.length || stageGrouped.Dropped?.length) ? <footer className="plm-side-states"><span><Archive size={14} /> Side states</span>{SIDE_STAGES.map((stage) => <button key={stage} onClick={() => setFilters((current) => ({ ...current, stage: [stage] }))} data-testid={`button-filter-plm-${stage.toLowerCase().replace(' ', '-')}`}>{stage} <b>{stageGrouped[stage]?.length || 0}</b></button>)}</footer> : null}
    {newStyle && <NewStyleModal onClose={() => setNewStyle(false)} onCreated={(id) => { setNewStyle(false); setSelected(id); queryClient.invalidateQueries({ queryKey: getListWorkspaceStylesQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetWorkspaceStylePlmQueryKey(id) }); }} />}{selected && <DetailDrawer id={selected} onClose={() => setSelected(null)} />}
  </section>;
}