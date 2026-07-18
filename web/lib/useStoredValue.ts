'use client';

import { useCallback, useSyncExternalStore } from 'react';

function subscribe() {
  return () => {};
}

function getServerSnapshot(): undefined {
  return undefined;
}

/**
 * Reads a Storage key without the "setState synchronously in an effect"
 * anti-pattern: `undefined` means "not yet synced from the client" (still on
 * the server snapshot / pre-hydration), `null` means "synced, no value set".
 */
export function useStoredValue(key: string, storage: 'local' | 'session' = 'local'): string | null | undefined {
  const getSnapshot = useCallback(
    () => (storage === 'session' ? window.sessionStorage : window.localStorage).getItem(key),
    [key, storage]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
