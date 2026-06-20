import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Building2,
  TrendingUp,
  AlertTriangle,
  UserSearch,
  FileBarChart2,
  CalendarClock,
  GraduationCap,
  CalendarHeart,
  Grid3x3,
  TimerOff,
  LogOut,
  Moon,
  Sun,
  RefreshCw,
  Menu,
} from "lucide-react";
import { useAuth, roleLabel } from "../lib/auth";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetTrigger } from "./ui/sheet";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, roles: ["executive", "hr_manager", "branch_manager"] },
  { to: "/branches", label: "Branches", icon: Building2, roles: ["executive", "hr_manager", "branch_manager"] },
  { to: "/trends", label: "Trends", icon: TrendingUp, roles: ["executive", "hr_manager", "branch_manager"] },
  { to: "/alerts", label: "Alerts", icon: AlertTriangle, roles: ["executive", "hr_manager", "branch_manager"] },
  { to: "/employees", label: "Employees", icon: UserSearch, roles: ["executive", "hr_manager", "branch_manager"] },
  { to: "/training", label: "Training", icon: GraduationCap, roles: ["executive", "hr_manager", "branch_manager"] },
  { to: "/days-worked", label: "Days Worked", icon: CalendarHeart, roles: ["executive", "hr_manager", "branch_manager"] },
  { to: "/hours-lost", label: "Hours Lost", icon: TimerOff, roles: ["executive", "hr_manager", "branch_manager"] },
  { to: "/heatmap", label: "Heatmap", icon: Grid3x3, roles: ["executive", "hr_manager", "branch_manager"] },
  { to: "/reports", label: "Reports", icon: FileBarChart2, roles: ["executive", "hr_manager", "branch_manager"] },
  { to: "/leave", label: "Leave & Notes", icon: CalendarClock, roles: ["executive", "hr_manager"] },
];

export const VivoLogo = ({ size = 30, light = false }) => (
  <div className="flex items-center gap-2.5" data-testid="vivo-logo">
    <div
      className="grid place-items-center rounded-full font-bold"
      style={{
        width: size, height: size, fontSize: size * 0.42,
        background: light ? "rgba(255,255,255,0.15)" : "hsl(var(--brand))",
        color: light ? "#fff" : "hsl(var(--background))",
      }}
    >
      V
    </div>
    <div className="leading-tight">
      <div className={`font-serif font-bold tracking-tight text-[17px] ${light ? "text-white" : "text-brand-deep"}`}>VIVO</div>
      <div className={`text-[9px] uppercase tracking-[0.18em] -mt-0.5 ${light ? "text-white/70" : "text-muted-foreground"}`}>Fashion Group</div>
    </div>
  </div>
);

/** Vertical sidebar navigation (the reference dashboard's primary nav). */
function SidebarNav({ onNavigate }) {
  const { user } = useAuth();
  const items = NAV.filter((n) => n.roles.includes(user?.role));
  return (
    <nav className="flex flex-col gap-1 px-3" data-testid="primary-nav">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            onClick={onNavigate}
            data-testid={`nav-${item.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-xl px-3 py-2.5 text-[12.5px] font-bold uppercase tracking-wider transition-colors ${
                isActive
                  ? "bg-brand text-background"
                  : "text-foreground/70 hover:text-foreground hover:bg-white/60"
              }`
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

/** Shared sidebar shell — brand on top, nav in the middle, user footer pinned. */
function SidebarBody({ user, onNavigate }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center border-b border-border px-5 shrink-0">
        <VivoLogo />
      </div>
      <div className="flex-1 overflow-y-auto py-4">
        <SidebarNav onNavigate={onNavigate} />
      </div>
      <div className="border-t border-border px-5 py-4 text-[11px]">
        <div className="font-semibold text-foreground truncate" data-testid="user-name">{user?.name}</div>
        <div className="text-muted-foreground truncate">{user?.email}</div>
        {user?.branch_assignment && (
          <div className="text-muted-foreground mt-0.5">Branch: {user.branch_assignment}</div>
        )}
      </div>
    </div>
  );
}

export default function AppLayout({ children, onRefresh }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [dark, setDark] = React.useState(() => {
    const stored = localStorage.getItem("vivo_theme");
    if (stored) return stored === "dark";
    return false;
  });
  const [refreshing, setRefreshing] = React.useState(false);
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("vivo_theme", dark ? "dark" : "light");
  }, [dark]);

  const handleLogout = async () => { await logout(); navigate("/login"); };
  const handleRefresh = async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try { await onRefresh(); } finally { setTimeout(() => setRefreshing(false), 600); }
  };

  React.useEffect(() => {
    if (!onRefresh) return;
    const t = setInterval(() => onRefresh().catch(() => {}), 30 * 60 * 1000);
    return () => clearInterval(t);
  }, [onRefresh]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Fixed left sidebar (desktop) */}
      <aside
        className="hidden lg:flex fixed inset-y-0 left-0 z-30 w-64 flex-col border-r border-border"
        style={{ background: "hsl(var(--accent-soft))" }}
        data-testid="sidebar"
      >
        <SidebarBody user={user} />
      </aside>

      {/* Content column, offset for the sidebar on desktop */}
      <div className="lg:pl-64">
        {/* Top bar — mobile menu + status pills + actions */}
        <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
          <div className="flex h-16 items-center gap-3 px-4 lg:px-8">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden h-8 w-8 rounded-full" data-testid="mobile-menu-button">
                  <Menu className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0" style={{ background: "hsl(var(--accent-soft))" }}>
                <SidebarBody user={user} onNavigate={() => setMobileOpen(false)} />
              </SheetContent>
            </Sheet>

            {/* Brand shows in the top bar on mobile (sidebar hidden there) */}
            <div className="lg:hidden"><VivoLogo size={26} /></div>

            <div className="ml-auto flex items-center gap-2">
              <span className="hidden sm:inline-flex pill" data-testid="status-live">
                <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-success animate-pulse" />Live
              </span>
              <span className="hidden md:inline-flex pill" data-testid="status-role">
                {roleLabel(user?.role)}
              </span>
              {onRefresh && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRefresh}
                  data-testid="refresh-button"
                  disabled={refreshing}
                  className="h-8 rounded-full text-[11px] font-bold uppercase tracking-wider text-brand-deep hover:bg-white/60"
                >
                  <RefreshCw className={`mr-1.5 h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              )}
              <Button
                variant="ghost" size="icon" onClick={() => setDark(!dark)}
                data-testid="theme-toggle" aria-label="Toggle theme"
                className="h-8 w-8 rounded-full hover:bg-white/60"
              >
                {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost" size="icon" onClick={handleLogout}
                data-testid="logout-button" aria-label="Logout"
                className="h-8 w-8 rounded-full hover:bg-white/60"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1600px] px-4 py-6 lg:px-8 lg:py-8">{children}</main>

        <footer className="border-t border-border bg-panel/60">
          <div className="px-4 lg:px-8 py-3 text-[11px] text-muted-foreground">
            © {new Date().getFullYear()} Vivo Fashion Group · BI · East Africa
          </div>
        </footer>
      </div>
    </div>
  );
}
