/**
 * History — the last 30 days with totals, opening the SAME log editor for
 * any selected date (identical repository path; no special past-day storage).
 */
import { useApp } from '@/app-context';
import { Button, Card, EmptyState, ErrorBanner, Screen, SectionTitle } from '@/components/ui';
import { addDays, formatDateKey, todayKey } from '@/domain/dates';
import type { DailySummary, MacroSummary, SummaryRange } from '@/domain/types';
import { colors, font, spacing } from '@/theme';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

const DAYS = 30;

const RANGE_LABEL: Record<SummaryRange, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

export default function HistoryScreen() {
  const { repo } = useApp();
  const router = useRouter();
  const [summaries, setSummaries] = useState<DailySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<SummaryRange>('day');
  const [macroSummary, setMacroSummary] = useState<MacroSummary | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    void repo
      .getMacroSummary(range, todayKey())
      .then((m) => {
        if (!cancelled) setMacroSummary(m);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [repo, range]);

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

      <View style={styles.rangeRow}>
        {(Object.keys(RANGE_LABEL) as SummaryRange[]).map((r) => (
          <Pressable
            key={r}
            accessibilityRole="button"
            accessibilityState={{ selected: range === r }}
            onPress={() => setRange(r)}
            style={[styles.rangeChip, range === r && styles.rangeChipSelected]}
          >
            <Text style={[styles.rangeChipText, range === r && styles.rangeChipTextSelected]}>{RANGE_LABEL[r]}</Text>
          </Pressable>
        ))}
      </View>
      {macroSummary ? (
        <Card style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>
            {RANGE_LABEL[macroSummary.range]} totals · {formatDateKey(macroSummary.from)}
            {macroSummary.from !== macroSummary.to ? ` – ${formatDateKey(macroSummary.to)}` : ''}
          </Text>
          <Text style={styles.summaryKcal} testID="summary-calories">
            {macroSummary.calories.toLocaleString()} kcal
          </Text>
          <Text style={styles.summaryMacros} testID="summary-macros">
            P {macroSummary.proteinGrams} · C {macroSummary.carbsGrams} · F {macroSummary.fatGrams} g ·{' '}
            {macroSummary.entryCount} entr{macroSummary.entryCount === 1 ? 'y' : 'ies'}
          </Text>
        </Card>
      ) : null}

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
  rangeRow: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.sm },
  rangeChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  rangeChipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  rangeChipText: { fontSize: font.caption, color: colors.text, fontWeight: '600' },
  rangeChipTextSelected: { color: '#fff' },
  summaryCard: { alignItems: 'center', marginBottom: spacing.sm },
  summaryTitle: { fontSize: font.caption, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 },
  summaryKcal: { fontSize: 28, fontWeight: '800', color: colors.primaryDark },
  summaryMacros: { fontSize: font.body, fontWeight: '600', color: colors.text },
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
