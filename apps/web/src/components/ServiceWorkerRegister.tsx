'use client';

import { useEffect } from 'react';
import { armPwaInstall } from '@/lib/pwa-install';

export function ServiceWorkerRegister() {
  useEffect(() => {
    armPwaInstall();
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch(() => {
          // A non-secure origin (plain HTTP, other than localhost) cannot install a worker.
        });
    }
  }, []);
  return null;
}
