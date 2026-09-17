/**
 * App-wide providers: repository + sync engine singletons.
 * The repository is created once per process (adapters are cheap) and
 * initialized with the seeded catalog on first launch.
 */
import type { CatalogBundle } from '@/db/seedCatalog';
import { createStorage } from '@/db/db';
import { Repository } from '@/db/repository';
import { getSupabaseClient } from '@/sync/supabase';
import { SyncEngine } from '@/sync/syncEngine';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import catalogBundle from '../data/foods.json';

/**
 * Paper texture preference. Persisted exactly like the local-AI toggle
 * ('true'/'false'; absent or unreadable means on) — the grain ships as part of
 * the design, so the default is on.
 */
export const PAPER_GRAIN_KEY = 'paper-grain';

interface AppContextValue {
  repo: Repository;
  sync: SyncEngine;
  ready: boolean;
  initError: string | null;
  /** Paper texture behind every screen. */
  grainOn: boolean;
  setGrainOn: (on: boolean) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

let singleton: { repo: Repository; sync: SyncEngine } | null = null;
function getSingletons(): { repo: Repository; sync: SyncEngine } {
  if (!singleton) {
    const repo = new Repository(createStorage());
    const sync = new SyncEngine(repo, getSupabaseClient);
    singleton = { repo, sync };
  }
  return singleton;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { repo, sync } = useMemo(getSingletons, []);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [grainOn, setGrainOnState] = useState(true);

  // Best-effort: a missing or unreadable preference keeps the default (on).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(PAPER_GRAIN_KEY);
        if (!cancelled && stored !== null) setGrainOnState(stored === 'true');
      } catch {
        // default on
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setGrainOn = useCallback(async (on: boolean) => {
    setGrainOnState(on);
    try {
      await AsyncStorage.setItem(PAPER_GRAIN_KEY, String(on));
    } catch {
      // persistence is best-effort; the switch still takes effect now
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await repo.init();
        await repo.ensureCatalog(catalogBundle as unknown as CatalogBundle);
        await sync.initialize();
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) setInitError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      sync.dispose();
    };
  }, [repo, sync]);

  // Best-effort sync whenever the app returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        sync.sync().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [sync]);

  return (
    <AppContext.Provider value={{ repo, sync, ready, initError, grainOn, setGrainOn }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
