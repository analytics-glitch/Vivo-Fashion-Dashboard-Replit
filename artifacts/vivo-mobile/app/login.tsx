import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/lib/auth";

export default function LoginScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async () => {
    if (submitting) return;
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAwareScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 64, paddingBottom: insets.bottom + 48 },
      ]}
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <View style={styles.header}>
        <Text style={[styles.brand, { color: c.primaryDeep }]}>Vivo Fashion Group</Text>
        <Text style={[styles.title, { color: c.foreground }]}>Executive BI</Text>
        <Text style={[styles.subtitle, { color: c.textSub }]}>
          Sign in to access the cockpit
        </Text>
      </View>

      <View
        style={[
          styles.card,
          { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius },
        ]}
      >
        <View style={styles.field}>
          <Text style={[styles.label, { color: c.mutedForeground }]}>Email</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@vivofashiongroup.com"
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            style={[
              styles.input,
              { color: c.foreground, borderColor: c.input, backgroundColor: c.panel },
            ]}
            editable={!submitting}
            onSubmitEditing={onSubmit}
            returnKeyType="next"
          />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: c.mutedForeground }]}>Password</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={c.mutedForeground}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            style={[
              styles.input,
              { color: c.foreground, borderColor: c.input, backgroundColor: c.panel },
            ]}
            editable={!submitting}
            onSubmitEditing={onSubmit}
            returnKeyType="go"
          />
        </View>

        {error ? (
          <Text style={[styles.error, { color: c.destructive }]}>{error}</Text>
        ) : null}

        <Pressable
          onPress={onSubmit}
          disabled={submitting}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: c.primary,
              borderRadius: c.radius,
              opacity: submitting || pressed ? 0.85 : 1,
            },
          ]}
        >
          {submitting ? (
            <ActivityIndicator color={c.primaryForeground} />
          ) : (
            <Text style={[styles.buttonText, { color: c.primaryForeground }]}>Sign in</Text>
          )}
        </Pressable>
      </View>

      <Text style={[styles.footnote, { color: c.mutedForeground }]}>
        Access is limited to approved Vivo Fashion Group staff.
      </Text>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, gap: 24, flexGrow: 1 },
  header: { gap: 4 },
  brand: {
    fontFamily: "Jakarta_700Bold",
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  title: { fontFamily: "Jakarta_800ExtraBold", fontSize: 30, letterSpacing: -0.8 },
  subtitle: { fontFamily: "Jakarta_500Medium", fontSize: 14 },
  card: {
    borderWidth: 1,
    padding: 20,
    gap: 16,
    shadowColor: "#102818",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  field: { gap: 6 },
  label: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: "Jakarta_500Medium",
    fontSize: 15,
  },
  error: { fontFamily: "Jakarta_500Medium", fontSize: 13 },
  button: {
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  buttonText: { fontFamily: "Jakarta_700Bold", fontSize: 15 },
  footnote: { fontFamily: "Jakarta_500Medium", fontSize: 12, textAlign: "center" },
});
