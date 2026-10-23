import { NextResponse } from 'next/server';
import { getServerTendrClient } from '@/lib/tendr-server';
import { serverEnv } from '@/lib/env';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      merchantReference: string;
      amount: string;
      currency: string;
      description?: string;
    };
    const client = getServerTendrClient();
    const webUrl = serverEnv().webUrl;
    const session = await client.createCheckoutSession(
      {
        merchantReference: body.merchantReference,
        amount: body.amount,
        currency: body.currency,
        description: body.description,
        successUrl: `${webUrl}/checkout/success`,
        cancelUrl: `${webUrl}/checkout/cancel`,
        mode: 'sandbox',
        metadata: { demo: 'true' },
      },
      { idempotencyKey: body.merchantReference },
    );
    const quote = await client.createQuote(session.id, {
      sourceAsset: 'USDC',
      sourceNetwork: 'near',
    });
    return NextResponse.json({ session, quote });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Checkout failed';
    return NextResponse.json({ error: { message } }, { status: 500 });
  }
}
