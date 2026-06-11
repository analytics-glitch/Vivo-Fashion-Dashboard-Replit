import { useQuery } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  Alert,
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
import { apiGet, apiPost } from "@/lib/api";
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

interface RedeemLookup {
  discount_code: string;
  member_name: string | null;
  kes_value: number | null;
  points_redeemed: number | null;
  code_status: string;
  used_at: string | null;
  redeemable: boolean;
}

interface RedemptionsReport {
  summary: {
    total_codes: number;
    open_codes: number;
    used_codes: number;
    kes_issued: number;
    kes_used: number;
    kes_open: number;
    points_redeemed: number;
  };
  by_store: { store: string; used_codes: number; kes_used: number }[];
}

export default function CrmLoyaltyScreen() {
  const c = useColors();
  const router = useRouter();
  const { status } = useAuth();
  const enabled = status === "authenticated";

  const [text, setText] = React.useState("");
  const [q, setQ] = React.useState("");

  const [earnCode, setEarnCode] = React.useState("");
  const [earnAmount, setEarnAmount] = React.useState("");
  const [earning, setEarning] = React.useState(false);

  const [redeemCode, setRedeemCode] = React.useState("");
  const [redeemStore, setRedeemStore] = React.useState("");
  const [redeemInfo, setRedeemInfo] = React.useState<RedeemLookup | null>(null);
  const [redeemBusy, setRedeemBusy] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 350);
    return () => clearTimeout(t);
  }, [text]);

  const awardPoints = async () => {
    if (earning) return;
    const code = earnCode.trim();
    const amount = Number(earnAmount);
    if (!code) {
      Alert.alert("Membership code required", "Scan or enter a membership code.");
      return;
    }
    if (!amount || amount <= 0) {
      Alert.alert("Amount required", "Enter a valid purchase amount in KES.");
      return;
    }
    setEarning(true);
    try {
      const r = await apiPost<{
        points_awarded?: number;
        points_balance?: number;
        member_name?: string | null;
      }>("/crm/loyalty/earn", { membership_code: code, amount_kes: amount });
      Alert.alert(
        "Points awarded",
        `${r.member_name || "Member"}: +${fmtNum(r.points_awarded ?? 0)} pts (balance ${fmtNum(r.points_balance ?? 0)})`,
      );
      setEarnCode("");
      setEarnAmount("");
      summaryQ.refetch();
    } catch (e) {
      Alert.alert(
        "Could not award points",
        e instanceof Error ? e.message : "Please try again.",
      );
    } finally {
      setEarning(false);
    }
  };

  const redeemLookup = async () => {
    if (redeemBusy) return;
    const code = redeemCode.trim();
    if (!code) {
      Alert.alert("Code required", "Scan or enter a redemption code.");
      return;
    }
    setRedeemBusy(true);
    setRedeemInfo(null);
    try {
      const r = await apiPost<RedeemLookup>("/crm/loyalty/redeem-code/lookup", {
        code,
      });
      setRedeemInfo(r);
    } catch (e) {
      Alert.alert(
        "Could not find code",
        e instanceof Error ? e.message : "Please try again.",
      );
    } finally {
      setRedeemBusy(false);
    }
  };

  const redeemApply = async () => {
    if (redeemBusy) return;
    const code = (redeemInfo?.discount_code || redeemCode).trim();
    if (!code) return;
    setRedeemBusy(true);
    try {
      const r = await apiPost<{
        kes_value?: number | null;
        member_name?: string | null;
      }>("/crm/loyalty/redeem-code/apply", {
        code,
        used_store_id: redeemStore.trim() || undefined,
      });
      Alert.alert(
        "Discount applied",
        `${fmtKES(r.kes_value ?? 0)} off for ${r.member_name || "member"}.`,
      );
      setRedeemCode("");
      setRedeemStore("");
      setRedeemInfo(null);
      summaryQ.refetch();
    } catch (e) {
      Alert.alert(
        "Could not apply code",
        e instanceof Error ? e.message : "Please try again.",
      );
    } finally {
      setRedeemBusy(false);
    }
  };

  const summaryQ = useQuery({
    queryKey: ["crm-loyalty-summary"],
    queryFn: () => apiGet<LoyaltySummary>("/crm/loyalty/summary"),
    staleTime: 60_000,
    enabled,
  });

  const reportQ = useQuery({
    queryKey: ["crm-loyalty-redemptions-report"],
    queryFn: () => apiGet<RedemptionsReport>("/crm/loyalty/redemptions/report"),
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

  const report = reportQ.data;

  const refetchAll = () => {
    summaryQ.refetch();
    reportQ.refetch();
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
          title="Award Points"
          caption="Scan or enter a membership code at point of sale"
        />
        <Card style={styles.earnCard}>
          <TextInput
            value={earnCode}
            onChangeText={setEarnCode}
            placeholder="Membership code"
            placeholderTextColor={c.mutedForeground}
            style={[styles.earnInput, { color: c.foreground, borderColor: c.border }]}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="number-pad"
            editable={!earning}
          />
          <TextInput
            value={earnAmount}
            onChangeText={(t) => setEarnAmount(t.replace(/[^0-9.]/g, ""))}
            placeholder="Purchase amount (KES)"
            placeholderTextColor={c.mutedForeground}
            style={[styles.earnInput, { color: c.foreground, borderColor: c.border }]}
            keyboardType="decimal-pad"
            editable={!earning}
          />
          <Pressable
            onPress={awardPoints}
            disabled={earning}
            style={({ pressed }) => [
              styles.earnButton,
              { backgroundColor: c.primary, opacity: earning || pressed ? 0.7 : 1 },
            ]}
          >
            {earning ? (
              <ActivityIndicator size="small" color={c.primaryForeground} />
            ) : (
              <Text style={[styles.earnButtonText, { color: c.primaryForeground }]}>
                Award points
              </Text>
            )}
          </Pressable>
        </Card>
      </View>

      <View>
        <SectionHeader
          title="Redeem Code"
          caption="Validate a member's redemption code at the till"
        />
        <Card style={styles.earnCard}>
          <TextInput
            value={redeemCode}
            onChangeText={(t) => {
              setRedeemCode(t);
              setRedeemInfo(null);
            }}
            placeholder="Redemption code (e.g. VFG-XXXXXXXX)"
            placeholderTextColor={c.mutedForeground}
            style={[styles.earnInput, { color: c.foreground, borderColor: c.border }]}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!redeemBusy}
          />
          <TextInput
            value={redeemStore}
            onChangeText={setRedeemStore}
            placeholder="Store ID (optional)"
            placeholderTextColor={c.mutedForeground}
            style={[styles.earnInput, { color: c.foreground, borderColor: c.border }]}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!redeemBusy}
          />
          {redeemInfo ? (
            <View
              style={[
                styles.redeemPreview,
                { backgroundColor: c.muted, borderColor: c.border },
              ]}
            >
              <Text style={[styles.redeemName, { color: c.foreground }]}>
                {redeemInfo.member_name || "Member"}
              </Text>
              <Text style={[styles.redeemMeta, { color: c.mutedForeground }]}>
                {redeemInfo.discount_code} · {fmtNum(redeemInfo.points_redeemed ?? 0)} pts ·{" "}
                {fmtKES(redeemInfo.kes_value ?? 0)} discount
              </Text>
              {!redeemInfo.redeemable ? (
                <Text style={[styles.redeemUsed, { color: c.destructive }]}>
                  Code already {redeemInfo.code_status}
                </Text>
              ) : null}
            </View>
          ) : null}
          {redeemInfo?.redeemable ? (
            <Pressable
              onPress={redeemApply}
              disabled={redeemBusy}
              style={({ pressed }) => [
                styles.earnButton,
                { backgroundColor: c.primary, opacity: redeemBusy || pressed ? 0.7 : 1 },
              ]}
            >
              {redeemBusy ? (
                <ActivityIndicator size="small" color={c.primaryForeground} />
              ) : (
                <Text style={[styles.earnButtonText, { color: c.primaryForeground }]}>
                  Apply discount
                </Text>
              )}
            </Pressable>
          ) : (
            <Pressable
              onPress={redeemLookup}
              disabled={redeemBusy}
              style={({ pressed }) => [
                styles.earnButton,
                {
                  backgroundColor: c.card,
                  borderWidth: 1,
                  borderColor: c.border,
                  opacity: redeemBusy || pressed ? 0.7 : 1,
                },
              ]}
            >
              {redeemBusy ? (
                <ActivityIndicator size="small" color={c.primary} />
              ) : (
                <Text style={[styles.earnButtonText, { color: c.foreground }]}>
                  Validate code
                </Text>
              )}
            </Pressable>
          )}
        </Card>
      </View>

      {report ? (
        <View>
          <SectionHeader
            title="Redemptions Report"
            caption="Issued by issue date; used/spend by redemption date (all time)"
          />
          <KpiGrid>
            <KpiCard
              label="Codes Issued"
              value={fmtNum(report.summary.total_codes)}
              sub={`${fmtKES(report.summary.kes_issued)} value`}
            />
            <KpiCard
              label="Codes Used"
              value={fmtNum(report.summary.used_codes)}
              sub={`${fmtKES(report.summary.kes_used)} spent`}
            />
            <KpiCard
              label="Open Codes"
              value={fmtNum(report.summary.open_codes)}
              sub={`${fmtKES(report.summary.kes_open)} liability`}
            />
            <KpiCard
              label="Points Redeemed"
              value={fmtNum(report.summary.points_redeemed)}
            />
          </KpiGrid>
          <SectionHeader title="Discount Spend by Store" />
          {report.by_store.length === 0 ? (
            <EmptyState text="No codes redeemed at a till yet" />
          ) : (
            <View style={styles.list}>
              {report.by_store.map((st) => (
                <Card key={st.store} style={styles.storeRow}>
                  <Text style={[styles.storeName, { color: c.foreground }]} numberOfLines={1}>
                    {st.store}
                  </Text>
                  <View style={styles.storeMeta}>
                    <Text style={[styles.storeKes, { color: c.foreground }]}>
                      {fmtKES(st.kes_used)}
                    </Text>
                    <Text style={[styles.storeCodes, { color: c.mutedForeground }]}>
                      {fmtNum(st.used_codes)} codes
                    </Text>
                  </View>
                </Card>
              ))}
            </View>
          )}
        </View>
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
  storeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  storeName: { fontFamily: "Jakarta_700Bold", fontSize: 14, flex: 1, marginRight: 12 },
  storeMeta: { alignItems: "flex-end" },
  storeKes: { fontFamily: "Jakarta_700Bold", fontSize: 15 },
  storeCodes: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
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
  earnCard: { gap: 10 },
  earnInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: "Jakarta_500Medium",
    fontSize: 15,
  },
  earnButton: {
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  earnButtonText: { fontFamily: "Jakarta_700Bold", fontSize: 15 },
  redeemPreview: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  redeemName: { fontFamily: "Jakarta_700Bold", fontSize: 15 },
  redeemMeta: { fontFamily: "Jakarta_500Medium", fontSize: 12.5 },
  redeemUsed: { fontFamily: "Jakarta_700Bold", fontSize: 12.5, marginTop: 2 },
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
