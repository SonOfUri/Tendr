import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { prisma } from './lib/prisma.js';

function sha256(input: string) {
  return createHash('sha256').update(input).digest('hex');
}

describe('checkout API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let apiKey = '';
  let merchantId = '';

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/tendr';
    process.env.WEBHOOK_SIGNING_SECRET ??= 'test-webhook-signing-secret';
    process.env.PAYMENT_PROVIDER ??= 'sandbox';
    process.env.CHECKOUT_LIVE_ENABLED ??= 'false';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.LOG_LEVEL ??= 'error';
    loadEnv(process.env);

    app = await buildApp();
    await app.ready();

    const merchant = await prisma.merchant.create({
      data: {
        name: 'Test Merchant',
        slug: `test-${randomBytes(4).toString('hex')}`,
      },
    });
    merchantId = merchant.id;
    apiKey = `tdr_test_${randomBytes(16).toString('hex')}`;
    await prisma.apiKey.create({
      data: {
        merchantId,
        name: 'test',
        keyPrefix: apiKey.slice(0, 12),
        keyHash: sha256(apiKey),
      },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!merchantId) {
      await prisma.$disconnect();
      return;
    }
    await prisma.payment.deleteMany({ where: { merchantId } });
    await prisma.quote.deleteMany({
      where: { session: { merchantId } },
    });
    await prisma.checkoutSession.deleteMany({ where: { merchantId } });
    await prisma.idempotencyKey.deleteMany({ where: { merchantId } });
    await prisma.auditEvent.deleteMany({ where: { merchantId } });
    await prisma.apiKey.deleteMany({ where: { merchantId } });
    await prisma.merchant.delete({ where: { id: merchantId } });
    await prisma.$disconnect();
  });

  it('creates, quotes, confirms a sandbox session', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'idem-1',
      },
      payload: {
        merchantReference: `order_${randomBytes(4).toString('hex')}`,
        amount: '49.99',
        currency: 'USD',
        description: 'Test purchase',
        successUrl: 'http://localhost:3000/success',
        cancelUrl: 'http://localhost:3000/cancel',
        mode: 'sandbox',
      },
    });
    expect(create.statusCode).toBe(201);
    const session = create.json();
    expect(session.status).toBe('CREATED');

    const again = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': 'idem-1',
      },
      payload: {
        merchantReference: session.merchantReference,
        amount: '49.99',
        currency: 'USD',
        description: 'Test purchase',
        successUrl: 'http://localhost:3000/success',
        cancelUrl: 'http://localhost:3000/cancel',
        mode: 'sandbox',
      },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(session.id);

    const quoteRes = await app.inject({
      method: 'POST',
      url: `/v1/checkout/sessions/${session.id}/quote`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { sourceAsset: 'USDC', sourceNetwork: 'near' },
    });
    expect(quoteRes.statusCode).toBe(200);
    const quote = quoteRes.json();

    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/checkout/sessions/${session.id}/confirm`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { quoteId: quote.id },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().payment.status).toBe('SETTLED');
    expect(confirm.json().session.status).toBe('SETTLED');
  });

  it('rejects invalid amount', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        merchantReference: 'bad',
        amount: 'not-a-number',
        currency: 'USD',
        successUrl: 'http://localhost:3000/ok',
        cancelUrl: 'http://localhost:3000/cancel',
        mode: 'sandbox',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.requestId).toBeTruthy();
  });
});
