import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Screen } from "@/components/screen";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionHeader,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { apiGet, apiPatch } from "@/lib/api";
import { useAuth } from "@/lib/auth";

interface Task {
  id: number;
  customer_id: string | null;
  title: string;
  description: string | null;
  due_date: string | null;
  priority: string;
  status: string;
  assignee_name: string | null;
}

const FILTERS = [
  { key: "open", label: "Open" },
  { key: "", label: "All" },
  { key: "done", label: "Done" },
];

function priorityTone(priority: string): string {
  if (priority === "high" || priority === "urgent") return "#b91c1c";
  if (priority === "low") return "#6b7280";
  return "#c2410c";
}

export default function CrmTasksScreen() {
  const c = useColors();
  const router = useRouter();
  const qc = useQueryClient();
  const { status } = useAuth();
  const enabled = status === "authenticated";

  const [filter, setFilter] = React.useState("open");

  const tasksQ = useQuery({
    queryKey: ["crm-tasks", filter],
    queryFn: () =>
      apiGet<{ tasks: Task[] }>("/crm/tasks", { status: filter || undefined }),
    staleTime: 30_000,
    enabled,
  });

  const markDone = useMutation({
    mutationFn: (id: number) =>
      apiPatch(`/crm/tasks/${id}`, { status: "done" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm-tasks"] });
    },
  });

  const rows = tasksQ.data?.tasks ?? [];

  return (
    <Screen onRefresh={tasksQ.refetch} refreshing={tasksQ.isFetching}>
      <Stack.Screen options={{ title: "Tasks" }} />

      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>CRM</Text>
        <Text style={[styles.title, { color: c.foreground }]}>Tasks</Text>
      </View>

      <View style={styles.segments}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <Pressable
              key={f.key || "all"}
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

      {tasksQ.isLoading ? (
        <LoadingState />
      ) : tasksQ.isError ? (
        <ErrorState onRetry={tasksQ.refetch} />
      ) : rows.length === 0 ? (
        <EmptyState text="No tasks here" />
      ) : (
        <View>
          <SectionHeader title={`${rows.length} tasks`} />
          <View style={styles.list}>
            {rows.map((t) => {
              const done = t.status === "done" || t.status === "cancelled";
              return (
                <Card key={t.id} style={styles.row}>
                  <View style={styles.rowTop}>
                    <View
                      style={[
                        styles.pBar,
                        { backgroundColor: priorityTone(t.priority) },
                      ]}
                    />
                    <Text
                      style={[
                        styles.taskTitle,
                        {
                          color: done ? c.mutedForeground : c.foreground,
                          textDecorationLine: done ? "line-through" : "none",
                        },
                      ]}
                      numberOfLines={2}
                    >
                      {t.title}
                    </Text>
                  </View>
                  {t.description ? (
                    <Text
                      style={[styles.desc, { color: c.mutedForeground }]}
                      numberOfLines={2}
                    >
                      {t.description}
                    </Text>
                  ) : null}
                  <View style={styles.metaRow}>
                    <Text style={[styles.meta, { color: c.mutedForeground }]}>
                      {[
                        t.due_date ? `Due ${t.due_date}` : null,
                        t.assignee_name ? `→ ${t.assignee_name}` : null,
                      ]
                        .filter(Boolean)
                        .join("  ·  ") || "No due date"}
                    </Text>
                  </View>
                  <View style={styles.actions}>
                    {t.customer_id ? (
                      <Pressable
                        onPress={() =>
                          router.push({
                            pathname: "/crm-customer",
                            params: { id: t.customer_id! },
                          })
                        }
                        style={({ pressed }) => [
                          styles.actionBtn,
                          { borderColor: c.border },
                          pressed && { opacity: 0.6 },
                        ]}
                      >
                        <Text style={[styles.actionText, { color: c.foreground }]}>
                          View contact
                        </Text>
                      </Pressable>
                    ) : null}
                    {!done ? (
                      <Pressable
                        disabled={markDone.isPending}
                        onPress={() => markDone.mutate(t.id)}
                        style={({ pressed }) => [
                          styles.actionBtn,
                          { backgroundColor: c.primary, borderColor: c.primary },
                          pressed && { opacity: 0.6 },
                        ]}
                      >
                        <Text
                          style={[styles.actionText, { color: c.primaryForeground }]}
                        >
                          {markDone.isPending ? "Saving…" : "Mark done"}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </Card>
              );
            })}
          </View>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: 2 },
  brand: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  title: { fontFamily: "Jakarta_800ExtraBold", fontSize: 26, letterSpacing: -0.6 },
  segments: { flexDirection: "row", gap: 8 },
  seg: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  segText: { fontFamily: "Jakarta_700Bold", fontSize: 12 },
  list: { gap: 12 },
  row: { gap: 8 },
  rowTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  pBar: { width: 4, alignSelf: "stretch", borderRadius: 999, minHeight: 18 },
  taskTitle: { fontFamily: "Jakarta_700Bold", fontSize: 15, flex: 1, letterSpacing: -0.2 },
  desc: { fontFamily: "Jakarta_500Medium", fontSize: 13 },
  metaRow: { flexDirection: "row" },
  meta: { fontFamily: "Jakarta_500Medium", fontSize: 12 },
  actions: { flexDirection: "row", gap: 8, marginTop: 2 },
  actionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  actionText: { fontFamily: "Jakarta_700Bold", fontSize: 13 },
});
