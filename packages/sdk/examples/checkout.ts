import { TendrClient } from 'tendr-sdk';

// Call on your server after loading and pricing the order from your own database.
export async function createCheckout(
  apiKey: string,
  order: {
    id: string;
    amount: string;
    currency: string;
    checkoutAttempt: number;
    successUrl: string;
    cancelUrl: string;
  },
) {
  const tendr = new TendrClient({ apiKey });
  const session = await tendr.checkoutSessions.create(
    {
      amount: order.amount,
      amount_currency: order.currency,
      external_ref: order.id,
      success_url: order.successUrl,
      cancel_url: order.cancelUrl,
    },
    { idempotencyKey: `${order.id}-checkout-${order.checkoutAttempt}` },
  );
  // Save the ID and COMPLETE URL server-side before redirecting. Keep the #cs= fragment.
  // Retry a lost response with the same attempt, idempotency key, and exact input.
  return { sessionId: session.id, checkoutUrl: session.url, expiresAt: session.expires_at };
}
