import { NextResponse } from 'next/server';
import { createCheckoutClient, type Quote } from '@/lib/checkout/api';
import { getDemo, type DemoCheckoutBootstrap, type DemoSlug } from '@/lib/demo';
import { buildDemoAssetOptions } from '@/lib/demo-assets';
import { serverEnv } from '@/lib/env';

type Body = {
  slug?: DemoSlug;
  /** Optional cart total override (e.g. after a demo discount code). */
  amount?: string;
};

function sanitizeAmount(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return fallback;
  return n.toFixed(2);
}

async function bootstrapCheckout(
  apiBaseUrl: string,
  clientSecret: string,
): Promise<DemoCheckoutBootstrap | null> {
  try {
    const client = createCheckoutClient({ baseUrl: apiBaseUrl, secret: clientSecret });
    const [session, tokenRes] = await Promise.all([client.session(), client.tokens()]);
    const firstPayable = buildDemoAssetOptions(tokenRes.tokens).find((o) => o.token)?.token;
    const tokenId = firstPayable?.asset_id ?? '';
    let quote: Quote | null = null;
    if (tokenId) {
      try {
        quote = await client.quote({ origin_asset: tokenId });
      } catch {
        quote = null;
      }
    }
    return { session, tokens: tokenRes.tokens, tokenId, quote };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    const demo = body.slug ? getDemo(body.slug) : undefined;
    if (!demo) {
      return NextResponse.json({ error: { message: 'Unknown demo' } }, { status: 400 });
    }

    const env = serverEnv();
    if (!env.tendrSecretKeyTest) {
      return NextResponse.json(
        {
          error: {
            message:
              'TENDR_SECRET_KEY_TEST is not set. Run `npm run db:seed` and add the printed secret test key to .env',
          },
        },
        { status: 500 },
      );
    }

    const amount = sanitizeAmount(body.amount, demo.amount);
    const externalRef = `demo_${demo.slug}_${Date.now()}`;
    const res = await fetch(`${env.apiBaseUrl}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.tendrSecretKeyTest}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': externalRef,
      },
      body: JSON.stringify({
        amount,
        amount_currency: demo.currency,
        external_ref: externalRef,
        // Stay on the playground canvas — never bounce the top window to a separate page.
        success_url: `${env.webUrl}/demo?status=settled&scenario=${demo.slug}`,
        cancel_url: `${env.webUrl}/demo?status=cancelled&scenario=${demo.slug}`,
        metadata: {
          demo: demo.slug,
          product: demo.productName,
          amount_override: amount !== demo.amount ? amount : undefined,
        },
      }),
    });

    const data = (await res.json()) as {
      id?: string;
      url?: string;
      client_secret?: string;
      error?: { message?: string; code?: string };
    };

    if (!res.ok || !data.url) {
      return NextResponse.json(
        {
          error: {
            message: data.error?.message ?? `API ${res.status}`,
            code: data.error?.code,
          },
        },
        { status: res.status >= 400 ? res.status : 502 },
      );
    }

    const clientSecret = data.client_secret ?? null;
    const bootstrap =
      data.id && clientSecret ? await bootstrapCheckout(env.apiBaseUrl, clientSecret) : null;

    return NextResponse.json({
      sessionId: data.id,
      url: data.url,
      clientSecret,
      bootstrap,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Checkout failed';
    return NextResponse.json({ error: { message } }, { status: 500 });
  }
}
