'use client';

// The theme preview (client part): reads `GET /v1/themes/preview/:token` from the browser and
// draws the merchant's draft on the real canvas with the API's sample cart. Payments are off:
// a fixed ribbon says so, the Pay button is disabled, and nothing creates a session.
import type { ThemePreview as PreviewOpts } from '@tendr/contracts';
import { useEffect, useMemo, useState } from 'react';
import { BlockCanvas } from '@/components/theme/BlockCanvas';
import { payButtonLabel } from '@/components/theme/pay-label';
import { WithPayBar } from '@/components/theme/PayBar';
import { ThemedPage } from '@/components/theme/ThemedPage';
import type { SessionLineItem, SessionView } from '@/lib/checkout/api';
import { formatUsd } from '@/lib/checkout/format';
import { publicEnv } from '@/lib/env';
import { parseShopperTheme } from '@/lib/theme/parse';
import { formatLinkAmount } from '@/lib/payment-links-client';
import { CheckoutCanvas } from '../../../pay/[id]/components/CheckoutCanvas';
import { PayeeLine } from '../../../pay/[id]/components/CheckoutHeader';

/** What the API's public preview read returns (apps/api/src/themes/preview.ts). */
export interface PreviewRead {
  preview: true;
  opts: PreviewOpts;
  theme: unknown;
  sample: {
    kind: 'checkout' | 'link';
    amount: string;
    amount_currency: string;
    line_items: SessionLineItem[];
    link?: { title: string; description: string };
  };
}

export const PREVIEW_RIBBON = 'Preview — payments are off';

/** Reads the preview; null when the link is unknown or expired, or the API can't be reached. */
export async function fetchPreview(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<PreviewRead | null> {
  try {
    const res = await fetchFn(
      `${publicEnv.apiBaseUrl}/v1/themes/preview/${encodeURIComponent(token)}`,
      {
        headers: { accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as PreviewRead | null;
    return body && body.preview === true && body.sample ? body : null;
  } catch {
    return null;
  }
}

/** The sample amount as the checkout shows a total ("$49.00", "₦25,000.00"). */
function sampleAmount(amount: string, currency: string): string {
  if (currency === 'USD') return formatUsd(amount) ?? amount;
  return formatLinkAmount(amount, currency, 2);
}

/** The sealed block, as a shopper sees it, with every control off. */
function SealedPreview({
  payee,
  tradingAs,
  amount,
  buttonLabel,
}: {
  payee: string;
  tradingAs: string | null;
  amount: string;
  /** The theme's button words (`settings.button_label`), if set. */
  buttonLabel: string | null;
}) {
  return (
    <>
      <header className="pay-header">
        <PayeeLine payee={payee} tradingAs={tradingAs} />
        <div className="pay-row">
          <span className="muted">Order total</span>
          <strong className="pay-total">{amount}</strong>
        </div>
        <div className="pay-row muted small">
          <span>Time left to pay</span>
          <span className="pay-countdown">
            <span aria-hidden>⏱ 15:00</span>
          </span>
        </div>
      </header>
      <section className="pay-section" aria-labelledby="preview-pay-title">
        <h2 id="preview-pay-title">Pay with crypto</h2>
        <p className="muted small">Shoppers choose a token and network here.</p>
        <button type="button" className="pay-button" disabled aria-disabled="true">
          <span className="pay-button-label">
            {payButtonLabel(buttonLabel, amount, `Pay ${amount}`)}
          </span>
        </button>
        <p className="pay-alert small" role="note">
          {PREVIEW_RIBBON}. Nothing on this page can take a payment.
        </p>
      </section>
    </>
  );
}

export function PreviewBody({ read }: { read: PreviewRead }) {
  const theme = useMemo(() => {
    const payee = (read.theme as { payee?: unknown } | null)?.payee;
    return parseShopperTheme(read.theme, typeof payee === 'string' && payee ? payee : 'Your store');
  }, [read.theme]);
  const { sample, opts } = read;
  const payee = theme.payee;
  const amount = sampleAmount(sample.amount, sample.amount_currency);
  const sealed = (
    <SealedPreview
      payee={payee}
      tradingAs={theme.trading_as}
      amount={amount}
      buttonLabel={theme.document.settings.button_label ?? null}
    />
  );

  let canvas;
  if (sample.kind === 'link') {
    canvas = (
      <WithPayBar amount={amount} payee={payee} enabled>
        <BlockCanvas
          blocks={theme.document.blocks}
          theme={theme}
          slots={{
            payment: sealed,
            orderSummary: sample.link ? (
              <div className="pay-section">
                <h1 className="pay-title">{sample.link.title}</h1>
                <p className="pay-link-description">{sample.link.description}</p>
              </div>
            ) : undefined,
          }}
        />
      </WithPayBar>
    );
  } else {
    // The checkout's own canvas, fed the sample cart as if it were a session.
    const view = {
      id: 'ses_preview',
      livemode: true,
      merchant: { name: payee },
      theme,
      line_items: sample.line_items,
      checkout_domains: [],
      amount: sample.amount,
      amount_currency: sample.amount_currency,
      success_url: null,
      cancel_url: null,
      payment_link: null,
    } as unknown as SessionView;
    canvas = (
      <CheckoutCanvas
        view={view}
        theme={theme}
        screen="pay"
        sealed={sealed}
        amountText={amount}
        formatAmount={(v) => sampleAmount(v, sample.amount_currency)}
      />
    );
  }

  return (
    <ThemedPage theme={theme} scheme={opts.scheme}>
      <div className="tdr-preview" data-viewport={opts.viewport}>
        <p className="tdr-preview-ribbon" role="status">
          {PREVIEW_RIBBON}
        </p>
        <div className="pay-card">
          {canvas}
          <p className="pay-foot muted small">Payments by Tendr</p>
        </div>
      </div>
    </ThemedPage>
  );
}

export function ThemePreview({ token }: { token: string }) {
  const [read, setRead] = useState<PreviewRead | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchPreview(token).then((r) => {
      if (live) setRead(r);
    });
    return () => {
      live = false;
    };
  }, [token]);

  if (read === undefined) {
    return (
      <div className="pay-card">
        <section className="pay-section pay-center">
          <span className="pay-spinner" aria-hidden />
          <p role="status">Loading the preview…</p>
        </section>
      </div>
    );
  }
  if (read === null) {
    return (
      <div className="pay-card">
        <section className="pay-section">
          <h1 className="pay-title">This preview link has expired</h1>
          <p role="alert">Preview links work for 15 minutes. Make a new one from the dashboard.</p>
        </section>
      </div>
    );
  }
  return <PreviewBody read={read} />;
}
