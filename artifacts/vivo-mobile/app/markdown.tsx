import { Stack } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  Card,
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingState,
  MagnitudeBar,
  SectionHeader,
} from "@/components/ui";
import { Badge, KpiGrid, Screen } from "@/components/screen";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { useColors } from "@/hooks/useColors";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useThumbnails } from "@/lib/thumbnails";
import { fmtKES, fmtNum, fmtPct } from "@/lib/format";

// GET /api/analytics/markdown-candidates — slow-moving, overstocked styles
// flagged for a price markdown (country filter only, no dates).
interface MarkdownCandidate {
  style_name: string | null;
  brand: string | null;
  subcategory: string | null;
  affected_stores: string;
  total_units: number;
  current_woc: number;
  sell_through_8wk: number;
  trend_bucket: string;
  estimated_markdown_revenue_kes: number;
  recommended_markdown_pct: number;
}

interface MarkdownResponse {
  candidates: MarkdownCandidate[];
  total: number;
  total_units: number;
  estimated_recovery_kes: number;
}

// GET /api/analytics/clearance-plan — store-level clearance schedule split by
// urgency (immediate = WoC > 26, planned = 16 < WoC <= 26).
interface ClearanceStyle {
  style_name: string | null;
  recommended_markdown_pct: number;
  total_units: number;
  current_woc: number;
}

interface ClearanceGroup {
  count: number;
  total_units: number;
  estimated_recovery_kes: number;
  by_store: Record<string, ClearanceStyle[]>;
}

interface ClearanceResponse {
  season_timing: string;
  immediate: ClearanceGroup;
  planned: ClearanceGroup;
}

export default function MarkdownScreen() {
  const c = useColors();
  const { status } = useAuth();
  const enabled = status === "authenticated";

  const mk = useQuery({
    queryKey: ["markdown-candidates"],
    queryFn: () => apiGet<MarkdownResponse>("/analytics/markdown-candidates"),
    staleTime: 5 * 60_000,
    enabled,
  });

  const cp = useQuery({
    queryKey: ["clearance-plan"],
    queryFn: () => apiGet<ClearanceResponse>("/analytics/clearance-plan"),
    staleTime: 5 * 60_000,
    enabled,
  });

  const refetch = () => {
    mk.refetch();
    cp.refetch();
  };

  const candidates = mk.data?.candidates ?? [];
  const ranked = [...candidates]
    .sort(
      (a, b) =>
        b.estimated_markdown_revenue_kes - a.estimated_markdown_revenue_kes,
    )
    .slice(0, 25);
  const maxUnits = ranked.reduce((m, r) => Math.max(m, r.total_units), 0);
  const { urlFor } = useThumbnails(ranked.map((r) => r.style_name));
  const avgMd = candidates.length
    ? candidates.reduce((s, r) => s + Number(r.recommended_markdown_pct || 0), 0) /
      candidates.length
    : 0;

  const wocColor = (woc: number): string => {
    if (woc > 52) return c.destructive;
    if (woc > 26) return c.amber;
    return c.mutedForeground;
  };

  const stColor = (st: number): string => {
    if (st < 10) return c.destructive;
    if (st < 20) return c.amber;
    return c.foreground;
  };

  const loading = mk.isLoading || cp.isLoading;
  const error = mk.isError || cp.isError;
  const refreshing = mk.isFetching || cp.isFetching;

  return (
    <>
      <Stack.Screen options={{ title: "Markdown & Clearance" }} />
      <Screen onRefresh={refetch} refreshing={refreshing}>
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState onRetry={refetch} />
        ) : (
          <>
            <KpiGrid>
              <KpiCard
                label="Candidates"
                value={fmtNum(mk.data?.total || 0)}
                sub="Overstocked, slow styles"
                accent
              />
              <KpiCard
                label="Units to Clear"
                value={fmtNum(mk.data?.total_units || 0)}
              />
              <KpiCard
                label="Est. Recovery"
                value={fmtKES(mk.data?.estimated_recovery_kes || 0)}
                sub="At recommended markdown"
              />
              <KpiCard label="Avg Markdown" value={fmtPct(avgMd, 0)} />
            </KpiGrid>

            <SectionHeader
              title={`Markdown Candidates · ${candidates.length}`}
              caption="High weeks-of-cover, weak 8-week sell-through"
            />
            {candidates.length === 0 ? (
              <EmptyState text="No markdown candidates right now" />
            ) : (
              <View style={styles.list}>
                {ranked.map((r, i) => (
                  <Card key={`${r.style_name}-${i}`} style={styles.row}>
                    <View style={styles.rowTop}>
                      <ProductThumbnail style={r.style_name} url={urlFor(r.style_name)} size={44} />
                      <Text
                        style={[styles.name, { color: c.foreground }]}
                        numberOfLines={2}
                      >
                        {r.style_name || "—"}
                      </Text>
                      <Text style={[styles.mdPct, { color: c.primaryDeep }]}>
                        -{fmtNum(r.recommended_markdown_pct)}%
                      </Text>
                    </View>
                    <View style={styles.tagRow}>
                      {r.brand ? <Badge text={r.brand} tone="neutral" /> : null}
                      {r.subcategory ? (
                        <Badge text={r.subcategory} tone="neutral" />
                      ) : null}
                      <Badge
                        text={r.trend_bucket}
                        tone={
                          r.trend_bucket === "DYING" ? "immediate" : "planned"
                        }
                      />
                    </View>
                    <MagnitudeBar
                      fraction={maxUnits ? r.total_units / maxUnits : 0}
                      color={wocColor(r.current_woc)}
                    />
                    <View style={styles.rowMeta}>
                      <Text style={[styles.meta, { color: c.mutedForeground }]}>
                        {fmtNum(r.total_units)} units ·{" "}
                        <Text style={{ color: wocColor(r.current_woc) }}>
                          {fmtNum(r.current_woc)}w cover
                        </Text>
                      </Text>
                      <Text
                        style={[
                          styles.meta,
                          { color: stColor(r.sell_through_8wk) },
                        ]}
                      >
                        {fmtPct(r.sell_through_8wk)} sell-through
                      </Text>
                    </View>
                    <View style={styles.rowMeta}>
                      <Text
                        style={[styles.recovery, { color: c.primary }]}
                      >
                        {fmtKES(r.estimated_markdown_revenue_kes)} est. revenue
                      </Text>
                    </View>
                    {r.affected_stores ? (
                      <Text
                        style={[styles.stores, { color: c.mutedForeground }]}
                        numberOfLines={2}
                      >
                        {r.affected_stores}
                      </Text>
                    ) : null}
                  </Card>
                ))}
              </View>
            )}

            <SectionHeader
              title="Clearance Plan"
              caption={cp.data?.season_timing || "Schedule split by urgency"}
            />
            {cp.data &&
            (cp.data.immediate.count > 0 || cp.data.planned.count > 0) ? (
              <View style={styles.list}>
                <ClearanceSection
                  title="Immediate"
                  tone="immediate"
                  intro="Critical overstock (over 26 weeks of cover) — mark down now."
                  group={cp.data.immediate}
                />
                <ClearanceSection
                  title="Planned"
                  tone="planned"
                  intro="Building overstock (16–26 weeks) — schedule into next window."
                  group={cp.data.planned}
                />
              </View>
            ) : (
              <EmptyState text="No clearance actions required" />
            )}
          </>
        )}
      </Screen>
    </>
  );
}

