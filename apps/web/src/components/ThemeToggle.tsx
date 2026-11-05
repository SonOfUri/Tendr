'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Monitor, Moon, Sun } from 'lucide-react';

const KEY = 'tendr-appearance';

export type AppearancePref = 'light' | 'dark' | 'device';

const OPTIONS: { id: AppearancePref; label: string; Icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
  { id: 'device', label: 'Device', Icon: Monitor },
];

function resolve(pref: AppearancePref): 'light' | 'dark' {
  if (pref === 'device') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref;
}

function readPref(): AppearancePref {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'device') return saved;
  } catch {
    /* private mode */
  }
  return 'device';
}

export function applyAppearance(pref: AppearancePref) {
  const resolved = resolve(pref);
  document.documentElement.setAttribute('data-appearance', resolved);
  document.documentElement.setAttribute('data-appearance-pref', pref);
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* private mode */
  }
}

type MenuBox = { left: number; bottom: number };

export function ThemeMenu() {
  const [pref, setPref] = useState<AppearancePref>('device');
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<MenuBox | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    const saved = readPref();
    setPref(saved);
    applyAppearance(saved);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (readPref() === 'device') applyAppearance('device');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if ((target as Element).closest?.('.theme-menu-panel')) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = OPTIONS.find((option) => option.id === pref) ?? {
    id: 'device' as const,
    label: 'Device',
    Icon: Monitor,
  };
  const CurrentIcon = current.Icon;

  function placeMenu() {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 176;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setBox({ left, bottom: window.innerHeight - rect.top + 8 });
  }

  return (
    <div className="theme-menu" ref={rootRef}>
      <button
        type="button"
        className="theme-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          placeMenu();
          setOpen(true);
        }}
      >
        <CurrentIcon size={15} strokeWidth={1.85} aria-hidden />
        <span>{current.label}</span>
        <ChevronDown
          size={14}
          strokeWidth={1.85}
          aria-hidden
          className={open ? 'theme-menu-chevron is-open' : 'theme-menu-chevron'}
        />
      </button>
      {open && box
        ? createPortal(
            <div
              className="theme-menu-panel"
              id={menuId}
              role="menu"
              aria-label="Color theme"
              style={{ left: box.left, bottom: box.bottom }}
            >
              {OPTIONS.map((option) => {
                const selected = pref === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className="theme-menu-item"
                    onClick={() => {
                      setPref(option.id);
                      applyAppearance(option.id);
                      setOpen(false);
                    }}
                  >
                    <option.Icon size={15} strokeWidth={1.85} aria-hidden />
                    {option.label}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
