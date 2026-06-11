import { Stack } from "expo-router";
import React from "react";

import colors from "@/constants/colors";

/**
 * Stack for the customer-facing loyalty card flow. This group is reachable
 * WITHOUT a staff BI login (see the redirect gate in app/_layout.tsx) — a
 * shopper enrols with phone + PIN and views their membership card here.
 */
export default function MemberLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.light.card },
        headerTintColor: colors.light.primaryDeep,
        headerTitleStyle: {
          fontFamily: "Jakarta_700Bold",
          color: colors.light.foreground,
        },
        headerShadowVisible: false,
        headerBackTitle: "Back",
        contentStyle: { backgroundColor: colors.light.background },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="enrol" options={{ title: "Join Vivo Rewards" }} />
      <Stack.Screen name="login" options={{ title: "Member sign in" }} />
    </Stack>
  );
}
