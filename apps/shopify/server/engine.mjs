import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { verifyWebhookSignature } from '@tendr/sdk/webhook';

export class RequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export const decimal = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/)
  .refine((v) => /^\d{1,12}(\.\d{1,6})?$/.test(v) && BigInt(v.replace('.', '')) > 0n);
export function equalAmount(a, b) {
  const units = (s) => {
    if (typeof s !== 'string' || !/^\d{1,18}(\.\d{1,18})?$/.test(s)) return null;
    const [whole, fraction = ''] = s.split('.');
    return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  };
  return units(a) !== null && units(a) === units(b);
}
const base = {
  id: z.string().min(1).max(255),
  gid: z.string(),
  amount: decimal,
  currency: z.string().regex(/^[A-Z]{3}$/),
  test: z.boolean(),
};
const paymentSchema = z.object({
  ...base,
  kind: z.literal('sale'),
  payment_method: z.object({ type: z.literal('offsite') }),
});
const refundSchema = z.object({ ...base, payment_id: base.id });
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const operationKey = (shop, test, kind, id) => `sh_${hash(`${shop}:${test}:${kind}:${id}`)}`;
const paid = (session) =>
  ['SETTLED', 'REFUNDED'].includes(session.status) &&
  session.payments?.some(
    (p) =>
      !p.is_late &&
      p.settled_at &&
      ['SETTLED', 'PARTIALLY_REFUNDED', 'REFUNDING', 'REFUNDED'].includes(p.status),
  );

