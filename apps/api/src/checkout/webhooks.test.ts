import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Event, Merchant } from '@prisma/client';
import { WEBHOOK_RETRY_WINDOW_MS, WebhookEventTypeValues } from '@tendr/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyRequestSignature } from '../gateway/signing.js';
import { clearEventHandlers, handledEventTypes, handlerNamesFor } from '../jobs/handlers.js';
import { prisma } from '../lib/prisma.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import {
  attemptDelivery,
  createEndpoint,
  deleteEndpoint,
  FANOUT_HANDLER,
  fanOutEvent,
  isPrivateAddress,
  registerWebhookHandlers,
  resendDelivery,
  retryDelayMs,
  setWebhookQueue,
  setWebhookResolver,
  setWebhookTransport,
  signPayload,
  sweepDueDeliveries,
  validateEndpointUrl,
  type WebhookRequest,
} from './webhooks.js';

const MIN = 60_000;
const DAY = 24 * 3600_000;

describe('signPayload', () => {
  it('produces t=<t>,v1=<hex> that a reference HMAC and the gateway verifier accept', () => {
    const body = '{"id":"evt_1","type":"payment.succeeded"}';
    const header = signPayload('whsec_abc', 1_700_000_000, body);
    const reference = createHmac('sha256', 'whsec_abc').update(`1700000000.${body}`).digest('hex');
    expect(header).toBe(`t=1700000000,v1=${reference}`);
    expect(verifyRequestSignature(header, Buffer.from(body), 'whsec_abc', 1_700_000_000)).toBe(
      'ok',
    );
    expect(verifyRequestSignature(header, Buffer.from(body), 'whsec_other', 1_700_000_000)).toBe(
      'invalid',
    );
  });

  it('retry delays grow 1 min × 2^n', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([1, 2, 4, 8, 16].map((m) => m * MIN));
  });
});

