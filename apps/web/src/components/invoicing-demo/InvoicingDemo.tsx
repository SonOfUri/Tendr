'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Fingerprint, Link2, Mail, Send, Wallet } from 'lucide-react';
import { DemoAssetModal } from '@/components/demo/DemoAssetModal';
import { InvoiceBreakdown } from '@/components/InvoiceBreakdown';
import { TendrLogo } from '@/components/TendrLogo';
import { burstDemoConfetti } from '@/lib/demo/confetti';
import {
  BEATS,
  BEAT_COPY,
  CHAPTERS,
  DEMO_INVOICE,
  INVOICE_ASSET_OPTIONS,
  INVOICE_USDC_NEAR,
  STORY,
  type InvoiceBeat,
} from './story';
import '@/components/demo/demo-playground.css';
import './invoicing-demo.css';

function nextBeat(beat: InvoiceBeat): InvoiceBeat | null {
  const i = BEATS.indexOf(beat);
  return i < BEATS.length - 1 ? BEATS[i + 1]! : null;
}

const TYPE_STEPS = [
  { key: 'name', text: STORY.contractor, pace: 32 },
  { key: 'email', text: STORY.email, pace: 26 },
  { key: 'reference', text: STORY.reference, pace: 34 },
  { key: 'due', text: STORY.due, pace: 30 },
  { key: 'token', text: '', pace: -1 },
  { key: 'l1', text: STORY.lines[0].description, pace: 16 },
  { key: 'l1amt', text: STORY.lines[0].human, pace: 42 },
  { key: 'l2', text: STORY.lines[1].description, pace: 20 },
  { key: 'l2amt', text: STORY.lines[1].human, pace: 42 },
  { key: 'wallet', text: STORY.wallet, pace: 36 },
] as const;

function wait(ms: number, timers: number[]) {
  return new Promise<void>((resolve) => {
    timers.push(window.setTimeout(resolve, ms));
  });
}

function reveal(canvas: HTMLElement, el: HTMLElement) {
  const box = canvas.getBoundingClientRect();
  const aim = el.getBoundingClientRect();
  const margin = 28;
  if (aim.bottom > box.bottom - margin) {
    canvas.scrollTop += aim.bottom - (box.bottom - margin);
  } else if (aim.top < box.top + margin) {
    canvas.scrollTop += aim.top - (box.top + margin);
  }
}

function cursorPoint(el: HTMLElement, xRatio: number, yRatio: number) {
  const aim = el.getBoundingClientRect();
  return {
    x: aim.left + aim.width * xRatio,
    y: aim.top + aim.height * yRatio,
  };
}

function originPoint(stage: HTMLElement, el: HTMLElement, xRatio: number, yRatio: number) {
  const box = stage.getBoundingClientRect();
  const aim = el.getBoundingClientRect();
  return {
    x: aim.left - box.left + aim.width * xRatio,
    y: aim.top - box.top + aim.height * yRatio,
  };
}

