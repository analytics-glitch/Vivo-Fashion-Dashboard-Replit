import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useFilters } from "@/lib/filters";
import { api, datePresets, fmtDate } from "@/lib/api";
import MultiSelect from "@/components/MultiSelect";
import { CLUSTERS, clusterStores } from "@/lib/clusters";
import {
  CalendarBlank,
  Globe,
  Storefront,
  ShareNetwork,
  Check,
  CaretDown,
  ArrowLeft,
  ArrowsLeftRight,
  ClockCounterClockwise,
} from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const COUNTRIES = ["Kenya", "Uganda", "Rwanda", "Online"];

// ---------- Date Range Picker (left presets + dual-month calendar) ----------
const PRESET_GROUPS = [
  {
    label: null,
    items: [
      ["today", "Today"],
      ["yesterday", "Yesterday"],
    ],
  },
  {
    label: "Last",
    items: [
      ["last_7d", "Last 7 days"],
      ["last_30d", "Last 30 days"],
      ["last_90d", "Last 90 days"],
      ["last_365d", "Last 365 days"],
      ["last_week", "Last week"],
      ["last_month", "Last month"],
      ["last_quarter", "Last quarter"],
      ["last_12_months", "Last 12 months"],
      ["last_year", "Last year"],
    ],
  },
  {
    label: "Period to date",
    items: [
      ["mtd", "Month to date"],
      ["qtd", "Quarter to date"],
      ["ytd", "Year to date"],
    ],
  },
];

const MobileFiltersOpenContext = createContext(null);

