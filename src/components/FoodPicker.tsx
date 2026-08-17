/**
 * Food search + selection. Searches catalog and user foods together;
 * empty results and database errors are explicit user-visible states.
 */
import { useApp } from '@/app-context';
import type { Food } from '@/domain/types';
import { colors, font, spacing } from '@/theme';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { EmptyState, ErrorBanner, Field, TextInput } from './ui';

export function FoodPicker({
  onSelect,
  autoFocus = false,
  placeholder = 'Search foods…',
}: {
  onSelect: (food: Food) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const { repo } = useApp();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Food[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(
    async (q: string) => {
      try {
        setError(null);
        setResults(await repo.searchFoods(q, 30));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setResults([]);
      }
    },
    [repo],
  );

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => search(query), 150);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, search]);

  const noResults = query.trim() !== '' && results.length === 0 && !error;

  return (
    <View style={styles.container}>
      <Field label="Food">
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={placeholder}
          autoCapitalize="sentences"
          autoFocus={autoFocus}
          testID="food-search"
        />
      </Field>
      {error ? <ErrorBanner message={`Search failed: ${error}`} /> : null}
      {noResults ? (
        <EmptyState
          title="No foods found"
          body="Try another search, or add it as a custom food in the Foods tab."
        />
      ) : null}
      {query.trim() !== '' && !noResults && !error ? (
        <FlatList
          data={results}
          keyExtractor={(f) => f.id}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => onSelect(item)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowText}>
                <Text style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowSub}>
                  {item.caloriesPer100g} kcal/100 g
                  {item.source === 'user' ? ' · custom' : ''}
                </Text>
              </View>
              <Text style={styles.rowCaret}>›</Text>
            </Pressable>
          )}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  list: { maxHeight: 280 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  rowPressed: { backgroundColor: '#f1f5f9' },
  rowText: { flex: 1, gap: 2 },
  rowName: { fontSize: font.body, color: colors.text, fontWeight: '500' },
  rowSub: { fontSize: font.caption, color: colors.textMuted },
  rowCaret: { fontSize: font.title, color: colors.textMuted },
});
