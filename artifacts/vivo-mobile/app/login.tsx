import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { enrollTwoFactorRequest, fetchAllowedDomains, googleLoginUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const LOGO = require("@/assets/images/vivo-logo.png");

export default function LoginScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { login, completeTwoFactor, completeGoogleLogin } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [domains, setDomains] = useState<string[]>([]);
  const [twoFactor, setTwoFactor] = useState<{ mode: "enroll" | "verify"; challengeToken: string } | null>(null);
  const [enrollment, setEnrollment] = useState<{ manual_key: string; backup_codes: string[] } | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [codesSaved, setCodesSaved] = useState(false);

  useEffect(() => {
    let active = true;
    fetchAllowedDomains().then((d) => {
      if (active) setDomains(d);
    });
    return () => {
      active = false;
    };
  }, []);

  const onSubmit = async () => {
    if (submitting || googleBusy) return;
    setError(null);
    if (!email.trim() || !password) {
      setError("Please enter both email and password.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password);
      if (result.twoFactorRequired) {
        if (!result.challengeToken) throw new Error("Two-step verification could not start.");
        const mode = result.mode === "enroll" ? "enroll" : "verify";
        setTwoFactor({ mode, challengeToken: result.challengeToken });
        if (mode === "enroll") {
          const setup = await enrollTwoFactorRequest(result.challengeToken);
          setEnrollment(setup);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const onTwoFactor = async () => {
    if (!twoFactor || submitting || !verificationCode.trim()) {
      if (!verificationCode.trim()) setError("Enter your authenticator or backup code.");
      return;
    }
    if (twoFactor.mode === "enroll" && !codesSaved) {
      setError("Save your backup codes before finishing setup.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await completeTwoFactor(verificationCode.trim(), twoFactor.challengeToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That verification code was not accepted.");
    } finally {
      setSubmitting(false);
    }
  };

  const onGoogle = async () => {
    if (submitting || googleBusy) return;
    setError(null);
    setGoogleBusy(true);
    try {
      // Deep link the backend hands the session back to. In Expo Go this is an
      // exp:// URL; in a dev/standalone build it is the app's own scheme. Both
      // are intercepted by openAuthSessionAsync to return control to the app.
      const returnUrl = Linking.createURL("/auth/callback");
      const result = await WebBrowser.openAuthSessionAsync(
        googleLoginUrl(returnUrl),
        returnUrl,
      );
      if (result.type !== "success" || !result.url) {
        // User dismissed the browser or it was cancelled; stay on login.
        return;
      }
      // Params arrive as a query (?token=) for native deep links or a #fragment
      // on web; accept whichever the OS preserved.
      const tail = result.url.includes("#")
        ? result.url.split("#")[1]
        : result.url.split("?")[1] ?? "";
      const params = new URLSearchParams(tail);
      const token = params.get("token");
      const err = params.get("error");
      if (err) {
        setError(googleErrorMessage(err));
        return;
      }
      const challengeToken = params.get("challenge_token");
      const twoFactorMode = params.get("mode") === "enroll" ? "enroll" : "verify";
      if (params.get("two_factor") === "1" && challengeToken) {
        setTwoFactor({ mode: twoFactorMode, challengeToken });
        if (twoFactorMode === "enroll") {
          const setup = await enrollTwoFactorRequest(challengeToken);
          setEnrollment(setup);
        }
        return;
      }
      if (!token) {
        setError("Google sign-in did not complete. Please try again.");
        return;
      }
      await completeGoogleLogin(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Google sign-in failed.");
    } finally {
      setGoogleBusy(false);
    }
  };

  const busy = submitting || googleBusy;

  return (
    <KeyboardAwareScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 32 },
      ]}
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <View
        style={[
          styles.card,
          { backgroundColor: c.card, borderColor: c.border, borderRadius: c.radius },
        ]}
      >
        {/* Brand header */}
        <View style={styles.brandRow}>
          <Image source={LOGO} style={styles.brandLogo} resizeMode="contain" />
          <View style={styles.brandText}>
            <Text style={[styles.brandName, { color: c.foreground }]}>
              Vivo Fashion Group
            </Text>
            <Text style={[styles.brandSub, { color: c.mutedForeground }]}>
              BI · East Africa
            </Text>
          </View>
        </View>

        <Text style={[styles.title, { color: c.foreground }]}>Sign in</Text>
        <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
          Access is restricted to{" "}
          {domains.length
            ? domains.map((d, i) => (
                <Text key={d} style={{ color: c.foreground, fontFamily: "Jakarta_700Bold" }}>
                  {i > 0 ? " or " : ""}@{d}
                </Text>
              ))
            : "approved"}{" "}
          email domains.
        </Text>

        {twoFactor ? (
          <View style={{ gap: 14 }}>
            <View style={[styles.twoFactorBox, { backgroundColor: c.panel, borderColor: c.border }]}>
              <Ionicons name="shield-checkmark-outline" size={24} color={c.primary} />
              <Text style={[styles.twoFactorTitle, { color: c.foreground }]}>
                {twoFactor.mode === "enroll" ? "Set up two-step verification" : "Verify your sign-in"}
              </Text>
              <Text style={[styles.twoFactorText, { color: c.mutedForeground }]}>
                {twoFactor.mode === "enroll"
                  ? "Add this account to your authenticator app, save the backup codes, then enter the 6-digit code."
                  : "Enter the 6-digit code from your authenticator app, or use one backup code."}
              </Text>
            </View>
            {enrollment ? (
              <View style={[styles.backupBox, { borderColor: "#fbbf24", backgroundColor: "#fffbeb" }]}>
                <Text style={[styles.backupTitle, { color: "#78350f" }]}>Manual setup key</Text>
                <Text style={[styles.manualKey, { color: "#78350f" }]}>{enrollment.manual_key}</Text>
                <Text style={[styles.backupTitle, { color: "#78350f", marginTop: 10 }]}>Save these 8 backup codes</Text>
                <Text style={[styles.backupText, { color: "#92400e" }]}>Each works once and will not be shown again.</Text>
                <View style={styles.codeGrid}>
                  {enrollment.backup_codes.map((code) => (
                    <Text key={code} style={[styles.code, { color: "#78350f" }]}>{code}</Text>
                  ))}
                </View>
                <Pressable onPress={() => setCodesSaved((v) => !v)} style={styles.savedRow}>
                  <Ionicons name={codesSaved ? "checkbox" : "square-outline"} size={20} color={c.primary} />
                  <Text style={[styles.backupText, { color: "#78350f" }]}>I saved my backup codes securely.</Text>
                </Pressable>
              </View>
            ) : null}
            <TextInput
              value={verificationCode}
              onChangeText={setVerificationCode}
              placeholder="123456 or ABCD-EFGH-JKLM"
              placeholderTextColor={c.mutedForeground}
              autoCapitalize="characters"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              style={[styles.input, { color: c.foreground, borderColor: c.input, backgroundColor: c.card, paddingLeft: 14 }]}
              editable={!busy}
              onSubmitEditing={onTwoFactor}
              autoFocus
            />
            {error ? (
              <View style={[styles.errorBox, { borderColor: c.destructive, backgroundColor: "#fef2f2", borderRadius: 10 }]}>
                <Ionicons name="warning-outline" size={15} color={c.destructive} />
                <Text style={[styles.errorText, { color: c.destructive }]}>{error}</Text>
              </View>
            ) : null}
            <Pressable onPress={onTwoFactor} disabled={busy} style={({ pressed }) => [
              styles.button, { backgroundColor: pressed ? c.primaryDeep : c.primary, borderRadius: c.radius, opacity: busy ? 0.6 : 1 },
            ]}>
              {submitting ? <ActivityIndicator color={c.primaryForeground} /> : (
                <>
                  <Ionicons name="shield-checkmark-outline" size={16} color={c.primaryForeground} />
                  <Text style={[styles.buttonText, { color: c.primaryForeground }]}>
                    {twoFactor.mode === "enroll" ? "Finish setup" : "Verify and sign in"}
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        ) : (
          <>
        {/* Google */}
        <Pressable
          onPress={onGoogle}
          disabled={busy}
          style={({ pressed }) => [
            styles.googleBtn,
            {
              borderColor: c.border,
              backgroundColor: pressed ? c.panel : c.card,
              borderRadius: c.radius,
              opacity: busy && !googleBusy ? 0.6 : 1,
            },
          ]}
        >
          {googleBusy ? (
            <ActivityIndicator color={c.primary} />
          ) : (
            <>
              <Ionicons name="logo-google" size={18} color={c.foreground} />
              <Text style={[styles.googleText, { color: c.foreground }]}>
                Sign in with Google
              </Text>
            </>
          )}
        </Pressable>
          </>
        )}

        {/* Divider */}
        <View style={styles.divider}>
          <View style={[styles.line, { backgroundColor: c.border }]} />
          <Text style={[styles.dividerText, { color: c.mutedForeground }]}>
            or email
          </Text>
          <View style={[styles.line, { backgroundColor: c.border }]} />
        </View>

        {/* Email */}
        <View style={styles.field}>
          <Text style={[styles.label, { color: c.mutedForeground }]}>Email</Text>
          <View style={styles.inputWrap}>
            <Ionicons
              name="mail-outline"
              size={15}
              color={c.mutedForeground}
              style={styles.inputIcon}
            />
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@company.com"
              placeholderTextColor={c.mutedForeground}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              style={[
                styles.input,
                { color: c.foreground, borderColor: c.input, backgroundColor: c.card },
              ]}
              editable={!busy}
              onSubmitEditing={onSubmit}
              returnKeyType="next"
            />
          </View>
        </View>

        {/* Password */}
        <View style={styles.field}>
          <Text style={[styles.label, { color: c.mutedForeground }]}>Password</Text>
          <View style={styles.inputWrap}>
            <Ionicons
              name="lock-closed-outline"
              size={15}
              color={c.mutedForeground}
              style={styles.inputIcon}
            />
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
                { color: c.foreground, borderColor: c.input, backgroundColor: c.card },
              ]}
              editable={!busy}
              onSubmitEditing={onSubmit}
              returnKeyType="go"
            />
          </View>
        </View>

        {error ? (
          <View
            style={[
              styles.errorBox,
              { borderColor: c.destructive, backgroundColor: "#fef2f2", borderRadius: 10 },
            ]}
          >
            <Ionicons name="warning-outline" size={15} color={c.destructive} />
            <Text style={[styles.errorText, { color: c.destructive }]}>{error}</Text>
          </View>
        ) : null}

        <Pressable
          onPress={onSubmit}
          disabled={busy}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: pressed ? c.primaryDeep : c.primary,
              borderRadius: c.radius,
              opacity: busy && !submitting ? 0.6 : 1,
            },
          ]}
        >
          {submitting ? (
            <ActivityIndicator color={c.primaryForeground} />
          ) : (
            <>
              <Ionicons name="log-in-outline" size={16} color={c.primaryForeground} />
              <Text style={[styles.buttonText, { color: c.primaryForeground }]}>
                Sign in
              </Text>
            </>
          )}
        </Pressable>

        <Text style={[styles.note, { color: c.mutedForeground }]}>
          Email/password accounts are created by your administrator. Contact them
          if you need access.
        </Text>

        <View style={[styles.poweredBy, { borderTopColor: c.border }]}>
          <Text style={[styles.poweredText, { color: c.mutedForeground }]}>
            Powered by
          </Text>
          <Image source={LOGO} style={styles.poweredLogo} resizeMode="contain" />
          <Text style={[styles.poweredBrand, { color: c.foreground }]}>BI</Text>
        </View>
      </View>
    </KeyboardAwareScrollView>
  );
}

