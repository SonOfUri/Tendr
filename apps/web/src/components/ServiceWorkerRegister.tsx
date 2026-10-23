'use client';

import { useEffect } from 'react';

export function ServiceWorkerRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').catch(() => {
        // Local HTTP may restrict SW; HTTPS required for installability.
      });
    }
  }, []);
  return null;
}
