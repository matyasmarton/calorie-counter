/**
 * App-wide local-AI state: one bridge adapter, live model states, the on-disk
 * inventory, and the persisted on/off toggle. Mirrors the AppProvider/useApp
 * pattern. Settings drives download/activate through the actions here so the
 * screen never talks to the bridge directly.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createBridgeAdapter,
  DEFAULT_LLM_BASE_URL,
  LOCAL_AI_ENABLED_KEY,
  type BridgeAdapter,
  type LocalModelInfo,
} from './bridge';
import type { LocalModelId, LocalModelState, NativeModelAdapter } from './adapter';

interface LocalModelContextValue {
  adapter: NativeModelAdapter;
  models: LocalModelState[];
  /** What the bridge found on disk, keyed by id (empty when it is unreachable). */
  inventory: LocalModelInfo[];
  enabled: boolean;
  /** True when the CORS proxy answered; false means "bridge not running". */
  bridgeUp: boolean;
  /** Which model (or 'path') is mid-action, so the UI can disable its buttons. */
  busy: LocalModelId | 'path' | null;
  /** 0–1 while a download runs. */
  progress: number | null;
  actionError: string | null;
  setEnabled: (v: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  downloadModel: (id: LocalModelId) => Promise<void>;
  useModel: (id: LocalModelId) => Promise<void>;
  useModelPath: (path: string) => Promise<void>;
  clearActionError: () => void;
}

const LocalModelContext = createContext<LocalModelContextValue | null>(null);

export function LocalModelProvider({ children }: { children: ReactNode }) {
  const adapterRef = useRef<BridgeAdapter | null>(null);
  if (!adapterRef.current) {
    adapterRef.current = createBridgeAdapter({
      baseUrl: DEFAULT_LLM_BASE_URL,
      modelName: 'cactus-needle-2',
    }) as BridgeAdapter;
  }
  const adapter = adapterRef.current;

  const [models, setModels] = useState<LocalModelState[]>(() => adapter.getModels());
  const [inventory, setInventory] = useState<LocalModelInfo[]>(() => adapter.getInventory());
  const [bridgeUp, setBridgeUp] = useState(false);
  const [enabled, setEnabledState] = useState(true);
  const [busy, setBusy] = useState<LocalModelId | 'path' | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const syncFromAdapter = useCallback(() => {
    setModels(adapter.getModels());
    setInventory(adapter.getInventory());
    setBridgeUp(adapter.isBridgeUp());
  }, [adapter]);

  const refresh = useCallback(async () => {
    await adapter.refresh();
    syncFromAdapter();
  }, [adapter, syncFromAdapter]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let value = true;
      try {
        const stored = await AsyncStorage.getItem(LOCAL_AI_ENABLED_KEY);
        if (stored !== null) value = stored === 'true';
      } catch {
        // default on
      }
      if (cancelled) return;
      adapter.setEnabled(value);
      setEnabledState(value);
      await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, refresh]);

  const setEnabled = useCallback(
    async (v: boolean) => {
      setEnabledState(v);
      try {
        await AsyncStorage.setItem(LOCAL_AI_ENABLED_KEY, String(v));
      } catch {
        // persistence is best-effort; runtime state still switches
      }
      adapter.setEnabled(v);
      await refresh();
    },
    [adapter, refresh],
  );

  // Shared busy/error envelope for the three model actions: Settings only ever
  // needs "which row is working, and what went wrong".
  const runModelAction = useCallback(
    async (key: LocalModelId | 'path', action: () => Promise<void>) => {
      setBusy(key);
      setProgress(null);
      setActionError(null);
      try {
        await action();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
        setProgress(null);
        syncFromAdapter();
      }
    },
    [syncFromAdapter],
  );

  const downloadModel = useCallback(
    (id: LocalModelId) => runModelAction(id, () => adapter.downloadModel(id, (f) => setProgress(f))),
    [adapter, runModelAction],
  );

  const useModel = useCallback(
    (id: LocalModelId) => runModelAction(id, () => adapter.loadModel(id)),
    [adapter, runModelAction],
  );

  const useModelPath = useCallback(
    (path: string) => runModelAction('path', () => adapter.useModelPath(path)),
    [adapter, runModelAction],
  );

  const clearActionError = useCallback(() => setActionError(null), []);

  const value = useMemo(
    () => ({
      adapter,
      models,
      inventory,
      enabled,
      bridgeUp,
      busy,
      progress,
      actionError,
      setEnabled,
      refresh,
      downloadModel,
      useModel,
      useModelPath,
      clearActionError,
    }),
    [
      adapter,
      models,
      inventory,
      enabled,
      bridgeUp,
      busy,
      progress,
      actionError,
      setEnabled,
      refresh,
      downloadModel,
      useModel,
      useModelPath,
      clearActionError,
    ],
  );

  return <LocalModelContext.Provider value={value}>{children}</LocalModelContext.Provider>;
}

export function useLocalModel(): LocalModelContextValue {
  const ctx = useContext(LocalModelContext);
  if (!ctx) throw new Error('useLocalModel must be used inside LocalModelProvider');
  return ctx;
}
