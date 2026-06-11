import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useColors } from "@/hooks/useColors";
import {
  fetchMemberMessages,
  markMessageRead,
  MemberMessage,
} from "@/lib/member";

/**
 * Loyalty member inbox — announcements and offers staff send from the BI CRM.
 * Tapping an unread message marks it read (optimistic) so the card badge clears.
 */
export default function MemberMessagesScreen() {
  const c = useColors();

  const [messages, setMessages] = useState<MemberMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    if (mode === "refresh") setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetchMemberMessages();
      setMessages(res.messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your messages.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load("initial");
    }, [load]),
  );

  const onOpen = useCallback(async (m: MemberMessage) => {
    if (m.read) return;
    setMessages((prev) =>
      prev.map((x) => (x.id === m.id ? { ...x, read: true } : x)),
    );
    try {
      await markMessageRead(m.id);
    } catch {
      // revert on failure so the unread state stays honest
      setMessages((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, read: false } : x)),
      );
    }
  }, []);

  if (loading) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background, padding: 24, gap: 14 }]}>
        <Ionicons name="warning-outline" size={28} color={c.destructive} />
        <Text style={[styles.errorText, { color: c.foreground }]}>{error}</Text>
        <Pressable
          onPress={() => load("initial")}
          style={[styles.retryBtn, { backgroundColor: c.primary }]}
        >
          <Text style={[styles.retryText, { color: c.primaryForeground }]}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => load("refresh")}
          tintColor={c.primary}
          colors={[c.primary]}
        />
      }
    >
      {messages.length === 0 ? (
        <View style={[styles.emptyBox, { backgroundColor: c.card, borderColor: c.border }]}>
          <Ionicons name="mail-outline" size={26} color={c.mutedForeground} />
          <Text style={[styles.emptyText, { color: c.mutedForeground }]}>
            No messages yet. Offers and updates from Vivo Rewards will appear here.
          </Text>
        </View>
      ) : (
        messages.map((m) => (
          <Pressable
            key={m.id}
            onPress={() => onOpen(m)}
            style={[
              styles.msg,
              { backgroundColor: c.card, borderColor: m.read ? c.border : c.primary },
            ]}
          >
            <View style={styles.msgHead}>
              {!m.read && <View style={[styles.dot, { backgroundColor: c.primary }]} />}
              <Text
                style={[
                  styles.msgTitle,
                  { color: c.foreground, fontFamily: m.read ? "Jakarta_600SemiBold" : "Jakarta_800ExtraBold" },
                ]}
                numberOfLines={2}
              >
                {m.title}
              </Text>
            </View>
            <Text style={[styles.msgBody, { color: c.foreground }]}>{m.body}</Text>
            <Text style={[styles.msgMeta, { color: c.mutedForeground }]}>
              {fmtWhen(m.created_at)}
              {m.created_by_name ? ` · ${m.created_by_name}` : ""}
            </Text>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}

function fmtWhen(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorText: { fontFamily: "Jakarta_600SemiBold", fontSize: 15, textAlign: "center" },
  retryBtn: { paddingHorizontal: 22, paddingVertical: 12, borderRadius: 999 },
  retryText: { fontFamily: "Jakarta_700Bold", fontSize: 14 },
  emptyBox: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 28,
    alignItems: "center",
    gap: 12,
  },
  emptyText: {
    fontFamily: "Jakarta_500Medium",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  msg: { borderWidth: 1, borderRadius: 14, padding: 16, gap: 8 },
  msgHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 999 },
  msgTitle: { fontSize: 15, letterSpacing: -0.2, flex: 1 },
  msgBody: { fontFamily: "Jakarta_500Medium", fontSize: 14, lineHeight: 20 },
  msgMeta: { fontFamily: "Jakarta_500Medium", fontSize: 12, marginTop: 2 },
});
