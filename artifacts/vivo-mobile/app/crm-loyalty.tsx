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

import { Screen, KpiGrid } from "@/components/screen";
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

interface LoyaltySummary {
  by_tier: Record<string, { members: number; points: number }>;
  total_members: number;
  total_points_outstanding: number;
  redemptions: { open_codes?: number; used_codes?: number };
}

interface Member {
  customer_id: string;
  name: string | null;
  brand_code: string;
  country: string | null;
  tier: string | null;
  points_balance: number | null;
  total_spend_kes: number;
}

export default function CrmLoyaltyScreen() {
  const c = useColors();
  const router = useRouter();
  const { status } = useAuth();
  const enabled = status === "authenticated";

  const [text, setText] = React.useState("");
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);

  const summaryQ = useQuery({
    queryKey: ["crm-loyalty-summary"],
    queryFn: () => apiGet<LoyaltySummary>("/crm/loyalty/summary"),
    staleTime: 60_000,
    enabled,
  });

  // Loyalty lookup reuses the customers search and shows enrolled members.
  const lookupQ = useQuery({
    queryKey: ["crm-loyalty-lookup", q],
    queryFn: () =>
      apiGet<{ customers: Member[] }>("/crm/customers", {
        q: q || undefined,
        limit: 40,
      }),
    staleTime: 30_000,
    enabled: enabled && q.length > 0,
  });

  const s = summaryQ.data;
  const tiers = s ? Object.entries(s.by_tier) : [];
  const members = (lookupQ.data?.customers ?? []).filter((m) => m.tier);

  const refetchAll = () => {
    summaryQ.refetch();
    if (q) lookupQ.refetch();
  };

  return (
    <Screen
      onRefresh={refetchAll}
      refreshing={summaryQ.isFetching || lookupQ.isFetching}
    >
      <Stack.Screen options={{ title: "Loyalty" }} />

      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>CRM</Text>
        <Text style={[styles.title, { color: c.foreground }]}>Loyalty</Text>
      </View>

      {summaryQ.isLoading ? (
        <LoadingState />
      ) : summaryQ.isError ? (
        <ErrorState onRetry={summaryQ.refetch} />
      ) : s ? (
        <>
          <KpiGrid>
            <KpiCard label="Members" value={fmtNum(s.total_members)} accent />
            <KpiCard
              label="Points Outstanding"
              value={fmtNum(s.total_points_outstanding)}
            />
            <KpiCard label="Open Codes" value={fmtNum(s.redemptions.open_codes ?? 0)} />
            <KpiCard label="Used Codes" value={fmtNum(s.redemptions.used_codes ?? 0)} />
          </KpiGrid>

          <View>
            <SectionHeader title="Members by Tier" />
            {tiers.length === 0 ? (
              <EmptyState text="No enrolled members yet" />
            ) : (
              <View style={styles.list}>
                {tiers.map(([tier, v]) => (
                  <Card key={tier} style={styles.tierRow}>
                    <Text style={[styles.tierName, { color: c.foreground }]}>
                      {tier.toUpperCase()}
                    </Text>
                    <View style={styles.tierMeta}>
                      <Text style={[styles.tierVal, { color: c.foreground }]}>
                        {fmtNum(v.members)} members
                      </Text>
                      <Text style={[styles.tierSub, { color: c.mutedForeground }]}>
                        {fmtNum(v.points)} pts
                      </Text>
                    </View>
                  </Card>
                ))}
              </View>
            )}
          </View>
        </>
      ) : null}

      <View>
        <SectionHeader
          title="Member Lookup"
          caption="Search a contact to view their loyalty status"
        />
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
          {lookupQ.isFetching ? (
            <ActivityIndicator size="small" color={c.primary} />
          ) : null}
        </View>

        {q.length === 0 ? null : lookupQ.isError ? (
          <ErrorState onRetry={lookupQ.refetch} />
        ) : members.length === 0 ? (
          <EmptyState text="No enrolled members match" />
        ) : (
          <View style={styles.list}>
            {members.map((m) => (
              <Pressable
                key={m.customer_id}
                onPress={() =>
                  router.push({
                    pathname: "/crm-customer",
                    params: { id: m.customer_id },
                  })
                }
                style={({ pressed }) => pressed && { opacity: 0.6 }}
              >
                <Card style={styles.memberRow}>
                  <View style={styles.memberTop}>
                    <View style={styles.nameWrap}>
                      <View
                        style={[
                          styles.dot,
                          { backgroundColor: brandColor(m.brand_code) },
                        ]}
                      />
                      <Text
                        style={[styles.memberName, { color: c.foreground }]}
                        numberOfLines={1}
                      >
                        {m.name?.trim() || m.customer_id}
                      </Text>
                    </View>
                    <Text style={[styles.tierBadge, { color: c.accentForeground }]}>
                      {m.tier?.toUpperCase()}
                    </Text>
                  </View>
                  <Text style={[styles.memberMeta, { color: c.mutedForeground }]}>
                    {brandLabel(m.brand_code)}
                    {m.country ? ` · ${m.country}` : ""}
                    {` · ${fmtNum(m.points_balance ?? 0)} pts · ${fmtKES(m.total_spend_kes)}`}
                  </Text>
                </Card>
              </Pressable>
            ))}
          </View>
        )}
      </View>
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
  tierRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  tierName: { fontFamily: "Jakarta_800ExtraBold", fontSize: 15, letterSpacing: 0.4 },
  tierMeta: { alignItems: "flex-end" },
  tierVal: { fontFamily: "Jakarta_700Bold", fontSize: 15 },
  tierSub: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  search: { flex: 1, paddingVertical: 12, fontFamily: "Jakarta_500Medium", fontSize: 15 },
  memberRow: { gap: 6 },
  memberTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  nameWrap: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  dot: { width: 9, height: 9, borderRadius: 999 },
  memberName: { fontFamily: "Jakarta_700Bold", fontSize: 15, flex: 1 },
  tierBadge: { fontFamily: "Jakarta_700Bold", fontSize: 11, letterSpacing: 0.6 },
  memberMeta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
