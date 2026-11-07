import { randomUUID } from 'node:crypto';
import { RequestError } from './engine.mjs';
import { signWebhookPayload } from '@tendr/sdk/webhook';

// No network adapter is constructed in simulator mode. Fixtures survive container restarts.
export function simulatedProviders(config, store) {
  const read = (id) => store.get(`fixture:${id}`);
  const write = (session) => store.set(`fixture:${session.id}`, session);
  return {
    create: async (op) => {
      const existing = store.get(`fixture-key:${op.key}`);
      if (existing) return existing;
      const id = `ses_sim_${randomUUID()}`;
      write({
        id,
        livemode: false,
        status: 'PENDING_DEPOSIT',
        amount: op.input.amount,
        amount_currency: op.input.currency,
        external_ref: op.externalRef,
        payments: [],
      });
      const result = { id, url: `${config.origin}/mock/${op.token}` };
      store.set(`fixture-key:${op.key}`, result);
      return result;
    },
    read: async (op) => read(op.sessionId || op.tendrId),
    refund: async (op) => {
      const existing = store.get(`fixture-key:${op.key}`);
      if (existing) return existing;
      const session = read(op.sessionId);
      const refunds = session.payments[0].refunds;
      const units = (v) => {
        const [a, b = ''] = v.split('.');
        return BigInt(a) * 1000000n + BigInt(b.padEnd(6, '0'));
      };
      if (
        refunds.reduce((sum, r) => sum + units(r.requested), 0n) + units(op.input.amount) >
        units(session.amount)
      )
        throw new RequestError(422, 'refund_exceeds_payment');
      const id = `ref_sim_${randomUUID()}`;
      refunds.push({
        id,
        refund_external_ref: op.externalRef,
        merchant_status: 'pending',
        requested: op.input.amount,
      });
      write(session);
      const result = { id, status: 'pending' };
      store.set(`fixture-key:${op.key}`, result);
      return result;
    },
    finish: async (op) => {
      store.set(`shopify-result:${op.key}`, {
        mutation: `${op.kind}Session${op.decision === 'resolve' ? 'Resolve' : 'Reject'}`,
        id: op.input.gid,
      });
      return { redirect: op.kind === 'payment' ? `${config.origin}/sim/order/${op.token}` : null };
    },
    configure: async () => {},
    transition: async (engine, op, action) => {
      const session = read(op.sessionId || op.tendrId);
      if (action === 'pay' && session.status === 'PENDING_DEPOSIT') {
        session.status = 'SETTLED';
        session.payments = [
          {
            id: `pay_sim_${randomUUID()}`,
            status: 'SETTLED',
            is_late: false,
            settled_at: new Date().toISOString(),
            refunds: [],
          },
        ];
      } else if (action === 'expire' && session.status === 'PENDING_DEPOSIT')
        session.status = 'EXPIRED';
      else if (action === 'approve-refund' && op.kind === 'refund') {
        const refund = session.payments.flatMap((p) => p.refunds).find((r) => r.id === op.tendrId);
        if (!refund) throw new RequestError(409, 'refund_not_created');
        refund.merchant_status = 'sent';
      } else throw new RequestError(409, 'invalid_simulated_transition');
      write(session);
      const payload = JSON.stringify({
        id: `evt_sim_${randomUUID()}`,
        type:
          action === 'pay'
            ? 'payment.succeeded'
            : action === 'expire'
              ? 'checkout.session.expired'
              : 'refund.sent',
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: { session_id: session.id },
      });
      await engine.webhook(
        'test',
        Buffer.from(payload),
        signWebhookPayload({ payload, secret: config.modes.test.webhook }).header,
      );
      await engine.tick();
    },
  };
}
