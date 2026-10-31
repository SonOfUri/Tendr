// The live-mode switch at the gateway: while LIVE_MODE_ENABLED is off, every principal in live
// mode can read but not write. Test mode is never affected.
import { randomBytes } from 'node:crypto';
import type { Merchant } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { sha256 } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { dashHeaders, loginAs } from '../test/dashboard.js';
import {
  createApiKey,
  createCredential,
  createMerchant,
  createRow,
  createUser,
  minimalSession,
  resetDb,
  setLiveMode,
} from '../test/helpers.js';
import { flushLastUsed } from './auth.js';

/** Throwaway write routes for the principal kinds no product route covers on its own. */
function testRoutes(app: FastifyInstance) {
  app.post(
    '/v1/test/pk-write',
    { config: { auth: { principals: ['publishable_key'] } } },
    async () => ({ ok: true }),
  );
  app.post(
    '/v1/test/client-write',
    { config: { auth: { principals: ['session_client'] } } },
    async () => ({ ok: true }),
  );
  app.get(
    '/v1/test/client-read',
    { config: { auth: { principals: ['session_client'] } } },
    async () => ({ ok: true }),
  );
}

const bearer = (raw: string) => ({ authorization: `Bearer ${raw}` });
const sessionBody = {
  amount: '10.00',
  amount_currency: 'USD',
  external_ref: 'order-1',
  success_url: 'https://shop.example.com/thanks',
  cancel_url: 'https://shop.example.com/cart',
};

describe('live-mode switch at the gateway', () => {
  let app: FastifyInstance;
  let m: Merchant;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    setLiveMode(undefined);
    m = await createMerchant();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await buildApp({ extraRoutes: testRoutes });
    await app.ready();
  });
  afterEach(async () => {
    await flushLastUsed();
    await app.close();
    logSpy.mockRestore();
    setLiveMode(undefined);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const expectLiveModeUnavailable = (res: { statusCode: number; body: string }) => {
    expect(res.statusCode, res.body).toBe(403);
    expect(JSON.parse(res.body).error).toMatchObject({
      code: 'LIVE_MODE_UNAVAILABLE',
      message: 'Live payments are not open yet. Test mode works as usual.',
    });
  };

  async function liveSessionSecret() {
    const id = newId('ses');
    const raw = `${id}_secret_${randomBytes(16).toString('hex')}`;
    await prisma.session.create({
      data: minimalSession({ id, merchantId: m.id, livemode: true, clientSecretHash: sha256(raw) }),
    });
    return raw;
  }

  it('a live secret key cannot create a checkout session; it can still read', async () => {
    const { raw } = await createApiKey(m.id, { livemode: true });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: bearer(raw),
      payload: sessionBody,
    });
    expectLiveModeUnavailable(res);
    expect(await prisma.session.count()).toBe(0);

    const read = await app.inject({ url: '/v1/themes', headers: bearer(raw) });
    expect(read.statusCode, read.body).toBe(200);
    const ping = await app.inject({ url: '/v1/ping', headers: bearer(raw) });
    expect(ping.statusCode).toBe(200);
  });

  it('a test secret key creates sessions as usual', async () => {
    const { raw } = await createApiKey(m.id, { livemode: false });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: bearer(raw),
      payload: sessionBody,
    });
    expect(res.json().error?.code).not.toBe('LIVE_MODE_UNAVAILABLE');
  });

  it('a live publishable key and a live session client secret cannot write; reads still work', async () => {
    const pk = await createApiKey(m.id, { livemode: true, kind: 'publishable' });
    expectLiveModeUnavailable(
      await app.inject({ method: 'POST', url: '/v1/test/pk-write', headers: bearer(pk.raw) }),
    );
    const client = await liveSessionSecret();
    expectLiveModeUnavailable(
      await app.inject({ method: 'POST', url: '/v1/test/client-write', headers: bearer(client) }),
    );
    const read = await app.inject({ url: '/v1/test/client-read', headers: bearer(client) });
    expect(read.statusCode, read.body).toBe(200);
  });

  it('a dashboard session in live mode cannot write; GET is allowed; test mode writes', async () => {
    const user = await createUser({ emailVerifiedAt: new Date() });
    await createCredential(user.id);
    await createRow('MerchantUser', m.id, false, {
      userId: user.id,
      role: 'owner',
      isSigner: true,
    });
    const login = await loginAs(user.id);
    const theme = { name: 'Live', document: {} };

    const liveWrite = await app.inject({
      method: 'POST',
      url: '/v1/themes/validate',
      headers: dashHeaders(login, { merchantId: m.id, livemode: true }),
      payload: theme,
    });
    expectLiveModeUnavailable(liveWrite);

    const liveRead = await app.inject({
      url: '/v1/payments',
      headers: dashHeaders(login, { merchantId: m.id, livemode: true }),
    });
    expect(liveRead.statusCode, liveRead.body).toBe(200);

    const testWrite = await app.inject({
      method: 'POST',
      url: '/v1/themes/validate',
      headers: dashHeaders(login, { merchantId: m.id, livemode: false }),
      payload: theme,
    });
    expect(testWrite.json().error?.code).not.toBe('LIVE_MODE_UNAVAILABLE');
  });

  it('credentials are checked first: a bad live key is still 401, a missing scope still 403 FORBIDDEN', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: bearer(`tdr_live_${randomBytes(24).toString('hex')}`),
      payload: sessionBody,
    });
    expect(bad.statusCode).toBe(401);
    const { raw } = await createApiKey(m.id, { livemode: true, scopes: [] });
    const noScope = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: bearer(raw),
      payload: sessionBody,
    });
    expect(noScope.statusCode).toBe(403);
    expect(noScope.json().error.code).toBe('FORBIDDEN');
  });

  it('with LIVE_MODE_ENABLED=true, live writes pass the gateway as before', async () => {
    setLiveMode(true);
    const { raw } = await createApiKey(m.id, { livemode: true });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/sessions',
      headers: bearer(raw),
      payload: sessionBody,
    });
    // No live account in this store: the session route answers, not the switch.
    expect(res.json().error?.code).not.toBe('LIVE_MODE_UNAVAILABLE');
    const pk = await createApiKey(m.id, { livemode: true, kind: 'publishable' });
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/test/pk-write',
      headers: bearer(pk.raw),
    });
    expect(ok.statusCode).toBe(200);
  });
});
