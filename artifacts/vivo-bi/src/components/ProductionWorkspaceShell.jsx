import React, { useState, useEffect } from 'react';
import {
  Factory,
  CalendarCheck,
  MonitorPlay,
  ClipboardText,
  PlayCircle,
  MagnifyingGlass,
  Engine,
  Users,
  FirstAid,
  Megaphone,
  IdentificationBadge,
  Wrench,
  GearSix,
  List,
  X,
  CaretLeft,
  UserCircle,
  WarningCircle
} from '@phosphor-icons/react';
import '../styles/production-workspace.css';

const NAV_ITEMS = [
  { id: "workspace", label: "Workspace", icon: Factory },
  { id: "plan", label: "Production Plan", icon: CalendarCheck },
  { id: "line-board", label: "Line Board", icon: MonitorPlay },
  { id: "work-orders", label: "Work Orders", icon: ClipboardText },
  { id: "execution", label: "Execution", icon: PlayCircle },
  { id: "quality", label: "Quality & Rework", icon: MagnifyingGlass },
  { id: "machines", label: "Machines", icon: Engine },
  { id: "productivity", label: "Operator Productivity", icon: Users },
  { id: "recovery", label: "Recovery Room", icon: FirstAid },
  { id: "huddle", label: "Shift Huddle / L10", icon: Megaphone },
  { id: "team", label: "Team", icon: IdentificationBadge },
  { id: "resources", label: "Resources", icon: Wrench },
  { id: "settings", label: "Setup & Settings", icon: GearSix },
];

function getStatusTone(state) {
  if (!state) return 'neutral';
  const s = state.toLowerCase();
  if (['fresh', 'ready', 'complete', 'ok', 'online'].includes(s)) return 'success';
  if (['stale', 'partial', 'incomplete', 'warning'].includes(s)) return 'warning';
  if (['error', 'missing', 'offline', 'failed'].includes(s)) return 'danger';
  return 'neutral';
}

function StatusIndicator({ status }) {
  if (!status) return null;
  const tone = getStatusTone(status.state);
  return (
    <div className={`pw-status pw-status--${tone}`} title={`As of ${status.asOf || 'unknown'}`} data-testid="pw-status-indicator">
      <span className="pw-status-dot" aria-hidden="true" />
      <div className="pw-status-text">
        <div className="pw-status-label">{status.label || 'Status'}</div>
        <div className="pw-status-state">{status.state}</div>
      </div>
    </div>
  );
}

function ScopeSelect({ label, field, data, onChange }) {
  if (!data) return null;
  
  const isDate = field === 'date' && (!data.options || data.options.length === 0);
  const isUnavailable = Boolean(data.disabled);
  
  return (
    <div className="pw-scope-item" data-testid={`pw-scope-${field}`}>
      <label className="pw-scope-label" htmlFor={`pw-scope-input-${field}`}>{label}</label>
      {isDate ? (
        <input
          id={`pw-scope-input-${field}`}
          type="date"
          className="pw-scope-select"
          value={data.value || ""}
          disabled={isUnavailable}
          onChange={(e) => onChange && onChange(field, e.target.value)}
        />
      ) : (
        <select 
          id={`pw-scope-input-${field}`}
          className="pw-scope-select"
          value={data.value || ""}
          disabled={isUnavailable}
          aria-describedby={isUnavailable ? `pw-scope-note-${field}` : undefined}
          onChange={(e) => onChange && onChange(field, e.target.value)}
        >
          <option value="" disabled>Select {label}</option>
          {(data.options || []).map((opt, i) => {
            const val = opt.id !== undefined ? opt.id : opt.value;
            const text = opt.label || opt.name || val;
            return <option key={val || i} value={val}>{text}</option>;
          })}
        </select>
      )}
      {isUnavailable && <div id={`pw-scope-note-${field}`} className="pw-scope-note">{data.note || "This filter is not available for the current source."}</div>}
    </div>
  );
}

function ScopeInput({ label, field, data, onChange, type = "text" }) {
  if (!data) return null;
  return (
    <div className="pw-scope-item" data-testid={`pw-scope-${field}`}>
      <label className="pw-scope-label" htmlFor={`pw-scope-input-${field}`}>{label}</label>
      <input
        id={`pw-scope-input-${field}`}
        type={type}
        className="pw-scope-select pw-scope-input"
        value={data.value || ""}
        placeholder={data.placeholder || label}
        onChange={(event) => onChange && onChange(field, event.target.value)}
      />
    </div>
  );
}

