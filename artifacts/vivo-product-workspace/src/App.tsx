import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, Router as WouterRouter, useLocation, useParams } from 'wouter';
import { io } from 'socket.io-client';
import { ArrowLeft, ArrowRight, BarChart3, BookOpen, CalendarDays, Check, ChevronDown, ChevronRight, CircleAlert, Clock3, Columns3, FileText, GalleryHorizontalEnd, History, LayoutDashboard, LogOut, Menu, MessageCircle, Package, Palette, Plus, Search, Settings2, Sparkles, X } from 'lucide-react';
import {
  getGetWorkspaceBoardQueryKey, getGetWorkspaceDashboardQueryKey, getGetWorkspacePlanQueryKey, getGetWorkspaceSessionQueryKey,
  getGetWorkspaceShowcaseQueryKey, getGetWorkspaceStylePlmQueryKey, getGetWorkspaceStyleQueryKey,
  getListWorkspaceBoardsQueryKey, getListWorkspacePlanHistoryQueryKey, getListWorkspaceShowcasesQueryKey, getListWorkspaceStylesQueryKey,
  useCreateWorkspaceBoard, useCreateWorkspaceBoardCard, useCreateWorkspaceBoardComment, useGetWorkspaceBoard, useGetWorkspaceDashboard,
  useGetWorkspacePlan, useGetWorkspaceSession, useGetWorkspaceShowcase, useGetWorkspaceStyle, useGetWorkspaceStylePlm,
  useListWorkspaceBoards, useListWorkspacePlanHistory, useListWorkspaceShowcases, useListWorkspaceStyles, useLoginWorkspace,
  useLogoutWorkspace, useUpdateWorkspaceBoardCard, useUpdateWorkspacePlan, useUpdateWorkspaceStyle,
} from '@workspace/api-client-react';
import type { WorkspaceBoard, WorkspacePlan, WorkspaceStyle } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import NotFound from '@/pages/not-found';
import './index.css';

const queryClient = new QueryClient();
const nav = [
  { href: '/product-workspace/', label: 'Workspace', icon: LayoutDashboard },
  { href: '/product-workspace/plan', label: 'Assortment plan', icon: CalendarDays },
  { href: '/product-workspace/board', label: 'Boards', icon: Columns3 },
  { href: '/product-workspace/plm', label: 'Style development', icon: Package },
  { href: '/product-workspace/showcase', label: 'Showcase', icon: GalleryHorizontalEnd },
  { href: '/product-workspace/styles', label: 'Style catalogue', icon: BookOpen },
];

function fmt(value: unknown, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function metricValue(value: unknown, suffix: unknown, fallback: string) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return `${rounded}${suffix ? String(suffix) : ''}`;
  }
  return fmt(value, fallback);
}
function initials(name = 'Vivo team') { return name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
function date(value: unknown) { if (!value) return 'No date'; const d = new Date(String(value)); return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); }
function getPathValue(item: unknown, keys: string[]) { const record = item as Record<string, unknown>; return keys.map((key) => record?.[key]).find((value) => value !== undefined); }

