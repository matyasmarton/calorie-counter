/**
 * Settings — account sign-in, sync status/manual sync, catalog provenance,
 * and JSON backup export/import (merge by UUID, or explicit restore).
 */
import { useApp } from '@/app-context';
import { DEFAULT_LLM_BASE_URL } from '@/local-ai/bridge';
import { useLocalModel } from '@/local-ai/model-context';
import { Button, Card, ErrorBanner, Field, Screen, SectionTitle, TextInput } from '@/components/ui';
import type { CatalogMetadata } from '@/domain/types';
import { useSyncStatus, syncStatusLabel } from '@/hooks/useSyncStatus';
import { colors, font, spacing } from '@/theme';
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

export default function SettingsScreen() {
  const { repo, sync } = useApp();
  const { status, pending, error } = useSyncStatus();
  const { models, enabled, setEnabled, refresh: refreshModels } = useLocalModel();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogMetadata | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setUserEmail(await sync.getUserEmail());
    setLastSyncedAt(await sync.getLastSyncedAt());
    setCatalog(await repo.getCatalogMetadata());
  }, [repo, sync]);

  useEffect(() => {
    void refresh();
  }, [refresh, status]);

  const doAuth = useCallback(
    async (mode: 'in' | 'up') => {
      if (!email.trim() || password.length < 6) {
        setAuthError('Enter a valid email and a password of at least 6 characters');
        return;
      }
      setAuthBusy(true);
      setAuthError(null);
      try {
        if (mode === 'in') await sync.signIn(email.trim(), password);
        else await sync.signUp(email.trim(), password);
        setPassword('');
        await refresh();
        setSyncNote(mode === 'in' ? 'Signed in.' : 'Account created — check your email to confirm, then sign in.');
      } catch (e) {
        setAuthError(e instanceof Error ? e.message : String(e));
      } finally {
        setAuthBusy(false);
      }
    },
    [sync, email, password, refresh],
  );

  const doSignOut = useCallback(async () => {
    try {
      await sync.signOut();
      setUserEmail(null);
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    }
  }, [sync]);

  const doSync = useCallback(async () => {
    setSyncBusy(true);
    setSyncNote(null);
    try {
      const result = await sync.sync();
      setSyncNote(`Pushed ${result.pushed}, pulled ${result.pulled} (applied ${result.applied}).`);
      await refresh();
    } catch (e) {
      setSyncNote(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncBusy(false);
    }
  }, [sync, refresh]);

  const doExport = useCallback(async () => {
    try {
      const payload = await repo.exportBackup();
      const json = JSON.stringify(payload, null, 2);
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `calorie-counter-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setSyncNote('Backup downloaded.');
      } else {
        // native: show the JSON for copy/export
        setImportText(json);
        setImportOpen(true);
        setImportError(null);
        setImportResult('Backup JSON ready below — copy it to save, or paste here to import on another device.');
      }
    } catch (e) {
      setSyncNote(e instanceof Error ? e.message : String(e));
    }
  }, [repo]);

  const doImport = useCallback(
    async (restore: boolean) => {
      setImportError(null);
      setImportResult(null);
      let payload: unknown;
      try {
        payload = JSON.parse(importText);
      } catch {
        setImportError('That is not valid JSON.');
        return;
      }
      try {
        const r = await repo.importBackup(payload, { restore });
        setImportResult(
          `Imported: ${r.userFoods} foods, ${r.entries} entries, ${r.measurements} measurements, ${r.activityDays} activity days, ${r.workouts} workouts, profile ${r.profile ? 'yes' : 'no'}.${restore ? ' Existing user data was replaced.' : ''}`,
        );
        setImportText('');
      } catch (e) {
        setImportError(e instanceof Error ? e.message : String(e));
      }
    },
    [repo, importText],
  );

  const statusText = syncStatusLabel(status, pending);
  const statusColor =
    status === 'synced'
      ? colors.primary
      : status === 'error' || status === 'not-configured'
        ? colors.warning
        : colors.textMuted;

  return (
    <Screen>
      <SectionTitle>Account &amp; sync</SectionTitle>
      <Card>
        <View style={styles.statusRow}>
          <Text style={styles.statusDot} accessibilityLabel={statusText}>●</Text>
          <View style={styles.statusText}>
            <Text style={[styles.statusTitle, { color: statusColor }]}>{statusText}</Text>
            <Text style={styles.statusSub}>
              {lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}` : 'Not synced yet'}
              {pending > 0 ? ' · changes queued locally' : ''}
            </Text>
          </View>
        </View>
        {status === 'not-configured' ? (
          <Text style={styles.hint}>
            Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to enable sync. Logging
            works fully offline — queued changes are never discarded.
          </Text>
        ) : null}
        {error ? <ErrorBanner message={`Last sync error: ${error}`} /> : null}
        {syncNote ? <Text style={styles.hint}>{syncNote}</Text> : null}
        <View style={styles.actions}>
          <Button label="Sync now" onPress={doSync} loading={syncBusy} disabled={status === 'not-configured' || status === 'signed-out'} />
          {userEmail ? (
            <Button variant="secondary" label="Sign out" onPress={() => void doSignOut()} />
          ) : null}
        </View>
      </Card>

      {userEmail ? (
        <Card>
          <Text style={styles.statusTitle}>Signed in as {userEmail}</Text>
          <Text style={styles.statusSub}>
            Entries, measurements, and custom foods sync across your devices with the same account.
          </Text>
        </Card>
      ) : (
        <Card>
          <Field label="Email">
            <TextInput value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="you@example.com" autoCapitalize="none" testID="auth-email" />
          </Field>
          <Field label="Password">
            <TextInput value={password} onChangeText={setPassword} placeholder="••••••" testID="auth-password" />
          </Field>
          {authError ? <ErrorBanner message={authError} /> : null}
          <View style={styles.actions}>
            <Button label="Sign in" onPress={() => void doAuth('in')} loading={authBusy} />
            <Button variant="secondary" label="Create account" onPress={() => void doAuth('up')} loading={authBusy} />
          </View>
          {status === 'not-configured' ? (
            <Text style={styles.hint}>Sign-in is disabled until sync is configured.</Text>
          ) : null}
        </Card>
      )}

      <SectionTitle>Data backup</SectionTitle>
      <Card>
        <Text style={styles.statusSub}>
          Export your foods, entries, and measurements as JSON. Import merges by ID (newest wins)
          or restores by replacing local data.
        </Text>
        <View style={styles.actions}>
          <Button label="Export backup" onPress={() => void doExport()} />
          <Button variant="secondary" label="Import backup" onPress={() => { setImportOpen(true); setImportError(null); setImportResult(null); }} />
        </View>
      </Card>

      <SectionTitle>Local AI</SectionTitle>
      <Card>
        <View style={styles.statusRow}>
          <View style={styles.statusText}>
            <Text style={styles.statusTitle}>Use local AI</Text>
            <Text style={styles.statusSub}>Runs entirely on this computer — no API keys, nothing leaves the machine.</Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={(v) => void setEnabled(v)}
            trackColor={{ true: colors.primary, false: colors.border }}
          />
        </View>
        {models.map((m) => (
          <View key={m.id} style={styles.statusRow}>
            <Text
              style={[
                styles.statusDot,
                { color: m.status === 'ready' ? colors.primary : m.status === 'downloading' ? colors.warning : colors.textMuted },
              ]}
            >
              ●
            </Text>
            <View style={styles.statusText}>
              <Text style={styles.statusTitle}>
                {m.id} — {m.status}
              </Text>
              {m.detail ? <Text style={styles.statusSub}>{m.detail}</Text> : null}
            </View>
          </View>
        ))}
        <Text style={styles.hint}>
          Model server: {DEFAULT_LLM_BASE_URL} · needle-2 parses meals · bonsai-4b plans tool calls.
          The desktop launcher starts both automatically; scripts/start-local-llm.sh starts them standalone.
          First run downloads the 14.6 MB needle binary and the Bonsai model (≈1.1 GB for 4B).
        </Text>
        {!enabled ? (
          <Text style={styles.hint}>AI meal parsing and quick add are disabled.</Text>
        ) : null}
        <View style={styles.actions}>
          <Button variant="ghost" label="Refresh" onPress={() => void refreshModels()} />
        </View>
      </Card>

      <SectionTitle>Food catalog</SectionTitle>
      <Card>
        {catalog ? (
          <>
            <Text style={styles.statusTitle}>{catalog.sourceName}</Text>
            <Text style={styles.statusSub}>Version: {catalog.version}</Text>
            <Text style={styles.statusSub}>{catalog.foodCount} foods · {catalog.license}</Text>
            <Text style={styles.hint}>{catalog.notes}</Text>
          </>
        ) : (
          <Text style={styles.statusSub}>Catalog metadata unavailable.</Text>
        )}
      </Card>

      <Modal visible={importOpen} transparent animationType="slide" onRequestClose={() => setImportOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Import / export JSON</Text>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <TextInput value={importText} onChangeText={setImportText} placeholder='Paste backup JSON here (or copy the exported JSON below)' multiline />
              {importError ? <ErrorBanner message={importError} /> : null}
              {importResult ? <Text style={styles.hint}>{importResult}</Text> : null}
            </ScrollView>
            <View style={styles.actions}>
              <Button label="Merge import" onPress={() => void doImport(false)} disabled={!importText.trim()} />
              <Button label="Restore (replace)" variant="danger" onPress={() => void doImport(true)} disabled={!importText.trim()} />
              <Button label="Close" variant="secondary" onPress={() => setImportOpen(false)} />
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  statusDot: { fontSize: 18, color: colors.primary },
  statusText: { flex: 1, gap: 2 },
  statusTitle: { fontSize: font.body, fontWeight: '600', color: colors.text },
  statusSub: { fontSize: font.caption, color: colors.textMuted },
  hint: { fontSize: font.caption, color: colors.textMuted, fontStyle: 'italic' },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', justifyContent: 'center', padding: spacing.lg },
  modalCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: spacing.lg,
    gap: spacing.md,
    maxHeight: '80%',
  },
  modalTitle: { fontSize: font.section, fontWeight: '700', color: colors.text },
  modalScroll: { flexGrow: 0 },
});
