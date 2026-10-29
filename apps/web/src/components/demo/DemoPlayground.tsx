'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEMOS, type DemoCheckoutBootstrap, type DemoSlug } from '@/lib/demo';
import { buildDemoUiBootstrap, DEMO_UI_ONLY } from '@/lib/demo-ui-checkout';
import { CodePanel } from './CodePanel';
import { DemoCheckoutPanel } from './DemoCheckoutPanel';
import { DemoFlowStepper, type DemoFlowStage } from './DemoFlowStepper';
import { DraggablePanel } from './DraggablePanel';
import type { CartPricing } from './EcommerceCart';
import { ScenarioCard } from './ScenarioCards';
import { ScenarioToggle } from './ScenarioToggle';
import './demo-playground.css';

type ViewMode = 'component' | 'code';
type ThemeMode = 'light' | 'dark';

type ActiveCheckout = {
  sessionId: string;
  clientSecret: string;
  bootstrap?: DemoCheckoutBootstrap | null;
};

type BrandProfile = { name: string; logoUrl: string };

function initialBrands(): Record<DemoSlug, BrandProfile> {
  return Object.fromEntries(
    DEMOS.map((d) => [
      d.slug,
      { name: d.branding.defaultName, logoUrl: d.branding.defaultLogoUrl },
    ]),
  ) as Record<DemoSlug, BrandProfile>;
}

