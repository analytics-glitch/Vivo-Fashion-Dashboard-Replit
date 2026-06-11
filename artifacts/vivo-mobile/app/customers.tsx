import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { BarChart, Donut, Legend } from "@/components/charts";
import { Screen, KpiGrid } from "@/components/screen";
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

interface CustomerSummary {
  total_customers: number;
  new_customers: number;
  repeat_customers: number;
  returning_customers: number;
  churned_customers: number;
  avg_customer_spend: number;
  avg_orders_per_customer: number;
  churn_rate: number;
}

interface FrequencyBucket {
  frequency_bucket: string;
  customer_count: number;
}

interface TopCustomer {
  rank: number;
  customer_id: string;
  customer_name: string;
  phone: string;
  email: string | null;
  city: string | null;
  customer_country: string | null;
  total_orders: number;
  total_units: number;
  total_sales: number;
  avg_basket: number;
  last_purchase_date: string | null;
  first_purchase_date: string | null;
}

interface LocationRow {
  pos_location_name: string;
  country: string;
  total_customers: number;
  new_customers: number;
  returning_customers: number;
  pct_of_total: number;
}

export default function CustomersScreen() {
  const c = useColors();
  const { range } = useFilters();
  const { status } = useAuth();
  const enabled = status === "authenticated";

  const summaryQ = useQuery({
    queryKey: ["customers", range.date_from, range.date_to],
    queryFn: () => apiGet<CustomerSummary>("/customers", range),
    staleTime: 5 * 60_000,
    enabled,
  });

  const freqQ = useQuery({
    queryKey: ["customer-frequency", range.date_from, range.date_to],
    queryFn: () => apiGet<FrequencyBucket[]>("/customer-frequency", range),
    staleTime: 5 * 60_000,
    enabled,
  });

  const topQ = useQuery({
    queryKey: ["top-customers", range.date_from, range.date_to],
    queryFn: () =>
      apiGet<TopCustomer[]>("/top-customers", { ...range, limit: 15 }),
    staleTime: 5 * 60_000,
    enabled,
  });

  const locQ = useQuery({
    queryKey: ["customers-by-location", range.date_from, range.date_to],
    queryFn: () => apiGet<LocationRow[]>("/customers-by-location", range),
    staleTime: 5 * 60_000,
    enabled,
  });

  const refetchAll = () => {
    summaryQ.refetch();
    freqQ.refetch();
    topQ.refetch();
    locQ.refetch();
  };
  const refreshing =
    summaryQ.isFetching ||
    freqQ.isFetching ||
    topQ.isFetching ||
    locQ.isFetching;

  const s = summaryQ.data;
  const freq = freqQ.data ?? [];
  const top = topQ.data ?? [];
  const locRows = locQ.data ?? [];

  // Aggregate customers-by-location into per-country totals (multiple POS
  // locations roll up under one country).
  const byCountry = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const r of locRows) {
      const key = r.country || "Other";
      map.set(key, (map.get(key) || 0) + (r.total_customers || 0));
    }
    return [...map.entries()]
      .map(([country, total_customers]) => ({ country, total_customers }))
      .sort((a, b) => b.total_customers - a.total_customers);
  }, [locRows]);

  const countryTotal = byCountry.reduce((t, r) => t + r.total_customers, 0);
  const countryMax = byCountry.reduce((m, r) => Math.max(m, r.total_customers), 0);
  const maxSales = top.reduce((m, r) => Math.max(m, r.total_sales), 0);

  const loading =
    summaryQ.isLoading || freqQ.isLoading || topQ.isLoading || locQ.isLoading;
  const errored =
    summaryQ.isError || freqQ.isError || topQ.isError || locQ.isError;

  return (
    <Screen onRefresh={refetchAll} refreshing={refreshing}>
      <Stack.Screen options={{ title: "Customers" }} />

      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>
          Customer Analytics
        </Text>
        <Text style={[styles.title, { color: c.foreground }]}>Customers</Text>
      </View>
      <PresetPills />

      {loading ? (
        <LoadingState />
      ) : errored ? (
        <ErrorState onRetry={refetchAll} />
      ) : (
        <>
          <KpiGrid>
            <KpiCard
              label="Total Customers"
              value={fmtNum(s?.total_customers ?? 0)}
              accent
            />
            <KpiCard label="New" value={fmtNum(s?.new_customers ?? 0)} />
            <KpiCard label="Repeat" value={fmtNum(s?.repeat_customers ?? 0)} />
            <KpiCard
              label="Avg Spend"
              value={fmtKES(s?.avg_customer_spend ?? 0)}
              sub={`${fmtNum(s?.avg_orders_per_customer ?? 0)} orders / customer`}
            />
            <KpiCard label="Churn Rate" value={fmtPct(s?.churn_rate ?? 0)} />
            <KpiCard
              label="Churned"
              value={fmtNum(s?.churned_customers ?? 0)}
              sub="Inactive 90+ days"
            />
          </KpiGrid>

          <View>
            <SectionHeader
              title="Purchase Frequency"
              caption="Customers by orders placed in period"
            />
            {freq.length === 0 ? (
              <EmptyState text="No frequency data this period" />
            ) : (
              <Card>
                <BarChart
                  data={freq.map((f) => ({
                    label: f.frequency_bucket.replace(" orders", "").replace(" order", ""),
                    value: f.customer_count,
                    color: c.primary,
                  }))}
                  valueFmt={(n) => fmtCompact(n)}
                />
              </Card>
            )}
          </View>

          <View>
            <SectionHeader
              title="Customers by Country"
              caption="Distinct customers per market"
            />
            {byCountry.length === 0 ? (
              <EmptyState text="No location data this period" />
            ) : (
              <>
                <Card style={styles.donutCard}>
                  <Donut
                    data={byCountry.map((r) => ({
                      label: r.country,
                      value: r.total_customers,
                      color: countryColor(r.country),
                    }))}
                    centerValue={fmtCompact(countryTotal)}
                    centerLabel="Customers"
                  />
                  <Legend
                    items={byCountry.map((r) => ({
                      label: r.country,
                      color: countryColor(r.country),
                      value: fmtNum(r.total_customers),
                    }))}
                  />
                </Card>
                <View style={styles.list}>
                  {byCountry.map((r) => {
                    const share = countryTotal
                      ? (r.total_customers / countryTotal) * 100
                      : 0;
                    return (
                      <Card key={r.country} style={styles.row}>
                        <View style={styles.rowTop}>
                          <CountryLabel country={r.country} />
                          <Text style={[styles.amount, { color: c.foreground }]}>
                            {fmtNum(r.total_customers)}
                          </Text>
                        </View>
                        <MagnitudeBar
                          fraction={countryMax ? r.total_customers / countryMax : 0}
                          color={countryColor(r.country)}
                        />
                        <Text style={[styles.meta, { color: c.mutedForeground }]}>
                          {fmtPct(share)} of customers
                        </Text>
                      </Card>
                    );
                  })}
                </View>
              </>
            )}
          </View>

          <View>
            <SectionHeader
              title="Top Customers"
              caption="Ranked by total spend (KES)"
            />
            {top.length === 0 ? (
              <EmptyState text="No customers this period" />
            ) : (
              <View style={styles.list}>
                {top.map((r) => (
                  <Card key={r.customer_id} style={styles.row}>
                    <View style={styles.rowTop}>
                      <Text
                        style={[styles.name, { color: c.foreground }]}
                        numberOfLines={1}
                      >
                        {r.customer_name?.trim() || r.customer_id}
                      </Text>
                      <Text style={[styles.amount, { color: c.primary }]}>
                        {fmtKES(r.total_sales)}
                      </Text>
                    </View>
                    <MagnitudeBar
                      fraction={maxSales ? r.total_sales / maxSales : 0}
                      color={c.primary}
                    />
                    <View style={styles.rowMeta}>
                      <Text style={[styles.meta, { color: c.mutedForeground }]}>
                        {fmtNum(r.total_orders)} orders · {fmtNum(r.total_units)} units
                      </Text>
                      <Text style={[styles.meta, { color: c.mutedForeground }]}>
                        {fmtKES(r.avg_basket)} basket
                      </Text>
                    </View>
                  </Card>
                ))}
              </View>
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
  donutCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginBottom: 12,
  },
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
  rowMeta: { flexDirection: "row", justifyContent: "space-between" },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
