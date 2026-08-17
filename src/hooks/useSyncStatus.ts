/** Live sync status for screens: engine status + unsynced-change count. */
import { useApp } from '@/app-context';
import type { SyncStatus } from '@/sync/syncEngine';
import { useEffect, useState } from 'react';

export function useSyncStatus(): { status: SyncStatus; pending: number; error: string | null } {
  const { sync } = useApp();
  const [status, setStatus] = useState<SyncStatus>(sync.getStatus());
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = sync.subscribe(setStatus);
    let mounted = true;
    sync
      .hasPendingChanges()
      .then((has) => {
        if (mounted) setPending(has ? 1 : 0);
      })
      .catch(() => {});
    return () => {
      unsub();
      mounted = false;
    };
  }, [sync]);

  return { status, pending, error };
}

export function syncStatusLabel(status: SyncStatus, pending: number): string {
  switch (status) {
    case 'not-configured':
      return 'Sync not configured';
    case 'signed-out':
      return 'Not signed in';
    case 'pending':
      return pending > 0 ? 'Not synced yet' : 'Signed in';
    case 'syncing':
      return 'Syncing…';
    case 'synced':
      return 'Synced';
    case 'error':
      return pending > 0 ? 'Not synced yet' : 'Sync failed';
  }
}
