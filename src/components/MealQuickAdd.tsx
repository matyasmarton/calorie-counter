/**
 * Quick add (local AI): describe a meal, let the local pipeline plan and
 * extract it (Bonsai plans → Needle 2 parses), review the deterministic
 * catalog matches, answer targeted follow-ups for localized dishes
 * (lecsó, menemen, bibimbap, …), then log entries. Saving a dish as a
 * custom food / recipe happens ONLY on explicit consent.
 */
import { useApp } from '@/app-context';
import { useLocalModel } from '@/local-ai/model-context';
import { resolveDraft, type DraftEntryProposal } from '@/local-ai/draftToEntries';
import { aggregateFoodInput, buildRecipeInput } from '@/local-ai/draftToFood';
import { parseMealText } from '@/local-ai/pipeline';
import type { MealDraft } from '@/local-ai/types';
import { Button, Card, ErrorBanner, SectionTitle, TextInput } from '@/components/ui';
import { colors, font, spacing } from '@/theme';
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

const MAX_FOLLOW_UP_ROUNDS = 3;

export function MealQuickAdd({ logDate, onAdded }: { logDate: string; onAdded: () => void }) {
  const { repo } = useApp();
  const { adapter, enabled } = useLocalModel();

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<MealDraft | null>(null);
  const [proposals, setProposals] = useState<DraftEntryProposal[]>([]);
  const [rounds, setRounds] = useState(0);
  const [details, setDetails] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFood, setSaveFood] = useState(false);
  const [saveRecipe, setSaveRecipe] = useState(false);

  const parse = useCallback(
    async (input: string) => {
      if (!enabled || !adapter.isReady()) {
        setError(adapter.unavailableReason() ?? 'Local AI is unavailable');
        return;
      }
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const d = await parseMealText(adapter, input);
        const props = await resolveDraft(d, (q, n) => repo.searchFoods(q, n));
        setDraft(d);
        setProposals(props);
      } catch (e) {
        setDraft(null);
        setProposals([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [adapter, enabled, repo],
  );

  const matched = proposals.filter((p) => p.food && p.servingId);
  const unmatched = proposals.filter((p) => !p.food || !p.servingId);
  const canFollowUp = unmatched.length > 0 && rounds < MAX_FOLLOW_UP_ROUNDS;

  const addEntries = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      for (const p of matched) {
        if (p.food && p.servingId) {
          await repo.addEntry({ logDate, foodId: p.food.id, servingId: p.servingId, amount: p.amount });
        }
      }
      setNote(`Added ${matched.length} of ${proposals.length} ingredients.`);
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, matched, proposals.length, logDate, repo, onAdded]);

  const saveLocalized = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const name = draft.mealDescription.trim().slice(0, 60) || 'Localized dish';
      if (saveFood) {
        const input = aggregateFoodInput(name, proposals);
        if (input) {
          await repo.createUserFood(input);
        } else {
          throw new Error('No matchable ingredients to save as a custom food');
        }
      }
      if (saveRecipe) {
        const input = buildRecipeInput(name, proposals);
        if (input) {
          await repo.saveRecipe(input);
        }
      }
      setSaveFood(false);
      setSaveRecipe(false);
      setDraft(null);
      setProposals([]);
      setText('');
      setDetails('');
      setRounds(0);
      setNote((prev) => `${prev ?? ''}${saveFood || saveRecipe ? ' Dish saved.' : ''}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, proposals, saveFood, saveRecipe, repo]);

  const clear = () => {
    setDraft(null);
    setProposals([]);
    setText('');
    setDetails('');
    setRounds(0);
    setNote(null);
    setError(null);
  };

  return (
    <Card>
      <SectionTitle>Quick add (local AI)</SectionTitle>
      {!draft ? (
        <>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder='Describe a meal, e.g. "chicken burrito with rice and salsa"'
            multiline
          />
          {error ? <ErrorBanner message={error} /> : null}
          {note ? <Text style={styles.note}>{note}</Text> : null}
          <View style={styles.actions}>
            <Button
              label="Parse with local AI"
              onPress={() => void parse(text)}
              loading={busy}
              disabled={!text.trim() || !enabled || !adapter.isReady()}
              testID="quick-add-parse"
            />
          </View>
        </>
      ) : (
        <>
          <Text style={styles.dishName}>{draft.mealDescription}</Text>
          <Text style={styles.detail}>Confidence: {Math.round(draft.confidence * 100)}%</Text>
          {draft.needsReview ? (
            <ErrorBanner message="Review required — some details are missing or uncertain." />
          ) : null}
          {error ? <ErrorBanner message={error} /> : null}
          {note ? <Text style={styles.note}>{note}</Text> : null}

          {proposals.map((p, i) => (
            <View key={`${p.ingredient.raw}-${i}`} style={styles.row}>
              {p.food && p.servingId ? (
                <Text style={styles.matched}>
                  {p.ingredient.raw} → {p.food.name} ({p.ingredient.amount ?? 1} ×{' '}
                  {p.food.servings.find((s) => s.id === p.servingId)?.label ?? 'serving'})
                </Text>
              ) : (
                <Text style={styles.unmatched}>{p.ingredient.raw} — No food match — skipped</Text>
              )}
            </View>
          ))}

          {canFollowUp ? (
            <View style={styles.followUp}>
              <Text style={styles.detail}>
                {unmatched.length} ingredient{unmatched.length === 1 ? '' : 's'} need more detail
                (round {rounds + 1}/{MAX_FOLLOW_UP_ROUNDS}).
              </Text>
              <TextInput
                value={details}
                onChangeText={setDetails}
                placeholder='Add amounts, units, origin, or extra ingredients, e.g. "2 peppers, 1 onion, 1 tsp oil"'
                multiline
              />
              <View style={styles.actions}>
                <Button
                  label="Re-parse with details"
                  onPress={() => {
                    setRounds((r) => r + 1);
                    void parse(`${text} ${details}`.trim());
                  }}
                  loading={busy}
                  disabled={!details.trim()}
                />
              </View>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Button
              label={`Add matched foods to ${logDate}`}
              onPress={() => void addEntries()}
              loading={saving}
              disabled={matched.length === 0}
              testID="quick-add-add"
            />
            <Button variant="secondary" label="Clear" onPress={clear} />
          </View>

          {unmatched.length > 0 ? (
            <View style={styles.consent}>
              <Text style={styles.detail}>Save this dish for future searches?</Text>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: saveFood }} onPress={() => setSaveFood((v) => !v)} style={styles.checkRow}>
                <Text style={styles.check}>{saveFood ? '☑' : '☐'}</Text>
                <Text style={styles.checkLabel}>Save as a custom food (calories/macros from matched ingredients)</Text>
              </Pressable>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: saveRecipe }} onPress={() => setSaveRecipe((v) => !v)} style={styles.checkRow}>
                <Text style={styles.check}>{saveRecipe ? '☑' : '☐'}</Text>
                <Text style={styles.checkLabel}>Remember recipe ingredients &amp; aliases</Text>
              </Pressable>
              <Button
                label="Save &amp; finish"
                onPress={() => void saveLocalized()}
                loading={saving}
                disabled={!saveFood && !saveRecipe}
              />
            </View>
          ) : null}
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' },
  dishName: { fontSize: font.section, fontWeight: '600', color: colors.text },
  detail: { fontSize: font.body, color: colors.textMuted, marginTop: 2 },
  note: { fontSize: font.body, color: colors.primary, marginTop: spacing.xs },
  row: { paddingVertical: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  matched: { fontSize: font.body, color: colors.text },
  unmatched: { fontSize: font.body, color: colors.warning },
  followUp: { marginTop: spacing.sm, gap: spacing.xs },
  consent: { marginTop: spacing.md, gap: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  check: { fontSize: font.body, color: colors.primary, width: 20 },
  checkLabel: { fontSize: font.body, color: colors.text, flex: 1 },
});
