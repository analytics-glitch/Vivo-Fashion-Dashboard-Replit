import { useQuery } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Screen } from "@/components/screen";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionHeader,
} from "@/components/ui";
import { brandColor, brandLabel, countryColor } from "@/constants/colors";
import { useColors } from "@/hooks/useColors";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtKES, fmtNum } from "@/lib/format";

interface ContactTag {
  id: number;
  name: string;
  color: string | null;
}

interface Contact {
  customer_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  country: string | null;
  brand_code: string;
  total_orders: number;
  total_spend_kes: number;
  last_order_date: string | null;
  is_manual: boolean;
  days_since: number | null;
  tier: string | null;
  points_balance: number | null;
  tags: ContactTag[];
}

const SEGMENTS = [
  { key: "", label: "All" },
  { key: "new", label: "New" },
  { key: "loyal", label: "Loyal" },
  { key: "vip", label: "VIP" },
  { key: "at_risk", label: "At risk" },
  { key: "churned", label: "Churned" },
];

export default function CrmContactsScreen() {
  const c = useColors();
  const router = useRouter();
  const { status } = useAuth();
  const enabled = status === "authenticated";

  const [text, setText] = React.useState("");
  const [q, setQ] = React.useState("");
  const [segment, setSegment] = React.useState("");

  // Debounce the search box so we don't fire a request per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);

  const listQ = useQuery({
    queryKey: ["crm-contacts", q, segment],
    queryFn: () =>
      apiGet<{ customers: Contact[]; count: number }>("/crm/customers", {
        q: q || undefined,
        segment: segment || undefined,
        limit: 60,
      }),
    staleTime: 60_000,
    enabled,
  });

  const rows = listQ.data?.customers ?? [];

  return (
    <Screen onRefresh={listQ.refetch} refreshing={listQ.isFetching}>
      <Stack.Screen options={{ title: "Contacts" }} />

      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>CRM</Text>
        <Text style={[styles.title, { color: c.foreground }]}>Contacts</Text>
      </View>

      <View
        style={[
          styles.searchWrap,
          { backgroundColor: c.card, borderColor: c.border },
        ]}
      >
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Search name, phone or email"
          placeholderTextColor={c.mutedForeground}
          style={[styles.search, { color: c.foreground }]}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {listQ.isFetching ? (
          <ActivityIndicator size="small" color={c.primary} />
        ) : null}
      </View>

      <View style={styles.segments}>
        {SEGMENTS.map((s) => {
          const active = segment === s.key;
          return (
            <Pressable
              key={s.key || "all"}
              onPress={() => setSegment(s.key)}
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
                {s.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {listQ.isLoading ? (
        <LoadingState />
      ) : listQ.isError ? (
        <ErrorState onRetry={listQ.refetch} />
      ) : rows.length === 0 ? (
        <EmptyState text="No contacts match this search" />
      ) : (
        <View>
          <SectionHeader
            title={`${fmtNum(rows.length)} contacts`}
            caption="Tap a contact for the 360 view"
          />
          <View style={styles.list}>
            {rows.map((r) => (
              <Pressable
                key={r.customer_id}
                onPress={() =>
                  router.push({
                    pathname: "/crm-customer",
                    params: { id: r.customer_id },
                  })
                }
                style={({ pressed }) => pressed && { opacity: 0.6 }}
              >
                <Card style={styles.row}>
                  <View style={styles.rowTop}>
                    <View style={styles.nameWrap}>
                      <View
                        style={[
                          styles.dot,
                          { backgroundColor: brandColor(r.brand_code) },
                        ]}
                      />
                      <Text
                        style={[styles.name, { color: c.foreground }]}
                        numberOfLines={1}
                      >
                        {r.name?.trim() || r.customer_id}
                      </Text>
                    </View>
                    <Text style={[styles.amount, { color: c.primary }]}>
                      {fmtKES(r.total_spend_kes)}
                    </Text>
                  </View>
                  <View style={styles.rowMeta}>
                    <Text
                      style={[styles.meta, { color: c.mutedForeground }]}
                      numberOfLines={1}
                    >
                      {brandLabel(r.brand_code)}
                      {r.country ? ` · ${r.country}` : ""}
                      {` · ${fmtNum(r.total_orders)} orders`}
                    </Text>
                    {r.tier ? (
                      <Text style={[styles.tier, { color: c.accentForeground }]}>
                        {r.tier.toUpperCase()}
                      </Text>
                    ) : null}
                  </View>
                  {r.phone || r.email ? (
                    <Text
                      style={[styles.contactLine, { color: c.mutedForeground }]}
                      numberOfLines={1}
                    >
                      {r.phone || r.email}
                    </Text>
                  ) : null}
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
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
  },
  search: { flex: 1, paddingVertical: 12, fontFamily: "Jakarta_500Medium", fontSize: 15 },
  segments: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  seg: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  segText: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 12,
    letterSpacing: 0.2,
  },
  list: { gap: 12 },
  row: { gap: 8 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  nameWrap: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  dot: { width: 9, height: 9, borderRadius: 999 },
  name: { fontFamily: "Jakarta_700Bold", fontSize: 15, flex: 1, letterSpacing: -0.2 },
  amount: { fontFamily: "Jakarta_800ExtraBold", fontSize: 16, letterSpacing: -0.3 },
  rowMeta: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12, flex: 1 },
  tier: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 10,
    letterSpacing: 0.6,
  },
  contactLine: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
