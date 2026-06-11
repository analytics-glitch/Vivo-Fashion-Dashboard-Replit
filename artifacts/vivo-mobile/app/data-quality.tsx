import { useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  KpiCard,
  LoadingState,
  SectionHeader,
} from "@/components/ui";
import { Badge, BadgeTone, KpiGrid, MiniTable, Screen } from "@/components/screen";
import { useColors } from "@/hooks/useColors";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtNum, fmtPct } from "@/lib/format";

interface DqCheck {
  check: string;
  score: number;
  detail?: string;
  status?: string;
  failing_locations?: string[];
}

interface DqReport {
  overall_score: number;
  checks: DqCheck[];
  checked_at: string;
}

interface SkuSource {
  source: string;
  store_id: string;
  total_sku_lines: number;
  pct_matched: number;
  pct_with_cost: number;
  pct_with_subcategory: number;
  pct_with_size: number;
}

interface SkuCoverage {
  sources: SkuSource[];
  total: number;
}

interface SyncCheck {
  checked_at: string | null;
  api_healthy: boolean;
  sync_healthy: boolean;
  action_taken: string | null;
  notes: string | null;
}

interface SyncStatus {
  health: string;
  last_sync_at: string | null;
  minutes_since: number | null;
  last_status: string | null;
  data_freshness: {
    last_loaded_at: string | null;
    minutes_since: number | null;
  } | null;
  last_check: SyncCheck | null;
}

const humanize = (s: string): string =>
  (s || "").replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());

const fmtTs = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const fmtAgo = (mins: number | null | undefined): string => {
  if (mins === null || mins === undefined || isNaN(Number(mins))) return "—";
  const m = Math.max(0, Math.round(Number(mins)));
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
};

const healthTone = (health?: string): BadgeTone => {
  if (health === "OK") return "good";
  if (health === "WARNING") return "warn";
  return "immediate";
};

