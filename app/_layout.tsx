import { Stack } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import type React from 'react';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { AppProvider, useApp } from '@/app-context';
import { LocalModelProvider } from '@/local-ai/model-context';
import { colors, displayFontFallback, setDisplayFont } from '@/theme';

/**
 * Only the bold face is loaded: importing the package index would pull every
 * weight (12 files, ~700 KB) into the bundle for one heading style.
 */
const BodoniModa_700Bold = require('@expo-google-fonts/bodoni-moda/700Bold/BodoniModa_700Bold.ttf');

// The display face is part of the layout, not a progressive enhancement: hold the
// splash so no heading is ever painted in the fallback and then reflowed.
void SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Resolves the display typeface before any screen mounts, so every `fontDisplay`
 * style reads the final family on its first render. A failed download degrades to
 * a system serif instead of blocking the app.
 */
function FontGate({ children }: { children: React.ReactNode }) {
  const [loaded, error] = useFonts({ BodoniModa_700Bold });
  const settled = loaded || error != null;
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    if (!settled) return;
    setDisplayFont(loaded ? 'BodoniModa_700Bold' : displayFontFallback);
    setApplied(true);
    void SplashScreen.hideAsync().catch(() => {});
  }, [settled, loaded]);

  if (!settled || !applied) return null;
  return <>{children}</>;
}

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
      <LocalModelProvider>
        <FontGate>
          <Gate />
        </FontGate>
      </LocalModelProvider>
    </AppProvider>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: colors.bg },
  loading: { color: colors.textMuted },
  error: { color: colors.danger, padding: 24, textAlign: 'center' },
});
