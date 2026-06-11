import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Card, WEB_TOP_INSET } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/lib/auth";

type Item = { label: string; caption: string; icon: keyof typeof Feather.glyphMap; route: string };
type Group = { title: string; items: Item[]; roles?: string[] };

const GROUPS: Group[] = [
  {
    title: "Performance",
    items: [
      { label: "Overview", caption: "Executive snapshot & KPIs", icon: "bar-chart-2", route: "/" },
      { label: "Executive Summary", caption: "One-screen business health", icon: "award", route: "/exec-summary" },
      { label: "Locations", caption: "Sales by country & channel", icon: "globe", route: "/markets" },
      { label: "Footfall", caption: "Traffic, turn-in & conversion", icon: "trending-up", route: "/footfall" },
    ],
  },
  {
    title: "Customers",
    items: [
      { label: "Customers", caption: "New, repeat, churn & spend", icon: "users", route: "/customers" },
      { label: "RFM Segments", caption: "Recency / frequency / value", icon: "pie-chart", route: "/rfm" },
    ],
  },
  {
    title: "CRM",
    // CRM is an analyst+ surface (matches the web nav + backend role gate);
    // hidden for viewer / store_manager / warehouse roles.
    roles: ["analyst", "exec", "admin"],
    items: [
      { label: "Contacts", caption: "Search profiles & 360 view", icon: "user", route: "/crm-contacts" },
      { label: "Tasks", caption: "Follow-up queue", icon: "check-square", route: "/crm-tasks" },
      { label: "Service Tickets", caption: "Cases, SLA & replies", icon: "life-buoy", route: "/crm-tickets" },
      { label: "Loyalty", caption: "Members, tiers & lookup", icon: "gift", route: "/crm-loyalty" },
    ],
  },
  {
    title: "Products & Range",
    items: [
      { label: "Products", caption: "Style & subcategory performance", icon: "shopping-bag", route: "/products" },
      { label: "Margin & Markdown", caption: "Gross margin & discount impact", icon: "percent", route: "/margin" },
      { label: "Markdown & Clearance", caption: "Price-drop candidates & plan", icon: "tag", route: "/markdown" },
    ],
  },
  {
    title: "Inventory",
    items: [
      { label: "Inventory", caption: "Stock on hand, cover & availability", icon: "box", route: "/inventory" },
      { label: "Velocity", caption: "Rate of sale & weeks of cover", icon: "zap", route: "/velocity" },
      { label: "Size Health", caption: "Broken size curve detection", icon: "grid", route: "/size-health" },
    ],
  },
  {
    title: "Planning",
    items: [
      { label: "Targets", caption: "Actuals vs annual / monthly goals", icon: "target", route: "/targets" },
      { label: "Data Quality", caption: "Completeness & sync freshness", icon: "shield", route: "/data-quality" },
    ],
  },
];

export default function MoreScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { logout, user } = useAuth();

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + WEB_TOP_INSET + 8, paddingBottom: 120 },
      ]}
    >
      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>Vivo Fashion Group</Text>
        <Text style={[styles.title, { color: c.foreground }]}>All Reports</Text>
      </View>

      {GROUPS.filter(
        (g) => !g.roles || g.roles.includes(user?.role ?? ""),
      ).map((g) => (
        <View key={g.title} style={styles.group}>
          <Text style={[styles.groupTitle, { color: c.mutedForeground }]}>{g.title}</Text>
          <Card style={styles.groupCard}>
            {g.items.map((it, i) => (
              <Pressable
                key={it.route}
                onPress={() => router.push(it.route as never)}
                style={({ pressed }) => [
                  styles.row,
                  i > 0 ? { borderTopWidth: 1, borderTopColor: c.border } : null,
                  pressed ? { opacity: 0.6 } : null,
                ]}
              >
                <View style={[styles.iconWrap, { backgroundColor: c.muted }]}>
                  <Feather name={it.icon} size={18} color={c.primary} />
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.rowLabel, { color: c.foreground }]}>{it.label}</Text>
                  <Text style={[styles.rowCaption, { color: c.mutedForeground }]} numberOfLines={1}>
                    {it.caption}
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color={c.mutedForeground} />
              </Pressable>
            ))}
          </Card>
        </View>
      ))}

      <View style={styles.group}>
        <Text style={[styles.groupTitle, { color: c.mutedForeground }]}>Account</Text>
        <Card style={styles.groupCard}>
          {user ? (
            <View style={styles.row}>
              <View style={[styles.iconWrap, { backgroundColor: c.muted }]}>
                <Feather name="user" size={18} color={c.primary} />
              </View>
              <View style={styles.rowText}>
                <Text style={[styles.rowLabel, { color: c.foreground }]} numberOfLines={1}>
                  {user.name || user.email}
                </Text>
                <Text style={[styles.rowCaption, { color: c.mutedForeground }]} numberOfLines={1}>
                  {user.email}
                </Text>
              </View>
            </View>
          ) : null}
          <Pressable
            onPress={() => logout()}
            style={({ pressed }) => [
              styles.row,
              { borderTopWidth: 1, borderTopColor: c.border },
              pressed ? { opacity: 0.6 } : null,
            ]}
          >
            <View style={[styles.iconWrap, { backgroundColor: "#fee2e2" }]}>
              <Feather name="log-out" size={18} color={c.destructive} />
            </View>
            <View style={styles.rowText}>
              <Text style={[styles.rowLabel, { color: c.destructive }]}>Sign out</Text>
            </View>
          </Pressable>
        </Card>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, gap: 18 },
  header: { gap: 2 },
  brand: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  title: { fontFamily: "Jakarta_800ExtraBold", fontSize: 26, letterSpacing: -0.6 },
  group: { gap: 8 },
  groupTitle: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingLeft: 4,
  },
  groupCard: { padding: 0, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontFamily: "Jakarta_700Bold", fontSize: 15, letterSpacing: -0.2 },
  rowCaption: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
