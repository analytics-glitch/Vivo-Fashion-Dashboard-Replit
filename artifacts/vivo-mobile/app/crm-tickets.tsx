import { useQuery } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Screen } from "@/components/screen";
import { Badge } from "@/components/screen";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionHeader,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface Ticket {
  id: number;
  ticket_number: string;
  customer_id: string | null;
  customer_name: string | null;
  subject: string;
  status: string;
  priority: string;
  inbound_channel: string | null;
  sla_overdue: boolean;
}

const FILTERS = [
  { key: "open", label: "Open" },
  { key: "", label: "All" },
  { key: "resolved", label: "Resolved" },
];

export default function CrmTicketsScreen() {
  const c = useColors();
  const router = useRouter();
  const { status } = useAuth();
  const enabled = status === "authenticated";

  const [filter, setFilter] = React.useState("open");

  const ticketsQ = useQuery({
    queryKey: ["crm-tickets", filter],
    queryFn: () =>
      apiGet<{ tickets: Ticket[] }>("/crm/tickets", {
        status: filter || undefined,
      }),
    staleTime: 30_000,
    enabled,
  });

  const rows = ticketsQ.data?.tickets ?? [];

  return (
    <Screen onRefresh={ticketsQ.refetch} refreshing={ticketsQ.isFetching}>
      <Stack.Screen options={{ title: "Tickets" }} />

      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>CRM</Text>
        <Text style={[styles.title, { color: c.foreground }]}>Service Tickets</Text>
      </View>

      <View style={styles.segments}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <Pressable
              key={f.key || "all"}
              onPress={() => setFilter(f.key)}
              style={[
                styles.seg,
                {
                  backgroundColor: active ? c.primary : c.card,
                  borderColor: active ? c.primary : c.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.segText,
                  { color: active ? c.primaryForeground : c.mutedForeground },
                ]}
              >
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {ticketsQ.isLoading ? (
        <LoadingState />
      ) : ticketsQ.isError ? (
        <ErrorState onRetry={ticketsQ.refetch} />
      ) : rows.length === 0 ? (
        <EmptyState text="No tickets here" />
      ) : (
        <View>
          <SectionHeader title={`${rows.length} tickets`} />
          <View style={styles.list}>
            {rows.map((t) => (
              <Pressable
                key={t.id}
                onPress={() =>
                  router.push({
                    pathname: "/crm-ticket",
                    params: { id: String(t.id) },
                  })
                }
                style={({ pressed }) => pressed && { opacity: 0.6 }}
              >
                <Card style={styles.row}>
                  <View style={styles.rowTop}>
                    <Text style={[styles.ticketNo, { color: c.mutedForeground }]}>
                      {t.ticket_number}
                    </Text>
                    <View style={styles.badges}>
                      {t.sla_overdue ? (
                        <Badge text="SLA overdue" tone="immediate" />
                      ) : null}
                      <Badge
                        text={t.status}
                        tone={
                          t.status === "resolved" || t.status === "closed"
                            ? "good"
                            : "planned"
                        }
                      />
                    </View>
                  </View>
                  <Text
                    style={[styles.subject, { color: c.foreground }]}
                    numberOfLines={2}
                  >
                    {t.subject}
                  </Text>
                  <Text
                    style={[styles.meta, { color: c.mutedForeground }]}
                    numberOfLines={1}
                  >
                    {[
                      t.customer_name?.trim() || null,
                      t.inbound_channel,
                      `priority ${t.priority}`,
                    ]
                      .filter(Boolean)
                      .join("  ·  ")}
                  </Text>
                </Card>
              </Pressable>
            ))}
          </View>
        </View>
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
  segments: { flexDirection: "row", gap: 8 },
  seg: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  segText: { fontFamily: "Jakarta_700Bold", fontSize: 12 },
  list: { gap: 12 },
  row: { gap: 8 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  ticketNo: { fontFamily: "Jakarta_700Bold", fontSize: 12, letterSpacing: 0.4 },
  badges: { flexDirection: "row", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" },
  subject: { fontFamily: "Jakarta_700Bold", fontSize: 15, letterSpacing: -0.2 },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
