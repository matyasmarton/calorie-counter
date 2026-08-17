import { Stack } from 'expo-router';
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { AppProvider, useApp } from '@/app-context';
import { colors } from '@/theme';

function Gate() {
  const { ready, initError } = useApp();
  if (initError) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>App failed to start: {initError}</Text>
      </View>
    );
  }
  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={styles.loading}>Opening your food log…</Text>
      </View>
    );
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function RootLayout() {
  return (
    <AppProvider>
      <Gate />
    </AppProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: colors.bg },
  loading: { color: colors.textMuted },
  error: { color: colors.danger, padding: 24, textAlign: 'center' },
});
