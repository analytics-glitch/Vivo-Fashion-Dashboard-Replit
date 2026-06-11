import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { Screen, KpiGrid, MiniTable } from "@/components/screen";
import {
  Card,
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  SectionHeader,
} from "@/components/ui";
import { brandColor, brandLabel } from "@/constants/colors";
import { useColors } from "@/hooks/useColors";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtKES, fmtNum } from "@/lib/format";

interface Profile {
  customer_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  country: string | null;
  city: string | null;
  brand_code: string;
  preferred_size: string | null;
  total_orders: number;
  total_spend_kes: number;
  first_order_date: string | null;
  last_order_date: string | null;
  is_manual: boolean;
}

interface Txn {
  order_id: string;
  sale_date: string | null;
  pos_location: string | null;
  amount_kes: number;
  units: number;
}

interface Tag {
  id: number;
  name: string;
  color: string | null;
}

interface Task {
  id: number;
  title: string;
  status: string;
  due_date: string | null;
}

interface Ticket {
  id: number;
  ticket_number: string;
  subject: string;
  status: string;
  priority: string;
}

interface Enrolment {
  tier: string | null;
  points_balance: number | null;
}

interface Detail {
  profile: Profile;
  transactions: Txn[];
  tags: Tag[];
  tasks: Task[];
  tickets: Ticket[];
  loyalty: { enrolment: Enrolment | null };
}

export default function CrmCustomerScreen() {
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { status } = useAuth();
  const enabled = status === "authenticated" && !!id;

  const detailQ = useQuery({
    queryKey: ["crm-customer", id],
    queryFn: () => apiGet<Detail>(`/crm/customers/${encodeURIComponent(id!)}`),
    staleTime: 30_000,
    enabled,
  });

  const d = detailQ.data;
  const p = d?.profile;

  return (
    <Screen onRefresh={detailQ.refetch} refreshing={detailQ.isFetching}>
      <Stack.Screen options={{ title: "Contact 360" }} />

      {detailQ.isLoading ? (
        <LoadingState />
      ) : detailQ.isError || !d || !p ? (
        <ErrorState onRetry={detailQ.refetch} />
      ) : (
        <>
          <View style={styles.header}>
            <View style={styles.nameWrap}>
              <View
                style={[styles.dot, { backgroundColor: brandColor(p.brand_code) }]}
              />
              <Text style={[styles.title, { color: c.foreground }]}>
                {p.name?.trim() || p.customer_id}
              </Text>
            </View>
            <Text style={[styles.sub, { color: c.mutedForeground }]}>
              {brandLabel(p.brand_code)}
              {p.country ? ` · ${p.country}` : ""}
              {p.city ? ` · ${p.city}` : ""}
              {p.is_manual ? " · Manual contact" : ""}
            </Text>
            {p.phone || p.email ? (
              <Text style={[styles.contact, { color: c.foreground }]}>
                {[p.phone, p.email].filter(Boolean).join("  ·  ")}
              </Text>
            ) : null}
          </View>

          <KpiGrid>
            <KpiCard label="Total Spend" value={fmtKES(p.total_spend_kes)} accent />
            <KpiCard label="Orders" value={fmtNum(p.total_orders)} />
            <KpiCard
              label="Loyalty Tier"
              value={d.loyalty.enrolment?.tier?.toUpperCase() || "—"}
              sub={
                d.loyalty.enrolment
                  ? `${fmtNum(d.loyalty.enrolment.points_balance ?? 0)} pts`
                  : "Not enrolled"
              }
            />
            <KpiCard
              label="Preferred Size"
              value={p.preferred_size || "—"}
              sub={p.last_order_date ? `Last ${p.last_order_date}` : undefined}
            />
          </KpiGrid>

          {d.tags.length > 0 ? (
            <View style={styles.tags}>
              {d.tags.map((t) => (
                <View
                  key={t.id}
                  style={[
                    styles.tag,
                    { backgroundColor: (t.color || c.primary) + "22" },
                  ]}
                >
                  <View
                    style={[
                      styles.tagDot,
                      { backgroundColor: t.color || c.primary },
                    ]}
                  />
                  <Text style={[styles.tagText, { color: c.foreground }]}>
                    {t.name}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <View>
            <SectionHeader title="Recent Orders" caption="Most recent 20 orders" />
            {d.transactions.length === 0 ? (
              <EmptyState text="No purchase history" />
            ) : (
              <MiniTable
                columns={[
                  { key: "sale_date", label: "Date", flex: 1.1 },
                  { key: "pos_location", label: "Location", flex: 1.4 },
                  { key: "units", label: "Units", align: "right", flex: 0.7 },
                  { key: "amount", label: "Amount", align: "right", flex: 1.2 },
                ]}
                rows={d.transactions.map((t) => ({
                  sale_date: t.sale_date || "—",
                  pos_location: t.pos_location || "—",
                  units: fmtNum(t.units),
                  amount: fmtKES(t.amount_kes),
                }))}
              />
            )}
          </View>

          <View>
            <SectionHeader title="Open Tasks" caption="Follow-ups for this contact" />
            {d.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled")
              .length === 0 ? (
              <EmptyState text="No open tasks" />
            ) : (
              <View style={styles.list}>
                {d.tasks
                  .filter((t) => t.status !== "done" && t.status !== "cancelled")
                  .map((t) => (
                    <Card key={t.id} style={styles.lineRow}>
                      <Text
                        style={[styles.lineTitle, { color: c.foreground }]}
                        numberOfLines={2}
                      >
                        {t.title}
                      </Text>
                      {t.due_date ? (
                        <Text style={[styles.lineMeta, { color: c.mutedForeground }]}>
                          Due {t.due_date}
                        </Text>
                      ) : null}
                    </Card>
                  ))}
              </View>
            )}
          </View>

          <View>
            <SectionHeader title="Tickets" caption="Service history" />
            {d.tickets.length === 0 ? (
              <EmptyState text="No tickets" />
            ) : (
              <View style={styles.list}>
                {d.tickets.map((t) => (
                  <Card key={t.id} style={styles.lineRow}>
                    <View style={styles.ticketTop}>
                      <Text style={[styles.ticketNo, { color: c.mutedForeground }]}>
                        {t.ticket_number}
                      </Text>
                      <Text style={[styles.lineMeta, { color: c.mutedForeground }]}>
                        {t.status} · {t.priority}
                      </Text>
                    </View>
                    <Text
                      style={[styles.lineTitle, { color: c.foreground }]}
                      numberOfLines={2}
                    >
                      {t.subject}
                    </Text>
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
  header: { gap: 6 },
  nameWrap: { flexDirection: "row", alignItems: "center", gap: 9 },
  dot: { width: 11, height: 11, borderRadius: 999 },
  title: { fontFamily: "Jakarta_800ExtraBold", fontSize: 24, letterSpacing: -0.6, flex: 1 },
  sub: { fontFamily: "Jakarta_500Medium", fontSize: 13 },
  contact: { fontFamily: "Jakarta_600SemiBold", fontSize: 14 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  tagDot: { width: 7, height: 7, borderRadius: 999 },
  tagText: { fontFamily: "Jakarta_600SemiBold", fontSize: 12 },
  list: { gap: 10 },
  lineRow: { gap: 4 },
  lineTitle: { fontFamily: "Jakarta_600SemiBold", fontSize: 14 },
  lineMeta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
  ticketTop: { flexDirection: "row", justifyContent: "space-between" },
  ticketNo: { fontFamily: "Jakarta_700Bold", fontSize: 11, letterSpacing: 0.4 },
});
