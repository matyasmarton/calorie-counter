/**
 * History — the last 30 days with totals, opening the SAME log editor for
 * any selected date (identical repository path; no special past-day storage).
 */
import { useApp } from '@/app-context';
import { Button, Card, EmptyState, ErrorBanner, Screen, SectionTitle } from '@/components/ui';
import { addDays, formatDateKey, todayKey } from '@/domain/dates';
import type { DailySummary } from '@/domain/types';
import { colors, font, spacing } from '@/theme';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

const DAYS = 30;

export default function HistoryScreen() {
  const { repo } = useApp();
  const router = useRouter();
  const [summaries, setSummaries] = useState<DailySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const to = todayKey();
    const from = addDays(to, -(DAYS - 1));
    try {
      setError(null);
      setSummaries(await repo.getDailySummaries(from, to));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [repo]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const byDate = new Map(summaries.map((s) => [s.logDate, s]));
  const rows: { date: string; summary: DailySummary | null }[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = addDays(todayKey(), -i);
    rows.push({ date: d, summary: byDate.get(d) ?? null });
  }
  const loggedDays = rows.filter((r) => r.summary && r.summary.entryCount > 0).length;

  return (
    <Screen>
      <SectionTitle>Last {DAYS} days</SectionTitle>
      <Text style={styles.sub}>
        {loggedDays} day{loggedDays === 1 ? '' : 's'} with entries. Tap a day to add or correct entries.
      </Text>
      {error ? <ErrorBanner message={`Could not load history: ${error}`} /> : null}
      {loading ? <EmptyState title="Loading…" /> : null}
      {!loading && !error ? (
        <Card style={styles.card}>
          {rows.map(({ date, summary }) => (
            <Pressable
              key={date}
              accessibilityRole="button"
              accessibilityLabel={`${formatDateKey(date)}: ${summary?.calories ?? 0} calories`}
              onPress={() => router.push({ pathname: '/(tabs)/log', params: { date } })}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowLeft}>
                <Text style={styles.rowDate}>
                  {date === todayKey() ? 'Today' : formatDateKey(date)}
                </Text>
                {summary && summary.weightKg != null ? (
                  <Text style={styles.rowMeta}>{summary.weightKg} kg</Text>
                ) : null}
              </View>
              <Text style={[styles.rowKcal, !summary?.entryCount && styles.rowEmpty]}>
                {summary && summary.entryCount > 0 ? `${summary.calories.toLocaleString()} kcal` : '—'}
              </Text>
              <Text style={styles.rowCaret}>›</Text>
            </Pressable>
          ))}
        </Card>
      ) : null}
      <Button variant="secondary" label="Go to today" onPress={() => router.push({ pathname: '/(tabs)/log', params: { date: todayKey() } })} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sub: { fontSize: font.caption, color: colors.textMuted },
  card: { paddingVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: spacing.sm },
  rowPressed: { opacity: 0.6 },
  rowLeft: { flex: 1, gap: 2 },
  rowDate: { fontSize: font.body, fontWeight: '500', color: colors.text },
  rowMeta: { fontSize: font.caption, color: colors.textMuted },
  rowKcal: { fontSize: font.body, fontWeight: '700', color: colors.primaryDark },
  rowEmpty: { color: colors.textMuted, fontWeight: '400' },
  rowCaret: { fontSize: font.title, color: colors.textMuted },
});
