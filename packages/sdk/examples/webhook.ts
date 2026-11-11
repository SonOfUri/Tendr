import { TendrClient } from '@usetendr/sdk';
import { constructWebhookEvent, TendrWebhookError } from '@usetendr/sdk/webhook';

interface Orders {
  findBySessionId(id: string): Promise<{ id: string; amount: string; currency: string } | null>;
  // Implement in one database transaction: deduplicate eventId, mark the order paid once,
  // and enqueue fulfillment once. Do not perform fulfillment before this transaction commits.
  markPaidOnce(input: { eventId: string; orderId: string; paymentId: string }): Promise<void>;
}
// Framework-neutral Fetch handler, e.g. a Next.js App Router POST handler.
export async function handleWebhook(
  request: Request,
  deps: {
    apiKey: string;
    webhookSecret: string;
    livemode: boolean;
    orders: Orders;
  },
): Promise<Response> {
  try {
    // Set a body-size limit in your framework/server. Do not run JSON body middleware first.
    const event = constructWebhookEvent({
      payload: new Uint8Array(await request.arrayBuffer()),
      signatureHeader: request.headers.get('tendr-signature') ?? '',
      secret: deps.webhookSecret,
    });
    if (event.livemode !== deps.livemode) return new Response('Wrong mode', { status: 400 });
    if (event.type !== 'payment.succeeded') return new Response('Ignored', { status: 200 });
    const { session_id, payment_id, external_ref } = event.data;
    if (
      typeof session_id !== 'string' ||
      typeof payment_id !== 'string' ||
      typeof external_ref !== 'string'
    ) {
      return new Response('Invalid order event', { status: 400 });
    }
    const order = await deps.orders.findBySessionId(session_id);
    const session = await new TendrClient({ apiKey: deps.apiKey }).checkoutSessions.retrieve(
      session_id,
    );
    const payment = session.payments.find((p) => p.id === payment_id);
    // This example deliberately prices orders in USD to avoid doing FX or float comparisons.
    // Compare decimal strings without converting money to floating-point numbers.
    if (
      !order ||
      order.currency !== 'USD' ||
      order.id !== external_ref ||
      session.external_ref !== order.id ||
      session.livemode !== deps.livemode ||
      session.amount_currency !== 'USD' ||
      !sameDecimal(session.amount, order.amount) ||
      session.status !== 'SETTLED' ||
      payment?.status !== 'SETTLED' ||
      !payment.settled_at ||
      payment.is_late
    ) {
      // Investigate mismatches; leave the order unfulfilled. Tendr will retry a non-2xx.
      return new Response('Order requires review', { status: 409 });
    }
    await deps.orders.markPaidOnce({ eventId: event.id, orderId: order.id, paymentId: payment_id });
    return new Response('OK', { status: 200 });
  } catch (error) {
    if (error instanceof TendrWebhookError) return new Response('Invalid webhook', { status: 400 });
    // Transient API/database errors must remain retryable. Do not log raw bodies or secrets.
    return new Response('Please retry', { status: 503 });
  }
}
function sameDecimal(left: string, right: string): boolean {
  const normalize = (value: string) => {
    if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
    const [whole = '0', fraction = ''] = value.split('.');
    return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`;
  };
  const a = normalize(left);
  return a !== null && a === normalize(right);
}
