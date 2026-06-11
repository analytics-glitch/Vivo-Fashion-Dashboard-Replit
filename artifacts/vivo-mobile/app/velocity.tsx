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

// /analytics/velocity — sell-through velocity by style. rate_of_sale is the
// recency-weighted weekly run rate; weeks_of_cover = current store stock / rate.
// Current stock excludes warehouses, matching every other stock breakdown.
interface VelocityRow {
  style_name: string | null;
  brand: string | null;
  product_type: string | null;
  units_sold: number;
  total_sales: number;
  current_stock: number;
  rate_of_sale: number | null;
  weeks_of_cover: number | null;
  sell_through: number | null;
}

// Sell-through thresholds mirror the web Velocity/Products pages.
const velocityTag = (st: number | null): { label: string; tone: BadgeTone } => {
  const v = Number(st);
  if (st === null || st === undefined || isNaN(v)) return { label: "—", tone: "neutral" };
  if (v >= 60) return { label: "Fast", tone: "good" };
  if (v >= 30) return { label: "Steady", tone: "warn" };
  return { label: "Slow", tone: "immediate" };
};

export default function VelocityScreen() {
  const c = useColors();
  const { range } = useFilters();
  const { status } = useAuth();

  const q = useQuery({
    queryKey: ["velocity", range.date_from, range.date_to],
    queryFn: () => apiGet<VelocityRow[]>("/analytics/velocity", range),
    staleTime: 5 * 60_000,
    enabled: status === "authenticated",
  });

  const rows = q.data ?? [];
  const units = rows.reduce((s, r) => s + Number(r.units_sold || 0), 0);
  const stock = rows.reduce((s, r) => s + Number(r.current_stock || 0), 0);
  const weeklyRate = rows.reduce((s, r) => s + Number(r.rate_of_sale || 0), 0);
  const sellThrough = units + stock > 0 ? (units * 100) / (units + stock) : 0;
  const fast = rows.filter((r) => Number(r.sell_through || 0) >= 60).length;
  const slow = rows.filter((r) => Number(r.sell_through || 0) < 30).length;

  const ranked = [...rows]
    .sort((a, b) => Number(b.rate_of_sale || 0) - Number(a.rate_of_sale || 0))
    .slice(0, 25);
  const maxRate = ranked.reduce((m, r) => Math.max(m, Number(r.rate_of_sale || 0)), 0);

  return (
    <>
      <Stack.Screen options={{ title: "Velocity" }} />
      <Screen onRefresh={() => q.refetch()} refreshing={q.isFetching}>
        <PresetPills />

        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState onRetry={() => q.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState text="No sales for the selected period" />
        ) : (
          <>
            <KpiGrid>
              <KpiCard label="Styles" value={fmtNum(rows.length)} accent />
              <KpiCard label="Units Sold" value={fmtNum(units)} />
              <KpiCard
                label="Weekly Rate"
                value={`${fmtNum(weeklyRate)} / wk`}
                sub={`${fmtNum(fast)} fast · ${fmtNum(slow)} slow`}
              />
              <KpiCard label="Current Stock" value={fmtNum(stock)} />
              <KpiCard label="Sell-Through" value={fmtPct(sellThrough)} />
            </KpiGrid>

            <SectionHeader
              title="Sell-Through Velocity by Style"
              caption="Rate of sale and weeks of cover. Current stock excludes warehouses."
            />
            <View style={styles.list}>
              {ranked.map((r, i) => {
                const rate = Number(r.rate_of_sale || 0);
                const tag = velocityTag(r.sell_through);
                return (
                  <Card key={`${r.style_name}-${i}`} style={styles.row}>
                    <View style={styles.rowTop}>
                      <Text
                        style={[styles.style, { color: c.foreground }]}
                        numberOfLines={1}
                      >
                        {r.style_name || "—"}
                      </Text>
                      <Text style={[styles.rate, { color: c.primary }]}>
                        {fmtNum(rate)} / wk
                      </Text>
                    </View>
                    <MagnitudeBar
                      fraction={maxRate ? rate / maxRate : 0}
                      color={c.primary}
                    />
                    <View style={styles.rowMeta}>
                      <Text style={[styles.meta, { color: c.mutedForeground }]}>
                        {fmtNum(r.units_sold)} sold · {fmtNum(r.current_stock)} stock
                      </Text>
                      <Badge text={tag.label} tone={tag.tone} />
                    </View>
                    <View style={styles.rowMeta}>
                      <Text style={[styles.meta, { color: c.mutedForeground }]}>
                        {r.weeks_of_cover == null
                          ? "Cover —"
                          : `${fmtNum(r.weeks_of_cover)} wks cover`}
                      </Text>
                      <Text style={[styles.meta, { color: c.mutedForeground }]}>
                        {fmtPct(r.sell_through)} sell-through
                      </Text>
                    </View>
                  </Card>
                );
              })}
            </View>
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
  rate: { fontFamily: "Jakarta_800ExtraBold", fontSize: 16 },
  rowMeta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
