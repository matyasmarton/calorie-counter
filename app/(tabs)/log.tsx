/**
 * Daily logging flow — the app's home screen.
 * Defaults to the local calendar date; supports navigation to any date
 * (history passes a `date` param so corrections use the identical path).
 * Add/edit/delete entries, live serving preview, explicit empty/error states.
 */
import { FoodPicker } from '@/components/FoodPicker';
import { ServingAmountInput } from '@/components/ServingAmountInput';
import { DailyEntryRow } from '@/components/DailyEntryRow';
import { MealQuickAdd } from '@/components/MealQuickAdd';
import { Button, Card, EmptyState, ErrorBanner, Screen, SectionTitle } from '@/components/ui';
import { useApp } from '@/app-context';
import { useLocalModel } from '@/local-ai/model-context';
import { addDays, formatDateKey, isValidDateKey, todayKey } from '@/domain/dates';
import type { DailyEntry, Food } from '@/domain/types';
import { useSyncStatus, syncStatusLabel } from '@/hooks/useSyncStatus';
import { colors, font, spacing } from '@/theme';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export default function LogScreen() {
  const { repo } = useApp();
  const { adapter, enabled } = useLocalModel();
  const router = useRouter();
  const params = useLocalSearchParams<{ date?: string }>();
  const { status, pending } = useSyncStatus();

  const [date, setDate] = useState<string>(() =>
    params.date && isValidDateKey(params.date) ? params.date : todayKey(),
  );
  const [entries, setEntries] = useState<DailyEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // add/edit form state
  const [selectedFood, setSelectedFood] = useState<Food | null>(null);
  const [servingId, setServingId] = useState('');
  const [amount, setAmount] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  const loadEntries = useCallback(
    async (d: string) => {
      try {
        setLoadError(null);
        setEntries(await repo.getDailyEntries(d));
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    },
    [repo],
  );

  useEffect(() => {
    setDate((prev) => (params.date && isValidDateKey(params.date) ? params.date : prev));
  }, [params.date]);

  useFocusEffect(
    useCallback(() => {
      void loadEntries(date);
    }, [date, loadEntries]),
  );

  const total = useMemo(() => entries.reduce((sum, e) => sum + e.calories, 0), [entries]);
  const macroTotals = useMemo(
    () =>
      entries.reduce(
        (sum, e) => ({
          protein: sum.protein + (e.proteinGrams ?? 0),
          carbs: sum.carbs + (e.carbsGrams ?? 0),
          fat: sum.fat + (e.fatGrams ?? 0),
        }),
        { protein: 0, carbs: 0, fat: 0 },
      ),
    [entries],
  );
  const isFuture = date > todayKey();

  const startEdit = useCallback(
    async (entry: DailyEntry) => {
      try {
        setDbError(null);
        const food = await repo.getFood(entry.foodId);
        setSelectedFood(food);
        setServingId(entry.servingId);
      } catch {
        // catalog food no longer available — rebuild from the entry snapshot
        const snapshot: Food = {
          id: entry.foodId,
          name: entry.foodName,
          category: 'Custom',
          caloriesPer100g: entry.caloriesPer100g,
          proteinPer100g: entry.proteinGrams ?? null,
          carbsPer100g: entry.carbsGrams ?? null,
          fatPer100g: entry.fatGrams ?? null,
          servings: [
            {
              id: entry.servingId,
              label: entry.servingLabel,
              grams: entry.servingGrams,
              approx: false,
            },
          ],
          source: 'catalog',
          ownerId: null,
          sourceRef: null,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          deletedAt: null,
        };
        setSelectedFood(snapshot);
        setServingId(entry.servingId);
      }
      setAmount(String(entry.amount));
      setEditingId(entry.id);
      setFormError(null);
    },
    [repo],
  );

  const resetForm = useCallback(() => {
    setSelectedFood(null);
    setServingId('');
    setAmount('');
    setEditingId(null);
    setFormError(null);
  }, []);

  const save = useCallback(async () => {
    if (!selectedFood) {
      setFormError('Choose a food first');
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setFormError('Enter an amount greater than 0');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editingId) {
        await repo.updateEntry(editingId, { servingId, amount: amt });
      } else {
        await repo.addEntry({ logDate: date, foodId: selectedFood.id, servingId, amount: amt });
      }
      resetForm();
      await loadEntries(date);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selectedFood, amount, servingId, editingId, date, repo, resetForm, loadEntries]);

  const remove = useCallback(
    async (id: string) => {
      try {
        setDbError(null);
        await repo.deleteEntry(id);
        await loadEntries(date);
      } catch (e) {
        setDbError(e instanceof Error ? e.message : String(e));
      }
    },
    [repo, date, loadEntries],
  );

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous day" onPress={() => setDate((d) => addDays(d, -1))} style={styles.navBtn}>
          <Text style={styles.navText}>‹</Text>
        </Pressable>
        <View style={styles.dateCol}>
          <Text style={styles.dateTitle}>{formatDateKey(date)}</Text>
          <Text style={styles.dateSub}>
            {date === todayKey() ? 'Today' : isFuture ? 'Planned day (future)' : 'Past day'}
          </Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Next day" onPress={() => setDate((d) => addDays(d, 1))} style={styles.navBtn}>
          <Text style={styles.navText}>›</Text>
        </Pressable>
        {date !== todayKey() ? (
          <Button variant="ghost" label="Today" onPress={() => setDate(todayKey())} />
        ) : null}
      </View>

      <Card style={styles.totalCard}>
        <Text style={styles.totalLabel}>Daily total</Text>
        <Text style={styles.totalValue} testID="daily-total">
          {total.toLocaleString()} kcal
        </Text>
        <Text style={styles.macroLine} testID="daily-macros">
          P {Math.round(macroTotals.protein * 10) / 10} · C {Math.round(macroTotals.carbs * 10) / 10} · F{' '}
          {Math.round(macroTotals.fat * 10) / 10} g
        </Text>
        <Text style={styles.totalCount}>
          {entries.length} entr{entries.length === 1 ? 'y' : 'ies'} · {syncStatusLabel(status, pending)}
        </Text>
      </Card>

      {loadError ? <ErrorBanner message={`Could not load entries: ${loadError}`} /> : null}
      {dbError ? <ErrorBanner message={`Database error: ${dbError}`} /> : null}
      {formError ? <ErrorBanner message={formError} /> : null}

      {enabled && adapter.isReady() ? (
        <MealQuickAdd logDate={date} onAdded={() => void loadEntries(date)} />
      ) : null}

      {!selectedFood ? (
        <Card>
          <SectionTitle>{editingId ? 'Edit entry' : 'Add food'}</SectionTitle>
          <FoodPicker onSelect={(food) => { setSelectedFood(food); setServingId(food.servings[0]?.id ?? ''); setAmount(''); setFormError(null); }} />
        </Card>
      ) : (
        <Card>
          <View style={styles.selectedHeader}>
            <View style={styles.selectedInfo}>
              <Text style={styles.selectedName}>{selectedFood.name}</Text>
              <Text style={styles.selectedSub}>
                {selectedFood.caloriesPer100g} kcal/100 g · {selectedFood.source === 'user' ? 'custom food' : 'catalog'}
                {selectedFood.proteinPer100g != null && selectedFood.carbsPer100g != null && selectedFood.fatPer100g != null
                  ? ` · P ${selectedFood.proteinPer100g} C ${selectedFood.carbsPer100g} F ${selectedFood.fatPer100g}`
                  : ' · macros unavailable'}
              </Text>
            </View>
            <Button variant="ghost" label="Change" onPress={() => setSelectedFood(null)} />
          </View>
          <ServingAmountInput food={selectedFood} servingId={servingId} amount={amount} onChange={(sid, amt) => { setServingId(sid); setAmount(amt); }} />
          <View style={styles.formActions}>
            <Button
              label={editingId ? 'Save changes' : `Add to ${formatDateKey(date)}`}
              onPress={save}
              loading={saving}
              testID="save-entry"
            />
            {editingId ? <Button variant="secondary" label="Cancel" onPress={resetForm} /> : null}
          </View>
        </Card>
      )}

      <SectionTitle>Logged foods</SectionTitle>
      {entries.length === 0 ? (
        <EmptyState
          title={loadError ? 'Could not load this day' : 'Nothing logged yet'}
          body={loadError ? undefined : 'Search a food above and add your first entry.'}
        />
      ) : (
        <Card style={styles.entriesCard}>
          {entries.map((e) => (
            <DailyEntryRow key={e.id} entry={e} onEdit={() => void startEdit(e)} onDelete={() => void remove(e.id)} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  navBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  navText: { fontSize: 22, color: colors.text },
  dateCol: { flex: 1, alignItems: 'center' },
  dateTitle: { fontSize: font.title, fontWeight: '700', color: colors.text },
  dateSub: { fontSize: font.caption, color: colors.textMuted },
  totalCard: { alignItems: 'center' },
  totalLabel: { fontSize: font.caption, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 },
  totalValue: { fontSize: 34, fontWeight: '800', color: colors.primaryDark },
  macroLine: { fontSize: font.body, fontWeight: '600', color: colors.text },
  totalCount: { fontSize: font.caption, color: colors.textMuted },
  selectedHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  selectedInfo: { flex: 1 },
  selectedName: { fontSize: font.section, fontWeight: '700', color: colors.text },
  selectedSub: { fontSize: font.caption, color: colors.textMuted },
  formActions: { flexDirection: 'row', gap: spacing.sm },
  entriesCard: { paddingVertical: spacing.sm },
});