export const DateRangeButton = ({ autoPairToday = false }) => {
  const f = useFilters();
  const mobileFiltersOpen = useContext(MobileFiltersOpenContext);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [draftRange, setDraftRange] = useState(null);
  const [draftFromInput, setDraftFromInput] = useState(f.dateFrom);
  const [draftToInput, setDraftToInput] = useState(f.dateTo);
  const mobileTriggerRef = useRef(null);

  // Sync drafts whenever either presentation opens. Keeping one draft state
  // means switching between desktop and phone layouts cannot apply stale dates.
  useEffect(() => {
    if (desktopOpen || mobileOpen) {
      setDraftRange({
        from: f.dateFrom ? new Date(f.dateFrom + "T00:00:00") : undefined,
        to: f.dateTo ? new Date(f.dateTo + "T00:00:00") : undefined,
      });
      setDraftFromInput(f.dateFrom);
      setDraftToInput(f.dateTo);
    }
  }, [desktopOpen, mobileOpen, f.dateFrom, f.dateTo]);

  // If the enclosing mobile Filters sheet closes from its close button,
  // backdrop, or Escape, do not leave an expanded chooser behind for the next
  // time the sheet opens.
  useEffect(() => {
    if (mobileFiltersOpen === false) setMobileOpen(false);
  }, [mobileFiltersOpen]);

  const presets = datePresets();
  const activeLabel = useMemo(() => {
    if (f.preset && f.preset !== "custom" && presets[f.preset]) {
      return presets[f.preset].label;
    }
    if (f.dateFrom && f.dateTo) {
      if (f.dateFrom === f.dateTo) return fmtDate(f.dateFrom);
      return `${fmtDate(f.dateFrom)} → ${fmtDate(f.dateTo)}`;
    }
    return "Select range";
  }, [f.preset, f.dateFrom, f.dateTo, presets]);

  const choosePreset = (key) => {
    if (key === "custom") {
      f.setPresetKey("custom");
      return;
    }
    f.setPreset(key);
    // Store Detail should never compare a partial current day with a full
    // month. When a user explicitly chooses Today there, pair it with the
    // immediately preceding day.
    if (autoPairToday && key === "today") {
      f.setCompareMode("yesterday");
    }
    setMobileOpen(false);
    setDesktopOpen(false);
    requestAnimationFrame(() => mobileTriggerRef.current?.focus());
  };

  const fmtCalInput = (d) => {
    if (!d) return "";
    return d.toLocaleDateString("en-US", {
      month: "short", day: "2-digit", year: "numeric",
      timeZone: "Africa/Nairobi",
    });
  };

  const apply = () => {
    if (draftRange?.from) {
      const from = isoOf(draftRange.from);
      const to = isoOf(draftRange.to || draftRange.from);
      f.setDateFrom(from);
      f.setDateTo(to);
      f.setPresetKey("custom");
    } else if (draftFromInput && draftToInput) {
      f.setDateFrom(draftFromInput);
      f.setDateTo(draftToInput);
      f.setPresetKey("custom");
    }
    setMobileOpen(false);
    setDesktopOpen(false);
    requestAnimationFrame(() => mobileTriggerRef.current?.focus());
  };

  const closeMobile = () => {
    setMobileOpen(false);
    requestAnimationFrame(() => mobileTriggerRef.current?.focus());
  };

  const handleTriggerClick = (event) => {
    // On phones the chooser is rendered inline in the Filters sheet. Prevent
    // Radix from opening its portalled popover, which would create a second
    // focus/scroll owner.
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      event.preventDefault();
      event.stopPropagation();
      if (mobileOpen) closeMobile();
      else setMobileOpen(true);
    }
  };

  const today = new Date();
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);

  return (
    <Popover
      open={desktopOpen}
      onOpenChange={(nextOpen) => {
        if (typeof window === "undefined" || window.innerWidth >= 768) {
          setDesktopOpen(nextOpen);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="date-range-pill"
          ref={mobileTriggerRef}
          onClick={handleTriggerClick}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-white pl-3 pr-2.5 py-1.5 text-[12.5px] font-medium text-foreground/85 hover:border-brand/40 hover:bg-brand-soft/30 transition-colors shadow-sm"
        >
          <CalendarBlank size={14} weight="bold" className="text-brand-deep" />
          <span className="max-w-[180px] truncate">{activeLabel}</span>
          <CaretDown size={12} weight="bold" className="text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="p-0 w-[640px] max-w-[95vw] border border-border bg-white rounded-xl shadow-2xl overflow-hidden"
        data-testid="date-range-panel"
      >
        <div className="flex flex-col sm:flex-row">
          {/* Desktop preset list remains in the two-pane popover. The mobile
              list is rendered inline below the trigger instead. */}
          <div className="hidden sm:block sm:w-[200px] sm:border-r border-border bg-[#fffaf3] py-2 overflow-y-auto sm:max-h-none">
            {PRESET_GROUPS.map((group, gi) => (
              <div key={gi} className="py-1">
                {group.label && (
                  <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
                    {group.label}
                  </div>
                )}
                {group.items.map(([k, lbl]) => (
                  <button
                    key={k}
                    type="button"
                    data-testid={`preset-${k}`}
                    onClick={() => choosePreset(k)}
                    className={`w-full text-left px-3 py-1.5 text-[12.5px] transition-colors ${
                      f.preset === k
                        ? "bg-brand text-white font-semibold"
                        : "text-foreground/80 hover:bg-brand-soft/60"
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            ))}
            <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              Custom
            </div>
            <button
              type="button"
              data-testid="preset-custom"
              onClick={() => choosePreset("custom")}
              className={`w-full text-left px-3 py-1.5 text-[12.5px] transition-colors ${
                f.preset === "custom"
                  ? "bg-brand text-white font-semibold"
                  : "text-foreground/80 hover:bg-brand-soft/60"
              }`}
            >
              Custom range
            </button>
          </div>
          {/* Right calendar panel */}
          <div className="flex-1 p-3 sm:p-4">
            {/* WS8 T809 — the free-range from/to inputs were removed: they
                duplicated the calendar below (two ways to set the same range).
                Presets + calendar are now the single date control. */}
            <Calendar
              mode="range"
              numberOfMonths={2}
              selected={draftRange}
              defaultMonth={lastMonth}
              onSelect={(r) => {
                setDraftRange(r);
                if (r?.from) setDraftFromInput(isoOf(r.from));
                if (r?.to) setDraftToInput(isoOf(r.to));
              }}
              disabled={{ after: today }}
              className="p-0"
            />
            {/* Footer */}
            <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-border">
              <button
                type="button"
                data-testid="date-range-cancel"
                onClick={() => setDesktopOpen(false)}
                className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-foreground/70 hover:bg-panel"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="date-range-apply"
                onClick={apply}
                className="px-4 py-1.5 rounded-lg text-[12.5px] font-semibold bg-brand text-white hover:bg-brand-deep transition-colors"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      </PopoverContent>
      {/* Mobile chooser: inline inside the parent Filters sheet. It is
          intentionally not a PopoverContent/Portal, so the sheet owns the
          complete touch scroll from presets through the calendar footer. */}
      {mobileOpen && (
        <div
          className="md:hidden mt-2 rounded-xl border border-border bg-white shadow-sm"
          data-testid="date-range-mobile-panel"
        >
          <div className="border-b border-border bg-[#fffaf3] p-2.5">
            {PRESET_GROUPS.map((group, gi) => (
              <div key={gi} className="mb-2.5 last:mb-0">
                {group.label && (
                  <div className="px-1 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
                    {group.label}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-1.5">
                  {group.items.map(([k, lbl]) => (
                    <button
                      key={k}
                      type="button"
                      data-testid={`preset-${k}-mobile`}
                      onClick={() => choosePreset(k)}
                      className={`min-h-10 min-w-0 rounded-lg border px-2.5 py-2 text-left text-[12.5px] transition-colors ${
                        f.preset === k
                          ? "border-brand bg-brand text-white font-semibold"
                          : "border-border bg-white text-foreground/80 hover:border-brand/40"
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="px-1 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              Custom
            </div>
            <button
              type="button"
              data-testid="preset-custom-mobile"
              onClick={() => choosePreset("custom")}
              className={`min-h-10 w-full rounded-lg border px-2.5 py-2 text-left text-[12.5px] transition-colors ${
                f.preset === "custom"
                  ? "border-brand bg-brand text-white font-semibold"
                  : "border-border bg-white text-foreground/80 hover:border-brand/40"
              }`}
            >
              Custom range
            </button>
          </div>
          <div className="p-3">
            <Calendar
              mode="range"
              numberOfMonths={1}
              selected={draftRange}
              defaultMonth={lastMonth}
              onSelect={(r) => {
                setDraftRange(r);
                if (r?.from) setDraftFromInput(isoOf(r.from));
                if (r?.to) setDraftToInput(isoOf(r.to));
              }}
              disabled={{ after: today }}
              className="p-0"
            />
            <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-border">
              <button
                type="button"
                data-testid="date-range-cancel-mobile"
                onClick={closeMobile}
                className="min-h-10 px-3 rounded-lg text-[12.5px] font-medium text-foreground/70 hover:bg-panel"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="date-range-apply-mobile"
                onClick={apply}
                className="min-h-10 px-4 rounded-lg text-[12.5px] font-semibold bg-brand text-white hover:bg-brand-deep transition-colors"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </Popover>
  );
};

const isoOf = (d) => {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// ---------- Comparison Period Button ----------
const COMPARE_OPTIONS = [
  ["none", "No comparison"],
  ["prior_period", "Previous period"],
  ["yesterday", "Yesterday"],
  ["last_month", "Previous month"],
  ["last_year", "Previous year"],
  ["last_year_dow", "Previous year (match day of week)"],
  ["custom", "Custom"],
];

const CompareButton = () => {
  const f = useFilters();
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(f.compareDateFrom || "");
  const [draftTo, setDraftTo] = useState(f.compareDateTo || "");

  useEffect(() => {
    if (open) {
      setDraftFrom(f.compareDateFrom || "");
      setDraftTo(f.compareDateTo || "");
    }
  }, [open, f.compareDateFrom, f.compareDateTo]);

  const activeLabel =
    COMPARE_OPTIONS.find(([k]) => k === f.compareMode)?.[1] || "No comparison";

  const choose = (k) => {
    if (k === "custom") {
      f.setCompareMode("custom");
      // Don't close — let user pick dates
      return;
    }
    f.setCompareMode(k);
    setOpen(false);
  };

  const applyCustom = () => {
    if (draftFrom && draftTo) {
      f.setCompareDateFrom(draftFrom);
      f.setCompareDateTo(draftTo);
      f.setCompareMode("custom");
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="compare-pill"
          className="inline-flex items-center gap-2 rounded-full border border-border bg-white pl-3 pr-2.5 py-1.5 text-[12.5px] font-medium text-foreground/85 hover:border-brand/40 hover:bg-brand-soft/30 transition-colors shadow-sm"
        >
          <CalendarBlank size={14} weight="bold" className="text-brand-deep" />
          <span className="max-w-[200px] truncate">{activeLabel}</span>
          <CaretDown size={12} weight="bold" className="text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="p-1.5 w-[280px] border border-border bg-white rounded-xl shadow-2xl"
        data-testid="compare-panel"
      >
        {COMPARE_OPTIONS.map(([k, lbl]) => (
          <button
            key={k}
            type="button"
            data-testid={`compare-option-${k}`}
            onClick={() => choose(k)}
            className={`w-full text-left px-3 py-2 rounded-md text-[12.5px] transition-colors ${
              f.compareMode === k
                ? "bg-brand text-white font-semibold"
                : "text-foreground/80 hover:bg-brand-soft/60"
            }`}
          >
            {lbl}
          </button>
        ))}
        {f.compareMode === "custom" && (
          <div className="border-t border-border mt-1.5 pt-2 px-2 pb-1 space-y-2">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              Compare against
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={draftFrom}
                onChange={(e) => setDraftFrom(e.target.value)}
                data-testid="compare-custom-from"
                className="flex-1 min-w-0 px-2 py-1 rounded-md border border-border text-[12px] outline-none focus:border-brand"
              />
              <span className="text-muted">→</span>
              <input
                type="date"
                value={draftTo}
                onChange={(e) => setDraftTo(e.target.value)}
                data-testid="compare-custom-to"
                className="flex-1 min-w-0 px-2 py-1 rounded-md border border-border text-[12px] outline-none focus:border-brand"
              />
            </div>
            <button
              type="button"
              data-testid="compare-custom-apply"
              onClick={applyCustom}
              disabled={!draftFrom || !draftTo}
              className="w-full px-3 py-1.5 rounded-md text-[12px] font-semibold bg-brand text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-brand-deep transition-colors"
            >
              Apply custom range
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

// ---------- Channel Group segmented control (All / Retail / Online) ----------
const CHANNEL_GROUP_OPTIONS = [
  ["all", "All"],
  ["retail", "Retail"],
  ["online", "Online"],
];

const ChannelGroupToggle = () => {
  const f = useFilters();
  return (
    <div
      className="inline-flex items-center rounded-full border border-border bg-white p-0.5 shadow-sm"
      data-testid="channel-group-toggle"
      role="group"
      aria-label="Channel segment"
    >
      {CHANNEL_GROUP_OPTIONS.map(([k, lbl]) => {
        const active = f.channelGroup === k;
        return (
          <button
            key={k}
            type="button"
            data-testid={`channel-group-${k}`}
            onClick={() => f.setChannelGroup(k)}
            className={`px-3 py-1 rounded-full text-[12px] font-semibold transition-colors ${
              active
                ? "bg-brand text-white shadow-sm"
                : "text-foreground/70 hover:bg-brand-soft/60"
            }`}
            aria-pressed={active}
          >
            {lbl}
          </button>
        );
      })}
    </div>
  );
};

// ---------- Currency Selector (cosmetic only — locked to KES for now) ----------
const CurrencyButton = () => {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="currency-pill"
            disabled
            className="inline-flex items-center gap-2 rounded-full border border-border bg-white pl-3 pr-2.5 py-1.5 text-[12.5px] font-semibold text-foreground/85 opacity-90 cursor-not-allowed shadow-sm"
          >
            <ArrowsLeftRight size={14} weight="bold" className="text-brand-deep" />
            <span>KES</span>
            <CaretDown size={12} weight="bold" className="text-muted" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          Multi-currency coming soon — KES locked for now
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

// ---------- Mobile filters trigger (collapses everything into a sheet) ----------
const MobileFiltersSheet = ({ children }) => {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          data-testid="mobile-filters-button"
          className="inline-flex items-center gap-2 rounded-full border border-border bg-white px-3 py-1.5 text-[12.5px] font-medium text-foreground/85 hover:border-brand/40 transition-colors shadow-sm"
        >
          <CalendarBlank size={14} weight="bold" className="text-brand-deep" />
          Filters
          <CaretDown size={12} weight="bold" className="text-muted" />
        </button>
      </SheetTrigger>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl pt-4 max-h-[85vh] overflow-y-auto"
        data-testid="mobile-filters-sheet"
      >
        <MobileFiltersOpenContext.Provider value={open}>
          <SheetTitle className="text-[15px] font-bold mb-3">Filters</SheetTitle>
          <div className="space-y-3 pb-4">{children}</div>
        </MobileFiltersOpenContext.Provider>
      </SheetContent>
    </Sheet>
  );
};

// ---------- Main FilterBar ----------
const BackButton = ({ className = "" }) => {
  const navigate = useNavigate();
  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  };
  return (
    <button
      type="button"
      onClick={goBack}
      data-testid="back-button"
      title="Go back"
      aria-label="Go back"
      className={`shrink-0 inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1.5 text-[12px] font-semibold text-foreground/80 hover:border-brand/40 hover:bg-brand-soft/50 transition-colors shadow-sm ${className}`}
    >
      <ArrowLeft size={14} weight="bold" className="text-brand-deep" />
      <span>Back</span>
    </button>
  );
};

// ---------- Compact "data last updated" pill ----------
const fmtRelFresh = (secs) => {
  if (secs == null || isNaN(secs)) return null;
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return "just now";
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

const fmtAbsFresh = (iso) => {
  if (!iso) return "—";
  // `last_updated` is a naive server-time timestamp; show its calendar parts
  // verbatim (no browser-timezone reinterpretation).
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return String(iso);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${m[3]} ${months[Number(m[2]) - 1]}, ${m[4]}:${m[5]}`;
};

const DataUpdatedPill = ({ className = "" }) => {
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    api
      .get("/data-freshness")
      .then((r) => { if (alive) setData(r.data); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const rel = fmtRelFresh(data?.seconds_since_update);
  if (!rel) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="data-updated-pill"
            className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-white/70 px-2.5 py-1 text-[11.5px] font-medium text-foreground/70 shadow-sm cursor-default ${className}`}
          >
            <ClockCounterClockwise size={13} weight="bold" className="text-brand-deep" />
            <span className="whitespace-nowrap">Updated {rel}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-[11px] leading-relaxed">
            <div>Last data load: {fmtAbsFresh(data?.last_updated)}</div>
            {data?.last_sale_date && <div>Last sale date: {data.last_sale_date}</div>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const FilterBar = () => {
  const f = useFilters();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [locations, setLocations] = useState([]);
  const [styleTypeOptions, setStyleTypeOptions] = useState([]);
  const [shareCopied, setShareCopied] = useState(false);
  const storeDefaultRef = React.useRef(false);
  const isStoreDetail = location.pathname === "/merchandising" && searchParams.get("tab") === "merch-store";
  const showStyleTypeFilter = !isStoreDetail &&
    ["/production", "/product-analysis", "/merchandising"].includes(location.pathname);

  // The provider's global default is Today vs Previous month, which is not a
  // fair Store Detail comparison because Today is only a partial day. Scope
  // the correction to this tab: Month to date vs the matching prior-month
  // window. A manually chosen Today uses the DateRangeButton pairing above.
  useEffect(() => {
    if (!isStoreDetail) {
      storeDefaultRef.current = false;
      return;
    }
    if (storeDefaultRef.current) return;
    storeDefaultRef.current = true;
    if (f.preset === "today" && f.compareMode === "last_month") {
      f.setPreset("mtd");
    }
  }, [isStoreDetail, f.preset, f.compareMode, f.setPreset]);

  const handleShare = async () => {
    const url = f.buildShareableLink?.() || window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1600);
    } catch {
      window.prompt("Copy this link:", url);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const mergeLocations = (incoming) => {
      if (cancelled || !incoming?.length) return;
      setLocations((current) => {
        const merged = new Map(current.map((row) => [row.channel, row]));
        incoming.forEach((row) => {
          if (row?.channel) merged.set(row.channel, row);
        });
        return Array.from(merged.values());
      });
    };

    // Populate the selector from the small store metadata table first. The
    // analytics-backed active-POS request can be delayed when sales queries are
    // busy, but that must never leave the global POS control unusable.
    api
      .get("/locations")
      .then((r) => mergeLocations(
        (r.data || [])
          .filter((row) => row.active !== false && row.store_type === "store")
          .map((row) => ({ channel: row.location_name, country: row.country }))
      ))
      .catch(() => {});

    // Enrich/confirm the list from recent trading activity when available.
    api
      .get("/analytics/active-pos")
      .then((r) => mergeLocations(r.data || []))
      .catch(() => {});

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!showStyleTypeFilter) return;
    api
      .get("/style-tracker/board")
      .then((r) => setStyleTypeOptions(r.data?.order_types || []))
      .catch(() => setStyleTypeOptions([]));
  }, [showStyleTypeFilter]);

  const channelOptions = useMemo(() => {
    const ONLINE_CHANNELS = [
      { channel: "Online - Shop Zetu", country: "Online" },
      { channel: "Online - Vivo", country: "Online" },
    ];
    const merged = [...locations];
    for (const oc of ONLINE_CHANNELS) {
      if (!merged.some((l) => l.channel === oc.channel)) merged.push(oc);
    }
    let filtered =
      f.countries.length === 0
        ? merged
        : merged.filter((l) => f.countries.includes(l.country));
    if (f.clusters.length > 0) {
      const pool = new Set(clusterStores(f.clusters));
      filtered = filtered.filter((l) => pool.has(l.channel));
    }
    return filtered.map((l) => ({
      value: l.channel,
      label: l.channel,
      group: l.country,
    }));
  }, [locations, f.countries, f.clusters]);

  const countryOptions = COUNTRIES.map((c) => ({ value: c, label: c }));
  const clusterOptions = Object.entries(CLUSTERS).map(([id, c]) => ({
    value: id,
    label: c.leader ? `${c.label} — ${c.leader}` : c.label,
  }));

  // Store Detail only consumes the date window and comparison range here.
  // Brand/category remain available in the Merchandising Hub scope strip and
  // the store itself is selected inside the page, so the other global controls
  // would be misleading on this tab.
  const ControlsInline = isStoreDetail ? (
    <>
      <DateRangeButton autoPairToday={isStoreDetail} />
      <CompareButton />
    </>
  ) : (
    <>
      <DateRangeButton />
      <CompareButton />
      <CurrencyButton />
      <MultiSelect
        testId="filter-countries"
        label="Country"
        icon={Globe}
        options={countryOptions}
        value={f.countries}
        onChange={(v) => {
          f.setCountries(v);
          f.setChannels([]);
        }}
        placeholder="All countries"
        width={210}
      />
      <MultiSelect
        testId="filter-clusters"
        label="Cluster"
        icon={Storefront}
        options={clusterOptions}
        value={f.clusters}
        onChange={(v) => {
          f.setClusters(v);
          f.setChannels([]);
        }}
        placeholder="All clusters"
        width={250}
      />
      {showStyleTypeFilter && (
        <MultiSelect
          testId="filter-style-types"
          label="Type"
          options={styleTypeOptions.map((type) => ({ value: type, label: type }))}
          value={f.styleTypes || []}
          onChange={f.setStyleTypes}
          placeholder="All types"
          width={180}
        />
      )}
      {/* WS8 T809 — the All/Retail/Online segment and the POS picker are ONE
          merged control: the segment scopes the channel population, the
          multiselect picks stores within it. */}
      <div
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white/70 pl-1 pr-1 py-0.5"
        data-testid="pos-filter-group"
      >
        <ChannelGroupToggle />
        <MultiSelect
          testId="filter-channels"
          label="POS"
          icon={Storefront}
          options={channelOptions}
          value={f.channels}
          onChange={f.setChannels}
          placeholder="All POS"
          width={220}
        />
      </div>
    </>
  );

  const mobileSummary = useMemo(() => {
    const labels = [];
    const presets = datePresets();
    const dateLabel = f.preset && f.preset !== "custom" && presets[f.preset]
      ? presets[f.preset].label
      : f.dateFrom && f.dateTo
        ? `${fmtDate(f.dateFrom)} – ${fmtDate(f.dateTo)}`
        : "Date";
    labels.push(dateLabel);
    if (f.compareMode && f.compareMode !== "none") {
      const compareLabel = {
        prior_period: "Previous period",
        yesterday: "Yesterday",
        last_month: "Previous month",
        last_year: "Previous year",
        last_year_dow: "Previous year (day matched)",
        custom: "Custom comparison",
      }[f.compareMode] || "Comparison";
      labels.push(`Compare: ${compareLabel}`);
    }
    if (!isStoreDetail) {
      if (f.countries.length) labels.push(f.countries.join(", "));
      if (f.clusters.length) labels.push(`${f.clusters.length} cluster${f.clusters.length === 1 ? "" : "s"}`);
      if (f.styleTypes?.length) labels.push(f.styleTypes.join(", "));
      if (f.channelGroup && f.channelGroup !== "all") labels.push(f.channelGroup === "retail" ? "Retail" : "Online");
      if (f.channels.length) labels.push(`${f.channels.length} POS`);
    }
    return labels;
  }, [
    f.preset, f.dateFrom, f.dateTo, f.compareMode, f.countries, f.clusters,
    f.styleTypes, f.channelGroup, f.channels, isStoreDetail,
  ]);

  return (
    <div
      className="bg-[#fed7aa] border-b border-border px-3 sm:px-5 lg:px-10 py-2 sm:py-3 no-print"
      data-testid="filter-bar"
    >
      {/* Desktop layout */}
      <div className="hidden md:flex md:flex-wrap md:items-center md:gap-2">
        <BackButton />
        {ControlsInline}
        <div className="ml-auto flex items-center gap-2">
          <DataUpdatedPill />
          <button
            type="button"
            onClick={handleShare}
            data-testid="share-filter-link"
            title="Copy a shareable link to this filtered view."
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold transition-all ${
              shareCopied
                ? "bg-[#059669] text-white border border-[#059669]"
                : "bg-white text-foreground/80 border border-border hover:border-brand/40 hover:bg-brand-soft/50"
            }`}
          >
            {shareCopied ? (
              <>
                <Check size={13} weight="bold" /> Copied
              </>
            ) : (
              <>
                <ShareNetwork size={13} weight="bold" /> Share view
              </>
            )}
          </button>
        </div>
      </div>

      {/* Mobile layout — one persistent summary row; the full control set lives
          in a bottom sheet so it never pushes the page content below the fold. */}
      <div className="flex md:hidden items-center gap-2 min-w-0">
        <BackButton />
        <div className="flex-1 min-w-0 overflow-x-auto">
          <div className="inline-flex items-center gap-1.5 whitespace-nowrap">
            {mobileSummary.map((label, i) => (
              <span
                key={`${label}-${i}`}
                className="inline-flex items-center rounded-full border border-border bg-white/70 px-2.5 py-1 text-[11px] text-foreground/75"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
        <MobileFiltersSheet>
          <div className="grid grid-cols-1 gap-3">
            {ControlsInline}
          </div>
        </MobileFiltersSheet>
        <div className="hidden sm:block shrink-0">
          <DataUpdatedPill />
        </div>
        <button
          type="button"
          onClick={handleShare}
          data-testid="share-filter-link-mobile"
          className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11.5px] font-semibold transition-all ${
            shareCopied
              ? "bg-[#059669] text-white border border-[#059669]"
              : "bg-white text-foreground/80 border border-border"
          }`}
        >
          {shareCopied ? (
            <>
              <Check size={12} weight="bold" /> Copied
            </>
          ) : (
            <>
              <ShareNetwork size={12} weight="bold" /> Share
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default FilterBar;
