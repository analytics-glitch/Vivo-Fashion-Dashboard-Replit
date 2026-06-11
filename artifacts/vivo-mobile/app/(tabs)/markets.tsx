import { useQuery } from "@tanstack/react-query";
import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  Card,
  CountryLabel,
  EmptyState,
  ErrorState,
  LoadingState,
  MagnitudeBar,
  PresetPills,
  SectionHeader,
  WEB_TOP_INSET,
} from "@/components/ui";
import { countryColor } from "@/constants/colors";
import { useColors } from "@/hooks/useColors";
import { CountryRow, apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtKES, fmtNum } from "@/lib/format";
import { useFilters } from "@/lib/filters";

export default function MarketsScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { range } = useFilters();
  const { status } = useAuth();

  const q = useQuery({
    queryKey: ["country-summary", range.date_from, range.date_to],
    queryFn: () => apiGet<CountryRow[]>("/country-summary", range),
    staleTime: 5 * 60_000,
    enabled: status === "authenticated",
  });

  const rows = q.data ?? [];
  const max = rows.reduce((m, r) => Math.max(m, r.total_sales), 0);
  const grandTotal = rows.reduce((s, r) => s + r.total_sales, 0);

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + WEB_TOP_INSET + 8, paddingBottom: 120 },
      ]}
    >
      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>Locations & Channels</Text>
        <Text style={[styles.title, { color: c.foreground }]}>Sales by Country</Text>
      </View>
      <PresetPills />

      {q.isLoading ? (
        <LoadingState />
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState text="No sales in this period" />
      ) : (
        <>
          <SectionHeader title="Net Sales by Market" caption="Ranked by total sales (KES)" />
          <View style={styles.list}>
            {rows.map((r) => {
              const share = grandTotal ? (r.total_sales / grandTotal) * 100 : 0;
              return (
                <Card key={r.country} style={styles.row}>
                  <View style={styles.rowTop}>
                    <CountryLabel country={r.country} />
                    <Text style={[styles.amount, { color: c.foreground }]}>
                      {fmtKES(r.total_sales)}
                    </Text>
                  </View>
                  <MagnitudeBar
                    fraction={max ? r.total_sales / max : 0}
                    color={countryColor(r.country)}
                  />
                  <View style={styles.rowMeta}>
                    <Text style={[styles.meta, { color: c.mutedForeground }]}>
                      {fmtNum(r.orders)} orders · {fmtNum(r.units_sold)} units
                    </Text>
                    <Text style={[styles.meta, { color: c.mutedForeground }]}>
                      {share.toFixed(1)}% · {fmtKES(r.avg_basket_size)} basket
                    </Text>
                  </View>
                </Card>
              );
            })}
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
  },
  amount: { fontFamily: "Jakarta_800ExtraBold", fontSize: 17, letterSpacing: -0.3 },
  rowMeta: { flexDirection: "row", justifyContent: "space-between" },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
