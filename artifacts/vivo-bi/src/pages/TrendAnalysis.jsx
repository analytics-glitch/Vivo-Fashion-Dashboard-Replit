import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useFilters } from "@/lib/filters";
import { api, fmtDate } from "@/lib/api";
import TrendPanel from "@/components/TrendPanel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { TrendUp, Plus, CalendarBlank, CaretDown } from "@phosphor-icons/react";

/**
 * Trend Analysis — a self-serve cockpit for watching any KPI's shape over time.
 *
 * Each "panel" is an independent mini-dashboard: pick the KPI, the granularity
 * (Year / Month / Week) and the scope (Overall or one store) WITHOUT affecting
 * the other panels, and ask the AI to describe what the trend shows. Add or
 * remove panels to compare KPIs side by side (e.g. Revenue monthly vs
 * Conversion weekly vs Footfall yearly).
 *
 * Unlike the rest of the dashboard, the date range here is PAGE-LOCAL (its own
 * calendar + month presets), independent of the global filter bar — trends read
 * best over a long, deliberately-chosen window. It defaults to the last 12
 * months at monthly granularity. Country is still inherited from the global bar.
 */

const pad = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// `n` calendar months before today (clamped so e.g. Mar 31 → Feb doesn't overflow).
const monthsAgo = (n) => {
  const t = new Date();
  const d = new Date(t.getFullYear(), t.getMonth() - n, t.getDate());
  // If the day overflowed (e.g. 31 → next month), pull back to month end.
  if (d.getDate() !== t.getDate()) d.setDate(0);
  return d;
};
const isoOf = (d) => (d ? toISO(d) : "");

const MONTH_PRESETS = [
  { months: 3, label: "Last 3 months" },
  { months: 6, label: "Last 6 months" },
  { months: 12, label: "Last 12 months" },
  { months: 24, label: "Last 24 months" },
];

let _seq = 0;
const newPanel = (kpi, bucket) => ({ id: ++_seq, kpi, bucket });

const DEFAULT_PANELS = [
  newPanel("total_sales", "month"),
  newPanel("conversion_rate", "month"),
  newPanel("units_sold", "month"),
  newPanel("avg_basket_size", "month"),
];

/**
 * TrendDateFilter — page-local date control. Month presets on the left, a
 * dual-month range calendar on the right; "Apply" commits the draft range.
 */
