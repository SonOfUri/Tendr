'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEMOS, type DemoCheckoutBootstrap, type DemoSlug } from '@/lib/demo';
import { buildDemoUiBootstrap } from '@/lib/demo-ui-checkout';
import { CodePanel } from '@/components/demo/CodePanel';
import { DemoCheckoutPanel } from '@/components/demo/DemoCheckoutPanel';
import { DemoFlowStepper } from '@/components/demo/DemoFlowStepper';
import { DraggablePanel } from '@/components/demo/DraggablePanel';
import type { CartPricing } from '@/components/demo/EcommerceCart';
import { ScenarioCard } from '@/components/demo/ScenarioCards';
import { ScenarioToggle } from '@/components/demo/ScenarioToggle';
import '@/components/demo/demo-playground.css';
import './motion-2.css';

type Brand = { name: string; logoUrl: string };
type CheckoutState = {
  slug: DemoSlug;
  sessionId: string;
  clientSecret: string;
  bootstrap: DemoCheckoutBootstrap;
  amount: string;
};

type Beat = {
  id: string;
  ms: number;
  slug: DemoSlug;
  checkout?: boolean;
  settle?: boolean;
  customize?: boolean;
  integrate?: boolean;
  ai?: 'open' | 'help';
  caption?: string;
};

const TAB = {
  ecommerce: '.demo-scenario-opt[title="E-commerce"]',
  fintech: '.demo-scenario-opt[title="Fintech"]',
  gaming: '.demo-scenario-opt[title="Gaming"]',
  markets: '.demo-scenario-opt[title="Prediction markets"]',
} as const;

type CursorStep =
  | { at: number; selector: string; snap?: boolean }
  | { at: number; click: true }
  | { at: number; hide: true };

const CURSOR_SCRIPT: Record<string, CursorStep[]> = {
  open: [
    { at: 350, selector: TAB.ecommerce, snap: true },
    { at: 5000, selector: TAB.fintech },
    { at: 6200, click: true },
  ],
  fintech: [
    { at: 2800, selector: TAB.gaming },
    { at: 4200, click: true },
  ],
  gaming: [
    { at: 2800, selector: TAB.markets },
    { at: 4200, click: true },
  ],
  markets: [],
  integrate: [{ at: 0, hide: true }],
  cart: [
    { at: 450, selector: '.demo-cart-cta', snap: true },
    { at: 5400, click: true },
  ],
  pay: [{ at: 700, selector: '.demo-asset-trigger' }],
  woo: [],
  ai: [
    { at: 250, selector: '.demo-tendrai-fab' },
    { at: 700, click: true },
  ],
  help: [
    { at: 350, selector: '.checkout-ai-tabs .checkout-ai-tab:nth-child(2)' },
    { at: 900, click: true },
    { at: 1250, selector: '.checkout-ai-suggestions button' },
    { at: 1700, click: true },
  ],
  settle: [
    { at: 500, selector: '.demo-status-card' },
    { at: 6200, selector: TAB.fintech },
    { at: 7600, click: true },
  ],
  fintech2: [
    { at: 5200, selector: TAB.markets },
    { at: 6600, click: true },
  ],
  markets2: [
    { at: 6400, selector: TAB.gaming },
    { at: 7600, click: true },
  ],
  game: [
    { at: 3200, selector: '.demo-accordion-trigger' },
    { at: 4700, click: true },
  ],
  brand: [
    { at: 250, selector: '#m2-brand-name' },
    { at: 1900, selector: '.demo-store-logo-preview' },
    { at: 2500, click: true },
    { at: 7000, selector: '.demo-game-cta' },
    { at: 8600, click: true },
  ],
  gamepay: [{ at: 800, selector: '.demo-asset-trigger' }],
  hold: [],
};

const BEATS: Beat[] = [
  { id: 'open', ms: 6500, slug: 'ecommerce', caption: 'Tendr’s live demonstration' },
  { id: 'fintech', ms: 4500, slug: 'fintech' },
  { id: 'gaming', ms: 4500, slug: 'gaming' },
  { id: 'markets', ms: 5500, slug: 'prediction-markets', caption: 'One payment infrastructure' },
  { id: 'integrate', ms: 17000, slug: 'ecommerce', integrate: true },
  { id: 'cart', ms: 6000, slug: 'ecommerce', caption: 'E-commerce' },
  { id: 'pay', ms: 8000, slug: 'ecommerce', checkout: true },
  { id: 'woo', ms: 6500, slug: 'ecommerce', checkout: true, caption: 'Already live on WooCommerce' },
  { id: 'ai', ms: 9000, slug: 'ecommerce', checkout: true, ai: 'open', caption: 'Meet Tendr AI' },
  { id: 'help', ms: 8000, slug: 'ecommerce', checkout: true, ai: 'help' },
  { id: 'settle', ms: 8000, slug: 'ecommerce', checkout: true, settle: true },
  { id: 'fintech2', ms: 7000, slug: 'fintech', caption: 'Fintech' },
  { id: 'markets2', ms: 8000, slug: 'prediction-markets', caption: 'One integration. Different applications.' },
  { id: 'game', ms: 5000, slug: 'gaming', caption: 'Customization' },
  { id: 'brand', ms: 9000, slug: 'gaming', customize: true },
  { id: 'gamepay', ms: 9000, slug: 'gaming', checkout: true, caption: 'Settlement routing stays the same' },
  { id: 'hold', ms: 0, slug: 'gaming', checkout: true, caption: 'Settlement routing stays the same' },
];

