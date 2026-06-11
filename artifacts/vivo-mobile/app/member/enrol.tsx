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
import { enrolMember } from "@/lib/member";

export default function MemberEnrolScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    if (submitting) return;
    setError(null);
    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    if (!phone.trim()) {
      setError("Please enter your phone number.");
      return;
    }
    if (!/^\d{4,6}$/.test(pin)) {
      setError("Choose a 4–6 digit PIN.");
      return;
    }
    setSubmitting(true);
    try {
      await enrolMember({
        name: name.trim(),
        phone: phone.trim(),
        pin,
        email: email.trim() || undefined,
      });
      router.replace("/member");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not enrol. Please try again.");
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
        <Text style={[styles.title, { color: c.foreground }]}>Join Vivo Rewards</Text>
        <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
          Earn points every time you shop and redeem them for discounts. Free to
          join — just your phone and a PIN.
        </Text>

        <Field label="Full name" icon="person-outline" c={c}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Your name"
            placeholderTextColor={c.mutedForeground}
            style={[styles.input, { color: c.foreground, borderColor: c.input }]}
            editable={!submitting}
            returnKeyType="next"
          />
        </Field>

        <Field label="Phone number" icon="call-outline" c={c}>
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
        </Field>

        <Field label="Email (optional)" icon="mail-outline" c={c}>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            style={[styles.input, { color: c.foreground, borderColor: c.input }]}
            editable={!submitting}
            returnKeyType="next"
          />
        </Field>

        <Field label="Choose a PIN (4–6 digits)" icon="lock-closed-outline" c={c}>
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
        </Field>

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
              Create my card
            </Text>
          )}
        </Pressable>

        <View style={styles.footerRow}>
          <Text style={[styles.footerText, { color: c.mutedForeground }]}>
            Already a member?
          </Text>
          <Link href="/member/login" replace asChild>
            <Pressable>
              <Text style={[styles.footerLink, { color: c.primary }]}>Sign in</Text>
            </Pressable>
          </Link>
        </View>
      </View>
    </KeyboardAwareScrollView>
  );
}

function Field({
  label,
  icon,
  c,
  children,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  c: ReturnType<typeof useColors>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.mutedForeground }]}>{label}</Text>
      <View style={styles.inputWrap}>
        <Ionicons name={icon} size={15} color={c.mutedForeground} style={styles.inputIcon} />
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 20, flexGrow: 1 },
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
