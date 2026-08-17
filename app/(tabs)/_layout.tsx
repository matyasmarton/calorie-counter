import { Tabs } from 'expo-router';
import React from 'react';
import { colors } from '@/theme';
import { FoodsIcon, HealthIcon, HistoryIcon, LogIcon, SettingsIcon } from '@/components/TabIcons';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen name="log" options={{ title: 'Log', tabBarIcon: () => <LogIcon /> }} />
      <Tabs.Screen name="foods" options={{ title: 'Foods', tabBarIcon: () => <FoodsIcon /> }} />
      <Tabs.Screen name="history" options={{ title: 'History', tabBarIcon: () => <HistoryIcon /> }} />
      <Tabs.Screen name="health" options={{ title: 'Health', tabBarIcon: () => <HealthIcon /> }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: () => <SettingsIcon /> }} />
    </Tabs>
  );
}
