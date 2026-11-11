import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signWebhookPayload } from '@usetendr/sdk/webhook';
import { loadConfig } from '../server/config.mjs';
import { Store } from '../server/store.mjs';
import { Engine, equalAmount, operationKey } from '../server/engine.mjs';
import { simulatedProviders } from '../server/simulator.mjs';

const cleanup = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  vi.restoreAllMocks();
});
export function setup(path = ':memory:', key = randomBytes(32)) {
  const config = loadConfig({
    SHOPIFY_SIMULATOR: 'true',
    SHOPIFY_APP_URL: 'http://localhost:3355',
    SHOPIFY_STORAGE_KEY: key.toString('hex'),
  });
  const store = new Store(path, key);
  const providers = simulatedProviders(config, store);
  const engine = new Engine(config, store, providers);
  return { config, store, providers, engine };
}
const payment = (overrides = {}) => ({
  id: 'pay-1',
  gid: 'gid://shopify/PaymentSession/pay-1',
  test: true,
  amount: '12.34',
  currency: 'USD',
  kind: 'sale',
  payment_method: { type: 'offsite' },
  ...overrides,
});
const refund = (overrides = {}) => ({
  id: 'ref-1',
  gid: 'gid://shopify/RefundSession/ref-1',
  payment_id: 'pay-1',
  test: true,
  amount: '2.34',
  currency: 'USD',
  ...overrides,
});
function fixture() {
  const f = setup();
  cleanup.push(() => f.store.close());
  return f;
}
const operation = (f, kind = 'payment', id = kind === 'payment' ? 'pay-1' : 'ref-1') =>
  f.store.operation(operationKey(f.config.shop, true, kind, id));
async function settle(f) {
  await f.engine.accept('payment', payment());
  await f.providers.transition(f.engine, operation(f), 'pay');
}