function initialBrands(): Record<DemoSlug, Brand> {
  return Object.fromEntries(
    DEMOS.map((d) => [d.slug, { name: d.branding.defaultName, logoUrl: d.branding.defaultLogoUrl }]),
  ) as Record<DemoSlug, Brand>;
}

function localPoint(el: HTMLElement) {
  const root = document.querySelector<HTMLElement>('.m2');
  if (!root) return null;
  const rootRect = root.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const scaleX = rootRect.width / root.offsetWidth || 1;
  const scaleY = rootRect.height / root.offsetHeight || 1;
  return {
    x: (rect.left - rootRect.left + rect.width * 0.38) / scaleX,
    y: (rect.top - rootRect.top + rect.height * 0.45) / scaleY,
  };
}

function waitFor(selector: string, dead: () => boolean, timers: number[]) {
  return new Promise<HTMLElement | null>((resolve) => {
    const started = performance.now();
    const tick = () => {
      if (dead()) {
        resolve(null);
        return;
      }
      const el = document.querySelector<HTMLElement>(selector);
      const rect = el?.getBoundingClientRect();
      if (el && rect && rect.width > 0 && rect.height > 0) {
        resolve(el);
        return;
      }
      if (performance.now() - started > 2200) {
        resolve(null);
        return;
      }
      timers.push(window.setTimeout(tick, 70));
    };
    tick();
  });
}

function bootCheckout(slug: DemoSlug, brand: Brand): CheckoutState {
  const demo = DEMOS.find((d) => d.slug === slug) ?? DEMOS[0]!;
  const amount = slug === 'ecommerce' ? '2213.00' : demo.amount;
  const built = buildDemoUiBootstrap({
    amount,
    currency: demo.currency,
    productName: demo.productName,
    merchantName: brand.name,
    merchantLogoUrl: brand.logoUrl,
  });
  return {
    slug,
    sessionId: built.sessionId,
    clientSecret: built.clientSecret,
    amount,
    bootstrap: {
      session: built.session,
      tokens: built.tokens,
      tokenId: built.tokenId,
      quote: built.quote,
    },
  };
}

