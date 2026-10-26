// Shopper-side checkout API, authenticated by the session client secret
// (`Authorization: Bearer ses_…_secret_…`, the `session_client` principal). Every route acts on
// the one session the secret opened. Called from the hosted checkout page (CORS for
// CHECKOUT_BASE_URL, without credentials: see app.ts).
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  DepositInputSchema,
  EmailInputSchema,
  QuoteInputSchema,
  SimulateInputSchema,
  createQuote,
  setShopperEmail,
  shopperSessionView,
  shopperTokens,
  simulateDeposit,
  submitDeposit,
  type ShopperCtx,
} from '../checkout/quotes.js';
import {
  provideRefundAddress,
  provideRefundAddressByToken,
  RefundAddressInputSchema,
  RefundAddressTokenInputSchema,
} from '../checkout/refunds.js';
import { publicFrameOrigins } from '../checkout/checkout-settings.js';
import { requirePrincipal } from '../gateway/principal.js';
import { notFound, unauthorized } from '../lib/errors.js';

/** Path prefix of the shopper routes (app.ts scopes the checkout-origin CORS rule to it). */
export const CHECKOUT_CLIENT_PREFIX = '/v1/checkout/client/';
/** Unauthenticated checkout routes (the web middleware's frame-origins lookup). */
export const CHECKOUT_PUBLIC_PREFIX = '/v1/checkout/public/';
/** The emailed return-address link's route (token-authenticated; same checkout-origin CORS). */
export const CHECKOUT_REFUND_ADDRESS_PATH = '/v1/checkout/refund-address';

const shopper = { config: { auth: { principals: ['session_client' as const] } } };

function ctxOf(req: FastifyRequest): ShopperCtx {
  const p = requirePrincipal(req);
  if (p.kind !== 'session_client' || !req.db) throw unauthorized();
  return { merchantId: p.merchantId, livemode: p.livemode, db: req.db, sessionId: p.sessionId };
}

export type CheckoutClientRouteOptions = {
  /** Per-session quote limiter (`createRateLimiters().sessionQuote`), run after auth. */
  quoteRateLimit: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Per-session-id frame-origins limiter (`createRateLimiters().frameOrigins`, C26). */
  frameOriginsRateLimit: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const checkoutClientRoutes: FastifyPluginAsync<CheckoutClientRouteOptions> = async (
  app,
  opts,
) => {
  app.get(`${CHECKOUT_CLIENT_PREFIX}session`, shopper, async (req) =>
    shopperSessionView(ctxOf(req)),
  );

  app.get(`${CHECKOUT_CLIENT_PREFIX}tokens`, shopper, async (req) =>
    shopperTokens(ctxOf(req).livemode),
  );

  // 8 / session / minute (gateway limiter), plus a lifetime cap of MAX_QUOTES_PER_SESSION.
  app.post(
    `${CHECKOUT_CLIENT_PREFIX}quote`,
    { ...shopper, preHandler: opts.quoteRateLimit },
    async (req, reply) => {
      const ctx = ctxOf(req);
      const input = QuoteInputSchema.parse(req.body);
      return reply.status(201).send(await createQuote(ctx, input));
    },
  );

  app.post(`${CHECKOUT_CLIENT_PREFIX}deposit`, shopper, async (req, reply) => {
    const ctx = ctxOf(req);
    const { tx_hash } = DepositInputSchema.parse(req.body);
    await submitDeposit(ctx, tx_hash);
    return reply.status(202).send({ submitted: true });
  });

  app.post(`${CHECKOUT_CLIENT_PREFIX}email`, shopper, async (req) => {
    const ctx = ctxOf(req);
    const { email } = EmailInputSchema.parse(req.body);
    await setShopperEmail(ctx, email);
    return { ok: true };
  });

  // Ruling C3: the shopper says where an exchange-sent return goes (screened; block → 403).
  // Each attempt screens an address, so it shares the per-session quote limiter.
  app.post(
    `${CHECKOUT_CLIENT_PREFIX}refund-address`,
    { ...shopper, preHandler: opts.quoteRateLimit },
    async (req) => {
      const ctx = ctxOf(req);
      const input = RefundAddressInputSchema.parse(req.body);
      return provideRefundAddress(ctx, input);
    },
  );

  // Ruling C20: the emailed return-address link. Public (the single-use token authenticates it;
  // a bad token is 401), so the gateway's per-IP `public` limit applies.
  app.post(CHECKOUT_REFUND_ADDRESS_PATH, { config: { auth: 'public' } }, async (req) => {
    const input = RefundAddressTokenInputSchema.parse(req.body);
    return provideRefundAddressByToken(input);
  });

  // Ruling C3 (Task 11): the origins allowed to frame this session's checkout, for the web
  // middleware's CSP `frame-ancestors`. Public; only the origin list, and an empty list (not a
  // 404) for unknown or malformed ids; expired sessions keep their origins (C28). Limited per
  // session id, not per IP (C26): the web middleware calls it from one server IP.
  app.get<{ Params: { sessionId: string } }>(
    `${CHECKOUT_PUBLIC_PREFIX}:sessionId/frame-origins`,
    {
      config: { auth: 'public', publicLimit: 'route' },
      preHandler: opts.frameOriginsRateLimit,
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return publicFrameOrigins(req.params.sessionId);
    },
  );

  app.post(`${CHECKOUT_CLIENT_PREFIX}simulate`, shopper, async (req) => {
    const ctx = ctxOf(req);
    // 404 before validating, so a live session learns nothing about the route.
    if (ctx.livemode) throw notFound();
    const input = SimulateInputSchema.parse(req.body);
    return simulateDeposit(ctx, input);
  });
};
