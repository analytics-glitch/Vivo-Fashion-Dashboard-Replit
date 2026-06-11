/**
 * Shared layout scaffolding for stack (non-tab) screens in the Vivo BI app.
 *
 * Stack screens use the native header for their title + back button, so this
 * scaffold only provides the themed, padded scroll body (with optional
 * pull-to-refresh) plus a couple of layout atoms (KpiGrid, MiniTable, Badge)
 * used across the analytical screens.
 */
import React from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Card } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

/** Themed, padded scroll container for a stack screen body. */
export function Screen({
  children,
  onRefresh,
  refreshing,
}: {
  children: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: insets.bottom + 40,
        gap: 16,
      }}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={!!refreshing}
            onRefresh={onRefresh}
            tintColor={c.primary}
            colors={[c.primary]}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

/** Responsive 2-column grid wrapper for KpiCards. */
export function KpiGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.grid}>{children}</View>;
}

export interface Column {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  flex?: number;
}

/** Compact tabular list inside a Card — for replica-style data tables. */
export function MiniTable({
  columns,
  rows,
}: {
  columns: Column[];
  rows: Record<string, string | number>[];
}) {
  const c = useColors();
  return (
    <Card style={styles.table}>
      <View style={[styles.tr, { backgroundColor: c.muted }]}>
        {columns.map((col) => (
          <Text
            key={col.key}
            style={[
              styles.th,
              { color: c.mutedForeground, flex: col.flex ?? 1, textAlign: col.align ?? "left" },
            ]}
            numberOfLines={1}
          >
            {col.label}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View
          key={i}
          style={[styles.tr, { borderTopWidth: 1, borderTopColor: c.border }]}
        >
          {columns.map((col) => (
            <Text
              key={col.key}
              style={[
                styles.td,
                { color: c.foreground, flex: col.flex ?? 1, textAlign: col.align ?? "left" },
              ]}
              numberOfLines={1}
            >
              {String(r[col.key] ?? "")}
            </Text>
          ))}
        </View>
      ))}
    </Card>
  );
}

export type BadgeTone = "immediate" | "planned" | "good" | "neutral" | "warn";

/** Small pill tag used for urgency / status labels. */
export function Badge({ text, tone = "neutral" }: { text: string; tone?: BadgeTone }) {
  const c = useColors();
  const tones: Record<BadgeTone, { bg: string; fg: string }> = {
    immediate: { bg: "#fee2e2", fg: "#b91c1c" },
    planned: { bg: "#ffedd5", fg: "#c2410c" },
    good: { bg: "#dcfce7", fg: "#15803d" },
    warn: { bg: "#fef3c7", fg: "#b45309" },
    neutral: { bg: c.muted, fg: c.mutedForeground },
  };
  const t = tones[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }]}>
      <Text style={[styles.badgeText, { color: t.fg }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  table: { padding: 0, overflow: "hidden" },
  tr: { flexDirection: "row", paddingHorizontal: 14, paddingVertical: 11, gap: 10 },
  th: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  td: { fontFamily: "Jakarta_600SemiBold", fontSize: 13 },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  badgeText: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 10,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
});
