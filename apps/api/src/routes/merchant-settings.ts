// Checkout settings (checkout Task 10; WooCommerce plugin spec §3).
// - A dashboard user needs `settings:manage`; changing settings also needs step-up — the checkout
//   domains decide who may frame the checkout (CSP `frame-ancestors`), the same class of
//   security-relevant setting as a webhook endpoint URL, whose create also needs step-up.
// - A connected site's key (a `secret_key` with `connection_id`, ruling W1) reads the settings and
//   changes only the fee and gas payers and the notification email (403 FIELD_NOT_ALLOWED for any
//   other field). A key the store made by hand is 403.
// - `POST /v1/settings/notification-email/verify` is public (the token is the credential),
//   limited per IP.
//
// The auth config allows both principal kinds, so the permission and step-up checks for
// dashboard users are made here: the gateway only accepts them on dashboard-only routes.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  assertConnectionFields,
  CheckoutSettingsPatchSchema,
  getCheckoutSettings,
  updateCheckoutSettings,
} from '../checkout/checkout-settings.js';
import { requirePrincipal, requireStepUp } from '../gateway/principal.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { type SettingsActor, verifyNotificationEmail } from '../merchants/notification-email.js';

const storeOrConnection = { principals: ['dashboard_user' as const, 'secret_key' as const] };

type Caller = { merchantId: string; livemode: boolean; actor: SettingsActor };

/** A dashboard user with `settings:manage`, or a connection key; anything else is refused. */
function caller(req: FastifyRequest): Caller {
  const p = requirePrincipal(req);
  if (p.kind === 'dashboard_user') {
    if (!p.permissions.includes('settings:manage')) {
      throw forbidden('Missing permission settings:manage');
    }
    return {
      merchantId: p.merchantId,
      livemode: p.livemode,
      actor: { by: 'user', userId: p.userId },
    };
  }
  if (p.kind !== 'secret_key') throw unauthorized();
  if (!p.connectionId) throw forbidden('This endpoint needs a connection key');
  return {
    merchantId: p.merchantId,
    livemode: p.livemode,
    actor: { by: 'connection', connectionId: p.connectionId },
  };
}

export type MerchantSettingsRouteOptions = {
  /** Per-IP limiter for the public verify route (`createRateLimiters().notificationEmailVerify`). */
  verifyRateLimit: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export const merchantSettingsRoutes: FastifyPluginAsync<MerchantSettingsRouteOptions> = async (
  app,
  opts,
) => {
  app.get('/v1/settings/checkout', { config: { auth: storeOrConnection } }, async (req) => {
    const c = caller(req);
    return getCheckoutSettings({ merchantId: c.merchantId, livemode: c.livemode });
  });

  app.patch('/v1/settings/checkout', { config: { auth: storeOrConnection } }, async (req) => {
    const c = caller(req);
    if (c.actor.by === 'user') requireStepUp(req);
    else assertConnectionFields(req.body);
    return updateCheckoutSettings(
      { merchantId: c.merchantId, livemode: c.livemode },
      c.actor,
      CheckoutSettingsPatchSchema.parse(req.body ?? {}),
    );
  });

  app.post(
    '/v1/settings/notification-email/verify',
    { config: { auth: 'public', publicLimit: 'route' }, onRequest: opts.verifyRateLimit },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return verifyNotificationEmail(req.body);
    },
  );
};
