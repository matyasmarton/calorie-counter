/**
 * Supabase client — configured from EXPO_PUBLIC_SUPABASE_URL /
 * EXPO_PUBLIC_SUPABASE_ANON_KEY. When those are absent the app is fully
 * functional locally and the sync engine reports "sync not configured";
 * queued changes are never discarded.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export function isSyncConfigured(): boolean {
  return Boolean(URL && ANON_KEY);
}

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (!isSyncConfigured()) return null;
  if (!client) {
    client = createClient(URL!, ANON_KEY!, {
      auth: {
        storage: AsyncStorage, // AsyncStorage works on native AND web (localStorage)
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}
