import React from 'react';
import { Stack } from 'expo-router';

// The Community website owns its Home / Shop / Community / Rewards / Account
// navigation. The native shell deliberately does not add a second tab bar.
export default function TabLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
