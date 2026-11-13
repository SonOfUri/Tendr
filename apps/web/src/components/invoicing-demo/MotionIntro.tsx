'use client';

import { useCallback, useEffect, useState } from 'react';
import { TendrLogo } from '@/components/TendrLogo';
import { MotionStage } from './MotionStage';
import './motion-intro.css';

/**
 * Spoken beats, in order. Durations leave a pause before the next sentence.
 * The last beat holds so the recording can cut.
 */
const SCENES = [
  { id: 'needs', ms: 2800 },
  { id: 'businesses', ms: 8400 },
  { id: 'own', ms: 6600 },
  { id: 'adapt', ms: 5200 },
  { id: 'pieces', ms: 8200 },
  { id: 'change', ms: 3600 },
  { id: 'tendr', ms: 9400 },
  { id: 'tagline', ms: 0 },
] as const;

type SceneId = (typeof SCENES)[number]['id'];

const INDUSTRIES = [
  {
    name: 'Online store',
    operating: 'Storefront',
    users: 'Shoppers',
    needs: 'Checkout',
    icon: 'store',
  },
  {
    name: 'Fintech',
    operating: 'Accounts',
    users: 'Customers',
    needs: 'Transfers',
    icon: 'card',
  },
  {
    name: 'Gaming',
    operating: 'Sessions',
    users: 'Players',
    needs: 'In-game',
    icon: 'game',
  },
  {
    name: 'Prediction market',
    operating: 'Positions',
    users: 'Traders',
    needs: 'Settlement',
    icon: 'market',
  },
] as const;

const PIECES = [
  { kicker: 'Integrations', label: 'Payment integrations', place: 'a' },
  { kicker: 'Wallets', label: 'Wallet support', place: 'b' },
  { kicker: 'Checkout', label: 'Checkout experiences', place: 'c' },
  { kicker: 'Settlement', label: 'Settlement processes', place: 'd' },
] as const;

const TOOLS = ['Integrate', 'Customize', 'Manage'] as const;

export function MotionIntro() {
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
      <div className="mi" key={`${run}-${scene.id}`} data-scene={scene.id}>
        <Scene id={scene.id} />
      </div>
    </MotionStage>
  );
}