function setNativeValue(input: HTMLInputElement, value: string) {
  const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  proto?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function InvoicingDemo() {
  const [beat, setBeat] = useState<InvoiceBeat>('link');
  const [signing, setSigning] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const signTimer = useRef<number | null>(null);
  const playGen = useRef(0);
  const [cursor, setCursor] = useState({
    x: 80,
    y: 120,
    clicking: false,
    on: false,
    snap: true,
  });
  const [zoomed, setZoomed] = useState(false);
  const [origin, setOrigin] = useState('50% 42%');
  const [writeReady, setWriteReady] = useState(false);
  const cursorOn = useRef(false);

  const clearSign = useCallback(() => {
    if (signTimer.current !== null) {
      window.clearTimeout(signTimer.current);
      signTimer.current = null;
    }
    setSigning(false);
  }, []);

  const goBridge = useCallback(() => {
    clearSign();
    setBeat('bridge');
  }, [clearSign]);

  const advance = useCallback(() => {
    playGen.current += 1;
    if (signing) {
      goBridge();
      return;
    }
    if (beat === 'paid') {
      setWriteReady(false);
      setBeat('link');
      return;
    }
    if (beat === 'settle') {
      setSigning(true);
      signTimer.current = window.setTimeout(() => {
        signTimer.current = null;
        setSigning(false);
        setBeat('bridge');
      }, 4200);
      return;
    }
    const next = nextBeat(beat);
    if (next) setBeat(next);
  }, [beat, goBridge, signing]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!event.shiftKey || !event.altKey) return;
      if (event.key !== 'N' && event.key !== 'n') return;
      event.preventDefault();
      advance();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance]);

  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  const pointAt = useCallback((el: HTMLElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!el.closest('.demo-asset-layer') && !el.closest('.inv-write')) reveal(canvas, el);
    const end = cursorPoint(el, 0.28, 0.55);
    const snap = !cursorOn.current;
    cursorOn.current = true;
    setCursor({ x: end.x, y: end.y, clicking: false, on: true, snap });
    if (snap) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setCursor((c) => ({ ...c, snap: false }));
        });
      });
    }
  }, []);

  const tap = useCallback(() => {
    setCursor((c) => ({ ...c, clicking: true }));
    window.setTimeout(() => {
      setCursor((c) => ({ ...c, clicking: false }));
    }, 200);
  }, []);

  useEffect(() => {
    if (beat === 'write' && !writeReady) return;
    const gen = ++playGen.current;
    const canvas = canvasRef.current;
    setZoomed(false);
    if (!canvas) return;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const target = canvas.querySelector<HTMLElement>('[data-act]');
    if (reduce || !target || beat === 'bridge' || beat === 'paid') {
      setCursor((c) => ({ ...c, on: false, clicking: false }));
      return;
    }
    reveal(canvas, target);
    const end = cursorPoint(target, 0.55, 0.62);
    const stage = canvas.querySelector<HTMLElement>('.inv-stage');
    const origin = stage ? originPoint(stage, target, 0.55, 0.62) : end;
    const fromTypedField = beat === 'write';
    const approach = {
      x: Math.max(48, end.x - 210),
      y: Math.max(64, end.y - 130),
    };
    setOrigin(`${origin.x}px ${origin.y}px`);
    cursorOn.current = true;
    setCursor(
      fromTypedField
        ? { ...end, clicking: false, on: true, snap: false }
        : { ...approach, clicking: false, on: true, snap: true },
    );
    let cancelled = false;
    const release = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (cancelled || playGen.current !== gen) return;
        setCursor((c) => ({ ...c, snap: false }));
      });
    });
    const move = window.setTimeout(() => {
      if (playGen.current !== gen) return;
      setCursor({ ...end, clicking: false, on: true, snap: false });
      if (!fromTypedField) setZoomed(true);
    }, fromTypedField ? 40 : 520);
    const click = window.setTimeout(() => {
      if (playGen.current !== gen) return;
      setCursor((c) => ({ ...c, clicking: true }));
    }, fromTypedField ? 980 : 1560);
    const go = window.setTimeout(() => {
      if (playGen.current !== gen) return;
      advanceRef.current();
    }, fromTypedField ? 1280 : 1880);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(release);
      window.clearTimeout(move);
      window.clearTimeout(click);
      window.clearTimeout(go);
    };
  }, [beat, writeReady]);

  useEffect(() => {
    if (beat !== 'paid' || !rootRef.current) return;
    const root = rootRef.current;
    const shower = {
      count: 100,
      delay: 1.4,
      durMin: 4.2,
      durSpan: 2.4,
      removeAfter: 9000,
    };
    const stopFirst = burstDemoConfetti(root, shower);
    let stopSecond = () => {};
    const late = window.setTimeout(() => {
      stopSecond = burstDemoConfetti(root, {
        count: 80,
        delay: 1.2,
        durMin: 4,
        durSpan: 2.2,
        removeAfter: 7800,
      });
    }, 2400);
    return () => {
      stopFirst();
      stopSecond();
      window.clearTimeout(late);
    };
  }, [beat]);

  useEffect(() => () => clearSign(), [clearSign]);

  const copy = BEAT_COPY[beat];
  const beatIndex = BEATS.indexOf(beat);

  return (
    <div className="inv-demo invoice-portal" ref={rootRef}>
      <section className="inv-canvas" aria-label="Invoicing demo" ref={canvasRef}>
        <div className="inv-stage" data-zoom={zoomed ? 'in' : 'out'} style={{ transformOrigin: origin }}>
          {beat === 'link' ? (
            <ChapterFrame side="contractor">
              <LinkScene onOpen={advance} />
            </ChapterFrame>
          ) : null}
          {beat === 'write' ? (
            <ChapterFrame side="contractor">
              <WriteScene
                onSend={advance}
                onPoint={pointAt}
                onTap={tap}
                onReady={() => setWriteReady(true)}
              />
            </ChapterFrame>
          ) : null}
          {beat === 'confirm' ? (
            <ChapterFrame side="contractor">
              <ConfirmScene onVerify={advance} />
            </ChapterFrame>
          ) : null}
          {beat === 'mail' ? (
            <ChapterFrame side="merchant" wide>
              <MailScene onOpen={advance} />
            </ChapterFrame>
          ) : null}
          {beat === 'letter' ? (
            <ChapterFrame side="merchant">
              <LetterScene onPay={advance} />
            </ChapterFrame>
          ) : null}
          {beat === 'settle' ? (
            <ChapterFrame side="merchant">
              <SettleScene signing={signing} onSign={advance} />
            </ChapterFrame>
          ) : null}
          {beat === 'bridge' || beat === 'paid' ? (
            <BridgeScene playing={beat === 'bridge'} onDone={() => setBeat('paid')} />
          ) : null}
        </div>
        <FilmCursor
          x={cursor.x}
          y={cursor.y}
          clicking={cursor.clicking}
          on={cursor.on}
          snap={cursor.snap}
        />
      </section>

      <aside className="inv-rail">
        <div className="inv-rail-top">
          <p className="inv-kicker">Invoicing</p>
          <p className="inv-rail-title">Contractor bills. Northline pays.</p>
        </div>
        <ol className="inv-stepper" aria-label="Invoicing flow">
          {CHAPTERS.map((chapter, i) => {
            const last = BEATS.indexOf(chapter.beats[chapter.beats.length - 1]!);
            const first = BEATS.indexOf(chapter.beats[0]!);
            const state = beatIndex > last ? 'done' : beatIndex >= first ? 'active' : 'todo';
            return (
              <li key={chapter.id} data-state={state}>
                {i < CHAPTERS.length - 1 ? <span className="inv-stepper-line" aria-hidden /> : null}
                <span className="inv-stepper-node" aria-hidden>
                  {state === 'done' ? <Check size={14} strokeWidth={2.4} /> : i + 1}
                  {state === 'active' ? <span className="inv-stepper-pulse" /> : null}
                </span>
                <span className="inv-stepper-copy">
                  <span className="inv-step-kicker">{chapter.label}</span>
                  <span className="inv-step-title">{chapter.who}</span>
                  <span className="inv-step-detail">
                    {state === 'active' ? copy.title : chapter.label}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
        <div className="inv-rail-body">
          <p className="inv-beat-title">{copy.title}</p>
          <p className="inv-beat-note">{copy.note}</p>
          <dl className="inv-facts">
            <div>
              <dt>Business</dt>
              <dd>{STORY.business}</dd>
            </div>
            <div>
              <dt>Contractor</dt>
              <dd>{STORY.contractor}</dd>
            </div>
            <div>
              <dt>Invoice</dt>
              <dd>
                {STORY.totalHuman} {STORY.symbol}
              </dd>
            </div>
          </dl>
        </div>
        <div className="inv-rail-foot">
          <button type="button" className="inv-primary" onClick={advance}>
            {copy.action}
          </button>
          <p className="inv-hint">Shift+Alt+N skips to the next beat.</p>
        </div>
      </aside>
    </div>
  );
}

function Brand({ who }: { who: string }) {
  return (
    <p className="inv-brand">
      <TendrLogo size={26} tone="black" className="inv-logo" />
      <span>TENDR</span>
      <em>{who}</em>
    </p>
  );
}

function FilmCursor({
  x,
  y,
  clicking,
  on,
  snap,
}: {
  x: number;
  y: number;
  clicking: boolean;
  on: boolean;
  snap: boolean;
}) {
  if (!on) return null;
  return (
    <div
      className="inv-cursor"
      data-click={clicking || undefined}
      data-snap={snap || undefined}
      style={{ left: x, top: y }}
      aria-hidden
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
        <path
          d="M5 3.5 19 12.2 11.4 13.6 8.8 20.5 5 3.5Z"
          fill="#fff"
          stroke="#111"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <span className="inv-cursor-ring" />
    </div>
  );
}

function Avatar({
  seed,
  kind = 'person',
}: {
  seed: string;
  kind?: 'person' | 'mark';
}) {
  const style = kind === 'mark' ? 'initials' : 'notionists';
  const src = `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}&backgroundColor=${kind === 'mark' ? '111111' : 'f2f2f2'}`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="inv-avatar" src={src} alt="" width={40} height={40} />
  );
}

function ChapterFrame({
  side,
  wide,
  children,
}: {
  side: 'contractor' | 'merchant';
  wide?: boolean;
  children: ReactNode;
}) {
  const contractor = side === 'contractor';
  return (
    <div className="inv-shot" data-wide={wide ? 'true' : undefined}>
      <p className="inv-who">
        <Avatar seed={contractor ? STORY.contractor : STORY.business} kind={contractor ? 'person' : 'mark'} />
        <span>
          <em>{contractor ? 'Contractor' : 'Merchant'}</em>
          <strong>{contractor ? STORY.contractor : STORY.business}</strong>
        </span>
      </p>
      {children}
    </div>
  );
}

function LinkScene({ onOpen }: { onOpen: () => void }) {
  return (
    <article className="inv-card inv-link">
      <Brand who="Invoice link" />
      <div className="inv-browser">
        <span className="inv-browser-dots" aria-hidden />
        <span className="inv-browser-url">{STORY.link}</span>
      </div>
      <p className="inv-eyebrow">Sent to {STORY.contractor}</p>
      <h1>Open the bill link</h1>
      <p className="inv-lead">
        Northline shares one public page. Claire bills from here. She never signs up for Tendr.
      </p>
      <button type="button" className="inv-primary" data-act onClick={onOpen}>
        <Link2 size={16} strokeWidth={1.85} aria-hidden />
        Open link
      </button>
    </article>
  );
}

function MailScene({ onOpen }: { onOpen: () => void }) {
  return (
    <article className="inv-card inv-mailapp">
      <Brand who="Inbox" />
      <div className="inv-mail-bar">
        <Mail size={16} strokeWidth={1.75} aria-hidden />
        <span>
          {STORY.business} · {STORY.merchantEmail}
        </span>
      </div>
      <ul className="inv-inbox">
        <li>
          <button type="button" className="inv-inbox-row" data-act data-unread="true" onClick={onOpen}>
            <Avatar seed="Tendr" kind="mark" />
            <span>
              <strong>Tendr</strong>
              <em>
                Invoice {STORY.reference} from {STORY.contractor}
              </em>
            </span>
            <time>09:14</time>
          </button>
        </li>
        <li>
          <div className="inv-inbox-row" data-muted="true">
            <Avatar seed="Studio rent" kind="mark" />
            <span>
              <strong>Studio rent</strong>
              <em>November invoice is attached</em>
            </span>
            <time>08:02</time>
          </div>
        </li>
        <li>
          <div className="inv-inbox-row" data-muted="true">
            <Avatar seed="Northline calendar" kind="mark" />
            <span>
              <strong>Calendar</strong>
              <em>Payout review · today 16:00</em>
            </span>
            <time>Yesterday</time>
          </div>
        </li>
      </ul>
    </article>
  );
}

function LetterScene({ onPay }: { onPay: () => void }) {
  return (
    <article className="inv-card inv-mail">
      <Brand who="Email" />
      <div className="inv-mail-bar">
        <Mail size={16} strokeWidth={1.75} aria-hidden />
        <span>To {STORY.merchantEmail}</span>
      </div>
      <p className="inv-eyebrow">From Tendr</p>
      <h1>Pay invoice {STORY.reference}</h1>
      <p className="inv-lead">
        {STORY.contractor} wants {STORY.totalHuman} {STORY.symbol} on {STORY.chain}. Northline can pay in {STORY.paySymbol} on {STORY.payChain}.
      </p>
      <InvoiceBreakdown invoice={DEMO_INVOICE} />
      <dl className="inv-dl">
        <div>
          <dt>Pay to</dt>
          <dd className="inv-mono">{STORY.wallet}</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>{STORY.chain}</dd>
        </div>
      </dl>
      <button type="button" className="inv-primary" data-act onClick={onPay}>
        Pay from wallet
      </button>
    </article>
  );
}

type BridgePhase = 'draw' | 'leave' | 'intent' | 'cross' | 'paid';

const BRIDGE_CAPTION: Record<BridgePhase, string> = {
  draw: 'A path opens between two different assets.',
  leave: `${STORY.payHuman} ${STORY.paySymbol} leaves Northline on ${STORY.payChain}.`,
  intent: `NEAR Intents swaps ${STORY.paySymbol} into ${STORY.symbol}.`,
  cross: `${STORY.totalHuman} ${STORY.symbol} is on its way to ${STORY.wallet}.`,
  paid: `Settled. ${STORY.wallet} received ${STORY.symbol} on ${STORY.chain}.`,
};

function NearLogo() {
  return (
    <svg className="inv-near-logo" viewBox="0 0 458 274" role="img" aria-label="NEAR">
      <path
        fill="currentColor"
        d="M229.2,110.8v52.5c0,0.4-0.3,0.8-0.8,0.8h-5.5c-2.5,0-4.9-1.3-6.3-3.4l-24.8-38.3l0.8,19.1v21.9c0,0.4-0.3,0.8-0.8,0.8h-7.2c-0.4,0-0.8-0.3-0.8-0.8v-52.6c0-0.4,0.3-0.8,0.8-0.8h5.4c2.5,0,4.9,1.3,6.3,3.4l24.8,38.2l-0.8-19.1v-21.7c0-0.4,0.3-0.8,0.8-0.8h7.2C228.9,110,229.2,110.3,229.2,110.8L229.2,110.8z"
      />
      <path
        fill="currentColor"
        d="M303,164h-7.6c-0.5,0-0.9-0.5-0.7-1l20.2-52.3c0.2-0.4,0.6-0.7,1-0.7h9.6c0.5,0,0.9,0.3,1,0.7l20.3,52.3c0.2,0.5-0.2,1-0.7,1h-7.6c-0.3,0-0.6-0.2-0.7-0.5l-16.3-43c-0.2-0.6-1.2-0.6-1.4,0l-16.3,43C303.6,163.8,303.3,164,303,164L303,164z"
      />
      <path
        fill="currentColor"
        d="M399.8,162.8l-15.2-19.4c8.6-1.6,13.6-7.4,13.6-16.3c0-10.2-6.6-17.1-18.4-17.1h-21.2c-0.6,0-1.1,0.5-1.1,1.1c0,4,3.2,7.2,7.2,7.2H379c7.1,0,10.5,3.6,10.5,8.9c0,5.3-3.3,8.9-10.5,8.9h-20.2c-0.6,0-1.1,0.5-1.1,1.1v26c0,0.4,0.3,0.8,0.8,0.8h7.2c0.4,0,0.8-0.3,0.8-0.8v-19.3h8.3l13.2,17.2c1.4,1.9,3.6,2.9,6,2.9h5.5C399.9,164,400.2,163.3,399.8,162.8L399.8,162.8z"
      />
      <path
        fill="currentColor"
        d="M280.2,110h-33.5c-0.6,0-1,0.4-1,1c0,4,3.3,7.3,7.3,7.3h27.2c0.4,0,0.8-0.3,0.8-0.8v-6.8C280.9,110.3,280.6,110,280.2,110z M280.2,155.7h-25c-0.4,0-0.8-0.3-0.8-0.8v-13.5c0-0.4,0.3-0.8,0.8-0.8h23.1c0.4,0,0.8-0.3,0.8-0.8V133c0-0.4-0.3-0.8-0.8-0.8h-31.5c-0.6,0-1.1,0.5-1.1,1.1v29.5c0,0.6,0.5,1.1,1.1,1.1h33.4c0.4,0,0.8-0.3,0.8-0.8v-6.8C280.9,156,280.6,155.7,280.2,155.7L280.2,155.7z"
      />
      <path
        fill="currentColor"
        d="M130.2,96.6l-18.8,27.9c-1.3,1.9,1.2,4.2,3,2.6l18.5-16.1c0.5-0.4,1.2-0.1,1.2,0.6v50.3c0,0.7-0.9,1-1.3,0.5l-56-67C75,93.2,72.4,92,69.5,92h-2c-5.2,0-9.5,4.3-9.5,9.6v70.8c0,5.3,4.3,9.6,9.6,9.6c3.3,0,6.4-1.7,8.2-4.6l18.8-27.9c1.3-1.9-1.2-4.2-3-2.6l-18.5,16c-0.5,0.4-1.2,0.1-1.2-0.6v-50.2c0-0.7,0.9-1,1.3-0.5l56,67c1.8,2.2,4.5,3.4,7.3,3.4h2c5.3,0,9.6-4.3,9.6-9.6v-70.8c-0.1-5.3-4.4-9.6-9.7-9.6C135.1,92,132,93.7,130.2,96.6z"
      />
    </svg>
  );
}

function BridgeScene({ playing, onDone }: { playing: boolean; onDone: () => void }) {
  const [phase, setPhase] = useState<BridgePhase>(playing ? 'draw' : 'paid');
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!playing) {
      setPhase('paid');
      return;
    }
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setPhase('paid');
      const done = window.setTimeout(() => doneRef.current(), 400);
      return () => window.clearTimeout(done);
    }
    setPhase('draw');
    const plan: [BridgePhase, number][] = [
      ['leave', 900],
      ['intent', 2500],
      ['cross', 4300],
      ['paid', 5900],
    ];
    const timers = plan.map(([next, ms]) => window.setTimeout(() => setPhase(next), ms));
    const done = window.setTimeout(() => doneRef.current(), 7400);
    return () => {
      for (const id of timers) window.clearTimeout(id);
      window.clearTimeout(done);
    };
  }, [playing]);

  const arrived = phase === 'cross' || phase === 'paid';
  const swapped = phase === 'intent' || phase === 'cross' || phase === 'paid';
  const northlineBalance = arrived ? STORY.payBalanceAfter : STORY.payBalance;
  const claireBalance = arrived ? STORY.totalHuman : '0';

  return (
    <div className="inv-bridge" data-phase={phase}>
      <p className="inv-bridge-kicker">Settlement</p>
      <div className="inv-bridge-row">
        <article className="inv-party" data-role="payer">
          <Avatar seed={STORY.business} kind="mark" />
          <strong>{STORY.business}</strong>
          <span>
            {STORY.paySymbol} · {STORY.payChain}
          </span>
          <em>
            {northlineBalance} {STORY.paySymbol}
          </em>
          <b>{arrived ? 'Sent' : 'Paying'}</b>
        </article>
        <div className="inv-track">
          <div className="inv-track-line" aria-hidden>
            <span className="inv-track-fill" />
          </div>
          <div className="inv-intent">
            <NearLogo />
            <strong>NEAR Intents</strong>
            <span>{swapped ? `${STORY.symbol} out` : `${STORY.paySymbol} in`}</span>
          </div>
          <div className="inv-packet">
            <strong>{swapped ? STORY.totalHuman : STORY.payHuman}</strong>
            <span>{swapped ? STORY.symbol : STORY.paySymbol}</span>
          </div>
        </div>
        <article className="inv-party" data-role="payee">
          <Avatar seed={STORY.contractor} />
          <strong>{STORY.contractor}</strong>
          <span className="inv-mono">
            {STORY.wallet} · {STORY.chain}
          </span>
          <em>
            {claireBalance} {STORY.symbol}
          </em>
          <b>{phase === 'paid' ? 'Paid' : 'Waiting'}</b>
        </article>
      </div>
      <p className="inv-bridge-caption">{BRIDGE_CAPTION[phase]}</p>
      {phase === 'paid' ? <p className="inv-pill inv-bridge-tx">Tx {STORY.tx}</p> : null}
    </div>
  );
}

