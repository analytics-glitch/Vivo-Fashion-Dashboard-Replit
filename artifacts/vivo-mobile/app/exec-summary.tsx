import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { Donut, Legend } from "@/components/charts";
import { KpiGrid, Screen } from "@/components/screen";
import {
  Card,
  CountryLabel,
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  MagnitudeBar,
  PresetPills,
  SectionHeader,
} from "@/components/ui";
import { countryColor } from "@/constants/colors";
import { useColors } from "@/hooks/useColors";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useFilters } from "@/lib/filters";
import { fmtCompact, fmtKES, fmtNum, fmtPct } from "@/lib/format";

interface ExecKpis {
  total_sales: number;
  net_sales: number;
  total_orders: number;
  total_units: number;
  avg_basket_size: number;
  avg_selling_price: number;
}

interface ExecCountryRow {
  country: string;
  orders: number;
  units_sold: number;
  total_sales: number;
  avg_basket_size: number;
}

interface ExecFootfallRow {
  location: string;
  total_footfall: number;
  orders: number;
  conversion_rate: number;
}

interface ExecTopSku {
  style_name: string | null;
  collection: string | null;
  brand: string | null;
  product_type: string | null;
  units_sold: number;
  total_sales: number;
  avg_price: number;
}

export default function ExecSummaryScreen() {
  const c = useColors();
  const { range } = useFilters();
  const { status } = useAuth();
  const enabled = status === "authenticated";

  const kpisQ = useQuery({
    queryKey: ["exec-kpis", range.date_from, range.date_to],
    queryFn: () => apiGet<ExecKpis>("/kpis", range),
    staleTime: 5 * 60_000,
    enabled,
  });

  const countryQ = useQuery({
    queryKey: ["exec-country", range.date_from, range.date_to],
    queryFn: () => apiGet<ExecCountryRow[]>("/country-summary", range),
    staleTime: 5 * 60_000,
    enabled,
  });

  const footfallQ = useQuery({
    queryKey: ["exec-footfall", range.date_from, range.date_to],
    queryFn: () => apiGet<ExecFootfallRow[]>("/footfall", range),
    staleTime: 5 * 60_000,
    enabled,
  });

  const topSkuQ = useQuery({
    queryKey: ["exec-top-skus", range.date_from, range.date_to],
    queryFn: () => apiGet<ExecTopSku[]>("/top-skus", { ...range, limit: 1 }),
    staleTime: 5 * 60_000,
    enabled,
  });

  const refetchAll = () => {
    kpisQ.refetch();
    countryQ.refetch();
    footfallQ.refetch();
    topSkuQ.refetch();
  };
  const refreshing =
    kpisQ.isFetching ||
    countryQ.isFetching ||
    footfallQ.isFetching ||
    topSkuQ.isFetching;

  const kpis = kpisQ.data;
  const countries = countryQ.data ?? [];
  const footfall = footfallQ.data ?? [];
  const topStyle = topSkuQ.data?.[0];

  const isLoading =
    kpisQ.isLoading ||
    countryQ.isLoading ||
    footfallQ.isLoading ||
    topSkuQ.isLoading;
  const isError = kpisQ.isError || countryQ.isError;

  // Sales-by-country mix (donut + ranked list).
  const ranked = [...countries].sort((a, b) => b.total_sales - a.total_sales);
  const grandTotal = ranked.reduce((s, r) => s + (r.total_sales || 0), 0);
  const maxCountry = ranked.reduce((m, r) => Math.max(m, r.total_sales || 0), 0);
  const slices = ranked.map((r) => ({
    label: r.country,
    value: Math.max(0, r.total_sales || 0),
    color: countryColor(r.country),
  }));
  const legendItems = slices.map((s) => ({
    label: s.label,
    color: s.color,
    value: grandTotal ? fmtPct((s.value / grandTotal) * 100) : "0%",
  }));

  // Footfall / conversion snapshot.
  const totalFootfall = footfall.reduce((s, r) => s + (r.total_footfall || 0), 0);
  const footfallOrders = footfall.reduce((s, r) => s + (r.orders || 0), 0);
  const conversion = totalFootfall ? (footfallOrders / totalFootfall) * 100 : 0;

  return (
    <>
      <Stack.Screen options={{ title: "Executive Summary" }} />
      <Screen onRefresh={refetchAll} refreshing={refreshing}>
        <View style={styles.header}>
          <Text style={[styles.brand, { color: c.primaryDeep }]}>
            Leadership Snapshot
          </Text>
          <Text style={[styles.title, { color: c.foreground }]}>
            Executive Summary
          </Text>
        </View>
        <PresetPills />

        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState onRetry={refetchAll} />
        ) : !kpis ? (
          <EmptyState text="No data for this period" />
        ) : (
          <>
            <KpiGrid>
              <KpiCard label="Total Sales" value={fmtKES(kpis.total_sales)} accent />
              <KpiCard label="Net Sales" value={fmtKES(kpis.net_sales)} />
              <KpiCard label="Transactions" value={fmtNum(kpis.total_orders)} />
              <KpiCard label="Units Sold" value={fmtNum(kpis.total_units)} />
              <KpiCard label="Avg Basket" value={fmtKES(kpis.avg_basket_size)} />
              <KpiCard label="Avg Selling Price" value={fmtKES(kpis.avg_selling_price)} />
            </KpiGrid>

            {ranked.length > 0 ? (
              <Card>
                <SectionHeader
                  title="Sales by Market"
                  caption="Share of total sales (KES)"
                />
                <View style={styles.donutRow}>
                  <Donut
                    data={slices}
                    centerValue={fmtCompact(grandTotal)}
                    centerLabel="Total"
                  />
                  <Legend items={legendItems} />
                </View>
              </Card>
            ) : null}

            {ranked.length > 0 ? (
              <View>
                <SectionHeader
                  title="Market Leaderboard"
                  caption="Ranked by total sales"
                />
                <View style={styles.list}>
                  {ranked.map((r) => {
                    const share = grandTotal
                      ? (r.total_sales / grandTotal) * 100
                      : 0;
                    return (
                      <Card key={r.country} style={styles.row}>
                        <View style={styles.rowTop}>
                          <CountryLabel country={r.country} />
                          <Text style={[styles.amount, { color: c.foreground }]}>
                            {fmtKES(r.total_sales)}
                          </Text>
                        </View>
                        <MagnitudeBar
                          fraction={maxCountry ? r.total_sales / maxCountry : 0}
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
              </View>
            ) : null}

            <View>
              <SectionHeader
                title="Footfall & Conversion"
                caption="Store traffic this period"
              />
              <KpiGrid>
                <KpiCard label="Total Footfall" value={fmtCompact(totalFootfall)} />
                <KpiCard label="Conversion" value={fmtPct(conversion)} />
              </KpiGrid>
            </View>

            {topStyle ? (
              <View>
                <SectionHeader title="Top Style" caption="Best-selling style by units" />
                <Card accent style={styles.topCard}>
                  <Text style={styles.topName} numberOfLines={2}>
                    {topStyle.style_name || "—"}
                  </Text>
                  <Text style={styles.topSub}>
                    {[topStyle.brand, topStyle.collection, topStyle.product_type]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </Text>
                  <View style={styles.topStats}>
                    <View style={styles.topStat}>
                      <Text style={styles.topStatLabel}>Units</Text>
                      <Text style={styles.topStatValue}>
                        {fmtNum(topStyle.units_sold)}
                      </Text>
                    </View>
                    <View style={styles.topStat}>
                      <Text style={styles.topStatLabel}>Net Sales</Text>
                      <Text style={styles.topStatValue}>
                        {fmtKES(topStyle.total_sales)}
                      </Text>
                    </View>
                    <View style={styles.topStat}>
                      <Text style={styles.topStatLabel}>Avg Price</Text>
                      <Text style={styles.topStatValue}>
                        {fmtKES(topStyle.avg_price)}
                      </Text>
                    </View>
                  </View>
                </Card>
              </View>
            ) : null}
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  header: { gap: 2 },
  brand: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  title: { fontFamily: "Jakarta_800ExtraBold", fontSize: 26, letterSpacing: -0.6 },
  donutRow: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 4 },
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
  topCard: { gap: 6 },
  topName: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 20,
    letterSpacing: -0.4,
    color: "#ffffff",
  },
  topSub: {
    fontFamily: "Jakarta_500Medium",
    fontSize: 13,
    color: "rgba(255,255,255,0.78)",
  },
  topStats: { flexDirection: "row", gap: 12, marginTop: 10 },
  topStat: { flex: 1, gap: 2 },
  topStatLabel: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.7)",
  },
  topStatValue: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 15,
    letterSpacing: -0.2,
    color: "#ffffff",
  },
});
