import { Stack } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

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
import { KpiGrid, Screen } from "@/components/screen";
import { useColors } from "@/hooks/useColors";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtKES, fmtNum, fmtPct } from "@/lib/format";
import { useFilters } from "@/lib/filters";

// GET /api/analytics/margin — markdown / discount impact on gross margin.
// COGS uses per-unit landed cost; gross margin / margin % are computed over the
// COSTED subset only (cost_coverage = share of units with a known cost).
interface MarginRow {
  dim: string | null;
  units: number;
  gross: number;
  discounts: number;
  discount_rate: number | null;
  net_revenue: number;
  cogs: number;
  gross_margin: number;
  margin_pct: number | null;
  cost_coverage: number | null;
}

const DIMS = [
  { id: "category", label: "Category" },
  { id: "subcategory", label: "Subcategory" },
  { id: "brand", label: "Brand" },
  { id: "store", label: "Store" },
  { id: "month", label: "Month" },
] as const;

export default function MarginScreen() {
  const c = useColors();
  const { range } = useFilters();
  const { status } = useAuth();
  const [dim, setDim] = useState<string>("category");

  const q = useQuery({
    queryKey: ["margin", dim, range.date_from, range.date_to],
    queryFn: () =>
      apiGet<MarginRow[]>("/analytics/margin", { dim, ...range }),
    staleTime: 5 * 60_000,
    enabled: status === "authenticated",
  });

  const rows = q.data ?? [];

  const k = useMemo(() => {
    const gross = rows.reduce((s, r) => s + Number(r.gross || 0), 0);
    const discounts = rows.reduce((s, r) => s + Number(r.discounts || 0), 0);
    const net = rows.reduce((s, r) => s + Number(r.net_revenue || 0), 0);
    const cogs = rows.reduce((s, r) => s + Number(r.cogs || 0), 0);
    const gm = rows.reduce((s, r) => s + Number(r.gross_margin || 0), 0);
    const units = rows.reduce((s, r) => s + Number(r.units || 0), 0);
    const costedNet = gm + cogs;
    const marginPct = costedNet > 0 ? (gm * 100) / costedNet : 0;
    const discountRate = gross > 0 ? (discounts * 100) / gross : 0;
    const coveredUnits = rows.reduce(
      (s, r) => s + (Number(r.units || 0) * Number(r.cost_coverage || 0)) / 100,
      0,
    );
    const coverage = units > 0 ? (coveredUnits * 100) / units : 0;
    return { gross, discounts, net, cogs, gm, marginPct, discountRate, coverage };
  }, [rows]);

  const marginColor = (m: number | null | undefined): string => {
    const v = Number(m);
    if (m === null || m === undefined || isNaN(v)) return c.mutedForeground;
    if (v >= 50) return c.primary;
    if (v >= 30) return c.amber;
    return c.destructive;
  };

  const ranked = useMemo(
    () => [...rows].sort((a, b) => b.net_revenue - a.net_revenue).slice(0, 20),
    [rows],
  );
  const maxNet = ranked.reduce((m, r) => Math.max(m, r.net_revenue), 0);
  const dimLabel = DIMS.find((d) => d.id === dim)?.label || "Category";

  return (
    <>
      <Stack.Screen options={{ title: "Margin & Markdown" }} />
      <Screen onRefresh={() => q.refetch()} refreshing={q.isFetching}>
        <PresetPills />

        <View style={styles.chips}>
          {DIMS.map((d) => {
            const active = d.id === dim;
            return (
              <Pressable
                key={d.id}
                onPress={() => setDim(d.id)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: active ? c.primary : "transparent",
                    borderColor: active ? c.primary : c.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    { color: active ? c.primaryForeground : c.textSub },
                  ]}
                >
                  {d.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState onRetry={() => q.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState text="No sales for the selected period" />
        ) : (
          <>
            <KpiGrid>
              <KpiCard label="Net Revenue" value={fmtKES(k.net)} accent />
              <KpiCard
                label="Gross Margin"
                value={fmtKES(k.gm)}
                sub={`${fmtPct(k.coverage)} cost coverage`}
              />
              <KpiCard label="Margin %" value={fmtPct(k.marginPct)} />
              <KpiCard label="COGS" value={fmtKES(k.cogs)} />
              <KpiCard label="Discounts" value={fmtKES(k.discounts)} />
              <KpiCard label="Discount Rate" value={fmtPct(k.discountRate)} />
            </KpiGrid>

            <SectionHeader
              title={`Margin by ${dimLabel}`}
              caption="Ranked by net revenue · margin computed on costed units"
            />
            <View style={styles.list}>
              {ranked.map((r, i) => (
                <Card key={`${r.dim}-${i}`} style={styles.row}>
                  <View style={styles.rowTop}>
                    <Text
                      style={[styles.name, { color: c.foreground }]}
                      numberOfLines={1}
                    >
                      {r.dim || "—"}
                    </Text>
                    <Text style={[styles.amount, { color: c.foreground }]}>
                      {fmtKES(r.net_revenue)}
                    </Text>
                  </View>
                  <MagnitudeBar
                    fraction={maxNet ? r.net_revenue / maxNet : 0}
                    color={marginColor(r.margin_pct)}
                  />
                  <View style={styles.rowMeta}>
                    <Text style={[styles.meta, { color: c.mutedForeground }]}>
                      {fmtNum(r.units)} units · {fmtKES(r.cogs)} COGS
                    </Text>
                    <Text
                      style={[styles.marginPct, { color: marginColor(r.margin_pct) }]}
                    >
                      {fmtPct(r.margin_pct)} margin
                    </Text>
                  </View>
                  <View style={styles.rowMeta}>
                    <Text style={[styles.meta, { color: c.mutedForeground }]}>
                      {fmtKES(r.discounts)} discounts
                    </Text>
                    <Text style={[styles.meta, { color: c.mutedForeground }]}>
                      {fmtPct(r.discount_rate)} disc · {fmtPct(r.cost_coverage)} costed
                    </Text>
                  </View>
                </Card>
              ))}
            </View>
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { fontFamily: "Jakarta_600SemiBold", fontSize: 13 },
  list: { gap: 12 },
  row: { gap: 10 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  name: { fontFamily: "Jakarta_700Bold", fontSize: 15, flex: 1, letterSpacing: -0.2 },
  amount: { fontFamily: "Jakarta_800ExtraBold", fontSize: 17, letterSpacing: -0.3 },
  rowMeta: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
  marginPct: { fontFamily: "Jakarta_700Bold", fontSize: 12 },
});
