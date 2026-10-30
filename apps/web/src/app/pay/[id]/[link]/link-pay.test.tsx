import type { PublicPaymentLinkView } from '@tendr/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Checkout } from '../components/Checkout';
import PayPage from '../page';
import {
  LinkPayBody,
  applyPayError,
  initialPayState,
  onPageRestored,
  pendingPaymentKey,
  readPendingPayment,
  savePendingPayment,
  type PayState,
} from './LinkPay';
import { tendrShopperTheme } from '@/lib/checkout/brand';

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.7' }),
}));

const SESSION = 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0';

const FIXED: PublicPaymentLinkView = {
  merchant: { name: 'Acme Studio' },
  theme: tendrShopperTheme('Acme Studio'),
  title: 'Logo design',
  description: 'Line one\nLine two https://evil.example',
  amount_type: 'fixed',
  amount: '25000.00',
  currency: 'NGN',
  minor_units: 2,
  min_amount: null,
  usd_rate: '1600',
  note: 'optional',
  fee_payer: 'merchant',
  availability: 'available',
  livemode: true,
};

const OPEN: PublicPaymentLinkView = {
  ...FIXED,
  title: 'Tip jar',
  description: null,
  amount_type: 'open',
  amount: null,
  min_amount: '1600.00',
};

const render = (view: PublicPaymentLinkView, state: PayState = initialPayState(view)) =>
  renderToStaticMarkup(
    <LinkPayBody
      view={view}
      state={state}
      onAmount={() => {}}
      onNote={() => {}}
      onSubmit={() => {}}
    />,
  );

afterEach(() => vi.unstubAllGlobals());