function Shell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const session = useGetWorkspaceSession({ query: { queryKey: getGetWorkspaceSessionQueryKey(), retry: false } });
  const logout = useLogoutWorkspace();
  const user = session.data?.user;
  const login = location.includes('/login');
  if (login) return <>{children}</>;
  if (session.isLoading) return <LoadingState />;
  const doLogout = () => logout.mutate(undefined, { onSuccess: () => setLocation('/product-workspace/login') });
  return (
    <div className="workspace-app">
      <aside className={`workspace-sidebar ${mobileOpen ? 'is-open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark">V</div>
          <div><div className="brand-name">Vivo</div><div className="brand-sub">Product workspace</div></div>
          <button className="icon-button mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close menu" data-testid="button-close-menu"><X size={18} /></button>
        </div>
        <div className="workspace-rule" />
        <div className="eyebrow sidebar-eyebrow">East Africa / 29 stores</div>
        <nav className="workspace-nav" aria-label="Workspace navigation">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={`workspace-nav-link ${location === href || (href !== '/product-workspace/' && location.startsWith(href)) ? 'active' : ''}`} onClick={() => setMobileOpen(false)} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}>
              <Icon size={17} strokeWidth={1.7} /><span>{label}</span>{href === '/product-workspace/board' && <span className="nav-count">3</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note"><Sparkles size={15} /><span>Decision room<br /><b>Q3 2026</b></span></div>
          <button className="workspace-nav-link logout-button" onClick={doLogout} data-testid="button-logout"><LogOut size={17} /><span>Sign out</span></button>
          <div className="profile-mini" data-testid="text-current-user"><div className="avatar" style={{ background: user?.color || '#d7a943' }}>{user?.initials || initials(user?.name)}</div><div><strong>{user?.name || 'Workspace member'}</strong><span>{user?.role || 'Merchandising'}</span></div><Settings2 size={15} /></div>
        </div>
      </aside>
      <main className="workspace-main">
        <header className="workspace-topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open menu" data-testid="button-open-menu"><Menu size={20} /></button>
          <div className="topbar-context"><span className="topbar-dot" /> Live workspace <span className="slash">/</span> Q3 2026</div>
          <div className="topbar-actions"><button className="topbar-action" onClick={() => setLocation('/product-workspace/styles')} data-testid="button-search"><Search size={16} /> <span>Search workspace</span><kbd>⌘ K</kbd></button><button className="icon-button" onClick={() => setLocation('/product-workspace/')} data-testid="button-notifications"><CircleAlert size={18} /></button></div>
        </header>
        {children}
      </main>
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}
function Skeleton({ className = '' }: { className?: string }) { return <div className={`skeleton ${className}`} />; }
function LoadingState() { return <div className="loading-grid"><Skeleton className="skeleton-hero" /><div className="skeleton-row"><Skeleton /><Skeleton /><Skeleton /></div><Skeleton className="skeleton-panel" /></div>; }
function ErrorState({ onRetry }: { onRetry?: () => void }) { return <div className="empty-state error-state"><CircleAlert size={22} /><h3>Could not open this room</h3><p>We couldn't reach the workspace service. Your work is safe.</p>{onRetry && <button className="button button-dark" onClick={onRetry} data-testid="button-retry">Try again</button>}</div>; }
function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-symbol"><Sparkles size={20} /></div><h3>{title}</h3><p>{text}</p>{action}</div>; }
function Progress({ value = 0 }: { value?: number }) { const safe = Math.max(0, Math.min(100, Number(value) || 0)); return <div className="progress-track"><span style={{ width: `${safe}%` }} /></div>; }
function StatusPill({ value }: { value: unknown }) { const label = fmt(value, 'In progress'); return <span className={`status-pill status-${label.toLowerCase().replaceAll(' ', '-')}`}><i />{label}</span>; }

function Dashboard() {
  const dashboard = useGetWorkspaceDashboard({ query: { queryKey: getGetWorkspaceDashboardQueryKey() } });
  if (dashboard.isLoading) return <section className="page"><LoadingState /></section>;
  if (dashboard.isError || !dashboard.data) return <section className="page"><ErrorState onRetry={() => dashboard.refetch()} /></section>;
  const data = dashboard.data;
  const kpis = data.kpis || [];
  return <section className="page dashboard-page">
    <PageHeading eyebrow="Monday, 17 August 2026" title="Good morning, team." description="The decisions shaping the next Vivo collection." action={<Link className="button button-gold" href="/product-workspace/plan" data-testid="link-open-plan">Open Q3 plan <ArrowRight size={16} /></Link>} />
    <div className="hero-ribbon"><div><span className="eyebrow gold-eyebrow">Collection pulse</span><h2>Make room for the<br /><em>right</em> product.</h2></div><div className="ribbon-stat"><strong>29</strong><span>stores reading<br />the same signal</span></div><div className="ribbon-lines" /></div>
    <div className="kpi-grid">{(kpis.length ? kpis.slice(0, 4) : [{ label: 'Styles in motion', value: '24', change: '+12%' }, { label: 'Awaiting decisions', value: '08', change: 'This week' }, { label: 'Q3 assortment', value: '126', change: 'Across 4 markets' }, { label: 'On-time delivery', value: '87%', change: '+6.4%' }]).map((item, index) => <div className="metric-card" key={index} data-testid={`card-kpi-${index}`}><span>{fmt(getPathValue(item, ['label', 'name', 'title']), ['Styles in motion', 'Awaiting decisions', 'Q3 assortment', 'On-time delivery'][index])}</span><strong>{metricValue(getPathValue(item, ['value', 'count', 'total']), getPathValue(item, ['suffix', 'unit']), ['24', '08', '126', '87%'][index])}</strong><small className={index === 1 ? 'muted-small' : 'positive'}>{fmt(getPathValue(item, ['change', 'delta', 'detail']), ['+12%', 'This week', 'Across 4 markets', '+6.4%'][index])}</small></div>)}</div>
    <div className="dashboard-columns"><div className="panel activity-panel"><div className="panel-heading"><div><span className="eyebrow">The room</span><h3>Recent activity</h3></div><Link className="text-button" href="/product-workspace/board" data-testid="link-view-activity">View all <ArrowRight size={14} /></Link></div>{data.activity?.length ? data.activity.slice(0, 5).map((item, i) => <div className="activity-row" key={i} data-testid={`row-activity-${i}`}><div className="activity-mark">{i % 2 ? <MessageCircle size={15} /> : <Check size={15} />}</div><div><strong>{fmt(getPathValue(item, ['title', 'action', 'name']), 'Collection update')}</strong><p>{fmt(getPathValue(item, ['detail', 'description', 'body']), 'A decision was logged in the workspace.')}</p></div><time>{date(getPathValue(item, ['time', 'createdAt']))}</time></div>) : <EmptyState title="The room is quiet" text="Activity will appear here as the team moves product forward." />}</div><div className="panel upcoming-panel"><div className="panel-heading"><div><span className="eyebrow">Next up</span><h3>Key dates</h3></div><CalendarDays size={18} /></div>{data.upcoming?.length ? data.upcoming.slice(0, 4).map((item, i) => <div className="upcoming-row" key={i} data-testid={`row-upcoming-${i}`}><div className="date-block"><b>{fmt(getPathValue(item, ['day', 'date']), '18')}</b><span>{fmt(getPathValue(item, ['month']), 'JUN')}</span></div><div><strong>{fmt(getPathValue(item, ['title', 'name']), 'Range review')}</strong><p>{fmt(getPathValue(item, ['detail', 'description']), 'Product team')}</p></div></div>) : <EmptyState title="No dates on deck" text="Your next reviews will show up here." />}</div></div>
  </section>;
}

function Login() {
  const [, setLocation] = useLocation();
  const login = useLoginWorkspace();
  const [email, setEmail] = useState('amara@vivo.co.ke');
  const [password, setPassword] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); login.mutate({ data: { email, password } }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getGetWorkspaceSessionQueryKey() }); setLocation('/product-workspace/'); } }); };
  return <div className="login-page"><div className="login-art"><div className="login-art-copy"><div className="brand-lockup light"><div className="brand-mark">V</div><div><div className="brand-name">Vivo</div><div className="brand-sub">Product workspace</div></div></div><div className="login-manifesto"><span>East Africa / 2026</span><h1>Product is a<br /><em>conversation.</em></h1><p>A considered room for the people deciding what Vivo becomes next.</p></div><div className="login-footer">Nairobi · Kampala · Dar es Salaam · Kigali</div></div></div><div className="login-form-wrap"><div className="login-form"><div className="eyebrow">Private workspace</div><h2>Welcome back.</h2><p className="form-intro">Sign in with your Vivo account to continue.</p><form onSubmit={submit}><label>Email address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@vivo.com" required data-testid="input-email" /></label><label>Password<div className="password-wrap"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" required data-testid="input-password" /><button type="button" className="password-hint" onClick={() => setPassword('vivo2026')} data-testid="button-fill-password">Use passkey</button></div></label>{login.isError && <div className="form-error">That sign-in didn't work. Check your details and try again.</div>}<button className="button button-dark button-wide" disabled={login.isPending} type="submit" data-testid="button-login">{login.isPending ? 'Opening workspace…' : 'Enter workspace'} <ArrowRight size={16} /></button></form><div className="login-meta"><span>Vivo Digital Product Workspace</span><span>v1.4.0</span></div></div></div></div>;
}

function PlanPage() {
  const plan = useGetWorkspacePlan({ query: { queryKey: getGetWorkspacePlanQueryKey() } });
  const history = useListWorkspacePlanHistory({ query: { queryKey: getListWorkspacePlanHistoryQueryKey() } });
  const update = useUpdateWorkspacePlan();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const p = plan.data as WorkspacePlan | undefined;
  const styles = p?.styles || [];
  const startEdit = () => { setName(p?.name || ''); setEditing(true); };
  const save = () => update.mutate({ data: { name } }, { onSuccess: () => { setEditing(false); queryClient.invalidateQueries({ queryKey: getGetWorkspacePlanQueryKey() }); queryClient.invalidateQueries({ queryKey: getListWorkspacePlanHistoryQueryKey() }); } });
  if (plan.isLoading) return <section className="page"><LoadingState /></section>;
  if (plan.isError || !p) return <section className="page"><ErrorState onRetry={() => plan.refetch()} /></section>;
  return <section className="page"><PageHeading eyebrow={`${p.quarter} ${p.year} / Assortment`} title={editing ? 'Name this plan.' : p.name} description="A living view of the range, tuned for East African demand." action={<div className="button-group"><button className="button button-quiet" onClick={() => setHistoryOpen(true)} data-testid="button-plan-history"><History size={15} /> History</button><button className="button button-quiet" disabled title="PDF export is coming soon" data-testid="button-export-pdf"><FileText size={15} /> PDF <span className="mono">Coming soon</span></button><button className="button button-dark" onClick={editing ? save : startEdit} data-testid="button-edit-plan">{editing ? <><Check size={15} /> Save plan</> : <><Settings2 size={15} /> Edit plan</>}</button></div>} />{editing && <div className="edit-inline"><input value={name} onChange={(e) => setName(e.target.value)} aria-label="Plan name" data-testid="input-plan-name" /><button className="icon-button" onClick={() => setEditing(false)} data-testid="button-cancel-plan"><X size={16} /></button></div>}<div className="plan-banner"><div><span className="eyebrow gold-eyebrow">Quarterly assortment</span><h2>{styles.length || 0} <small>styles in the edit</small></h2></div><div className="plan-facts"><div><span>Range shape</span><b>{fmt((p.summary as Record<string, unknown>)?.rangeShape, 'Balanced')}</b></div><div><span>Target margin</span><b>{fmt((p.summary as Record<string, unknown>)?.targetMargin, '58.2%')}</b></div><div><span>Markets</span><b>KE · UG · TZ · RW</b></div></div></div><div className="section-label"><span>Planned styles</span><span className="mono">{styles.length} / 126</span></div><div className="style-table">{styles.length ? styles.map((style, i) => <StyleRow key={style.id} style={style} index={i} />) : <EmptyState title="Your plan is a blank page" text="Styles added to the assortment will appear here." />}</div>{historyOpen && <div className="drawer-backdrop" onClick={() => setHistoryOpen(false)}><aside className="history-drawer" onClick={(e) => e.stopPropagation()}><div className="drawer-header"><div><span className="eyebrow">Audit trail</span><h2>Plan history</h2></div><button className="icon-button" onClick={() => setHistoryOpen(false)} data-testid="button-close-history"><X size={17} /></button></div>{history.isLoading ? <LoadingState /> : history.data?.length ? history.data.map((item) => <div className="history-item" key={item.id} data-testid={`row-history-${item.id}`}><span className="history-dot" /><div><strong>{item.action}</strong><p>{item.detail || 'Plan was updated.'}</p><small>{item.actor} · {date(item.createdAt)}</small></div></div>) : <EmptyState title="No edits yet" text="Changes to the plan will be recorded here." />}</aside></div>}</section>;
}
function StyleRow({ style, index }: { style: WorkspaceStyle; index: number }) { return <Link href={`/product-workspace/styles/${style.id}`} className="style-row" data-testid={`row-style-${style.id}`}><span className="row-index">{String(index + 1).padStart(2, '0')}</span><div className="style-thumb" style={style.image ? { backgroundImage: `url(${style.image})` } : undefined}><Palette size={15} /></div><div className="style-main"><strong>{style.name}</strong><span>{style.code} · {style.brand} · {style.category}</span></div><StatusPill value={style.status} /><div className="row-progress"><Progress value={style.progress} /><span>{style.progress || 0}%</span></div><span className="row-date">{date(style.targetDate)} <ChevronRight size={15} /></span></Link>; }

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
  return <section className="page"><PageHeading eyebrow="Shared decision rooms" title="Boards" description="Keep the work visible. Move ideas into decisions." action={<button className="button button-dark" onClick={() => setNewBoard(true)} data-testid="button-new-board"><Plus size={16} /> New board</button>} />{newBoard && <div className="modal-backdrop"><div className="modal-card"><div className="drawer-header"><div><span className="eyebrow">New room</span><h2>Start a board</h2></div><button className="icon-button" onClick={() => setNewBoard(false)} data-testid="button-close-board-modal"><X size={17} /></button></div><label>Board title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. High summer colour edit" data-testid="input-board-title" /></label><button className="button button-dark button-wide" onClick={createBoard} disabled={create.isPending} data-testid="button-create-board">Create board <ArrowRight size={16} /></button></div></div>}<div className="board-grid">{boards.data?.length ? boards.data.map((item) => <button className="board-card" key={item.id} onClick={() => setSelected(item.id)} data-testid={`card-board-${item.id}`}><div className="board-card-top"><span className="board-symbol"><Columns3 size={17} /></span><span className="mono">{String(item.id).padStart(2, '0')}</span></div><h3>{item.title}</h3><p>{item.description || 'A shared space for product decisions.'}</p><div className="board-card-meta"><span>{item.cards?.length || 0} cards</span><span>{item.collaborators?.length || 0} collaborators <ArrowRight size={13} /></span></div></button>) : <EmptyState title="No boards yet" text="Start a room for your next product conversation." action={<button className="button button-dark" onClick={() => setNewBoard(true)} data-testid="button-empty-new-board"><Plus size={15} /> Create board</button>} />}</div></section>;
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
  return <section className="page board-detail-page"><button className="back-link" onClick={onBack} data-testid="button-back-boards"><ArrowLeft size={15} /> All boards</button><PageHeading eyebrow="Collaboration board" title={board.title} description={board.description} action={<span className="collab-stack">{board.collaborators?.slice(0, 4).map((person) => <span key={person.id} className="avatar small" style={{ background: person.color }}>{person.initials}</span>)}<span className="presence-label" data-testid="text-board-presence">{presence} connected</span></span>} /><div className="board-toolbar"><span className="eyebrow">Working view · drag cards between columns</span><div><button className="button button-quiet" onClick={() => queryClient.invalidateQueries({ queryKey: getGetWorkspaceBoardQueryKey(board.id) })} data-testid="button-board-filter"><Settings2 size={14} /> Refresh view</button><button className="button button-quiet" onClick={() => navigator.clipboard?.writeText(window.location.href)} data-testid="button-board-share">Copy board link</button></div></div><div className="kanban">{columns.map((column, i) => { const record = column as Record<string, unknown>; const id = String(record.id || record.key || i); const title = String(record.title || record.name || `Column ${i + 1}`); const cards = (board.cards || []).filter((card) => card.columnId === id); return <div className={`kanban-column ${draggedCard ? 'drop-ready' : ''}`} key={id} onDragOver={(event) => event.preventDefault()} onDrop={() => moveCard(id)} data-testid={`column-board-${id}`}><div className="column-heading"><span>{title}</span><b>{cards.length}</b></div>{cards.map((card) => <div className="kanban-card" draggable onDragStart={() => setDraggedCard(card.id)} onDragEnd={() => setDraggedCard(null)} key={card.id} data-testid={`card-board-item-${card.id}`}><span className="mono">{card.styleId ? `ST-${card.styleId}` : 'NOTE'}</span><h4>{card.title}</h4><p>{card.description || 'No description yet.'}</p><div className="tag-row">{(card.tags || ['Product']).map((tag) => <span key={tag}>{tag}</span>)}</div></div>)}{i === 0 && <div className="add-card"><input value={cardTitle} onChange={(e) => setCardTitle(e.target.value)} placeholder="Add a card…" data-testid="input-card-title" /><button onClick={addCard} aria-label="Add card" data-testid="button-add-card"><Plus size={15} /></button></div>}</div>})}</div><div className="comments-panel"><div className="panel-heading"><div><span className="eyebrow">The thread</span><h3>Comments <span className="count">{board.comments?.length || 0}</span></h3></div><MessageCircle size={18} /></div>{board.comments?.slice(0, 5).map((item) => <div className="comment-row" key={item.id} data-testid={`comment-board-${item.id}`}><div className="avatar" style={{ background: item.author.color }}>{item.author.initials}</div><div><strong>{item.author.name}</strong><time>{date(item.createdAt)}</time><p>{item.body}</p></div></div>)}<div className="comment-input"><input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add to the conversation…" data-testid="input-comment" /><button onClick={addComment} data-testid="button-add-comment"><ArrowRight size={16} /></button></div></div></section>;
}

function PlmPage() {
  const styles = useListWorkspaceStyles(undefined, { query: { queryKey: getListWorkspaceStylesQueryKey() } });
  const [selected, setSelected] = useState<number | null>(null);
  if (selected) return <PlmDetail id={selected} onBack={() => setSelected(null)} />;
  return <section className="page"><PageHeading eyebrow="Product lifecycle management" title="Style development" description="The path from first thought to production-ready." action={<div className="view-switch"><button className="active" data-testid="button-plm-board"><Columns3 size={15} /> Board</button><button data-testid="button-plm-list"><FileText size={15} /> List</button></div>} />{styles.isLoading ? <LoadingState /> : <div className="plm-overview"><div className="plm-intro"><span className="eyebrow gold-eyebrow">Current motion</span><h2>From sketch to<br /><em>store floor.</em></h2><p>Every style has a next step. Keep the handoffs clean and the questions close.</p></div><div className="plm-stages">{['Brief', 'Development', 'Sample', 'Ready'].map((stage, i) => <div className="plm-stage" key={stage}><div className="stage-title"><span>{stage}</span><b>{styles.data?.filter((s) => i === 0 ? /brief/i.test(s.status) : i === 1 ? /develop|progress/i.test(s.status) : i === 2 ? /sample/i.test(s.status) : /ready|approved/i.test(s.status)).length || [4, 8, 3, 9][i]}</b></div><div className="stage-line"><span style={{ width: `${[28, 64, 43, 82][i]}%` }} /></div>{styles.data?.filter((s) => i === 0 ? /brief/i.test(s.status) : i === 1 ? /develop|progress/i.test(s.status) : i === 2 ? /sample/i.test(s.status) : /ready|approved/i.test(s.status)).slice(0, 3).map((style) => <button className="plm-style" key={style.id} onClick={() => setSelected(style.id)} data-testid={`card-plm-style-${style.id}`}><span className="mono">{style.code}</span><strong>{style.name}</strong><small>{style.owner} · {date(style.targetDate)}</small><Progress value={style.progress} /></button>)}</div>)}</div></div>}</section>;
}
function PlmDetail({ id, onBack }: { id: number; onBack: () => void }) { const style = useGetWorkspaceStyle(id, { query: { queryKey: getGetWorkspaceStyleQueryKey(id) } }); const plm = useGetWorkspaceStylePlm(id, { query: { queryKey: getGetWorkspaceStylePlmQueryKey(id) } }); return <section className="page"><button className="back-link" onClick={onBack} data-testid="button-back-plm"><ArrowLeft size={15} /> Development board</button>{style.isLoading ? <LoadingState /> : style.data ? <><PageHeading eyebrow={`PLM / ${style.data.code}`} title={style.data.name} description={`${style.data.brand} · ${style.data.category} · Owner ${style.data.owner}`} action={<StatusPill value={style.data.status} />} /><div className="detail-grid"><div className="detail-hero"><div className="detail-image" style={style.data.image ? { backgroundImage: `url(${style.data.image})` } : undefined}><Palette size={36} /></div><div><span className="eyebrow">Completion</span><h2>{style.data.progress || 0}%</h2><Progress value={style.data.progress} /><p>Target date {date(style.data.targetDate)}</p></div></div><div className="panel checklist-panel"><div className="panel-heading"><div><span className="eyebrow">Workflow</span><h3>Development checks</h3></div><Clock3 size={18} /></div>{['Tech pack', 'Fabric confirmed', 'Fit session', 'POM / QC', 'Cost estimate', 'Production order'].map((label, i) => <div className="check-row" key={label}><span className={i < (style.data.progress || 0) / 18 ? 'check done' : 'check'}>{i < (style.data.progress || 0) / 18 && <Check size={12} />}</span><span>{label}</span><small>{i < (style.data.progress || 0) / 18 ? 'Complete' : 'Upcoming'}</small></div>)}</div><div className="panel detail-data">{plm.isLoading ? <Skeleton className="skeleton-panel" /> : <><span className="eyebrow">PLM signal</span><h3>What needs attention</h3><p>{plm.data ? 'PLM data is synced. Review the open checks before the next handoff.' : 'No additional PLM notes yet.'}</p><button className="button button-quiet" data-testid="button-open-plm-data">Open full PLM record <ArrowRight size={15} /></button></>}</div></div></> : <ErrorState onRetry={() => style.refetch()} />}</section>; }

function ShowcasePage() {
  const showcases = useListWorkspaceShowcases({ query: { queryKey: getListWorkspaceShowcasesQueryKey() } });
  const [selected, setSelected] = useState<number | null>(null);
  if (selected) return <ShowcaseDetail id={selected} onBack={() => setSelected(null)} />;
  return <section className="page"><PageHeading eyebrow="Editorial gallery" title="Showcase" description="The considered edit — ready to share with the room." action={<button className="button button-quiet" data-testid="button-showcase-filter">All seasons <ChevronDown size={15} /></button>} />{showcases.isLoading ? <LoadingState /> : <div className="showcase-grid">{showcases.data?.length ? showcases.data.map((showcase, i) => <button className={`showcase-card showcase-${i % 3}`} key={showcase.id} onClick={() => setSelected(showcase.id)} data-testid={`card-showcase-${showcase.id}`}><div className="showcase-visual"><span>{String(showcase.season).slice(0, 2)}</span><GalleryHorizontalEnd size={22} /></div><div className="showcase-copy"><div><StatusPill value={showcase.status} /><span className="mono">{showcase.frames?.length || 0} frames</span></div><h3>{showcase.title}</h3><p>{showcase.description || 'A seasonal point of view.'}</p><span className="showcase-open">Open story <ArrowRight size={14} /></span></div></button>) : <EmptyState title="The gallery is waiting" text="Published showcases will take their place here." />}</div>}</section>;
}
function ShowcaseDetail({ id, onBack }: { id: number; onBack: () => void }) { const showcase = useGetWorkspaceShowcase(id, { query: { queryKey: getGetWorkspaceShowcaseQueryKey(id) } }); const [frame, setFrame] = useState(0); const frames = showcase.data?.frames || []; return <section className="page showcase-detail">{<button className="back-link" onClick={onBack} data-testid="button-back-showcase"><ArrowLeft size={15} /> All showcases</button>}{showcase.isLoading ? <LoadingState /> : showcase.data ? <><PageHeading eyebrow={`${showcase.data.season} / Showcase`} title={showcase.data.title} description={showcase.data.description} action={<StatusPill value={showcase.data.status} />} /><div className="story-frame"><div className="story-visual"><span className="frame-number">{String(frame + 1).padStart(2, '0')} / {String(frames.length || 1).padStart(2, '0')}</span><div className="frame-art"><Sparkles size={46} /></div><button className="frame-prev" onClick={() => setFrame((frame - 1 + frames.length) % Math.max(frames.length, 1))} data-testid="button-frame-previous"><ArrowLeft size={18} /></button><button className="frame-next" onClick={() => setFrame((frame + 1) % Math.max(frames.length, 1))} data-testid="button-frame-next"><ArrowRight size={18} /></button></div><div className="story-caption"><span className="eyebrow">Frame {frame + 1}</span><h2>{fmt(getPathValue(frames[frame], ['title', 'name']), 'A study in proportion')}</h2><p>{fmt(getPathValue(frames[frame], ['description', 'caption']), showcase.data.description || 'A point of view for the season.')}</p><div className="frame-dots">{frames.map((_, i) => <button className={frame === i ? 'active' : ''} key={i} onClick={() => setFrame(i)} data-testid={`button-frame-${i}`} />)}</div></div></div></> : <ErrorState onRetry={() => showcase.refetch()} />}</section>; }

function StylesPage() {
  const params = useParams<{ id?: string }>();
  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  const styles = useListWorkspaceStyles({ search: search || undefined, brand: brand || undefined }, { query: { queryKey: getListWorkspaceStylesQueryKey({ search: search || undefined, brand: brand || undefined }) } });
  const [selected, setSelected] = useState<number | null>(() => params.id ? Number(params.id) : null);
  const brands = useMemo(() => Array.from(new Set((styles.data || []).map((s) => s.brand).filter(Boolean))), [styles.data]);
  if (selected) return <StyleDetail id={selected} onBack={() => setSelected(null)} />;
  return <section className="page"><PageHeading eyebrow="Product library" title="Style catalogue" description="Search the working language of the Vivo collection." /><div className="catalogue-tools"><label className="search-field"><Search size={17} /><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by style, code or owner…" data-testid="input-style-search" /></label><select value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Filter by brand" data-testid="select-style-brand"><option value="">All brands</option>{brands.map((item) => <option key={item} value={item}>{item}</option>)}</select><button className="button button-quiet" onClick={() => { setSearch(''); setBrand(''); }} data-testid="button-clear-style-filters">Clear filters</button></div>{styles.isLoading ? <LoadingState /> : <div className="catalogue-list"><div className="catalogue-head"><span>{styles.data?.length || 0} styles</span><span>Updated moments ago</span></div>{styles.data?.length ? styles.data.map((style, i) => <button className="catalogue-row" key={style.id} onClick={() => setSelected(style.id)} data-testid={`row-catalogue-style-${style.id}`}><span className="row-index">{String(i + 1).padStart(2, '0')}</span><div className="catalogue-thumb" style={style.image ? { backgroundImage: `url(${style.image})` } : undefined}><Palette size={15} /></div><div className="catalogue-name"><strong>{style.name}</strong><span>{style.code} · {style.category}</span></div><span className="catalogue-brand">{style.brand}</span><StatusPill value={style.status} /><div className="catalogue-progress"><Progress value={style.progress} /><span>{style.progress || 0}%</span></div><ChevronRight size={16} /></button>) : <EmptyState title="No styles in this edit" text="Try a different search or clear your filters." action={<button className="button button-quiet" onClick={() => { setSearch(''); setBrand(''); }} data-testid="button-empty-clear-filters">Clear filters</button>} />}</div>}</section>;
}
function StyleDetail({ id, onBack }: { id: number; onBack: () => void }) { const style = useGetWorkspaceStyle(id, { query: { queryKey: getGetWorkspaceStyleQueryKey(id) } }); const update = useUpdateWorkspaceStyle(); const [editing, setEditing] = useState(false); const [owner, setOwner] = useState(''); const save = () => update.mutate({ id, data: { owner } }, { onSuccess: () => { setEditing(false); queryClient.invalidateQueries({ queryKey: getGetWorkspaceStyleQueryKey(id) }); queryClient.invalidateQueries({ queryKey: getListWorkspaceStylesQueryKey() }); } }); return <section className="page">{<button className="back-link" onClick={onBack} data-testid="button-back-catalogue"><ArrowLeft size={15} /> Style catalogue</button>}{style.isLoading ? <LoadingState /> : style.data ? <><PageHeading eyebrow={`Style / ${style.data.code}`} title={style.data.name} description={`${style.data.brand} · ${style.data.category} · ${style.data.market || 'East Africa'}`} action={<button className="button button-dark" onClick={() => { setOwner(style.data?.owner || ''); setEditing(!editing); }} data-testid="button-edit-style"><Settings2 size={15} /> Edit style</button>} />{editing && <div className="edit-inline"><label>Owner<input value={owner} onChange={(e) => setOwner(e.target.value)} data-testid="input-style-owner" /></label><button className="button button-gold" onClick={save} disabled={update.isPending} data-testid="button-save-style">Save changes <Check size={15} /></button></div>}<div className="style-detail-layout"><div className="style-detail-art" style={style.data.image ? { backgroundImage: `url(${style.data.image})` } : undefined}><div className="style-art-label"><span className="mono">{style.data.code}</span><b>{style.data.name}</b></div></div><div className="style-detail-info"><div className="detail-status"><StatusPill value={style.data.status} /><span className="mono">Target {date(style.data.targetDate)}</span></div><h2>A shape worth<br /><em>keeping close.</em></h2><div className="detail-progress"><div><span>Development progress</span><b>{style.data.progress || 0}%</b></div><Progress value={style.data.progress} /></div><div className="fact-list"><div><span>Owner</span><b>{style.data.owner}</b></div><div><span>Price</span><b>{style.data.price ? `KES ${style.data.price.toLocaleString()}` : 'To be set'}</b></div><div><span>Market</span><b>{style.data.market || 'East Africa'}</b></div></div></div></div><div className="style-tabs"><button className="active" data-testid="button-style-overview">Overview</button><button data-testid="button-style-colourways">Colourways <span>{style.data.colorways?.length || 0}</span></button><button data-testid="button-style-fabrics">Fabrics <span>{style.data.fabrics?.length || 0}</span></button><button data-testid="button-style-samples">Samples <span>{style.data.samples?.length || 0}</span></button><button data-testid="button-style-production">Production</button></div></> : <ErrorState onRetry={() => style.refetch()} />}</section>; }

function Router() { const [location] = useLocation(); return <ErrorBoundary resetKey={location}><Switch><Route path="/product-workspace/login" component={Login} /><Route path="/product-workspace/" component={Dashboard} /><Route path="/product-workspace/plan" component={PlanPage} /><Route path="/product-workspace/board" component={BoardPage} /><Route path="/product-workspace/plm" component={PlmPage} /><Route path="/product-workspace/showcase" component={ShowcasePage} /><Route path="/product-workspace/styles" component={StylesPage} /><Route path="/product-workspace/styles/:id" component={StylesPage} /><Route component={NotFound} /></Switch></ErrorBoundary>; }
function App() { return <QueryClientProvider client={queryClient}><WouterRouter><Shell><Router /></Shell></WouterRouter></QueryClientProvider>; }
export default App;