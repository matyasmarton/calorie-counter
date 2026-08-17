/**
 * Custom foods — create/edit/delete user foods with calories per 100 g and
 * household serving definitions. Catalog foods are read-only here.
 */
import { useApp } from '@/app-context';
import { Button, Card, Chip, EmptyState, ErrorBanner, Field, Screen, SectionTitle, TextInput } from '@/components/ui';
import type { Serving, UserFood } from '@/domain/types';
import { colors, font, spacing } from '@/theme';
import React, { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

interface ServingRow {
  key: string;
  label: string;
  grams: string;
}

const PRESETS: { label: string; grams: number }[] = [
  { label: 'g', grams: 1 },
  { label: 'oz', grams: 28.35 },
  { label: 'cup', grams: 240 },
  { label: 'tbsp', grams: 15 },
  { label: 'tsp', grams: 5 },
  { label: 'piece', grams: 100 },
  { label: 'handful', grams: 30 },
  { label: 'slice', grams: 30 },
];

let keySeq = 0;
const newKey = () => `sv-${++keySeq}`;

const defaultRows = (): ServingRow[] => [
  { key: newKey(), label: 'g', grams: '1' },
  { key: newKey(), label: 'oz', grams: '28.35' },
];

export default function FoodsScreen() {
  const { repo } = useApp();
  const [foods, setFoods] = useState<UserFood[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<UserFood | null>(null);
  const [name, setName] = useState('');
  const [kcal, setKcal] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [rows, setRows] = useState<ServingRow[]>(defaultRows);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setFoods(await repo.getUserFoods());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [repo]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const resetForm = useCallback(() => {
    setEditing(null);
    setName('');
    setKcal('');
    setProtein('');
    setCarbs('');
    setFat('');
    setRows(defaultRows());
    setFormError(null);
  }, []);

  const startEdit = useCallback((f: UserFood) => {
    setEditing(f);
    setName(f.name);
    setKcal(String(f.caloriesPer100g));
    setProtein(f.proteinPer100g == null ? '' : String(f.proteinPer100g));
    setCarbs(f.carbsPer100g == null ? '' : String(f.carbsPer100g));
    setFat(f.fatPer100g == null ? '' : String(f.fatPer100g));
    setRows(f.servings.map((s) => ({ key: newKey(), label: s.label, grams: String(s.grams) })));
    setFormError(null);
  }, []);

  const save = useCallback(async () => {
    const servings: Serving[] = rows
      .map((r) => ({ id: r.key, label: r.label.trim(), grams: Number(r.grams), approx: true }))
      .filter((s) => s.label !== '');
    const parseMacro = (v: string): number | null => {
      const n = Number(v);
      return v.trim() === '' ? null : n;
    };
    if (!name.trim()) {
      setFormError('Name is required');
      return;
    }
    if (!Number.isFinite(Number(kcal)) || Number(kcal) < 0) {
      setFormError('Calories per 100 g must be a non-negative number');
      return;
    }
    const p = parseMacro(protein);
    const c = parseMacro(carbs);
    const f = parseMacro(fat);
    if (p != null && (!Number.isFinite(p) || p < 0)) {
      setFormError('Protein per 100 g must be a non-negative number');
      return;
    }
    if (c != null && (!Number.isFinite(c) || c < 0)) {
      setFormError('Carbohydrates per 100 g must be a non-negative number');
      return;
    }
    if (f != null && (!Number.isFinite(f) || f < 0)) {
      setFormError('Fat per 100 g must be a non-negative number');
      return;
    }
    if (servings.length === 0 || servings.some((s) => !Number.isFinite(s.grams) || s.grams <= 0)) {
      setFormError('Add at least one serving size with a positive gram weight');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const input = { name, caloriesPer100g: Number(kcal), proteinPer100g: p, carbsPer100g: c, fatPer100g: f, servings };
      if (editing) {
        await repo.updateUserFood(editing.id, input);
      } else {
        await repo.createUserFood(input);
      }
      resetForm();
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [repo, editing, name, kcal, protein, carbs, fat, rows, load, resetForm]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await repo.deleteUserFood(id);
        setConfirmDeleteId(null);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [repo, load],
  );

  const updateRow = useCallback((key: string, patch: Partial<ServingRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  return (
    <Screen>
      <SectionTitle>{editing ? `Edit: ${editing.name}` : 'Add custom food'}</SectionTitle>
      <Card>
        <Field label="Name">
          <TextInput value={name} onChangeText={setName} placeholder="e.g. Mom's granola" autoCapitalize="sentences" testID="food-name" />
        </Field>
        <Field label="Calories per 100 g" hint="Use the value on the package or a trusted source.">
          <TextInput value={kcal} onChangeText={setKcal} keyboardType="decimal-pad" placeholder="e.g. 420" testID="food-kcal" />
        </Field>
        <Field label="Protein per 100 g (g)" hint="Optional for legacy foods; needed for macro totals.">
          <TextInput value={protein} onChangeText={setProtein} keyboardType="decimal-pad" placeholder="e.g. 18" testID="food-protein" />
        </Field>
        <Field label="Carbs per 100 g (g)" hint="Optional for legacy foods; needed for macro totals.">
          <TextInput value={carbs} onChangeText={setCarbs} keyboardType="decimal-pad" placeholder="e.g. 30" testID="food-carbs" />
        </Field>
        <Field label="Fat per 100 g (g)" hint="Optional for legacy foods; needed for macro totals.">
          <TextInput value={fat} onChangeText={setFat} keyboardType="decimal-pad" placeholder="e.g. 8" testID="food-fat" />
        </Field>
        <Field label="Serving sizes" hint="Each serving stores grams — all calorie math uses the same formula.">
          <View style={styles.presets}>
            {PRESETS.map((p) => (
              <Chip
                key={p.label}
                label={p.label}
                selected={rows.some((r) => r.label === p.label && r.grams === String(p.grams))}
                onPress={() => setRows((rs) => [...rs, { key: newKey(), label: p.label, grams: String(p.grams) }])}
              />
            ))}
          </View>
          {rows.map((r) => (
            <View key={r.key} style={styles.servingRow}>
              <View style={styles.servingLabel}>
                <TextInput value={r.label} onChangeText={(t) => updateRow(r.key, { label: t })} placeholder="label" testID={`sv-label-${r.key}`} />
              </View>
              <View style={styles.servingGrams}>
                <TextInput value={r.grams} onChangeText={(t) => updateRow(r.key, { grams: t })} keyboardType="decimal-pad" placeholder="grams" testID={`sv-grams-${r.key}`} />
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove serving ${r.label}`} onPress={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} style={styles.removeBtn}>
                <Text style={styles.removeText}>✕</Text>
              </Pressable>
            </View>
          ))}
        </Field>
        {formError ? <ErrorBanner message={formError} /> : null}
        <View style={styles.actions}>
          <Button label={editing ? 'Save changes' : 'Add food'} onPress={save} loading={saving} />
          {editing ? <Button variant="secondary" label="Cancel" onPress={resetForm} /> : null}
        </View>
      </Card>

      <SectionTitle>Your foods</SectionTitle>
      {error ? <ErrorBanner message={error} /> : null}
      {foods.length === 0 ? (
        <EmptyState title="No custom foods yet" body="Foods you add here are saved on this account and synced across devices." />
      ) : (
        <Card style={styles.listCard}>
          {foods.map((f) => (
            <View key={f.id} style={styles.row}>
              <View style={styles.rowInfo}>
                <Text style={styles.rowName}>{f.name}</Text>
                <Text style={styles.rowMeta}>
                  {f.caloriesPer100g} kcal/100 g · {f.servings.length} serving{f.servings.length === 1 ? '' : 's'}
                </Text>
                <Text style={styles.rowMeta}>
                  {f.proteinPer100g != null && f.carbsPer100g != null && f.fatPer100g != null
                    ? `P ${f.proteinPer100g} · C ${f.carbsPer100g} · F ${f.fatPer100g} g/100 g`
                    : 'Macros unavailable'}
                </Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${f.name}`} onPress={() => startEdit(f)} style={styles.rowAction}>
                <Text style={styles.rowActionText}>Edit</Text>
              </Pressable>
              {confirmDeleteId === f.id ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`Confirm delete ${f.name}`} onPress={() => void remove(f.id)} style={styles.rowAction}>
                  <Text style={[styles.rowActionText, styles.confirmText]}>Confirm?</Text>
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${f.name}`}
                  onPress={() => {
                    setConfirmDeleteId(f.id);
                    setTimeout(() => setConfirmDeleteId((cur) => (cur === f.id ? null : cur)), 3000);
                  }}
                  style={styles.rowAction}
                >
                  <Text style={[styles.rowActionText, styles.deleteText]}>Delete</Text>
                </Pressable>
              )}
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  servingRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  servingLabel: { flex: 1 },
  servingGrams: { flex: 1 },
  removeBtn: { width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  removeText: { color: colors.danger, fontSize: font.body },
  actions: { flexDirection: 'row', gap: spacing.sm },
  listCard: { paddingVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowInfo: { flex: 1, gap: 2 },
  rowName: { fontSize: font.body, fontWeight: '500', color: colors.text },
  rowMeta: { fontSize: font.caption, color: colors.textMuted },
  rowAction: { padding: 4 },
  rowActionText: { fontSize: font.caption, color: colors.primary, fontWeight: '600' },
  deleteText: { color: colors.danger },
  confirmText: { color: colors.warning },
});
