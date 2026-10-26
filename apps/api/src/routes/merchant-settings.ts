// Checkout settings (checkout Task 10): `settings:manage`. Changing them also needs step-up —
// the checkout domains decide who may frame the checkout (CSP `frame-ancestors`), the same class
// of security-relevant setting as a webhook endpoint URL, whose create also needs step-up.
import type { FastifyPluginAsync } from 'fastify';
import {
  CheckoutSettingsPatchSchema,
  getCheckoutSettings,
  updateCheckoutSettings,
} from '../checkout/checkout-settings.js';
import { requireDashboardUser } from '../gateway/principal.js';

const manage = { principals: ['dashboard_user' as const], permission: 'settings:manage' as const };
const manageStepUp = { ...manage, stepUp: true };

export const merchantSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/settings/checkout', { config: { auth: manage } }, async (req) => {
    const p = requireDashboardUser(req);
    return getCheckoutSettings({ merchantId: p.merchantId, livemode: p.livemode });
  });

  app.patch('/v1/settings/checkout', { config: { auth: manageStepUp } }, async (req) => {
    const p = requireDashboardUser(req);
    return updateCheckoutSettings(
      { merchantId: p.merchantId, livemode: p.livemode },
      p.userId,
      CheckoutSettingsPatchSchema.parse(req.body ?? {}),
    );
  });
};
