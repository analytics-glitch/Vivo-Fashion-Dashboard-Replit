import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";
import { countryColor } from "@/constants/colors";
import { PRESETS, PresetKey } from "@/lib/api";
import { useFilters } from "@/lib/filters";

export const WEB_TOP_INSET = Platform.OS === "web" ? 67 : 0;

/** Uppercase, letter-spaced label above a value (matches web "eyebrow"). */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return (
    <Text style={[styles.eyebrow, { color: c.mutedForeground }]}>{children}</Text>
  );
}

/** White elevated card. */
export function Card({
  children,
  style,
  accent,
}: {
  children: React.ReactNode;
  style?: object;
  accent?: boolean;
}) {
  const c = useColors();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: accent ? c.primary : c.card,
          borderColor: accent ? c.primaryDeep : c.border,
          borderRadius: c.radius,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A KPI tile: small eyebrow label + big value + optional sub line. */
export function KpiCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  const c = useColors();
  const fg = accent ? c.primaryForeground : c.foreground;
  const subFg = accent ? "rgba(255,255,255,0.75)" : c.mutedForeground;
  return (
    <Card accent={accent} style={styles.kpiCard}>
      <Text style={[styles.kpiLabel, { color: subFg }]}>{label}</Text>
      <Text style={[styles.kpiValue, { color: fg }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {sub ? <Text style={[styles.kpiSub, { color: subFg }]}>{sub}</Text> : null}
    </Card>
  );
}

/** Section title + optional caption. */
export function SectionHeader({
  title,
  caption,
}: {
  title: string;
  caption?: string;
}) {
  const c = useColors();
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionTitle, { color: c.foreground }]}>{title}</Text>
      {caption ? (
        <Text style={[styles.sectionCaption, { color: c.mutedForeground }]}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

/** Colored country dot + name (no flag glyphs). */
export function CountryLabel({ country }: { country: string }) {
  const c = useColors();
  return (
    <View style={styles.countryLabel}>
      <View style={[styles.dot, { backgroundColor: countryColor(country) }]} />
      <Text style={[styles.countryName, { color: c.foreground }]}>{country}</Text>
    </View>
  );
}

/** Horizontal magnitude bar used in ranked lists. */
export function MagnitudeBar({
  fraction,
  color,
}: {
  fraction: number;
  color: string;
}) {
  const c = useColors();
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <View style={[styles.barTrack, { backgroundColor: c.muted }]}>
      <View
        style={[styles.barFill, { width: `${pct}%`, backgroundColor: color }]}
      />
    </View>
  );
}

/** Date-range preset pills (shared global filter). */
export function PresetPills() {
  const c = useColors();
  const { preset, setPreset } = useFilters();
  return (
    <View style={styles.pills}>
      {PRESETS.map((p) => {
        const active = p.key === preset;
        return (
          <Pressable
            key={p.key}
            onPress={() => setPreset(p.key as PresetKey)}
            style={[
              styles.pill,
              {
                backgroundColor: active ? c.primary : "transparent",
                borderColor: active ? c.primary : c.border,
              },
            ]}
          >
            <Text
              style={[
                styles.pillText,
                { color: active ? c.primaryForeground : c.textSub },
              ]}
            >
              {p.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function LoadingState() {
  const c = useColors();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={c.primary} />
      <Text style={[styles.stateText, { color: c.mutedForeground }]}>
        Loading…
      </Text>
    </View>
  );
}

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  const c = useColors();
  return (
    <View style={styles.center}>
      <Feather name="alert-triangle" size={28} color={c.destructive} />
      <Text style={[styles.stateText, { color: c.foreground }]}>
        Couldn't load data
      </Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          style={[styles.retryBtn, { backgroundColor: c.primary }]}
        >
          <Text style={[styles.retryText, { color: c.primaryForeground }]}>
            Retry
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function EmptyState({ text }: { text: string }) {
  const c = useColors();
  return (
    <View style={styles.center}>
      <Feather name="inbox" size={26} color={c.mutedForeground} />
      <Text style={[styles.stateText, { color: c.mutedForeground }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    padding: 16,
    shadowColor: "#102818",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  kpiCard: {
    flex: 1,
    minWidth: "45%",
    gap: 6,
  },
  kpiLabel: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  kpiValue: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 24,
    letterSpacing: -0.5,
  },
  kpiSub: {
    fontFamily: "Jakarta_500Medium",
    fontSize: 12,
  },
  eyebrow: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.9,
    textTransform: "uppercase",
  },
  sectionHeader: { gap: 2, marginBottom: 12 },
  sectionTitle: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 18,
    letterSpacing: -0.3,
  },
  sectionCaption: { fontFamily: "Jakarta_500Medium", fontSize: 13 },
  countryLabel: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  countryName: { fontFamily: "Jakarta_600SemiBold", fontSize: 15 },
  barTrack: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
    width: "100%",
  },
  barFill: { height: 6, borderRadius: 3 },
  pills: { flexDirection: "row", gap: 8 },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillText: { fontFamily: "Jakarta_600SemiBold", fontSize: 13 },
  center: {
    paddingVertical: 48,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  stateText: { fontFamily: "Jakarta_500Medium", fontSize: 14 },
  retryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
  },
  retryText: { fontFamily: "Jakarta_600SemiBold", fontSize: 14 },
});
