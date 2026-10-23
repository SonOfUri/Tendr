import {
  CreateCheckoutSessionRequestSchema,
  CreateQuoteRequestSchema,
  type CreateCheckoutSessionRequest,
  type CreateQuoteRequest,
} from '@tendr/contracts';
import { Prisma } from '@prisma/client';
import { env } from '../env.js';
import { assertTransition } from '../domain/state-machine.js';
import { hashRequest } from '../lib/crypto.js';
import { AppError, conflict, invalidState, notFound, providerNotConfigured } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { serializePayment, serializeQuote, serializeSession } from '../lib/serialize.js';
import { getProviders } from '../providers/index.js';
import { enqueueWebhook } from './webhooks.js';

const SESSION_TTL_MS = 30 * 60 * 1000;

function validateCallbackUrl(url: string) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError('VALIDATION_ERROR', 'Callback URL must be http(s)', 400);
  }
  if (env().NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new AppError('VALIDATION_ERROR', 'Callback URLs must use HTTPS in production', 400);
  }
}

export async function createCheckoutSession(
  merchantId: string,
  raw: unknown,
  idempotencyKey?: string,
) {
  const body = CreateCheckoutSessionRequestSchema.parse(raw) as CreateCheckoutSessionRequest;
  validateCallbackUrl(body.successUrl);
  validateCallbackUrl(body.cancelUrl);

  if (body.mode === 'live') {
    if (!env().CHECKOUT_LIVE_ENABLED || env().PAYMENT_PROVIDER === 'sandbox') {
      throw providerNotConfigured(
        'Live mode is not available. Use mode=sandbox or configure a live provider.',
      );
    }
  }

  const requestHash = hashRequest(body);

  if (idempotencyKey) {
    const existing = await prisma.idempotencyKey.findUnique({
      where: { merchantId_key: { merchantId, key: idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key reused with a different request body',
          409,
        );
      }
      return { statusCode: existing.responseCode, body: existing.responseBody };
    }
  }

  try {
    const session = await prisma.checkoutSession.create({
      data: {
        merchantId,
        merchantReference: body.merchantReference,
        amount: new Prisma.Decimal(body.amount),
        currency: body.currency,
        description: body.description,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        mode: body.mode,
        status: 'CREATED',
        metadata: body.metadata,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
      include: { payment: true },
    });

    await prisma.auditEvent.create({
      data: {
        merchantId,
        entityType: 'CheckoutSession',
        entityId: session.id,
        action: 'created',
        toStatus: 'CREATED',
      },
    });

    const responseBody = serializeSession(session);
    await enqueueWebhook(merchantId, 'checkout.session.created', responseBody);

    if (idempotencyKey) {
      await prisma.idempotencyKey.create({
        data: {
          merchantId,
          key: idempotencyKey,
          requestHash,
          responseCode: 201,
          responseBody,
        },
      });
    }

    return { statusCode: 201, body: responseBody };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('merchantReference already exists for this merchant');
    }
    throw err;
  }
}

export async function getCheckoutSession(merchantId: string, sessionId: string) {
  const session = await prisma.checkoutSession.findFirst({
    where: { id: sessionId, merchantId },
    include: { payment: true },
  });
  if (!session) throw notFound('Checkout session not found');
  if (session.expiresAt < new Date() && ['CREATED', 'AWAITING_PAYMENT'].includes(session.status)) {
    await transitionSession(session.id, session.status, 'EXPIRED', merchantId);
    const refreshed = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: session.id },
      include: { payment: true },
    });
    return serializeSession(refreshed);
  }
  return serializeSession(session);
}

export async function createQuote(merchantId: string, sessionId: string, raw: unknown) {
  const body = CreateQuoteRequestSchema.parse(raw ?? {}) as CreateQuoteRequest;
  const session = await prisma.checkoutSession.findFirst({
    where: { id: sessionId, merchantId },
  });
  if (!session) throw notFound('Checkout session not found');
  if (session.expiresAt < new Date()) throw new AppError('EXPIRED', 'Session expired', 410);
  if (!['CREATED', 'AWAITING_PAYMENT'].includes(session.status)) {
    throw invalidState(`Cannot quote session in status ${session.status}`);
  }

  const { SandboxPaymentProvider } = await import('../providers/sandbox.js');
  const sandbox = new SandboxPaymentProvider();
  const providers = getProviders();
  // Sandbox sessions always use the sandbox quote path for honesty.
  const result =
    session.mode === 'sandbox'
      ? await sandbox.createQuote({
          amount: session.amount.toString(),
          currency: session.currency,
          sourceAsset: body.sourceAsset,
          sourceNetwork: body.sourceNetwork,
        })
      : await providers.quotes.createQuote({
          amount: session.amount.toString(),
          currency: session.currency,
          sourceAsset: body.sourceAsset,
          sourceNetwork: body.sourceNetwork,
        });

  if (session.status === 'CREATED') {
    await transitionSession(session.id, 'CREATED', 'AWAITING_PAYMENT', merchantId);
  }

  const quote = await prisma.quote.create({
    data: {
      sessionId: session.id,
      sourceAsset: result.sourceAsset,
      sourceNetwork: result.sourceNetwork,
      destinationAsset: result.destinationAsset,
      destinationNetwork: result.destinationNetwork,
      sourceAmount: new Prisma.Decimal(result.sourceAmount),
      destinationAmount: new Prisma.Decimal(result.destinationAmount),
      expiresAt: result.expiresAt,
      provider: result.provider,
    },
  });

  await enqueueWebhook(merchantId, 'payment.pending', {
    sessionId: session.id,
    quoteId: quote.id,
  });

  return serializeQuote(quote);
}