export default function ProductionWorkspaceShell({
  children,
  activeModule = "workspace",
  onNavigate,
  scope,
  onScopeChange,
  onBackToBi,
  user,
  sourceStatus
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleNavClick = (id) => {
    if (onNavigate) onNavigate(id);
    setMobileOpen(false);
  };

  return (
    <div className="pw-shell" data-testid="pw-shell">
      <div 
        className={`pw-mobile-overlay ${mobileOpen ? 'open' : ''}`}
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />

      <aside className={`pw-sidebar ${mobileOpen ? 'open' : ''}`} data-testid="pw-sidebar">
        <div className="pw-brand">
          <Factory size={28} weight="fill" color="var(--pw-gold)" />
          <div className="pw-brand-text">
            <div className="pw-brand-title">Production</div>
            <div className="pw-brand-subtitle">Operating Workspace</div>
          </div>
          {mobileOpen && (
            <button 
              className="pw-mobile-close"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
            >
              <X size={20} />
            </button>
          )}
        </div>
        
        <nav className="pw-nav" aria-label="Production Modules" data-testid="pw-nav">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            const isActive = activeModule === item.id;
            return (
              <button
                key={item.id}
                className={`pw-nav-item ${isActive ? 'active' : ''}`}
                onClick={() => handleNavClick(item.id)}
                data-testid={`pw-nav-${item.id}`}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon size={20} weight={isActive ? "fill" : "regular"} className="pw-nav-icon" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="pw-main">
        <header className="pw-header">
          <div className="pw-header-top">
            <div className="pw-header-actions">
              <button 
                className="pw-mobile-toggle"
                onClick={() => setMobileOpen(true)}
                aria-label="Open menu"
                data-testid="pw-mobile-toggle"
              >
                <List size={20} />
              </button>
              
              {onBackToBi && (
                <button 
                  className="pw-back-btn" 
                  onClick={onBackToBi}
                  data-testid="pw-back-bi"
                >
                  <CaretLeft size={16} weight="bold" />
                  <span>Back to BI</span>
                </button>
              )}
            </div>
            
            <div className="pw-header-actions">
              <StatusIndicator status={sourceStatus} />
              <div className="pw-user-badge" data-testid="pw-user-badge">
                <UserCircle size={24} weight="light" color="var(--pw-navy)" />
                {user && (
                  <div className="pw-user-info">
                    <span className="pw-user-name">{user.name || 'Operator'}</span>
                    <span className="pw-user-role">{user.role || 'Production'}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
          
          {scope && (
            <div className="pw-scope-bar" data-testid="pw-scope-bar">
              <div className="pw-scope-filters">
                <ScopeSelect label="Date" field="date" data={scope.date} onChange={onScopeChange} />
                <ScopeSelect label="Factory" field="factory" data={scope.factory} onChange={onScopeChange} />
                <ScopeSelect label="Line" field="line" data={scope.line} onChange={onScopeChange} />
                <ScopeSelect label="Shift" field="shift" data={scope.shift} onChange={onScopeChange} />
                <ScopeSelect label="Stage" field="stage" data={scope.stage} onChange={onScopeChange} />
                <ScopeSelect label="Plan status" field="planStatus" data={scope.planStatus} onChange={onScopeChange} />
                <ScopeSelect label="Delivery risk" field="deliveryRisk" data={scope.deliveryRisk} onChange={onScopeChange} />
                <ScopeInput label="Owner" field="owner" data={scope.owner} onChange={onScopeChange} />
                <ScopeInput label="Search" field="search" data={scope.search} onChange={onScopeChange} />
              </div>
            </div>
          )}
        </header>
        
        <div className="pw-content" data-testid="pw-content">
          {children || (
            <div className="pw-empty-state">
              <WarningCircle size={48} weight="light" className="pw-empty-icon" />
              <h2 className="pw-empty-title">No Content Available</h2>
              <p className="pw-empty-text">
                Select a module from the sidebar to view production data, or check your operational scope settings.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