export function DemoPlayground() {
  const [slug, setSlug] = useState<DemoSlug>('ecommerce');
  const [view, setView] = useState<ViewMode>('component');
  const [theme, setTheme] = useState<ThemeMode>('light');
  const [busy, setBusy] = useState(false);
  const [pendingAmount, setPendingAmount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accordionOpen, setAccordionOpen] = useState(false);
  const [checkout, setCheckout] = useState<ActiveCheckout | null>(null);
  const [settledHint, setSettledHint] = useState<string | null>(null);
  const [brands, setBrands] = useState(initialBrands);
  const [cartPricing, setCartPricing] = useState<CartPricing | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const demo = DEMOS.find((d) => d.slug === slug) ?? DEMOS[0]!;
  const brand = brands[slug]!;
  const flowStage: DemoFlowStage = settledHint
    ? 'settled'
    : checkout
      ? 'checkout'
      : 'idle';
  const sidebarAmount = slug === 'ecommerce' && cartPricing ? cartPricing.total : demo.amount;
  const checkoutAmount =
    pendingAmount ??
    (slug === 'ecommerce' && cartPricing ? cartPricing.total : demo.amount);
  const sidebarDiscount =
    slug === 'ecommerce' && cartPricing?.discountOn ? 'TENDR · 25% off' : null;

  const onCartPricingChange = useCallback((pricing: CartPricing) => {
    setCartPricing(pricing);
  }, []);

  const updateBrand = useCallback(
    (patch: Partial<BrandProfile>) => {
      setBrands((prev) => ({ ...prev, [slug]: { ...prev[slug], ...patch } }));
    },
    [slug],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    if (!status) return;
    if (status === 'settled') {
      const scenario = params.get('scenario');
      const match = scenario ? DEMOS.find((d) => d.slug === scenario) : undefined;
      if (match) setSlug(match.slug);
      setSettledHint(match?.successHint ?? DEMOS[0]!.successHint);
    }
    window.history.replaceState(null, '', '/demo');
  }, []);

  // Warm scenario media so Prediction / cart / logos don't stall on first open.
  useEffect(() => {
    const urls = [
      '/demo/kane.webp',
      '/demo/mbappe.webp',
      '/demo/puffer-jacket.webp',
      '/demo/beige-coat.webp',
      ...DEMOS.map((d) => d.branding.defaultLogoUrl),
    ];
    for (const src of urls) {
      const img = new Image();
      img.src = src;
    }
  }, []);

  const startCheckout = useCallback(
    (amount?: string) => {
      const payAmount =
        amount ?? (slug === 'ecommerce' && cartPricing ? cartPricing.total : demo.amount);
      setBusy(true);
      setPendingAmount(payAmount);
      setError(null);
      setSettledHint(null);
      setView('component');

      // UI-only demo: never hit the network. Feel the flow; no "fetch failed" on stage.
      if (DEMO_UI_ONLY) {
        const boot = buildDemoUiBootstrap({
          amount: payAmount,
          currency: demo.currency,
          productName: demo.productName,
          merchantName: brand.name,
          merchantLogoUrl: brand.logoUrl,
        });
        setCheckout({
          sessionId: boot.sessionId,
          clientSecret: boot.clientSecret,
          bootstrap: {
            session: boot.session,
            tokens: boot.tokens,
            tokenId: boot.tokenId,
            quote: boot.quote,
          },
        });
        setBusy(false);
        return;
      }

      setError('Live checkout API is disabled for this demo build.');
      setBusy(false);
    },
    [
      brand.logoUrl,
      brand.name,
      cartPricing,
      demo.amount,
      demo.currency,
      demo.productName,
      slug,
    ],
  );

  const closeCheckout = useCallback(() => {
    setCheckout(null);
    setPendingAmount(null);
  }, []);

  const completeCheckout = useCallback(() => {
    setCheckout(null);
    setPendingAmount(null);
    setSettledHint(demo.successHint);
  }, [demo.successHint]);

  const onCheckoutStatus = useCallback(
    (status: 'confirming' | 'success') => {
      if (status === 'success') setSettledHint(demo.successHint);
    },
    [demo.successHint],
  );

  function onLogoFile(file: File | undefined) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        updateBrand({ logoUrl: reader.result });
      }
    };
    reader.readAsDataURL(file);
  }

  const customizeHint = useMemo(() => demo.branding.customizeHint, [demo.branding.customizeHint]);

  return (
    <div className="demo-playground" data-theme={theme} data-scenario={slug}>
      <section className="demo-canvas" aria-label="Demo canvas">
        <div className="demo-canvas-chrome">
          <div className="demo-view-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              aria-pressed={view === 'component'}
              onClick={() => setView('component')}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <path d="M3 2.5 9 6 3 9.5V2.5Z" fill="currentColor" />
              </svg>
              Component
            </button>
            <button type="button" aria-pressed={view === 'code'} onClick={() => setView('code')}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path
                  d="M5 3.5 2.5 7 5 10.5M9 3.5 11.5 7 9 10.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Code
            </button>
          </div>

          <button
            type="button"
            className="demo-theme-toggle"
            aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          >
            {theme === 'light' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M21 14.3A8.5 8.5 0 1 1 9.7 3 7 7 0 0 0 21 14.3Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7" />
                <path
                  d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>

        <div className="demo-stage">
          <DraggablePanel
            key={`component-${demo.slug}`}
            kind="component"
            visible={view === 'component' && !checkout}
            anchor="center"
          >
            <ScenarioCard
              demo={demo}
              busy={busy}
              onFund={startCheckout}
              onCartPricingChange={onCartPricingChange}
            />
          </DraggablePanel>

          <DraggablePanel
            key={`code-${demo.slug}`}
            kind="code"
            visible={view === 'code' && !checkout}
            anchor="top"
          >
            <CodePanel demo={demo} />
          </DraggablePanel>
        </div>

        {checkout ? (
          <DemoCheckoutPanel
            sessionId={checkout.sessionId}
            clientSecret={checkout.clientSecret}
            productName={demo.productName}
            merchantName={brand.name}
            merchantLogoUrl={brand.logoUrl}
            payEyebrow={demo.branding.payEyebrow}
            skin={demo.slug}
            amountHint={checkoutAmount}
            bootstrap={checkout.bootstrap}
            uiOnly={DEMO_UI_ONLY}
            successHint={demo.successHint}
            onClose={closeCheckout}
            onComplete={completeCheckout}
            onStatusChange={onCheckoutStatus}
          />
        ) : null}
      </section>

      <aside className="demo-sidebar">
        <div className="demo-sidebar-top">
          <p className="demo-sidebar-label">Usecases</p>
          <ScenarioToggle
            value={slug}
            onChange={(next) => {
              setSlug(next);
              setError(null);
              setSettledHint(null);
              setCheckout(null);
              setCartPricing(null);
            }}
          />
        </div>

        <div className="demo-sidebar-body">
          <DemoFlowStepper
            key={demo.slug}
            demo={demo}
            stage={flowStage}
            entityName={brand.name}
            entityLogoUrl={brand.logoUrl}
            amount={sidebarAmount}
            discountLabel={sidebarDiscount}
          />
          {error ? (
            <p className="demo-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="demo-sidebar-footer">
          <button
            type="button"
            className="demo-accordion-trigger"
            aria-expanded={accordionOpen}
            onClick={() => setAccordionOpen((v) => !v)}
          >
            Customize experience
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              aria-hidden
              style={{
                transform: accordionOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 180ms ease',
              }}
            >
              <path
                d="M4 6.5 8 10.5 12 6.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </button>
          <div className="demo-accordion-panel" hidden={!accordionOpen}>
            <div className="demo-field">
              <label htmlFor="demo-brand-name">{demo.branding.nameFieldLabel}</label>
              <input
                id="demo-brand-name"
                key={`name-${demo.slug}`}
                value={brand.name}
                onChange={(e) => updateBrand({ name: e.target.value })}
                placeholder={demo.branding.defaultName}
              />
            </div>
            <div className="demo-field">
              <label htmlFor="demo-brand-logo">{demo.branding.logoFieldLabel}</label>
              <div className="demo-store-logo-row">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={brand.logoUrl}
                  alt=""
                  className="demo-store-logo-preview"
                  width={44}
                  height={44}
                />
                <div className="demo-store-logo-actions">
                  <button
                    type="button"
                    className="demo-store-logo-btn"
                    onClick={() => logoInputRef.current?.click()}
                  >
                    Upload logo
                  </button>
                  <button
                    type="button"
                    className="demo-store-logo-btn ghost"
                    onClick={() =>
                      updateBrand({
                        name: demo.branding.defaultName,
                        logoUrl: demo.branding.defaultLogoUrl,
                      })
                    }
                  >
                    Reset
                  </button>
                  <input
                    ref={logoInputRef}
                    id="demo-brand-logo"
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      onLogoFile(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </div>
              </div>
            </div>
            <p style={{ margin: 0 }}>{customizeHint}</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
