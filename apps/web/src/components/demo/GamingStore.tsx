'use client';

import type { DemoDefinition } from '@/lib/demo';
import { DemoButtonLabel } from './DemoButtonLabel';

type Props = {
  demo: DemoDefinition;
  busy: boolean;
  onUnlock: () => void;
};

/** Tiny CSS-pixel hero for the Nebula Skin preview. */
function PixelHero() {
  return (
    <div className="demo-game-sprite" aria-hidden>
      <div className="demo-game-sprite-glow" />
      <div className="demo-game-pixel-art">
        <span style={{ gridArea: '1 / 4 / 2 / 7' }} data-c="skin" />
        <span style={{ gridArea: '2 / 3 / 3 / 8' }} data-c="skin" />
        <span style={{ gridArea: '3 / 3 / 4 / 4' }} data-c="skin" />
        <span style={{ gridArea: '3 / 4 / 4 / 5' }} data-c="eye" />
        <span style={{ gridArea: '3 / 5 / 4 / 6' }} data-c="skin" />
        <span style={{ gridArea: '3 / 6 / 4 / 7' }} data-c="eye" />
        <span style={{ gridArea: '3 / 7 / 4 / 8' }} data-c="skin" />
        <span style={{ gridArea: '4 / 3 / 5 / 8' }} data-c="skin" />
        <span style={{ gridArea: '5 / 2 / 6 / 9' }} data-c="suit" />
        <span style={{ gridArea: '6 / 2 / 7 / 4' }} data-c="suit" />
        <span style={{ gridArea: '6 / 4 / 7 / 7' }} data-c="core" />
        <span style={{ gridArea: '6 / 7 / 7 / 9' }} data-c="suit" />
        <span style={{ gridArea: '7 / 3 / 8 / 5' }} data-c="suit" />
        <span style={{ gridArea: '7 / 6 / 8 / 8' }} data-c="suit" />
        <span style={{ gridArea: '8 / 3 / 9 / 5' }} data-c="boot" />
        <span style={{ gridArea: '8 / 6 / 9 / 8' }} data-c="boot" />
        <span style={{ gridArea: '2 / 2 / 3 / 3' }} data-c="aura" />
        <span style={{ gridArea: '2 / 8 / 3 / 9' }} data-c="aura" />
        <span style={{ gridArea: '5 / 1 / 6 / 2' }} data-c="aura" />
        <span style={{ gridArea: '5 / 9 / 6 / 10' }} data-c="aura" />
      </div>
    </div>
  );
}

export function GamingStore({ demo, busy, onUnlock }: Props) {
  return (
    <div className="demo-game">
      <div className="demo-game-scanlines" aria-hidden />
      <div className="demo-game-stars" aria-hidden>
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>

      <header className="demo-game-hud">
        <div className="demo-game-hud-chip">
          <span className="demo-game-coin" aria-hidden />
          <span>12,480</span>
        </div>
        <div className="demo-game-hud-chip demo-game-hud-lvl">
          <span>LV 24</span>
          <span className="demo-game-xp" aria-hidden>
            <i style={{ width: '68%' }} />
          </span>
        </div>
      </header>

      <p className="demo-game-kicker">ITEM SHOP</p>
      <h3 className="demo-game-title">{demo.productName}</h3>

      <div className="demo-game-stage">
        <span className="demo-game-rarity">EPIC</span>
        <PixelHero />
        <div className="demo-game-platform" aria-hidden />
      </div>

      <p className="demo-game-blurb">{demo.productDetail}</p>

      <div className="demo-game-price-row">
        <div className="demo-game-price">
          <span className="demo-game-coin" aria-hidden />
          <strong>999</strong>
          <span className="demo-game-price-fiat">${demo.amount}</span>
        </div>
        <span className="demo-game-tag">UNLOCKS ON SETTLE</span>
      </div>

      <button
        type="button"
        className="demo-game-cta"
        disabled={busy}
        aria-busy={busy}
        onClick={onUnlock}
      >
        <DemoButtonLabel busy={busy} busyLabel="Opening">
          UNLOCK SKIN
        </DemoButtonLabel>
      </button>

      <p className="demo-game-foot">Press to buy · inventory grants after Tendr settlement</p>
    </div>
  );
}