describe('Shopify durable payment flow', () => {
  it('creates once, returns a stable redirect, and refuses changed amounts', async () => {
    const f = fixture();
    const create = vi.spyOn(f.providers, 'create');
    const result = await f.engine.accept('payment', payment());
    expect(await f.engine.accept('payment', payment())).toEqual(result);
    await expect(f.engine.accept('payment', payment({ amount: '99.00' }))).rejects.toMatchObject({
      status: 409,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(operation(f).done).toBeUndefined();
  });
  it('serializes concurrent delivery and never creates a second checkout', async () => {
    const f = fixture();
    const original = f.providers.create;
    let release;
    const wait = new Promise((r) => {
      release = r;
    });
    const create = vi.spyOn(f.providers, 'create').mockImplementation(async (op) => {
      await wait;
      return original(op);
    });
    const first = f.engine.accept('payment', payment());
    await expect(f.engine.accept('payment', payment())).rejects.toMatchObject({ status: 503 });
    release();
    await first;
    await f.engine.accept('payment', payment());
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('replays the exact create after a lost response', async () => {
    const f = fixture();
    const original = f.providers.create;
    const create = vi
      .spyOn(f.providers, 'create')
      .mockImplementationOnce(async (op) => {
        await original(op);
        throw new Error('timeout');
      })
      .mockImplementation(original);
    await expect(f.engine.accept('payment', payment())).rejects.toMatchObject({ status: 503 });
    const first = operation(f);
    await f.engine.accept('payment', payment());
    expect(create.mock.calls[0][0].request).toEqual(create.mock.calls[1][0].request);
    expect(operation(f).tendrId).toBe(f.store.get(`fixture-key:${first.key}`).id);
  });
  it('stops uncertain creation before the backend idempotency record expires', async () => {
    const f = fixture();
    const create = vi.spyOn(f.providers, 'create').mockRejectedValue(new Error('timeout'));
    await expect(f.engine.accept('payment', payment())).rejects.toMatchObject({ status: 503 });
    const op = operation(f);
    op.firstAttempt = Date.now() - 21 * 3600_000;
    f.store.save(op);
    await expect(f.engine.accept('payment', payment())).rejects.toMatchObject({
      code: 'manual_reconciliation_required',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('stops unknown creates after key rotation, because idempotency is credential scoped', async () => {
    const f = fixture();
    const create = vi.spyOn(f.providers, 'create').mockRejectedValue(new Error('timeout'));
    await expect(f.engine.accept('payment', payment())).rejects.toMatchObject({ status: 503 });
    f.config.modes.test.key = 'changed';
    await expect(f.engine.accept('payment', payment())).rejects.toMatchObject({
      code: 'manual_reconciliation_required',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it.each(['PROCESSING', 'HELD', 'SCREENING_PENDING', 'LATE_DEPOSIT'])(
    'does not resolve %s or trust a success event alone',
    async (status) => {
      const f = fixture();
      await f.engine.accept('payment', payment());
      const op = operation(f);
      const session = f.store.get(`fixture:${op.tendrId}`);
      session.status = status;
      f.store.set(`fixture:${op.tendrId}`, session);
      const payload = JSON.stringify({
        id: 'evt',
        type: 'payment.succeeded',
        livemode: false,
        data: { session_id: op.tendrId },
      });
      await f.engine.webhook(
        'test',
        Buffer.from(payload),
        signWebhookPayload({ payload, secret: f.config.modes.test.webhook }).header,
      );
      await f.engine.tick();
      expect(operation(f).decision).toBeUndefined();
    },
  );
  it.each(['livemode', 'external_ref', 'amount', 'amount_currency', 'id'])(
    'refuses mismatched authoritative session %s',
    async (field) => {
      const f = fixture();
      await f.engine.accept('payment', payment());
      const op = operation(f);
      const read = f.providers.read;
      vi.spyOn(f.providers, 'read').mockImplementation(async (value) => ({
        ...(await read(value)),
        [field]: field === 'livemode' ? true : 'WRONG',
      }));
      await f.providers.transition(f.engine, op, 'pay');
      expect(operation(f).done).toBeUndefined();
    },
  );
  it('corroborates original currency when Tendr converted a non-USD checkout', async () => {
    const f = fixture();
    await f.engine.accept('payment', payment({ currency: 'CAD' }));
    const op = operation(f);
    const session = f.store.get(`fixture:${op.tendrId}`);
    session.original_amount = '12.34';
    session.original_currency = 'CAD';
    session.amount = '9.00';
    session.amount_currency = 'USD';
    f.store.set(`fixture:${op.tendrId}`, session);
    await f.providers.transition(f.engine, op, 'pay');
    expect(operation(f).done).toBe(true);
  });
  it('retries Shopify failures and preserves its terminal decision', async () => {
    const f = fixture();
    await f.engine.accept('payment', payment());
    const original = f.providers.finish;
    const finish = vi
      .spyOn(f.providers, 'finish')
      .mockRejectedValueOnce(new Error('userErrors'))
      .mockImplementation(original);
    await f.providers.transition(f.engine, operation(f), 'pay');
    expect(operation(f)).toMatchObject({ decision: 'resolve' });
    expect(operation(f).done).toBeUndefined();
    await f.engine.sync(operation(f).key);
    expect(operation(f)).toMatchObject({ decision: 'resolve', done: true });
    expect(finish).toHaveBeenCalledTimes(2);
  });
  it('recovers an unwitnessed Shopify success on restart, keeping data encrypted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tendr-shopify-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'store.db');
    const key = randomBytes(32);
    const f = setup(path, key);
    await settle(f);
    const old = operation(f);
    old.done = false;
    old.retryAt = 0;
    f.store.save(old);
    f.store.set('oauth', { accessToken: 'do-not-write-this-token-in-plaintext' });
    f.store.close();
    expect(readFileSync(path).includes(Buffer.from('do-not-write-this-token-in-plaintext'))).toBe(
      false,
    );
    expect(readFileSync(path).includes(Buffer.from(old.token))).toBe(false);
    const restarted = setup(path, key);
    cleanup.push(() => restarted.store.close());
    await restarted.engine.tick();
    expect(operation(restarted)).toMatchObject({ done: true, tendrId: old.tendrId });
  });
  it('rejects empty expired sessions but waits if any payment was detected', async () => {
    const f = fixture();
    await f.engine.accept('payment', payment());
    const op = operation(f);
    const session = f.store.get(`fixture:${op.tendrId}`);
    session.status = 'EXPIRED';
    session.payments = [{ status: 'PROCESSING' }];
    f.store.set(`fixture:${op.tendrId}`, session);
    await f.engine.sync(op.key);
    expect(operation(f).decision).toBeUndefined();
    session.payments = [];
    f.store.set(`fixture:${op.tendrId}`, session);
    await f.engine.sync(op.key);
    expect(operation(f)).toMatchObject({ done: true, decision: 'reject' });
  });
  it('refuses live, authorization, invalid amounts and mismatched GIDs', async () => {
    const f = fixture();
    for (const overrides of [
      { test: false },
      { kind: 'authorization' },
      { amount: '0' },
      { amount: '1e4' },
      { gid: 'gid://shopify/PaymentSession/another' },
    ])
      await expect(f.engine.accept('payment', payment(overrides))).rejects.toBeDefined();
    expect(f.store.list()).toHaveLength(0);
  });
  it('rejects malformed amounts as validation errors rather than throwing during parsing', async () => {
    const f = fixture();
    for (const amount of ['NaN', '1e4', '-1', '', '1.2.3'])
      await expect(f.engine.accept('payment', payment({ amount }))).rejects.toMatchObject({
        status: 422,
      });
  });
  it('will not reuse an existing database for a different store or environment', () => {
    const f = fixture();
    expect(
      () => new Engine({ ...f.config, shop: 'other.myshopify.com' }, f.store, f.providers),
    ).toThrow('Database is bound');
    expect(() => new Engine({ ...f.config, simulated: false }, f.store, f.providers)).toThrow(
      'Database is bound',
    );
  });
  it('uses exact decimal comparisons', () => {
    expect(equalAmount('999999999999.123456', '999999999999.123457')).toBe(false);
    expect(equalAmount('12.340', '12.34')).toBe(true);
    expect(equalAmount(undefined, '1')).toBe(false);
  });
});

describe('refunds and webhooks', () => {
  it('waits for wallet approval and sent status; duplicate refunds create once', async () => {
    const f = fixture();
    await settle(f);
    const create = vi.spyOn(f.providers, 'refund');
    await f.engine.accept('refund', refund());
    await f.engine.accept('refund', refund());
    expect(create).toHaveBeenCalledTimes(1);
    expect(operation(f, 'refund').done).toBeUndefined();
    await f.providers.transition(f.engine, operation(f, 'refund'), 'approve-refund');
    expect(operation(f, 'refund')).toMatchObject({ done: true, decision: 'resolve' });
  });
  it('does not refund unknown, unconfirmed, cross-mode or wrong-currency payments', async () => {
    const f = fixture();
    await expect(f.engine.accept('refund', refund())).rejects.toMatchObject({ status: 409 });
    await f.engine.accept('payment', payment());
    await expect(f.engine.accept('refund', refund())).rejects.toMatchObject({ status: 409 });
    await f.providers.transition(f.engine, operation(f), 'pay');
    await expect(f.engine.accept('refund', refund({ test: false }))).rejects.toMatchObject({
      status: 503,
    });
    await expect(f.engine.accept('refund', refund({ currency: 'EUR' }))).rejects.toMatchObject({
      status: 409,
    });
  });
  it('keeps a refund under review pending instead of rejecting a retryable failure', async () => {
    const f = fixture();
    await settle(f);
    await f.engine.accept('refund', refund());
    const op = operation(f, 'refund');
    const session = f.store.get(`fixture:${op.sessionId}`);
    session.payments[0].refunds[0].merchant_status = 'review';
    f.store.set(`fixture:${op.sessionId}`, session);
    await f.engine.sync(op.key);
    expect(operation(f, 'refund').decision).toBeUndefined();
    session.payments[0].refunds[0].merchant_status = 'cancelled';
    f.store.set(`fixture:${op.sessionId}`, session);
    await f.engine.sync(op.key);
    expect(operation(f, 'refund')).toMatchObject({ done: true, decision: 'reject' });
  });
  it('checks raw signatures, timestamps and mode', async () => {
    const f = fixture();
    const payload = Buffer.from(JSON.stringify({ id: 'evt', livemode: false }));
    const opts = { payload, secret: f.config.modes.test.webhook };
    await expect(f.engine.webhook('test', payload, 'forged')).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      f.engine.webhook('test', payload, signWebhookPayload({ ...opts, timestamp: 1 }).header),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      f.engine.webhook('test', Buffer.from('{}'), signWebhookPayload(opts).header),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      f.engine.webhook('test', payload, signWebhookPayload(opts).header),
    ).resolves.toBeUndefined();
    const wrong = Buffer.from(JSON.stringify({ id: 'evt', livemode: true }));
    await expect(
      f.engine.webhook('test', wrong, signWebhookPayload({ ...opts, payload: wrong }).header),
    ).rejects.toMatchObject({ status: 400 });
  });
});