export class Engine {
  constructor(config, store, providers) {
    Object.assign(this, { config, store, providers });
    this.wake = new Set();
    const binding = {
      shop: config.shop,
      simulated: config.simulated,
      tendrUrl: config.tendrUrl,
      origin: config.origin,
    };
    const existing = store.get('binding');
    if (existing && JSON.stringify(existing) !== JSON.stringify(binding))
      throw new Error('Database is bound to another shop, environment or origin');
    if (!existing) store.set('binding', binding);
  }
  async accept(kind, body) {
    const parsed = (kind === 'payment' ? paymentSchema : refundSchema).safeParse(body);
    if (!parsed.success) throw new RequestError(422, 'invalid_payment_request');
    const input = parsed.data;
    if (
      input.gid !== `gid://shopify/${kind === 'payment' ? 'Payment' : 'Refund'}Session/${input.id}`
    )
      throw new RequestError(422, 'invalid_session_gid');
    if (
      ((this.config.simulated || this.config.testOnly) && !input.test) ||
      !this.config.modes[input.test ? 'test' : 'live'].key
    )
      throw new RequestError(503, 'payment_mode_unconfigured');
    const key = operationKey(this.config.shop, input.test, kind, input.id);
    const fingerprint = hash(JSON.stringify(input));
    let op = this.store.operation(key);
    if (op && op.fingerprint !== fingerprint)
      throw new RequestError(409, 'session_payload_changed');
    if (!op) {
      const parent =
        kind === 'refund'
          ? this.store.operation(
              operationKey(this.config.shop, input.test, 'payment', input.payment_id),
            )
          : null;
      if (
        kind === 'refund' &&
        (!parent?.done || parent.decision !== 'resolve' || parent.input.currency !== input.currency)
      )
        throw new RequestError(409, 'original_payment_not_confirmed');
      const token = randomBytes(24).toString('base64url');
      const externalRef = `shopify:${key}`;
      const returnUrl = `${this.config.origin}/return/${token}`;
      op = this.store.insert({
        key,
        kind,
        input,
        fingerprint,
        token,
        createdAt: Date.now(),
        externalRef,
        parentKey: parent?.key,
        sessionId: parent?.tendrId,
        request:
          kind === 'payment'
            ? {
                amount: input.amount,
                amount_currency: input.currency,
                external_ref: externalRef,
                success_url: returnUrl,
                cancel_url: returnUrl,
                expires_in: 1800,
              }
            : {
                session: parent.tendrId,
                amount: input.amount,
                currency: input.currency,
                external_ref: externalRef,
                reason: 'Shopify merchant refund',
              },
      });
      if (op.fingerprint !== fingerprint) throw new RequestError(409, 'session_payload_changed');
    }
    await this.sync(key);
    op = this.store.operation(key);
    if (!op.tendrId)
      throw new RequestError(
        503,
        op.review ? 'manual_reconciliation_required' : 'provider_pending_retry',
      );
    return kind === 'payment' ? { redirect_url: `${this.config.origin}/checkout/${op.token}` } : {};
  }
  corroborate(op, session) {
    const expected = op.kind === 'payment' ? op : this.store.operation(op.parentKey);
    if (
      session.id !== expected.tendrId ||
      session.livemode !== !expected.input.test ||
      session.external_ref !== expected.externalRef ||
      (session.original_currency || session.amount_currency) !== expected.input.currency ||
      !equalAmount(session.original_amount || session.amount, expected.input.amount)
    )
      throw new Error('tendr_session_mismatch');
  }
  async sync(key) {
    if (!this.store.claim(key)) return;
    let op = this.store.operation(key);
    try {
      if (op.done || op.review) return;
      if (!this.config.simulated && !this.store.get('oauth')) return;
      if (!op.tendrId) {
        // Tendr's HTTP idempotency records expire. Never replay an uncertain create indefinitely.
        if (op.firstAttempt && Date.now() - op.firstAttempt > 20 * 60 * 60 * 1000) {
          op.review = true;
          op.lastError = 'create_outcome_unknown';
          return;
        }
        const credentialHash = hash(this.config.modes[op.input.test ? 'test' : 'live'].key);
        if (op.credentialHash && op.credentialHash !== credentialHash) {
          op.review = true;
          op.lastError = 'credential_changed_during_create';
          return;
        }
        if (!op.firstAttempt) {
          op.firstAttempt = Date.now();
          op.credentialHash = credentialHash;
          this.store.save(op);
        }
        const result = await (op.kind === 'payment'
          ? this.providers.create(op)
          : this.providers.refund(op));
        if (typeof result.id !== 'string' || !result.id) throw new Error('invalid_tendr_response');
        if (op.kind === 'payment') {
          const url = new URL(result.url);
          if (
            url.origin !==
              (this.config.simulated ? this.config.origin : this.config.checkoutOrigin) ||
            url.username ||
            url.password
          )
            throw new Error('invalid_checkout_origin');
          op.checkoutUrl = url.href;
        }
        op.tendrId = result.id;
        this.store.save(op);
      }
      if (!op.decision) {
        const session = await this.providers.read(op);
        this.corroborate(op, session);
        if (op.kind === 'payment') {
          if (paid(session)) op.decision = 'resolve';
          // An expired session with an in-flight, held or late payment needs operator review.
          else if (session.status === 'EXPIRED' && session.payments?.length === 0)
            op.decision = 'reject';
        } else {
          const refund = session.payments
            ?.flatMap((p) => p.refunds || [])
            .find((r) => r.id === op.tendrId);
          if (refund && refund.refund_external_ref !== op.externalRef)
            throw new Error('refund_reference_mismatch');
          if (refund?.merchant_status === 'sent') op.decision = 'resolve';
          if (refund?.merchant_status === 'cancelled') op.decision = 'reject';
          // 'review' / failed transaction is NOT a final refund failure: owner may retry it.
        }
        if (op.decision) this.store.save(op);
      }
      if (op.decision) {
        const result = await this.providers.finish(op);
        if (result.redirect) {
          const url = new URL(result.redirect);
          const allowed = this.config.simulated
            ? url.origin === this.config.origin
            : url.protocol === 'https:' &&
              (url.hostname === this.config.shop ||
                url.hostname === 'checkout.shopify.com' ||
                url.hostname === 'shop.app');
          if (allowed && !url.username && !url.password) op.returnUrl = url.href;
        }
        op.done = true;
      }
      op.lastError = null;
      op.attempts = 0;
      op.retryAt = Date.now() + 15_000;
    } catch {
      op.attempts = (op.attempts || 0) + 1;
      op.lastError = 'provider_verification_pending';
      op.retryAt = Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(op.attempts, 9));
    } finally {
      this.store.save(op);
      this.store.release(key);
    }
  }
  async tick() {
    for (const op of this.store.list({ pending: true })) {
      if (this.wake.delete(op.key) || !op.retryAt || op.retryAt <= Date.now())
        await this.sync(op.key);
    }
  }
  async webhook(mode, payload, signature) {
    const secret = this.config.modes[mode]?.webhook;
    if (!secret || !verifyWebhookSignature({ payload, signatureHeader: signature || '', secret }))
      throw new RequestError(401, 'invalid_webhook_signature');
    let event;
    try {
      event = JSON.parse(payload.toString());
    } catch {
      throw new RequestError(400, 'invalid_webhook');
    }
    if (event?.livemode !== (mode === 'live') || typeof event.id !== 'string')
      throw new RequestError(400, 'webhook_mode_mismatch');
    // A signed event only wakes reconciliation; it never changes payment state directly.
    for (const op of this.store.list({ pending: true, limit: 1000 })) {
      if (
        op.input.test === (mode === 'test') &&
        event.data?.session_id === (op.sessionId || op.tendrId)
      ) {
        this.wake.add(op.key);
      }
    }
  }
  view(op) {
    return {
      token: op.token,
      id: op.input.id,
      kind: op.kind,
      amount: op.input.amount,
      currency: op.input.currency,
      mode: op.input.test ? 'Test' : 'Live',
      state: op.review
        ? 'Needs reconciliation'
        : op.done
          ? op.decision === 'resolve'
            ? 'Confirmed'
            : 'Rejected'
          : op.decision
            ? 'Awaiting Shopify confirmation'
            : op.kind === 'refund'
              ? 'Awaiting Tendr wallet approval'
              : 'Awaiting payment',
      done: Boolean(op.done),
      paid: op.done && op.decision === 'resolve',
      returnUrl: op.returnUrl || null,
      attention: Boolean(op.lastError),
    };
  }
}