export function MotionDemo() {
  const [index, setIndex] = useState(0);
  const [run, setRun] = useState(0);
  const [brands, setBrands] = useState(initialBrands);
  const [checkout, setCheckout] = useState<CheckoutState | null>(null);
  const [accordion, setAccordion] = useState(false);
  const [cartPricing, setCartPricing] = useState<CartPricing | null>(null);
  const [signal, setSignal] = useState(0);
  const [cursor, setCursor] = useState({ x: 120, y: 180, on: false, clicking: false, snap: true });
  const brandsRef = useRef(brands);
  brandsRef.current = brands;
  const beat = BEATS[index] ?? BEATS[0]!;
  const demo = DEMOS.find((d) => d.slug === beat.slug) ?? DEMOS[0]!;
  const brand = brands[beat.slug]!;
  const flowStage = beat.settle ? 'settled' : beat.checkout ? 'checkout' : 'idle';
  const sidebarAmount = beat.slug === 'ecommerce' && cartPricing ? cartPricing.total : demo.amount;

  const restart = useCallback(() => {
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
    setBrands(initialBrands());
    setCheckout(null);
    setAccordion(false);
    setCartPricing(null);
    setSignal(0);
    setIndex(0);
    setRun((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.shiftKey && event.altKey && event.code === 'KeyN') {
        event.preventDefault();
        setIndex((i) => Math.min(BEATS.length - 1, i + 1));
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
        setIndex(BEATS.length - 1);
        return;
      }
      const id = window.location.hash.replace('#', '');
      const found = BEATS.findIndex((item) => item.id === id);
      setIndex(found >= 0 ? found : 0);
      if (fromHash) setRun((n) => n + 1);
    };
    go(false);
    const onHash = () => go(true);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (beat.ms <= 0) return;
    if (window.location.hash.replace('#', '') === beat.id) return;
    const timer = window.setTimeout(() => setIndex((i) => Math.min(BEATS.length - 1, i + 1)), beat.ms);
    return () => window.clearTimeout(timer);
  }, [beat, run]);

  useEffect(() => {
    setAccordion(Boolean(beat.customize));
    if (!beat.checkout) {
      setCheckout(null);
      return;
    }
    setCheckout((current) => {
      if (current && current.slug === beat.slug) return current;
      return bootCheckout(beat.slug, brandsRef.current[beat.slug]);
    });
  }, [beat, run]);

  useEffect(() => {
    if (beat.id !== 'game') return;
    const gaming = DEMOS.find((d) => d.slug === 'gaming')!;
    setBrands((prev) => ({
      ...prev,
      gaming: { name: gaming.branding.defaultName, logoUrl: gaming.branding.defaultLogoUrl },
    }));
  }, [beat.id, run]);

  useEffect(() => {
    if (beat.id !== 'brand') return;
    const next = 'Nebula Arcade';
    const logo = '/tendr-logo.png';
    let i = 0;
    let typer = 0;
    const startType = window.setTimeout(() => {
      setBrands((prev) => ({ ...prev, gaming: { ...prev.gaming, name: '' } }));
      typer = window.setInterval(() => {
        i += 1;
        const name = next.slice(0, i);
        setBrands((prev) => ({ ...prev, gaming: { ...prev.gaming, name } }));
        const field = document.getElementById('m2-brand-name');
        if (field instanceof HTMLInputElement) {
          field.focus();
          const caret = name.length;
          window.requestAnimationFrame(() => field.setSelectionRange(caret, caret));
        }
        if (i >= next.length) window.clearInterval(typer);
      }, 85);
    }, 700);
    const swap = window.setTimeout(() => {
      setBrands((prev) => ({ ...prev, gaming: { ...prev.gaming, logoUrl: logo } }));
    }, 2600);
    return () => {
      window.clearTimeout(startType);
      window.clearInterval(typer);
      window.clearTimeout(swap);
    };
  }, [beat.id, run]);

  useEffect(() => {
    if (!beat.settle) return;
    setSignal((n) => n + 1);
  }, [beat.settle, beat.id, run]);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const steps = CURSOR_SCRIPT[beat.id] ?? [];
    let cancelled = false;
    const timers: number[] = [];
    let moveGen = 0;
    const dead = () => cancelled;

    const moveTo = (selector: string, snap = false) => {
      const mine = ++moveGen;
      void (async () => {
        const el = await waitFor(selector, () => dead() || moveGen !== mine, timers);
        if (!el || dead() || moveGen !== mine) return;
        const point = localPoint(el);
        if (!point) return;
        setCursor((current) => ({
          ...current,
          x: point.x,
          y: point.y,
          on: true,
          clicking: false,
          snap,
        }));
        if (snap) {
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              if (!dead()) setCursor((current) => ({ ...current, snap: false }));
            });
          });
        }
      })();
    };

    for (const step of steps) {
      timers.push(
        window.setTimeout(() => {
          if (dead()) return;
          if ('hide' in step) {
            moveGen += 1;
            setCursor((current) => ({ ...current, on: false, clicking: false }));
            return;
          }
          if ('click' in step) {
            setCursor((current) => ({ ...current, clicking: true }));
            timers.push(
              window.setTimeout(() => {
                if (!dead()) setCursor((current) => ({ ...current, clicking: false }));
              }, 280),
            );
            return;
          }
          moveTo(step.selector, step.snap);
        }, step.at),
      );
    }

    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [beat.id, run]);

  useEffect(() => {
    if (beat.ai !== 'open') return;
    const click = () => {
      const button = document.querySelector<HTMLButtonElement>('.demo-tendrai-fab');
      if (button && button.getAttribute('aria-expanded') !== 'true') button.click();
    };
    const a = window.setTimeout(click, 700);
    const b = window.setTimeout(click, 1800);
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(b);
    };
  }, [beat.ai, beat.id, run]);

  useEffect(() => {
    if (beat.ai !== 'help') return;
    const ensure = window.setTimeout(() => {
      const fab = document.querySelector<HTMLButtonElement>('.demo-tendrai-fab');
      if (fab && fab.getAttribute('aria-expanded') !== 'true') fab.click();
    }, 200);
    const openHelp = window.setTimeout(() => {
      const tabs = document.querySelectorAll<HTMLButtonElement>('.checkout-ai-tab');
      tabs[1]?.click();
    }, 900);
    const ask = window.setTimeout(() => {
      const suggestion = document.querySelector<HTMLButtonElement>('.checkout-ai-suggestions button');
      suggestion?.click();
    }, 1700);
    return () => {
      window.clearTimeout(ensure);
      window.clearTimeout(openHelp);
      window.clearTimeout(ask);
    };
  }, [beat.ai, beat.id, run]);

  const onCartPricingChange = useCallback((pricing: CartPricing) => {
    setCartPricing(pricing);
  }, []);

  return (
    <div className="demo-playground m2" data-theme="light" data-scenario={beat.slug} data-beat={beat.id}>
      <section className="demo-canvas" aria-label="Demo canvas">
        <div className="demo-canvas-chrome">
          <div className="demo-view-toggle" role="group" aria-label="View mode">
            <button type="button" aria-pressed="true">
              Component
            </button>
            <button type="button" aria-pressed="false">
              Code
            </button>
          </div>
          <button type="button" className="demo-theme-toggle" aria-label="Switch to dark mode" tabIndex={-1}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M21 14.3A8.5 8.5 0 1 1 9.7 3 7 7 0 0 0 21 14.3Z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className="demo-stage">
          <DraggablePanel kind="component" visible={!checkout} anchor="center">
            <ScenarioCard
              demo={demo}
              busy={false}
              onFund={() => setCheckout(bootCheckout(beat.slug, brandsRef.current[beat.slug]))}
              onCartPricingChange={onCartPricingChange}
            />
          </DraggablePanel>
          <DraggablePanel kind="code" visible={false} anchor="top">
            <CodePanel demo={demo} />
          </DraggablePanel>
        </div>
        {checkout ? (
          <DemoCheckoutPanel
            key={checkout.sessionId}
            sessionId={checkout.sessionId}
            clientSecret={checkout.clientSecret}
            productName={demo.productName}
            merchantName={brand.name}
            merchantLogoUrl={brand.logoUrl}
            payEyebrow={demo.branding.payEyebrow}
            skin={beat.slug}
            uiTheme="light"
            amountHint={checkout.amount}
            bootstrap={checkout.bootstrap}
            uiOnly
            manualSettle
            filmSettle={beat.settle ? signal : undefined}
            successHint={demo.successHint}
            onClose={() => setCheckout(null)}
            onComplete={() => undefined}
          />
        ) : null}
        {beat.caption ? <p className="m2-caption">{beat.caption}</p> : null}
      </section>
      <aside className="demo-sidebar">
        <div className="demo-sidebar-top">
          <p className="demo-sidebar-label">Usecases</p>
          <ScenarioToggle value={beat.slug} onChange={() => undefined} />
        </div>
        <div className="demo-sidebar-body">
          <DemoFlowStepper
            key={demo.slug}
            demo={demo}
            stage={flowStage}
            entityName={brand.name}
            entityLogoUrl={brand.logoUrl}
            amount={sidebarAmount}
          />
        </div>
        <div className="demo-sidebar-footer">
          <button type="button" className="demo-accordion-trigger" aria-expanded={accordion}>
            Customize experience
          </button>
          <div className="demo-accordion-panel" hidden={!accordion}>
            <div className="demo-field">
              <label htmlFor="m2-brand-name">{demo.branding.nameFieldLabel}</label>
              <input id="m2-brand-name" value={brand.name} readOnly />
            </div>
            <div className="demo-field">
              <label>{demo.branding.logoFieldLabel}</label>
              <div className="demo-store-logo-row">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={brand.logoUrl} alt="" className="demo-store-logo-preview" width={44} height={44} />
              </div>
            </div>
            <p style={{ margin: 0 }}>{demo.branding.customizeHint}</p>
          </div>
        </div>
      </aside>
      {beat.integrate ? <IntegrateBoard /> : null}
      <FilmCursor x={cursor.x} y={cursor.y} on={cursor.on} clicking={cursor.clicking} snap={cursor.snap} />
    </div>
  );
}