function googleErrorMessage(code: string): string {
  switch (code) {
    case "domain_not_allowed":
      return "That Google account is not on an approved company domain.";
    case "not_configured":
      return "Google sign-in is not configured. Use email and password.";
    case "invalid_state":
      return "Google sign-in expired. Please try again.";
    case "token_exchange":
    case "profile":
      return "Could not complete Google sign-in. Please try again.";
    default:
      return "Google sign-in failed. Please try again.";
  }
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, flexGrow: 1, justifyContent: "center" },
  card: {
    borderWidth: 1,
    padding: 24,
    gap: 14,
    shadowColor: "#102818",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 2 },
  brandLogo: { width: 44, height: 44, borderRadius: 8 },
  brandText: { flex: 1 },
  brandName: { fontFamily: "Jakarta_700Bold", fontSize: 15, letterSpacing: -0.2 },
  brandSub: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 10.5,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 1,
  },
  title: { fontFamily: "Jakarta_800ExtraBold", fontSize: 22, letterSpacing: -0.5 },
  subtitle: { fontFamily: "Jakarta_500Medium", fontSize: 13, lineHeight: 19, marginTop: -6 },
  googleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderWidth: 1,
    paddingVertical: 13,
    marginTop: 4,
  },
  googleText: { fontFamily: "Jakarta_600SemiBold", fontSize: 14 },
  divider: { flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 4 },
  line: { height: 1, flex: 1 },
  dividerText: {
    fontFamily: "Jakarta_600SemiBold",
    fontSize: 10.5,
    letterSpacing: 0.8,
    textTransform: "uppercase",
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
  twoFactorBox: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 7, alignItems: "center" },
  twoFactorTitle: { fontFamily: "Jakarta_700Bold", fontSize: 16, textAlign: "center" },
  twoFactorText: { fontFamily: "Jakarta_500Medium", fontSize: 12.5, lineHeight: 18, textAlign: "center" },
  backupBox: { borderWidth: 1, borderRadius: 10, padding: 12 },
  backupTitle: { fontFamily: "Jakarta_700Bold", fontSize: 12 },
  backupText: { fontFamily: "Jakarta_500Medium", fontSize: 11, lineHeight: 16 },
  manualKey: { fontFamily: "Jakarta_700Bold", fontSize: 14, letterSpacing: 1.2, marginTop: 5 },
  codeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  code: { fontFamily: "Jakarta_600SemiBold", fontSize: 11, width: "47%" },
  savedRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 11 },
  note: { fontFamily: "Jakarta_500Medium", fontSize: 11.5, lineHeight: 17, marginTop: 2 },
  poweredBy: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderTopWidth: 1,
    paddingTop: 14,
    marginTop: 6,
  },
  poweredText: { fontFamily: "Jakarta_500Medium", fontSize: 11 },
  poweredLogo: { width: 16, height: 16, borderRadius: 3 },
  poweredBrand: { fontFamily: "Jakarta_700Bold", fontSize: 11 },
});
