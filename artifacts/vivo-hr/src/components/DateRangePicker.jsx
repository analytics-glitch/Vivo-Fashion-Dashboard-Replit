import React, { useEffect, useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Calendar } from "./ui/calendar";
import { PRESETS, matchPreset, parseISO, toISO, yesterday } from "../lib/dates";
import { CalendarIcon } from "lucide-react";

const fmt = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
};

export default function DateRangePicker({ value, onChange, testId = "date-range", className = "" }) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(value?.from || yesterday());
  const [draftTo, setDraftTo] = useState(value?.to || yesterday());

  useEffect(() => {
    if (open) {
      setDraftFrom(value?.from || yesterday());
      setDraftTo(value?.to || yesterday());
    }
  }, [open, value]);

  const matched = useMemo(() => matchPreset(value?.from, value?.to), [value]);
  const triggerLabel = matched
    ? matched.label
    : value?.from && value?.to
      ? value.from === value.to ? fmt(value.from) : `${fmt(value.from)} → ${fmt(value.to)}`
      : "Select dates";

  const applyPreset = (p) => {
    const [f, t] = p.range();
    setDraftFrom(f);
    setDraftTo(t);
  };

  const apply = () => {
    let f = draftFrom, t = draftTo;
    // Single-day selection: only one end picked → use it for both.
    if (f && !t) t = f;
    if (t && !f) f = t;
    if (f && t && f > t) [f, t] = [t, f];
    onChange?.({ from: f, to: t });
    setOpen(false);
  };

  const selected = useMemo(() => {
    const from = parseISO(draftFrom);
    const to = parseISO(draftTo);
    return from && to ? { from, to } : from ? { from } : undefined;
  }, [draftFrom, draftTo]);

  const grouped = useMemo(() => ({
    quick: PRESETS.filter((p) => p.group === "quick"),
    last:  PRESETS.filter((p) => p.group === "last"),
    period: PRESETS.filter((p) => p.group === "period"),
  }), []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          data-testid={`${testId}-trigger`}
          className={`h-9 rounded-full border-border bg-panel/40 hover:bg-panel/60 font-semibold justify-start ${className}`}
        >
          <CalendarIcon className="h-3.5 w-3.5 mr-2 text-brand" />
          <span className="truncate">{triggerLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto p-0 overflow-hidden rounded-2xl border-border shadow-xl"
        data-testid={`${testId}-content`}
      >
        <div className="flex">
          {/* Preset sidebar */}
          <div className="w-[170px] border-r border-border bg-panel/40 py-3 overflow-y-auto max-h-[480px]">
            {grouped.quick.map((p) => (
              <PresetButton key={p.key} p={p} active={matched?.key === p.key} onClick={applyPreset} />
            ))}
            <SectionLabel>Last</SectionLabel>
            {grouped.last.map((p) => (
              <PresetButton key={p.key} p={p} active={matched?.key === p.key} onClick={applyPreset} />
            ))}
            <SectionLabel>Period to date</SectionLabel>
            {grouped.period.map((p) => (
              <PresetButton key={p.key} p={p} active={matched?.key === p.key} onClick={applyPreset} />
            ))}
            <SectionLabel>Custom</SectionLabel>
            <div className="px-3 py-1 text-[12px] text-muted-foreground">Pick dates on right →</div>
          </div>

          {/* Right pane */}
          <div className="p-4 min-w-[600px] bg-card">
            <div className="flex items-center gap-2 mb-4">
              <Input
                type="date"
                value={draftFrom}
                onChange={(e) => setDraftFrom(e.target.value)}
                className="h-9 rounded-lg border-border"
                data-testid={`${testId}-from`}
              />
              <span className="text-muted-foreground">→</span>
              <Input
                type="date"
                value={draftTo}
                onChange={(e) => setDraftTo(e.target.value)}
                className="h-9 rounded-lg border-border"
                data-testid={`${testId}-to`}
              />
            </div>

            <Calendar
              mode="range"
              numberOfMonths={2}
              selected={selected}
              onSelect={(r) => {
                if (!r) { setDraftFrom(""); setDraftTo(""); return; }
                // Mirror exactly what react-day-picker computes for the range.
                // Use local-time formatting (toISO) — toISOString() would shift
                // the date back a day in UTC+3. Leave `to` empty after the first
                // click so the second click can extend into a real range.
                setDraftFrom(toISO(r.from));
                setDraftTo(toISO(r.to));
              }}
              defaultMonth={selected?.from || new Date()}
            />

            <div className="mt-3 flex items-center justify-end gap-2 border-t border-border pt-3">
              <Button variant="ghost" onClick={() => setOpen(false)} className="rounded-full h-9 text-[11px] font-bold uppercase tracking-wider">Cancel</Button>
              <Button onClick={apply} className="rounded-full h-9 bg-brand hover:bg-brand-deep text-background text-[11px] font-bold uppercase tracking-wider" data-testid={`${testId}-apply`}>Apply</Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PresetButton({ p, active, onClick }) {
  return (
    <button
      type="button"
      data-testid={`preset-${p.key}`}
      onClick={() => onClick(p)}
      className={`w-full text-left px-4 py-2 text-[13px] transition-colors ${
        active
          ? "bg-brand text-background font-semibold"
          : "text-foreground/80 hover:bg-white/60 hover:text-brand-deep"
      }`}
    >
      {p.label}
    </button>
  );
}

function SectionLabel({ children }) {
  return <div className="mt-2 px-4 py-1 text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{children}</div>;
}
