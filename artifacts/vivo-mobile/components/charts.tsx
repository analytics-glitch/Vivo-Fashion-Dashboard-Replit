/**
 * Lightweight SVG charts for the Vivo BI mobile app, built on react-native-svg.
 *
 * These mirror the web cockpit's Recharts visuals (donut mix, trend line,
 * category bars) in a mobile-friendly, dependency-light form. All colors come
 * from the shared design tokens so charts match the warm-peach / safari-green
 * identity. No flag glyphs — categories use colored dots + names.
 */
import React, { useState } from "react";
import { LayoutChangeEvent, StyleSheet, Text, View } from "react-native";
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from "react-native-svg";

import { useColors } from "@/hooks/useColors";

export interface Slice {
  label: string;
  value: number;
  color: string;
}

/** Donut / ring chart with a centered value + label. */
export function Donut({
  data,
  size = 168,
  thickness = 24,
  centerValue,
  centerLabel,
}: {
  data: Slice[];
  size?: number;
  thickness?: number;
  centerValue?: string;
  centerLabel?: string;
}) {
  const c = useColors();
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;
  let offset = 0;

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <G rotation={-90} origin={`${cx}, ${cy}`}>
          <Circle
            cx={cx}
            cy={cy}
            r={r}
            stroke={c.muted}
            strokeWidth={thickness}
            fill="none"
          />
          {total > 0 &&
            data.map((d, i) => {
              const frac = Math.max(0, d.value) / total;
              const len = frac * C;
              const el = (
                <Circle
                  key={`${d.label}-${i}`}
                  cx={cx}
                  cy={cy}
                  r={r}
                  stroke={d.color}
                  strokeWidth={thickness}
                  fill="none"
                  strokeDasharray={`${len} ${C - len}`}
                  strokeDashoffset={-offset}
                  strokeLinecap="butt"
                />
              );
              offset += len;
              return el;
            })}
        </G>
      </Svg>
      {(centerValue || centerLabel) && (
        <View style={styles.donutCenter} pointerEvents="none">
          {centerValue ? (
            <Text
              style={[styles.donutValue, { color: c.foreground }]}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {centerValue}
            </Text>
          ) : null}
          {centerLabel ? (
            <Text style={[styles.donutLabel, { color: c.mutedForeground }]}>
              {centerLabel}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** Legend rows for a Donut (colored dot + label + optional value). */
export function Legend({
  items,
}: {
  items: { label: string; color: string; value?: string }[];
}) {
  const c = useColors();
  return (
    <View style={styles.legend}>
      {items.map((it, i) => (
        <View key={`${it.label}-${i}`} style={styles.legendRow}>
          <View style={[styles.legendDot, { backgroundColor: it.color }]} />
          <Text style={[styles.legendLabel, { color: c.foreground }]} numberOfLines={1}>
            {it.label}
          </Text>
          {it.value ? (
            <Text style={[styles.legendValue, { color: c.mutedForeground }]}>
              {it.value}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** Smooth area + line trend (sparkline-style), responsive to container width. */
export function TrendLine({
  data,
  color,
  height = 130,
}: {
  data: number[];
  color?: string;
  height?: number;
}) {
  const c = useColors();
  const [w, setW] = useState(0);
  const col = color ?? c.primary;
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);

  const pad = 6;
  const innerH = height - pad * 2;
  const max = data.length ? Math.max(...data) : 0;
  const min = data.length ? Math.min(...data) : 0;
  const stepX = data.length > 1 && w > 0 ? (w - pad * 2) / (data.length - 1) : 0;
  const yFor = (v: number) =>
    max === min ? height / 2 : pad + innerH - ((v - min) / (max - min)) * innerH;

  let linePath = "";
  let areaPath = "";
  if (w > 0 && data.length > 1) {
    const pts = data.map((v, i) => [pad + i * stepX, yFor(v)] as const);
    linePath = pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
      .join(" ");
    const lastX = pts[pts.length - 1][0];
    areaPath = `${linePath} L ${lastX.toFixed(1)} ${height - pad} L ${pad} ${
      height - pad
    } Z`;
  }

  return (
    <View onLayout={onLayout} style={{ width: "100%", height }}>
      {w > 0 && data.length > 1 ? (
        <Svg width={w} height={height}>
          <Defs>
            <LinearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={col} stopOpacity={0.22} />
              <Stop offset="1" stopColor={col} stopOpacity={0.02} />
            </LinearGradient>
          </Defs>
          <Path d={areaPath} fill="url(#trendFill)" />
          <Path d={linePath} stroke={col} strokeWidth={2.5} fill="none" />
        </Svg>
      ) : null}
    </View>
  );
}

/** Vertical bar chart (responsive). Uses RN views for crisp rendering. */
export function BarChart({
  data,
  height = 170,
  valueFmt,
}: {
  data: { label: string; value: number; color?: string }[];
  height?: number;
  valueFmt?: (n: number) => string;
}) {
  const c = useColors();
  const max = data.reduce((m, d) => Math.max(m, d.value), 0) || 1;
  return (
    <View style={[styles.bars, { height }]}>
      {data.map((d, i) => {
        const h = Math.max(2, (Math.max(0, d.value) / max) * (height - 44));
        return (
          <View key={`${d.label}-${i}`} style={styles.barCol}>
            <Text style={[styles.barValue, { color: c.mutedForeground }]} numberOfLines={1}>
              {valueFmt ? valueFmt(d.value) : String(d.value)}
            </Text>
            <View
              style={[
                styles.barFill,
                { height: h, backgroundColor: d.color ?? c.primary },
              ]}
            />
            <Text style={[styles.barLabel, { color: c.mutedForeground }]} numberOfLines={1}>
              {d.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  donutCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  donutValue: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 22,
    letterSpacing: -0.5,
    maxWidth: "70%",
  },
  donutLabel: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  legend: { gap: 10, flex: 1, justifyContent: "center" },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { fontFamily: "Jakarta_600SemiBold", fontSize: 13, flex: 1 },
  legendValue: { fontFamily: "Jakarta_700Bold", fontSize: 13 },
  bars: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 8,
  },
  barCol: { flex: 1, alignItems: "center", justifyContent: "flex-end", gap: 6 },
  barValue: { fontFamily: "Jakarta_600SemiBold", fontSize: 10 },
  barFill: { width: "70%", borderRadius: 6, minHeight: 2 },
  barLabel: { fontFamily: "Jakarta_500Medium", fontSize: 10, textAlign: "center" },
});
