import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Screen } from "@/components/screen";
import { Badge } from "@/components/screen";
import {
  Card,
  ErrorState,
  LoadingState,
  SectionHeader,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface Ticket {
  id: number;
  ticket_number: string;
  customer_id: string | null;
  subject: string;
  status: string;
  priority: string;
  inbound_channel: string | null;
  issue_category: string | null;
  assigned_to_name: string | null;
}

interface Message {
  id: number;
  direction: string;
  sender_name: string | null;
  body: string;
  created_at: string | null;
}

const STATUSES = ["open", "in_progress", "resolved", "closed"];

export default function CrmTicketScreen() {
  const c = useColors();
  const router = useRouter();
  const qc = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { status } = useAuth();
  const enabled = status === "authenticated" && !!id;

  const [reply, setReply] = React.useState("");

  const detailQ = useQuery({
    queryKey: ["crm-ticket", id],
    queryFn: () =>
      apiGet<{ ticket: Ticket; messages: Message[] }>(`/crm/tickets/${id}`),
    staleTime: 15_000,
    enabled,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["crm-ticket", id] });
    qc.invalidateQueries({ queryKey: ["crm-tickets"] });
  };

  const setStatus = useMutation({
    mutationFn: (s: string) => apiPatch(`/crm/tickets/${id}`, { status: s }),
    onSuccess: invalidate,
  });

  const sendReply = useMutation({
    mutationFn: (body: string) =>
      apiPost(`/crm/tickets/${id}/messages`, { body, direction: "outbound" }),
    onSuccess: () => {
      setReply("");
      invalidate();
    },
  });

  const t = detailQ.data?.ticket;
  const msgs = detailQ.data?.messages ?? [];

  return (
    <Screen onRefresh={detailQ.refetch} refreshing={detailQ.isFetching}>
      <Stack.Screen options={{ title: "Ticket" }} />

      {detailQ.isLoading ? (
        <LoadingState />
      ) : detailQ.isError || !t ? (
        <ErrorState onRetry={detailQ.refetch} />
      ) : (
        <>
          <View style={styles.header}>
            <View style={styles.headerTop}>
              <Text style={[styles.ticketNo, { color: c.primaryDeep }]}>
                {t.ticket_number}
              </Text>
              <Badge
                text={t.status}
                tone={
                  t.status === "resolved" || t.status === "closed"
                    ? "good"
                    : "planned"
                }
              />
            </View>
            <Text style={[styles.title, { color: c.foreground }]}>{t.subject}</Text>
            <Text style={[styles.sub, { color: c.mutedForeground }]}>
              {[
                t.inbound_channel,
                t.issue_category,
                `priority ${t.priority}`,
                t.assigned_to_name ? `→ ${t.assigned_to_name}` : null,
              ]
                .filter(Boolean)
                .join("  ·  ")}
            </Text>
            {t.customer_id ? (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: "/crm-customer",
                    params: { id: t.customer_id! },
                  })
                }
                style={({ pressed }) => [
                  styles.viewBtn,
                  { borderColor: c.border },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Text style={[styles.viewText, { color: c.foreground }]}>
                  View contact
                </Text>
              </Pressable>
            ) : null}
          </View>

          <View>
            <SectionHeader title="Status" />
            <View style={styles.statusRow}>
              {STATUSES.map((s) => {
                const active = t.status === s;
                return (
                  <Pressable
                    key={s}
                    disabled={setStatus.isPending}
                    onPress={() => setStatus.mutate(s)}
                    style={[
                      styles.statusPill,
                      {
                        backgroundColor: active ? c.primary : c.card,
                        borderColor: active ? c.primary : c.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusText,
                        { color: active ? c.primaryForeground : c.mutedForeground },
                      ]}
                    >
                      {s.replace("_", " ")}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View>
            <SectionHeader title="Conversation" caption={`${msgs.length} messages`} />
            {msgs.length === 0 ? (
              <Card>
                <Text style={[styles.empty, { color: c.mutedForeground }]}>
                  No messages yet
                </Text>
              </Card>
            ) : (
              <View style={styles.list}>
                {msgs.map((m) => (
                  <Card key={m.id} style={styles.msg}>
                    <View style={styles.msgTop}>
                      <Text style={[styles.msgWho, { color: c.foreground }]}>
                        {m.sender_name || m.direction}
                      </Text>
                      <Text style={[styles.msgDir, { color: c.mutedForeground }]}>
                        {m.direction}
                      </Text>
                    </View>
                    <Text style={[styles.msgBody, { color: c.foreground }]}>
                      {m.body}
                    </Text>
                  </Card>
                ))}
              </View>
            )}
          </View>

          <View>
            <SectionHeader title="Reply" />
            <Card style={styles.replyCard}>
              <TextInput
                value={reply}
                onChangeText={setReply}
                placeholder="Type a reply…"
                placeholderTextColor={c.mutedForeground}
                style={[styles.replyInput, { color: c.foreground }]}
                multiline
              />
              <Pressable
                disabled={!reply.trim() || sendReply.isPending}
                onPress={() => sendReply.mutate(reply.trim())}
                style={({ pressed }) => [
                  styles.sendBtn,
                  {
                    backgroundColor:
                      !reply.trim() || sendReply.isPending ? c.muted : c.primary,
                  },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Text
                  style={[
                    styles.sendText,
                    {
                      color:
                        !reply.trim() || sendReply.isPending
                          ? c.mutedForeground
                          : c.primaryForeground,
                    },
                  ]}
                >
                  {sendReply.isPending ? "Sending…" : "Send reply"}
                </Text>
              </Pressable>
            </Card>
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: 6 },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  ticketNo: { fontFamily: "Jakarta_700Bold", fontSize: 13, letterSpacing: 0.4 },
  title: { fontFamily: "Jakarta_800ExtraBold", fontSize: 22, letterSpacing: -0.5 },
  sub: { fontFamily: "Jakarta_500Medium", fontSize: 13 },
  viewBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 4,
  },
  viewText: { fontFamily: "Jakarta_700Bold", fontSize: 13 },
  statusRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusPill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  statusText: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 12,
    textTransform: "capitalize",
  },
  list: { gap: 10 },
  msg: { gap: 5 },
  msgTop: { flexDirection: "row", justifyContent: "space-between" },
  msgWho: { fontFamily: "Jakarta_700Bold", fontSize: 13 },
  msgDir: {
    fontFamily: "Jakarta_500Medium",
    fontSize: 11,
    textTransform: "capitalize",
  },
  msgBody: { fontFamily: "Jakarta_500Medium", fontSize: 14, lineHeight: 20 },
  empty: { fontFamily: "Jakarta_500Medium", fontSize: 13, textAlign: "center" },
  replyCard: { gap: 12 },
  replyInput: {
    fontFamily: "Jakarta_500Medium",
    fontSize: 14,
    minHeight: 70,
    textAlignVertical: "top",
  },
  sendBtn: {
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: "center",
  },
  sendText: { fontFamily: "Jakarta_700Bold", fontSize: 14 },
});
