/**
 * Activity — daily activity (steps, active calories, active minutes), manual
 * workout logging with heart-rate or MET derived calorie estimates, and the
 * net-energy view (intake − burn) for the day, ISO week and calendar month.
 *
 * Everything here is manual entry by design: no band API, no native modules.
 * Step-based "active calories" reported by a tracker often already include a
 * logged workout, so the screen says so rather than guessing.
 */
import { useApp } from '@/app-context';
import { TrendChart, type TrendPoint } from '@/components/TrendChart';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorBanner,
  Field,
  Screen,
  SectionTitle,
  TextInput,
} from '@/components/ui';
import { addDays, isValidDateKey, todayKey } from '@/domain/dates';
import type {
  ActivityDay,
  DailyEnergy,
  EnergySummary,
  Sex,
  UserProfile,
  Workout,
  WorkoutCaloriesSource,
} from '@/domain/types';
import { MET_BY_TYPE, estimateWorkoutCalories, resolveAge, workoutTypeLabel } from '@/domain/workouts';
import { colors, font, spacing } from '@/theme';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

type Range = 'day' | 'week' | 'month';

const RANGE_LABELS: Record<Range, string> = { day: 'Day', week: 'Week', month: 'Month' };
const SOURCE_LABELS: Record<WorkoutCaloriesSource, string> = {
  manual: 'entered manually',
  'hr-estimate': 'estimated from heart rate',
  'met-estimate': 'estimated from MET',
};
const WORKOUT_TYPES = Object.keys(MET_BY_TYPE);
const TREND_DAYS = 30;

