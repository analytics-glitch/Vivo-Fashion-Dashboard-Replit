import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Card, ErrorState, LoadingState, WEB_TOP_INSET } from "@/components/ui";
import { countryColor } from "@/constants/colors";
import { useColors } from "@/hooks/useColors";
import {
  COMPARES,
  CompareKey,
  FootfallRow,
  Kpis,
  PRESETS,
  PRESET_MENU_LABEL,
  PresetKey,
  StockoutAlert,
  apiGet,
  compareRange as buildCompareRange,
  presetRange,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  fmtCompact,
  fmtDateLabel,
  fmtDelta,
  fmtKES,
  fmtNum,
  fmtPct,
} from "@/lib/format";

type MenuKind = null | "date" | "compare" | "country";

const RETAIL_SET = "Kenya,Uganda,Rwanda";

const COUNTRY_OPTIONS = [
  { value: "", label: "All countries" },
  { value: RETAIL_SET, label: "Retail markets" },
  { value: "Kenya", label: "Kenya" },
  { value: "Uganda", label: "Uganda" },
  { value: "Rwanda", label: "Rwanda" },
  { value: "Online", label: "Online" },
];

const pctDelta = (cur?: number, prev?: number): number | null => {
  if (cur == null || prev == null || !isFinite(prev) || prev === 0) return null;
  return ((cur - prev) / prev) * 100;
};

