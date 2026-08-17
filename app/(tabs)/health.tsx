/**
 * Health — date-based weight/height entry with BMI (adult reference only),
 * plus intake and weight trend charts (30 days / all history) that render
 * missing dates as gaps. Graphs read the same repository queries as screens.
 */
import { useApp } from '@/app-context';
import { TrendChart, type TrendPoint } from '@/components/TrendChart';
import { Button, Card, Chip, EmptyState, ErrorBanner, Field, Screen, SectionTitle, TextInput } from '@/components/ui';
import { addDays, isValidDateKey, todayKey } from '@/domain/dates';
import { BMI_ADULT_REFERENCE_DISCLAIMER, BMI_CATEGORY_LABELS, bmiResult } from '@/domain/health';
import type { DailySummary, HealthMeasurement } from '@/domain/types';
import { colors, font, spacing } from '@/theme';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type Range = '30d' | 'all';

export default function HealthScreen() {
  const { repo } = useApp();
  const [measurements, setMeasurements] = useState<HealthMeasurement[]>([]);
  const [summaries, setSummaries] = useState<DailySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>('30d');

  // form
  const [date, setDate] = useState(todayKey());
  const [weight, setWeight] = useState('');
  const [height, setHeight] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setMeasurements(await repo.getHealthMeasurements());
      const to = todayKey();
      const from = range === '30d' ? addDays(to, -29) : '2000-01-01';
      setSummaries(await repo.getDailySummaries(from, to));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [repo, range]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const current = measurements.find((m) => m.measuredAt <= todayKey()) ?? null;
  const bmi = current?.weightKg != null && current?.heightCm != null ? bmiResult(current.weightKg, current.heightCm) : null;

  const intakePoints: TrendPoint[] = useMemo(
    () => summaries.filter((s) => s.entryCount > 0).map((s) => ({ date: s.logDate, value: s.calories })),
    [summaries],
  );
  const weightPoints: TrendPoint[] = useMemo(() => {
    const to = todayKey();
    const from = range === '30d' ? addDays(to, -29) : '2000-01-01';
    return measurements
      .filter((m) => m.weightKg != null && m.measuredAt >= from && m.measuredAt <= to)
      .map((m) => ({ date: m.measuredAt, value: m.weightKg! }));
  }, [measurements, range]);

  const save = useCallback(async () => {
    if (!isValidDateKey(date)) {
      setFormError('Enter a valid date (YYYY-MM-DD)');
      return;
    }
    const w = weight === '' ? null : Number(weight);
    const h = height === '' ? null : Number(height);
    if (w != null && (!Number.isFinite(w) || w <= 0)) {
      setFormError('Weight must be a positive number');
      return;
    }
    if (h != null && (!Number.isFinite(h) || h <= 0)) {
      setFormError('Height must be a positive number');
      return;
    }
    if (w == null && h == null) {
      setFormError('Enter a weight, a height, or both');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editingId) {
        await repo.updateHealthMeasurement(editingId, { measuredAt: date, weightKg: w, heightCm: h });
      } else {
        await repo.addHealthMeasurement({ measuredAt: date, weightKg: w, heightCm: h });
      }
      setWeight('');
      setHeight('');
      setEditingId(null);
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [repo, date, weight, height, editingId, load]);

  const startEdit = useCallback((m: HealthMeasurement) => {
    setEditingId(m.id);
    setDate(m.measuredAt);
    setWeight(m.weightKg != null ? String(m.weightKg) : '');
    setHeight(m.heightCm != null ? String(m.heightCm) : '');
    setFormError(null);
  }, []);

  const remove = useCallback(
    async (id: string) => {
      try {
        await repo.deleteHealthMeasurement(id);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [repo, load],
  );

  return (
    <Screen>
      <SectionTitle>Current BMI</SectionTitle>
      <Card style={styles.bmiCard}>
        {bmi ? (
          <>
            <Text style={styles.bmiValue} testID="bmi-value">
              {bmi.bmi.toFixed(1)}
            </Text>
            <Text style={styles.bmiCategory}>{BMI_CATEGORY_LABELS[bmi.category]}</Text>
            <Text style={styles.bmiMeta}>
              Based on {current!.weightKg} kg and {current!.heightCm} cm on {current!.measuredAt}.
            </Text>
          </>
        ) : (
          <Text style={styles.bmiMissing}>
            {current
              ? 'Add both weight and height to see your BMI.'
              : 'No measurements yet — add a weight below to get started.'}
          </Text>
        )}
        <Text style={styles.disclaimer}>{BMI_ADULT_REFERENCE_DISCLAIMER}</Text>
      </Card>

      <SectionTitle>{editingId ? 'Edit measurement' : 'Add measurement'}</SectionTitle>
      <Card>
        <Field label="Date (YYYY-MM-DD)" error={date !== '' && !isValidDateKey(date) ? 'Invalid date' : null}>
          <TextInput value={date} onChangeText={setDate} placeholder={todayKey()} testID="measure-date" />
        </Field>
        <Field label="Weight (kg)">
          <TextInput value={weight} onChangeText={setWeight} keyboardType="decimal-pad" placeholder="e.g. 70.5" testID="measure-weight" />
        </Field>
        <Field label="Height (cm)">
          <TextInput value={height} onChangeText={setHeight} keyboardType="decimal-pad" placeholder="e.g. 175" testID="measure-height" />
        </Field>
        {formError ? <ErrorBanner message={formError} /> : null}
        <View style={styles.formActions}>
          <Button label={editingId ? 'Save changes' : 'Save measurement'} onPress={save} loading={saving} />
          {editingId ? <Button variant="secondary" label="Cancel" onPress={() => { setEditingId(null); setWeight(''); setHeight(''); }} /> : null}
        </View>
      </Card>

      <SectionTitle>Trends</SectionTitle>
      <View style={styles.rangeRow}>
        <Chip label="Last 30 days" selected={range === '30d'} onPress={() => setRange('30d')} />
        <Chip label="All history" selected={range === 'all'} onPress={() => setRange('all')} />
      </View>
      {error ? <ErrorBanner message={error} /> : null}

      <Card>
        <Text style={styles.chartTitle}>Daily calorie intake</Text>
        <TrendChart points={intakePoints} unit="kcal" color={colors.chart} />
      </Card>
      <Card>
        <Text style={styles.chartTitle}>Weight</Text>
        <TrendChart points={weightPoints} unit="kg" color={colors.chartWeight} />
      </Card>

      <SectionTitle>Measurements</SectionTitle>
      {measurements.length === 0 ? (
        <EmptyState title="No measurements yet" body="Weight and height are optional — food logging works without them." />
      ) : (
        <Card style={styles.listCard}>
          {measurements.map((m) => (
            <View key={m.id} style={styles.row}>
              <View style={styles.rowInfo}>
                <Text style={styles.rowDate}>{m.measuredAt}</Text>
                <Text style={styles.rowMeta}>
                  {m.weightKg != null ? `${m.weightKg} kg` : '—'} · {m.heightCm != null ? `${m.heightCm} cm` : '—'}
                </Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Edit measurement" onPress={() => startEdit(m)} style={styles.action}>
                <Text style={styles.actionText}>Edit</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Delete measurement" onPress={() => void remove(m.id)} style={styles.action}>
                <Text style={[styles.actionText, styles.deleteText]}>Delete</Text>
              </Pressable>
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  bmiCard: { alignItems: 'center' },
  bmiValue: { fontSize: 44, fontWeight: '800', color: colors.primaryDark },
  bmiCategory: { fontSize: font.section, fontWeight: '600', color: colors.text },
  bmiMeta: { fontSize: font.caption, color: colors.textMuted },
  bmiMissing: { fontSize: font.body, color: colors.text },
  disclaimer: { fontSize: font.caption, color: colors.textMuted, textAlign: 'center', fontStyle: 'italic' },
  formActions: { flexDirection: 'row', gap: spacing.sm },
  rangeRow: { flexDirection: 'row', gap: spacing.sm },
  chartTitle: { fontSize: font.section, fontWeight: '600', color: colors.text },
  listCard: { paddingVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowInfo: { flex: 1, gap: 2 },
  rowDate: { fontSize: font.body, fontWeight: '500', color: colors.text },
  rowMeta: { fontSize: font.caption, color: colors.textMuted },
  action: { padding: 4 },
  actionText: { fontSize: font.caption, color: colors.primary, fontWeight: '600' },
  deleteText: { color: colors.danger },
});
