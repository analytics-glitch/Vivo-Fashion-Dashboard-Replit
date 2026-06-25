/**
 * <ProductThumbnail style="Linen Wrap Dress" url={urlFor(style)} />
 *
 * Renders a square product photo for a style. When `url` is falsy (or the
 * image fails to load) it shows a deterministic coloured placeholder with a
 * 2-letter monogram — mirroring the web cockpit's ProductThumbnail so the same
 * style looks the same on both surfaces.
 *
 * The image endpoint (`/api/product-image/<sku>`) is auth-gated, so on native
 * we attach the Bearer token as a request header; on web the session cookie
 * authorizes the same-origin request automatically.
 */
import React, { useState } from "react";
import { Image, Platform, StyleSheet, Text, View } from "react-native";

import { assetUrl, getAuthToken } from "@/lib/api";

const PALETTE = [
  "#F97316", "#FB923C", "#F59E0B",
  "#16A34A", "#059669", "#10B981",
  "#7C3AED", "#DB2777", "#0EA5E9", "#EF4444",
  "#8B5CF6", "#0891B2", "#CA8A04",
];

const hash = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
};

const initialsFor = (s: string): string => {
  const cleaned = (s || "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (cleaned.length === 0) return "?";
  if (cleaned.length === 1) return cleaned[0].slice(0, 2).toUpperCase();
  return (cleaned[0][0] + cleaned[1][0]).toUpperCase();
};

function Placeholder({ style, size }: { style: string; size: number }) {
  const bg = PALETTE[hash(style || "") % PALETTE.length];
  return (
    <View
      style={[
        styles.box,
        { width: size, height: size, backgroundColor: bg },
      ]}
    >
      <Text style={[styles.initials, { fontSize: Math.round(size * 0.38) }]}>
        {initialsFor(style)}
      </Text>
    </View>
  );
}

export function ProductThumbnail({
  style,
  url,
  size = 44,
}: {
  style: string | null | undefined;
  url: string | null | undefined;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const label = style || "";

  if (!url || failed) {
    return <Placeholder style={label} size={size} />;
  }

  const token = getAuthToken();
  const headers =
    Platform.OS !== "web" && token
      ? { Authorization: `Bearer ${token}` }
      : undefined;

  return (
    <Image
      source={{ uri: assetUrl(url), headers }}
      style={[styles.box, { width: size, height: size }]}
      resizeMode="cover"
      onError={() => setFailed(true)}
      accessibilityLabel={label}
    />
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: 8,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  initials: {
    fontFamily: "Jakarta_800ExtraBold",
    color: "#ffffff",
    letterSpacing: -0.3,
  },
});
