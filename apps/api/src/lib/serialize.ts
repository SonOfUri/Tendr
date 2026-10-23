import type { CheckoutSession, Payment, Quote } from '@prisma/client';

function decimalToString(value: { toFixed?: (n: number) => string } | string | number): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toFixed(2);
  if (typeof value.toFixed === 'function') {
    const s = value.toString();
    return s.includes('e') ? Number(s).toFixed(8).replace(/\.?0+$/, '') || '0' : s;
  }
  return String(value);
}

export function serializeSession(session: CheckoutSession & { payment?: Payment | null }) {
  return {
    id: session.id,
    merchantId: session.merchantId,
    merchantReference: session.merchantReference,
    amount: decimalToString(session.amount),
    currency: session.currency,
    description: session.description,
    successUrl: session.successUrl,
    cancelUrl: session.cancelUrl,
    mode: session.mode,
    status: session.status,
    metadata: (session.metadata ?? {}) as Record<string, string>,
    paymentId: session.payment?.id ?? null,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

export function serializePayment(payment: Payment) {
  return {
    id: payment.id,
    sessionId: payment.sessionId,
    merchantId: payment.merchantId,
    status: payment.status,
    amount: decimalToString(payment.amount),
    currency: payment.currency,
    mode: payment.mode,
    provider: payment.provider,
    providerReference: payment.providerReference,
    failureReason: payment.failureReason,
    settledAt: payment.settledAt?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

export function serializeQuote(quote: Quote) {
  return {
    id: quote.id,
    sessionId: quote.sessionId,
    sourceAsset: quote.sourceAsset,
    sourceNetwork: quote.sourceNetwork,
    destinationAsset: quote.destinationAsset,
    destinationNetwork: quote.destinationNetwork,
    sourceAmount: decimalToString(quote.sourceAmount),
    destinationAmount: decimalToString(quote.destinationAmount),
    expiresAt: quote.expiresAt.toISOString(),
    provider: quote.provider,
    createdAt: quote.createdAt.toISOString(),
  };
}
