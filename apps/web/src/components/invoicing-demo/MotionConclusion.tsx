'use client';

import { useCallback, useEffect, useState } from 'react';
import { TendrLogo } from '@/components/TendrLogo';
import { MotionStage } from './MotionStage';
import './motion-conclusion.css';

/**
 * Spoken beats for the closer. Durations leave a pause before the next line.
 * The end card holds so the recording can cut on the earth plate.
 */
const SCENES = [
  { id: 'shown', ms: 9000 },
  { id: 'beginning', ms: 4200 },
  { id: 'world', ms: 9000 },
  { id: 'one', ms: 6000 },
  { id: 'tagline', ms: 5600 },
  { id: 'close', ms: 0 },
] as const;

type SceneId = (typeof SCENES)[number]['id'];

export function MotionConclusion() {
  const [index, setIndex] = useState(0);
  const [run, setRun] = useState(0);
  const scene = SCENES[index] ?? SCENES[0];

  const restart = useCallback(() => {
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
    setIndex(0);
    setRun((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.shiftKey && event.altKey && event.code === 'KeyN') {
        event.preventDefault();
        setIndex((i) => Math.min(SCENES.length - 1, i + 1));
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        restart();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [restart]);

  useEffect(() => {
    const go = (fromHash: boolean) => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setIndex(SCENES.length - 1);
        return;
      }
      const id = window.location.hash.replace('#', '');
      const found = SCENES.findIndex((item) => item.id === id);
      setIndex(found >= 0 ? found : 0);
      if (fromHash) setRun((n) => n + 1);
    };
    go(false);
    const onHash = () => go(true);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (scene.ms <= 0) return;
    if (window.location.hash.replace('#', '') === scene.id) return;
    const timer = window.setTimeout(() => setIndex((i) => Math.min(SCENES.length - 1, i + 1)), scene.ms);
    return () => window.clearTimeout(timer);
  }, [scene, run]);

  return (
    <MotionStage>
      <div className="mc" key={`${run}-${scene.id}`} data-scene={scene.id}>
        <Scene id={scene.id} />
      </div>
    </MotionStage>
  );
}

function Scene({ id }: { id: SceneId }) {
  if (id === 'shown') {
    return (
      <h1 className="mc-hero">
        <span className="mc-drop">What becomes possible</span>
        <br />
        <span className="mc-drop mc-drop-2">when infrastructure</span>
        <br />
        <span className="mc-drop mc-drop-3">
          <span className="mc-mark">adapts to the business.</span>
        </span>
        <br />
        <span className="mc-drop mc-drop-4">Not the other way around.</span>
      </h1>
    );
  }

  if (id === 'beginning') {
    return (
      <h1 className="mc-hero">
        <span className="mc-drop">And this is</span>
        <br />
        <span className="mc-drop mc-drop-2">
          <span className="mc-mark">just the beginning.</span>
        </span>
      </h1>
    );
  }

  if (id === 'world') {
    return (
      <h1 className="mc-hero">
        <span className="mc-drop">We&apos;re building Tendr</span>
        <br />
        <span className="mc-drop mc-drop-2">
          for payments that happen <span className="mc-mark">seamlessly.</span>
        </span>
        <br />
        <span className="mc-drop mc-drop-3">Across applications and industries.</span>
      </h1>
    );
  }

  if (id === 'one') {
    return (
      <h1 className="mc-hero">
        <span className="mc-drop">Different experiences.</span>
        <br />
        <span className="mc-drop mc-drop-2">
          <span className="mc-mark">One payment infrastructure.</span>
        </span>
      </h1>
    );
  }

  if (id === 'tagline') {
    return (
      <h1 className="mc-hero">
        <span className="mc-drop">Tendr.</span>
        <br />
        <span className="mc-drop mc-drop-2">One Checkout.</span>
        <br />
        <span className="mc-drop mc-drop-3">
          <span className="mc-mark">Every Way</span> to Pay.
        </span>
      </h1>
    );
  }

  return (
    <div className="mc-end">
      <div className="mc-end-logo">
        <TendrLogo size={92} tone="white" />
        <span>Tendr</span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="mc-end-powered"
        src="/poweredbynearintents.png"
        alt="Powered by NEAR Intents"
      />
    </div>
  );
}
