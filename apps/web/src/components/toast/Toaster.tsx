'use client';

import { useSyncExternalStore } from 'react';
import { toast, type ToastItem } from './toast-store';

/** Stable empty list for SSR — a fresh `[]` each call loops useSyncExternalStore. */
const EMPTY: ToastItem[] = [];

function getServerSnapshot() {
  return EMPTY;
}

function ToastCard({ item }: { item: ToastItem }) {
  return (
    <div className={`tendr-toast tendr-toast--${item.tone}`} role="status" aria-live="polite">
      <span className="tendr-toast-bar" aria-hidden />
      <p className="tendr-toast-message">{item.message}</p>
      <button
        type="button"
        className="tendr-toast-dismiss"
        aria-label="Dismiss"
        onClick={() => toast.dismiss(item.id)}
      >
        ×
      </button>
    </div>
  );
}

export function Toaster() {
  const items = useSyncExternalStore(toast.subscribe, toast.getSnapshot, getServerSnapshot);

  if (items.length === 0) return null;

  return (
    <div className="tendr-toaster" aria-label="Notifications">
      {items.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>
  );
}
