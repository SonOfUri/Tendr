'use client';

import { useEffect, useMemo, useState } from 'react';
import type { DemoDefinition } from '@/lib/demo';
import { DemoButtonLabel } from './DemoButtonLabel';

type Side = 'kane' | 'mbappe';

type Props = {
  demo: DemoDefinition;
  busy: boolean;
  onDeposit: (amount?: string) => void;
};

const BASE = { kane: 42, mbappe: 58 } as const;
const KANE_SRC = '/demo/kane.webp';
const MBAPPE_SRC = '/demo/mbappe.webp';

export function PredictionMarket({ demo, busy, onDeposit }: Props) {
  const [picked, setPicked] = useState<Side | null>(null);

  useEffect(() => {
    for (const src of [KANE_SRC, MBAPPE_SRC]) {
      const img = new Image();
      img.src = src;
    }
  }, []);

  const odds = useMemo(() => {
    if (!picked) return BASE;
    if (picked === 'kane') return { kane: 47, mbappe: 53 };
    return { kane: 38, mbappe: 62 };
  }, [picked]);

  function vote(side: Side) {
    setPicked(side);
    onDeposit(demo.amount);
  }

  return (
    <div className="demo-pred">
      <div className="demo-pred-head">
        <div className="demo-pred-avatars" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={KANE_SRC} alt="" className="demo-pred-avatar" width={42} height={42} decoding="async" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={MBAPPE_SRC}
            alt=""
            className="demo-pred-avatar demo-pred-avatar-overlap"
            width={42}
            height={42}
            decoding="async"
          />
        </div>
        <h3 className="demo-pred-question">Who wins the Ballon d&apos;Or?</h3>
      </div>

      <div className="demo-pred-faces">
        <figure className="demo-pred-face" data-side="kane" data-active={picked === 'kane' ? 'true' : 'false'}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={KANE_SRC}
            alt="Harry Kane"
            width={360}
            height={360}
            decoding="async"
            fetchPriority="high"
          />
          <figcaption>
            <span className="demo-pred-name">Harry Kane</span>
            <span className="demo-pred-club">Bayern Munich</span>
          </figcaption>
        </figure>
        <span className="demo-pred-vs" aria-hidden>
          VS
        </span>
        <figure className="demo-pred-face" data-side="mbappe" data-active={picked === 'mbappe' ? 'true' : 'false'}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={MBAPPE_SRC}
            alt="Kylian Mbappé"
            width={360}
            height={360}
            decoding="async"
            fetchPriority="high"
          />
          <figcaption>
            <span className="demo-pred-name">Kylian Mbappé</span>
            <span className="demo-pred-club">Real Madrid</span>
          </figcaption>
        </figure>
      </div>

      <div className="demo-pred-odds">
        <div className="demo-pred-odds-labels">
          <div>
            <span className="demo-pred-odds-kicker">Kane</span>
            <strong>{odds.kane}%</strong>
          </div>
          <div>
            <span className="demo-pred-odds-kicker">Mbappé</span>
            <strong>{odds.mbappe}%</strong>
          </div>
        </div>
        <div
          className="demo-pred-bar"
          style={{ ['--kane' as string]: `${odds.kane}%` }}
          role="img"
          aria-label={`Kane ${odds.kane} percent, Mbappé ${odds.mbappe} percent`}
        />
      </div>

      <div className="demo-pred-stake">
        <span>Stake</span>
        <strong>${demo.amount}</strong>
      </div>

      <div className="demo-pred-actions">
        <button
          type="button"
          className="demo-pred-btn demo-pred-btn-kane"
          disabled={busy}
          aria-busy={busy && picked === 'kane'}
          onClick={() => vote('kane')}
        >
          <DemoButtonLabel busy={busy && picked === 'kane'} busyLabel="Opening">
            Vote Kane
          </DemoButtonLabel>
        </button>
        <button
          type="button"
          className="demo-pred-btn demo-pred-btn-mbappe"
          disabled={busy}
          aria-busy={busy && picked === 'mbappe'}
          onClick={() => vote('mbappe')}
        >
          <DemoButtonLabel busy={busy && picked === 'mbappe'} busyLabel="Opening">
            Vote Mbappé
          </DemoButtonLabel>
        </button>
      </div>

      <p className="demo-pred-note">{demo.productDetail}</p>
    </div>
  );
}
