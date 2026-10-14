import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, request } from '../shared/lib/api';
import type { Filters, Settings } from '../shared/lib/types';

export type Changes = Partial<
  Omit<Settings, 'revision' | 'games_available' | 'game_keys' | 'inventory_filters'>
> & { inventory_filters?: Partial<Filters> };
const nested = ['inventory_filters', 'mining_benefits'] as const;
const reloadKey = 'tdm.settings-draft';
export function mergeDraft(settings: Settings, changes: Changes): Settings {
  return {
    ...settings,
    ...changes,
    inventory_filters: { ...settings.inventory_filters, ...changes.inventory_filters },
    mining_benefits: { ...settings.mining_benefits, ...changes.mining_benefits },
  };
}
export function remainingChanges(queued: Changes, sent: Changes): Changes {
  const next = { ...queued };
  for (const key of Object.keys(next) as (keyof Changes)[]) {
    if ((nested as readonly string[]).includes(key)) {
      const rest = Object.fromEntries(
        Object.entries(next[key] ?? {}).filter(
          ([field, value]) =>
            JSON.stringify(value) !==
            JSON.stringify((sent[key] as Record<string, unknown> | undefined)?.[field]),
        ),
      );
      if (Object.keys(rest).length) Object.assign(next, { [key]: rest });
      else delete next[key];
    } else if (JSON.stringify(next[key]) === JSON.stringify(sent[key])) delete next[key];
  }
  return next;
}
function readReloadDraft(key: string): { changes: Changes; revision?: string } | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 100_000) return null;
    const value = JSON.parse(raw);
    if (
      typeof value.expires !== 'number' ||
      value.expires < Date.now() ||
      !value.changes ||
      typeof value.changes !== 'object' ||
      Array.isArray(value.changes)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function createDraft(key: string, settings?: Settings) {
  const restored = readReloadDraft(key);
  const record = {
    invalidated: false,
    queued: { current: restored?.changes ?? ({} as Changes) },
    baseline: { current: (restored ?? settings) as { revision?: string } | undefined },
    latest: { current: settings },
    sending: { current: false },
    restored: !!restored,
    error: restored ? 'settings_restored' : '',
    version: 0,
    listeners: new Set<() => void>(),
    persist() {
      if (record.invalidated) return;
      try {
        if (Object.keys(record.queued.current).length)
          sessionStorage.setItem(
            key,
            JSON.stringify({
              changes: record.queued.current,
              revision: record.baseline.current?.revision,
              expires: Date.now() + 600_000,
            }),
          );
        else sessionStorage.removeItem(key);
      } catch {
        /* In-memory drafts still survive account switches. */
      }
    },
    emit() {
      if (record.invalidated) return;
      record.persist();
      record.version++;
      for (const listener of record.listeners) listener();
    },
    subscribe(listener: () => void) {
      record.listeners.add(listener);
      return () => {
        record.listeners.delete(listener);
      };
    },
    snapshot() {
      return record.version;
    },
  };
  return record;
}
const drafts = new Map<string, ReturnType<typeof createDraft>>();
export function clearAutosaveDrafts() {
  for (const draft of drafts.values()) draft.invalidated = true;
  drafts.clear();
  try {
    for (const key of Object.keys(sessionStorage))
      if (key === reloadKey || key.startsWith(`${reloadKey}.`)) sessionStorage.removeItem(key);
  } catch {
    /* Browser storage may be unavailable. */
  }
}
export const hasUnsavedDrafts = () =>
  [...drafts.values()].some(
    (draft) => draft.sending.current || Object.keys(draft.queued.current).length > 0,
  );

export function useAutosave(
  settings: Settings | undefined,
  connected: boolean,
  saved: (settings: Settings, previousRevision: string | undefined) => void,
  scopedRequest: typeof request = request,
  accountId?: string,
) {
  const key = accountId ? `${reloadKey}.${accountId}` : reloadKey;
  const [record] = useState(() => {
    if (!accountId) return createDraft(key, settings);
    if (!drafts.has(accountId)) drafts.set(accountId, createDraft(key, settings));
    return drafts.get(accountId)!;
  });
  useSyncExternalStore(record.subscribe, record.snapshot, record.snapshot);
  const { latest, queued, baseline, sending, restored } = record;
  if (settings) latest.current = settings;
  const changes = queued.current;
  const busy = sending.current;
  const error = record.error;
  const setChanges = (changes: Changes) => {
    queued.current = changes;
    record.emit();
  };
  const setBusy = (busy: boolean) => {
    sending.current = busy;
    record.emit();
  };
  const setError = (error: string) => {
    if (record.error !== error) {
      record.error = error;
      record.emit();
    }
  };
  const pending = Object.keys(changes).length > 0;

  function change<K extends keyof Changes>(
    key: K,
    value: Settings[K] | ((current: Settings[K]) => Settings[K]),
  ) {
    if (!Object.keys(queued.current).length) baseline.current = latest.current;
    if (!latest.current) return;
    const current = mergeDraft(latest.current, queued.current);
    let next = typeof value === 'function' ? value(current[key]) : value;
    if ((nested as readonly string[]).includes(key)) {
      next = {
        ...(queued.current[key] as object),
        ...Object.fromEntries(
          Object.entries(next as object).filter(
            ([field, item]) =>
              JSON.stringify(item) !==
              JSON.stringify((current[key] as Record<string, unknown>)[field]),
          ),
        ),
      } as Settings[K];
    }
    queued.current = {
      ...queued.current,
      [key]: next,
    };
    setChanges(queued.current);
    setError('');
  }

  async function save(refresh = false) {
    if (record.invalidated || sending.current || !latest.current || !connected) return;
    const sent = queued.current;
    if (!Object.keys(sent).length) return;
    if (
      ('minimum_refresh_interval_minutes' in sent &&
        (!Number.isInteger(sent.minimum_refresh_interval_minutes) ||
          sent.minimum_refresh_interval_minutes! < 1 ||
          sent.minimum_refresh_interval_minutes! > 1440)) ||
      ('proxy' in sent && sent.proxy !== '' && !/^https?:\/\/[^\s]+$/i.test(sent.proxy ?? ''))
    ) {
      setError('settings_invalid');
      return;
    }
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      const base = refresh
        ? await scopedRequest<Settings>('/api/settings')
        : (baseline.current ?? latest.current);
      const result = await scopedRequest<{ settings: Settings }>('/api/settings', {
        ...sent,
        revision: base.revision,
      });
      saved(result.settings, base.revision);
      baseline.current = result.settings;
      // Edits made while this request was in flight belong to the next save.
      queued.current = remainingChanges(queued.current, sent);
      setChanges(queued.current);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 409
          ? 'settings_conflict'
          : 'settings_save_failed',
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!pending || busy || !connected || error) return;
    const timer = window.setTimeout(() => void save(), 500);
    return () => window.clearTimeout(timer);
  }, [changes, pending, busy, connected, error]);
  useEffect(() => {
    if (connected && !restored) setError('');
  }, [connected]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (pending || busy) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending, busy]);
  const flush = useRef(save);
  flush.current = save;
  useEffect(
    () => () => {
      record.persist();
      void flush.current();
    },
    [record],
  );
  return {
    draft: settings ? mergeDraft(settings, changes) : undefined,
    change,
    busy,
    pending,
    error,
    retry: () => save(true),
    reload: () => {
      try {
        if (Object.keys(queued.current).length)
          sessionStorage.setItem(
            key,
            JSON.stringify({
              changes: queued.current,
              revision: baseline.current?.revision,
              expires: Date.now() + 600_000,
            }),
          );
        window.location.reload();
      } catch {
        setError('settings_reload_failed');
      }
    },
  };
}