/** Whole non-negative number from a form field, or null when blank/invalid. */
function parseCount(value: string): number | null {
  if (value.trim() === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Optional positive number from a form field (null when blank). */
function parseOptional(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export default function ActivityScreen() {
  const { repo } = useApp();
  const [range, setRange] = useState<Range>('day');
  const [summary, setSummary] = useState<EnergySummary | null>(null);
  const [activityDays, setActivityDays] = useState<ActivityDay[]>([]);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [dailyEnergy, setDailyEnergy] = useState<DailyEnergy[]>([]);
  const [error, setError] = useState<string | null>(null);

  // daily-activity form
  const [dayDate, setDayDate] = useState(todayKey());
  const [steps, setSteps] = useState('');
  const [activeKcal, setActiveKcal] = useState('');
  const [activeMinutes, setActiveMinutes] = useState('');
  const [dayError, setDayError] = useState<string | null>(null);
  const [daySaving, setDaySaving] = useState(false);

  // workout form
  const [workoutDate, setWorkoutDate] = useState(todayKey());
  const [workoutType, setWorkoutType] = useState(WORKOUT_TYPES[0]!);
  const [duration, setDuration] = useState('');
  const [avgHr, setAvgHr] = useState('');
  const [peakHr, setPeakHr] = useState('');
  const [manualCalories, setManualCalories] = useState('');
  const [notes, setNotes] = useState('');
  const [editingWorkoutId, setEditingWorkoutId] = useState<string | null>(null);
  const [workoutError, setWorkoutError] = useState<string | null>(null);
  const [workoutSaving, setWorkoutSaving] = useState(false);
  const [formWeightKg, setFormWeightKg] = useState<number | null>(null);

  // profile form
  const [sex, setSex] = useState<Sex | null>(null);
  const [birthYear, setBirthYear] = useState('');
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const anchor = todayKey();
      const next = await repo.getEnergySummary(range, anchor);
      setSummary(next);
      setActivityDays(await repo.getActivityDays(next.from, next.to));
      setWorkouts(await repo.getWorkouts(next.from, next.to));
      setDailyEnergy(await repo.getDailyEnergy(addDays(anchor, -(TREND_DAYS - 1)), anchor));
      const stored = await repo.getProfile();
      setProfile(stored);
      setSex(stored?.sex ?? null);
      setBirthYear(stored?.birthYear == null ? '' : String(stored.birthYear));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [repo, range]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // The calorie estimate needs the weight measured at or before the workout date.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isValidDateKey(workoutDate)) {
        setFormWeightKg(null);
        return;
      }
      try {
        const measurement = await repo.getLatestHealthBefore(workoutDate);
        if (!cancelled) setFormWeightKg(measurement?.weightKg ?? null);
      } catch {
        if (!cancelled) setFormWeightKg(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, workoutDate]);

  const preview = useMemo(() => {
    const durationMin = Number(duration);
    if (!isValidDateKey(workoutDate) || !Number.isFinite(durationMin) || durationMin <= 0) return null;
    try {
      return estimateWorkoutCalories({
        workoutType,
        durationMin,
        avgHr: parseOptional(avgHr),
        weightKg: formWeightKg,
        age: resolveAge(profile?.birthYear ?? null, workoutDate),
        sex: profile?.sex ?? null,
        manualCalories: parseOptional(manualCalories),
      });
    } catch {
      return null;
    }
  }, [workoutType, duration, workoutDate, avgHr, manualCalories, formWeightKg, profile]);

  const netPoints: TrendPoint[] = useMemo(
    () => dailyEnergy.map((d) => ({ date: d.logDate, value: d.netCalories })),
    [dailyEnergy],
  );

  const saveDay = useCallback(async () => {
    if (!isValidDateKey(dayDate)) {
      setDayError('Enter a valid date (YYYY-MM-DD)');
      return;
    }
    const s = parseCount(steps);
    const k = parseCount(activeKcal);
    const m = parseCount(activeMinutes);
    if (s == null || k == null || m == null) {
      setDayError('Steps, active calories and active minutes must be zero or more');
      return;
    }
    if (!Number.isInteger(s) || !Number.isInteger(m)) {
      setDayError('Steps and active minutes must be whole numbers');
      return;
    }
    setDaySaving(true);
    setDayError(null);
    try {
      await repo.upsertActivityDay({
        logDate: dayDate,
        steps: s,
        activeKcal: k,
        activeMinutes: m,
      });
      setSteps('');
      setActiveKcal('');
      setActiveMinutes('');
      await load();
    } catch (e) {
      setDayError(e instanceof Error ? e.message : String(e));
    } finally {
      setDaySaving(false);
    }
  }, [repo, dayDate, steps, activeKcal, activeMinutes, load]);

  const startEditDay = useCallback((day: ActivityDay) => {
    setDayDate(day.logDate);
    setSteps(String(day.steps));
    setActiveKcal(String(day.activeKcal));
    setActiveMinutes(String(day.activeMinutes));
    setDayError(null);
  }, []);

  const removeDay = useCallback(
    async (id: string) => {
      try {
        await repo.deleteActivityDay(id);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [repo, load],
  );

  const resetWorkoutForm = useCallback(() => {
    setEditingWorkoutId(null);
    setDuration('');
    setAvgHr('');
    setPeakHr('');
    setManualCalories('');
    setNotes('');
  }, []);

  const saveWorkout = useCallback(async () => {
    if (!isValidDateKey(workoutDate)) {
      setWorkoutError('Enter a valid date (YYYY-MM-DD)');
      return;
    }
    const durationMin = Number(duration);
    if (!Number.isFinite(durationMin) || durationMin <= 0) {
      setWorkoutError('Duration must be a positive number of minutes');
      return;
    }
    const avg = parseOptional(avgHr);
    const peak = parseOptional(peakHr);
    const manual = parseOptional(manualCalories);
    if ((avg != null && avg <= 0) || (peak != null && peak <= 0)) {
      setWorkoutError('Heart rates must be positive numbers');
      return;
    }
    if (manual != null && manual < 0) {
      setWorkoutError('Calories must be zero or more');
      return;
    }
    setWorkoutSaving(true);
    setWorkoutError(null);
    try {
      const input = {
        logDate: workoutDate,
        workoutType,
        durationMin,
        avgHr: avg,
        peakHr: peak,
        manualCalories: manual,
        notes: notes.trim() === '' ? null : notes,
      };
      if (editingWorkoutId) await repo.updateWorkout(editingWorkoutId, input);
      else await repo.addWorkout(input);
      resetWorkoutForm();
      await load();
    } catch (e) {
      setWorkoutError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorkoutSaving(false);
    }
  }, [
    repo,
    workoutDate,
    workoutType,
    duration,
    avgHr,
    peakHr,
    manualCalories,
    notes,
    editingWorkoutId,
    resetWorkoutForm,
    load,
  ]);

  const startEditWorkout = useCallback((workout: Workout) => {
    setEditingWorkoutId(workout.id);
    setWorkoutDate(workout.logDate);
    setWorkoutType(workout.workoutType);
    setDuration(String(workout.durationMin));
    setAvgHr(workout.avgHr == null ? '' : String(workout.avgHr));
    setPeakHr(workout.peakHr == null ? '' : String(workout.peakHr));
    setManualCalories(workout.caloriesSource === 'manual' ? String(workout.calories) : '');
    setNotes(workout.notes ?? '');
    setWorkoutError(null);
  }, []);

  const removeWorkout = useCallback(
    async (id: string) => {
      try {
        await repo.deleteWorkout(id);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [repo, load],
  );

  const saveProfile = useCallback(async () => {
    const year = birthYear.trim() === '' ? null : Number(birthYear);
    if (year != null && !Number.isInteger(year)) {
      setProfileError('Birth year must be a whole year, e.g. 1990');
      return;
    }
    setProfileSaving(true);
    setProfileError(null);
    try {
      await repo.saveProfile({ sex, birthYear: year });
      await load();
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : String(e));
    } finally {
      setProfileSaving(false);
    }
  }, [repo, sex, birthYear, load]);

  const netColor = summary && summary.netCalories < 0 ? colors.primaryDark : colors.text;
  // Burn = resting baseline + logged activity. Split them so the resting share —
  // which comes from the profile and the measurements, not from a tracker — is
  // visible rather than appearing as an unexplained jump in "Burned".
  const activeBurn =
    summary && summary.restingCalories != null ? summary.burnCalories - summary.restingCalories : null;

  return (
    <Screen>
      <SectionTitle>Energy balance</SectionTitle>
      <View style={styles.rangeRow}>
        {(['day', 'week', 'month'] as Range[]).map((r) => (
          <Chip key={r} label={RANGE_LABELS[r]} selected={range === r} onPress={() => setRange(r)} />
        ))}
      </View>
      {error ? <ErrorBanner message={error} /> : null}

      <Card>
        {summary ? (
          <>
            <Text style={styles.rangeCaption}>
              {summary.from === summary.to ? summary.from : `${summary.from} → ${summary.to}`}
            </Text>
            <View style={styles.statsRow}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Intake</Text>
                <Text style={styles.statValue} testID="energy-intake">
                  {summary.intakeCalories}
                </Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Burned</Text>
                <Text style={styles.statValue} testID="energy-burn">
                  {summary.burnCalories}
                </Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Net</Text>
                <Text style={[styles.statValue, { color: netColor }]} testID="energy-net">
                  {summary.netCalories}
                </Text>
              </View>
            </View>
            <Text style={styles.statMeta}>
              kcal
              {activeBurn != null
                ? ` · ${summary.restingCalories} resting + ${activeBurn} active`
                : ''}{' '}
              · {summary.workoutCount} workout{summary.workoutCount === 1 ? '' : 's'} logged this{' '}
              {range}
            </Text>
            <Text style={styles.hint}>
              Steady-state trackers often fold workout calories into daily active calories — log one or
              the other to avoid counting the same burn twice.
            </Text>
          </>
        ) : (
          <Text style={styles.hint}>Loading…</Text>
        )}
      </Card>

      <Card>
        <Text style={styles.chartTitle}>Net calories — last {TREND_DAYS} days</Text>
        <TrendChart points={netPoints} unit="kcal" color={colors.chartWeight} />
      </Card>

      <SectionTitle>Daily activity</SectionTitle>
      <Card>
        <Field
          label="Date (YYYY-MM-DD)"
          error={dayDate !== '' && !isValidDateKey(dayDate) ? 'Invalid date' : null}
        >
          <TextInput value={dayDate} onChangeText={setDayDate} placeholder={todayKey()} testID="activity-date" />
        </Field>
        <Field label="Steps" hint="One row per day — saving the same date updates it.">
          <TextInput value={steps} onChangeText={setSteps} keyboardType="numeric" placeholder="e.g. 9000" testID="activity-steps" />
        </Field>
        <Field label="Active calories (kcal)">
          <TextInput value={activeKcal} onChangeText={setActiveKcal} keyboardType="numeric" placeholder="e.g. 300" testID="activity-kcal" />
        </Field>
        <Field label="Active minutes">
          <TextInput value={activeMinutes} onChangeText={setActiveMinutes} keyboardType="numeric" placeholder="e.g. 45" testID="activity-minutes" />
        </Field>
        {dayError ? <ErrorBanner message={dayError} /> : null}
        <Button label="Save activity day" onPress={() => void saveDay()} loading={daySaving} testID="save-activity-day" />
      </Card>

      {activityDays.length === 0 ? (
        <EmptyState title="No activity logged in this range" body="Steps, active calories and minutes are all optional." />
      ) : (
        <Card style={styles.listCard}>
          {activityDays.map((day) => (
            <View key={day.id} style={styles.row}>
              <View style={styles.rowInfo}>
                <Text style={styles.rowDate}>{day.logDate}</Text>
                <Text style={styles.rowMeta}>
                  {day.steps.toLocaleString()} steps · {day.activeKcal} kcal · {day.activeMinutes} min
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit activity day"
                onPress={() => startEditDay(day)}
                style={styles.action}
              >
                <Text style={styles.actionText}>Edit</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete activity day"
                onPress={() => void removeDay(day.id)}
                style={styles.action}
              >
                <Text style={[styles.actionText, styles.deleteText]}>Delete</Text>
              </Pressable>
            </View>
          ))}
        </Card>
      )}

      <SectionTitle>{editingWorkoutId ? 'Edit workout' : 'Log a workout'}</SectionTitle>
      <Card>
        <Text style={styles.fieldLabel}>Type</Text>
        <View style={styles.chipWrap}>
          {WORKOUT_TYPES.map((type) => (
            <Chip
              key={type}
              label={workoutTypeLabel(type)}
              selected={workoutType === type}
              onPress={() => setWorkoutType(type)}
            />
          ))}
        </View>
        <Field
          label="Date (YYYY-MM-DD)"
          error={workoutDate !== '' && !isValidDateKey(workoutDate) ? 'Invalid date' : null}
        >
          <TextInput value={workoutDate} onChangeText={setWorkoutDate} placeholder={todayKey()} testID="workout-date" />
        </Field>
        <Field label="Duration (minutes)">
          <TextInput value={duration} onChangeText={setDuration} keyboardType="numeric" placeholder="e.g. 30" testID="workout-duration" />
        </Field>
        <Field label="Average heart rate (bpm)" hint="Optional — with weight and profile age it drives the estimate.">
          <TextInput value={avgHr} onChangeText={setAvgHr} keyboardType="numeric" placeholder="e.g. 150" testID="workout-avg-hr" />
        </Field>
        <Field label="Peak heart rate (bpm)" hint="Stored for reference; it never enters the estimate.">
          <TextInput value={peakHr} onChangeText={setPeakHr} keyboardType="numeric" placeholder="e.g. 172" testID="workout-peak-hr" />
        </Field>
        <Field label="Calories (kcal)" hint="Leave blank to use the estimate; a value here always wins.">
          <TextInput value={manualCalories} onChangeText={setManualCalories} keyboardType="numeric" placeholder="optional override" testID="workout-manual-kcal" />
        </Field>
        <Field label="Notes">
          <TextInput value={notes} onChangeText={setNotes} placeholder="optional" testID="workout-notes" />
        </Field>
        <Text style={styles.estimate} testID="workout-estimate">
          {preview
            ? `Estimate: ${preview.calories} kcal (${SOURCE_LABELS[preview.source]})`
            : 'No estimate yet — add a duration and either your weight plus profile age (heart-rate estimate) or a known workout type (MET estimate), or enter calories yourself.'}
        </Text>
        {workoutError ? <ErrorBanner message={workoutError} /> : null}
        <View style={styles.formActions}>
          <Button
            label={editingWorkoutId ? 'Save workout' : 'Log workout'}
            onPress={() => void saveWorkout()}
            loading={workoutSaving}
            testID="save-workout"
          />
          {editingWorkoutId ? <Button variant="secondary" label="Cancel" onPress={resetWorkoutForm} /> : null}
        </View>
      </Card>

      <SectionTitle>Workouts</SectionTitle>
      {workouts.length === 0 ? (
        <EmptyState title="No workouts logged in this range" body="Logging a workout adds its burn to the net total above." />
      ) : (
        <Card style={styles.listCard}>
          {workouts.map((workout) => (
            <View key={workout.id} style={styles.row}>
              <View style={styles.rowInfo}>
                <Text style={styles.rowDate}>
                  {workout.logDate} · {workoutTypeLabel(workout.workoutType)}
                </Text>
                <Text style={styles.rowMeta}>
                  {workout.durationMin} min · {workout.calories} kcal ({SOURCE_LABELS[workout.caloriesSource]})
                  {workout.avgHr == null ? '' : ` · avg ${workout.avgHr} bpm`}
                  {workout.peakHr == null ? '' : ` · peak ${workout.peakHr} bpm`}
                </Text>
                {workout.notes ? <Text style={styles.rowMeta}>{workout.notes}</Text> : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit workout"
                onPress={() => startEditWorkout(workout)}
                style={styles.action}
              >
                <Text style={styles.actionText}>Edit</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Delete workout"
                onPress={() => void removeWorkout(workout.id)}
                style={styles.action}
              >
                <Text style={[styles.actionText, styles.deleteText]}>Delete</Text>
              </Pressable>
            </View>
          ))}
        </Card>
      )}

      <SectionTitle>Profile</SectionTitle>
      <Card>
        <Text style={styles.fieldLabel}>Sex (used by the heart-rate equation)</Text>
        <View style={styles.rangeRow}>
          <Chip label="Male" selected={sex === 'male'} onPress={() => setSex(sex === 'male' ? null : 'male')} />
          <Chip label="Female" selected={sex === 'female'} onPress={() => setSex(sex === 'female' ? null : 'female')} />
        </View>
        <Field label="Birth year" hint="Only the year is stored — it sets the age term in the estimate.">
          <TextInput value={birthYear} onChangeText={setBirthYear} keyboardType="numeric" placeholder="e.g. 1990" testID="profile-birth-year" />
        </Field>
        {profileError ? <ErrorBanner message={profileError} /> : null}
        <Button label="Save profile" onPress={() => void saveProfile()} loading={profileSaving} testID="save-profile" />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  rangeRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  chipWrap: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  rangeCaption: { fontSize: font.caption, color: colors.textMuted },
  statsRow: { flexDirection: 'row', gap: spacing.lg },
  stat: { flex: 1, alignItems: 'center', gap: spacing.xs },
  statLabel: { fontSize: font.caption, color: colors.textMuted },
  statValue: { fontSize: 28, fontWeight: '800', color: colors.text },
  statMeta: { fontSize: font.caption, color: colors.textMuted, textAlign: 'center' },
  hint: { fontSize: font.caption, color: colors.textMuted, fontStyle: 'italic' },
  chartTitle: { fontSize: font.section, fontWeight: '600', color: colors.text },
  fieldLabel: { fontSize: font.caption, fontWeight: '600', color: colors.textMuted },
  estimate: { fontSize: font.body, color: colors.text, fontWeight: '600' },
  formActions: { flexDirection: 'row', gap: spacing.sm },
  listCard: { paddingVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowInfo: { flex: 1, gap: 2 },
  rowDate: { fontSize: font.body, fontWeight: '500', color: colors.text },
  rowMeta: { fontSize: font.caption, color: colors.textMuted },
  action: { padding: 4 },
  actionText: { fontSize: font.caption, color: colors.primary, fontWeight: '600' },
  deleteText: { color: colors.danger },
});
