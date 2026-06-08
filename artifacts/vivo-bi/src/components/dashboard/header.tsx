import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ChevronDown, Check, Sun, Moon, Printer } from "lucide-react";
import { DATA_SOURCES } from "@/lib/utils";
import { getGetKpiSummaryQueryKey } from "@workspace/api-client-react";

const INTERVAL_OPTIONS = [
  { label: "Every 5 min", ms: 5 * 60 * 1000 },
  { label: "Every 15 min", ms: 15 * 60 * 1000 },
  { label: "Every 1 hour", ms: 60 * 60 * 1000 },
];

export function DashboardHeader() {
  const queryClient = useQueryClient();
  const [isDark, setIsDark] = useState(false);
  const [isSpinning, setIsSpinning] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [selectedIntervalMs, setSelectedIntervalMs] = useState(INTERVAL_OPTIONS[0].ms);
  
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Dark mode sync
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  // Click outside for dropdown
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Auto-refresh logic
  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const intervalId = setInterval(() => {
      handleRefresh();
    }, selectedIntervalMs);
    return () => clearInterval(intervalId);
  }, [autoRefreshEnabled, selectedIntervalMs]);

  const handleRefresh = async () => {
    setIsSpinning(true);
    await queryClient.invalidateQueries();
    setTimeout(() => setIsSpinning(false), 600);
  };

  // Get last refreshed from one of the core queries
  const summaryState = queryClient.getQueryState(getGetKpiSummaryQueryKey());
  const lastRefreshed = summaryState?.dataUpdatedAt
    ? (() => {
        const d = new Date(summaryState.dataUpdatedAt);
        const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
        const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        return `${time} on ${date}`;
      })()
    : null;

  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="pt-2">
        <h1 className="font-serif font-bold text-[36px] tracking-tight">Vivo Fashion Group</h1>
        <p className="text-muted-foreground mt-1 text-[14px]">Executive Business Intelligence</p>
        
        {DATA_SOURCES.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-3">
            <span className="text-[12px] text-muted-foreground shrink-0">Data Sources:</span>
            {DATA_SOURCES.map((source) => (
              <span
                key={source}
                className="text-[11px] font-medium rounded px-2 py-0.5 truncate print:!bg-[rgb(229,231,235)] print:!text-[rgb(75,85,99)] border"
                title={source}
                style={{
                  maxWidth: "20ch",
                  backgroundColor: isDark ? "rgba(255,255,255,0.05)" : "#f9fafb",
                  borderColor: isDark ? "rgba(255,255,255,0.1)" : "#e5e7eb",
                  color: isDark ? "#d1d5db" : "#4b5563",
                }}
              >
                {source}
              </span>
            ))}
          </div>
        )}
        {lastRefreshed && <p className="text-[12px] text-muted-foreground mt-2">Last refresh: {lastRefreshed}</p>}
      </div>

      <div className="flex items-center gap-3 pt-2 print:hidden">
        <div className="relative" ref={dropdownRef}>
          <div
            className="flex items-center rounded-[6px] overflow-hidden h-[26px] text-[12px] shadow-sm border border-transparent dark:border-white/10"
            style={{
              backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "#ffffff",
              color: isDark ? "#c8c9cc" : "#4b5563",
              border: isDark ? undefined : "1px solid #e5e7eb",
            }}
          >
            <button 
              onClick={handleRefresh} 
              className="flex items-center gap-1.5 px-2.5 h-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors font-medium"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSpinning ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <div className="w-px h-4 shrink-0" style={{ backgroundColor: isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.1)" }} />
            <button 
              onClick={() => setDropdownOpen((o) => !o)} 
              className="flex items-center justify-center px-1.5 h-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>

          {dropdownOpen && (
            <div className="absolute right-0 top-full mt-1 w-48 rounded-md border bg-popover text-popover-foreground shadow-md z-50 py-1 text-sm">
              <div className="px-3 py-2 flex items-center justify-between border-b">
                <span className="font-medium text-xs">Auto-refresh</span>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" checked={autoRefreshEnabled} onChange={(e) => setAutoRefreshEnabled(e.target.checked)} />
                  <div className="w-7 h-4 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-primary"></div>
                </label>
              </div>
              <div className="py-1">
                {INTERVAL_OPTIONS.map((opt) => (
                  <button
                    key={opt.ms}
                    className={`w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-muted transition-colors ${!autoRefreshEnabled ? "opacity-50 cursor-not-allowed" : ""}`}
                    disabled={!autoRefreshEnabled}
                    onClick={() => {
                      setSelectedIntervalMs(opt.ms);
                      setDropdownOpen(false);
                    }}
                  >
                    <span>{opt.label}</span>
                    {selectedIntervalMs === opt.ms && <Check className="w-3 h-3 text-primary" />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => window.print()}
          className="flex items-center justify-center w-[26px] h-[26px] rounded-[6px] transition-colors shadow-sm border"
          style={{ 
            backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "#ffffff", 
            color: isDark ? "#c8c9cc" : "#4b5563",
            borderColor: isDark ? "rgba(255,255,255,0.1)" : "#e5e7eb"
          }}
          aria-label="Export as PDF"
        >
          <Printer className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setIsDark((d) => !d)}
          className="flex items-center justify-center w-[26px] h-[26px] rounded-[6px] transition-colors shadow-sm border"
          style={{ 
            backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "#ffffff", 
            color: isDark ? "#c8c9cc" : "#4b5563",
            borderColor: isDark ? "rgba(255,255,255,0.1)" : "#e5e7eb"
          }}
          aria-label="Toggle dark mode"
        >
          {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}
