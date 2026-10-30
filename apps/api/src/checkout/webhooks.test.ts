import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Event, Merchant } from '@prisma/client';
import { WEBHOOK_RETRY_WINDOW_MS, WebhookEventTypeValues } from '@tendr/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revokeConnection } from '../connect/connections.js';
import { verifyRequestSignature } from '../gateway/signing.js';
import { clearEventHandlers, handledEventTypes, handlerNamesFor } from '../jobs/handlers.js';
import { newId } from '../lib/ids.js';
import { prisma } from '../lib/prisma.js';
import { sessionRefs } from './session-refs.js';
import { createMerchant, createRow, resetDb } from '../test/helpers.js';
import {
  attemptDelivery,
  createEndpoint,
  deleteEndpoint,
  deliveryKey,
  FANOUT_HANDLER,
  fanOutEvent,
  isPrivateAddress,
  liveConnectionId,
  MAX_REPLACEMENT_HOPS,
  registerWebhookHandlers,
  resendDelivery,
  retryDelayMs,
  ROTATION_OVERLAP_MS,
  rotateEndpointSecret,
  sendTestEvent,
  strictHostPolicy,
  setWebhookQueue,
  setWebhookResolver,
  setWebhookTransport,
  signPayload,
  sweepDueDeliveries,
  validateEndpointUrl,
  webhookData,
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

  it('signs with every overlap secret as extra v1= values', () => {
    const body = '{"id":"evt_2"}';
    const header = signPayload('whsec_new', 1_700_000_000, body, ['whsec_old']);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    for (const s of ['whsec_new', 'whsec_old']) {
      expect(verifyRequestSignature(header, Buffer.from(body), s, 1_700_000_000)).toBe('ok');
    }
    expect(header.split(',')[1]).toBe(signPayload('whsec_new', 1_700_000_000, body).split(',')[1]);
  });

  it('retry delays grow 1 min × 2^n', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([1, 2, 4, 8, 16].map((m) => m * MIN));
  });
});

