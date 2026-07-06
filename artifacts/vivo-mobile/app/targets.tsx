import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

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

interface QuarterStore {
  channel: string;
  sales_target: number;
  qtd_target: number;
  qtd_actual: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const currentQuarter = () => Math.floor(new Date().getMonth() / 3) + 1;

export default function TargetsScreen() {
  const c = useColors();
  const { status } = useAuth();

  const year = new Date().getFullYear();
  const [quarter, setQuarter] = React.useState<number>(currentQuarter());

  const annualQ = useQuery({
    queryKey: ["annual-targets"],
    queryFn: () => apiGet<AnnualTargets>("/analytics/annual-targets"),
    staleTime: 5 * 60_000,
    enabled: status === "authenticated",
  });

  // Quarter snapshot: aggregate the 3 months of the selected quarter from the
  // per-store monthly endpoint (target-to-date = summed MTD across the months,
  // which is a full month for elapsed months and MTD for the current month).
  const quarterQ = useQuery({
    queryKey: ["quarter-targets", year, quarter],
    queryFn: async (): Promise<QuarterStore[]> => {
      const months = [0, 1, 2].map((i) => (quarter - 1) * 3 + 1 + i);
      const results = await Promise.all(
        months.map((m) =>
          apiGet<MonthlyTargets>(
            `/analytics/monthly-targets?month=${year}-${pad2(m)}-01`,
          ),
        ),
      );
      const agg = new Map<string, QuarterStore>();
      for (const r of results) {
        for (const s of r.stores ?? []) {
          const cur =
            agg.get(s.channel) ??
            { channel: s.channel, sales_target: 0, qtd_target: 0, qtd_actual: 0 };
          cur.sales_target += s.sales_target || 0;
          cur.qtd_target += s.mtd_target || 0;
          cur.qtd_actual += s.mtd_actual || 0;
          agg.set(s.channel, cur);
        }
      }
      return Array.from(agg.values());
    },
    staleTime: 5 * 60_000,
    enabled: status === "authenticated",
  });

  const refetchAll = () => {
    annualQ.refetch();
    quarterQ.refetch();
  };

  const data = annualQ.data;
  const total = data?.total;
  const buckets = (data?.buckets ?? [])
    .slice()
    .sort((a, b) => b.target_annual - a.target_annual);

  const stores = (quarterQ.data ?? [])
    .slice()
    .sort((a, b) => b.sales_target - a.sales_target);

  return (
    <Screen
      onRefresh={refetchAll}
      refreshing={annualQ.isFetching || quarterQ.isFetching}
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
            title={`Quarterly Targets · Q${quarter} ${year}`}
            caption="Quarter-to-date target vs actual by store"
          />

          <View style={[styles.segGroup, { borderColor: c.border, backgroundColor: c.card }]}>
            {[1, 2, 3, 4].map((q) => {
              const on = quarter === q;
              return (
                <Pressable
                  key={q}
                  onPress={() => setQuarter(q)}
                  style={[styles.segItem, on && { backgroundColor: c.primary }]}
                >
                  <Text
                    style={[
                      styles.segText,
                      { color: on ? c.primaryForeground : c.mutedForeground },
                    ]}
                  >
                    Q{q}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {quarterQ.isLoading ? (
            <LoadingState />
          ) : quarterQ.isError ? (
            <ErrorState onRetry={() => quarterQ.refetch()} />
          ) : stores.length === 0 ? (
            <EmptyState text="No target data for this quarter" />
          ) : (
            <MiniTable
              columns={[
                { key: "market", label: "Market", flex: 1.4 },
                { key: "target", label: "Qtr Target", align: "right" },
                { key: "actual", label: "QTD Actual", align: "right" },
                { key: "att", label: "Att.", align: "right", flex: 0.8 },
              ]}
              rows={stores.map((s) => ({
                market: s.channel,
                target: fmtKES(s.sales_target),
                actual: fmtKES(s.qtd_actual),
                att: fmtPct(
                  s.sales_target ? (s.qtd_actual / s.sales_target) * 100 : 0,
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
  segGroup: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 10,
    padding: 3,
    gap: 3,
    marginBottom: 12,
  },
  segItem: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 7,
    alignItems: "center",
  },
  segText: { fontFamily: "Jakarta_700Bold", fontSize: 13 },
});
