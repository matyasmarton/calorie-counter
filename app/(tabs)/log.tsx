/**
 * Daily logging flow — the app's home screen.
 * Defaults to the local calendar date; supports navigation to any date
 * (history passes a `date` param so corrections use the identical path).
 * Add/edit/delete entries, live serving preview, explicit empty/error states.
 *
 * Layout: one centered reading column on phones and tablets (Summary, This week,
 * Entries, Add form). Past the tablet breakpoint the same blocks sit in a
 * two-column grid: the summary across the top, entries beside the add form, and
 * the week charts across the bottom.
 */
import { FoodPicker } from '@/components/FoodPicker';
import { ServingAmountInput } from '@/components/ServingAmountInput';
import { DailyEntryRow } from '@/components/DailyEntryRow';
import { MealQuickAdd } from '@/components/MealQuickAdd';
import { TrendChart } from '@/components/TrendChart';
import { Button, Card, EmptyState, ErrorBanner, Screen, SectionTitle } from '@/components/ui';
import { useApp } from '@/app-context';
import { useLocalModel } from '@/local-ai/model-context';
import { roundTo } from '@/domain/calories';
import { addDays, formatDateKey, isValidDateKey, todayKey } from '@/domain/dates';
import { netEnergy } from '@/domain/energy';
import type { DailyEnergy, DailyEntry, Food } from '@/domain/types';
import { useSyncStatus, syncStatusLabel } from '@/hooks/useSyncStatus';
import { colors, font, spacing } from '@/theme';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

/** Entries shown before "Show all" — the front page previews only the latest few. */
const PREVIEW_COUNT = 2;

/** The week graph always covers the last seven days ending today. */
const WEEK_DAYS = 7;

/** Wider than a tablet: the Log opens up into columns instead of one long column. */
const WIDE_BREAKPOINT = 1024;
const WIDE_MAX_WIDTH = 1100;

/**
 * Surplus/deficit wording, defined once so the day summary and the week headline
 * can never drift apart. Sign convention comes from the energy domain:
 * positive = surplus, negative = deficit, zero = on target.
 */
function balanceLabel(net: number): string {
  if (net === 0) return 'on target';
  return `${Math.abs(net).toLocaleString()} kcal ${net > 0 ? 'surplus' : 'deficit'}`;
}

/** Ink for a signed balance: surplus rust, deficit green, on-target muted. */
function netTone(net: number) {
  return net === 0 ? styles.netNeutral : net > 0 ? styles.netSurplus : styles.netDeficit;
}

/** Intake vs. burn for one day, in display type. */
function SummaryCard({
  total,
  net,
  burn,
  workoutCount,
  entryCount,
  macroTotals,
  syncLabel,
}: {
  total: number;
  net: number;
  burn: number | null;
  workoutCount: number | null;
  entryCount: number;
  macroTotals: { protein: number; carbs: number; fat: number };
  syncLabel: string;
}) {
  return (
    <Card style={styles.totalCard}>
      <Text style={styles.totalLabel}>Daily total</Text>
      <Text style={styles.totalValue} testID="daily-total">
        {total.toLocaleString()} kcal
      </Text>
      <Text style={styles.burnLine} testID="burn-total">
        {burn === null
          ? 'burn unavailable'
          : `${burn.toLocaleString()} kcal burnt - ${workoutCount ?? 0} ${
              (workoutCount ?? 0) === 1 ? 'workout' : 'workouts'
            }`}
      </Text>
      <Text style={[styles.netLine, netTone(net)]} testID="net-energy">
        {balanceLabel(net)}
      </Text>
      <Text style={styles.macroLine} testID="daily-macros">
        P {roundTo(macroTotals.protein, 1)} · C {roundTo(macroTotals.carbs, 1)} · F {roundTo(macroTotals.fat, 1)} g
      </Text>
      <Text style={styles.totalCount}>
        {entryCount} entr{entryCount === 1 ? 'y' : 'ies'} · {syncLabel}
      </Text>
    </Card>
  );
}

/** Seven-day intake and balance trends, always anchored on today. */
function WeekGraphCard({ week, weekNet }: { week: DailyEnergy[]; weekNet: number }) {
  return (
    <Card>
      <SectionTitle>This week</SectionTitle>
      <Text style={[styles.weekHeadline, netTone(weekNet)]} testID="week-net">
        {week.length === 0 ? 'No days logged yet' : `${balanceLabel(weekNet)} this week`}
      </Text>
      <View style={styles.chartBlock}>
        <Text style={styles.chartCaption}>Intake</Text>
        <TrendChart points={week.map((d) => ({ date: d.logDate, value: d.intakeCalories }))} unit="kcal" />
      </View>
      <View style={styles.chartBlock}>
        <Text style={styles.chartCaption}>Balance (intake − burn)</Text>
        <TrendChart
          points={week.map((d) => ({ date: d.logDate, value: d.netCalories }))}
          unit="kcal"
          color={colors.rust}
        />
        <Text style={styles.chartNote}>positive = surplus</Text>
      </View>
    </Card>
  );
}

