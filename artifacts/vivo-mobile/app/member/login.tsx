import { Ionicons } from "@expo/vector-icons";
import { Link, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { loginMember } from "@/lib/member";

export default function MemberLoginScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    if (submitting) return;
    setError(null);
    if (!phone.trim() || !pin) {
      setError("Enter your phone number and PIN.");
      return;
    }
    setSubmitting(true);
    try {
      await loginMember({ phone: phone.trim(), pin });
      router.replace("/member");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAwareScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <View
        style={[
          styles.card,
          { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius },
        ]}
      >
        <Text style={[styles.title, { color: c.foreground }]}>Member sign in</Text>
        <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
          View your points, tier and membership card.
        </Text>

        <View style={styles.field}>
          <Text style={[styles.label, { color: c.mutedForeground }]}>Phone number</Text>
          <View style={styles.inputWrap}>
            <Ionicons
              name="call-outline"
              size={15}
              color={c.mutedForeground}
              style={styles.inputIcon}
            />
            <TextInput
              value={phone}
              onChangeText={setPhone}
              placeholder="07XX XXX XXX"
              placeholderTextColor={c.mutedForeground}
              keyboardType="phone-pad"
              style={[styles.input, { color: c.foreground, borderColor: c.input }]}
              editable={!submitting}
              returnKeyType="next"
            />
          </View>
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: c.mutedForeground }]}>PIN</Text>
          <View style={styles.inputWrap}>
            <Ionicons
              name="lock-closed-outline"
              size={15}
              color={c.mutedForeground}
              style={styles.inputIcon}
            />
            <TextInput
              value={pin}
              onChangeText={(t) => setPin(t.replace(/\D/g, "").slice(0, 6))}
              placeholder="••••"
              placeholderTextColor={c.mutedForeground}
              keyboardType="number-pad"
              secureTextEntry
              style={[styles.input, { color: c.foreground, borderColor: c.input }]}
              editable={!submitting}
              onSubmitEditing={onSubmit}
              returnKeyType="go"
            />
          </View>
        </View>

        {error ? (
          <View style={[styles.errorBox, { borderColor: c.destructive }]}>
            <Ionicons name="warning-outline" size={15} color={c.destructive} />
            <Text style={[styles.errorText, { color: c.destructive }]}>{error}</Text>
          </View>
        ) : null}

        <Pressable
          onPress={onSubmit}
          disabled={submitting}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: pressed ? c.primaryDeep : c.primary,
              borderRadius: c.radius,
              opacity: submitting ? 0.7 : 1,
            },
          ]}
        >
          {submitting ? (
            <ActivityIndicator color={c.primaryForeground} />
          ) : (
            <Text style={[styles.buttonText, { color: c.primaryForeground }]}>
              Sign in
            </Text>
          )}
        </Pressable>

        <View style={styles.footerRow}>
          <Text style={[styles.footerText, { color: c.mutedForeground }]}>
            New to Vivo Rewards?
          </Text>
          <Link href="/member/enrol" replace asChild>
            <Pressable>
              <Text style={[styles.footerLink, { color: c.primary }]}>Join now</Text>
            </Pressable>
          </Link>
        </View>
      </View>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 20, flexGrow: 1, justifyContent: "center" },
  card: { borderWidth: 1, padding: 24, gap: 14 },
  title: { fontFamily: "Jakarta_800ExtraBold", fontSize: 22, letterSpacing: -0.5 },
  subtitle: {
    fontFamily: "Jakarta_500Medium",
    fontSize: 13,
    lineHeight: 19,
    marginTop: -6,
  },
  field: { gap: 6 },
  label: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  inputWrap: { position: "relative", justifyContent: "center" },
  inputIcon: { position: "absolute", left: 12, zIndex: 1 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingLeft: 36,
    paddingRight: 14,
    paddingVertical: 12,
    fontFamily: "Jakarta_500Medium",
    fontSize: 15,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#fef2f2",
  },
  errorText: { fontFamily: "Jakarta_500Medium", fontSize: 12.5, flex: 1, lineHeight: 18 },
  button: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  buttonText: { fontFamily: "Jakarta_700Bold", fontSize: 15 },
  footerRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    marginTop: 2,
  },
  footerText: { fontFamily: "Jakarta_500Medium", fontSize: 13 },
  footerLink: { fontFamily: "Jakarta_700Bold", fontSize: 13 },
});