export async function confirmCheckout(merchantId: string, sessionId: string, quoteId: string) {
  const session = await prisma.checkoutSession.findFirst({
    where: { id: sessionId, merchantId },
    include: { payment: true },
  });
  if (!session) throw notFound('Checkout session not found');
  if (session.payment) throw conflict('Payment already exists for session');

  const quote = await prisma.quote.findFirst({ where: { id: quoteId, sessionId } });
  if (!quote) throw notFound('Quote not found');
  if (quote.expiresAt < new Date()) throw new AppError('EXPIRED', 'Quote expired', 410);

  const sandbox = new (await import('../providers/sandbox.js')).SandboxPaymentProvider();
  const providers = getProviders();
  const paymentProvider = session.mode === 'sandbox' ? sandbox : providers.payments;
  const verifier = session.mode === 'sandbox' ? sandbox : providers.verifier;

  const started = await paymentProvider.startPayment({
    sessionId,
    quoteId,
    amount: session.amount.toString(),
    currency: session.currency,
  });

  await transitionSession(session.id, session.status, 'PROCESSING', merchantId);

  const payment = await prisma.payment.create({
    data: {
      sessionId: session.id,
      merchantId,
      status: 'PROCESSING',
      amount: session.amount,
      currency: session.currency,
      mode: session.mode,
      provider: paymentProvider.name,
      providerReference: started.providerReference,
    },
  });

  await enqueueWebhook(merchantId, 'payment.processing', serializePayment(payment));

  // Sandbox auto-verifies and settles server-side (never from browser).
  const verified = await verifier.verify(started.providerReference);
  if (verified.status === 'SETTLED') {
    await transitionSession(session.id, 'PROCESSING', 'SETTLED', merchantId);
    const settled = await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'SETTLED', settledAt: new Date() },
    });
    await enqueueWebhook(merchantId, 'payment.settled', serializePayment(settled));
    const refreshed = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: session.id },
      include: { payment: true },
    });
    return { session: serializeSession(refreshed), payment: serializePayment(settled) };
  }

  if (verified.status === 'FAILED') {
    await transitionSession(session.id, 'PROCESSING', 'FAILED', merchantId);
    const failed = await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'FAILED', failureReason: verified.failureReason ?? 'Payment failed' },
    });
    await enqueueWebhook(merchantId, 'payment.failed', serializePayment(failed));
    const refreshed = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: session.id },
      include: { payment: true },
    });
    return { session: serializeSession(refreshed), payment: serializePayment(failed) };
  }

  const refreshed = await prisma.checkoutSession.findUniqueOrThrow({
    where: { id: session.id },
    include: { payment: true },
  });
  return { session: serializeSession(refreshed), payment: serializePayment(payment) };
}

export async function getPayment(merchantId: string, paymentId: string) {
  const payment = await prisma.payment.findFirst({ where: { id: paymentId, merchantId } });
  if (!payment) throw notFound('Payment not found');
  return serializePayment(payment);
}

export async function listMerchantPayments(merchantId: string, limit = 20, cursor?: string) {
  const payments = await prisma.payment.findMany({
    where: { merchantId, ...(cursor ? { id: { lt: cursor } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return {
    data: payments.map(serializePayment),
    meta: {
      nextCursor: payments.length === limit ? (payments[payments.length - 1]?.id ?? null) : null,
      limit,
    },
  };
}

async function transitionSession(
  sessionId: string,
  from: string,
  to: string,
  merchantId: string,
) {
  assertTransition(from, to);
  await prisma.checkoutSession.update({
    where: { id: sessionId },
    data: { status: to },
  });
  await prisma.auditEvent.create({
    data: {
      merchantId,
      entityType: 'CheckoutSession',
      entityId: sessionId,
      action: 'status_change',
      fromStatus: from,
      toStatus: to,
    },
  });
  if (to === 'EXPIRED') {
    await enqueueWebhook(merchantId, 'payment.expired', { sessionId });
  }
}