export default function DataQualityScreen() {
  const c = useColors();
  const { status } = useAuth();
  const enabled = status === "authenticated";

  const reportQ = useQuery({
    queryKey: ["dq-report"],
    queryFn: () => apiGet<DqReport>("/data-quality/report"),
    staleTime: 5 * 60_000,
    enabled,
  });

  const coverageQ = useQuery({
    queryKey: ["dq-sku-coverage"],
    queryFn: () => apiGet<SkuCoverage>("/data-quality/sku-coverage"),
    staleTime: 5 * 60_000,
    enabled,
  });

  const syncQ = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => apiGet<SyncStatus>("/sync-status"),
    staleTime: 5 * 60_000,
    enabled,
  });

  const refetchAll = () => {
    reportQ.refetch();
    coverageQ.refetch();
    syncQ.refetch();
  };

  const report = reportQ.data;
  const checks = report?.checks ?? [];
  const sources = (coverageQ.data?.sources ?? [])
    .slice()
    .sort((a, b) => b.total_sku_lines - a.total_sku_lines);
  const sync = syncQ.data;

  // Coverage rollup: total-line-weighted match rate across sources.
  const totalLines = sources.reduce((s, r) => s + r.total_sku_lines, 0);
  const wAvgMatched = totalLines
    ? sources.reduce((s, r) => s + r.pct_matched * r.total_sku_lines, 0) /
      totalLines
    : 0;

  return (
    <Screen
      onRefresh={refetchAll}
      refreshing={reportQ.isFetching || coverageQ.isFetching || syncQ.isFetching}
    >
      <Stack.Screen options={{ title: "Data Quality" }} />

      {reportQ.isLoading ? (
        <LoadingState />
      ) : reportQ.isError ? (
        <ErrorState onRetry={refetchAll} />
      ) : !report ? (
        <EmptyState text="Data quality report unavailable" />
      ) : (
        <>
          <KpiGrid>
            <KpiCard
              label="Overall Score"
              value={fmtPct(report.overall_score)}
              sub={
                report.overall_score > 90
                  ? "Healthy"
                  : report.overall_score >= 75
                    ? "Watch"
                    : "At risk"
              }
              accent
            />
            <KpiCard
              label="SKU Coverage"
              value={fmtPct(wAvgMatched)}
              sub="matched (90d)"
            />
            <KpiCard label="Checks" value={fmtNum(checks.length)} />
            <KpiCard label="Sources" value={fmtNum(sources.length)} />
          </KpiGrid>

          {syncQ.isError ? (
            <Card style={styles.syncCard}>
              <Eyebrow>Sync Freshness</Eyebrow>
              <Text style={[styles.syncSub, { color: c.destructive }]}>
                Unable to load sync status
              </Text>
            </Card>
          ) : sync ? (
            <Card style={styles.syncCard}>
              <View style={styles.syncTop}>
                <Eyebrow>Sync Freshness</Eyebrow>
                <Badge text={sync.health} tone={healthTone(sync.health)} />
              </View>
              <Text style={[styles.syncMain, { color: c.foreground }]}>
                {fmtTs(sync.last_sync_at)}
              </Text>
              <Text style={[styles.syncSub, { color: c.mutedForeground }]}>
                Last sync cycle · {fmtAgo(sync.minutes_since)}
                {sync.last_status ? ` · ${sync.last_status}` : ""}
              </Text>
              {sync.data_freshness ? (
                <Text style={[styles.syncSub, { color: c.mutedForeground }]}>
                  Latest data load ·{" "}
                  {fmtAgo(sync.data_freshness.minutes_since)}
                </Text>
              ) : null}
              {sync.last_check ? (
                <Text style={[styles.syncSub, { color: c.mutedForeground }]}>
                  Health check {fmtTs(sync.last_check.checked_at)} · API{" "}
                  {sync.last_check.api_healthy ? "healthy" : "down"} · Sync{" "}
                  {sync.last_check.sync_healthy ? "healthy" : "down"}
                </Text>
              ) : null}
            </Card>
          ) : null}

          <SectionHeader
            title="Quality Checks"
            caption="Each check scores 0–100; overall is the mean"
          />
          {checks.length === 0 ? (
            <EmptyState text="No individual checks returned" />
          ) : (
            <View style={styles.list}>
              {checks.map((ck) => {
                const ok = ck.status ? ck.status === "ok" : ck.score >= 80;
                return (
                  <Card key={ck.check} style={styles.checkRow}>
                    <View style={styles.checkTop}>
                      <Text
                        style={[styles.checkName, { color: c.foreground }]}
                        numberOfLines={1}
                      >
                        {humanize(ck.check)}
                      </Text>
                      <View style={styles.checkRight}>
                        <Text
                          style={[
                            styles.checkScore,
                            { color: ok ? c.primary : c.destructive },
                          ]}
                        >
                          {fmtPct(ck.score)}
                        </Text>
                        <Badge
                          text={ok ? "OK" : "Alert"}
                          tone={ok ? "good" : "warn"}
                        />
                      </View>
                    </View>
                    {ck.detail ? (
                      <Text
                        style={[styles.checkDetail, { color: c.mutedForeground }]}
                      >
                        {ck.detail}
                      </Text>
                    ) : null}
                  </Card>
                );
              })}
            </View>
          )}

          <SectionHeader
            title="SKU Coverage by Source"
            caption="Share of recent sale lines (90d) matching a product"
          />
          {coverageQ.isLoading ? (
            <LoadingState />
          ) : coverageQ.isError ? (
            <ErrorState onRetry={() => coverageQ.refetch()} />
          ) : sources.length === 0 ? (
            <EmptyState text="SKU coverage data unavailable" />
          ) : (
            <MiniTable
              columns={[
                { key: "source", label: "Source", flex: 1.4 },
                { key: "lines", label: "Lines", align: "right" },
                { key: "matched", label: "% Match", align: "right", flex: 0.9 },
                { key: "cost", label: "% Cost", align: "right", flex: 0.9 },
              ]}
              rows={sources.map((r) => ({
                source: r.source,
                lines: fmtNum(r.total_sku_lines),
                matched: fmtPct(r.pct_matched, 0),
                cost: fmtPct(r.pct_with_cost, 0),
              }))}
            />
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  syncCard: { gap: 4 },
  syncTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  syncMain: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 20,
    letterSpacing: -0.4,
  },
  syncSub: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
  list: { gap: 12 },
  checkRow: { gap: 6 },
  checkTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  checkName: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 14,
    flex: 1,
    letterSpacing: -0.2,
  },
  checkRight: { flexDirection: "row", alignItems: "center", gap: 8 },
  checkScore: { fontFamily: "Jakarta_800ExtraBold", fontSize: 16 },
  checkDetail: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
});
