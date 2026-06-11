import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  Card,
  ErrorState,
  LoadingState,
  PresetPills,
  SectionHeader,
  WEB_TOP_INSET,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { Kpis, apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtCompact, fmtKES, fmtNum, fmtPct } from "@/lib/format";
import { useFilters } from "@/lib/filters";

export default function OverviewScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { range } = useFilters();
  const { status, logout } = useAuth();

  const q = useQuery({
    queryKey: ["kpis", range.date_from, range.date_to],
    queryFn: () => apiGet<Kpis>("/kpis", range),
    staleTime: 5 * 60_000,
    enabled: status === "authenticated",
  });

  const k = q.data;

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + WEB_TOP_INSET + 8, paddingBottom: 120 },
      ]}
    >
      <View style={styles.headerRow}>
        <View style={styles.header}>
          <Text style={[styles.brand, { color: c.primaryDeep }]}>Vivo Fashion Group</Text>
          <Text style={[styles.title, { color: c.foreground }]}>Executive Overview</Text>
        </View>
        <Pressable
          onPress={() => logout()}
          hitSlop={10}
          style={[styles.signOut, { borderColor: c.border, backgroundColor: c.card }]}
        >
          <Feather name="log-out" size={16} color={c.textSub} />
        </Pressable>
      </View>
      <PresetPills />

      {q.isLoading ? (
        <LoadingState />
      ) : q.isError || !k ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : (
        <>
          <View style={styles.heroRow}>
            <Card accent style={styles.hero}>
              <Text style={[styles.heroLabel]}>Net Sales</Text>
              <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit>
                {fmtKES(k.net_sales)}
              </Text>
              <Text style={styles.heroSub}>
                {fmtKES(k.total_sales)} total · {fmtNum(k.total_orders)} orders
              </Text>
            </Card>
          </View>

          <SectionHeader title="Key Metrics" />
          <View style={styles.grid}>
            <Metric label="Orders" value={fmtNum(k.total_orders)} />
            <Metric label="Units Sold" value={fmtNum(k.total_units)} />
            <Metric label="Avg Basket" value={fmtKES(k.avg_basket_size)} />
            <Metric label="Avg Sell Price" value={fmtKES(k.avg_selling_price)} />
            <Metric label="Gross Sales" value={fmtKES(k.gross_sales)} />
            <Metric label="Return Rate" value={fmtPct(k.return_rate)} />
          </View>

          <SectionHeader title="Movement" caption="Discounts & returns this period" />
          <Card style={styles.movement}>
            <MovementRow label="Discounts" value={fmtKES(k.total_discounts)} />
            <View style={[styles.divider, { backgroundColor: c.border }]} />
            <MovementRow label="Returns" value={fmtKES(k.total_returns)} />
            <View style={[styles.divider, { backgroundColor: c.border }]} />
            <MovementRow label="Units / Order" value={fmtCompact(k.total_orders ? k.total_units / k.total_orders : 0)} />
          </Card>
        </>
      )}
    </ScrollView>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  const c = useColors();
  return (
    <Card style={styles.metric}>
      <Text style={[styles.metricLabel, { color: c.mutedForeground }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: c.foreground }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </Card>
  );
}

function MovementRow({ label, value }: { label: string; value: string }) {
  const c = useColors();
  return (
    <View style={styles.movementRow}>
      <Text style={[styles.movementLabel, { color: c.textSub }]}>{label}</Text>
      <Text style={[styles.movementValue, { color: c.foreground }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, gap: 16 },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  header: { gap: 2, flexShrink: 1 },
  signOut: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  brand: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  title: { fontFamily: "Jakarta_800ExtraBold", fontSize: 26, letterSpacing: -0.6 },
  heroRow: { flexDirection: "row" },
  hero: { flex: 1, gap: 6 },
  heroLabel: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.75)",
  },
  heroValue: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 34,
    letterSpacing: -1,
    color: "#ffffff",
  },
  heroSub: {
    fontFamily: "Jakarta_500Medium",
    fontSize: 13,
    color: "rgba(255,255,255,0.8)",
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  metric: { flexBasis: "47%", flexGrow: 1, gap: 6 },
  metricLabel: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  metricValue: { fontFamily: "Jakarta_800ExtraBold", fontSize: 20, letterSpacing: -0.4 },
  movement: { gap: 0, paddingVertical: 4 },
  movementRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
  },
  movementLabel: { fontFamily: "Jakarta_500Medium", fontSize: 14 },
  movementValue: { fontFamily: "Jakarta_700Bold", fontSize: 15 },
  divider: { height: 1 },
});
