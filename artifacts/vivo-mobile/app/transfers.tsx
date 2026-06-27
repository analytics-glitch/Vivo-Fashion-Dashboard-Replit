import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import React from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Badge, Screen } from "@/components/screen";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionHeader,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  apiGet,
  apiPost,
  IbtFreshness,
  IbtScanInResult,
  IbtTransfer,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";

const FILTERS = [
  { key: "in_transit", label: "In transit" },
  { key: "received", label: "Received" },
  { key: "discrepancy", label: "Discrepancy" },
  { key: "overdue", label: "Overdue" },
];

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : Number(n).toLocaleString();

const skuLine = (t: IbtTransfer) =>
  [t.color, t.size, t.sku].filter(Boolean).join(" · ") || "—";

export default function TransfersScreen() {
  const c = useColors();
  const router = useRouter();
  const qc = useQueryClient();
  const { status } = useAuth();
  const enabled = status === "authenticated";

  const [filter, setFilter] = React.useState("in_transit");
  const [scanIn, setScanIn] = React.useState<IbtTransfer | null>(null);

  const freshnessQ = useQuery({
    queryKey: ["ibt-freshness"],
    queryFn: () => apiGet<IbtFreshness>("/ibt/freshness"),
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled,
  });
  const stale = !!freshnessQ.data?.stale;

  const transfersQ = useQuery({
    queryKey: ["ibt-transfers", filter],
    queryFn: () =>
      apiGet<IbtTransfer[]>("/ibt/transfers", { status: filter, days: 120 }),
    staleTime: 30_000,
    enabled,
  });

  const rows = transfersQ.data ?? [];

  const refresh = () => {
    freshnessQ.refetch();
    transfersQ.refetch();
  };

  return (
    <Screen onRefresh={refresh} refreshing={transfersQ.isFetching}>
      <Stack.Screen options={{ title: "Stock Transfers" }} />

      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>Operations</Text>
        <Text style={[styles.title, { color: c.foreground }]}>
          Stock Transfers
        </Text>
        <Text style={[styles.sub, { color: c.mutedForeground }]}>
          Scan stock out of a donor store and receive it at the destination.
        </Text>
      </View>

      <FreshnessBanner f={freshnessQ.data} />

      <Pressable
        onPress={() => router.push("/transfer-suggestions" as never)}
        style={({ pressed }) => [
          styles.cta,
          { backgroundColor: c.primary },
          pressed && { opacity: 0.7 },
        ]}
      >
        <Feather name="truck" size={16} color={c.primaryForeground} />
        <Text style={[styles.ctaText, { color: c.primaryForeground }]}>
          Scan out a suggested move
        </Text>
        <Feather name="chevron-right" size={16} color={c.primaryForeground} />
      </Pressable>

      <View style={styles.segments}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={[
                styles.seg,
                {
                  backgroundColor: active ? c.primary : c.card,
                  borderColor: active ? c.primary : c.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.segText,
                  { color: active ? c.primaryForeground : c.mutedForeground },
                ]}
              >
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {transfersQ.isLoading ? (
        <LoadingState />
      ) : transfersQ.isError ? (
        <ErrorState onRetry={transfersQ.refetch} />
      ) : rows.length === 0 ? (
        <EmptyState
          text={
            filter === "in_transit"
              ? "Nothing in transit — scan a move out to start a consignment."
              : "No consignments here."
          }
        />
      ) : (
        <View>
          <SectionHeader title={`${rows.length} consignments`} />
          <View style={styles.list}>
            {rows.map((t) => (
              <Card key={t.consignment_id} style={styles.row}>
                <View style={styles.rowTop}>
                  <Text style={[styles.cid, { color: c.primaryDeep }]}>
                    {t.consignment_id}
                  </Text>
                  <View style={styles.badges}>
                    {t.overdue ? <Badge text="Overdue" tone="immediate" /> : null}
                    <Badge
                      text={t.status.replace("_", " ")}
                      tone={
                        t.status === "received"
                          ? "good"
                          : t.status === "discrepancy"
                            ? "warn"
                            : "planned"
                      }
                    />
                  </View>
                </View>

                <View style={styles.route}>
                  <Text
                    style={[styles.store, { color: c.foreground }]}
                    numberOfLines={1}
                  >
                    {t.from_store}
                  </Text>
                  <Feather name="arrow-right" size={13} color={c.primary} />
                  <Text
                    style={[styles.store, { color: c.primary }]}
                    numberOfLines={1}
                  >
                    {t.to_store}
                  </Text>
                </View>

                <Text
                  style={[styles.style, { color: c.foreground }]}
                  numberOfLines={1}
                >
                  {t.style_name || "—"}
                </Text>
                <Text
                  style={[styles.meta, { color: c.mutedForeground }]}
                  numberOfLines={1}
                >
                  {skuLine(t)}
                </Text>

                <View style={styles.statsRow}>
                  <Stat label="Qty" value={fmt(t.qty)} c={c} />
                  {t.status === "in_transit" ? (
                    <Stat label="In transit" value={`${fmt(t.days_in_transit)}d`} c={c} />
                  ) : (
                    <Stat
                      label="Received"
                      value={fmt(t.received_qty)}
                      c={c}
                    />
                  )}
                  <Stat
                    label="Route"
                    value={t.via_hub ? "via hub" : "same-mall"}
                    c={c}
                  />
                </View>

                {t.status === "discrepancy" &&
                t.received_qty != null &&
                t.received_qty !== t.qty ? (
                  <Text style={[styles.disc, { color: c.amber }]}>
                    {t.received_qty < t.qty
                      ? `Short by ${fmt(t.qty - t.received_qty)} unit(s)`
                      : `Overage of ${fmt(t.received_qty - t.qty)} unit(s)`}
                  </Text>
                ) : null}

                {t.status === "in_transit" ? (
                  <Pressable
                    disabled={stale}
                    onPress={() => !stale && setScanIn(t)}
                    style={({ pressed }) => [
                      styles.scanBtn,
                      {
                        backgroundColor: stale ? c.muted : "#059669",
                      },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Feather
                      name={stale ? "lock" : "package"}
                      size={14}
                      color={stale ? c.mutedForeground : "#ffffff"}
                    />
                    <Text
                      style={[
                        styles.scanText,
                        { color: stale ? c.mutedForeground : "#ffffff" },
                      ]}
                    >
                      {stale ? "Receiving locked" : "Scan in"}
                    </Text>
                  </Pressable>
                ) : null}
              </Card>
            ))}
          </View>
        </View>
      )}

      <ScanInModal
        transfer={scanIn}
        onClose={() => setScanIn(null)}
        onDone={() => {
          setScanIn(null);
          qc.invalidateQueries({ queryKey: ["ibt-transfers"] });
          freshnessQ.refetch();
        }}
      />
    </Screen>
  );
}

function Stat({
  label,
  value,
  c,
}: {
  label: string;
  value: string;
  c: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: c.mutedForeground }]}>
        {label}
      </Text>
      <Text style={[styles.statValue, { color: c.foreground }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/** Amber soft-lock banner shown when the sales sync is behind SLA. */
export function FreshnessBanner({ f }: { f?: IbtFreshness }) {
  const c = useColors();
  if (!f) return null;
  if (!f.stale) {
    return (
      <View style={[styles.fresh, { backgroundColor: "#dcfce7" }]}>
        <Feather name="check-circle" size={14} color="#15803d" />
        <Text style={[styles.freshText, { color: "#15803d" }]}>
          Stock figures fresh · as of {f.as_of_eat} EAT
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.fresh, { backgroundColor: "#fef3c7" }]}>
      <Feather name="alert-triangle" size={14} color="#b45309" />
      <Text style={[styles.freshText, { color: "#b45309" }]}>
        Sales sync is behind SLA — scan actions are locked until figures refresh
        {f.sync_lag_min != null ? ` (${Math.round(f.sync_lag_min)} min behind)` : ""}.
      </Text>
    </View>
  );
}

function ScanInModal({
  transfer,
  onClose,
  onDone,
}: {
  transfer: IbtTransfer | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const c = useColors();
  const [received, setReceived] = React.useState("");
  const [odooRef, setOdooRef] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (transfer) {
      setReceived(String(transfer.qty));
      setOdooRef(transfer.odoo_transfer_id ?? "");
      setError(null);
    }
  }, [transfer]);

  const scanIn = useMutation({
    mutationFn: () =>
      apiPost<IbtScanInResult>("/ibt/scan-in", {
        consignment_id: transfer!.consignment_id,
        received_qty: Number(received),
        odoo_transfer_id: odooRef.trim() || null,
      }),
    onSuccess: onDone,
    onError: (e: Error) => setError(e.message),
  });

  const dispatched = transfer?.qty ?? 0;
  const recNum = Number(received);
  const willDiscrepancy =
    received !== "" && Number.isFinite(recNum) && recNum !== dispatched;
  const shortfall = Math.max(dispatched - (Number.isFinite(recNum) ? recNum : 0), 0);

  return (
    <Modal
      visible={!!transfer}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: c.card }]}>
          <View style={styles.sheetHead}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sheetTitle, { color: c.foreground }]}>
                Scan in — receive transfer
              </Text>
              {transfer ? (
                <Text style={[styles.sheetSub, { color: c.mutedForeground }]}>
                  {transfer.from_store} → {transfer.to_store} ·{" "}
                  {transfer.consignment_id}
                </Text>
              ) : null}
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <Feather name="x" size={20} color={c.mutedForeground} />
            </Pressable>
          </View>

          <View style={styles.fieldRow}>
            <View style={styles.field}>
              <Text style={[styles.label, { color: c.mutedForeground }]}>
                Dispatched
              </Text>
              <View
                style={[
                  styles.readonly,
                  { backgroundColor: c.muted, borderColor: c.border },
                ]}
              >
                <Text style={[styles.readonlyText, { color: c.foreground }]}>
                  {fmt(dispatched)} units
                </Text>
              </View>
            </View>
            <View style={styles.field}>
              <Text style={[styles.label, { color: c.mutedForeground }]}>
                Received
              </Text>
              <TextInput
                value={received}
                onChangeText={setReceived}
                keyboardType="number-pad"
                style={[
                  styles.input,
                  { color: c.foreground, borderColor: c.border },
                ]}
              />
            </View>
          </View>

          {willDiscrepancy ? (
            <View style={[styles.note, { backgroundColor: "#fef3c7" }]}>
              <Feather name="alert-triangle" size={14} color="#b45309" />
              <Text style={[styles.noteText, { color: "#b45309" }]}>
                {recNum > dispatched
                  ? `Overage of ${fmt(recNum - dispatched)} — will be flagged as a discrepancy.`
                  : `Short by ${fmt(shortfall)} unit(s) — will be flagged as a discrepancy.`}
              </Text>
            </View>
          ) : (
            <View style={[styles.note, { backgroundColor: "#dcfce7" }]}>
              <Feather name="check-circle" size={14} color="#15803d" />
              <Text style={[styles.noteText, { color: "#15803d" }]}>
                Full receipt — all {fmt(dispatched)} units accounted for.
              </Text>
            </View>
          )}

          <Text style={[styles.label, { color: c.mutedForeground }]}>
            Odoo transfer ref (optional)
          </Text>
          <TextInput
            value={odooRef}
            onChangeText={setOdooRef}
            placeholder="e.g. WH/IN/01234"
            placeholderTextColor={c.mutedForeground}
            style={[styles.input, { color: c.foreground, borderColor: c.border }]}
          />

          {error ? (
            <View style={[styles.note, { backgroundColor: "#fee2e2" }]}>
              <Feather name="alert-circle" size={14} color="#b91c1c" />
              <Text style={[styles.noteText, { color: "#b91c1c" }]}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.6 }]}
            >
              <Text style={[styles.cancelText, { color: c.mutedForeground }]}>
                Cancel
              </Text>
            </Pressable>
            <Pressable
              disabled={received === "" || scanIn.isPending}
              onPress={() => {
                setError(null);
                scanIn.mutate();
              }}
              style={({ pressed }) => [
                styles.submitBtn,
                {
                  backgroundColor:
                    received === "" || scanIn.isPending ? c.muted : "#059669",
                },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Feather
                name="package"
                size={14}
                color={
                  received === "" || scanIn.isPending ? c.mutedForeground : "#ffffff"
                }
              />
              <Text
                style={[
                  styles.submitText,
                  {
                    color:
                      received === "" || scanIn.isPending
                        ? c.mutedForeground
                        : "#ffffff",
                  },
                ]}
              >
                {scanIn.isPending ? "Receiving…" : "Scan in"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: { gap: 3 },
  brand: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  title: { fontFamily: "Jakarta_800ExtraBold", fontSize: 26, letterSpacing: -0.6 },
  sub: { fontFamily: "Jakarta_500Medium", fontSize: 13 },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  ctaText: { flex: 1, fontFamily: "Jakarta_700Bold", fontSize: 14 },
  segments: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  seg: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  segText: { fontFamily: "Jakarta_700Bold", fontSize: 12 },
  list: { gap: 12 },
  row: { gap: 7 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  cid: { fontFamily: "Jakarta_700Bold", fontSize: 12, letterSpacing: 0.4 },
  badges: { flexDirection: "row", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" },
  route: { flexDirection: "row", alignItems: "center", gap: 8 },
  store: { fontFamily: "Jakarta_700Bold", fontSize: 14, flexShrink: 1 },
  style: { fontFamily: "Jakarta_700Bold", fontSize: 14, letterSpacing: -0.2 },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
  statsRow: { flexDirection: "row", gap: 18, marginTop: 2 },
  stat: { gap: 1 },
  statLabel: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 10,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  statValue: { fontFamily: "Jakarta_700Bold", fontSize: 14 },
  disc: { fontFamily: "Jakarta_600SemiBold", fontSize: 12 },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 4,
  },
  scanText: { fontFamily: "Jakarta_700Bold", fontSize: 13 },
  fresh: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  freshText: { flex: 1, fontFamily: "Jakarta_600SemiBold", fontSize: 12 },
  // Modal
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 12,
  },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  sheetTitle: { fontFamily: "Jakarta_800ExtraBold", fontSize: 18, letterSpacing: -0.4 },
  sheetSub: { fontFamily: "Jakarta_500Medium", fontSize: 12, marginTop: 2 },
  fieldRow: { flexDirection: "row", gap: 12 },
  field: { flex: 1, gap: 6 },
  label: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 15,
  },
  readonly: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  readonlyText: { fontFamily: "Jakarta_600SemiBold", fontSize: 15 },
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  noteText: { flex: 1, fontFamily: "Jakarta_600SemiBold", fontSize: 12 },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  cancelBtn: { paddingHorizontal: 14, paddingVertical: 11 },
  cancelText: { fontFamily: "Jakarta_700Bold", fontSize: 14 },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
  },
  submitText: { fontFamily: "Jakarta_700Bold", fontSize: 14 },
});
