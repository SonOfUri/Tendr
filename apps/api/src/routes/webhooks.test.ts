import type { Merchant } from '@prisma/client';
import type { MerchantUserRole } from '@tendr/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import {
  fanOutEvent,
  setWebhookResolver,
  setWebhookTransport,
  type WebhookRequest,
} from '../checkout/webhooks.js';
import { verifyRequestSignature } from '../gateway/signing.js';
import { prisma } from '../lib/prisma.js';
import { getSecret } from '../secrets/secrets.js';
import { dashHeaders, loginAs, type Login } from '../test/dashboard.js';
import { createMerchant, createRow, createUser, resetDb } from '../test/helpers.js';

describe('webhook endpoint routes', () => {
  let app: FastifyInstance;
  let merchant: Merchant;
  let admin: Login;
  let sent: WebhookRequest[];
  let status: number;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp();
    await app.ready();
    merchant = await createMerchant();
    admin = await member('admin');
    sent = [];
    status = 200;
    setWebhookResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    setWebhookTransport(async (req) => {
      sent.push(req);
      return { status };
    });
  });
  afterEach(async () => {
    await app.close();
    setWebhookTransport(null);
    setWebhookResolver(null);
    logSpy.mockRestore();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function member(role: MerchantUserRole, opts: { stepUp?: boolean } = {}) {
    const user = await createUser({ emailVerifiedAt: new Date() });
    await createRow('MerchantUser', merchant.id, false, { userId: user.id, role });
    return loginAs(user.id, opts);
  }

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    who: Login,
    payload?: unknown,
    livemode = false,
  ) =>
    app.inject({
      method,
      url,
      headers: dashHeaders(who, { merchantId: merchant.id, livemode }),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const create = (url: string, who = admin, livemode = false, events?: string[]) =>
    call('POST', '/v1/webhooks/endpoints', who, { url, ...(events ? { events } : {}) }, livemode);

  it('shows the signing secret only on create and rotate', async () => {
    const res = await create('https://shop.example/hooks', admin, false, ['payment.succeeded']);
    expect(res.statusCode).toBe(201);
    const { endpoint, secret } = res.json();
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(endpoint).toMatchObject({
      url: 'https://shop.example/hooks',
      events: ['payment.succeeded'],
      livemode: false,
      active: true,
    });
    expect(JSON.stringify(endpoint)).not.toContain(secret);
    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(await getSecret(row.secretRef)).toBe(secret);
    expect(
      (await prisma.secret.findUniqueOrThrow({ where: { id: row.secretRef } })).ciphertext,
    ).not.toContain(secret);

    const list = await call('GET', '/v1/webhooks/endpoints', admin);
    expect(list.statusCode).toBe(200);
    expect(list.json().endpoints).toHaveLength(1);
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toContain('sec_');

    const rotated = await call('POST', `/v1/webhooks/endpoints/${endpoint.id}/rotate`, admin, {});
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json().secret as string;
    expect(next).toMatch(/^whsec_/);
    expect(next).not.toBe(secret);
    const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(await getSecret(after.secretRef)).toBe(next);
    // The old secret overlaps for 24 h (second v1=), so its row is kept until the next rotation.
    expect(after.previousSecretRef).toBe(row.secretRef);
    expect(rotated.json().previous_secret_expires_at).toEqual(
      after.previousSecretExpiresAt!.toISOString(),
    );
    expect(rotated.body).not.toContain(secret);

    const deliveries = await call('GET', `/v1/webhooks/endpoints/${endpoint.id}/deliveries`, admin);
    expect(deliveries.body).not.toContain(next);
  });

  it('create and rotate need step-up; every route needs settings:manage', async () => {
    const noStepUp = await member('admin', { stepUp: false });
    const res = await create('https://shop.example/hooks', noStepUp);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('STEP_UP_REQUIRED');

    const { endpoint } = (await create('https://shop.example/hooks')).json();
    const rot = await call('POST', `/v1/webhooks/endpoints/${endpoint.id}/rotate`, noStepUp, {});
    expect(rot.json().error.code).toBe('STEP_UP_REQUIRED');
    expect((await call('GET', '/v1/webhooks/endpoints', noStepUp)).statusCode).toBe(200);

    const finance = await member('finance');
    for (const [method, url] of [
      ['POST', '/v1/webhooks/endpoints'],
      ['GET', '/v1/webhooks/endpoints'],
      ['DELETE', `/v1/webhooks/endpoints/${endpoint.id}`],
      ['POST', `/v1/webhooks/endpoints/${endpoint.id}/rotate`],
      ['POST', `/v1/webhooks/endpoints/${endpoint.id}/test`],
      ['GET', `/v1/webhooks/endpoints/${endpoint.id}/deliveries`],
      ['POST', `/v1/webhooks/deliveries/whd_x/resend`],
    ] as const) {
      const r = await call(method, url, finance, method === 'POST' ? {} : undefined);
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('rejects an http:// URL in live; allows http://localhost in test only', async () => {
    const live = await create('http://shop.example/hooks', admin, true);
    expect(live.statusCode).toBe(400);
    expect(live.json().error.code).toBe('VALIDATION_ERROR');
    expect((await create('http://localhost:3000/hooks', admin, true)).statusCode).toBe(400);
    expect((await create('https://10.0.0.8/hooks', admin, true)).statusCode).toBe(400);
    const ok = await create('https://shop.example/hooks', admin, true);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().endpoint.livemode).toBe(true);

    expect((await create('http://localhost:3000/hooks')).statusCode).toBe(201);
    expect((await create('http://shop.example/hooks')).statusCode).toBe(400);
    expect(
      (
        await call('POST', '/v1/webhooks/endpoints', admin, {
          url: 'https://x.example',
          events: ['session.created'],
        })
      ).statusCode,
    ).toBe(400);
    expect(await prisma.webhookEndpoint.count()).toBe(2);
  });

  it('endpoints are per mode', async () => {
    await create('https://test.example/hooks');
    await create('https://live.example/hooks', admin, true);
    const test = (await call('GET', '/v1/webhooks/endpoints', admin)).json().endpoints;
    const live = (await call('GET', '/v1/webhooks/endpoints', admin, undefined, true)).json()
      .endpoints;
    expect(test.map((e: { url: string }) => e.url)).toEqual(['https://test.example/hooks']);
    expect(live.map((e: { url: string }) => e.url)).toEqual(['https://live.example/hooks']);
    const del = await call('DELETE', `/v1/webhooks/endpoints/${live[0].id}`, admin);
    expect(del.statusCode).toBe(404); // a live endpoint is invisible from test mode
  });

  it('test send delivers a signed ping; deliveries list and resend', async () => {
    const { endpoint, secret } = (await create('https://shop.example/hooks')).json();
    const ping = await call('POST', `/v1/webhooks/endpoints/${endpoint.id}/test`, admin, {});
    expect(ping.statusCode).toBe(200);
    expect(ping.json().delivery).toMatchObject({ event_type: 'ping', status: 'delivered' });
    const body = JSON.parse(sent[0]!.body);
    expect(body).toMatchObject({
      type: 'ping',
      livemode: false,
      data: { endpoint_id: endpoint.id },
    });
    const header = sent[0]!.headers['tendr-signature']!;
    const t = Number(/t=(\d+)/.exec(header)![1]);
    expect(verifyRequestSignature(header, Buffer.from(sent[0]!.body), secret, t)).toBe('ok');
    // The ping never enters the outbox.
    expect(await prisma.eventOutbox.count()).toBe(0);

    status = 500;
    const failed = await call('POST', `/v1/webhooks/endpoints/${endpoint.id}/test`, admin, {});
    expect(failed.json().delivery).toMatchObject({ status: 'failed', status_code: 500 });

    const list = await call('GET', `/v1/webhooks/endpoints/${endpoint.id}/deliveries`, admin);
    expect(list.json().deliveries).toHaveLength(2);

    status = 200;
    const resend = await call(
      'POST',
      `/v1/webhooks/deliveries/${failed.json().delivery.id}/resend`,
      admin,
      {},
    );
    expect(resend.statusCode).toBe(200);
    expect(resend.json().delivery).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(JSON.parse(sent[2]!.body).id).toBe(JSON.parse(sent[1]!.body).id);
  });

  it('delete stops deliveries; resend of another mode/merchant delivery is 404', async () => {
    const { endpoint } = (await create('https://shop.example/hooks')).json();
    const s = await createRow('Session', merchant.id, false, {});
    const ev = await createRow('Event', merchant.id, false, {
      type: 'checkout.session.expired',
      payload: { session_id: s.id, external_ref: null, reason: 'timeout' },
    });
    await fanOutEvent(ev as never);
    const d = await prisma.webhookDelivery.findFirstOrThrow();

    const other = await createMerchant();
    const foreign = await createRow('WebhookDelivery', other.id, false, {});
    expect(
      (await call('POST', `/v1/webhooks/deliveries/${foreign.id}/resend`, admin, {})).statusCode,
    ).toBe(404);
    expect(
      (await call('POST', `/v1/webhooks/deliveries/${d.id}/resend`, admin, {}, true)).statusCode,
    ).toBe(404);

    expect((await call('DELETE', `/v1/webhooks/endpoints/${endpoint.id}`, admin)).statusCode).toBe(
      200,
    );
    expect((await call('GET', '/v1/webhooks/endpoints', admin)).json().endpoints).toEqual([]);
    expect(
      (await call('POST', `/v1/webhooks/deliveries/${d.id}/resend`, admin, {})).statusCode,
    ).toBe(409);
    expect(sent).toHaveLength(0);
  });
});
