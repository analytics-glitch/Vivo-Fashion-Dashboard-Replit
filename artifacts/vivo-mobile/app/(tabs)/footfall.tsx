import { useQuery } from "@tanstack/react-query";
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  Card,
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  MagnitudeBar,
  PresetPills,
  SectionHeader,
  WEB_TOP_INSET,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { FootfallRow, apiGet } from "@/lib/api";
import { fmtCompact, fmtNum, fmtPct } from "@/lib/format";
import { useFilters } from "@/lib/filters";

export default function FootfallScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { range } = useFilters();

  // Footfall endpoint takes date range only (no country filter, per backend contract).
  const q = useQuery({
    queryKey: ["footfall", range.date_from, range.date_to],
    queryFn: () => apiGet<FootfallRow[]>("/footfall", range),
    staleTime: 5 * 60_000,
  });

  const rows = q.data ?? [];
  const totalFootfall = rows.reduce((s, r) => s + (r.total_footfall || 0), 0);
  const totalOutside = rows.reduce((s, r) => s + (r.outside_traffic || 0), 0);
  const turnIn = totalOutside ? (totalFootfall / totalOutside) * 100 : 0;

  // Conversion snapshot: only stores with linked sales + sane turn-in.
  const converting = rows
    .filter((r) => r.conversion_rate > 0)
    .sort((a, b) => b.conversion_rate - a.conversion_rate)
    .slice(0, 8);
  const maxConv = converting.reduce((m, r) => Math.max(m, r.conversion_rate), 0);

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + WEB_TOP_INSET + 8, paddingBottom: 120 },
      ]}
    >
      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>Footfall & Conversion</Text>
        <Text style={[styles.title, { color: c.foreground }]}>Store Traffic</Text>
      </View>
      <PresetPills />

      {q.isLoading ? (
        <LoadingState />
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState text="No footfall recorded in this period" />
      ) : (
        <>
          <View style={styles.grid}>
            <KpiCard label="Total Footfall" value={fmtCompact(totalFootfall)} accent />
            <KpiCard label="Outside Traffic" value={fmtCompact(totalOutside)} />
            <KpiCard label="Turn-in Rate" value={fmtPct(turnIn)} />
            <KpiCard label="Stores Tracked" value={fmtNum(rows.length)} />
          </View>

          <SectionHeader
            title="Top Stores by Conversion"
            caption="Orders as a share of footfall"
          />
          {converting.length === 0 ? (
            <EmptyState text="No conversion data linked this period" />
          ) : (
            <View style={styles.list}>
              {converting.map((r) => (
                <Card key={r.location} style={styles.row}>
                  <View style={styles.rowTop}>
                    <Text style={[styles.store, { color: c.foreground }]} numberOfLines={1}>
                      {r.location}
                    </Text>
                    <Text style={[styles.conv, { color: c.primary }]}>
                      {fmtPct(r.conversion_rate)}
                    </Text>
                  </View>
                  <MagnitudeBar
                    fraction={maxConv ? r.conversion_rate / maxConv : 0}
                    color={c.primary}
                  />
                  <View style={styles.rowMeta}>
                    <Text style={[styles.meta, { color: c.mutedForeground }]}>
                      {fmtCompact(r.total_footfall)} footfall
                    </Text>
                    <Text style={[styles.meta, { color: c.mutedForeground }]}>
                      {fmtNum(r.orders)} orders
                    </Text>
                  </View>
                </Card>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, gap: 16 },
  header: { gap: 2 },
  brand: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  title: { fontFamily: "Jakarta_800ExtraBold", fontSize: 26, letterSpacing: -0.6 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  list: { gap: 12 },
  row: { gap: 10 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  store: { fontFamily: "Jakarta_700Bold", fontSize: 15, flex: 1, letterSpacing: -0.2 },
  conv: { fontFamily: "Jakarta_800ExtraBold", fontSize: 17 },
  rowMeta: { flexDirection: "row", justifyContent: "space-between" },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
