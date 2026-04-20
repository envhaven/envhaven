import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Track "pending" keys (e.g. pids or tmux window indices) with a timeout
 * safety net: if the backend never confirms by removing the key from its
 * source-of-truth list, we clear it after `failsafeMs` so the UI doesn't
 * show a stuck spinner. Used by both TerminalsPanel and ProcessSheet —
 * same shape, same bug class, one implementation.
 *
 * Callers drive two edges:
 *  - `markPending(key)` when dispatching an action.
 *  - `reconcile(aliveKeys)` whenever the source list updates; any pending
 *    key not in `aliveKeys` is treated as confirmed-gone and cleared.
 */
export function usePendingFailsafe<K>(failsafeMs: number) {
  const [pending, setPending] = useState<Set<K>>(new Set());
  const timers = useRef<Map<K, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((k: K) => {
    const t = timers.current.get(k);
    if (t) clearTimeout(t);
    timers.current.delete(k);
  }, []);

  const markPending = useCallback(
    (k: K) => {
      setPending((prev) => {
        const next = new Set(prev);
        next.add(k);
        return next;
      });
      clearTimer(k);
      timers.current.set(
        k,
        setTimeout(() => {
          timers.current.delete(k);
          setPending((prev) => {
            if (!prev.has(k)) return prev;
            const next = new Set(prev);
            next.delete(k);
            return next;
          });
        }, failsafeMs)
      );
    },
    [clearTimer, failsafeMs]
  );

  const reconcile = useCallback(
    (isAlive: (k: K) => boolean) => {
      setPending((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set<K>();
        for (const k of prev) {
          if (isAlive(k)) {
            next.add(k);
          } else {
            clearTimer(k);
          }
        }
        return next.size === prev.size ? prev : next;
      });
    },
    [clearTimer]
  );

  useEffect(() => {
    const captured = timers.current;
    return () => {
      for (const t of captured.values()) clearTimeout(t);
      captured.clear();
    };
  }, []);

  return { pending, markPending, reconcile };
}