/** The day's log — a two-entry preview with the rest behind "Show all". */
function EntriesBlock({
  entries,
  expanded,
  error,
  onToggleExpanded,
  onEdit,
  onDelete,
}: {
  entries: DailyEntry[];
  expanded: boolean;
  error: string | null;
  onToggleExpanded: () => void;
  onEdit: (entry: DailyEntry) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <SectionTitle>Logged foods</SectionTitle>
      {entries.length === 0 ? (
        <EmptyState
          title={error ? 'Could not load this day' : 'Nothing logged yet'}
          body={error ? undefined : 'Search a food above and add your first entry.'}
        />
      ) : (
        <Card style={styles.entriesCard}>
          {entries.slice(0, expanded ? undefined : PREVIEW_COUNT).map((e) => (
            <DailyEntryRow key={e.id} entry={e} onEdit={() => onEdit(e)} onDelete={() => onDelete(e.id)} />
          ))}
          {entries.length > PREVIEW_COUNT ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                // Native layout animation before the toggle — no animation library.
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                onToggleExpanded();
              }}
              style={styles.showAllRow}
            >
              <Text style={styles.showAllText}>
                {expanded ? 'Show less' : `Show all ${entries.length} entries`}
              </Text>
            </Pressable>
          ) : null}
        </Card>
      )}
    </>
  );
}