function Scene({ id }: { id: SceneId }) {
  if (id === 'needs') {
    return (
      <h1 className="mi-hero mi-hero-still">
        <span className="mi-drop">Every business</span>
        <br />
        <span className="mi-drop mi-drop-2">
          needs <span className="mi-mark-word">payments.</span>
        </span>
      </h1>
    );
  }

  if (id === 'businesses') {
    return (
      <div className="mi-stack">
        <div className="mi-industries">
          {INDUSTRIES.map((item) => (
            <article className="mi-industry" key={item.name}>
              <Icon name={item.icon} />
              <h2>{item.name}</h2>
            </article>
          ))}
        </div>
        <p className="mi-aside mi-aside-late">
          Not the same <span className="mi-mark-word">payment experience.</span>
        </p>
      </div>
    );
  }

  if (id === 'own') {
    return (
      <div className="mi-matrix">
        <div className="mi-matrix-head">
          <span />
          <span data-col="1">Operating</span>
          <span data-col="2">Users</span>
          <span data-col="3">Needs</span>
        </div>
        {INDUSTRIES.map((item) => (
          <div className="mi-matrix-row" key={item.name}>
            <span className="mi-matrix-name">
              <Icon name={item.icon} />
              {item.name}
            </span>
            <span data-col="1">{item.operating}</span>
            <span data-col="2">{item.users}</span>
            <span data-col="3">{item.needs}</span>
          </div>
        ))}
      </div>
    );
  }

  if (id === 'adapt') {
    return (
      <div className="mi-stack">
        <div className="mi-chips">
          {INDUSTRIES.map((item) => (
            <span className="mi-chip" key={item.name}>
              {item.name}
            </span>
          ))}
        </div>
        <p className="mi-kicker">What they need</p>
        <h1 className="mi-hero mi-hero-still">
          <span className="mi-drop">Infrastructure</span>
          <br />
          <span className="mi-drop mi-drop-2">
            <span className="mi-mark-word">flexible enough</span>
          </span>
          <br />
          <span className="mi-drop mi-drop-3">to adapt to them.</span>
        </h1>
      </div>
    );
  }

  if (id === 'pieces') {
    return (
      <div className="mi-scatter">
        <p className="mi-scatter-label">
          <span>Pieced together.</span>
        </p>
        {PIECES.map((piece, i) => (
          <article className={`mi-piece mi-piece-${piece.place}`} key={piece.label}>
            <div className="mi-piece-card">
              <span className="mi-piece-num">0{i + 1}</span>
              <strong>{piece.kicker}</strong>
              <p>{piece.label}</p>
            </div>
          </article>
        ))}
      </div>
    );
  }

  if (id === 'change') {
    return (
      <div className="mi-stack">
        <TendrLogo className="mi-logo" size={76} tone="white" />
        <h1 className="mi-hero mi-hero-still">
          <span className="mi-drop mi-drop-2">
            We&apos;re building <span className="mi-mark-word">Tendr</span>
          </span>
          <br />
          <span className="mi-drop mi-drop-3">to change that.</span>
        </h1>
      </div>
    );
  }

  if (id === 'tendr') {
    return (
      <div className="mi-stack">
        <div className="mi-wordmark">
          <TendrLogo size={58} tone="white" />
          <span>Tendr</span>
        </div>
        <p className="mi-lead">
          <span className="mi-mark-word">Universal</span> payment infrastructure
        </p>
        <div className="mi-tools">
          {TOOLS.map((tool) => (
            <span key={tool}>{tool}</span>
          ))}
        </div>
        <div className="mi-chips mi-chips-late">
          {INDUSTRIES.map((item) => (
            <span className="mi-chip mi-chip-ghost" key={item.name}>
              {item.name}
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mi-stack">
      <h1 className="mi-tagline">
        <span className="mi-line mi-line-drop">One Checkout.</span>
        <span className="mi-line mi-line-2">
          <span className="mi-mark-word">Every Way</span> to Pay.
        </span>
      </h1>
    </div>
  );
}

function Icon({ name }: { name: (typeof INDUSTRIES)[number]['icon'] }) {
  return (
    <span className="mi-icon" aria-hidden="true">
      {name === 'store' && (
        <svg viewBox="0 0 24 24">
          <path d="M4 10.2 12 4.5l8 5.7" />
          <path d="M6.2 9.6V19.5h11.6V9.6" />
          <path d="M10 19.5v-5.2h4v5.2" />
        </svg>
      )}
      {name === 'card' && (
        <svg viewBox="0 0 24 24">
          <rect x="3" y="5.5" width="18" height="13" rx="2.2" />
          <path d="M3 10h18" />
          <path d="M7 14.5h3.5" />
        </svg>
      )}
      {name === 'game' && (
        <svg viewBox="0 0 24 24">
          <path d="M7.2 8.2h9.6a3.4 3.4 0 0 1 3.4 3.4v.8A3.6 3.6 0 0 1 16.6 16h-1.1l-1.5-1.6H10l-1.5 1.6H7.4A3.6 3.6 0 0 1 3.8 12.4v-.8a3.4 3.4 0 0 1 3.4-3.4Z" />
          <path d="M8 12.2h2.6M9.3 10.9v2.6" />
          <circle cx="15.4" cy="11.4" r="0.7" />
          <circle cx="17.2" cy="13.1" r="0.7" />
        </svg>
      )}
      {name === 'market' && (
        <svg viewBox="0 0 24 24">
          <path d="M4 16.5 8.6 11l3.3 2.7L20 6.8" />
          <path d="M14.5 6.8H20V12" />
        </svg>
      )}
    </span>
  );
}
