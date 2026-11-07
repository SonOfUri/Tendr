'use client';

import { useEffect, useState } from 'react';

const DISMISS_KEY = 'tendr-pwa-install-dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let listening = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Catch the browser's install offer on any page, before the dashboard mounts. */
export function armPwaInstall() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
}

function standalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone and iPad Safari, which never fire `beforeinstallprompt`. */
function iosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function usePwaInstall() {
  const [installed, setInstalled] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  const [ios, setIos] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    armPwaInstall();
    const read = () => {
      setInstalled(standalone());
      setCanPrompt(deferred !== null);
      setIos(iosSafari());
      setHidden(dismissed());
    };
    read();
    listeners.add(read);
    const media = window.matchMedia('(display-mode: standalone)');
    media.addEventListener('change', read);
    return () => {
      listeners.delete(read);
      media.removeEventListener('change', read);
    };
  }, []);

  async function install() {
    if (!deferred) {
      try {
        localStorage.removeItem(DISMISS_KEY);
      } catch {
        /* private mode */
      }
      setHidden(false);
      return;
    }
    await deferred.prompt();
    const choice = await deferred.userChoice;
    deferred = null;
    if (choice.outcome === 'accepted') setInstalled(true);
    emit();
  }

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode */
    }
    setHidden(true);
  }

  const available = !installed && (canPrompt || ios);
  return {
    showBanner: available && !hidden,
    showAction: available,
    ios,
    canPrompt,
    install,
    dismiss,
  };
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);
  return online;
}