function ClearanceSection({
  title,
  tone,
  intro,
  group,
}: {
  title: string;
  tone: "immediate" | "planned";
  intro: string;
  group: ClearanceGroup;
}) {
  const c = useColors();
  const byStore = group.by_store || {};
  const stores = Object.keys(byStore).sort(
    (a, b) => byStore[b].length - byStore[a].length,
  );
  const accent = tone === "immediate" ? c.destructive : c.amber;

  return (
    <Card style={[styles.clearCard, { borderLeftColor: accent, borderLeftWidth: 4 }]}>
      <View style={styles.clearHead}>
        <Badge text={title} tone={tone} />
        <Text style={[styles.clearStats, { color: c.mutedForeground }]}>
          {fmtNum(group.count)} styles · {fmtNum(group.total_units)} units
        </Text>
      </View>
      <Text style={[styles.clearIntro, { color: c.mutedForeground }]}>
        {intro}
      </Text>
      <Text style={[styles.clearRecovery, { color: accent }]}>
        {fmtKES(group.estimated_recovery_kes)} est. recovery
      </Text>

      {stores.length === 0 ? (
        <Text style={[styles.clearIntro, { color: c.mutedForeground }]}>
          No styles in this urgency band.
        </Text>
      ) : (
        <View style={styles.storeList}>
          {stores.map((store) => (
            <View
              key={store}
              style={[styles.storeBlock, { backgroundColor: c.muted }]}
            >
              <View style={styles.storeHead}>
                <Text
                  style={[styles.storeName, { color: c.foreground }]}
                  numberOfLines={1}
                >
                  {store}
                </Text>
                <Text style={[styles.storeCount, { color: c.mutedForeground }]}>
                  {byStore[store].length} styles
                </Text>
              </View>
              {byStore[store].map((s, i) => (
                <View key={`${s.style_name}-${i}`} style={styles.styleRow}>
                  <Text
                    style={[styles.styleName, { color: c.foreground }]}
                    numberOfLines={1}
                  >
                    {s.style_name || "—"}
                  </Text>
                  <Text style={[styles.styleMd, { color: c.primaryDeep }]}>
                    -{fmtNum(s.recommended_markdown_pct)}%
                  </Text>
                  <Text style={[styles.styleMeta, { color: c.mutedForeground }]}>
                    {fmtNum(s.total_units)}u · {fmtNum(s.current_woc)}w
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12 },
  row: { gap: 10 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  name: { fontFamily: "Jakarta_700Bold", fontSize: 15, flex: 1, letterSpacing: -0.2 },
  mdPct: { fontFamily: "Jakarta_800ExtraBold", fontSize: 18, letterSpacing: -0.3 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  rowMeta: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
  recovery: { fontFamily: "Jakarta_700Bold", fontSize: 13 },
  stores: { fontFamily: "Jakarta_500Medium", fontSize: 11 },
  clearCard: { gap: 8 },
  clearHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  clearStats: { fontFamily: "Jakarta_600SemiBold", fontSize: 12 },
  clearIntro: { fontFamily: "Jakarta_500Medium", fontSize: 12, lineHeight: 17 },
  clearRecovery: { fontFamily: "Jakarta_800ExtraBold", fontSize: 16, letterSpacing: -0.3 },
  storeList: { gap: 10, marginTop: 2 },
  storeBlock: { borderRadius: 10, padding: 12, gap: 8 },
  storeHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  storeName: { fontFamily: "Jakarta_700Bold", fontSize: 13, flex: 1 },
  storeCount: { fontFamily: "Jakarta_600SemiBold", fontSize: 11 },
  styleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  styleName: { fontFamily: "Jakarta_600SemiBold", fontSize: 12, flex: 1 },
  styleMd: { fontFamily: "Jakarta_800ExtraBold", fontSize: 13 },
  styleMeta: { fontFamily: "Jakarta_500Medium", fontSize: 11 },
});
