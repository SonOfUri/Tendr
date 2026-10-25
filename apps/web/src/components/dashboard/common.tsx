'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { chainLabel } from '@/lib/assets';
import type { Destination } from '@/lib/actions';
import { errorMessage } from '@/lib/api';
import { STATUS_WORDS } from '@/lib/proposals';

/** Loads with `fn` whenever `key` changes; `reload` runs it again. */
export function useLoad<T>(fn: () => Promise<T>, key: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `fn` is recreated each render; `key` names what it depends on.
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const reload = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    if (key === null) return;
    setData(null);
    void reload();
  }, [key, reload]);
  return { data, error, reload, setData };
}

/** Runs one action at a time with a busy flag and an error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/** A proposal or saved-address status: the raw state (for support) and its words. */
export function Status({ status }: { status: string }) {
  return (
    <span className="status" data-status={status} title={STATUS_WORDS[status] ?? status}>
      {status}
    </span>
  );
}

/** The full destination of money: chain and complete address, never a nickname alone. */
export function DestinationBox({ destination }: { destination: Destination }) {
  return (
    <div className="destination" data-testid="destination">
      <p className="muted small">Destination</p>
      <p>
        <strong>{chainLabel(destination.chain)}</strong>{' '}
        <span className="muted">({destination.chain})</span>
      </p>
      <p className="address">{destination.address}</p>
      {destination.note && <p className="muted small">{destination.note}</p>}
    </div>
  );
}

/** Re-renders every `ms` (for countdowns). */
export function useTick(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
