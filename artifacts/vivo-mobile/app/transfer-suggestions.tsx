import { Feather } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack } from "expo-router";
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
  IbtScanOutResult,
  IbtSuggestionBundle,
  IbtSuggestionSku,
  IbtSuggestionsResponse,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { FreshnessBanner } from "./transfers";

/** A suggested move flattened from a bundle + its SKU line. */
type Move = IbtSuggestionSku & {
  from_store: string;
  from_country: string | null;
  to_store: string;
  to_country: string | null;
  via_hub: boolean;
  route: string | null;
  run_id: string;
};

const fmt = (n: number | null | undefined) =>
  n == null ? "—" : Number(n).toLocaleString();

const moveKey = (m: Move) => `${m.from_store}||${m.to_store}||${m.sku}`;

const flatten = (bundles: IbtSuggestionBundle[], runId: string): Move[] => {
  const out: Move[] = [];
  for (const b of bundles) {
    for (const s of b.skus) {
      if ((s.suggested_qty ?? 0) < 1) continue;
      out.push({
        ...s,
        from_store: b.from_store,
        from_country: b.from_country,
        to_store: b.to_store,
        to_country: b.to_country,
        via_hub: b.via_hub,
        route: b.route,
        run_id: runId,
      });
    }
  }
  return out;
};

