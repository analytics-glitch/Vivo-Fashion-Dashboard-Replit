import React, { createContext, useContext, useMemo, useState } from "react";

import { DateRange, PresetKey, presetRange } from "@/lib/api";

interface FiltersValue {
  preset: PresetKey;
  setPreset: (p: PresetKey) => void;
  range: DateRange;
}

const FiltersContext = createContext<FiltersValue | null>(null);

export function FiltersProvider({ children }: { children: React.ReactNode }) {
  const [preset, setPreset] = useState<PresetKey>("90d");

  const range = useMemo(() => presetRange(preset), [preset]);

  const value = useMemo<FiltersValue>(
    () => ({ preset, setPreset, range }),
    [preset, range],
  );
  return (
    <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>
  );
}

export function useFilters(): FiltersValue {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error("useFilters must be used inside FiltersProvider");
  return ctx;
}