export default function OverviewScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { status, logout } = useAuth();

  // The Overview owns its own snapshot filters (today / vs last month),
  // independent of the shared tab filters so it does not re-scope the
  // Markets/Products/Footfall tabs.
  const [preset, setPreset] = React.useState<PresetKey>("today");
  const [compare, setCompare] = React.useState<CompareKey>("last_month");
  const [country, setCountry] = React.useState<string>("");
  const range = React.useMemo(() => presetRange(preset), [preset]);
  const compareRange = React.useMemo(
    () => buildCompareRange(range, compare),
    [range, compare],
  );

  const [menu, setMenu] = React.useState<MenuKind>(null);
  const [bannerOpen, setBannerOpen] = React.useState(true);

  const enabled = status === "authenticated";
  const countryParam = country || undefined;

  const cur = useQuery({
    queryKey: ["kpis", range.date_from, range.date_to, country],
    queryFn: () =>
      apiGet<Kpis>("/kpis", { ...range, country: countryParam }),
    staleTime: 5 * 60_000,
    enabled,
  });

  const prev = useQuery({
    queryKey: ["kpis-prev", compareRange.date_from, compareRange.date_to, country],
    queryFn: () =>
      apiGet<Kpis>("/kpis", { ...compareRange, country: countryParam }),
    staleTime: 5 * 60_000,
    enabled,
  });

  const footfall = useQuery({
    queryKey: ["footfall", range.date_from, range.date_to],
    queryFn: () => apiGet<FootfallRow[]>("/footfall", range),
    staleTime: 5 * 60_000,
    enabled,
  });

  const stockout = useQuery({
    queryKey: ["stockout", country],
    queryFn: () =>
      apiGet<StockoutAlert[]>("/replenishment/stockout-alerts", {
        country: countryParam,
      }),
    staleTime: 5 * 60_000,
    enabled,
  });

  const k = cur.data;
  const p = prev.data;
  const vsLabel = COMPARES.find((x) => x.key === compare)?.vs ?? "vs prior";

  const ffRows = footfall.data ?? [];
  const totalFootfall = ffRows.reduce((s, r) => s + (r.total_footfall || 0), 0);
  const ffOrders = ffRows.reduce((s, r) => s + (r.orders || 0), 0);
  const conversion = totalFootfall > 0 ? (ffOrders * 100) / totalFootfall : 0;

  const stockoutCount = (stockout.data ?? []).length;

  const refreshedAt = cur.dataUpdatedAt
    ? new Date(cur.dataUpdatedAt).toLocaleTimeString("en-GB", {
        timeZone: "Africa/Nairobi",
        hour12: false,
      })
    : "—";

  const segActive =
    country === ""
      ? "all"
      : country === "Online"
        ? "online"
        : country === RETAIL_SET
          ? "retail"
          : "";

  const countryChipLabel =
    country === ""
      ? "All countries"
      : country === RETAIL_SET
        ? "Retail markets"
        : country;

  const go = (path: string) => router.navigate(path as never);

  const refreshAll = () => {
    cur.refetch();
    prev.refetch();
    footfall.refetch();
    stockout.refetch();
  };

  const onShare = async () => {
    if (!k) return;
    try {
      await Share.share({
        message:
          `Vivo Fashion Group — Mobile snapshot\n` +
          `${fmtDateLabel(range.date_from)} -> ${fmtDateLabel(range.date_to)}\n` +
          `Total sales: ${fmtKES(k.total_sales)}\n` +
          `Net sales: ${fmtKES(k.net_sales)}\n` +
          `Transactions: ${fmtNum(k.total_orders)}\n` +
          `Units sold: ${fmtNum(k.total_units)}`,
      });
    } catch {
      // sharing unavailable (e.g. web) — ignore
    }
  };

  const menuConfig: Record<
    Exclude<MenuKind, null>,
    { title: string; options: { value: string; label: string }[]; selected: string; onSelect: (v: string) => void }
  > = {
    date: {
      title: "Date range",
      options: PRESETS.map((x) => ({ value: x.key, label: PRESET_MENU_LABEL[x.key] })),
      selected: preset,
      onSelect: (v) => setPreset(v as PresetKey),
    },
    compare: {
      title: "Compare to",
      options: COMPARES.map((x) => ({ value: x.key, label: x.chip })),
      selected: compare,
      onSelect: (v) => setCompare(v as typeof compare),
    },
    country: {
      title: "Country",
      options: COUNTRY_OPTIONS,
      selected: country,
      onSelect: (v) => setCountry(v),
    },
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {/* Top app bar */}
      <View
        style={[
          styles.topbar,
          {
            paddingTop: insets.top + WEB_TOP_INSET + 8,
            backgroundColor: c.background,
            borderBottomColor: c.border,
          },
        ]}
      >
        <View style={styles.logoBox}>
          <Text style={styles.logoText}>Vivo</Text>
        </View>
        <Text style={[styles.brand, { color: c.foreground }]} numberOfLines={1}>
          Vivo Fashion Group
        </Text>
        <View style={styles.topActions}>
          <IconBtn icon="refresh-cw" onPress={refreshAll} />
          <IconBtn icon="log-out" onPress={() => logout()} />
        </View>
      </View>

      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={[styles.content, { paddingBottom: 120 }]}
      >
        {/* Channel segmented + Share */}
        <View style={styles.segRow}>
          <View style={[styles.segGroup, { borderColor: c.border, backgroundColor: c.card }]}>
            {[
              { key: "all", label: "All", set: "" },
              { key: "retail", label: "Retail", set: RETAIL_SET },
              { key: "online", label: "Online", set: "Online" },
            ].map((s) => {
              const on = segActive === s.key;
              return (
                <Pressable
                  key={s.key}
                  onPress={() => setCountry(s.set)}
                  style={[styles.segItem, on && { backgroundColor: c.primary }]}
                >
                  <Text
                    style={[
                      styles.segText,
                      { color: on ? c.primaryForeground : c.textSub },
                    ]}
                  >
                    {s.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            onPress={onShare}
            style={[styles.shareBtn, { borderColor: c.border, backgroundColor: c.card }]}
          >
            <Feather name="share-2" size={14} color={c.textSub} />
            <Text style={[styles.shareText, { color: c.textSub }]}>Share</Text>
          </Pressable>
        </View>

        {/* Filter chips */}
        <View style={styles.chipsWrap}>
          <Chip
            icon="calendar"
            label={PRESETS.find((x) => x.key === preset)?.label ?? "Today"}
            onPress={() => setMenu("date")}
          />
          <Chip
            icon="calendar"
            label={COMPARES.find((x) => x.key === compare)?.chip ?? "Compare"}
            onPress={() => setMenu("compare")}
          />
          <Chip icon="repeat" label="KES" />
          <Chip
            icon="globe"
            label={`Country: ${countryChipLabel}`}
            onPress={() => setMenu("country")}
            dot={country && country !== RETAIL_SET ? countryColor(country) : undefined}
          />
          <Chip icon="map-pin" label="POS: All POS" />
        </View>

        {/* Date range + vs pill */}
        <View style={styles.rangeRow}>
          <Text style={[styles.rangeText, { color: c.textSub }]}>
            {fmtDateLabel(range.date_from)}  →  {fmtDateLabel(range.date_to)}
          </Text>
          <View style={[styles.vsPill, { backgroundColor: c.muted }]}>
            <Text style={[styles.vsPillText, { color: c.primaryDeep }]}>{vsLabel}</Text>
          </View>
        </View>

        {/* Snapshot + last refreshed */}
        <View style={styles.snapRow}>
          <View style={[styles.snapPill, { borderColor: c.border, backgroundColor: c.card }]}>
            <Feather name="smartphone" size={12} color={c.primary} />
            <Text style={[styles.snapText, { color: c.foreground }]}>Mobile snapshot</Text>
          </View>
          <Text style={[styles.refreshed, { color: c.mutedForeground }]}>
            Last refreshed: {refreshedAt} EAT
          </Text>
        </View>

        {/* Stockout alert banner */}
        {bannerOpen && stockoutCount > 0 ? (
          <Card style={styles.banner}>
            <View style={styles.bannerTop}>
              <Feather name="alert-triangle" size={18} color={c.foreground} />
              <Text style={[styles.bannerText, { color: c.foreground }]}>
                {fmtNum(stockoutCount)} styles stocking out within 2 weeks
              </Text>
              <Pressable onPress={() => setBannerOpen(false)} hitSlop={10}>
                <Feather name="x" size={18} color={c.mutedForeground} />
              </Pressable>
            </View>
            <Pressable
              onPress={() => go("/products")}
              style={[styles.bannerBtn, { borderColor: c.border }]}
            >
              <Text style={[styles.bannerBtnText, { color: c.primaryDeep }]}>
                Review replenishments
              </Text>
            </Pressable>
          </Card>
        ) : null}

        {/* KPI grid */}
        {cur.isLoading ? (
          <LoadingState />
        ) : cur.isError || !k ? (
          <ErrorState onRetry={() => cur.refetch()} />
        ) : (
          <View style={styles.grid}>
            <KpiTile
              accent
              icon="dollar-sign"
              label="Total Sales"
              value={fmtKES(k.total_sales)}
              delta={pctDelta(k.total_sales, p?.total_sales)}
              vsLabel={vsLabel}
              action="See by location"
              onAction={() => go("/markets")}
            />
            <KpiTile
              icon="corner-up-left"
              label="Net Sales"
              value={fmtKES(k.net_sales)}
              delta={pctDelta(k.net_sales, p?.net_sales)}
              vsLabel={vsLabel}
              action="Drill into returns"
              onAction={() => go("/markets")}
            />
            <KpiTile
              icon="shopping-cart"
              label="Transactions"
              value={fmtNum(k.total_orders)}
              delta={pctDelta(k.total_orders, p?.total_orders)}
              vsLabel={vsLabel}
              action="Order detail"
              onAction={() => go("/markets")}
            />
            <KpiTile
              icon="box"
              label="Total Units Sold"
              value={fmtNum(k.total_units)}
              delta={pctDelta(k.total_units, p?.total_units)}
              vsLabel={vsLabel}
              action="Top styles"
              onAction={() => go("/products")}
            />
            <KpiTile
              icon="users"
              label="Total Footfall"
              value={footfall.isLoading ? "…" : fmtNum(totalFootfall)}
              note="Walk-ins counted at our store sensors"
              onAction={() => go("/footfall")}
            />
            <KpiTile
              icon="target"
              label="Conversion Rate"
              value={footfall.isLoading ? "…" : fmtPct(conversion, 2)}
              note="Out of every 100 walk-ins, how many bought"
              onAction={() => go("/footfall")}
            />
          </View>
        )}
      </ScrollView>

      {/* Dropdown menu */}
      <Modal
        transparent
        visible={menu !== null}
        animationType="fade"
        onRequestClose={() => setMenu(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setMenu(null)}>
          <Pressable
            style={[styles.sheet, { backgroundColor: c.card, borderColor: c.border }]}
          >
            {menu ? (
              <>
                <Text style={[styles.sheetTitle, { color: c.foreground }]}>
                  {menuConfig[menu].title}
                </Text>
                {menuConfig[menu].options.map((o) => {
                  const sel = menuConfig[menu].selected === o.value;
                  return (
                    <Pressable
                      key={o.value}
                      onPress={() => {
                        menuConfig[menu].onSelect(o.value);
                        setMenu(null);
                      }}
                      style={styles.sheetRow}
                    >
                      <Text
                        style={[
                          styles.sheetRowText,
                          { color: sel ? c.primary : c.foreground },
                        ]}
                      >
                        {o.label}
                      </Text>
                      {sel ? <Feather name="check" size={18} color={c.primary} /> : null}
                    </Pressable>
                  );
                })}
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function IconBtn({
  icon,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={[styles.iconBtn, { borderColor: c.border, backgroundColor: c.card }]}
    >
      <Feather name={icon} size={17} color={c.textSub} />
    </Pressable>
  );
}

function Chip({
  icon,
  label,
  onPress,
  dot,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  onPress?: () => void;
  dot?: string;
}) {
  const c = useColors();
  const interactive = !!onPress;
  return (
    <Pressable
      onPress={onPress}
      disabled={!interactive}
      style={[styles.chip, { borderColor: c.border, backgroundColor: c.card }]}
    >
      {dot ? (
        <View style={[styles.chipDot, { backgroundColor: dot }]} />
      ) : (
        <Feather name={icon} size={13} color={c.mutedForeground} />
      )}
      <Text style={[styles.chipText, { color: c.foreground }]} numberOfLines={1}>
        {label}
      </Text>
      {interactive ? (
        <Feather name="chevron-down" size={14} color={c.mutedForeground} />
      ) : null}
    </Pressable>
  );
}

function KpiTile({
  icon,
  label,
  value,
  delta,
  vsLabel,
  action,
  note,
  accent,
  onAction,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  delta?: number | null;
  vsLabel?: string;
  action?: string;
  note?: string;
  accent?: boolean;
  onAction?: () => void;
}) {
  const c = useColors();
  const fg = accent ? c.primaryForeground : c.foreground;
  const subFg = accent ? "rgba(255,255,255,0.78)" : c.mutedForeground;
  const down = (delta ?? 0) < 0;
  const deltaColor = accent
    ? down
      ? "#ffb4a8"
      : "#9be7b4"
    : down
      ? c.destructive
      : c.primary;

  return (
    <Pressable
      onPress={onAction}
      style={[
        styles.tile,
        {
          backgroundColor: accent ? c.primary : c.card,
          borderColor: accent ? c.primaryDeep : c.border,
          borderRadius: c.radius,
        },
      ]}
    >
      <View style={styles.tileTop}>
        <Text style={[styles.tileLabel, { color: subFg }]} numberOfLines={1}>
          {label}
        </Text>
        <Feather name={icon} size={15} color={subFg} />
      </View>
      <Text style={[styles.tileValue, { color: fg }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>

      {note ? (
        <Text style={[styles.tileNote, { color: subFg }]} numberOfLines={2}>
          {note}
        </Text>
      ) : (
        <>
          <View style={styles.deltaRow}>
            <Text style={[styles.deltaVs, { color: subFg }]} numberOfLines={1}>
              {vsLabel}
            </Text>
            {delta == null ? (
              <Text style={[styles.deltaPct, { color: subFg }]}>—</Text>
            ) : (
              <>
                <Feather
                  name={down ? "arrow-down-right" : "arrow-up-right"}
                  size={13}
                  color={deltaColor}
                />
                <Text style={[styles.deltaPct, { color: deltaColor }]}>
                  {fmtDelta(delta)}
                </Text>
              </>
            )}
          </View>
          {action ? (
            <View
              style={[
                styles.actionPill,
                {
                  backgroundColor: accent ? "rgba(255,255,255,0.16)" : c.muted,
                },
              ]}
            >
              <Text
                style={[
                  styles.actionText,
                  { color: accent ? c.primaryForeground : c.primaryDeep },
                ]}
                numberOfLines={1}
              >
                {action}
              </Text>
              <Feather
                name="arrow-right"
                size={12}
                color={accent ? c.primaryForeground : c.primaryDeep}
              />
            </View>
          ) : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  logoBox: {
    backgroundColor: "#ea580c",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  logoText: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 16,
    color: "#ffffff",
    letterSpacing: -0.3,
  },
  brand: {
    flex: 1,
    fontFamily: "Jakarta_700Bold",
    fontSize: 15,
    letterSpacing: -0.2,
  },
  topActions: { flexDirection: "row", gap: 8 },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  content: { paddingHorizontal: 16, paddingTop: 14, gap: 14 },

  segRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  segGroup: {
    flex: 1,
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 999,
    padding: 3,
  },
  segItem: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 999,
    alignItems: "center",
  },
  segText: { fontFamily: "Jakarta_600SemiBold", fontSize: 13 },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
  },
  shareText: { fontFamily: "Jakarta_600SemiBold", fontSize: 13 },

  chipsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: "100%",
  },
  chipDot: { width: 9, height: 9, borderRadius: 5 },
  chipText: { fontFamily: "Jakarta_600SemiBold", fontSize: 13 },

  rangeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  rangeText: { fontFamily: "Jakarta_600SemiBold", fontSize: 14 },
  vsPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  vsPillText: { fontFamily: "Jakarta_700Bold", fontSize: 11 },

  snapRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  snapPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  snapText: { fontFamily: "Jakarta_600SemiBold", fontSize: 13 },
  refreshed: { fontFamily: "Jakarta_500Medium", fontSize: 12 },

  banner: { gap: 12 },
  bannerTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  bannerText: { flex: 1, fontFamily: "Jakarta_700Bold", fontSize: 14 },
  bannerBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  bannerBtnText: { fontFamily: "Jakarta_600SemiBold", fontSize: 13 },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    borderWidth: 1,
    padding: 14,
    gap: 8,
    shadowColor: "#102818",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  tileTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  tileLabel: {
    flex: 1,
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  tileValue: { fontFamily: "Jakarta_800ExtraBold", fontSize: 23, letterSpacing: -0.6 },
  tileNote: { fontFamily: "Jakarta_500Medium", fontSize: 12, lineHeight: 16 },
  deltaRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  deltaVs: { fontFamily: "Jakarta_500Medium", fontSize: 11 },
  deltaPct: { fontFamily: "Jakarta_700Bold", fontSize: 12 },
  actionPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    marginTop: 2,
  },
  actionText: { fontFamily: "Jakarta_600SemiBold", fontSize: 12 },

  backdrop: {
    flex: 1,
    backgroundColor: "rgba(15,24,16,0.35)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 36,
    gap: 4,
  },
  sheetTitle: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 16,
    marginBottom: 8,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
  },
  sheetRowText: { fontFamily: "Jakarta_600SemiBold", fontSize: 15 },
});