function WriteScene({
  onSend,
  onPoint,
  onTap,
  onReady,
}: {
  onSend: () => void;
  onPoint: (el: HTMLElement) => void;
  onTap: () => void;
  onReady: () => void;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const pointRef = useRef(onPoint);
  const tapRef = useRef(onTap);
  const readyRef = useRef(onReady);
  pointRef.current = onPoint;
  tapRef.current = onTap;
  readyRef.current = onReady;
  const [values, setValues] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string | null>(null);
  const [asset, setAsset] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const timers: number[] = [];
    let cancelled = false;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finish = (next: Record<string, string>) => {
      setValues(next);
      setActive(null);
      setReady(true);
      readyRef.current();
    };
    const alive = () => !cancelled;

    async function selectAsset() {
      const trigger = rootRef.current?.querySelector<HTMLElement>('.demo-asset-trigger');
      if (!trigger || !alive()) return;
      pointRef.current(trigger);
      await wait(520, timers);
      if (!alive()) return;
      tapRef.current();
      await wait(180, timers);
      if (!alive()) return;
      trigger.click();
      await wait(460, timers);
      if (!alive()) return;
      const search = document.querySelector<HTMLInputElement>('.demo-asset-search input');
      if (search) {
        pointRef.current(search);
        await wait(480, timers);
        if (!alive()) return;
        tapRef.current();
        search.focus();
        await wait(160, timers);
        const query = 'USDC';
        for (let i = 1; i <= query.length; i++) {
          if (!alive()) return;
          setNativeValue(search, query.slice(0, i));
          await wait(78, timers);
        }
        await wait(320, timers);
      }
      if (!alive()) return;
      const usdc = [...document.querySelectorAll<HTMLButtonElement>('.demo-asset-row')].find((row) =>
        /USDC/i.test(row.textContent ?? ''),
      );
      if (!usdc) {
        setAsset(INVOICE_USDC_NEAR);
        return;
      }
      usdc.scrollIntoView({ block: 'nearest' });
      pointRef.current(usdc);
      await wait(520, timers);
      if (!alive()) return;
      tapRef.current();
      await wait(180, timers);
      if (!alive()) return;
      usdc.click();
      await wait(420, timers);
      if (!alive()) return;
      const near = [...document.querySelectorAll<HTMLButtonElement>('.demo-asset-chain-panel-row')].find(
        (row) => (row.textContent ?? '').includes('NEAR'),
      );
      if (!near) {
        setAsset(INVOICE_USDC_NEAR);
        return;
      }
      pointRef.current(near);
      await wait(480, timers);
      if (!alive()) return;
      tapRef.current();
      await wait(180, timers);
      if (!alive()) return;
      near.click();
      await wait(280, timers);
    }

    if (reduce) {
      setAsset(INVOICE_USDC_NEAR);
      finish(Object.fromEntries(TYPE_STEPS.filter((step) => step.pace >= 0).map((step) => [step.key, step.text])));
      return;
    }
    (async () => {
      await wait(700, timers);
      for (let s = 0; s < TYPE_STEPS.length; s++) {
        if (cancelled) return;
        const step = TYPE_STEPS[s]!;
        if (step.pace < 0) {
          await selectAsset();
          continue;
        }
        const el = rootRef.current?.querySelector<HTMLElement>(`[data-key="${step.key}"]`);
        if (el) pointRef.current(el);
        await wait(s === 0 ? 140 : 500, timers);
        if (cancelled) return;
        tapRef.current();
        setActive(step.key);
        await wait(160, timers);
        for (let i = 1; i <= step.text.length; i++) {
          if (cancelled) return;
          setValues((current) => ({ ...current, [step.key]: step.text.slice(0, i) }));
          await wait(step.pace + Math.round(Math.random() * 22), timers);
        }
        await wait(80, timers);
      }
      if (cancelled) return;
      finish(Object.fromEntries(TYPE_STEPS.map((step) => [step.key, step.text])));
    })();
    return () => {
      cancelled = true;
      for (const id of timers) window.clearTimeout(id);
    };
  }, []);

  const showTotal = (values.l2amt ?? '') === STORY.lines[1].human;

  return (
    <article className="inv-card inv-write" ref={rootRef}>
      <Brand who="Invoice" />
      <h1>Send an invoice</h1>
      <div className="inv-form">
        <div className="inv-row">
          <Field
            label="Your name"
            fieldKey="name"
            value={values.name ?? ''}
            hot={active === 'name'}
            placeholder="Your name"
          />
          <Field
            label="Email"
            fieldKey="email"
            value={values.email ?? ''}
            hot={active === 'email'}
            placeholder="you@studio.com"
          />
        </div>
        <div className="inv-row">
          <Field
            label="Invoice reference"
            fieldKey="reference"
            value={values.reference ?? ''}
            hot={active === 'reference'}
            placeholder="INV-001"
          />
          <Field
            label="Due date"
            fieldKey="due"
            value={values.due ?? ''}
            hot={active === 'due'}
            placeholder="Due date"
          />
        </div>
        <div className="inv-asset">
          <DemoAssetModal options={INVOICE_ASSET_OPTIONS} value={asset} onChange={setAsset} />
        </div>
        <div className="inv-lines">
          <div className="inv-line-head">
            <span>Description</span>
            <span>Amount ({STORY.symbol})</span>
          </div>
          <div className="inv-line-edit">
            <Field
              label="Description"
              fieldKey="l1"
              value={values.l1 ?? ''}
              hot={active === 'l1'}
              placeholder="e.g. Design work"
            />
            <Field
              label={`Amount (${STORY.symbol})`}
              fieldKey="l1amt"
              value={values.l1amt ?? ''}
              hot={active === 'l1amt'}
              placeholder="0.00"
              mono
            />
          </div>
          <div className="inv-line-edit">
            <Field
              label="Description"
              fieldKey="l2"
              value={values.l2 ?? ''}
              hot={active === 'l2'}
              placeholder="e.g. Design work"
            />
            <Field
              label={`Amount (${STORY.symbol})`}
              fieldKey="l2amt"
              value={values.l2amt ?? ''}
              hot={active === 'l2amt'}
              placeholder="0.00"
              mono
            />
          </div>
          <div className="inv-line inv-line-total" data-ready={showTotal ? 'true' : 'false'}>
            <span>Total</span>
            <strong>
              {showTotal ? `${STORY.totalHuman} ${STORY.symbol}` : '—'}
            </strong>
          </div>
        </div>
        <Field
          label="Receiving wallet"
          fieldKey="wallet"
          value={values.wallet ?? ''}
          hot={active === 'wallet'}
          placeholder="name.near"
          mono
        />
        <button
          type="button"
          className="inv-primary"
          data-act={ready ? '' : undefined}
          onClick={onSend}
        >
          <Send size={16} strokeWidth={1.85} aria-hidden />
          Send invoice
        </button>
      </div>
    </article>
  );
}

