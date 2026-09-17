/**
 * One logged entry row: name, serving, grams, calories, edit/delete actions.
 */
import type { DailyEntry } from '@/domain/types';
import { colors, font, spacing } from '@/theme';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

export function DailyEntryRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: DailyEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.info}>
        <Text style={styles.name}>{entry.foodName}</Text>
        <Text style={styles.sub}>
          {entry.amount} × {entry.servingLabel}
          {entry.servingGrams !== 1 ? ` (${entry.servingGrams} g)` : ''} · {entry.grams} g
        </Text>
        {entry.proteinGrams != null && entry.carbsGrams != null && entry.fatGrams != null ? (
          <Text style={styles.macros}>
            P {entry.proteinGrams} · C {entry.carbsGrams} · F {entry.fatGrams} g
          </Text>
        ) : (
          <Text style={styles.macrosMuted}>Macros unavailable</Text>
        )}
      </View>
      <Text style={styles.kcal}>{entry.calories} kcal</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${entry.foodName}`} onPress={onEdit} style={styles.action}>
        <Text style={styles.actionText}>Edit</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${entry.foodName}`}
        onPress={onDelete}
        style={styles.action}
      >
        <Text style={[styles.actionText, styles.deleteText]}>Delete</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  info: { flex: 1, gap: 2 },
  name: { fontSize: font.body, color: colors.text, fontWeight: '500' },
  sub: { fontSize: font.caption, color: colors.textMuted },
  macros: { fontSize: font.caption, color: colors.primaryDark },
  macrosMuted: { fontSize: font.caption, color: colors.textMuted, fontStyle: 'italic' },
  kcal: { fontSize: font.body, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  action: { padding: 4 },
  actionText: { fontSize: font.caption, color: colors.primary, fontWeight: '600' },
  deleteText: { color: colors.danger },
});
