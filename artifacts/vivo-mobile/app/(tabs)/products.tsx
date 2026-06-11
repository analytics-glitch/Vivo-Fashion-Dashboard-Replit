import { useQuery } from "@tanstack/react-query";
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  MagnitudeBar,
  PresetPills,
  SectionHeader,
  WEB_TOP_INSET,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { TopSku, apiGet } from "@/lib/api";
import { fmtKES, fmtNum } from "@/lib/format";
import { useFilters } from "@/lib/filters";

export default function ProductsScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { range } = useFilters();

  const q = useQuery({
    queryKey: ["top-skus", range.date_from, range.date_to],
    queryFn: () => apiGet<TopSku[]>("/top-skus", { ...range, limit: 15 }),
    staleTime: 5 * 60_000,
  });

  const rows = (q.data ?? []).filter((r) => r.style_name);
  const max = rows.reduce((m, r) => Math.max(m, r.units_sold), 0);

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + WEB_TOP_INSET + 8, paddingBottom: 120 },
      ]}
    >
      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>Products</Text>
        <Text style={[styles.title, { color: c.foreground }]}>Top Styles</Text>
      </View>
      <PresetPills />

      {q.isLoading ? (
        <LoadingState />
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState text="No products sold in this period" />
      ) : (
        <>
          <SectionHeader title="Best Sellers" caption="Ranked by units sold" />
          <View style={styles.list}>
            {rows.map((r, i) => (
              <Card key={`${r.style_name}-${i}`} style={styles.row}>
                <View style={styles.rowTop}>
                  <View style={styles.rank}>
                    <Text style={[styles.rankNum, { color: c.primary }]}>
                      {String(i + 1).padStart(2, "0")}
                    </Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.style, { color: c.foreground }]} numberOfLines={1}>
                        {r.style_name}
                      </Text>
                      {r.brand ? (
                        <Text style={[styles.brandSmall, { color: c.mutedForeground }]}>
                          {r.brand}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  <View style={styles.unitsBox}>
                    <Text style={[styles.units, { color: c.foreground }]}>
                      {fmtNum(r.units_sold)}
                    </Text>
                    <Text style={[styles.unitsLabel, { color: c.mutedForeground }]}>units</Text>
                  </View>
                </View>
                <MagnitudeBar fraction={max ? r.units_sold / max : 0} color={c.primary} />
                <View style={styles.rowMeta}>
                  <Text style={[styles.meta, { color: c.mutedForeground }]}>
                    {fmtKES(r.total_sales)} sales
                  </Text>
                  <Text style={[styles.meta, { color: c.mutedForeground }]}>
                    {fmtKES(r.avg_price)} avg
                  </Text>
                </View>
              </Card>
            ))}
          </View>
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
  list: { gap: 12 },
  row: { gap: 10 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  rank: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  rankNum: { fontFamily: "Jakarta_800ExtraBold", fontSize: 15 },
  style: { fontFamily: "Jakarta_700Bold", fontSize: 15, letterSpacing: -0.2 },
  brandSmall: { fontFamily: "Jakarta_500Medium", fontSize: 12, marginTop: 1 },
  unitsBox: { alignItems: "flex-end" },
  units: { fontFamily: "Jakarta_800ExtraBold", fontSize: 17 },
  unitsLabel: { fontFamily: "Jakarta_500Medium", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  rowMeta: { flexDirection: "row", justifyContent: "space-between" },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