function FilmCursor({
  x,
  y,
  on,
  clicking,
  snap,
}: {
  x: number;
  y: number;
  on: boolean;
  clicking: boolean;
  snap: boolean;
}) {
  if (!on) return null;
  return (
    <div
      className="m2-cursor"
      data-click={clicking ? '' : undefined}
      data-snap={snap ? '' : undefined}
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
      <span className="m2-cursor-ring" />
    </div>
  );
}

function IntegrateBoard() {
  return (
    <div className="m2-integrate">
      <p className="m2-kicker">Ways to integrate</p>
      <h1>
        Accessible wherever
        <br />
        businesses <span>build</span>.
      </h1>
      <div className="m2-paths">
        <article>
          <span>01</span>
          <h2>Checkout widget</h2>
          <p>Drop a payment experience into the application.</p>
        </article>
        <article>
          <span>02</span>
          <h2>API and SDK</h2>
          <p>Build a deeper, custom integration.</p>
        </article>
        <article className="m2-commerce">
          <div className="m2-commerce-logos">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/plugins/woocommerce.svg" alt="WooCommerce" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/plugins/shopify.svg" alt="Shopify" />
          </div>
          <h2>E-commerce</h2>
          <p>WooCommerce is live. Shopify is coming soon.</p>
        </article>
      </div>
    </div>
  );
}