export default function TransferSuggestionsScreen() {
  const c = useColors();
  const qc = useQueryClient();
  const { status } = useAuth();
  const enabled = status === "authenticated";

  const [scanOut, setScanOut] = React.useState<Move | null>(null);
  const [dispatched, setDispatched] = React.useState<Set<string>>(new Set());

  const sugQ = useQuery({
    queryKey: ["ibt-suggestions"],
    queryFn: () =>
      apiGet<IbtSuggestionsResponse>("/analytics/ibt-suggestions", {
        demand_days: 28,
        limit: 200,
      }),
    staleTime: 5 * 60_000,
    enabled,
  });

  const stale = !!sugQ.data?.freshness?.stale;
  const moves = React.useMemo(
    () => flatten(sugQ.data?.bundles ?? [], sugQ.data?.run_id ?? ""),
    [sugQ.data],
  );
  const visible = moves.filter((m) => !dispatched.has(moveKey(m)));

  return (
    <Screen onRefresh={sugQ.refetch} refreshing={sugQ.isFetching}>
      <Stack.Screen options={{ title: "Suggested Moves" }} />

      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>Operations</Text>
        <Text style={[styles.title, { color: c.foreground }]}>
          Suggested moves
        </Text>
        <Text style={[styles.sub, { color: c.mutedForeground }]}>
          Each SKU moves from a store where it isn&apos;t selling to one where it
          is. Scan out to dispatch it into transit.
        </Text>
      </View>

      <FreshnessBanner f={sugQ.data?.freshness} />

      {sugQ.isLoading ? (
        <LoadingState />
      ) : sugQ.isError ? (
        <ErrorState onRetry={sugQ.refetch} />
      ) : visible.length === 0 ? (
        <EmptyState text="No suggested moves right now." />
      ) : (
        <View>
          <SectionHeader title={`${visible.length} suggested SKU moves`} />
          <View style={styles.list}>
            {visible.map((m) => (
              <Card key={moveKey(m)} style={styles.row}>
                <View style={styles.rowTop}>
                  <Text
                    style={[styles.style, { color: c.foreground }]}
                    numberOfLines={1}
                  >
                    {m.style_name || "—"}
                  </Text>
                  <View style={styles.badges}>
                    {m.curve_complete ? (
                      <Badge text="curve" tone="planned" />
                    ) : null}
                    <Badge
                      text={m.via_hub ? "via hub" : "same-mall"}
                      tone="neutral"
                    />
                  </View>
                </View>

                <View style={styles.route}>
                  <Text
                    style={[styles.store, { color: c.foreground }]}
                    numberOfLines={1}
                  >
                    {m.from_store}
                  </Text>
                  <Feather name="arrow-right" size={13} color={c.primary} />
                  <Text
                    style={[styles.store, { color: c.primary }]}
                    numberOfLines={1}
                  >
                    {m.to_store}
                  </Text>
                </View>

                <Text
                  style={[styles.meta, { color: c.mutedForeground }]}
                  numberOfLines={1}
                >
                  {[m.color, m.size, m.sku].filter(Boolean).join(" · ") || "—"}
                </Text>

                <View style={styles.statsRow}>
                  <Stat label="Suggested" value={fmt(m.suggested_qty)} c={c} />
                  <Stat label="Donor SOH" value={fmt(m.from_available)} c={c} />
                  <Stat label="Value" value={`KES ${fmt(m.value_kes)}`} c={c} />
                </View>

                <Pressable
                  disabled={stale}
                  onPress={() => !stale && setScanOut(m)}
                  style={({ pressed }) => [
                    styles.scanBtn,
                    { backgroundColor: stale ? c.muted : c.primary },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Feather
                    name={stale ? "lock" : "truck"}
                    size={14}
                    color={stale ? c.mutedForeground : c.primaryForeground}
                  />
                  <Text
                    style={[
                      styles.scanText,
                      {
                        color: stale ? c.mutedForeground : c.primaryForeground,
                      },
                    ]}
                  >
                    {stale ? "Dispatch locked" : "Scan out"}
                  </Text>
                </Pressable>
              </Card>
            ))}
          </View>
        </View>
      )}

      <ScanOutModal
        move={scanOut}
        onClose={() => setScanOut(null)}
        onDispatched={(key) => {
          setDispatched((prev) => new Set(prev).add(key));
          qc.invalidateQueries({ queryKey: ["ibt-transfers"] });
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

function ScanOutModal({
  move,
  onClose,
  onDispatched,
}: {
  move: Move | null;
  onClose: () => void;
  onDispatched: (key: string) => void;
}) {
  const c = useColors();
  const [qty, setQty] = React.useState("");
  const [odooRef, setOdooRef] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [block, setBlock] = React.useState<{
    message?: string;
    available?: number;
    reserved?: number;
    requested?: number;
  } | null>(null);
  const [done, setDone] = React.useState<IbtScanOutResult | null>(null);

  React.useEffect(() => {
    if (move) {
      setQty(String(move.suggested_qty ?? 0));
      setOdooRef("");
      setError(null);
      setBlock(null);
      setDone(null);
    }
  }, [move]);

  const scanOut = useMutation({
    mutationFn: () =>
      apiPost<IbtScanOutResult>("/ibt/scan-out", {
        from_store: move!.from_store,
        from_country: move!.from_country,
        to_store: move!.to_store,
        to_country: move!.to_country,
        style_name: move!.style_name,
        brand: move!.brand,
        subcategory: move!.subcategory,
        sku: move!.sku,
        color: move!.color,
        size: move!.size,
        barcode: move!.barcode,
        qty: Number(qty),
        via_hub: move!.via_hub,
        route: move!.route,
        run_id: move!.run_id || null,
        source_onhand_at_calc: move!.from_available,
        dest_gap_at_calc: move!.dest_gap_at_calc,
        net_ccc_days: move!.net_ccc_days,
        value_kes: move!.value_kes,
        curve_complete: !!move!.curve_complete,
        odoo_transfer_id: odooRef.trim() || null,
      }),
    onSuccess: (data) => setDone(data),
    onError: (e: Error & { status?: number; detail?: unknown }) => {
      if (
        e.status === 409 &&
        e.detail &&
        typeof e.detail === "object"
      ) {
        setBlock(e.detail as Record<string, number | string>);
      } else {
        setError(e.message);
      }
    },
  });

  const donorAvail = move?.from_available ?? 0;

  return (
    <Modal
      visible={!!move}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: c.card }]}>
          <View style={styles.sheetHead}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sheetTitle, { color: c.foreground }]}>
                Scan out — dispatch transfer
              </Text>
              {move ? (
                <Text style={[styles.sheetSub, { color: c.mutedForeground }]}>
                  {move.style_name} · {move.from_store} → {move.to_store}
                </Text>
              ) : null}
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <Feather name="x" size={20} color={c.mutedForeground} />
            </Pressable>
          </View>

          {done ? (
            <View style={styles.doneWrap}>
              <View style={[styles.note, { backgroundColor: "#dcfce7" }]}>
                <Feather name="check-circle" size={16} color="#15803d" />
                <Text style={[styles.noteText, { color: "#15803d" }]}>
                  In transit — label the carton with this consignment id so the
                  destination can scan it in.
                </Text>
              </View>
              <View
                style={[
                  styles.cidBox,
                  { borderColor: "#86efac", backgroundColor: c.card },
                ]}
              >
                <Text style={[styles.cidText, { color: "#15803d" }]}>
                  {done.consignment_id}
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  if (move) onDispatched(moveKey(move));
                  onClose();
                }}
                style={({ pressed }) => [
                  styles.submitBtn,
                  { backgroundColor: c.primary, alignSelf: "flex-end" },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={[styles.submitText, { color: c.primaryForeground }]}>
                  Done
                </Text>
              </Pressable>
            </View>
          ) : (
            <>
              {block ? (
                <View style={[styles.note, { backgroundColor: "#fee2e2" }]}>
                  <Feather name="alert-triangle" size={14} color="#b91c1c" />
                  <Text style={[styles.noteText, { color: "#b91c1c" }]}>
                    Stock no longer available.{" "}
                    {block.message ? `${block.message} ` : ""}
                    Live available: {fmt(block.available ?? 0)}
                    {block.reserved
                      ? ` · reserved: ${fmt(block.reserved)}`
                      : ""}{" "}
                    · requested: {fmt(block.requested ?? Number(qty))}.
                  </Text>
                </View>
              ) : null}

              <Text style={[styles.label, { color: c.mutedForeground }]}>
                Units to dispatch
              </Text>
              <TextInput
                value={qty}
                onChangeText={setQty}
                keyboardType="number-pad"
                style={[
                  styles.input,
                  { color: c.foreground, borderColor: c.border },
                ]}
              />
              <Text style={[styles.hint, { color: c.mutedForeground }]}>
                Suggested {fmt(move?.suggested_qty)} · donor on-hand{" "}
                {fmt(donorAvail)}
              </Text>

              <Text style={[styles.label, { color: c.mutedForeground }]}>
                Odoo transfer ref (optional)
              </Text>
              <TextInput
                value={odooRef}
                onChangeText={setOdooRef}
                placeholder="e.g. WH/OUT/01234"
                placeholderTextColor={c.mutedForeground}
                style={[
                  styles.input,
                  { color: c.foreground, borderColor: c.border },
                ]}
              />

              {error ? (
                <View style={[styles.note, { backgroundColor: "#fee2e2" }]}>
                  <Feather name="alert-circle" size={14} color="#b91c1c" />
                  <Text style={[styles.noteText, { color: "#b91c1c" }]}>
                    {error}
                  </Text>
                </View>
              ) : null}

              <View style={styles.actions}>
                <Pressable
                  onPress={onClose}
                  style={({ pressed }) => [
                    styles.cancelBtn,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Text style={[styles.cancelText, { color: c.mutedForeground }]}>
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  disabled={qty === "" || Number(qty) < 1 || scanOut.isPending}
                  onPress={() => {
                    setError(null);
                    setBlock(null);
                    scanOut.mutate();
                  }}
                  style={({ pressed }) => [
                    styles.submitBtn,
                    {
                      backgroundColor:
                        qty === "" || Number(qty) < 1 || scanOut.isPending
                          ? c.muted
                          : c.primary,
                    },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Feather
                    name="truck"
                    size={14}
                    color={
                      qty === "" || Number(qty) < 1 || scanOut.isPending
                        ? c.mutedForeground
                        : c.primaryForeground
                    }
                  />
                  <Text
                    style={[
                      styles.submitText,
                      {
                        color:
                          qty === "" || Number(qty) < 1 || scanOut.isPending
                            ? c.mutedForeground
                            : c.primaryForeground,
                      },
                    ]}
                  >
                    {scanOut.isPending ? "Dispatching…" : "Scan out"}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
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
  list: { gap: 12 },
  row: { gap: 7 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  badges: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  route: { flexDirection: "row", alignItems: "center", gap: 8 },
  store: { fontFamily: "Jakarta_700Bold", fontSize: 14, flexShrink: 1 },
  style: { fontFamily: "Jakarta_700Bold", fontSize: 14, flexShrink: 1 },
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
  sheetTitle: {
    fontFamily: "Jakarta_800ExtraBold",
    fontSize: 18,
    letterSpacing: -0.4,
  },
  sheetSub: { fontFamily: "Jakarta_500Medium", fontSize: 12, marginTop: 2 },
  label: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  hint: { fontFamily: "Jakarta_500Medium", fontSize: 11, marginTop: -6 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 15,
  },
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
  doneWrap: { gap: 12 },
  cidBox: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignSelf: "flex-start",
  },
  cidText: { fontFamily: "Jakarta_800ExtraBold", fontSize: 16, letterSpacing: 0.5 },
});