describe('endpoint URL policy (C24)', () => {
  afterEach(() => {
    setWebhookResolver(null);
    vi.unstubAllEnvs();
  });

  it('strict policy: live always; test mode only in production', () => {
    expect(strictHostPolicy(true)).toBe(true);
    expect(strictHostPolicy(false)).toBe(false); // NODE_ENV=test
    vi.stubEnv('NODE_ENV', 'development');
    expect(strictHostPolicy(false)).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    expect(strictHostPolicy(false)).toBe(true);
  });

  it('production: test-mode endpoints get the private-address block and https-only', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    setWebhookResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    await expect(validateEndpointUrl('https://shop.example/hooks', false)).resolves.toBe(
      'https://shop.example/hooks',
    );
    for (const u of [
      'http://localhost:3000/hooks',
      'http://127.0.0.1:3000/hooks',
      'http://[::1]/hooks',
      'http://shop.example/hooks',
    ]) {
      await expect(validateEndpointUrl(u, false), u).rejects.toThrow(/https/);
    }
    for (const u of ['https://127.0.0.1/hooks', 'https://10.0.0.8/hooks', 'https://[fe80::1]/x']) {
      await expect(validateEndpointUrl(u, false), u).rejects.toThrow(/public/);
    }
    setWebhookResolver(async () => [{ address: '192.168.1.20', family: 4 }]);
    await expect(validateEndpointUrl('https://intranet.example/hooks', false)).rejects.toThrow(
      /public/,
    );
  });

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

  it('T9: blocks IPv4-compatible ::/96 and Teredo 2001::/32', () => {
    for (const ip of [
      '::8.8.8.8',
      '::808:808',
      '::7f00:1',
      '::0:a9fe:a9fe',
      '0:0:0:0:0:0:808:808',
      '2001::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // a Teredo address (embeds an arbitrary IPv4)
      '[2001::5efe:c000:201]',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    // Neighbours stay public: Google DNS (2001:4860::/32), IPv4-mapped public.
    for (const ip of ['2001:4860:4860::8888', '2a00:1450:4001::64', '::ffff:8.8.8.8']) {
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
        payment_link_id: null,
        payer_note: null,
        amount_out: '25.10',
      },
    });
    expect(body.data).not.toHaveProperty('verified_by');
    const header = req.headers['tendr-signature']!;
    const t = Number(/t=(\d+)/.exec(header)![1]);
    expect(verifyRequestSignature(header, Buffer.from(req.body), all.secret, t)).toBe('ok');
    expect(rows[0]!.sessionId).toMatch(/^ses_/);
  });

  it('payment.succeeded webhook carries payment_link_id and payer_note', async () => {
    await createEndpoint(testCtx(), { url: 'https://a.example/hooks' });
    const s = await session();
    const ev = await event('payment.succeeded', {
      payment_id: 'pay_1',
      session_id: s.id,
      ...sessionRefs({ externalRef: null, paymentLinkId: 'plink_1', payerNote: 'for <b>Sam</b>' }),
    });
    await fanOutEvent(ev);
    const d = await prisma.webhookDelivery.findFirstOrThrow();
    await attemptDelivery(d.id);
    expect(parse(sent[0]!).data).toMatchObject({
      external_ref: null,
      payment_link_id: 'plink_1',
      payer_note: 'for <b>Sam</b>',
    });
  });

  it('non-link session events carry both as null', async () => {
    const data = webhookData({ session_id: 'ses_1', external_ref: 'order-1' }, 'payment.late');
    expect(data).toEqual({
      session_id: 'ses_1',
      external_ref: 'order-1',
      payment_link_id: null,
      payer_note: null,
    });
    // Events with no session keep the keys out entirely.
    expect(webhookData({ endpoint_id: 'we_1' }, 'ping')).toEqual({ endpoint_id: 'we_1' });
    expect(sessionRefs({ externalRef: 'o', paymentLinkId: null, payerNote: null })).toEqual({
      external_ref: 'o',
      payment_link_id: null,
      payer_note: null,
    });
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
      payment_link_id: null,
      payer_note: null,
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

  it('production: re-checks test-mode endpoints at send time (http localhost, private DNS)', async () => {
    const local = await createEndpoint(testCtx(), { url: 'http://localhost:4242/hooks' });
    const intranet = await createEndpoint(testCtx(), { url: 'https://intranet.example/hooks' });
    await fanOutEvent(await succeeded(false));
    const rows = await prisma.webhookDelivery.findMany();
    const of = (id: string) => rows.find((r) => r.endpointId === id)!.id;

    vi.stubEnv('NODE_ENV', 'production');
    try {
      const r1 = await attemptDelivery(of(local.endpoint.id));
      expect(r1).toMatchObject({ status: 'failed' });
      expect(r1?.error).toMatch(/https/);
      setWebhookResolver(async () => [{ address: '10.2.3.4', family: 4 }]);
      const r2 = await attemptDelivery(of(intranet.endpoint.id));
      expect(r2?.status).toBe('pending');
      expect(r2?.error).toMatch(/public/);
      expect(sent).toHaveLength(0);
      setWebhookResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
      const r3 = await attemptDelivery(of(intranet.endpoint.id), {
        now: new Date(Date.now() + 2 * MIN),
      });
      expect(r3?.status).toBe('delivered');
      expect(sent[0]!.strict).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rotation: the old secret also signs (second v1=) for 24 h, then only the new one', async () => {
    const ep = await createEndpoint(testCtx(), { url: 'https://a.example/hooks' });
    const t0 = new Date(Date.now() - 3 * DAY);
    const { secret: next } = await rotateEndpointSecret(testCtx(), ep.endpoint.id, t0);
    const verify = (r: WebhookRequest, secret: string) => {
      const header = r.headers['tendr-signature']!;
      const t = Number(/t=(\d+)/.exec(header)![1]);
      return verifyRequestSignature(header, Buffer.from(r.body), secret, t);
    };

    // Within the overlap: both secrets verify.
    await fanOutEvent(await succeeded(), t0);
    const [d1] = await prisma.webhookDelivery.findMany();
    await attemptDelivery(d1!.id, { now: new Date(t0.getTime() + 3600_000) });
    expect(sent[0]!.headers['tendr-signature']!.match(/v1=/g)).toHaveLength(2);
    expect(verify(sent[0]!, next)).toBe('ok');
    expect(verify(sent[0]!, ep.secret)).toBe('ok');

    // After 24 h: the new secret only; the old one no longer verifies.
    await fanOutEvent(await succeeded(), t0);
    const d2 = (await prisma.webhookDelivery.findMany()).find((d) => d.id !== d1!.id)!;
    await attemptDelivery(d2.id, { now: new Date(t0.getTime() + ROTATION_OVERLAP_MS + 1) });
    expect(sent[1]!.headers['tendr-signature']!.match(/v1=/g)).toHaveLength(1);
    expect(verify(sent[1]!, next)).toBe('ok');
    expect(verify(sent[1]!, ep.secret)).toBe('invalid');

    // Rotating again: only the latest old secret overlaps; the first one's row is deleted.
    const firstRef = (await prisma.webhookEndpoint.findFirstOrThrow()).previousSecretRef!;
    const t1 = new Date(t0.getTime() + 2 * DAY);
    const { secret: third } = await rotateEndpointSecret(testCtx(), ep.endpoint.id, t1);
    expect(await prisma.secret.findUnique({ where: { id: firstRef } })).toBeNull();
    await fanOutEvent(await succeeded(), t1);
    const d3 = (await prisma.webhookDelivery.findMany()).find(
      (d) => d.id !== d1!.id && d.id !== d2.id,
    )!;
    await attemptDelivery(d3.id, { now: new Date(t1.getTime() + 60_000) });
    expect(verify(sent[2]!, third)).toBe('ok');
    expect(verify(sent[2]!, next)).toBe('ok');
    expect(verify(sent[2]!, ep.secret)).toBe('invalid');
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

describe('connection-scoped delivery', () => {
  let merchant: Merchant;
  let sent: WebhookRequest[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  const ctx = () => ({ merchantId: merchant.id, livemode: false });

  beforeEach(async () => {
    await resetDb();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    merchant = await createMerchant();
    sent = [];
    setWebhookResolver(async () => [{ address: '93.184.216.34', family: 4 }]);
    setWebhookTransport(async (req) => {
      sent.push(req);
      return { status: 200 };
    });
  });
  afterEach(() => {
    setWebhookTransport(null);
    setWebhookResolver(null);
    clearEventHandlers();
    logSpy.mockRestore();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Two connected sites (A, B), each with its own endpoint, plus a hand-made (unbound) one. */
  async function sites() {
    const a = await createRow('Connection', merchant.id, false, {
      siteUrl: 'https://a.example',
      siteOrigin: 'https://a.example',
    });
    const b = await createRow('Connection', merchant.id, false, {
      siteUrl: 'https://b.example',
      siteOrigin: 'https://b.example',
    });
    const bound = async (url: string, connectionId: string | null) => {
      const { endpoint } = await createEndpoint(ctx(), { url });
      await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { connectionId } });
      return endpoint;
    };
    const epA = await bound('https://a.example/wp-json/tendr/v1/webhook', a.id as string);
    const epB = await bound('https://b.example/wp-json/tendr/v1/webhook', b.id as string);
    const unbound = await bound('https://hand.example/hooks', null);
    return {
      a: a.id as string,
      b: b.id as string,
      epA: epA.id as string,
      epB: epB.id as string,
      unbound: unbound.id as string,
    };
  }

  /** A payment (and its session) created with `connectionId`'s keys (null: a dashboard key). */
  async function paymentOn(connectionId: string | null) {
    const p = await createRow('Payment', merchant.id, false);
    await prisma.session.update({
      where: { id: p.sessionId as string },
      data: { connectionId },
    });
    return { paymentId: p.id as string, sessionId: p.sessionId as string };
  }

  async function event(
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<Event> {
    return (await createRow('Event', merchant.id, false, {
      type,
      aggregateType,
      aggregateId,
      payload,
    })) as unknown as Event;
  }

  const recipients = async (eventId: string) =>
    (await prisma.webhookDelivery.findMany({ where: { eventId } })).map((d) => d.endpointId).sort();

  it("event for connection A's session is delivered to A's endpoint, not B's, and to an unbound endpoint", async () => {
    const s = await sites();
    const { paymentId, sessionId } = await paymentOn(s.a);
    const payload = { payment_id: paymentId, session_id: sessionId };

    const onSession = await event('checkout.session.expired', 'session', sessionId, payload);
    expect(await fanOutEvent(onSession)).toBe(2);
    expect(await recipients(onSession.id)).toEqual([s.epA, s.unbound].sort());

    const onPayment = await event('payment.succeeded', 'payment', paymentId, payload);
    expect(await fanOutEvent(onPayment)).toBe(2);
    expect(await recipients(onPayment.id)).toEqual([s.epA, s.unbound].sort());

    for (const d of await prisma.webhookDelivery.findMany()) await attemptDelivery(d.id);
    expect(sent).toHaveLength(4);
    expect(sent.some((r) => r.url.startsWith('https://b.'))).toBe(false);
  });

  it("an event for a refund on connection A's payment reaches A's endpoint only", async () => {
    const s = await sites();
    const { paymentId, sessionId } = await paymentOn(s.a);
    const refund = await createRow('Refund', merchant.id, false, { paymentId });
    const ev = await event('refund.sent', 'refund', refund.id as string, {
      refund_id: refund.id,
      payment_id: paymentId,
      session_id: sessionId,
    });
    await fanOutEvent(ev);
    const to = await recipients(ev.id);
    expect(to).toContain(s.epA);
    expect(to).not.toContain(s.epB);
  });

  it("the event's connection comes from its subject, never from its payload", async () => {
    const s = await sites();
    const onA = await paymentOn(s.a);
    const onB = await paymentOn(s.b);
    // B's payment, with a payload naming A's session: it goes to B's site.
    const ev = await event('payment.succeeded', 'payment', onB.paymentId, {
      payment_id: onB.paymentId,
      session_id: onA.sessionId,
    });
    await fanOutEvent(ev);
    expect(await recipients(ev.id)).toEqual([s.epB, s.unbound].sort());
  });

  it('a session made with a dashboard key, or an event with no session subject, goes only to unbound endpoints', async () => {
    const s = await sites();
    const dashboard = await paymentOn(null);
    const ev = await event('payment.succeeded', 'payment', dashboard.paymentId, {
      payment_id: dashboard.paymentId,
      session_id: dashboard.sessionId,
    });
    await fanOutEvent(ev);
    expect(await recipients(ev.id)).toEqual([s.unbound]);

    const onA = await paymentOn(s.a);
    const subjectless = await event('payment.succeeded', 'merchant', merchant.id, {
      session_id: onA.sessionId,
    });
    await fanOutEvent(subjectless);
    expect(await recipients(subjectless.id)).toEqual([s.unbound]);
  });

  it('internal ops events still never delivered', async () => {
    const s = await sites();
    const { paymentId, sessionId } = await paymentOn(s.a);
    const refund = await createRow('Refund', merchant.id, false, { paymentId });
    for (const [type, aggregateType, id] of [
      ['refund.needs_review', 'refund', refund.id as string],
      ['account.proposal.cancelled', 'account_proposal', newId('prop')],
      ['account.proposal.failed', 'account_proposal', newId('prop')],
      ['payment.status_changed', 'payment', paymentId],
      ['session.status_changed', 'session', sessionId],
    ] as const) {
      const ev = await event(type, aggregateType, id, { session_id: sessionId });
      expect(await fanOutEvent(ev), type).toBe(0);
    }
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it('the connection filter holds at send time: a revoked endpoint, or a mismatched row, is never sent', async () => {
    const s = await sites();
    const { paymentId, sessionId } = await paymentOn(s.a);
    const ev = await event('payment.succeeded', 'payment', paymentId, {
      payment_id: paymentId,
      session_id: sessionId,
    });
    await fanOutEvent(ev);
    // A re-connect revokes A's old connection (and deactivates its endpoints) before the send.
    await prisma.$transaction((tx) => revokeConnection(tx, s.a, 'site'));
    const toA = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: s.epA } });
    expect((await attemptDelivery(toA.id))?.status).toBe('failed');
    expect(sent.some((r) => r.url.startsWith('https://a.'))).toBe(false);

    // A delivery row that names B's endpoint for A's event (the fan-out never makes one): refused.
    const wrong = await prisma.webhookDelivery.create({
      data: {
        id: newId('whd'),
        ...ctx(),
        endpointId: s.epB,
        eventId: ev.id,
        eventType: ev.type,
        idempotencyKey: deliveryKey(s.epB, ev.id),
        nextRetryAt: new Date(),
      },
    });
    expect(await attemptDelivery(wrong.id)).toMatchObject({
      status: 'failed',
      error: 'connection mismatch',
    });
    expect(sent.some((x) => x.url.startsWith('https://b.'))).toBe(false);
  });

  it("a test send (ping) to a connection's endpoint still goes out", async () => {
    const s = await sites();
    expect((await sendTestEvent(ctx(), s.epA)).status).toBe('delivered');
    expect(sent).toHaveLength(1);
  });

  it('W8: a replaced connection follows replaced_by_id to the live successor; a loop or an over-long chain resolves to nothing', async () => {
    const live = await createRow('Connection', merchant.id, false);
    const mid = await createRow('Connection', merchant.id, false, {
      revokedAt: new Date(),
      replacedById: live.id,
    });
    const old = await createRow('Connection', merchant.id, false, {
      revokedAt: new Date(),
      replacedById: mid.id,
    });
    expect(await liveConnectionId(old.id as string, merchant.id)).toBe(live.id);
    expect(await liveConnectionId(live.id as string, merchant.id)).toBe(live.id);
    // Revoked with no successor (disconnect, dashboard removal, sweep).
    const gone = await createRow('Connection', merchant.id, false, { revokedAt: new Date() });
    expect(await liveConnectionId(gone.id as string, merchant.id)).toBeNull();
    // Another store's connection is never followed into.
    const otherStore = await createMerchant();
    const foreign = await createRow('Connection', otherStore.id, false, {
      revokedAt: new Date(),
    });
    expect(await liveConnectionId(foreign.id as string, merchant.id)).toBeNull();

    // A loop (never written by the re-connect, but guarded): x → y → x.
    const x = await createRow('Connection', merchant.id, false, { revokedAt: new Date() });
    const y = await createRow('Connection', merchant.id, false, {
      revokedAt: new Date(),
      replacedById: x.id,
    });
    await prisma.connection.update({ where: { id: x.id as string }, data: { replacedById: y.id } });
    expect(await liveConnectionId(x.id as string, merchant.id)).toBeNull();

    // A chain of MAX_REPLACEMENT_HOPS re-connects resolves; one more does not.
    let next = (await createRow('Connection', merchant.id, false)).id as string;
    const chain: string[] = [];
    for (let i = 0; i <= MAX_REPLACEMENT_HOPS; i++) {
      next = (
        await createRow('Connection', merchant.id, false, {
          revokedAt: new Date(),
          replacedById: next,
        })
      ).id as string;
      chain.push(next);
    }
    expect(await liveConnectionId(chain[MAX_REPLACEMENT_HOPS - 1]!, merchant.id)).not.toBeNull();
    expect(await liveConnectionId(chain[MAX_REPLACEMENT_HOPS]!, merchant.id)).toBeNull();
  });

  it("W8: a replaced site's session delivers to the successor, other sites stay isolated", async () => {
    const s = await sites();
    const { paymentId } = await paymentOn(s.a);
    // Site A re-connects as A2; site B is untouched.
    const a2 = await createRow('Connection', merchant.id, false, {
      siteUrl: 'https://a.example',
      siteOrigin: 'https://a.example',
    });
    await prisma.$transaction((tx) => revokeConnection(tx, s.a, 'site'));
    await prisma.connection.update({ where: { id: s.a }, data: { replacedById: a2.id } });
    const { endpoint: epA2 } = await createEndpoint(ctx(), { url: 'https://a.example/hooks2' });
    await prisma.webhookEndpoint.update({
      where: { id: epA2.id },
      data: { connectionId: a2.id as string },
    });
    const ev = await event('payment.succeeded', 'payment', paymentId, { payment_id: paymentId });
    await fanOutEvent(ev);
    expect(await recipients(ev.id)).toEqual([epA2.id, s.unbound].sort());
    for (const d of await prisma.webhookDelivery.findMany({ where: { eventId: ev.id } })) {
      expect((await attemptDelivery(d.id))?.status).toBe('delivered');
    }
    expect(sent.some((r) => r.url.startsWith('https://b.'))).toBe(false);
  });
});

describe('per-type payload keys', () => {
  it('`status` is delivered only on refund.cancelled and refund.failed', () => {
    const payload = { refund_id: 'ref_1', status: 'expired', currency: 'x' };
    expect(webhookData(payload, 'refund.cancelled')).toEqual({
      refund_id: 'ref_1',
      status: 'expired',
    });
    expect(webhookData(payload, 'refund.failed')).toHaveProperty('status');
    expect(webhookData(payload, 'refund.sent')).toEqual({ refund_id: 'ref_1' });
    expect(webhookData(payload, 'payment.succeeded')).not.toHaveProperty('status');
    expect(webhookData(payload)).not.toHaveProperty('status');
  });

  it('`network_fee` is delivered on payment.succeeded only', () => {
    const network_fee = {
      paid_by: 'merchant',
      fee_mode: null,
      amount: null,
      asset: null,
      usd: '0.048',
      method: 'eip3009',
      reason: null,
    };
    const payload = { payment_id: 'pay_1', network_fee };
    expect(webhookData(payload, 'payment.succeeded')).toEqual({
      payment_id: 'pay_1',
      network_fee,
    });
    expect(webhookData(payload, 'payment.detected')).toEqual({ payment_id: 'pay_1' });
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