function ConfirmScene({ onVerify }: { onVerify: () => void }) {
  return (
    <article className="inv-card inv-mail">
      <Brand who="Claire’s email" />
      <div className="inv-mail-bar">
        <Mail size={16} strokeWidth={1.75} aria-hidden />
        <span>Inbox · {STORY.email}</span>
      </div>
      <p className="inv-eyebrow">From Tendr</p>
      <h1>Confirm invoice {STORY.reference}</h1>
      <p className="inv-lead">
        {STORY.contractor}, confirming sends this invoice to {STORY.business}’s inbox. Your wallet{' '}
        <span className="inv-mono">{STORY.wallet}</span> cannot be changed after this.
      </p>
      <ul className="inv-mail-facts">
        <li>
          <span>To</span>
          {STORY.business}
        </li>
        <li>
          <span>Amount</span>
          {STORY.totalHuman} {STORY.symbol}
        </li>
        <li>
          <span>Reference</span>
          {STORY.reference}
        </li>
      </ul>
      <button type="button" className="inv-primary" data-act onClick={onVerify}>
        Verify and send
      </button>
    </article>
  );
}

function SettleScene({ signing, onSign }: { signing: boolean; onSign: () => void }) {
  const [step, setStep] = useState<'ask' | 'scan' | 'signed'>('ask');

  useEffect(() => {
    if (!signing) {
      setStep('ask');
      return;
    }
    setStep('ask');
    const scan = window.setTimeout(() => setStep('scan'), 900);
    const signed = window.setTimeout(() => setStep('signed'), 2300);
    return () => {
      window.clearTimeout(scan);
      window.clearTimeout(signed);
    };
  }, [signing]);

  return (
    <article className="inv-card inv-settle">
      <Brand who="Payout quote" />
      <p className="inv-eyebrow">Exact output · expires {STORY.quoteMinutes}</p>
      <h1>
        {STORY.totalHuman} <span>{STORY.symbol}</span>
      </h1>
      <p className="inv-lead">
        Northline sends {STORY.paySymbol} on {STORY.payChain}. {STORY.contractor.split(' ')[0]} receives{' '}
        {STORY.symbol} on {STORY.chain}, at <span className="inv-mono">{STORY.wallet}</span>.
      </p>
      <ul className="inv-quote">
        <li>
          <span>Pay from</span>
          <strong>
            <Wallet size={14} strokeWidth={1.75} aria-hidden />
            {STORY.payBalance} {STORY.paySymbol} · {STORY.payChain}
          </strong>
        </li>
        <li>
          <span>Northline sends</span>
          <strong>
            {STORY.payHuman} {STORY.paySymbol}
          </strong>
        </li>
        <li>
          <span>Claire receives</span>
          <strong>
            {STORY.totalHuman} {STORY.symbol} · {STORY.chain}
          </strong>
        </li>
        <li>
          <span>Network fee</span>
          <strong>
            {STORY.payFee} {STORY.paySymbol}
          </strong>
        </li>
      </ul>
      <button type="button" className="inv-primary" data-act onClick={onSign} disabled={signing}>
        <Fingerprint size={16} strokeWidth={1.85} aria-hidden />
        Sign and pay
      </button>
      {signing ? (
        <div className="inv-passkey" data-step={step} aria-live="polite">
          <div className="inv-passkey-mark" data-step={step}>
            <span className="inv-passkey-ring" />
            <span className="inv-passkey-ring" />
            {step === 'signed' ? (
              <Check size={34} strokeWidth={2.4} aria-hidden />
            ) : (
              <Fingerprint size={34} strokeWidth={1.6} aria-hidden />
            )}
            {step === 'scan' ? <span className="inv-passkey-scan" /> : null}
          </div>
          <p className="inv-eyebrow">{step === 'signed' ? 'Signed' : 'Wallet passkey'}</p>
          <h2>{step === 'signed' ? 'Payout approved' : 'Confirm with Northline'}</h2>
          <div className="inv-passkey-route">
            <span>
              <strong>
                {STORY.payHuman} {STORY.paySymbol}
              </strong>
              <em>{STORY.payChain}</em>
            </span>
            <i aria-hidden />
            <span>
              <strong>
                {STORY.totalHuman} {STORY.symbol}
              </strong>
              <em>{STORY.chain}</em>
            </span>
          </div>
          <p>
            {step === 'signed'
              ? 'Opening the NEAR Intents bridge.'
              : 'Touch the passkey. Nothing leaves the wallet until this signs.'}
          </p>
          <ol className="inv-passkey-steps">
            <li data-on="true">Ask</li>
            <li data-on={step === 'scan' || step === 'signed' ? 'true' : 'false'}>Scan</li>
            <li data-on={step === 'signed' ? 'true' : 'false'}>Signed</li>
          </ol>
        </div>
      ) : null}
    </article>
  );
}

function Field({
  label,
  value,
  mono,
  hot,
  fieldKey,
  placeholder,
}: {
  label: string;
  value: string;
  mono?: boolean;
  hot?: boolean;
  fieldKey: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    if (!hot || !input) return;
    input.focus({ preventScroll: true });
    const end = value.length;
    try {
      input.setSelectionRange(end, end);
    } catch {
      // Some input types reject a selection range.
    }
  }, [hot, value]);
  return (
    <label className="inv-field" data-hot={hot || undefined}>
      <span>{label}</span>
      <input
        ref={ref}
        data-key={fieldKey}
        value={value}
        placeholder={placeholder}
        onChange={() => {}}
        className={mono ? 'inv-mono' : undefined}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}