const TrendDateFilter = ({ dateFrom, dateTo, presetMonths, onChange }) => {
  const [open, setOpen] = useState(false);
  const [draftRange, setDraftRange] = useState({
    from: dateFrom ? new Date(dateFrom + "T00:00:00") : undefined,
    to: dateTo ? new Date(dateTo + "T00:00:00") : undefined,
  });

  useEffect(() => {
    setDraftRange({
      from: dateFrom ? new Date(dateFrom + "T00:00:00") : undefined,
      to: dateTo ? new Date(dateTo + "T00:00:00") : undefined,
    });
  }, [dateFrom, dateTo, open]);

  const today = new Date();

  const activeLabel = useMemo(() => {
    const hit = MONTH_PRESETS.find((p) => p.months === presetMonths);
    if (hit) return hit.label;
    if (dateFrom && dateTo) return `${fmtDate(dateFrom)} – ${fmtDate(dateTo)}`;
    return "Pick a range";
  }, [presetMonths, dateFrom, dateTo]);

  const choosePreset = (months) => {
    onChange({ from: toISO(monthsAgo(months)), to: toISO(today), presetMonths: months });
    setOpen(false);
  };

  const apply = () => {
    if (draftRange?.from) {
      onChange({
        from: isoOf(draftRange.from),
        to: isoOf(draftRange.to || draftRange.from),
        presetMonths: null,
      });
    }
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="trend-date-pill"
          className="inline-flex items-center gap-2 rounded-full border border-border bg-white pl-3 pr-2.5 py-1.5 text-[12.5px] font-medium text-foreground/85 hover:border-brand/40 hover:bg-brand-soft/30 transition-colors shadow-sm"
        >
          <CalendarBlank size={14} weight="bold" className="text-brand-deep" />
          <span className="max-w-[200px] truncate">{activeLabel}</span>
          <CaretDown size={12} weight="bold" className="text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="p-0 w-[640px] max-w-[95vw] border border-border bg-white rounded-xl shadow-2xl overflow-hidden"
        data-testid="trend-date-panel"
      >
        <div className="flex flex-col sm:flex-row max-h-[85vh] overflow-y-auto sm:overflow-visible">
          {/* Mobile: horizontal preset chips */}
          <div className="sm:hidden border-b border-border bg-[#fffaf3] px-2 py-2 overflow-x-auto">
            <div className="flex gap-1.5 whitespace-nowrap">
              {MONTH_PRESETS.map((p) => (
                <button
                  key={p.months}
                  type="button"
                  data-testid={`trend-preset-${p.months}m-mobile`}
                  onClick={() => choosePreset(p.months)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                    presetMonths === p.months
                      ? "bg-brand text-white"
                      : "bg-white text-foreground/80 border border-border hover:border-brand/40"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {/* Desktop preset list */}
          <div className="hidden sm:block sm:w-[200px] sm:border-r border-border bg-[#fffaf3] py-2 overflow-y-auto sm:max-h-none">
            <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              Presets
            </div>
            {MONTH_PRESETS.map((p) => (
              <button
                key={p.months}
                type="button"
                data-testid={`trend-preset-${p.months}m`}
                onClick={() => choosePreset(p.months)}
                className={`w-full text-left px-3 py-1.5 text-[12.5px] transition-colors ${
                  presetMonths === p.months
                    ? "bg-brand text-white font-semibold"
                    : "text-foreground/80 hover:bg-brand-soft/60"
                }`}
              >
                {p.label}
              </button>
            ))}
            <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">
              Custom
            </div>
            <div className="px-3 py-1 text-[11.5px] text-muted">
              Pick a range on the calendar →
            </div>
          </div>
          {/* Calendar panel */}
          <div className="flex-1 p-3 sm:p-4">
            <Calendar
              mode="range"
              numberOfMonths={typeof window !== "undefined" && window.innerWidth >= 640 ? 2 : 1}
              selected={draftRange}
              defaultMonth={draftRange?.from || monthsAgo(1)}
              onSelect={(r) => setDraftRange(r || {})}
              disabled={{ after: today }}
              className="p-0"
            />
            <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-border">
              <button
                type="button"
                data-testid="trend-date-cancel"
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-foreground/70 hover:bg-panel"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="trend-date-apply"
                onClick={apply}
                className="px-4 py-1.5 rounded-lg text-[12.5px] font-semibold bg-brand text-white hover:bg-brand-deep transition-colors"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

const TrendAnalysis = () => {
  const { applied } = useFilters();
  // Country + data version still come from the global bar; the date range does NOT.
  const { countries, dataVersion } = applied;

  // Page-local date range — defaults to the last 12 months.
  const [dateFrom, setDateFrom] = useState(() => toISO(monthsAgo(12)));
  const [dateTo, setDateTo] = useState(() => toISO(new Date()));
  const [presetMonths, setPresetMonths] = useState(12);

  const onDateChange = useCallback(({ from, to, presetMonths: pm }) => {
    setDateFrom(from);
    setDateTo(to);
    setPresetMonths(pm ?? null);
  }, []);

  const [panels, setPanels] = useState(DEFAULT_PANELS);
  const [stores, setStores] = useState([]);

  // Master store list (active POS) so each panel can scope to a single store.
  useEffect(() => {
    let cancelled = false;
    api
      .get("/analytics/active-pos", { params: { n_days: 365 } })
      .then((r) => {
        if (cancelled) return;
        const names = Array.from(
          new Set((r.data || []).map((s) => s.channel).filter(Boolean))
        ).sort((a, b) => a.localeCompare(b));
        setStores(names);
      })
      .catch(() => { if (!cancelled) setStores([]); });
    return () => { cancelled = true; };
  }, []);

  const addPanel = useCallback(() => {
    setPanels((p) => [...p, newPanel("total_sales", "month")]);
  }, []);

  const removePanel = useCallback((id) => {
    setPanels((p) => p.filter((x) => x.id !== id));
  }, []);

  const countryLabel = countries && countries.length ? countries.join(", ") : "All markets";

  return (
    <div className="space-y-6" data-testid="trend-analysis-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[18px] font-bold text-foreground">
            <TrendUp size={20} weight="duotone" className="text-[#1a5c38]" />
            Trend Analysis
          </h1>
          <p className="text-[12.5px] text-muted mt-1 max-w-2xl">
            Track any KPI over time — revenue, net sales, units, transactions, footfall,
            conversion, basket value or selling price. Each panel sets its own granularity
            and store scope independently, so you can compare different KPIs side by side.
            This page has its own date range (defaulting to the last 12 months); the market
            comes from the filter bar above.
          </p>
          <div className="text-[11.5px] text-muted mt-1">
            <span className="num">{fmtDate(dateFrom)} – {fmtDate(dateTo)}</span>
            <span className="mx-1.5">·</span>
            <span>{countryLabel}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TrendDateFilter
            dateFrom={dateFrom}
            dateTo={dateTo}
            presetMonths={presetMonths}
            onChange={onDateChange}
          />
          <button
            type="button"
            onClick={addPanel}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#1a5c38] text-white text-[12.5px] font-semibold px-3.5 py-2 hover:bg-[#0f3d24] transition-colors"
            data-testid="trend-add-panel"
          >
            <Plus size={14} weight="bold" /> Add KPI panel
          </button>
        </div>
      </div>

      {panels.length === 0 ? (
        <div className="card-white p-12 text-center text-[13px] text-muted">
          No panels. Click <span className="font-semibold text-foreground">Add KPI panel</span> to start a trend.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {panels.map((p) => (
            <TrendPanel
              key={p.id}
              dateFrom={dateFrom}
              dateTo={dateTo}
              countries={countries}
              dataVersion={dataVersion}
              stores={stores}
              initialKpi={p.kpi}
              initialBucket={p.bucket}
              removable={panels.length > 1}
              onRemove={() => removePanel(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default TrendAnalysis;
