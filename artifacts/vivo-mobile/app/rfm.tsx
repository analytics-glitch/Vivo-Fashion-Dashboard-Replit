import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { Screen, KpiGrid, MiniTable } from "@/components/screen";
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
import { useColors } from "@/hooks/useColors";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useFilters } from "@/lib/filters";
import { fmtKES, fmtNum, fmtPct } from "@/lib/format";

interface RfmSegment {
  segment: string;
  customers: number;
  monetary: number;
  avg_recency_days: number;
  avg_frequency: number;
  avg_monetary: number;
}

interface RfmCustomer {
  customer_id: string;
  segment: string;
  recency_days: number;
  frequency: number;
  monetary: number;
  r_score: number;
  f_score: number;
  m_score: number;
}

interface RfmResponse {
  summary: RfmSegment[];
  customers: RfmCustomer[];
}

// Canonical RFM grid order + accent colors (within the editorial palette).
const SEG_META: Record<string, { color: string; desc: string }> = {
  Champions: { color: "#1a5c38", desc: "Recent, frequent, high spend" },
  Loyal: { color: "#1a5c38", desc: "Consistent repeat buyers" },
  "Potential Loyalist": { color: "#2f8f5b", desc: "Recent buyers gaining momentum" },
  New: { color: "#4b7bec", desc: "Recent first purchases" },
  Promising: { color: "#6f9bf0", desc: "Recent, low frequency so far" },
  "At Risk": { color: "#d97706", desc: "Were valuable, slipping away" },
  "Cant Lose Them": { color: "#dc2626", desc: "High value, gone quiet" },
  Hibernating: { color: "#b45309", desc: "Low activity, low value" },
  Lost: { color: "#6b7280", desc: "No recent activity" },
};
const ORDER = Object.keys(SEG_META);
const segColor = (s: string) => SEG_META[s]?.color || "#6b7280";

export default function RfmScreen() {
  const c = useColors();
  const { range } = useFilters();
  const { status } = useAuth();

  const q = useQuery({
    queryKey: ["analytics-rfm", range.date_from, range.date_to],
    queryFn: () =>
      apiGet<RfmResponse>("/analytics/rfm", { ...range, limit: 2000 }),
    staleTime: 5 * 60_000,
    enabled: status === "authenticated",
  });

  const summary = q.data?.summary ?? [];
  const customers = q.data?.customers ?? [];

  const totals = React.useMemo(() => {
    const total = summary.reduce((t, r) => t + Number(r.customers || 0), 0);
    const monetary = summary.reduce((t, r) => t + Number(r.monetary || 0), 0);
    const champ =
      summary.find((r) => r.segment === "Champions")?.customers || 0;
    const risk = summary
      .filter((r) => ["At Risk", "Cant Lose Them"].includes(r.segment))
      .reduce((t, r) => t + Number(r.customers || 0), 0);
    return { total, monetary, champ, risk };
  }, [summary]);

  const segView = React.useMemo(() => {
    const idx = (s: string) => {
      const i = ORDER.indexOf(s);
      return i === -1 ? 999 : i;
    };
    return [...summary].sort((a, b) => idx(a.segment) - idx(b.segment));
  }, [summary]);

  const maxSeg = segView.reduce((m, r) => Math.max(m, r.customers), 0);

  return (
    <Screen onRefresh={() => q.refetch()} refreshing={q.isFetching}>
      <Stack.Screen options={{ title: "RFM Segments" }} />

      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>
          Customer Analytics
        </Text>
        <Text style={[styles.title, { color: c.foreground }]}>RFM Segments</Text>
      </View>
      <PresetPills />

      {q.isLoading ? (
        <LoadingState />
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : summary.length === 0 ? (
        <EmptyState text="No customers for this period" />
      ) : (
        <>
          <KpiGrid>
            <KpiCard label="Customers" value={fmtNum(totals.total)} accent />
            <KpiCard label="Net Spend" value={fmtKES(totals.monetary)} />
            <KpiCard
              label="Champions"
              value={fmtNum(totals.champ)}
              sub="Recent, frequent, high spend"
            />
            <KpiCard
              label="At Risk / Can't Lose"
              value={fmtNum(totals.risk)}
              sub="Win-back priority"
            />
          </KpiGrid>

          <View>
            <SectionHeader
              title="RFM Segments"
              caption="Scored 1–5 on Recency, Frequency & Monetary value"
            />
            <View style={styles.list}>
              {segView.map((r) => {
                const pct = totals.total
                  ? (r.customers / totals.total) * 100
                  : 0;
                return (
                  <Card key={r.segment} style={styles.row}>
                    <View style={styles.rowTop}>
                      <View style={styles.segLabel}>
                        <View
                          style={[styles.dot, { backgroundColor: segColor(r.segment) }]}
                        />
                        <Text
                          style={[styles.segName, { color: c.foreground }]}
                          numberOfLines={1}
                        >
                          {r.segment}
                        </Text>
                      </View>
                      <Text style={[styles.amount, { color: c.foreground }]}>
                        {fmtNum(r.customers)}
                      </Text>
                    </View>
                    <MagnitudeBar
                      fraction={maxSeg ? r.customers / maxSeg : 0}
                      color={segColor(r.segment)}
                    />
                    <Text style={[styles.desc, { color: c.mutedForeground }]}>
                      {SEG_META[r.segment]?.desc || ""}
                    </Text>
                    <View style={styles.rowMeta}>
                      <Text style={[styles.meta, { color: c.mutedForeground }]}>
                        {fmtPct(pct)} of base · {fmtKES(r.monetary)} spend
                      </Text>
                      <Text style={[styles.meta, { color: c.mutedForeground }]}>
                        {fmtNum(r.avg_frequency)} orders · {fmtNum(r.avg_recency_days)}d
                      </Text>
                    </View>
                  </Card>
                );
              })}
            </View>
          </View>

          <View>
            <SectionHeader
              title="Top Customers by Value"
              caption="Highest net spend with R/F/M scores"
            />
            {customers.length === 0 ? (
              <EmptyState text="No customers for this period" />
            ) : (
              <MiniTable
                columns={[
                  { key: "customer_id", label: "Customer", flex: 1.4 },
                  { key: "segment", label: "Segment", flex: 1.2 },
                  { key: "monetary", label: "Spend", align: "right", flex: 1.1 },
                  { key: "rfm", label: "RFM", align: "right", flex: 0.8 },
                ]}
                rows={customers.slice(0, 50).map((r) => ({
                  customer_id: r.customer_id || "—",
                  segment: r.segment,
                  monetary: fmtKES(r.monetary),
                  rfm: `${r.r_score}/${r.f_score}/${r.m_score}`,
                }))}
              />
            )}
          </View>
        </>
      )}
    </Screen>
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
  list: { gap: 12 },
  row: { gap: 8 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  segLabel: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  segName: { fontFamily: "Jakarta_700Bold", fontSize: 15, flex: 1, letterSpacing: -0.2 },
  amount: { fontFamily: "Jakarta_800ExtraBold", fontSize: 17, letterSpacing: -0.3 },
  desc: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
  rowMeta: { flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 4 },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
