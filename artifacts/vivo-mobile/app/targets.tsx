import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  Card,
  CountryLabel,
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  MagnitudeBar,
  SectionHeader,
} from "@/components/ui";
import { KpiGrid, MiniTable, Screen } from "@/components/screen";
import { countryColor } from "@/constants/colors";
import { useColors } from "@/hooks/useColors";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtKES, fmtPct } from "@/lib/format";

interface TargetTotals {
  target_annual: number;
  actual_ytd: number;
  pct_of_target_ytd: number;
  projected_year: number;
  pct_of_target_projected: number;
  variance_projected: number;
}

interface AnnualBucket extends TargetTotals {
  bucket: string;
}

interface AnnualTargets {
  total: TargetTotals;
  buckets: AnnualBucket[];
  completion_pct: number;
  days_elapsed: number;
  days_total: number;
  as_of: string;
}

interface MonthlyStore {
  channel: string;
  sales_target: number;
  mtd_actual: number;
  mtd_target: number;
  projected_landing: number;
  pct_of_target_projected: number;
  ksh_variance_total: number;
  days_complete: number;
  days_in_month: number;
  days_remaining: number;
}

interface MonthlyTargets {
  month: string;
  stores: MonthlyStore[];
}

export default function TargetsScreen() {
  const c = useColors();
  const { status } = useAuth();

  const annualQ = useQuery({
    queryKey: ["annual-targets"],
    queryFn: () => apiGet<AnnualTargets>("/analytics/annual-targets"),
    staleTime: 5 * 60_000,
    enabled: status === "authenticated",
  });

  const monthlyQ = useQuery({
    queryKey: ["monthly-targets"],
    queryFn: () => apiGet<MonthlyTargets>("/analytics/monthly-targets"),
    staleTime: 5 * 60_000,
    enabled: status === "authenticated",
  });

  const refetchAll = () => {
    annualQ.refetch();
    monthlyQ.refetch();
  };

  const data = annualQ.data;
  const total = data?.total;
  const buckets = (data?.buckets ?? [])
    .slice()
    .sort((a, b) => b.target_annual - a.target_annual);
  const maxTarget = buckets.reduce((m, b) => Math.max(m, b.target_annual), 0);

  const stores = (monthlyQ.data?.stores ?? [])
    .slice()
    .sort((a, b) => b.mtd_target - a.mtd_target);

  const monthLabel = monthlyQ.data?.month
    ? new Date(monthlyQ.data.month).toLocaleDateString("en-GB", {
        month: "long",
        year: "numeric",
      })
    : "";

  return (
    <Screen
      onRefresh={refetchAll}
      refreshing={annualQ.isFetching || monthlyQ.isFetching}
    >
      <Stack.Screen options={{ title: "Targets" }} />

      {annualQ.isLoading ? (
        <LoadingState />
      ) : annualQ.isError ? (
        <ErrorState onRetry={refetchAll} />
      ) : !total ? (
        <EmptyState text="No target data available" />
      ) : (
        <>
          <KpiGrid>
            <KpiCard
              label="Annual Target"
              value={fmtKES(total.target_annual)}
              accent
            />
            <KpiCard label="Actual YTD" value={fmtKES(total.actual_ytd)} />
            <KpiCard
              label="Attainment"
              value={fmtPct(total.pct_of_target_ytd)}
              sub={`${data?.completion_pct ?? 0}% of year elapsed`}
            />
            <KpiCard
              label="Projected Year"
              value={fmtKES(total.projected_year)}
              sub={`${fmtPct(total.pct_of_target_projected)} of target`}
            />
          </KpiGrid>

          <SectionHeader
            title="Annual Targets by Market"
            caption="YTD actuals against full-year target (KES)"
          />
          {buckets.length === 0 ? (
            <EmptyState text="No market breakdown" />
          ) : (
            <View style={styles.list}>
              {buckets.map((b) => {
                const frac = b.target_annual
                  ? b.actual_ytd / b.target_annual
                  : 0;
                return (
                  <Card key={b.bucket} style={styles.row}>
                    <View style={styles.rowTop}>
                      <CountryLabel country={b.bucket} />
                      <Text style={[styles.amount, { color: c.foreground }]}>
                        {fmtPct(b.pct_of_target_ytd)}
                      </Text>
                    </View>
                    <MagnitudeBar
                      fraction={frac}
                      color={countryColor(b.bucket)}
                    />
                    <View style={styles.rowMeta}>
                      <Text
                        style={[styles.meta, { color: c.mutedForeground }]}
                      >
                        {fmtKES(b.actual_ytd)} of {fmtKES(b.target_annual)}
                      </Text>
                      <Text
                        style={[
                          styles.meta,
                          {
                            color:
                              b.variance_projected >= 0
                                ? c.primary
                                : c.destructive,
                          },
                        ]}
                      >
                        {b.variance_projected >= 0 ? "+" : ""}
                        {fmtKES(b.variance_projected)} proj.
                      </Text>
                    </View>
                  </Card>
                );
              })}
            </View>
          )}

          <SectionHeader
            title={`Monthly Targets${monthLabel ? ` · ${monthLabel}` : ""}`}
            caption="Month-to-date target vs actual by market"
          />
          {monthlyQ.isLoading ? (
            <LoadingState />
          ) : monthlyQ.isError ? (
            <ErrorState onRetry={() => monthlyQ.refetch()} />
          ) : stores.length === 0 ? (
            <EmptyState text="No monthly target data" />
          ) : (
            <MiniTable
              columns={[
                { key: "market", label: "Market", flex: 1.4 },
                { key: "target", label: "MTD Target", align: "right" },
                { key: "actual", label: "Actual", align: "right" },
                { key: "att", label: "Att.", align: "right", flex: 0.8 },
              ]}
              rows={stores.map((s) => ({
                market: s.channel,
                target: fmtKES(s.mtd_target),
                actual: fmtKES(s.mtd_actual),
                att: fmtPct(
                  s.mtd_target ? (s.mtd_actual / s.mtd_target) * 100 : 0,
                  0,
                ),
              }))}
            />
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12 },
  row: { gap: 10 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  amount: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 17,
    letterSpacing: -0.3,
  },
  rowMeta: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
