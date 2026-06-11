import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
  useFonts,
} from "@expo-google-fonts/plus-jakarta-sans";
import { Feather } from "@expo/vector-icons";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import colors from "@/constants/colors";
import { AuthProvider, useAuth } from "@/lib/auth";
import { FiltersProvider } from "@/lib/filters";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
  const { status } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === "loading") return;
    const onLogin = segments[0] === "login";
    // The customer loyalty card flow (app/member/*) has its OWN member-token
    // session and is intentionally reachable WITHOUT a staff BI login, so the
    // staff auth gate must not bounce it back to /login.
    const onMember = segments[0] === "member";
    if (status === "unauthenticated" && !onLogin && !onMember) {
      router.replace("/login");
    } else if (status === "authenticated" && onLogin) {
      router.replace("/(tabs)");
    }
  }, [status, segments, router]);

  if (status === "loading") {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.light.background,
        }}
      >
        <ActivityIndicator color={colors.light.primary} />
      </View>
    );
  }

  return (
    <Stack
      screenOptions={{
        headerBackTitle: "Back",
        headerStyle: { backgroundColor: colors.light.card },
        headerTintColor: colors.light.primaryDeep,
        headerTitleStyle: {
          fontFamily: "Jakarta_700Bold",
          color: colors.light.foreground,
        },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.light.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="member" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Jakarta_400Regular: PlusJakartaSans_400Regular,
    Jakarta_500Medium: PlusJakartaSans_500Medium,
    Jakarta_600SemiBold: PlusJakartaSans_600SemiBold,
    Jakarta_700Bold: PlusJakartaSans_700Bold,
    Jakarta_800ExtraBold: PlusJakartaSans_800ExtraBold,
    ...Feather.font,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            <KeyboardProvider>
              <AuthProvider>
                <FiltersProvider>
                  <RootLayoutNav />
                </FiltersProvider>
              </AuthProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
