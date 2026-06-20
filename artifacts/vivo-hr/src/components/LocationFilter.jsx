import React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Label } from "./ui/label";

export const LOCATIONS = ["HQ", "Shopzetu", "Stores"];

export default function LocationFilter({ value, onChange, label = "Location", testId = "filter-location", className = "" }) {
  return (
    <div className={className}>
      {label && (
        <Label className="text-[10px] font-bold uppercase tracking-wider text-brand-deep">{label}</Label>
      )}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger data-testid={testId} className="h-9 rounded-full border-border bg-panel/40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All locations</SelectItem>
          {LOCATIONS.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
