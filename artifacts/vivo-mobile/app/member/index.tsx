import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Barcode from "react-native-barcode-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { brandColor, brandLabel } from "@/constants/colors";
import { useColors } from "@/hooks/useColors";
import { fmtKESLong, fmtNum } from "@/lib/format";
import {
  fetchMemberMe,
  getMemberToken,
  loadMemberToken,
  logoutMember,
  MemberMe,
  redeemPoints,
} from "@/lib/member";

const LOGO = require("@/assets/images/vivo-logo.png");

export default function MemberCardScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [data, setData] = useState<MemberMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (mode === "refresh") setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        await loadMemberToken();
        if (!getMemberToken()) {
          router.replace("/member/login");
          return;
        }
        const me = await fetchMemberMe();
        setData(me);
      } catch (e) {
        const status = (e as { status?: number })?.status;
        if (status === 401) {
          router.replace("/member/login");
          return;
        }
        setError(e instanceof Error ? e.message : "Could not load your card.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [router],
  );

  useFocusEffect(
    useCallback(() => {
      void load("initial");
    }, [load]),
  );

  const onRedeem = () => {
    if (!data) return;
    const { config, member } = data;
    const floor = config.redemption_floor;
    if (member.points_balance < floor) {
      Alert.alert(
        "Not enough points yet",
        `You need at least ${fmtNum(floor)} points to redeem. You have ${fmtNum(
          member.points_balance,
        )}.`,
      );
      return;
    }
    const value = member.points_balance / (config.points_per_kes_redeem || 100);
    Alert.alert(
      "Redeem your points?",
      `Redeem all ${fmtNum(member.points_balance)} points for a ${fmtKESLong(
        value,
      )} discount code to use at checkout.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Redeem",
          style: "default",
          onPress: async () => {
            setRedeeming(true);
            try {
              const res = await redeemPoints(member.points_balance);
              Alert.alert(
                "Discount code ready",
                `Show this code at the till:\n\n${res.discount_code}\n\nWorth ${fmtKESLong(
                  res.kes_value,
                )}.`,
              );
              await load("refresh");
            } catch (e) {
              Alert.alert(
                "Could not redeem",
                e instanceof Error ? e.message : "Please try again.",
              );
            } finally {
              setRedeeming(false);
            }
          },
        },
      ],
    );
  };

  const onSignOut = () => {
    Alert.alert("Sign out of your card?", "You can sign back in with your phone and PIN.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          await logoutMember();
          router.replace("/member/login");
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background, padding: 24, gap: 14 }]}>
        <Ionicons name="warning-outline" size={28} color={c.destructive} />
        <Text style={[styles.errorText, { color: c.foreground }]}>
          {error || "Could not load your card."}
        </Text>
        <Pressable
          onPress={() => load("initial")}
          style={[styles.primaryBtn, { backgroundColor: c.primary }]}
        >
          <Text style={[styles.primaryBtnText, { color: c.primaryForeground }]}>
            Try again
          </Text>
        </Pressable>
        <Pressable onPress={() => router.replace("/login")}>
          <Text style={[styles.link, { color: c.primary }]}>Back to staff sign in</Text>
        </Pressable>
      </View>
    );
  }

  const { member, ledger, config } = data;
  const unread = data.unread_messages || 0;
  const accent = brandColor(member.brand_code);
  const value = member.points_balance / (config.points_per_kes_redeem || 100);

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: insets.top + 16,
        paddingBottom: insets.bottom + 40,
        gap: 16,
      }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => load("refresh")}
          tintColor={c.primary}
          colors={[c.primary]}
        />
      }
    >
      {/* Top bar */}
      <View style={styles.topbar}>
        <View style={styles.brandRow}>
          <Image source={LOGO} style={styles.brandLogo} resizeMode="contain" />
          <Text style={[styles.brandName, { color: c.foreground }]}>Vivo Rewards</Text>
        </View>
        <Pressable onPress={onSignOut} hitSlop={10}>
          <Ionicons name="log-out-outline" size={22} color={c.mutedForeground} />
        </Pressable>
      </View>

      {/* Membership card */}
      <View style={[styles.card, { backgroundColor: c.primaryDeep }]}>
        <View style={styles.cardHead}>
          <View style={styles.brandDotRow}>
            <View style={[styles.brandDot, { backgroundColor: accent }]} />
            <Text style={styles.cardBrand}>{brandLabel(member.brand_code)}</Text>
          </View>
          <View style={styles.tierPill}>
            <Text style={styles.tierPillText}>{(member.tier || "Bronze").toUpperCase()}</Text>
          </View>
        </View>

        <Text style={styles.cardName} numberOfLines={1}>
          {member.name || "Member"}
        </Text>

        <View style={styles.pointsRow}>
          <View>
            <Text style={styles.pointsLabel}>Points balance</Text>
            <Text style={styles.pointsValue}>{fmtNum(member.points_balance)}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.pointsLabel}>Worth about</Text>
            <Text style={styles.pointsWorth}>{fmtKESLong(value)}</Text>
          </View>
        </View>

        {/* Scannable barcode */}
        <View style={styles.barcodeBox}>
          <Barcode
            value={member.membership_code}
            format="CODE128"
            maxWidth={280}
            height={70}
            singleBarWidth={2}
            backgroundColor="#ffffff"
            lineColor="#0f3d24"
          />
          <Text style={styles.barcodeText}>{member.membership_code}</Text>
        </View>
        <Text style={styles.scanHint}>Show this at the till to earn points</Text>
      </View>

      {/* Lifetime + tier progress */}
      <View style={styles.statsRow}>
        <View style={[styles.statCard, { backgroundColor: c.card, borderColor: c.border }]}>
          <Text style={[styles.statLabel, { color: c.mutedForeground }]}>Lifetime points</Text>
          <Text style={[styles.statValue, { color: c.foreground }]}>
            {fmtNum(member.points_lifetime)}
          </Text>
        </View>
        <View style={[styles.statCard, { backgroundColor: c.card, borderColor: c.border }]}>
          <Text style={[styles.statLabel, { color: c.mutedForeground }]}>Tier</Text>
          <Text style={[styles.statValue, { color: c.foreground }]}>
            {member.tier || "Bronze"}
          </Text>
        </View>
      </View>

      {/* Redeem */}
      <Pressable
        onPress={onRedeem}
        disabled={redeeming}
        style={({ pressed }) => [
          styles.redeemBtn,
          {
            backgroundColor: pressed ? c.primaryDeep : c.primary,
            opacity: redeeming ? 0.7 : 1,
          },
        ]}
      >
        {redeeming ? (
          <ActivityIndicator color={c.primaryForeground} />
        ) : (
          <>
            <Ionicons name="pricetag-outline" size={18} color={c.primaryForeground} />
            <Text style={[styles.redeemText, { color: c.primaryForeground }]}>
              Redeem points for a discount
            </Text>
          </>
        )}
      </Pressable>
      <Text style={[styles.redeemNote, { color: c.mutedForeground }]}>
        Minimum {fmtNum(config.redemption_floor)} points ·{" "}
        {fmtNum(config.points_per_kes_redeem)} points = KES 1
      </Text>

      {/* Messages inbox */}
      <Pressable
        onPress={() => router.push("/member/messages")}
        style={({ pressed }) => [
          styles.inboxRow,
          { backgroundColor: c.card, borderColor: c.border, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <Ionicons name="mail-outline" size={20} color={c.primary} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.inboxTitle, { color: c.foreground }]}>Messages</Text>
          <Text style={[styles.inboxSub, { color: c.mutedForeground }]}>
            Offers and updates from Vivo Rewards
          </Text>
        </View>
        {unread > 0 && (
          <View style={[styles.badge, { backgroundColor: c.primary }]}>
            <Text style={[styles.badgeText, { color: c.primaryForeground }]}>
              {unread > 99 ? "99+" : unread}
            </Text>
          </View>
        )}
        <Ionicons name="chevron-forward" size={18} color={c.mutedForeground} />
      </Pressable>

      {/* Activity (points audit) */}
      <View>
        <Text style={[styles.sectionTitle, { color: c.foreground }]}>Recent activity</Text>
        {ledger.length === 0 ? (
          <View style={[styles.emptyBox, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[styles.emptyText, { color: c.mutedForeground }]}>
              No points activity yet. Shop and scan your card to start earning.
            </Text>
          </View>
        ) : (
          <View style={[styles.ledger, { backgroundColor: c.card, borderColor: c.border }]}>
            {ledger.map((e, i) => {
              const up = e.points_change >= 0;
              return (
                <View
                  key={i}
                  style={[
                    styles.ledgerRow,
                    i > 0 && { borderTopWidth: 1, borderTopColor: c.border },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.ledgerReason, { color: c.foreground }]}>
                      {reasonLabel(e.reason)}
                    </Text>
                    <Text style={[styles.ledgerDate, { color: c.mutedForeground }]}>
                      {fmtDateTime(e.created_at)}
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text
                      style={[
                        styles.ledgerChange,
                        { color: up ? c.primary : c.destructive },
                      ]}
                    >
                      {up ? "+" : ""}
                      {fmtNum(e.points_change)}
                    </Text>
                    <Text style={[styles.ledgerBalance, { color: c.mutedForeground }]}>
                      bal {fmtNum(e.balance_after)}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case "earn":
      return "Points earned on purchase";
    case "redemption":
      return "Redeemed for discount";
    case "adjust":
      return "Manual adjustment";
    default:
      return reason ? reason[0].toUpperCase() + reason.slice(1) : "Activity";
  }
}

function fmtDateTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: "center", justifyContent: "center" },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandLogo: { width: 32, height: 32, borderRadius: 7 },
  brandName: { fontFamily: "Jakarta_800ExtraBold", fontSize: 18, letterSpacing: -0.4 },
  card: {
    borderRadius: 20,
    padding: 20,
    gap: 16,
    shadowColor: "#102818",
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brandDotRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  brandDot: { width: 10, height: 10, borderRadius: 999 },
  cardBrand: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 13,
    color: "rgba(255,255,255,0.9)",
    letterSpacing: 0.3,
  },
  tierPill: {
    backgroundColor: "rgba(255,255,255,0.16)",
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
  },
  tierPillText: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 11,
    letterSpacing: 1,
    color: "#ffffff",
  },
  cardName: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 22,
    color: "#ffffff",
    letterSpacing: -0.4,
  },
  pointsRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  pointsLabel: {
    fontFamily: "Jakarta_500Medium",
    fontSize: 11,
    color: "rgba(255,255,255,0.7)",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  pointsValue: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 34,
    color: "#ffffff",
    letterSpacing: -1,
  },
  pointsWorth: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 16,
    color: "#ffffff",
  },
  barcodeBox: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    gap: 6,
  },
  barcodeText: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 13,
    letterSpacing: 3,
    color: "#0f3d24",
  },
  scanHint: {
    fontFamily: "Jakarta_500Medium",
    fontSize: 12,
    color: "rgba(255,255,255,0.75)",
    textAlign: "center",
  },
  statsRow: { flexDirection: "row", gap: 12 },
  statCard: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 4,
  },
  statLabel: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  statValue: { fontFamily: "Jakarta_800ExtraBold", fontSize: 20, letterSpacing: -0.4 },
  redeemBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 15,
    borderRadius: 14,
  },
  redeemText: { fontFamily: "Jakarta_700Bold", fontSize: 15 },
  redeemNote: {
    fontFamily: "Jakarta_500Medium",
    fontSize: 12,
    textAlign: "center",
    marginTop: -6,
  },
  inboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  inboxTitle: { fontFamily: "Jakarta_700Bold", fontSize: 15, letterSpacing: -0.2 },
  inboxSub: { fontFamily: "Jakarta_500Medium", fontSize: 12, marginTop: 2 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 999,
    paddingHorizontal: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontFamily: "Jakarta_800ExtraBold", fontSize: 12 },
  sectionTitle: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 18,
    letterSpacing: -0.3,
    marginBottom: 10,
  },
  ledger: { borderWidth: 1, borderRadius: 14, overflow: "hidden" },
  ledgerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 12,
  },
  ledgerReason: { fontFamily: "Jakarta_600SemiBold", fontSize: 14 },
  ledgerDate: { fontFamily: "Jakarta_500Medium", fontSize: 12, marginTop: 2 },
  ledgerChange: { fontFamily: "Jakarta_800ExtraBold", fontSize: 16 },
  ledgerBalance: { fontFamily: "Jakarta_500Medium", fontSize: 11, marginTop: 2 },
  emptyBox: { borderWidth: 1, borderRadius: 14, padding: 18 },
  emptyText: {
    fontFamily: "Jakarta_500Medium",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  errorText: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 15,
    textAlign: "center",
  },
  primaryBtn: { paddingHorizontal: 22, paddingVertical: 12, borderRadius: 999 },
  primaryBtnText: { fontFamily: "Jakarta_700Bold", fontSize: 14 },
  link: { fontFamily: "Jakarta_600SemiBold", fontSize: 13 },
});