describe('link page', () => {
  it('renders a fixed price with its USD equivalent, the note and the pay button', () => {
    const html = render(FIXED);
    expect(html).toContain('Acme Studio');
    expect(html).toContain('Logo design');
    expect(html).toContain('₦25,000');
    expect(html).not.toContain('₦25,000.00');
    expect(html).toContain('≈ $15.63');
    expect(html).toContain('Note to Acme Studio (optional)');
    expect(html).toMatch(/maxLength="280"|maxlength="280"/);
    expect(html).toContain('Pay with crypto');
    expect(html).not.toContain('Test mode');
    // Plain text: kept as written, never turned into a link.
    expect(html).toContain('Line one\nLine two https://evil.example');
    expect(html).not.toContain('href="https://evil.example');
  });

  it('draws the link on its theme: title in the order summary, payment sealed', () => {
    const theme = {
      ...tendrShopperTheme('Kola Kicks'),
      id: 'thm_link',
      version: 2,
      payee: 'Acme Studio',
      trading_as: 'Kola Kicks',
    };
    const html = render({ ...FIXED, theme });
    expect(html).toMatch(/class="tdr-theme tdr-page"/);
    // The title is the theme's order summary block (a merchant block); the default theme puts
    // the payment block last.
    expect(html).toMatch(/data-type="order_summary"[\s\S]*Logo design/);
    const inSealed = html.split('<section class="tdr-payment"')[1]!.replace(/&#x27;/g, "'");
    expect(inSealed).toContain("You're paying <strong>Acme Studio</strong>");
    expect(inSealed).toContain('· trading as Kola Kicks');
    expect(inSealed).toContain('Pay with crypto');
    expect(inSealed).toContain('Note to Acme Studio (optional)');
    expect(inSealed).not.toContain('Logo design');
  });

  it('renders without usd equivalent', () => {
    expect(render({ ...FIXED, usd_rate: null })).not.toContain('≈');
    expect(render({ ...FIXED, currency: 'USD', amount: '25.00', usd_rate: null })).not.toContain(
      '≈',
    );
  });

  it('formats with the API minor units, never rounding or padding (RSD is 2, Intl says 0)', () => {
    const rsd = { ...FIXED, currency: 'RSD', amount: '100.50', usd_rate: null };
    expect(render(rsd)).toContain('RSD\u00a0100.50');
    const btc = { ...FIXED, currency: 'BTC', amount: '0.00100000', minor_units: 8, usd_rate: null };
    expect(render(btc)).toContain('BTC\u00a00.001');
    expect(render(btc)).not.toContain('0.00100000');
  });

  it('accepts an open RSD amount with decimals and rejects IRT decimals', () => {
    // The live USD line appears only for an amount the page accepts.
    const rsd = { ...OPEN, currency: 'RSD', min_amount: '100.00', usd_rate: '117.5' };
    const ok = render(rsd, { ...initialPayState(rsd), amount: '100.50' });
    expect(ok).toContain('≈ $0.86');
    expect(ok).toContain('inputMode="decimal"');
    const irt = { ...OPEN, currency: 'IRT', minor_units: 0, min_amount: null, usd_rate: '42000' };
    const bad = render(irt, { ...initialPayState(irt), amount: '5.5' });
    expect(bad).not.toContain('≈');
    expect(bad).toContain('inputMode="numeric"');
    expect(render(irt, { ...initialPayState(irt), amount: '42000' })).toContain('≈ $1.00');
  });

  it('renders an amount box and the minimum for an open link', () => {
    const html = render(OPEN);
    expect(html).toContain('name="amount"');
    expect(html).toContain('Minimum ₦1,600');
  });

  it('shows plus-fees line only for shopper-paid links', () => {
    expect(render({ ...FIXED, fee_payer: 'shopper' })).toContain('plus fees, shown before you pay');
    expect(render(FIXED)).not.toContain('plus fees');
  });

  it('hides the note when the link takes none, and shows the test banner in test mode', () => {
    expect(render({ ...FIXED, note: 'off' })).not.toContain('Note to');
    expect(render({ ...FIXED, livemode: false })).toContain('Test mode — no real money moves');
  });

  it('shows each unavailable state with no pay button', () => {
    const cases = [
      ['inactive', "This link isn't taking payments right now"],
      ['archived', "This link isn't taking payments right now"],
      ['used_up', "This link isn't taking payments right now"],
      ['expired', 'This link has expired'],
      ['merchant_not_ready', "This link isn't taking payments yet"],
    ] as const;
    for (const [availability, copy] of cases) {
      const html = render({ ...FIXED, availability });
      expect(html).toContain(copy.replace("'", '&#x27;'));
      expect(html).not.toContain('Pay with crypto');
    }
  });

  it('shows unavailable state after a refused pay', () => {
    const state = applyPayError(initialPayState(FIXED), FIXED, {
      code: 'LINK_UNAVAILABLE',
      message: 'x',
      details: { availability: 'expired' },
    });
    const html = render(FIXED, state);
    expect(html).toContain('This link has expired');
    expect(html).not.toContain('Pay with crypto');
  });

  it('shows the someone-is-paying message on LINK_RESERVED', () => {
    const state = applyPayError(initialPayState(FIXED), FIXED, {
      code: 'LINK_RESERVED',
      message: 'x',
    });
    const html = render(FIXED, state);
    expect(html).toContain('Someone is paying this link right now, try again shortly.');
    expect(html).toMatch(/<button[^>]*type="submit"(?![^>]*disabled)[^>]*>Pay with crypto/);
  });

  it('maps the other refusals to their messages', () => {
    const msg = (view: PublicPaymentLinkView, code: string, details?: unknown) =>
      render(view, applyPayError(initialPayState(view), view, { code, message: 'x', details }));
    expect(msg(FIXED, 'LINK_BUSY')).toContain(
      'Too many people are paying right now. Try again in a minute.',
    );
    expect(msg(FIXED, 'RATE_LIMITED')).toContain(
      'Too many people are paying right now. Try again in a minute.',
    );
    expect(msg(FIXED, 'FX_RATE_UNAVAILABLE')).toContain(
      'Prices can&#x27;t be loaded right now. Try again in a minute.',
    );
    const small = msg(FIXED, 'AMOUNT_TOO_LOW', { min_amount: '1600.00' });
    expect(small).toContain('This amount is too small to pay in crypto right now.');
    expect(small).not.toContain('Pay with crypto');
    const low = msg(OPEN, 'AMOUNT_TOO_LOW', { min_amount: '1700.00' });
    expect(low).toContain('The minimum is ₦1,700.');
    expect(low).toContain('aria-invalid="true"');
    expect(low).toContain('Pay with crypto');
  });
});

/** A Map-backed Storage; `failing` throws on every call, like a blocked one. */
function memoryStorage(failing = false): Storage {
  const m = new Map<string, string>();
  const guard = () => {
    if (failing) throw new Error('SecurityError');
  };
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (guard(), m.get(k) ?? null),
    setItem: (k: string, v: string) => (guard(), void m.set(k, v)),
    removeItem: (k: string) => (guard(), void m.delete(k)),
  };
}

