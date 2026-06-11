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
  SectionHeader,
} from "@/components/ui";
import { BarChart, Donut, Legend } from "@/components/charts";
import { KpiGrid, Screen } from "@/components/screen";
import { useColors } from "@/hooks/useColors";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtCompact, fmtNum, fmtPct } from "@/lib/format";

// /analytics/inventory-summary — merchandise-filtered stock aggregate. by_location
// keeps ALL locations (warehouse included) so the client splits store vs warehouse
// with its own regex, single-sourced here exactly as the web cockpit does.
interface InventorySummary {
  total_units: number;
  sku_count: number;
  location_count: number;
  by_location: { location: string; country: string; units: number }[];
  by_subcat: { product_type: string; units: number }[];
}

// A location counts as "warehouse" (non-store stock) when its name matches this
// pattern — mirrors isWarehouseLocation() on the web Inventory page.
const isWarehouseLocation = (loc: string): boolean =>
  /warehouse|wholesale|holding|staging|sale stock|online - shop zetu/.test(
    (loc || "").toLowerCase(),
  );

export default function InventoryScreen() {
  const c = useColors();
  const { status } = useAuth();

  const q = useQuery({
    queryKey: ["inventory-summary"],
    queryFn: () => apiGet<InventorySummary>("/analytics/inventory-summary"),
    staleTime: 5 * 60_000,
    enabled: status === "authenticated",
  });

  const summary = q.data;
  const byLocation = (summary?.by_location ?? [])
    .map((r) => ({ ...r, units: r.units || 0 }))
    .sort((a, b) => b.units - a.units);

  let storeUnits = 0;
  let warehouseUnits = 0;
  for (const r of byLocation) {
    if (isWarehouseLocation(r.location)) warehouseUnits += r.units;
    else storeUnits += r.units;
  }
  const total = summary?.total_units ?? 0;
  const maxLoc = byLocation.reduce((m, r) => Math.max(m, r.units), 0);

  const stores = byLocation.filter((r) => !isWarehouseLocation(r.location)).slice(0, 12);
  const subcats = (summary?.by_subcat ?? []).slice(0, 6);

  return (
    <>
      <Stack.Screen options={{ title: "Inventory" }} />
      <Screen onRefresh={() => q.refetch()} refreshing={q.isFetching}>
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState onRetry={() => q.refetch()} />
        ) : !summary ? (
          <EmptyState text="No inventory data available" />
        ) : (
          <>
            <KpiGrid>
              <KpiCard label="Available Units" value={fmtCompact(total)} accent />
              <KpiCard
                label="Store Units"
                value={fmtCompact(storeUnits)}
                sub={`${fmtPct(total ? (storeUnits / total) * 100 : 0)} on floor`}
              />
              <KpiCard label="SKUs" value={fmtNum(summary.sku_count)} />
              <KpiCard label="Locations" value={fmtNum(summary.location_count)} />
            </KpiGrid>

            <SectionHeader
              title="Store vs Warehouse"
              caption="Available units by holding type"
            />
            <Card style={styles.donutRow}>
              <Donut
                size={148}
                thickness={22}
                centerValue={fmtCompact(total)}
                centerLabel="Units"
                data={[
                  { label: "Store", value: storeUnits, color: c.primary },
                  { label: "Warehouse", value: warehouseUnits, color: c.amber },
                ]}
              />
              <Legend
                items={[
                  { label: "Store", color: c.primary, value: fmtCompact(storeUnits) },
                  { label: "Warehouse", color: c.amber, value: fmtCompact(warehouseUnits) },
                ]}
              />
            </Card>

            {subcats.length > 0 && (
              <>
                <SectionHeader
                  title="Stock by Subcategory"
                  caption="Top merchandise categories by available units"
                />
                <Card>
                  <BarChart
                    data={subcats.map((s) => ({
                      label: s.product_type,
                      value: s.units,
                    }))}
                    valueFmt={(n) => fmtCompact(n)}
                  />
                </Card>
              </>
            )}

            <SectionHeader
              title="Available Stock by Store"
              caption="Ranked by available units (selling locations)"
            />
            {stores.length === 0 ? (
              <EmptyState text="No store stock recorded" />
            ) : (
              <View style={styles.list}>
                {stores.map((r) => {
                  const share = total ? (r.units / total) * 100 : 0;
                  return (
                    <Card key={r.location} style={styles.row}>
                      <View style={styles.rowTop}>
                        <Text
                          style={[styles.store, { color: c.foreground }]}
                          numberOfLines={1}
                        >
                          {r.location}
                        </Text>
                        <Text style={[styles.amount, { color: c.foreground }]}>
                          {fmtCompact(r.units)}
                        </Text>
                      </View>
                      <MagnitudeBar
                        fraction={maxLoc ? r.units / maxLoc : 0}
                        color={c.primary}
                      />
                      <View style={styles.rowMeta}>
                        <Text style={[styles.meta, { color: c.mutedForeground }]}>
                          {r.country || "—"}
                        </Text>
                        <Text style={[styles.meta, { color: c.mutedForeground }]}>
                          {fmtPct(share)} of stock
                        </Text>
                      </View>
                    </Card>
                  );
                })}
              </View>
            )}
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  donutRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  list: { gap: 12 },
  row: { gap: 10 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  store: { fontFamily: "Jakarta_700Bold", fontSize: 15, flex: 1, letterSpacing: -0.2 },
  amount: { fontFamily: "Jakarta_800ExtraBold", fontSize: 17, letterSpacing: -0.3 },
  rowMeta: { flexDirection: "row", justifyContent: "space-between" },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
