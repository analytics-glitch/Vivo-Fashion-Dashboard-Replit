import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  Card,
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  MagnitudeBar,
  PresetPills,
  SectionHeader,
} from "@/components/ui";
import { Badge, BadgeTone, KpiGrid, Screen } from "@/components/screen";
import { useColors } from "@/hooks/useColors";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useFilters } from "@/lib/filters";
import { fmtNum, fmtPct } from "@/lib/format";

// /analytics/size-curve — size-run health by style. A "broken" curve = catalogued
// sizes that are out of stock across selling locations (warehouses excluded).
// Best-sellers with broken curves surface first so lost-sales risk is actionable.
interface SizeCurveRow {
  style_name: string | null;
  brand: string | null;
  category: string | null;
  product_type: string | null;
  units_sold: number;
  total_sizes: number;
  sizes_in_stock: number;
  broken_sizes: number;
  health_pct: number | null;
  ibt_opportunity: boolean;
  missing_sizes: string | null;
}

// Curve-health thresholds mirror the web SizeHealth page.
const healthTone = (h: number | null): BadgeTone => {
  const v = Number(h);
  if (h === null || h === undefined || isNaN(v)) return "neutral";
  if (v >= 80) return "good";
  if (v >= 50) return "warn";
  return "immediate";
};

export default function SizeHealthScreen() {
  const c = useColors();
  const { range } = useFilters();
  const { status } = useAuth();

  const q = useQuery({
    queryKey: ["size-curve", range.date_from, range.date_to],
    queryFn: () => apiGet<SizeCurveRow[]>("/analytics/size-curve", range),
    staleTime: 5 * 60_000,
    enabled: status === "authenticated",
  });

  const rows = q.data ?? [];
  const broken = rows.filter((r) => Number(r.broken_sizes || 0) > 0);
  const whole = rows.length - broken.length;
  const avgHealth = rows.length
    ? rows.reduce((s, r) => s + Number(r.health_pct || 0), 0) / rows.length
    : 0;

  // Broken-curve best-sellers first (units_sold desc, then most broken sizes).
  const ranked = [...broken]
    .sort(
      (a, b) =>
        Number(b.units_sold || 0) - Number(a.units_sold || 0) ||
        Number(b.broken_sizes || 0) - Number(a.broken_sizes || 0),
    )
    .slice(0, 25);
  const maxUnits = ranked.reduce((m, r) => Math.max(m, Number(r.units_sold || 0)), 0);

  return (
    <>
      <Stack.Screen options={{ title: "Size Health" }} />
      <Screen onRefresh={() => q.refetch()} refreshing={q.isFetching}>
        <PresetPills />

        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState onRetry={() => q.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState text="No styles for the selected period" />
        ) : (
          <>
            <KpiGrid>
              <KpiCard label="Styles Tracked" value={fmtNum(rows.length)} accent />
              <KpiCard
                label="Broken Curves"
                value={fmtNum(broken.length)}
                sub="One or more sizes out"
              />
              <KpiCard label="Fully Stocked" value={fmtNum(whole)} />
              <KpiCard label="Avg Curve Health" value={fmtPct(avgHealth)} />
            </KpiGrid>

            <SectionHeader
              title="Broken Size Curves by Style"
              caption="Best-sellers with out-of-stock sizes first. Warehouses excluded."
            />
            {ranked.length === 0 ? (
              <EmptyState text="No broken size curves in this period" />
            ) : (
              <View style={styles.list}>
                {ranked.map((r, i) => (
                  <Card key={`${r.style_name}-${i}`} style={styles.row}>
                    <View style={styles.rowTop}>
                      <Text
                        style={[styles.style, { color: c.foreground }]}
                        numberOfLines={1}
                      >
                        {r.style_name || "—"}
                      </Text>
                      <Badge text={fmtPct(r.health_pct)} tone={healthTone(r.health_pct)} />
                    </View>
                    <MagnitudeBar
                      fraction={maxUnits ? Number(r.units_sold || 0) / maxUnits : 0}
                      color={c.primary}
                    />
                    <View style={styles.rowMeta}>
                      <Text style={[styles.meta, { color: c.mutedForeground }]}>
                        {fmtNum(r.units_sold)} sold · {r.brand || "—"}
                      </Text>
                      <Text style={[styles.meta, { color: c.mutedForeground }]}>
                        {fmtNum(r.sizes_in_stock)}/{fmtNum(r.total_sizes)} sizes ·{" "}
                        {fmtNum(r.broken_sizes)} broken
                      </Text>
                    </View>
                    {r.missing_sizes ? (
                      <Text style={[styles.missing, { color: c.destructive }]} numberOfLines={2}>
                        Missing: {r.missing_sizes}
                      </Text>
                    ) : null}
                  </Card>
                ))}
              </View>
            )}
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12 },
  row: { gap: 10 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  style: { fontFamily: "Jakarta_700Bold", fontSize: 15, flex: 1, letterSpacing: -0.2 },
  rowMeta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
  missing: { fontFamily: "Jakarta_600SemiBold", fontSize: 12 },
});