describe('continue a started payment', () => {
  const NOW = Date.parse('2026-10-30T12:00:00Z');
  const entry = {
    url: 'https://usetendr.tech/pay/ses_x#cs=ses_x_secret_y',
    expires_at: '2026-10-30T12:05:00.000Z',
  };

  it('keys the entry by store, link and mode', () => {
    const keys = new Set([
      pendingPaymentKey('acme', 'tip-jar', false),
      pendingPaymentKey('acme', 'tip-jar', true),
      pendingPaymentKey('acme', 'logo', false),
      pendingPaymentKey('other', 'tip-jar', false),
    ]);
    expect(keys.size).toBe(4);
  });

  it('reads back an unexpired entry and drops an expired one', () => {
    const storage = memoryStorage();
    const key = pendingPaymentKey('acme', 'tip-jar', false);
    savePendingPayment(storage, key, entry);
    expect(readPendingPayment(storage, key, NOW)).toEqual(entry);
    expect(readPendingPayment(storage, pendingPaymentKey('acme', 'tip-jar', true), NOW)).toBeNull();
    expect(readPendingPayment(storage, key, Date.parse(entry.expires_at))).toBeNull();
    expect(storage.getItem(key)).toBeNull();
  });

  it('ignores junk and works without storage', () => {
    const storage = memoryStorage();
    storage.setItem('k', '{not json');
    expect(readPendingPayment(storage, 'k', NOW)).toBeNull();
    storage.setItem(
      'k',
      JSON.stringify({ url: 'javascript:alert(1)', expires_at: entry.expires_at }),
    );
    expect(readPendingPayment(storage, 'k', NOW)).toBeNull();
    const blocked = memoryStorage(true);
    expect(() => savePendingPayment(blocked, 'k', entry)).not.toThrow();
    expect(readPendingPayment(blocked, 'k', NOW)).toBeNull();
    expect(() => savePendingPayment(null, 'k', entry)).not.toThrow();
    expect(readPendingPayment(null, 'k', NOW)).toBeNull();
  });

  it('shows "Continue your payment" next to the Pay button', () => {
    const html = renderToStaticMarkup(
      <LinkPayBody
        view={FIXED}
        state={initialPayState(FIXED)}
        continueUrl={entry.url}
        onAmount={() => {}}
        onNote={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(html).toContain('Continue your payment');
    expect(html).toContain(`href="${entry.url}"`);
    expect(html).toContain('Pay with crypto');
    expect(render(FIXED)).not.toContain('Continue your payment');
  });

  it('a page restored from the back/forward cache re-enables Pay', () => {
    const target = new EventTarget();
    const restored = vi.fn();
    const stop = onPageRestored(target, restored);
    target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(restored).not.toHaveBeenCalled();
    target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(restored).toHaveBeenCalledTimes(1);
    stop();
    target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(restored).toHaveBeenCalledTimes(1);
  });
});

describe('pay routes', () => {
  it('/pay/ses_<valid id> still routes to the session page', async () => {
    const el = await PayPage({ params: Promise.resolve({ id: SESSION }) });
    expect(el.type).toBe(Checkout);
    expect(el.props.sessionId).toBe(SESSION);
    await expect(PayPage({ params: Promise.resolve({ id: 'acme' }) })).rejects.toThrow();
  });

  it('a link page never resolves a session id, and 404s an unknown link', async () => {
    const { default: LinkPage } = await import('./page');
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'nope' } }), {
          status: 404,
        }),
    );
    vi.stubGlobal('fetch', fetchFn);
    const page = (id: string, link: string, mode?: string) =>
      LinkPage({
        params: Promise.resolve({ id, link }),
        searchParams: Promise.resolve(mode ? { mode } : {}),
      });
    await expect(page(SESSION, 'tip-jar')).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(page('acme', 'nope', 'test')).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/payment_links\/public\/acme\/nope\?mode=test$/);
    expect(new Headers(init.headers).get('x-tendr-client-ip')).toBe('203.0.113.7');
  });
});