/** Pick a food (or change the one being edited) and save it to the viewed day. */
function AddFormBlock({
  date,
  selectedFood,
  servingId,
  amount,
  editingId,
  saving,
  quickAdd,
  onSelectFood,
  onChangeAmount,
  onSave,
  onCancel,
}: {
  date: string;
  selectedFood: Food | null;
  servingId: string;
  amount: string;
  editingId: string | null;
  saving: boolean;
  quickAdd: ReactNode;
  onSelectFood: (food: Food) => void;
  onChangeAmount: (servingId: string, amount: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      {quickAdd}
      {selectedFood ? (
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
            <Button variant="ghost" label="Change" onPress={onCancel} />
          </View>
          <ServingAmountInput food={selectedFood} servingId={servingId} amount={amount} onChange={onChangeAmount} />
          <View style={styles.formActions}>
            <Button
              label={editingId ? 'Save changes' : `Add to ${formatDateKey(date)}`}
              onPress={onSave}
              loading={saving}
              testID="save-entry"
            />
            {editingId ? <Button variant="secondary" label="Cancel" onPress={onCancel} /> : null}
          </View>
        </Card>
      ) : (
        <Card>
          <SectionTitle>{editingId ? 'Edit entry' : 'Add food'}</SectionTitle>
          <FoodPicker onSelect={onSelectFood} />
        </Card>
      )}
    </>
  );
}

export default function LogScreen() {
  const { repo } = useApp();
  const { adapter, enabled } = useLocalModel();
  const params = useLocalSearchParams<{ date?: string }>();
  const { status, pending } = useSyncStatus();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;

  const [date, setDate] = useState<string>(() =>
    params.date && isValidDateKey(params.date) ? params.date : todayKey(),
  );
  const [entries, setEntries] = useState<DailyEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Burn for the viewed day: null until loaded and whenever the query fails. */
  const [burn, setBurn] = useState<number | null>(null);
  const [workoutCount, setWorkoutCount] = useState<number | null>(null);
  /** The list previews the two most recent entries until "Show all" is tapped. */
  const [expanded, setExpanded] = useState(false);
  /** Last seven days ending today, for the front-page trend graph. */
  const [week, setWeek] = useState<DailyEnergy[]>([]);

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
        // Entries drive intake; the energy summary only adds burn, so a failed
        // summary must not take the day's entries down with it. The week window is
        // always anchored on today — the graph is front-page context, not a
        // function of the day being viewed.
        const [nextEntries, summary, nextWeek] = await Promise.all([
          repo.getDailyEntries(d),
          repo.getEnergySummary('day', d).then(
            (s) => s,
            () => null,
          ),
          repo.getDailyEnergy(addDays(todayKey(), -(WEEK_DAYS - 1)), todayKey()).then(
            (w) => w,
            () => null,
          ),
        ]);
        setEntries(nextEntries);
        setBurn(summary?.burnCalories ?? null);
        setWorkoutCount(summary?.workoutCount ?? null);
        setWeek(nextWeek ?? []);
        // A reloaded day (or a different day) always starts as a preview.
        setExpanded(false);
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
  // Intake comes from the entries (refreshes on add/edit/delete); burn from the
  // energy summary. Positive net = surplus.
  const balance = useMemo(() => netEnergy(total, burn ?? 0), [total, burn]);
  const weekTotals = useMemo(
    () =>
      week.reduce(
        (sum, d) => ({ intake: sum.intake + d.intakeCalories, burn: sum.burn + d.burnCalories }),
        { intake: 0, burn: 0 },
      ),
    [week],
  );
  const weekNet = netEnergy(weekTotals.intake, weekTotals.burn).net;
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

  const selectFood = useCallback((food: Food) => {
    setSelectedFood(food);
    setServingId(food.servings[0]?.id ?? '');
    setAmount('');
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

  const summaryBlock = (
    <SummaryCard
      total={total}
      net={balance.net}
      burn={burn}
      workoutCount={workoutCount}
      entryCount={entries.length}
      macroTotals={macroTotals}
      syncLabel={syncStatusLabel(status, pending)}
    />
  );
  const graphBlock = <WeekGraphCard week={week} weekNet={weekNet} />;
  const entriesBlock = (
    <EntriesBlock
      entries={entries}
      expanded={expanded}
      error={loadError}
      onToggleExpanded={() => setExpanded((v) => !v)}
      onEdit={(entry) => void startEdit(entry)}
      onDelete={(id) => void remove(id)}
    />
  );
  const formBlock = (
    <AddFormBlock
      date={date}
      selectedFood={selectedFood}
      servingId={servingId}
      amount={amount}
      editingId={editingId}
      saving={saving}
      quickAdd={
        enabled && adapter.isReady() ? (
          <MealQuickAdd logDate={date} onAdded={() => void loadEntries(date)} />
        ) : null
      }
      onSelectFood={selectFood}
      onChangeAmount={(sid, amt) => {
        setServingId(sid);
        setAmount(amt);
      }}
      onSave={() => void save()}
      onCancel={resetForm}
    />
  );

  return (
    <Screen maxWidth={wide ? WIDE_MAX_WIDTH : undefined}>
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
        {date === todayKey() ? null : (
          <Button variant="ghost" label="Today" onPress={() => setDate(todayKey())} />
        )}
      </View>

      {summaryBlock}

      {loadError ? <ErrorBanner message={`Could not load entries: ${loadError}`} /> : null}
      {dbError ? <ErrorBanner message={`Database error: ${dbError}`} /> : null}
      {formError ? <ErrorBanner message={formError} /> : null}

      {wide ? (
        <>
          <View style={styles.gridRow}>
            <View style={styles.gridCell}>{entriesBlock}</View>
            <View style={styles.gridCell}>{formBlock}</View>
          </View>
          {graphBlock}
        </>
      ) : (
        <>
          {graphBlock}
          {entriesBlock}
          {formBlock}
        </>
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
  totalValue: { fontSize: 34, fontWeight: '800', color: colors.primaryDark, fontVariant: ['tabular-nums'] },
  burnLine: { fontSize: font.body, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  netLine: { fontSize: font.section, fontWeight: '700', fontVariant: ['tabular-nums'] },
  netSurplus: { color: colors.rust },
  netDeficit: { color: colors.primary },
  netNeutral: { color: colors.textMuted },
  macroLine: { fontSize: font.body, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  totalCount: { fontSize: font.caption, color: colors.textMuted },
  selectedHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  selectedInfo: { flex: 1 },
  selectedName: { fontSize: font.section, fontWeight: '700', color: colors.text },
  selectedSub: { fontSize: font.caption, color: colors.textMuted },
  formActions: { flexDirection: 'row', gap: spacing.sm },
  entriesCard: { paddingVertical: spacing.sm },
  showAllRow: { paddingVertical: spacing.sm, alignItems: 'center' },
  showAllText: { fontSize: font.caption, fontWeight: '600', color: colors.primary },
  weekHeadline: { fontSize: font.section, fontWeight: '700', fontVariant: ['tabular-nums'] },
  chartBlock: { gap: spacing.xs },
  chartCaption: {
    fontSize: font.caption,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  chartNote: { fontSize: font.caption, color: colors.textMuted },
  gridRow: { flexDirection: 'row', gap: spacing.lg, alignItems: 'flex-start' },
  gridCell: { flex: 1, gap: spacing.md },
});
