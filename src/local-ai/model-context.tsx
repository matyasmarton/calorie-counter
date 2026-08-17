/**
 * App-wide local-AI state: one bridge adapter, live model states, and the
 * persisted on/off toggle. Mirrors the AppProvider/useApp pattern.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createBridgeAdapter, DEFAULT_LLM_BASE_URL, LOCAL_AI_ENABLED_KEY, type BridgeAdapter } from './bridge';
import type { LocalModelState, NativeModelAdapter } from './adapter';

interface LocalModelContextValue {
  adapter: NativeModelAdapter;
  models: LocalModelState[];
  enabled: boolean;
  setEnabled: (v: boolean) => Promise<void>;
  refresh: () => Promise<void>;
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
  const [enabled, setEnabledState] = useState(true);

  const refresh = useCallback(async () => {
    await adapter.refresh();
    setModels(adapter.getModels());
  }, [adapter]);

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

  const value = useMemo(
    () => ({ adapter, models, enabled, setEnabled, refresh }),
    [adapter, models, enabled, setEnabled, refresh],
  );

  return <LocalModelContext.Provider value={value}>{children}</LocalModelContext.Provider>;
}

export function useLocalModel(): LocalModelContextValue {
  const ctx = useContext(LocalModelContext);
  if (!ctx) throw new Error('useLocalModel must be used inside LocalModelProvider');
  return ctx;
}
