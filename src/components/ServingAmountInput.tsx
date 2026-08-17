/**
 * Serving unit selector + amount input with a live grams/calories preview
 * before save (the plan's required "converted grams/calories before save").
 */
import { calculateCalories, servingAmountToGrams } from '@/domain/calories';
import type { Food } from '@/domain/types';
import { colors, font, spacing } from '@/theme';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Field, TextInput } from './ui';

export function ServingAmountInput({
  food,
  servingId,
  amount,
  onChange,
}: {
  food: Food;
  servingId: string;
  amount: string;
  onChange: (servingId: string, amount: string) => void;
}) {
  const serving = food.servings.find((s) => s.id === servingId) ?? food.servings[0]!;
  const amountNum = Number(amount);
  const valid = Number.isFinite(amountNum) && amountNum > 0;
  const grams = valid ? servingAmountToGrams(serving, amountNum) : null;
  const calories = valid ? calculateCalories(food.caloriesPer100g, amountNum, serving.grams) : null;
  const isApprox = serving.approx;

  return (
    <View style={styles.container}>
      <Field label="Serving size">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {food.servings.map((s) => (
            <View key={s.id} style={styles.chipWrap}>
              <Text
                accessibilityRole="button"
                accessibilityState={{ selected: s.id === serving.id }}
                onPress={() => onChange(s.id, amount)}
                style={[styles.chip, s.id === serving.id && styles.chipSelected]}
              >
                {s.label}
              </Text>
              {s.approx ? <Text style={styles.approxTag}>approx</Text> : null}
            </View>
          ))}
        </ScrollView>
      </Field>
      <Field label="Amount" error={amount !== '' && !valid ? 'Enter a number greater than 0' : null}>
        <TextInput
          value={amount}
          onChangeText={(t) => onChange(servingId, t)}
          keyboardType="decimal-pad"
          placeholder="e.g. 1"
          testID="amount-input"
        />
      </Field>
      {valid ? (
        <View accessibilityLiveRegion="polite" style={styles.preview}>
          <Text style={styles.previewText}>
            {amountNum} × {serving.label} ≈ <Text style={styles.previewStrong}>{grams} g</Text>
            {isApprox ? ' (approx)' : ''} ·{' '}
            <Text style={styles.previewStrong}>{calories} kcal</Text>
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  chips: { gap: spacing.sm, paddingVertical: 2 },
  chipWrap: { alignItems: 'center', gap: 2 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    fontSize: font.caption,
    color: colors.text,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary, color: '#fff' },
  approxTag: { fontSize: 10, color: colors.warning },
  preview: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
    borderWidth: 1,
    borderRadius: 10,
    padding: spacing.md,
  },
  previewText: { fontSize: font.body, color: colors.text },
  previewStrong: { fontWeight: '700', color: colors.primaryDark },
});
