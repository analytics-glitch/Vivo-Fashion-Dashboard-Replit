import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { io } from 'socket.io-client';
import { ArrowLeft, ArrowRight, BarChart3, CalendarCheck2, CalendarDays, Check, ChevronDown, ChevronRight, CircleAlert, Clock3, Columns3, FileText, GalleryHorizontalEnd, History, LayoutDashboard, Library, ListChecks, LogOut, Menu, MessageCircle, Package, Palette, Plus, Search, Settings2, ShieldCheck, Sparkles, UsersRound, X } from 'lucide-react';
import {
  getGetWorkspaceBoardQueryKey, getGetWorkspaceDashboardQueryKey, getGetWorkspacePlanQueryKey, getGetWorkspaceSessionQueryKey,
  getListWorkspaceBoardsQueryKey, getListWorkspacePlanHistoryQueryKey, getListWorkspacePlansQueryKey, getListWorkspaceStylesQueryKey,
  useCreateWorkspaceBoard, useCreateWorkspaceBoardCard, useCreateWorkspaceBoardComment, useGetWorkspaceBoard, useGetWorkspaceDashboard,
  useAddWorkspacePlanStyle, useCreateWorkspacePlan, useGetWorkspacePlan, useGetWorkspaceSession,
  useListWorkspaceBoards, useListWorkspacePlanHistory, useListWorkspacePlans, useListWorkspaceStyles, useLoginWorkspace,
  useLogoutWorkspace, useUpdateWorkspaceBoardCard, useUpdateWorkspacePlan,
  getListWorkspaceTeamQueryKey, useListWorkspaceTeam,
} from '@workspace/api-client-react';
import type { WorkspaceBoard, WorkspaceDashboardSnapshot, WorkspacePlan, WorkspacePlanIndexItem, WorkspaceStyle } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import NotFound from '@/pages/not-found';
import GarmentImage from '@/components/GarmentImage';

const StyleDevelopmentTrackerPage = lazy(() => import('@/pages/StyleDevelopmentTrackerPage'));
const FeedbackPage = lazy(() => import('@/pages/FeedbackPage'));
const PublicFeedbackPage = lazy(() => import('@/pages/FeedbackPage').then(({ PublicFeedbackPage: Page }) => ({ default: Page })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const ShowcasePage = lazy(() => import('@/pages/ShowcasePage'));
const TeamDirectoryPage = lazy(() => import('@/pages/TeamDirectoryPage'));
const L10Page = lazy(() => import('@/pages/L10Page'));
const AssortmentPlanPage = lazy(() => import('@/pages/AssortmentPlanPage'));
const RangePlanPage = lazy(() => import('@/pages/RangePlanPage'));
const DefinitionsPage = lazy(() => import('@/pages/DefinitionsPage'));
const ResourcesPage = lazy(() => import('@/pages/ResourcesPage'));
const WeeklyOrderPlanPage = lazy(() => import('@/pages/WeeklyOrderPlanPage'));
const FabricStockMixPage = lazy(() => import('@/pages/FabricStockMixPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
  },
});
const nav = [
  { href: '/product-workspace/', label: 'Home', icon: LayoutDashboard },
  { href: '/product-workspace/style-development', label: 'Style Development', icon: Package },
  { href: '/product-workspace/weekly-order-plan', label: 'Weekly Order Plan', icon: CalendarCheck2 },
  { href: '/product-workspace/range-plan', label: 'Range Plan', icon: BarChart3 },
  { href: '/product-workspace/plan', label: 'Assortment Plan', icon: CalendarDays },
  { href: '/product-workspace/fabric-stock-mix', label: 'Fabric Stock Mix', icon: Palette },
  { href: '/product-workspace/showcase', label: 'Showcase', icon: GalleryHorizontalEnd },
  { href: '/product-workspace/l10', label: 'L10 Meeting', icon: ListChecks },
  { href: '/product-workspace/rocks', label: 'Rocks', icon: Columns3 },
  { href: '/product-workspace/feedback', label: 'Style Feedback', icon: MessageCircle },
  { href: '/product-workspace/team', label: 'Meet the Team', icon: UsersRound },
  { href: '/product-workspace/resources', label: 'Resources', icon: Library },
  { href: '/product-workspace/definitions', label: 'Definitions & Data Trust', icon: ShieldCheck },
];
const workspaceMarkets = ['KE', 'UG', 'RW'].join(' · ');
type TodayBirthday = { name: string; role: string };

function fmt(value: unknown, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function metricValue(value: unknown, suffix: unknown, fallback: string) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
    const suffixText = suffix ? String(suffix) : '';
    return `${rounded}${suffixText ? (suffixText === '%' ? suffixText : ` ${suffixText}`) : ''}`;
  }
  return fmt(value, fallback);
}
function apiDecimal(value: unknown, digits = 1, suffix = '') {
  const numeric = Number(value);
  return value === null || value === undefined || !Number.isFinite(numeric)
    ? '—'
    : `${numeric.toFixed(digits)}${suffix}`;
}
function initials(name = 'Vivo team') { return name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
function date(value: unknown) { if (!value) return 'No date'; const d = new Date(String(value)); return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); }
function getPathValue(item: unknown, keys: string[]) { const record = item as Record<string, unknown>; return keys.map((key) => record?.[key]).find((value) => value !== undefined); }

type WorkspaceIdentity = { id: string; name: string; role: string };
function readIdentity(): WorkspaceIdentity | null {
  const id = localStorage.getItem('workspace_user_id');
  if (!id) return null;
  return { id, name: localStorage.getItem('workspace_user_name') || '', role: localStorage.getItem('workspace_user_role') || '' };
}