describe('endpoint URL policy (C24)', () => {
  afterEach(() => setWebhookResolver(null));

  it('classifies private, loopback and link-local addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      'not-an-ip',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('live: https only, and the host must resolve to public addresses', async () => {
    setWebhookResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    await expect(validateEndpointUrl('https://shop.example/hooks', true)).resolves.toBe(
      'https://shop.example/hooks',
    );
    await expect(validateEndpointUrl('http://shop.example/hooks', true)).rejects.toThrow(/https/);
    await expect(validateEndpointUrl('http://localhost:3000/hooks', true)).rejects.toThrow(/https/);
    await expect(validateEndpointUrl('https://127.0.0.1/hooks', true)).rejects.toThrow(/public/);
    await expect(validateEndpointUrl('https://[::1]/hooks', true)).rejects.toThrow(/public/);
    setWebhookResolver(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ]);
    await expect(validateEndpointUrl('https://rebind.example/hooks', true)).rejects.toThrow(
      /public/,
    );
    setWebhookResolver(async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(validateEndpointUrl('https://nowhere.example/hooks', true)).rejects.toThrow(
      /resolved/,
    );
    await expect(validateEndpointUrl('https://u:p@shop.example/', true)).rejects.toThrow(
      /credentials/,
    );
    await expect(validateEndpointUrl('ftp://shop.example/', true)).rejects.toThrow(/https/);
  });

  it('test: http://localhost is allowed, other http hosts are not', async () => {
    const resolver = vi.fn(async () => [{ address: '10.0.0.1', family: 4 }]);
    setWebhookResolver(resolver);
    await expect(validateEndpointUrl('http://localhost:4242/hooks', false)).resolves.toBe(
      'http://localhost:4242/hooks',
    );
    await expect(validateEndpointUrl('http://127.0.0.1:4242/x', false)).resolves.toBeTruthy();
    await expect(validateEndpointUrl('http://shop.example/hooks', false)).rejects.toThrow(
      /localhost/,
    );
    await expect(validateEndpointUrl('https://shop.example/hooks', false)).resolves.toBeTruthy();
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('webhook delivery', () => {
  let merchant: Merchant;
  let sent: WebhookRequest[];
  let respond: (req: WebhookRequest) => number | Promise<number>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let refSeq = 0;
  const testCtx = () => ({ merchantId: merchant.id, livemode: false });
  const liveCtx = () => ({ merchantId: merchant.id, livemode: true });

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    merchant = await createMerchant();
    sent = [];
    respond = () => 200;
    setWebhookResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    setWebhookTransport(async (req) => {
      sent.push(req);
      return { status: await respond(req) };
    });
  });
  afterEach(() => {
    setWebhookTransport(null);
    setWebhookResolver(null);
    setWebhookQueue(null);
    clearEventHandlers();
    logSpy.mockRestore();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function session(livemode = false) {
    return createRow('Session', merchant.id, livemode, { externalRef: `order-${++refSeq}` });
  }

  async function event(
    type: string,
    payload: Record<string, unknown>,
    livemode = false,
    createdAt = new Date(),
  ): Promise<Event> {
    return (await createRow('Event', merchant.id, livemode, {
      type,
      payload,
      aggregateType: 'payment',
      createdAt,
    })) as unknown as Event;
  }

  async function succeeded(livemode = false, createdAt?: Date) {
    const s = await session(livemode);
    return event(
      'payment.succeeded',
      {
        payment_id: 'pay_1',
        session_id: s.id,
        external_ref: 'order-77',
        amount_out: '25.10',
        verified_by: 'receipts',
      },
      livemode,
      createdAt,
    );
  }

  const parse = (r: WebhookRequest) =>
    JSON.parse(r.body) as {
      id: string;
      type: string;
      created: number;
      livemode: boolean;
      data: Record<string, unknown>;
    };

  it('fans an event out to the subscribed endpoints of its mode and signs the body', async () => {
    const all = await createEndpoint(testCtx(), { url: 'https://a.example/hooks' });
    const only = await createEndpoint(testCtx(), {
      url: 'https://b.example/hooks',
      events: ['payment.succeeded'],
    });
    const other = await createEndpoint(testCtx(), {
      url: 'https://c.example/hooks',
      events: ['refund.sent'],
    });
    const created = new Date('2026-10-01T00:00:00Z');
    const ev = await succeeded(false, created);
    expect(await fanOutEvent(ev)).toBe(2);
    expect(await fanOutEvent(ev)).toBe(2); // replay: still one row per (endpoint, event)
    const rows = await prisma.webhookDelivery.findMany({ orderBy: { endpointId: 'asc' } });
    expect(rows.map((r) => r.endpointId).sort()).toEqual(
      [all.endpoint.id, only.endpoint.id].sort(),
    );
    expect(rows.every((r) => r.idempotencyKey === `whd_${r.endpointId}_${ev.id}`)).toBe(true);
    expect(rows.some((r) => r.endpointId === other.endpoint.id)).toBe(false);

    for (const r of rows) {
      expect((await attemptDelivery(r.id))?.status).toBe('delivered');
    }
    expect(sent).toHaveLength(2);
    const req = sent.find((r) => r.url === 'https://a.example/hooks')!;
    const body = parse(req);
    expect(body).toEqual({
      id: ev.id,
      type: 'payment.succeeded',
      created: Math.floor(created.getTime() / 1000),
      livemode: false,
      data: {
        payment_id: 'pay_1',
        session_id: rows[0]!.sessionId,
        external_ref: 'order-77',
        amount_out: '25.10',
      },
    });
    expect(body.data).not.toHaveProperty('verified_by');
    const header = req.headers['tendr-signature']!;
    const t = Number(/t=(\d+)/.exec(header)![1]);
    expect(verifyRequestSignature(header, Buffer.from(req.body), all.secret, t)).toBe('ok');
    expect(rows[0]!.sessionId).toMatch(/^ses_/);
  });

  it('never delivers internal ops events (C23 allowlist)', async () => {
    await createEndpoint(testCtx(), { url: 'https://a.example/hooks' });
    for (const type of [
      'payment.verification_blocked',
      'payment.verification_timeout',
      'refund.needs_review',
      'payment.screening_unresolved',
      'session.created',
      'session.status_changed',
      'payment.status_changed',
      'merchant_account.activated',
      'ping',
    ]) {
      expect(await fanOutEvent(await event(type, { session_id: null })), type).toBe(0);
    }
    expect(await prisma.webhookDelivery.count()).toBe(0);

    clearEventHandlers();
    registerWebhookHandlers();
    registerWebhookHandlers(); // idempotent
    expect(handledEventTypes().sort()).toEqual([...WebhookEventTypeValues].sort());
    for (const t of WebhookEventTypeValues) expect(handlerNamesFor(t)).toEqual([FANOUT_HANDLER]);
    expect(handlerNamesFor('refund.needs_review')).toEqual([]);
  });

  it('strips sender and screening internals from data', async () => {
    await createEndpoint(testCtx(), { url: 'https://a.example/hooks' });
    const s = await session();
    const ev = await event('payment.held', {
      payment_id: 'pay_9',
      session_id: s.id,
      external_ref: 'order-77',
      held_reason: 'sanctions',
      sender_address: '0xbad',
      blocked_destination: '0xbad2',
      notify: 'all_signers',
      notice: 'Tendr cannot freeze them',
    });
    await fanOutEvent(ev);
    const d = await prisma.webhookDelivery.findFirstOrThrow();
    await attemptDelivery(d.id);
    expect(parse(sent[0]!).data).toEqual({
      payment_id: 'pay_9',
      session_id: s.id,
      external_ref: 'order-77',
      held_reason: 'sanctions',
      notice: 'Tendr cannot freeze them',
    });
  });

  it('never sends a test-mode event to a live endpoint, or a live event to a test one', async () => {
    const live = await createEndpoint(liveCtx(), { url: 'https://live.example/hooks' });
    const test = await createEndpoint(testCtx(), { url: 'https://test.example/hooks' });
    await fanOutEvent(await succeeded(false));
    let rows = await prisma.webhookDelivery.findMany();
    expect(rows.map((r) => [r.endpointId, r.livemode])).toEqual([[test.endpoint.id, false]]);
    for (const r of rows) await attemptDelivery(r.id);
    expect(sent.map((r) => r.url)).toEqual(['https://test.example/hooks']);
    expect(parse(sent[0]!).livemode).toBe(false);

    await fanOutEvent(await succeeded(true));
    rows = await prisma.webhookDelivery.findMany({ where: { livemode: true } });
    expect(rows.map((r) => r.endpointId)).toEqual([live.endpoint.id]);

    // The composite FKs refuse a cross-mode delivery row outright.
    const testEvent = await succeeded(false);
    await expect(
      prisma.webhookDelivery.create({
        data: {
          id: 'whd_cross',
          merchantId: merchant.id,
          livemode: true,
          endpointId: live.endpoint.id,
          eventId: testEvent.id,
          eventType: testEvent.type,
          idempotencyKey: 'cross',
        },
      }),
    ).rejects.toThrow();
  });

  it('retries a 5xx with growing delays, then gives up 3 days after the first attempt', async () => {
    await createEndpoint(testCtx(), { url: 'https://down.example/hooks' });
    respond = () => 503;
    const t0 = new Date(Date.now() - 4 * DAY);
    await fanOutEvent(await succeeded(), t0);
    const { id } = await prisma.webhookDelivery.findFirstOrThrow();

    let now = t0;
    const delays: number[] = [];
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await attemptDelivery(id, { now });
      expect(r).not.toBeNull();
      times.push(now.getTime());
      if (r!.status !== 'pending') {
        expect(r!.status).toBe('failed');
        break;
      }
      expect(r!.statusCode).toBe(503);
      // Not due before its time.
      expect(await attemptDelivery(id, { now: new Date(r!.nextRetryAt!.getTime() - 1) })).toBe(
        null,
      );
      delays.push(r!.nextRetryAt!.getTime() - now.getTime());
      now = r!.nextRetryAt!;
    }
    expect(delays.slice(0, 6)).toEqual([1, 2, 4, 8, 16, 32].map((m) => m * MIN));
    for (let i = 1; i < delays.length - 1; i++) expect(delays[i]).toBe(2 * delays[i - 1]!);
    // The last try lands exactly at the 3-day mark, and the row gives up there.
    expect(times.at(-1)! - t0.getTime()).toBe(WEBHOOK_RETRY_WINDOW_MS);
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('failed');
    expect(row.nextRetryAt).toBeNull();
    expect(row.attempt).toBe(times.length);
    expect(row.statusCode).toBe(503);
    expect(row.firstAttemptAt).toEqual(t0);
    // Gave up: no more automatic sends.
    expect(await attemptDelivery(id, { now: new Date(now.getTime() + DAY) })).toBeNull();
    expect(await sweepDueDeliveries(new Date(now.getTime() + DAY))).toBe(0);
  });

  it('endpoint down for hours then back: same event id each time, resend works after give-up (Review Focus 5)', async () => {
    const { secret } = await createEndpoint(testCtx(), { url: 'https://flaky.example/hooks' });
    const t0 = new Date(Date.now() - 4 * DAY);
    const ev = await succeeded(false, t0);
    await fanOutEvent(ev, t0);
    const { id } = await prisma.webhookDelivery.findFirstOrThrow();

    // Down the whole window: network errors and 500s.
    let n = 0;
    respond = () => {
      n++;
      if (n % 2) throw new Error('ECONNREFUSED');
      return 500;
    };
    let now = t0;
    for (;;) {
      const r = await attemptDelivery(id, { now });
      if (r!.status === 'failed') break;
      now = r!.nextRetryAt!;
    }
    const failedRow = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(failedRow.status).toBe('failed');

    // Back up: a manual resend after give-up delivers.
    respond = () => 200;
    const view = await resendDelivery(testCtx(), id);
    expect(view.status).toBe('delivered');
    expect(view.status_code).toBe(200);
    expect(view.attempts).toBe(failedRow.attempt + 1);

    // Every request carried the same event id and body, each validly signed with the same scheme.
    const bodies = new Set(sent.map((r) => r.body));
    expect(bodies.size).toBe(1);
    expect(sent.length).toBeGreaterThan(10);
    for (const r of sent) {
      expect(parse(r).id).toBe(ev.id);
      expect(r.headers['tendr-event-id']).toBe(ev.id);
      const header = r.headers['tendr-signature']!;
      expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      const t = Number(/t=(\d+)/.exec(header)![1]);
      expect(verifyRequestSignature(header, Buffer.from(r.body), secret, t)).toBe('ok');
    }
    // Still exactly one delivery row for (endpoint, event).
    expect(await prisma.webhookDelivery.count()).toBe(1);
  });

  it('queues the first send and each retry on the webhooks queue', async () => {
    const add = vi.fn(async () => ({}));
    setWebhookQueue({ add } as never);
    await createEndpoint(testCtx(), { url: 'https://a.example/hooks' });
    const t0 = new Date();
    await fanOutEvent(await succeeded(), t0);
    const { id } = await prisma.webhookDelivery.findFirstOrThrow();
    expect(add).toHaveBeenCalledWith(
      'deliver-webhook',
      { deliveryId: id },
      expect.objectContaining({ delay: 0, jobId: `whd__${id}__${t0.getTime()}` }),
    );
    respond = () => 502;
    await attemptDelivery(id, { now: t0 });
    expect(add).toHaveBeenLastCalledWith(
      'deliver-webhook',
      { deliveryId: id },
      expect.objectContaining({ delay: MIN }),
    );
    expect(await sweepDueDeliveries(new Date(t0.getTime() + MIN))).toBe(1);
  });

  it('a deleted endpoint receives nothing more; resend of its deliveries is refused', async () => {
    const ep = await createEndpoint(testCtx(), { url: 'https://a.example/hooks' });
    await fanOutEvent(await succeeded());
    const { id } = await prisma.webhookDelivery.findFirstOrThrow();
    await deleteEndpoint(testCtx(), ep.endpoint.id);
    const r = await attemptDelivery(id);
    expect(r?.status).toBe('failed');
    expect(sent).toHaveLength(0);
    expect(await fanOutEvent(await succeeded())).toBe(0);
    await expect(resendDelivery(testCtx(), id)).rejects.toMatchObject({ status: 409 });
  });

  it('live: re-checks the host at send time and refuses one now resolving privately', async () => {
    await createEndpoint(liveCtx(), { url: 'https://shop.example/hooks' });
    await fanOutEvent(await succeeded(true));
    const { id } = await prisma.webhookDelivery.findFirstOrThrow();
    setWebhookResolver(async () => [{ address: '169.254.169.254', family: 4 }]);
    const r = await attemptDelivery(id);
    expect(r?.status).toBe('pending');
    expect(r?.error).toMatch(/public/);
    expect(sent).toHaveLength(0);
  });

  it('two concurrent sends of one delivery: only one goes out', async () => {
    await createEndpoint(testCtx(), { url: 'https://a.example/hooks' });
    await fanOutEvent(await succeeded());
    const { id } = await prisma.webhookDelivery.findFirstOrThrow();
    const results = await Promise.all([attemptDelivery(id), attemptDelivery(id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});

describe('the real HTTP transport', () => {
  let server: Server;
  let url: string;
  let hits: { headers: Record<string, unknown>; body: string; path: string }[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    hits = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        hits.push({ headers: req.headers, body, path: req.url ?? '' });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: '/ok' }).end();
        } else {
          res.writeHead(204).end();
        }
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    logSpy.mockRestore();
  });

  it('POSTs the signed JSON body and never follows redirects (test mode, localhost)', async () => {
    const merchant = await createMerchant();
    const ctx = { merchantId: merchant.id, livemode: false };
    const ok = await createEndpoint(ctx, { url: `${url}/ok` });
    const redirect = await createEndpoint(ctx, { url: `${url}/redirect` });
    const s = await createRow('Session', merchant.id, false, {});
    const ev = await createRow('Event', merchant.id, false, {
      type: 'checkout.session.expired',
      payload: { session_id: s.id, external_ref: null, reason: 'timeout' },
    });
    await fanOutEvent(ev as unknown as Event);
    const rows = await prisma.webhookDelivery.findMany();
    const byEndpoint = (id: string) => rows.find((r) => r.endpointId === id)!.id;
    expect((await attemptDelivery(byEndpoint(ok.endpoint.id)))?.status).toBe('delivered');
    const r = await attemptDelivery(byEndpoint(redirect.endpoint.id));
    expect(r?.status).toBe('pending');
    expect(r?.statusCode).toBe(302);
    expect(hits.map((h) => h.path)).toEqual(['/ok', '/redirect']);
    const hit = hits[0]!;
    expect(hit.headers['content-type']).toBe('application/json');
    const header = hit.headers['tendr-signature'] as string;
    const t = Number(/t=(\d+)/.exec(header)![1]);
    expect(verifyRequestSignature(header, Buffer.from(hit.body), ok.secret, t)).toBe('ok');
    expect(JSON.parse(hit.body)).toMatchObject({
      id: ev.id,
      type: 'checkout.session.expired',
      data: { session_id: s.id, external_ref: null, reason: 'timeout' },
    });
  });
});