function IdentityModal({ onPick, onClose, canClose }: { onPick: (identity: WorkspaceIdentity) => void; onClose: () => void; canClose: boolean }) {
  const [typedName, setTypedName] = useState('');
  const team = useListWorkspaceTeam({
    query: { queryKey: getListWorkspaceTeamQueryKey(), retry: false },
    request: { credentials: 'include' },
  });
  const teamMembers = useMemo(
    () => [...(team.data ?? [])].filter((member) => member.name.trim()).sort((a, b) => {
      const aIsAdmin = a.role.trim().toLowerCase() === 'admin';
      const bIsAdmin = b.role.trim().toLowerCase() === 'admin';
      if (aIsAdmin !== bIsAdmin) return aIsAdmin ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    }),
    [team.data],
  );
  const submitTypedName = (event: FormEvent) => {
    event.preventDefault();
    const name = typedName.trim();
    if (!name) return;
    onPick({ id: `custom:${name.toLocaleLowerCase()}`, name, role: 'Team member' });
  };
  const continueAsGuest = () => onPick({ id: 'guest', name: 'Guest', role: 'Guest' });
  return (
    <div className="settings-modal-backdrop" onClick={canClose ? onClose : undefined}>
      <div className="settings-modal identity-modal" role="dialog" aria-modal="true" aria-label="Who are you?" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-head">
          <h3>Who are you?</h3>
          {canClose && <button className="icon-button" onClick={onClose} aria-label="Close" data-testid="button-close-identity"><X size={16} /></button>}
        </div>
        <p className="settings-note">Pick your name so your work is attributed correctly.</p>
        {team.isLoading ? (
          <p className="settings-empty">Loading the team…</p>
        ) : team.isError ? (
          <p className="settings-empty">We couldn't load the team list right now. Please try again shortly.</p>
        ) : teamMembers.length ? (
          <div className="identity-list">
            {teamMembers.map((member) => (
              <button
                key={member.id}
                className="identity-card"
                onClick={() => onPick({ id: String(member.id), name: member.name, role: member.role })}
                data-testid={`button-identity-${member.id}`}
              >
                <span className="avatar" style={{ background: '#C9A96E' }}>{initials(member.name)}</span>
                <span className="identity-card-copy"><strong>{member.name}</strong><span>{member.role}{member.department ? ` · ${member.department}` : ''}</span></span>
              </button>
            ))}
          </div>
        ) : (
          <p className="settings-empty">No saved team members yet. You can still continue below.</p>
        )}
        <form className="identity-fallback" onSubmit={submitTypedName}>
          <label htmlFor="identity-name">Or type your name...</label>
          <div className="identity-fallback-row">
            <input
              id="identity-name"
              value={typedName}
              onChange={(event) => setTypedName(event.target.value)}
              placeholder="Type your name..."
              autoComplete="name"
              data-testid="input-identity-name"
            />
            <button className="button button-dark" type="submit" disabled={!typedName.trim()} data-testid="button-continue-identity">Continue →</button>
          </div>
        </form>
        <button className="identity-guest-link" type="button" onClick={continueAsGuest} data-testid="button-continue-guest">Continue as guest</button>
      </div>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('workspace_sidebar_collapsed') === 'true');
  const session = useGetWorkspaceSession({ query: { queryKey: getGetWorkspaceSessionQueryKey(), retry: false } });
  const logout = useLogoutWorkspace();
  const [identity, setIdentity] = useState<WorkspaceIdentity | null>(() => readIdentity());
  const [identityOpen, setIdentityOpen] = useState(() => readIdentity() === null);
  const team = useListWorkspaceTeam({
    query: { queryKey: getListWorkspaceTeamQueryKey(), retry: false },
    request: { credentials: 'include' },
  });
  useEffect(() => {
    if (!team.data || !identity || identity.id === 'guest' || identity.id.startsWith('custom:')) return;
    const member = team.data.find((m) => String(m.id) === identity.id);
    if (!member) {
      localStorage.removeItem('workspace_user_id');
      localStorage.removeItem('workspace_user_name');
      localStorage.removeItem('workspace_user_role');
      setIdentity(null);
      setIdentityOpen(true);
    } else if (member.name !== identity.name || member.role !== identity.role) {
      localStorage.setItem('workspace_user_name', member.name);
      localStorage.setItem('workspace_user_role', member.role);
      setIdentity({ id: identity.id, name: member.name, role: member.role });
    }
  }, [team.data, identity]);
  const pickIdentity = (picked: WorkspaceIdentity) => {
    localStorage.setItem('workspace_user_id', picked.id);
    localStorage.setItem('workspace_user_name', picked.name);
    localStorage.setItem('workspace_user_role', picked.role);
    setIdentity(picked);
    setIdentityOpen(false);
  };
  const focusAssortmentSearch = () => {
    if (location === '/product-workspace/plan') {
      document.querySelector<HTMLInputElement>('[data-assortment-search]')?.focus();
      return;
    }
    sessionStorage.setItem('workspace_focus_assortment_search', '1');
    setLocation('/product-workspace/plan');
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (location === '/product-workspace/plan') {
          document.querySelector<HTMLInputElement>('[data-assortment-search]')?.focus();
        } else {
          sessionStorage.setItem('workspace_focus_assortment_search', '1');
          setLocation('/product-workspace/plan');
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [location, setLocation]);
  const login = location.includes('/login');
  if (login) return <>{children}</>;
  if (session.isLoading) return <LoadingState />;
  const doLogout = () => logout.mutate(undefined, { onSuccess: () => setLocation('/product-workspace/login') });
  const collapseSidebar = () => {
    setSidebarCollapsed(true);
    setMobileOpen(false);
    localStorage.setItem('workspace_sidebar_collapsed', 'true');
  };
  const expandSidebar = () => {
    setSidebarCollapsed(false);
    localStorage.setItem('workspace_sidebar_collapsed', 'false');
    if (window.matchMedia('(max-width: 760px)').matches) setMobileOpen(true);
  };
  return (
    <div className={`workspace-app ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`workspace-sidebar ${mobileOpen ? 'is-open' : ''} ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark">V</div>
          <div><div className="brand-name">Vivo</div><div className="brand-sub">Product workspace</div></div>
          <button className="icon-button sidebar-close" onClick={collapseSidebar} aria-label="Collapse sidebar" data-testid="button-collapse-sidebar"><X size={18} /></button>
        </div>
        <div className="workspace-rule" />
        <div className="eyebrow sidebar-eyebrow">East Africa / 29 stores</div>
        <nav className="workspace-nav" aria-label="Workspace navigation">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={`workspace-nav-link ${location === href || (href !== '/product-workspace/' && location.startsWith(href)) ? 'active' : ''}`} onClick={() => setMobileOpen(false)} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}>
              <Icon size={17} strokeWidth={1.7} /><span>{label}</span>{href === '/product-workspace/rocks' && <span className="nav-count">3</span>}
            </Link>
          ))}
          {identity?.role === 'Admin' && (
            <Link href="/product-workspace/settings" className={`workspace-nav-link ${location.startsWith('/product-workspace/settings') ? 'active' : ''}`} onClick={() => setMobileOpen(false)} data-testid="link-nav-settings">
              <Settings2 size={17} strokeWidth={1.7} /><span>Settings</span>
            </Link>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note"><Sparkles size={15} /><span>Decision room<br /><b>Q3 2026</b></span></div>
          <button className="workspace-nav-link logout-button" onClick={doLogout} data-testid="button-logout"><LogOut size={17} /><span>Sign out</span></button>
          <div className="profile-mini" data-testid="text-current-user"><div className="avatar" style={{ background: '#C9A96E' }}>{identity ? initials(identity.name) : 'V'}</div><div><strong>{identity?.name || 'Workspace member'}</strong><span>{identity?.role || 'Select your identity'}</span></div><Settings2 size={15} /></div>
        </div>
      </aside>
      {sidebarCollapsed && <button className="icon-button sidebar-expand-toggle" onClick={expandSidebar} aria-label="Open sidebar" data-testid="button-expand-sidebar"><Menu size={20} /></button>}
      <main className="workspace-main">
        <header className="workspace-topbar">
          <a
            href="/"
            className="dashboard-back-link"
            onClick={(event) => {
              event.preventDefault();
              window.location.href = '/';
            }}
            data-testid="link-dashboard-back"
            aria-label="Back to dashboard"
          >
            <span className="dashboard-back-arrow" aria-hidden="true">←</span>
            <span className="dashboard-back-label">Dashboard</span>
          </a>
          <button className="icon-button mobile-menu" onClick={() => { setSidebarCollapsed(false); setMobileOpen(true); }} aria-label="Open menu" data-testid="button-open-menu"><Menu size={20} /></button>
          <div className="topbar-context"><span className="topbar-dot" /> Live workspace <span className="slash">/</span> Q3 2026</div>
          <div className="topbar-actions"><button className="topbar-action" onClick={focusAssortmentSearch} data-testid="button-search"><Search size={16} /> <span>Search assortment</span><kbd>⌘ K</kbd></button><button className="icon-button" onClick={() => setLocation('/product-workspace/')} data-testid="button-notifications"><CircleAlert size={18} /></button><button className="identity-pill" onClick={() => setIdentityOpen(true)} data-testid="button-identity-pill">{identity ? <>Signed in as <b>{identity.name}</b> · {identity.role}</> : 'Who are you?'}</button></div>
        </header>
        {children}
      </main>
      {identityOpen && <IdentityModal onPick={pickIdentity} onClose={() => setIdentityOpen(false)} canClose={identity !== null} />}
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: ReactNode; description?: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}
function Skeleton({ className = '' }: { className?: string }) { return <div className={`skeleton ${className}`} />; }
function LoadingState() { return <div className="loading-grid"><Skeleton className="skeleton-hero" /><div className="skeleton-row"><Skeleton /><Skeleton /><Skeleton /></div><Skeleton className="skeleton-panel" /></div>; }
function ErrorState({ onRetry }: { onRetry?: () => void }) { return <div className="empty-state error-state"><CircleAlert size={22} /><h3>Could not open this room</h3><p>We couldn't reach the workspace service. Your work is safe.</p>{onRetry && <button className="button button-dark" onClick={onRetry} data-testid="button-retry">Try again</button>}</div>; }
function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-symbol"><Sparkles size={20} /></div><h3>{title}</h3><p>{text}</p>{action}</div>; }
function Progress({ value = 0 }: { value?: number | null }) { const safe = Math.max(0, Math.min(100, Number(value) || 0)); return <div className="progress-track"><span style={{ width: `${safe}%` }} /></div>; }
function StatusPill({ value }: { value: unknown }) { const label = fmt(value, 'In progress'); return <span className={`status-pill status-${label.toLowerCase().replaceAll(' ', '-')}`}><i />{label}</span>; }

type FocusWeek = { isoYear: number; isoWeek: number; stylesCommitted: number; unitsCommitted: number; targetUnits: number; targetSource: 'entered' | 'derived'; monthLabel: string; varianceUnits: number; status: string; newUnits: number; newnessTargetUnits: number; newnessTargetPct: number; newnessVarianceUnits: number };
type FocusMonth = { label: string; units: number; targetUnits: number; varianceUnits: number; newUnits: number; newnessTargetUnits: number; newnessVarianceUnits: number };
type FocusNewness = { newUnits: number; totalUnits: number; capacityUnits: number; pct: number; targetUnits: number; targetPctOfCapacity: number; plannedNewStyles: number; impliedStyles: number; shortfallUnits: number; shortfallStyles: number; meetsTarget: boolean; monthLabel: string; explanation: string };
type FocusGap = { subCategory: string; plannedNewStyles: number; availableNewStyles: number; balance: number; status: string };
type FocusWaiting = { sampleApprovals: number; setSampleApprovals: number; fabricBlocks: number; total: number };
type FocusScorecard = { key: string; owner: string; measurable: string; goal: string; value: number | null; uom: string; onTrack: boolean | null; available: boolean; note?: string };
type WorkspaceDashboardFocus = { week: FocusWeek; month: FocusMonth; newness: FocusNewness; gaps: FocusGap[]; waiting: FocusWaiting; scorecard: FocusScorecard[] };

function Dashboard() {
  const [showAllGaps, setShowAllGaps] = useState(false);
  const dashboard = useGetWorkspaceDashboard({ query: { queryKey: getGetWorkspaceDashboardQueryKey() } });
  const birthdays = useQuery<TodayBirthday[]>({
    queryKey: ['workspace', 'team', 'birthdays', 'today'],
    queryFn: async () => {
      const response = await fetch('/api/team/birthdays/today', { credentials: 'include' });
      if (!response.ok) throw new Error('Could not load today’s birthdays');
      return response.json() as Promise<TodayBirthday[]>;
    },
    retry: false,
    staleTime: 60_000,
  });
  if (dashboard.isLoading) return <section className="page"><LoadingState /></section>;
  if (dashboard.isError || !dashboard.data) return <section className="page"><ErrorState onRetry={() => dashboard.refetch()} /></section>;

  const data = dashboard.data;
  const snapshot: WorkspaceDashboardSnapshot = data.snapshot;
  const focus = (data as any).focus as WorkspaceDashboardFocus | undefined;
  const materialGaps = focus?.gaps.filter((gap) => Math.abs(gap.balance) > 1) ?? [];
  const visibleGaps = showAllGaps ? focus?.gaps ?? [] : materialGaps;

  const snapshotDate = new Date(`${snapshot.asOfDate}T12:00:00`);
  const snapshotDateLabel = Number.isNaN(snapshotDate.getTime())
    ? snapshot.asOfDate
    : snapshotDate.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });

  const subtitle = focus?.week
    ? `Week ${focus.week.isoWeek} · ${snapshot.inDevelopment} Q3 tracker styles · ${focus.week.stylesCommitted} styles committed · ${focus.waiting.total} approvals or blocks need attention.`
    : "The decisions shaping the next Vivo collection.";
  const scorecardValue = (row: FocusScorecard) => {
    if (!row.available || row.value === null) return '—';
    const isAverage = /^avg\b/i.test(row.measurable.trim());
    const value = row.uom === 'Mtrs'
      ? Math.round(row.value).toLocaleString()
      : row.uom === 'No.' && !isAverage
      ? Math.round(row.value).toLocaleString()
      : Number.isInteger(row.value) ? row.value.toLocaleString() : row.value.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return row.uom === '%' ? `${value}%` : row.uom === 'Mtrs' ? `${value} m` : value;
  };

  return (
    <section className="page dashboard-page">
      <PageHeading
        eyebrow={snapshotDateLabel}
        title="Good morning, team."
        description={subtitle}
        action={<Link className="button button-gold" href="/product-workspace/plan" data-testid="link-open-plan">Open Q3 plan <ArrowRight size={16} /></Link>}
      />

      {birthdays.data?.length ? (
        <div className="snapshot-birthday" role="status" data-testid="snapshot-birthdays-today" style={{ marginBottom: 24, marginTop: -8 }}>
          <Sparkles size={16} aria-hidden="true" style={{ color: '#ae8746' }} />
          <strong>Happy Birthday {birthdays.data.map((member) => member.name).join(', ')}!</strong>
        </div>
      ) : null}

      <div className="dash-brief">
        {focus && (
          <div className="dash-action-grid">
            <div className="dash-action-tile" data-testid="tile-week-units">
              <h3 className="dash-tile-title">
                Weekly units · W{focus.week.isoWeek}
                <CalendarDays size={14} />
              </h3>
              <div className="dash-tile-main">
                <span className="dash-tile-value">{Math.round(focus.week.unitsCommitted).toLocaleString()} / {Math.round(focus.week.targetUnits).toLocaleString()}</span>
                <span className="dash-tile-sub">units planned / saved factory target · {focus.week.stylesCommitted} styles</span>
              </div>
              <div className={`dash-tile-status ${focus.week.varianceUnits < 0 ? 'danger' : 'success'}`}>
                {focus.week.varianceUnits < 0 ? <CircleAlert size={14} /> : <Check size={14} />}
                <span>
                  {Math.abs(Math.round(focus.week.varianceUnits)).toLocaleString()} units {focus.week.varianceUnits < 0 ? 'below' : 'above'} weekly target
                </span>
              </div>
            </div>

            <div className="dash-action-tile" data-testid="tile-week-newness">
              <h3 className="dash-tile-title">
                Weekly newness · W{focus.week.isoWeek}
                <Sparkles size={14} />
              </h3>
              <div className="dash-tile-main">
                <span className="dash-tile-value">{Math.round(focus.week.newUnits).toLocaleString()} / {Math.round(focus.week.newnessTargetUnits).toLocaleString()}</span>
                <span className="dash-tile-sub">new units planned / {apiDecimal(focus.week.newnessTargetPct, 0, '%')} weekly newness target</span>
              </div>
              <div className={`dash-tile-status ${focus.week.newnessVarianceUnits < 0 ? 'danger' : 'success'}`}>
                {focus.week.newnessVarianceUnits < 0 ? <CircleAlert size={14} /> : <Check size={14} />}
                <span>{Math.abs(Math.round(focus.week.newnessVarianceUnits)).toLocaleString()} new units {focus.week.newnessVarianceUnits < 0 ? 'below' : 'above'} weekly target</span>
              </div>
            </div>

            <div className="dash-action-tile" data-testid="tile-month-units">
              <h3 className="dash-tile-title">
                Monthly units · {focus.month.label}
                <CalendarDays size={14} />
              </h3>
              <div className="dash-tile-main">
                <span className="dash-tile-value">{Math.round(focus.month.units).toLocaleString()} / {Math.round(focus.month.targetUnits).toLocaleString()}</span>
                <span className="dash-tile-sub">units planned / monthly target</span>
              </div>
              <div className={`dash-tile-status ${focus.month.varianceUnits < 0 ? 'danger' : 'success'}`}>
                {focus.month.varianceUnits < 0 ? <CircleAlert size={14} /> : <Check size={14} />}
                <span>{Math.abs(Math.round(focus.month.varianceUnits)).toLocaleString()} units {focus.month.varianceUnits < 0 ? 'below' : 'above'} monthly target</span>
              </div>
            </div>

            <div className="dash-action-tile" data-testid="tile-month-newness">
              <h3 className="dash-tile-title">
                Monthly newness · {focus.month.label}
                <Sparkles size={14} />
              </h3>
              <div className="dash-tile-main">
                <span className="dash-tile-value">{Math.round(focus.month.newUnits).toLocaleString()} / {Math.round(focus.month.newnessTargetUnits).toLocaleString()}</span>
                <span className="dash-tile-sub">new units planned / monthly newness target</span>
              </div>
              <div className={`dash-tile-status ${focus.month.newnessVarianceUnits < 0 ? 'danger' : 'success'}`}>
                {focus.month.newnessVarianceUnits < 0 ? <CircleAlert size={14} /> : <Check size={14} />}
                <span>{Math.abs(Math.round(focus.month.newnessVarianceUnits)).toLocaleString()} new units {focus.month.newnessVarianceUnits < 0 ? 'below' : 'above'} monthly target</span>
              </div>
            </div>

            <Link href="/product-workspace/style-development" className="dash-action-tile" data-testid="tile-waiting">
              <h3 className="dash-tile-title">
                Needs attention
                <Clock3 size={14} />
              </h3>
              <div className="dash-waiting-list">
                <div className={`dash-waiting-item ${focus.waiting.sampleApprovals > 0 ? 'critical' : ''}`}>
                  <span>Sample approvals</span>
                  <strong>{focus.waiting.sampleApprovals}</strong>
                </div>
                <div className={`dash-waiting-item ${focus.waiting.setSampleApprovals > 0 ? 'critical' : ''}`}>
                  <span>Set sample approvals</span>
                  <strong>{focus.waiting.setSampleApprovals}</strong>
                </div>
                <div className={`dash-waiting-item ${focus.waiting.fabricBlocks > 0 ? 'critical' : ''}`}>
                  <span>Fabric blocks</span>
                  <strong>{focus.waiting.fabricBlocks}</strong>
                </div>
              </div>
            </Link>
          </div>
        )}

        {focus && (
          <section className="dash-gaps-section" data-testid="section-style-gaps">
            <div className="dash-gaps-header">
              <div><span className="eyebrow">Current month</span><h3>Style Gaps</h3></div>
              {focus.gaps.length > materialGaps.length && (
                <button type="button" className="dash-gaps-toggle" onClick={() => setShowAllGaps((current) => !current)} data-testid="button-toggle-all-gaps">
                  {showAllGaps ? 'Show material gaps' : `Show all (${focus.gaps.length})`}
                </button>
              )}
            </div>
            <div className="dash-gaps-table-wrap">
              <table className="dash-gaps-table">
                <thead><tr><th>Subcategory</th><th>Scheduled</th><th>Planned</th><th>Gap</th></tr></thead>
                <tbody>
                  {visibleGaps.length ? visibleGaps.map((gap) => (
                    <tr key={gap.subCategory}>
                      <td>{gap.subCategory}</td>
                      <td>{gap.availableNewStyles}</td>
                      <td>{gap.plannedNewStyles}</td>
                      <td><span className={`dash-gap-value ${gap.balance < 0 ? 'shortfall' : gap.balance > 0 ? 'surplus' : ''}`}><i />{gap.balance > 0 ? '+' : ''}{gap.balance}</span></td>
                    </tr>
                  )) : <tr><td colSpan={4} className="dash-gaps-empty">No material style gaps.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {focus?.scorecard && (
          <div className="dash-scorecard-section" data-testid="scorecard-section">
            <div className="dash-scorecard-header">
              <h3>Weekly L10 Scorecard</h3>
              <div className="dash-scorecard-meta">
                <span>Week {focus.week.isoWeek}</span>
                <span>•</span>
                <span>{focus.week.monthLabel}</span>
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="dash-scorecard-table">
                <thead>
                  <tr>
                    <th>Measurable</th>
                    <th className="owner">Owner</th>
                    <th>Goal</th>
                    <th>Actual</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {focus.scorecard.map((row) => (
                    <tr key={row.key}>
                      <td className="measurable">{row.measurable}</td>
                      <td className="owner">{row.owner}</td>
                      <td className="goal">
                        {row.goal}
                      </td>
                      <td className="value">
                        <span className={!row.available ? 'dash-value-unavailable' : undefined}>{scorecardValue(row)}</span>
                      </td>
                      <td>
                        {row.available ? (
                          <span className={`dash-scorecard-status ${row.onTrack ? 'on-track' : 'off-track'}`}>
                            {row.onTrack ? 'On Track' : 'Off Track'}
                          </span>
                        ) : (
                          <span className="dash-scorecard-status unavailable">N/A</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="dashboard-columns">
          <div className="panel activity-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">The room</span>
                <h3>Recent activity</h3>
              </div>
            </div>
            {data.activity?.length ? data.activity.slice(0, 5).map((item: any, i: number) => (
              <div className="activity-row" key={i} data-testid={`row-activity-${i}`}>
                <div className="activity-mark">
                  {i % 2 ? <MessageCircle size={15} /> : <Check size={15} />}
                </div>
                <div>
                  <strong>{fmt(getPathValue(item, ['title', 'action', 'name']), 'Collection update')}</strong>
                  <p>{fmt(getPathValue(item, ['detail', 'description', 'body']), 'A decision was logged in the workspace.')}</p>
                </div>
                <time>{date(getPathValue(item, ['time', 'createdAt']))}</time>
              </div>
            )) : <EmptyState title="The room is quiet" text="Activity will appear here as the team moves product forward." />}
          </div>
          <div className="panel upcoming-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Next up</span>
                <h3>Key dates</h3>
              </div>
              <CalendarDays size={18} />
            </div>
            {data.upcoming?.length ? data.upcoming.slice(0, 4).map((item: any, i: number) => (
              <div className="upcoming-row" key={i} data-testid={`row-upcoming-${i}`}>
                <div className="date-block">
                  <b>{fmt(getPathValue(item, ['day', 'date']), '18')}</b>
                  <span>{fmt(getPathValue(item, ['month']), 'JUN')}</span>
                </div>
                <div>
                  <strong>{fmt(getPathValue(item, ['title', 'name']), 'Range review')}</strong>
                  <p>{fmt(getPathValue(item, ['detail', 'description']), 'Product team')}</p>
                </div>
              </div>
            )) : <EmptyState title="No dates on deck" text="Your next reviews will show up here." />}
          </div>
        </div>
      </div>
    </section>
  );
}
function Login() {
  const [, setLocation] = useLocation();
  const login = useLoginWorkspace();
  const [email, setEmail] = useState('amara@vivo.co.ke');
  const [password, setPassword] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); login.mutate({ data: { email, password } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceSessionQueryKey() }); setLocation('/product-workspace/'); } }); };
  return <div className="login-page"><div className="login-art"><div className="login-art-copy"><div className="brand-lockup light"><div className="brand-mark">V</div><div><div className="brand-name">Vivo</div><div className="brand-sub">Product workspace</div></div></div><div className="login-manifesto"><span>East Africa / 2026</span><h1>Product is a<br /><em>conversation.</em></h1><p>A considered room for the people deciding what Vivo becomes next.</p></div><div className="login-footer">Nairobi · Kampala · Dar es Salaam · Kigali</div></div></div><div className="login-form-wrap"><div className="login-form"><div className="eyebrow">Private workspace</div><h2>Welcome back.</h2><p className="form-intro">Sign in with your Vivo account to continue.</p><form onSubmit={submit}><label>Email address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@vivo.com" required data-testid="input-email" /></label><label>Password<div className="password-wrap"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" required data-testid="input-password" /><button type="button" className="password-hint" onClick={() => setPassword('vivo2026')} data-testid="button-fill-password">Use passkey</button></div></label>{login.isError && <div className="form-error">That sign-in didn't work. Check your details and try again.</div>}<button className="button button-dark button-wide" disabled={login.isPending} type="submit" data-testid="button-login">{login.isPending ? 'Opening workspace…' : 'Enter workspace'} <ArrowRight size={16} /></button></form><div className="login-meta"><span>Vivo Digital Product Workspace</span><span>v1.4.0</span></div></div></div></div>;
}

const quarterChoices = ['Q1', 'Q2', 'Q3', 'Q4'] as const;

function PlanPage() {
  const [selectedQuarter, setSelectedQuarter] = useState('Q3');
  const [selectedYear, setSelectedYear] = useState(2026);
  const planParams = { quarter: selectedQuarter, year: selectedYear };
  const plan = useGetWorkspacePlan(planParams, { query: { queryKey: getGetWorkspacePlanQueryKey(planParams) } });
  const plans = useListWorkspacePlans({ query: { queryKey: getListWorkspacePlansQueryKey() } });
  const history = useListWorkspacePlanHistory({ query: { queryKey: getListWorkspacePlanHistoryQueryKey() } });
  const stylesForAdd = useListWorkspaceStyles(undefined, { query: { queryKey: getListWorkspaceStylesQueryKey(), enabled: false } });
  const update = useUpdateWorkspacePlan();
  const addStyle = useAddWorkspacePlanStyle();
  const createPlan = useCreateWorkspacePlan();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [addStyleOpen, setAddStyleOpen] = useState(false);
  const [styleSearch, setStyleSearch] = useState('');
  const [placeholderCategory, setPlaceholderCategory] = useState('');
  const [placeholderTier, setPlaceholderTier] = useState('Core');
  const [newPlanOpen, setNewPlanOpen] = useState(false);
  const [newPlanName, setNewPlanName] = useState('');
  const [newPlanQuarter, setNewPlanQuarter] = useState('Q1');
  const [newPlanYear, setNewPlanYear] = useState('2027');
  const p = plan.data as WorkspacePlan | undefined;
  const styles = p?.styles || [];
  const planIndex = (plans.data || []) as WorkspacePlanIndexItem[];
  const selectedIndex = planIndex.find((item) => item.quarter === selectedQuarter && item.year === selectedYear);
  const startEdit = () => { setName(p?.name || ''); setEditing(true); };
  const refreshPlan = () => {
    queryClient.invalidateQueries({ queryKey: getGetWorkspacePlanQueryKey(planParams) });
    queryClient.invalidateQueries({ queryKey: getListWorkspacePlansQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListWorkspacePlanHistoryQueryKey() });
  };
  const save = () => update.mutate({ data: { planId: p?.id, name } }, { onSuccess: () => { setEditing(false); refreshPlan(); } });
  const openNewPlan = () => {
    setNewPlanQuarter('Q1');
    setNewPlanYear('2027');
    setNewPlanName('Q1 2027 Assortment Plan');
    setNewPlanOpen(true);
  };
  const createNewPlan = () => {
    const year = Number(newPlanYear);
    if (!newPlanName.trim() || !Number.isInteger(year)) return;
    createPlan.mutate({ data: { name: newPlanName.trim(), quarter: newPlanQuarter, year } }, {
      onSuccess: (created) => {
        setNewPlanOpen(false);
        setSelectedQuarter(created.quarter);
        setSelectedYear(created.year);
        queryClient.invalidateQueries({ queryKey: getListWorkspacePlansQueryKey() });
      },
    });
  };
  const openAddStyle = () => {
    setStyleSearch('');
    setPlaceholderCategory('');
    setPlaceholderTier('Core');
    setAddStyleOpen(true);
    stylesForAdd.refetch();
  };
  const addExistingStyle = (style: WorkspaceStyle) => {
    if (!p) return;
    addStyle.mutate({ data: { planId: p.id, styleId: style.id } }, { onSuccess: () => { setAddStyleOpen(false); refreshPlan(); } });
  };
  const addPlaceholder = () => {
    if (!p || !placeholderCategory.trim()) return;
    addStyle.mutate({ data: { planId: p.id, category: placeholderCategory.trim(), tier: placeholderTier } }, { onSuccess: () => { setAddStyleOpen(false); refreshPlan(); } });
  };
  const availableStyles = (stylesForAdd.data || []).filter((style) => !styles.some((planned) => planned.id === style.id)).filter((style) => {
    const query = styleSearch.trim().toLowerCase();
    return !query || style.name.toLowerCase().includes(query) || style.code.toLowerCase().includes(query);
  });
  if (plan.isLoading || plans.isLoading) return <section className="page"><LoadingState /></section>;
  if (plan.isError || !p) return <section className="page"><ErrorState onRetry={() => plan.refetch()} /></section>;
  return <section className="page plan-page">
    <PageHeading
      eyebrow={`${p.quarter} ${p.year} / Assortment`}
      title={editing ? 'Name this plan.' : p.name}
      description="A living view of the range, tuned for East African demand."
      action={<div className="button-group plan-heading-actions">
        <button className="button button-gold" onClick={openNewPlan} data-testid="button-new-plan"><Plus size={15} /> New plan</button>
        <button className="button button-quiet" onClick={() => setHistoryOpen(true)} data-testid="button-plan-history"><History size={15} /> History</button>
        <button className="button button-quiet" disabled title="PDF export is coming soon" data-testid="button-export-pdf"><FileText size={15} /> PDF <span className="mono">Coming soon</span></button>
        <button className="button button-dark" onClick={editing ? save : startEdit} data-testid="button-edit-plan">{editing ? <><Check size={15} /> Save plan</> : <><Settings2 size={15} /> Edit plan</>}</button>
      </div>}
    />
    <div className="plan-quarter-nav" aria-label="Quarterly plans">
      <div className="plan-quarter-tabs">
        {quarterChoices.map((quarter) => {
          const item = planIndex.find((candidate) => candidate.quarter === quarter && candidate.year === 2026);
          return <button className={`plan-quarter-tab ${selectedQuarter === quarter && selectedYear === 2026 ? 'active' : ''}`} key={quarter} onClick={() => { setSelectedQuarter(quarter); setSelectedYear(2026); setEditing(false); }} data-testid={`button-quarter-${quarter.toLowerCase()}`}>
            <span>{quarter}</span><b>{item?.styleCount ?? 0}</b><small>styles</small>
          </button>;
        })}
      </div>
      <button className="plan-new-tab" onClick={openNewPlan} data-testid="button-new-plan-tab"><Plus size={15} /> New plan</button>
    </div>
    {editing && <div className="edit-inline"><input value={name} onChange={(e) => setName(e.target.value)} aria-label="Plan name" data-testid="input-plan-name" /><button className="icon-button" onClick={() => setEditing(false)} data-testid="button-cancel-plan"><X size={16} /></button></div>}
    <div className="plan-banner"><div><span className="eyebrow gold-eyebrow">Quarterly assortment</span><h2>{styles.length || 0} <small>styles in the edit</small></h2></div><div className="plan-facts"><div><span>Range shape</span><b>{fmt((p.summary as Record<string, unknown>)?.rangeShape, 'Balanced')}</b></div><div><span>Target margin</span><b>{fmt((p.summary as Record<string, unknown>)?.targetMargin, '58.2%')}</b></div><div><span>Markets</span><b>{workspaceMarkets}</b></div></div></div>
    <div className="section-label"><span>Planned styles</span><span className="mono">PLANNED STYLES {styles.length} / 126</span></div>
    <div className="planned-style-actions"><button className="button button-dark add-style-button" onClick={openAddStyle} data-testid="button-add-style"><Plus size={17} /> Add Style</button><span>Search the catalogue or create a placeholder for this edit.</span></div>
    <div className="style-table">{styles.length ? styles.map((style, i) => <StyleRow key={style.id} style={style} index={i} />) : <EmptyState title={selectedIndex?.styleCount === 0 ? `Start ${p.quarter} ${p.year}` : 'Your plan is a blank page'} text="Add an existing style or create a category placeholder to begin this quarter's edit." action={<button className="button button-gold" onClick={openAddStyle} data-testid="button-start-quarter-plan"><Plus size={15} /> Start this quarter's plan</button>} />}</div>
    {historyOpen && <div className="drawer-backdrop" onClick={() => setHistoryOpen(false)}><aside className="history-drawer" onClick={(e) => e.stopPropagation()}><div className="drawer-header"><div><span className="eyebrow">Audit trail</span><h2>Plan history</h2></div><button className="icon-button" onClick={() => setHistoryOpen(false)} data-testid="button-close-history"><X size={17} /></button></div>{history.isLoading ? <LoadingState /> : history.data?.length ? history.data.map((item) => <div className="history-item" key={item.id} data-testid={`row-history-${item.id}`}><span className="history-dot" /><div><strong>{item.action}</strong><p>{item.detail || 'Plan was updated.'}</p><small>{item.actor} · {date(item.createdAt)}</small></div></div>) : <EmptyState title="No edits yet" text="Changes to the plan will be recorded here." />}</aside></div>}
    {addStyleOpen && <div className="modal-backdrop" onClick={() => setAddStyleOpen(false)}><div className="modal-card add-style-modal" onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><span className="eyebrow">Planned styles / {p.quarter} {p.year}</span><h2>Add a style</h2></div><button className="icon-button" onClick={() => setAddStyleOpen(false)} aria-label="Close add style dialog" data-testid="button-close-add-style"><X size={17} /></button></div><label className="modal-search"><Search size={16} /><input autoFocus value={styleSearch} onChange={(event) => setStyleSearch(event.target.value)} placeholder="Search by style name or number" aria-label="Search styles to add" data-testid="input-add-style-search" /></label><div className="modal-section-label"><span>Existing styles</span><span className="mono">{availableStyles.length} matches</span></div><div className="style-picker-results">{stylesForAdd.isFetching ? <Skeleton className="picker-loading" /> : availableStyles.length ? availableStyles.map((style) => <button className="style-picker-row" key={style.id} onClick={() => addExistingStyle(style)} disabled={addStyle.isPending} data-testid={`button-add-existing-style-${style.id}`}><div className="style-picker-mark"><Palette size={15} /></div><span><strong>{style.name}</strong><small>{style.code} · {style.category} · {style.brand}</small></span><Plus size={16} /></button>) : <p className="modal-muted">No matching styles found. Create a placeholder below.</p>}</div><div className="modal-divider"><span>or create a placeholder</span></div><div className="placeholder-fields"><label>Category<input value={placeholderCategory} onChange={(event) => setPlaceholderCategory(event.target.value)} placeholder="e.g. Knitwear" data-testid="input-placeholder-category" /></label><label>Tier<select value={placeholderTier} onChange={(event) => setPlaceholderTier(event.target.value)} data-testid="select-placeholder-tier"><option>Core</option><option>Elevated</option><option>Entry</option><option>Statement</option></select></label></div>{addStyle.isError && <div className="form-error">That style could not be added. It may already be on this plan.</div>}<button className="button button-dark button-wide" onClick={addPlaceholder} disabled={addStyle.isPending || !placeholderCategory.trim()} data-testid="button-create-placeholder"><Sparkles size={15} /> Create placeholder</button></div></div>}
    {newPlanOpen && <div className="modal-backdrop" onClick={() => setNewPlanOpen(false)}><div className="modal-card new-plan-modal" onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><span className="eyebrow">New decision room</span><h2>Create a plan</h2></div><button className="icon-button" onClick={() => setNewPlanOpen(false)} aria-label="Close new plan dialog" data-testid="button-close-new-plan"><X size={17} /></button></div><label>Plan name<input autoFocus value={newPlanName} onChange={(event) => setNewPlanName(event.target.value)} placeholder="Q1 2027 Assortment Plan" data-testid="input-new-plan-name" /></label><div className="placeholder-fields"><label>Quarter<select value={newPlanQuarter} onChange={(event) => { const quarter = event.target.value; setNewPlanQuarter(quarter); setNewPlanName(`${quarter} ${newPlanYear} Assortment Plan`); }} data-testid="select-new-plan-quarter">{quarterChoices.map((quarter) => <option key={quarter}>{quarter}</option>)}</select></label><label>Year<input type="number" min="2020" max="2100" value={newPlanYear} onChange={(event) => { const year = event.target.value; setNewPlanYear(year); setNewPlanName(`${newPlanQuarter} ${year} Assortment Plan`); }} data-testid="input-new-plan-year" /></label></div>{createPlan.isError && <div className="form-error">A plan may already exist for that quarter and year.</div>}<button className="button button-gold button-wide" onClick={createNewPlan} disabled={createPlan.isPending || !newPlanName.trim()} data-testid="button-create-new-plan">Create plan <ArrowRight size={16} /></button></div></div>}
  </section>;
}
function StyleRow({ style, index }: { style: WorkspaceStyle; index: number }) { return <Link href={`/product-workspace/styles/${style.id}`} className="style-row" data-testid={`row-style-${style.id}`}><span className="row-index">{String(index + 1).padStart(2, '0')}</span><GarmentImage className="style-thumb" source="plm" styleKey={style.code || style.id} image={style.image} alt={style.name} /><div className="style-main"><strong>{style.name}</strong><span>{style.code} · {style.brand} · {style.category}</span></div><StatusPill value={style.status} /><div className="row-progress"><Progress value={style.progress} /><span>{style.progress || 0}%</span></div><span className="row-date">{date(style.targetDate)} <ChevronRight size={15} /></span></Link>; }

function BoardPage() {
  const boards = useListWorkspaceBoards({ query: { queryKey: getListWorkspaceBoardsQueryKey() } });
  const create = useCreateWorkspaceBoard();
  const [selected, setSelected] = useState<number | null>(null);
  const [newBoard, setNewBoard] = useState(false);
  const [title, setTitle] = useState('');
  const board = useGetWorkspaceBoard(selected || 0, { query: { enabled: !!selected, queryKey: getGetWorkspaceBoardQueryKey(selected || 0) } });
  const createBoard = () => { if (!title.trim()) return; create.mutate({ data: { title, description: 'A new Vivo decision room.' } }, { onSuccess: (created) => { setNewBoard(false); setTitle(''); setSelected(created.id); queryClient.invalidateQueries({ queryKey: getListWorkspaceBoardsQueryKey() }); } }); };
  if (selected && board.data) return <BoardDetail board={board.data} onBack={() => setSelected(null)} />;
  if (boards.isLoading) return <section className="page"><LoadingState /></section>;
  return <section className="page"><PageHeading eyebrow="Rocks & priorities" title="Rocks" description="Keep the work visible. Move ideas into decisions." action={<button className="button button-dark" onClick={() => setNewBoard(true)} data-testid="button-new-rock"><Plus size={16} /> New rock</button>} />{newBoard && <div className="modal-backdrop"><div className="modal-card"><div className="drawer-header"><div><span className="eyebrow">New room</span><h2>Start a rock</h2></div><button className="icon-button" onClick={() => setNewBoard(false)} data-testid="button-close-rock-modal"><X size={17} /></button></div><label>Rock title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. High summer colour edit" data-testid="input-rock-title" /></label><button className="button button-dark button-wide" onClick={createBoard} disabled={create.isPending} data-testid="button-create-rock">Create rock <ArrowRight size={16} /></button></div></div>}<div className="board-grid">{boards.data?.length ? boards.data.map((item) => <button className="board-card" key={item.id} onClick={() => setSelected(item.id)} data-testid={`card-rock-${item.id}`}><div className="board-card-top"><span className="board-symbol"><Columns3 size={17} /></span><span className="mono">{String(item.id).padStart(2, '0')}</span></div><h3>{item.title}</h3><p>{item.description || 'A shared space for product decisions.'}</p><div className="board-card-meta"><span>{item.cards?.length || 0} cards</span><span>{item.collaborators?.length || 0} collaborators <ArrowRight size={13} /></span></div></button>) : <EmptyState title="No rocks yet" text="Start a room for your next product conversation." action={<button className="button button-dark" onClick={() => setNewBoard(true)} data-testid="button-empty-new-rock"><Plus size={15} /> Create rock</button>} />}</div></section>;
}
function BoardDetail({ board, onBack }: { board: WorkspaceBoard; onBack: () => void }) {
  const createCard = useCreateWorkspaceBoardCard();
  const createComment = useCreateWorkspaceBoardComment();
  const updateCard = useUpdateWorkspaceBoardCard();
  const [cardTitle, setCardTitle] = useState('');
  const [comment, setComment] = useState('');
  const [presence, setPresence] = useState(1);
  const [draggedCard, setDraggedCard] = useState<number | null>(null);
  useEffect(() => {
    const socket = io({ path: '/api/workspace/socket.io', withCredentials: true });
    socket.on('connect', () => socket.emit('join-board', board.id));
    socket.on('board:presence', (payload: { count?: number }) => setPresence(payload.count || 1));
    return () => { socket.disconnect(); };
  }, [board.id]);
  const columns = board.columns?.length ? board.columns : [{ id: 'ideas', title: 'Ideas' }, { id: 'review', title: 'In review' }, { id: 'decided', title: 'Decided' }];
  const addCard = () => { if (!cardTitle.trim()) return; createCard.mutate({ id: board.id, data: { title: cardTitle, columnId: String((columns[0] as Record<string, unknown>).id || 'ideas') } }, { onSuccess: () => { setCardTitle(''); queryClient.invalidateQueries({ queryKey: getGetWorkspaceBoardQueryKey(board.id) }); } }); };
  const addComment = () => { if (!comment.trim()) return; createComment.mutate({ id: board.id, data: { body: comment } }, { onSuccess: () => { setComment(''); queryClient.invalidateQueries({ queryKey: getGetWorkspaceBoardQueryKey(board.id) }); } }); };
  const moveCard = (columnId: string) => {
    if (!draggedCard) return;
    updateCard.mutate({ id: board.id, cardId: draggedCard, data: { columnId, position: 0 } }, {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetWorkspaceBoardQueryKey(board.id) }),
    });
    setDraggedCard(null);
  };
  return <section className="page board-detail-page"><button className="back-link" onClick={onBack} data-testid="button-back-rocks"><ArrowLeft size={15} /> All rocks</button><PageHeading eyebrow="Collaboration rock" title={board.title} description={board.description} action={<span className="collab-stack">{board.collaborators?.slice(0, 4).map((person) => <span key={person.id} className="avatar small" style={{ background: person.color }}>{person.initials}</span>)}<span className="presence-label" data-testid="text-rock-presence">{presence} connected</span></span>} /><div className="board-toolbar"><span className="eyebrow">Working view · drag cards between columns</span><div><button className="button button-quiet" onClick={() => queryClient.invalidateQueries({ queryKey: getGetWorkspaceBoardQueryKey(board.id) })} data-testid="button-rock-refresh"><Settings2 size={14} /> Refresh view</button><button className="button button-quiet" onClick={() => navigator.clipboard?.writeText(window.location.href)} data-testid="button-rock-share">Copy rock link</button></div></div><div className="kanban">{columns.map((column, i) => { const record = column as Record<string, unknown>; const id = String(record.id || record.key || i); const title = String(record.title || record.name || `Column ${i + 1}`); const cards = (board.cards || []).filter((card) => card.columnId === id); return <div className={`kanban-column ${draggedCard ? 'drop-ready' : ''}`} key={id} onDragOver={(event) => event.preventDefault()} onDrop={() => moveCard(id)} data-testid={`column-rock-${id}`}><div className="column-heading"><span>{title}</span><b>{cards.length}</b></div>{cards.map((card) => <div className="kanban-card" draggable onDragStart={() => setDraggedCard(card.id)} onDragEnd={() => setDraggedCard(null)} key={card.id} data-testid={`card-rock-item-${card.id}`}><span className="mono">{card.styleId ? `ST-${card.styleId}` : 'NOTE'}</span><h4>{card.title}</h4><p>{card.description || 'No description yet.'}</p><div className="tag-row">{(card.tags || ['Product']).map((tag) => <span key={tag}>{tag}</span>)}</div></div>)}{i === 0 && <div className="add-card"><input value={cardTitle} onChange={(e) => setCardTitle(e.target.value)} placeholder="Add a card…" data-testid="input-card-title" /><button onClick={addCard} aria-label="Add card" data-testid="button-add-card"><Plus size={15} /></button></div>}</div>})}</div><div className="comments-panel"><div className="panel-heading"><div><span className="eyebrow">The thread</span><h3>Comments <span className="count">{board.comments?.length || 0}</span></h3></div><MessageCircle size={18} /></div>{board.comments?.slice(0, 5).map((item) => <div className="comment-row" key={item.id} data-testid={`comment-rock-${item.id}`}><div className="avatar" style={{ background: item.author.color }}>{item.author.initials}</div><div><strong>{item.author.name}</strong><time>{date(item.createdAt)}</time><p>{item.body}</p></div></div>)}<div className="comment-input"><input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add to the conversation…" data-testid="input-comment" /><button onClick={addComment} data-testid="button-add-comment"><ArrowRight size={16} /></button></div></div></section>;
}

function PulseAwareFeedbackRoute() {
  const isPulse = new URLSearchParams(window.location.search).has('style') && ['investigate', 'champion'].includes(new URLSearchParams(window.location.search).get('mode') || '');
  return isPulse ? <PublicFeedbackPage /> : <FeedbackPage />;
}
function LegacyCatalogueRedirect() { const [, setLocation] = useLocation(); useEffect(() => { setLocation('/product-workspace/plan', { replace: true }); }, [setLocation]); return null; }
function RouteLoadingState() { return <section className="page"><div className="range-plan-loading"><Clock3 size={20} />Loading workspace…</div></section>; }
function Router() { const [location] = useLocation(); return <ErrorBoundary resetKey={location}><Suspense fallback={<RouteLoadingState />}><Switch><Route path="/feedback" component={PublicFeedbackPage} /><Route path="/feedback/" component={PublicFeedbackPage} /><Route path="/styles" component={LegacyCatalogueRedirect} /><Route path="/styles/:id" component={LegacyCatalogueRedirect} /><Route path="/product-workspace/login" component={Login} /><Route path="/product-workspace/" component={Dashboard} /><Route path="/product-workspace/plan" component={AssortmentPlanPage} /><Route path="/product-workspace/fabric-stock-mix" component={FabricStockMixPage} /><Route path="/product-workspace/rocks" component={BoardPage} /><Route path="/product-workspace/board" component={BoardPage} /><Route path="/product-workspace/style-development" component={StyleDevelopmentTrackerPage} /><Route path="/product-workspace/plm" component={StyleDevelopmentTrackerPage} /><Route path="/product-workspace/feedback" component={PulseAwareFeedbackRoute} /><Route path="/product-workspace/settings" component={SettingsPage} /><Route path="/product-workspace/team" component={TeamDirectoryPage} /><Route path="/product-workspace/l10" component={L10Page} /><Route path="/product-workspace/range-plan" component={RangePlanPage} /><Route path="/product-workspace/definitions" component={DefinitionsPage} /><Route path="/product-workspace/weekly-order-plan" component={WeeklyOrderPlanPage} /><Route path="/product-workspace/showcase" component={ShowcasePage} /><Route path="/product-workspace/showcase/:id" component={ShowcasePage} /><Route path="/product-workspace/styles" component={LegacyCatalogueRedirect} /><Route path="/product-workspace/styles/:id" component={LegacyCatalogueRedirect} /><Route path="/product-workspace/resources" component={ResourcesPage} /><Route path="/product-workspace/resources/:id" component={ResourcesPage} /><Route component={NotFound} /></Switch></Suspense></ErrorBoundary>; }
function AppEntry() { const [location] = useLocation(); const publicFeedback = location === '/feedback' || location === '/feedback/'; const publicPulse = location === '/product-workspace/feedback' && new URLSearchParams(window.location.search).has('style') && ['investigate', 'champion'].includes(new URLSearchParams(window.location.search).get('mode') || ''); return publicFeedback || publicPulse ? <Router /> : <Shell><Router /></Shell>; }
function App() { return <QueryClientProvider client={queryClient}><WouterRouter><AppEntry /></WouterRouter></QueryClientProvider>; }
export default App;
